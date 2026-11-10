/**
 * V11 线上核验：公开魔搭入口的 8 个拍照场景（新增节日暖光 / 家居客厅 / 咖啡馆）。
 *
 * 用法：node scripts/v11-online.mjs
 *   默认 https://www.modelscope.cn/studios/BallCard/bouquet-workbench?mode=full
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { newStudioAwarePage } from './studio-page.mjs';

const URL = process.env.ONLINE_URL ?? 'https://www.modelscope.cn/studios/BallCard/bouquet-workbench?mode=full';
const OUT = '.verify/v11-online';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await newStudioAwarePage(context);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// 魔搭平台外壳对匿名访客会返回 users/login/info 401，属平台会话探测，不是应用错误。
const platformNoise = (text) => text.includes('404') || text.includes('401') || text.includes('login/info');
page.on('console', (m) => { if (m.type() === 'error' && !platformNoise(m.text())) errors.push(m.text()); });
const exec = (fn, arg) => page.evaluate(fn, arg);
const wait = (ms) => page.waitForTimeout(ms);

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`); console.log('ok', name); };
const state = () => exec(() => window.__bouquetDebug.getState());
const testId = (id) => page.locator(`[data-testid=${id}]`);

const SCENES = [
  { id: 'window', group: 'photography-window', background: null },
  { id: 'studio', group: null, background: null },
  { id: 'gallery', group: 'photography-gallery', background: '30443d' },
  { id: 'florist', group: 'florist-set', background: 'ece0cf' },
  { id: 'garden', group: 'garden-set', background: 'e7eee8' },
  { id: 'festive', group: 'festive-set', background: '3b2a26' },
  { id: 'living', group: 'living-set', background: 'e9dfd0' },
  { id: 'cafe', group: 'cafe-set', background: 'ece4d8' },
];
const SET_NAMES = SCENES.map((scene) => scene.group).filter(Boolean);

try {
  const started = Date.now();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, { timeout: 240000 });
  await wait(2000);

  const health = await exec(async () => {
    try {
      const response = await fetch('api/health', { cache: 'no-store' });
      return { status: response.status, body: await response.json().catch(() => null) };
    } catch (error) { return { status: 0, error: String(error) }; }
  });
  check('线上健康检查版本 0.11.0', health.status === 200 && health.body?.version === '0.11.0', health);

  await exec(() => {
    const store = window.__bouquetDebug.store;
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
  await testId('stage-finish').click();
  await wait(1800);

  for (const scene of SCENES) {
    check(`线上场景入口 ${scene.id}`, await testId(`photo-scene-${scene.id}`).isVisible());
  }

  const visibleSets = () => exec((names) => {
    const scene = window.__bouquetDebug.scene.scene ?? window.__bouquetDebug.scene;
    return names.filter((name) => {
      const object = scene.getObjectByName(name);
      return Boolean(object && object.visible);
    });
  }, SET_NAMES);
  const background = () => exec(() => {
    const value = window.__bouquetDebug.scene.scene.background;
    return value?.isColor ? value.getHexString() : null;
  });

  for (const scene of SCENES) {
    await testId(`photo-scene-${scene.id}`).click();
    await wait(500);
    const snapshot = await state();
    check(`线上选中 ${scene.id}`, snapshot.doc.photo.scene === scene.id, snapshot.doc.photo.scene);
    const visible = await visibleSets();
    if (scene.group) check(`线上 ${scene.id} 布景可见且唯一`, visible.length === 1 && visible[0] === scene.group, visible);
    else check(`线上 ${scene.id} 不显示外景`, visible.length === 0, visible);
    const hex = await background();
    if (scene.background) check(`线上 ${scene.id} 背景色`, hex === scene.background, { got: hex, want: scene.background });
  }

  await testId('photo-scene-festive').click();
  await wait(800);
  await page.screenshot({ path: `${OUT}/01-online-festive.png` }).catch(() => {});
  await testId('photo-scene-living').click();
  await wait(800);
  await page.screenshot({ path: `${OUT}/02-online-living.png` }).catch(() => {});
  await testId('photo-scene-cafe').click();
  await wait(800);
  const exported = await exec(async () => {
    const result = await window.__bouquetDebug.scene.exportPng(1200);
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    return { width: result.width, height: result.height, png: [...bytes.slice(0, 4)].join(',') };
  });
  check('线上咖啡馆导出 PNG', exported.width === 1600 && exported.png === '137,80,78,71', exported);
  await page.screenshot({ path: `${OUT}/03-online-cafe.png` }).catch(() => {});

  check('线上无应用脚本错误', errors.length === 0, errors.slice(0, 3));
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ date: new Date().toISOString(), url: URL, ms: Date.now() - started, health, checks, errors }, null, 2));
  console.log(`\nV11 线上核验：${checks.length}/${checks.length} 通过`);
} catch (error) {
  writeFileSync(`${OUT}/failure.json`, JSON.stringify({ date: new Date().toISOString(), url: URL, checks, error: String(error), errors }, null, 2));
  throw error;
} finally {
  await browser.close();
}
