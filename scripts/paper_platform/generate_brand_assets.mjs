// Render distribution-sized icons from the approved SVG; no network or product data.
import {chromium} from '../../apps/paper_workspace/collaboration/node_modules/playwright-core/index.mjs'
import {readFileSync,mkdtempSync,rmSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'

const root=resolve(import.meta.dirname,'../..')
const assets=join(root,'apps/paper_workspace/static/assets')
const staticRoot=join(root,'apps/paper_workspace/static')
const temporary=mkdtempSync(join(tmpdir(),'paper-folio-'))
const svg=name=>'data:image/svg+xml;base64,'+readFileSync(join(assets,name)).toString('base64')
const browser=await chromium.launch()
try {
  const page=await browser.newPage({viewport:{width:512,height:512},deviceScaleFactor:1})
  await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;background:transparent}.icon{width:512px;height:512px;border-radius:112px;background:#202124}.icon img{width:100%;height:100%}</style><div class="icon"><img src="${svg('paper-folio-dark.svg')}"></div>`)
  await page.screenshot({path:join(temporary,'icon.png'),omitBackground:true})
  await page.setViewportSize({width:180,height:180})
  await page.setContent(`<style>body{margin:0;background:#202124}img{width:180px;height:180px}</style><img src="${svg('paper-folio-dark.svg')}">`)
  await page.screenshot({path:join(staticRoot,'apple-touch-icon.png')})
  await page.setViewportSize({width:1200,height:630})
  await page.setContent(`<style>body{margin:0;background:#101113;color:#aaaab0;font-family:Arial,sans-serif}.preview{width:1200px;height:630px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:30px}.preview img{width:540px;height:auto}.preview p{font-size:24px;letter-spacing:.01em;margin:0}</style><div class="preview"><img src="${svg('paper-folio-wordmark-dark.svg')}"><p>Write, review, and collaborate.</p></div>`)
  await page.screenshot({path:join(assets,'share-preview-v3.png')})
  execFileSync('python3',['-c',String.raw`
from PIL import Image
from pathlib import Path
import sys
source=Image.open(sys.argv[1]).convert('RGBA')
assets=Path(sys.argv[2]); root=Path(sys.argv[3])
small=source.resize((64,64),Image.Resampling.LANCZOS)
small.save(assets/'favicon-64.png')
small.save(assets/'favicon.png')
source.save(root/'favicon.ico',format='ICO',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64)])
`,join(temporary,'icon.png'),assets,staticRoot])
} finally {await browser.close();rmSync(temporary,{recursive:true,force:true})}
console.log('Rendered favicon, touch icon and social preview from approved Folio SVGs.')
