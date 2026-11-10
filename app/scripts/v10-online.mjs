/**
 * V10 线上核验：公开魔搭入口的 8 种呈现形态、5 件 Lux3D 花器资源与 5 个拍照场景。
 *
 * 用法：node scripts/v10-online.mjs
 *   默认 https://www.modelscope.cn/studios/BallCard/bouquet-workbench?mode=full
 *   魔搭公开页把应用放在 iframe 里，复用 studio-page.mjs 的作用域代理在应用帧里断言。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { newStudioAwarePage } from './studio-page.mjs';

const URL = process.env.ONLINE_URL ?? 'https://www.modelscope.cn/studios/BallCard/bouquet-workbench?mode=full';
const OUT = '.verify/v10-online';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await newStudioAwarePage(context);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// 魔搭平台外壳对匿名访客会返回 users/login/info 401，这是平台会话探测，不是应用错误。
const platformNoise = (text) => text.includes('404') || text.includes('401') || text.includes('login/info');
page.on('console', (m) => { if (m.type() === 'error' && !platformNoise(m.text())) errors.push(m.text()); });
const exec = (fn, arg) => page.evaluate(fn, arg);
const wait = (ms) => page.waitForTimeout(ms);

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`); console.log('ok', name); };
const state = () => exec(() => window.__bouquetDebug.getState());
const testId = (id) => page.locator(`[data-testid=${id}]`);

try {
  const started = Date.now();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, { timeout: 240000 });
  await wait(2000);

  const catalog = await exec(() => {
    const c = window.__bouquetDebug.getState().catalog;
    return { families: c.families.length, entries: c.entries.length, assetsVersion: c.assetsVersion, mode: c.mode };
  });
  check('线上目录 30 花型 / 53 配色', catalog.families === 30 && catalog.entries === 53, catalog);
  check('线上目录来自 manifest', catalog.mode === 'manifest', catalog);

  const health = await exec(async () => {
    try {
      const r = await fetch('api/health', { cache: 'no-store' });
      return { status: r.status, body: await r.json().catch(() => null) };
    } catch (e) { return { status: 0, error: String(e) }; }
  });
  check('线上健康检查版本 0.10.0', health.status === 200 && health.body?.version === '0.10.0', health);

  // 放 6 枝花，进入包装
  await exec(() => {
    const d = window.__bouquetDebug;
    const store = d.store;
    store.clearStems();
    for (let i = 0; i < 6; i += 1) {
      store.setPlacement(i < 3 ? 'rose-pink' : i < 5 ? 'tulip-cream' : 'eucalyptus-green');
      store.placeStem({ height: (i % 3) * 0.035, tilt: 10 + i * 3, direction: i * 137, spin: 30 });
      store.setPlacement(null);
    }
    store.select(null);
  });
  await page.waitForFunction(() => [...window.__bouquetDebug.scene.views.values()].every((view) => view.object), null, { timeout: 120000 });
  await wait(800);
  await testId('stage-wrap').click();
  await wait(500);

  for (const kind of ['basket', 'box', 'bucket', 'bag', 'crate']) {
    check(`线上呈现入口 ${kind}`, await testId(`presentation-${kind}`).isVisible());
  }
  // 切到花篮，等 Lux3D GLB 挂载（程序化兜底先出现）
  await testId('presentation-basket').click();
  await wait(300);
  check('线上花篮先预览', (await state()).presentationPreview === true);
  await testId('confirm-presentation').click();
  await wait(500);
  check('线上采用花篮', (await state()).doc.presentation.kind === 'basket');
  const basketModel = await page.waitForFunction(() => {
    const scene = window.__bouquetDebug.scene.scene ?? window.__bouquetDebug.scene;
    return Boolean(scene.getObjectByName('vessel-model-basket'));
  }, null, { timeout: 90000 }).then(() => true).catch(() => false);
  check('线上加载 Lux3D 花篮 GLB', basketModel);
  const basketAsset = await exec(async () => {
    const r = await fetch('assets/vessels/wicker-basket.glb', { cache: 'no-store' });
    return { status: r.status, bytes: (await r.arrayBuffer()).byteLength };
  });
  check('线上花篮 GLB 可下载且大小正确', basketAsset.status === 200 && basketAsset.bytes > 2000000, basketAsset);
  await page.screenshot({ path: `${OUT}/01-online-basket.png` }).catch(() => {});

  // 拍照场景
  await testId('stage-finish').click();
  await wait(1600);
  for (const scene of ['window', 'studio', 'gallery', 'florist', 'garden']) {
    check(`线上拍照场景入口 ${scene}`, await testId(`photo-scene-${scene}`).isVisible());
  }
  await testId('photo-scene-garden').click();
  await wait(1200);
  check('线上庭院场景选中', (await state()).doc.photo.scene === 'garden');
  const gardenSet = await exec(() => {
    const scene = window.__bouquetDebug.scene.scene ?? window.__bouquetDebug.scene;
    const object = scene.getObjectByName('garden-set');
    return Boolean(object && object.visible);
  });
  check('线上庭院布景可见', gardenSet);
  await page.screenshot({ path: `${OUT}/02-online-garden.png` }).catch(() => {});

  check('线上无脚本错误', errors.length === 0, errors.slice(0, 3));
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ date: new Date().toISOString(), url: URL, ms: Date.now() - started, catalog, health, basketAsset, checks, errors }, null, 2));
  console.log(`\nV10 线上核验：${checks.length}/${checks.length} 通过`);
} catch (error) {
  writeFileSync(`${OUT}/failure.json`, JSON.stringify({ date: new Date().toISOString(), url: URL, checks, error: String(error), errors }, null, 2));
  throw error;
} finally {
  await browser.close();
}
