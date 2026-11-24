import {test} from 'node:test'
import assert from 'node:assert/strict'
import {translatedReadingPosition as map} from '../static/rebuttal-reading-position.js'
const segments=[{source:'First paragraph.',text:'첫 번째 설명입니다.'},{source:'\n\n',text:'\n\n'},{source:'Repeated.',text:'반복 문단입니다.'},{source:'\n\n',text:'\n\n'},{source:'Repeated.',text:'반복 문단입니다.'}]
const english=segments.map(p=>p.source).join(''),korean=segments.map(p=>p.text).join(''),meta={source:english,translation:korean,segments}
test('ordered translation pairs keep repeated paragraphs distinct in both directions',()=>{
 const en=english.lastIndexOf('Repeated.'),ko=korean.lastIndexOf('반복')
 assert.equal(map(en,english,korean,meta),ko)
 assert.equal(map(ko,english,korean,meta,'ko'),en)
})
test('position inside a block follows that block rather than whole-document proportions',()=>{
 const en=english.lastIndexOf('Repeated.')+4,ko=korean.lastIndexOf('반복')
 const translated=map(en,english,korean,meta)
 assert.ok(translated>=ko&&translated<korean.length)
 assert.ok(Math.abs(map(translated,english,korean,meta,'ko')-en)<=1)
})
test('end positions map to the final block end',()=>{
 assert.equal(map(english.length,english,korean,meta),korean.length)
 assert.equal(map(korean.length,english,korean,meta,'ko'),english.length)
})
test('stale or edited translations are not used as trusted reading pairs',()=>{
 assert.equal(map(10,english+' changed',korean,meta),null)
 assert.equal(map(10,english,korean+' 수동 수정',meta),null)
 assert.equal(map(10,english,korean,null),null)
 assert.equal(map(NaN,english,korean,meta),null)
})
test('partial translation waits when the requested source has not arrived',()=>{
 const partial=segments.slice(0,2),text=partial.map(p=>p.text).join('')
 assert.equal(map(english.lastIndexOf('Repeated.'),english,text,{source:english,translation:text,segments:partial}),null)
 assert.equal(map(0,english,text,{source:english,translation:text,segments:partial}),0)
})
test('CRLF snapshots match normalized CodeMirror positions without modifying metadata',()=>{
 const original=structuredClone(meta);original.source=original.source.replaceAll('\n','\r\n');original.segments=original.segments.map(p=>({...p,source:p.source.replaceAll('\n','\r\n')}))
 const before=structuredClone(original)
 assert.equal(map(english.lastIndexOf('Repeated.'),english,korean,original),korean.lastIndexOf('반복'))
 assert.deepEqual(original,before)
})

test('end positions include unsegmented trailing whitespace in both languages',()=>{
  const english='Answer.\n\n', korean='답변입니다.\n', segments=[{source:'Answer.',text:'답변입니다.'}]
  const meta={source:english,translation:korean,segments}
  assert.equal(map(english.length,english,korean,meta),korean.length)
  assert.equal(map(korean.length,english,korean,meta,'ko'),english.length)
  assert.equal(map('Answer. Next.'.length,'Answer. Next.',korean,{...meta,source:'Answer. Next.'}),null)
})
