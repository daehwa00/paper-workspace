"""Bounded review ingestion. OpenReview credentials exist only in SessionPool memory."""
from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

_MODULE_DIR = str(Path(__file__).resolve().parent)
if _MODULE_DIR not in sys.path:
    sys.path.insert(0, _MODULE_DIR)
try:
    from .review_structure import structure_reviews
    from .pdf_linebreaks import normalize as normalize_pdf_linebreaks
except ImportError:
    from review_structure import structure_reviews
    from pdf_linebreaks import normalize as normalize_pdf_linebreaks

MAX_FILE_BYTES = 12_000_000
MAX_TEXT = 2_000_000
MAX_REVIEWS = 400


class ValidationError(ValueError):
    pass


class UpstreamRequestError(ValidationError):
    def __init__(self, status, code=None):
        super().__init__('upstream request failed')
        self.status = status
        self.code = code


BRIDGE_ERROR_CODES = frozenset({'bridge_cancelled', 'model_timeout', 'bridge_busy', 'model_unavailable',
                                'model_response_invalid', 'bridge_invalid_request', 'model_rate_limited',
                                'model_auth_failed', 'model_execution_failed'})


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def text(value, name='text', maximum=MAX_TEXT):
    if not isinstance(value, str) or len(value) > maximum:
        raise ValidationError(f'invalid {name}')
    return value


def json_request(url, payload=None, token=None, maximum=MAX_FILE_BYTES, *, timeout=90):
    headers = {'Accept': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    data = None if payload is None else json.dumps(payload).encode()
    if data is not None:
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(maximum + 1)
        if len(raw) > maximum:
            raise ValidationError('upstream response is too large')
        return json.loads(raw)
    except urllib.error.HTTPError as exc:
        code = None
        try:
            details = json.loads(exc.read(8193))
            candidate = details.get('error_code') if isinstance(details, dict) else None
            if isinstance(candidate, str) and candidate in BRIDGE_ERROR_CODES:
                code = candidate
        except (ValueError, UnicodeDecodeError, OSError):
            pass
        raise UpstreamRequestError(exc.code, code) from None
    except TimeoutError:
        raise ValidationError('upstream request timed out') from None
    except (urllib.error.URLError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        # Never expose upstream exceptions: they may contain credentials or tokens.
        raise ValidationError('upstream request failed') from None


def decode_file(payload):
    try:
        value = text(payload.get('data_base64'), 'file', MAX_FILE_BYTES * 2)
        data = base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        raise ValidationError('invalid base64 file') from None
    if not data or len(data) > MAX_FILE_BYTES:
        raise ValidationError('file is empty or too large')
    return data


def normalize_reviews(value):
    if isinstance(value, dict):
        value = value.get('reviews', value.get('notes', [value]))
    if not isinstance(value, list) or not value or len(value) > MAX_REVIEWS:
        raise ValidationError('reviews must be a non-empty bounded array')
    reviews = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise ValidationError('invalid review')
        fields = item.get('fields', item.get('content'))
        if fields is None and 'text' in item:
            fields = {'review': item['text']}
        if not isinstance(fields, dict) or not fields or len(fields) > 80:
            raise ValidationError('invalid review fields')
        clean = {}
        for key, field in fields.items():
            text(key, 'field name', 160)
            if isinstance(field, dict) and 'value' in field:
                field = field['value']
            if isinstance(field, (int, float, bool)):
                field = str(field)
            if isinstance(field, list):
                field = json.dumps(field, ensure_ascii=False)
            clean[key] = text(field, 'field')
        signatures = item.get('signatures') or []
        if not isinstance(signatures, list): raise ValidationError('invalid source signatures')
        version = item.get('source_version', item.get('mdate', item.get('tmdate')))
        if version is not None and (type(version) not in {str, int} or len(str(version)) > 240): raise ValidationError('invalid source version')
        reviewer = item.get('reviewer_id') or (signatures[0] if signatures else f'Reviewer {index + 1}')
        note_id = item.get('note_id', item.get('id'))
        if note_id is not None:
            text(note_id, 'note id', 240)
        normalized = {'reviewer_id': text(reviewer, 'reviewer', 240), 'fields': clean,
                        'note_id': note_id, 'source_version': version,
                        'signatures': [text(s, 'signature', 240) for s in signatures[:20]]}
        source_type = item.get('source_type')
        if source_type is not None:
            if source_type not in {'official_review', 'ai_review', 'comment', 'unstructured'}:
                raise ValidationError('invalid review source type')
            normalized['source_type'] = source_type
        if 'suggested_include' in item:
            if type(item['suggested_include']) is not bool:
                raise ValidationError('invalid suggested inclusion')
            normalized['suggested_include'] = item['suggested_include']
        extraction = item.get('extraction')
        if extraction is not None:
            if not isinstance(extraction, dict) or extraction.get('parser') != 'openreview-print-v1':
                raise ValidationError('invalid extraction provenance')
            if any(extraction.get(k) is not None and (type(extraction[k]) is not int or not 1 <= extraction[k] <= 1000) for k in ('start_page','end_page')):
                raise ValidationError('invalid extraction page')
            normalized['extraction'] = {k: extraction.get(k) for k in ('parser','start_page','end_page')}
        reviews.append(normalized)
    return reviews


def prepare_import(payload, compiler, sessions=None, actor=None, session_id=None):
    kind = payload.get('kind')
    pages = []
    if kind == 'openreview':
        if sessions is None:
            raise ValidationError('OpenReview is unavailable')
        raw = sessions.notes(actor, session_id, payload.get('forum'), payload.get('api_version', 2), payload.get('connection_id'))
        reviews = normalize_reviews(raw)
    elif kind == 'pdf':
        data = decode_file(payload)
        if not data.startswith(b'%PDF-'):
            raise ValidationError('file signature is not PDF')
        result = compiler('/extract-review', {'data_base64': base64.b64encode(data).decode()})
        if not isinstance(result, dict) or not isinstance(result.get('pages'), list):
            raise ValidationError('invalid PDF extraction response')
        pages = [{'page': p['page'], 'text': text(p['text'])} for p in result['pages'][:1000]]
        extracted = text(result.get('text', '\n'.join(p['text'] for p in pages)))
        raw = {'filename': text(payload.get('filename', 'review.pdf'), 'filename', 240),
               'data_base64': base64.b64encode(data).decode(), 'pages': pages, 'text': extracted}
        reviews = normalize_reviews([{'text': extracted}])
    elif kind in {'text', 'json'}:
        value = payload.get('text')
        if value is None and payload.get('data_base64') is not None:
            try:
                value = decode_file(payload).decode('utf-8-sig')
            except UnicodeDecodeError:
                raise ValidationError('review file must be UTF-8') from None
        value = text(value)
        raw = {'filename': text(payload.get('filename', 'review.' + ('json' if kind == 'json' else 'txt')), 'filename', 240), 'text': value}
        if kind == 'json':
            try:
                parsed = json.loads(value)
            except json.JSONDecodeError:
                raise ValidationError('invalid review JSON') from None
            reviews = normalize_reviews(parsed)
        else:
            reviews = normalize_reviews([{'text': value}])
    else:
        raise ValidationError('invalid import kind')
    structure = None
    if kind in {'pdf', 'text'}:
        structured = structure_reviews(raw['text'], pages)
        if structured:
            reviews = normalize_reviews(structured['reviews'])
            structure = structured['structure']
    if kind == 'pdf':
        clean_pdf_review_linebreaks(reviews)
    return {'id': secrets.token_hex(16), 'kind': kind, 'status': 'staged', 'raw': raw,
            'source_hash': digest(raw), 'reviews': reviews, 'pages': pages, 'structure': structure}


def clean_pdf_review_linebreaks(reviews):
    for review in reviews:
        review['fields'] = {name: normalize_pdf_linebreaks(value)[0]
                            for name, value in review['fields'].items()}


def reparse_staged_import(staged):
    """Refresh a pending proposal only; committed sources and original bytes stay intact."""
    if staged.get('status') != 'staged' or staged.get('kind') not in {'pdf', 'text'}:
        raise ValidationError('only pending PDF or text imports can be organized again')
    raw = staged.get('raw', {})
    structured = structure_reviews(text(raw.get('text'), 'source text'), staged.get('pages', raw.get('pages', [])))
    if structured:
        proposed = normalize_reviews(structured['reviews'])
        if staged.get('kind') == 'pdf':
            clean_pdf_review_linebreaks(proposed)
        if staged.get('reviews') != proposed:
            staged.setdefault('structure_revisions', []).append({'reviews': staged.get('reviews', []), 'structure': staged.get('structure')})
            staged['reviews'] = proposed
        staged['structure'] = structured['structure']
    return staged


class SDKNoteReader:
    """Official token-authenticated SDK reads with bounded HTTP and raw provenance.

    The SDK's guest constructor may log in using OPENREVIEW_USERNAME/PASSWORD.
    Public reads therefore stay on the credential-free REST path in SessionPool.
    Login/MFA also stay on explicit HTTP to avoid the SDK's interactive prompts.
    """
    def __init__(self, version, baseurl, token):
        # Lazy imports keep text/JSON development independent of the optional SDK.
        import openreview
        import requests

        client_type = openreview.api.OpenReviewClient if version == 2 else openreview.Client

        class NoteClient(client_type):
            def get_profile(self, *args, **kwargs):
                # Construction otherwise performs an unnecessary, unbounded profile read.
                return None

        class BoundedSession(requests.Session):
            def __init__(self):
                super().__init__()
                self.trust_env = False
                self.last_response = None

            def request(self, method, url, **kwargs):
                kwargs.update(timeout=(10, 30), allow_redirects=False, stream=True)
                response = super().request(method, url, **kwargs)
                try:
                    raw = response.raw.read(MAX_FILE_BYTES + 1, decode_content=True)
                    if len(raw) > MAX_FILE_BYTES:
                        raise ValidationError('OpenReview response is too large')
                    response._content = raw
                    response._content_consumed = True
                    self.last_response = response
                    return response
                finally:
                    response.close()

        self.client = NoteClient(baseurl=baseurl, token=token)
        self.client.session.close()
        # A fresh requests Session uses zero retries, unlike the SDK's long backoff.
        self.client.session = BoundedSession()

    def page(self, forum, offset, limit):
        self.client.get_notes(forum=forum, offset=offset, limit=limit, with_count=True)
        response = self.client.session.last_response
        if response is None:
            raise ValidationError('invalid OpenReview SDK response')
        # Note.to_json omits some original fields (e.g. API v2 tmdate/details).
        # Capture the same SDK response JSON so immutable source provenance is exact.
        return response.json()

    def close(self):
        self.client.session.close()


class SessionPool:
    """Actor + opaque browser cookie binding; neither passwords nor tokens are persisted."""
    def __init__(self, request=json_request, ttl=3600, sdk_factory=None):
        self.request = request
        self.sdk_factory = sdk_factory or SDKNoteReader
        self.ttl = min(ttl, 3600)
        self._entries = {}
        self._lock = threading.RLock()

    def _prune(self):
        for key in list(self._entries):
            if self._entries[key]['expires'] <= time.time():
                del self._entries[key]

    @staticmethod
    def _base(version):
        if type(version) is not int or version not in {1, 2}:
            raise ValidationError('invalid OpenReview API version')
        return 'https://api2.openreview.net' if version == 2 else 'https://api.openreview.net'

    def connect(self, actor, session_id, username, password, version=2):
        text(username, 'username', 320); text(password, 'password', 4096)
        result = self.request(self._base(version) + '/login', {'id': username, 'password': password, 'expiresIn': 3600})
        entry = {'actor': actor, 'version': version, 'expires': time.time() + self.ttl,
                 'connection_id': secrets.token_hex(16)}
        if result.get('mfaPending'):
            entry.update(pending=result.get('mfaPendingToken'), methods=result.get('mfaMethods', []), challenge_id=secrets.token_hex(16))
            if not entry['pending']:
                raise ValidationError('invalid OpenReview MFA challenge')
            public = {'challenge_id': entry['challenge_id'], 'methods': entry['methods'], 'mfa_required': True}
        else:
            entry['token'] = result.get('token')
            if not isinstance(entry['token'], str) or not entry['token']:
                raise ValidationError('OpenReview authentication failed')
            public = {'connection_id': entry['connection_id'], 'connected': True}
        with self._lock:
            self._prune()
            if session_id not in self._entries and len(self._entries) >= 100:
                raise ValidationError('too many OpenReview sessions')
            self._entries[session_id] = entry
        return public

    def _entry(self, actor, session_id):
        self._prune()
        entry = self._entries.get(session_id)
        if not entry or entry['actor'] != actor:
            raise ValidationError('OpenReview session expired or unavailable')
        return entry

    def mfa(self, actor, session_id, challenge_id, method, code):
        with self._lock:
            entry = self._entry(actor, session_id)
            if challenge_id != entry.get('challenge_id') or method not in entry.get('methods', []):
                raise ValidationError('invalid MFA challenge')
            payload = {'mfaPendingToken': entry['pending'], 'method': method}
            base = self._base(entry['version'])
        sending_code = not code and method == 'emailOtp'
        if sending_code:
            self.request(base + '/mfa/challenge', payload)
        else:
            payload['code'] = text(code, 'MFA code', 200)
            result = self.request(base + '/mfa/verify', payload)
            if not isinstance(result.get('token'), str) or not result['token']:
                raise ValidationError('MFA verification failed')
        with self._lock:
            current = self._entry(actor, session_id)
            if current is not entry or current.get('challenge_id') != challenge_id:
                raise ValidationError('OpenReview MFA challenge changed')
            if sending_code:
                return {'challenge_id': challenge_id, 'methods': entry['methods'], 'code_sent': True}
            entry['token'] = result['token']
            entry.pop('pending', None)
            entry.pop('challenge_id', None)
            entry.pop('methods', None)
            return {'connection_id': entry['connection_id'], 'connected': True}

    def disconnect(self, actor, session_id):
        with self._lock:
            entry = self._entries.get(session_id)
            if entry and entry['actor'] == actor:
                del self._entries[session_id]

    def notes(self, actor, session_id, forum, version=2, connection_id=None):
        forum = text(forum, 'forum', 500)
        if forum.startswith('https://openreview.net/forum?'):
            forum = urllib.parse.parse_qs(urllib.parse.urlsplit(forum).query).get('id', [''])[0]
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,240}', forum):
            raise ValidationError('invalid OpenReview forum')
        token = None
        if connection_id or session_id:
            with self._lock:
                entry = self._entries.get(session_id)
                if entry:
                    entry = self._entry(actor, session_id)
                    if connection_id and entry['connection_id'] != connection_id:
                        raise ValidationError('invalid OpenReview connection')
                    if entry['version'] != version or not entry.get('token'):
                        raise ValidationError('OpenReview authentication incomplete')
                    token = entry['token']
                elif connection_id:
                    raise ValidationError('OpenReview session expired')
        # The official SDK is used only with this browser session's explicit token.
        # Public reads never instantiate it, so ambient server credentials cannot leak.
        reader = None
        try:
            baseurl = self._base(version)
            if token:
                reader = self.sdk_factory(version, baseurl, token)
            notes = []
            while len(notes) < MAX_REVIEWS:
                if reader is not None:
                    result = reader.page(forum, offset=len(notes), limit=100)
                else:
                    query = urllib.parse.urlencode({'forum': forum, 'limit': 100, 'offset': len(notes)})
                    result = self.request(baseurl + '/notes?' + query)
                if not isinstance(result, dict):
                    raise ValidationError('invalid OpenReview notes')
                batch = result.get('notes')
                total = result.get('count')
                if not isinstance(batch, list) or len(batch) > 100 or any(not isinstance(n, dict) for n in batch):
                    raise ValidationError('invalid OpenReview notes')
                if total is not None and (type(total) is not int or total < 0):
                    raise ValidationError('invalid OpenReview note count')
                if total is not None and total > MAX_REVIEWS:
                    raise ValidationError('too many OpenReview notes')
                notes.extend(batch)
                if len(batch) < 100 or total is not None and len(notes) >= total:
                    return notes
            if total is None:
                raise ValidationError('OpenReview note limit reached without a complete count')
            return notes
        except ValidationError:
            raise
        except Exception:
            # SDK/requests exceptions can embed tokens or other authentication details.
            raise ValidationError('OpenReview note retrieval failed') from None
        finally:
            if reader is not None:
                try: reader.close()
                except Exception: pass
