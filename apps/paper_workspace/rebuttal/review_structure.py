"""Lossless source preservation, deterministic structure for printed OpenReview pages.

This is document parsing, not LLM analysis. Original text/pages remain in the
import source; only the proposed review records are split here.
"""
from __future__ import annotations

import re

VERSION = 'openreview-print-v1'
_OFFICIAL = r'(?:Official|O!cial|Oﬃcial|Oﬀicial)'
_HEADER = re.compile(
    rf'^[ \t]*(?P<kind>{_OFFICIAL}[ \t]+(?:Review|Comment)|AI[ \t]+Review)'
    r'[ \t]+by[ \t]+(?P<author>[^\n\r]+)', re.M | re.I,
)
_FIELDS = {
    'paper summary': 'Paper Summary', 'summary': 'Summary',
    'strengths': 'Strengths', 'weaknesses': 'Weaknesses',
    'justification of recommendation': 'Justification of Recommendation',
    'specific points of feedback for rebuttal': 'Specific Points of Feedback for Rebuttal',
    'questions': 'Questions', 'questions for authors': 'Questions for Authors',
    'rating': 'Rating', 'recommendation': 'Recommendation', 'confidence': 'Confidence',
    'soundness': 'Soundness', 'presentation': 'Presentation', 'contribution': 'Contribution',
    'limitations': 'Limitations', 'review': 'Review', 'comment': 'Comment',
}
_FIELD = re.compile(r'^[ \t]*(?P<field>' + '|'.join(re.escape(k) for k in sorted(_FIELDS, key=len, reverse=True)) + r'):[ \t]*(?P<inline>[^\r\n]*)', re.M | re.I)
_NOTE = re.compile(r'Revisions\s*\(/revisions\?id=([A-Za-z0-9_-]+)\)')
_UI_ACTION = re.compile(
    r'^[ 	]*(?:Add:[ 	]*(?:Author Response|Withdrawal|Confidential Comment))(?:[ 	]+(?:Author Response|Withdrawal|Confidential Comment))*[ 	]*\r?$',
    re.M | re.I,
)
_UI_FOOTER = re.compile(
    r'^[ \t]*(?P<label>About OpenReview|OpenReview Homepage)'
    r'(?:[ \t]+(?P<link>\((?:/|https?://openreview\.net)[^)\r\n]*\)))?[ \t]*\r?$',
    re.M | re.I,
)


def _ui_cutoff(body, sections, last_record):
    # UI controls may occur between records. Footer links should occur in the
    # suffix of the final record, after its last named field.
    if action := _UI_ACTION.search(body, sections[-1].end()):
        return action.start()
    if last_record:
        markers = list(_UI_FOOTER.finditer(body, sections[-1].end()))
        if markers:
            first = last = markers[-1]
            labels = {last['label'].lower()}
            for marker in reversed(markers[:-1]):
                if body[marker.end():first.start()].strip():
                    break
                first = marker
                labels.add(marker['label'].lower())
            if len(labels) > 1:
                return first.start()
            # A lone navigation label needs an explicit link or a separated
            # end-of-document block to distinguish it from review prose.
            separator = body[:first.start()].replace('\r\n', '\n').endswith('\n\n')
            if not body[last.end():].strip() and (first['link'] or separator):
                return first.start()
    return len(body)


def _author(value):
    # Printed UI icons and timestamps follow the actual reviewer pseudonym.
    value = re.split(r'[\ue000-\uf8ff]|\s{2,}\d{1,2}\s+[A-Za-z]{3,9}\s+20\d{2}', value, maxsplit=1)[0]
    return value.strip().rstrip('(').strip()


def _page_at(position, source, pages):
    if '\f' in source:
        return source.count('\f', 0, position) + 1
    if pages and source == '\n\n'.join(p['text'] for p in pages):
        offset = 0
        for page in pages:
            end = offset + len(page['text'])
            if position <= end:
                return page['page']
            offset = end + 2
        return pages[-1]['page']
    return None


def structure_reviews(source, pages=None):
    """Return proposed records + recognizer summary, or None for ordinary text.

    Require a real named field near every recognized header. A quoted header or
    prose mentioning OpenReview must not cause partial source loss.
    """
    matches = list(_HEADER.finditer(source))
    if not matches:
        return None
    records = []
    for index, header in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(source)
        body = source[header.end():end]
        sections = list(_FIELD.finditer(body))
        if not sections or sections[0].start() > 1600:
            return None
        cutoff = _ui_cutoff(body, sections, index == len(matches) - 1)
        if cutoff < len(body):
            body = body[:cutoff]
            sections = list(_FIELD.finditer(body))
        if not sections:
            return None
        fields = {}
        for field_index, section in enumerate(sections):
            stop = sections[field_index + 1].start() if field_index + 1 < len(sections) else len(body)
            content_start = section.start('inline')
            content = body[content_start:stop].strip()
            name = _FIELDS[section['field'].lower()]
            if content:
                fields[name] = (fields[name] + '\n\n' + content) if name in fields else content
        if not fields:
            return None
        kind = header['kind'].lower()
        source_type = 'ai_review' if kind.startswith('ai') else 'comment' if 'comment' in kind else 'official_review'
        note = _NOTE.search(body[:sections[0].start()])
        record = {
            'reviewer_id': _author(header['author']), 'fields': fields,
            'source_type': source_type, 'suggested_include': source_type == 'official_review',
            'extraction': {'parser': VERSION, 'start_page': _page_at(header.start(), source, pages),
                           'end_page': _page_at(max(header.start(), end - 1), source, pages)},
        }
        if not record['reviewer_id']:
            return None
        if note:
            record['note_id'] = note[1]
        records.append(record)
    counts = {name: sum(r['source_type'] == name for r in records) for name in ('official_review', 'ai_review', 'comment')}
    # Keep administrative-only pages as plain text rather than claiming a review parse.
    if not counts['official_review'] and not counts['ai_review']:
        return None
    return {'reviews': records, 'structure': {'parser': VERSION, **counts, 'record_count': len(records),
                                            'suggested_count': sum(r['suggested_include'] for r in records)}}
