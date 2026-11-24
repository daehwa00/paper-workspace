from __future__ import annotations

import http.client
import json
import os
import socket
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest


ROOT = Path(__file__).parents[2]
BRIDGE = ROOT / "apps/paper_workspace/codex_bridge/server.mjs"


def available_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


@pytest.fixture
def bridge(tmp_path: Path):
    port = available_port()
    auth_home = tmp_path / "auth"
    auth_home.mkdir()
    (auth_home / "auth.json").write_text(
        json.dumps({"auth": {"access_token": "a" * 32}}), encoding="utf-8"
    )
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "mode").write_text("success", encoding="utf-8")
    executable_dir = tmp_path / "bin"
    executable_dir.mkdir()
    fake_codex = executable_dir / "codex"
    fake_codex.write_text(
        """#!/usr/bin/env node
import { closeSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';

const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
const model = process.argv[process.argv.indexOf('--model') + 1];
const rebuttal = !process.argv.includes('--config');
function writeResult() {
  const result = rebuttal ? { text: '번역' } : { replacement: '수정문', summary: '요약' };
  writeFileSync(output, JSON.stringify(result));
}
switch (readFileSync('mode', 'utf8').trim()) {
  case 'oversized-replacement':
    writeFileSync(output, JSON.stringify({ replacement: 'x'.repeat(50_001), summary: '요약' }));
    break;
  case 'oversized-summary':
    writeFileSync(output, JSON.stringify({ replacement: '수정문', summary: 'x'.repeat(501) }));
    break;
  case 'sparse-output':
    writeResult();
    truncateSync(output, 128 * 1024 * 1024);
    break;
  case 'check-profile':
    if (model !== 'gpt-6.1-sol') process.exit(5);
    writeResult();
    break;
  case 'broken-stdin':
    closeSync(0);
    process.stderr.write('HTTP 429 private reviewer prose sk-proj-' + 'z'.repeat(30));
    setTimeout(() => process.exit(7), 40);
    break;
  case 'wait':
    process.stdin.resume();
    writeFileSync('started', String(process.pid));
    const timer = setInterval(() => {
      try {
        readFileSync('finish');
        clearInterval(timer);
        writeResult();
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }, 20);
    break;
  case 'signal':
    process.kill(process.pid, 'SIGTERM');
    break;
  case 'empty-summary':
    writeFileSync(output, JSON.stringify({ replacement: '수정문', summary: '' }));
    break;
  default:
    process.stdin.resume();
    process.stdin.on('end', writeResult);
}
""",
        encoding="utf-8",
    )
    fake_codex.chmod(0o755)
    environment = {
        **os.environ,
        "CODEX_BRIDGE_PORT": str(port),
        "CODEX_BRIDGE_TOKEN": "bridge-token-for-test",
        "CODEX_HOME": str(auth_home),
        "CODEX_WORKSPACE": str(workspace),
        "PATH": f"{executable_dir}:{os.environ['PATH']}",
    }
    process = subprocess.Popen(
        ["node", str(BRIDGE)],
        cwd=ROOT,
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        for _ in range(40):
            if process.poll() is not None:
                pytest.fail(f"Codex bridge exited during startup: {process.stderr.read()}")
            try:
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=0.2)
                connection.request("GET", "/health")
                response = connection.getresponse()
                response.read()
                connection.close()
                assert response.status == 200
                break
            except (ConnectionRefusedError, TimeoutError):
                time.sleep(0.05)
        else:
            pytest.fail("Codex bridge did not become healthy")
        yield port, workspace
    finally:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)


AUTH_HEADERS = {
    "Authorization": "Bearer bridge-token-for-test",
    "Content-Type": "application/json",
}
REVISION = {
    "file": "paper/main.tex",
    "selection": "Original text.",
    "instruction": "문장을 다듬어줘",
    "source": "Original text.",
}
REBUTTAL = {
    "job_id": "job",
    "task": "translate_block",
    "payload": {"reviews": [], "concerns": [], "documents": []},
}


def request_json(port, path, body=None, *, headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=8)
    try:
        connection.request(
            "GET" if body is None else "POST",
            path,
            body=None if body is None else json.dumps(body),
            headers={**AUTH_HEADERS, **(headers or {})},
        )
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


def request_revision(port: int, **overrides: object) -> tuple[int, dict[str, str]]:
    return request_json(port, "/api/codex", {**REVISION, **overrides})


def wait_until(check):
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.02)
    pytest.fail("Bridge did not reach the expected state")


def open_revision_upload(port, body):
    connection = socket.create_connection(("127.0.0.1", port), timeout=3)
    headers = "".join(f"{name}: {value}\r\n" for name, value in AUTH_HEADERS.items())
    request = (
        f"POST /api/codex HTTP/1.1\r\nHost: localhost\r\n{headers}"
        f"Content-Length: {len(body)}\r\n\r\n"
    )
    connection.sendall(request.encode("ascii"))
    return connection


@pytest.mark.parametrize("mode", ["oversized-replacement", "oversized-summary"])
def test_bridge_rejects_oversized_codex_response_without_truncating(
    bridge: tuple[int, Path], mode: str
) -> None:
    port, workspace = bridge
    (workspace / "mode").write_text(mode, encoding="utf-8")

    status, response = request_revision(port)

    assert status == 422
    expected_error = (
        "Codex 수정문이(가) 너무 깁니다."
        if mode == "oversized-replacement"
        else "Codex 요약이(가) 너무 깁니다."
    )
    assert response == {"error": expected_error, "error_code": "model_response_invalid"}


def test_bridge_reports_codex_termination_signal(bridge: tuple[int, Path]) -> None:
    port, workspace = bridge
    (workspace / "mode").write_text("signal", encoding="utf-8")

    status, response = request_revision(port)

    assert status == 422
    assert response == {
        "error": "Codex가 신호 SIGTERM(으)로 끝났습니다.",
        "error_code": "model_execution_failed",
    }


def test_bridge_preserves_an_empty_optional_summary(bridge: tuple[int, Path]) -> None:
    port, workspace = bridge
    (workspace / "mode").write_text("empty-summary", encoding="utf-8")

    status, response = request_revision(port)

    assert status == 200
    assert response == {"replacement": "수정문", "summary": ""}


def test_bridge_rejects_an_oversized_selected_passage_without_revising_it(
    bridge: tuple[int, Path]
) -> None:
    port, _ = bridge

    status, response = request_revision(port, selection="x" * 12_001)

    assert status == 422
    assert response == {
        "error": "선택 문장이(가) 너무 깁니다.",
        "error_code": "bridge_invalid_request",
    }


@pytest.mark.parametrize("route", ["/api/codex", "/internal/rebuttal"])
def test_bridge_survives_early_child_stdin_close_and_hides_stderr(bridge, route):
    port, workspace = bridge
    (workspace / "mode").write_text("broken-stdin")
    if route == "/api/codex":
        body = {**REVISION, "source": "x" * 80_000}
    else:
        # Exceeds the stdin socket buffer so the pending write hits the closed fd.
        payload = {**REBUTTAL["payload"], "documents": [{"text": "x" * 500_000}]}
        body = {**REBUTTAL, "payload": payload}

    status, response = request_json(port, route, body)

    assert status == 422
    assert response["error_code"] == "model_rate_limited"
    assert "private reviewer prose" not in response["error"]
    assert "sk-proj-" not in response["error"]
    (workspace / "mode").write_text("success")
    assert request_json(port, route, body)[0] == 200


@pytest.mark.parametrize("cancel_attempt", [{"attempt": 2}, {}])
def test_rebuttal_cancel_ignores_stale_attempt_and_honors_current_cancel(bridge, cancel_attempt):
    port, workspace = bridge
    (workspace / "mode").write_text("wait")
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(
            request_json, port, "/internal/rebuttal", {**REBUTTAL, "attempt": 2}
        )
        wait_until((workspace / "started").exists)
        assert request_json(
            port, "/internal/rebuttal/cancel", {"job_id": "job", "attempt": 1}
        ) == (200, {"cancelled": False})
        assert request_json(
            port, "/internal/rebuttal/cancel", {"job_id": "job", **cancel_attempt}
        ) == (200, {"cancelled": True})
        assert future.result() == (
            422,
            {"error": "rebuttal job cancelled", "error_code": "bridge_cancelled"},
        )

    (workspace / "mode").write_text("success")
    assert request_json(port, "/internal/rebuttal", {**REBUTTAL, "attempt": 3})[0] == 200


@pytest.mark.parametrize("profile", ["constructor", "toString", "__proto__"])
def test_bridge_profile_selection_uses_own_properties(bridge, profile):
    port, workspace = bridge
    (workspace / "mode").write_text("check-profile")

    assert request_revision(port, profile=profile)[0] == 200
    status, response = request_json(port, "/internal/rebuttal", {**REBUTTAL, "profile": profile})
    assert status == 422
    assert response["error_code"] == "bridge_invalid_request"


def test_incomplete_and_invalid_uploads_leave_the_revision_slot_free(bridge):
    port, _ = bridge
    body = json.dumps(REVISION).encode()
    with open_revision_upload(port, body) as upload:
        upload.sendall(body[:1])
        assert request_json(port, "/health") == (200, {"status": "ok", "busy": False})
        assert request_revision(port, source="")[0] == 422
        assert request_revision(port)[0] == 200
        upload.sendall(body[1:])
        response = http.client.HTTPResponse(upload)
        response.begin()
        assert response.status == 200
        response.read()


def test_disconnect_stops_child_and_busy_responses_do_not_charge_rate_limit(bridge):
    port, workspace = bridge
    (workspace / "mode").write_text("wait")
    body = json.dumps(REVISION).encode()
    with open_revision_upload(port, body) as upload:
        upload.sendall(body)
        wait_until((workspace / "started").exists)
        pid = int((workspace / "started").read_text())
        for _ in range(10):
            status, response = request_revision(port)
            assert status == 429
            assert "처리 중" in response["error"]

    wait_until(lambda: request_json(port, "/health")[1]["busy"] is False)
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
    (workspace / "mode").write_text("success")
    assert request_revision(port)[0] == 200


@pytest.mark.parametrize("route, body", [("/api/codex", REVISION), ("/internal/rebuttal", REBUTTAL)])
def test_bridge_rejects_output_above_the_byte_cap(bridge, route, body):
    port, workspace = bridge
    (workspace / "mode").write_text("sparse-output")

    status, response = request_json(port, route, body)

    assert status == 422
    assert response["error_code"] == "model_response_invalid"
    if route == "/api/codex":
        assert "응답 파일이 너무 크" in response["error"]


def test_start_copies_credentials_to_configured_codex_home(tmp_path):
    auth_secret = tmp_path / "codex-auth"
    auth_secret.write_text('{"auth": "fixture"}')
    auth_home = tmp_path / "custom auth"
    workspace = tmp_path / "workspace"
    node = tmp_path / "node"
    node.write_text('#!/bin/sh\n[ "$1" = /app/server.mjs ] && [ -f "$CODEX_HOME/auth.json" ]\n')
    node.chmod(0o755)
    # Redirect the container's secret mount into this temporary directory.
    script = BRIDGE.with_name("start.sh").read_text().replace("/run/secrets/codex-auth", str(auth_secret))
    subprocess.run(
        ["sh", "-c", script],
        env={
            **os.environ,
            "CODEX_HOME": str(auth_home),
            "CODEX_WORKSPACE": str(workspace),
            "PATH": f"{tmp_path}:{os.environ['PATH']}",
        },
        check=True,
    )

    assert (auth_home / "auth.json").read_text() == auth_secret.read_text()
    assert (auth_home / "auth.json").stat().st_mode & 0o777 == 0o600
    assert workspace.is_dir()


def test_rate_limit_normalizes_proxy_ip_and_ignores_conflicting_paper_header(bridge):
    port, _ = bridge
    for index in range(10):
        status, _ = request_json(
            port,
            "/api/codex",
            REVISION,
            headers={
                "X-Paper-Client-IP": f"203.0.113.{index + 1}",
                "X-Forwarded-For": f"198.51.100.{index + 1}, ::FFFF:C000:0201",
            },
        )
        assert status == 200
    assert request_json(
        port, "/api/codex", REVISION, headers={"X-Paper-Client-IP": "192.0.2.1"}
    )[0] == 429
    assert request_json(
        port, "/api/codex", REVISION, headers={"X-Paper-Client-IP": "192.0.2.2"}
    )[0] == 200
