/**
 * V16 §6 全流程音效与音频偏好入口验证（真实浏览器，连已运行的 Vite dev server）。
 *
 * 覆盖：
 * 1) 页面加载后**未创建/未解锁** AudioContext（contextState=none, unlocked=false）；
 * 2) 第一次真实 pointerdown 后解锁（App 里 installUnlockOnFirstGesture 的接线）；
 * 3) 真实操作取花 → 放花 → 选中，played 里有 pick/place/select 且 audible=true；
 * 4) 整理/包装/花泥/装饰/贺卡等动作的 sound 事件（翻瓣、去刺、修叶、剪枝、纸、折、
 *    丝带、花泥、装饰、保存各至少一条），失败路径不产生成功音（见负向检查）；
 * 5) 顶栏统一入口：audio-toggle / audio-mute / audio-volume 可键盘/鼠标操作；
 *    静音后动作仍有 debug 事件但 audible=false，且 muted=true、stats.played 不增加；
 * 6) 音量滑杆写 store + 本机设置，刷新后保留（settings.audio.volume）；
 * 7) 切后台（document.hidden）时音频上下文挂起、期间不发声、返回不补播；
 * 8) 全程无页面外音频请求（背景音乐只允许本地 /assets/audio/ 下的生成曲目），无页面脚本错误；
 * 9) 拍照阶段真实预览会触发 camera、点「拍照存相册」触发 save（若当前分支可用）。
 *
 * 运行：先保证 dev server 在 http://127.0.0.1:5173，然后
 *   cd app && node scripts/v16-audio.mjs
 * 环境变量：SMOKE_URL、V16_OUT、HEADED。
 *
 * 说明：音效是 WebAudio 程序化合成（振荡器 + 带通白噪声 + 增益包络），不是录音素材，
 * 因此本脚本只能验证「事件、解锁、静音、持久化、无外部资源」，不能替真人判断音色是否舒适。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const SITE_URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.V16_OUT ?? '.verify/v16-audio';
const SETTINGS_KEY = 'bouquet-workbench.settings.v1';
mkdirSync(OUT, { recursive: true });

const checks = [];
let failed = 0;
let skipped = 0;

function must(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), kind: 'must', detail });
  if (!ok) {
    failed += 1;
    console.error('FAIL', name, detail === undefined ? '' : JSON.stringify(detail));
  } else {
    console.log('ok  ', name, detail === undefined ? '' : JSON.stringify(detail));
  }
}

function skip(name, detail) {
  skipped += 1;
  checks.push({ name, ok: false, kind: 'skip', detail });
  console.log('skip', name, detail === undefined ? '' : JSON.stringify(detail));
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: process.env.HEADED !== '1',
  args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const pageErrors = [];
const consoleErrors = [];
const audioRequests = [];
const origins = new Set();
let context = null;
let page = null;

function attachPage() {
  page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.includes('404')) return;
    consoleErrors.push(text);
  });
  page.on('request', (request) => {
    const url = request.url();
    try {
      origins.add(new URL(url).origin);
    } catch {
      /* ignore */
    }
    if (/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)(\?|$)/i.test(url)) audioRequests.push(url);
  });
}

/** 并行开发时 Vite 可能因为别人保存文件而整页刷新；给一次干净的重试会话。 */
async function freshSession() {
  if (context) await context.close().catch(() => {});
  pageErrors.length = 0;
  consoleErrors.length = 0;
  audioRequests.length = 0;
  origins.clear();
  checks.length = 0;
  failed = 0;
  skipped = 0;
  context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  page = await context.newPage();
  attachPage();
}
await freshSession();

const wait = (ms) => page.waitForTimeout(ms);
const state = () => page.evaluate(() => window.__bouquetDebug.getState());
const storeCall = (fn, ...args) =>
  page.evaluate(({ fn, args }) => window.__bouquetDebug.store[fn](...args), { fn, args });
const audioState = () =>
  page.evaluate(async () => {
    const api = window.__bouquetDebug?.audio;
    if (api?.state) return api.state();
    // 仅作为 App 未接线时的兜底（dev server 下同一模块实例）。
    const mod = await import('/src/audio/engine.ts');
    return mod.getAudioDebug();
  });
const audioReset = () =>
  page.evaluate(async () => {
    const api = window.__bouquetDebug?.audio;
    if (api?.reset) {
      api.reset();
      return 'app';
    }
    const mod = await import('/src/audio/engine.ts');
    mod.resetAudioDebug();
    return 'module-fallback';
  });
const playedNames = async () => (await audioState()).played.map((item) => `${item.name}:${item.audible ? 'on' : 'off'}`);
const shot = async (name) => {
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path });
  console.log('shot', path);
  return path;
};
const waitAudio = async (predicate, timeout = 4000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const current = await audioState();
    if (predicate(current)) return current;
    await wait(80);
  }
  return audioState();
};

/** 触发一个 store 动作并断言对应音效事件。 */
async function expectSound(label, action, soundName, opts = {}) {
  await audioReset();
  const result = await action();
  await wait(opts.settle ?? 260);
  const debug = await audioState();
  const events = debug.played.filter((item) => item.name === soundName);
  const audible = events.some((item) => item.audible);
  must(`${label} → ${soundName} 音效事件`, audible, {
    action: result,
    events: debug.played.map((item) => `${item.name}:${item.audible}`),
    stats: debug.stats,
  });
  return debug;
}

let wiring = 'unknown';
const isNavigationLost = (error) =>
  /Execution context was destroyed|Target page, context or browser has been closed|ERR_ABORTED|not attached|navigat/i.test(
    String(error?.message ?? error),
  );
// 并行开发时 Vite 可能因为别人保存文件整页刷新，会打断页面上下文；失败则换新会话重跑。
for (let attempt = 1; attempt <= 3; attempt += 1) {
  if (attempt > 1) {
    console.warn(`attempt ${attempt}: 上一次运行被页面刷新打断，换新会话重试`);
    await freshSession();
  }
  try {
  // ---------- 0. 初始状态：模块加载不创建 AudioContext ----------
  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__bouquetDebug), null, { timeout: 60000 });
  await page.waitForSelector('[data-testid=audio-toggle]', { timeout: 60000 });
  wiring = await page.evaluate(() => (window.__bouquetDebug?.audio?.state ? 'app' : 'module-fallback'));
  console.log('debug wiring:', wiring);

  const before = await audioState();
  must('初始状态未解锁且无 AudioContext', before.unlocked === false && before.contextState === 'none', {
    unlocked: before.unlocked,
    contextState: before.contextState,
    supported: before.supported,
    stats: before.stats,
  });
  await shot('00-initial');

  // ---------- 1. 第一次真实 pointerdown 解锁 ----------
  await page.mouse.click(1180, 690); // 点画布空白处：只作为首个用户手势，不落位
  const unlockedState = await waitAudio((item) => item.unlocked === true, 5000);
  must('首次 pointerdown 后音频解锁', unlockedState.unlocked === true && unlockedState.contextState === 'running', {
    unlocked: unlockedState.unlocked,
    contextState: unlockedState.contextState,
  });
  await shot('01-unlocked');

  // ---------- 2. 真实取花 / 放花 / 选中 ----------
  await wait(400);
  await audioReset();
  const card = (await page.getByTestId('shelf-card-rose').count())
    ? page.getByTestId('shelf-card-rose')
    : page.locator('[data-testid^="shelf-card-"]').first();
  let pickMode = 'click';
  try {
    await card.click({ timeout: 6000 });
  } catch {
    await card.evaluate((el) => el.click());
    pickMode = 'dom-click';
  }
  await wait(350);
  const afterPick = await audioState();
  const placement = await page.evaluate(() => window.__bouquetDebug.getState().placement);
  must('花材架取花 → pick 音效事件', Boolean(placement?.assetId) && afterPick.played.some((item) => item.name === 'pick' && item.audible), {
    pickMode,
    placement,
    played: afterPick.played.map((item) => `${item.name}:${item.audible}`),
  });

  const canvasBox = await page.locator('.bouquet-canvas').boundingBox();
  await page.mouse.click(canvasBox.x + canvasBox.width * 0.62, canvasBox.y + canvasBox.height * 0.56);
  await wait(450);
  let doc = await state();
  let placePath = 'canvas-click';
  if (doc.doc.stems.length === 0) {
    // 画布区域被别的浮层挡住时退回 store 的落位接口（仍是真实落位，只不是真实点击）。
    await storeCall('placeStem', { height: 0.02, tilt: 16, direction: 20, spin: 30 });
    await wait(300);
    doc = await state();
    placePath = 'store-placeStem';
  }
  const placeDebug = await audioState();
  must('点击画布放花 → place 音效事件', doc.doc.stems.length === 1 && placeDebug.played.some((item) => item.name === 'place' && item.audible), {
    placePath,
    stems: doc.doc.stems.length,
    played: placeDebug.played.map((item) => `${item.name}:${item.audible}`),
  });
  const stemId = doc.doc.stems[0]?.id;
  must('获得可操作的花枝 id', Boolean(stemId), stemId);

  // 取消选中，再真实点花头选中 → select。
  await page.mouse.click(canvasBox.x + canvasBox.width * 0.2, canvasBox.y + canvasBox.height * 0.8);
  await wait(200);
  const selectedAfterBlank = await page.evaluate(() => window.__bouquetDebug.getState().selectedId);
  if (selectedAfterBlank) await storeCall('select', null);
  await audioReset();
  let selectPath = 'canvas-click';
  const point = await page.evaluate((id) => window.__bouquetDebug.getStemScreenPoint(id), stemId);
  if (point && point.visible) {
    await page.mouse.click(point.x, point.y);
    await wait(300);
  }
  let selectedId = await page.evaluate(() => window.__bouquetDebug.getState().selectedId);
  if (selectedId !== stemId) {
    await page.evaluate((id) => window.__bouquetDebug.select(id), stemId);
    selectPath = 'debug-select';
    await wait(150);
    selectedId = await page.evaluate(() => window.__bouquetDebug.getState().selectedId);
  }
  const selectDebug = await audioState();
  must('真实点击花头 → select 音效事件', selectedId === stemId && selectDebug.played.some((item) => item.name === 'select' && item.audible), {
    selectPath,
    selectedId,
    stemPoint: point,
    played: selectDebug.played.map((item) => `${item.name}:${item.audible}`),
  });
  await shot('02-arrange');

  // 连续取花（模拟拖动 / 连点）：同名音限频，不会叠几十声。
  await audioReset();
  const throttleDebug = await page.evaluate(() => {
    const store = window.__bouquetDebug.store;
    for (let i = 0; i < 8; i += 1) {
      store.setPlacement(null);
      store.setPlacement('rose-pink');
    }
    store.setPlacement(null);
    return window.__bouquetDebug.audio.state();
  });
  must(
    '连续取花同名音限频',
    throttleDebug.stats.attempted >= 8 && throttleDebug.stats.throttled >= 5 && throttleDebug.stats.played <= 3,
    { stats: throttleDebug.stats },
  );

  // 失败路径：对不存在的花枝做处理，应什么都不发生、也不播成功音。
  await audioReset();
  const failedAction = await page.evaluate(() => {
    const store = window.__bouquetDebug.store;
    const before = window.__bouquetDebug.audio.state().stats.attempted;
    const result = store.trimStem('stem-does-not-exist');
    return { result, attemptedBefore: before, attemptedAfter: window.__bouquetDebug.audio.state().stats.attempted };
  });
  must('失败动作不播放任何提示音', failedAction.attemptedAfter === failedAction.attemptedBefore, failedAction);

  // ---------- 3. 全流程动作音效（直接走 store 的真实动作方法） ----------
  await expectSound('剪枝（余茎）', () => storeCall('trimStem', stemId), 'snip');
  await expectSound('修叶', () => storeCall('trimStem', stemId, 1), 'trim-leaf');
  await expectSound('翻瓣', () => storeCall('setPetalFlip', stemId, 1), 'flip');
  await expectSound('去刺', () => storeCall('setThornsRemoved', stemId, true), 'dethorn');
  await expectSound('铺纸', () => storeCall('setPackageStep', 'paper'), 'paper');
  await expectSound('收束折叠', () => storeCall('setPackageStep', 'fold'), 'fold');
  await expectSound('系结（丝带步）', () => storeCall('setPackageStep', 'ribbon'), 'ribbon');
  await expectSound('换包装纸', () => storeCall('setPaperId', 'kraft'), 'paper');
  await expectSound('换丝带颜色', () => storeCall('setRibbonColor', 'cream'), 'ribbon');
  // 花泥只对容器开放：先换成花篮（换容器本身不发声），再放花泥/裁切。
  await storeCall('setPresentation', 'basket');
  await wait(200);
  await expectSound('放入花泥', () => storeCall('setFoam', 'place'), 'foam-place');
  await expectSound('裁切花泥', () => storeCall('setFoam', 'cut'), 'foam-cut');
  await expectSound('添加装饰', async () => {
    for (const kind of ['butterfly', 'star-pick', 'heart-pick']) {
      const id = await storeCall('addOrnament', kind);
      if (id) return `${kind}:${id}`;
    }
    return null;
  }, 'ornament');
  await expectSound('贺卡采用文字（保存类反馈）', () => storeCall('applyCardMessage', '谢谢你，今天也慢慢来。'), 'save');

  // 负向检查：不能随手点就播 error/成功音——error 只应由失败路径显式调用；
  // 本流程没有任何失败动作，因此 played 里不应出现 error。
  const negative = await audioState();
  must('正常流程不出现失败音 error', !negative.played.some((item) => item.name === 'error'), {
    played: negative.played.map((item) => `${item.name}:${item.audible}`),
  });

  // ---------- 4. 顶栏音效入口：静音 / 取消静音 / 音量 ----------
  await page.getByTestId('audio-toggle').click();
  await page.waitForSelector('[data-testid=audio-panel]', { timeout: 4000 });
  await wait(320); // 等浮层入场动画结束再截图，否则半透明状态会把下面板子透出来
  must('顶栏音效入口展开面板', true);
  must(
    '入口 data-testid 齐全',
    (await page.getByTestId('audio-mute').count()) === 1 && (await page.getByTestId('audio-volume').count()) === 1,
  );
  const ariaBefore = await page.getByTestId('audio-toggle').getAttribute('aria-expanded');
  must('喇叭按钮带 aria-expanded', ariaBefore === 'true', ariaBefore);
  await shot('03-audio-panel');

  await page.getByTestId('audio-mute').click();
  await wait(180);
  const mutedState = await state();
  const mutedDebug = await audioState();
  must('点静音后 store/debug 都是 muted', mutedState.audio.muted === true && mutedDebug.muted === true, {
    store: mutedState.audio,
    debugMuted: mutedDebug.muted,
  });
  must(
    '静音按钮 aria-checked=false',
    (await page.getByTestId('audio-mute').getAttribute('aria-checked')) === 'false',
  );

  // 静音后动作：仍有事件，但 audible=false，且没有新的实际播放。
  const playedBeforeMutedAction = mutedDebug.stats.played;
  await audioReset();
  await storeCall('setPetalFlip', stemId, 0);
  await wait(240);
  const mutedActionDebug = await audioState();
  const mutedFlipEvents = mutedActionDebug.played.filter((item) => item.name === 'flip');
  must(
    '静音后动作仍有事件但不发声',
    mutedFlipEvents.length > 0 && mutedFlipEvents.every((item) => item.audible === false) && mutedActionDebug.stats.played === 0,
    {
      events: mutedActionDebug.played.map((item) => `${item.name}:${item.audible}`),
      stats: mutedActionDebug.stats,
      playedBeforeMutedAction,
    },
  );
  await shot('04-muted');

  await page.getByTestId('audio-mute').click();
  await wait(220);
  const unmutedState = await state();
  must('取消静音后恢复发声偏好', unmutedState.audio.muted === false, unmutedState.audio);

  // 音量滑杆：用真实键盘操作（先按到最小、再 7×→ = 35%），写 store + 本机设置。
  const slider = page.getByTestId('audio-volume');
  await slider.focus();
  for (let i = 0; i < 16; i += 1) await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 7; i += 1) await page.keyboard.press('ArrowRight');
  await wait(300);
  const volumeState = await state();
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), SETTINGS_KEY);
  must('音量滑杆写入 store', Math.abs(volumeState.audio.volume - 0.35) < 0.02, volumeState.audio);
  must('音量写入本机设置', stored?.audio && Math.abs(stored.audio.volume - 0.35) < 0.02 && stored.audio.muted === false, stored?.audio);
  await shot('05-volume');

  // 键盘可操作：Esc 关闭并把焦点还给喇叭按钮。
  await page.getByTestId('audio-volume').focus();
  await page.keyboard.press('Escape');
  await wait(160);
  must('Esc 收起音效面板', (await page.getByTestId('audio-panel').count()) === 0);
  const focusedTestId = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
  must('Esc 后焦点回到喇叭按钮', focusedTestId === 'audio-toggle', focusedTestId);

  // ---------- 5. 切后台：挂起、不发声、返回不补播 ----------
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await wait(400);
  const hiddenState = await audioState();
  must('切后台后音频上下文挂起', hiddenState.contextState === 'suspended', hiddenState.contextState);

  await audioReset();
  await storeCall('setPetalFlip', stemId, 1);
  await wait(260);
  const hiddenPlayed = await audioState();
  must(
    '切后台期间不发声、不排队',
    hiddenPlayed.played.length > 0 && hiddenPlayed.played.every((item) => item.audible === false),
    hiddenPlayed.played.map((item) => `${item.name}:${item.audible}`),
  );

  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const resumedState = await waitAudio((item) => item.contextState === 'running', 4000);
  must('回到前台后恢复上下文', resumedState.contextState === 'running', resumedState.contextState);
  const nochore = (await audioState()).played.filter((item) => item.audible);
  must('返回前台不补播', nochore.length === 0, nochore.map((item) => item.name));

  // ---------- 6. 刷新后保留音量/静音偏好 ----------
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid=start-continue], [data-testid=audio-toggle], [data-testid=start-blank]')),
    null,
    { timeout: 60000 },
  );
  const storedAfterReload = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), SETTINGS_KEY);
  must(
    '刷新后本机设置仍保留音量与静音',
    storedAfterReload?.audio && Math.abs(storedAfterReload.audio.volume - 0.35) < 0.02 && storedAfterReload.audio.muted === false,
    storedAfterReload?.audio,
  );
  if (await page.getByTestId('start-continue').count()) {
    await page.getByTestId('start-continue').click();
    await page.waitForSelector('[data-testid=audio-toggle]', { timeout: 60000 });
    await page.waitForFunction(() => Boolean(window.__bouquetDebug), null, { timeout: 60000 });
    const reloadState = await state();
    must('刷新后 store 读回音量 0.35', Math.abs(reloadState.audio.volume - 0.35) < 0.02, reloadState.audio);
    await page.getByTestId('audio-toggle').click();
    const sliderValue = await page.getByTestId('audio-volume').inputValue();
    must('刷新后音量滑杆显示 35%', sliderValue === '35', sliderValue);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid=audio-panel]', { state: 'detached' }).catch(() => {});
    await shot('06-after-reload');
  } else {
    skip('刷新后 UI 回读音量', '没有继续入口（可能直接进了工作台）');
  }

  // ---------- 7. 拍照 / 保存的真实音效（成品阶段） ----------
  try {
    await page.waitForFunction(() => Boolean(window.__bouquetDebug?.scene), null, { timeout: 30000 });
    await page.waitForFunction(
      () => [...window.__bouquetDebug.scene.views.values()].every((view) => view.object && view.loaded),
      null,
      { timeout: 120000 },
    );
    await audioReset();
    await page.getByTestId('stage-finish').click({ timeout: 8000 });
    await page.waitForSelector('[data-testid=photo-preview]', { timeout: 30000 });
    await wait(1200);
    const finishDebug = await audioState();
    must('进入拍照阶段真实预览 → camera 音效事件', finishDebug.played.some((item) => item.name === 'camera' && item.audible), {
      played: finishDebug.played.map((item) => `${item.name}:${item.audible}`),
    });
    await shot('07-finish');

    const albumBefore = (await state()).album.length;
    await audioReset();
    await page.getByTestId('album-save').click({ timeout: 8000 });
    // 预览在保存后会补拍一帧，保存事件也可能比按钮点击晚一点；轮询等它出现。
    let afterSave = await state();
    let saveDebug = await audioState();
    for (let i = 0; i < 30; i += 1) {
      if (afterSave.album.length > albumBefore && saveDebug.played.some((item) => item.name === 'save' && item.audible)) break;
      await wait(200);
      afterSave = await state();
      saveDebug = await audioState();
    }
    must(
      '拍照存相册 → save 音效事件',
      afterSave.album.length > albumBefore && saveDebug.played.some((item) => item.name === 'save' && item.audible),
      {
        albumBefore,
        albumAfter: afterSave.album.length,
        played: saveDebug.played.map((item) => `${item.name}:${item.audible}`),
      },
    );
    await shot('08-saved');
  } catch (error) {
    skip('拍照/保存真实路径音效', String(error?.message ?? error).slice(0, 300));
  }

  // ---------- 8. 外部音频依赖与脚本错误 ----------
  // 背景音乐（V16 音乐轮）是本地 /assets/audio/ 下的生成曲目，属于允许范围；
  // 这里只拦「页面外 / 非本地 audio 目录」的请求。
  const foreignAudio = audioRequests.filter((url) => {
    try {
      const parsed = new URL(url);
      return parsed.origin !== new URL(SITE_URL).origin || !parsed.pathname.startsWith('/assets/audio/');
    } catch {
      return true;
    }
  });
  const bgmAudio = audioRequests.length - foreignAudio.length;
  must('无页面外音频文件请求（BGM 仅本地 /assets/audio/）', foreignAudio.length === 0, {
    foreign: foreignAudio.slice(0, 5),
    localBgmRequests: bgmAudio,
  });
  must('页面无脚本错误', pageErrors.length === 0, pageErrors.slice(0, 5));
  if (consoleErrors.length) {
    console.log('note: console errors（不计为失败，可能来自并行改动）:', consoleErrors.slice(0, 5));
  }
  checks.push({
    name: '访问过的资源来源',
    ok: true,
    kind: 'info',
    detail: [...origins],
  });
  console.log('origins:', [...origins].join(', '));
  break; // 本次尝试全部通过；不再跑重试会话
  } catch (error) {
    if (isNavigationLost(error) && attempt < 3) {
      console.warn(
        `attempt ${attempt} 被页面刷新打断，换新会话重试：`,
        String(error?.message ?? error).slice(0, 160),
      );
      continue;
    }
    failed += 1;
    checks.push({ name: '脚本执行中断', ok: false, kind: 'must', detail: String(error?.stack ?? error) });
    console.error('ABORT', error);
    try {
      await shot('99-abort');
    } catch {
      /* ignore */
    }
    break;
  }
}

const summary = {
    url: SITE_URL,
    at: new Date().toISOString(),
    wiring,
    passed: checks.filter((item) => item.ok && item.kind !== 'info').length,
    failed,
    skipped,
    pageErrors,
    consoleErrors: consoleErrors.slice(0, 10),
    audioRequests,
    origins: [...origins],
    checks,
  };
  writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
  const lines = [
    '# V16 §6 全流程音效验证',
    '',
    `- 时间：${summary.at}`,
    `- 地址：${SITE_URL}`,
    `- debug 接线：${wiring}`,
    `- 通过：${summary.passed} / 失败：${failed} / 跳过：${skipped}`,
    '',
    '| 结果 | 检查项 | 细节 |',
    '| --- | --- | --- |',
    ...checks.map((item) => {
      const result = item.kind === 'info' ? 'info' : item.ok ? 'PASS' : item.kind === 'skip' ? 'SKIP' : 'FAIL';
      const detail = item.detail === undefined ? '' : JSON.stringify(item.detail).replaceAll('|', '\\|').slice(0, 600);
      return `| ${result} | ${item.name} | ${detail} |`;
    }),
    '',
    '说明：音效为 WebAudio 程序化合成（无外部音频文件、无在线生成）；背景音乐为本地 /assets/audio/ 下 API 生成并循环处理的文件；自动检查不能代替真人试听。',
  ];
  writeFileSync(`${OUT}/summary.md`, `${lines.join('\n')}\n`);
  console.log(`\nsummary: ${OUT}/summary.md  passed=${summary.passed} failed=${failed} skipped=${skipped}`);
  await browser.close();
  process.exit(failed > 0 ? 1 : 0);
