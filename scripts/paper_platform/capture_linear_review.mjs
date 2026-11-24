import {chromium} from '../../apps/paper_workspace/collaboration/node_modules/playwright-core/index.mjs';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const artifacts = new URL('../../.omx/artifacts/linear-refresh/', import.meta.url);
mkdirSync(artifacts, {recursive:true});
const artifact = name => new URL(name, artifacts);
const spec=readFileSync(new URL('../../apps/paper_workspace/collaboration/tests/rebuttal.spec.js',import.meta.url),'utf8');
const seeded=Function(spec.slice(spec.indexOf('const fresh'),spec.indexOf('async function api'))+';return seeded')();
async function showScreen(page, screen) {
 const button=page.locator(`#screen-nav [data-screen="${screen}"]`);
 if(!await button.isVisible())await page.locator('#screen-nav .sidebar-advanced summary').click();
 await button.click();
}
const browser=await chromium.launch({headless:true});const phase=process.argv[2]||'attached';const results=[];
for(const scheme of ['light','dark']){
 const context=await browser.newContext({viewport:{width:1600,height:1000},deviceScaleFactor:1,reducedMotion:'reduce',colorScheme:scheme});
 await context.addInitScript(()=>{localStorage.setItem('collab-name','Test Author');localStorage.setItem('collab-name-user-set','1')});
 let state=seeded();await context.route('**/api/rebuttal/projects/**',async route=>{await route.fulfill({json:state})});
 const page=await context.newPage();await page.goto((process.env.PAPER_E2E_URL||'http://127.0.0.1:18080')+'/p/linear-rebuttal-'+phase+'-'+scheme+'/rebuttal?round=r1&lang=en#reviews');await page.waitForSelector('#response-editor .cm-content');await page.evaluate(()=>document.fonts.ready);
 for(const screen of ['overview','reviews','evidence','submission']){await showScreen(page,screen);await page.screenshot({path:artifact(`rebuttal-${phase}-${screen}-${scheme}.png`).pathname,fullPage:true,animations:'disabled'});}
 await showScreen(page,'overview');await page.locator('[data-action="rules"]').click();await page.waitForSelector('#form-dialog[open]');await page.screenshot({path:artifact(`rebuttal-${phase}-rules-${scheme}.png`).pathname,fullPage:true,animations:'disabled'});await page.locator('#dialog-close').click();
 for(const lang of ['en','ko']){await page.locator('#language').selectOption(lang);for(const width of [320,390,1024,1600]){await page.setViewportSize({width,height:900});for(const screen of ['overview','reviews','evidence','submission']){await showScreen(page,screen);results.push({scheme,lang,width,screen,...await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth}))});}if(lang==='ko')await page.screenshot({path:artifact(`rebuttal-${phase}-${width}-${scheme}.png`).pathname,fullPage:true,animations:'disabled'});}}
 state.rounds[0].title='장문의 검토 라운드 제목 · Long review round title with multiple words';
 state.rounds[0].reviewers[0].name='매우 긴 리뷰어 이름 · Reviewer with a long descriptive name';
 state.rounds[0].documents[0].title='긴 논문 답변 문서 제목 · Response to the reviewer with a long descriptive title';
 state.rounds[0].concerns[0].title='긴 우려 사항과 실험 결과의 신뢰 구간에 대한 상세한 검토 요청 · A detailed concern about baseline uncertainty and the reported results';
 await page.evaluate(()=>window.PaperRebuttal.refresh());
 for(const width of [320,390,1024,1600]){await page.setViewportSize({width,height:900});for(const screen of ['overview','reviews','evidence','submission']){await showScreen(page,screen);results.push({scheme,lang:'ko-long',width,screen,...await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth}))});}}
 await page.setViewportSize({width:1600,height:1000});await showScreen(page,'reviews');
 await page.locator('.concern-picker [data-action="select-concern"]').first().click();
 await page.screenshot({path:artifact(`rebuttal-${phase}-selected-${scheme}.png`).pathname,fullPage:true,animations:'disabled'});
 await page.screenshot({path:artifact(`rebuttal-${phase}-frame-${scheme}.png`).pathname,clip:{x:0,y:0,width:1600,height:205}});
 await page.locator('.screen-nav').screenshot({path:artifact(`rebuttal-${phase}-tabs-${scheme}.png`).pathname});
 if(['after','attached','precision'].includes(phase)){
 await showScreen(page,'overview');
 const metrics=await page.evaluate(()=>{const sample=selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect(),s=getComputedStyle(e);return {width:r.width,height:r.height,font:s.font,fontFamily:s.fontFamily,color:s.color,background:s.backgroundColor,border:s.borderRadius}};return {rail:sample('.app-header'),heading:sample('.workspace-heading'),button:sample('#new-round'),tabs:sample('.screen-nav'),fontLoaded:document.fonts.status}});
 await page.locator('#new-round').focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');metrics.focus=await page.locator('#new-round').evaluate(e=>({outline:getComputedStyle(e).outline,offset:getComputedStyle(e).outlineOffset}));
 await page.locator('[data-action="rules"]').click();await page.waitForSelector('#form-dialog[open]');await page.locator('[data-action="add-limit"]').click();
 await page.screenshot({path:artifact(`rebuttal-${phase}-rule-limit-${scheme}.png`).pathname,fullPage:true,animations:'disabled'});
 await page.setViewportSize({width:320,height:900});
 metrics.mobileDialog=await page.locator('#form-dialog').evaluate(e=>({width:e.getBoundingClientRect().width,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}));
 await page.screenshot({path:artifact(`rebuttal-${phase}-dialog-320-${scheme}.png`).pathname,fullPage:true,animations:'disabled'});
 await page.emulateMedia({reducedMotion:'reduce'});metrics.reducedMotion=await page.locator('#form-dialog').evaluate(e=>getComputedStyle(e).animationDuration);
 writeFileSync(artifact(`rebuttal-metrics-${scheme}.json`),JSON.stringify(metrics,null,2));
 }
 await context.close();
}
writeFileSync(artifact(`rebuttal-${phase}-layout.json`),JSON.stringify(results,null,2));await browser.close();console.log(JSON.stringify({phase,checks:results.length,overflows:results.filter(x=>x.overflow)}));
