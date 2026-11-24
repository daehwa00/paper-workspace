import test from 'node:test'
import assert from 'node:assert/strict'
import {alignedResponseTranslation} from '../static/rebuttal-model.js'
const span=(text,quote)=>({quote,start:text.indexOf(quote),end:text.indexOf(quote)+quote.length})
test('aligns grounded, unchanged and unique sentence translations after unrelated edits',()=>{
  const en='First claim. Second claim.',ko='첫 번째 주장. 두 번째 주장.'
  const meta={source:en,translation:ko,segments:[{source:'First claim.',text:'첫 번째 주장.'},{source:'Second claim.',text:'두 번째 주장.'}]}
  assert.equal(alignedResponseTranslation(span(en,'First claim.'),en,ko,meta)?.text,'첫 번째 주장.')
  assert.equal(alignedResponseTranslation(span(en,'First claim. Second claim.'),en,ko,meta)?.text,ko)
  assert.equal(alignedResponseTranslation(span(en,'First claim.'),en+' Changed',ko,meta)?.text,'첫 번째 주장.')
  assert.equal(alignedResponseTranslation(span(en,'First claim.'),en,ko+' 변경',meta)?.text,'첫 번째 주장.')
  assert.equal(alignedResponseTranslation({quote:'Forged',start:0,end:6},en,ko,meta),null)
  assert.equal(alignedResponseTranslation(span(en,'First claim.'),en,ko,{...meta,segments:[...meta.segments,meta.segments[0]]}),null)
})
const english='First claim. Second claim.'
const korean='첫 번째 주장. 두 번째 주장.'
const metadata={source:english,translation:korean,segments:[{source:'First claim.',text:'첫 번째 주장.'},{source:'Second claim.',text:'두 번째 주장.'}]}
test('recomputes live offsets after inserting an unrelated introductory sentence',()=>{
  const en='New introduction. '+english,ko='새로운 소개. '+korean
  const result=alignedResponseTranslation(span(en,'Second claim.'),en,ko,metadata)
  assert.deepEqual(result,{start:ko.indexOf('두 번째 주장.'),end:ko.length,text:'두 번째 주장.'})
})
test('adding Markdown headings preserves unchanged sentence pairs',()=>{
  const en='## Response\n'+english,ko='## 답변\n'+korean
  assert.equal(alignedResponseTranslation(span(en,'First claim.'),en,ko,metadata)?.text,'첫 번째 주장.')
})
test('changing one sentence preserves the other connection in either language',()=>{
  const en=english.replace('First claim.','Updated first claim.')
  const ko=korean.replace('첫 번째 주장.','수정된 첫 번째 설명.')
  assert.equal(alignedResponseTranslation(span(en,'Second claim.'),en,ko,metadata)?.text,'두 번째 주장.')
  assert.equal(alignedResponseTranslation(span(en,'Updated first claim.'),en,ko,metadata),null)
  assert.equal(alignedResponseTranslation(span(english,'First claim.'),english,ko,metadata),null)
})
test('rejects negation inserted before an otherwise identical sentence',()=>{
  const en='Not '+english,ko='사실이 아닌 '+korean
  assert.equal(alignedResponseTranslation(span(en,'First claim.'),en,korean,metadata),null)
  assert.equal(alignedResponseTranslation(span(english,'First claim.'),english,ko,metadata),null)
})
test('a fragment whose former sentence boundary changed is not reused',()=>{
  const meta={source:'First claim',translation:'첫 주장',segments:[{source:'First claim',text:'첫 주장'}]}
  assert.equal(alignedResponseTranslation(span('First claim is false','First claim'),'First claim is false','첫 주장',meta),null)
  assert.equal(alignedResponseTranslation(span('First claim','First claim'),'First claim','첫 주장이 아니다',meta),null)
})
test('pairs must be unique in both the saved snapshot and current text',()=>{
  assert.equal(alignedResponseTranslation(span(english,'First claim.'),english,korean+' 첫 번째 주장.',metadata),null)
  const repeated={...metadata,source:'First claim. '+english}
  assert.equal(alignedResponseTranslation(span(english,'First claim.'),english,korean,repeated),null)
  assert.equal(alignedResponseTranslation(span(english,'First claim.'),english,korean,{...metadata,translation:korean+' 첫 번째 주장.'}),null)
})
test('does not trust segment pairs absent from the recorded translation snapshot',()=>{
  const forged={source:'Different source.',translation:'다른 번역.',segments:metadata.segments}
  assert.equal(alignedResponseTranslation(span(english,'First claim.'),english,korean,forged),null)
  assert.equal(alignedResponseTranslation(span(english,'First claim.'),english,korean,null),null)
})
test('multi-sentence mappings do not absorb newly inserted or reordered Korean content',()=>{
  const ko='첫 번째 주장. 새로 삽입된 설명. 두 번째 주장.'
  assert.equal(alignedResponseTranslation(span(english,english),english,ko,metadata),null)
  assert.equal(alignedResponseTranslation(span(english,'First claim.'),english,ko,metadata)?.text,'첫 번째 주장.')
  assert.equal(alignedResponseTranslation(span(english,english),english,'두 번째 주장. 첫 번째 주장.',metadata),null)
})
test('verified relative anchors continue to resolve shifted source positions',()=>{
  const en='Introduction. '+english,originalSpan={...span(english,'First claim.'),anchorRelative:'anchor',headRelative:'head'}
  const start=en.indexOf(originalSpan.quote)
  assert.equal(alignedResponseTranslation(originalSpan,en,korean,metadata,()=>[start,start+originalSpan.quote.length])?.text,'첫 번째 주장.')
  assert.equal(alignedResponseTranslation(originalSpan,en,korean,metadata,()=>null),null)
})
test('aligns table rows only through unique exact stable identifiers',()=>{
  const en='| Variant | Value | Count |\n| Phase (P) | [P] | [P-M] |\n| Pool (G) | [G] | [G-M] |'
  const ko='| 종류 | 값 | 개수 |\n| 위상 (P) | [P] | [P-M] |\n| 풀링 (G) | [G] | [G-M] |'
  const q='| Phase (P) | [P] | [P-M] |',meta={source:en,translation:ko,segments:[]}
  assert.equal(alignedResponseTranslation(span(en,q),en,ko,meta)?.text,'| 위상 (P) | [P] | [P-M] |')
  const duplicate=ko+'\n| 중복 | [P] | [P-M] |'
  assert.equal(alignedResponseTranslation(span(en,q),en,duplicate,{...meta,translation:duplicate}),null)
  assert.equal(alignedResponseTranslation(span(en,q),en+'\nUnrelated note.',ko+'\n별도 설명.',meta)?.text,'| 위상 (P) | [P] | [P-M] |')
  assert.equal(alignedResponseTranslation(span(en,q),en,ko.replace('위상 (P)','다른 값 (P)'),meta),null)
  const changed=en.replace('Phase (P)','Changed phase (P)')
  assert.equal(alignedResponseTranslation(span(changed,'| Changed phase (P) | [P] | [P-M] |'),changed,ko,meta),null)
})
