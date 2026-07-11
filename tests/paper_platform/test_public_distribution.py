import json
from pathlib import Path


ROOT = Path(__file__).parents[2]


def test_runtime_is_project_agnostic() -> None:
    compose = (ROOT / "infra/paper-workspace/compose.yaml").read_text(encoding="utf-8")
    web_image = (ROOT / "infra/paper-workspace/Dockerfile").read_text(encoding="utf-8")
    compiler_image = (ROOT / "apps/paper_workspace/compiler/Dockerfile").read_text(encoding="utf-8")
    compiler = (ROOT / "apps/paper_workspace/compiler/server.py").read_text(encoding="utf-8")

    assert "PAPER_PROJECT_DIR" in compose
    assert "../../paper/" not in compose
    assert "paper/vendor" not in web_image
    assert "paper/" not in compiler_image
    assert "KIT =" not in compiler
    assert "aaai2027" not in compiler


def test_example_project_has_a_manifest_and_no_conference_assets() -> None:
    example = ROOT / "examples/paper-workspace-project"
    manifest = json.loads((example / "project.json").read_text(encoding="utf-8"))

    assert manifest["entrypoint"] == "main.tex"
    assert {item["path"] for item in manifest["files"]} >= {"main.tex", "references.bib"}
    assert (example / "main.tex").is_file()
    assert not any("aaai" in path.name.lower() for path in example.rglob("*"))


def test_publication_files_explain_safe_export_and_secret_handling() -> None:
    documentation_root = ROOT / "apps/paper_workspace" if (ROOT / "apps/paper_workspace/README.md").exists() else ROOT
    readme = (documentation_root / "README.md").read_text(encoding="utf-8")
    notices = (documentation_root / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
    env_example = (ROOT / "infra/paper-workspace/.env.example").read_text(encoding="utf-8")

    for heading in ("빠른 시작", "내 논문 연결", "Codex 연결", "외부 공개", "문제 해결"):
        assert heading in readme
    assert "auth.json" in readme
    assert "커밋" in readme
    assert "PDF.js" in notices
    assert "CODEX_BRIDGE_TOKEN" in env_example
    assert "PAPER_PROJECT_DIR" in env_example
    assert "/home/qlab" not in env_example


def test_public_export_is_allowlist_based() -> None:
    exporter = (ROOT / "scripts/paper_platform/export_public_workspace.py").read_text(encoding="utf-8")

    assert "PUBLIC_PATHS" in exporter
    assert "paper/" not in exporter
    assert "auth.json" in exporter
    assert "secret" in exporter.lower()
