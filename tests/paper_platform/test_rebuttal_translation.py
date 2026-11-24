from __future__ import annotations

from copy import deepcopy

import pytest

from apps.paper_workspace.rebuttal import translation


def payload(source, **extra):
    return {"reviews": [{"id": "r1", "reviewer_id": "reviewer1", "fields": {"review": source}}],
            "glossary": {}, **extra}


class Translator:
    def __init__(self):
        self.calls = []
        self.cache = {}
        self.progress = []

    def bridge(self, task, request, profile):
        assert task == "translate_block"
        assert request["phase"] == "translate_block"
        assert request["documents"] == request["concerns"] == []
        assert len(request["reviews"]) == 1
        self.calls.append((deepcopy(request), profile))
        source, = request["reviews"][0]["fields"].values()
        if source.startswith(("```", "~~~")):
            return {"text": source}
        return {"text": "한국어 " + source}

    def run(self, source, *, profile=None, glossary=None, **kwargs):
        return translation.run_translation(
            payload(source, glossary=glossary or {}), self.bridge, self.progress.append,
            kwargs.pop("cancelled", lambda: False), profile=profile,
            cache_get=self.cache.get, cache_put=self.cache.__setitem__, **kwargs,
        )["translations"][0]


def test_only_edited_paragraph_calls_model_again():
    runner = Translator()
    runner.run("First paragraph.\n\nSecond paragraph.\n\nThird paragraph.")
    result = runner.run("First paragraph.\n\nEdited paragraph.\n\nThird paragraph.")
    assert len(runner.calls) == 4
    assert runner.calls[-1][0]["reviews"][0]["fields"] == {"review": "Edited paragraph."}
    assert result["text"] == "한국어 First paragraph.\n\n한국어 Edited paragraph.\n\n한국어 Third paragraph."


def test_paragraph_insertion_and_deletion_reuse_unchanged_sources():
    runner = Translator()
    runner.run("First paragraph.\n\nLast paragraph.")
    inserted = runner.run("First paragraph.\n\nInserted paragraph.\n\nLast paragraph.")
    deleted = runner.run("Last paragraph.")
    assert len(runner.calls) == 3
    assert "Inserted paragraph." in inserted["text"]
    assert deleted["text"] == "한국어 Last paragraph."


def test_duplicate_paragraphs_reuse_one_call_without_removing_occurrences():
    runner = Translator()
    source = "Repeated paragraph.\n\nRepeated paragraph.\n\nFinal paragraph."
    result = runner.run(source)
    assert len(runner.calls) == 2
    assert result["text"].count("한국어 Repeated paragraph.") == 2
    assert "".join(segment["source"] for segment in result["segments"]) == source
    assert runner.progress[-1]["completed"] == runner.progress[-1]["total"] == 3


def test_cache_is_independent_of_review_ids_and_field_names():
    runner = Translator()
    first = runner.run("Same paragraph.")
    p = {"reviews": [{"id": "different", "reviewer_id": "other", "fields": {"response": "Same paragraph."}}]}
    result = translation.run_translation(p, runner.bridge, runner.progress.append, lambda: False,
                                         cache_get=runner.cache.get)["translations"][0]
    assert len(runner.calls) == 1
    assert (result["review_id"], result["field"]) == ("different", "response")
    assert result["text"] == first["text"]


def test_glossary_profile_and_engine_version_separate_cache(monkeypatch):
    runner = Translator()
    runner.run("Same paragraph.", profile="light")
    runner.run("Same paragraph.", profile="medium")
    runner.run("Same paragraph.", profile="light", glossary={"term": "용어"})
    runner.run("Same paragraph.", profile="light", glossary={"term": "용어"})
    monkeypatch.setattr(translation, "VERSION", "next-version")
    runner.run("Same paragraph.", profile="light", glossary={"term": "용어"})
    assert len(runner.calls) == 4
    assert len(runner.cache) == 4
    assert all(len(key) == 64 for key in runner.cache)


def test_cached_suffix_is_resolved_before_calls_but_hidden_until_prefix_ready():
    runner = Translator()
    runner.run("Cached suffix.")
    runner.progress.clear()
    events = []

    def cache_get(key):
        events.append("cache")
        return runner.cache.get(key)

    def bridge(*args):
        events.append("model")
        assert runner.progress[0]["translations"][0]["text"] == ""
        assert runner.progress[0]["completed"] == 1
        return runner.bridge(*args)

    result = translation.run_translation(payload("New prefix.\n\nCached suffix."), bridge, runner.progress.append,
                                         lambda: False, cache_get=cache_get)
    assert events == ["cache", "cache", "model"]
    assert runner.progress[-1]["translations"] == result["translations"]
    assert runner.progress[-1]["completed"] == runner.progress[-1]["total"] == 2
    assert runner.progress[0]["translations"][0]["text"] == ""


def test_progress_snapshots_are_independent_and_follow_source_order():
    runner = Translator()
    result = runner.run("First paragraph.\n\nSecond paragraph.\n\nThird paragraph.")
    texts = [event["translations"][0]["text"] for event in runner.progress]
    assert texts[0] == ""
    assert texts[1] == "한국어 First paragraph.\n\n"
    assert texts[2] == "한국어 First paragraph.\n\n한국어 Second paragraph.\n\n"
    assert texts[-1] == result["text"]
    assert [event["completed"] for event in runner.progress] == [0, 1, 2, 3]


@pytest.mark.parametrize("invalid", [None, {}, {"text": 123}, {"text": ""}, {"text": "English only."},
                                    {"text": "中文翻译。"}, {"text": "한국어", "review_id": "wrong"},
                                    {"text": "가" * 600}])
def test_invalid_result_retries_only_failed_block_once(invalid):
    calls = []

    def bridge(task, request, profile):
        source = request["reviews"][0]["fields"]["review"]
        calls.append(source)
        if source == "Second paragraph.":
            return invalid
        return {"text": "첫 번째 문단입니다."}

    with pytest.raises(translation.AnalysisError):
        translation.run_translation(payload("First paragraph.\n\nSecond paragraph."), bridge, lambda _: None, lambda: False)
    assert calls == ["First paragraph.", "Second paragraph.", "Second paragraph."]


def test_validation_retry_can_recover_without_repeating_successful_block():
    calls = []
    phases = []

    def bridge(task, request, profile):
        source = request["reviews"][0]["fields"]["review"]
        calls.append(source)
        phases.append((request['phase'], request.get('validation_feedback')))
        return {"text": "English only." if len(calls) == 2 else "문단 번역입니다."}

    result = translation.run_translation(payload("First paragraph.\n\nSecond paragraph."), bridge, lambda _: None, lambda: False)
    assert calls == ["First paragraph.", "Second paragraph.", "Second paragraph."]
    assert phases == [('translate_block', None), ('translate_block', None), ('translate_block_verify_quotes', 'translation')]
    assert result["translations"][0]["text"] == "문단 번역입니다.\n\n문단 번역입니다."


def test_short_output_and_invalid_cache_are_regenerated():
    runner = Translator()
    source = "This paragraph contains enough content to make a one word translation suspicious. " * 3
    key = translation._cache_key(source.strip(), {}, None)
    runner.cache[key] = "한국어"
    result = runner.run(source)
    assert len(runner.calls) == 1
    assert runner.cache[key] == result["text"].strip()


def test_bridge_failure_is_not_retried():
    calls = []

    def bridge(*args):
        calls.append(args)
        raise RuntimeError("bridge unavailable")

    with pytest.raises(RuntimeError, match="bridge unavailable"):
        translation.run_translation(payload("Paragraph."), bridge, lambda _: None, lambda: False)
    assert len(calls) == 1


@pytest.mark.parametrize("source", ["", " \t\r\n  ", " " * 9000])
def test_empty_fields_do_not_call_model_and_preserve_whitespace(source):
    def unexpected(*args):
        pytest.fail("empty fields must not call model or cache")

    events = []
    result = translation.run_translation(payload(source), unexpected, events.append, lambda: False, cache_get=unexpected)
    assert result["translations"][0]["text"] == source
    assert events[-1]["total"] == events[-1]["completed"] == 0


def test_cancellation_before_start_and_after_model_prevents_cache_and_progress():
    runner = Translator()
    with pytest.raises(translation.AnalysisCancelled):
        runner.run("Paragraph.", cancelled=lambda: True)
    assert not runner.calls and not runner.progress
    cancelled = False

    def bridge(*args):
        nonlocal cancelled
        cancelled = True
        return runner.bridge(*args)

    with pytest.raises(translation.AnalysisCancelled):
        translation.run_translation(payload("Paragraph."), bridge, runner.progress.append, lambda: cancelled,
                                    cache_put=runner.cache.__setitem__)
    assert len(runner.calls) == 1
    assert len(runner.progress) == 1
    assert not runner.cache


def test_cancellation_from_progress_stops_before_next_block():
    runner = Translator()
    cancelled = False

    def progress(event):
        nonlocal cancelled
        if event["completed"]:
            cancelled = True

    with pytest.raises(translation.AnalysisCancelled):
        translation.run_translation(payload("First paragraph.\n\nSecond paragraph."), runner.bridge, progress, lambda: cancelled)
    assert len(runner.calls) == 1


@pytest.mark.parametrize("fence", ["```", "~~~~"])
def test_markdown_fences_math_and_exact_source_whitespace_are_preserved(fence):
    runner = Translator()
    source = (" \tIntroduction.\r\n \r\n" + fence + "python\nprint('a')\n\nprint('b')\n" + fence
              + "\n\nMath follows: $$\nx = y\n\nz = 1\n$$ and $a_b$ and \\(x+y\\).\n\n  Last paragraph.  ")
    result = runner.run(source)
    assert "".join(segment["source"] for segment in result["segments"]) == source
    assert "".join(segment["text"] for segment in result["segments"]) == result["text"]
    assert "\r\n \r\n" in result["text"]
    assert result["text"].startswith(" \t한국어 Introduction.") and result["text"].endswith("  ")
    sources = [next(iter(request["reviews"][0]["fields"].values())) for request, _ in runner.calls]
    assert any("print('a')\n\nprint('b')" in block for block in sources)
    assert any("x = y\n\nz = 1" in block for block in sources)


@pytest.mark.parametrize("source", ["```python\n# English comment\nvalue = 1\n```", "~~~\nEnglish code\n~~~", "$$x+y=1$$", "12345"])
def test_verbatim_technical_only_output_is_allowed(source):
    result = translation.run_translation(payload(source), lambda *args: {"text": source}, lambda _: None, lambda: False)
    assert result["translations"][0]["text"] == source


def test_model_cannot_change_math_or_code():
    calls = []

    def bridge(*args):
        calls.append(args)
        return {"text": "이 수식은 $x=2$입니다."}

    with pytest.raises(translation.AnalysisError, match="code or math changed"):
        translation.run_translation(payload("This formula is $x=1$."), bridge, lambda _: None, lambda: False)
    assert len(calls) == 2


@pytest.mark.parametrize("source,translated", [
    (r"For a projector $P$ satisfying $X_{\mathrm{detail}}P=X_{\mathrm{detail}}$,",
     r"$X_{\mathrm{detail}}P=X_{\mathrm{detail}}$를 만족하는 프로젝터 $P$에 대해,"),
    ("Call `apply` on `value`.", "`value`에 `apply`를 호출합니다."),
    ("$x$ matches $y$, and $x$ is retained.", "$y$와 같은 $x$이며, $x$는 유지됩니다."),
])
def test_korean_word_order_can_move_unchanged_inline_math_and_code(source, translated):
    calls = []

    def bridge(*args):
        calls.append(args)
        return {"text": translated}

    result = translation.run_translation(payload(source), bridge, lambda _: None, lambda: False)
    assert result["translations"][0]["text"] == translated
    assert len(calls) == 1


@pytest.mark.parametrize("source,translated", [
    ("Compare $x$ and $x$.", "$x$를 비교합니다."),
    ("Compare $x$ and $y$.", "$y$와 $x$ 그리고 $x$를 비교합니다."),
    ("Call `apply` on `value`.", "`value`에 `update`를 호출합니다."),
    ("First:\n$$x=1$$\nThen:\n$$y=2$$", "먼저:\n$$y=2$$\n다음:\n$$x=1$$"),
    ("First:\n```\nx=1\n```\nThen:\n```\ny=2\n```",
     "먼저:\n```\ny=2\n```\n다음:\n```\nx=1\n```"),
])
def test_inline_reordering_still_rejects_changed_counts_values_and_block_order(source, translated):
    with pytest.raises(translation.AnalysisError, match="code or math changed"):
        translation._validate_text(translated, source)


def test_long_paragraph_splits_at_safe_boundaries_without_overlap():
    runner = Translator()
    source = ("A useful complete sentence. " * 100 + "$" + "x" * 1800 + "$ and final explanation. ") * 2
    result = runner.run(source)
    parts = [segment["source"] for segment in result["segments"] if segment["source"].strip()]
    assert len(parts) > 2
    assert all(len(part) <= translation.MAX_BLOCK_CHARS for part in parts)
    assert all(part.count("$") % 2 == 0 for part in parts)
    assert "".join(segment["source"] for segment in result["segments"]) == source


def test_oversized_indivisible_protected_block_fails_before_model_call():
    runner = Translator()
    with pytest.raises(translation.AnalysisError, match="safe splitting limit"):
        runner.run("```\n" + "x" * 9000 + "\n```")
    assert not runner.calls


def test_snapshot_is_not_mutated_and_identity_validation_precedes_calls():
    runner = Translator()
    p = payload("Paragraph.")
    original = deepcopy(p)
    translation.run_translation(p, runner.bridge, runner.progress.append, lambda: False)
    assert p == original
    p["reviews"].append(deepcopy(p["reviews"][0]))
    with pytest.raises(translation.AnalysisError, match="Duplicate translation review ID"):
        translation.run_translation(p, runner.bridge, runner.progress.append, lambda: False)
    assert len(runner.calls) == 1


def test_timeout_recovers_only_uncached_block_and_keeps_model_profile():
    runner = Translator()
    runner.run('First paragraph.\n\nLast paragraph.', profile='chosen-profile')
    calls = []
    def bridge(task, request, profile):
        source = request['reviews'][0]['fields']['review']
        calls.append((source, profile))
        if len(calls) == 1:
            raise translation.UpstreamRequestError(422, 'model_timeout')
        return {'text': '추가한 문단의 번역입니다.'}
    events = []
    result = translation.run_translation(payload('First paragraph.\n\nNew paragraph.\n\nLast paragraph.'),bridge,events.append,lambda:False,profile='chosen-profile',cache_get=runner.cache.get,cache_put=runner.cache.__setitem__)
    assert calls == [('New paragraph.', 'chosen-profile')] * 2
    retry = next(event for event in events if event.get('retrying'))
    assert (retry['completed'], retry['total']) == (2, 3)
    assert events[-1]['completed'] == 3
    assert not events[-1].get('retrying')
    assert result['translations'][0]['text'] == '한국어 First paragraph.\n\n추가한 문단의 번역입니다.\n\n한국어 Last paragraph.'


@pytest.mark.parametrize('code,expected_calls', [('model_timeout',2),('model_auth_failed',1),('model_rate_limited',1),('bridge_busy',1)])
def test_upstream_recovery_is_bounded_and_does_not_retry_auth_or_quota(code,expected_calls):
    calls=[]
    def bridge(*args):
        calls.append(args)
        raise translation.UpstreamRequestError(422,code)
    with pytest.raises(translation.UpstreamRequestError) as raised:
        translation.run_translation(payload('A paragraph.'),bridge,lambda _:None,lambda:False)
    assert raised.value.code == code
    assert len(calls) == expected_calls


def test_cancelled_timeout_does_not_start_recovery():
    cancelled=False;calls=[]
    def bridge(*args):
        nonlocal cancelled
        calls.append(args);cancelled=True
        raise translation.UpstreamRequestError(422,'model_timeout')
    with pytest.raises(translation.AnalysisCancelled):
        translation.run_translation(payload('A paragraph.'),bridge,lambda _:None,lambda:cancelled)
    assert len(calls)==1


def test_timeout_retry_budget_is_not_reset_by_validation_repair():
    calls=[]
    def bridge(*args):
        calls.append(args)
        if len(calls)==2:return {'text':'English only.'}
        raise translation.UpstreamRequestError(422,'model_timeout')
    with pytest.raises(translation.UpstreamRequestError):
        translation.run_translation(payload('A paragraph.'),bridge,lambda _:None,lambda:False)
    assert len(calls)==3


def test_translation_deadline_preserves_large_blocks_and_other_analysis():
    import json, subprocess
    from pathlib import Path
    root=Path(__file__).parents[2]
    script="""import{rebuttalTimeoutMs}from'./apps/paper_workspace/codex_bridge/rebuttal.mjs';
const body=(task,size)=>({task,payload:{reviews:[{fields:{response:'a'.repeat(size)}}]}});
console.log(JSON.stringify([rebuttalTimeoutMs(body('translate_block',547)),rebuttalTimeoutMs(body('translate_block',8000)),rebuttalTimeoutMs(body('connect',547))]));"""
    assert json.loads(subprocess.check_output(['node','--input-type=module','-e',script],cwd=root,text=True))==[60000,120000,120000]
