from __future__ import annotations

import importlib.util
import json
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest


ROOT = Path(__file__).parents[2]
SERVER_PATH = ROOT / "apps/paper_workspace/backup/server.py"


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
    assert store.list("paper-one") == [first]
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


def test_http_api_creates_lists_and_restores_snapshots(tmp_path: Path) -> None:
    backup = load_backup_module()
    backup.BackupHandler.store = backup.BackupStore(tmp_path / "backups.sqlite3")
    server = ThreadingHTTPServer(("127.0.0.1", 0), backup.BackupHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        with urllib.request.urlopen(f"{base}/health") as response:
            assert json.load(response) == {"status": "ok"}
        request = urllib.request.Request(
            f"{base}/projects/paper-one/snapshots",
            data=json.dumps({"snapshot": snapshot_payload(), "actor": "Dae", "reason": "interval"}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request) as response:
            created = json.load(response)
            assert response.status == 201
        snapshot_id = created["snapshot"]["id"]
        with urllib.request.urlopen(f"{base}/projects/paper-one/snapshots") as response:
            assert json.load(response)["snapshots"][0]["id"] == snapshot_id
        with urllib.request.urlopen(f"{base}/projects/paper-one/snapshots/{snapshot_id}") as response:
            assert json.load(response)["snapshot"]["payload"] == snapshot_payload()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
