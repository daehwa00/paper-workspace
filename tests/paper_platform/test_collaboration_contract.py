from pathlib import Path

ROOT = Path(__file__).parents[2]


def test_collaboration_contract_covers_requested_workflows() -> None:
    contract = (ROOT / "docs/paper-platform/collaboration-contract.md").read_text(encoding="utf-8")
    client = (ROOT / "apps/paper_workspace/collaboration/client.js").read_text(encoding="utf-8")
    compose = (ROOT / "infra/paper-workspace/compose.yaml").read_text(encoding="utf-8")
    package = (ROOT / "apps/paper_workspace/collaboration/package.json").read_text(encoding="utf-8")
    for feature in ("Yjs", "Y.Text", "IndexedDB", "LevelDB", "relative cursor"):
        assert feature in contract
    assert "new Y.Doc()" in client
    assert "IndexeddbPersistence" in client
    assert "createRelativePositionFromTypeIndex" in client
    assert "mapFor" in client
    assert "collaboration_data:/data" in compose
    assert '"y-websocket"' in package


def test_collaboration_image_copies_server_modules() -> None:
    collaboration = ROOT / "apps/paper_workspace/collaboration"
    dockerfile = (collaboration / "Dockerfile").read_text(encoding="utf-8")

    for name in (
        "server.cjs",
        "atomic-source.cjs",
        "http-helpers.cjs",
        "rebuttal-sources.cjs",
        "runtime-sync.cjs",
        "source-merge.cjs",
        "storage-quota.cjs",
        "writeback.cjs",
    ):
        assert (collaboration / name).is_file()
        assert f"apps/paper_workspace/collaboration/{name}" in dockerfile
