#!/usr/bin/env python3
"""Freeze resolved Compose JSON and image IDs without contacting Docker."""

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import sys

COMPOSE_FILE = "runtime.compose.json"
MANIFEST_FILE = "manifest.json"
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")


def reject_symlinks(path: Path) -> None:
    for component in (path.absolute(), *path.absolute().parents):
        if component.is_symlink():
            raise ValueError("symlink paths are not supported")


def read_object(path: Path) -> dict:
    reject_symlinks(path)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError) as from_error:
        raise ValueError("input must contain valid UTF-8 JSON") from from_error
    if not isinstance(value, dict):
        raise ValueError("input JSON must be an object")
    return value


def escape_dollars(value):
    """Keep config's existing $$ escapes; escape any remaining single dollars.

    Default `docker compose config --format json` already escapes literal dollars.
    Preserving pairs makes that representation survive one more Compose parse.
    """
    if isinstance(value, str):
        return re.sub(r"\$+", lambda m: m[0] + "$" * (len(m[0]) % 2), value)
    if isinstance(value, list):
        return [escape_dollars(item) for item in value]
    if isinstance(value, dict):
        return {key: escape_dollars(item) for key, item in value.items()}
    return value


def runtime_config(compose: dict, images: dict) -> dict:
    services = compose.get("services")
    if not isinstance(services, dict) or not services:
        raise ValueError("resolved Compose must contain services")
    if set(images) != set(services):
        raise ValueError("image mapping must match every Compose service exactly")
    if any(not isinstance(value, str) or not IMAGE_ID.fullmatch(value)
           for value in images.values()):
        raise ValueError("every image must be a sha256 image ID with 64 lowercase hex digits")
    volumes = compose.get("volumes", {})
    if not isinstance(volumes, dict):
        raise ValueError("resolved Compose volumes must be an object")
    for volume in volumes.values():
        if not isinstance(volume, dict) or not isinstance(volume.get("name"), str) or not volume["name"]:
            raise ValueError("every volume must have an explicit resolved name")

    frozen = copy.deepcopy(compose)
    for name, service in frozen["services"].items():
        if not isinstance(service, dict):
            raise ValueError("every Compose service must be an object")
        mounts = service.get("volumes", [])
        if not isinstance(mounts, list):
            raise ValueError("resolved service volumes must be a list")
        for mount in mounts:
            if not isinstance(mount, dict):
                raise ValueError("mounts must use resolved long syntax")
            source = mount.get("source")
            if mount.get("type") == "bind" and (
                not isinstance(source, str) or not Path(source).is_absolute()
            ):
                raise ValueError("bind sources must be absolute paths")
            if mount.get("type") == "volume" and (
                not isinstance(source, str) or source not in volumes
            ):
                raise ValueError("volume mounts must reference explicitly named volumes")
        service.pop("build", None)
        service["image"] = images[name]
    if "volumes" in frozen:
        frozen["volumes"] = {
            key: {"name": volume["name"], "external": True}
            for key, volume in volumes.items()
        }
    return escape_dollars(frozen)


def json_bytes(value: dict) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")


def write_new(path: Path, content: bytes, mode: int) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(descriptor, "wb") as stream:
        os.fchmod(stream.fileno(), mode)
        stream.write(content)


def freeze_release(compose_path: Path, images_path: Path, output: Path) -> dict:
    reject_symlinks(output)
    if output.exists():
        raise ValueError("output directory must not already exist")
    images = read_object(images_path)
    content = json_bytes(runtime_config(read_object(compose_path), images))
    manifest = {"image_ids": images, "compose_sha256": hashlib.sha256(content).hexdigest()}
    output.mkdir(mode=0o700)
    try:
        output.chmod(0o700)
        write_new(output / COMPOSE_FILE, content, 0o600)
        write_new(output / MANIFEST_FILE, json_bytes(manifest), 0o644)
    except BaseException:
        for name in (COMPOSE_FILE, MANIFEST_FILE):
            (output / name).unlink(missing_ok=True)
        output.rmdir()
        raise
    return {"compose": str(output / COMPOSE_FILE), "manifest": str(output / MANIFEST_FILE),
            "services": len(images)}


def verify_release(output: Path) -> dict:
    """Check file integrity and image pins; this does not authenticate a release."""
    manifest = read_object(output / MANIFEST_FILE)
    if set(manifest) != {"image_ids", "compose_sha256"}:
        raise ValueError("invalid release manifest fields")
    compose_path = output / COMPOSE_FILE
    compose = read_object(compose_path)
    if hashlib.sha256(compose_path.read_bytes()).hexdigest() != manifest["compose_sha256"]:
        raise ValueError("release Compose hash mismatch")
    images = manifest["image_ids"]
    if not isinstance(images, dict):
        raise ValueError("invalid release image mapping")
    if runtime_config(compose, images) != compose:
        raise ValueError("release Compose is not frozen")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compose", type=Path, required=True, help="default resolved Compose JSON")
    parser.add_argument("--images", type=Path, required=True, help="service to sha256 image ID JSON")
    parser.add_argument("--output", type=Path, required=True, help="new private release directory")
    args = parser.parse_args()
    try:
        summary = freeze_release(args.compose, args.images, args.output)
    except (OSError, ValueError):
        # Input contents and environment values must never reach the terminal.
        print("Unable to freeze release: check input JSON, image IDs, mount paths and new output path.", file=sys.stderr)
        return 1
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
