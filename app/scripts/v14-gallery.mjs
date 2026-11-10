/**
 * v14 作品展 → 创作 验证。
 *
 * 覆盖：
 * 1) 作品展条目 6 件（4 件 Lux3D + 2 件工作台手作），手作条目标注「工作台手作」；
 * 2) 作品展条目的「用这个配色开始创作」直链：进入工作台后花枝就是该配色的真实花材，
 *    地址栏不残留 ?palette=；
 * 3) Lux3D 作品详情页（?exhibit=）有配色入口，点击后同样能进入可编辑的起点作品；
 * 4) 手作封面文件存在、是 900px 级真实 JPEG；
 * 5) 手作详情页显示封面 +「工作台手作」，没有伪造 3D 模型；
 * 6) 390px 窄屏作品展/详情页都不横向溢出。
 *
 * 运行（5173 已在跑）：node scripts/v14-gallery.mjs
 * 环境变量：SMOKE_URL、v14_OUT、HEADED。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { newStudioAwarePage } from './studio-page.mjs';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.v14_OUT ?? '.verify/v14-gallery';
mkdirSync(OUT, { recursive: true });

/** 期望的配色起点（与 data/showcase.ts 一致，用来断言载入的确实是这束花的花材）。 */
const EXPECTED = {
  morning: { count: 10, first: 'rose-pink', kind: 'paper', paper: 'ivory' },
  daylight: { count: 9, first: 'tulip-cream', kind: 'vase', paper: 'sage' },
  'wood-table': { count: 9, first: 'peony-1', kind: 'pot', paper: 'clay' },
  birthday: { count: 9, first: 'carnation-1', kind: 'bucket', paper: 'kraft' },
};
const LUX = ['morning', 'daylight', 'evening', 'sunshine'];
const HANDMADE = ['wood-table', 'birthday'];
const COVER = {
  'wood-table': 'public/showcase/handmade-wood-table.jpg',
  birthday: 'public/showcase/handmade-birthday.jpg',
};

function jpegSize(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

const checks = [];
let count = 0;
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`);
  count += 1;
  console.log('ok', name);
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: process.env.HEADED !== '1',
  args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});

async function manifestIds(page) {
  return page.evaluate(async () => {
    const response = await fetch('/assets/manifest.json', { cache: 'no-cache' });
    const json = await response.json();
    return json.assets.map((asset) => asset.id);
  });
}

async function openWorkbench(context) {
  const page = await newStudioAwarePage(context);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text());
  });
  await page.goto(URL);
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalog.mode === 'manifest', null, { timeout: 60000 });
  return { page, errors };
}

/** 断言工作台里是一束该配色的真实花材，且地址栏已经清掉 palette 参数。 */
async function expectPaletteLoaded(page, id) {
  const expected = EXPECTED[id];
  const state = await page.evaluate(() => {
    const doc = window.__bouquetDebug.getState().doc;
    return {
      stems: doc.stems.map((stem) => stem.assetId),
      kind: doc.presentation.kind,
      paperId: doc.wrapping.paperId,
      stage: window.__bouquetDebug.getState().stage,
      search: location.search,
    };
  });
  const ids = await manifestIds(page);
  check(`${id}：地址栏无 palette 参数`, !new URLSearchParams(state.search).has('palette'), state.search);
  check(`${id}：花枝 ${expected.count} 枝`, state.stems.length === expected.count, state.stems.length);
  check(`${id}：花材全部来自真实清单`, state.stems.every((assetId) => ids.includes(assetId)), state.stems);
  check(`${id}：主花为 ${expected.first}`, state.stems[0] === expected.first, state.stems[0]);
  check(`${id}：器型 ${expected.kind}`, state.kind === expected.kind, state.kind);
  check(`${id}：纸色 ${expected.paper}`, state.paperId === expected.paper, state.paperId);
  check(`${id}：进入后停在可编辑的摆放阶段`, state.stage === 'arrange', state.stage);
  const unique = new Set(state.stems).size;
  check(`${id}：至少用到 5 种不同花材`, unique >= 5, unique);
}

try {
  // ---------- 桌面：作品展 + 配色入口 + 手作封面 / 详情页 ----------
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await context.addInitScript(() => { try { localStorage.clear(); } catch { /* 隐私模式忽略 */ } });
  const { page, errors } = await openWorkbench(context);

  await page.getByTestId('showcase-gallery').waitFor({ state: 'visible' });
  const items = await page.locator('.gallery-item').count();
  const luxCount = await page.locator('.gallery-item[data-source="lux3d"]').count();
  const handmadeCount = await page.locator('.gallery-item[data-source="handmade"]').count();
  check('作品展条目 4+2 共 6 件', items === 6 && luxCount === 4 && handmadeCount === 2, { items, luxCount, handmadeCount });
  check('作品展标注「工作台手作」', await page.getByTestId('gallery-handmade-tag').count() === 2);
  check('手作分组标题可见', await page.getByTestId('gallery-group-handmade').isVisible());
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('.gallery-item')].map((node) => node.getAttribute('data-source')));
  check('先整束作品、后工作台手作', order.slice(0, 4).every((source) => source === 'lux3d') && order.slice(4).every((source) => source === 'handmade'), order);
  await page.screenshot({ path: `${OUT}/01-gallery-desktop.png` });
  await page.getByTestId('gallery-group-handmade').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/01b-gallery-handmade.png` });

  // 作品展直链：?palette=morning
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.getByTestId('gallery-palette-morning').click(),
  ]);
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalog.mode === 'manifest', null, { timeout: 60000 });
  await expectPaletteLoaded(page, 'morning');
  await page.waitForFunction(() => [...window.__bouquetDebug.scene.views.values()].some((view) => view.object), null, { timeout: 90000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/02-workbench-palette-morning.png` });

  // Lux3D 详情页：配色按钮可以点，点击后仍然进工作台
  for (const id of LUX) {
    await page.goto(`${URL}?exhibit=${id}`);
    await page.getByTestId('exhibit-start-palette').waitFor({ state: 'visible' });
    const href = await page.getByTestId('exhibit-start-palette').getAttribute('href');
    check(`${id}：详情页配色入口指向 ?palette=`, (href ?? '').includes(`palette=${id}`), href);
  }
  await page.goto(`${URL}?exhibit=morning`);
  await page.waitForSelector('[data-testid=exhibit-canvas][data-status=ready]', { timeout: 90000 });
  await page.screenshot({ path: `${OUT}/03-exhibit-lux3d.png` });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.getByTestId('exhibit-start-palette').click(),
  ]);
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalog.mode === 'manifest', null, { timeout: 60000 });
  await expectPaletteLoaded(page, 'morning');

  // 手作封面文件
  for (const id of HANDMADE) {
    const buffer = readFileSync(COVER[id]);
    const size = jpegSize(buffer);
    check(`${id}：手作封面存在且 >30KB`, buffer.length > 30000, buffer.length);
    check(`${id}：手作封面为 900px 级 JPEG`, size?.width === 900 && size.height === 1125, size);
  }

  // 手作详情页：真实封面 + 工作台手作 + 配色按钮，没有伪造 3D
  for (const id of HANDMADE) {
    await page.goto(`${URL}?exhibit=${id}`);
    await page.getByTestId('exhibit-cover').waitFor({ state: 'visible' });
    check(`${id}：手作详情页显示真实封面`, await page.getByTestId('exhibit-cover').isVisible());
    check(`${id}：手作详情页无 3D 画布`, await page.getByTestId('exhibit-canvas').count() === 0);
    check(`${id}：标注「工作台手作」`, await page.getByText('工作台手作', { exact: false }).first().isVisible());
    check(`${id}：封面说明由工作台拍摄`, await page.locator('.exhibit-cover figcaption').isVisible());
    await page.screenshot({ path: `${OUT}/04-exhibit-handmade-${id}.png` });
    if (id === 'wood-table') {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.getByTestId('exhibit-start-palette').click(),
      ]);
      await page.waitForFunction(() => window.__bouquetDebug?.getState().catalog.mode === 'manifest', null, { timeout: 60000 });
      await expectPaletteLoaded(page, id);
      await page.goto(URL);
      await page.waitForFunction(() => window.__bouquetDebug?.getState().catalog.mode === 'manifest', null, { timeout: 60000 });
    }
  }

  check('桌面流程无脚本错误', errors.length === 0, errors.slice(0, 3));
  await context.close();

  // ---------- 窄屏：作品展展开与详情页都不横向溢出 ----------
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await mobile.addInitScript(() => { try { localStorage.clear(); } catch { /* 隐私模式忽略 */ } });
  const { page: small, errors: smallErrors } = await openWorkbench(mobile);
  await small.getByRole('button', { name: '看看花间作品' }).click();
  await small.waitForTimeout(400);
  check('窄屏作品展可展开', await small.getByTestId('gallery-morning').isVisible());
  const galleryOverflow = await small.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('窄屏作品展无横向溢出', galleryOverflow <= 1, galleryOverflow);
  await small.screenshot({ path: `${OUT}/05-gallery-mobile.png`, fullPage: false });
  await small.goto(`${URL}?exhibit=wood-table`);
  await small.getByTestId('exhibit-cover').waitFor({ state: 'visible' });
  const exhibitOverflow = await small.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('窄屏手作详情页无横向溢出', exhibitOverflow <= 1, exhibitOverflow);
  check('窄屏手作详情页配色按钮可见', await small.getByTestId('exhibit-start-palette').isVisible());
  await small.screenshot({ path: `${OUT}/06-exhibit-handmade-mobile.png`, fullPage: true });
  check('窄屏流程无脚本错误', smallErrors.length === 0, smallErrors.slice(0, 3));
  await mobile.close();

  writeFileSync(`${OUT}/results.json`, JSON.stringify({ passed: count, checks }, null, 2));
  console.log(`\nv14 作品展带动创作：${count}/${count} 通过`);
} catch (error) {
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ passed: count, checks, error: String(error) }, null, 2));
  console.error('\n失败：', error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
