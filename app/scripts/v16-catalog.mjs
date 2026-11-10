/**
 * v16 花材类目 / 知识浮窗 / 新手指引验证（V16 §2 + §4）。
 *
 * 覆盖：
 * 1) 目录完整：32 花型 / 57 配色全部上架；绣球、蝴蝶兰已接入真实 Lux3D GLB，不再标「占位」；
 * 2) 类目入口：三组展开 → 12 个小类逐个筛选（每类非空、花科正确、合计 32），清空恢复；
 * 3) 旧搜索 / 色系 / 最近使用 / 类目叠加不回归；
 * 4) 知识浮窗：<300ms 不出现、约 300ms 预览、满 2s 固定、固定后经过其他花材不换内容、
 *    浮窗内点击/滚动不关闭、外部点击只关闭不穿透三维操作、Esc 关闭、拖取取消、
 *    键盘「了解」进入 + Esc 退出 + 焦点返回；
 * 5) 知识内容自检：32 花型都有三节内容；配对 1–2 条、养护 2–3 条；来源带核对日期；
 * 6) 新手引导：四步推进、候选只进入取花不直接加花、跳过、帮助入口重看、刷新不重复、
 *    老用户（已有作品）不强制教学、EmptyGuide 既有提示不重复；
 * 7) 391px 窄屏：「了解」入口可点、浮窗在视口内、无横向溢出。
 *
 * 运行：先确保 http://127.0.0.1:5173 在跑，再 `node scripts/v16-catalog.mjs`。
 * 环境变量：SMOKE_URL、V16_OUT。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.V16_OUT ?? '.verify/v16-catalog';
mkdirSync(OUT, { recursive: true });

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

const ctxDesktop = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const ctxNarrow = await browser.newContext({ viewport: { width: 391, height: 844 } });

/** 打开页面。clear=true 先清 localStorage 再重载（模拟全新玩家）。 */
async function openPage(context, { clear = false, viewport } = {}) {
  const page = await context.newPage();
  if (viewport) await page.setViewportSize(viewport);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
  });
  await page.goto(URL);
  if (clear) {
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  }
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, {
    timeout: 90000,
  });
  await page.waitForTimeout(1100);
  return { page, pageErrors };
}

/** 有存档时刷新会先到开始页：点「继续上次的花束」进入工作台。 */
async function enterWorkbench(page) {
  if ((await page.locator('[data-testid="start-continue"]').count()) > 0) {
    await page.getByTestId('start-continue').click();
    await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, {
      timeout: 90000,
    });
    await page.waitForTimeout(900);
    return true;
  }
  return false;
}

async function hideCoach(page) {
  if ((await page.locator('[data-testid="onboarding-skip"]').count()) > 0) {
    await page.getByTestId('onboarding-skip').click();
    await page.waitForTimeout(220);
  }
}

async function state(page) {
  return page.evaluate(() => window.__bouquetDebug.getState());
}

async function cardCount(page) {
  return page.locator('.shelf-card').count();
}

async function waitCards(page, count, timeout = 5000) {
  await page
    .waitForFunction((expected) => document.querySelectorAll('.shelf-card').length === expected, count, { timeout })
    .catch(() => {});
  return cardCount(page);
}

/** 展开指定类目组（已展开时不重复点击，避免把组又收起来）。 */
async function ensureGroupOpen(page, group) {
  const expanded = await page.getByTestId(`shelf-group-${group}`).getAttribute('aria-expanded');
  if (expanded !== 'true') await page.getByTestId(`shelf-group-${group}`).click();
  await page.waitForSelector('[data-testid="shelf-subcats"]', { timeout: 3000 });
}

/** 找一个真正落在画布上、没有被界面浮层盖住的点。 */
async function canvasPoint(page) {
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

/** 类目 → 期望命中的花科（与 data/categories.ts 的映射一致，测试侧独立写死以便发现漂移）。 */
const CATEGORY_EXPECT = {
  'rose': { group: 'main', families: ['rose'] },
  'spray-rose': { group: 'main', families: ['spray'] },
  'tulip': { group: 'main', families: ['tulip'] },
  'lily': { group: 'main', families: ['lily'] },
  'carnation': { group: 'main', families: ['carnation'] },
  'chrysanthemum': { group: 'main', families: ['daisy', 'spray-chrysanthemum'] },
  'hydrangea': { group: 'main', families: ['hydrangea'] },
  'lisianthus': { group: 'main', families: ['lisianthus'] },
  'orchid': { group: 'main', families: ['orchid'] },
  'other-flowers': {
    group: 'main',
    families: ['peony', 'herbaceous-peony', 'sunflower', 'dahlia', 'calla', 'alstroemeria'],
  },
  'filler-mix': {
    group: 'filler',
    families: ['babys-breath', 'statice', 'waxflower', 'rice-flower', 'veronica', 'snapdragon'],
  },
  'greenery': {
    group: 'greenery',
    families: [
      'eucalyptus',
      'ruscus',
      'salal',
      'asparagus-fern',
      'leatherleaf',
      'boston-fern',
      'ivy',
      'fatsia',
      'aspidistra',
      'bear-grass',
    ],
  },
};

try {
  // ==================== A. 目录完整 + 类目入口（桌面） ====================
  {
    const { page, pageErrors } = await openPage(ctxDesktop, { clear: true });
    await hideCoach(page);
    const initial = await state(page);
    check('目录清单就绪（manifest）', initial.catalogStatus === 'manifest', initial.catalogStatus);
    check(
      '32 花型 / 57 配色（新增绣球、蝴蝶兰）',
      initial.catalog.families.length === 32 && initial.catalog.entries.length === 57,
      { families: initial.catalog.families.length, entries: initial.catalog.entries.length },
    );
    check('花材架 32 张卡全部渲染', (await waitCards(page, 32)) === 32, await cardCount(page));
    check('计数显示 32/32', (await page.getByTestId('shelf-count').innerText()) === '32/32', await page.getByTestId('shelf-count').innerText());
    await page.screenshot({ path: `${OUT}/a-boot.png` });

    // ---------- 新增两种花材：卡片存在 + 真实模型（2026-11-10 起不再标「占位」） ----------
    const hydrangeaBadge = await page.locator('[data-testid="shelf-card-hydrangea"] .shelf-placeholder-badge').count();
    const orchidBadge = await page.locator('[data-testid="shelf-card-orchid"] .shelf-placeholder-badge').count();
    const roseBadge = await page.locator('[data-testid="shelf-card-rose"] .shelf-placeholder-badge').count();
    const badgeTotal = await page.locator('.shelf-placeholder-badge').count();
    const newModelGlbs = await page.evaluate(() => {
      const catalog = window.__bouquetDebug.getState().catalog;
      return ['hydrangea', 'orchid'].map((family) => ({
        family,
        glb: catalog.families.find((item) => item.family === family)?.entries?.[0]?.glb ?? null,
      }));
    });
    check('绣球卡片不标「占位」且指向真实 GLB', hydrangeaBadge === 0 && Boolean(newModelGlbs[0].glb), { hydrangeaBadge, ...newModelGlbs[0] });
    check('蝴蝶兰卡片不标「占位」且指向真实 GLB', orchidBadge === 0 && Boolean(newModelGlbs[1].glb), { orchidBadge, ...newModelGlbs[1] });
    check('真实 GLB 花材（玫瑰）不标占位', roseBadge === 0, roseBadge);
    check('32 种花材全部是真实模型，架上没有任何「占位」标注', badgeTotal === 0, badgeTotal);

    // ---------- 类目入口：三组展开 ----------
    const groups = await page.evaluate(() =>
      [...document.querySelectorAll('.shelf-group-chip')].map((el) => el.getAttribute('data-testid')),
    );
    check('类目入口是主花 / 配花 / 叶材三组', groups.join(',') === 'shelf-group-main,shelf-group-filler,shelf-group-greenery', groups);
    check('默认不展开小类（保持紧凑）', (await page.locator('[data-testid="shelf-subcats"]').count()) === 0);
    await page.getByTestId('shelf-group-main').click();
    await page.waitForSelector('[data-testid="shelf-subcats"]', { timeout: 3000 });
    const mainCats = await page.evaluate(() =>
      [...document.querySelectorAll('.shelf-subcat-chip')].map((el) => el.getAttribute('data-testid').replace('shelf-cat-', '')),
    );
    check('主花组展开 10 个小类', mainCats.length === 10, mainCats);
    await page.screenshot({ path: `${OUT}/a-categories-main.png` });

    // ---------- 12 个小类逐个筛选 ----------
    let categorySum = 0;
    const categoryDetail = {};
    for (const [category, expect] of Object.entries(CATEGORY_EXPECT)) {
      const group = expect.group;
      await ensureGroupOpen(page, group);
      await page.getByTestId(`shelf-cat-${category}`).click();
      await page.waitForTimeout(160);
      const count = await cardCount(page);
      const present = await page.evaluate(
        (families) => families.filter((family) => Boolean(document.querySelector(`[data-testid="shelf-card-${family}"]`))),
        expect.families,
      );
      const unexpected = await page.evaluate(
        (families) => {
          const allowed = new Set(families);
          return [...document.querySelectorAll('.shelf-card')]
            .map((el) => el.getAttribute('data-family'))
            .filter((family) => family && !allowed.has(family));
        },
        expect.families,
      );
      categorySum += count;
      categoryDetail[category] = count;
      check(
        `类目「${category}」非空且只命中该类的花科`,
        count === expect.families.length && present.length === expect.families.length && unexpected.length === 0,
        { count, expected: expect.families.length, present, unexpected },
      );
    }
    check('12 个类目合计正好覆盖 32 花型（无空类目 / 无重复归类）', categorySum === 32, { categorySum, categoryDetail });

    // 菊类截图（跨类目：非洲菊 + 多头小菊）
    await ensureGroupOpen(page, 'main');
    await page.getByTestId('shelf-cat-chrysanthemum').click();
    await page.waitForTimeout(200);
    check(
      '菊类同时包含非洲菊与多头小菊',
      (await page.locator('[data-testid="shelf-card-daisy"]').count()) === 1 &&
        (await page.locator('[data-testid="shelf-card-spray-chrysanthemum"]').count()) === 1,
    );
    check('选中类目时显示一句用途说明', (await page.getByTestId('shelf-cat-note').count()) === 1);

    // 叶材组截图
    await ensureGroupOpen(page, 'greenery');
    await page.getByTestId('shelf-cat-greenery').click();
    await page.waitForTimeout(200);
    check('叶材类目 10 种花材', (await cardCount(page)) === 10, await cardCount(page));
    await page.screenshot({ path: `${OUT}/a-categories-greenery.png` });

    // ---------- 清空恢复 ----------
    await page.getByTestId('shelf-cat-all').click();
    check('点「全部」恢复 32 花型', (await waitCards(page, 32)) === 32, await cardCount(page));
    check('恢复后计数 32/32', (await page.getByTestId('shelf-count').innerText()) === '32/32');
    check('恢复后不再显示类目说明', (await page.getByTestId('shelf-cat-note').count()) === 0);

    // ==================== B. 搜索 / 色系 / 最近使用不回归 ====================
    await page.getByTestId('shelf-search').fill('玫瑰');
    check('搜索「玫瑰」仍是玫瑰 + 多头玫瑰 2 种', (await waitCards(page, 2)) === 2, await cardCount(page));
    check('搜索后计数 2/32', (await page.getByTestId('shelf-count').innerText()) === '2/32');
    await page.screenshot({ path: `${OUT}/b-shelf-search.png` });
    await page.getByTestId('shelf-search-clear').click();
    check('清空搜索恢复 32 种', (await waitCards(page, 32)) === 32);

    // 搜索 + 类目叠加
    await ensureGroupOpen(page, 'main');
    await page.getByTestId('shelf-cat-rose').click();
    await page.getByTestId('shelf-search').fill('玫瑰');
    check(
      '类目 + 搜索叠加：玫瑰类目里只有玫瑰',
      (await waitCards(page, 1)) === 1 && (await page.locator('[data-testid="shelf-card-rose"]').count()) === 1,
      await cardCount(page),
    );
    await page.getByTestId('shelf-search-clear').click();
    await page.getByTestId('shelf-cat-all').click();
    await waitCards(page, 32);

    // 色系
    await page.getByTestId('shelf-color-pink').click();
    const pinkCount = await cardCount(page);
    const pinkRose = await page.locator('[data-testid="shelf-card-rose"]').count();
    const pinkEucalyptus = await page.locator('[data-testid="shelf-card-eucalyptus"]').count();
    check('色系「粉」缩小结果集', pinkCount > 0 && pinkCount < 32, pinkCount);
    check('粉筛选保留玫瑰、排除纯绿叶尤加利', pinkRose === 1 && pinkEucalyptus === 0, { pinkRose, pinkEucalyptus });
    await page.screenshot({ path: `${OUT}/b-shelf-color.png` });
    await page.getByTestId('shelf-color-all').click();
    check('取消色系恢复 32 种', (await waitCards(page, 32)) === 32);

    // 最近使用
    await page.getByTestId('palette-tulip').click();
    await page.waitForTimeout(220);
    check('取花进入放置模式（郁金香）', (await state(page)).placement?.assetId === 'tulip-pink');
    await page.getByTestId('palette-rose').click();
    await page.waitForTimeout(240);
    let current = await state(page);
    const recent = await page.evaluate(() => ({
      row: Boolean(document.querySelector('[data-testid="shelf-recent"]')),
      ids: [...document.querySelectorAll('[data-testid="shelf-recent-chip"]')].map((el) => el.getAttribute('data-asset-id')),
    }));
    check('取花进入放置模式（玫瑰）', current.placement?.assetId === 'rose-pink', current.placement);
    check(
      '最近使用行出现且最新在前',
      recent.row && recent.ids[0] === 'rose-pink' && recent.ids.includes('tulip-pink'),
      recent,
    );
    await page.locator('[data-testid="shelf-recent-chip"][data-asset-id="tulip-pink"]').click();
    await page.waitForTimeout(180);
    current = await state(page);
    check('点最近使用可再次取花', current.placement?.assetId === 'tulip-pink', current.placement);
    await page.screenshot({ path: `${OUT}/b-shelf-recent.png` });
    await page.evaluate(() => window.__bouquetDebug.store.setPlacement(null));

    // ==================== C. 知识内容自检（32 花型 · 三节 · 来源） ====================
    const audit = await page.evaluate(() => {
      const api = window.__bouquetKnowledge;
      if (!api?.families) return { error: '没有知识调试入口' };
      const families = api.families();
      const catalogFamilies = window.__bouquetDebug.getState().catalog.families.map((item) => item.family);
      const entries = families.map((family) => {
        const entry = api.entry(family);
        return {
          family,
          identify: Boolean(entry?.identify?.trim()),
          meaning: Boolean(entry?.meaning?.trim()),
          pairing: entry?.pairing?.length ?? 0,
          care: entry?.care?.length ?? 0,
          sources: entry?.sources?.length ?? 0,
          unverified: entry?.unverified === true,
          urls: (entry?.sources ?? []).map((source) => source.url),
          checked: (entry?.sources ?? []).map((source) => source.checkedAt),
        };
      });
      return { families, catalogFamilies, entries };
    });
    check('知识内容覆盖全部 32 花型', audit.families?.length === 32 && audit.catalogFamilies?.every((family) => audit.families.includes(family)), {
      knowledge: audit.families?.length,
      missing: audit.catalogFamilies?.filter((family) => !audit.families?.includes(family)),
    });
    check(
      '每条都有「认识它 / 怎么搭 / 照顾它」三节内容',
      audit.entries?.every((entry) => entry.identify && entry.meaning && entry.pairing >= 1 && entry.care >= 2),
      audit.entries?.filter((entry) => !(entry.identify && entry.meaning && entry.pairing >= 1 && entry.care >= 2)),
    );
    check(
      '搭配 1–2 条、养护 2–3 条（不堆百科）',
      audit.entries?.every((entry) => entry.pairing <= 2 && entry.care <= 3),
      audit.entries?.filter((entry) => entry.pairing > 2 || entry.care > 3),
    );
    check(
      '每条都有来源或明确 unverified',
      audit.entries?.every((entry) => entry.sources > 0 || entry.unverified),
      audit.entries?.filter((entry) => entry.sources === 0 && !entry.unverified),
    );
    check(
      '来源都是实际核对过的维基条目（2026-11-10）',
      audit.entries?.every(
        (entry) =>
          entry.sources === 0 ||
          (entry.urls.every((url) => typeof url === 'string' && url.startsWith('https://en.wikipedia.org/wiki/')) &&
            entry.checked.every((date) => date === '2026-11-10')),
      ),
      audit.entries?.filter(
        (entry) =>
          entry.sources > 0 &&
          !(
            entry.urls.every((url) => typeof url === 'string' && url.startsWith('https://en.wikipedia.org/wiki/')) &&
            entry.checked.every((date) => date === '2026-11-10')
          ),
      ),
    );
    const unverifiedCount = audit.entries?.filter((entry) => entry.unverified).length ?? -1;
    check('有来源的条目不为空（unverified 数 0，属于已核对来源）', unverifiedCount === 0, unverifiedCount);

    // 打开「绣球」知识卡：三节渲染 + 真实模型（2026-11-10 起不再标占位模型）+ 模型示意图 + 来源可展开
    await page.getByTestId('shelf-card-hydrangea').scrollIntoViewIfNeeded();
    await page.getByTestId('shelf-know-hydrangea').click();
    await page.waitForTimeout(260);
    const hydrangeaCard = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="knowledge-card"]');
      if (!card) return null;
      return {
        name: card.querySelector('[data-testid="knowledge-name"]')?.textContent ?? '',
        meta: card.querySelector('[data-testid="knowledge-meta"]')?.textContent ?? '',
        phase: card.getAttribute('data-phase'),
        identify: Boolean(card.querySelector('[data-testid="knowledge-section-identify"]')),
        pairing: Boolean(card.querySelector('[data-testid="knowledge-section-pairing"]')),
        care: Boolean(card.querySelector('[data-testid="knowledge-section-care"]')),
        imageNote: card.querySelector('[data-testid="knowledge-image-note"]')?.textContent ?? '',
        sources: Boolean(card.querySelector('[data-testid="knowledge-sources"]')),
      };
    });
    check('绣球知识卡打开且三节齐全', Boolean(hydrangeaCard) && hydrangeaCard.identify && hydrangeaCard.pairing && hydrangeaCard.care, hydrangeaCard);
    check('绣球卡片不再注明「占位模型」', !hydrangeaCard?.meta.includes('占位模型'), hydrangeaCard?.meta);
    check('图片标注为模型示意图（不是实拍）', hydrangeaCard?.imageNote.includes('模型示意'), hydrangeaCard?.imageNote);
    await page.locator('[data-testid="knowledge-sources"] summary').click();
    const sourceLinks = await page.locator('[data-testid="knowledge-sources"] a').count();
    check('来源默认收起、可展开且带真实链接', sourceLinks > 0, sourceLinks);
    check('绣球知识卡已固定（了解入口直接固定）', hydrangeaCard?.phase === 'pinned', hydrangeaCard?.phase);
    await page.screenshot({ path: `${OUT}/c-knowledge-hydrangea.png` });
    await page.getByTestId('knowledge-close').click();
    await page.waitForTimeout(200);
    check('关闭按钮可关闭浮窗', (await page.locator('[data-testid="knowledge-card"]').count()) === 0);

    // 没有收录来源的花材：必须明确写 unverified，而不是假装有来源。
    await page.evaluate(() => window.__bouquetKnowledge.open('__未收录花材__'));
    await page.waitForTimeout(260);
    const unknownEntry = await page.evaluate(() => ({
      open: Boolean(document.querySelector('[data-testid="knowledge-card"]')),
      hasNoFigure: Boolean(document.querySelector('.knowledge-figure-empty')),
    }));
    await page.locator('[data-testid="knowledge-sources"] summary').click();
    const unverifiedShown = await page.locator('[data-testid="knowledge-unverified"]').count();
    check(
      '未收录花材明确标 unverified（不编造来源）',
      unknownEntry.open && unknownEntry.hasNoFigure && unverifiedShown === 1,
      { ...unknownEntry, unverifiedShown },
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check('知识内容自检无脚本异常', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ==================== D. 知识浮窗交互状态（桌面） ====================
  {
    const { page, pageErrors } = await openPage(ctxDesktop, { clear: true });
    await hideCoach(page);
    // 先放一枝并选中：用于验证打开/关闭浮窗不改选中、相机与作品（计划 §4）。
    await page.evaluate(() => {
      const store = window.__bouquetDebug.store;
      store.setPlacement('rose-pink');
      store.placeStem({ tilt: 10, direction: 0, spin: 0 });
      store.setPlacement(null);
    });
    await page.waitForTimeout(700);
    const baseline = await page.evaluate(() => {
      const debug = window.__bouquetDebug;
      const state = debug.getState();
      const stem = state.doc.stems[0];
      if (stem) debug.select(stem.id);
      const next = debug.getState();
      return {
        camera: debug.getSceneState().camera,
        selectedId: next.selectedId,
        doc: JSON.stringify(next.doc),
      };
    });
    const rose = await page.getByTestId('shelf-card-rose').boundingBox();
    await page.mouse.move(rose.x + rose.width / 2, rose.y + rose.height / 2);
    await page.waitForTimeout(140);
    check('悬停 <300ms 不出现浮窗', (await page.locator('[data-testid="knowledge-card"]').count()) === 0);
    await page.waitForTimeout(300);
    let cardPhase = await page.locator('[data-testid="knowledge-card"]').getAttribute('data-phase');
    check('悬停约 300ms 出现预览', (await page.locator('[data-testid="knowledge-card"]').count()) === 1 && cardPhase === 'preview', cardPhase);
    check('预览内容是悬停的那张卡（玫瑰）', (await page.getByTestId('knowledge-name').innerText()) === '玫瑰');
    await page.screenshot({ path: `${OUT}/d-knowledge-preview.png` });

    // 满 2 秒固定
    await page.waitForTimeout(1750);
    cardPhase = await page.locator('[data-testid="knowledge-card"]').getAttribute('data-phase');
    check('同一张卡连续悬停满 2 秒固定', cardPhase === 'pinned', cardPhase);
    const pinnedFamily = await page.evaluate(() => window.__bouquetKnowledge.family());
    check('固定后仍显示玫瑰', pinnedFamily === 'rose', pinnedFamily);
    await page.screenshot({ path: `${OUT}/d-knowledge-pinned.png` });

    // 固定后经过其他花材不换内容
    const tulip = await page.getByTestId('shelf-card-tulip').boundingBox();
    await page.mouse.move(tulip.x + tulip.width / 2, tulip.y + tulip.height / 2);
    await page.waitForTimeout(450);
    check(
      '固定后经过其他花材不自动换内容',
      (await page.evaluate(() => window.__bouquetKnowledge.family())) === 'rose' &&
        (await page.getByTestId('knowledge-name').innerText()) === '玫瑰',
    );

    // 移入浮窗阅读：不关闭
    const cardBox = await page.getByTestId('knowledge-card').boundingBox();
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + 200);
    await page.waitForTimeout(220);
    check('固定后可以移入浮窗（不关闭）', (await page.locator('[data-testid="knowledge-card"]').count()) === 1);
    await page.locator('[data-testid="knowledge-scroll"]').click();
    check('浮窗内点击不关闭', (await page.locator('[data-testid="knowledge-card"]').count()) === 1);
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(200);
    const scrolled = await page.evaluate(() => document.querySelector('[data-testid="knowledge-scroll"]')?.scrollTop ?? 0);
    check('浮窗内滚动不关闭且内容可滚动', (await page.locator('[data-testid="knowledge-card"]').count()) === 1 && scrolled > 0, scrolled);

    // 打开浮窗不改变作品 / 选中 / 相机（计划 §4：打开前的状态保留）
    const whileOpen = await page.evaluate(() => {
      const debug = window.__bouquetDebug;
      const state = debug.getState();
      return {
        camera: debug.getSceneState().camera,
        selectedId: state.selectedId,
        doc: JSON.stringify(state.doc),
        cardOpen: Boolean(document.querySelector('[data-testid="knowledge-card"]')),
      };
    });
    check(
      '浮窗打开期间不改选中、相机与作品',
      whileOpen.cardOpen &&
        JSON.stringify(whileOpen.camera) === JSON.stringify(baseline.camera) &&
        whileOpen.selectedId === baseline.selectedId &&
        whileOpen.doc === baseline.doc,
      {
        cardOpen: whileOpen.cardOpen,
        cameraSame: JSON.stringify(whileOpen.camera) === JSON.stringify(baseline.camera),
        selectedSame: whileOpen.selectedId === baseline.selectedId,
        docSame: whileOpen.doc === baseline.doc,
      },
    );

    // 外部空白点击：只关闭，不穿透三维操作（放置态保留、不加花）
    await page.evaluate(() => window.__bouquetDebug.store.setPlacement('rose-pink'));
    const stemsBefore = (await state(page)).doc.stems.length;
    const canvas = await canvasPoint(page);
    await page.mouse.click(canvas.x, canvas.y);
    await page.waitForTimeout(320);
    const afterOutside = await state(page);
    check('点浮窗外空白处关闭浮窗', (await page.locator('[data-testid="knowledge-card"]').count()) === 0);
    check(
      '空白点击不穿透三维操作（没有落花、放置态保留）',
      afterOutside.doc.stems.length === stemsBefore && afterOutside.placement?.assetId === 'rose-pink',
      { stems: afterOutside.doc.stems.length, placement: afterOutside.placement },
    );
    await page.evaluate(() => window.__bouquetDebug.store.setPlacement(null));

    // Esc 关闭
    await page.evaluate(() => window.__bouquetKnowledge.open('tulip'));
    await page.waitForTimeout(220);
    check('programmatic 打开后可见', (await page.locator('[data-testid="knowledge-card"]').count()) === 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(220);
    check('Esc 关闭浮窗', (await page.locator('[data-testid="knowledge-card"]').count()) === 0);

    // 未满 2 秒移开消失
    await page.mouse.move(rose.x + rose.width / 2, rose.y + rose.height / 2);
    await page.waitForTimeout(500);
    check('再次悬停出现预览', (await page.locator('[data-testid="knowledge-card"]').count()) === 1);
    await page.mouse.move(700, 260);
    await page.waitForTimeout(200);
    check('未满 2 秒移开则消失', (await page.locator('[data-testid="knowledge-card"]').count()) === 0);

    // 快速经过其他花材重置计时：玫瑰预览 → 移到郁金香 → 约 300ms 后显示郁金香
    await page.mouse.move(rose.x + rose.width / 2, rose.y + rose.height / 2);
    await page.waitForTimeout(380);
    check('玫瑰预览出现', (await page.getByTestId('knowledge-name').innerText()) === '玫瑰');
    await page.mouse.move(tulip.x + tulip.width / 2, tulip.y + tulip.height / 2);
    await page.waitForTimeout(120);
    const duringSwitch = await page.locator('[data-testid="knowledge-card"]').count();
    await page.waitForTimeout(320);
    const switchName = await page.getByTestId('knowledge-name').innerText();
    check(
      '快速经过其他花材会重置计时并换成新卡',
      duringSwitch === 0 && switchName === '郁金香',
      { duringSwitch, switchName },
    );
    await page.mouse.move(700, 260);
    await page.waitForTimeout(200);

    // 开始拖取立即取消预览
    await page.mouse.move(rose.x + rose.width / 2, rose.y + rose.height / 2);
    await page.waitForTimeout(420);
    check('拖取前预览已出现', (await page.locator('[data-testid="knowledge-card"]').count()) === 1);
    await page.mouse.down();
    await page.mouse.move(rose.x + rose.width / 2 + 22, rose.y + rose.height / 2 + 22, { steps: 3 });
    await page.waitForTimeout(160);
    check('开始拖取立即取消预览与计时', (await page.locator('[data-testid="knowledge-card"]').count()) === 0);
    await page.mouse.up();
    await page.waitForTimeout(220);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__bouquetDebug.store.setPlacement(null));

    // 键盘进入 / 退出 + 焦点返回
    await page.getByTestId('shelf-know-rose').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(260);
    const kb = await page.evaluate(() => ({
      open: Boolean(document.querySelector('[data-testid="knowledge-card"]')),
      inside: Boolean(document.querySelector('[data-testid="knowledge-card"]')?.contains(document.activeElement)),
      active: document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.className ?? '',
    }));
    check('键盘「了解」可进入浮窗且焦点进入', kb.open && kb.inside, kb);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(260);
    const focusBack = await page.evaluate(() => ({
      closed: !document.querySelector('[data-testid="knowledge-card"]'),
      testid: document.activeElement?.getAttribute('data-testid') ?? '',
    }));
    check('Esc 退出且焦点回到触发入口', focusBack.closed && focusBack.testid === 'shelf-know-rose', focusBack);
    await page.screenshot({ path: `${OUT}/d-knowledge-focus-back.png` });

    // 点另一张花材：先关浮窗，再照常执行取花点击
    await page.evaluate(() => window.__bouquetKnowledge.open('rose'));
    await page.waitForTimeout(240);
    check('先打开玫瑰知识卡（准备点另一张花材）', (await page.locator('[data-testid="knowledge-card"]').count()) === 1);
    await page.getByTestId('palette-tulip').click();
    await page.waitForTimeout(320);
    const afterOtherFlower = await state(page);
    check(
      '点另一张花材先关浮窗、再照常取花',
      (await page.locator('[data-testid="knowledge-card"]').count()) === 0 &&
        afterOtherFlower.placement?.assetId === 'tulip-pink',
      { placement: afterOtherFlower.placement, card: await page.locator('[data-testid="knowledge-card"]').count() },
    );
    await page.evaluate(() => window.__bouquetDebug.store.setPlacement(null));

    // 刷新后浮窗不残留（本页已放了一枝，刷新会先到开始页）
    await page.reload();
    await page.waitForTimeout(1300);
    const resumed = await enterWorkbench(page);
    if (!resumed) {
      await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, {
        timeout: 90000,
      });
    }
    await page.waitForTimeout(800);
    check('刷新后浮窗状态不残留', (await page.locator('[data-testid="knowledge-card"]').count()) === 0);
    check('浮窗流程无脚本异常', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ==================== E. 新手引导四步 / 跳过 / 重看 / 刷新 / 老用户 ====================
  {
    const { page, pageErrors } = await openPage(ctxDesktop, { clear: true });
    const boot = await page.evaluate(() => ({
      coach: Boolean(document.querySelector('[data-testid="onboarding-coach"]')),
      step: document.querySelector('[data-testid="onboarding-coach"]')?.getAttribute('data-step') ?? '',
      progress: document.querySelector('[data-testid="onboarding-progress"]')?.textContent ?? '',
      purpose: document.querySelector('[data-testid="onboarding-purpose"]')?.textContent ?? '',
      candidates: document.querySelectorAll('.coach-candidate').length,
      coachCards: document.querySelectorAll('.shelf-card.is-coach').length,
      htmlClass: document.documentElement.classList.contains('onboarding-active'),
      emptyGuideVisible: (() => {
        const el = document.querySelector('.empty-guide.first-flower-hint');
        if (!el) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      })(),
      record: localStorage.getItem('bouquet-workbench.onboarding.v1'),
    }));
    check('新玩家首次进入出现引导第 1 步', boot.coach && boot.step === 'flower', boot);
    check('第 1 步讲清主花用途', boot.purpose.includes('主花'), boot.purpose);
    check('第 1 步有 3 个可点击候选且花材架高亮', boot.candidates === 3 && boot.coachCards === 3, boot);
    check('与 EmptyGuide 既有提示不重复（引导期间隐藏）', !boot.emptyGuideVisible, boot.emptyGuideVisible);
    check('引导未开始前不写完成记录', boot.record === null, boot.record);
    // 引导卡片不能吃三维操作：画布中央底部这一点必须仍然是 canvas（iteration5 切线点击回归）。
    const hitAtCanvasBottom = await page.evaluate(() => {
      const el = document.elementFromPoint(665, 629);
      if (!el) return 'none';
      return `${el.tagName}${el.closest('[data-testid="onboarding-coach"]') ? '·coach' : ''}`;
    });
    check('1366×768 画布中央底部 (665,629) 不被引导卡片挡住', hitAtCanvasBottom === 'CANVAS', hitAtCanvasBottom);
    await page.screenshot({ path: `${OUT}/e-onboarding-step1.png` });

    // 点候选只进入取花，不直接加花
    await page.getByTestId('onboarding-candidate-rose').click();
    await page.waitForTimeout(250);
    let current = await state(page);
    check(
      '点候选沿用正常取花逻辑（进入放置态、作品仍为空）',
      current.placement?.assetId === 'rose-pink' && current.doc.stems.length === 0,
      { placement: current.placement, stems: current.doc.stems.length },
    );
    check('取花提示出现', (await page.getByTestId('onboarding-picked').count()) === 1);

    const canvas = await canvasPoint(page);
    await page.mouse.click(canvas.x, canvas.y);
    await page.waitForTimeout(500);
    current = await state(page);
    const step2 = await page.evaluate(() => ({
      step: document.querySelector('[data-testid="onboarding-coach"]')?.getAttribute('data-step') ?? '',
      purpose: document.querySelector('[data-testid="onboarding-purpose"]')?.textContent ?? '',
      coachCards: [...document.querySelectorAll('.shelf-card.is-coach')].map((el) => el.getAttribute('data-family')),
    }));
    check('放下一枝后进入第 2 步', current.doc.stems.length === 1 && step2.step === 'companion', { stems: current.doc.stems.length, step2 });
    check('第 2 步讲清配花用途', step2.purpose.includes('配花'), step2.purpose);
    check('第 2 步高亮配花候选', step2.coachCards.includes('spray-chrysanthemum') && step2.coachCards.includes('babys-breath'), step2.coachCards);
    await page.screenshot({ path: `${OUT}/e-onboarding-step2.png` });

    // 第 2 步：点候选 → 放花 → 第 3 步
    await page.getByTestId('onboarding-candidate-spray-chrysanthemum').click();
    await page.waitForTimeout(240);
    const canvas2 = await canvasPoint(page);
    await page.mouse.click(canvas2.x + 20, canvas2.y - 30);
    await page.waitForTimeout(480);
    const step3 = await page.evaluate(() => ({
      step: document.querySelector('[data-testid="onboarding-coach"]')?.getAttribute('data-step') ?? '',
      purpose: document.querySelector('[data-testid="onboarding-purpose"]')?.textContent ?? '',
    }));
    check('第 3 步出现并讲清叶材用途', step3.step === 'greenery' && step3.purpose.includes('叶材'), step3);

    // 第 3 步：叶材 → 第 4 步（自由调整）
    await page.getByTestId('onboarding-candidate-eucalyptus').click();
    await page.waitForTimeout(240);
    const canvas3 = await canvasPoint(page);
    await page.mouse.click(canvas3.x - 24, canvas3.y + 26);
    await page.waitForTimeout(480);
    const step4 = await page.evaluate(() => ({
      step: document.querySelector('[data-testid="onboarding-coach"]')?.getAttribute('data-step') ?? '',
      finish: Boolean(document.querySelector('[data-testid="onboarding-finish"]')),
      line: document.querySelector('[data-testid="onboarding-line"]')?.textContent ?? '',
    }));
    check('第 4 步出现且说明没有唯一配方', step4.step === 'free' && step4.finish && step4.line.includes('没有固定'), step4);
    await page.screenshot({ path: `${OUT}/e-onboarding-step4.png` });

    // 修剪模式（切线）时引导必须让开画面：iteration5 曾经因为卡片盖住切线而失败。
    await page.evaluate(() => window.__bouquetDebug.store.setTrimMode(true));
    await page.waitForTimeout(260);
    check('进入修剪模式后引导浮层让开画面', (await page.locator('[data-testid="onboarding-coach"]').count()) === 0);
    await page.evaluate(() => window.__bouquetDebug.store.setTrimMode(false));
    await page.waitForTimeout(260);
    check('退出修剪模式后引导回到第 4 步', (await page.locator('[data-testid="onboarding-coach"]').count()) === 1);

    // 用真实鼠标点「完成」：按钮点击后浮层会立即卸载，避免 locator 重试误判。
    const finishBox = await page.getByTestId('onboarding-finish').boundingBox();
    await page.mouse.click(finishBox.x + finishBox.width / 2, finishBox.y + finishBox.height / 2);
    await page.waitForTimeout(320);
    const finished = await page.evaluate(() => ({
      gone: !document.querySelector('[data-testid="onboarding-coach"]'),
      record: JSON.parse(localStorage.getItem('bouquet-workbench.onboarding.v1') ?? 'null'),
    }));
    check('点完成收起引导并记录', finished.gone && finished.record?.done === true, finished);

    // 刷新：有作品 → 开始页 → 继续；引导不重复
    await page.reload();
    await page.waitForTimeout(1400);
    const started = await enterWorkbench(page);
    check('有作品刷新后进入开始页（继续上次花束）', started, started);
    check('刷新后引导不重复出现', (await page.locator('[data-testid="onboarding-coach"]').count()) === 0);

    // 帮助入口重看
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('bouquet:onboarding-replay')));
    await page.waitForTimeout(300);
    const replay = await page.evaluate(() => ({
      coach: Boolean(document.querySelector('[data-testid="onboarding-coach"]')),
      step: document.querySelector('[data-testid="onboarding-coach"]')?.getAttribute('data-step') ?? '',
    }));
    check('帮助入口事件可重看引导（回到第 1 步）', replay.coach && replay.step === 'flower', replay);
    await page.getByTestId('onboarding-skip').click();
    await page.waitForTimeout(240);
    const skipped = await page.evaluate(() => ({
      gone: !document.querySelector('[data-testid="onboarding-coach"]'),
      record: JSON.parse(localStorage.getItem('bouquet-workbench.onboarding.v1') ?? 'null'),
    }));
    check('可跳过引导并记录 skipped', skipped.gone && skipped.record?.skipped === true, skipped);

    // ==== 老用户：本机已有作品，刷新后不强制重教 ====
    await page.evaluate(() => {
      localStorage.removeItem('bouquet-workbench.onboarding.v1');
      const store = window.__bouquetDebug.store;
      store.setPlacement('rose-pink');
      store.placeStem({ tilt: 8, direction: 20, spin: 0 });
      store.setPlacement(null);
    });
    await page.waitForTimeout(900);
    const persisted = await page.evaluate(() => {
      try {
        const raw = JSON.parse(localStorage.getItem('bouquet-workbench.v1') ?? 'null');
        return raw?.stems?.length ?? 0;
      } catch {
        return -1;
      }
    });
    check('本机已保存作品（老用户前置条件）', persisted > 0, persisted);
    await page.reload();
    await page.waitForTimeout(1500);
    await enterWorkbench(page);
    await page.waitForTimeout(700);
    const oldUser = await page.evaluate(() => ({
      coach: Boolean(document.querySelector('[data-testid="onboarding-coach"]')),
      hasStems: window.__bouquetDebug.getState().doc.stems.length > 0,
    }));
    check('老用户（本机已有作品）不被强制重新教学', oldUser.hasStems && !oldUser.coach, oldUser);
    await page.screenshot({ path: `${OUT}/e-onboarding-old-user.png` });
    check('引导流程无脚本异常', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ==================== F. 391px 窄屏 ====================
  {
    const { page, pageErrors } = await openPage(ctxNarrow, { clear: true, viewport: { width: 391, height: 844 } });
    const narrow = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="palette-panel"]');
      const panelRect = panel?.getBoundingClientRect();
      const cards = [...document.querySelectorAll('.shelf-card')];
      const know = [...document.querySelectorAll('.shelf-know')];
      return {
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        coach: Boolean(document.querySelector('[data-testid="onboarding-coach"]')),
        coachVisible: (() => {
          const el = document.querySelector('[data-testid="onboarding-coach"]');
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= window.innerWidth + 1;
        })(),
        cardOverflow: cards.some((card) => {
          const rect = card.getBoundingClientRect();
          return panelRect ? rect.right > panelRect.right + 1 : false;
        }),
        knowCount: know.length,
        knowVisible: know.slice(0, 4).every((btn) => getComputedStyle(btn).opacity === '1'),
      };
    });
    check('391px 无横向溢出', narrow.scrollWidth <= narrow.innerWidth && narrow.bodyScrollWidth <= narrow.innerWidth, {
      innerWidth: narrow.innerWidth,
      scrollWidth: narrow.scrollWidth,
      bodyScrollWidth: narrow.bodyScrollWidth,
    });
    check('391px 卡片不超出面板且两列保持', !narrow.cardOverflow);
    check('391px 引导浮层在视口内', narrow.coach && narrow.coachVisible, narrow);
    check('391px 每张卡都有「了解」入口', narrow.knowCount === 32 && narrow.knowVisible, narrow);
    await page.screenshot({ path: `${OUT}/f-narrow-shelf.png` });

    await hideCoach(page);
    await page.getByTestId('shelf-card-hydrangea').scrollIntoViewIfNeeded();
    await page.waitForTimeout(220);
    await page.getByTestId('shelf-know-hydrangea').click({ force: true });
    await page.waitForTimeout(320);
    const narrowCard = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="knowledge-card"]');
      if (!card) return null;
      const rect = card.getBoundingClientRect();
      return {
        phase: card.getAttribute('data-phase'),
        name: card.querySelector('[data-testid="knowledge-name"]')?.textContent ?? '',
        withinViewport: rect.left >= 0 && rect.right <= window.innerWidth + 1 && rect.top >= 0 && rect.bottom <= window.innerHeight + 1,
        width: Math.round(rect.width),
      };
    });
    check('窄屏「了解」可打开知识浮窗', Boolean(narrowCard) && narrowCard.phase === 'pinned', narrowCard);
    check('窄屏浮窗内容正确且在视口内', narrowCard?.name === '绣球' && narrowCard.withinViewport, narrowCard);
    await page.screenshot({ path: `${OUT}/f-narrow-knowledge.png` });
    await page.getByTestId('knowledge-close').click();
    await page.waitForTimeout(220);
    check('窄屏关闭按钮可关闭', (await page.locator('[data-testid="knowledge-card"]').count()) === 0);
    const stillNoOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    check('窄屏打开关闭浮窗后仍无横向溢出', stillNoOverflow);
    check('窄屏流程无脚本异常', pageErrors.length === 0, pageErrors);
    await page.close();
  }
} catch (error) {
  failed += 1;
  console.log('FAIL 脚本异常', error?.stack ?? error?.message ?? error);
} finally {
  await ctxDesktop.close();
  await ctxNarrow.close();
  await browser.close();
}

writeFileSync(`${OUT}/results.json`, JSON.stringify({ passed, failed, results }, null, 2));
console.log(`\n=== v16-catalog：通过 ${passed} / 失败 ${failed} ===`);
if (failed > 0) process.exitCode = 1;
