/**
 * V0.7 §3 / V0.7.3 比例校准验证：花头 70/80/90/100% 对照、尺寸候选 a/b/c 与 6/12/20 枝固定样束。
 *
 * 用法（先起 dev 服务）：
 *   npm run dev -- --port 5190 --strictPort
 *   node scripts/v07-ratio.mjs
 *
 * 产出：.verify/v07-ratio/results.json 与四视角截图。
 * 这里只验证「花头缩放确实只改花头、枝长/花头中心按尺寸候选变化」，观感仍需人看截图。
 */

import {chromium} from 'playwright-core';
import {mkdirSync,writeFileSync} from 'node:fs';

const BASE=process.env.RATIO_URL??'http://127.0.0.1:5190/';
const OUT='.verify/v07-ratio';
mkdirSync(OUT,{recursive:true});

/**
 * V0.7.3 尺寸候选相对候选 a 的倍率（head 是花头宽度比，stem 是枝长/花头中心位移比）。
 * b = 花头 0.64 / a 0.80 = 0.8；c = 0.56 / 0.80 = 0.7。
 */
const SIZE_SCALE_BY_CANDIDATE={a:{head:1,stem:1},b:{head:0.8,stem:0.88},c:{head:0.7,stem:0.85}};

let passed=0;const checks=[];const errors=[];
function check(name,ok,detail){
  checks.push({name,ok,detail:detail??null});
  if(!ok)throw Error(`${name}: ${JSON.stringify(detail)}`);
  passed++;console.log('ok',name);
}

const browser=await chromium.launch({channel:'chrome',headless:process.env.HEADED!=='1',args:['--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding']});
const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1});
const page=await context.newPage();
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404'))errors.push(m.text());});

const exec=fn=>page.evaluate(fn);
const wait=ms=>page.waitForTimeout(ms);
const state=()=>exec(()=>window.__bouquetDebug.getState());

async function open(sample,head,view){
  await page.goto(`${BASE}?sample=${sample}&head=${head}&view=${view}`);
  await page.waitForFunction(()=>window.__bouquetDebug?.getState().catalog.mode==='manifest');
  await page.waitForFunction(()=>{
    const s=window.__bouquetDebug.getState();
    if(s.doc.stems.length===0)return false;
    return [...window.__bouquetDebug.scene.views.values()].every(v=>v.object);
  },{timeout:20000});
  await wait(1100);
}

/** 背面视角：转 180°。预设里没有背面，用相机实际翻转，保留其余参数。 */
async function flipToBack(){
  await exec(()=>{
    const d=window.__bouquetDebug;const cam=d.scene.camera,t=d.scene.controls.target;
    const dx=cam.position.x-t.x,dy=cam.position.y-t.y,dz=cam.position.z-t.z;
    cam.position.set(t.x-dx,t.y+dy,t.z-dz);d.scene.controls.update();
  });
  await wait(600);
}

async function shot(name){
  await page.locator('[data-testid=viewport]').screenshot({path:`${OUT}/${name}.png`});
}

function measure(){
  return exec(()=>{
    const d=window.__bouquetDebug;const doc=d.getState().doc;
    const out={};
    for(const [id,view] of d.scene.views){
      const stem=doc.stems.find(s=>s.id===id);if(!stem||!view.loaded)continue;
      const upper=view.object?.getObjectByName('prepared-upper-stem');
      const entry={};
      if(view.loaded.headMetrics){
        entry.headWidth=+view.loaded.headMetrics.width.toFixed(4);
        entry.headHeight=+view.loaded.headMetrics.height.toFixed(4);
        entry.headCenter=+view.loaded.headMetrics.centerY.toFixed(4);
      }
      entry.headRadius=+view.loaded.headRadius.toFixed(4);
      entry.headAnchor=+view.loaded.headHeight.toFixed(4);
      entry.upperStem=upper?+(upper.userData.fullHeight*upper.scale.y).toFixed(4):null;
      entry.headParts=(view.loaded.headParts??[]).length;
      entry.stemScale=+stem.scale.toFixed(3);
      const bucket=out[stem.assetId]??(out[stem.assetId]={count:0,items:[]});
      bucket.count++;bucket.items.push(entry);
    }
    const stats=d.getSceneState().stats;
    const byKind={};
    for(const stem of doc.stems){
      const kind=d.getState().catalog.entriesById[stem.assetId]?.kind??'main';
      byKind[kind]=(byKind[kind]??0)+1;
    }
    return {stems:doc.stems.length,byKind,measure:out,stats};
  });
}

const recorded={};

try{
  // ---------- 1. 三个样束的配方与枝数 ----------
  const expected={6:{main:3,filler:2,greenery:1},12:{main:5,filler:4,greenery:3},20:{main:8,filler:7,greenery:5}};
  for(const size of [6,12,20]){
    await open(size,0.8,'front');
    const data=await measure();
    recorded[`bundle${size}`]=data;
    check(`${size} 枝样束枝数正确`,data.stems===size,{stems:data.stems});
    check(`${size} 枝样束分类为 3/2/1 或 5/4/3 或 8/7/5`,
      data.byKind.main===expected[size].main&&data.byKind.filler===expected[size].filler&&data.byKind.greenery===expected[size].greenery,
      {byKind:data.byKind});
  }

  // ---------- 2. 花头倍率对照（12 枝样束） ----------
  const ratios={};
  for(const head of [1,0.9,0.8,0.7]){
    await open(12,head,'front');
    await shot(`12-${head}-front`);
    await exec(()=>window.__bouquetDebug.store.setViewPreset('side'));await wait(900);await shot(`12-${head}-side`);
    await exec(()=>window.__bouquetDebug.store.setViewPreset('top'));await wait(900);await shot(`12-${head}-top`);
    await exec(()=>window.__bouquetDebug.store.setViewPreset('front'));await wait(900);await flipToBack();await shot(`12-${head}-back`);
    const data=await measure();
    recorded[`head${head}`]=data;
    ratios[head]={
      roseWidth:data.measure['rose-pink']?.items[0]?.headWidth??null,
      tulipWidth:data.measure['rose-pink']?.items[0]?.headWidth??null,
      roseCenter:data.measure['rose-pink']?.items[0]?.headCenter??null,
      roseAnchor:data.measure['rose-pink']?.items[0]?.headAnchor??null,
      roseUpper:data.measure['rose-pink']?.items[0]?.upperStem??null,
      roseRadius:data.measure['rose-pink']?.items[0]?.headRadius??null,
      sprayParts:data.measure['spray-rose-pink']?.items[0]?.headParts??null,
      paperRadius:null,
    };
  }
  const base=ratios[1];
  for(const head of [0.9,0.8,0.7]){
    const width=ratios[head].roseWidth;
    check(`花头 ${head*100}% 倍率：实测花头宽度比 ${(width/base.roseWidth).toFixed(3)}`,Math.abs(width/base.roseWidth-head)<0.03,{got:width/base.roseWidth,want:head});
  }
  // V0.7.3：花头中心改为「按可见顶点实测」。缩放仍是绕 headOffsetY 锚点做的，
  // 所以中心只随「花头几何中心与锚点的差值」小幅移动（玫瑰 70–100% 之间约 3–4mm），
  // 不再像旧实现那样被裁掉的茎顶点把中心拉到下方 11cm。
  const anchors=[1,0.9,0.8,0.7].map(h=>ratios[h].roseAnchor);
  const anchorSpread=Math.max(...anchors)-Math.min(...anchors);
  check(`花头中心随倍率只小幅变化（跨度 ${(anchorSpread*1000).toFixed(1)}mm ≤ 15mm）`,anchorSpread<=0.015,{anchors,spread:anchorSpread});
  check('花头中心与实测可见花头中心一致（0.30–0.40m，而不是被裁顶点拉低的 ~0.24m）',
    anchors.every(y=>y>0.30&&y<0.40),{anchors});
  check('花头缩小后上半段茎加长（补上花头底部空隙）',
    ratios[0.7].roseUpper>ratios[1].roseUpper,
    {u07:ratios[0.7].roseUpper,u10:ratios[1].roseUpper});
  check('花头占用半径跟实测宽度同步（半径≈宽/2）',
    Math.abs(ratios[0.8].roseRadius-ratios[0.8].roseWidth/2)<0.006,
    {radius:ratios[0.8].roseRadius,halfWidth:ratios[0.8].roseWidth/2});
  // V9：多头玫瑰已换成真实单网格 GLB（lux-spray.glb），没有程序化多头登记，
  // 场景按“一个实测花头”取包络；程序化兜底路径（builtin 模式 / GLB 加载失败）
  // 仍然是三个注册花头。两条路径都要覆盖，不能只保留旧断言。
  const sprayEntry=await exec(()=>{const e=window.__bouquetDebug.getState().catalog.entriesById['spray-rose-pink'];return e?{glb:e.glb??null,source:e.source}:null;});
  const sprayIsGlb=Boolean(sprayEntry?.glb);
  if(sprayIsGlb){
    check(`多头玫瑰（真实单网格 GLB ${sprayEntry.glb}）按单个实测花头处理、不注册程序多头`,ratios[0.8].sprayParts===0,{parts:ratios[0.8].sprayParts,glb:sprayEntry.glb});
  }else{
    check('多头玫瑰逐个登记三个花头（程序化兜底路径）',ratios[0.8].sprayParts===3,{parts:ratios[0.8].sprayParts,source:sprayEntry?.source??null});
  }

  // ---------- 2b. V0.7.3 尺寸候选 a/b/c：花头与枝长一起缩，握点不动 ----------
  const candidates={};
  for(const candidate of ['a','b','c']){
    await page.goto(`${BASE}?sample=12&size=${candidate}&view=front`);
    await page.waitForFunction(()=>window.__bouquetDebug?.getState().catalog.mode==='manifest');
    await page.waitForFunction(()=>{
      const s=window.__bouquetDebug.getState();
      return s.doc.stems.length===12&&[...window.__bouquetDebug.scene.views.values()].every(v=>v.object);
    },{timeout:20000});
    await wait(1100);
    const data=await measure();
    recorded[`size-${candidate}`]=data;
    candidates[candidate]={
      sizeCandidate:(await state()).sizeCandidate,
      assetsVersion:(await state()).catalog.assetsVersion,
      rose:data.measure['rose-pink']?.items[0]??null,
    };
  }
  const roseA=candidates.a.rose, roseB=candidates.b.rose, roseC=candidates.c.rose;
  for(const [id,rose] of [['b',roseB],['c',roseC]]){
    const want=SIZE_SCALE_BY_CANDIDATE[id].head;
    check(`候选 ${id} 的玫瑰实测头宽是候选 a 的 ${(want*100).toFixed(0)}%（±3%）`,
      Math.abs(rose.headWidth/roseA.headWidth-want)<0.03,
      {a:roseA.headWidth,got:rose.headWidth,ratio:rose.headWidth/roseA.headWidth,want});
    check(`候选 ${id} 的花头中心按 stemFactor 向握点收（±1cm）`,
      Math.abs(roseA.headCenter-rose.headCenter-(roseA.headCenter*(1-SIZE_SCALE_BY_CANDIDATE[id].stem)))<0.01,
      {aCenter:roseA.headCenter,center:rose.headCenter,stem:SIZE_SCALE_BY_CANDIDATE[id].stem});
  }
  check('候选 a 保持 V0.7 原比例（花头 0.8 倍率）',
    Math.abs(roseA.headWidth-base.roseWidth*0.8)<0.02,
    {aWidth:roseA.headWidth,want:base.roseWidth*0.8});

  // ---------- 3. 6 / 20 枝四视角截图（用 80% 起始校准值） ----------
  for(const size of [6,20]){
    await open(size,0.8,'front');
    await shot(`${size}-0.8-front`);
    await exec(()=>window.__bouquetDebug.store.setViewPreset('side'));await wait(900);await shot(`${size}-0.8-side`);
    await exec(()=>window.__bouquetDebug.store.setViewPreset('top'));await wait(900);await shot(`${size}-0.8-top`);
    await exec(()=>window.__bouquetDebug.store.setViewPreset('front'));await wait(900);await flipToBack();await shot(`${size}-0.8-back`);
  }

  // 斜 45° 是默认观赏角度，单独留一套给审美审阅用。
  for(const size of [6,12,20]){
    await open(size,0.8,'quarter');
    await shot(`${size}-0.8-quarter`);
  }

  check('全程无页面与 WebGL 错误',errors.length===0,errors);
  writeFileSync(`${OUT}/results.json`,JSON.stringify({
    date:new Date().toISOString(),
    passed,
    checks,
    ratios,
    recorded,
    errors,
    note:'花头倍率与枝长通过实测几何断言；观感（比例是否协调）仍需人看截图。',
  },null,2));
  console.log(`PASSED ${passed}`);
}catch(error){
  writeFileSync(`${OUT}/failure.json`,JSON.stringify({date:new Date().toISOString(),passed,checks,error:String(error),errors},null,2));
  throw error;
}finally{
  await browser.close();
}
