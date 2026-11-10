/**
 * V0.7.5 素材验证：30 花型 / 53 条配色，全部来自 manifest 的真实 GLB。
 *
 * 用法：
 *   1) npm run dev -- --port 5190 --strictPort
 *   2) 真实清单（管线交付后）：node scripts/v07-materials.mjs
 *      未等管线、用测试清单（3 个现有 GLB 冒充 30 花型）：
 *      $env:MATERIALS_MANIFEST='.verify/manifest-fixture.json'; node scripts/v07-materials.mjs
 *
 * 检查：
 * - 主花／配花／绿叶各 10 种、共 30 花型 / 53 条配色；
 * - 53 条全部是 manifest 条目（每条都有 glb），花材架用静态缩略图，
 *   不再为每条配色下载 GLB（缺图的少数几条才回退运行时渲染）；
 * - 30 花型都能单独放一枝，加载到的真的是 GLB（loaded.source==='glb'），
 *   三角面在预算内、花头高度与半径在合理量级（默认尺寸候选 b）；
 * - 混合花束同框加载、正视图截图，供人工辨识。
 *
 * 真实 manifest 未齐时不会放松断言：会把「N 条仍是程序化占位」连同缺失
 * 的 assetId 一起写进 .verify/v07-materials/failure.json。
 */

import {chromium} from 'playwright-core';
import {mkdirSync,writeFileSync} from 'node:fs';

const BASE=process.env.MATERIAL_URL??'http://127.0.0.1:5190/';
const MANIFEST=process.env.MATERIALS_MANIFEST??'';
const OUT=process.env.MATERIALS_OUT??'.verify/v07-materials';
mkdirSync(OUT,{recursive:true});

let passed=0;const checks=[];const errors=[];const rows=[];
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
page.on('crash',()=>errors.push('page crashed (渲染进程异常)'));
const glbRequests=[];
let countingGlb=true;
page.on('request',r=>{if(countingGlb&&r.url().includes('.glb'))glbRequests.push(r.url());});

const exec=(fn,arg)=>page.evaluate(fn,arg);
const wait=ms=>page.waitForTimeout(ms);
const url=`${BASE}?head=0.8&view=front${MANIFEST?`&manifest=${encodeURIComponent(MANIFEST)}`:''}`;

/** 三角面预算：管线只压贴图不改几何，现有真实 GLB 在 3.7–5.9 万；留一倍余量。 */
const TRIANGLE_BUDGET=120000;

try{
  await page.goto(url);
  await page.waitForFunction(()=>window.__bouquetDebug?.getState().catalog.mode==='manifest',null,{timeout:60000});
  await page.waitForFunction(()=>document.querySelectorAll('img.model-thumbnail').length>=30,null,{timeout:60000});
  // 等 30 张缩略图全部解码：有静态图的很快，缺图落回运行时渲染的要真的加载模型。
  await page.waitForFunction(
    ()=>(()=>{const imgs=[...document.querySelectorAll('img.model-thumbnail')];return imgs.length>=30&&imgs.every(i=>i.complete&&i.naturalWidth>0);})(),
    null,
    {timeout:120000},
  );
  await wait(600);
  countingGlb=false;

  // ---------- 1. 目录结构：30 花型 / 53 配色 ----------
  const catalog=await exec(()=>{
    const d=window.__bouquetDebug;const c=d.getState().catalog;
    const byKind={main:[],filler:[],greenery:[]};
    for(const f of c.families)(byKind[f.kind]??=[]).push(f.displayName);
    return {
      byKind,entries:c.entries.length,families:c.families.length,
      assetsVersion:c.assetsVersion,
      procedural:c.entries.filter(e=>!e.glb).map(e=>({id:e.assetId,source:e.source})),
      manifestEntries:c.entries.filter(e=>e.source==='manifest').length,
      withThumb:c.entries.filter(e=>e.thumb).length,
      kinds:c.entries.reduce((acc,e)=>({...acc,[e.kind]:(acc[e.kind]??0)+1}),{}),
      cards:document.querySelectorAll('.shelf-card').length,
      staticThumbs:[...document.querySelectorAll('img.model-thumbnail')].filter(i=>!i.src.startsWith('data:')).length,
      runtimeThumbs:[...document.querySelectorAll('img.model-thumbnail')].filter(i=>i.src.startsWith('data:')).length,
      decodedThumbs:[...document.querySelectorAll('img.model-thumbnail')].filter(i=>i.complete&&i.naturalWidth>0).length,
    };
  });
  const fixture=catalog.assetsVersion.startsWith('fixture');
  const paletteGlbRequests=glbRequests.slice();
  check('主花 10 种',catalog.byKind.main.length===10,{names:catalog.byKind.main});
  check('配花 10 种',catalog.byKind.filler.length===10,{names:catalog.byKind.filler});
  check('绿叶 10 种',catalog.byKind.greenery.length===10,{names:catalog.byKind.greenery});
  check('花材架共 30 花型',catalog.families===30,{families:catalog.families});
  check('花材架共 53 条配色',catalog.entries===53,{entries:catalog.entries,kinds:catalog.kinds});
  check(
    '53 条配色全部来自 manifest 的真实 GLB',
    catalog.procedural.length===0&&catalog.manifestEntries===53,
    {manifestEntries:catalog.manifestEntries,stillProcedural:catalog.procedural.slice(0,60),hint:catalog.procedural.length?'manifest 还没齐：这些 id 仍是程序化占位':null},
  );
  check('花材架渲染 30 张卡',catalog.cards===30,{cards:catalog.cards});
  check('花材架缩略图全部出图',catalog.decodedThumbs===30,{decoded:catalog.decodedThumbs,static:catalog.staticThumbs,runtime:catalog.runtimeThumbs});
  check('53 条配色都带静态缩略图字段（thumb）',catalog.withThumb===53,{withThumb:catalog.withThumb});
  check(
    '花材架每张缩略图 = 静态图或运行时回退渲染',
    catalog.staticThumbs+catalog.runtimeThumbs===30,
    {staticThumbs:catalog.staticThumbs,runtimeThumbs:catalog.runtimeThumbs},
  );
  check(
    '不为 53 条配色逐个下载 GLB（GLB 请求 ≤ 运行时回退的缩略图数）',
    paletteGlbRequests.length<=catalog.runtimeThumbs,
    {requests:paletteGlbRequests.length,runtimeThumbs:catalog.runtimeThumbs,urls:[...new Set(paletteGlbRequests)]},
  );
  await page.screenshot({path:`${OUT}/00-palette.png`});

  // ---------- 2. 逐一放花：每种都用自己的真实 GLB ----------
  // 每种放一枝都要新开一份模板（模型 7–8 MB/枝）。测试清单用 3 个现有 GLB
  // 冒充 30 花型，不释放会累积到渲染进程崩溃；每轮放完先清实例、再清
  // AssetLoader 模板缓存（与「重试重载」同一条路径），内存才有界。
  const triangleSets=new Set();
  for(const family of await exec(()=>window.__bouquetDebug.getState().catalog.families.map(f=>({family:f.family,kind:f.kind,name:f.displayName,assetId:f.entries[0].assetId})))){
    const info=await exec(async(assetId)=>{
      const d=window.__bouquetDebug,s=d.store;
      s.clearStems();
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      d.scene.assetLoader?.clearCache?.();
      s.setPlacement(assetId);
      s.placeStem({tilt:4,direction:0,height:0.03});
      s.setPlacement(null);
      const stems=d.getState().doc.stems;
      const id=stems[stems.length-1]?.id;
      if(!id)return {error:'no stem'};
      for(let i=0;i<120;i++){
        const v=d.scene.views.get(id);
        if(v?.object)break;
        await new Promise(r=>setTimeout(r,50));
      }
      const v=d.scene.views.get(id);
      if(!v?.loaded)return {error:'not loaded'};
      let tris=0;let meshes=0;
      v.loaded.template.traverse(o=>{const m=o;if(m.isMesh){meshes++;const g=m.geometry;tris+=g.index?g.index.count/3:g.attributes.position.count/3;}});
      return {ok:true,assetId:v.loaded.assetId,headHeight:+v.loaded.headHeight.toFixed(4),headRadius:+v.loaded.headRadius.toFixed(4),tris:Math.round(tris),meshes,source:v.loaded.source,headMetrics:Boolean(v.loaded.headMetrics),headParts:v.loaded.headParts?.length??0,scale:+d.getState().doc.stems.find(x=>x.id===id).scale.toFixed(2)};
    },family.assetId);
    if(info.error)throw Error(`放花失败 ${family.family}: ${info.error}`);
    rows.push({...family,...info});
    triangleSets.add(info.tris);
    await wait(120);
    await page.locator('[data-testid=viewport]').screenshot({path:`${OUT}/${family.kind}-${family.family}.png`});
  }
  check('30 种都能单独放一枝并加载',rows.length===30,{loaded:rows.length});
  check(
    '每种都加载了真实 GLB（没有回退程序化占位）',
    rows.every(r=>r.source==='glb'),
    rows.filter(r=>r.source!=='glb').map(r=>({f:r.family,source:r.source})),
  );
  check('每种都有真实几何（非空白）',rows.every(r=>r.tris>50&&r.meshes>=1),rows.filter(r=>r.tris<=50).map(r=>({f:r.family,tris:r.tris})));
  check(
    '单枝三角面在预算内（≤ 12 万）',
    rows.every(r=>r.tris<=TRIANGLE_BUDGET),
    rows.filter(r=>r.tris>TRIANGLE_BUDGET).map(r=>({f:r.family,tris:r.tris})),
  );
  check(
    '真实 GLB 三角面数万级（> 1 万）',
    rows.every(r=>r.tris>10000),
    rows.filter(r=>r.tris<=10000).map(r=>({f:r.family,tris:r.tris})),
  );
  check(
    '每种花型的几何互不相同（不是全回退同一种占位）',
    triangleSets.size>= (fixture?3:20),
    {distinct:triangleSets.size,total:rows.length,fixture},
  );
  // V0.7.3：默认尺寸候选 b 把花头中心往握点收了 ~12%，花头再小 20%，
  // 范围 0.25–0.55m 仍能抓住「花头贴地」或「花头飞到握点外」这类量级错误。
  check('花头高度在合理量级（0.25–0.55m，默认候选 b）',rows.every(r=>r.headHeight>0.25&&r.headHeight<0.55),rows.map(r=>({f:r.family,h:r.headHeight})).filter(r=>r.h<=0.25||r.h>=0.55));
  // 花头半径上限放到 0.22：绿叶的叶面铺开本来就比花头宽，这也是解析时的夹取上限。
  check('花头半径在合理量级（0.02–0.22m）且大于 0',rows.every(r=>r.headRadius>0.02&&r.headRadius<=0.22),rows.map(r=>({f:r.family,r:r.headRadius})).filter(r=>r.r<=0.02||r.r>0.22));
  // 主花的花头必须比配花大：混插时主次才分得开（绿叶按页面铺开，不参与比较）。
  const mainRadius=rows.filter(r=>r.kind==='main').reduce((n,r)=>n+r.headRadius,0)/rows.filter(r=>r.kind==='main').length;
  const fillerRadius=rows.filter(r=>r.kind==='filler').reduce((n,r)=>n+r.headRadius,0)/rows.filter(r=>r.kind==='filler').length;
  check('主花花头平均比配花大',mainRadius>fillerRadius,{main:+mainRadius.toFixed(3),filler:+fillerRadius.toFixed(3)});
  // 玫瑰/郁金香是切出独立花头实测的；其余 28 种单网格 GLB 走管线的
  // transform.headOffsetY + size.headRadius，不该出现「分离花头」。
  const split=rows.filter(r=>['rose','tulip'].includes(r.family));
  check('玫瑰/郁金香有分离花头实测，其余花型走单网格实测值',split.every(r=>r.headMetrics)&&rows.filter(r=>!['rose','tulip'].includes(r.family)).every(r=>!r.headMetrics),{split:split.map(r=>({f:r.family,metrics:r.headMetrics})),single:rows.filter(r=>!r.headMetrics).length});

  // ---------- 3. 混合花束：三分类各取几种，检查同框加载 ----------
  const mixed=await exec(async()=>{
    const d=window.__bouquetDebug,s=d.store,c=d.getState().catalog;
    const pick=(kind,index)=>c.families.filter(f=>f.kind===kind)[index].entries[0].assetId;
    s.clearStems();
    const plan=[[pick('main',0),3],[pick('main',7),2],[pick('filler',3),2],[pick('greenery',4),2]];
    let angle=0;
    for(const [assetId,count] of plan){
      for(let i=0;i<count;i++){
        s.setPlacement(assetId);
        s.placeStem({tilt:8+(i%3)*6,direction:angle,height:0.03});
        s.setPlacement(null);angle+=41;
      }
    }
    for(let i=0;i<160;i++){
      const all=[...d.scene.views.values()].every(v=>v.object&&v.loaded?.source==='glb');
      if(all)break;
      await new Promise(r=>setTimeout(r,60));
    }
    return {stems:s.getState().doc.stems.length,loaded:[...d.scene.views.values()].filter(v=>v.object&&v.loaded?.source==='glb').length};
  });
  check('混合花束 9 枝全部用真实 GLB 加载',mixed.stems===9&&mixed.loaded===9,mixed);
  await exec(()=>window.__bouquetDebug.store.setViewPreset('quarter'));
  await wait(1000);
  await page.screenshot({path:`${OUT}/99-mixed.png`});

  check('无页面与 WebGL 错误',errors.length===0,errors.slice(0,5));
  writeFileSync(`${OUT}/results.json`,JSON.stringify({date:new Date().toISOString(),url,fixture,passed,checks,rows,catalog,errors},null,2));
  console.log(`PASSED ${passed}`);
}catch(error){
  writeFileSync(`${OUT}/failure.json`,JSON.stringify({date:new Date().toISOString(),url,fixture:MANIFEST,passed,checks,rows,error:String(error),errors},null,2));
  throw error;
}finally{
  await browser.close();
}
