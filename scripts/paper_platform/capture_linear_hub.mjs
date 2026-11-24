import {chromium} from '../../apps/paper_workspace/collaboration/node_modules/playwright-core/index.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const phase=process.argv[2]||'after';if(!['before','after'].includes(phase))throw Error('Expected before or after');
const output=resolve('.omx/artifacts/linear-refresh/remaining-hub',phase);mkdirSync(output,{recursive:true});
const base=process.env.PAPER_E2E_URL||'http://127.0.0.1:18630',rows=[];
const projects=[{slug:'compact-paper',display_name_en:'A reusable paper workspace',display_name_ko:'재사용 가능한 논문 작업공간',description_en:'Source, PDF and review responses.',description_ko:'원고·PDF·리뷰와 답변을 함께 관리합니다.',updated_at:'ICLR 2027',page_count:17},{slug:'long-paper',display_name:'A long research manuscript title · 한국어와 영어를 함께 사용하는 긴 프로젝트 제목',description:'This long description remains available while the list keeps a consistent density. 한국어와 영어를 혼용해도 겹치지 않습니다.',page_count:28}];
const browser=await chromium.launch();
try{for(const theme of ['light','dark'])for(const lang of ['en','ko'])for(const width of [320,390,1024,1600]){
 const context=await browser.newContext({viewport:{width,height:1000},deviceScaleFactor:1,reducedMotion:'reduce'});
 await context.addInitScript(theme=>{localStorage.setItem('paper-workspace-theme',theme);localStorage.setItem('collab-name','Design review');localStorage.setItem('collab-name-user-set','1')},theme);
 await context.route('**/projects/index.json',route=>route.fulfill({json:{projects}}));
 await context.route('**/api/backups/activity',route=>route.fulfill({json:{projects:[{project_id:'compact-paper',actor:'DR',modified_at:'2026-10-27T00:00:00Z'}]}}));
 const page=await context.newPage();await page.goto(`${base}/hub.html?lang=${lang}`);await page.locator('.project-card').first().waitFor();await page.evaluate(()=>document.fonts.ready);await page.mouse.move(0,0);
 rows.push({theme,lang,width,...await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,language:document.documentElement.lang,fonts:document.fonts.status,sidebar:document.querySelector('.hub-topbar').getBoundingClientRect().width,toolbar:document.querySelector('.hub-intro').getBoundingClientRect().height,rows:[...document.querySelectorAll('.project-card')].map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {height:r.height,top:r.y,font:s.font,gap:s.gap,padding:s.padding}})}))});
 await page.screenshot({path:`${output}/${theme}-${lang}-${width}.png`,animations:'disabled'});await context.close();
}writeFileSync(`${output}/measurements.json`,JSON.stringify(rows,null,2));console.log(JSON.stringify({phase,captures:rows.length,overflows:rows.filter(r=>r.overflow).length}));}finally{await browser.close()}
