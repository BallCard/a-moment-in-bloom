/**
 * V9 线上核验：公开魔搭入口的目录、缩略图、真实 GLB 与健康检查是否可用。
 *
 * 用法：node scripts/v9-online.mjs
 *   默认 https://www.modelscope.cn/studios/BallCard/bouquet-workbench?mode=full
 *
 * 魔搭公开页会把应用放在 iframe 里（ballcard-bouquet-workbench.ms.show），
 * 复用 studio-page.mjs 的作用域代理在应用帧里断言。证据写 .verify/v9-online/。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { newStudioAwarePage } from './studio-page.mjs';

const URL = process.env.ONLINE_URL ?? 'https://www.modelscope.cn/studios/BallCard/bouquet-workbench?mode=full';
const OUT = '.verify/v9-online';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await newStudioAwarePage(context);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
const exec = (fn, arg) => page.evaluate(fn, arg);
const wait = (ms) => page.waitForTimeout(ms);

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`); console.log('ok', name); };

try {
  const started = Date.now();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, { timeout: 240000 });
  await wait(2000);

  const catalog = await exec(() => {
    const c = window.__bouquetDebug.getState().catalog;
    const kinds = { main: 0, filler: 0, greenery: 0 };
    for (const f of c.families) kinds[f.kind] += 1;
    return { families: c.families.length, entries: c.entries.length, kinds, assetsVersion: c.assetsVersion, mode: c.mode };
  });
  check('线上目录 30 花型 / 53 配色', catalog.families === 30 && catalog.entries === 53, catalog);
  check('线上目录来自 V9 manifest', catalog.mode === 'manifest' && String(catalog.assetsVersion).startsWith('2026-11-07.lux3d-112541'), catalog.assetsVersion);

  const thumbs = await exec(async () => {
    const imgs = [...document.querySelectorAll('.model-thumbnail')];
    const results = [];
    for (const img of imgs.slice(0, 30)) results.push({ src: img.getAttribute('src'), ok: img.complete && img.naturalWidth > 0 });
    return { count: imgs.length, bad: results.filter((r) => !r.ok), sample: results.slice(0, 2) };
  });
  check('线上花材架静态缩略图可解码（抽 30 张）', thumbs.count >= 10 && thumbs.bad.length === 0, { count: thumbs.count, bad: thumbs.bad.slice(0, 3) });

  const placed = await exec(async () => {
    const d = window.__bouquetDebug;
    const s = d.store;
    s.clearStems();
    for (const id of ['rose-pink', 'peony-1', 'eucalyptus-green']) {
      s.setPlacement(id);
      s.placeStem({ tilt: 12, direction: Math.random() * 360 });
      s.setPlacement(null);
    }
    for (let i = 0; i < 160; i++) {
      if (s.getState().doc.stems.every((x) => d.scene.views.get(x.id)?.object)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    return s.getState().doc.stems.map((x) => ({ id: x.assetId, source: d.scene.views.get(x.id)?.loaded?.source ?? 'pending' }));
  });
  check('线上 3 枝真实 GLB 全部加载', placed.length === 3 && placed.every((p) => p.source === 'glb'), placed);

  const health = await exec(async () => {
    try {
      const r = await fetch('api/health', { cache: 'no-store' });
      return { status: r.status, body: await r.json().catch(() => null) };
    } catch (e) { return { status: 0, error: String(e) }; }
  });
  check('线上健康检查可读且版本 0.9.1', health.status === 200 && health.body?.version === '0.9.1', health);

  // V0.9.1：匿名首次点击眼睛应出现「可以选中 + 滚轮切换」提示，且本机只记一次。
  function testId(id) { return page.locator(`[data-testid=${id}]`); }
  await testId('view-eye').click();
  await wait(350);
  const hintCount = await testId('view-hint').count();
  const hintText = hintCount ? await testId('view-hint').innerText() : '';
  check('线上首次点击眼睛出现视角提示', hintCount === 1 && hintText.includes('滚轮') && hintText.includes('选中'), { hintText });
  const hintFlag = await exec(() => localStorage.getItem('bouquet-workbench.first-use.view-wheel'));
  check('线上首次提示写入本机标记', hintFlag === '1', { hintFlag });
  await page.screenshot({ path: `${OUT}/02-online-view-hint.png` }).catch(() => {});
  await testId('view-hint-close').click();
  await wait(200);
  check('线上点「知道了」收起提示', (await testId('view-hint').count()) === 0);
  await testId('view-eye').click();
  await wait(300);
  check('线上再次点眼睛不重复提示', (await testId('view-hint').count()) === 0);

  await page.screenshot({ path: `${OUT}/01-online-bouquet.png` });
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ date: new Date().toISOString(), url: URL, ms: Date.now() - started, catalog, thumbs, placed, health, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, catalog, placed, health, errors }, null, 2));
} catch (error) {
  writeFileSync(`${OUT}/failure.json`, JSON.stringify({ date: new Date().toISOString(), url: URL, checks, error: String(error), errors }, null, 2));
  throw error;
} finally {
  await browser.close();
}
