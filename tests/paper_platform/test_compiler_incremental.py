from __future__ import annotations

import importlib.util
import subprocess
import sys
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
