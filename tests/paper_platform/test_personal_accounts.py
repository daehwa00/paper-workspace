from __future__ import annotations
import importlib.util
import json
from pathlib import Path
import pytest

ROOT = Path(__file__).parents[2]
spec = importlib.util.spec_from_file_location('personal_accounts', ROOT / 'apps/paper_workspace/password_gate/accounts.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)

@pytest.fixture
def registry():
    return {'users': {'alice': {'password_hash': a.password_hash('a long private password')}, 'bob': {'password_hash': a.password_hash('another private password')}},
            'projects': {'first': {'backup_id': 'first-backup', 'members': {'alice': 'owner'}}, 'second': {'backup_id': 'second-backup', 'members': {'bob': 'owner', 'alice': 'viewer'}}}, 'default_project': 'first'}

def test_password_and_revocable_sessions(registry):
    assert a.authenticate(registry, 'alice', 'a long private password')
    assert not a.authenticate(registry, 'bob', 'a long private password')
    assert not a.authenticate(registry, 'missing', 'a long private password')
    token = a.issue(registry, 'alice', 'secret', 60, now=100)
    cookie = 'paper_session=' + token
    assert a.session(registry, cookie, 'secret', now=159) == 'alice'
    assert a.session(registry, cookie, 'secret', now=160) is None
    assert a.session(registry, cookie + 'x', 'secret', now=110) is None
    registry['users']['alice']['disabled'] = True
    assert a.session(registry, cookie, 'secret', now=110) is None

@pytest.mark.parametrize('path', ['/p/first', '/p/first/project/main.tex', '/projects/first/thumbnail.png', '/api/backups/projects/first-backup/assets/x.pdf', '/api/backups/projects/first-backup/snapshots/1', '/collab/paper-workspace:paper.glowme.kr:first', '/collab-runtime/paper-workspace:paper.glowme.kr:first'])
def test_foreign_project_denied(registry, path):
    assert a.authorize(registry, 'bob', path, 'GET') is None
    assert a.authorize(registry, 'alice', path, 'GET') == 'owner'

@pytest.mark.parametrize('path', ['/api/backups/projects/second-backup/snapshots', '/api/backups/projects/second-backup/assets/x', '/api/backups/projects/second-backup/activity', '/collab-runtime/paper-workspace:paper.glowme.kr:second'])
def test_viewer_cannot_write(registry, path):
    assert a.authorize(registry, 'alice', path, 'POST') is None
    assert a.authorize(registry, 'alice', path, 'DELETE') is None
    assert a.authorize(registry, 'bob', path, 'POST') == 'owner'

@pytest.mark.parametrize('path', ['/project-runtime/project/main.tex', '/generated-thumbnails/first/thumbnail.png', '/projects/first/../second/main.tex', '/projects/first/%2e%2e/second/main.tex', '/projects/first/%252e%252e/main.tex', '/alice', '/unknown.html', '/assets/../project/main.tex', '//project/main.tex'])
def test_no_fallback_or_encoding_bypass(registry, path):
    assert a.authorize(registry, 'bob', path, 'GET') is None

def test_catalog_filter_and_password_reset(registry, tmp_path, monkeypatch):
    file = tmp_path / 'index.json'; file.write_text('{"projects":[{"slug":"first"},{"slug":"second"}]}')
    monkeypatch.setattr(a, 'CATALOG', str(file))
    assert a.catalog(registry, 'bob') == {'projects': [{'slug': 'second'}]}
    token = a.issue(registry, 'alice', 'secret', 60, now=100)
    registry['users']['alice']['password_hash'] = a.password_hash('replacement password')
    assert a.session(registry, 'paper_session=' + token, 'secret', now=110) is None


def test_project_metadata_reuses_project_read_and_write_permissions(registry):
    first = '/api/backups/projects/first-backup/metadata'
    second = '/api/backups/projects/second-backup/metadata'
    assert a.authorize(registry, 'alice', first, 'PUT') == 'owner'
    assert a.authorize(registry, 'alice', second, 'GET') == 'viewer'
    assert a.authorize(registry, 'alice', second, 'PUT') is None
    assert a.authorize(registry, 'bob', first, 'GET') is None
    assert a.authorize(registry, 'bob', second, 'PUT') == 'owner'

def test_http_login_identity_headers_and_empty_activity_scope(registry, tmp_path, monkeypatch):
    import http.client
    import json
    import threading
    from urllib.parse import urlencode
    spec = importlib.util.spec_from_file_location('personal_gate_http', ROOT / 'apps/paper_workspace/password_gate/server.py')
    gate = importlib.util.module_from_spec(spec); spec.loader.exec_module(gate)
    registry['users']['empty'] = {'password_hash': a.password_hash('empty account password')}
    file = tmp_path / 'accounts.json'; file.write_text(json.dumps(registry))
    monkeypatch.setattr(gate.accounts, 'REGISTRY', str(file))
    monkeypatch.setattr(gate, 'SESSION_SECRET', 'private session secret with enough entropy')
    server = gate.ThreadingHTTPServer(('127.0.0.1', 0), gate.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        connection = http.client.HTTPConnection(*server.server_address)
        connection.request('POST', '/login', urlencode({'username': 'empty', 'password': 'empty account password'}), {'Content-Type': 'application/x-www-form-urlencoded'})
        response = connection.getresponse(); response.read()
        assert response.status == 303
        assert response.getheader('Location') == '/empty'
        cookie = next(value for key, value in response.getheaders() if key.lower() == 'set-cookie' and value.startswith('paper_session='))
        connection.request('GET', '/verify', headers={'Cookie': cookie, 'X-Forwarded-Uri': '/api/backups/activity', 'X-Forwarded-Method': 'GET'})
        response = connection.getresponse(); response.read()
        assert response.status == 200
        assert response.getheader('X-Paper-Actor') == 'empty'
        assert response.getheader('X-Paper-Allowed-Projects') == '-'
        connection.request('GET', '/verify', headers={'Cookie': cookie, 'X-Forwarded-Uri': '/p/first', 'X-Paper-Actor': 'alice'})
        response = connection.getresponse(); response.read()
        assert response.status == 403
        connection.request('GET', '/context.js', headers={'Cookie': cookie})
        response = connection.getresponse(); body = response.read()
        assert response.getheader('Cache-Control') == 'no-store'
        assert b'"user": "empty"' in body and b'password' not in body
        connection.close()
    finally:
        server.shutdown(); server.server_close(); thread.join()


@pytest.mark.parametrize("suffix", ["/rebuttal/", "/rebuttal/round-1/"])
def test_rebuttal_authorization_accepts_trailing_slash(registry, suffix):
    assert a.authorize(registry, "alice", "/p/first" + suffix, "GET") == "owner"
    assert a.authorize(registry, "bob", "/p/first" + suffix, "GET") is None


def test_canonical_source_uses_edge_owner_even_with_legacy_default(registry):
    registry["projects"]["aaai27"] = {"backup_id": "canonical-backup", "members": {"bob": "owner"}}
    shared = (ROOT / "infra/paper-workspace/Caddyfile.shared").read_text()
    accounts_caddy = (ROOT / "infra/paper-workspace/Caddyfile.accounts").read_text()
    assert f"^/p/{a.CANONICAL_PROJECT}/project/" in shared
    assert f"^/projects/{a.CANONICAL_PROJECT}/" in accounts_caddy
    assert "disable_symlinks on" in (ROOT / "infra/paper-workspace/nginx.conf").read_text()
    for path in ("/index.html", "/project/main.tex", "/p/aaai27/project/main.tex", "/projects/aaai27/main.tex"):
        assert a.authorize(registry, "bob", path, "GET") == "owner"
        assert a.authorize(registry, "alice", path, "GET") is None


def test_issue_user_registry_write_failure_never_publishes_secret(tmp_path, monkeypatch):
    from scripts.paper_platform import manage_accounts

    registry_path = tmp_path / "registry.json"
    output = tmp_path / "issued.txt"
    replace = manage_accounts.os.replace

    def fail_registry_write(source, destination):
        if destination == registry_path:
            raise OSError("registry volume unavailable")
        return replace(source, destination)

    monkeypatch.setattr(manage_accounts.os, "replace", fail_registry_write)
    data = {"users": {"alice": {"password_hash": "example"}}, "projects": {}}
    with pytest.raises(OSError, match="registry volume unavailable"):
        manage_accounts.save_registry(registry_path, data, output, "issued password")
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("option", ["argument", "environment"])
def test_issue_user_uses_configured_login_domain(tmp_path, monkeypatch, option):
    import os
    import subprocess
    import sys

    registry_path = tmp_path / "registry.json"
    output = tmp_path / "issued.txt"
    command = [
        sys.executable, str(ROOT / "scripts/paper_platform/manage_accounts.py"),
        "--registry", str(registry_path), "issue-user", "--user", "alice",
        "--secret-output", str(output),
    ]
    if option == "argument":
        command.extend(["--domain", "papers.example.test"])
    else:
        monkeypatch.setenv("PAPER_DOMAIN", "papers.example.test")
    subprocess.run(command, check=True, capture_output=True, env=os.environ)
    assert output.read_text().splitlines()[0] == "주소: https://papers.example.test/alice"
    assert output.stat().st_mode & 0o777 == 0o600
    password = output.read_text().splitlines()[-1].split(" ", 1)[1]
    assert a.authenticate(json.loads(registry_path.read_text()), "alice", password)
