import {chromium} from 'playwright-core';
import {mkdirSync,writeFileSync} from 'node:fs';
import {newStudioAwarePage} from './studio-page.mjs';
const out='.verify/v15.1-online';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const checks=[];
function check(name,ok,detail){checks.push({name,ok:Boolean(ok),detail});console.log(ok?'ok':'FAIL',name,JSON.stringify(detail??''));if(!ok)throw Error(name);}
try{
 const context=await browser.newContext({viewport:{width:1366,height:768}});
 const page=await newStudioAwarePage(context);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('https://www.modelscope.cn/studios/BallCard/bouquet-workbench?mode=full',{timeout:180000,waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__bouquetDebug?.getState().catalogStatus==='manifest',null,{timeout:180000});
 const facts=await page.evaluate(async()=>{
  const health=await fetch('api/health',{cache:'no-store'}).then(r=>r.json());
  const html=await fetch('./',{cache:'no-store'}).then(r=>r.text());
  const src=html.match(/src="([^"]+\.js)"/)[1];
  const js=await fetch(src,{cache:'no-store'});
  const headers=Object.fromEntries(js.headers);
  const conditional=await fetch(src,{headers:{'If-None-Match':headers.etag},cache:'no-store'});
  const manifest=await fetch('assets/manifest.json',{cache:'no-store'});
  return {health,htmlHasFlower:html.includes('boot-petal'),headers,conditional:conditional.status,manifestCache:manifest.headers.get('cache-control'),assetsVersion:(await manifest.json()).assetsVersion};
 });
 check('health 0.15.1',facts.health.version==='0.15.1',facts.health);
 check('inline loading flower present',facts.htmlHasFlower);
 check('gzip bundle',facts.headers['content-encoding']==='gzip',facts.headers['content-length']);
 check('bundle immutable',facts.headers['cache-control']?.includes('immutable'));
 check('conditional bundle 304',facts.conditional===304,facts.conditional);
 check('manifest revalidated',facts.manifestCache?.includes('must-revalidate'),facts.manifestCache);
 check('sunflower fix retained',facts.assetsVersion==='2026-11-09.lux3d-recolor-fix');
 check('new/gallery explicit entries',await page.getByTestId('new-bouquet').isVisible()&&await page.getByTestId('gallery-open').isVisible());
 check('fresh empty workbench',await page.evaluate(()=>window.__bouquetDebug.getState().doc.stems.length===0));
 await page.evaluate(()=>{const s=window.__bouquetDebug.store;s.setPlacement('sunflower-1');s.placeStem({tilt:10,direction:0});s.setPlacement(null);});
 await page.waitForFunction(()=>window.__bouquetDebug.getState().doc.stems.length===1);
 await page.waitForTimeout(900);await page.reload();await page.getByTestId('start-continue').waitFor();
 check('saved visitor gets choice',await page.getByTestId('start-blank').isVisible());
 check('choice has no WebGL canvas',await page.locator('canvas').count()===0);
 await page.screenshot({path:`${out}/saved-choice.png`});
 await page.getByTestId('start-gallery').click();check('saved visitor can browse gallery',await page.getByTestId('showcase-gallery').isVisible());
 await page.getByTestId('start-continue').click();await page.waitForFunction(()=>window.__bouquetDebug?.getState().doc.stems.length===1,null,{timeout:120000});
 check('continue returns saved stem',true);
 await page.screenshot({path:`${out}/continued.png`});
 // V15.1：纸包前沿修正的线上签名——同一束「清晨来信」纸口半径应由 0.266 变为约 0.29。
 await page.evaluate(()=>window.__bouquetDebug.store.loadPaletteBouquet('morning'));
 await page.waitForFunction(()=>window.__bouquetDebug.getState().doc.stems.length>=8,null,{timeout:120000});
 await page.waitForFunction(()=>window.__bouquetDebug.getState().loading?.active===false,null,{timeout:180000});
 await page.waitForTimeout(2600);
 const paper=await page.evaluate(()=>{const st=window.__bouquetDebug.getSceneState();return{radius:st.package?.paperRadius,fold:st.package?.fold,stems:window.__bouquetDebug.getState().doc.stems.length};});
 check('paper mouth widened (V15.1)',paper.radius>=0.28&&paper.radius<=0.31,paper);
 await page.screenshot({path:`${out}/paper-morning.png`});
 check('no script errors',errors.length===0,errors);
}finally{writeFileSync(`${out}/results.json`,JSON.stringify({at:new Date().toISOString(),checks},null,2));await browser.close();}
console.log(`${checks.length} passed`);
