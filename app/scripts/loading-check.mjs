import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
const browser=await chromium.launch({channel:'chrome',headless:true});
const out='.verify/startup-abc';mkdirSync(out,{recursive:true});
const base=process.env.SMOKE_URL??'http://127.0.0.1:8792/';
try{
 const context=await browser.newContext({viewport:{width:1366,height:768}});
 const page=await context.newPage();let release;const gate=new Promise(r=>release=r);
 await page.route('**/assets/*.js',async route=>{await gate;await route.continue();});
 await page.goto(base,{waitUntil:'commit'});
 await page.locator('#boot-splash svg').waitFor({state:'visible'});
 await page.waitForTimeout(1400);await page.screenshot({path:`out/loading-desktop.png`.replace('out/',`${out}/`)});
 assert.equal(await page.locator('#boot-splash .boot-petal').count(),5);
 assert.equal(await page.evaluate(()=>Boolean(window.__bouquetDebug)),false);
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.locator('.boot-flower').evaluate(el=>getComputedStyle(el).animationName),'none');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${out}/loading-mobile.png`});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 release();await page.waitForFunction(()=>window.__bouquetDebug);await page.locator('#boot-splash').waitFor({state:'detached'});
 await page.setViewportSize({width:1366,height:768});await page.screenshot({path:`${out}/workbench-topbar.png`});
 assert(await page.getByTestId('new-bouquet').isVisible());assert(await page.getByTestId('gallery-open').isVisible());
 writeFileSync(`${out}/loading-results.json`,JSON.stringify({passed:7,checks:['inline before JS','five petals','reduced motion','mobile no overflow','ready removes splash','new entry visible','gallery entry visible']},null,2));
 console.log('loading 7/7');
}finally{await browser.close();}
