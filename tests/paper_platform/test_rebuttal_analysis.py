from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]
spec = importlib.util.spec_from_file_location("rebuttal_analysis", ROOT / "apps/paper_workspace/rebuttal/analysis.py")
analysis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analysis)


def payload():
    return {"reviews": [{"id": "r1", "reviewer_id": "reviewer1", "fields": {"review": "😀 질문: ablation과 비용을 설명하세요."}}],
            "documents": [{"id": "d1", "text": "😀 답변: ablation 결과입니다. 추가로 비용입니다."}, {"id": "d2", "text": "제한을 인정합니다."}],
            "concerns": [{"id": "c1", "title": "Ablation and cost", "reviewer_id": "reviewer1", "source_spans": [{"review_id": "r1", "field": "review", "quote": "ablation과 비용"}]}]}


def mapping(quote="ablation 결과입니다.", **kwargs):
    return {"concern_id": "c1", "coverage": "addressed", "response_spans": [{"document_id": "d1", "quote": quote, "start": 999, "end": 1000}], "reason": "Evidence", "missing": [], **kwargs}


@pytest.mark.parametrize("message,issue", [
    ("Invalid translation block: code or math changed", "translation_protected_content"),
    ("Invalid translation block: expected only text", "translation"),
    ("Invalid translation block: output is too short", "translation"),
    ("Translation block exceeds safe splitting limit", "translation"),
])
def test_translation_validation_has_bounded_specific_diagnostics(message, issue):
    assert analysis.validation_issue(analysis.AnalysisError(message)) == issue


def test_offsets_derive_from_snapshot_utf16_and_discontiguous_spans():
    p = payload()
    raw = mapping()
    raw["response_spans"].append({"document_id": "d1", "quote": "비용입니다."})
    value = analysis.validate_result("map", {"mappings": [raw]}, p)
    spans = value["mappings"][0]["response_spans"]
    assert spans[0]["start"] == 7  # emoji consumes two UTF-16 units
    assert spans[0]["end"] == 22
    assert spans[1]["start"] > spans[0]["end"]
    assert analysis.validate_result("map", value, p) == value


@pytest.mark.parametrize("change", ["document", "concern", "quote"])
def test_invalid_mapping_evidence_is_rejected(change):
    raw = mapping()
    if change == "document":
        raw["response_spans"][0]["document_id"] = "invented"
    elif change == "concern":
        raw["concern_id"] = "invented"
    else:
        raw["response_spans"][0]["quote"] = "invented experiment"
    with pytest.raises(analysis.AnalysisError):
        analysis.validate_result("map", {"mappings": [raw]}, payload())


def test_repeated_quote_is_uncertain_and_unanchored():
    p = payload()
    p["documents"][0]["text"] = "비용입니다. 비용입니다."
    m = analysis.validate_result("map", {"mappings": [mapping("비용입니다.")]}, p)["mappings"][0]
    assert m["coverage"] == "uncertain"
    assert m["response_spans"] == []


def test_missing_quote_cannot_claim_addressed():
    m = analysis.validate_result("map", {"mappings": [mapping(response_spans=[])]}, payload())["mappings"][0]
    assert m["coverage"] == "uncertain"


def test_grounded_concern_ids_stable_with_multiple_source_spans():
    p = payload()
    c = {"id": "model-id", "title": "Two requests", "reviewer_id": "reviewer1", "source_spans": [{"review_id": "r1", "field": "review", "quote": "ablation"}, {"review_id": "r1", "field": "review", "quote": "비용"}]}
    first = analysis.validate_result("analyze", {"concerns": [c]}, p)
    c["id"] = "different-id"
    second = analysis.validate_result("analyze", {"concerns": [c]}, p)
    assert first["concerns"][0]["id"] == second["concerns"][0]["id"]
    assert first == analysis.validate_result("analyze", first, p)
    c["source_spans"][0]["review_id"] = "missing"
    with pytest.raises(analysis.AnalysisError):
        analysis.validate_result("analyze", {"concerns": [c]}, p)


def test_connect_classifies_and_audits_without_losing_or_duplicating_links():
    snapshot=payload();snapshot['concerns']=[];snapshot['scope']={'document_ids':['d1']}
    snapshot['manuscript']={'entrypoint':'main.tex','files':[{'path':'main.tex','text':'Original manuscript'}]}
    calls=[]
    def link(quote,relationship='partial',title='Ablation'):
        return {'title':title,'source_spans':[{'review_id':'r1','field':'review','quote':'ablation과 비용'}],
                'response_spans':[{'document_id':'d1','quote':quote}],'relationship':relationship,'reason':'리뷰의 요청 중 일부를 답변합니다.'}
    def bridge(task,request,profile):
        calls.append((task,request))
        if request['phase']=='direct_connect':return {'links':[link('ablation 결과입니다.')]}
        assert request['phase']=='direct_connect_audit'
        assert request['candidate_mappings'][0]['relationship']=='partial'
        return {'links':[link('ablation 결과입니다.'),link('추가로 비용입니다.','direct','다른 제목')]}
    stages=[];result=analysis.run_analysis('connect',snapshot,bridge,stages.append,lambda:False)
    assert [x[1]['phase'] for x in calls]==['direct_connect','direct_connect_audit']
    assert all(x[1]['manuscript']==snapshot['manuscript'] for x in calls)
    assert stages==['direct_connect','direct_connect_audit']
    assert len(result['concerns'])==1 and len(result['mappings'])==2
    assert [m['relationship'] for m in result['mappings']]==['partial','direct']
    assert all(m['coverage']=='related' for m in result['mappings'])
    assert all(m['concern_id']==result['concerns'][0]['id'] for m in result['mappings'])
    assert result['translations']==[] and result['findings']==[]


@pytest.mark.parametrize('failure,feedback', [('fabricated','evidence'),('multi','multiple_sentences'),('english','korean_reason'),('relationship','relationship')])
def test_direct_connection_retries_invalid_first_pass_and_audits(failure,feedback):
    snapshot=payload();snapshot['concerns']=[];snapshot['scope']={'document_ids':['d1']};calls=[]
    def bridge(task,request,profile):
        calls.append(request)
        if request['phase']=='direct_connect_audit':return {'links':[]}
        first=len(calls)==1
        return {'links':[{'title':'Ablation','source_spans':[{'review_id':'r1','field':'review','quote':'ablation과 비용'}],
                          'response_spans':[{'document_id':'d1','quote':('fabricated' if failure=='fabricated' else 'ablation 결과입니다. 추가로 비용입니다.' if failure=='multi' else 'ablation 결과입니다.') if first else 'ablation 결과입니다.'}],
                          'relationship':('incorrect' if first and failure=='relationship' else 'partial'),
                          'reason':'Related evidence' if first and failure=='english' else '리뷰 요청 일부를 설명합니다.'}]}
    result=analysis.run_analysis('connect',snapshot,bridge,lambda _:None,lambda:False)
    assert len(calls)==3 and calls[1]['validation_feedback']==feedback
    assert calls[2]['phase']=='direct_connect_audit'
    assert result['mappings'][0]['response_spans'][0]['quote']=='ablation 결과입니다.'


def test_audit_retries_forged_quote_and_does_not_publish_incomplete_audit():
    snapshot=payload();snapshot['concerns']=[];snapshot['scope']={'document_ids':['d1']};calls=[]
    def bridge(task,request,profile):
        calls.append(request)
        if request['phase']=='direct_connect':return {'links':[]}
        return {'links':[{'title':'invented','source_spans':[{'review_id':'r1','field':'review','quote':'invented'}],
                          'response_spans':[{'document_id':'d1','quote':'ablation 결과입니다.'}],
                          'relationship':'direct','reason':'근거가 없습니다.'}]}
    result=analysis.run_analysis('connect',snapshot,bridge,lambda _:None,lambda:False)
    assert result['mappings']==[] and result['connection_warnings'][0]['omitted_links']==1
    assert len(calls)==4 and calls[-1]['phase']=='direct_connect_audit_verify_quotes'


def test_direct_connection_rejects_oversized_input_without_splitting():
    snapshot=payload();snapshot['concerns']=[];snapshot['scope']={'document_ids':['d1']};snapshot['reviews'][0]['fields']['review']='x'*65000
    calls=[]
    with pytest.raises(analysis.AnalysisError, match='context exceeds'):
        analysis.run_analysis('connect',snapshot,lambda *args:calls.append(args),lambda _:None,lambda:False)
    assert calls==[]


def test_translate_preserves_uncertainty_and_rejects_unknown_fields():
    item = {"review_id": "r1", "field": "review", "text": "의미가 불확실한 번역", "uncertain": [{"text": "cost", "reason": "ambiguous"}]}
    assert analysis.validate_result("translate", {"translations": [item]}, payload())["translations"][0] == item
    item["field"] = "unknown"
    with pytest.raises(analysis.AnalysisError):
        analysis.validate_result("translate", {"translations": [item]}, payload())


def test_translation_alignments_only_keep_grounded_korean_segments():
    item = {"review_id": "r1", "field": "review", "text": "질문과 비용을 설명하세요.", "uncertain": [], "segments": [
        {"source": "ablation과 비용을 설명하세요.", "text": "절제 실험과 비용을 설명하세요."},
        {"source": "invented", "text": "없는 문장"},
        {"source": "😀 질문:", "text": "English"},
    ]}
    result = analysis.validate_result("translate", {"translations": [item]}, payload())
    assert result["translations"][0]["segments"] == [item["segments"][0]]


@pytest.mark.parametrize("text", [
    "缺少条件：摘要承诺对平稳且完全观测的过程提供识别保证。",
    "Please explain the ablation results and cost.",
    "한국어 缺少条件摘要承诺对平稳且完全观测的过程提供识别保证。",
    "",
])
def test_translation_rejects_non_korean_and_blank_prose(text):
    item = {"review_id": "r1", "field": "review", "text": text}
    with pytest.raises(analysis.AnalysisError, match="must be Korean"):
        analysis.validate_result("translate", {"translations": [item]}, payload())


@pytest.mark.parametrize("source", ["10.2 ± 0.5", "ALPHABET / GPT-4", "$x + y = 1$", "AdamW lr=1e-5", ""])
def test_translation_allows_unchanged_technical_only_fields(source):
    p = {"reviews": [{"id": "r1", "fields": {"review": source}}]}
    item = {"review_id": "r1", "field": "review", "text": source}
    assert analysis.validate_result("translate", {"translations": [item]}, p)["translations"][0]["text"] == source


def test_translation_keeps_technical_terms_and_limited_hanja_in_korean():
    item = {"review_id": "r1", "field": "review", "text": "ALPHABET의 ablation 결과와 비용(費用)을 설명해 주세요."}
    assert analysis.validate_result("translate", {"translations": [item]}, payload())["translations"][0]["text"] == item["text"]


def test_translation_duplicate_review_field_is_rejected():
    item = {"review_id": "r1", "field": "review", "text": "중복 번역입니다."}
    with pytest.raises(analysis.AnalysisError, match="Duplicate translation"):
        analysis.validate_result("translate", {"translations": [item, {**item, "text": "또 다른 번역입니다."}]}, payload())


@pytest.mark.parametrize('invalid', [[], [{'review_id': 'r1', 'field': 'review', 'text': 'English only', 'uncertain': []}]])
def test_translation_validation_failure_retries_with_safe_feedback(invalid):
    calls = []
    snapshot = {'reviews': [{'id': 'r1', 'reviewer_id': 'reviewer1', 'fields': {'review': 'Please clarify the result.'}}]}
    def bridge(task, request, profile):
        calls.append(request)
        return {'translations': invalid if len(calls) == 1 else [{'review_id': 'r1', 'field': 'review', 'text': '결과를 설명해 주세요.', 'uncertain': []}]}
    result = analysis.run_analysis('translate', snapshot, bridge, lambda _: None, lambda: False)
    assert result['translations'][0]['text'] == '결과를 설명해 주세요.'
    assert len(calls) == 2
    assert calls[1]['validation_feedback'] == 'translation'
    assert calls[1]['phase'].endswith('_verify_quotes')


def test_analyze_uses_grounded_ids_when_model_reuses_a_placeholder():
    snapshot = {'reviews': [{'id': 'r1', 'reviewer_id': 'reviewer1', 'fields': {'review': 'Explain the baseline and report uncertainty.'}}], 'documents': [], 'concerns': []}
    def bridge(task, request, profile):
        return {'translations': [{'review_id': 'r1', 'field': 'review', 'text': '기준선과 불확실성을 설명하세요.', 'uncertain': []}],
                'concerns': [{'id': 'c1', 'title': title, 'reviewer_id': 'reviewer1', 'source_spans': [{'review_id': 'r1', 'field': 'review', 'quote': quote}], 'requires_response': True, 'strategy': 'clarify'} for title, quote in [('Baseline', 'baseline'), ('Uncertainty', 'uncertainty')]]}
    result = analysis.run_analysis('analyze', snapshot, bridge, lambda _: None, lambda: False)
    assert len(result['concerns']) == 2
    assert len({item['id'] for item in result['concerns']}) == 2


@pytest.mark.parametrize("wrong", ["review", "field", "duplicate", "missing"])
def test_translation_chunk_rejects_wrong_target_duplicates_and_omissions(wrong):
    p = {"reviews": [{"id": "r1", "fields": {"review": "Explain cost.", "summary": "Explain results."}}, {"id": "r2", "fields": {"review": "Explain latency."}}]}
    def bridge(*_):
        item = {"review_id": "r2" if wrong == "review" else "r1", "field": "summary" if wrong == "field" else "review", "text": "비용을 설명하세요."}
        return {"translations": [] if wrong == "missing" else [item, item] if wrong == "duplicate" else [item]}
    with pytest.raises(analysis.AnalysisError):
        analysis.run_analysis("translate", p, bridge, lambda _: None, lambda: False)


def test_translation_chunks_merge_in_source_order_preserving_real_repetitions(monkeypatch):
    monkeypatch.setattr(analysis, "CHUNK_CHARS", 8)
    p = {"reviews": [{"id": "r1", "fields": {"review": "Repeat. Repeat. Last."}}]}
    texts, calls = {"Repeat. ": "반복입니다.", "Last.": "마지막입니다."}, []
    def bridge(task, request, profile):
        chunk = request["reviews"][0]["fields"]["review"]
        calls.append(chunk)
        return {"translations": [{"review_id": "r1", "field": "review", "text": texts[chunk], "uncertain": [{"text": chunk, "reason": "확인 필요"}]}]}
    value = analysis.run_analysis("translate", p, bridge, lambda _: None, lambda: False)
    assert calls == ["Repeat. ", "Repeat. ", "Last."]
    assert value["translations"][0]["text"] == "반복입니다.\n반복입니다.\n마지막입니다."
    assert len(value["translations"][0]["uncertain"]) == 3


def test_analysis_boundary_extraction_ignores_translation_output(monkeypatch):
    monkeypatch.setattr(analysis, "CHUNK_CHARS", 8)
    p = {"reviews": [{"id": "r1", "fields": {"review": "Repeat. Repeat. "}}]}
    boundary_seen = []
    def bridge(task, request, profile):
        chunk = request["reviews"][0]["fields"]["review"]
        if len(chunk) > 8:
            boundary_seen.append(chunk)
            # A concern-only boundary call must never append or validate these.
            return {"translations": [{"review_id": "other", "field": "other", "text": "中文"}]}
        return {"translations": [{"review_id": "r1", "field": "review", "text": "반복입니다."}]}
    value = analysis.run_analysis("analyze", p, bridge, lambda _: None, lambda: False)
    assert boundary_seen == ["Repeat. Repeat. "]
    assert value["translations"][0]["text"] == "반복입니다.\n반복입니다."


def test_findings_and_consistency_quotes_checked():
    p = payload()
    result = {"findings": [{"document_id": "d1", "quote": "ablation 결과입니다.", "type": "unsupported", "reason": "Claim needs evidence", "suggestion": "Qualify claim", "meaning_change": True}], "consistency": [{"document_ids": ["d1", "d2"], "quotes": [{"document_id": "d2", "quote": "제한을 인정합니다."}], "reason": "Check scope"}]}
    value = analysis.validate_result("style", result, p)
    assert value["findings"][0]["meaning_change"] is True
    result["consistency"][0]["quotes"][0]["quote"] = "fabricated"
    with pytest.raises(analysis.AnalysisError):
        analysis.validate_result("consistency", result, p)


def test_simulated_questions_cannot_enter_actual_coverage():
    result = {"simulated_questions": [{"question": "What about future work?", "concern_ids": ["c1"]}], "mappings": [mapping()]}
    value = analysis.validate_result("simulate", result, payload())
    assert value["concerns"] == value["mappings"] == []
    assert value["simulated_questions"][0]["inferred"] is True


def test_rules_research_has_metadata_only_and_cannot_apply_candidates():
    requests = []
    def bridge(task, request, profile):
        requests.append(request)
        return {"rules_candidates": [{"venue": "Synthetic", "active_rules_id": "fake", "applied": True, "sources": [{"url": "https://example.org", "status": "verified"}]}]}
    p = {**payload(), "venue": "Synthetic", "year": 2026, "official_urls": ["https://example.org", "file:///secret", "http://unsafe"]}
    value = analysis.run_analysis("research_rules", p, bridge, lambda _: None, lambda: False)
    assert set(requests[0]) == {"venue", "year", "track", "stage", "official_urls"}
    assert requests[0]["official_urls"] == ["https://example.org"]
    assert "active_rules_id" not in value["rules_candidates"][0]
    assert value["rules_candidates"][0]["sources"][0]["status"] == "unverified"


def test_cancellation_before_and_after_bridge():
    with pytest.raises(analysis.AnalysisCancelled):
        analysis.run_analysis("map", payload(), lambda *_: pytest.fail("called"), lambda _: None, lambda: True)
    state = {"cancel": False}
    def bridge(*_):
        state["cancel"] = True
        return {}
    with pytest.raises(analysis.AnalysisCancelled):
        analysis.run_analysis("map", payload(), bridge, lambda _: None, lambda: state["cancel"])


def test_long_mapping_reconciles_partial_evidence_across_documents(monkeypatch):
    monkeypatch.setattr(analysis, "CHUNK_CHARS", 300)
    p = payload()
    p["documents"] = [{"id": "d1", "text": "padding " * 90 + "ablation evidence."}, {"id": "d2", "text": "cost evidence."}]
    calls = []
    def bridge(task, request, profile):
        calls.append(request)
        if request["phase"] == "global_coverage":
            assert {d["id"] for d in request["documents"]} == {"d1", "d2"}
            return {"mappings": [mapping(response_spans=[{"document_id": "d1", "quote": "ablation evidence."}, {"document_id": "d2", "quote": "cost evidence."}])]}
        output = []
        for d in request["documents"]:
            for quote in ("ablation evidence.", "cost evidence."):
                if quote in d["text"]:
                    output.append(mapping(coverage="partial", response_spans=[{"document_id": d["id"], "quote": quote}]))
        return {"mappings": output}
    value = analysis.run_analysis("map", p, bridge, lambda _: None, lambda: False)
    assert len(calls) > 3
    assert value["mappings"][0]["coverage"] == "addressed"
    assert len(value["mappings"][0]["response_spans"]) == 2


def test_unmatched_concern_remains_missing_without_forced_link():
    value = analysis.run_analysis("map", payload(), lambda *_: {"mappings": []}, lambda _: None, lambda: False)
    assert value["mappings"][0]["coverage"] == "missing"
    assert value["mappings"][0]["response_spans"] == []


def test_full_pipeline_runs_only_explicit_calls_and_preserves_input():
    p = payload()
    before = json.dumps(p, sort_keys=True)
    kinds = []
    def bridge(task, request, profile):
        kinds.append(task)
        if task == "analyze":
            return {"translations": [{"review_id": "r1", "field": "review", "text": "ablation과 비용을 설명하세요.", "uncertain": []}], "concerns": []}
        return {}
    value = analysis.run_analysis("analyze", p, bridge, lambda _: None, lambda: False)
    assert {"analyze", "map", "style", "consistency"}.issubset(kinds)
    assert value["translations"]
    assert json.dumps(p, sort_keys=True) == before


def test_rewrite_requires_exact_snapshot_selection():
    p = payload()
    p["selection"] = {"document_id": "d1", "quote": "ablation 결과입니다."}
    assert analysis.validate_result("rewrite", {"replacement": "Qualified wording"}, p)["replacement"] == "Qualified wording"
    p["selection"]["quote"] = "stale text"
    with pytest.raises(analysis.AnalysisError):
        analysis.validate_result("rewrite", {"replacement": "x"}, p)


def test_golden_has_at_least_thirty_cases_and_varied_coverage():
    cases = json.loads((Path(__file__).parent / "fixtures/rebuttal-golden.json").read_text())["cases"]
    assert len(cases) >= 30
    assert {m["coverage"] for c in cases for m in c["expected"]["mappings"]} >= {"addressed", "partial", "related", "missing"}
    for case in cases:
        analysis.validate_result("map", case["expected"], case["payload"])


def test_known_concern_stale_source_is_rejected():
    p = payload()
    p["concerns"][0]["source_spans"][0]["quote"] = "stale reviewer text"
    with pytest.raises(analysis.AnalysisError):
        analysis.validate_result("map", {"mappings": [mapping()]}, p)


def test_declared_remaining_gap_downgrades_addressed():
    m = analysis.validate_result("map", {"mappings": [mapping(missing=["cost numbers"])]}, payload())["mappings"][0]
    assert m["coverage"] == "partial"


def test_evaluator_counts_false_links_and_omissions():
    spec = importlib.util.spec_from_file_location("rebuttal_evaluator", ROOT / "scripts/paper_platform/evaluate_rebuttal.py")
    evaluator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(evaluator)
    case = {"id": "bad-predictions", "payload": payload(), "expected": {"mappings": [mapping()]}}
    def wrong_factory(case):
        def bridge(*_):
            return {"mappings": [mapping(response_spans=[{"document_id": "d2", "quote": "제한을 인정합니다."}], coverage="partial")]}
        return bridge
    metrics = evaluator.evaluate([case], wrong_factory)
    assert metrics["mapping"]["false_positive"] == 1
    assert metrics["mapping"]["false_negative"] == 1
    assert metrics["mapping"]["precision"] == metrics["mapping"]["recall"] == 0
    assert metrics["sufficiency"]["accuracy"] == 0


def test_mapping_scope_limits_documents_and_concerns():
    p = payload()
    p["scope"] = {"document_ids": ["d2"], "concern_ids": ["c1"]}
    requests = []
    def bridge(task, request, profile):
        requests.append(request)
        return {"mappings": []}
    analysis.run_analysis("map", p, bridge, lambda _: None, lambda: False)
    assert requests
    assert all({d["id"] for d in r["documents"]} <= {"d2"} for r in requests)
    assert all({c["id"] for c in r["concerns"]} == {"c1"} for r in requests)


def test_rerun_preserves_existing_grounded_id_when_title_paraphrased():
    p = payload()
    old = p["concerns"][0]
    proposed = {**old, "id": "fresh-model-id", "title": "Explain the ablation and computational cost"}
    result = analysis.validate_result("analyze", {"concerns": [proposed]}, p)
    assert result["concerns"][0]["id"] == "c1"


def test_extraction_does_not_send_existing_translations_as_source_context():
    p = payload()
    p['reviews'][0]['translations'] = {'other_field': 'Unrelated translated concern'}
    requests = []
    def bridge(task, request, profile):
        requests.append(request)
        if task == 'analyze':
            return {'translations': [{'review_id': 'r1', 'field': 'review', 'text': 'ablation과 비용을 설명하세요.'}]}
        return {}
    analysis.run_analysis('analyze', p, bridge, lambda _: None, lambda: False)
    assert requests
    assert all('translations' not in review for request in requests for review in request['reviews'])
    assert p['reviews'][0]['translations']['other_field'] == 'Unrelated translated concern'


def test_invalid_quote_gets_one_grounding_repair_without_relaxing_validation():
    p = payload()
    calls = []
    def bridge(task, request, profile):
        calls.append(request)
        return {'mappings': [mapping('fabricated quotation' if len(calls) == 1 else 'ablation 결과입니다.')]}
    result = analysis.run_analysis('map', p, bridge, lambda _: None, lambda: False)
    assert len(calls) >= 2
    assert calls[1]['phase'].endswith('_verify_quotes')
    assert result['mappings'][0]['response_spans'][0]['quote'] == 'ablation 결과입니다.'
    calls.clear()
    def invalid(*args):
        calls.append(args)
        return {'mappings': [mapping('fabricated quotation')]}
    with pytest.raises(analysis.AnalysisError, match='Quote absent'):
        analysis.run_analysis('map', p, invalid, lambda _: None, lambda: False)
    assert len(calls) == 2


@pytest.mark.parametrize('sentence', [
    'The paper bounds states on irregular grids (Prop. 1/Cor. 2).',
    'By Prop. 1 and Cor. 2, the stated bound holds.',
    'The claim follows from Thm. 3 and Lem. 1.',
    'See Sec. 2, Tab. 1 and Alg. 3 for details.',
    r'The bound follows from Prop. \ref{prop:stable}.',
    'The estimate is given in App. A and Ref. [12].',
])
def test_scholarly_reference_abbreviations_are_not_sentence_boundaries(sentence):
    assert not analysis._multiple_sentences(sentence)


@pytest.mark.parametrize('text', [
    'The paper bounds states (Prop. 1/Cor. 2). Lemma 1 proves stability.',
    'The method is sound. Prop. 1 gives a bound.',
    'A finite model is considered. Results follow.',
])
def test_distinct_sentences_still_require_separate_links(text):
    assert analysis._multiple_sentences(text)


def test_two_pass_connection_accepts_exact_scholarly_references():
    review='Which properties hold for the finite model?'
    answer='The paper bounds states on irregular grids under stated assumptions (Prop. 1/Cor. 2).'
    snapshot={'reviews':[{'id':'r','reviewer_id':'reviewer','fields':{'review':review}}],
              'documents':[{'id':'d','text':answer}],'concerns':[],'scope':{'document_ids':['d']}}
    calls=[]
    def bridge(task,request,profile):
        calls.append(request['phase'])
        if request['phase']=='direct_connect_audit':return {'links':[]}
        return {'links':[{'title':'Finite model','source_spans':[{'review_id':'r','field':'review','quote':review}],
                          'response_spans':[{'document_id':'d','quote':answer}],'relationship':'direct',
                          'reason':'유한 모델에서 성립하는 경계를 설명합니다.'}]}
    result=analysis.run_analysis('connect',snapshot,bridge,lambda _:None,lambda:False)
    assert calls==['direct_connect','direct_connect_audit']
    assert result['mappings'][0]['response_spans'][0]['quote']==answer


def test_connection_validation_reports_safe_attempt_details():
    snapshot=payload(); snapshot['concerns']=[]; snapshot['scope']={'document_ids':['d1']}
    snapshot['documents'][0]['text']='첫째. 둘째. 셋째. 넷째.'
    calls=[]
    def bridge(task,request,profile):
        calls.append(request)
        return {'links':[{'title':'private title', 'source_spans':[{'review_id':'r1','field':'review','quote':'ablation과 비용'}],
            'response_spans':[{'document_id':'d1','quote':'첫째. 둘째. 셋째. 넷째.'}],
            'relationship':'partial','reason':'리뷰 요청을 설명합니다.'}]}
    with pytest.raises(analysis.AnalysisError) as caught:
        analysis.run_analysis('connect',snapshot,bridge,lambda _:None,lambda:False)
    assert caught.value.validation_failures == [
        {'issue':'multiple_sentences','attempt':1,'link_index':0},
        {'issue':'multiple_sentences','attempt':2,'link_index':0},
        {'issue':'multiple_sentences','attempt':3,'link_index':0}]
    assert calls[1]['validation_feedback']=='multiple_sentences'
    assert 'private title' not in str(caught.value.validation_failures)


def test_connection_salvages_only_independently_grounded_links_after_retry():
    snapshot=payload();snapshot['concerns']=[];snapshot['scope']={'document_ids':['d1']}
    def bridge(task,request,profile):
        if request['phase']=='direct_connect_audit': return {'links':[]}
        def link(quote):return {'title':'Ablation','source_spans':[{'review_id':'r1','field':'review','quote':'ablation과 비용'}],
          'response_spans':[{'document_id':'d1','quote':quote}],'relationship':'partial','reason':'리뷰 요청 일부를 설명합니다.'}
        return {'links':[link('ablation 결과입니다.'),link('ablation 결과입니다. 추가로 비용입니다.'),link('fabricated')]}
    result=analysis.run_analysis('connect',snapshot,bridge,lambda _:None,lambda:False)
    assert len(result['mappings'])==1
    assert result['mappings'][0]['response_spans'][0]['quote']=='ablation 결과입니다.'
    assert result['connection_warnings'][0]['omitted_links']==1


@pytest.mark.parametrize('sentence', ['Q1. Separation is a population claim.', '1. The method works.', '- 2. The method works.'])
def test_numbered_question_prefix_is_not_a_sentence_boundary(sentence):
    assert not analysis._multiple_sentences(sentence)


def test_repair_narrows_only_original_grounded_candidate_pairs():
    snapshot=payload(); snapshot['concerns']=[]; snapshot['scope']={'document_ids':['d1']}
    def link(quote): return {'title':'Ablation','source_spans':[{'review_id':'r1','field':'review','quote':'ablation과 비용'}], 'response_spans':[{'document_id':'d1','quote':quote}],'relationship':'partial','reason':'리뷰 요청 일부를 설명합니다.'}
    def bridge(task,request,profile):
        if request['phase']=='direct_connect_audit':return {'links':[]}
        if request['phase']=='direct_connect_repair':return {'links':[link('추가로 비용입니다.'),link('fabricated')]}
        return {'links':[link('ablation 결과입니다. 추가로 비용입니다.')]}
    result=analysis.run_analysis('connect',snapshot,bridge,lambda _:None,lambda:False)
    assert [m['response_spans'][0]['quote'] for m in result['mappings']]==['추가로 비용입니다.']
    assert not result.get('connection_warnings')


def test_repair_can_recover_exact_substring_of_imperfect_candidate():
    snapshot=payload();snapshot['concerns']=[];snapshot['scope']={'document_ids':['d1']}
    def link(quote):return {'title':'Ablation','source_spans':[{'review_id':'r1','field':'review','quote':'ablation과 비용'}], 'response_spans':[{'document_id':'d1','quote':quote}], 'relationship':'partial','reason':'리뷰 요청 일부를 설명합니다.'}
    def bridge(task,request,profile):
        if request['phase']=='direct_connect_audit':return {'links':[]}
        if request['phase']=='direct_connect_repair':return {'links':[link('ablation 결과입니다.')]}
        return {'links':[link('ablation 결과입니다. 추가로 비용입니다. NOT IN ORIGINAL')]}
    result=analysis.run_analysis('connect',snapshot,bridge,lambda _:None,lambda:False)
    assert result['mappings'][0]['response_spans'][0]['quote']=='ablation 결과입니다.'
    assert not result.get('connection_warnings')


@pytest.mark.parametrize('repair_quote', [None, 'fabricated', 'ablation 결과입니다. Fabricated sentence.'])
def test_unrepairable_multi_sentence_pair_is_retained_as_uncertain_context(repair_quote):
    snapshot=payload();snapshot['concerns']=[];snapshot['scope']={'document_ids':['d1']}
    original_quote='ablation 결과입니다. 추가로 비용입니다.'
    def link(quote):
        return {'title':'Ablation','source_spans':[{'review_id':'r1','field':'review','quote':'ablation과 비용'}],
                'response_spans':[{'document_id':'d1','quote':quote}],
                'relationship':'direct','reason':'리뷰의 요청을 설명합니다.'}
    def bridge(task,request,profile):
        if request['phase']=='direct_connect_audit':return {'links':[]}
        if request['phase']=='direct_connect_repair':return {'links':[] if repair_quote is None else [link(repair_quote)]}
        return {'links':[link(original_quote)]}
    result=analysis.run_analysis('connect',snapshot,bridge,lambda _:None,lambda:False)
    assert len(result['mappings'])==1
    mapping=result['mappings'][0]
    assert mapping['relationship']=='context' and mapping['coverage']=='uncertain'
    assert '확인이 필요합니다' in mapping['reason']
    assert mapping['response_spans'][0]['quote']==original_quote
    assert 'start' in mapping['response_spans'][0]
    assert result['connection_diagnostics'][0]['type']=='contextual_candidate'
    assert 'quote' not in result['connection_diagnostics'][0]['response']
    warning,=result['connection_warnings']
    assert warning['stage']=='direct_connect'
    assert warning['omitted_links']==0 and warning['contextual_links']==1
    assert warning['repair']['accepted']==0
    assert [failure['issue'] for failure in warning['validation_failures']]==['multiple_sentences']*3


def test_rewrite_uses_second_selection_offset_and_refuses_unanchored_duplicate():
    p = payload()
    source = "😀 First selected phrase. " + "x" * 2100 + " Second selected phrase."
    p["documents"] = [{"id": "d1", "text": source}]
    quote = "selected phrase"
    requested = len(source[:source.rindex(quote)].encode("utf-16-le")) // 2
    p["selection"] = {"document_id": "d1", "quote": quote, "start": requested}
    calls = []

    def bridge(task, request, profile):
        calls.append(request)
        return {"replacement": "revised phrase"}

    assert analysis.run_analysis("rewrite", p, bridge, lambda _: None, lambda: False)["replacement"] == "revised phrase"
    excerpt = calls[0]["documents"][0]["text"]
    selection = calls[0]["selection"]
    assert "Second selected phrase" in excerpt and "First selected phrase" not in excerpt
    assert excerpt.encode("utf-16-le")[selection["start"] * 2:selection["end"] * 2].decode("utf-16-le") == quote
    for offset in (None, requested - 1):
        p["selection"]["start"] = offset
        with pytest.raises(analysis.AnalysisError, match="Ambiguous rewrite selection"):
            analysis.run_analysis("rewrite", p, bridge, lambda _: None, lambda: False)
    assert len(calls) == 1
