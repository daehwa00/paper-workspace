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
    default_alias = output / "projects/default-paper"
    assert default_alias.is_symlink()
    assert (default_alias / "main.tex").read_text() == "main default-paper"
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


def test_runtime_upgrade_replaces_an_old_fingerprint_missing_default_alias(tmp_path: Path) -> None:
    runtime = load_runtime_module()
    default = tmp_path / "default"
    projects = tmp_path / "projects"
    output = tmp_path / "runtime"
    write_project(default, "default-paper")
    (projects / "index.json").parent.mkdir()
    (projects / "index.json").write_text(
        json.dumps({"projects": [{"slug": "default-paper", "source": "default"}]}),
        encoding="utf-8",
    )
    runtime.sync_runtime(default, projects, output)

    # Releases before default aliases existed hashed only regular files.  Model
    # that persisted fingerprint, then remove the newly required alias from the
    # old runtime volume before running the upgraded synchronizer.
    legacy_digest = hashlib.sha256()
    paths = sorted([
        *(output / "project").rglob("*"),
        *(output / "projects").rglob("*"),
    ])
    for path in paths:
        if path.is_file():
            legacy_digest.update(path.relative_to(output).as_posix().encode())
            with path.open("rb") as handle:
                while chunk := handle.read(64 * 1024):
                    legacy_digest.update(chunk)
    (output / ".fingerprint").write_text(f"{legacy_digest.hexdigest()}\n", encoding="utf-8")
    (output / "projects/default-paper").unlink()

    runtime.sync_runtime(default, projects, output)

    alias = output / "projects/default-paper"
    assert alias.is_symlink()
    assert alias.readlink() == Path("../project")


def test_missing_declared_file_does_not_freeze_other_runtime_updates(tmp_path: Path) -> None:
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

    (default / "sections/method.tex").unlink()
    (default / "main.tex").write_text(
        "\\input{sections/method}\nlatest main source",
        encoding="utf-8",
    )
    runtime.sync_runtime(default, projects, output)

    runtime_root = output / "project"
    manifest = json.loads((runtime_root / "project.json").read_text())
    assert (runtime_root / "main.tex").read_text() == (
        "\\input{sections/method}\nlatest main source"
    )
    assert not (runtime_root / "sections/method.tex").exists()
    assert all(item["path"] != "sections/method.tex" for item in manifest["files"])
    assert manifest["runtime_warnings"] == [
        "manifest file is missing: sections/method.tex"
    ]


def test_missing_preview_artifacts_do_not_freeze_runtime_updates(tmp_path: Path) -> None:
    runtime = load_runtime_module()
    default = tmp_path / "default"
    projects = tmp_path / "projects"
    output = tmp_path / "runtime"
    write_project(default, "default-paper")
    (default / "build").mkdir()
    preview_pdf = default / "build/preview.pdf"
    preview_synctex = default / "build/preview.synctex.gz"
    preview_pdf.write_bytes(b"%PDF-1.4\n")
    preview_synctex.write_bytes(b"SyncTeX\n")
    manifest_path = default / "project.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["preview_pdf"] = "build/preview.pdf"
    manifest["preview_synctex"] = "build/preview.synctex.gz"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    projects.mkdir()
    (projects / "index.json").write_text(
        json.dumps({"projects": [{"slug": "default-paper", "source": "default"}]}),
        encoding="utf-8",
    )
    runtime.sync_runtime(default, projects, output)

    preview_pdf.unlink()
    preview_synctex.unlink()
    (default / "main.tex").write_text("latest source", encoding="utf-8")
    runtime.sync_runtime(default, projects, output)

    runtime_manifest = json.loads((output / "project/project.json").read_text())
    assert (output / "project/main.tex").read_text() == "latest source"
    assert "preview_pdf" not in runtime_manifest
    assert "preview_synctex" not in runtime_manifest
    assert runtime_manifest["runtime_warnings"] == [
        "manifest file is missing: build/preview.pdf",
        "manifest file is missing: build/preview.synctex.gz",
    ]


def test_runtime_omits_synctex_without_its_preview_pdf(tmp_path: Path) -> None:
    runtime = load_runtime_module()
    default = tmp_path / "default"
    projects = tmp_path / "projects"
    output = tmp_path / "runtime"
    write_project(default, "default-paper")
    (default / "build").mkdir()
    (default / "build/preview.synctex.gz").write_bytes(b"SyncTeX\n")
    manifest_path = default / "project.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["preview_pdf"] = "build/preview.pdf"
    manifest["preview_synctex"] = "build/preview.synctex.gz"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    projects.mkdir()
    (projects / "index.json").write_text(
        json.dumps({"projects": [{"slug": "default-paper", "source": "default"}]}),
        encoding="utf-8",
    )

    runtime.sync_runtime(default, projects, output)

    runtime_manifest = json.loads((output / "project/project.json").read_text())
    assert "preview_pdf" not in runtime_manifest
    assert "preview_synctex" not in runtime_manifest
    assert not (output / "project/build/preview.synctex.gz").exists()
    assert runtime_manifest["runtime_warnings"] == [
        "manifest file is missing: build/preview.pdf"
    ]


def test_runtime_keeps_preview_pdf_when_only_synctex_is_missing(tmp_path: Path) -> None:
    runtime = load_runtime_module()
    default = tmp_path / "default"
    projects = tmp_path / "projects"
    output = tmp_path / "runtime"
    write_project(default, "default-paper")
    (default / "build").mkdir()
    (default / "build/preview.pdf").write_bytes(b"%PDF-1.4\n")
    manifest_path = default / "project.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["preview_pdf"] = "build/preview.pdf"
    manifest["preview_synctex"] = "build/preview.synctex.gz"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    projects.mkdir()
    (projects / "index.json").write_text(
        json.dumps({"projects": [{"slug": "default-paper", "source": "default"}]}),
        encoding="utf-8",
    )

    runtime.sync_runtime(default, projects, output)

    runtime_manifest = json.loads((output / "project/project.json").read_text())
    assert runtime_manifest["preview_pdf"] == "build/preview.pdf"
    assert "preview_synctex" not in runtime_manifest
    assert (output / "project/build/preview.pdf").is_file()
    assert runtime_manifest["runtime_warnings"] == [
        "manifest file is missing: build/preview.synctex.gz"
    ]


def test_runtime_rejects_duplicate_catalog_slugs(tmp_path: Path) -> None:
    runtime = load_runtime_module()
    catalog = tmp_path / "index.json"
    catalog.write_text(
        json.dumps({"projects": [{"slug": "duplicate"}, {"slug": "duplicate"}]}),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="duplicate slugs"):
        runtime.catalog_projects(catalog)


def test_runtime_auto_includes_only_referenced_files_from_opted_in_roots(
    tmp_path: Path,
) -> None:
    runtime = load_runtime_module()
    default = tmp_path / "default"
    projects = tmp_path / "projects"
    output = tmp_path / "runtime"
    write_project(default, "default-paper")
    (default / "Figures").mkdir()
    (default / "generated").mkdir()
    (default / "Figures/plot.pdf").write_bytes(b"%PDF-1.4\n%%EOF\n")
    (default / "Figures/private.pdf").write_bytes(b"%PDF-1.4\nprivate\n%%EOF\n")
    (default / "generated/results.tex").write_text(
        "\\input{generated/nested}\nresults",
        encoding="utf-8",
    )
    (default / "generated/nested.tex").write_text("nested", encoding="utf-8")
    (default / "main.tex").write_text(
        "\\input{generated/results}\n"
        "\\includegraphics{Figures/plot.pdf}\n"
        "\\includegraphics{Figures/missing-upload.png}\n",
        encoding="utf-8",
    )
    manifest_path = default / "project.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["auto_include_roots"] = ["Figures", "generated"]
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    projects.mkdir()
    (projects / "index.json").write_text(
        json.dumps({"projects": [{"slug": "default-paper", "source": "default"}]}),
        encoding="utf-8",
    )

    runtime.sync_runtime(default, projects, output)

    runtime_root = output / "project"
    assert (runtime_root / "Figures/plot.pdf").is_file()
    assert (runtime_root / "generated/results.tex").is_file()
    assert (runtime_root / "generated/nested.tex").is_file()
    assert not (runtime_root / "Figures/private.pdf").exists()
    assert not (runtime_root / "private-draft.tex").exists()
    runtime_manifest = json.loads((runtime_root / "project.json").read_text())
    entries = {item["path"]: item for item in runtime_manifest["files"]}
    assert entries["Figures/plot.pdf"]["type"] == "asset"
    assert entries["generated/results.tex"]["managed"] is True
    assert entries["generated/nested.tex"]["managed"] is True


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
