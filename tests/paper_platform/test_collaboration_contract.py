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
