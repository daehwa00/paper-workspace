from __future__ import annotations

import importlib.util
import gzip
import os
import subprocess
import sys
import threading
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "paper_workspace_compiler",
    ROOT / "apps/paper_workspace/compiler/server.py",
)
assert SPEC and SPEC.loader
compiler = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = compiler
SPEC.loader.exec_module(compiler)


@pytest.fixture(autouse=True)
def clear_build_states() -> None:
    compiler._build_states.clear()
    compiler._compile_cache.clear()
    compiler._synctex_cache.clear()
    compiler._compile_flights.clear()


def fake_process_runner(aux_versions: list[str], latex_outputs: list[str] | None = None):
    calls: list[str] = []
    latex_outputs = latex_outputs or [""] * len(aux_versions)

    def run(command, cwd, env, client_id, timeout):
        del env, client_id, timeout
        program = command[0]
        calls.append(program)
        if program == "pdflatex":
            index = calls.count("pdflatex") - 1
            Path(cwd, "preview.aux").write_text(aux_versions[min(index, len(aux_versions) - 1)], encoding="utf-8")
            Path(cwd, "preview.pdf").write_bytes(b"%PDF-1.4\n")
            Path(cwd, "preview.synctex.gz").write_bytes(b"\x1f\x8b")
            return subprocess.CompletedProcess(command, 0, latex_outputs[min(index, len(latex_outputs) - 1)], "")
        if program == "bibtex":
            Path(cwd, "preview.bbl").write_text("resolved bibliography", encoding="utf-8")
            return subprocess.CompletedProcess(command, 0, "", "")
        raise AssertionError(program)

    return calls, run


def run_build(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runner, *, files, warm, previous_signature=""):
    texmf = tmp_path / ".texmf"
    texmf.mkdir(exist_ok=True)
    monkeypatch.setattr(compiler, "_run_process", runner)
    return compiler._run_latex_build(
        tmp_path,
        Path("main.tex"),
        files,
        "browser-client",
        texmf,
        warm,
        previous_signature,
    )


def test_cold_bibliography_build_keeps_three_pass_quality(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    aux = "\\citation{paper}\n\\bibstyle{plain}\n\\bibdata{references}\n"
    calls, runner = fake_process_runner([aux, aux, aux])

    passes, bibtex_runs, _ = run_build(
        tmp_path,
        monkeypatch,
        runner,
        files={"main.tex": "text", "references.bib": "@article{paper}"},
        warm=False,
    )

    assert passes == 3
    assert bibtex_runs == 1
    assert calls == ["pdflatex", "bibtex", "pdflatex", "pdflatex"]


def test_warm_prose_edit_reuses_stable_aux_and_bibliography(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    aux = "\\citation{paper}\n\\bibstyle{plain}\n\\bibdata{references}\n"
    files = {"main.tex": "revised prose", "references.bib": "@article{paper}"}
    (tmp_path / "preview.aux").write_text(aux, encoding="utf-8")
    (tmp_path / "preview.bbl").write_text("resolved bibliography", encoding="utf-8")
    previous_signature = compiler._bibliography_signature(aux, files)
    calls, runner = fake_process_runner([aux])

    passes, bibtex_runs, signature = run_build(
        tmp_path,
        monkeypatch,
        runner,
        files=files,
        warm=True,
        previous_signature=previous_signature,
    )

    assert passes == 1
    assert bibtex_runs == 0
    assert signature == previous_signature
    assert calls == ["pdflatex"]


def test_bibliography_change_forces_bibtex_and_settling_passes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    aux = "\\citation{paper}\n\\bibstyle{plain}\n\\bibdata{references}\n"
    old_files = {"main.tex": "text", "references.bib": "@article{paper,title={Old}}"}
    new_files = {"main.tex": "text", "references.bib": "@article{paper,title={New}}"}
    (tmp_path / "preview.aux").write_text(aux, encoding="utf-8")
    (tmp_path / "preview.bbl").write_text("old bibliography", encoding="utf-8")
    calls, runner = fake_process_runner([aux, aux, aux])

    passes, bibtex_runs, _ = run_build(
        tmp_path,
        monkeypatch,
        runner,
        files=new_files,
        warm=True,
        previous_signature=compiler._bibliography_signature(aux, old_files),
    )

    assert passes == 3
    assert bibtex_runs == 1
    assert calls == ["pdflatex", "bibtex", "pdflatex", "pdflatex"]


def test_reference_changes_rerun_until_auxiliary_state_is_stable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "preview.aux").write_text("old label", encoding="utf-8")
    calls, runner = fake_process_runner(["new label", "new label"])

    passes, bibtex_runs, _ = run_build(
        tmp_path,
        monkeypatch,
        runner,
        files={"main.tex": "text"},
        warm=True,
    )

    assert passes == 2
    assert bibtex_runs == 0
    assert calls == ["pdflatex", "pdflatex"]


def test_build_state_token_is_bound_and_rotated() -> None:
    binding = ("client-a", "paper-a", "main.tex", "main.tex", "document")
    token = compiler._build_state_put(binding, {"preview.aux": b"private label"}, "bib-signature")

    assert token and len(token) == 32
    assert compiler._build_state_get(token, binding) is not None
    assert compiler._build_state_get(token, ("client-b", *binding[1:])) is None
    assert compiler._build_state_get(token, (binding[0], "paper-b", *binding[2:])) is None

    replacement = compiler._build_state_put(binding, {"preview.aux": b"next label"}, "next", token)
    assert replacement != token
    assert compiler._build_state_get(token, binding) is None
    assert compiler._build_state_get(replacement, binding) is not None


def test_build_state_expires_and_lru_capacity_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    now = [100.0]
    monkeypatch.setattr(compiler.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(compiler, "BUILD_STATE_ITEMS", 2)
    binding = ("client", "paper", "main.tex", "main.tex", "document")
    first = compiler._build_state_put(binding, {"preview.aux": b"one"}, "one")
    second = compiler._build_state_put(binding, {"preview.aux": b"two"}, "two")
    third = compiler._build_state_put(binding, {"preview.aux": b"three"}, "three")

    assert compiler._build_state_get(first, binding) is None
    assert compiler._build_state_get(second, binding) is not None
    assert compiler._build_state_get(third, binding) is not None

    now[0] += compiler.BUILD_STATE_TTL + 1
    assert compiler._build_state_get(second, binding) is None
    assert compiler._build_state_get(third, binding) is None


def test_build_state_snapshot_contains_only_bounded_generated_artifacts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "preview.aux").write_bytes(b"labels")
    (tmp_path / "preview.bbl").write_bytes(b"bibliography")
    (tmp_path / "main.tex").write_text("secret manuscript", encoding="utf-8")
    (tmp_path / "figure.pdf").write_bytes(b"secret asset")
    (tmp_path / "preview.log").write_text("source excerpts", encoding="utf-8")

    snapshot = compiler._snapshot_build_artifacts(tmp_path)

    assert snapshot == {"preview.aux": b"labels", "preview.bbl": b"bibliography"}
    monkeypatch.setattr(compiler, "BUILD_STATE_MAX_BYTES", 5)
    assert compiler._snapshot_build_artifacts(tmp_path) == {}


def test_rejected_replacement_discards_the_previous_build_state(monkeypatch: pytest.MonkeyPatch) -> None:
    binding = ("client", "paper", "main.tex", "main.tex", "document")
    previous = compiler._build_state_put(binding, {"preview.aux": b"labels"}, "signature")
    monkeypatch.setattr(compiler, "BUILD_STATE_MAX_BYTES", 1)

    replacement = compiler._build_state_put(
        binding,
        {"preview.aux": b"too large"},
        "next signature",
        previous,
    )

    assert replacement is None
    assert compiler._build_state_get(previous, binding) is None


def test_compile_and_synctex_caches_have_a_combined_byte_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(compiler, "COMPILE_CACHE_MAX_BYTES", 20)
    compiler._cache_put("first", b"123456", b"abc", 1)
    compiler._cache_put("second", b"654321", b"xyz", 1)

    total = sum(len(item[1]) + len(item[2]) for item in compiler._compile_cache.values())
    total += sum(len(item[1]) for item in compiler._synctex_cache.values())
    assert total <= 20
    assert len(compiler._compile_cache) + len(compiler._synctex_cache) < 4


def test_identical_compile_requests_share_one_flight() -> None:
    leader, event = compiler._claim_compile_flight("same-payload")
    follower, follower_event = compiler._claim_compile_flight("same-payload")

    assert leader is True
    assert follower is False
    assert follower_event is event
    assert not event.is_set()

    compiler._finish_compile_flight("same-payload", event)
    assert event.wait(0.1)
    assert "same-payload" not in compiler._compile_flights
    assert compiler._claim_compile_flight("same-payload")[0] is True


def test_finishing_stale_compile_flight_does_not_wake_replacement() -> None:
    _, stale = compiler._claim_compile_flight("payload")
    with compiler._compile_flight_lock:
        replacement = threading.Event()
        compiler._compile_flights["payload"] = replacement

    compiler._finish_compile_flight("payload", stale)

    assert stale.is_set()
    assert not replacement.is_set()
    assert compiler._compile_flights["payload"] is replacement


def test_synctex_validation_rejects_invalid_and_expanding_payloads(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ValueError, match="not gzip"):
        compiler.validated_synctex(b"not a gzip stream")

    monkeypatch.setattr(compiler, "MAX_SYNCTEX_EXPANDED_BYTES", 32)
    with pytest.raises(ValueError, match="expanded"):
        compiler.validated_synctex(gzip.compress(b"x" * 33))
    assert compiler.validated_synctex(gzip.compress(b"valid"))


def test_compile_normalizes_only_project_synctex_sources(tmp_path: Path) -> None:
    nested = tmp_path / "sections" / "method.tex"
    nested.parent.mkdir()
    nested.write_text("method", encoding="utf-8")
    localized = tmp_path / "한글" / "방법.tex"
    localized.parent.mkdir()
    localized.write_text("방법", encoding="utf-8")
    expanded = (
        f"SyncTeX Version:1\n"
        f"Input:1:{tmp_path}/./main.tex\n"
        f"Input:2:{nested}\n"
        f"Input:3:{localized}\n"
        "Input:4:/usr/share/texlive/article.cls\n"
    ).encode()

    normalized = gzip.decompress(compiler.normalized_synctex(
        gzip.compress(expanded), tmp_path, {"main.tex", "sections/method.tex", "한글/방법.tex"},
    )).decode()

    assert "Input:1:main.tex\n" in normalized
    assert "Input:2:sections/method.tex\n" in normalized
    assert "Input:3:한글/방법.tex\n" in normalized
    assert "Input:4:/usr/share/texlive/article.cls\n" in normalized
    assert str(tmp_path) not in normalized


def test_reverse_synctex_keeps_nested_project_paths_and_rejects_escape(tmp_path: Path) -> None:
    nested = tmp_path / "sections" / "method.tex"
    nested.parent.mkdir()
    nested.write_text("method", encoding="utf-8")

    assert compiler.synctex_source_path(str(nested), tmp_path) == "sections/method.tex"
    assert compiler.synctex_source_path("main.tex", tmp_path) == "main.tex"
    assert compiler.synctex_source_path(
        "/tmp/tmpabcd1234/sections/method.tex", tmp_path,
    ) == "sections/method.tex"
    with pytest.raises(ValueError, match="outside"):
        compiler.synctex_source_path(str(tmp_path.parent / "secret.tex"), tmp_path)
    with pytest.raises(ValueError, match="outside"):
        compiler.synctex_source_path("/tmp/uploaded/main.tex", tmp_path)
    with pytest.raises(ValueError, match="invalid project path"):
        compiler.synctex_source_path("/tmp/tmpabcd1234/../secret.tex", tmp_path)


@pytest.mark.skipif(
    not all(compiler.shutil.which(tool) for tool in ("pdflatex", "synctex")),
    reason="TeX tools are available in the compiler image",
)
def test_normalized_synctex_survives_a_new_navigation_workspace(tmp_path: Path) -> None:
    build = tmp_path / "build"
    navigation = tmp_path / "navigation"
    build.mkdir()
    navigation.mkdir()
    (build / "main.tex").write_text(
        "\\documentclass{article}\n\\begin{document}\nHello SyncTeX\n\\end{document}\n",
        encoding="utf-8",
    )
    subprocess.run(
        ["pdflatex", "-interaction=nonstopmode", "-halt-on-error", "-synctex=1", "-jobname=preview", "main.tex"],
        cwd=build, capture_output=True, check=True,
    )
    normalized = compiler.normalized_synctex(
        (build / "preview.synctex.gz").read_bytes(), build, {"main.tex"},
    )
    (navigation / "main.synctex.gz").write_bytes(normalized)
    (navigation / "main.pdf").write_bytes((build / "preview.pdf").read_bytes())

    forward = subprocess.run(
        ["synctex", "view", "-i", "3:0:main.tex", "-o", "main.pdf"],
        cwd=navigation, text=True, capture_output=True, check=True,
    )
    reverse = subprocess.run(
        ["synctex", "edit", "-o", "1:300:300:main.pdf"],
        cwd=navigation, text=True, capture_output=True, check=True,
    )

    assert "Page:1" in forward.stdout
    input_match = compiler.re.search(r"^Input:(.+)$", reverse.stdout, compiler.re.MULTILINE)
    assert input_match
    assert compiler.synctex_source_path(input_match.group(1), navigation) == "main.tex"


@pytest.mark.skipif(
    not all(compiler.shutil.which(tool) for tool in ("pdflatex", "synctex")),
    reason="TeX tools are available in the compiler image",
)
def test_legacy_nested_synctex_remains_bidirectional(tmp_path: Path) -> None:
    build = tmp_path / "build"
    navigation = tmp_path / "navigation"
    (build / "sections").mkdir(parents=True)
    navigation.mkdir()
    (build / "main.tex").write_text(
        "\\documentclass{article}\n\\begin{document}\n"
        "\\input{sections/method}\n\\end{document}\n",
        encoding="utf-8",
    )
    (build / "sections" / "method.tex").write_text("Nested legacy source\n", encoding="utf-8")
    subprocess.run(
        ["pdflatex", "-interaction=nonstopmode", "-halt-on-error", "-synctex=1", "-jobname=preview", "main.tex"],
        cwd=build, capture_output=True, check=True,
    )
    (navigation / "main.synctex.gz").write_bytes((build / "preview.synctex.gz").read_bytes())
    (navigation / "main.pdf").write_bytes((build / "preview.pdf").read_bytes())

    forward = subprocess.run(
        ["synctex", "view", "-i", "1:0:sections/method.tex", "-o", "main.pdf"],
        cwd=navigation, text=True, capture_output=True, check=True,
    )
    page = compiler.re.search(r"^Page:(\d+)$", forward.stdout, compiler.re.MULTILINE)
    x = compiler.re.search(r"^x:([0-9.+-]+)$", forward.stdout, compiler.re.MULTILINE)
    y = compiler.re.search(r"^y:([0-9.+-]+)$", forward.stdout, compiler.re.MULTILINE)
    assert page and x and y
    reverse = subprocess.run(
        ["synctex", "edit", "-o", f"{page.group(1)}:{x.group(1)}:{y.group(1)}:main.pdf"],
        cwd=navigation, text=True, capture_output=True, check=True,
    )
    input_match = compiler.re.search(r"^Input:(.+)$", reverse.stdout, compiler.re.MULTILINE)
    assert input_match
    assert compiler.synctex_source_path(input_match.group(1), navigation) == "sections/method.tex"


def test_compiler_health_reflects_required_tex_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(compiler.shutil, "which", lambda name: None if name == "synctex" else f"/usr/bin/{name}")

    assert compiler.compiler_health_errors() == ["synctex"]


def test_process_output_is_drained_with_a_bounded_tail(tmp_path: Path) -> None:
    result = compiler._run_process(
        [sys.executable, "-c", "import sys; sys.stdout.write('x' * 300000 + 'TAIL')"],
        tmp_path,
        dict(os.environ),
        "",
        5,
    )

    assert result.returncode == 0
    assert len(result.stdout.encode()) <= compiler.MAX_PROCESS_LOG_BYTES
    assert result.stdout.endswith("TAIL")
