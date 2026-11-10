/**
 * V0.7 §7 折叠视角控件验证。
 *
 * 用法：npm run dev -- --port 5190 --strictPort  然后 node scripts/v07-view.mjs
 * 覆盖：右下角折叠控件、眼睛固定/自由、下拉四项、滚轮循环与阈值节流、
 * Ctrl+滚轮调花枝大小优先、再次点亮回到上次固定视角、拖动退出固定、数字键、面板让位。
 */

import {chromium} from 'playwright-core';
import {mkdirSync,writeFileSync} from 'node:fs';

const BASE=process.env.VIEW_URL??'http://127.0.0.1:5190/';
const OUT='.verify/v07-view';
mkdirSync(OUT,{recursive:true});

let passed=0;const checks=[];const errors=[];
function check(name,ok,detail){
  checks.push({name,ok,detail:detail??null});
  if(!ok)throw Error(`${name}: ${JSON.stringify(detail)}`);
  passed++;console.log('ok',name);
}

const browser=await chromium.launch({channel:'chrome',headless:process.env.HEADED!=='1'});
const context=await browser.newContext({viewport:{width:1440,height:900}});
const page=await context.newPage();
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404'))errors.push(m.text());});

const exec=fn=>page.evaluate(fn);
const wait=ms=>page.waitForTimeout(ms);
const state=()=>exec(()=>window.__bouquetDebug.getState());
const camInfo=()=>exec(()=>{
  const d=window.__bouquetDebug;const c=d.scene.camera,t=d.scene.controls.target;
  return {pos:c.position.toArray().map(n=>+n.toFixed(4)),dist:+c.position.distanceTo(t).toFixed(4),zoomEnabled:d.scene.controls.enableZoom};
});
const dockBox=()=>page.locator('[data-testid=view-controls]').boundingBox();

try{
  await page.goto(`${BASE}?sample=12&head=0.8&view=quarter`);
  await page.waitForFunction(()=>window.__bouquetDebug?.getState().doc.stems.length===12);
  await wait(1200);

  // ---------- 1. 折叠控件外观与位置 ----------
  const box=await dockBox();
  const vp=await page.locator('[data-testid=viewport]').boundingBox();
  check('控件在画布右下角',box.x+box.width>vp.x+vp.width*0.75&&box.y+box.height>vp.y+vp.height*0.75,{box,vp});
  check('默认显示眼睛+当前视角名',await page.locator('[data-testid=view-eye]').isVisible()&&(await page.locator('[data-testid=view-current]').innerText()).includes('斜 45°'));
  check('默认眼睛亮起（固定视角）',await page.locator('[data-testid=view-eye]').getAttribute('aria-pressed')==='true');
  check('默认下拉收起',await page.locator('[data-testid=view-menu]').count()===0);

  // ---------- 2. 下拉四项 + 自由 + 复位 ----------
  await page.getByTestId('view-current').click();
  await wait(150);
  check('下拉在 DOM 里',await page.locator('[data-testid=view-menu]').isVisible());
  for(const id of ['front','quarter','side','top','free','reset']){
    check(`下拉含 ${id}`,await page.locator(`[data-testid=view-${id}]`).count()===1);
  }
  await page.screenshot({path:`${OUT}/01-menu.png`});
  const before=await camInfo();
  await page.getByTestId('view-side').click();
  await wait(900);
  const afterSide=await camInfo();
  check('下拉选侧面切到侧面且锁定',(await state()).viewPreset==='side'&&(await state()).viewLocked===true);
  check('侧面机位真的变了',Math.abs(afterSide.pos[0]-before.pos[0])>0.05,{before:before.pos,after:afterSide.pos});
  check('下拉选完后收起',await page.locator('[data-testid=view-menu]').count()===0);

  // ---------- 3. 眼睛关闭 → 自由模式保留当前角度 ----------
  await page.getByTestId('view-eye').click();
  await wait(300);
  const afterUnlock=await camInfo();
  check('眼睛关闭进入自由视角',(await state()).viewLocked===false&&(await state()).viewPreset==='free');
  check('关闭眼睛保留当前角度',Math.abs(afterUnlock.dist-before.dist)<0.35&&afterUnlock.zoomEnabled===true,{afterUnlock,beforeDist:before.dist});

  // ---------- 3b. 首次点击眼睛：提示「可选中 + 滚轮快速切换」，只出现一次 ----------
  const hintText=await page.locator('[data-testid=view-hint]').innerText().catch(()=> '');
  check('首次点击眼睛出现视角提示',(await page.locator('[data-testid=view-hint]').count())===1,{hintText});
  check('提示说明可选中并提到滚轮切换',hintText.includes('可以选中')&&hintText.includes('滚轮'),{hintText});
  check('首次提示写入本机标记',(await exec(()=>localStorage.getItem('bouquet-workbench.first-use.view-wheel')))==='1');
  await page.screenshot({path:`${OUT}/03b-eye-hint.png`});
  await page.getByTestId('view-hint-close').click();
  await wait(150);
  check('点「知道了」收起提示',(await page.locator('[data-testid=view-hint]').count())===0);

  // ---------- 4. 自由模式：滚轮缩放不改视角 ----------
  await page.mouse.move(vp.x+vp.width/2,vp.y+vp.height/2);
  const free0=await camInfo();
  await page.mouse.wheel(0,-220);
  await wait(420);
  const free1=await camInfo();
  check('自由模式滚轮缩放相机',Math.abs(free1.dist-free0.dist)>0.02,{from:free0.dist,to:free1.dist});
  check('自由模式滚轮不切视角',(await state()).viewPreset==='free');

  // ---------- 5. 再次点亮眼睛回到上次固定视角 ----------
  await page.getByTestId('view-eye').click();
  await wait(900);
  check('再次点亮回到上次固定视角（侧面）',(await state()).viewPreset==='side'&&(await state()).viewLocked===true);
  check('再次点眼睛不再重复首次提示',(await page.locator('[data-testid=view-hint]').count())===0);

  // ---------- 6. 固定模式滚轮循环 + 阈值 + 节流 ----------
  const locked0=await camInfo();
  check('固定模式禁用 OrbitControls 缩放',locked0.zoomEnabled===false);
  await page.mouse.move(vp.x+vp.width/2,vp.y+vp.height/2);
  await page.mouse.wheel(0,40);           // 低于阈值 90
  await wait(120);
  check('小幅度滚轮不切换（累计阈值）',(await state()).viewPreset==='side');
  await page.mouse.wheel(0,70);           // 累计 110 → 切一档
  await wait(320);
  check('累计过阈值后切换一档',(await state()).viewPreset==='top',{got:(await state()).viewPreset});
  await wait(400);
  // 连续两次大 delta 在冷却时间内，只切一档
  await page.mouse.wheel(0,150);
  await page.mouse.wheel(0,150);
  await wait(260);
  const afterFast=(await state()).viewPreset;
  await wait(300);
  const afterFast2=(await state()).viewPreset;
  check('节流：一次快速滑动只切一档',afterFast===afterFast2&&afterFast!=='top',{afterFast,afterFast2});
  check('固定模式滚轮不缩放',Math.abs((await camInfo()).dist-locked0.dist)<0.4);
  await page.screenshot({path:`${OUT}/02-fixed.png`});

  // ---------- 7. Ctrl+滚轮调花枝大小，优先级高于切视角 ----------
  // V0.7.3：12 枝样束本身已经贴得很密，放大被统一落位约束钳制（不允许把花头
  // 顶进邻枝），缩小永远合法；所以这里用「向下滚 = 缩小」验证 Ctrl+滚轮生效。
  // 「间距够时可以放大」由 v07-placement.mjs 的玩法路径覆盖。
  await exec(()=>{const d=window.__bouquetDebug;d.store.select(d.getState().doc.stems[0].id);});
  await wait(250);
  const presetBeforeCtrl=(await state()).viewPreset;
  const scaleBefore=(await state()).doc.stems[0].scale;
  await page.mouse.move(vp.x+vp.width/2,vp.y+vp.height/2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0,120);
  await page.keyboard.up('Control');
  await wait(320);
  const scaleAfter=(await state()).doc.stems[0].scale;
  check('Ctrl+滚轮改选中花枝大小（密集样束缩小）',scaleBefore-scaleAfter>0.005,{scaleBefore,scaleAfter});
  check('Ctrl+滚轮不切视角',(await state()).viewPreset===presetBeforeCtrl,{before:presetBeforeCtrl,after:(await state()).viewPreset});

  // ---------- 8. 拖动空白退出固定模式 ----------
  await exec(()=>window.__bouquetDebug.store.select(null));
  await wait(200);
  // 挑一块确实没有花、也没有面板的空白：花束在中间，右下角是视角控件，这里取右上偏中。
  await page.mouse.move(vp.x+vp.width*0.74,vp.y+vp.height*0.42);
  await page.mouse.down();
  await page.mouse.move(vp.x+vp.width*0.74+90,vp.y+vp.height*0.42,{steps:10});
  await page.mouse.up();
  await wait(300);
  check('拖动空白自动关闭固定模式',(await state()).viewLocked===false&&(await state()).viewPreset==='free',{preset:(await state()).viewPreset,locked:(await state()).viewLocked});
  const dragHint=(await page.locator('[data-testid=view-hint]').count())===1?await page.locator('[data-testid=view-hint]').innerText():'';
  check('首次拖动进入自由视角给出说明',dragHint.includes('自由视角')&&dragHint.includes('滚轮'),{dragHint});
  check('拖动提示写入本机标记',(await exec(()=>localStorage.getItem('bouquet-workbench.first-use.view-drag')))==='1');
  if(dragHint) await page.getByTestId('view-hint-close').click();
  await wait(150);

  // ---------- 9. 数字键 1–4 开启固定模式 ----------
  await page.keyboard.press('1');
  await wait(900);
  check('数字键 1 开启固定模式并切正面',(await state()).viewLocked===true&&(await state()).viewPreset==='front');
  await page.keyboard.press('3');
  await wait(900);
  check('数字键 3 切侧面',(await state()).viewPreset==='side');

  // ---------- 10. 复位在下拉里 ----------
  await page.getByTestId('view-current').click();
  await wait(120);
  await page.getByTestId('view-reset').click();
  await wait(900);
  check('复位回到斜 45° 且保持固定',(await state()).viewPreset==='quarter'&&(await state()).viewLocked===true);

  // ---------- 11. 右侧面板展开时控件让位不重叠 ----------
  await exec(()=>{const d=window.__bouquetDebug;d.store.select(d.getState().doc.stems[0].id);});
  await wait(400);
  if(await page.locator('[data-testid=right-reopen]').count()) await page.getByTestId('right-reopen').click();
  await wait(500);
  const panel=await page.locator('.side-right').boundingBox();
  const shifted=await dockBox();
  const overlap=panel&&shifted&&shifted.x<panel.x+panel.width&&shifted.x+shifted.width>panel.x;
  check('右侧面板展开时控件左移且不与面板重叠',Boolean(panel)&&Boolean(shifted)&&!overlap,{panel,shifted});
  await page.screenshot({path:`${OUT}/03-shifted.png`});

  // ---------- 12. 面板滚动不控制镜头 ----------
  await exec(()=>window.__bouquetDebug.store.select(null));
  await wait(200);
  const beforeScroll=await camInfo();
  const flowerPanel=await page.locator('[data-testid=flower-panel]').boundingBox();
  if(flowerPanel){
    await page.mouse.move(flowerPanel.x+flowerPanel.width/2,flowerPanel.y+flowerPanel.height/2);
    await page.mouse.wheel(0,200);
    await wait(350);
  }
  check('面板内滚动不切视角也不缩放',Math.abs((await camInfo()).dist-beforeScroll.dist)<0.02&&(await state()).viewPreset==='quarter');

  // ---------- 13. 刷新后首次提示不再重复 ----------
  await page.reload();
  await page.waitForFunction(()=>window.__bouquetDebug?.getState().doc.stems.length===12);
  await wait(1000);
  check('刷新后首次提示不会自己出现',(await page.locator('[data-testid=view-hint]').count())===0);
  await page.getByTestId('view-eye').click();
  await wait(250);
  check('刷新后再点眼睛也不重复首次提示',(await page.locator('[data-testid=view-hint]').count())===0);

  check('无页面与 WebGL 错误',errors.length===0,errors);
  writeFileSync(`${OUT}/results.json`,JSON.stringify({date:new Date().toISOString(),passed,checks,errors},null,2));
  console.log(`PASSED ${passed}`);
}catch(error){
  writeFileSync(`${OUT}/failure.json`,JSON.stringify({date:new Date().toISOString(),passed,checks,error:String(error),errors},null,2));
  throw error;
}finally{
  await browser.close();
}
