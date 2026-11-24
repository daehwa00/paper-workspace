// Actual password-gate HTML, isolated HTTP fixture; no login or remote mutation.
import {chromium} from '../../apps/paper_workspace/collaboration/node_modules/playwright-core/index.mjs';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(process.env.PAPER_AUTH_ROOT||resolve(import.meta.dirname,'../..')),phase=process.argv[2]||'after';
if(!['before','after'].includes(phase))throw Error('Expected before or after');
const pages=JSON.parse(execFileSync('python3',[resolve(root,'scripts/paper_platform/render_auth_fixtures.py'),phase],{maxBuffer:8*1024*1024}));
const output=process.env.PAPER_AUTH_OUTPUT||resolve(root,'.omx/artifacts/linear-refresh/remaining-login',phase);mkdirSync(output,{recursive:true});
const base=process.env.PAPER_E2E_URL||'http://127.0.0.1:18600',rows=[];
const browser=await chromium.launch();
try{
for(const mode of ['shared','accounts'])for(const theme of ['light','dark'])for(const lang of ['en','ko'])for(const width of [320,390,1024,1600]){
 const context=await browser.newContext({viewport:{width,height:width<768?844:1000},deviceScaleFactor:1,reducedMotion:'reduce'});
 await context.addInitScript(theme=>localStorage.setItem('paper-workspace-theme',theme),theme);
 await context.route('**/_auth/login**',route=>route.fulfill({contentType:'text/html',body:pages[`${mode}-${lang}-`]}));
 const page=await context.newPage();await page.goto(`${base}/_auth/login?lang=${lang}`);await page.evaluate(()=>document.fonts.ready);await page.mouse.move(0,0);
 const metrics=await page.evaluate(()=>{
  const box=selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect(),s=getComputedStyle(e);return {x:r.x,y:r.y,width:r.width,height:r.height,font:s.font,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,color:s.color,background:s.backgroundColor,border:s.border,borderRadius:s.borderRadius,boxShadow:s.boxShadow}};
  return {overflow:document.documentElement.scrollWidth>innerWidth,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scale:visualViewport.scale},fonts:document.fonts.status,background:getComputedStyle(document.body).backgroundColor,main:box('main'),logo:box('.mark'),heading:box('h1'),input:box('input'),button:box('button'),inputCount:document.querySelectorAll('input').length};
 });const record={mode,theme,lang,width,...metrics};rows.push(record);
 await page.screenshot({path:`${output}/${mode}-${theme}-${lang}-${width}.png`,animations:'disabled'});
 if(mode==='accounts'&&lang==='en'&&width===1600){
  await page.locator('input').first().blur();await page.locator('button').screenshot({path:`${output}/button-${theme}-base.png`});
  await page.locator('button').hover();await page.locator('button').screenshot({path:`${output}/button-${theme}-hover.png`});
  await page.locator('input').first().screenshot({path:`${output}/input-${theme}.png`});
  const cdp=await context.newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');const {root:document}=await cdp.send('DOM.getDocument');const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:document.nodeId,selector:'h1'});record.renderedFonts=(await cdp.send('CSS.getPlatformFontsForNode',{nodeId})).fonts;
 }
 await context.close();
}
writeFileSync(`${output}/measurements.json`,JSON.stringify(rows,null,2));
console.log(JSON.stringify({phase,captures:rows.length,overflows:rows.filter(r=>r.overflow).length}));
}finally{await browser.close()}
