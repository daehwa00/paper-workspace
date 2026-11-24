"""Runtime releases need no daemon, credentials, or production data to test."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/paper_platform/freeze_runtime_release.py"
SPEC = importlib.util.spec_from_file_location("freeze_runtime_release", SCRIPT)
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
IMAGE = "sha256:" + "a" * 64


def compose():
    return {
        "name": "release-test",
        "services": {
            "web": {
                "build": {"context": "/old/source", "dockerfile": "Dockerfile"},
                "image": "mutable:latest", "command": ["echo", "literal"],
                "environment": {"SECRET": "private-value"},
                "ports": [{"target": 80, "published": "8080", "protocol": "tcp"}],
                "networks": {"internal": None},
                "depends_on": {"db": {"condition": "service_started", "required": True}},
                "volumes": [
                    {"type": "bind", "source": "/srv/release", "target": "/app", "read_only": True},
                    {"type": "volume", "source": "data", "target": "/data", "volume": {"nocopy": True}},
                ],
            },
            "db": {"image": "database:latest", "networks": {"internal": None}},
        },
        "networks": {"internal": {"name": "existing_internal", "internal": True}},
        "volumes": {"data": {"name": "existing_data", "driver": "local", "labels": {"old": "label"}}},
    }


def inputs(tmp_path, value=None, images=None):
    config_path = tmp_path / "resolved.json"
    images_path = tmp_path / "images.json"
    config_path.write_text(json.dumps(compose() if value is None else value))
    images_path.write_text(json.dumps({"web": IMAGE, "db": IMAGE} if images is None else images))
    return config_path, images_path, tmp_path / "release"


def test_freeze_preserves_runtime_fields_and_uses_external_named_volumes(tmp_path):
    original = compose()
    paths = inputs(tmp_path, original)
    summary = release.freeze_release(*paths)
    frozen = json.loads((paths[2] / release.COMPOSE_FILE).read_text())
    expected = copy.deepcopy(original)
    expected["services"]["web"].pop("build")
    for service in expected["services"].values():
        service["image"] = IMAGE
    expected["volumes"]["data"] = {"name": "existing_data", "external": True}
    assert frozen == expected
    assert original == compose()
    assert summary["services"] == 2
    manifest = release.verify_release(paths[2])
    assert set(manifest) == {"image_ids", "compose_sha256"}
    assert "private-value" not in json.dumps(manifest)
    for path, mode in ((paths[2], 0o700), (paths[2] / release.COMPOSE_FILE, 0o600),
                       (paths[2] / release.MANIFEST_FILE, 0o644)):
        assert stat.S_IMODE(path.stat().st_mode) == mode


@pytest.mark.parametrize("kind", ["missing_image", "extra_image", "invalid_id", "relative_bind",
                                    "unnamed_volume", "anonymous_mount", "unknown_volume", "short_mount",
                                    "no_services", "invalid_service", "invalid_volumes"])
def test_invalid_inputs_leave_no_output(tmp_path, kind):
    value = compose()
    images = {"web": IMAGE, "db": IMAGE}
    if kind == "missing_image":
        images.pop("db")
    elif kind == "extra_image":
        images["extra"] = IMAGE
    elif kind == "invalid_id":
        images["web"] = "mutable:latest"
    elif kind == "relative_bind":
        value["services"]["web"]["volumes"][0]["source"] = "./relative"
    elif kind == "unnamed_volume":
        value["volumes"]["data"].pop("name")
    elif kind in ("anonymous_mount", "unknown_volume"):
        value["services"]["web"]["volumes"][1]["source"] = None if kind == "anonymous_mount" else "other"
    elif kind == "short_mount":
        value["services"]["web"]["volumes"] = ["/data"]
    elif kind == "no_services":
        value["services"] = {}
    elif kind == "invalid_service":
        value["services"]["web"] = []
    elif kind == "invalid_volumes":
        value["volumes"] = []
    paths = inputs(tmp_path, value, images)
    with pytest.raises(ValueError):
        release.freeze_release(*paths)
    assert not paths[2].exists()


@pytest.mark.parametrize("kind", ["directory", "file", "symlink", "dangling_symlink", "parent_symlink", "input_symlink"])
def test_existing_output_and_symlinks_are_refused(tmp_path, kind):
    config, images, output = inputs(tmp_path)
    if kind == "directory":
        output.mkdir()
    elif kind == "file":
        output.write_text("keep")
    elif kind in ("symlink", "dangling_symlink"):
        output.symlink_to(config if kind == "symlink" else tmp_path / "absent")
    elif kind == "parent_symlink":
        parent = tmp_path / "linked"
        parent.symlink_to(tmp_path, target_is_directory=True)
        output = parent / "release"
    else:
        link = tmp_path / "linked.json"
        link.symlink_to(config)
        config = link
    with pytest.raises(ValueError):
        release.freeze_release(config, images, output)
    assert not (output / release.COMPOSE_FILE).exists()
    if kind == "file":
        assert output.read_text() == "keep"


def test_failed_write_cleans_up_new_directory(tmp_path, monkeypatch):
    paths = inputs(tmp_path)
    write = release.write_new

    def fail_manifest(path, content, mode):
        if path.name == release.MANIFEST_FILE:
            raise OSError("simulated disk failure")
        write(path, content, mode)

    monkeypatch.setattr(release, "write_new", fail_manifest)
    with pytest.raises(OSError):
        release.freeze_release(*paths)
    assert not paths[2].exists()


def test_manifest_detects_tampering(tmp_path):
    paths = inputs(tmp_path)
    release.freeze_release(*paths)
    path = paths[2] / release.COMPOSE_FILE
    path.write_text(path.read_text() + " ")
    with pytest.raises(ValueError, match="hash mismatch"):
        release.verify_release(paths[2])


@pytest.mark.parametrize("bad_input", ["{private-value", "[]", "\udcff"])
def test_cli_errors_do_not_leak_input(tmp_path, bad_input):
    config, images, output = inputs(tmp_path)
    config.write_bytes(bad_input.encode("utf-8", errors="surrogateescape"))
    result = subprocess.run([sys.executable, str(SCRIPT), "--compose", str(config),
                             "--images", str(images), "--output", str(output)], capture_output=True, text=True)
    assert result.returncode == 1
    assert result.stdout == ""
    assert "private-value" not in result.stderr
    assert "Traceback" not in result.stderr
    assert not output.exists()


def test_cli_outputs_only_paths_and_service_count(tmp_path):
    config, images, output = inputs(tmp_path)
    result = subprocess.run([sys.executable, str(SCRIPT), "--compose", str(config),
                             "--images", str(images), "--output", str(output)], capture_output=True, text=True, check=True)
    assert json.loads(result.stdout) == {"compose": str(output / release.COMPOSE_FILE),
                                        "manifest": str(output / release.MANIFEST_FILE), "services": 2}
    assert result.stderr == ""


def test_single_dollars_are_escaped_and_existing_pairs_remain_stable():
    assert release.escape_dollars(["$TOKEN", "$$TOKEN", "$$$TOKEN", "$$$$TOKEN", "${TOKEN}", "$5"]) == [
        "$$TOKEN", "$$TOKEN", "$$$$TOKEN", "$$$$TOKEN", "$${TOKEN}", "$$5",
    ]


def test_real_compose_resolved_dollar_roundtrip(tmp_path):
    docker = shutil.which("docker")
    if docker is None or subprocess.run([docker, "compose", "version"], capture_output=True).returncode:
        pytest.skip("Docker Compose is not installed")
    env_file = tmp_path / "empty.env"
    env_file.touch()
    source = tmp_path / "source.json"
    values = ["$$TOKEN", "$$$$TOKEN", "$${TOKEN}", "cost $$5", "trailing $$", "plain"]
    source.write_text(json.dumps({"name": "release-dollar-test", "services": {"app": {
        "image": "busybox", "command": ["echo", *values],
        "environment": {f"VALUE_{index}": value for index, value in enumerate(values)},
        "healthcheck": {"test": ["CMD-SHELL", "test -n \"$$TOKEN\""]},
    }}}))
    env = dict(os.environ, TOKEN="must-not-expand")

    def resolved(path, *options):
        result = subprocess.run([docker, "compose", "--env-file", str(env_file), "-f", str(path),
                                 "config", "--format", "json", *options],
                                env=env, capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    original = resolved(source)
    config, images, output = inputs(tmp_path, original, {"app": IMAGE})
    release.freeze_release(config, images, output)
    expected = copy.deepcopy(original)
    expected["services"]["app"]["image"] = IMAGE
    assert resolved(output / release.COMPOSE_FILE) == expected
    assert "must-not-expand" not in json.dumps(expected)
    # --no-interpolate exposes exactly what a subsequent Compose parser reads.
    assert resolved(output / release.COMPOSE_FILE, "--no-interpolate")["services"]["app"]["environment"] == original["services"]["app"]["environment"]
