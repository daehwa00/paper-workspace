from __future__ import annotations

import http.client
import json
import os
import socket
import subprocess
import time
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
import { readFileSync, writeFileSync } from 'node:fs';

const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
switch (readFileSync('mode', 'utf8').trim()) {
  case 'oversized-replacement':
    writeFileSync(output, JSON.stringify({ replacement: 'x'.repeat(50_001), summary: '요약' }));
    break;
  case 'oversized-summary':
    writeFileSync(output, JSON.stringify({ replacement: '수정문', summary: 'x'.repeat(501) }));
    break;
  case 'signal':
    process.kill(process.pid, 'SIGTERM');
    break;
  case 'empty-summary':
    writeFileSync(output, JSON.stringify({ replacement: '수정문', summary: '' }));
    break;
  default:
    writeFileSync(output, JSON.stringify({ replacement: '수정문', summary: '요약' }));
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


def request_revision(
    port: int, **overrides: object
) -> tuple[int, dict[str, str]]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        connection.request(
            "POST",
            "/api/codex",
            body=json.dumps(
                {
                    "file": "paper/main.tex",
                    "selection": "Original text.",
                    "instruction": "문장을 다듬어줘",
                    "source": "Original text.",
                    **overrides,
                }
            ),
            headers={
                "Authorization": "Bearer bridge-token-for-test",
                "Content-Type": "application/json",
            },
        )
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


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
    assert response == {"error": expected_error}


def test_bridge_reports_codex_termination_signal(bridge: tuple[int, Path]) -> None:
    port, workspace = bridge
    (workspace / "mode").write_text("signal", encoding="utf-8")

    status, response = request_revision(port)

    assert status == 422
    assert response == {"error": "Codex가 신호 SIGTERM(으)로 끝났습니다."}


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
    assert response == {"error": "선택 문장이(가) 너무 깁니다."}
