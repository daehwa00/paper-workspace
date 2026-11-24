from __future__ import annotations

import base64
import http.client
import importlib.util
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("rebuttal_compiler", ROOT / "apps/paper_workspace/compiler/server.py")
assert SPEC and SPEC.loader
compiler = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = compiler
SPEC.loader.exec_module(compiler)
TOKEN = "rebuttal-bridge-test-token"


def post(port, path, body, token=TOKEN):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        connection.request("POST", path, json.dumps(body), {"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


@pytest.fixture
def rebuttal_bridge(tmp_path):
    auth = tmp_path / "auth"
    auth.mkdir()
    (auth / "auth.json").write_text(json.dumps({"access_token": "PRIVATE_ACCESS_TOKEN_123456789"}))
    binary = tmp_path / "bin"
    binary.mkdir()
    fake = binary / "codex"
    fake.write_text('''#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  fs.appendFileSync('calls.jsonl', JSON.stringify({args, prompt}) + '\\n');
  const output = args[args.indexOf('--output-last-message') + 1];
  const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1]));
  if (prompt.includes('"selection":"wait"')) {
    fs.writeFileSync('waiting', String(process.pid));
    setTimeout(() => fs.writeFileSync(output, JSON.stringify({replacement: 'late', summary: ''})), 30000);
  } else if (fs.existsSync('result.json')) {
    fs.writeFileSync(output, fs.readFileSync('result.json'));
  } else {
    const result = {};
    for (const [key, value] of Object.entries(schema.properties)) result[key] = value.type === 'array' ? [] : 'ok';
    fs.writeFileSync(output, JSON.stringify(result));
  }
});
''')
    fake.chmod(0o755)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    process = subprocess.Popen(["node", str(ROOT / "apps/paper_workspace/codex_bridge/server.mjs")], env={**os.environ, "CODEX_BRIDGE_PORT": str(port), "CODEX_BRIDGE_TOKEN": TOKEN, "CODEX_HOME": str(auth), "CODEX_WORKSPACE": str(tmp_path), "PATH": f"{binary}:{os.environ['PATH']}"}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for _ in range(80):
            if process.poll() is not None:
                pytest.fail(process.stderr.read().decode())
            try:
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=.2)
                connection.request("GET", "/health")
                connection.getresponse().read()
                connection.close()
                break
            except OSError:
                time.sleep(.025)
        else:
            pytest.fail("bridge did not start")
        yield port, tmp_path
    finally:
        process.terminate()
        process.wait(timeout=3)


def analysis(task="map", job_id="job", **payload):
    return {"task": task, "job_id": job_id, "payload": {"reviews": [], "concerns": [], "documents": [], **payload}}


@pytest.mark.parametrize("task,key", [("translate", "translations"), ("analyze", "concerns"), ("map", "mappings"), ("style", "findings"), ("consistency", "consistency"), ("simulate", "simulated_questions"), ("rewrite", "replacement")])
def test_task_schemas_disable_tools_and_web(rebuttal_bridge, task, key):
    port, work = rebuttal_bridge
    status, result = post(port, "/internal/rebuttal", analysis(task))
    assert status == 200, result
    assert key in result["result"]
    invocation = json.loads((work / "calls.jsonl").read_text().splitlines()[-1])
    args = invocation["args"]
    assert args[args.index('--model')+1] == 'gpt-6.1-terra'
    effort='low' if task == 'translate' else 'medium' if task == 'style' else 'xhigh' if task=='consistency' else 'high'
    assert f'model_reasoning_effort="{effort}"' in args
    if task in {'translate','analyze'}:
        assert 'Korean (ko-KR)' in invocation['prompt']
        assert 'Do not translate into Chinese or Japanese' in invocation['prompt']
        assert 'exactly one translations entry' in invocation['prompt']
    assert 'web_search="disabled"' in args
    for flag in ("shell_tool", "unified_exec", "multi_agent", "apps"):
        assert args[args.index(flag) - 1] == "--disable"
    assert "--ignore-user-config" in args and "--ignore-rules" in args


def test_translation_block_uses_light_and_minimal_output_without_alignment(rebuttal_bridge):
    port, work = rebuttal_bridge
    (work / 'result.json').write_text(json.dumps({'text': '실험을 추가했습니다.'}))
    status, result = post(port, '/internal/rebuttal', analysis('translate_block', reviews=[{'id': 'doc', 'reviewer_id': 'doc', 'fields': {'response': 'We added an experiment.'}}], glossary={}, phase='translate_block'))
    assert status == 200 and result['result']['text'] == '실험을 추가했습니다.'
    invocation = json.loads((work / 'calls.jsonl').read_text().splitlines()[-1])
    assert 'model_reasoning_effort="low"' in invocation['args']
    assert invocation['args'][invocation['args'].index('--model') + 1] == 'gpt-6.1-terra'
    assert 'Do not append the original, explanations, alternative translations, or alignment pairs.' in invocation['prompt']
    assert 'web_search="disabled"' in invocation['args']


def test_translation_block_retry_prompt_explains_validation_without_changing_schema(rebuttal_bridge):
    port, work = rebuttal_bridge
    (work / 'result.json').write_text(json.dumps({'text': '수식 $x^2$를 보존했습니다.'}))
    body = analysis('translate_block', reviews=[{'id':'doc','reviewer_id':'doc','fields':{'response':'We preserved $x^2$.'}}],
        glossary={}, phase='translate_block_verify_quotes', validation_feedback='translation')
    status, result = post(port, '/internal/rebuttal', body)
    assert status == 200 and set(result['result']) == {'text'}
    invocation = json.loads((work / 'calls.jsonl').read_text().splitlines()[-1])
    assert 'previous attempt failed translation validation' in invocation['prompt']
    assert 'Copy code, LaTeX delimiters and equations verbatim' in invocation['prompt']
    assert 'Return exactly one translation for the supplied review and field' not in invocation['prompt']


def test_direct_connect_includes_manuscript_as_context(rebuttal_bridge):
    port, work = rebuttal_bridge
    manuscript={'entrypoint':'main.tex','files':[{'path':'main.tex','text':'Manuscript context'}]}
    status, result=post(port,'/internal/rebuttal',analysis('direct_connect',manuscript=manuscript))
    assert status == 200 and result['result']['links'] == []
    invocation=json.loads((work / 'calls.jsonl').read_text().splitlines()[-1])
    assert 'Manuscript context' in invocation['prompt']
    assert 'never use the manuscript as a source of quoted review or response text' in invocation['prompt']


def test_validation_retry_feedback_reaches_the_bridge(rebuttal_bridge):
    port, work = rebuttal_bridge
    body = analysis('analyze', phase='extract_verify_quotes', validation_feedback='evidence')
    status, result = post(port, '/internal/rebuttal', body)
    assert status == 200, result
    invocation = json.loads((work / 'calls.jsonl').read_text().splitlines()[-1])
    assert 'The previous attempt failed validation' in invocation['prompt']
    for phase, feedback in [('extract', 'evidence'), ('extract_verify_quotes', 'unexpected')]:
        invalid = analysis('analyze', phase=phase, validation_feedback=feedback)
        status, result = post(port, '/internal/rebuttal', invalid)
        assert status == 422 and result['error_code'] == 'bridge_invalid_request'


def test_research_is_metadata_only_and_live_search(rebuttal_bridge):
    port, work = rebuttal_bridge
    body = {"task": "research_rules", "job_id": "research", "payload": {"venue": "Venue", "year": 2026, "track": "Main", "stage": "Rebuttal", "official_urls": ["https://example.org/2026/rebuttal"]}}
    assert post(port, "/internal/rebuttal", body) == (200, {"result": {"rules_candidates": []}})
    invocation = json.loads((work / "calls.jsonl").read_text().splitlines()[-1])
    assert 'web_search="live"' in invocation["args"]
    assert "official URL, title, verbatim supporting excerpt" in invocation["prompt"]
    for field in ("reviews", "documents", "manuscript", "credentials"):
        bad = {**body, "payload": {**body["payload"], field: "private"}}
        assert post(port, "/internal/rebuttal", bad)[0] == 422
    assert len((work / "calls.jsonl").read_text().splitlines()) == 1


@pytest.mark.parametrize("mutation", [lambda body: body.update(task="shell"), lambda body: body.update(job_id="../escape"), lambda body: body.update(profile="unknown"), lambda body: body["payload"].update(credentials="secret"), lambda body: body["payload"].update(selection="PRIVATE_ACCESS_TOKEN_123456789")])
def test_invalid_model_input_is_rejected_before_spawn(rebuttal_bridge, mutation):
    port, work = rebuttal_bridge
    body = analysis()
    mutation(body)
    status, result = post(port, "/internal/rebuttal", body)
    assert status == 422
    assert "PRIVATE_ACCESS_TOKEN" not in json.dumps(result)
    assert not (work / "calls.jsonl").exists()


@pytest.mark.parametrize("output", [{"mappings": [], "score": 99}, {"mappings": [{"concern_id": "c", "response_spans": [], "coverage": "addressed", "reason": "x", "missing": [], "score": .9}]}, {"mappings": "bad"}, {"mappings": [], "rules_candidates": []}])
def test_invalid_model_results_are_rejected(rebuttal_bridge, output):
    port, work = rebuttal_bridge
    (work / "result.json").write_text(json.dumps(output))
    assert post(port, "/internal/rebuttal", analysis())[0] == 422


def test_multiple_mapping_spans_are_preserved(rebuttal_bridge):
    port, work = rebuttal_bridge
    output = {"mappings": [{"concern_id": "c1", "response_spans": [{"document_id": "d1", "quote": "One"}, {"document_id": "d2", "quote": "Two"}], "coverage": "partial", "reason": "needs more", "missing": ["evidence"]}]}
    (work / "result.json").write_text(json.dumps(output))
    assert post(port, "/internal/rebuttal", analysis()) == (200, {"result": output})


def test_cancel_affects_only_named_running_job(rebuttal_bridge):
    port, work = rebuttal_bridge
    results = []
    worker = threading.Thread(target=lambda: results.append(post(port, "/internal/rebuttal", analysis("rewrite", "slow", selection="wait"))))
    worker.start()
    for _ in range(100):
        if (work / "waiting").exists():
            break
        time.sleep(.025)
    assert (work / "waiting").exists()
    assert post(port, "/internal/rebuttal/cancel", {"job_id": "other"}) == (200, {"cancelled": False})
    assert worker.is_alive()
    assert post(port, "/internal/rebuttal", analysis("map", "sibling"))[0] == 200
    assert post(port, "/internal/rebuttal/cancel", {"job_id": "slow"}) == (200, {"cancelled": True})
    worker.join(timeout=3)
    assert not worker.is_alive()
    assert results[0][0] == 422 and "cancelled" in results[0][1]["error"]
    assert post(port, "/internal/rebuttal", analysis("map", "slow"))[0] == 200


def test_internal_routes_require_bearer_auth(rebuttal_bridge):
    port, _ = rebuttal_bridge
    for path in ("/internal/rebuttal", "/internal/rebuttal/cancel"):
        assert post(port, path, analysis(), token="wrong")[0] == 401


@pytest.fixture
def compiler_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), compiler.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def document(text="Review **response**."):
    return {"documents": [{"id": "doc", "title": "Response", "text": text}]}


@pytest.mark.parametrize("path,payload", [("/extract-review", []), ("/rebuttal-render", []), ("/extract-review", {"data_base64": "not base64"}), ("/extract-review", {"data_base64": base64.b64encode(b"not PDF").decode()}), ("/rebuttal-render", document(" "))])
def test_compiler_rejects_malformed_and_blank_inputs(compiler_server, path, payload):
    assert post(compiler_server, path, payload)[0] == 422


@pytest.mark.parametrize("name,template", [("../escape.tex", "%%REBUTTAL_BODY%%"), ("main.tex", r"\input{/etc/passwd} %%REBUTTAL_BODY%%"), ("main.tex", r"\csname input\endcsname{secret} %%REBUTTAL_BODY%%"), ("main.tex", "no placeholder"), ("main.tex", r"\usepackage{../../secret} %%REBUTTAL_BODY%%")])
def test_template_paths_and_tex_injection_are_rejected(name, template):
    with pytest.raises(ValueError):
        compiler.render_rebuttal({**document(), "template": {"entrypoint": name, "files": {name: template}}})


def fake_toolchain(monkeypatch, *, pages=2, extracted="First page\fSecond page\f", body="Converted response"):
    calls = []
    def process(command, work, deadline):
        calls.append(command)
        if command[0] == "pdfinfo":
            return f"Pages: {pages}\n"
        if command[0] == "pdftotext":
            (work / "review.txt").write_text(extracted)
        if command[0] == "pandoc":
            (work / "body.tex").write_text(body)
        if command[0] == "pdflatex":
            (work / "rebuttal.pdf").write_bytes(b"%PDF-1.4 fixture")
        return ""
    monkeypatch.setattr(compiler, "_rebuttal_process", process)
    return calls


def test_pdf_extraction_retains_page_provenance_and_rejects_blank(monkeypatch):
    calls = fake_toolchain(monkeypatch)
    payload = {"data_base64": base64.b64encode(b"%PDF-1.4 fixture").decode()}
    result = compiler.extract_review(payload)
    assert result == {"pages": [{"page": 1, "text": "First page"}, {"page": 2, "text": "Second page"}], "text": "First page\n\nSecond page"}
    assert [call[0] for call in calls] == ["pdfinfo", "pdftotext"]
    fake_toolchain(monkeypatch, extracted=" \f\f")
    with pytest.raises(ValueError, match="no extractable text"):
        compiler.extract_review(payload)
    fake_toolchain(monkeypatch, pages=101)
    with pytest.raises(ValueError, match="100 pages"):
        compiler.extract_review(payload)


def test_renderer_uses_fixed_flags_and_no_manuscript_caches(monkeypatch):
    calls = fake_toolchain(monkeypatch)
    caches = [dict(compiler._compile_cache), dict(compiler._build_states), dict(compiler._synctex_cache)]
    result = compiler.render_rebuttal(document())
    assert result["page_count"] == 2 and base64.b64decode(result["pdf"]).startswith(b"%PDF-")
    assert "Converted response" in result["files"]["main.tex"]
    assert "%%REBUTTAL_BODY%%" not in result["files"]["main.tex"]
    assert calls[0] == ["pandoc", "--sandbox", "--from=markdown-raw_tex-raw_html", "--to=latex", "--output=body.tex", "body.md"]
    assert all("-no-shell-escape" in call for call in calls if call[0] == "pdflatex")
    assert caches == [dict(compiler._compile_cache), dict(compiler._build_states), dict(compiler._synctex_cache)]


@pytest.mark.parametrize("body", [r"\input{/etc/passwd}", r"\includegraphics{https://example.org/a.png}", r"\includegraphics{../../secret.png}", r"\csname input\endcsname{secret}"])
def test_generated_latex_cannot_read_external_files(monkeypatch, body):
    calls = fake_toolchain(monkeypatch, body=body)
    with pytest.raises(ValueError):
        compiler.render_rebuttal(document())
    assert not any(call[0] == "pdflatex" for call in calls)


def test_rebuttal_process_is_resource_bounded_and_has_no_actor_or_secrets(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_BRIDGE_TOKEN", "private")
    monkeypatch.setenv("HTTP_PROXY", "http://private")
    calls = []
    def runner(command, work, env, actor, timeout):
        calls.append((command, env, actor, timeout))
        return subprocess.CompletedProcess(command, 0, "ok", "")
    monkeypatch.setattr(compiler, "_run_process", runner)
    assert compiler._rebuttal_process(["pandoc", "body.md"], tmp_path, time.monotonic() + 30) == "ok"
    command, env, actor, timeout = calls[0]
    assert command[0] == "prlimit" and "--fsize=16777216" in command
    assert "CODEX_BRIDGE_TOKEN" not in env and "HTTP_PROXY" not in env
    assert actor == "" and timeout <= 20


def test_direct_connect_audit_prompt_contains_candidates_and_classification_schema(rebuttal_bridge):
    port, work = rebuttal_bridge
    body = analysis('direct_connect', phase='direct_connect_audit', candidate_mappings=[{'reason':'기존 연결'}])
    status, result = post(port, '/internal/rebuttal', body)
    assert status == 200 and result['result']['links'] == []
    invocation = json.loads((work / 'calls.jsonl').read_text().splitlines()[-1])
    assert 'AUDIT PASS' in invocation['prompt']
    assert 'Return only newly discovered pairs' in invocation['prompt']
    assert '기존 연결' in invocation['prompt']
