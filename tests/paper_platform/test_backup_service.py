from __future__ import annotations

import importlib.util
import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]
SERVER_PATH = ROOT / "apps/paper_workspace/backup/server.py"
PNG_BYTES = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"


def load_backup_module():
    spec = importlib.util.spec_from_file_location("paper_backup_server", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def snapshot_payload(text: str = "hello") -> dict[str, object]:
    return {
        "title": "Example paper",
        "files": {"main.tex": text, "sections/method.tex": "Method"},
        "comments": [{"id": "c1", "text": "Check this claim"}],
    }


def test_snapshot_round_trip_and_hash_deduplication(tmp_path: Path) -> None:
    backup = load_backup_module()
    store = backup.BackupStore(tmp_path / "backups.sqlite3", retention=50)

    first, first_deduplicated = store.create("paper-one", snapshot_payload(), "Dae", "interval")
    second, second_deduplicated = store.create("paper-one", snapshot_payload(), "Dae", "interval")

    assert first_deduplicated is False
    assert second_deduplicated is True
    assert second["id"] == first["id"]
    assert second["checked_at"] >= first["checked_at"]
    assert store.list("paper-one") == [second]
    restored = store.get("paper-one", first["id"])
    assert restored["payload"] == snapshot_payload()


def test_retention_keeps_latest_snapshots_per_project(tmp_path: Path) -> None:
    backup = load_backup_module()
    store = backup.BackupStore(tmp_path / "backups.sqlite3", retention=3)
    created = [store.create("paper-one", snapshot_payload(str(index)), None, "interval")[0] for index in range(5)]
    store.create("paper-two", snapshot_payload("other"), None, "manual")

    retained = store.list("paper-one")
    assert [item["id"] for item in retained] == [created[4]["id"], created[3]["id"], created[2]["id"]]
    with pytest.raises(backup.SnapshotNotFound):
        store.get("paper-one", created[0]["id"])
    assert len(store.list("paper-two")) == 1


@pytest.mark.parametrize("project_id", ["", "../paper", "paper/name", "a" * 65, "space name"])
def test_project_id_validation_rejects_unsafe_values(project_id: str) -> None:
    backup = load_backup_module()
    with pytest.raises(backup.ValidationError):
        backup.validate_project_id(project_id)


@pytest.mark.parametrize("path", ["../main.tex", "/main.tex", "paper//main.tex", "paper/./main.tex", "bad\\name.tex"])
def test_snapshot_validation_rejects_unsafe_file_paths(path: str) -> None:
    backup = load_backup_module()
    payload = snapshot_payload()
    payload["files"] = {path: "content"}
    with pytest.raises(backup.ValidationError):
        backup.canonical_snapshot(payload)


def test_snapshot_validation_rejects_oversized_or_invalid_content(monkeypatch: pytest.MonkeyPatch) -> None:
    backup = load_backup_module()
    monkeypatch.setattr(backup, "MAX_SNAPSHOT_BYTES", 100)
    with pytest.raises(backup.ValidationError, match="too large"):
        backup.canonical_snapshot(snapshot_payload("x" * 200))
    with pytest.raises(backup.ValidationError, match="files"):
        backup.canonical_snapshot({"title": "No files", "files": []})
    with pytest.raises(backup.ValidationError, match="strings"):
        backup.canonical_snapshot({"files": {"main.tex": object()}})


def test_database_contains_canonical_json_not_pickle(tmp_path: Path) -> None:
    backup = load_backup_module()
    store = backup.BackupStore(tmp_path / "backups.sqlite3")
    metadata, _ = store.create("paper-one", snapshot_payload(), None, None)
    restored = store.get("paper-one", metadata["id"])
    assert json.dumps(restored["payload"], sort_keys=True)


def test_project_activity_tracks_latest_server_time_and_actor(tmp_path: Path) -> None:
    backup = load_backup_module()
    store = backup.BackupStore(tmp_path / "backups.sqlite3")
    store.create("paper-with-snapshot", snapshot_payload(), "Snapshot Author", "auto")

    first = store.record_activity("paper-one", "Dae", "edit")
    second = store.record_activity("paper-one", "KDH", "codex")
    activity = {item["project_id"]: item for item in store.list_activity()}

    assert second["modified_at"] >= first["modified_at"]
    assert activity["paper-one"]["actor"] == "KDH"
    assert activity["paper-one"]["reason"] == "codex"
    assert activity["paper-with-snapshot"]["actor"] == "Snapshot Author"
    with pytest.raises(backup.ValidationError, match="actor"):
        store.record_activity("paper-one", "", "edit")


def test_snapshot_export_is_written_for_external_copy(tmp_path: Path) -> None:
    backup = load_backup_module()
    export_dir = tmp_path / "exports"
    store = backup.BackupStore(tmp_path / "backups.sqlite3", export_dir=export_dir)
    store.create("paper-one", snapshot_payload(), None, "manual")
    exported = list((export_dir / "paper-one").glob("*.json.zlib"))
    assert len(exported) == 1
    assert json.loads(backup.zlib.decompress(exported[0].read_bytes())) == snapshot_payload()


def test_asset_store_round_trip_quota_and_paths(tmp_path: Path) -> None:
    backup = load_backup_module()
    store = backup.AssetStore(tmp_path / "assets", max_file_bytes=20, max_project_bytes=24)
    assert store.put("paper-one", "figures/a.png", PNG_BYTES)["size_bytes"] == len(PNG_BYTES)
    assert store.get("paper-one", "figures/a.png") == PNG_BYTES
    listed = store.list("paper-one")
    assert listed[0]["path"] == "figures/a.png"
    assert listed[0]["size_bytes"] == len(PNG_BYTES)
    assert listed[0]["modified_at"].endswith("Z")
    with pytest.raises(backup.ValidationError, match="quota"):
        store.put("paper-one", "figures/b.png", PNG_BYTES)
    with pytest.raises(backup.ValidationError, match="path"):
        store.put("paper-one", "../escape.png", PNG_BYTES)
    store.delete("paper-one", "figures/a.png")
    with pytest.raises(backup.SnapshotNotFound):
        store.get("paper-one", "figures/a.png")


@pytest.mark.parametrize(
    ("name", "content", "mime_type"),
    [
        ("paper.pdf", b"%PDF-1.7\n", "application/pdf"),
        ("figure.png", PNG_BYTES, "image/png"),
        ("photo.jpg", b"\xff\xd8\xff\xe0jpeg", "image/jpeg"),
        ("photo.jpeg", b"\xff\xd8\xff\xe1jpeg", "image/jpeg"),
        ("plot.eps", b"%!PS-Adobe-3.0 EPSF-3.0\n", "application/postscript"),
        ("preview.synctex.gz", b"\x1f\x8b\x08\x00", "application/gzip"),
    ],
)
def test_asset_validation_allows_expected_formats(
    name: str, content: bytes, mime_type: str
) -> None:
    backup = load_backup_module()
    assert backup.validate_asset_content(name, content) == mime_type


@pytest.mark.parametrize(
    ("name", "content", "message"),
    [
        ("payload.html", b"<script>alert(1)</script>", "not allowed"),
        ("payload.svg", b"<svg onload='alert(1)'>", "not allowed"),
        ("payload.xml", b"<?xml version='1.0'?><x/>", "not allowed"),
        ("payload.png", b"<script>alert(1)</script>", "does not match"),
        ("payload.pdf", b"not a pdf", "does not match"),
        ("payload.synctex.gz", b"not gzip", "does not match"),
    ],
)
def test_asset_validation_rejects_active_or_mismatched_content(
    name: str, content: bytes, message: str
) -> None:
    backup = load_backup_module()
    with pytest.raises(backup.ValidationError, match=message):
        backup.validate_asset_content(name, content)


def test_http_api_creates_lists_and_restores_snapshots(tmp_path: Path) -> None:
    backup = load_backup_module()
    backup.BackupHandler.store = backup.BackupStore(tmp_path / "backups.sqlite3")
    backup.BackupHandler.assets = backup.AssetStore(tmp_path / "assets")
    server = ThreadingHTTPServer(("127.0.0.1", 0), backup.BackupHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        with urllib.request.urlopen(f"{base}/health") as response:
            assert json.load(response) == {"status": "ok"}
        request = urllib.request.Request(
            f"{base}/projects/paper-one/snapshots",
            data=json.dumps(
                {"snapshot": snapshot_payload(), "actor": "Dae", "reason": "interval"}
            ).encode(),
            headers={"Content-Type": "application/json", "X-Paper-Actor": "Forged actor"},
            method="POST",
        )
        with urllib.request.urlopen(request) as response:
            created = json.load(response)
            assert response.status == 201
            assert created["snapshot"]["actor"] == "Shared user"
        snapshot_id = created["snapshot"]["id"]
        with urllib.request.urlopen(f"{base}/projects/paper-one/snapshots") as response:
            assert json.load(response)["snapshots"][0]["id"] == snapshot_id
        with urllib.request.urlopen(f"{base}/projects/paper-one/snapshots/{snapshot_id}") as response:
            assert json.load(response)["snapshot"]["payload"] == snapshot_payload()
        activity_request = urllib.request.Request(
            f"{base}/projects/paper-one/activity",
            data=json.dumps({"actor": "KDH", "reason": "edit"}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(activity_request) as response:
            assert json.load(response)["activity"]["actor"] == "Shared user"
        with urllib.request.urlopen(f"{base}/activity") as response:
            assert json.load(response)["projects"][0]["project_id"] == "paper-one"
        asset_request = urllib.request.Request(
            f"{base}/projects/paper-one/assets/figures%2Fplot.png", data=PNG_BYTES, method="PUT"
        )
        with urllib.request.urlopen(asset_request) as response:
            assert json.load(response)["asset"]["path"] == "figures/plot.png"
        with urllib.request.urlopen(f"{base}/projects/paper-one/assets") as response:
            assert json.load(response)["assets"][0]["size_bytes"] == len(PNG_BYTES)
        asset_url = f"{base}/projects/paper-one/assets/figures%2Fplot.png"
        with urllib.request.urlopen(asset_url) as response:
            assert response.read() == PNG_BYTES
            assert response.headers["Content-Type"] == "image/png"
            assert response.headers["Content-Disposition"].startswith("attachment;")
            assert response.headers["X-Content-Type-Options"] == "nosniff"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_http_api_rejects_active_assets_and_serves_legacy_files_as_downloads(
    tmp_path: Path,
) -> None:
    backup = load_backup_module()
    backup.BackupHandler.store = backup.BackupStore(tmp_path / "backups.sqlite3")
    backup.BackupHandler.assets = backup.AssetStore(tmp_path / "assets")
    backup.BackupHandler.actor_mode = "shared"
    server = ThreadingHTTPServer(("127.0.0.1", 0), backup.BackupHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        request = urllib.request.Request(
            f"{base}/projects/paper-one/assets/payload.html",
            data=b"<script>alert(1)</script>",
            method="PUT",
        )
        with pytest.raises(urllib.error.HTTPError) as rejected:
            urllib.request.urlopen(request)
        assert rejected.value.code == 400

        legacy = tmp_path / "assets/paper-one/legacy.html"
        legacy.parent.mkdir(parents=True, exist_ok=True)
        legacy.write_bytes(b"<script>alert(1)</script>")
        with urllib.request.urlopen(f"{base}/projects/paper-one/assets/legacy.html") as response:
            assert response.headers["Content-Type"] == "application/octet-stream"
            assert response.headers["Content-Disposition"].startswith("attachment;")
            assert response.headers["X-Content-Type-Options"] == "nosniff"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_proxy_actor_mode_requires_trusted_header_and_ignores_body_actor(tmp_path: Path) -> None:
    backup = load_backup_module()
    backup.BackupHandler.store = backup.BackupStore(tmp_path / "backups.sqlite3")
    backup.BackupHandler.assets = backup.AssetStore(tmp_path / "assets")
    backup.BackupHandler.actor_mode = "proxy"
    server = ThreadingHTTPServer(("127.0.0.1", 0), backup.BackupHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        body = json.dumps({"actor": "Forged browser actor", "reason": "edit"}).encode()
        missing_header = urllib.request.Request(
            f"{base}/projects/paper-one/activity",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with pytest.raises(urllib.error.HTTPError) as rejected:
            urllib.request.urlopen(missing_header)
        assert rejected.value.code == 400

        trusted = urllib.request.Request(
            f"{base}/projects/paper-one/activity",
            data=body,
            headers={"Content-Type": "application/json", "X-Paper-Actor": "verified@example.org"},
            method="POST",
        )
        with urllib.request.urlopen(trusted) as response:
            assert json.load(response)["activity"]["actor"] == "verified@example.org"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        backup.BackupHandler.actor_mode = "shared"
