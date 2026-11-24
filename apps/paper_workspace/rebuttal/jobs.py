"""Analysis queue, worker lifecycle and snapshot-grounded publication."""
from __future__ import annotations

import copy
import json
import logging
import os
import re
import sqlite3
import threading

if __package__:
    from .imports import ValidationError, UpstreamRequestError, digest, text
    from .state import TASKS, TRANSLATION_TASKS, now, uid, identifier, NotFound, Conflict, lookup, find_round, checked_texts, invalidate
else:
    from imports import ValidationError, UpstreamRequestError, digest, text
    from state import TASKS, TRANSLATION_TASKS, now, uid, identifier, NotFound, Conflict, lookup, find_round, checked_texts, invalidate


def _sqlite_busy(error):
    code = getattr(error, 'sqlite_errorcode', 0)
    return code & 0xff in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED} or 'locked' in str(error).lower()


def analysis_failure(error):
    # Never store arbitrary bridge/model text, which can contain credentials or review text.
    if isinstance(error, UpstreamRequestError):
        messages = {
            'model_timeout': '분석 모델 실행 시간이 초과됐습니다. (Model timeout)',
            'model_rate_limited': '분석 모델의 호출 한도에 도달했습니다. (Model rate limited)',
            'model_auth_failed': '분석 모델 인증에 실패했습니다. (Model authentication failed)',
            'model_unavailable': '서버에서 분석 모델 실행 프로그램을 찾을 수 없습니다. (Model unavailable)',
            'model_response_invalid': '분석 모델의 응답 형식이 올바르지 않습니다. (Invalid model response)',
            'model_execution_failed': '분석 모델 실행이 실패했습니다. (Model execution failed)',
            'bridge_invalid_request': '분석 요청 형식이 올바르지 않습니다. (Invalid bridge request)',
            'bridge_busy': '분석 모델이 다른 요청을 처리 중입니다. (Bridge busy)',
            'bridge_cancelled': '분석 작업이 취소됐습니다. (Bridge cancelled)',
        }
        if error.code in messages:
            return error.code, messages[error.code]
        if error.status in (401, 403):
            return 'bridge_auth_failed', '분석 서비스 인증에 실패했습니다. (Bridge authentication failed)'
        if error.status == 429:
            return 'bridge_busy', messages['bridge_busy']
        return 'upstream_http_error', f'분석 서비스가 오류를 반환했습니다. (HTTP {error.status})'
    if type(error).__name__ == 'AnalysisError':
        if str(error).startswith(('Invalid translation', 'Translation block exceeds')):
            return 'invalid_translation_result', '번역 결과가 한국어·형식 검증을 통과하지 못했습니다. 다시 시도하면 완료한 문단을 재사용합니다. (Invalid translation result)'
        if str(error).startswith('Quote absent from snapshot:'):
            return 'unverified_quote', '리뷰 원문 또는 답변에 없는 구절을 AI가 인용해 분석을 중단했습니다. (Unverified quotation)'
        if str(error).startswith('Analysis context exceeds'):
            return 'context_too_large', '분석 입력이 처리 한도를 초과했습니다. (Analysis context too large)'
        if str(error) == 'Connection reason must be Korean':
            return 'invalid_connection_reason', '연결 이유를 한국어로 생성하지 못했습니다. 다시 시도해 주세요. (Invalid connection reason)'
        if str(error).startswith(('Unknown review_id:', 'Unknown document_id:', 'Unknown review field:', 'Unknown mapping concern ID', 'Concern reviewer does not match its source')):
            return 'invalid_evidence_reference', 'AI 결과의 리뷰·문서 식별자가 입력과 일치하지 않습니다. (Invalid evidence reference)'
        if str(error) == 'Actual concerns require review source evidence':
            return 'missing_concern_evidence', 'AI가 원문 근거 없이 리뷰 쟁점을 제시했습니다. (Missing concern evidence)'
        if str(error) in {'Each review chunk requires exactly one Korean translation', 'Duplicate translation review and field', 'Translation must be Korean; regenerate the review translation', 'Empty review field must have an empty translation', 'Invalid translation', 'Unknown translation review or field'}:
            return 'invalid_translation_result', '리뷰 번역 결과가 형식 또는 한국어 검증을 통과하지 못했습니다. 다시 시도해 주세요. (Invalid translation result)'
        return 'invalid_analysis_result', 'AI 분석 결과가 원문·식별자 검증을 통과하지 못했습니다. (Invalid analysis result)'
    if isinstance(error, (TimeoutError, ValidationError)) and (isinstance(error, TimeoutError) or str(error) == 'upstream request timed out'):
        return 'upstream_timeout', '분석 모델 응답 대기 시간이 초과됐습니다. (Upstream timeout)'
    if isinstance(error, ValidationError) and str(error) == 'upstream request failed':
        return 'upstream_request_failed', '분석 모델 호출에 실패했습니다. 잠시 후 다시 시도하세요. (Upstream request failed)'
    return 'analysis_execution_failed', '분석 실행 중 오류가 발생했습니다. (Analysis execution failed)'


class JobStore:
    @staticmethod
    def _public_job(job, include_progress=False):
        hidden = {'payload'} | (set() if include_progress else {'translation_progress'})
        return {**{k: v for k, v in job.items() if k not in hidden}, **({'selection': job['payload']['selection']} if 'selection' in job.get('payload', {}) else {}), **({'scope': job['payload']['scope']} if 'scope' in job.get('payload', {}) else {})}

    def job(self, project, round_id, job_id):
        with self._lock, self._connect() as db:
            row = db.execute('SELECT data FROM jobs WHERE project_id=? AND round_id=? AND id=?', (project, round_id, job_id)).fetchone()
            if not row: raise NotFound('job not found')
            job = json.loads(row['data'])
            result = self._public_job(job, include_progress=True)
            if job['task'] == 'translate_response':
                result['source'] = job['payload']['reviews'][0]['fields']['response']
            return {'job': result}

    def _translation_cache_get(self, project, key):
        with self._connect() as db:
            row = db.execute('SELECT text FROM translation_cache WHERE project_id=? AND cache_key=?', (project, key)).fetchone()
            return row['text'] if row else None

    def _translation_cache_put(self, project, key, value):
        with self._lock, self._connect() as db:
            db.execute('INSERT INTO translation_cache VALUES(?,?,?,?) ON CONFLICT(project_id,cache_key) DO UPDATE SET text=excluded.text,updated_at=excluded.updated_at', (project, key, value, now()))
            # Bound reusable translations independently from the job history.
            db.execute('DELETE FROM translation_cache WHERE project_id=? AND cache_key NOT IN (SELECT cache_key FROM translation_cache WHERE project_id=? ORDER BY updated_at DESC LIMIT 2000)', (project, project))

    @staticmethod
    def analysis_payload(round_, payload):
        texts = checked_texts(round_, payload.get('texts', {}), require_all=True)
        selection = payload.get('selection')
        scope = payload.get('scope', {})
        if not isinstance(scope, dict):
            raise ValidationError('invalid analysis scope')
        if any(not isinstance(scope.get(key), list) or any(not isinstance(value, str) for value in scope[key]) for key in ('review_ids','document_ids','concern_ids') if key in scope):
            raise ValidationError('invalid analysis scope')
        if 'review_ids' in scope and (not scope['review_ids'] or set(scope['review_ids']) - {r['id'] for r in round_['reviews']}):
            raise ValidationError('unknown analysis scope')
        if set(scope.get('document_ids', [])) - set(texts) or set(scope.get('concern_ids', [])) - {c['id'] for c in round_['concerns']}:
            raise ValidationError('unknown analysis scope')
        documents = [{'id': d['id'], 'title': d['title'], 'text': texts[d['id']]} for d in round_['documents']]
        rules = lookup(round_['rules'], round_.get('active_rules_id'))
        result = {'reviews': [{k: r[k] for k in ('id', 'reviewer_id', 'fields', 'translations') if k in r} for r in round_['reviews']], 'concerns': round_['concerns'], 'documents': documents,
                  'glossary': round_['glossary'], 'rules': rules, 'scope': scope}
        if 'review_ids' in scope:
            review_ids = set(scope['review_ids'])
            result['reviews'] = [review for review in result['reviews'] if review['id'] in review_ids]
            reviewers = {review.get('reviewer_id') for review in result['reviews']}
            result['concerns'] = [concern for concern in result['concerns'] if
                                  (concern.get('reviewer_id') in reviewers or any(span.get('review_id') in review_ids for span in concern.get('source_spans', []))) and
                                  all(span.get('review_id') in review_ids for span in concern.get('source_spans', []))]
        if 'document_ids' in scope:
            result['documents'] = [d for d in documents if d['id'] in scope['document_ids']]
        if payload.get('task') == 'connect':
            reviewers = {review.get('reviewer_id') for review in result['reviews']}
            if not scope.get('review_ids') or len(scope.get('document_ids', [])) != 1 or len(reviewers) != 1:
                raise ValidationError('select one reviewer and one response document')
            doc = lookup(round_['documents'], scope['document_ids'][0])
            if doc.get('kind') == 'reviewer' and doc.get('reviewer_id') not in reviewers:
                raise ValidationError('response document does not match reviewer')
        if 'concern_ids' in scope:
            if set(scope['concern_ids']) - {c['id'] for c in result['concerns']}:
                raise ValidationError('unknown analysis scope')
            result['concerns'] = [c for c in result['concerns'] if c['id'] in scope['concern_ids']]
        if selection is not None and payload.get('task') != 'research_rules':
            if not isinstance(selection, dict): raise ValidationError('invalid selection')
            result['selection'] = {k: v for k, v in selection.items() if k in {'document_id', 'quote', 'start', 'end', 'content_hash'}}
        if payload.get('task') == 'research_rules':
            # Only public venue metadata crosses the web-enabled model boundary.
            source = payload.get('research') or payload.get('rules') or payload.get('selection') or rules or {}
            result = {key: source.get(key) for key in ('venue', 'year', 'track', 'stage') if source.get(key) is not None}
            result['official_urls'] = source.get('official_urls', [s['url'] for s in source.get('sources', []) if isinstance(s, dict) and s.get('url')])
        return result

    def queue(self, project, round_id, payload, actor, manuscript=None):
        task = payload.get('task')
        if task not in TASKS:
            raise ValidationError('invalid analysis task')
        profile = payload.get('profile') or ('rebuttal-translation-light' if task in TRANSLATION_TASKS else 'rebuttal-sol-light' if task == 'style' else 'rebuttal-sol-high' if task in {'consistency', 'research_rules'} else 'rebuttal-sol-medium')
        if profile is not None and (not isinstance(profile, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', profile)):
            raise ValidationError('invalid analysis profile')
        def apply(state, db):
            round_ = find_round(state, round_id)
            snapshot = self.analysis_payload(round_, payload)
            if task == 'translate_response':
                documents = snapshot.get('documents', [])
                if len(documents) != 1 or not documents[0].get('text', '').strip():
                    raise ValidationError('select one nonempty response to translate')
                doc = documents[0]
                snapshot['reviews'] = [{'id': doc['id'], 'reviewer_id': doc['id'], 'fields': {'response': doc['text']}}]
                snapshot['documents'] = []
                snapshot['concerns'] = []
                snapshot['scope'] = {}
            if task in TRANSLATION_TASKS:
                # Translation depends on its source and glossary, not analysis metadata.
                snapshot = {'reviews': [{k: r[k] for k in ('id', 'reviewer_id', 'fields') if k in r} for r in snapshot['reviews']], 'documents': [], 'concerns': [], 'glossary': snapshot['glossary'], 'scope': snapshot['scope']}
            if task == 'connect' and manuscript is not None:
                snapshot['manuscript'] = copy.deepcopy(manuscript)
            invalidate(round_, payload.get('texts', {}))
            input_hash = digest(snapshot)
            prompt_version = 'rebuttal-direct-connect-v10' if task == 'connect' else 'rebuttal-translation-blocks-v1' if task in TRANSLATION_TASKS else 'rebuttal-ko-v2'
            model_version = 'bridge-terra-61-v1'
            cache_key = digest({'task': task, 'input': input_hash, 'profile': profile, 'model_version': model_version, 'prompt_version': prompt_version})
            if task in TRANSLATION_TASKS:
                for row in db.execute("SELECT data FROM jobs WHERE project_id=? AND round_id=? AND status IN ('queued','running')", (project, round_id)):
                    existing = json.loads(row['data'])
                    if existing.get('cache_key') == cache_key:
                        return {'job': self._public_job(existing)}
            pending = db.execute("SELECT count(*) FROM jobs WHERE project_id=? AND status IN ('queued','running')", (project,)).fetchone()[0]
            if db.execute('SELECT count(*) FROM jobs WHERE project_id=?', (project,)).fetchone()[0] >= 1000:
                raise ValidationError('job history quota exceeded')
            if pending >= 20:
                raise ValidationError('too many pending jobs')
            job = {'id': uid(), 'round_id': round_id, 'task': task, 'status': 'queued', 'stage': 'queued', 'created_at': now(),
                   'actor': actor, 'input_hash': input_hash, 'cache_key': cache_key, 'payload': snapshot,
                   'profile': profile, 'model_version': model_version, 'prompt_version': prompt_version, 'attempt': 1,
                   'text_hashes': copy.deepcopy(round_.get('text_hashes', {})), 'metadata_hash': self._metadata_hash(round_)}
            if task == 'translate_response': job['document_id'] = doc['id']
            previous = next((json.loads(row['data']) for row in db.execute("SELECT data FROM jobs WHERE project_id=? AND round_id=? AND status='completed' ORDER BY created_at DESC", (project, round_id)) if json.loads(row['data']).get('cache_key') == cache_key), None)
            if previous:
                job.update(status='completed', stage='cached', result=previous['result'], completed_at=now(), cached_from=previous['id'])
                if task == 'connect':
                    for key in ('connection_warnings', 'connection_diagnostics'):
                        job[key] = copy.deepcopy(previous.get(key, previous['result'].get(key, [])))
                self._publish(round_, job)
            db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)', (job['id'], project, round_id, job['created_at'], job['status'], input_hash, json.dumps(job)))
            round_['analyses'].append({'id': job['id'], 'task': task, 'input_hash': input_hash, 'created_at': job['created_at']})
            return {'job': self._public_job(job)}
        response = self.mutate(project, payload.get('expected_revision'), apply)
        self._wake.set()
        return response

    def job_action(self, project, round_id, job_id, payload, action):
        identifier(project)
        expected_revision = payload.get('expected_revision')
        if type(expected_revision) is not int or expected_revision < 0:
            raise ValidationError('expected_revision is required')
        remote_attempt = None
        with self._lock, self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            state = self._load(db, project)
            if expected_revision != state['revision']:
                raise Conflict(state['revision'])
            find_round(state, round_id)
            row = db.execute('SELECT data FROM jobs WHERE id=? AND project_id=? AND round_id=?', (job_id, project, round_id)).fetchone()
            if row is None:
                raise NotFound('job not found')
            job = json.loads(row['data'])
            changed = True
            if action == 'cancel':
                changed = job['status'] in {'queued', 'running'}
                if job['status'] == 'running':
                    remote_attempt = job.get('attempt', 1)
                if changed:
                    job.update(status='cancelled', stage='cancelled', completed_at=now())
            else:
                if job['status'] not in {'failed', 'cancelled'}:
                    raise ValidationError('only failed or cancelled jobs can be retried')
                job.update(status='queued', stage='queued', attempt=job.get('attempt', 1) + 1)
                for key in ('error', 'completed_at', 'started_at', 'validation_details', 'error_code', 'failed_stage', 'translation_progress'):
                    job.pop(key, None)
            if changed:
                db.execute('UPDATE jobs SET status=?,data=? WHERE id=?', (job['status'], json.dumps(job), job_id))
                self._save(db, project, state)
            response = self._state(db, project)
            response['result'] = {'job': self._public_job(job)}
        self._wake.set()
        if remote_attempt is not None:
            self._cancel_remote(job_id, remote_attempt)
        return response

    def _cancel_remote(self, job_id, attempt):
        url = os.environ.get('CODEX_BRIDGE_URL', 'http://codex-bridge:8790').rstrip('/') + '/internal/rebuttal/cancel'
        token = os.environ.get('CODEX_BRIDGE_TOKEN')
        try:
            self._request(url, {'job_id': job_id, 'attempt': attempt}, token)
        except ValidationError:
            pass

    @staticmethod
    def _metadata_hash(round_):
        return digest({'reviews': [{k: r.get(k) for k in ('id', 'reviewer_id', 'fields')} for r in round_['reviews']],
                       **{k: round_.get(k) for k in ('concerns', 'documents', 'glossary', 'active_rules_id')}})

    @staticmethod
    def _publish(round_, job):
        result = job.get('result', {})
        stale = any(round_.get('text_hashes', {}).get(k) != v for k, v in job.get('text_hashes', {}).items()) or job.get('metadata_hash') != JobStore._metadata_hash(round_)
        if job.get('task') == 'translate':
            stale = round_.get('glossary', {}) != job.get('payload', {}).get('glossary', {}) or any(
                lookup(round_['reviews'], review['id']) is None or lookup(round_['reviews'], review['id']).get('fields') != review.get('fields')
                for review in job.get('payload', {}).get('reviews', []))
        job['stale'] = stale
        if job.get('task') == 'connect' and job.get('prompt_version') in {'rebuttal-direct-connect-v2','rebuttal-direct-connect-v3','rebuttal-direct-connect-v4','rebuttal-direct-connect-v5','rebuttal-direct-connect-v6','rebuttal-direct-connect-v7','rebuttal-direct-connect-v8','rebuttal-direct-connect-v9','rebuttal-direct-connect-v10'} and not stale and not job.get('connection_warnings'):
            review_ids = {review['id'] for review in job.get('payload', {}).get('reviews', [])}
            document_ids = {doc['id'] for doc in job.get('payload', {}).get('documents', [])}
            for mapping in round_['mappings']:
                concern = lookup(round_['concerns'], mapping.get('concern_id'))
                spans = mapping.get('response_spans', [])
                sources = (concern or {}).get('source_spans', [])
                if (mapping.get('origin') == 'ai' and spans and sources
                    and all(span.get('document_id') in document_ids for span in spans)
                    and all(span.get('review_id') in review_ids for span in sources)):
                    if mapping.get('decision', 'proposed') == 'proposed': mapping['superseded'] = True
                    else:
                        mapping.pop('superseded', None)
                        if concern: concern.pop('superseded', None)
        for incoming in result.get('concerns', []):
            existing_concern = lookup(round_['concerns'], incoming.get('id'))
            if existing_concern is not None and existing_concern.get('superseded') and not stale:
                existing_concern.pop('superseded', None)
            if existing_concern is None:
                concern = copy.deepcopy(incoming)
                concern.setdefault('id', uid()); concern.setdefault('requires_response', True)
                concern.setdefault('strategy', 'clarify'); concern.setdefault('work_status', 'todo'); concern.setdefault('comments', [])
                concern.update(origin='ai', decision='proposed', input_hash=job['input_hash'], stale=stale)
                round_['concerns'].append(concern)
        for key in ('mappings', 'findings'):
            for incoming in result.get(key, []):
                item = copy.deepcopy(incoming)
                # Never overwrite confirmed/rejected/manual entries, including cached reruns.
                semantic = digest({k: v for k, v in item.items() if k != 'id'})
                if any(not existing.get('superseded') and existing.get('proposal_hash') == semantic and existing.get('input_hash') == job['input_hash'] for existing in round_[key]): continue
                item.update(id=uid(), input_hash=job['input_hash'], origin='ai', decision='proposed', stale=stale, proposal_hash=semantic)
                if key == 'findings': item['status'] = 'proposed'
                else: item['dependency_document_ids'] = [d['id'] for d in job.get('payload', {}).get('documents', [])]
                round_[key].append(item)
        if job.get('task') == 'connect' and job.get('prompt_version') in {'rebuttal-direct-connect-v2','rebuttal-direct-connect-v3','rebuttal-direct-connect-v4','rebuttal-direct-connect-v5','rebuttal-direct-connect-v6','rebuttal-direct-connect-v7','rebuttal-direct-connect-v8','rebuttal-direct-connect-v9','rebuttal-direct-connect-v10'} and not stale and not job.get('connection_warnings'):
            for concern in round_['concerns']:
                mappings = [m for m in round_['mappings'] if m.get('concern_id') == concern.get('id')]
                if (concern.get('origin') == 'ai' and not concern.get('comments')
                    and mappings and all(m.get('superseded') for m in mappings)):
                    concern['superseded'] = True
        for translation in result.get('translations', []) if not stale and job.get('task') in {'translate', 'analyze'} else []:
            review = lookup(round_['reviews'], translation['review_id'])
            if not review: continue
            revision = {'id': uid(), 'field': translation['field'], 'text': translation['text'], 'uncertain': translation.get('uncertain', []),
                        'origin': 'ai', 'input_hash': job['input_hash'], 'created_at': now()}
            review.setdefault('translation_revisions', []).append(revision)
            if not any(r.get('origin') == 'manual' for r in review['translation_revisions']):
                review.setdefault('translations', {})[translation['field']] = translation['text']
                review.setdefault('translation_alignments', {})[translation['field']] = {'source': review.get('fields', {}).get(translation['field'], ''), 'segments': copy.deepcopy(translation.get('segments', []))}

    def start(self):
        with self._lock:
            if self._worker is not None or self._stop.is_set():
                return
            self._worker = threading.Thread(target=self._work, name='rebuttal-worker', daemon=True)
            self._translation_worker = threading.Thread(target=self._work, args=('translation',),
                                                        name='rebuttal-translation-worker', daemon=True)
            self._worker.start()
            self._translation_worker.start()

    def workers_alive(self):
        return all(worker is not None and worker.is_alive()
                   for worker in (self._worker, self._translation_worker))

    def close(self):
        self._stop.set(); self._wake.set()
        if self._worker: self._worker.join(timeout=2)
        if self._translation_worker: self._translation_worker.join(timeout=2)

    def _claim(self, lane=None):
        with self._lock, self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            rows = db.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at,id").fetchall()
            if lane is not None:
                rows = [row for row in rows if (json.loads(row['data'])['task'] in TRANSLATION_TASKS) == (lane == 'translation')]
            if not rows: return None
            # Round robin between projects, FIFO within each project.
            projects = list(dict.fromkeys(row['project_id'] for row in rows))
            last_project = self._last_translation_project if lane == 'translation' else self._last_project
            if last_project in projects:
                index = (projects.index(last_project) + 1) % len(projects)
                project = projects[index]
            else: project = projects[0]
            row = next(r for r in rows if r['project_id'] == project)
            job = json.loads(row['data']); job.update(status='running', stage='starting', started_at=now())
            db.execute('UPDATE jobs SET status=?,data=? WHERE id=?', ('running', json.dumps(job), job['id']))
            if lane == 'translation': self._last_translation_project = project
            else:
                self._last_project = project
                db.execute("INSERT INTO worker_state VALUES('last_project',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (project,))
            return project, row['round_id'], job

    def _job_update(self, project, job_id, update, publish=False, expected_attempt=None):
        with self._lock, self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT data FROM jobs WHERE id=? AND project_id=?', (job_id, project)).fetchone()
            if not row: return
            job = json.loads(row['data'])
            if job['status'] != 'running' or expected_attempt is not None and job.get('attempt', 1) != expected_attempt:
                return
            job.update(update)
            if job['status'] == 'completed': job.pop('translation_progress', None)
            if publish:
                state = self._load(db, project)
                round_ = find_round(state, job['round_id'])
                before = copy.deepcopy(round_)
                self._publish(round_, job)
                if round_ != before:
                    self._save(db, project, state)
            db.execute('UPDATE jobs SET status=?,data=? WHERE id=?', (job['status'], json.dumps(job), job_id))

    def _cancelled(self, job_id, expected_attempt=None):
        if self._stop.is_set(): return True
        with self._connect() as db:
            row = db.execute('SELECT status,data FROM jobs WHERE id=?', (job_id,)).fetchone()
            return not row or row['status'] != 'running' or expected_attempt is not None and json.loads(row['data']).get('attempt', 1) != expected_attempt

    def _worker_update(self, *args, **kwargs):
        delay = 0.05
        while not self._stop.is_set():
            try:
                return self._job_update(*args, **kwargs)
            except sqlite3.OperationalError as error:
                if not _sqlite_busy(error):
                    raise
                self._stop.wait(delay)
                delay = min(delay * 2, 2)

    def _work(self, lane='analysis'):
        delay = 0.05
        while not self._stop.is_set():
            try:
                claimed = self._claim(lane)
                if claimed is None:
                    self._wake.wait(1)
                    self._wake.clear()
                else:
                    project, _, job = claimed
                    self._run_job(project, job)
                delay = 0.05
            except Exception as error:
                # Log the exception class only: errors can contain private input.
                logging.getLogger(__name__).warning('Rebuttal worker iteration failed (%s)', type(error).__name__)
                self._stop.wait(delay)
                delay = min(delay * 2, 2)

    def _run_job(self, project, job):
        job.setdefault('attempt', 1)
        last_stage = 'starting'
        try:
            try:
                from .analysis import run_analysis, validate_result, validation_issue
            except ImportError:
                from analysis import run_analysis, validate_result, validation_issue
            def bridge(task, payload, profile=None):
                if self.bridge == self._bridge:
                    return self.bridge(task, payload, profile, job['id'], attempt=job['attempt'])
                return self.bridge(task, payload, profile, job['id'])
            def progress(stage):
                nonlocal last_stage
                last_stage = text(stage, 'stage', 160)
                self._worker_update(project, job['id'], {'stage': last_stage}, expected_attempt=job['attempt'])
            analysis_task = 'translate' if job['task'] == 'translate_response' else job['task']
            if job['task'] in TRANSLATION_TASKS:
                try:
                    from .translation import run_translation
                except ImportError:
                    from translation import run_translation
                def translation_progress(partial):
                    nonlocal last_stage
                    last_stage = 'translation'
                    self._worker_update(project, job['id'], {'stage': last_stage, 'translation_progress': partial}, expected_attempt=job['attempt'])
                result = run_translation(job['payload'], bridge, translation_progress,
                    lambda: self._cancelled(job['id'], job['attempt']), profile=job.get('profile'),
                    cache_get=lambda key: self._translation_cache_get(project, key),
                    cache_put=lambda key, value: self._translation_cache_put(project, key, value))
            else:
                result = run_analysis(analysis_task, job['payload'], bridge,
                                      progress,
                                      lambda: self._cancelled(job['id'], job['attempt']), profile=job.get('profile'))
            warnings = result.get('connection_warnings', []) if job['task'] == 'connect' else []
            diagnostics = result.get('connection_diagnostics', []) if job['task'] == 'connect' else []
            if job['task'] not in TRANSLATION_TASKS:
                result = validate_result(analysis_task, result, job['payload'])
            if not self._cancelled(job['id'], job['attempt']):
                self._worker_update(project, job['id'], {'status': 'completed', 'stage': 'completed', 'result': result, 'connection_warnings': warnings, 'connection_diagnostics': diagnostics, 'completed_at': now()}, publish=True, expected_attempt=job['attempt'])
        except Exception as error:
            code, message = analysis_failure(error)
            update = {'status': 'failed', 'stage': 'failed', 'failed_stage': last_stage, 'error_code': code, 'error': message, 'completed_at': now()}
            if type(error).__name__ == 'AnalysisError':
                details = getattr(error, 'validation_failures', [])
                issue = validation_issue(error)
                descriptions = {'span_count': '인용 구절 개수 불일치', 'multiple_sentences': '한 연결에 여러 문장 포함', 'relationship': '연결 관계 값 오류', 'korean_reason': '연결 이유의 한국어 검증 실패', 'empty_reason': '연결 이유 누락', 'links_format': '연결 목록 형식 오류', 'source_spans_format': '리뷰 인용 형식 오류', 'response_spans_format': '답변 인용 형식 오류', 'missing_evidence': '리뷰 근거 누락', 'quote_absent': '원문과 인용 불일치', 'unknown_reference': '리뷰 또는 답변 식별자 불일치', 'context_too_large': '분석 입력 크기 초과', 'translation': '번역 결과 검증 실패', 'translation_protected_content': '수식·코드 보존 오류', 'other_validation': '기타 결과 검증 오류'}
                update['validation_details'] = {'issue': issue, 'attempts': details[:3]}
                update['error'] = f"{message} 검증 항목: {descriptions[issue]}"
            self._worker_update(project, job['id'], update, expected_attempt=job['attempt'])
