/**
 * V9 视觉验收：真实 53 条清单下的花材架与成品花束截图。
 *
 * 用法：npm run build && npx vite preview --port 5185 --strictPort，然后
 *   node scripts/v9-visual.mjs
 *
 * 只截图与记录事实（30 花型/53 配色/成品混插），不做断言阈值；断言在
 * v07-materials.mjs / v07-real-manifest.mjs 里。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.VISUAL_URL ?? 'http://127.0.0.1:5185/';
const OUT = '.verify/v9-visual';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });

const exec = (fn, arg) => page.evaluate(fn, arg);
const wait = (ms) => page.waitForTimeout(ms);

try {
  const started = Date.now();
  await page.goto(BASE);
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalog.mode === 'manifest');
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('.model-thumbnail')];
    return imgs.length >= 10 && imgs.every((i) => i.complete && i.naturalWidth > 0);
  }, null, { timeout: 60000 });
  await wait(1200);

  const catalog = await exec(() => {
    const c = window.__bouquetDebug.getState().catalog;
    const kinds = { main: 0, filler: 0, greenery: 0 };
    for (const f of c.families) kinds[f.kind] += 1;
    return {
      families: c.families.length,
      entries: c.entries.length,
      kinds,
      familiesOfKind: { main: [], filler: [], greenery: [] },
    };
  });

  // 1) 全部花材架（三分类各截一张，面板滚动条内部滚动，只能按分类截）
  for (const kind of ['main', 'filler', 'greenery']) {
    const button = page.locator('.palette-categories button', { hasText: kind === 'main' ? '主花' : kind === 'filler' ? '配花' : '绿叶' });
    if (await button.count()) await button.first().click();
    await wait(900);
    await page.screenshot({ path: `${OUT}/01-palette-${kind}.png` });
  }
  const allButton = page.locator('.palette-categories button', { hasText: '全部' });
  if (await allButton.count()) await allButton.first().click();
  await wait(600);

  // 2) 12 枝混插成品（8 个花型 + 绿叶）
  const placed = await exec(async () => {
    const d = window.__bouquetDebug;
    const s = d.store;
    s.clearStems();
    const picks = [
      ['rose-pink', 0, 8, 0], ['peony-1', 0.02, 14, 40], ['tulip-cream', 0.03, 22, 80],
      ['carnation-1', 0.01, 30, 120], ['sunflower-1', 0.04, 36, 160], ['lily-2', 0.03, 42, 200],
      ['eucalyptus-green', 0.03, 48, 240], ['ruscus-1', 0.02, 54, 280], ['statice-1', 0.03, 60, 320],
      ['spray-rose-pink', 0.03, 66, 350], ['daisy-gold', 0.03, 72, 25], ['ivy-1', 0.02, 78, 300],
    ];
    for (const [id, height, tilt, direction] of picks) {
      s.setPlacement(id);
      s.placeStem({ height, tilt, direction, spin: 20 });
      s.setPlacement(null);
    }
    s.select(null);
    for (let i = 0; i < 100; i++) {
      const stems = s.getState().doc.stems;
      if (stems.every((stem) => d.scene.views.get(stem.id)?.object)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const stems = s.getState().doc.stems;
    return {
      stems: stems.length,
      assets: stems.map((x) => x.assetId),
      loaded: stems.map((x) => d.scene.views.get(x.id)?.loaded?.source ?? 'pending'),
      triangles: stems.map((x) => {
        const loaded = d.scene.views.get(x.id)?.loaded;
        if (!loaded) return 0;
        let tris = 0;
        loaded.template.traverse((o) => { const m = o; if (m.isMesh) { const g = m.geometry; tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3; } });
        return Math.round(tris);
      }),
    };
  });
  await wait(1500);
  await page.screenshot({ path: `${OUT}/02-bouquet-front.png` });

  // 3) 侧视角 + 俯视角
  await exec(() => window.__bouquetDebug.store.setViewPreset('quarter'));
  await wait(1000);
  await page.screenshot({ path: `${OUT}/03-bouquet-quarter.png` });
  await exec(() => window.__bouquetDebug.store.setViewPreset('top'));
  await wait(1000);
  await page.screenshot({ path: `${OUT}/04-bouquet-top.png` });

  // 4) 花材架配色总量（从 DOM 数）
  const colorDots = await exec(() => document.querySelectorAll('.variant-dot').length);
  const cards = await exec(() => document.querySelectorAll('.shelf-card').length);

  const scene = await exec(() => window.__bouquetDebug.getSceneState());
  const report = {
    date: new Date().toISOString(),
    url: BASE,
    loadMs: Date.now() - started,
    catalog,
    cards,
    colorDots,
    placed,
    scene: { stats: scene.stats, demo: scene.demo ?? null },
    errors,
  };
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ catalog, cards, colorDots, placed: { stems: placed.stems, loaded: placed.loaded, triangles: placed.triangles }, stats: scene.stats, errors }, null, 2));
} catch (error) {
  writeFileSync(`${OUT}/failure.json`, JSON.stringify({ date: new Date().toISOString(), error: String(error), errors }, null, 2));
  throw error;
} finally {
  await browser.close();
}
