import {test,expect} from './fixtures.js'
for(const theme of ['light','dark'])test(`review sidebar arrow is painted in both directions in ${theme}`,async({page})=>{
  await page.setViewportSize({width:1440,height:900})
  await page.addInitScript(theme=>{
    localStorage.setItem('paper-workspace-theme',theme)
    localStorage.setItem('paper-workspace-layout',JSON.stringify({sidebarCollapsed:false,sidebarWidth:244}))
  },theme)
  await page.route('**/api/rebuttal/projects/**/state',route=>route.fulfill({json:{revision:0,enabled:true,rounds:[],jobs:[]}}))
  await page.goto('/p/sidebar-arrow/rebuttal?standalone=1')
  const button=page.locator('#toggle-review-sidebar')
  await expect(button).toHaveAttribute('aria-expanded','true')
  await expect(page.locator('.project-frame-header')).toHaveCSS('background-color','rgba(0, 0, 0, 0)')
  for(const expanded of ['true','false']){
    if(expanded==='false'){
      await button.click()
      await page.waitForFunction(()=>!document.documentElement.classList.contains('sidebar-motion-running'))
    }
    await expect(button).toHaveAttribute('aria-expanded',expanded)
    await page.mouse.move(800,600)
    const png=await button.locator('svg').screenshot()
    const painted=await page.evaluate(async png=>{
      const image=new Image();image.src='data:image/png;base64,'+png;await image.decode()
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height
      const context=canvas.getContext('2d');context.fillStyle=getComputedStyle(document.body).backgroundColor;context.fillRect(0,0,image.width,image.height)
      const background=context.getImageData(0,0,1,1).data
      context.drawImage(image,0,0)
      const pixels=context.getImageData(0,0,image.width,image.height).data;let count=0
      for(let i=0;i<pixels.length;i+=4)if(Math.max(...[0,1,2].map(channel=>Math.abs(pixels[i+channel]-background[channel])))>20)count++
      return count
    },png.toString('base64'))
    expect(painted).toBeGreaterThan(8)
  }
  await button.click();await expect(button).toHaveAttribute('aria-expanded','true')
})
test('mobile review header retains its opaque background',async({page})=>{
  await page.setViewportSize({width:390,height:844})
  await page.addInitScript(()=>localStorage.setItem('paper-workspace-theme','dark'))
  await page.route('**/api/rebuttal/projects/**/state',route=>route.fulfill({json:{revision:0,enabled:true,rounds:[],jobs:[]}}))
  await page.goto('/p/sidebar-arrow/rebuttal?standalone=1')
  await expect(page.locator('.project-frame-header')).not.toHaveCSS('background-color','rgba(0, 0, 0, 0)')
})
