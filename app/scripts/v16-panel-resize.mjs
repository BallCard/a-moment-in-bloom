/**
 * v16 第二轮：左右侧面板可拖拽拉伸 + 自适应验证。
 *
 * 覆盖：
 * 1) 两侧把手常驻存在：左花材面板内边缘、右栏内边缘；role=separator、可聚焦、
 *    cursor: col-resize、没 hover 时也有可见细线，hover 后线变绿变粗；
 * 2) 拖动后宽度真的变化，且夹在 min/max 内；内容自适应：左侧仍两列卡片、
 *    卡片/面板不横向溢出、字号不跟着变大；右侧容器自适应、不横向溢出、
 *    视角控件跟着右栏让开；
 * 3) 刷新后宽度保留（localStorage 独立 key，含坏 JSON / 越界值的兜底）；
 * 4) 键盘可调：把手聚焦后 ←/→（Shift 加大步长）改宽度，aria-valuenow 同步；
 * 5) 拖动把手不误触三维：相机位置/目标、选中状态都不变；拖完画布仍能选中花枝；
 * 6) 391px / ≤760px 窄屏：不渲染把手、即使本机存了宽宽度也不应用、不横向溢出，
 *    760 → 761px 边界处把手与宽度变量恢复。
 *
 * 运行（Vite dev server 已在 5173）：`cd app && node scripts/v16-panel-resize.mjs`
 * 环境变量：SMOKE_URL、v16_PANEL_OUT、HEADED。
 *
 * 不做的事：不启动新服务、不 build、不改工作区其它文件。
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.v16_PANEL_OUT ?? '.verify/v16-panel-resize';
const STORAGE_KEY = 'bouquet.panel-widths.v1';
mkdirSync(OUT, { recursive: true });

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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launch({
  channel: 'chrome',
  headless: process.env.HEADED !== '1',
  args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});

/**
 * 打开工作台；clear=true 时先清 localStorage 再重载，保证从默认宽度开始。
 * 用 `?sample=6` 进入：这样即使其它 teammate 改源码触发整页热重载，URL 里
 * 也始终是工作台入口，不会因为本机存过花束而落到「继续上次」开屏。
 */
async function openWorkbench(context, { clear = false, query = '?sample=6' } = {}) {
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(URL);
  if (clear) {
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${URL}${query}`);
  } else {
    await page.goto(`${URL}${query}`);
  }
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, {
    timeout: 90000,
  });
  await wait(500);
  return { page, pageErrors };
}

/** 取真实样束并展开右侧面板（选中第 1 枝，再用右侧窄条打开）。 */
async function preparePanels(page, { sample = 6 } = {}) {
  await page.evaluate((size) => {
    window.__bouquetDebug.store.loadSampleBouquet(size);
  }, sample);
  await page.waitForFunction(
    () => [...window.__bouquetDebug.scene.views.values()].every((view) => view.object),
    null,
    { timeout: 90000 },
  );
  await page.evaluate(() => {
    const debug = window.__bouquetDebug;
    const state = debug.getState();
    if (!state.selectedId && state.doc.stems.length > 0) debug.store.select(state.doc.stems[0].id);
  });
  await wait(220);
  const reopen = page.locator('[data-testid="right-reopen"]');
  if (await reopen.count()) await reopen.click();
  await page.waitForSelector('.right-stack', { state: 'visible', timeout: 8000 }).catch(() => {});
  await wait(250);
}

async function sideWidths(page) {
  return page.evaluate(() => {
    const app = document.querySelector('.app');
    const left = document.querySelector('.side-left');
    const right = document.querySelector('.side-right');
    return {
      left: left ? Math.round(left.getBoundingClientRect().width) : null,
      right: right ? Math.round(right.getBoundingClientRect().width) : null,
      leftVar: app ? app.style.getPropertyValue('--panel-left-w').trim() : '',
      rightVar: app ? app.style.getPropertyValue('--panel-right-w').trim() : '',
    };
  });
}

/** 其它 teammate 正在改源码时 Vite 可能整页热重载；一旦发现页面被重载就重新准备好面板。 */
async function recoverIfReloaded(page) {
  const alive = await page
    .evaluate(
      () =>
        Boolean(window.__bouquetDebug) &&
        window.__bouquetDebug.getState().catalogStatus === 'manifest' &&
        window.__bouquetDebug.getState().doc.stems.length > 0 &&
        Boolean(document.querySelector('.flower-panel')),
    )
    .catch(() => false);
  if (alive) return false;
  // 万一重载后落在「继续上次的花束 / 空白花台」开屏，先点继续。
  const continueButton = page.locator('[data-testid="start-continue"]');
  if (await continueButton.count().catch(() => 0)) {
    await continueButton.click().catch(() => {});
    await page.waitForSelector('.app', { timeout: 30000 }).catch(() => {});
  }
  await page
    .waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, { timeout: 90000 })
    .catch(() => {});
  await preparePanels(page);
  return true;
}

async function handleBox(page, side, attempt = 0) {
  const box = await page
    .locator(`[data-testid="panel-resize-${side}"]`)
    .boundingBox({ timeout: 8000 })
    .catch(() => null);
  if (!box) {
    // 页面正好被热重载：重新准备好面板后再找一次。
    if (attempt < 1 && (await recoverIfReloaded(page))) return handleBox(page, side, attempt + 1);
    throw new Error(`找不到 ${side} 把手`);
  }
  return { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 120) };
}

/** 从把手中心水平拖 dx 像素（正数向右），分步移动更像真人。 */
async function dragHandle(page, side, dx, attempt = 0) {
  await recoverIfReloaded(page);
  const start = await handleBox(page, side);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const steps = 8;
  for (let index = 1; index <= steps; index += 1) {
    await page.mouse.move(start.x + (dx * index) / steps, start.y);
    await wait(16);
  }
  await page.mouse.up();
  await wait(260);
  if (attempt < 1 && (await recoverIfReloaded(page))) {
    // 拖动过程中被热重载打断：页面已重新准备好，再拖一次。
    await dragHandle(page, side, dx, attempt + 1);
  }
}

async function pageOverflow(page) {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
}

async function contentMetrics(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return {
        left: Math.round(box.left),
        right: Math.round(box.right),
        width: Math.round(box.width),
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        overflowX: node.scrollWidth - node.clientWidth,
      };
    };
    const grid = document.querySelector('.shelf-grid');
    const gridColumns = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean) : [];
    return {
      leftSide: rect('.side-left'),
      rightSide: rect('.side-right'),
      flowerPanel: rect('.flower-panel'),
      shelfScroll: rect('.shelf-scroll'),
      shelfCards: document.querySelectorAll('.shelf-card').length,
      gridColumns: gridColumns.length,
      shelfNameFont: (() => {
        const name = document.querySelector('.shelf-name');
        return name ? getComputedStyle(name).fontSize : null;
      })(),
      rightStack: rect('.right-stack'),
      rightHead: rect('.right-panel-head'),
      inspector: rect('.inspector'),
      viewDock: rect('.view-dock'),
      helpReopen: rect('.help-reopen'),
      rightSubFont: (() => {
        const node = document.querySelector('.right-panel-sub');
        return node ? getComputedStyle(node).fontSize : null;
      })(),
      panelTabFont: (() => {
        const node = document.querySelector('.panel-tab');
        return node ? getComputedStyle(node).fontSize : null;
      })(),
    };
  });
}

async function cameraState(page) {
  return page.evaluate(() => {
    const scene = window.__bouquetDebug.getSceneState();
    return { camera: scene.camera, transitioning: scene.transitioning };
  });
}

try {
  // ==================== 桌面 1366×768 ====================
  const ctxDesktop = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
  const { page, pageErrors } = await openWorkbench(ctxDesktop, { clear: true });
  await preparePanels(page);

  // ---------- 1. 两个把手常驻存在且可发现 ----------
  await page.screenshot({ path: `${OUT}/01-default-1366.png` });
  const bothHandles = await page.evaluate(() => {
    const read = (side) => {
      const node = document.querySelector(`[data-testid="panel-resize-${side}"]`);
      if (!node) return null;
      const style = getComputedStyle(node);
      const line = getComputedStyle(node, '::before');
      return {
        role: node.getAttribute('role'),
        tabIndex: node.tabIndex,
        cursor: style.cursor,
        width: Math.round(node.getBoundingClientRect().width),
        ariaMin: node.getAttribute('aria-valuemin'),
        ariaMax: node.getAttribute('aria-valuemax'),
        ariaNow: node.getAttribute('aria-valuenow'),
        lineWidth: line.width,
        lineOpacity: Number(line.opacity),
        inSide: Boolean(node.closest(`.side-${side}`)),
        dataSide: node.getAttribute('data-side'),
      };
    };
    return {
      left: read('left'),
      right: read('right'),
      total: document.querySelectorAll('.panel-resize-handle').length,
    };
  });
  check('左右两个把手都存在', bothHandles.total === 2 && Boolean(bothHandles.left) && Boolean(bothHandles.right), bothHandles.total);
  check(
    '把手挂在对应侧栏内边缘',
    bothHandles.left?.inSide && bothHandles.right?.inSide && bothHandles.left?.dataSide === 'left' && bothHandles.right?.dataSide === 'right',
    bothHandles,
  );
  check(
    '把手可聚焦且是分隔条',
    bothHandles.left?.role === 'separator' &&
      bothHandles.right?.role === 'separator' &&
      bothHandles.left?.tabIndex === 0 &&
      bothHandles.right?.tabIndex === 0,
    { left: bothHandles.left?.role, right: bothHandles.right?.role },
  );
  check(
    '把手 cursor 为 col-resize',
    bothHandles.left?.cursor === 'col-resize' && bothHandles.right?.cursor === 'col-resize',
    { left: bothHandles.left?.cursor, right: bothHandles.right?.cursor },
  );
  check(
    '把手没 hover 也有常驻细线',
    Number(bothHandles.left?.lineOpacity) > 0.2 &&
      bothHandles.left?.lineWidth === '2px' &&
      Number(bothHandles.right?.lineOpacity) > 0.2,
    { left: { w: bothHandles.left?.lineWidth, o: bothHandles.left?.lineOpacity }, right: { o: bothHandles.right?.lineOpacity } },
  );
  check(
    'aria 上下限与初始宽度合理',
    Number(bothHandles.left?.ariaMin) === 240 &&
      Number(bothHandles.left?.ariaMax) === 420 &&
      Number(bothHandles.right?.ariaMin) === 300 &&
      Number(bothHandles.right?.ariaMax) === 460 &&
      Number(bothHandles.left?.ariaNow) === 258 &&
      Number(bothHandles.right?.ariaNow) === 300,
    bothHandles,
  );

  // hover 高亮
  const hoverPoint = await handleBox(page, 'left');
  await page.mouse.move(hoverPoint.x, hoverPoint.y);
  await wait(260);
  // 悬停高亮是 CSS 过渡：并行跑脚本时 260ms 可能还在过渡中，等它稳定再断言。
  await page
    .waitForFunction(
      () => {
        const node = document.querySelector('[data-testid="panel-resize-left"]');
        if (!node) return false;
        const line = getComputedStyle(node, '::before');
        return line.width === '3px' && Number(line.opacity) === 1;
      },
      null,
      { timeout: 4000 },
    )
    .catch(() => {});
  const hoverLine = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="panel-resize-left"]');
    const line = getComputedStyle(node, '::before');
    return { width: line.width, opacity: Number(line.opacity) };
  });
  check('hover 时把手线高亮变绿变粗', hoverLine.width === '3px' && hoverLine.opacity === 1, hoverLine);
  await page.mouse.move(683, 420);
  await wait(200);

  await recoverIfReloaded(page);

  // ---------- 2. 默认布局与内容自适应基线 ----------
  const baseWidths = await sideWidths(page);
  const baseMetrics = await contentMetrics(page);
  const baseCamera = await cameraState(page);
  const baseOverflow = await pageOverflow(page);
  check('1366 下默认左 258 / 右 300', baseWidths.left === 258 && baseWidths.right === 300, baseWidths);
  check('左侧仍是两列卡片', baseMetrics.gridColumns === 2 && baseMetrics.shelfCards > 0, { columns: baseMetrics.gridColumns, cards: baseMetrics.shelfCards });
  check('默认宽度没有横向溢出', baseOverflow.scrollWidth <= baseOverflow.innerWidth + 1, baseOverflow);
  check(
    '右栏展开时视角控件向左让开',
    Boolean(baseMetrics.viewDock && baseMetrics.rightSide) &&
      baseMetrics.viewDock.right <= baseMetrics.rightSide.left + 1,
    { dock: baseMetrics.viewDock, sideRight: baseMetrics.rightSide },
  );
  check(
    '帮助入口贴在左侧栏右边',
    Boolean(baseMetrics.helpReopen && baseMetrics.leftSide) &&
      baseMetrics.helpReopen.left >= baseMetrics.leftSide.right - 1,
    { help: baseMetrics.helpReopen, sideLeft: baseMetrics.leftSide },
  );

  // ---------- 3. 左栏向右拖宽 +80 ----------
  await dragHandle(page, 'left', 80);
  const afterLeftDrag = await sideWidths(page);
  const afterLeftMetrics = await contentMetrics(page);
  const afterLeftOverflow = await pageOverflow(page);
  const afterLeftCamera = await cameraState(page);
  check(
    '拖动左把手后左栏变宽约 80px',
    afterLeftDrag.left !== null && Math.abs(afterLeftDrag.left - 338) <= 3,
    { before: baseWidths.left, after: afterLeftDrag.left },
  );
  check('拖动后左侧内容仍两列卡片', afterLeftMetrics.gridColumns === 2 && afterLeftMetrics.shelfCards === baseMetrics.shelfCards, {
    columns: afterLeftMetrics.gridColumns,
    cards: afterLeftMetrics.shelfCards,
  });
  check(
    '拖动后左侧面板与卡片流不横向溢出',
    Boolean(afterLeftMetrics.flowerPanel && afterLeftMetrics.shelfScroll) &&
      afterLeftMetrics.flowerPanel.overflowX <= 1 &&
      afterLeftMetrics.shelfScroll.overflowX <= 1,
    { panel: afterLeftMetrics.flowerPanel, shelf: afterLeftMetrics.shelfScroll },
  );
  check('拖动后页面不横向溢出', afterLeftOverflow.scrollWidth <= afterLeftOverflow.innerWidth + 1, afterLeftOverflow);
  check('变宽时花材名字号不被拉大', afterLeftMetrics.shelfNameFont === baseMetrics.shelfNameFont, {
    before: baseMetrics.shelfNameFont,
    after: afterLeftMetrics.shelfNameFont,
  });
  check(
    '拖动左把手不误触相机',
    JSON.stringify(afterLeftCamera.camera) === JSON.stringify(baseCamera.camera),
    { before: baseCamera.camera, after: afterLeftCamera.camera },
  );
  check(
    '拖动左把手不改变选中状态',
    await page.evaluate(() => {
      const state = window.__bouquetDebug.getState();
      return Boolean(state.selectedId) && state.placement === null;
    }),
    {},
  );
  check(
    '帮助入口跟着左栏宽度移动',
    Boolean(afterLeftMetrics.helpReopen && afterLeftMetrics.leftSide) &&
      afterLeftMetrics.helpReopen.left >= afterLeftMetrics.leftSide.right - 1,
    { help: afterLeftMetrics.helpReopen, sideLeft: afterLeftMetrics.leftSide },
  );
  await page.screenshot({ path: `${OUT}/02-left-wider.png` });

  // ---------- 4. 左栏 min / max 夹取 ----------
  await dragHandle(page, 'left', 500);
  const leftMax = await sideWidths(page);
  check('左栏拖到上限夹在 420', leftMax.left === 420, leftMax);
  const leftMaxMetrics = await contentMetrics(page);
  check(
    '左栏最宽时仍是两列且不横向溢出',
    leftMaxMetrics.gridColumns === 2 && leftMaxMetrics.flowerPanel?.overflowX <= 1 && leftMaxMetrics.shelfScroll?.overflowX <= 1,
    leftMaxMetrics.flowerPanel,
  );
  await page.screenshot({ path: `${OUT}/03-left-max.png` });
  await dragHandle(page, 'left', -600);
  const leftMin = await sideWidths(page);
  check('左栏拖到下限夹在 240', leftMin.left === 240, leftMin);

  // ---------- 5. 键盘调宽 ----------
  await recoverIfReloaded(page);
  const leftHandle = page.locator('[data-testid="panel-resize-left"]');
  await leftHandle.focus({ timeout: 8000 }).catch(async () => {
    await recoverIfReloaded(page);
    await leftHandle.focus({ timeout: 8000 });
  });
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
  check('把手可以获得键盘焦点', focused === 'panel-resize-left', focused);
  await page.keyboard.press('ArrowRight');
  await wait(220);
  await page.keyboard.press('ArrowRight');
  await wait(220);
  await page.keyboard.press('Shift+ArrowRight');
  await wait(300);
  const afterKeys = await sideWidths(page);
  const ariaAfterKeys = await leftHandle.getAttribute('aria-valuenow');
  check('←/→ 每次 +16px、Shift +32px', afterKeys.left === 240 + 16 + 16 + 32, { width: afterKeys.left });
  check('键盘调宽后 aria-valuenow 同步', Number(ariaAfterKeys) === afterKeys.left, { aria: ariaAfterKeys, width: afterKeys.left });
  const afterKeyCamera = await cameraState(page);
  check('键盘调宽不误触相机', JSON.stringify(afterKeyCamera.camera) === JSON.stringify(baseCamera.camera), afterKeyCamera.camera);
  await page.screenshot({ path: `${OUT}/04-left-keyboard.png` });

  // ---------- 6. 右栏向左拖宽 +70 ----------
  await recoverIfReloaded(page);
  await dragHandle(page, 'right', -70);
  const afterRightDrag = await sideWidths(page);
  const afterRightMetrics = await contentMetrics(page);
  const afterRightOverflow = await pageOverflow(page);
  check(
    '拖动右把手后右栏变宽约 70px',
    afterRightDrag.right !== null && Math.abs(afterRightDrag.right - 370) <= 3,
    { before: baseWidths.right, after: afterRightDrag.right },
  );
  check(
    '右栏变宽后容器自适应且不横向溢出',
    Boolean(afterRightMetrics.rightStack && afterRightMetrics.rightHead) &&
      afterRightMetrics.rightStack.width >= 360 &&
      afterRightMetrics.rightStack.overflowX <= 1 &&
      afterRightMetrics.rightHead.overflowX <= 1 &&
      afterRightOverflow.scrollWidth <= afterRightOverflow.innerWidth + 1,
    { stack: afterRightMetrics.rightStack, head: afterRightMetrics.rightHead, page: afterRightOverflow },
  );
  check(
    '右栏变宽时文字字号不变（不整体放大）',
    afterRightMetrics.rightSubFont === baseMetrics.rightSubFont &&
      afterRightMetrics.panelTabFont === baseMetrics.panelTabFont,
    {
      before: { sub: baseMetrics.rightSubFont, tab: baseMetrics.panelTabFont },
      after: { sub: afterRightMetrics.rightSubFont, tab: afterRightMetrics.panelTabFont },
    },
  );
  check(
    '视角控件仍让开变宽的右栏',
    Boolean(afterRightMetrics.viewDock && afterRightMetrics.rightSide) &&
      afterRightMetrics.viewDock.right <= afterRightMetrics.rightSide.left + 1,
    { dock: afterRightMetrics.viewDock, sideRight: afterRightMetrics.rightSide },
  );
  await page.screenshot({ path: `${OUT}/05-right-wider.png` });

  // ---------- 7. 右栏 min / max 夹取 + 键盘 ----------
  await recoverIfReloaded(page);
  await dragHandle(page, 'right', -500);
  const rightMax = await sideWidths(page);
  check('右栏拖到上限夹在 460', rightMax.right === 460, rightMax);
  await dragHandle(page, 'right', 500);
  const rightMin = await sideWidths(page);
  check('右栏拖到下限夹在 300', rightMin.right === 300, rightMin);
  const rightHandle = page.locator('[data-testid="panel-resize-right"]');
  await rightHandle.focus({ timeout: 8000 }).catch(async () => {
    await recoverIfReloaded(page);
    await rightHandle.focus({ timeout: 8000 });
  });
  await page.keyboard.press('ArrowLeft');
  await wait(220);
  await page.keyboard.press('ArrowLeft');
  await wait(300);
  const rightAfterKeys = await sideWidths(page);
  check('右栏键盘 ← 变宽', rightAfterKeys.right === 332, rightAfterKeys);

  // ---------- 8. 刷新保留宽度 ----------
  await recoverIfReloaded(page);
  const saved = await sideWidths(page);
  const reloaded = await openWorkbench(ctxDesktop, { query: '?sample=6' });
  const afterReload = await sideWidths(reloaded.page);
  check(
    '刷新后左栏宽度保留',
    afterReload.leftVar === `${saved.left}px` && afterReload.left === saved.left,
    { saved: saved.left, reloaded: afterReload.left, var: afterReload.leftVar },
  );
  check(
    '刷新后右栏宽度变量保留',
    afterReload.rightVar === `${saved.right}px`,
    { saved: saved.right, var: afterReload.rightVar },
  );
  // 打开右栏确认实际渲染宽度也用回存的值
  await preparePanels(reloaded.page);
  await recoverIfReloaded(reloaded.page);
  const reloadedWidths = await sideWidths(reloaded.page);
  check('刷新后打开右栏用的是保存的宽度', reloadedWidths.right === saved.right, { expected: saved.right, actual: reloadedWidths.right });
  await reloaded.page.screenshot({ path: `${OUT}/06-after-reload.png` });

  // ---------- 9. 坏 JSON / 越界值兜底 ----------
  await reloaded.page.evaluate(() => localStorage.setItem('bouquet.panel-widths.v1', 'not-json{'));
  await reloaded.page.goto(`${URL}?sample=6`);
  await reloaded.page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, {
    timeout: 90000,
  });
  await wait(400);
  const afterBadJson = await sideWidths(reloaded.page);
  check('坏 JSON 读失败回到默认宽度', afterBadJson.left === 258 && afterBadJson.rightVar === '', afterBadJson);
  await reloaded.page.evaluate(() => localStorage.setItem('bouquet.panel-widths.v1', JSON.stringify({ left: 9999, right: 5 })));
  await reloaded.page.goto(`${URL}?sample=6`);
  await reloaded.page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, {
    timeout: 90000,
  });
  await wait(400);
  const afterOutOfRange = await sideWidths(reloaded.page);
  check('越界存储值夹进 min/max', afterOutOfRange.left === 420 && afterOutOfRange.rightVar === '300px', afterOutOfRange);

  // ---------- 10. 拖完仍能点三维选花枝 ----------
  await recoverIfReloaded(reloaded.page);
  await preparePanels(reloaded.page);
  const cameraBeforeClick = await cameraState(reloaded.page);
  await reloaded.page.evaluate(() => window.__bouquetDebug.store.select(null));
  await wait(250);
  const clickTarget = await reloaded.page.evaluate(() => {
    const stems = window.__bouquetDebug.getState().doc.stems;
    for (const stem of stems) {
      const point = window.__bouquetDebug.getStemScreenPoint(stem.id);
      if (point?.visible) return { id: stem.id, x: Math.round(point.x), y: Math.round(point.y) };
    }
    return null;
  });
  if (clickTarget) {
    await reloaded.page.mouse.click(clickTarget.x, clickTarget.y);
    await wait(350);
    const selectedAfterClick = await reloaded.page.evaluate(() => window.__bouquetDebug.getState().selectedId);
    check('拖动把手后画布点击仍能选中花枝', selectedAfterClick === clickTarget.id, {
      target: clickTarget,
      selected: selectedAfterClick,
    });
    const cameraAfterClick = await cameraState(reloaded.page);
    check(
      '画布点击选中不移动相机',
      JSON.stringify(cameraAfterClick.camera) === JSON.stringify(cameraBeforeClick.camera),
      { before: cameraBeforeClick.camera, after: cameraAfterClick.camera },
    );
  } else {
    check('拖动把手后画布点击仍能选中花枝', false, { reason: '找不到可见花头屏幕坐标' });
  }
  check('桌面流程没有页面运行错误', pageErrors.length === 0, pageErrors.slice(0, 5));
  await reloaded.page.close();
  await page.close();
  await ctxDesktop.close();

  // ==================== 窄屏 391×844 ====================
  const ctxNarrow = await browser.newContext({ viewport: { width: 391, height: 844 }, deviceScaleFactor: 1 });
  const narrow = await openWorkbench(ctxNarrow, { clear: true });
  await preparePanels(narrow.page);
  await recoverIfReloaded(narrow.page);
  const narrowWidths = await sideWidths(narrow.page);
  const narrowHandles = await narrow.page.evaluate(() => ({
    count: document.querySelectorAll('.panel-resize-handle').length,
    left: Boolean(document.querySelector('[data-testid="panel-resize-left"]')),
    right: Boolean(document.querySelector('[data-testid="panel-resize-right"]')),
    display: (() => {
      const node = document.querySelector('[data-testid="panel-resize-left"]');
      return node ? getComputedStyle(node).display : null;
    })(),
  }));
  const narrowOverflow = await pageOverflow(narrow.page);
  const narrowMetrics = await contentMetrics(narrow.page);
  check('391px 窄屏不渲染把手', narrowHandles.count === 0 && !narrowHandles.left && !narrowHandles.right, narrowHandles);
  check('391px 沿用既有窄屏宽度 232 / 272', narrowWidths.left === 232 && narrowWidths.right === 272, narrowWidths);
  check('391px 页面不横向溢出', narrowOverflow.scrollWidth <= narrowOverflow.innerWidth + 1, narrowOverflow);
  check(
    '391px 两侧栏都在视口内',
    Boolean(narrowMetrics.rightSide && narrowMetrics.leftSide) &&
      narrowMetrics.rightSide.right <= 391 + 1 &&
      narrowMetrics.leftSide.left >= -1,
    { left: narrowMetrics.leftSide, right: narrowMetrics.rightSide },
  );
  check('391px 花材架仍有卡片且两列', narrowMetrics.gridColumns === 2 && narrowMetrics.shelfCards > 0, {
    columns: narrowMetrics.gridColumns,
    cards: narrowMetrics.shelfCards,
  });
  await narrow.page.screenshot({ path: `${OUT}/07-narrow-391.png` });

  // 本机存了宽宽度也不能带到窄屏
  await narrow.page.evaluate(
    (key) => localStorage.setItem(key, JSON.stringify({ left: 420, right: 460 })),
    STORAGE_KEY,
  );
  await narrow.page.goto(`${URL}?sample=6`);
  await narrow.page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, {
    timeout: 90000,
  });
  await wait(400);
  await preparePanels(narrow.page);
  await recoverIfReloaded(narrow.page);
  const narrowStored = await sideWidths(narrow.page);
  const narrowStoredOverflow = await pageOverflow(narrow.page);
  check(
    '窄屏即使存了 420/460 也不应用（退回 232/272）',
    narrowStored.left === 232 && narrowStored.right === 272 && narrowStored.leftVar === '' && narrowStored.rightVar === '',
    narrowStored,
  );
  check('窄屏带存储值也不横向溢出', narrowStoredOverflow.scrollWidth <= narrowStoredOverflow.innerWidth + 1, narrowStoredOverflow);
  await narrow.page.screenshot({ path: `${OUT}/08-narrow-391-stored.png` });

  // 760 / 761 边界
  await narrow.page.setViewportSize({ width: 760, height: 844 });
  await wait(400);
  const at760 = await narrow.page.evaluate(() => ({
    handles: document.querySelectorAll('.panel-resize-handle').length,
    left: Math.round(document.querySelector('.side-left').getBoundingClientRect().width),
  }));
  check('760px 仍按窄屏退化（无把手）', at760.handles === 0 && at760.left === 232, at760);
  await narrow.page.setViewportSize({ width: 761, height: 844 });
  await wait(500);
  const at761 = await narrow.page.evaluate(() => ({
    handles: document.querySelectorAll('.panel-resize-handle').length,
    left: Math.round(document.querySelector('.side-left').getBoundingClientRect().width),
    leftVar: document.querySelector('.app').style.getPropertyValue('--panel-left-w').trim(),
  }));
  const at761Overflow = await pageOverflow(narrow.page);
  check('761px 恢复把手并应用存储宽度（420 被视口上限收窄）', at761.handles === 2 && at761.left > 232 && at761.leftVar !== '', at761);
  check('761px 恢复后仍不横向溢出', at761Overflow.scrollWidth <= at761Overflow.innerWidth + 1, at761Overflow);
  await narrow.page.screenshot({ path: `${OUT}/09-boundary-761.png` });
  check('窄屏流程没有页面运行错误', narrow.pageErrors.length === 0, narrow.pageErrors.slice(0, 5));
  await ctxNarrow.close();
} finally {
  await browser.close();
}

const total = results.length;
console.log(`\nv16 面板拉伸：通过 ${passed}/${total}，失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const item of results.filter((entry) => !entry.ok)) console.log(` - ${item.name} ${JSON.stringify(item.detail)}`);
  process.exitCode = 1;
}
