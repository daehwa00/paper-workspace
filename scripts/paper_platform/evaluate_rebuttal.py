#!/usr/bin/env python3
"""Evaluate actual run_analysis outputs; mocks are explicitly separated from live runs.

Example (deterministic structural smoke test):
  python scripts/paper_platform/evaluate_rebuttal.py --mock
A live runner is an importable module:function implementing call_bridge(task,payload,profile):
  python scripts/paper_platform/evaluate_rebuttal.py --runner package:bridge --live
No live-model quality claim is made by the mock path.
"""
from __future__ import annotations

import argparse
import importlib
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("rebuttal_analysis_eval", ROOT / "apps/paper_workspace/rebuttal/analysis.py")
analysis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analysis)


def edges(result):
    return {(m["concern_id"], span["document_id"]) for m in result.get("mappings", []) for span in m.get("response_spans", []) if m.get("coverage") != "missing"}


def evaluate(cases, runner_factory):
    tp = fp = fn = correct = total = 0
    failures, confusion, case_results, critical = [], {}, [], []
    for case in cases:
        try:
            actual = analysis.run_analysis("map", case["payload"], runner_factory(case), lambda _: None, lambda: False)
            actual_edges = edges(actual)
            predicted = {m["concern_id"]: m["coverage"] for m in actual["mappings"]}
        except Exception as exc:
            failures.append({"case": case["id"], "error": str(exc)})
            critical.append({"case": case["id"], "type": "runner_or_validation_failure"})
            actual_edges, predicted = set(), {}
        expected_edges = edges(case["expected"])
        tp += len(actual_edges & expected_edges)
        fp += len(actual_edges - expected_edges)
        fn += len(expected_edges - actual_edges)
        expected_coverage = {m["concern_id"]: m["coverage"] for m in case["expected"]["mappings"]}
        case_results.append({"case": case["id"], "expected_coverage": expected_coverage, "actual_coverage": predicted,
                             "false_links": sorted(actual_edges - expected_edges), "missed_links": sorted(expected_edges - actual_edges)})
        for m in case["expected"]["mappings"]:
            gold, pred = m["coverage"], predicted.get(m["concern_id"], "omitted")
            total += 1
            correct += gold == pred
            if pred == "addressed" and gold in {"partial", "related", "missing"}:
                critical.append({"case": case["id"], "concern_id": m["concern_id"], "type": "overclaimed_sufficiency", "expected": gold})
            label = gold + "->" + pred
            confusion[label] = confusion.get(label, 0) + 1
    return {"cases": len(cases), "mapping": {"true_positive": tp, "false_positive": fp, "false_negative": fn,
             "precision": tp / (tp + fp) if tp + fp else None, "recall": tp / (tp + fn) if tp + fn else None},
            "sufficiency": {"correct": correct, "total": total, "accuracy": correct / total if total else None, "confusion": confusion}, "failures": failures, "critical_failures": critical, "case_results": case_results}


def mock_runner(case):
    def run(task, payload, profile):
        mappings = case["expected"]["mappings"]
        if payload.get("phase") == "mapping":
            docs = {d["id"]: d["text"] for d in payload["documents"]}
            ids = {c["id"] for c in payload["concerns"]}
            return {"mappings": [{**m, "response_spans": [s for s in m["response_spans"] if s["document_id"] in docs and s["quote"] in docs[s["document_id"]]]} for m in mappings if m["concern_id"] in ids and any(s["document_id"] in docs and s["quote"] in docs[s["document_id"]] for s in m["response_spans"])]}
        return {"mappings": [m for m in mappings if m["concern_id"] in {c["id"] for c in payload["concerns"]}]}
    return run


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, default=ROOT / "tests/paper_platform/fixtures/rebuttal-golden.json")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--mock", action="store_true")
    source.add_argument("--runner", help="module:function; executes this runner through real run_analysis")
    parser.add_argument("--live", action="store_true", help="Explicitly authorize live model calls for --runner")
    args = parser.parse_args()
    if args.runner and not args.live:
        parser.error("--runner requires --live to make live-model intent explicit")
    if args.mock and args.live:
        parser.error("--mock cannot be labeled --live")
    cases = json.loads(args.fixtures.read_text())["cases"]
    if args.mock:
        factory = mock_runner
    else:
        module, name = args.runner.split(":", 1)
        sys.path.insert(0, str(ROOT))
        bridge = getattr(importlib.import_module(module), name)
        factory = lambda _: bridge
    metrics = evaluate(cases, factory)
    metrics.update(evaluation_mode="mock_structural" if args.mock else "live_runner", live_model_calls_requested=bool(args.live),
                   quality_evidence="mock outputs only; no LLM quality claim" if args.mock else "external runner outputs; inspect runner for model provenance", runner=args.runner)
    if args.mock:
        metrics["llm_quality_validated"] = False
    print(json.dumps(metrics, ensure_ascii=False, indent=2))
    return bool(metrics["failures"])


if __name__ == "__main__":
    raise SystemExit(main())
