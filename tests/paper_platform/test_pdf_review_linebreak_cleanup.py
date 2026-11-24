import importlib.util
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

ROOT=Path(__file__).resolve().parents[2]
PATH=ROOT/'scripts/paper_platform/normalize_pdf_review_linebreaks.py'
spec=importlib.util.spec_from_file_location('pdf_review_cleanup',PATH)
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)


def state():
    original='1. 😀 Please clarify the\n    baseline comparison.\n2. Report uncertainty.\n\nA separate paragraph.'
    quote='the\n    baseline comparison'
    start=mod.utf16_len(original[:original.index(quote)])
    return {'revision':1,'rounds':[{'imports':[{'id':'pdf','kind':'pdf'}], 'reviews':[{'id':'r','source_id':'pdf','fields':{'Weaknesses':original},'extraction':{'parser':'openreview-print-v1'},'source_revisions':[{'fields':{'Weaknesses':original}}]}], 'concerns':[{'id':'c','source_spans':[{'review_id':'r','field':'Weaknesses','quote':quote,'start':start,'end':start+mod.utf16_len(quote)}]}]}]}


def test_pdf_wraps_keep_lists_paragraphs_and_remap_utf16_anchors():
    before=state();after,stats=mod.clean_state(before)
    review=after['rounds'][0]['reviews'][0];span=after['rounds'][0]['concerns'][0]['source_spans'][0]
    assert review['fields']['Weaknesses']=='1. 😀 Please clarify the baseline comparison.\n2. Report uncertainty.\n\nA separate paragraph.'
    assert span['quote']=='the baseline comparison'
    assert span['start']==mod.utf16_len(review['fields']['Weaknesses'].split('the baseline')[0])
    assert review['source_revisions'][0]['fields']==before['rounds'][0]['reviews'][0]['fields']
    assert stats=={'reviews':1,'fields':1,'joined_linebreaks':1,'remapped_spans':1}
    assert mod.clean_state(after)[1]['fields']==0


def test_preserves_code_and_math_blocks():
    text='Text before.\n\n```\n  code\n  code2\n```\n\n$$\nx +\ny\n$$'
    assert mod.normalize(text)[0]==text


def test_ambiguous_quote_aborts_without_changing_original():
    original=state();r=original['rounds'][0];r['reviews'][0]['fields']['Weaknesses']='repeat\n  phrase repeat\n  phrase';r['concerns'][0]['source_spans'][0].update(quote='repeat',start=999)
    with pytest.raises(ValueError,match='ambiguous'):mod.clean_state(original)
    assert r['reviews'][0]['fields']['Weaknesses']=='repeat\n  phrase repeat\n  phrase'


def test_apply_creates_backup_and_updates_atomically(tmp_path):
    db=tmp_path/'source.db';backup=tmp_path/'backup.db';value=state()
    with sqlite3.connect(db) as c:
        c.execute('CREATE TABLE projects(id TEXT, revision INTEGER, state TEXT)');c.execute('CREATE TABLE jobs(status TEXT)')
        c.execute('INSERT INTO projects VALUES(?,?,?)',('p',1,json.dumps(value)))
    result=subprocess.run([sys.executable,str(PATH),'--db',str(db),'--apply','--backup',str(backup)],capture_output=True,text=True,check=True)
    assert json.loads(result.stdout)['applied'] is True
    with sqlite3.connect(db) as c: row=c.execute('SELECT revision,state FROM projects').fetchone()
    with sqlite3.connect(backup) as c: saved=c.execute('SELECT revision,state FROM projects').fetchone()
    assert row[0]==2 and saved[0]==1
    assert json.loads(saved[1])==value
    assert json.loads(row[1])['rounds'][0]['concerns'][0]['source_spans'][0]['quote']=='the baseline comparison'


def test_preserves_four_space_code_blocks_and_wraps_surrounding_prose():
    source = 'PDF prose wraps\nonto this line.\n\n    x = 1\n    print(x)\n\nAnother sentence\ncontinues here.'
    normalized, mapping, changes = mod.normalize(source)
    assert normalized == 'PDF prose wraps onto this line.\n\n    x = 1\n    print(x)\n\nAnother sentence continues here.'
    assert changes == 2
    assert mapping[source.index('print')] == normalized.index('print')
