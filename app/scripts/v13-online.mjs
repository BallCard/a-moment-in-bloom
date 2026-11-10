/**
 * V13 线上核验：公开魔搭入口的近景道具（Lux3D GLB）是否可用、按需加载、失败回退不受影响。
 *
 * 用法：node scripts/v13-online.mjs
 *   默认 https://www.modelscope.cn/studios/BallCard/bouquet-workbench?mode=full
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { newStudioAwarePage } from './studio-page.mjs';

const URL = process.env.ONLINE_URL ?? 'https://www.modelscope.cn/studios/BallCard/bouquet-workbench?mode=full';
const OUT = '.verify/v13-online';
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
const testId = (id) => page.locator(`[data-testid=${id}]`);

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
  check('线上健康检查版本 0.13.0', health.status === 200 && health.body?.version === '0.13.0', health);

  // 按需加载：进入拍照前不应该已经请求 4 件道具 GLB。
  const bootRequests = await exec(() => performance
    .getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((name) => name.includes('/assets/props/')));
  check('进入拍照前未预载道具 GLB（按需加载）', bootRequests.length === 0, bootRequests);

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

  const waitNode = async (name) => page
    .waitForFunction((target) => Boolean(window.__bouquetDebug.scene.scene.getObjectByName(target)), name, { timeout: 90000 })
    .then(() => true)
    .catch(() => false);

  await testId('photo-scene-festive').click();
  await wait(800);
  check('线上节日暖光加载蜡烛 GLB', (await waitNode('scene-prop-candle-0')) && (await waitNode('scene-prop-candle-1')));
  await page.screenshot({ path: `${OUT}/01-online-festive-candles.png` }).catch(() => {});

  await testId('photo-scene-living').click();
  await wait(800);
  check('线上家居客厅加载台灯 GLB', await waitNode('scene-prop-table-lamp-0'));
  check('线上家居客厅加载干花 GLB', await waitNode('scene-prop-dried-bouquet-0'));
  await page.screenshot({ path: `${OUT}/02-online-living-props.png` }).catch(() => {});

  await testId('photo-scene-cafe').click();
  await wait(800);
  check('线上咖啡馆加载杯碟 GLB', await waitNode('scene-prop-coffee-set-0'));
  await page.screenshot({ path: `${OUT}/03-online-cafe-coffee.png` }).catch(() => {});

  const assets = await exec(async () => {
    const files = ['candle', 'coffee-set', 'table-lamp', 'dried-bouquet'];
    const results = [];
    for (const file of files) {
      const response = await fetch(`assets/props/${file}.glb`, { cache: 'no-store' });
      results.push({ file, status: response.status, bytes: (await response.arrayBuffer()).byteLength });
    }
    return results;
  });
  check('线上 4 件道具 GLB 均可下载且大小匹配', assets.every((item) => item.status === 200 && item.bytes > 500000), assets);

  const loaded = await exec(() => performance
    .getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((name) => name.includes('/assets/props/')));
  check('线上进入场景后才加载道具（资源记录存在）', loaded.length >= 4, loaded.length);

  check('线上无应用脚本错误', errors.length === 0, errors.slice(0, 3));
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ date: new Date().toISOString(), url: URL, ms: Date.now() - started, health, assets, checks, errors }, null, 2));
  console.log(`\nV13 线上核验：${checks.length}/${checks.length} 通过`);
} catch (error) {
  writeFileSync(`${OUT}/failure.json`, JSON.stringify({ date: new Date().toISOString(), url: URL, checks, error: String(error), errors }, null, 2));
  throw error;
} finally {
  await browser.close();
}
