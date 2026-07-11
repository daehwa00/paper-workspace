from pathlib import Path

ROOT = Path(__file__).parents[2]


def test_collaboration_contract_covers_requested_workflows() -> None:
    contract = (ROOT / "docs/paper-platform/collaboration-contract.md").read_text(encoding="utf-8")
    for event in ("join", "presence", "cursor", "leave"):
        assert event in contract
    assert "not synchronized" in contract
    assert "no server-authoritative revision" in contract
