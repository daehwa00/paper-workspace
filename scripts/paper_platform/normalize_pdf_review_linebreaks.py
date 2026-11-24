#!/usr/bin/env python3
"""One-time cleanup of PDF hard wraps with exact source-span remapping.

Run in dry-run mode first; --apply requires an explicit private SQLite backup.
Only existing PDF-derived review fields are changed. The PDF source and prior
source revisions remain intact. All matching source anchors are remapped in the
same SQLite transaction; ambiguous anchors abort the whole operation.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import re
import secrets
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

try:
    from pdf_linebreaks import normalize
except ModuleNotFoundError:
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from apps.paper_workspace.rebuttal.pdf_linebreaks import normalize


def utf16_len(value):
    return len(value.encode('utf-16-le')) // 2


def remap_span(span, old, new, mapping):
    quote = span.get('quote')
    if not isinstance(quote, str) or not quote: raise ValueError('empty source quote')
    hits = [m.start() for m in re.finditer(re.escape(quote), old)]
    supplied = span.get('start')
    candidates = [p for p in hits if utf16_len(old[:p]) == supplied]
    if len(candidates) == 1: start = candidates[0]
    elif len(hits) == 1: start = hits[0]
    else: raise ValueError('source quote missing or ambiguous')
    end = start + len(quote)
    if mapping[start] is None or mapping[end] is None: raise ValueError('source quote boundary falls inside whitespace being joined')
    new_start, new_end = mapping[start], mapping[end]
    updated = new[new_start:new_end]
    if not updated: raise ValueError('source quote became empty')
    span['quote'] = updated
    span['start'] = utf16_len(new[:new_start])
    span['end'] = utf16_len(new[:new_end])


def clean_state(state):
    state = copy.deepcopy(state)
    stats = {'reviews':0,'fields':0,'joined_linebreaks':0,'remapped_spans':0}
    for round_ in state.get('rounds', []):
        imports = {item.get('id'):item for item in round_.get('imports', [])}
        targets = [review for review in round_.get('reviews', []) if imports.get(review.get('source_id'), {}).get('kind') == 'pdf' and review.get('extraction', {}).get('parser') == 'openreview-print-v1']
        updates = {}
        for review in targets:
            old_fields = review.get('fields', {})
            new_fields = dict(old_fields)
            for field, old in old_fields.items():
                if not isinstance(old, str): raise ValueError('review field is not text')
                new, mapping, count = normalize(old)
                if count and new != old:
                    new_fields[field] = new
                    updates[(review['id'], field)] = (old, new, mapping)
                    stats['fields'] += 1; stats['joined_linebreaks'] += count
            if new_fields != old_fields:
                revisions = review.setdefault('source_revisions', [])
                if not any(item.get('fields') == old_fields for item in revisions):
                    revisions.append({'id':secrets.token_hex(16),'fields':copy.deepcopy(old_fields),'source_id':review.get('source_id'),'origin':'before_pdf_wrap_cleanup','created_at':datetime.now(timezone.utc).isoformat()})
                revisions.append({'id':secrets.token_hex(16),'fields':copy.deepcopy(new_fields),'source_id':review.get('source_id'),'origin':'pdf_wrap_cleanup','created_at':datetime.now(timezone.utc).isoformat()})
                review['fields'] = new_fields
                stats['reviews'] += 1
        for concern in round_.get('concerns', []):
            for span in concern.get('source_spans', []):
                key = (span.get('review_id'), span.get('field'))
                if key in updates:
                    remap_span(span, *updates[key]); stats['remapped_spans'] += 1
    return state, stats


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--db', required=True)
    p.add_argument('--apply', action='store_true')
    p.add_argument('--backup', help='New SQLite backup path; mandatory with --apply')
    args=p.parse_args()
    if args.apply and not args.backup: p.error('--apply requires --backup')
    os.umask(0o077)
    db=sqlite3.connect(args.db, timeout=15)
    db.execute('PRAGMA busy_timeout=15000')
    try:
        db.execute('BEGIN IMMEDIATE' if args.apply else 'BEGIN')
        rows=db.execute('SELECT id,revision,state FROM projects').fetchall()
        if len(rows)!=1: raise ValueError('expected exactly one project; refusing broad modification')
        if db.execute("SELECT count(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]: raise ValueError('an analysis is running; refusing to change its source')
        project,revision,raw=rows[0]
        state=json.loads(raw)
        if state.get('revision')!=revision: raise ValueError('revision mismatch')
        cleaned,stats=clean_state(state)
        if args.apply and stats['fields']:
            path=Path(args.backup)
            fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
            try:
                with sqlite3.connect(f'file:{args.db}?mode=ro',uri=True) as original, sqlite3.connect(path) as backup: original.backup(backup)
            except BaseException:
                path.unlink(missing_ok=True);raise
            cleaned['revision']=revision+1
            encoded=json.dumps(cleaned,ensure_ascii=False,separators=(',',':'),allow_nan=False)
            if len(encoded.encode())>8_000_000: raise ValueError('project state size limit exceeded')
            db.execute('UPDATE projects SET revision=?,state=? WHERE id=? AND revision=?',(revision+1,encoded,project,revision))
            if db.execute('SELECT changes()').fetchone()[0]!=1: raise ValueError('concurrent project change')
            db.commit()
        else: db.rollback()
        print(json.dumps({'applied':bool(args.apply and stats['fields']),**stats}))
    except BaseException:
        db.rollback();raise
    finally: db.close()

if __name__=='__main__': main()
