"""SQLite persistence and project mutations."""
from __future__ import annotations

from pathlib import Path
import base64
import copy
import hashlib
import io
import json
import logging
import os
import re
import sqlite3
import threading
import urllib.error
import urllib.parse
import urllib.request
import zipfile

if __package__:
    from .imports import ValidationError, digest, json_request, prepare_import, normalize_reviews, reparse_staged_import, text
    from .exports import assemble, validate_rules
    from .state import MAX_STATE_BYTES, now, uid, identifier, NotFound, Conflict, reject_secrets, empty_state, new_round, lookup, find_round, checked_texts, stale_mapping, invalidate, validate_edit
    from .jobs import JobStore
    from .restore import RestoreStore
else:
    from imports import ValidationError, digest, json_request, prepare_import, normalize_reviews, reparse_staged_import, text
    from exports import assemble, validate_rules
    from state import MAX_STATE_BYTES, now, uid, identifier, NotFound, Conflict, reject_secrets, empty_state, new_round, lookup, find_round, checked_texts, stale_mapping, invalidate, validate_edit
    from jobs import JobStore
    from restore import RestoreStore


class RebuttalStore(JobStore, RestoreStore):
    _request = staticmethod(json_request)

    def __init__(self, database_path, compiler=None, bridge=None, asset_write=None, asset_read=None, asset_delete=None):
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.compiler = compiler or self._compiler
        self.bridge = bridge or self._bridge
        self.asset_write = asset_write or self._asset_write
        self.asset_read = asset_read or self._asset_read
        self.asset_delete = asset_delete or self._asset_delete
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._worker = None
        self._translation_worker = None
        self._last_translation_project = None
        self._last_project = None
        with self._connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, round_id TEXT NOT NULL,
                    created_at TEXT NOT NULL, status TEXT NOT NULL, input_hash TEXT NOT NULL, data TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status,created_at,id);
                CREATE TABLE IF NOT EXISTS restore_requests(
                    project_id TEXT NOT NULL, actor TEXT NOT NULL, request_key TEXT NOT NULL,
                    snapshot_hash TEXT NOT NULL, result TEXT NOT NULL,
                    PRIMARY KEY(project_id, actor, request_key));
                CREATE TABLE IF NOT EXISTS worker_state(key TEXT PRIMARY KEY, value TEXT);
                CREATE TABLE IF NOT EXISTS translation_cache(project_id TEXT NOT NULL, cache_key TEXT NOT NULL, text TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project_id,cache_key));
                CREATE TABLE IF NOT EXISTS response_versions(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, round_id TEXT NOT NULL, document_id TEXT NOT NULL, created_at TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS response_versions_lookup ON response_versions(project_id,round_id,document_id,id DESC);
            ''')
            last = db.execute("SELECT value FROM worker_state WHERE key='last_project'").fetchone()
            self._last_project = last['value'] if last else None
            for row in db.execute("SELECT * FROM jobs WHERE status='running'").fetchall():
                data = json.loads(row['data']); data.update(status='failed', stage='interrupted', error='Service restarted; retry explicitly', completed_at=now())
                db.execute('UPDATE jobs SET status=?,data=? WHERE id=?', ('failed', json.dumps(data), row['id']))

    def _connect(self):
        db = sqlite3.connect(self.database_path, timeout=15)
        try:
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('PRAGMA busy_timeout=15000')
        except sqlite3.Error:
            db.close()
            raise
        return db

    @classmethod
    def _compiler(cls, path, payload):
        return cls._request(os.environ.get('COMPILER_URL', 'http://compiler:8000').rstrip('/') + path, payload, maximum=30_000_000)

    @staticmethod
    def _asset_write(project, path, data, actor):
        base = os.environ.get('BACKUP_URL')
        if not base:
            raise ValidationError('PDF source storage is unavailable')
        request = urllib.request.Request(base.rstrip('/') + '/projects/' + project + '/assets/' + path,
            data=data, method='PUT', headers={'Content-Type': 'application/pdf', 'X-Paper-Actor': actor or 'Shared user',
            'X-Paper-Role': 'editor', 'X-Paper-Allowed-Projects': project})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                if response.status not in {200, 201}: raise ValidationError('PDF source storage failed')
        except urllib.error.URLError:
            raise ValidationError('PDF source storage failed') from None

    @staticmethod
    def _asset_delete(project, path, actor):
        base = os.environ.get('BACKUP_URL')
        if not base:
            raise ValidationError('PDF source storage is unavailable')
        request = urllib.request.Request(base.rstrip('/') + '/projects/' + project + '/assets/' + path,
            method='DELETE', headers={'X-Paper-Actor': actor or 'Shared user', 'X-Paper-Role': 'editor',
            'X-Paper-Allowed-Projects': project})
        try:
            with urllib.request.urlopen(request, timeout=30):
                pass
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise ValidationError('PDF source cleanup failed') from None
        except urllib.error.URLError:
            raise ValidationError('PDF source cleanup failed') from None

    @staticmethod
    def _asset_read(project, path):
        if not re.fullmatch(r'rebuttal/sources/[a-f0-9]{64}\.pdf', path):
            raise ValidationError('invalid PDF source reference')
        base = os.environ.get('BACKUP_URL')
        if not base: raise ValidationError('PDF source storage is unavailable')
        request = urllib.request.Request(base.rstrip('/') + '/projects/' + project + '/assets/' + path,
            headers={'X-Paper-Allowed-Projects': project})
        try:
            with urllib.request.urlopen(request, timeout=30) as response: data = response.read(12_000_001)
        except urllib.error.URLError:
            raise ValidationError('PDF source retrieval failed') from None
        if len(data) > 12_000_000 or not data.startswith(b'%PDF-') or hashlib.sha256(data).hexdigest() != Path(path).stem:
            raise ValidationError('PDF source integrity verification failed')
        return data

    @classmethod
    def _bridge(cls, task, payload, profile=None, job_id=None, *, attempt=None):
        request = {'task': task, 'payload': payload, 'job_id': job_id}
        if profile is not None:
            request['profile'] = profile
        if attempt is not None:
            request['attempt'] = attempt
        result = cls._request(os.environ.get('CODEX_BRIDGE_URL', 'http://codex-bridge:8790').rstrip('/') + '/internal/rebuttal',
                              request, os.environ.get('CODEX_BRIDGE_TOKEN'), timeout=140)
        if not isinstance(result, dict) or not isinstance(result.get('result'), dict):
            raise ValidationError('invalid bridge response')
        return result['result']

    @staticmethod
    def _load(db, project):
        row = db.execute('SELECT * FROM projects WHERE id=?', (project,)).fetchone()
        return json.loads(row['state']) if row else empty_state()

    def _state(self, db, project):
        state = self._load(db, project)
        state['jobs'] = [self._public_job(json.loads(r['data'])) for r in db.execute('SELECT data FROM jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 200', (project,))]
        return state

    def state(self, project):
        identifier(project)
        with self._lock, self._connect() as db:
            return self._state(db, project)

    def response_document(self, db, project, round_id, document_id):
        round_ = find_round(self._load(db, project), identifier(round_id))
        document = lookup(round_['documents'], identifier(document_id))
        if document is None: raise NotFound('response document not found')
        return document

    def response_versions(self, project, round_id, document_id):
        with self._lock, self._connect() as db:
            document = self.response_document(db, project, round_id, document_id)
            rows = db.execute('SELECT id,created_at,content,reason,actor FROM response_versions WHERE project_id=? AND round_id=? AND document_id=? ORDER BY id DESC LIMIT 50', (project,round_id,document_id)).fetchall()
        versions = [dict(row) | {'source': 'response'} for row in rows]
        base = os.environ.get('BACKUP_URL')
        if base:
            headers = {'X-Paper-Actor': 'Rebuttal history', 'X-Paper-Role': 'viewer', 'X-Paper-Allowed-Projects': project}
            url = base.rstrip('/') + '/projects/' + urllib.parse.quote(project, safe='') + '/snapshots'
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=5) as response:
                    backups = json.load(response).get('snapshots', [])
                for backup in backups[:50]:
                    with urllib.request.urlopen(urllib.request.Request(url + '/' + str(int(backup['id'])), headers=headers), timeout=5) as response:
                        snapshot = json.load(response)['snapshot']['payload'].get('rebuttal')
                    old_round = next((r for r in (snapshot or {}).get('rounds', []) if r.get('id') == round_id), None)
                    old_doc = next((d for d in (old_round or {}).get('documents', []) if d.get('id') == document_id), None)
                    key = (old_doc or {}).get('text_key') or document_id
                    saved = (snapshot or {}).get('texts', {})
                    content = saved.get(key) if old_doc else None
                    versions.append({'id': 'paper-' + str(backup['id']), 'created_at': backup.get('created_at'), 'content': content if isinstance(content, str) else None, 'reason': 'paper', 'actor': backup.get('actor', ''), 'source': 'paper'})
            except (OSError, ValueError, KeyError, TypeError):
                # Report partial results instead of pretending the old backups do not exist.
                return {'versions': versions, 'paper_unavailable': True}
        versions.sort(key=lambda item: item.get('created_at') or '', reverse=True)
        return {'versions': versions, 'paper_unavailable': False}

    def save_response_version(self, project, round_id, document_id, payload, actor):
        content = payload.get('content')
        if not isinstance(content, str) or len(content.encode('utf-8')) > 2_000_000: raise ValidationError('invalid response content')
        reason = payload.get('reason', 'auto')
        if reason not in {'auto', 'pre-restore'}: raise ValidationError('invalid version reason')
        digest_value = hashlib.sha256(content.encode('utf-8')).hexdigest()
        with self._lock, self._connect() as db:
            self.response_document(db, project, round_id, document_id)
            last = db.execute('SELECT content_hash FROM response_versions WHERE project_id=? AND round_id=? AND document_id=? ORDER BY id DESC LIMIT 1', (project,round_id,document_id)).fetchone()
            if not last or last['content_hash'] != digest_value:
                db.execute('INSERT INTO response_versions(project_id,round_id,document_id,created_at,content,content_hash,reason,actor) VALUES(?,?,?,?,?,?,?,?)', (project,round_id,document_id,now(),content,digest_value,reason,actor))
                db.execute('DELETE FROM response_versions WHERE project_id=? AND round_id=? AND document_id=? AND id NOT IN (SELECT id FROM response_versions WHERE project_id=? AND round_id=? AND document_id=? ORDER BY id DESC LIMIT 50)', (project,round_id,document_id,project,round_id,document_id))
        return {'saved': True}

    @staticmethod
    def _save(db, project, state):
        state['revision'] += 1
        state['jobs'] = []
        reject_secrets(state)
        encoded = json.dumps(state, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        if len(encoded.encode()) > MAX_STATE_BYTES:
            raise ValidationError('project rebuttal data quota exceeded')
        db.execute('INSERT INTO projects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state', (project, state['revision'], encoded))

    def mutate(self, project, expected_revision, operation, *, replay=None, commit=None):
        identifier(project)
        if type(expected_revision) is not int or expected_revision < 0:
            raise ValidationError('expected_revision is required')
        with self._lock, self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            state = self._load(db, project)
            result = replay(db) if replay else None
            if result is None:
                if expected_revision != state['revision']:
                    raise Conflict(state['revision'])
                result = operation(state, db)
                self._save(db, project, state)
            response = self._state(db, project)
            if result is not None:
                response['result'] = result
            if commit:
                commit(db)
            return response

    def create_round(self, project, payload):
        def apply(state, db):
            if len(state['rounds']) >= 100:
                raise ValidationError('too many rounds')
            round_ = new_round(payload.get('title')); state['rounds'].append(round_)
            return {'round_id': round_['id']}
        return self.mutate(project, payload.get('expected_revision'), apply)

    def update_round(self, project, round_id, payload, actor='Shared user'):
        def apply(state, db):
            round_ = find_round(state, round_id)
            texts = checked_texts(round_, payload.get('texts', {}))
            reconfirmed = validate_edit(round_, payload.get('round'), texts, actor)
            invalidate(round_, texts)
            for mapping in round_['mappings']:
                if mapping['id'] in reconfirmed:
                    mapping.update(stale=False, needs_reconfirmation=False, decision='confirmed', confirmed_at=now(), confirmed_by=actor)
                    mapping['confirmed_input_hash'] = digest({'concern': lookup(round_['concerns'], mapping['concern_id']), 'texts': texts})
        return self.mutate(project, payload.get('expected_revision'), apply)

    def create_document(self, project, round_id, payload):
        def apply(state, db):
            round_ = find_round(state, round_id)
            kind = payload.get('kind', 'reviewer')
            if kind not in {'reviewer', 'common', 'unified'} or len(round_['documents']) >= 400:
                raise ValidationError('invalid document kind or limit')
            reviewer_id = payload.get('reviewer_id')
            if reviewer_id is not None and lookup(round_['reviewers'], reviewer_id) is None:
                raise ValidationError('unknown reviewer')
            document_id = uid()
            document = {'id': document_id, 'title': text(payload.get('title'), 'title', 500), 'kind': kind,
                        'reviewer_id': reviewer_id, 'text_key': document_id, 'seed_text': ''}
            round_['documents'].append(document)
            for mapping in round_['mappings']: stale_mapping(mapping, 'document_added')
            return {'document': document}
        return self.mutate(project, payload.get('expected_revision'), apply)

    def stage_import(self, project, round_id, payload, sessions=None, actor=None, session_id=None):
        # Network reads happen outside the write transaction, but revision is checked again at commit.
        current = self.state(project)
        if current['revision'] != payload.get('expected_revision'):
            raise Conflict(current['revision'])
        find_round(current, round_id)
        staged = prepare_import(payload, self.compiler, sessions, actor, session_id)
        staged.update(created_at=now(), actor=actor)
        source = None
        asset_path = None
        referenced = False
        if staged['kind'] == 'pdf':
            source = base64.b64decode(staged['raw'].pop('data_base64'), validate=True)
            source_hash = hashlib.sha256(source).hexdigest()
            asset_path = 'rebuttal/sources/' + source_hash + '.pdf'
            staged['raw']['asset'] = {'path': asset_path, 'sha256': source_hash, 'size_bytes': len(source), 'mime': 'application/pdf'}
            staged['source_hash'] = digest(staged['raw'])

        def apply(state, db):
            nonlocal referenced
            round_ = find_round(state, round_id)
            if len(round_['imports']) >= 200:
                raise ValidationError('too many imports')
            if asset_path:
                referenced = any(
                    item.get('raw', {}).get('asset', {}).get('path') == asset_path
                    for existing in state['rounds'] for item in existing['imports'])
            round_['imports'].append(staged)
            return {'import': staged}

        def commit(db):
            # Validate the revision and quotas before creating the asset. Keep the
            # SQLite reservation across the write so another import cannot race cleanup.
            try:
                self.asset_write(project, asset_path, source, actor)
                db.commit()
            except Exception:
                if not referenced:
                    try:
                        self.asset_delete(project, asset_path, actor)
                    except Exception:
                        logging.getLogger(__name__).warning('Failed to clean up staged PDF asset')
                raise

        return self.mutate(project, payload.get('expected_revision'), apply, commit=commit if asset_path else None)

    def reparse_import(self, project, round_id, import_id, payload):
        def apply(state, db):
            staged = lookup(find_round(state, round_id)['imports'], import_id)
            if staged is None:
                raise NotFound('import not found')
            reparse_staged_import(staged)
            return {'import': staged}
        return self.mutate(project, payload.get('expected_revision'), apply)

    def commit_import(self, project, round_id, import_id, payload, actor):
        def apply(state, db):
            round_ = find_round(state, round_id)
            staged = lookup(round_['imports'], import_id)
            if staged is None:
                raise NotFound('import not found')
            if staged['status'] != 'staged':
                raise ValidationError('import is already committed')
            edited = normalize_reviews(payload.get('reviews'))
            if staged['kind'] == 'openreview':
                raw_by_note = {r.get('note_id'): r for r in staged['reviews']}
                if any(r.get('note_id') not in raw_by_note for r in edited):
                    raise ValidationError('unknown OpenReview note')
                for review in edited:
                    raw = raw_by_note[review['note_id']]
                    if raw['reviewer_id'] != review['reviewer_id']:
                        raise ValidationError('OpenReview signatures are immutable')
                    review['signatures'] = raw.get('signatures', [])
                    review['source_version'] = raw.get('source_version')
                returned = {r.get('note_id') for r in edited}
                edited += [copy.deepcopy(r) for r in staged['reviews'] if r.get('note_id') not in returned]
            for incoming in edited:
                label = incoming['reviewer_id']
                reviewer = next((r for r in round_['reviewers'] if r.get('label') == label), None)
                if reviewer is None:
                    reviewer = {'id': uid(), 'label': label}; round_['reviewers'].append(reviewer)
                previous = next((r for r in round_['reviews'] if incoming.get('note_id') and r.get('note_id') == incoming['note_id']), None)
                source_revision = {'id': uid(), 'fields': incoming['fields'], 'source_id': import_id,
                                   'source_version': incoming.get('source_version'), 'created_at': now(), 'actor': actor}
                if previous:
                    previous.setdefault('source_revisions', []).append(source_revision)
                    # Imported updates are immutable revisions; existing cited text remains stable.
                    continue
                review = {'id': uid(), 'reviewer_id': reviewer['id'], 'fields': incoming['fields'], 'translations': {},
                          'source_id': import_id, 'source_revisions': [source_revision], 'translation_revisions': [],
                          'signatures': incoming.get('signatures', [])}
                for key in ('note_id', 'source_version', 'source_type', 'extraction'):
                    if incoming.get(key) is not None:
                        review[key] = incoming[key]
                round_['reviews'].append(review)
            staged['status'] = 'committed'
            staged['committed_at'] = now()
            staged['extraction_revision'] = {'id': uid(), 'reviews': edited, 'actor': actor, 'created_at': now()}
            return {'import_id': import_id}
        return self.mutate(project, payload.get('expected_revision'), apply)

    def add_rules(self, project, round_id, payload, actor):
        rules = validate_rules(payload.get('rules'))
        rules.update(id=uid(), status='draft', created_at=now(), actor=actor)
        def apply(state, db):
            find_round(state, round_id)['rules'].append(rules)
            return {'rules': rules}
        return self.mutate(project, payload.get('expected_revision'), apply)

    def apply_rules(self, project, round_id, rule_id, payload, actor):
        def apply(state, db):
            round_ = find_round(state, round_id)
            draft = lookup(round_['rules'], rule_id)
            if draft is None:
                raise NotFound('rules not found')
            applied = copy.deepcopy(draft)
            applied.update(id=uid(), draft_id=rule_id, status='applied', applied_at=now(), applied_by=actor)
            round_['rules'].append(applied); round_['active_rules_id'] = applied['id']
            return {'rules': applied}
        return self.mutate(project, payload.get('expected_revision'), apply)

    def export(self, project, round_id, payload):
        state = self.state(project)
        if state['revision'] != payload.get('expected_revision'):
            raise Conflict(state['revision'])
        round_ = find_round(state, round_id)
        result = assemble(round_, payload, self.compiler)
        format_ = payload.get('format', 'markdown')
        if format_ == 'json':
            public = json.loads(result['content'])
            public.update(schema_version=1, round=round_, texts=payload.get('texts', {}))
            result['content'] = json.dumps(public, ensure_ascii=False, indent=2)
        elif format_ == 'zip':
            buffer = io.BytesIO(base64.b64decode(result['data_base64']))
            with zipfile.ZipFile(buffer, 'a', zipfile.ZIP_DEFLATED) as archive:
                archive.writestr('round.json', json.dumps({'schema_version': 1, 'rounds': [round_], 'texts': payload.get('texts', {})}, ensure_ascii=False, indent=2))
                for imported in round_['imports']:
                    asset = imported.get('raw', {}).get('asset')
                    if asset:
                        archive.writestr('sources/' + asset['sha256'] + '.pdf', self.asset_read(project, asset['path']))
            result['data_base64'] = base64.b64encode(buffer.getvalue()).decode()
        state['result'] = result
        return state

    def submit(self, project, round_id, payload, actor):
        state = self.state(project)
        if state['revision'] != payload.get('expected_revision'):
            raise Conflict(state['revision'])
        result = assemble(find_round(state, round_id), payload, self.compiler)
        if any(not check['passed'] for check in result['checks']):
            raise ValidationError('submission exceeds the active mechanical rules')
        def apply(current, db):
            round_ = find_round(current, round_id)
            submission = {'id': uid(), 'created_at': now(), 'actor': actor, 'rules_id': round_['active_rules_id'],
                          'input_hash': digest({'texts': payload.get('texts'), 'target': payload.get('target')}),
                          'output': result, 'texts': checked_texts(round_, payload.get('texts', {}))}
            round_['submissions'].append(submission)
            return {'submission': submission, **result}
        return self.mutate(project, payload.get('expected_revision'), apply)
