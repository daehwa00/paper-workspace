"""Boundaries shared by the rebuttal service, authentication and recovery."""
import importlib.util
import hashlib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


accounts = load('rebuttal_account_integration', 'apps/paper_workspace/password_gate/accounts.py')
backup = load('rebuttal_backup_integration', 'apps/paper_workspace/backup/server.py')


@pytest.fixture
def registry():
    return {'projects': {'paper-a': {'backup_id': 'backup-a', 'members': {'author': 'editor', 'reader': 'viewer'}},
                         'paper-b': {'backup_id': 'backup-b', 'members': {'other': 'owner'}}}}


@pytest.mark.parametrize('path', ['/p/paper-a/rebuttal', '/p/paper-a/rebuttal/round-1', '/api/rebuttal/projects/paper-a/state', '/api/rebuttal/projects/paper-a/snapshot'])
def test_rebuttal_reads_use_the_addressed_project(registry, path):
    assert accounts.authorize(registry, 'author', path, 'GET') == 'editor'
    assert accounts.authorize(registry, 'reader', path, 'GET') == 'viewer'
    assert accounts.authorize(registry, 'other', path, 'GET') is None


@pytest.mark.parametrize('suffix', ['/rounds', '/rounds/r/rules/x/apply', '/rounds/r/analyses', '/openreview/session', '/restore'])
def test_viewer_cannot_mutate_rebuttal(registry, suffix):
    path = '/api/rebuttal/projects/paper-a' + suffix
    assert accounts.authorize(registry, 'reader', path, 'POST') is None
    assert accounts.authorize(registry, 'author', path, 'POST') == 'editor'


def test_readonly_export_does_not_grant_other_post_routes(registry):
    assert accounts.authorize(registry, 'reader', '/api/rebuttal/projects/paper-a/rounds/r/exports', 'POST') == 'viewer'
    assert accounts.authorize(registry, 'reader', '/api/rebuttal/projects/paper-b/rounds/r/exports', 'POST') is None
    assert accounts.authorize(registry, 'reader', '/api/rebuttal/projects/paper-a/rounds/r/submissions', 'POST') is None


def test_backups_keep_rebuttal_text_and_review_metadata():
    snapshot = {'files': {'paper/main.tex': 'source'}, 'rebuttal': {'schema_version': 1, 'rounds': [{'id': 'round', 'concerns': [{'id': 'c1', 'source_spans': [{'quote': 'Why?'}]}]}], 'texts': {'response-1': 'Our answer 🧪'}}}
    decoded, _ = backup.canonical_snapshot(snapshot)
    assert decoded == snapshot
    legacy, _ = backup.canonical_snapshot({'files': {'paper/main.tex': 'source'}})
    assert 'rebuttal' not in legacy


@pytest.mark.parametrize('key', ['password', 'access_token', 'mfaPendingToken', 'connection_id'])
def test_backup_never_accepts_connection_credentials(key):
    with pytest.raises(backup.ValidationError, match='credentials'):
        backup.canonical_snapshot({'files': {'paper/main.tex': 'source'}, 'rebuttal': {'schema_version': 1, 'rounds': [{key: 'private'}]}})


def test_all_proxy_modes_route_rebuttal_before_general_compiler_api():
    for name in ['Caddyfile', 'Caddyfile.password', 'Caddyfile.auth', 'Caddyfile.accounts']:
        source = (ROOT / 'infra/paper-workspace' / name).read_text()
        assert source.index('handle /api/rebuttal/*') < source.index('handle_path /api/*')
        assert 'reverse_proxy rebuttal:8020' in source
        if name != 'Caddyfile':
            assert source.index('forward_auth') < source.index('handle /api/rebuttal/*')


def test_response_initialization_receives_trusted_editor_headers_in_shared_proxy_modes():
    for name in ['Caddyfile', 'Caddyfile.password', 'Caddyfile.auth']:
        source = (ROOT / 'infra/paper-workspace' / name).read_text()
        runtime = source.split('handle /collab-runtime/* {', 1)[1].split('handle /collab* {', 1)[0]
        assert 'header_up X-Paper-Actor' in runtime
        assert 'header_up X-Paper-Role "editor"' in runtime
        assert 'header_up X-Paper-Allowed-Projects "*"' in runtime


@pytest.mark.parametrize('action', ['response-init', 'response-restore'])
def test_response_collaboration_mutations_enforce_project_membership(registry, action):
    path = '/collab-runtime/paper-workspace%3Apaper.example%3Apaper-a?' + action + '=1'
    assert accounts.authorize(registry, 'author', path, 'POST') == 'editor'
    assert accounts.authorize(registry, 'reader', path, 'POST') is None
    assert accounts.authorize(registry, 'other', path, 'POST') is None


def test_review_pdf_assets_remain_immutable(tmp_path):
    store = backup.AssetStore(tmp_path)
    content = b'%PDF-1.4\nreview source\n%%EOF'
    path = 'rebuttal/sources/' + hashlib.sha256(content).hexdigest() + '.pdf'
    store.put('project', path, content)
    store.put('project', path, content)  # Repeated imports are idempotent.
    with pytest.raises(backup.ValidationError, match='content hash'):
        store.put('project', path, content + b'changed')
    with pytest.raises(backup.ValidationError, match='immutable'):
        store.delete('project', path)
    assert store.get('project', path) == content
