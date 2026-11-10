/**
 * v14 拍照完成体验验证（真实浏览器，连已运行的 Vite dev server）。
 *
 * 覆盖：
 * 1) 拍照阶段的大预览成为主视觉（尺寸、与导出同构图）；
 * 2) 8 个场景缩略图卡片：文件真实存在、图片能加载、逐个切换生效且预览更新；
 * 3) 一键适配：故意把 zoom/offset 调坏，点击后 photo 值被改回、预测 NDC 花头仍在框内、
 *    花头屏幕坐标仍在视口内；
 * 4) 保存成功卡：显示 AlbumEntry.name 与缩略图，可「继续创作」「查看相册」；
 * 5) 预览性能：hook captureThumbnail 计数，静止 4 秒捕获次数 ≤1（旧版 1.6s 轮询约 2–3 次），
 *    页面隐藏期间不再捕获，恢复可见后补拍一帧；
 * 6) 391px 窄屏不横向溢出；全程无脚本错误。
 *
 * 运行：先保证 Vite dev server 在 http://127.0.0.1:5173，然后
 *   cd app && node scripts/v14-photo.mjs
 * 环境变量：SMOKE_URL、v14_OUT、HEADED。
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { newStudioAwarePage } from './studio-page.mjs';

const SITE_URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.v14_OUT ?? '.verify/v14-photo';
const SCENES_DIR = fileURLToPath(new URL('../public/assets/scenes/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const SCENES = [
  { id: 'window', label: '窗边' },
  { id: 'studio', label: '素色台面' },
  { id: 'gallery', label: '墨绿展台' },
  { id: 'florist', label: '花店一角' },
  { id: 'garden', label: '庭院午后' },
  { id: 'festive', label: '节日暖光' },
  { id: 'living', label: '家居客厅' },
  { id: 'cafe', label: '咖啡馆' },
];

const checks = [];
let count = 0;
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`);
  count += 1;
  console.log('ok', name);
}

const AGENT = 'photo';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: process.env.HEADED !== '1',
  args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await newStudioAwarePage(context);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text());
});

const wait = ms => page.waitForTimeout(ms);
const state = () => page.evaluate(() => window.__bouquetDebug.getState());
const previewSrc = () => page.getByTestId('photo-preview').getAttribute('src');
const counter = () => page.evaluate(() => window.__v14Captures);

try {
  // ---------- 0. 缩略图文件先落盘检查 ----------
  for (const scene of SCENES) {
    const file = `${SCENES_DIR}${scene.id}.jpg`;
    check(
      `缩略图文件存在 ${scene.id}.jpg`,
      existsSync(file) && statSync(file).size > 2500,
      existsSync(file) ? statSync(file).size : 'missing',
    );
  }

  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__bouquetDebug?.getState().catalog?.mode === 'manifest',
    null,
    { timeout: 90000 },
  );

  // hook 场景实例上的 captureThumbnail：预览、保存、导出都会经过它，计数才可信。
  await page.evaluate(() => {
    const scene = window.__bouquetDebug.scene;
    const original = scene.captureThumbnail.bind(scene);
    window.__v14Captures = { count: 0, hidden: 0, last: 0 };
    scene.captureThumbnail = async size => {
      window.__v14Captures.count += 1;
      window.__v14Captures.last = size ?? 480;
      if (document.hidden) window.__v14Captures.hidden += 1;
      return original(size);
    };
  });

  // ---------- 1. 准备好 6 枝样束并进入拍照阶段 ----------
  await page.evaluate(() => window.__bouquetDebug.store.loadSampleBouquet(6));
  await page.waitForFunction(
    () =>
      [...window.__bouquetDebug.scene.views.values()].every(view => view.object && view.loaded),
    null,
    { timeout: 120000 },
  );
  await page.getByTestId('stage-finish').click();
  await page.waitForFunction(() => window.__bouquetDebug.getState().stage === 'finish', null, {
    timeout: 20000,
  });
  await page.waitForSelector('[data-testid=photo-preview]', { timeout: 30000 });
  await wait(2600);

  const firstPreview = await previewSrc();
  check('大预览已生成真实照片', firstPreview?.startsWith('data:image/jpeg;base64,'));
  // 和 app/scripts/iteration5.mjs 的旧断言对齐：预览必须就是「此刻拍下来」的那张图。
  const sameAsCapture = await page.evaluate(async () => {
    const expected = await window.__bouquetDebug.captureThumbnail();
    return document.querySelector('[data-testid=photo-preview]')?.getAttribute('src') === expected;
  });
  check('预览与最终照片完全一致', sameAsCapture);
  const previewBox = await page.getByTestId('photo-preview').boundingBox();
  check('大预览尺寸成为主视觉', Boolean(previewBox && previewBox.width >= 260), previewBox);
  const panelBox = await page.getByTestId('photo-tools').boundingBox();
  check('拍照面板加宽', Boolean(panelBox && panelBox.width >= 340), panelBox);
  check(
    '面板不遮挡左侧作品卡',
    Boolean(panelBox && panelBox.x > 300),
    panelBox && panelBox.x,
  );
  await page.screenshot({ path: `${OUT}/01-finish-large-preview.png` });

  // ---------- 2. 8 个场景缩略图卡片 ----------
  await page.getByTestId('photo-scene-grid').waitFor({ state: 'visible', timeout: 10000 });
  for (const scene of SCENES) {
    const card = page.getByTestId(`photo-scene-${scene.id}`);
    check(`场景卡片可见 ${scene.id}`, await card.isVisible());
    check(`场景卡片文案 ${scene.id}`, (await card.innerText()).trim() === scene.label, {
      got: (await card.innerText()).trim(),
    });
    const img = card.locator('img');
    check(`场景卡片使用真实缩略图 ${scene.id}`, (await img.count()) === 1);
    const src = await img.getAttribute('src');
    check(`缩略图路径 ${scene.id}`, Boolean(src?.includes(`/assets/scenes/${scene.id}.jpg`)), src);
    const loaded = await img.evaluate(node => node.complete && node.naturalWidth > 0);
    check(`缩略图加载成功 ${scene.id}`, loaded);
  }

  const previewByScene = {};
  for (const scene of SCENES) {
    await page.getByTestId(`photo-scene-${scene.id}`).click();
    await wait(850);
    const snapshot = await state();
    check(`切换场景生效 ${scene.id}`, snapshot.doc.photo.scene === scene.id, {
      got: snapshot.doc.photo.scene,
    });
    await page
      .getByTestId(`photo-scene-${scene.id}`)
      .evaluate(node => node.getAttribute('aria-pressed') === 'true')
      .then(ok => check(`场景卡片选中态 ${scene.id}`, ok));
    const src = await previewSrc();
    check(`切换场景后预览更新 ${scene.id}`, src?.startsWith('data:image/jpeg;base64,'));
    previewByScene[scene.id] = src;
  }
  check(
    '不同场景预览不同',
    previewByScene.window !== previewByScene.gallery,
    { window: previewByScene.window?.length, gallery: previewByScene.gallery?.length },
  );
  await page.evaluate(() => {
    const panel = document.querySelector('[data-testid=photo-tools]');
    if (panel) panel.scrollTop = 0;
  });
  await wait(150);
  await page.screenshot({ path: `${OUT}/02-scene-thumbnails.png` });

  // ---------- 3. 一键适配花束取景 ----------
  await page.getByTestId('photo-scene-window').click();
  await wait(700);
  await page.evaluate(() => {
    const { store } = window.__bouquetDebug;
    store.updatePhoto({ zoom: 1.3, offsetX: 0.2, offsetY: 0.19 });
    store.endTransaction();
  });
  await wait(500);
  const beforeFit = (await state()).doc.photo;
  await page.getByTestId('photo-fit').click();
  await wait(700);
  const afterFit = (await state()).doc.photo;
  const fitNote = page.getByTestId('photo-fit-note');
  check('适配后有构图说明', await fitNote.isVisible());
  const maxNdc = Number(await fitNote.getAttribute('data-max-ndc'));
  const fill = Number(await fitNote.getAttribute('data-fill'));
  const zoomMoved = Math.abs(afterFit.zoom - beforeFit.zoom) > 0.004;
  const offsetMoved =
    Math.abs(afterFit.offsetX - beforeFit.offsetX) > 0.004 ||
    Math.abs(afterFit.offsetY - beforeFit.offsetY) > 0.004;
  check('一键适配改变 zoom/offset', zoomMoved || offsetMoved, { beforeFit, afterFit });
  check('一键适配把花头预测在框内并留边', Number.isFinite(maxNdc) && maxNdc > 0 && maxNdc <= 0.93, {
    maxNdc,
  });
  check('适配提示花束占比合理', fill >= 10 && fill <= 100, fill);
  const heads = await page.evaluate(() =>
    window.__bouquetDebug
      .getState()
      .doc.stems.map(stem => ({ id: stem.id, ...window.__bouquetDebug.getStemScreenPoint(stem.id) })),
  );
  const headsInside = heads.every(
    head =>
      head.visible &&
      Number.isFinite(head.x) &&
      Number.isFinite(head.y) &&
      head.x >= 0 &&
      head.x <= 1366 &&
      head.y >= 0 &&
      head.y <= 768,
  );
  check('适配后花头都在视口内', heads.length >= 6 && headsInside, heads);
  await page.evaluate(() => {
    const panel = document.querySelector('[data-testid=photo-tools]');
    if (panel) panel.scrollTop = 0;
  });
  await wait(150);
  await page.screenshot({ path: `${OUT}/03-photo-fit.png` });

  // ---------- 4. 保存成功卡 ----------
  const savedTitle = '晨光测试花束';
  await page.evaluate(title => {
    const { store } = window.__bouquetDebug;
    store.updatePhoto({ frame: 'postcard', title });
    store.endTransaction();
  }, savedTitle);
  await wait(600);
  await page.getByTestId('album-save').click();
  await page.waitForSelector('[data-testid=photo-save-success]', { timeout: 30000 });
  const savedName = (await page.getByTestId('photo-save-name').innerText()).trim();
  const albumEntry = await page.evaluate(() => window.__bouquetDebug.getState().album[0] ?? null);
  check('保存成功卡出现且名称正确', savedName === savedTitle && albumEntry?.name === savedTitle, {
    savedName,
    albumName: albumEntry?.name,
  });
  const savedThumb = await page
    .getByTestId('photo-save-success')
    .locator('img')
    .getAttribute('src');
  check('保存成功卡带照片缩略图', Boolean(savedThumb?.startsWith('data:image/')), savedThumb?.slice(0, 21));
  check(
    '成功卡缩略图与相册照片一致',
    Boolean(albumEntry?.photos?.length) && savedThumb === albumEntry.photos.at(-1).thumbnail,
  );
  await page.screenshot({ path: `${OUT}/04-save-success.png` });

  await page.getByTestId('photo-open-album').click();
  await wait(400);
  check('查看相册入口可用', (await state()).albumOpen === true);
  await page.evaluate(() => window.__bouquetDebug.store.closeAlbum());
  await wait(200);
  await page.getByTestId('photo-continue').click();
  await wait(500);
  check('继续创作回到摆花', (await state()).stage === 'arrange', (await state()).stage);

  // ---------- 5. 预览性能：静止不重复编码 ----------
  await page.getByTestId('stage-finish').click();
  await page.waitForSelector('[data-testid=photo-preview]', { timeout: 30000 });
  await wait(2600);
  const idleStart = await counter();
  await wait(4000);
  const idleEnd = await counter();
  const idleCaptures = idleEnd.count - idleStart.count;
  check('静止 4 秒预览捕获 ≤1 次', idleCaptures <= 1, {
    idleCaptures,
    oldIntervalWouldBe: '约 2–3 次（1.6s 轮询）',
  });

  // 页面隐藏：修改构图也不拍摄；恢复可见后补拍一帧。
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hiddenStart = await counter();
  await page.evaluate(() => {
    const { store } = window.__bouquetDebug;
    store.updatePhoto({ zoom: 0.95 });
    store.endTransaction();
  });
  await wait(1800);
  const hiddenEnd = await counter();
  check('页面隐藏时不再捕获', hiddenEnd.count === hiddenStart.count, {
    before: hiddenStart.count,
    after: hiddenEnd.count,
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await wait(1500);
  const resumed = await counter();
  check('恢复可见后补拍一帧', resumed.count > hiddenEnd.count, {
    hidden: hiddenEnd.count,
    resumed: resumed.count,
  });

  // ---------- 6. 391px 窄屏 ----------
  await page.setViewportSize({ width: 391, height: 844 });
  await wait(700);
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const panel = document.querySelector('[data-testid=photo-tools]');
    const rect = panel?.getBoundingClientRect();
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      panelLeft: rect?.left ?? null,
      panelRight: rect?.right ?? null,
      panelWidth: rect?.width ?? null,
    };
  });
  check(
    '391px 窄屏无横向溢出',
    overflow.scrollWidth <= overflow.clientWidth &&
      overflow.bodyScrollWidth <= overflow.clientWidth &&
      (overflow.panelLeft ?? 0) >= 0 &&
      (overflow.panelRight ?? 9999) <= 391,
    overflow,
  );
  check(
    '391px 窄屏大预览仍可见',
    await page.getByTestId('photo-preview').isVisible(),
  );
  await page.screenshot({ path: `${OUT}/05-mobile-391.png` });

  check('全程无脚本错误', errors.length === 0, errors.slice(0, 3));
  writeFileSync(
    `${OUT}/results.json`,
    JSON.stringify({ passed: count, total: count, checks, errors, agent: AGENT }, null, 2),
  );
  console.log(`\nv14 拍照完成体验：${count}/${count} 通过`);
} catch (error) {
  writeFileSync(
    `${OUT}/results.json`,
    JSON.stringify({ passed: count, checks, error: String(error), errors, agent: AGENT }, null, 2),
  );
  console.error('\n失败：', error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
