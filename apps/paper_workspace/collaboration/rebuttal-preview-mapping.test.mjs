import {test} from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'esbuild'
import {chromium} from 'playwright'

test('preview maps quoted paragraphs and escaped entities to Markdown and restores the exact end', async () => {
  const {outputFiles:[bundle]} = await build({
    entryPoints:[fileURLToPath(new URL('./response-preview.js',import.meta.url))],
    bundle:true,write:false,format:'iife',globalName:'Preview'
  })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setContent('<style>blockquote{margin:0} p{margin:0;white-space:pre-wrap} #host{height:42px;overflow:auto;font:16px/20px monospace}</style><div id="host"></div>')
    await page.addScriptTag({content:bundle.text})
    const mapped = await page.evaluate(() => {
      const source = 'Intro\r\n\r\n> First &amp; full\r\n> Second &#38; full\r\n>\r\n> **Nested &copy; emphasis**\r\n\r\nTail\n\n'
      const host = document.querySelector('#host')
      host.innerHTML = Preview.renderResponsePreview(source,{sourcePositions:true})
      const paragraph = host.querySelector('blockquote p')
      const expected = source.indexOf('Second')
      function sourceAt(node, local) {
        const saved = document.caretRangeFromPoint
        const savedPosition = document.caretPositionFromPoint
        const nativeRects = Range.prototype.getClientRects
        document.caretRangeFromPoint = () => ({startContainer:node,startOffset:local})
        document.caretPositionFromPoint = () => ({offsetNode:node,offset:local})
        Range.prototype.getClientRects = function() {
          return this.startContainer === node ? nativeRects.call(this) : []
        }
        try { return Preview.previewSourcePosition(host,source)?.position }
        finally {
          document.caretRangeFromPoint = saved
          document.caretPositionFromPoint = savedPosition
          Range.prototype.getClientRects = nativeRects
        }
      }
      Preview.previewScrollToPosition(host,expected,0,source)
      const text = paragraph.firstChild
      const actual = sourceAt(text,text.data.indexOf('full',text.data.indexOf('Second')))
      const nested = host.querySelector('blockquote strong')
      const nestedStart = Number(nested.dataset.sourceStart)
      const restored = Preview.previewScrollToPosition(host,source.length,0,source)
      return {
        actual, expected:source.indexOf('full',expected), nestedStart, expectedNested:source.indexOf('**Nested'),
        restored, scroll:host.scrollTop, maxScroll:host.scrollHeight-host.clientHeight,
        missing:Preview.previewScrollToPosition(document.createElement('div'),0,0,'')
      }
    })
    assert.equal(mapped.actual,mapped.expected)
    assert.equal(mapped.nestedStart,mapped.expectedNested)
    assert.equal(mapped.restored,true)
    assert.equal(mapped.scroll,mapped.maxScroll)
    assert.ok(mapped.scroll>0)
    assert.equal(mapped.missing,false)
  } finally {
    await browser.close()
  }
})
