import importlib.util
import json
import os
from pathlib import Path


ROOT = Path(__file__).parents[2]
MODULE_PATH = ROOT / "scripts/paper_platform/generate_project_thumbnails.py"
SPEC = importlib.util.spec_from_file_location("generate_project_thumbnails", MODULE_PATH)
assert SPEC and SPEC.loader
THUMBNAILS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(THUMBNAILS)


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_missing_catalog_thumbnail_is_generated_from_default_project_pdf(tmp_path: Path) -> None:
    catalog = tmp_path / "projects/index.json"
    default_project = tmp_path / "paper"
    output = tmp_path / "output"
    write_json(catalog, {"projects": [{"slug": "default-paper", "source": "default"}]})
    write_json(default_project / "project.json", {"entrypoint": "main.tex"})
    pdf = default_project / "build/main.pdf"
    pdf.parent.mkdir(parents=True)
    pdf.write_bytes(b"%PDF-1.4\n")

    rendered_sources: list[Path] = []

    def render(source: Path, destination: Path) -> None:
        rendered_sources.append(source)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"\x89PNG\r\n\x1a\n")

    assert THUMBNAILS.scan_projects(catalog, default_project, catalog.parent, output, render) == ["default-paper"]
    assert rendered_sources == [pdf]
    assert (output / "default-paper/thumbnail.png").read_bytes().startswith(b"\x89PNG")
    assert THUMBNAILS.scan_projects(catalog, default_project, catalog.parent, output, render) == []

    pdf.write_bytes(b"%PDF-1.4\nupdated")
    os.utime(pdf, None)
    assert THUMBNAILS.scan_projects(catalog, default_project, catalog.parent, output, render) == ["default-paper"]


def test_explicit_static_thumbnail_is_left_untouched(tmp_path: Path) -> None:
    catalog = tmp_path / "projects/index.json"
    project = tmp_path / "projects/example-paper"
    write_json(catalog, {"projects": [{
        "slug": "example-paper",
        "thumbnail": "/projects/example-paper/thumbnail.png",
    }]})
    write_json(project / "project.json", {"entrypoint": "main.tex"})
    (project / "main.pdf").write_bytes(b"%PDF-1.4\n")

    def fail_if_called(_source: Path, _destination: Path) -> None:
        raise AssertionError("explicit thumbnails must not be regenerated")

    assert THUMBNAILS.scan_projects(catalog, tmp_path / "paper", catalog.parent, tmp_path / "output", fail_if_called) == []


def test_standard_submission_pdf_is_preferred_to_a_stale_main_preview(tmp_path: Path) -> None:
    project = tmp_path / "paper"
    write_json(project / "project.json", {"entrypoint": "main.tex"})
    stale = project / "build/main.pdf"
    current = project / "build/submission/submission.pdf"
    stale.parent.mkdir(parents=True)
    current.parent.mkdir(parents=True)
    stale.write_bytes(b"%PDF stale\n")
    current.write_bytes(b"%PDF current\n")

    assert THUMBNAILS.resolve_project_pdf(project) == current


def test_one_broken_pdf_does_not_block_other_project_thumbnails(tmp_path: Path) -> None:
    catalog = tmp_path / "projects/index.json"
    write_json(catalog, {"projects": [{"slug": "broken"}, {"slug": "healthy"}]})
    for slug in ("broken", "healthy"):
        project = catalog.parent / slug
        write_json(project / "project.json", {"entrypoint": "main.tex"})
        (project / "main.pdf").write_bytes(f"%PDF {slug}\n".encode())

    def render(source: Path, destination: Path) -> None:
        if source.parent.name == "broken":
            raise RuntimeError("invalid PDF")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"\x89PNG\r\n\x1a\n")

    updated = THUMBNAILS.scan_projects(catalog, tmp_path / "paper", catalog.parent, tmp_path / "output", render)

    assert updated == ["healthy"]
    assert (tmp_path / "output/healthy/thumbnail.png").is_file()
