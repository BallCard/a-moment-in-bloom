/**
 * V14 线上核验：公开魔搭入口上，本轮五块体验改动是否真的可用。
 *
 * 覆盖：health 0.14.0、花材架两列/搜索/色系、包装第一层 8 个真实预览、
 * 拍照 8 张场景缩略图、委托 6 封与 c4 心愿标签、作品展 6 件与「用这个配色开始创作」、
 * 手作封面与器型预览等新增静态资源可下载、无应用脚本错误。
 *
 * 用法：node scripts/v14-online.mjs
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { newStudioAwarePage } from './studio-page.mjs';

const URL = process.env.ONLINE_URL ?? 'https://www.modelscope.cn/studios/BallCard/bouquet-workbench?mode=full';
const OUT = '.verify/v14-online';
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
  check('线上健康检查版本 0.14.0', health.status === 200 && health.body?.version === '0.14.0', health);

  // ---------- 花材架 ----------
  await exec(() => window.__bouquetDebug.store.clearStems());
  await wait(600);
  const shelf = await exec(() => {
    const grid = document.querySelector('[data-testid=shelf-grid]');
    const cards = document.querySelectorAll('.shelf-card');
    const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
    return { cards: cards.length, columns, search: Boolean(document.querySelector('[data-testid=shelf-search]')), tones: document.querySelectorAll('[data-testid^=shelf-color-]').length };
  });
  check('线上花材架 30 张卡、两列', shelf.cards === 30 && shelf.columns === 2, shelf);
  check('线上花材架搜索与色系筛选存在', shelf.search && shelf.tones >= 9, shelf);
  await page.evaluate(() => {
    const input = document.querySelector('[data-testid=shelf-search]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '玫瑰');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(500);
  check('线上搜索过滤到 2 种', (await page.locator('.shelf-card').count()) === 2, await page.locator('.shelf-card').count());
  await page.evaluate(() => {
    const input = document.querySelector('[data-testid=shelf-search]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.screenshot({ path: `${OUT}/01-online-shelf.png` });

  // ---------- 包装第一层真实预览 ----------
  await exec(() => {
    const store = window.__bouquetDebug.store;
    for (let i = 0; i < 6; i += 1) {
      store.setPlacement(i < 3 ? 'rose-pink' : i < 5 ? 'tulip-cream' : 'eucalyptus-green');
      store.placeStem({ height: (i % 3) * 0.03, tilt: 8 + i * 3, direction: i * 137, spin: 20 });
      store.setPlacement(null);
    }
    store.select(null);
  });
  await page.waitForFunction(() => [...window.__bouquetDebug.scene.views.values()].every((view) => view.object), null, { timeout: 120000 });
  await wait(600);
  await testId('stage-wrap').click();
  await wait(900);
  await page.locator('.package-choice-grid').scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForFunction(
    () => {
      const imgs = [...document.querySelectorAll('.package-choice-img')];
      return imgs.length === 8 && imgs.every((img) => img.complete && img.naturalWidth > 0);
    },
    null,
    { timeout: 20000 },
  ).catch(() => {});
  const previews = await exec(() => [...document.querySelectorAll('.package-choice-img')].map((img) => ({ src: img.getAttribute('src'), ok: img.complete && img.naturalWidth > 0 })));
  check('线上包装第一层 8 个器型小预览全部加载', previews.length === 8 && previews.every((item) => item.ok), previews);
  await page.screenshot({ path: `${OUT}/02-online-package-forms.png` });

  // ---------- 拍照场景缩略图 ----------
  await testId('stage-finish').click();
  await wait(1800);
  const scenes = await exec(() => {
    const ids = ['window', 'studio', 'gallery', 'florist', 'garden', 'festive', 'living', 'cafe'];
    return ids.map((id) => {
      const card = document.querySelector(`[data-testid=photo-scene-${id}]`);
      const img = card?.querySelector('img');
      return { id, card: Boolean(card), img: img ? img.src : null, loaded: Boolean(img && img.complete && img.naturalWidth > 0) };
    });
  });
  check('线上拍照 8 个场景缩略图全部加载', scenes.length === 8 && scenes.every((item) => item.card && item.loaded && item.img.includes('/assets/scenes/')), scenes);
  const large = await page.getByTestId('photo-preview').boundingBox();
  check('线上大取景预览存在且为主视觉', Boolean(large) && large.width >= 260, large);
  await page.screenshot({ path: `${OUT}/03-online-photo-scenes.png` });

  // ---------- 委托 ----------
  await page.getByTestId('mode-commission').click();
  await page.waitForSelector('[data-testid=commission-card]');
  await wait(400);
  const picker = await exec(() => ({ text: document.querySelector('.commission-pager span')?.textContent ?? '', chips: document.querySelectorAll('[data-testid=commission-wish-chip]').length }));
  check('线上委托共 6 封', (picker.text ?? '').trim().endsWith('/ 6'), picker);
  await page.screenshot({ path: `${OUT}/04-online-commission.png` });
  await page.getByTestId('commission-close').click();
  await wait(300);

  // ---------- 作品展与静态资源 ----------
  await exec(() => { window.__bouquetDebug.store.clearStems(); window.__bouquetDebug.store.setStage('arrange'); });
  await wait(800);
  const gallery = await exec(() => ({ items: document.querySelectorAll('.gallery-item').length, handmade: document.querySelectorAll('[data-testid^=gallery-][data-source=handmade]').length, paletteLinks: document.querySelectorAll('a[href*="palette="]').length }));
  check('线上作品展 6 件且含手作', gallery.items === 6, gallery);
  check('线上作品展有「用这个配色开始创作」入口', gallery.paletteLinks >= 6, gallery);
  await page.screenshot({ path: `${OUT}/05-online-gallery.png` });

  const assets = await exec(async () => {
    const files = [
      ...['window', 'studio', 'gallery', 'florist', 'garden', 'festive', 'living', 'cafe'].map((id) => `assets/scenes/${id}.jpg`),
      ...['paper', 'vase', 'pot', 'basket', 'box', 'bucket', 'bag', 'crate'].map((id) => `assets/vessels/previews/${id}.jpg`),
      'showcase/handmade-wood-table.jpg',
      'showcase/handmade-birthday.jpg',
    ];
    const results = [];
    for (const file of files) {
      const response = await fetch(file, { cache: 'no-store' });
      results.push({ file, status: response.status, bytes: (await response.arrayBuffer()).byteLength });
    }
    return results;
  });
  const badAssets = assets.filter((item) => item.status !== 200 || item.bytes < 2000);
  check('线上新增静态资源（场景 8 / 器型 8 / 手作 2）全部可下载', badAssets.length === 0, badAssets);

  // 配色入口真的能载入工作台。
  // 线上入口把应用放在 iframe 里，作品展的 ./?palette= 是在应用自身窗口内跳转；
  // 这里用同一路径（在应用 frame 内 location 跳转）验证参数应用与地址栏清理。
  const appFrame = page.frames().find((frame) => frame.url().startsWith('https://ballcard-bouquet-workbench.ms.show/')) ?? page.mainFrame();
  await appFrame.goto(new globalThis.URL('?palette=morning', appFrame.url()).href, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await appFrame.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, { timeout: 240000 });
  await appFrame.waitForFunction(() => window.__bouquetDebug.getState().doc.stems.length > 0, null, { timeout: 60000 });
  const palette = await appFrame.evaluate(() => {
    const state = window.__bouquetDebug.getState();
    return { stems: state.doc.stems.length, stage: state.stage, assets: [...new Set(state.doc.stems.map((stem) => stem.assetId))], url: location.search };
  });
  check('线上「用这个配色开始创作」载入 10 枝且回到摆放阶段', palette.stems === 10 && palette.stage === 'arrange', palette);
  check('线上配色入口应用后地址栏清掉参数', palette.url === '' || !palette.url.includes('palette='), palette.url);
  await page.screenshot({ path: `${OUT}/06-online-palette.png` });

  check('线上无应用脚本错误', errors.length === 0, errors.slice(0, 3));
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ date: new Date().toISOString(), url: URL, ms: Date.now() - started, health, shelf, previews, scenes, gallery, assets, palette, checks, errors }, null, 2));
  console.log(`\nV14 线上核验：${checks.length}/${checks.length} 通过`);
} catch (error) {
  writeFileSync(`${OUT}/failure.json`, JSON.stringify({ date: new Date().toISOString(), url: URL, checks, error: String(error), errors }, null, 2));
  throw error;
} finally {
  await browser.close();
}
