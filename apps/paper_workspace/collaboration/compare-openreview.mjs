import { chromium } from '@playwright/test'
const browser=await chromium.launch();const live=await browser.newPage(),local=await browser.newPage();await live.goto('https://openreview.net/',{waitUntil:'domcontentloaded'});await live.waitForFunction(()=>window.marked && window.MathJax?.startup?.promise);await live.evaluate(()=>MathJax.startup.promise);await local.goto('about:blank');await local.addScriptTag({path:new URL('../static/vendor/paper-editor.js',import.meta.url).pathname});
const inputs=['# Heading\n\n**bold** and *italic*\n\n- one\n- two','| A | B |\n| --- | ---: |\n| x | 1 |','~~deleted~~ and https://example.com\n\n- [x] Done\n- [ ] Pending','Inline $x^2$ and $\\\\alpha + \\\\frac{1}{2}$','$$\n\\\\sum_{i=1}^n x_i\n$$','Code `$x$` and literal <b>test</b>','![alt](https://example.com/a.png)','Equation $\\\\ce{H2O}$ and $\\\\cancel{x}$','unescaped $\\alpha$ and underscore $x_1$','[example](https://example.com) and & < >'];
let failures = 0
for (const input of inputs) {
const ref=await live.evaluate(async input=>{const el=document.createElement('div');el.innerHTML=DOMPurify.sanitize(marked(input));document.body.append(el);await MathJax.typesetPromise([el]);const normalize=el=>{for(const m of el.querySelectorAll('mjx-container')){let mml=m.querySelector('mjx-assistive-mml math')?.outerHTML || 'missing';m.replaceWith(document.createTextNode(`{math:${m.getAttribute('display')||'inline'}:${mml}}`))}return el.innerHTML};const result=normalize(el);el.remove();return result},input);
const result=await local.evaluate(input=>{const el=document.createElement('div');el.innerHTML=PaperEditor.renderResponsePreview(input);for(const m of el.querySelectorAll('mjx-container')){let mml=m.querySelector('mjx-assistive-mml math')?.outerHTML || 'missing';m.replaceWith(document.createTextNode(`{math:${m.getAttribute('display')||'inline'}:${mml}}`))}return el.innerHTML},input);
if (ref !== result) { failures++; console.error(JSON.stringify({input,ref,result})) }
}
await browser.close()
console.log(`${inputs.length - failures}/${inputs.length} OpenReview comparisons matched`)
if (failures) process.exitCode = 1
