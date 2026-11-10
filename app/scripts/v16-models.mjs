/**
 * V16 真实花材模型接入验证（绣球 hydrangea / 蝴蝶兰 orchid）。
 *
 * 覆盖：
 * 1) 正式清单（fixture:false，不带 ?manifest=）：assetsVersion、新增 4 条配色、
 *    32 花型 / 57 配色，新增条目指向 lux-hydrangea.glb / lux-orchid.glb；
 * 2) GLB 与缩略图可从 dev server 真实下载，字节数与磁盘一致；
 * 3) 花材架：两张卡片缩略图真实渲染、没有「占位」标签；
 * 4) 知识卡：绣球悬停约 300ms 出现预览、名字正确、meta 不再标「占位模型」，
 *    满 2 秒固定，三节内容（认识它 / 搭配 / 照顾它）都在；蝴蝶兰同样可打开；
 * 5) 工作台：两种花都能从花材架点选→点画布放上去，场景里加载的是 GLB
 *    （loaded.source==='glb'，不是程序化兜底），网络确实请求两份 GLB 且 200；
 * 6) 无页面错误、无 GLB 加载失败回退提示；截图与数字写进 .verify/v16-models/。
 *
 * 运行：先确保 http://127.0.0.1:5173 已在跑，再 `node scripts/v16-models.mjs`。
 * 环境变量：SMOKE_URL、V16_MODELS_OUT、V16_MODELS_EXPECT_VERSION。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.V16_MODELS_OUT ?? '.verify/v16-models';
const EXPECT_VERSION = process.env.V16_MODELS_EXPECT_VERSION ?? '2026-11-10.lux3d-hydrangea-orchid';
mkdirSync(OUT, { recursive: true });

const EXPECT = {
  families: ['hydrangea', 'orchid'],
  entries: [
    { id: 'hydrangea-1', glb: 'lux-hydrangea.glb', thumb: 'thumbs/hydrangea-1.png', name: '绣球 · 天蓝' },
    { id: 'hydrangea-2', glb: 'lux-hydrangea.glb', thumb: 'thumbs/hydrangea-2.png', name: '绣球 · 藕粉' },
    { id: 'orchid-1', glb: 'lux-orchid.glb', thumb: 'thumbs/orchid-1.png', name: '蝴蝶兰 · 白' },
    { id: 'orchid-2', glb: 'lux-orchid.glb', thumb: 'thumbs/orchid-2.png', name: '蝴蝶兰 · 紫' },
  ],
  // 花架卡片上的「占位」小标签；真实 GLB 接入后不应再出现。
  placeholderBadge: '.shelf-placeholder-badge',
};

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});

const results = [];
let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  if (ok) {
    passed += 1;
    console.log('ok  ', name);
  } else {
    failed += 1;
    console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail));
  }
}

const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
const consoleInfos = [];
const glbResponses = [];
const failedRequests = [];
page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)));
page.on('console', (message) => {
  const text = message.text();
  if (message.type() === 'error') consoleErrors.push(text);
  if (message.type() === 'info' || message.type() === 'log') consoleInfos.push(text);
});
page.on('response', (response) => {
  const url = response.url();
  if (/lux-(hydrangea|orchid)\.glb$/.test(url)) {
    glbResponses.push({ url, status: response.status() });
  }
  if (response.status() >= 400) failedRequests.push({ url, status: response.status() });
});

const report = {
  at: new Date().toISOString(),
  url: URL,
  expectedVersion: EXPECT_VERSION,
  assetsVersion: null,
  counts: {},
  glbDownloads: {},
  thumbDownloads: {},
  shelf: {},
  knowledge: {},
  workbench: {},
  network: {},
  screenshots: [],
  results,
  passed,
  failed,
};

/** 有存档时刷新会先到开始页：点「继续上次的花束」进入工作台。 */
async function enterWorkbench() {
  if ((await page.locator('[data-testid="start-continue"]').count()) > 0) {
    await page.getByTestId('start-continue').click();
    await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, {
      timeout: 90000,
    });
    await page.waitForTimeout(800);
  }
}

async function hideCoach() {
  if ((await page.locator('[data-testid="onboarding-skip"]').count()) > 0) {
    await page.getByTestId('onboarding-skip').click();
    await page.waitForTimeout(220);
  }
}

async function state() {
  return page.evaluate(() => window.__bouquetDebug.getState());
}

/** 找一个真正落在画布上、没有被界面浮层盖住的点。 */
async function canvasPoint() {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    for (let fy = 0.18; fy <= 0.82; fy += 0.04) {
      for (let fx = 0.12; fx <= 0.88; fx += 0.04) {
        const x = rect.left + rect.width * fx;
        const y = rect.top + rect.height * fy;
        if (document.elementFromPoint(x, y) === canvas) return { x, y };
      }
    }
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
}

async function waitSceneLoaded(expectedStems, timeout = 90000) {
  await page.waitForFunction(
    (count) => {
      const debug = window.__bouquetDebug;
      if (!debug) return false;
      const stems = debug.getState().doc.stems;
      if (stems.length !== count) return false;
      const views = [...debug.scene.views.values()];
      return views.length > 0 && views.every((view) => view.object && view.loaded);
    },
    expectedStems,
    { timeout },
  );
}

try {
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await enterWorkbench();
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, {
    timeout: 90000,
  });
  await page.waitForTimeout(900);
  await hideCoach();

  // ---------- 1. 正式清单（fixture:false） ----------
  const initial = await state();
  const pageUrl = page.url();
  check(
    '清单为正式 manifest（不是 fixture）',
    initial.catalogStatus === 'manifest' && !/[?&]manifest=/.test(pageUrl),
    { catalogStatus: initial.catalogStatus, pageUrl },
  );

  const manifest = await page.evaluate(async () => {
    const response = await fetch('/assets/manifest.json', { cache: 'no-cache' });
    return { ok: response.ok, status: response.status, json: await response.json() };
  });
  report.assetsVersion = manifest.json?.assetsVersion ?? null;
  check('manifest 可读取', manifest.ok && manifest.status === 200, manifest.status);
  check(
    `assetsVersion 已更新为 ${EXPECT_VERSION}`,
    manifest.json?.assetsVersion === EXPECT_VERSION,
    manifest.json?.assetsVersion,
  );

  const byId = Object.fromEntries((manifest.json?.assets ?? []).map((entry) => [entry.id, entry]));
  const entryOk = EXPECT.entries.every(
    (expect) =>
      byId[expect.id] &&
      byId[expect.id].glb === expect.glb &&
      byId[expect.id].thumb === expect.thumb &&
      byId[expect.id].displayName === expect.name,
  );
  check(
    '新增 4 条配色指向真实 GLB 与缩略图',
    entryOk,
    EXPECT.entries.map((expect) => ({ id: expect.id, got: byId[expect.id] && { glb: byId[expect.id].glb, thumb: byId[expect.id].thumb } })),
  );

  const families = initial.catalog.families.map((family) => family.family);
  const assetsVersionState = initial.catalog.assetsVersion;
  report.counts = {
    families: families.length,
    entries: initial.catalog.entries.length,
    catalogAssetsVersion: assetsVersionState,
    manifestEntries: manifest.json?.assets?.length ?? 0,
  };
  check(
    '目录 32 花型 / 57 配色（含绣球、蝴蝶兰）',
    families.length === 32 && initial.catalog.entries.length === 57 && manifest.json?.assets?.length === 57,
    report.counts,
  );
  check(
    '目录里出现绣球 / 蝴蝶兰两个花型',
    EXPECT.families.every((family) => families.includes(family)),
    families.filter((family) => EXPECT.families.includes(family)),
  );
  check(
    '运行时目录里两个花型都带 glb（不是程序化占位）',
    initial.catalog.entries
      .filter((entry) => EXPECT.families.includes(entry.family))
      .every((entry) => Boolean(entry.glb)),
    initial.catalog.entries.filter((entry) => EXPECT.families.includes(entry.family)).map((entry) => ({ id: entry.assetId, glb: entry.glb })),
  );

  // ---------- 2. GLB / 缩略图真实可下载 ----------
  for (const glb of ['lux-hydrangea.glb', 'lux-orchid.glb']) {
    const info = await page.evaluate(async (url) => {
      const response = await fetch(url, { cache: 'no-cache' });
      const buffer = response.ok ? await response.arrayBuffer() : new ArrayBuffer(0);
      return { status: response.status, bytes: buffer.byteLength };
    }, `/assets/${glb}`);
    let disk = null;
    try {
      disk = statSync(path.join(process.cwd(), 'public', 'assets', glb)).size;
    } catch {
      disk = null;
    }
    report.glbDownloads[glb] = { ...info, disk };
    check(`${glb} 可从站点下载且与磁盘一致`, info.status === 200 && info.bytes > 0 && info.bytes === disk, { ...info, disk });
  }
  for (const expect of EXPECT.entries) {
    const info = await page.evaluate(async (url) => {
      const response = await fetch(url, { cache: 'no-cache' });
      return { status: response.status };
    }, `/assets/${expect.thumb}`);
    report.thumbDownloads[expect.id] = info.status;
    check(`${expect.thumb} 可下载`, info.status === 200, info.status);
  }

  // ---------- 3. 花材架卡片 ----------
  const cards = await page.locator('.shelf-card').count();
  check('花材架卡片数与目录一致（32）', cards === 32, cards);
  for (const family of EXPECT.families) {
    const card = page.getByTestId(`shelf-card-${family}`);
    const exists = (await card.count()) === 1;
    check(`花材架有 ${family} 卡片`, exists);
    if (!exists) continue;
    const inspect = await card.evaluate((node, selector) => {
      const badges = [...node.querySelectorAll(selector)].map((el) => el.textContent?.trim() ?? '');
      const img = node.querySelector('.shelf-thumb img');
      return {
        placeholderBadges: badges,
        textHasPlaceholder: (node.textContent ?? '').includes('占位'),
        thumbSrc: img?.getAttribute('src') ?? null,
        thumbLoaded: Boolean(img && img.complete && img.naturalWidth > 0),
      };
    }, EXPECT.placeholderBadge);
    report.shelf[family] = inspect;
    check(`${family} 卡片没有「占位」标签`, inspect.placeholderBadges.length === 0 && !inspect.textHasPlaceholder, inspect);
    check(`${family} 卡片缩略图真实渲染`, inspect.thumbLoaded && Boolean(inspect.thumbSrc), inspect);
  }
  await page.screenshot({ path: `${OUT}/shelf-models.png` });
  report.screenshots.push('shelf-models.png');

  // ---------- 4. 知识卡（绣球预览 → 固定；蝴蝶兰再打开一次） ----------
  async function openKnowledge(family, { pinned = false } = {}) {
    const cardLocator = page.getByTestId(`shelf-card-${family}`);
    // 绣球 / 蝴蝶兰排在主花组靠后，默认滚动位置在 1366×768 视口外；
    // 先滚进可视区再悬停，否则 mouse.move 落在窗口外、不会触发知识浮窗。
    await cardLocator.scrollIntoViewIfNeeded();
    await page.waitForTimeout(180);
    const card = await cardLocator.boundingBox();
    await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
    await page.waitForTimeout(pinned ? 2200 : 420);
    const panel = page.locator('[data-testid="knowledge-card"]');
    const visible = (await panel.count()) === 1;
    const phase = visible ? await panel.getAttribute('data-phase') : null;
    const name = visible ? await page.getByTestId('knowledge-name').innerText() : null;
    const meta = visible ? await page.getByTestId('knowledge-meta').innerText() : null;
    const sections = visible
      ? await page.evaluate(() =>
          ['identify', 'pairing', 'care'].map(
            (key) => document.querySelectorAll(`[data-testid="knowledge-section-${key}"]`).length,
          ),
        )
      : [];
    return { visible, phase, name, meta, sections };
  }

  const hydrangeaKnowledge = await openKnowledge('hydrangea');
  report.knowledge.hydrangea = hydrangeaKnowledge;
  check(
    '悬停绣球约 300ms 出现知识预览',
    hydrangeaKnowledge.visible && hydrangeaKnowledge.phase === 'preview',
    hydrangeaKnowledge,
  );
  check('知识卡标题是绣球', hydrangeaKnowledge.name === '绣球', hydrangeaKnowledge.name);
  check(
    '知识卡 meta 不再标「占位模型」',
    Boolean(hydrangeaKnowledge.meta) && !hydrangeaKnowledge.meta.includes('占位模型'),
    hydrangeaKnowledge.meta,
  );
  check(
    '知识卡三节内容齐全',
    hydrangeaKnowledge.sections.length === 3 && hydrangeaKnowledge.sections.every((count) => count === 1),
    hydrangeaKnowledge.sections,
  );
  await page.screenshot({ path: `${OUT}/knowledge-hydrangea.png` });
  report.screenshots.push('knowledge-hydrangea.png');

  await page.waitForTimeout(2000);
  const pinnedPhase = await page.locator('[data-testid="knowledge-card"]').getAttribute('data-phase').catch(() => null);
  check('同一张绣球卡满 2 秒固定', pinnedPhase === 'pinned', pinnedPhase);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);

  // ---------- 5. 工作台：点选 → 点画布落位（真实 GLB） ----------
  await page.getByTestId('palette-hydrangea').click();
  let current = await state();
  check('点绣球卡片进入放置模式（hydrangea-1）', current.placement?.assetId === 'hydrangea-1', current.placement);
  const firstPoint = await canvasPoint();
  await page.mouse.click(firstPoint.x, firstPoint.y);
  await page.waitForTimeout(500);
  current = await state();
  check('绣球能放到工作台（1 枝）', current.doc.stems.length === 1 && current.doc.stems[0]?.assetId === 'hydrangea-1', current.doc.stems.map((stem) => stem.assetId));

  await page.getByTestId('palette-orchid').click();
  current = await state();
  check('点蝴蝶兰卡片进入放置模式（orchid-1）', current.placement?.assetId === 'orchid-1', current.placement);
  const secondPoint = await canvasPoint();
  await page.mouse.click(secondPoint.x + 24, secondPoint.y + 26);
  await page.waitForTimeout(500);
  current = await state();
  check(
    '蝴蝶兰能放到工作台（共 2 枝）',
    current.doc.stems.length === 2 && current.doc.stems.some((stem) => stem.assetId === 'orchid-1'),
    current.doc.stems.map((stem) => stem.assetId),
  );

  await waitSceneLoaded(2);
  const loadedViews = await page.evaluate(() =>
    [...window.__bouquetDebug.scene.views.entries()].map(([stemId, view]) => ({
      stemId,
      assetId: view.loaded?.assetId ?? null,
      source: view.loaded?.source ?? null,
      templateName: view.loaded?.template?.name ?? null,
      headRadius: view.loaded?.headRadius ?? null,
      headHeight: view.loaded?.headHeight ?? null,
    })),
  );
  report.workbench.views = loadedViews;
  check(
    '两枝场景资产都来自真实 GLB（source=glb）',
    loadedViews.length === 2 && loadedViews.every((view) => view.source === 'glb'),
    loadedViews,
  );
  check(
    '两枝场景资产 id 与花架选择一致',
    loadedViews.some((view) => view.assetId === 'hydrangea-1') &&
      loadedViews.some((view) => view.assetId === 'orchid-1'),
    loadedViews.map((view) => view.assetId),
  );

  await page.waitForTimeout(900);
  const stats = await page.evaluate(() => window.__bouquetDebug.getSceneState().stats);
  report.workbench.stats = stats;
  check('场景渲染统计可读（三角面 > 0）', typeof stats?.triangles === 'number' && stats.triangles > 0, stats);
  await page.screenshot({ path: `${OUT}/workbench-models.png` });
  report.screenshots.push('workbench-models.png');

  // ---------- 6. 网络、错误与回退提示 ----------
  const glbStatuses = glbResponses.map((item) => ({ file: item.url.split('/').pop(), status: item.status }));
  report.network = {
    glbResponses: glbStatuses,
    failedRequests: failedRequests.slice(0, 10),
    fallbackConsole: consoleInfos.filter((text) => text.includes('GLB 加载失败')).slice(0, 5),
    consoleErrors: consoleErrors.slice(0, 10),
    pageErrors: pageErrors.slice(0, 10),
  };
  check(
    '网络确实请求了两份新 GLB 且 200',
    ['lux-hydrangea.glb', 'lux-orchid.glb'].every((file) =>
      glbStatuses.some((item) => item.file === file && item.status === 200),
    ),
    glbStatuses,
  );
  const toasts = current.toasts ?? current.toast ?? [];
  const toastText = JSON.stringify(toasts);
  check(
    '没有 GLB 加载失败回退提示',
    report.network.fallbackConsole.length === 0 && !toastText.includes('先用占位花'),
    { fallbackConsole: report.network.fallbackConsole, toasts },
  );
  check('页面无脚本错误', pageErrors.length === 0, pageErrors);
  check('控制台无 error 级消息', consoleErrors.length === 0, consoleErrors);
  check('没有失败的静态资源请求', failedRequests.length === 0, failedRequests.slice(0, 5));

  // 知识卡：蝴蝶兰（工作台里再打开一次，确认新素材同样有内容）
  await page.keyboard.press('Escape');
  const orchidKnowledge = await openKnowledge('orchid', { pinned: true });
  report.knowledge.orchid = orchidKnowledge;
  check(
    '蝴蝶兰知识卡可打开且固定',
    orchidKnowledge.visible && orchidKnowledge.phase === 'pinned' && orchidKnowledge.name === '蝴蝶兰',
    orchidKnowledge,
  );
  check(
    '蝴蝶兰知识卡 meta 不含「占位模型」且三节齐全',
    Boolean(orchidKnowledge.meta) &&
      !orchidKnowledge.meta.includes('占位模型') &&
      orchidKnowledge.sections.every((count) => count === 1),
    orchidKnowledge,
  );
  await page.screenshot({ path: `${OUT}/knowledge-orchid-workbench.png` });
  report.screenshots.push('knowledge-orchid-workbench.png');
} catch (error) {
  failed += 1;
  results.push({ name: '验证脚本异常', ok: false, detail: String(error?.stack ?? error) });
  console.error('FAIL 验证脚本异常', error);
} finally {
  report.pageErrors = pageErrors;
  report.consoleErrors = consoleErrors;
  report.passed = passed;
  report.failed = failed;
  report.ok = failed === 0;
  writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n${passed} passed, ${failed} failed → ${OUT}/results.json`);
  if (process.env.HEADED !== '1') {
    await browser.close();
  }
  process.exitCode = failed === 0 ? 0 : 1;
}
