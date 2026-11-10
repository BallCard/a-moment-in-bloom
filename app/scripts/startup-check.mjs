import assert from 'node:assert/strict';
import http from 'node:http';
import {gunzipSync} from 'node:zlib';
import {mkdirSync, writeFileSync} from 'node:fs';
import {chromium} from 'playwright-core';
const base = process.env.SMOKE_URL ?? 'http://127.0.0.1:8792/';
const out = '.verify/startup-abc'; mkdirSync(out,{recursive:true});
let checks=0;
function ok(value,label){assert(value,label);console.log('ok',++checks,label);}
function request(path,headers={},method='GET'){return new Promise((resolve,reject)=>{
  http.request(new URL(path,base),{headers,method},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));}).on('error',reject).end();
});}
const index=await request('/');
const bundle=index.body.toString().match(/src="([^"]+\.js)"/)[1];
const raw=await request(bundle,{'accept-encoding':'identity'});
const zipped=await request(bundle,{'accept-encoding':'gzip'});
ok(zipped.headers['content-encoding']==='gzip','gzip negotiation');
ok(gunzipSync(zipped.body).equals(raw.body),'gzip content matches');
ok(zipped.body.length<raw.body.length*.5,'bundle transfer more than halved');
ok(zipped.headers['cache-control'].includes('immutable'),'fingerprinted bundles immutable');
ok((await request(bundle,{'if-none-match':zipped.headers.etag,'accept-encoding':'gzip'})).status===304,'gzip etag 304');
ok((await request(bundle,{'accept-encoding':'gzip;q=0'})).headers['content-encoding']===undefined,'gzip q=0 honored');
const head=await request(bundle,{'accept-encoding':'gzip'},'HEAD');
ok(!head.body.length&&Number(head.headers['content-length'])===zipped.body.length,'HEAD representation length');
const manifest=await request('/assets/manifest.json');
ok(manifest.headers['cache-control'].includes('must-revalidate'),'mutable manifest revalidated');
ok((await request('/assets/manifest.json',{'if-none-match':manifest.headers.etag})).status===304,'manifest 304');
ok(index.headers['cache-control'].includes('must-revalidate'),'html revalidated');
ok((await request('/api/health')).headers['cache-control']==='no-store','health never cached');
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const context=await browser.newContext({viewport:{width:1366,height:768}});
 let page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.waitForFunction(()=>window.__bouquetDebug);
 ok(await page.getByTestId('showcase-gallery').isVisible(),'fresh visitor empty gallery');
 await page.goto(new URL('?palette=morning',base).href);await page.waitForFunction(()=>window.__bouquetDebug?.getState().doc.stems.length===10);
 await page.waitForTimeout(800);
 await page.close(); page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
 const models=[];page.on('request',r=>{if(r.url().includes('.glb'))models.push(r.url());});
 await page.goto(base);await page.getByTestId('start-continue').waitFor();await page.waitForTimeout(800);
 ok(models.length===0,'no GLB requested before continue');
 ok(!await page.locator('canvas').count(),'no 3D scene before choice');
 await page.screenshot({path:`${out}/saved-choice.png`});
 await page.getByTestId('start-gallery').click();
 ok(await page.getByTestId('showcase-gallery').isVisible(),'browse gallery while retaining saved bouquet');
 ok(JSON.parse(await page.evaluate(()=>localStorage.getItem('bouquet-workbench.v1'))).stems.length===10,'gallery leaves save intact');
 await page.getByTestId('start-continue').click();await page.waitForFunction(()=>window.__bouquetDebug);
 ok(await page.evaluate(()=>window.__bouquetDebug.getState().doc.stems.length===10),'continue restores ten stems');
 await page.getByTestId('new-bouquet').click();await page.getByTestId('start-blank').click();
 await page.waitForFunction(()=>window.__bouquetDebug?.getState().doc.stems.length===0);
 ok(await page.evaluate(()=>JSON.parse(localStorage.getItem('bouquet-workbench.before-new.v1')).doc.stems.length===10),'new bouquet backs up old work');
 await page.getByTestId('gallery-open').click();await page.getByTestId('start-restore').click();
 await page.getByTestId('start-continue').waitFor();
 ok(JSON.parse(await page.evaluate(()=>localStorage.getItem('bouquet-workbench.v1'))).stems.length===10,'backup recovered through reload');
 // Verify quota failures do not replace the live bouquet.
 await page.evaluate(()=>{const real=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.includes('before-new'))throw new DOMException('full','QuotaExceededError');return real.call(this,k,v);};});
 await page.getByTestId('start-blank').click();
 ok(await page.getByRole('alert').isVisible(),'failed backup blocks new bouquet');
 ok(await page.getByTestId('start-continue').isVisible(),'original remains available on failure');
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:`${out}/choice-mobile.png`});
 ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile no horizontal overflow');
 ok(errors.length===0,'no page errors');
 writeFileSync(`${out}/result.json`,JSON.stringify({checks,errors,raw:raw.body.length,gzip:zipped.body.length},null,2));
} finally {await browser.close();}
console.log(`${checks} passed`);
