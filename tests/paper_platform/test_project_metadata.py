from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
import json
import threading
import urllib.error
import urllib.request

import pytest

from apps.paper_workspace.backup import server as api


def test_metadata_persistence_partial_updates_and_undo(tmp_path):
    store = api.BackupStore(tmp_path / 'backup.sqlite3')
    assert store.project_metadata('alpha') == {'project_id': 'alpha', 'revision': 0, 'values': {}}
    first = store.update_project_metadata('alpha', {'expected_revision': 0, 'changes': {'venue': 'ICLR 2028'}})
    second = store.update_project_metadata('alpha', {'expected_revision': 1, 'changes': {'description': '새 부제목'}})
    assert second['values'] == {'venue': 'ICLR 2028', 'description': '새 부제목'}
    with pytest.raises(api.MetadataConflict) as conflict:
        store.update_project_metadata('alpha', {'expected_revision': first['revision'], 'changes': {'venue': None}})
    assert conflict.value.current == second
    undone = store.update_project_metadata('alpha', {'expected_revision': 2, 'changes': {'venue': None}})
    assert undone['values'] == {'description': '새 부제목'}
    assert api.BackupStore(store.database_path).project_metadata('alpha') == undone
    empty = store.update_project_metadata('alpha', {'expected_revision': 3, 'changes': {'description': ''}})
    assert empty['values'] == {'description': ''}
    assert store.list_project_metadata(set()) == []
    assert store.list_project_metadata({'alpha'}) == [empty]


@pytest.mark.parametrize('changes', [{'venue': 'x' * 81}, {'description': 'x' * 501}, {'venue': 42}, {'description': []},
                                     {'title': 'no'}, {}, {'venue': ' a'}, {'description': 'bad\nline'}, {'venue': 'bad\x00value'}])
def test_invalid_metadata_is_rejected_without_writes(tmp_path, changes):
    store = api.BackupStore(tmp_path / 'backup.sqlite3')
    with pytest.raises(api.ValidationError):
        store.update_project_metadata('alpha', {'expected_revision': 0, 'changes': changes})
    assert store.list_project_metadata() == []


@pytest.mark.parametrize('revision', [True, -1, 1.5, '0', None])
def test_revision_requires_a_nonnegative_integer(tmp_path, revision):
    store = api.BackupStore(tmp_path / 'backup.sqlite3')
    with pytest.raises(api.ValidationError):
        store.update_project_metadata('alpha', {'expected_revision': revision, 'changes': {'venue': 'arXiv'}})


def test_independent_connections_cannot_both_overwrite_the_same_revision(tmp_path):
    stores = [api.BackupStore(tmp_path / 'backup.sqlite3') for _ in range(2)]
    gate = threading.Barrier(2)
    def save(index):
        gate.wait()
        try:
            return stores[index].update_project_metadata('alpha', {'expected_revision': 0, 'changes': {'venue': str(index)}})['revision']
        except api.MetadataConflict:
            return 'conflict'
    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(save, range(2)), key=str) == [1, 'conflict']


@pytest.mark.parametrize('actor_mode', ['proxy', 'display'])
def test_metadata_http_permissions_scope_and_conflicts(tmp_path, actor_mode):
    class Handler(api.BackupHandler):
        store = api.BackupStore(tmp_path / 'backup.sqlite3')
        assets = api.AssetStore(tmp_path / 'assets')
        allowed_projects = {'alpha', 'beta'}
        project_allowlist = None
        actor_mode = 'proxy'
    Handler.actor_mode = actor_mode
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    base = f'http://127.0.0.1:{server.server_port}'
    def request(path, method='GET', role='editor', allowed='alpha', payload=None):
        headers = {'Content-Type': 'application/json', 'X-Paper-Role': role, 'X-Paper-Allowed-Projects': allowed, 'X-Paper-Actor': 'verified'}
        req = urllib.request.Request(base + path, data=json.dumps(payload).encode() if payload is not None else None, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as response: return response.status, json.load(response)
        except urllib.error.HTTPError as error: return error.code, json.load(error)
    payload = {'expected_revision': 0, 'changes': {'venue': 'arXiv'}, 'actor': 'forged'}
    try:
        assert request('/projects/alpha/metadata', 'PUT', role='viewer', payload=payload)[0] == 403
        assert request('/projects/beta/metadata', 'PUT', payload=payload)[0] == 404
        assert request('/projects/alpha/metadata', 'PUT', payload=payload)[0] == 200
        status, conflict = request('/projects/alpha/metadata', 'PUT', payload={**payload, 'changes': {'venue': 'ICML 2028'}})
        assert status == 409 and conflict['metadata']['values']['venue'] == 'arXiv'
        assert request('/projects/alpha/metadata', role='viewer')[1]['metadata']['revision'] == 1
        assert request('/activity', allowed='beta')[1]['metadata'] == []
        assert request('/activity')[1]['metadata'][0]['project_id'] == 'alpha'
    finally:
        server.shutdown(); server.server_close(); thread.join(2)
