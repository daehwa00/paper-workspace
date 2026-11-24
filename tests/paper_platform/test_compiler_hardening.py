from __future__ import annotations

import base64
import gzip
import http.client
import json
import shutil
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

import pytest

from test_compiler_incremental import compiler


@pytest.fixture
def runtime():
    return compiler.CompilerRuntime()


@pytest.fixture
def post(runtime):
    server = compiler.create_server(("127.0.0.1", 0), runtime=runtime)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02})
    thread.start()

    def request(payload, *, path="/compile", actor="alice", client="shared", state=""):
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        try:
            headers = {"X-Paper-Actor": actor, "X-Compile-Client": client, "X-Compile-State": state}
            body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
            connection.request("POST", path, body, headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    try:
        yield request
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def project(content="contents"):
    return {"workspace_id": "paper", "files": {"main.tex": content}}


@pytest.fixture
def fake_build(monkeypatch):
    monkeypatch.setattr(compiler, "_pdf_audit", lambda pdf: {"size_bytes": len(pdf)})

    def build(work, entrypoint, files, *_):
        (work / "preview.pdf").write_bytes(b"%PDF-1.4")
        (work / "preview.aux").write_bytes(files["main.tex"].encode())
        (work / "preview.synctex.gz").write_bytes(gzip.compress(
            f"SyncTeX Version:1\nInput:1:{work / 'main.tex'}\n"
            f"Input:2:{work / '__fragment_preview.tex'}\n"
            f"Input:3:{work / 'absent.tex'}\n".encode()
        ))
        return 2, 0, "test bibliography"

    monkeypatch.setattr(compiler, "_run_latex_build", build)
    return build


@pytest.mark.parametrize("scope", [("bob", "shared", "paper"), ("alice", "shared", "other")])
def test_cancellation_isolated_by_actor_and_workspace(runtime, monkeypatch, scope):
    killed = []
    monkeypatch.setattr(compiler.sys.modules[compiler.CompilerRuntime.__module__],
                        "terminate_process", killed.append)
    _, _, first = runtime.claim_build("old", ("alice", "shared", "paper"))
    first.process = object()
    _, _, unrelated = runtime.claim_build("unrelated", scope)
    unrelated.process = object()

    _, _, new = runtime.claim_build("new", first.scope)
    assert killed == [first.process]
    runtime.assert_current(new)
    runtime.assert_current(unrelated)
    with pytest.raises(RuntimeError, match="superseded"):
        runtime.spawn(first, ["unused"])
    runtime.end_generation(first)
    runtime.assert_current(new)
    runtime.end_generation(new)
    with pytest.raises(RuntimeError, match="superseded"):
        runtime.assert_current(first)


def test_superseded_flight_cannot_prevent_rebuilding_same_payload(runtime):
    scope = ("alice", "shared", "paper")
    _, old_flight, old = runtime.claim_build("A", scope)
    runtime.claim_build("B", scope)
    leader, new_flight, current = runtime.claim_build("A", scope)
    assert leader
    assert old_flight is not new_flight
    runtime.end_generation(old)
    runtime.finish_flight("A", old_flight)
    assert runtime.flights["A"] is new_flight
    runtime.assert_current(current)
    same, duplicate, _ = runtime.claim_build("A", scope)
    assert not same
    assert duplicate is new_flight
    runtime.assert_current(current)


@pytest.mark.parametrize("endpoint", ["/compile", "/package"])
@pytest.mark.parametrize(("extra_files", "assets", "error"), [
    ({"sections/a.tex": "", "sections/./a.tex": ""}, {}, "duplicate normalized"),
    ({}, {"fig/a.png": "", "fig//a.png": ""}, "duplicate normalized"),
    ({"entry.tex": "", "entry.tex/chapter.tex": ""}, {}, "conflicts with directory"),
    ({"entry.tex/chapter.tex": "", "entry.tex": ""}, {}, "conflicts with directory"),
    ({"figure.png/chapter.tex": ""}, {"./figure.png": ""}, "conflicts with directory"),
    ({"./__fragment_preview.tex": ""}, {}, "reserved project path"),
    ({"sections//__fragment_preview.tex/child.tex": ""}, {}, "reserved project path"),
])
def test_rejects_normalized_collisions_on_project_endpoints(post, endpoint, extra_files, assets, error):
    payload = project()
    payload["files"].update(extra_files)
    payload["assets"] = assets
    status, response = post(payload, path=endpoint)
    assert status == 422
    assert error in response["error"]


def test_rejects_duplicate_json_entries(post):
    status, response = post(b'{"workspace_id":"paper","files":{"main.tex":"a","main.tex":"b"}}')
    assert status == 422
    assert "duplicate request key" in response["error"]


@pytest.mark.parametrize(("location", "expected"), [("staging", 422), ("disk", 500), ("output", 500)])
def test_staging_and_output_os_errors_are_json(post, runtime, fake_build, monkeypatch, location, expected):
    original = Path.write_text
    if location == "output":
        def no_pdf(work, *args):
            result = fake_build(work, *args)
            (work / "preview.pdf").unlink()
            return result
        monkeypatch.setattr(compiler, "_run_latex_build", no_pdf)
    else:
        def write(path, *args, **kwargs):
            if path.name == "main.tex":
                if location == "staging":
                    raise IsADirectoryError("conflict")
                raise OSError("device unavailable")
            return original(path, *args, **kwargs)
        monkeypatch.setattr(Path, "write_text", write)

    status, response = post(project())
    assert status == expected
    assert response["error"]
    assert not runtime.flights
    assert not runtime.generations


def test_cache_hit_issues_current_state_for_exact_result(post, runtime, fake_build):
    status, old = post(project("old"))
    assert status == 200
    status, built = post(project("current"))
    assert status == 200
    old_token = old["build_state_id"]
    runtime.build_states.pop(old_token)

    status, cached = post(project("current"), state=old_token)
    token = cached["build_state_id"]
    assert status == 200 and cached["cached"]
    assert token and token not in (old_token, built["build_state_id"])
    binding = ("alice", "shared", "paper", "main.tex", "main.tex", "document")
    assert runtime.build_state_get(token, binding).artifacts == {"preview.aux": b"current"}
    assert runtime.build_state_get(token, ("bob", *binding[1:])) is None


def test_cache_recheck_after_flight_claim_avoids_duplicate_build(post, runtime, fake_build, monkeypatch):
    payload = project()
    assert post(payload)[0] == 200
    original_get = runtime.cache_get
    calls = []

    def racing_get(key):
        calls.append(key)
        return original_get(key) if len(calls) > 1 else None

    monkeypatch.setattr(runtime, "cache_get", racing_get)
    monkeypatch.setattr(compiler, "_run_latex_build", lambda *_: pytest.fail("duplicate build"))
    status, response = post(payload)
    assert status == 200 and response["cached"]
    assert len(calls) == 2


@pytest.mark.parametrize(("failure", "status"), [(None, 200), (RuntimeError("TeX error"), 422), (OSError("disk error"), 500)])
def test_singleflight_waiters_receive_full_outcome_without_cache(
    post, runtime, fake_build, monkeypatch, failure, status,
):
    leader_started = threading.Event()
    follower_joined = threading.Event()
    calls = []
    runtime.settings = type("Settings", (), {"COMPILE_CACHE_MAX_BYTES": 1})
    original_claim = runtime.claim_build

    def claim(*args):
        result = original_claim(*args)
        if not result[0]:
            follower_joined.set()
        return result

    def build(*args):
        calls.append(1)
        leader_started.set()
        assert follower_joined.wait(3)
        if failure:
            raise failure
        return fake_build(*args)

    monkeypatch.setattr(runtime, "claim_build", claim)
    monkeypatch.setattr(compiler, "_run_latex_build", build)
    with ThreadPoolExecutor(max_workers=2) as executor:
        leader = executor.submit(post, project())
        assert leader_started.wait(3)
        follower = executor.submit(post, project(), client="follower")
        first_status, first = leader.result()
        second_status, second = follower.result()

    assert first_status == second_status == status
    assert len(calls) == 1
    assert not runtime.compile_cache
    if failure:
        assert first == second
    else:
        assert second["cached"] and not first["cached"]
        assert first["pdf_base64"] == second["pdf_base64"]
        assert first["compile_id"] == second["compile_id"]
        assert first["build_state_id"] != second["build_state_id"]
        for client, result in (("shared", first), ("follower", second)):
            binding = ("alice", client, "paper", "main.tex", "main.tex", "document")
            assert runtime.build_state_get(result["build_state_id"], binding)


def test_rejects_request_and_asset_budgets_before_decode_or_build(post, monkeypatch):
    monkeypatch.setattr(compiler, "MAX_REQUEST_BYTES", 15)
    assert post(project())[0] == 422
    monkeypatch.setattr(compiler, "MAX_REQUEST_BYTES", 1024)
    monkeypatch.setattr(compiler, "MAX_ASSET_BYTES", 3)
    monkeypatch.setattr(compiler, "decode_assets", lambda *_: pytest.fail("decoded oversized assets"))
    monkeypatch.setattr(compiler, "_run_latex_build", lambda *_: pytest.fail("started oversized build"))
    payload = {**project(), "assets": {"a.png": "YWI=", "b.png": "Y2Q="}}
    status, response = post(payload)
    assert status == 422
    assert "assets exceed" in response["error"]


def test_request_admission_rejects_before_body_read():
    runtime = compiler.CompilerRuntime(request_limit=1)
    assert runtime.request_slots.acquire(blocking=False)
    with compiler.create_server(("127.0.0.1", 0), runtime=runtime) as server:
        thread = threading.Thread(target=server.handle_request, daemon=True)
        thread.start()
        with closing(http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)) as connection:
            connection.putrequest("POST", "/compile")
            connection.putheader("Content-Length", "48000000")
            connection.endheaders()
            response = connection.getresponse()
            assert response.status == 503
            assert "capacity" in json.loads(response.read())["error"]
        thread.join(timeout=3)
    runtime.request_slots.release()


def test_snapshot_does_not_open_oversized_auxiliary_file(tmp_path, monkeypatch):
    artifact = tmp_path / "preview.aux"
    with artifact.open("wb") as stream:
        stream.truncate(compiler.BUILD_STATE_MAX_BYTES + 1)
    monkeypatch.setattr(Path, "open", lambda *_: pytest.fail("opened oversized artifact"))
    assert compiler._snapshot_build_artifacts(tmp_path) == {}


@pytest.mark.parametrize(("file_name", "limit"), [
    ("preview.pdf", "MAX_PDF_BYTES"), ("preview.synctex.gz", "MAX_SYNCTEX_BYTES"),
])
def test_output_is_capped_before_opening(post, fake_build, monkeypatch, file_name, limit):
    original_open = Path.open
    monkeypatch.setattr(compiler, limit, 1)

    def guard(path, mode="r", *args, **kwargs):
        if path.name == file_name and mode == "rb":
            pytest.fail("opened oversized compile output")
        return original_open(path, mode, *args, **kwargs)

    monkeypatch.setattr(Path, "open", guard)
    status, response = post(project())
    assert status == 422 and "exceeds size limit" in response["error"]


@pytest.mark.parametrize("use_raw", [False, True])
@pytest.mark.parametrize(("source", "status"), [
    ("main.tex", 200),
    ("__fragment_preview.tex", 422),
    ("absent.tex", 422),
    ("/tmp/tmpabcdefgh/main.tex", 422),
    ("/__compiler_unmapped__/2", 422),
])
def test_reverse_synctex_returns_only_project_sources(
    post, runtime, fake_build, monkeypatch, use_raw, source, status,
):
    _, result = post(project())
    if use_raw:
        runtime.synctex_cache.clear()
        reference = {"synctex_base64": result["synctex_base64"]}
    else:
        reference = {"compile_id": result["compile_id"]}
    output = f"Input:{source}\nLine:7\nColumn:2\n"
    monkeypatch.setattr(compiler.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess([], 0, output, ""))
    coordinates = {"page": 1, "x": 10, "y": 11}
    actual, response = post({**reference, **coordinates}, path="/synctex")
    assert actual == status
    if status == 200:
        assert response == {"file": "main.tex", "line": 7, "column": 2}


def test_reverse_synctex_rejects_tampered_or_cross_actor_raw_data(post, fake_build, monkeypatch):
    _, result = post(project())
    raw = bytearray(base64.b64decode(result["synctex_base64"]))
    raw[-1] ^= 1
    monkeypatch.setattr(compiler.subprocess, "run", lambda *_a, **_k: pytest.fail("ran unverified SyncTeX"))
    coordinates = {"page": 1, "x": 10, "y": 11}

    for actor, encoded in [
        ("bob", result["synctex_base64"]),
        ("alice", base64.b64encode(raw).decode()),
        ("alice", base64.b64encode(gzip.compress(b"Input:1:main.tex\n")).decode()),
    ]:
        status, response = post({**coordinates, "synctex_base64": encoded}, path="/synctex", actor=actor)
        assert status == 422
        assert "SyncTeX cache expired" in response["error"]


@pytest.mark.skipif(not all(shutil.which(name) for name in ("pdflatex", "synctex", "pdffonts")),
                    reason="compiler toolchain is unavailable")
def test_real_signed_synctex_round_trip_after_cache_eviction(post, runtime):
    document = r"\documentclass{article}" "\n" r"\begin{document}" "\nHello world\n" r"\end{document}"
    status, result = post(project(document))
    assert status == 200, result
    raw = result["synctex_base64"]
    assert b"Input:1:main.tex" in gzip.decompress(base64.b64decode(raw))
    runtime.synctex_cache.clear()
    reference = {"synctex_base64": raw}
    status, forward = post({**reference, "file": "main.tex", "line": 3}, path="/synctex-view")
    assert status == 200, forward
    status, reverse = post(
        {**reference, "page": forward["page"], "x": forward["x"], "y": forward["y"]}, path="/synctex",
    )
    assert status == 200, reverse
    assert reverse["file"] == "main.tex"


def test_reverse_synctex_skips_uneditable_matches_before_project_source(
    post, fake_build, monkeypatch,
):
    _, result = post(project())
    output = "Input:__fragment_preview.tex\nLine:2\nColumn:1\nInput:main.tex\nLine:8\nColumn:9\n"
    monkeypatch.setattr(compiler.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess([], 0, output, ""))
    status, data = post({"compile_id": result["compile_id"], "page": 1, "x": 10, "y": 11}, path="/synctex")
    assert status == 200
    assert data == {"file": "main.tex", "line": 8, "column": 9}
