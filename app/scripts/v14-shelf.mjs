/**
 * v14 花材架提效验证。
 *
 * 覆盖：
 * 1) 两列紧凑卡片：1366×768 一屏可见 ≥ 8 种花，缩略图真实加载；
 * 2) 名称搜索、色系筛选、两者与分类叠加、清空筛选；
 * 3) 颜色色点只在选中花材后展开，点卡片进入放置模式，颜色点可换色；
 * 4) 最近使用：localStorage 记录 / 顺序 / 刷新后保留 / 可清除；
 * 5) 按住拖到画布仍保留放置态；放满 20 枝提示仍在；
 * 6) 「挑选花材 / 已有花枝」标签切换与收起把手；
 * 7) 委托模式：commissionWishes(c1/c2/c3) 命中花材加「心愿」标记 + 顶部说明；
 * 8) 391px 窄屏无横向溢出。
 *
 * 运行：先确保 http://127.0.0.1:5173 已在跑，再 `node scripts/v14-shelf.mjs`。
 * 环境变量：SMOKE_URL、v14_SHELF_OUT。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.v14_SHELF_OUT ?? '.verify/v14-shelf';
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

/** 打开工作台，等真实清单就绪；clear=true 时先清 localStorage 再重载。 */
async function openPage(context, { clear = false, viewport } = {}) {
  const page = await context.newPage();
  if (viewport) await page.setViewportSize(viewport);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(URL);
  if (clear) {
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  }
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, {
    timeout: 90000,
  });
  await page.waitForTimeout(900);
  return { page, pageErrors };
}

async function cardCount(page) {
  return page.locator('.shelf-card').count();
}

async function waitCards(page, count, timeout = 5000) {
  await page
    .waitForFunction((expected) => document.querySelectorAll('.shelf-card').length === expected, count, {
      timeout,
    })
    .catch(() => {});
  return cardCount(page);
}

async function state(page) {
  return page.evaluate(() => window.__bouquetDebug.getState());
}

const ctxDesktop = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const ctxNarrow = await browser.newContext({ viewport: { width: 391, height: 844 } });

try {
  // ==================== 桌面：布局 / 搜索 / 色系 / 颜色 / 最近 / 拖拽 / 满枝 ====================
  {
    const { page, pageErrors } = await openPage(ctxDesktop, { clear: true });
    const initialState = await state(page);
    // V16 起目录随新花型增加（32 花型 / 57 配色）；这里只断言「清单完整加载」，
    // 不锁死具体数字，避免每加一种花就要改这份回归脚本。
    const totalFamilies = initialState.catalog.families.length;
    const totalEntries = initialState.catalog.entries.length;
    check('目录清单就绪（manifest）', initialState.catalogStatus === 'manifest', initialState.catalogStatus);
    check(
      '花材清单完整加载（≥30 花型 / ≥53 配色，且花架卡片数与目录一致）',
      totalFamilies >= 30 &&
        totalEntries >= 53 &&
        totalEntries >= totalFamilies &&
        (await cardCount(page)) === totalFamilies,
      { families: totalFamilies, entries: totalEntries, cards: await cardCount(page) },
    );

    // ---------- 1. 两列 + 一屏 8 种以上 ----------
    const layout = await page.evaluate(() => {
      const grid = document.querySelector('.shelf-grid');
      const scroll = document.querySelector('.shelf-scroll');
      const cards = [...document.querySelectorAll('.shelf-card')];
      const bottom = scroll?.getBoundingClientRect().bottom ?? 0;
      const thumbs = [...document.querySelectorAll('.shelf-thumb img')];
      return {
        columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
        visible: cards.filter((card) => card.getBoundingClientRect().bottom <= bottom + 2).length,
        total: cards.length,
        thumbOk: thumbs.slice(0, 6).filter((img) => img.complete && img.naturalWidth > 0).length,
        thumbTotal: Math.min(6, thumbs.length),
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    check('花材架为两列网格', layout.columns === 2, layout.columns);
    check('1366×768 一屏可见 ≥ 8 种花材', layout.visible >= 8, { visible: layout.visible, total: layout.total });
    check('缩略图真实加载', layout.thumbOk === layout.thumbTotal && layout.thumbTotal > 0, layout);
    check('页面无横向溢出', !layout.horizontalOverflow);
    await page.screenshot({ path: `${OUT}/shelf-default.png` });

    // ---------- 2. 名称搜索 ----------
    await page.getByTestId('shelf-search').fill('玫瑰');
    const searchCount = await waitCards(page, 2);
    const searchNames = await page.locator('.shelf-card .shelf-name').allInnerTexts();
    check('搜索“玫瑰”过滤到玫瑰 / 多头玫瑰 2 种', searchCount === 2 && searchNames.join(',') === '玫瑰,多头玫瑰', {
      searchCount,
      searchNames,
    });
    check(
      '搜索后计数更新',
      (await page.getByTestId('shelf-count').innerText()) === `2/${totalFamilies}`,
      await page.getByTestId('shelf-count').innerText(),
    );
    await page.screenshot({ path: `${OUT}/shelf-search.png` });

    await page.getByTestId('shelf-search').fill('没有这种花');
    await waitCards(page, 0);
    check('搜索无结果时出现空状态', (await page.locator('[data-testid="shelf-empty"]').count()) === 1);
    await page.getByTestId('shelf-search-clear').click();
    check('清空搜索恢复全部花型', (await waitCards(page, totalFamilies)) === totalFamilies);

    // ---------- 3. 色系筛选 ----------
    await page.getByTestId('shelf-color-pink').click();
    const pinkCount = await cardCount(page);
    const pinkHasRose = await page.locator('[data-testid="shelf-card-rose"]').count();
    const pinkHasEucalyptus = await page.locator('[data-testid="shelf-card-eucalyptus"]').count();
    check('色系筛选“粉”缩小结果集', pinkCount > 0 && pinkCount < totalFamilies, pinkCount);
    check('粉筛选保留玫瑰、排除纯绿叶尤加利', pinkHasRose === 1 && pinkHasEucalyptus === 0, {
      pinkHasRose,
      pinkHasEucalyptus,
    });
    await page.screenshot({ path: `${OUT}/shelf-color.png` });
    await page.getByTestId('shelf-color-all').click();
    check('取消色系筛选恢复全部花型', (await waitCards(page, totalFamilies)) === totalFamilies);

    // ---------- 4. 颜色只在选中后展开 ----------
    check(
      '未选中时玫瑰没有颜色点',
      (await page.locator('[data-testid="palette-rose-pink"]').count()) === 0 &&
        (await page.locator('[data-testid="shelf-variants-rose"]').count()) === 0,
    );
    await page.getByTestId('palette-rose').click();
    await page.waitForSelector('[data-testid="shelf-variants-rose"]', { timeout: 5000 });
    let current = await state(page);
    check('点卡片进入放置模式（rose-pink）', current.placement?.assetId === 'rose-pink', current.placement);
    check(
      '选中后展开 3 个颜色点',
      (await page.locator('[data-testid="shelf-variants-rose"] .variant-dot').count()) === 3,
    );
    await page.screenshot({ path: `${OUT}/shelf-selected.png` });

    await page.getByTestId('palette-tulip').click();
    check(
      '换选其他花材后颜色点跟着换，不再同时展开',
      (await page.locator('[data-testid="shelf-variants-rose"]').count()) === 0 &&
        (await page.locator('[data-testid="shelf-variants-tulip"]').count()) === 1,
    );
    await page.getByTestId('palette-tulip-cream').click();
    current = await state(page);
    check('点颜色点换色并进入放置（tulip-cream）', current.placement?.assetId === 'tulip-cream', current.placement);

    // ---------- 5. 最近使用 ----------
    const recent = await page.evaluate(() => ({
      row: Boolean(document.querySelector('[data-testid="shelf-recent"]')),
      ids: [...document.querySelectorAll('[data-testid="shelf-recent-chip"]')].map((el) =>
        el.getAttribute('data-asset-id'),
      ),
      stored: JSON.parse(localStorage.getItem('bouquet.shelf-recent') ?? '[]'),
    }));
    check('最近使用行出现', recent.row);
    check('最近顺序：最新在前', recent.ids[0] === 'tulip-cream' && recent.ids.includes('rose-pink'), recent.ids);
    check('localStorage 已记录最近使用', Array.isArray(recent.stored) && recent.stored[0] === 'tulip-cream', recent.stored);
    await page.screenshot({ path: `${OUT}/shelf-recent.png` });

    // 点最近使用的花材可以直接再取一次，并把它顶到最前
    await page.locator('[data-testid="shelf-recent-chip"][data-asset-id="rose-pink"]').click();
    current = await state(page);
    const idsAfterClick = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="shelf-recent-chip"]')].map((el) => el.getAttribute('data-asset-id')),
    );
    check(
      '点最近使用可再次取花并置顶',
      current.placement?.assetId === 'rose-pink' && idsAfterClick[0] === 'rose-pink',
      { placement: current.placement, idsAfterClick },
    );

    // 刷新后仍保留
    await page.reload();
    await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, {
      timeout: 90000,
    });
    await page.waitForTimeout(700);
    const afterReload = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="shelf-recent-chip"]')].map((el) => el.getAttribute('data-asset-id')),
    );
    check('刷新后最近使用仍保留', afterReload[0] === 'rose-pink', afterReload);
    await page.getByTestId('shelf-recent-clear').click();
    await page.waitForTimeout(250);
    const cleared = await page.evaluate(() => ({
      row: Boolean(document.querySelector('[data-testid="shelf-recent"]')),
      stored: localStorage.getItem('bouquet.shelf-recent'),
    }));
    check('最近使用可清除', !cleared.row && cleared.stored === '[]', cleared);

    // ---------- 6. 按住拖动仍进入放置模式 ----------
    await page.mouse.move(0, 0);
    const card = await page.getByTestId('palette-eucalyptus').boundingBox();
    const drop = await page.evaluate(() => {
      const candidates = [
        [820, 640],
        [700, 560],
        [1050, 560],
        [760, 700],
      ];
      for (const [x, y] of candidates) {
        const el = document.elementFromPoint(x, y);
        if (el instanceof HTMLCanvasElement) return { x, y };
        const canvas = el?.closest?.('.bouquet-canvas');
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
      }
      return { x: 820, y: 640 };
    });
    await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
    await page.mouse.down();
    await page.mouse.move(card.x + card.width / 2 + 24, card.y + card.height / 2 + 24, { steps: 4 });
    const midDrag = await state(page);
    check('按住拖动卡片进入放置模式', midDrag.placement?.assetId === 'eucalyptus-green', midDrag.placement);
    await page.mouse.move(drop.x, drop.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    current = await state(page);
    check(
      '拖到画布松开直接落位成一枝（放置态随之结束）',
      current.doc.stems.length === 1 && !current.placement,
      { stems: current.doc.stems.length, placement: current.placement },
    );
    await page.keyboard.press('Escape');

    // ---------- 7. 满 20 枝提示 ----------
    await page.evaluate(() => {
      const store = window.__bouquetDebug.store;
      while (store.getState().doc.stems.length < 20) {
        store.setPlacement('rose-pink');
        store.placeStem({ tilt: 8 + Math.random() * 16, direction: Math.random() * 360, spin: 0 });
      }
      store.setPlacement(null);
    });
    await page.waitForTimeout(600);
    current = await state(page);
    check('可以放满 20 枝', current.doc.stems.length === 20, current.doc.stems.length);
    await page.getByTestId('palette-peony').click();
    await page.waitForTimeout(300);
    current = await state(page);
    const fullWarn = await page.getByTestId('shelf-full-warn').isVisible().catch(() => false);
    check('满 20 枝时提示可见且不再进入放置', fullWarn && !current.placement, {
      fullWarn,
      placement: current.placement,
    });
    await page.screenshot({ path: `${OUT}/shelf-full.png` });

    check('桌面流程无脚本异常', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ==================== 桌面：标签切换 / 收起 / 委托心愿 ====================
  {
    const { page, pageErrors } = await openPage(ctxDesktop, { clear: true });

    // ---------- 8. 标签切换 ----------
    const defaultView = await page.evaluate(() => ({
      palette: Boolean(document.querySelector('[data-testid="palette-panel"]')),
      stems: Boolean(document.querySelector('[data-testid="stem-list"]')),
      paletteOn: document.querySelector('[data-testid="flower-tab-palette"]')?.getAttribute('aria-selected'),
    }));
    check(
      '默认在「挑选花材」，不同时堆叠花枝列表',
      defaultView.palette && !defaultView.stems && defaultView.paletteOn === 'true',
      defaultView,
    );
    await page.getByTestId('flower-tab-stems').click();
    await page.waitForTimeout(250);
    const stemView = await page.evaluate(() => ({
      palette: Boolean(document.querySelector('[data-testid="palette-panel"]')),
      stems: Boolean(document.querySelector('[data-testid="stem-list"]')),
      selected: document.querySelector('[data-testid="flower-tab-stems"]')?.getAttribute('aria-selected'),
    }));
    check('切到「已有花枝」后只显示花枝列表', !stemView.palette && stemView.stems && stemView.selected === 'true', stemView);
    await page.screenshot({ path: `${OUT}/shelf-tab-stems.png` });
    await page.getByTestId('flower-tab-palette').click();
    await page.waitForTimeout(250);
    check(
      '切回「挑选花材」恢复花材架',
      (await page.locator('[data-testid="palette-panel"]').count()) === 1 &&
        (await page.locator('[data-testid="stem-list"]').count()) === 0,
    );

    // 收起 / 展开把手
    await page.getByTestId('flower-panel-collapse').click();
    await page.waitForTimeout(250);
    check('收起后保留窄把手', (await page.getByTestId('flower-panel-handle').count()) === 1);
    await page.getByTestId('flower-panel-expand').click();
    await page.waitForTimeout(250);
    check('把手可重新展开面板', (await page.getByTestId('flower-panel').count()) === 1);

    // ---------- 9. 委托模式心愿标记 ----------
    const freeMarkers = await page.locator('[data-wish="1"]').count();
    check('自由模式没有心愿标记', freeMarkers === 0 && (await page.getByTestId('shelf-wish-line').count()) === 0, freeMarkers);

    await page.evaluate(() => window.__bouquetDebug.store.startCommission('c1-birthday', null));
    await page.waitForTimeout(600);
    const c1 = await page.evaluate(() => ({
      line: document.querySelector('[data-testid="shelf-wish-line"]')?.textContent ?? '',
      marked: [...document.querySelectorAll('.shelf-card[data-wish="1"]')].map((el) => el.getAttribute('data-testid')),
    }));
    check(
      'c1 委托：玫瑰 / 郁金香 / 尤加利 被标为心愿',
      ['shelf-card-rose', 'shelf-card-tulip', 'shelf-card-eucalyptus'].every((id) => c1.marked.includes(id)),
      c1.marked,
    );
    check('c1 委托：顶部一行心愿说明', c1.line.includes('委托心愿') && c1.line.includes('郁金香'), c1.line);
    check('c1 委托：未命中的花材不加标记', !c1.marked.includes('shelf-card-peony'), c1.marked);
    await page.screenshot({ path: `${OUT}/shelf-commission.png` });

    await page.evaluate(() => window.__bouquetDebug.store.startCommission('c2-new-home', null));
    await page.waitForTimeout(500);
    const c2Marked = await page.evaluate(() =>
      [...document.querySelectorAll('.shelf-card[data-wish="1"]')].map((el) => el.getAttribute('data-testid')),
    );
    check('c2 委托：只标出尤加利（family 心愿）', c2Marked.length === 1 && c2Marked[0] === 'shelf-card-eucalyptus', c2Marked);

    await page.evaluate(() => window.__bouquetDebug.store.startCommission('c3-anniversary', null));
    await page.waitForTimeout(500);
    const c3Marked = await page.evaluate(() =>
      [...document.querySelectorAll('.shelf-card[data-wish="1"]')].map((el) => el.getAttribute('data-testid')),
    );
    check(
      'c3 委托：玫瑰 / 郁金香（配色 + family 心愿）',
      c3Marked.includes('shelf-card-rose') && c3Marked.includes('shelf-card-tulip') && c3Marked.length === 2,
      c3Marked,
    );

    // c4–c6 由委托扩充任务追加；用防御式写法：不存在就跳过，存在就验证 family / kinds 命中。
    const laterCommissions = [
      {
        id: 'c4-sunflower-basket',
        label: 'c4 委托：向日葵（family）+ 整类配花（kinds）',
        mustMark: ['shelf-card-sunflower', 'shelf-card-spray-chrysanthemum'],
        mustNotMark: ['shelf-card-rose'],
      },
      {
        id: 'c5-new-home-pot',
        label: 'c5 委托：鲁斯卡斯（family）+ 主花/绿叶整类（kinds）',
        mustMark: ['shelf-card-ruscus', 'shelf-card-rose', 'shelf-card-eucalyptus'],
        mustNotMark: ['shelf-card-babys-breath'],
      },
      {
        id: 'c6-anniversary-box',
        label: 'c6 委托：玫瑰 / 郁金香（family）',
        mustMark: ['shelf-card-rose', 'shelf-card-tulip'],
        mustNotMark: ['shelf-card-daisy'],
      },
    ];
    for (const item of laterCommissions) {
      const started = await page.evaluate(
        (commissionId) => window.__bouquetDebug.store.startCommission(commissionId, null),
        item.id,
      );
      await page.waitForTimeout(400);
      if (!started) {
        check(`${item.id} 尚未加入清单（跳过）`, true, null);
        continue;
      }
      const marked = await page.evaluate(() =>
        [...document.querySelectorAll('.shelf-card[data-wish="1"]')].map((el) => el.getAttribute('data-testid')),
      );
      check(
        item.label,
        item.mustMark.every((id) => marked.includes(id)) && item.mustNotMark.every((id) => !marked.includes(id)),
        marked,
      );
    }

    await page.evaluate(() => window.__bouquetDebug.store.setMode('free'));
    await page.waitForTimeout(500);
    const afterFree = await page.evaluate(() => ({
      line: Boolean(document.querySelector('[data-testid="shelf-wish-line"]')),
      marked: document.querySelectorAll('.shelf-card[data-wish="1"]').length,
    }));
    check('回到自由模式心愿标记消失', !afterFree.line && afterFree.marked === 0, afterFree);

    check('委托流程无脚本异常', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ==================== 391px 窄屏 ====================
  {
    const { page, pageErrors } = await openPage(ctxNarrow, { clear: true, viewport: { width: 391, height: 844 } });
    const narrow = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="flower-panel"]');
      const grid = document.querySelector('.shelf-grid');
      const cards = [...document.querySelectorAll('.shelf-card')];
      const panelRect = panel?.getBoundingClientRect();
      return {
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
        cards,
        cardOverflow: cards.some((card) => {
          const rect = card.getBoundingClientRect();
          return panelRect ? rect.right > panelRect.right + 1 : false;
        }),
      };
    });
    check('391px 无横向溢出', narrow.scrollWidth <= narrow.innerWidth && narrow.bodyScrollWidth <= narrow.innerWidth, {
      innerWidth: narrow.innerWidth,
      scrollWidth: narrow.scrollWidth,
      bodyScrollWidth: narrow.bodyScrollWidth,
    });
    check('391px 仍是两列且卡片不超出面板', narrow.columns === 2 && !narrow.cardOverflow, {
      columns: narrow.columns,
      cardOverflow: narrow.cardOverflow,
    });
    await page.screenshot({ path: `${OUT}/shelf-narrow-391.png` });
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
console.log(`\n=== v14-shelf：通过 ${passed} / 失败 ${failed} ===`);
if (failed > 0) process.exitCode = 1;
