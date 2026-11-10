import {chromium} from 'playwright-core';
import {mkdirSync,writeFileSync} from 'node:fs';
const base=process.env.EXHIBIT_URL??'http://127.0.0.1:4212/';
const out='.verify/exhibit';mkdirSync(out,{recursive:true});const checks=[],errors=[];
const check=(name,ok)=>{checks.push({name,ok});if(!ok)throw Error(name);};
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.waitForFunction(()=>window.__bouquetDebug?.getState().catalog.mode==='manifest');
 await page.getByTestId('palette-rose-pink').click();
 await page.locator('canvas').click({position:{x:350,y:300}});
 await page.waitForFunction(()=>window.__bouquetDebug.getState().doc.stems.length===1);
 // Persistence refreshes updatedAt; compare all actual work, including document identity.
 const documentContent=()=>page.evaluate(()=>{const {updatedAt,...doc}=window.__bouquetDebug.getState().doc;return JSON.stringify(doc);});
 const before=await documentContent();
 await page.getByTestId('more-menu-toggle').click();await page.getByTestId('exhibit-open').click();
 await page.waitForSelector('[data-testid=exhibit-canvas][data-status=ready]');
 check('工作台更多菜单进入真实模型展示',await page.getByRole('heading',{name:'清晨来信'}).isVisible());
 check('一体模型与编辑边界可见',await page.getByText('一体模型展示 · 不支持逐枝编辑').isVisible());
 await page.waitForTimeout(500);await page.screenshot({path:`${out}/desktop.png`});
 await page.getByTestId('exhibit-rotate').click();check('摆动启动',await page.getByTestId('exhibit-rotate').getAttribute('aria-pressed')==='true');
 const canvas=page.locator('.exhibit-canvas canvas'),box=await canvas.boundingBox();
 await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.7,box.y+box.height*.52,{steps:12});await page.mouse.up();
 check('手动旋转暂停摆动',await page.getByTestId('exhibit-rotate').getAttribute('aria-pressed')==='false');
 await page.getByTestId('exhibit-reset').click();
 const downloadEvent=page.waitForEvent('download');await page.getByTestId('exhibit-export').click();const download=await downloadEvent;await download.saveAs(`${out}/export.png`);check('真实成品PNG导出',download.suggestedFilename().endsWith('.png'));
 await page.getByTestId('exhibit-back').click();await page.waitForFunction(()=>window.__bouquetDebug?.getState().catalog.mode==='manifest');
 check('返回后花枝与工作台文档保留',before===await documentContent());
 await page.goto(`${base}?exhibit=morning`);await page.waitForSelector('[data-status=ready]');await page.reload();await page.waitForSelector('[data-status=ready]');check('直达链接刷新可用',true);
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);await page.screenshot({path:`${out}/mobile.png`,fullPage:true});check('窄屏无横向溢出',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.close();
 const failed=await context.newPage();await failed.route('**/showcase/morning-letter.glb',r=>r.abort());await failed.goto(`${base}?exhibit=morning`);await failed.getByRole('alert').waitFor();check('模型加载失败给出重试',await failed.getByRole('button',{name:'重新加载'}).isVisible());await failed.unroute('**/showcase/morning-letter.glb');await failed.getByRole('button',{name:'重新加载'}).click();await failed.waitForSelector('[data-status=ready]');check('重试恢复真实模型',true);await failed.close();
 check('页面无脚本异常',errors.length===0);
 writeFileSync(`${out}/results.json`,JSON.stringify({checks,errors},null,2));console.log(`${checks.length} checks passed`);
}finally{await browser.close();}
