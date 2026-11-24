from __future__ import annotations

import base64
import copy
import importlib.util
import json
from pathlib import Path

import pytest

PATH = Path(__file__).parents[2] / 'apps/paper_workspace/rebuttal/imports.py'


def load():
    spec = importlib.util.spec_from_file_location('paper_rebuttal_imports', PATH)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize('kind,value,expected', [
    ('text', 'A reviewer comment', 'A reviewer comment'),
    ('json', '{"reviews":[{"reviewer_id":"R1","fields":{"summary":"A review","rating":4}}]}', 'A review'),
    ('json', '{"notes":[{"id":"note1","signatures":["Venue/Reviewer_1"],"content":{"review":{"value":"A review"}}}]}', 'A review'),
])
def test_text_json_and_openreview_shaped_json_preview(kind, value, expected):
    api = load()
    preview = api.prepare_import({'kind': kind, 'data_base64': base64.b64encode(value.encode()).decode(), 'filename': 'review.txt'}, None)
    assert preview['status'] == 'staged'
    assert expected in preview['reviews'][0]['fields'].values()
    assert preview['raw']['text'] == value
    assert preview['source_hash'] == api.digest(preview['raw'])


@pytest.mark.parametrize('payload', [
    {'kind': 'json', 'text': '{broken'},
    {'kind': 'text', 'data_base64': 'not base64'},
    {'kind': 'pdf', 'data_base64': base64.b64encode(b'not pdf').decode()},
    {'kind': 'json', 'text': '{"reviews":[]}'},
    {'kind': 'other', 'text': 'source'},
])
def test_malformed_sources_fail_closed(payload):
    api = load()
    with pytest.raises(api.ValidationError): api.prepare_import(payload, lambda *a: {})


def test_memory_only_mfa_actor_binding_expiry_and_no_token_in_public_result(monkeypatch):
    api = load(); calls = []
    def request(url, payload=None, token=None):
        calls.append((url, payload, token))
        if url.endswith('/login'): return {'mfaPending': True, 'mfaPendingToken': 'SENSITIVE-PENDING', 'mfaMethods': ['totp', 'emailOtp']}
        if url.endswith('/mfa/challenge'): return {}
        if url.endswith('/mfa/verify'): return {'token': 'SENSITIVE-TOKEN'}
        return {'notes': [{'id': 'note', 'signatures': ['Reviewer'], 'content': {'review': {'value': 'Review'}}}], 'count': 1}
    sdk_calls = []
    class SDK:
        def page(self, forum, offset, limit):
            sdk_calls.append((forum, offset, limit))
            return request('https://api2.openreview.net/notes', token='SENSITIVE-TOKEN')
        def close(self): pass
    pool = api.SessionPool(request=request, sdk_factory=lambda version, baseurl, token: SDK())
    challenge = pool.connect('Dae', 'browser', 'email@example.org', 'SENSITIVE-PASSWORD')
    assert challenge['mfa_required'] is True
    assert 'SENSITIVE' not in json.dumps(challenge)
    with pytest.raises(api.ValidationError): pool.mfa('Someone else', 'browser', challenge['challenge_id'], 'totp', '123456')
    sent = pool.mfa('Dae', 'browser', challenge['challenge_id'], 'emailOtp', '')
    assert sent['code_sent'] is True
    connection = pool.mfa('Dae', 'browser', challenge['challenge_id'], 'totp', '123456')
    assert 'SENSITIVE' not in json.dumps(connection)
    notes = pool.notes('Dae', 'browser', 'https://openreview.net/forum?id=Forum123', connection_id=connection['connection_id'])
    assert notes[0]['id'] == 'note'
    assert calls[-1][2] == 'SENSITIVE-TOKEN'
    assert sdk_calls == [('Forum123', 0, 100)]
    assert 'password' not in pool._entries['browser']
    monkeypatch.setattr(api.time, 'time', lambda: pool._entries['browser']['expires'] + 1)
    with pytest.raises(api.ValidationError, match='expired'): pool.notes('Dae', 'browser', 'Forum123', connection_id=connection['connection_id'])


def test_public_forum_pagination_and_signature_preservation():
    api = load(); pages = []
    def request(url, payload=None, token=None):
        pages.append(url)
        offset = 100 if 'offset=100' in url else 0
        count = 2 if offset else 100
        return {'notes': [{'id': f'n{offset + i}', 'signatures': ['Venue/Reviewer_1'], 'mdate': 7,
                           'content': {'review': {'value': f'Review {offset + i}'}}} for i in range(count)], 'count': 102}
    pool = api.SessionPool(request=request)
    preview = api.prepare_import({'kind': 'openreview', 'forum': 'Forum123'}, None, pool, 'Dae', None)
    assert len(preview['reviews']) == 102 and len(pages) == 2
    assert preview['reviews'][0]['signatures'] == ['Venue/Reviewer_1']
    assert preview['reviews'][0]['source_version'] == 7
    assert 'token' not in json.dumps(preview)


def test_openreview_partial_commit_keeps_unreturned_notes_and_reimport_keeps_original(tmp_path):
    server_path = PATH.with_name('server.py')
    spec = importlib.util.spec_from_file_location('paper_rebuttal_service', server_path)
    server = importlib.util.module_from_spec(spec); spec.loader.exec_module(server)
    store = server.RebuttalStore(tmp_path / 'domain.sqlite3')
    state = store.create_round('paper', {'title': 'Round', 'expected_revision': 0}); rid = state['rounds'][0]['id']
    class Sessions:
        def notes(self, *args):
            return [{'id': 'note1', 'signatures': ['Venue/R1'], 'mdate': 1, 'content': {'review': {'value': 'Original'}}},
                    {'id': 'note2', 'signatures': ['Venue/R2'], 'content': {'review': {'value': 'Must preserve'}}}]
    staged = store.stage_import('paper', rid, {'kind': 'openreview', 'forum': 'Forum', 'expected_revision': state['revision']}, Sessions(), 'Dae')['result']['import']
    edited = copy.deepcopy(staged['reviews'][:1]); edited[0]['fields']['review'] = 'Edited extraction'
    state = store.commit_import('paper', rid, staged['id'], {'reviews': edited, 'expected_revision': store.state('paper')['revision']}, 'Dae')
    assert {r['note_id'] for r in state['rounds'][0]['reviews']} == {'note1', 'note2'}
    review_id = state['rounds'][0]['reviews'][0]['id']
    staged2 = store.stage_import('paper', rid, {'kind': 'openreview', 'forum': 'Forum', 'expected_revision': state['revision']}, Sessions(), 'Dae')['result']['import']
    edited = copy.deepcopy(staged2['reviews']); edited[0]['fields']['review'] = 'Updated upstream'
    state = store.commit_import('paper', rid, staged2['id'], {'reviews': edited, 'expected_revision': store.state('paper')['revision']}, 'Dae')
    review = state['rounds'][0]['reviews'][0]
    assert review['id'] == review_id
    assert review['fields']['review'] == 'Edited extraction'
    assert review['source_revisions'][-1]['fields']['review'] == 'Updated upstream'
    assert state['rounds'][0]['imports'][0]['raw'][0]['content']['review']['value'] == 'Original'


def test_disconnect_revokes_only_the_bound_actor():
    api = load()
    pool = api.SessionPool(request=lambda *a, **k: {'token': 'PRIVATE'})
    connection = pool.connect('Dae', 'browser', 'user', 'password')
    pool.disconnect('Other', 'browser')
    assert pool._entries['browser']['actor'] == 'Dae'
    pool.disconnect('Dae', 'browser')
    assert not pool._entries
    with pytest.raises(api.ValidationError): pool.notes('Dae', 'browser', 'Forum', connection_id=connection['connection_id'])


@pytest.mark.parametrize('version', [1, 2])
def test_authenticated_sdk_matches_public_source_and_preserves_bounded_paging(version, monkeypatch):
    api = load()
    monkeypatch.setenv('OPENREVIEW_USERNAME', 'AMBIENT-USER')
    monkeypatch.setenv('OPENREVIEW_PASSWORD', 'AMBIENT-PASSWORD')
    notes = [{'id': f'n{i}', 'signatures': ['Venue/Reviewer'], 'tmdate': 123, 'details': {'original': 'preserve'},
              'custom_provenance': {'original_order': i}, 'content': {'review': {'value': f'Review {i}'} if version == 2 else f'Review {i}'}}
             for i in range(102)]
    public_calls, sdk_calls, factories, closed = [], [], [], []
    def request(url, payload=None, token=None):
        if url.endswith('/login'): return {'token': 'EXPLICIT-SESSION-TOKEN'}
        assert token is None
        assert payload is None
        public_calls.append(url)
        offset = 100 if 'offset=100' in url else 0
        return {'notes': copy.deepcopy(notes[offset:offset + 100]), 'count': len(notes)}
    class SDK:
        def page(self, forum, offset, limit):
            sdk_calls.append((forum, offset, limit))
            return {'notes': copy.deepcopy(notes[offset:offset + limit]), 'count': len(notes)}
        def close(self): closed.append(True)
    def factory(sdk_version, baseurl, token):
        factories.append((sdk_version, baseurl, token))
        return SDK()
    pool = api.SessionPool(request=request, sdk_factory=factory)
    payload = {'kind': 'openreview', 'forum': 'Forum123', 'api_version': version}
    public = api.prepare_import(payload, None, pool, 'Dae', None)
    assert factories == []
    connection = pool.connect('Dae', 'browser', 'user', 'password', version)
    private = api.prepare_import({**payload, 'connection_id': connection['connection_id']}, None, pool, 'Dae', 'browser')
    assert factories == [(version, pool._base(version), 'EXPLICIT-SESSION-TOKEN')]
    assert sdk_calls == [('Forum123', 0, 100), ('Forum123', 100, 100)]
    assert len(public_calls) == 2 and closed == [True]
    assert private['raw'] == public['raw'] == notes
    assert private['source_hash'] == public['source_hash']
    assert private['reviews'] == public['reviews']
    assert private['reviews'][0]['source_version'] == 123
    assert 'EXPLICIT-SESSION-TOKEN' not in json.dumps(private)
    assert 'AMBIENT-' not in json.dumps(private)


@pytest.mark.parametrize('mode', ['too_many', 'oversized_page', 'exception', 'valid_max'])
def test_sdk_read_limits_and_exception_redaction(mode):
    api = load(); calls, closed = [], []
    class SDK:
        def page(self, forum, offset, limit):
            calls.append((offset, limit))
            if mode == 'exception': raise RuntimeError('Bearer PRIVATE-TOKEN credentials PRIVATE-PASSWORD')
            size = 101 if mode == 'oversized_page' else 100
            return {'notes': [{'id': f'n{offset+i}', 'content': {'review': 'Review'}} for i in range(size)],
                    'count': 401 if mode == 'too_many' else 400}
        def close(self): closed.append(True)
    pool = api.SessionPool(request=lambda *a, **k: {'token': 'PRIVATE-TOKEN'}, sdk_factory=lambda *a: SDK())
    connection = pool.connect('Dae', 'browser', 'user', 'PRIVATE-PASSWORD')
    if mode == 'valid_max':
        assert len(pool.notes('Dae', 'browser', 'Forum', connection_id=connection['connection_id'])) == 400
        assert calls == [(0, 100), (100, 100), (200, 100), (300, 100)]
    else:
        with pytest.raises(api.ValidationError) as error:
            pool.notes('Dae', 'browser', 'Forum', connection_id=connection['connection_id'])
        assert 'PRIVATE-' not in str(error.value)
        assert len(calls) == 1
    assert closed == [True]


@pytest.mark.parametrize('path,code', [('/mfa/challenge', ''), ('/mfa/verify', '123456')])
def test_session_pool_mfa_releases_lock_and_cannot_update_replacement(path, code):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    api = load()
    started, release = Event(), Event()

    def request(url, payload=None, *_):
        if url.endswith(path):
            started.set()
            if not release.wait(4):
                raise RuntimeError('MFA synchronization timed out')
            return {'token': 'late-mfa-token'}
        if payload['id'] == 'pending':
            return {'mfaPending': True, 'mfaPendingToken': 'pending-token', 'mfaMethods': ['emailOtp']}
        return {'token': 'replacement-token'}

    pool = api.SessionPool(request=request)
    challenge = pool.connect('Author', 'browser', 'pending', 'password')
    with ThreadPoolExecutor(max_workers=2) as executor:
        mfa = executor.submit(pool.mfa, 'Author', 'browser', challenge['challenge_id'], 'emailOtp', code)
        try:
            assert started.wait(2)
            other = executor.submit(pool.connect, 'Other', 'other-browser', 'replacement', 'password')
            assert other.result(timeout=2)['connected']
            replacement = executor.submit(pool.connect, 'Author', 'browser', 'replacement', 'password')
            assert replacement.result(timeout=2)['connected']
        finally:
            release.set()
        with pytest.raises(api.ValidationError, match='challenge changed'):
            mfa.result(timeout=2)
    assert pool._entries['browser']['token'] == 'replacement-token'


def test_session_pool_replaces_existing_connection_at_capacity():
    api = load()
    pool = api.SessionPool(request=lambda url, body: {'token': body['id']})
    for i in range(100):
        pool.connect('Author', f'browser-{i}', f'user-{i}', 'password')
    assert pool.connect('Author', 'browser-0', 'replacement', 'password')['connected']
    assert pool._entries['browser-0']['token'] == 'replacement'
    with pytest.raises(api.ValidationError, match='too many'):
        pool.connect('Author', 'browser-new', 'new', 'password')
