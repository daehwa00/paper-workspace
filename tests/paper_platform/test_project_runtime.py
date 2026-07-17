from __future__ import annotations

import importlib.util
import hashlib
import json
from pathlib import Path

import pytest


ROOT = Path(__file__).parents[2]
SCRIPT = ROOT / "scripts/paper_platform/sync_project_runtime.py"


def load_runtime_module():
    spec = importlib.util.spec_from_file_location("paper_project_runtime", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_project(root: Path, marker: str) -> None:
    root.mkdir(parents=True)
    (root / "sections").mkdir()
    (root / "main.tex").write_text(f"main {marker}", encoding="utf-8")
    (root / "sections/method.tex").write_text(f"method {marker}", encoding="utf-8")
    (root / "private-draft.tex").write_text("must not be served", encoding="utf-8")
    (root / ".secret").write_text("must not be served", encoding="utf-8")
    (root / "project.json").write_text(
        json.dumps(
            {
                "id": marker,
                "version": "1",
                "entrypoint": "main.tex",
                "files": [
                    {"path": "main.tex", "managed": True},
                    {"path": "sections/method.tex", "managed": True},
                ],
            }
        ),
        encoding="utf-8",
    )


def test_runtime_contains_only_manifest_listed_project_files(tmp_path: Path) -> None:
    runtime = load_runtime_module()
    default = tmp_path / "default"
    projects = tmp_path / "projects"
    output = tmp_path / "runtime"
    write_project(default, "default-paper")
    write_project(projects / "paper-two", "paper-two")
    (projects / "index.json").write_text(
        json.dumps(
            {
                "projects": [
                    {"slug": "default-paper", "source": "default"},
                    {"slug": "paper-two"},
                ]
            }
        ),
        encoding="utf-8",
    )

    runtime.sync_runtime(default, projects, output)

    assert (output / "project/main.tex").read_text() == "main default-paper"
    assert (output / "project/sections/method.tex").is_file()
    assert (output / "projects/index.json").is_file()
    assert (output / "projects/paper-two/main.tex").read_text() == "main paper-two"
    assert not (output / "project/private-draft.tex").exists()
    assert not (output / "project/.secret").exists()
    assert not (output / "projects/paper-two/private-draft.tex").exists()

    manifest = json.loads((output / "project/project.json").read_text())
    assert len(manifest["runtime_revision"]) == 64
    assert "project.json" not in manifest["runtime_file_revisions"]
    for relative in ("main.tex", "sections/method.tex"):
        assert manifest["runtime_file_revisions"][relative] == hashlib.sha256(
            (output / "project" / relative).read_bytes()
        ).hexdigest()


def test_runtime_revision_tracks_only_staged_manifest_files(tmp_path: Path) -> None:
    runtime = load_runtime_module()
    default = tmp_path / "default"
    projects = tmp_path / "projects"
    output = tmp_path / "runtime"
    write_project(default, "default-paper")
    projects.mkdir()
    (projects / "index.json").write_text(
        json.dumps({"projects": [{"slug": "default-paper", "source": "default"}]}),
        encoding="utf-8",
    )

    runtime.sync_runtime(default, projects, output)
    initial = json.loads((output / "project/project.json").read_text())
    (default / "private-draft.tex").write_text("private change", encoding="utf-8")
    runtime.sync_runtime(default, projects, output)
    private_change = json.loads((output / "project/project.json").read_text())
    assert private_change["runtime_revision"] == initial["runtime_revision"]

    (default / "main.tex").write_text("main changed without a version bump", encoding="utf-8")
    runtime.sync_runtime(default, projects, output)
    source_change = json.loads((output / "project/project.json").read_text())
    assert source_change["version"] == initial["version"] == "1"
    assert source_change["runtime_revision"] != initial["runtime_revision"]
    assert source_change["runtime_file_revisions"]["main.tex"] == hashlib.sha256(
        (output / "project/main.tex").read_bytes()
    ).hexdigest()


def test_runtime_hashes_the_staged_copy_when_source_changes_mid_sync(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime = load_runtime_module()
    default = tmp_path / "default"
    projects = tmp_path / "projects"
    output = tmp_path / "runtime"
    write_project(default, "default-paper")
    projects.mkdir()
    (projects / "index.json").write_text(
        json.dumps({"projects": [{"slug": "default-paper", "source": "default"}]}),
        encoding="utf-8",
    )
    original_copy = runtime.shutil.copyfile
    raced = False

    def copy_then_edit(source: Path, destination: Path) -> None:
        nonlocal raced
        original_copy(source, destination)
        if not raced and Path(source) == default / "main.tex":
            raced = True
            Path(source).write_text("changed after staged copy", encoding="utf-8")

    monkeypatch.setattr(runtime.shutil, "copyfile", copy_then_edit)
    runtime.sync_runtime(default, projects, output)

    staged = output / "project/main.tex"
    manifest = json.loads((output / "project/project.json").read_text())
    assert staged.read_text() == "main default-paper"
    assert manifest["runtime_file_revisions"]["main.tex"] == hashlib.sha256(
        staged.read_bytes()
    ).hexdigest()


def test_runtime_rejects_manifest_symlinks_without_replacing_last_good_copy(tmp_path: Path) -> None:
    runtime = load_runtime_module()
    default = tmp_path / "default"
    projects = tmp_path / "projects"
    output = tmp_path / "runtime"
    write_project(default, "default-paper")
    projects.mkdir()
    (projects / "index.json").write_text(
        json.dumps({"projects": [{"slug": "default-paper", "source": "default"}]}),
        encoding="utf-8",
    )
    runtime.sync_runtime(default, projects, output)
    previous = (output / "project/main.tex").read_text()
    (default / "sections/method.tex").unlink()
    (default / "sections/method.tex").symlink_to(default / "private-draft.tex")

    with pytest.raises(ValueError, match="symlinks"):
        runtime.sync_runtime(default, projects, output)

    assert (output / "project/main.tex").read_text() == previous
    assert not (output / "project/private-draft.tex").exists()
