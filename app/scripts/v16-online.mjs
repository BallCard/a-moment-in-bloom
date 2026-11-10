/**
 * V16 / 0.16.0 线上核验（在魔搭公开入口的 iframe 内执行，与真实评审路径一致）。
 * 覆盖：health/缓存/清单/新资源、花材分类、绣球真实模型上屏、知识卡、整理面板、BGM 面板、
 * 开屏作品展右侧画册 + 滚轮切换、无脚本错误。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { newStudioAwarePage } from './studio-page.mjs';

const out = '.verify/v16-online';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(ok ? 'ok' : 'FAIL', name, JSON.stringify(detail ?? ''));
  if (!ok) throw Error(name);
}

try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await newStudioAwarePage(context);
  await page.goto('https://www.modelscope.cn/studios/BallCard/bouquet-workbench?mode=full', { timeout: 180000, waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('[data-testid="start-continue"]') || window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, { timeout: 180000 });
  await page.evaluate(() => {
    window.__v16errors = [];
    window.addEventListener('error', (event) => window.__v16errors.push(String(event.message)));
    window.addEventListener('unhandledrejection', (event) => window.__v16errors.push(String(event.reason)));
  });

  const facts = await page.evaluate(async () => {
    const health = await fetch('api/health', { cache: 'no-store' }).then((r) => r.json());
    const html = await fetch('./', { cache: 'no-store' }).then((r) => r.text());
    const src = html.match(/src="([^"]+\.js)"/)[1];
    const js = await fetch(src, { cache: 'no-store' });
    const headers = Object.fromEntries(js.headers);
    const conditional = await fetch(src, { headers: { 'If-None-Match': headers.etag }, cache: 'no-store' });
    const manifestResponse = await fetch('assets/manifest.json', { cache: 'no-store' });
    const manifest = await manifestResponse.json();
    const hydrangea = await fetch('assets/lux-hydrangea.glb', { cache: 'no-store' });
    const orchid = await fetch('assets/lux-orchid.glb', { cache: 'no-store' });
    const thumb = await fetch('assets/thumbs/hydrangea-1.png', { cache: 'no-store' });
    const bgm1 = await fetch('assets/audio/ambient-calm-1.mp3', { cache: 'no-store' });
    const bgm2 = await fetch('assets/audio/ambient-calm-2.mp3', { cache: 'no-store' });
    return {
      health,
      htmlHasFlower: html.includes('boot-petal'),
      headers,
      conditional: conditional.status,
      manifestCache: manifestResponse.headers.get('cache-control'),
      assetsVersion: manifest.assetsVersion,
      colors: window.__bouquetDebug.getState().catalog.entries.length,
      families: window.__bouquetDebug.getState().catalog.families.length,
      hydrangea: hydrangea.status,
      orchid: orchid.status,
      thumb: thumb.status,
      bgm1: { status: bgm1.status, type: bgm1.headers.get('content-type'), size: bgm1.headers.get('content-length') },
      bgm2: bgm2.status,
    };
  });

  check('health 0.16.0', facts.health.version === '0.16.0', facts.health);
  check('inline loading flower present', facts.htmlHasFlower);
  check('gzip bundle', facts.headers['content-encoding'] === 'gzip', facts.headers['content-length']);
  check('hashed bundle immutable', facts.headers['cache-control']?.includes('immutable'));
  check('conditional bundle 304', facts.conditional === 304, facts.conditional);
  check('manifest revalidated', facts.manifestCache?.includes('must-revalidate'), facts.manifestCache);
  check('manifest assetsVersion 2026-11-10.v16', facts.assetsVersion === '2026-11-10.lux3d-hydrangea-orchid', facts.assetsVersion);
  check('catalog 32 families / 57 colours', facts.families === 32 && facts.colors === 57, { families: facts.families, colors: facts.colors });
  check('hydrangea / orchid GLB 200', facts.hydrangea === 200 && facts.orchid === 200, { hydrangea: facts.hydrangea, orchid: facts.orchid });
  check('hydrangea thumbnail 200', facts.thumb === 200);
  check('BGM mp3 200 audio/mpeg', facts.bgm1.status === 200 && facts.bgm1.type?.includes('audio') && facts.bgm2 === 200, facts.bgm1);
  check('new / gallery entries', await page.getByTestId('new-bouquet').isVisible() && await page.getByTestId('gallery-open').isVisible());
  check('fresh empty workbench', await page.evaluate(() => window.__bouquetDebug.getState().doc.stems.length === 0));

  // 花材架：12 类目入口 + 绣球真实模型上屏
  await page.getByTestId('shelf-cat-all').waitFor();
  await page.getByTestId('shelf-group-main').click();
  await page.getByTestId('shelf-subcats').waitFor();
  const shelf = await page.evaluate(() => ({
    groups: document.querySelectorAll('[data-testid="shelf-group-main"], [data-testid="shelf-group-filler"], [data-testid="shelf-group-greenery"]').length,
    subcats: document.querySelectorAll('[data-testid="shelf-subcats"] button').length,
    count: document.querySelector('[data-testid="shelf-count"]')?.textContent ?? '',
  }));
  check('shelf exposes category groups and sub-categories', shelf.groups === 3 && shelf.subcats >= 4, shelf);
  await page.getByTestId('shelf-cat-all').click();
  await page.evaluate(() => {
    const store = window.__bouquetDebug.store;
    store.setPlacement('hydrangea-1');
    store.placeStem({ tilt: 8, direction: 20 });
    store.setPlacement(null);
  });
  await page.waitForFunction(() => window.__bouquetDebug.getState().doc.stems.length === 1);
  await page.waitForFunction(() => [...window.__bouquetDebug.scene.views.values()].every((view) => view.object && view.loaded?.source === 'glb'), null, { timeout: 120000 });
  const placed = await page.evaluate(() => {
    const view = [...window.__bouquetDebug.scene.views.values()][0];
    return { source: view.loaded?.source, family: view.loaded?.assetId };
  });
  check('hydrangea real GLB on table', placed.source === 'glb' && String(placed.family).startsWith('hydrangea'), placed);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/hydrangea-workbench.png` });

  // 知识卡
  await page.evaluate(() => window.__bouquetKnowledge.open('hydrangea'));
  await page.getByTestId('knowledge-card').waitFor();
  const knowledge = await page.evaluate(() => ({
    phase: window.__bouquetKnowledge.phase(),
    name: document.querySelector('[data-testid="knowledge-name"]')?.textContent ?? '',
    care: Boolean(document.querySelector('[data-testid="knowledge-section-care"]')),
    sources: document.querySelectorAll('[data-testid="knowledge-sources"] a').length,
  }));
  check('knowledge card opens with hydrangea', knowledge.phase === 'pinned' && knowledge.name.includes('绣球'), knowledge);
  check('knowledge card has care + sources', knowledge.care && knowledge.sources > 0, knowledge);
  await page.screenshot({ path: `${out}/knowledge-card.png` });
  await page.evaluate(() => window.__bouquetKnowledge.close('test'));

  // 整理面板
  const stemId = await page.evaluate(() => window.__bouquetDebug.getState().doc.stems[0].id);
  await page.evaluate((id) => window.__bouquetDebug.select(id), stemId);
  await page.getByTestId('flower-organize').waitFor({ timeout: 30000 });
  await page.getByTestId('flower-organize').click();
  await page.getByTestId('organize-panel').waitFor({ timeout: 30000 });
  const organizeStem = await page.evaluate(() => ({
    stemAction: Boolean(document.querySelector('[data-testid="organize-stem"]')),
    mouth: Boolean(document.querySelector('[data-testid="organize-mouth"]')),
    summary: document.querySelector('[data-testid="organize-stem-summary"]')?.textContent ?? '',
  }));
  check('organize panel opens with stem actions', organizeStem.stemAction, organizeStem);
  await page.evaluate(() => window.__bouquetDebug.select(null));
  await page.getByTestId('organize-bouquet').waitFor({ timeout: 30000 });
  const organizeBouquet = await page.evaluate(() => ({
    lead: document.querySelector('[data-testid="organize-bouquet-lead"]')?.textContent ?? '',
  }));
  check('organize panel exposes whole-bouquet action', organizeBouquet.lead.includes('一次整理整束'), organizeBouquet);
  await page.screenshot({ path: `${out}/organize-panel.png` });

  // 声音面板 + BGM 资源引用
  await page.getByTestId('audio-toggle').click();
  await page.getByTestId('audio-panel').waitFor();
  const audio = await page.evaluate(() => {
    const bgm = document.querySelector('[data-testid="audio-bgm"]');
    return {
      hasBgmToggle: Boolean(bgm),
      sources: [...document.querySelectorAll('audio')].map((item) => item.getAttribute('src') ?? '').filter(Boolean),
    };
  });
  check('audio panel exposes BGM toggle', audio.hasBgmToggle, audio);
  check('BGM audio element references generated track', audio.sources.some((src) => /ambient-calm/.test(src)), audio.sources);
  await page.screenshot({ path: `${out}/audio-panel.png` });

  // 开屏作品展：有存档后刷新给选择页 → 作品展画册 → 右侧滚轮切换
  await page.reload();
  await page.getByTestId('start-continue').waitFor({ timeout: 120000 });
  await page.getByTestId('start-gallery').click();
  const stage = page.getByTestId('showcase-gallery');
  await stage.waitFor();
  const before = await stage.getAttribute('data-index');
  const box = await stage.boundingBox();
  await page.mouse.move(box.x + box.width * 0.72, box.y + box.height * 0.5);
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(1000);
  const after = await stage.getAttribute('data-index');
  check('stage gallery wheel switches work', before !== after, { before, after });
  const stageStyle = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="showcase-gallery"].is-stage');
    if (!node) return null;
    const style = getComputedStyle(node);
    return { border: style.borderTopWidth, radius: style.borderTopLeftRadius, shadow: style.boxShadow };
  });
  check('stage gallery has no card shell', stageStyle && stageStyle.border === '0px' && stageStyle.radius === '0px' && stageStyle.shadow === 'none', stageStyle);
  await page.screenshot({ path: `${out}/start-gallery.png` });

  const frameErrors = await page.evaluate(() => window.__v16errors ?? []);
  check('no script errors in app frame', frameErrors.length === 0, frameErrors);
} finally {
  writeFileSync(`${out}/results.json`, JSON.stringify({ at: new Date().toISOString(), checks }, null, 2));
  await browser.close();
}
console.log(`${checks.length} passed`);
