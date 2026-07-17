from __future__ import annotations

import importlib.util
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
