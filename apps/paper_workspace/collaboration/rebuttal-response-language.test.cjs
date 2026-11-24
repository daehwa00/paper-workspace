const {test} = require('node:test')
const assert = require('node:assert/strict')
const {readFile} = require('node:fs/promises')
const {resolve} = require('node:path')
async function moduleUnderTest() {
  const source = await readFile(resolve(__dirname, '../static/rebuttal-response-language.js'), 'utf8')
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}
test('aligns unique passages only while both language versions match', async () => {
  const {translatedResponseRange, responseLanguageState} = await moduleUnderTest()
  const input = {source:'First. Second.', translation:'첫째. 둘째.', alignedSource:'First. Second.', alignedTranslation:'첫째. 둘째.', segments:[{source:'First.',text:'첫째.'},{source:'Second.',text:'둘째.'}]}
  assert.deepEqual(translatedResponseRange(input, 'Second.'), {start:4,end:7,quote:'둘째.'})
  assert.equal(translatedResponseRange({...input, source:'First. Changed.'}, 'First.'), null)
  assert.equal(translatedResponseRange({...input, translation:'수정됨'}, 'First.'), null)
  assert.equal(responseLanguageState({...input, source:'edited'}).sourceChanged, true)
})
test('rejects ambiguous duplicate passages and unaligned segments', async () => {
  const {translatedResponseRange} = await moduleUnderTest()
  const input = {source:'Repeat. Repeat.', translation:'반복. 반복.', alignedSource:'Repeat. Repeat.', alignedTranslation:'반복. 반복.', segments:[{source:'Repeat.',text:'반복.'}]}
  assert.equal(translatedResponseRange(input, 'Repeat.'), null)
  assert.equal(translatedResponseRange({...input, source:'Repeat.', alignedSource:'Repeat.'}, 'Repeat.'), null)
})
