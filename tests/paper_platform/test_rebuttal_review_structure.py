"""Printed-page fixtures are synthetic; private reviewer text is never committed."""
import base64
import copy

import pytest

from apps.paper_workspace.rebuttal.imports import prepare_import, reparse_staged_import, ValidationError
from apps.paper_workspace.rebuttal.review_structure import structure_reviews
from apps.paper_workspace.rebuttal.server import RebuttalStore


def printed_review(author, note, spelling='Official'):
    return f'''A short review title
{spelling} Review by Program Committee {author}    \ue109 22 Oct 2026 (modified: 24 Oct 2026)
 \ue105 Program Chairs, Authors   Revisions (/revisions?id={note})
Paper Summary:
Synthetic method summary.
Strengths:
1. A reproducible test.
Weaknesses:
1. Explain the first comparison.
2. Explain the second comparison.
Justification of Recommendation:
Evidence is needed.
Specific Points of Feedback for Rebuttal:
Q1. What changes between conditions?
Q2. How is variation measured?
Rating: 5: Borderline
Confidence: 4: Confident
                   Add: Author Response
'''


def printed_page():
    return ('OpenReview navigation\nAbstract: This is not a reviewer comment.\n'
            + '\n\n'.join(printed_review(f'R{i}', f'note{i}', 'O!cial' if i == 1 else 'Official') for i in range(1, 6))
            + '''\nPhase update\nO!cial Comment by Program Chairs    \ue109 25 Sep 2026
Revisions (/revisions?id=chairnote)
Comment:
The schedule is unchanged.
\nAI Review\nAI Review by AI Reviewer (\ue135 )    \ue109 27 Jul 2026
Revisions (/revisions?id=ainote)
Review:
This is an AI-authored observation.
''')


def test_printed_page_separates_human_reviews_ai_and_administration():
    source = printed_page()
    result = structure_reviews(source)
    assert result['structure'] == {'parser': 'openreview-print-v1', 'official_review': 5, 'ai_review': 1,
                                   'comment': 1, 'record_count': 7, 'suggested_count': 5}
    assert [r['reviewer_id'] for r in result['reviews'][:5]] == [f'Program Committee R{i}' for i in range(1, 6)]
    first = result['reviews'][0]
    assert first['note_id'] == 'note1'
    assert list(first['fields']) == ['Paper Summary', 'Strengths', 'Weaknesses', 'Justification of Recommendation', 'Specific Points of Feedback for Rebuttal', 'Rating', 'Confidence']
    assert first['fields']['Rating'] == '5: Borderline'
    assert first['fields']['Confidence'] == '4: Confident'
    assert not any('Abstract:' in field or 'Add: Author Response' in field for r in result['reviews'] for field in r['fields'].values())
    assert all(r['suggested_include'] == (r['source_type'] == 'official_review') for r in result['reviews'])


@pytest.mark.parametrize('spelling', ['Official', 'O!cial', 'Oﬃcial'])
def test_pdf_font_ligature_variants_and_page_continuations(spelling):
    source = printed_review('R1', 'note1', spelling).replace('2. Explain', '\f2. Explain')
    result = structure_reviews(source)
    assert len(result['reviews']) == 1
    assert '2. Explain the second comparison.' in result['reviews'][0]['fields']['Weaknesses']
    assert result['reviews'][0]['extraction']['start_page'] == 1
    assert result['reviews'][0]['extraction']['end_page'] == 2


def test_unrecognized_or_quoted_header_does_not_discard_original():
    for source in ['Ordinary reviewer text. $x+y$ remains intact.', 'Official Review by A reviewer\nThis line only mentions a UI header.']:
        assert structure_reviews(source) is None
        staged = prepare_import({'kind': 'text', 'text': source}, None)
        assert staged['raw']['text'] == source
        assert staged['reviews'][0]['fields']['review'] == source


def test_pdf_import_preserves_original_and_page_provenance_without_model_calls():
    pages = [{'page': 1, 'text': printed_review('R1', 'note1')}, {'page': 2, 'text': printed_review('R2', 'note2')}]
    source = '\n\n'.join(p['text'] for p in pages)
    pdf = b'%PDF-1.4\nsynthetic-pdf-extraction-is-injected'
    calls = []
    def compiler(path, payload):
        calls.append(path)
        return {'pages': pages, 'text': source}
    staged = prepare_import({'kind': 'pdf', 'filename': 'review.pdf', 'data_base64': base64.b64encode(pdf).decode()}, compiler)
    assert calls == ['/extract-review']
    assert staged['raw']['text'] == source
    assert base64.b64decode(staged['raw']['data_base64']) == pdf
    assert len(staged['reviews']) == 2
    assert staged['reviews'][1]['extraction']['start_page'] == 2


def test_pending_legacy_import_can_be_reparsed_without_losing_source_or_old_proposal():
    source = printed_page()
    staged = {'id': 'same-id', 'kind': 'pdf', 'status': 'staged', 'raw': {'text': source}, 'source_hash': 'unchanged', 'reviews': [{'fields': {'review': source}, 'reviewer_id': 'Reviewer 1'}]}
    original = copy.deepcopy(staged['raw'])
    reparse_staged_import(staged)
    assert staged['id'] == 'same-id' and staged['source_hash'] == 'unchanged' and staged['raw'] == original
    assert len(staged['reviews']) == 7 and len(staged['structure_revisions']) == 1
    reparse_staged_import(staged)
    assert len(staged['structure_revisions']) == 1
    staged['status'] = 'committed'
    with pytest.raises(ValidationError, match='pending'):
        reparse_staged_import(staged)


def test_restaging_and_committing_only_selected_official_reviews(tmp_path):
    store = RebuttalStore(tmp_path/'domain.sqlite3')
    state = store.create_round('project', {'title': 'Round', 'expected_revision': 0})
    rid = state['rounds'][0]['id']
    state = store.stage_import('project', rid, {'kind': 'text', 'text': printed_page(), 'expected_revision': state['revision']})
    source = state['result']['import']
    state = store.reparse_import('project', rid, source['id'], {'expected_revision': state['revision']})
    selected = [r for r in state['result']['import']['reviews'] if r['suggested_include']]
    state = store.commit_import('project', rid, source['id'], {'reviews': selected, 'expected_revision': state['revision']}, 'Author')
    assert len(state['rounds'][0]['reviews']) == 5
    assert all(r['source_type'] == 'official_review' for r in state['rounds'][0]['reviews'])
    assert state['jobs'] == []
    with pytest.raises(ValidationError, match='pending'):
        store.reparse_import('project', rid, source['id'], {'expected_revision': state['revision']})


def test_pdf_import_joins_wrapped_sentences_but_preserves_raw_and_structure():
    source = printed_review('R1', 'note1').replace(
        '1. Explain the first comparison.', '1. Explain the first\n   comparison.\n\nA separate paragraph.')
    pages = [{'page': 1, 'text': source}]
    pdf = b'%PDF-1.4\nsynthetic'
    staged = prepare_import({'kind': 'pdf', 'data_base64': base64.b64encode(pdf).decode()},
                            lambda *_: {'text': source, 'pages': pages})
    weaknesses = staged['reviews'][0]['fields']['Weaknesses']
    assert weaknesses == '1. Explain the first comparison.\n\nA separate paragraph.\n2. Explain the second comparison.'
    assert staged['raw']['text'] == source and staged['raw']['pages'] == pages
    assert base64.b64decode(staged['raw']['data_base64']) == pdf
    reparse_staged_import(staged)
    assert staged['reviews'][0]['fields']['Weaknesses'] == weaknesses
    assert not staged.get('structure_revisions')
    text_staged = prepare_import({'kind': 'text', 'text': source}, None)
    assert 'first\n   comparison' in text_staged['reviews'][0]['fields']['Weaknesses']


def test_unstructured_pdf_review_is_normalized_without_changing_raw():
    source = 'A sentence broken\n  across lines.\n\nA new paragraph.'
    staged = prepare_import({'kind': 'pdf', 'data_base64': base64.b64encode(b'%PDF-synthetic').decode()},
                            lambda *_: {'text': source, 'pages': [{'page': 1, 'text': source}]})
    assert staged['reviews'][0]['fields']['review'] == 'A sentence broken across lines.\n\nA new paragraph.'
    assert staged['raw']['text'] == source


def test_openreview_body_line_does_not_truncate_remaining_review():
    source = (
        'Official Review by Reviewer A\nWeaknesses:\n'
        'About OpenReview, the manuscript needs better baselines.\n'
        'About OpenReview\nPlease also report uncertainty.\n'
        '\nAbout OpenReview (/about)\nOpenReview Homepage (/)\n'
    )
    review = structure_reviews(source)['reviews'][0]
    assert review['fields']['Weaknesses'] == (
        'About OpenReview, the manuscript needs better baselines.\n'
        'About OpenReview\nPlease also report uncertainty.'
    )
