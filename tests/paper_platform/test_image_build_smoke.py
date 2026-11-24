"""Run the production image's shell guard, including grep's error path."""
from pathlib import Path
import os
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[2]
GUARD = ROOT / "scripts/paper_platform/verify_static_tokens.sh"


@pytest.mark.parametrize("token", ["", "__UNKNOWN_ASSET_HASH__", "__FAVICON_DATA__"])
def test_static_token_guard(tmp_path, token):
    page = tmp_path / "index.html"
    page.write_text("<html>" + token + "</html>")
    result = subprocess.run(["sh", str(GUARD), str(page)], capture_output=True)
    assert result.returncode == (1 if token else 0)


def test_static_token_guard_rejects_missing_file(tmp_path):
    result = subprocess.run(["sh", str(GUARD), str(tmp_path / "missing.html")], capture_output=True)
    assert result.returncode == 2


def test_static_token_guard_rejects_grep_error(tmp_path):
    grep = tmp_path / "grep"
    grep.write_text("#!/bin/sh\nexit 2\n")
    grep.chmod(0o755)
    result = subprocess.run(["/bin/sh", str(GUARD), str(tmp_path / "index.html")],
                            env={**os.environ, "PATH": str(tmp_path)}, capture_output=True)
    assert result.returncode == 2


def test_static_image_excludes_editor_backups():
    dockerfile = (ROOT / "infra/paper-workspace/Dockerfile").read_text()
    copies = [line for line in dockerfile.splitlines() if "apps/paper_workspace/static" in line]
    assert len(copies) == 3
    assert "apps/paper_workspace/static/*.js" in copies[0]
    assert "apps/paper_workspace/static/*.css" in copies[0]
    assert all("--exclude=*.orig" in line for line in copies[1:])
    assert not (ROOT / "apps/paper_workspace/static/bootstrap.js.orig").exists()
    assert not (ROOT / "apps/paper_workspace/static/project-frame.css.orig").exists()
