import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../../../..');
const pages=JSON.parse(execFileSync('python3',[resolve(root,'scripts/paper_platform/render_auth_fixtures.py')],{maxBuffer:8*1024*1024}));
for(const theme of ['light','dark'])for(const mode of ['shared','accounts'])test(`actual gate layout and native form contract ${mode} ${theme}`,async({page})=>{
 await page.addInitScript(theme=>localStorage.setItem('paper-workspace-theme',theme),theme);
 let post;
 await page.route('**/_auth/login**',async route=>{
  if(route.request().method()==='POST'){post=new URLSearchParams(route.request().postData());await route.fulfill({contentType:'text/html',body:'<p>Isolated form received</p>'})}
  else await route.fulfill({contentType:'text/html',body:pages[`${mode}-en-`]});
 });
 await page.setViewportSize({width:1600,height:1000});await page.goto('/_auth/login?lang=en');await page.evaluate(()=>document.fonts.ready);
 await expect(page.locator('main')).toHaveCSS('border-width','0px');
 expect((await page.locator('main').boundingBox()).width).toBe(288);
 expect((await page.locator('h1').boundingBox()).y).toBe(388);
 await expect(page.locator('h1')).toHaveCSS('font-size','18px');await expect(page.locator('h1')).toHaveCSS('font-weight','500');
 const first=page.locator('input').first();expect((await first.boundingBox()).y).toBe(433);
 expect((await first.boundingBox()).height).toBe(44);await expect(first).toHaveCSS('border-radius','10px');
 const button=page.getByRole('button',{name:'Continue to workspace'});expect((await button.boundingBox()).height).toBe(44);await expect(button).toHaveCSS('border-radius','9999px');
 await page.mouse.move(0,0);await expect(button).toHaveCSS('background-color',theme==='light'?'rgb(254, 254, 255)':'rgb(27, 27, 28)');
 await button.hover();await expect(button).toHaveCSS('background-color',theme==='light'?'rgb(243, 243, 243)':'rgb(36, 37, 38)');
 await first.focus();await expect(first).toBeFocused();
 if(mode==='accounts')await page.getByRole('textbox',{name:'Workspace',exact:true}).fill('test-author');
 await page.getByRole('textbox',{name:'Access password',exact:true}).fill('isolated-test-password');
 await page.getByRole('textbox',{name:'Access password',exact:true}).press('Enter');
 await expect.poll(()=>post?.get('password')).toBe('isolated-test-password');
 if(mode==='accounts')expect(post.get('username')).toBe('test-author');
});
for(const theme of ['light','dark'])test(`login handles Korean long errors and both native input modes ${theme}`,async({page})=>{
 await page.addInitScript(theme=>localStorage.setItem('paper-workspace-theme',theme),theme);
 for(const mode of ['shared','accounts'])for(const width of [320,390,1024,1600]){
  await page.setViewportSize({width,height:900});await page.route('**/_auth/login**',route=>route.fulfill({contentType:'text/html',body:pages[`${mode}-ko-rate_limited`]}));await page.goto('/_auth/login?lang=ko');
  await expect(page.locator('[role=alert]')).toBeVisible();await expect(page.getByRole('textbox',{name:'접속 비밀번호',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  for(const control of await page.locator('input,button,.language a').all())expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
  const english=page.getByRole('link',{name:'English',exact:true});await english.focus();await expect(english).toBeFocused();expect(await english.getAttribute('href')).toContain('lang=en');
  await page.unroute('**/_auth/login**');
 }
});
