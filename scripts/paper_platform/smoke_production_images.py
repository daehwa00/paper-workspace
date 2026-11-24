#!/usr/bin/env python3
"""Build and exercise isolated production images with synthetic account data.

Requires Docker Compose; uses only Python's standard library on the host. The
production account overrides, runtime publisher, TLS proxy and persistent stores
are retained. TeX, thumbnails, backups and external LLM services are not started.
"""
from __future__ import annotations

import hashlib
import http.client
from http.cookies import SimpleCookie
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import subprocess
import tempfile
from urllib.parse import parse_qs, urlencode, urlsplit

ROOT = Path(__file__).resolve().parents[2]
INFRA = ROOT / "infra/paper-workspace"
PORT = 19964
ORIGIN = f"https://localhost:{PORT}"
SERVICES = {"workspace", "password-gate", "collaboration", "collaboration-storage-init",
            "project-runtime", "project-runtime-storage-init", "rebuttal", "caddy", "caddy-storage-init"}
BUILDS = ["workspace", "password-gate", "collaboration", "rebuttal", "caddy"]


def run(command, *, capture=False, input=None, env=None):
    return subprocess.run(command, cwd=ROOT, check=True, text=True, input=input, env=env,
                          stdout=subprocess.PIPE if capture else None).stdout


def fixtures(directory):
    spec = importlib.util.spec_from_file_location("smoke_accounts", ROOT / "apps/paper_workspace/password_gate/accounts.py")
    accounts = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(accounts)
    password = secrets.token_urlsafe(24)
    registry = directory / "accounts"
    projects = directory / "projects"
    default = directory / "default"
    registry.mkdir()
    projects.mkdir()
    default.mkdir()
    manifest = {"id": "smoke", "version": "1", "entrypoint": "main.tex",
                "files": [{"path": "main.tex", "managed": True}]}
    for target in (default, projects / "smoke", projects / "other"):
        target.mkdir(exist_ok=True)
        (target / "project.json").write_text(json.dumps(manifest))
        (target / "main.tex").write_text("% isolated production image smoke\n\\documentclass{article}\n")
    (projects / "index.json").write_text(json.dumps({"projects": [
        {"slug": "smoke", "activity_id": "smoke", "display_name": "Synthetic paper"},
        {"slug": "other", "activity_id": "other", "display_name": "Unauthorized paper"}]}))
    (registry / "accounts.json").write_text(json.dumps({"default_project": "smoke", "users": {
        "smoke": {"password_hash": accounts.password_hash(password)},
        "other": {"password_hash": accounts.password_hash(secrets.token_urlsafe(24))}}, "projects": {
        "smoke": {"backup_id": "smoke", "members": {"smoke": "owner"}},
        "other": {"backup_id": "other", "members": {"other": "owner"}}}}))
    (registry / "accounts.json").chmod(0o600)
    return password, registry, projects, default


def configuration(directory, project, registry, projects, default):
    # Reset explicit production env_files before Compose can read local secrets.
    override = directory / "no-production-env.yaml"
    override.write_text("services:\n" + "".join(
        f"  {name}:\n    env_file: !reset []\n" for name in ("codex-bridge", "rebuttal", "caddy", "password-gate")))
    empty_env = directory / "empty.env"
    empty_env.touch()
    env = {**os.environ, "PAPER_PROJECT_DIR": str(default), "PAPER_PROJECTS_DIR": str(projects),
           "PAPER_ACCOUNTS_DIR": str(registry), "PAPER_DOMAIN": f"localhost:{PORT}",
           "HOST_UID": str(os.getuid()), "HOST_GID": str(os.getgid())}
    command = ["docker", "compose", "--env-file", str(empty_env), "-p", project]
    for filename in ("compose.yaml", "compose.password.yaml", "compose.accounts.yaml"):
        command += ["-f", str(INFRA / filename)]
    command += ["-f", str(override), "config", "--format", "json"]
    config = json.loads(run(command, capture=True, env=env))
    config["name"] = project
    config["services"] = {name: service for name, service in config["services"].items() if name in SERVICES}
    for name, service in config["services"].items():
        service["restart"] = "no"
        service.pop("env_file", None)
        if "depends_on" in service:
            service["depends_on"] = {key: value for key, value in service["depends_on"].items() if key in SERVICES}
        if "build" in service:
            service["image"] = f"{project}-{name}:smoke"
    for name in ("project-runtime", "project-runtime-storage-init"):
        config["services"][name]["image"] = "python:3.13-slim"
    runtime = config["services"]["project-runtime"]
    runtime["volumes"].append({"type": "bind", "source": str(ROOT / "scripts/paper_platform/runtime_common.py"),
                               "target": "/app/runtime_common.py", "read_only": True})
    runtime["volumes"].append({"type": "bind", "source": str(ROOT / "scripts/paper_platform/sync_project_runtime.py"),
                               "target": "/app/sync_project_runtime.py", "read_only": True})
    config["services"]["collaboration-storage-init"]["image"] = config["services"]["collaboration"]["image"]
    gate = config["services"]["password-gate"]
    gate["environment"]["PAPER_SESSION_SECRET"] = secrets.token_urlsafe(48)
    # Trust only the smoke network containing the gate and Caddy; choose no fixed
    # subnet that could overlap the operator's deployment.
    gate["environment"]["PAPER_TRUSTED_PROXY_CIDRS"] = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
    config["networks"]["auth_internal"].pop("ipam", None)
    config["services"]["collaboration"]["environment"]["COLLAB_ALLOWED_ORIGINS"] = ORIGIN
    rebuttal = config["services"]["rebuttal"]["environment"]
    rebuttal.update(REBUTTAL_ENABLED="true", REBUTTAL_PROJECTS="smoke,other",
                    CODEX_BRIDGE_URL="http://127.0.0.1:9", COMPILER_URL="http://127.0.0.1:9",
                    BACKUP_URL="http://127.0.0.1:9")
    config["services"]["caddy"]["ports"] = [{"target": PORT, "published": str(PORT),
                                                  "host_ip": "127.0.0.1", "protocol": "tcp"}]
    # Compose config expands resource names using its input project. Retain that
    # ownership; no external or bind-backed operational volumes are used.
    used_volumes = {v["source"] for service in config["services"].values()
                    for v in service.get("volumes", []) if v["type"] == "volume"}
    config["volumes"] = {key: value for key, value in config["volumes"].items() if key in used_volumes}
    path = directory / "compose.json"
    path.write_text(json.dumps(config))
    path.chmod(0o600)
    return ["docker", "compose", "--env-file", str(empty_env), "-p", project, "-f", str(path)]


def request(path, *, cookie="", body=None, form=False, headers=None):
    connection = http.client.HTTPSConnection("localhost", PORT, timeout=15,
                                             context=ssl._create_unverified_context())
    request_headers = {"Accept": "text/html" if body is None else "application/json", **(headers or {})}
    if cookie:
        request_headers["Cookie"] = cookie
    if body is not None:
        request_headers["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
        body = urlencode(body) if form else json.dumps(body)
    try:
        connection.request("GET" if body is None else "POST", path, body, request_headers)
        response = connection.getresponse()
        return response.status, response.getheaders(), response.read()
    finally:
        connection.close()


def expect(path, status=200, **kwargs):
    result = request(path, **kwargs)
    if result[0] != status:
        raise AssertionError(f"{path}: expected HTTP {status}, got {result[0]}")
    return result


def check_page(path, cookie, page):
    _, _, body = expect(path, cookie=cookie)
    html = body.decode()
    assert "<html" in html and not re.search(r"__[A-Z_]*(?:_HASH|FAVICON_DATA)__", html), path
    assert f'data-paper-page="{page}"' in html, f"Unexpected application page at {path}"
    hashed = 0
    for reference in set(re.findall(r'(?:src|href)="([^"]+)"', html)):
        parsed = urlsplit(reference)
        version = parse_qs(parsed.query).get("v", [])
        if version and re.fullmatch(r"[0-9a-f]{16}", version[0]):
            asset_path = parsed.path if parsed.path.startswith("/") else "/" + parsed.path
            _, _, asset = expect(asset_path + "?" + parsed.query, cookie=cookie)
            assert hashlib.sha256(asset).hexdigest()[:16] == version[0], asset_path
            hashed += 1
    assert hashed >= 3, f"No versioned production assets in {path}"


def collaboration(compose, cookie, mode):
    # Use the production image's installed Yjs client, ws and protocol packages;
    # a new container process and Y.Doc are used for each side of the restart.
    script = r"""
const Y = require('yjs')
const { WebsocketProvider } = require('y-websocket')
const WS = require('ws')
const https = require('https')
const config = CONFIG
class Socket extends WS {
  constructor(url, protocols) {
    super(url.replace('wss://localhost:', 'wss://caddy:'), protocols, {
      rejectUnauthorized: false, servername: 'localhost',
      headers: { Host: `localhost:${config.port}`, Origin: config.origin, Cookie: config.cookie }
    })
  }
}
const doc = new Y.Doc()
const provider = new WebsocketProvider(config.origin.replace('https:', 'wss:') + '/collab',
  `paper-workspace:localhost:${config.port}:smoke`, doc, {WebSocketPolyfill: Socket, disableBc: true})
const deadline = setTimeout(() => { console.error('Authenticated collaboration sync timed out'); process.exit(1) }, 20000)
provider.on('connection-error', error => { console.error(`Authenticated collaboration upgrade failed: ${error.message}`); process.exit(1) })
let completed = false
provider.on('sync', async synced => {
  if (!synced || completed) return
  completed = true
  try {
    if (config.mode === 'write') {
      doc.getMap('smokePersistence').set('marker', 'production-leveldb-restart')
      // response-init explicitly flushes LevelDB. Verify its authoritative Yjs
      // update includes our marker before allowing the restart.
      for (let attempt = 0; ; attempt++) {
        const update = await new Promise((resolve, reject) => {
          const body = JSON.stringify({entries: [{key: 'smoke_response', initial: 'Synthetic response'}]})
          const req = https.request({hostname: 'caddy', port: config.port, rejectUnauthorized: false, servername: 'localhost',
            method: 'POST', path: `/collab-runtime/paper-workspace:localhost:${config.port}:smoke?response-init=1`,
            headers: {Host: `localhost:${config.port}`, Origin: config.origin, Cookie: config.cookie,
              'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)}}, response => {
            let text = ''; response.on('data', chunk => {text += chunk})
            response.on('end', () => {
              if (response.statusCode !== 200) return reject(new Error(`Protected collaboration API returned ${response.statusCode}`))
              try { resolve(JSON.parse(text).update) } catch (error) { reject(error) }
            })
          })
          req.on('error', reject); req.end(body)
        })
        const authoritative = new Y.Doc()
        Y.applyUpdate(authoritative, Buffer.from(update, 'base64'))
        const persisted = authoritative.getMap('smokePersistence').get('marker') === 'production-leveldb-restart'
        authoritative.destroy()
        if (persisted) break
        if (attempt >= 20) throw new Error('WebSocket update did not reach the persistent server')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    } else if (doc.getMap('smokePersistence').get('marker') !== 'production-leveldb-restart') {
      throw new Error('Persisted LevelDB marker missing after restart')
    }
    provider.destroy(); doc.destroy(); clearTimeout(deadline)
  } catch (error) { console.error(error.message); process.exit(1) }
})
"""
    # Avoid passing session material as a command argument or printing it.
    script = script.replace("CONFIG", json.dumps({"port": PORT, "origin": ORIGIN, "cookie": cookie, "mode": mode}))
    run(compose + ["exec", "-T", "collaboration", "node"], input=script)


def smoke(compose, password):
    status, headers, _ = request("/")
    assert status in (302, 303) and dict(headers).get("Location", "").startswith("/_auth/login"), "Landing must require login"
    _, _, login = expect("/_auth/login")
    assert b'name="username"' in login and b'name="password"' in login
    expect("/assets/paper-workspace-icon.png")
    for path in ("/p/smoke", "/p/smoke/rebuttal?standalone=1", "/p/smoke/project/main.tex",
                 "/api/rebuttal/projects/smoke/state", f"/collab/paper-workspace:localhost:{PORT}:smoke"):
        expect(path, 401, headers={"Accept": "application/json", "X-Paper-Actor": "smoke", "X-Paper-Role": "owner"})
    _, headers, _ = expect("/_auth/login", 303, form=True, body={"username": "smoke", "password": password})
    cookies = SimpleCookie()
    for key, value in headers:
        if key.lower() == "set-cookie":
            cookies.load(value)
    assert "paper_session" in cookies, "Login did not issue an account session"
    cookie = "paper_session=" + cookies["paper_session"].value
    _, _, identity = expect("/_auth/me", cookie=cookie)
    assert json.loads(identity)["user"] == "smoke"
    _, _, catalog = expect("/projects/index.json", cookie=cookie)
    assert [p["slug"] for p in json.loads(catalog)["projects"]] == ["smoke"]
    check_page("/smoke", cookie, "hub")
    check_page("/p/smoke", cookie, "workspace")
    check_page("/p/smoke/rebuttal?standalone=1", cookie, "rebuttal")
    _, _, source = expect("/p/smoke/project/main.tex", cookie=cookie)
    assert source.startswith(b"% isolated production image smoke")
    for path in ("/p/other", "/p/other/project/main.tex", "/api/rebuttal/projects/other/state"):
        expect(path, 403, cookie=cookie)
    endpoint = "/api/rebuttal/projects/smoke"
    _, _, initial = expect(endpoint + "/state", cookie=cookie)
    state = json.loads(initial)
    assert state["revision"] == 0 and state["rounds"] == [] and state.get("enabled") is not False
    _, _, created = expect(endpoint + "/rounds", cookie=cookie,
                           body={"title": "Synthetic persistent round", "expected_revision": 0}, headers={"Origin": ORIGIN})
    saved = json.loads(created)
    assert saved["revision"] > 0 and saved["rounds"][0]["title"] == "Synthetic persistent round"
    collaboration(compose, cookie, "write")
    run(compose + ["restart", "collaboration", "rebuttal"])
    run(compose + ["up", "-d", "--wait", "--wait-timeout", "120"])
    collaboration(compose, cookie, "read")
    _, _, restored = expect(endpoint + "/state", cookie=cookie)
    restored = json.loads(restored)
    assert restored["revision"] == saved["revision"] and restored["rounds"] == saved["rounds"]
    print("PASS: account login, authorization, Paper/Rebuttal assets and hashes, project source, authenticated WebSocket, LevelDB/SQLite restart persistence", flush=True)


def main():
    project = "paper-global-smoke-" + secrets.token_hex(4)
    with tempfile.TemporaryDirectory(prefix=project + "-") as temporary:
        directory = Path(temporary)
        password, registry, projects, default = fixtures(directory)
        compose = configuration(directory, project, registry, projects, default)
        try:
            run(compose + ["build", *BUILDS])
            run(compose + ["up", "-d", "--wait", "--wait-timeout", "180"])
            smoke(compose, password)
        except Exception:
            run(compose + ["logs", "--no-color", "--tail", "40", "workspace", "caddy", "collaboration", "rebuttal"])
            raise
        finally:
            # Only this random smoke project owns these containers, networks,
            # volumes and image tags. Cleanup failures also fail the CI job.
            run(compose + ["down", "--volumes", "--rmi", "local", "--remove-orphans", "--timeout", "20"])
            images = set(run(["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}"], capture=True).splitlines())
            owned = [f"{project}-{name}:smoke" for name in BUILDS if f"{project}-{name}:smoke" in images]
            if owned:
                run(["docker", "image", "rm", *owned])


if __name__ == "__main__":
    main()
