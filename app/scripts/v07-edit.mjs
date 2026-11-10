/**
 * V0.7 §6 点击对象直达编辑验证。
 *
 * 用法：npm run dev -- --port 5190 --strictPort  然后 node scripts/v07-edit.mjs
 * 覆盖：点 3D 贺卡展开编辑区并定位正文、点包装纸/花器进入对应选择区、
 * 拍照阶段点对象回到编辑且内容保留、编辑面板与包装进度分离、
 * 拖动镜头不误触、界面入口可用、无贺卡内容也能打开。
 */

import {chromium} from 'playwright-core';
import {mkdirSync,writeFileSync} from 'node:fs';

const BASE=process.env.EDIT_URL??'http://127.0.0.1:5190/';
const OUT='.verify/v07-edit';
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
const decorPoint=kind=>page.evaluate(k=>window.__bouquetDebug.scene.getDecorScreenPoint(k),kind);
const activeTestId=()=>exec(()=>document.activeElement?.getAttribute('data-testid')??null);

try{
  await page.goto(`${BASE}?sample=12&head=0.8&view=quarter`);
  await page.waitForFunction(()=>window.__bouquetDebug?.getState().doc.stems.length===12);
  await wait(1200);

  // 进包装阶段并写一张卡片，保证 3D 贺卡存在且可见
  await exec(()=>{
    const s=window.__bouquetDebug.store;
    s.setStage('wrap');
    s.setPackageStep('card');
    s.updateCardFieldTransient('message','生日快乐');
    s.endTransaction();
  });
  await wait(1200);
  check(
    '包装阶段说明补充「直接点画面编辑」提示',
    (await page.locator('.wrap-intro').innerText()).includes('直接点画面'),
    {intro:await page.locator('.wrap-intro').innerText()},
  );

  // ---------- 1. 点 3D 贺卡 → 展开贺卡编辑区并定位正文 ----------
  await page.getByTestId('right-panel-close').click().catch(()=>{});
  await wait(300);
  const cardPt=await decorPoint('card');
  check('3D 贺卡有可点位置',Boolean(cardPt),cardPt);
  await page.mouse.click(cardPt.x,cardPt.y);
  await wait(600);
  check('点贺卡展开右栏',await page.getByTestId('decor-panel').isVisible());
  check('点贺卡出现贺卡编辑区',await page.getByTestId('card-editor').isVisible());
  check('点贺卡定位到正文输入框',(await activeTestId())==='card-message',{active:await activeTestId()});
  check('点贺卡不改包装进度',(await state()).doc.wrapping.step==='card');
  await page.screenshot({path:`${OUT}/01-card.png`});

  // ---------- 2. 编辑面板与包装进度分离 ----------
  await exec(()=>{const s=window.__bouquetDebug.store;s.setPackageStep('fold');});
  await wait(900);
  check('先切回叠包步骤',(await state()).doc.wrapping.step==='fold');
  const paperPtFold=await decorPoint('paper');
  check('叠包步骤能点到包装纸',Boolean(paperPtFold),paperPtFold);
  await page.mouse.click(paperPtFold.x,paperPtFold.y);
  await wait(700);
  check('叠包步骤点包装纸展开选择区',await page.getByTestId('presentation-paper').isVisible());
  check('打开选择区不把包装重新展开（仍叠包）',(await state()).doc.wrapping.step==='fold',{step:(await state()).doc.wrapping.step});
  await exec(()=>{const s=window.__bouquetDebug.store;s.setPackageStep('card');});
  await wait(1100);
  const cardPt2=await decorPoint('card');
  check('卡片步骤又能点到贺卡',Boolean(cardPt2),cardPt2);
  await page.mouse.click(cardPt2.x,cardPt2.y);
  await wait(600);
  check('叠包→卡片后点贺卡展开编辑区',await page.getByTestId('card-editor').isVisible());
  check('展开编辑区不改包装进度（仍卡片）',(await state()).doc.wrapping.step==='card',{step:(await state()).doc.wrapping.step});
  check('展开编辑区定位正文',(await activeTestId())==='card-message');
  await page.screenshot({path:`${OUT}/02-card-at-fold.png`});

  // ---------- 3. 点 3D 包装纸 → 进包装选择区并选中纸片 ----------
  const paperPt=await decorPoint('paper');
  check('3D 包装纸有可点位置',Boolean(paperPt),paperPt);
  await page.mouse.click(paperPt.x,paperPt.y);
  await wait(600);
  check('点包装纸展开包装与花器',await page.getByTestId('presentation-paper').isVisible());
  check('点包装纸选中对应纸片',Boolean((await state()).selectedSheetId)&&(await state()).selectedSheetId===(await state()).doc.presentation.sheets[0].id,{selected:(await state()).selectedSheetId});
  await page.screenshot({path:`${OUT}/03-paper.png`});

  // ---------- 4. 点 3D 花器 → 进花器选择区 ----------
  await exec(()=>{const s=window.__bouquetDebug.store;s.previewPresentation('vase');s.endTransaction();});
  await wait(1400);
  const vesselPt=await decorPoint('vessel');
  check('3D 花器有可点位置',Boolean(vesselPt),vesselPt);
  await page.mouse.click(vesselPt.x,vesselPt.y);
  await wait(600);
  check('点花器展开包装与花器选择',await page.getByTestId('presentation-vase').isVisible());
  check('点花器不改花器形式',(await state()).doc.presentation.kind==='vase');

  // 换回纸包，供后面拍照阶段验证
  await exec(()=>{const s=window.__bouquetDebug.store;s.previewPresentation('paper');s.endTransaction();});
  await wait(1200);
  await exec(()=>{const s=window.__bouquetDebug.store;s.setPackageStep('card');s.updateCardFieldTransient('message','生日快乐，天天开心');s.endTransaction();});
  await wait(900);

  // ---------- 5. 拍照阶段点对象回到编辑，内容全部保留 ----------
  const beforeFinish=await exec(()=>{
    const d=window.__bouquetDebug;d.store.setStage('finish');
    const s=d.getState();
    return {stems:s.doc.stems.length,paper:s.doc.wrapping.paperId,step:s.doc.wrapping.step,card:s.doc.card.message,album:s.album.length};
  });
  await wait(1600);
  const finishCardPt=await decorPoint('card');
  check('拍照阶段仍能定位贺卡',Boolean(finishCardPt),finishCardPt);
  await page.mouse.click(finishCardPt.x,finishCardPt.y);
  await wait(1000);
  const afterFinish=await state();
  check('拍照阶段点贺卡回到包装阶段',afterFinish.stage==='wrap',{stage:afterFinish.stage});
  check('回到编辑保留花材、包装、卡片内容',afterFinish.doc.stems.length===beforeFinish.stems&&afterFinish.doc.wrapping.paperId===beforeFinish.paper&&afterFinish.doc.card.message===beforeFinish.card,{before:beforeFinish,after:{stems:afterFinish.doc.stems.length,paper:afterFinish.doc.wrapping.paperId,card:afterFinish.doc.card.message}});
  check('回到编辑保留相册照片',afterFinish.album.length===beforeFinish.album);
  check('回到编辑定位到正文',(await activeTestId())==='card-message');
  await page.screenshot({path:`${OUT}/04-from-photo.png`});

  // ---------- 6. 界面「卡片」入口同样展开编辑区 ----------
  await page.getByTestId('package-step-paper').click();
  await wait(900);
  check('界面切到摆纸',(await state()).doc.wrapping.step==='paper');
  await page.getByTestId('package-step-card').click();
  await wait(700);
  check('界面卡片入口展开编辑区',await page.getByTestId('card-editor').isVisible());
  check('界面卡片入口定位正文',(await activeTestId())==='card-message');

  // ---------- 7. 拖动镜头不误触编辑 ----------
  await exec(()=>{const d=window.__bouquetDebug;d.store.select(null);d.scene.getDecorState();});
  await page.keyboard.press('Escape');
  await wait(300);
  const nonceBefore=(await state()).editorRequest?.nonce??0;
  const stageBefore=(await state()).stage;
  const vp=await page.locator('[data-testid=viewport]').boundingBox();
  await page.mouse.move(vp.x+vp.width*0.72,vp.y+vp.height*0.42);
  await page.mouse.down();
  await page.mouse.move(vp.x+vp.width*0.72+70,vp.y+vp.height*0.42+18,{steps:12});
  await page.mouse.up();
  await wait(500);
  check('拖动镜头不产生编辑请求',((await state()).editorRequest?.nonce??0)===nonceBefore,{before:nonceBefore,after:(await state()).editorRequest?.nonce});
  check('拖动镜头不切阶段',(await state()).stage===stageBefore);

  // ---------- 8. 无贺卡内容时点 3D 贺卡也能进编辑，且不自动添加内容 ----------
  await exec(()=>{const s=window.__bouquetDebug.store;s.updateCardFieldTransient('message','');s.endTransaction();s.requestEditor('wrapping');});
  await wait(700);
  const emptyCardPt=await decorPoint('card');
  if(emptyCardPt){
    await page.mouse.click(emptyCardPt.x,emptyCardPt.y);
    await wait(600);
    check('无贺卡内容时点贺卡仍打开编辑区',await page.getByTestId('card-editor').isVisible());
  }else{
    // 卡片内容清空后 3D 贺卡本来就隐藏：通过界面入口进入，且不自动填内容。
    await page.getByTestId('package-step-card').click();
    await wait(600);
    check('无贺卡内容时界面入口可进编辑区',await page.getByTestId('card-editor').isVisible());
  }
  check('打开编辑器不自动写卡片内容',(await state()).doc.card.message==='');

  // ---------- 9. 摆花阶段点空白不会误进编辑 ----------
  await exec(()=>window.__bouquetDebug.store.setStage('arrange'));
  await wait(900);
  const nonceArrange=(await state()).editorRequest?.nonce??0;
  await page.mouse.click(vp.x+vp.width*0.74,vp.y+vp.height*0.42);
  await wait(400);
  check('摆花阶段点空白不进编辑',((await state()).editorRequest?.nonce??0)===nonceArrange);

  check('无页面与 WebGL 错误',errors.length===0,errors);
  writeFileSync(`${OUT}/results.json`,JSON.stringify({date:new Date().toISOString(),passed,checks,errors},null,2));
  console.log(`PASSED ${passed}`);
}catch(error){
  writeFileSync(`${OUT}/failure.json`,JSON.stringify({date:new Date().toISOString(),passed,checks,error:String(error),errors},null,2));
  throw error;
}finally{
  await browser.close();
}
