/**
 * v14 包装面板收敛验证：先选呈现形式，再按步骤出控件；卡片步骤聚焦祝福；
 * 花器分支只留插花相关控件；预览 → 采用 → 一次撤销的流程不变。
 *
 * 运行（Vite dev server 已在 5173）：`cd app && node scripts/v14-package.mjs`
 * - 若 `public/assets/vessels/previews/*.jpg` 缺失，会先在真实工作台里逐形态截图生成；
 *   `node scripts/v14-package.mjs --previews` 可强制重新生成这 8 张小图。
 * - 环境变量：SMOKE_URL、v14_OUT、HEADED。
 *
 * 不做的事：不启动新服务、不 build、不改工作区其它文件。
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.v14_OUT ?? '.verify/v14-package';
const PREVIEW_OUT = 'public/assets/vessels/previews';
const KINDS = ['paper', 'vase', 'pot', 'basket', 'box', 'bucket', 'bag', 'crate'];
const LABELS = {
  paper: '纸片包装',
  vase: '细口花瓶',
  pot: '宽口陶罐',
  basket: '藤编花篮',
  box: '花礼盒',
  bucket: '抱抱桶',
  bag: '手提花袋',
  crate: '木条花箱',
};

mkdirSync(OUT, { recursive: true });
mkdirSync(PREVIEW_OUT, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
}

const launch = () =>
  chromium.launch({
    channel: 'chrome',
    headless: process.env.HEADED !== '1',
    args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  });

/** 等页面加载到真实清单、样束花材都进场景。 */
async function openWorkbench(page, { sample = 6, step = 'card' } = {}) {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, { timeout: 60000 });
  await page.evaluate(
    ({ sample, step }) => {
      const store = window.__bouquetDebug.store;
      store.loadSampleBouquet(sample);
      store.enterWrap();
      if (step) store.setPackageStep(step);
      store.endTransaction();
    },
    { sample, step },
  );
  await page.waitForFunction(
    () => [...window.__bouquetDebug.scene.views.values()].every((view) => view.object),
    null,
    { timeout: 90000 },
  );
  await settlePackage(page);
}

/** 等包装/换装动画停下来。 */
async function settlePackage(page, timeout = 6000) {
  await page
    .waitForFunction(() => !window.__bouquetDebug.getDecorState().animating, null, { timeout })
    .catch(() => {});
}

/** 等容器 GLB（如果有）加载完：模型加载是异步的，直接多等一会更稳。 */
async function settleVessel(page, ms = 1800) {
  await page.waitForTimeout(ms);
  await settlePackage(page);
}

/**
 * 用真实渲染生成 8 张小预览：同一株 6 枝样束、同一机位，只换呈现形式；
 * 隐藏 UI 层后按花器/纸片的屏幕位置裁一块方形截图。
 */
async function generatePreviews(browser, force = false) {
  const missing = force ? KINDS : KINDS.filter((kind) => !existsSync(join(PREVIEW_OUT, `${kind}.jpg`)));
  if (missing.length === 0) {
    console.log('小预览图已存在，跳过生成（--previews 可强制重生成）');
    return true;
  }
  console.log(`生成小预览图 ${missing.length}/8 …`);
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1.5 });
  const page = await context.newPage();
  try {
    await openWorkbench(page, { sample: 6, step: 'card' });
    for (const kind of missing) {
      await page.evaluate((target) => {
        const store = window.__bouquetDebug.store;
        store.setPresentation(target);
        store.endTransaction();
      }, kind);
      await settleVessel(page, 1900);
      const point = await page.evaluate(
        (target) => window.__bouquetDebug.scene.getDecorScreenPoint(target === 'paper' ? 'paper' : 'vessel'),
        kind,
      );
      if (!point) {
        console.log(`  ${kind}: 找不到可截图的位置，跳过`);
        continue;
      }
      // 裁一块能装下整件容器的方形：高容器（抱抱桶/手提花袋）给更大的取景。
      const half = { paper: 150, vase: 135, pot: 145, basket: 155, box: 145, bucket: 235, bag: 215, crate: 150 }[kind] ?? 150;
      const clip = {
        x: Math.max(0, Math.min(1366 - half * 2, point.x - half)),
        y: Math.max(0, Math.min(768 - half * 2, point.y - half)),
        width: half * 2,
        height: half * 2,
      };
      const shot = join(PREVIEW_OUT, `${kind}.jpg`);
      // 隐藏 UI 层，只截工作台里的花与容器。
      await page.evaluate(() => {
        const layer = document.querySelector('.ui-layer');
        if (layer) layer.setAttribute('data-v14-hidden', '1');
        const style = document.createElement('style');
        style.id = 'v14-hide-ui';
        style.textContent = '.ui-layer[data-v14-hidden="1"]{display:none!important}';
        document.head.appendChild(style);
      });
      await page.waitForTimeout(220);
      await page.screenshot({ path: shot, clip, type: 'jpeg', quality: 84 });
      await page.evaluate(() => {
        document.getElementById('v14-hide-ui')?.remove();
        document.querySelector('.ui-layer')?.removeAttribute('data-v14-hidden');
      });
      console.log(`  ${kind} → ${shot}`);
    }
    // 回到纸片包装，避免把生成用的形态写进后续检查
    await page.evaluate(() => {
      const store = window.__bouquetDebug.store;
      store.setPresentation('paper');
      store.endTransaction();
    });
    return KINDS.every((kind) => existsSync(join(PREVIEW_OUT, `${kind}.jpg`)));
  } finally {
    await context.close();
  }
}

/** 当前 store 快照 + 常用测试入口。 */
const createHelpers = (page) => {
  const state = () => page.evaluate(() => window.__bouquetDebug.getState());
  const count = (testId) => page.locator(`[data-testid="${testId}"]`).count();
  const visible = async (testId) => {
    const locator = page.locator(`[data-testid="${testId}"]`);
    if ((await locator.count()) === 0) return false;
    return locator.first().isVisible();
  };
  const wait = (ms) => page.waitForTimeout(ms);
  return { state, count, visible, wait };
};

const browser = await launch();
let pageErrors = [];
try {
  // ---------- 0. 小预览图（真实渲染截图，缺失才生成） ----------
  const previewsReady = await generatePreviews(browser, process.argv.includes('--previews'));
  check('8 张小预览图生成/已存在', previewsReady, { dir: PREVIEW_OUT });

  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  // 开发服务器上可能有别的改动正在热更新：只统计真正落到本应用逻辑上的错误，
  // 忽略 Vite HMR 重载提示与资源 404/500（截图与断言本身已覆盖面板内容）。
  const isNoise = (text) =>
    text.includes('Failed to load resource') || text.includes('[vite]') || text.includes('vite:') || text.includes('HMR');
  page.on('pageerror', (error) => { if (!isNoise(error.message)) pageErrors.push(error.message); });
  page.on('console', (message) => {
    if (message.type() === 'error' && !isNoise(message.text())) pageErrors.push(message.text());
  });
  const { state, count, visible, wait } = createHelpers(page);
  await openWorkbench(page, { sample: 6, step: 'paper' });
  await wait(600);

  // ---------- 1. 第一层：形态选择区 ----------
  check('右栏顶部显示阶段说明', (await page.getByTestId('right-panel-stage').innerText()).includes('第 1/4 步'), await page.getByTestId('right-panel-stage').innerText());
  check('形态选择区出现', await visible('presentation-grid'));
  check('形态选择区有 8 项', (await page.locator('.package-choice-item').count()) === 8, {
    items: await page.locator('.package-choice-item').count(),
  });
  for (const kind of KINDS) {
    const item = page.getByTestId(`presentation-${kind}`);
    check(`形态 ${LABELS[kind]} 可点`, (await item.count()) === 1 && (await item.isEnabled()) && (await item.innerText()).trim() === LABELS[kind]);
  }
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid^="presentation-thumb-"]')].every((img) => img.complete && img.naturalWidth > 0),
    null,
    { timeout: 8000 },
  ).catch(() => {});
  const thumbs = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="presentation-thumb-"]')].map((img) => ({
      testId: img.getAttribute('data-testid'),
      loaded: img.complete && img.naturalWidth > 0,
      src: img.getAttribute('src'),
    })),
  );
  check('每项都有小预览图（8 张）', thumbs.length === 8 && thumbs.every((item) => item.loaded), thumbs.filter((item) => !item.loaded));
  await page.screenshot({ path: `${OUT}/01-form-choice.png` });

  // ---------- 2. 纸片包装：摆纸控件 ----------
  check('切纸包显示纸片控件', (await visible('paper-controls')) && (await visible('sheet-list')) && (await visible('sheet-color-ivory')));
  check('摆纸步骤不提前摊开卡片编辑', !(await visible('card-editor')));
  check('摆纸步骤显示滑块与固定/层级', (await visible('paper-fixed')) && (await visible('paper-reorder')) && (await page.locator('.package-slider').count()) === 3);
  await page.screenshot({ path: `${OUT}/02-paper-place.png` });

  // ---------- 3. 切花篮：只在预览里，确认前不算改好 ----------
  await page.getByTestId('presentation-basket').click();
  await settleVessel(page, 900);
  {
    const snapshot = await state();
    check('切花篮先进入预览', snapshot.presentationPreview === true && snapshot.doc.presentation.kind === 'basket', {
      pending: snapshot.presentationPreview,
      kind: snapshot.doc.presentation.kind,
    });
  }
  check('花器说明出现', (await visible('vessel-note')) && (await page.getByTestId('vessel-note').innerText()).includes('插深'));
  check('花器分支不显示纸片列表', (await count('sheet-list')) === 0 && (await count('paper-controls')) === 0);
  // V16 §5：花器没有可靠系结点，不再显示无效丝带控件；改为显示装饰面板与卡片。
  check('花器分支不显示无效丝带、显示装饰与卡片', (await count('ribbon-block')) === 0 && (await visible('decorations-panel')) && (await visible('card-editor')));
  await page.screenshot({ path: `${OUT}/03-basket-preview.png` });
  await page.getByTestId('confirm-presentation').click();
  await settleVessel(page, 600);
  {
    const snapshot = await state();
    check('采用花篮后形态生效', snapshot.presentationPreview === false && snapshot.doc.presentation.kind === 'basket', {
      pending: snapshot.presentationPreview,
      kind: snapshot.doc.presentation.kind,
    });
  }
  await page.screenshot({ path: `${OUT}/04-basket-adopted.png` });

  // ---------- 4. 一次撤销回到纸片包装 ----------
  await page.evaluate(() => window.__bouquetDebug.store.undo());
  await settleVessel(page, 700);
  {
    const snapshot = await state();
    check('撤销一次回到纸片包装', snapshot.doc.presentation.kind === 'paper' && snapshot.presentationPreview === false, snapshot.doc.presentation.kind);
  }
  check('撤销后纸片控件回来', (await visible('paper-controls')) && (await visible('sheet-list')));

  // ---------- 5. 取消预览不改形态 ----------
  await page.getByTestId('presentation-vase').click();
  await wait(500);
  check('切花瓶进入预览', (await state()).presentationPreview === true);
  check('预览条出现取消按钮', await visible('cancel-presentation'));
  await page.getByTestId('cancel-presentation').click();
  await settleVessel(page, 700);
  {
    const snapshot = await state();
    check('取消后形态不变', snapshot.presentationPreview === false && snapshot.doc.presentation.kind === 'paper', snapshot.doc.presentation.kind);
  }

  // ---------- 6. 步骤切换：卡片步骤聚焦祝福 ----------
  await page.getByTestId('package-step-card').click();
  await settleVessel(page, 900);
  check('切到卡片步骤', (await state()).doc.wrapping.step === 'card');
  check('卡片步骤显示祝福编辑', (await visible('card-editor')) && (await visible('card-to')) && (await visible('card-message')) && (await visible('card-from')));
  check('卡片步骤给出聚焦说明', await visible('card-focus-note'));
  check('卡片步骤收起纸片列表', !(await visible('sheet-list')) && !(await visible('paper-controls')));
  check('卡片步骤提供「还想调一调」', await visible('package-more-toggle'));
  await page.screenshot({ path: `${OUT}/05-card-step.png` });
  await page.getByTestId('package-more-toggle').click();
  await wait(400);
  check('展开「还想调一调」能看到纸片与丝带', (await visible('paper-controls')) && (await visible('sheet-list')) && (await visible('ribbon-block')));
  check('展开后卡片编辑仍在', await visible('card-message'));
  await page.screenshot({ path: `${OUT}/06-card-more-open.png` });
  await page.getByTestId('card-to').click();
  await page.getByTestId('card-to').fill('妈妈');
  await page.getByTestId('card-message').click();
  await wait(200);
  check('卡片内容可编辑', (await state()).doc.card.to === '妈妈');

  // ---------- 7. 丝带步骤：只出丝带 ----------
  await page.getByTestId('package-step-ribbon').click();
  await settleVessel(page, 900);
  check('丝带步骤显示丝带', (await visible('ribbon-block')) && (await visible('ribbon-cream')));
  check('丝带步骤不摊开纸片列表', !(await visible('sheet-list')));
  check('丝带步骤卡片折叠进「还想调一调」', !(await visible('card-editor')));
  await page.screenshot({ path: `${OUT}/07-ribbon-step.png` });

  // ---------- 8. 花器分支：只留插花相关控件 ----------
  await page.getByTestId('presentation-basket').click();
  await settleVessel(page, 900);
  await page.getByTestId('confirm-presentation').click();
  await settleVessel(page, 800);
  check('花器分支不出现包装步骤条', (await count('package-step-paper')) === 0);
  check('花器分支显示插花提示', (await visible('vessel-flow')) && (await visible('vessel-block')));
  check('花器分支隐藏纸片专属控件', (await count('sheet-list')) === 0 && (await count('paper-controls')) === 0 && (await count('paper-fixed')) === 0);
  {
    const before = await page.evaluate(() => {
      const api = window.__bouquetDebug;
      const first = api.getState().doc.stems[0];
      api.store.select(first.id);
      return first.pose.height;
    });
    await wait(300);
    check('点花枝后出现插深/剪短控件', (await visible('vessel-deepen')) && (await visible('vessel-raise')) && (await visible('vessel-trim')));
    const deepenButton = page.getByTestId('vessel-deepen');
    const canDeepen = await deepenButton.isEnabled();
    // 样束的花枝可能已经压到器底（插深下限），这时按钮明确禁用；能调时才验证插深变化。
    if (canDeepen) {
      await deepenButton.click();
    } else {
      check('插深到底时按钮明确禁用', (await deepenButton.getAttribute('title'))?.includes('插到器底') === true, await deepenButton.getAttribute('title'));
      await page.getByTestId('vessel-raise').click();
    }
    await wait(400);
    const after = await page.evaluate(() => window.__bouquetDebug.getState().doc.stems[0].pose.height);
    const changed = canDeepen ? after < before - 0.004 : after > before + 0.004;
    check(canDeepen ? '再插深 1cm 改变选中花枝' : '拔高 1cm 改变选中花枝', changed, { before, after, canDeepen });
    await page.evaluate(() => window.__bouquetDebug.store.undo());
    await wait(300);
    const restored = await page.evaluate(() => window.__bouquetDebug.getState().doc.stems[0].pose.height);
    check('插深一次撤销可还原', Math.abs(restored - before) < 0.0021, { before, restored });
  }
  await page.screenshot({ path: `${OUT}/08-vessel-controls.png` });

  // ---------- 9. 回到纸包，卡片内容保留 ----------
  await page.evaluate(() => {
    const store = window.__bouquetDebug.store;
    store.setPresentation('paper');
    store.endTransaction();
    store.setPackageStep('card');
    store.endTransaction();
  });
  await wait(700);
  const cardKept = await page.evaluate(() => window.__bouquetDebug.getState().doc.card.to);
  check('换回纸包后卡片内容仍在', cardKept === '妈妈' && (await page.getByTestId('card-to').inputValue()) === '妈妈', { cardKept });

  // ---------- 10. 391px 窄屏不横向溢出 ----------
  const narrow = await browser.newContext({ viewport: { width: 391, height: 844 }, deviceScaleFactor: 1 });
  const narrowPage = await narrow.newPage();
  await openWorkbench(narrowPage, { sample: 6, step: 'paper' });
  await narrowPage.waitForTimeout(700);
  const overflow = await narrowPage.evaluate(() => {
    const doc = document.documentElement;
    const panel = document.querySelector('.decor-panel');
    const side = document.querySelector('.side-right');
    const rect = side?.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      scrollWidth: doc.scrollWidth,
      panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : 0,
      sideRight: rect ? Math.round(rect.right) : null,
      choiceWidths: [...document.querySelectorAll('.package-choice-item')].map((item) => Math.round(item.getBoundingClientRect().width)),
    };
  });
  check('391px 页面不横向溢出', overflow.scrollWidth <= overflow.innerWidth + 1, overflow);
  check('391px 面板内部不横向溢出', overflow.panelOverflow <= 1, overflow);
  check('391px 右栏完整落在视口内', overflow.sideRight !== null && overflow.sideRight <= overflow.innerWidth + 1, overflow);
  check('391px 形态格子仍有可点宽度', overflow.choiceWidths.length === 8 && overflow.choiceWidths.every((width) => width >= 28), overflow.choiceWidths);
  await narrowPage.screenshot({ path: `${OUT}/09-narrow-391.png` });
  await narrow.close();

  // ---------- 11. 无运行错误 ----------
  check('无页面运行错误', pageErrors.length === 0, pageErrors.slice(0, 5));
} finally {
  await browser.close();
}

const passed = results.filter((item) => item.ok).length;
const failed = results.length - passed;
console.log(`\nv14 包装面板：通过 ${passed}/${results.length}，失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const item of results.filter((entry) => !entry.ok)) console.log(` - ${item.name} ${JSON.stringify(item.detail)}`);
  process.exitCode = 1;
}
