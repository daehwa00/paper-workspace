import {chromium} from '../../apps/paper_workspace/collaboration/node_modules/playwright-core/index.mjs';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const artifacts=new URL(process.env.PAPER_SURFACE_OUTPUT ? 'file://'+process.env.PAPER_SURFACE_OUTPUT.replace(/\/$/,'')+'/' : '../../.omx/artifacts/linear-refresh/precision/',import.meta.url);mkdirSync(artifacts,{recursive:true});
const artifact=name=>new URL(name,artifacts);
const baseURL=process.env.PAPER_E2E_URL||'http://127.0.0.1:18080';
const b=await chromium.launch();const all=[];
for(const theme of ['light','dark']){
 const p=await b.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:1,reducedMotion:'reduce'});
 await p.addInitScript(t=>{localStorage.setItem('collab-name','Design Review');localStorage.setItem('collab-name-user-set','1');localStorage.setItem('paper-workspace-theme',t)},theme);
 await p.route('**/vendor/pdfjs/*.mjs',async r=>{const response=await r.fetch();await r.fulfill({response,headers:{...response.headers(),'content-type':'text/javascript'}})});
 await p.route('**/api/compile',r=>r.fulfill({json:{elapsed_ms:20,compile_id:'visual-real-pdf',pdf_base64:readFileSync(process.env.PAPER_VISUAL_PDF||'/tmp/paper-design-compile/main.pdf').toString('base64'),synctex_base64:''}}));
 await p.goto(`${baseURL}/p/final-visual-${theme}-${Date.now()}?lang=en`);await p.waitForFunction(()=>typeof workspaceReadyForCompile!=='undefined'&&workspaceReadyForCompile);await p.evaluate(()=>document.fonts.ready);await p.locator('.pdf-page canvas').first().waitFor();
 const cdp=await p.context().newCDPSession(p);await cdp.send('DOM.enable');await cdp.send('CSS.enable');const {root}=await cdp.send('DOM.getDocument');const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector:'#ask'});all.push({theme,fonts:(await cdp.send('CSS.getPlatformFontsForNode',{nodeId})).fonts});
 for(const tab of ['assist','comments','sources','checks','tasks']){await p.locator(`[data-tab=${tab}]`).click();await p.screenshot({path:artifact(`workspace-${tab}-${theme}.png`).pathname});}
 await p.locator('[data-tab=assist]').click();await p.locator('#model-settings summary').click();await p.locator('#assistant-panel').screenshot({path:artifact(`component-model-settings-${theme}.png`).pathname});await p.locator('#model-settings summary').click();
 await p.locator('#status-center-toggle').click();await p.locator('#status-center').screenshot({path:artifact(`component-status-${theme}.png`).pathname});await p.locator('#status-center-close').click();
 await p.locator('#new-file').click();await p.locator('#action-dialog').screenshot({path:artifact(`component-action-dialog-${theme}.png`).pathname});await p.keyboard.press('Escape');
 await p.setViewportSize({width:320,height:1000});await p.screenshot({path:artifact(`workspace-after-${theme}-320.png`).pathname});await p.close();
}
writeFileSync(artifact('platform-fonts.json'),JSON.stringify(all,null,2));await b.close();
