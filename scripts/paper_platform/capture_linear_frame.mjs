// Local fixture only. Capture the frame independently of manuscript/review content.
import {chromium} from '../../apps/paper_workspace/collaboration/node_modules/playwright-core/index.mjs'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'

const phase = process.argv[2] || 'after'
if (!['before', 'after'].includes(phase)) throw Error('Expected before or after')
const out = resolve(process.env.PAPER_FRAME_OUTPUT || 'docs/paper-platform/design-refresh/live-frame', phase)
const baseURL = process.env.PAPER_E2E_URL || 'http://127.0.0.1:18191'
const widths = (process.env.PAPER_FRAME_WIDTHS || '320,390,1024,1600').split(',').map(Number)
const locales = (process.env.PAPER_FRAME_LOCALES || 'en,ko').split(',')
const pdf = readFileSync(process.env.PAPER_VISUAL_PDF || '/tmp/paper-design-compile/main.pdf')
mkdirSync(out, {recursive:true})
const browser = await chromium.launch()
const rows = []
try {
  for (const theme of ['light','dark']) for (const width of widths) for (const locale of locales) {
    const context = await browser.newContext({viewport:{width,height:1000},deviceScaleFactor:1,reducedMotion:'reduce',colorScheme:theme})
    try {
      await context.addInitScript(theme => {
        localStorage.setItem('paper-workspace-theme',theme)
        localStorage.setItem('collab-name','Frame review')
        localStorage.setItem('collab-name-user-set','1')
      },theme)
      await context.route('**/vendor/pdfjs/*.mjs',async route => {
        const response = await route.fetch()
        await route.fulfill({response,headers:{...response.headers(),'content-type':'text/javascript'}})
      })
      await context.route('**/api/compile',route => route.fulfill({json:{elapsed_ms:20,compile_id:'frame-visual-pdf',pdf_base64:pdf.toString('base64'),synctex_base64:''}}))
      await context.route('**/api/rebuttal/projects/**/state',route => route.fulfill({json:{revision:0,enabled:true,rounds:[],jobs:[]}}))
      await context.route('**/projects/index.json',route => route.fulfill({json:{projects:[{slug:'frame-paper',display_name_en:'A manuscript workspace for a long research project title',display_name_ko:'긴 연구 프로젝트 제목을 사용하는 논문 작업공간',description_en:'Write, review and prepare a manuscript for submission.',description_ko:'원고를 작성하고 검토하여 논문 제출을 준비합니다.',page_count:13}]}}))
      await context.route('**/api/backups/activity',route => route.fulfill({json:{projects:[{project_id:'frame-paper',actor:'DR',modified_at:'2026-10-26T00:00:00Z'}]}}))
      await context.route('**/api/backups/projects/*/assets',route => route.fulfill({json:{assets:[]}}))
      await context.route('**/api/backups/projects/*/snapshots',route => route.fulfill({json:{snapshots:[]}}))
      const page = await context.newPage()
      const errors=[]
      page.on('pageerror',error=>errors.push(error.message))
      const id = `${theme}-${width}-${locale}`
      for (const surface of ['writing','review','hub']) {
        if (surface === 'writing') {
          await page.goto(`${baseURL}/p/frame-${phase}-${id}?lang=${locale}`)
          await page.waitForFunction(() => workspaceReadyForCompile && !compileController)
          await page.locator('.pdf-page canvas').first().waitFor({state:'attached'})
        } else if (surface === 'review') {
          await page.locator('#open-rebuttal').click()
          await page.locator('#screen-nav button').first().waitFor()
        } else {
          await page.goto(`${baseURL}/hub.html?lang=${locale}`)
          await page.locator('.project-card').first().waitFor()
        }
        await page.evaluate(() => document.fonts.ready)
        await page.mouse.move(width-1,999)
        const metrics = await page.evaluate(() => {
          const selectors = {header:'.project-frame-header,.hub-page-header',brand:'.project-frame-brand,.hub-home',title:'.project-frame-title',main:'.project-frame-main,.hub-main',sidebar:'.project-frame-sidebar,.hub-topbar',nav:'.quick-nav-link[aria-current],#screen-nav button[aria-current],.hub-nav a',file:'.file.active',tabs:'.project-workspace-nav'}
          const box = e => {if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {x:r.x,y:r.y,width:r.width,height:r.height,font:s.font,lineHeight:s.lineHeight,padding:s.padding,border:s.borderWidth,radius:s.borderRadius,display:s.display}}
          return {language:document.documentElement.lang,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scale:visualViewport.scale},fonts:document.fonts.status,overflow:document.documentElement.scrollWidth-innerWidth,elements:Object.fromEntries(Object.entries(selectors).map(([name,selector]) => [name,box(document.querySelector(selector))])),frameRadius:getComputedStyle(document.documentElement).getPropertyValue('--frame-radius').trim(),headerSurface:(()=>{const e=document.querySelector('.project-frame-header');if(!e)return null;const s=getComputedStyle(e,'::before');return {inset:s.inset,radius:s.borderRadius,border:s.borderWidth}})()}
        })
        rows.push({theme,width,locale,surface,...metrics,errors:[...errors]})
        if(metrics.language!==locale) throw Error(`${surface}: expected ${locale}, rendered ${metrics.language}`)
        await page.screenshot({path:`${out}/${id}-${surface}.png`,animations:'disabled'})
        if(surface==='writing'&&process.env.PAPER_COMPONENT_CAPTURE==='1') {
          if(width<768)await page.locator('[data-focus=assistant]').click()
          else if(width===1024)await page.locator('#toggle-assistant').click()
          await page.evaluate(locale=>{
            const text=editorValue().slice(0,48)
            addCommentForSelection({file:state.current,start:0,end:text.length,text},locale==='ko'?'공동저자 검토 전에 이 문장의 근거와 표현을 확인해 주세요.':'Please check the evidence and wording before coauthor review.')
          },locale)
          for(const tab of ['assist','comments','sources','checks','tasks']) {
            await page.locator(`[data-tab=${tab}]`).click()
            await page.screenshot({path:`${out}/${id}-tool-${tab}.png`,animations:'disabled'})
          }
          await page.locator('[data-tab=assist]').click()
          await page.locator('.workspace-switcher').click()
          await page.locator('.workspace-project').first().waitFor()
          await page.screenshot({path:`${out}/${id}-project-menu.png`,animations:'disabled'})
          await page.keyboard.press('Escape')
        }
      }
    } finally {await context.close()}
  }
} finally {await browser.close()}
writeFileSync(`${out}/measurements.json`,JSON.stringify(rows,null,2)+'\n')
console.log(JSON.stringify({phase,states:rows.length,overflows:rows.filter(x => x.overflow>0).map(x => ({surface:x.surface,width:x.width,theme:x.theme,locale:x.locale,overflow:x.overflow}))}))
