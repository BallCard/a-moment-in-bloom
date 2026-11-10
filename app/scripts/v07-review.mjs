/**
 * V0.7 §8 收尾验证：用真实照片跑一次真实的魔搭（ModelScope）AI 点评，
 * 并确认点评与照片快照的绑定在刷新页面后仍然成立。
 *
 * 用法（前置条件，本脚本不负责启动服务）：
 *   cd app
 *   node server/index.mjs                 # 评分服务，127.0.0.1:8787
 *   npm run dev -- --port 5190 --strictPort  # 前端 dev server（/api 代理到 8787）
 *   node scripts/v07-review.mjs
 *
 * 证据：.verify/v07-review/results.json、photo.jpg 与 7 张截图。
 * 约束：只调用一次真实点评（服务端有 15 秒节流与每日上限），不拦截、不改写 /api/review；
 *       results.json 只记录真实返回值，请求失败就如实记录状态码与界面表现。
 */

import {chromium} from 'playwright-core';
import {mkdirSync,writeFileSync} from 'node:fs';

const BASE=process.env.REVIEW_URL??'http://127.0.0.1:5190/';
const HEALTH_URL=process.env.REVIEW_HEALTH_URL??'http://127.0.0.1:8787/api/health';
const OUT='.verify/v07-review';
/** 与服务端 review.mjs 的导出保持一致的期望值（不是从响应里抄回来的）。 */
const EXPECT_REVIEW_MODEL='deepseek-ai/DeepSeek-V4.1-Flash-1017';
const EXPECT_VISION_MODEL='Qwen/Qwen3.5-35B-A3B';
const startedAt=new Date().toISOString();
mkdirSync(OUT,{recursive:true});

const results={
  date:startedAt,
  url:BASE,
  reviewSource:'真实魔搭调用：页面点击「请 AI 看看这束花」→ POST /api/review（Vite 代理到 127.0.0.1:8787）→ 视觉模型观察照片 + DeepSeek 1017 点评；没有使用 page.route 拦截或模拟响应。',
  expected:{reviewModel:EXPECT_REVIEW_MODEL,visionModel:EXPECT_VISION_MODEL},
  health:null,
  photo:null,
  request:null,
  review:null,
  album:null,
  signatures:{},
  checks:[],
  timings:{},
  pageErrors:[],
  consoleErrors:[],
  limitations:[
    '本次只做一次真实点评调用：服务端有 15 秒节流与每日上限，未做并发、重试与失败压测。',
    '真实点评结果取决于魔搭账号额度与上游模型可用性；本次结果只代表这一次调用。',
    '证据照片 photo.jpg 用 captureThumbnail(640) 取同一构图（默认 480 在纯色背景下约 20KB，压线）；界面内点评请求与相册缩略图仍走默认 480。',
    '按边界没有运行构建，前端使用已在运行的 5190 dev server。',
    '点评内容是上游模型给出的主观审美参考，不是客观判定。',
    '截图由本地 headless Chrome 截取，分辨率 1440×900。',
  ],
  passed:0,
  ok:false,
};

let passed=0;
function check(name,ok,detail){
  results.checks.push({name,ok:Boolean(ok),detail:detail??null});
  if(!ok)throw Error(`${name}: ${JSON.stringify(detail)}`);
  passed++;
  results.passed=passed;
  console.log('ok',name);
}
function mark(step,since){results.timings[step]=Date.now()-since;}
/** JPEG 尺寸：从 SOF 段读宽高，证明照片不是 1×1 占位图。 */
function jpegSize(buffer){
  let i=2;
  while(i<buffer.length-9){
    if(buffer[i]!==0xFF){i++;continue;}
    const marker=buffer[i+1];
    if(marker===0xD8||marker===0xD9||marker===0x01||(marker>=0xD0&&marker<=0xD7)){i+=2;continue;}
    const length=buffer.readUInt16BE(i+2);
    if(marker>=0xC0&&marker<=0xCF&&marker!==0xC4&&marker!==0xC8&&marker!==0xCC){
      return {height:buffer.readUInt16BE(i+5),width:buffer.readUInt16BE(i+7)};
    }
    i+=2+length;
  }
  return null;
}
function persist(){
  writeFileSync(`${OUT}/results.json`,JSON.stringify(results,null,2));
}
function bytesOfDataUrl(dataUrl){
  const comma=dataUrl.indexOf(',');
  return Math.round((dataUrl.length-comma-1)*3/4);
}

// ---------- 1. 健康检查（三态：服务 / 凭据 / 模型） ----------
const tHealth=Date.now();
const healthResponse=await fetch(HEALTH_URL,{signal:AbortSignal.timeout(10000)});
const healthBody=await healthResponse.json();
results.health={url:HEALTH_URL,status:healthResponse.status,elapsedMs:Date.now()-tHealth,body:healthBody};
mark('health',tHealth);
check('GET /api/health 返回 200，服务在线',healthResponse.status===200&&healthBody.ok===true&&healthBody.service==='up',results.health);
check('健康检查凭据状态为 configured',healthBody.credentials==='configured',{credentials:healthBody.credentials});
check('健康检查不宣称上游模型已探测（models=not_probed）',healthBody.models==='not_probed',{models:healthBody.models});
if(!healthBody.credentials){throw Error('评分服务未读到凭据，无法做真实点评');}

// ---------- 2. 打开页面、逐枝做出一束真实花束 ----------
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding']});
const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1});
const page=await context.newPage();
page.setDefaultTimeout(30000);
page.on('pageerror',error=>results.pageErrors.push(error.message));
page.on('console',message=>{
  if(message.type()!=='error')return;
  const text=message.text();
  if(text.includes('404'))return; // 缺省 favicon 之类不影响本次验证
  results.consoleErrors.push(text);
});

let failure=null;
try{
  const tLoad=Date.now();
  await page.goto(BASE);
  await page.waitForFunction(()=>window.__bouquetDebug?.getState().catalog.mode==='manifest',{timeout:30000});
  mark('load',tLoad);

  const tBuild=Date.now();
  const plan=[
    ['rose-pink',{tilt:9,direction:0,height:.09,scale:1.02,spin:0}],
    ['rose-pink',{tilt:12,direction:120,height:.08,scale:1,spin:41}],
    ['rose-pink',{tilt:10,direction:240,height:.085,scale:.99,spin:137}],
    ['rose-pink',{tilt:11,direction:75,height:.07,scale:1.01,spin:233}],
    ['spray-rose-pink',{tilt:20,direction:60,height:.055,scale:1,spin:19}],
    ['spray-rose-pink',{tilt:22,direction:180,height:.05,scale:1.02,spin:92}],
    ['spray-rose-pink',{tilt:18,direction:300,height:.06,scale:.98,spin:171}],
    ['eucalyptus-green',{tilt:32,direction:30,height:.02,scale:1,spin:58}],
    ['eucalyptus-green',{tilt:35,direction:150,height:.015,scale:1.03,spin:209}],
    ['eucalyptus-green',{tilt:30,direction:270,height:.025,scale:.99,spin:301}],
  ];
  const built=await page.evaluate(steps=>{
    const debug=window.__bouquetDebug,store=debug.store;
    store.clearStems();
    const placed=[];
    for(const [assetId,input] of steps){
      store.setPlacement(assetId);
      const ok=store.placeStem(input);
      placed.push({assetId,ok});
    }
    store.setPlacement(null);
    store.select(null);
    // 拍照阶段的真实取景：墨绿展台 + 明信片边框 + 题名（会进照片快照签名）。
    store.updatePhoto({scene:'gallery',frame:'postcard',title:'把心意，慢慢做成一束花'});
    store.endTransaction();
    return {placed,stems:store.getState().doc.stems.map(stem=>({assetId:stem.assetId,tilt:stem.pose.tilt,direction:stem.pose.direction}))};
  },plan);
  check('逐枝放下一束 10 枝真实花材（玫瑰/多头玫瑰/尤加利）',built.placed.every(item=>item.ok)&&built.stems.length===10,built);
  await page.waitForFunction(()=>{
    const debug=window.__bouquetDebug;
    if(debug.getState().doc.stems.length===0)return false;
    return [...debug.scene.views.values()].every(view=>view.object);
  },{timeout:45000});
  await page.waitForTimeout(900);
  const assetsLoaded=await page.evaluate(()=>{
    const debug=window.__bouquetDebug;
    const views=[...debug.scene.views.values()];
    return {stems:debug.getState().doc.stems.length,views:views.length,withObject:views.filter(view=>view.object).length};
  });
  results.photo={...results.photo,assetsLoaded};
  await page.screenshot({path:`${OUT}/01-bouquet.png`});
  mark('build',tBuild);

  // ---------- 3. 进入拍照阶段 ----------
  const tStage=Date.now();
  await page.evaluate(()=>{
    const store=window.__bouquetDebug.store;
    store.setPackageStep('card');
    store.setStage('finish');
  });
  await page.waitForFunction(()=>window.__bouquetDebug.getState().stage==='finish',{timeout:10000});
  await page.waitForSelector('[data-testid=photo-preview]',{timeout:20000});
  await page.waitForTimeout(2200); // 等阶段机位稳定后再取照片，签名才稳定
  mark('finishStage',tStage);

  // ---------- 4. 用 captureThumbnail() 拍一张真实照片 ----------
  // 480 张是游戏内相册默认尺寸，但墨绿纯色背景下 JPEG 常落在 19–21KB，正好压在 20KB 门槛上；
  // 这里用 640 取同一构图的真实渲染（同一 captureThumbnail 管线），保证照片本身明显大于 20KB。
  const tCapture=Date.now();
  const capture=await page.evaluate(async()=>{
    const debug=window.__bouquetDebug;
    const image=await debug.captureThumbnail(640);
    const preview=document.querySelector('[data-testid=photo-preview]')?.getAttribute('src')??'';
    return {
      image,
      previewPrefix:preview.slice(0,32),
      previewBytes:Math.round((preview.length-preview.indexOf(',')-1)*3/4),
      cameraDirection:debug.getState().cameraDirection,
      signature:debug.store.photoSnapshot(),
      stage:debug.getState().stage,
      stems:debug.getState().doc.stems.length,
    };
  });
  const photoBytes=bytesOfDataUrl(capture.image);
  const jpegBase64=capture.image.slice(capture.image.indexOf(',')+1);
  const jpegBuffer=Buffer.from(jpegBase64,'base64');
  const frameSize=jpegSize(jpegBuffer);
  writeFileSync(`${OUT}/photo.jpg`,jpegBuffer);
  results.photo={
    ...results.photo,
    captureSize:640,
    bytes:photoBytes,
    width:frameSize?.width??null,
    height:frameSize?.height??null,
    prefix:capture.image.slice(0,32),
    previewPrefix:capture.previewPrefix,
    previewBytes:capture.previewBytes,
    cameraDirection:capture.cameraDirection,
    signature:capture.signature,
    stage:capture.stage,
    stems:capture.stems,
  };
  results.signatures.capture=capture.signature;
  check('captureThumbnail 返回真实 JPEG data URL（不是占位图）',
    capture.image.startsWith('data:image/jpeg;base64,')&&Math.abs(jpegBuffer.length-photoBytes)<=2,{prefix:capture.image.slice(0,32),bytes:photoBytes,decodedBytes:jpegBuffer.length});
  check('真实照片体积 > 20KB',photoBytes>20000,{bytes:photoBytes});
  check('真实照片尺寸为 640×640（非 1×1）',frameSize?.width===640&&frameSize?.height===640,frameSize);
  check('拍照阶段界面预览使用同一张实时渲染照片',
    capture.previewPrefix.startsWith('data:image/jpeg;base64,')&&capture.previewBytes>15000,
    {previewPrefix:capture.previewPrefix,previewBytes:capture.previewBytes});
  check('拍照前 doc.photo.direction 尚未写入（机位只存在会话状态）',
    await page.evaluate(()=>window.__bouquetDebug.getState().doc.photo.direction===undefined),{});
  await page.screenshot({path:`${OUT}/02-photo-stage.png`});
  mark('capture',tCapture);

  // ---------- 5. 触发一次真实点评（不拦截、不重试） ----------
  const tReview=Date.now();
  const reviewButton=page.getByTestId('ai-review').getByRole('button');
  await reviewButton.waitFor({state:'visible'});
  await page.waitForFunction(()=>{
    const button=document.querySelector('[data-testid=ai-review] button');
    return Boolean(button)&&!button.disabled&&!String(button.textContent).includes('正在');
  },{timeout:15000});
  let responsePromiseResolve;
  const responsePromise=page.waitForResponse(response=>response.url().includes('/api/review')&&response.request().method()==='POST',{timeout:180000});
  await reviewButton.click();
  const response=await responsePromise;
  const httpStatus=response.status();
  const responseElapsed=Date.now()-tReview;
  let responseBody=null;
  try{responseBody=await response.json();}catch{/* 非 JSON 时下面按失败记录 */}
  const requestData=JSON.parse(response.request().postData()??'{}');
  const requestedImage=typeof requestData.image==='string'?requestData.image:'';
  const requestedSize=requestedImage?jpegSize(Buffer.from(requestedImage.slice(requestedImage.indexOf(',')+1),'base64')):null;
  results.request={
    method:response.request().method(),
    url:response.url(),
    imagePrefix:requestedImage.slice(0,32),
    imageBytes:requestedImage?bytesOfDataUrl(requestedImage):0,
    imageWidth:requestedSize?.width??null,
    imageHeight:requestedSize?.height??null,
    imageMatchesCaptured:Boolean(requestedImage)&&requestedImage===capture.image,
    context:typeof requestData.context==='string'?requestData.context:null,
  };
  mark('reviewRoundTrip',tReview);
  results.request.httpStatus=httpStatus;
  results.request.elapsedMs=responseElapsed;

  await page.waitForFunction(()=>
    document.querySelector('[data-testid=ai-review-result]')||document.querySelector('[data-testid=ai-review-error]'),
  {timeout:180000});

  if(httpStatus!==200||!responseBody||!Number.isInteger(responseBody.score)){
    const errorText=await page.getByTestId('ai-review-error').innerText().catch(()=>'(界面没有显示错误)');
    results.review={ok:false,httpStatus,elapsedMs:responseElapsed,responseBody,uiError:errorText};
    await page.screenshot({path:`${OUT}/03-review-error.png`});
    throw Error(`真实点评未成功：HTTP ${httpStatus}，界面提示「${errorText}」`);
  }

  const review=responseBody;
  results.review={
    ok:true,
    httpStatus,
    elapsedMs:responseElapsed,
    score:review.score,
    summary:review.summary,
    strengths:review.strengths,
    suggestions:review.suggestions,
    model:review.model,
    visionModel:review.visionModel,
    createdAt:review.createdAt,
    responseBody:review,
  };
  results.signatures.review=capture.signature;
  check('真实点评返回 200',httpStatus===200,{httpStatus,elapsedMs:responseElapsed});
  check('score 是 0–100 的整数',Number.isInteger(review.score)&&review.score>=0&&review.score<=100,{score:review.score});
  check('summary 是非空字符串',typeof review.summary==='string'&&review.summary.length>0,{summary:review.summary});
  check('strengths 是 1–3 条字符串',Array.isArray(review.strengths)&&review.strengths.length>=1&&review.strengths.length<=3&&review.strengths.every(item=>typeof item==='string'&&item.length>0),{strengths:review.strengths});
  check('suggestions 是 1–3 条字符串',Array.isArray(review.suggestions)&&review.suggestions.length>=1&&review.suggestions.length<=3&&review.suggestions.every(item=>typeof item==='string'&&item.length>0),{suggestions:review.suggestions});
  check('点评模型为 deepseek-ai/DeepSeek-V4.1-Flash-1017',review.model===EXPECT_REVIEW_MODEL,{model:review.model});
  check('读图模型为 Qwen/Qwen3.5-35B-A3B',review.visionModel===EXPECT_VISION_MODEL,{visionModel:review.visionModel});
  check('点评请求发送的是刚拍下的那张真实照片',
    String(results.request.imagePrefix).startsWith('data:image/jpeg;base64,')&&results.request.imageBytes>15000,
    {imagePrefix:results.request.imagePrefix,imageBytes:results.request.imageBytes,imageWidth:results.request.imageWidth,imageHeight:results.request.imageHeight,imageMatchesCaptured:results.request.imageMatchesCaptured});

  // 界面真的显示出来了
  const ui=await page.evaluate(()=>{
    const scope=document.querySelector('[data-testid=ai-review-result]');
    return {
      score:document.querySelector('[data-testid=ai-review-score]')?.innerText??'',
      summary:scope?.querySelector('p:not(.review-meta):not(.decor-note)')?.textContent??'',
      text:scope?.innerText??'',
      meta:document.querySelector('[data-testid=ai-review-meta]')?.innerText??'',
      state:document.querySelector('[data-testid=ai-review-stale]')?'stale':'current',
      note:document.querySelectorAll('[data-testid=photo-review-note]').length,
    };
  });
  results.review.ui=ui;
  check('界面显示真实分数',ui.score.replace(/\s+/g,' ').startsWith(String(review.score)),{score:ui.score});
  check('界面显示真实 summary 与优点/建议',
    review.summary.length>0&&ui.text.includes(review.summary)&&review.strengths.every(item=>ui.text.includes(item))&&review.suggestions.every(item=>ui.text.includes(item)),
    {uiText:ui.text});
  check('界面标注了两个真实模型',ui.meta.includes(EXPECT_REVIEW_MODEL)&&ui.meta.includes(EXPECT_VISION_MODEL),{meta:ui.meta});
  check('点评对应当前画面（不是失效态）',ui.state==='current',{state:ui.state});
  check('当前画面点评会随照片保存的提示可见',ui.note===1,{note:ui.note});
  const storeReview=await page.evaluate(()=>window.__bouquetDebug.getState().currentReview);
  check('store.currentReview 保存了真实点评与画面签名',
    storeReview?.score===review.score&&storeReview?.snapshot===capture.signature,{score:storeReview?.score,snapshotMatches:storeReview?.snapshot===capture.signature});
  await page.getByTestId('ai-review').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({path:`${OUT}/03-review-result.png`});

  // ---------- 6. 存进相册，点评跟着这张照片 ----------
  const tSave=Date.now();
  await page.getByTestId('album-save').click();
  await page.waitForFunction(()=>window.__bouquetDebug.getState().album.length===1,{timeout:20000});
  await page.waitForTimeout(500);
  const saved=await page.evaluate(()=>{
    const state=window.__bouquetDebug.getState();
    const entry=state.album[0];
    return {
      entryId:entry.id,
      entryName:entry.name,
      photos:entry.photos.map(photo=>({id:photo.id,thumbnailBytes:Math.round((photo.thumbnail.length-photo.thumbnail.indexOf(',')-1)*3/4),review:photo.review??null})),
      signature:window.__bouquetDebug.store.photoSnapshot(),
    };
  });
  results.album={entryId:saved.entryId,entryName:saved.entryName,photos:saved.photos};
  check('拍下的照片存进了相册',saved.photos.length===1&&saved.photos[0].thumbnailBytes>15000,{photos:saved.photos.map(photo=>({bytes:photo.thumbnailBytes}))});
  check('相册照片带着这条真实点评（分数/摘要/模型）',
    saved.photos[0].review?.score===review.score&&saved.photos[0].review?.summary===review.summary&&saved.photos[0].review?.model===EXPECT_REVIEW_MODEL&&saved.photos[0].review?.visionModel===EXPECT_VISION_MODEL,
    {review:saved.photos[0].review});
  check('相册照片的点评保存了拍摄那一刻的画面签名',saved.photos[0].review?.snapshot===capture.signature,{savedSnapshot:saved.photos[0].review?.snapshot===capture.signature});
  mark('saveAlbum',tSave);

  // 相册界面也显示点评
  await page.evaluate(()=>window.__bouquetDebug.store.openAlbum());
  await page.getByTestId('album-panel').waitFor();
  await page.getByTestId('album-entry').first().locator('button').click();
  await page.getByTestId('album-photo-review-score').waitFor();
  const albumUi=await page.evaluate(()=>({
    score:document.querySelector('[data-testid=album-photo-review-score]')?.innerText??'',
    meta:document.querySelector('[data-testid=album-photo-review-meta]')?.innerText??'',
    text:document.querySelector('[data-testid=album-photo-review]')?.innerText??'',
  }));
  results.album.ui=albumUi;
  check('相册照片详情显示真实点评分数与模型',
    albumUi.score.replace(/\s+/g,' ').startsWith(String(review.score))&&albumUi.meta.includes(EXPECT_REVIEW_MODEL)&&albumUi.meta.includes(EXPECT_VISION_MODEL),
    albumUi);
  check('相册照片详情显示真实 summary 与建议',
    albumUi.text.includes(review.summary)&&review.suggestions.every(item=>albumUi.text.includes(item)),{albumText:albumUi.text});
  await page.screenshot({path:`${OUT}/04-album-review.png`});
  await page.evaluate(()=>window.__bouquetDebug.store.closeAlbum());

  // ---------- 7. 刷新页面：点评仍与这张照片快照绑定 ----------
  const tReload=Date.now();
  await page.reload();
  await page.waitForFunction(()=>window.__bouquetDebug?.getState().catalog.mode==='manifest',{timeout:30000});
  await page.waitForFunction(()=>window.__bouquetDebug.getState().doc.stems.length===10,{timeout:20000});
  await page.waitForFunction(()=>{
    const views=[...window.__bouquetDebug.scene.views.values()];
    return views.length>0&&views.every(view=>view.object);
  },{timeout:45000});
  await page.waitForTimeout(700);
  mark('reload',tReload);

  const afterReload=await page.evaluate(()=>{
    const state=window.__bouquetDebug.getState();
    const entry=state.album[0];
    let rawReview=null;
    try{
      // 落盘格式是 {version, entries:[...]}，与 ALBUM_KEY 一致（见 data/album.ts serializeAlbumFile）。
      const raw=JSON.parse(localStorage.getItem('bouquet-workbench.album.v1')??'{}');
      rawReview=raw?.entries?.[0]?.photos?.[0]?.review??null;
    }catch{/* 原始存储解析失败就记为 null，交给断言报出来 */}
    return {
      albumCount:state.album.length,
      currentReview:state.currentReview,
      stage:state.stage,
      photos:entry?entry.photos.map(photo=>({id:photo.id,review:photo.review??null})):[],
      localStorageBytes:(localStorage.getItem('bouquet-workbench.album.v1')??'').length,
      localStorageReview:rawReview,
    };
  });
  check('刷新后相册仍在（1 件作品 1 张照片）',afterReload.albumCount===1&&afterReload.photos.length===1,{albumCount:afterReload.albumCount,photos:afterReload.photos.length});
  check('刷新后点评仍绑定在原照片上（分数/摘要/模型/签名一致）',
    afterReload.photos[0]?.review?.score===review.score&&
    afterReload.photos[0]?.review?.summary===review.summary&&
    afterReload.photos[0]?.review?.model===EXPECT_REVIEW_MODEL&&
    afterReload.photos[0]?.review?.visionModel===EXPECT_VISION_MODEL&&
    afterReload.photos[0]?.review?.snapshot===capture.signature,
    {review:afterReload.photos[0]?.review});
  check('刷新后当前画面不会自动带点评（点评属于照片，不属于启动态）',afterReload.currentReview===null,{currentReview:afterReload.currentReview});
  check('localStorage 里的相册记录包含真实点评字段',
    afterReload.localStorageReview?.score===review.score&&
    afterReload.localStorageReview?.model===EXPECT_REVIEW_MODEL&&
    afterReload.localStorageReview?.visionModel===EXPECT_VISION_MODEL&&
    afterReload.localStorageReview?.snapshot===capture.signature,
    {bytes:afterReload.localStorageBytes,indexedStorageReview:afterReload.localStorageReview});

  // 刷新后打开相册，界面上仍能看到这条点评
  await page.evaluate(()=>window.__bouquetDebug.store.openAlbum());
  await page.getByTestId('album-panel').waitFor();
  await page.getByTestId('album-entry').first().locator('button').click();
  await page.getByTestId('album-photo-review-score').waitFor();
  const reloadUi=await page.evaluate(()=>({
    score:document.querySelector('[data-testid=album-photo-review-score]')?.innerText??'',
    meta:document.querySelector('[data-testid=album-photo-review-meta]')?.innerText??'',
    text:document.querySelector('[data-testid=album-photo-review]')?.innerText??'',
  }));
  check('刷新后相册照片详情仍显示这条真实点评',
    reloadUi.score.replace(/\s+/g,' ').startsWith(String(review.score))&&reloadUi.text.includes(review.summary)&&reloadUi.meta.includes(EXPECT_REVIEW_MODEL),
    reloadUi);
  results.album.afterReload={score:reloadUi.score,meta:reloadUi.meta};
  await page.screenshot({path:`${OUT}/05-album-after-reload.png`});

  // 从相册重开这张照片：签名按当前文档 + 恢复后的机位重算，应等于点评里的签名
  const tBind=Date.now();
  await page.evaluate(()=>{
    const store=window.__bouquetDebug.store;
    const entry=store.getState().album[0];
    store.openAlbumEntry(entry.id,entry.photos[0].id);
  });
  await page.waitForFunction(()=>{
    const debug=window.__bouquetDebug;
    const state=debug.getState();
    return Boolean(state.currentReview)&&state.currentReview.snapshot===debug.store.photoSnapshot();
  },{timeout:25000});
  await page.waitForTimeout(600);
  const bound=await page.evaluate(()=>{
    const debug=window.__bouquetDebug;
    const state=debug.getState();
    return {
      stage:state.stage,
      currentReview:state.currentReview,
      recomputedSignature:debug.store.photoSnapshot(),
      uiScore:document.querySelector('[data-testid=ai-review-score]')?.innerText??'',
      uiState:document.querySelector('[data-testid=ai-review-result]')?.getAttribute('data-state')??'',
      stale:document.querySelectorAll('[data-testid=ai-review-stale]').length,
    };
  });
  mark('bindingAfterReload',tBind);
  results.signatures.recomputedAfterReload=bound.recomputedSignature;
  check('刷新后重开照片：按当前文档与恢复机位重算的快照签名与点评一致',
    bound.recomputedSignature===afterReload.photos[0].review.snapshot,{matches:bound.recomputedSignature===afterReload.photos[0].review.snapshot});
  check('刷新后重开照片：点评显示为当前画面的点评（不是失效提示）',
    bound.uiState==='current'&&bound.stale===0&&bound.uiScore.replace(/\s+/g,' ').startsWith(String(review.score)),
    {uiState:bound.uiState,uiScore:bound.uiScore,stale:bound.stale});
  await page.getByTestId('ai-review').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({path:`${OUT}/06-review-after-reload.png`});

  // ---------- 8. 重新拍一张新照片：旧点评不会串到新照片上 ----------
  const tNew=Date.now();
  await page.evaluate(()=>window.__bouquetDebug.store.setViewPreset('side'));
  await page.waitForTimeout(1800);
  const changed=await page.evaluate(()=>({
    signature:window.__bouquetDebug.store.photoSnapshot(),
    scoreCount:document.querySelectorAll('[data-testid=ai-review-score]').length,
    staleCount:document.querySelectorAll('[data-testid=ai-review-stale]').length,
    cameraDirection:window.__bouquetDebug.getState().cameraDirection,
  }));
  check('换机位后画面签名改变，旧点评不再显示在这一帧',
    changed.signature!==bound.recomputedSignature&&changed.scoreCount===0&&changed.staleCount===1,
    {signatureChanged:changed.signature!==bound.recomputedSignature,scoreCount:changed.scoreCount,staleCount:changed.staleCount});

  await page.getByTestId('album-save').click();
  await page.waitForFunction(()=>window.__bouquetDebug.getState().album[0].photos.length===2,{timeout:20000});
  await page.waitForTimeout(500);
  const afterNew=await page.evaluate(()=>{
    const state=window.__bouquetDebug.getState();
    const entry=state.album[0];
    return {
      photos:entry.photos.map(photo=>({id:photo.id,review:photo.review??null})),
      signature:window.__bouquetDebug.store.photoSnapshot(),
      currentReview:state.currentReview,
    };
  });
  mark('newPhoto',tNew);
  results.album.twoPhotos=afterNew.photos.map(photo=>photo.review?{score:photo.review.score,snapshotTail:photo.review.snapshot.slice(-70)}:null);
  check('新拍的照片没有继承旧点评',afterNew.photos.length===2&&!afterNew.photos[1].review,{photos:afterNew.photos.map(photo=>photo.review?.score??null)});
  check('旧照片的点评仍留在原照片上，没被移动',
    afterNew.photos[0].review?.score===review.score&&afterNew.photos[0].review?.snapshot===capture.signature,
    {firstReviewScore:afterNew.photos[0].review?.score});
  check('两张照片的画面签名不同（不同机位）',
    afterNew.photos[0].review?.snapshot!==afterNew.signature&&afterNew.photos[1].review==null,
    {firstReviewSnapshotTail:afterNew.photos[0].review?.snapshot?.slice(-70)??null,newSignatureTail:afterNew.signature.slice(-70)});

  // 相册里看两张照片：第一张有真实点评，第二张明确「没有点评」
  await page.evaluate(()=>window.__bouquetDebug.store.openAlbum());
  await page.getByTestId('album-panel').waitFor();
  if(!(await page.getByTestId('album-photo-review-score').count())){
    await page.getByTestId('album-entry').first().locator('button').click();
  }
  await page.locator('.album-filmstrip button').nth(1).click();
  await page.waitForTimeout(300);
  const emptyText=await page.getByTestId('album-photo-review-empty').innerText();
  const emptyCount=await page.locator('[data-testid=album-photo-review-score]').count();
  check('相册里新照片明确显示「这张照片没有点评」',emptyCount===0&&emptyText.includes('没有点评'),{emptyCount,emptyText});
  await page.screenshot({path:`${OUT}/07-new-photo-no-review.png`});

  check('全程没有页面运行时错误（pageerror）',results.pageErrors.length===0,results.pageErrors);
  results.ok=true;
  results.finishedAt=new Date().toISOString();
  persist();
  console.log(`PASSED ${passed}`);
}catch(error){
  failure={message:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack??null:null};
  results.ok=false;
  results.finishedAt=new Date().toISOString();
  results.failure=failure;
  writeFileSync(`${OUT}/failure.json`,JSON.stringify({...results,failure},null,2));
  persist();
  throw error;
}finally{
  await browser.close();
}
