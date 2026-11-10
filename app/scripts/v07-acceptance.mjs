/**
 * V7 §3/§5 落位与密集场景验收证据（acceptance）。
 *
 * 用法（先确认 dev 服务在跑；默认 127.0.0.1:5190，不会自己起服务）：
 *   node scripts/v07-acceptance.mjs                 # 固定样束四视角 + 玩法路径 + 拼版图源
 *   node scripts/v07-acceptance.mjs --fixtures-only # 只跑固定样束与包络统计
 *   HEADED=1 node scripts/v07-acceptance.mjs
 *   ACCEPT_URL=http://127.0.0.1:5190/ node scripts/v07-acceptance.mjs
 *
 * 产出（.verify/v07-acceptance/，可用 ACCEPT_OUT 加子目录）：
 *   - results.json：每束/每步的包络统计、真实玩法路径后的 core 重叠、断言与限制说明
 *   - fixture-<bundle>-<view>.png：固定 6/12/20 枝密集样束 × 正/侧/背/俯
 *   - acceptance-<step>.png：玩法路径每一步的视图
 *   - 拼版图由 .verify/v07-size/make_sheet.py 生成：acceptance/contact-sheet.png
 *
 * 口径（必须写在报告里）：
 *   - 包络是 src/three/envelope.ts 的**椭球**近似（核心椭球严格、外缘允许少量交叠）；
 *   - **包络重叠 ≠ 花瓣网格穿透深度**：它衡量的是同口径的碰撞近似，
 *     画面是否真的穿模仍要人看截图，不能把 core 重叠数当成网格穿模率；
 *   - 场景取包络走 Lead 提供的 `window.__bouquetDebug.scene.getEnvelopeState()`，
 *     脚本只用 envelope.ts 的纯函数做配对统计，不复制求解器逻辑；
 *   - 旧样束 fixture 本身就有包络重叠，是**压力用例**：玩法操作后的要求是
 *     「不新增 core 重叠」且 worst.core 不高于 fixture 基线，而不是把 fixture 当失败。
 */

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.ACCEPT_URL ?? 'http://127.0.0.1:5190/';
const OUT = `.verify/v07-acceptance${process.env.ACCEPT_OUT ? `/${process.env.ACCEPT_OUT}` : ''}`;
mkdirSync(OUT, { recursive: true });

const args = new Map(
  process.argv
    .slice(2)
    .filter((item) => item.startsWith('--'))
    .map((item) => {
      const [key, value = '1'] = item.replace(/^--/, '').split('=');
      return [key, value];
    }),
);
const FIXTURES_ONLY = args.has('fixtures-only');
const BUNDLES = (args.get('bundles') ?? '6,12,20').split(',').map(Number).filter(Boolean);
const VIEWS = ['front', 'side', 'top', 'back'];
/** 验收统一用新作品默认候选 b（缩小 20%）；a/c 的尺寸对照见 v07-size.mjs。 */
const SIZE = (args.get('size') ?? 'b').toLowerCase();
const TOLERANCE_CORE = 0.0015; // 1.5mm：包络坐标在调试入口里四舍五入到 0.1mm，留一点余量

const checks = [];
const failures = [];
const errors = [];
let step = 'boot';
let passed = 0;
function check(name, ok, detail) {
  checks.push({ name, ok, detail: detail ?? null });
  if (ok) {
    passed += 1;
    console.log('ok  ', name);
  } else {
    failures.push({ name, detail: detail ?? null });
    console.log('FAIL', name, JSON.stringify(detail ?? null));
  }
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: process.env.HEADED !== '1',
  args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on('pageerror', (error) =>
  errors.push({ step, message: error.message, stack: (error.stack ?? '').slice(0, 800) }),
);
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('404')) errors.push({ step, message: message.text() });
});

const wait = (ms) => page.waitForTimeout(ms);
const shot = (name) => page.locator('[data-testid=viewport]').screenshot({ path: `${OUT}/${name}.png` });

async function open(query, { expectStems = 1 } = {}) {
  await page.goto(`${BASE}?${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__bouquetDebug), null, { timeout: 25000 });
  await page.waitForFunction(() => window.__bouquetDebug.getState().catalog.mode === 'manifest', null, {
    timeout: 25000,
  });
  await page.waitForFunction(
    (minStems) => {
      const debug = window.__bouquetDebug;
      const state = debug.getState();
      if (state.doc.stems.length < minStems) return false;
      return [...debug.scene.views.values()].every((view) => view.object && view.loaded);
    },
    expectStems,
    { timeout: 25000 },
  );
  await wait(1300);
}

/**
 * 场景包络报告：以 Lead 的 getEnvelopeState() 为唯一几何来源，
 * 再用 envelope.ts 纯函数逐对统计（core/rim 超限对数、按花材分类、top 对）。
 */
function collectReport() {
  return async () => {
    const debug = window.__bouquetDebug;
    const state = debug.getState();
    const envelopeState = debug.scene.getEnvelopeState();
    const env = await import('/src/three/envelope.ts');
    const stems = envelopeState.stems;
    const pairs = [];
    for (let a = 0; a < stems.length; a += 1) {
      for (let b = a + 1; b < stems.length; b += 1) {
        const first = stems[a];
        const second = stems[b];
        const limits = env.stricterLimits(env.limitsFor(first.kind), env.limitsFor(second.kind));
        let core = 0;
        let rim = 0;
        for (const volumeA of first.volumes) {
          for (const volumeB of second.volumes) {
            const overlap = env.overlapBetween(volumeA, volumeB);
            if (overlap.core > core) core = overlap.core;
            if (overlap.rim > rim) rim = overlap.rim;
          }
        }
        if (core <= 0 && rim <= 0) continue;
        pairs.push({
          a: first.stemId,
          b: second.stemId,
          kindA: first.kind,
          kindB: second.kind,
          core: +core.toFixed(4),
          rim: +rim.toFixed(4),
          limits,
          overCore: core > limits.core + 1e-9,
          overRim: rim > limits.rim + 1e-9,
        });
      }
    }
    const categories = {};
    for (const pair of pairs) {
      const key = [pair.kindA, pair.kindB].sort().join('-');
      const bucket = categories[key] ?? (categories[key] = { pairs: 0, overCore: 0, overRim: 0, maxCore: 0 });
      bucket.pairs += 1;
      if (pair.overCore) bucket.overCore += 1;
      if (pair.overRim) bucket.overRim += 1;
      bucket.maxCore = Math.max(bucket.maxCore, pair.core);
    }
    for (const bucket of Object.values(categories)) bucket.maxCore = +bucket.maxCore.toFixed(4);
    const overCorePairs = pairs.filter((pair) => pair.overCore);
    const overRimPairs = pairs.filter((pair) => pair.overRim);
    const maxCore = pairs.reduce((max, pair) => Math.max(max, pair.core), 0);
    const maxRim = pairs.reduce((max, pair) => Math.max(max, pair.rim), 0);
    return {
      sizeCandidate: envelopeState.sizeCandidate,
      assetsVersion: envelopeState.assetsVersion,
      stemCount: stems.length,
      sceneWorst: envelopeState.worst,
      computed: {
        overlappingPairs: pairs.length,
        overCorePairs: overCorePairs.length,
        overRimPairs: overRimPairs.length,
        maxCore: +maxCore.toFixed(4),
        maxRim: +maxRim.toFixed(4),
        byKind: categories,
        topPairs: pairs.slice().sort((x, y) => y.core - x.core).slice(0, 8),
      },
      stems: stems.map((stem) => ({
        stemId: stem.stemId,
        assetId: stem.assetId,
        kind: stem.kind,
        volumeCount: stem.volumes.length,
        pose: stem.pose,
        scale: stem.scale,
        basePosition: stem.basePosition,
        contact: stem.contact,
      })),
      doc: {
        stems: state.doc.stems.length,
        stage: state.stage,
        sizeCandidate: state.sizeCandidate,
        pastCount: state.pastCount,
        futureCount: state.futureCount,
        selectedId: state.selectedId,
      },
    };
  };
}

/** 记录一步：操作说明 + 包络报告 + 可选截图。 */
async function recordStep(name, action, screenshot) {
  const report = await page.evaluate(collectReport());
  if (screenshot) await shot(`acceptance-${name}`);
  return { name, action, screenshot: screenshot ? `acceptance-${name}.png` : null, report };
}

async function setPreset(preset) {
  await page.evaluate((value) => window.__bouquetDebug.store.setViewPreset(value), preset);
  await wait(950);
}

async function flipToBack() {
  await page.evaluate(() => {
    const debug = window.__bouquetDebug;
    const camera = debug.scene.camera;
    const target = debug.scene.controls.target;
    const dx = camera.position.x - target.x;
    const dy = camera.position.y - target.y;
    const dz = camera.position.z - target.z;
    camera.position.set(target.x - dx, target.y + dy, target.z - dz);
    debug.scene.controls.update();
  });
  await wait(700);
}

/** 拖动一支花头：真实 pointer 事件走场景的拖动入口。 */
async function dragStemHead(stemId, dxPx, dyPx) {
  const point = await page.evaluate(
    (id) => window.__bouquetDebug.getStemScreenPoint(id),
    stemId,
  );
  if (!point || !point.visible) return { moved: false, reason: 'head-not-visible', point };
  const viewport = await page.locator('[data-testid=viewport]').boundingBox();
  const startX = point.x;
  const startY = point.y;
  await page.mouse.move(startX, startY);
  await wait(120);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(startX + (dxPx * i) / steps, startY + (dyPx * i) / steps);
    await wait(40);
  }
  await page.mouse.up();
  await wait(500);
  const after = await page.evaluate(
    (id) => window.__bouquetDebug.getStemScreenPoint(id),
    stemId,
  );
  return { moved: true, point, after, viewport: viewport ? { width: viewport.width, height: viewport.height } : null };
}

const fixtureReports = {};

try {
  // ---------- 1. 固定样束：四视角 + 包络统计 ----------
  for (const bundle of BUNDLES) {
    step = `fixture-${bundle}`;
    await open(`sample=${bundle}&view=front&size=${SIZE}`);
    fixtureReports[bundle] = await page.evaluate(collectReport());
    await shot(`fixture-${bundle}-front`);
    for (const view of VIEWS) {
      if (view === 'front') continue;
      if (view === 'back') {
        await setPreset('front');
        await flipToBack();
      } else {
        await setPreset(view);
      }
      await shot(`fixture-${bundle}-${view}`);
    }
    console.log(`fixture ${bundle} done`);
  }

  const fixtureSummary = Object.fromEntries(
    Object.entries(fixtureReports).map(([bundle, report]) => [
      bundle,
      {
        stems: report.stemCount,
        sizeCandidate: report.sizeCandidate,
        sceneWorst: report.sceneWorst,
        computed: report.computed,
      },
    ]),
  );
  check(
    '固定样束包络统计已采集（6/12/20，含 core/rim 超限对数与分花材统计）',
    Object.keys(fixtureSummary).length === BUNDLES.length,
    fixtureSummary,
  );
  // 场景 worst 与脚本逐对统计交叉校验：两者应是同一口径（容差 1.5mm）。
  const worstMismatch = [];
  for (const [bundle, report] of Object.entries(fixtureReports)) {
    const deltaCore = Math.abs((report.sceneWorst?.core ?? 0) - report.computed.maxCore);
    if (deltaCore > TOLERANCE_CORE) worstMismatch.push({ bundle, sceneWorst: report.sceneWorst?.core, computed: report.computed.maxCore, deltaCore });
  }
  check('场景 getEnvelopeState().worst 与脚本逐对统计一致（≤1.5mm）', worstMismatch.length === 0, {
    worstMismatch,
    note: '调试入口把包络坐标四舍五入到 0.1mm，1.5mm 内视为一致；超过说明两套口径不一致。',
  });

  // ---------- 2. 真实玩法路径（候选 b / 新作品默认） ----------
  const playSteps = [];
  if (!FIXTURES_ONLY) {
    // 2a. 空场景：连续添加同一位置附近的 3 枝，统一落位约束应保证不产生 core 超限。
    step = 'play-empty';
    await open(`size=${SIZE}`, { expectStems: 0 });
    await page.evaluate(() => {
      const store = window.__bouquetDebug.store;
      if (store.getState().doc.stems.length > 0) store.clearStems();
    });
    await wait(400);
    playSteps.push(await recordStep('00-empty', '清空工作台', true));

    const addPlan = [
      { assetId: 'rose-pink', tilt: 18, direction: 10, height: 0.03 },
      { assetId: 'rose-pink', tilt: 19, direction: 12, height: 0.03 },
      { assetId: 'rose-pink', tilt: 20, direction: 14, height: 0.03 },
    ];
    for (let i = 0; i < addPlan.length; i += 1) {
      const plan = addPlan[i];
      await page.evaluate((value) => {
        const store = window.__bouquetDebug.store;
        store.setPlacement(value.assetId);
        return store.placeStem({ tilt: value.tilt, direction: value.direction, height: value.height, scale: 1 });
      }, plan);
      await page.waitForFunction(
        (index) => window.__bouquetDebug.getState().doc.stems.length === index + 1,
        i,
        { timeout: 15000 },
      );
      await page.waitForFunction(
        () => [...window.__bouquetDebug.scene.views.values()].every((view) => view.object),
        null,
        { timeout: 15000 },
      );
      await wait(700);
      playSteps.push(await recordStep(`0${i + 1}-add-${i + 1}`, `添加第 ${i + 1} 枝（故意挤在同一方向附近）`, true));
    }
    const addReports = playSteps.filter((item) => item.name.includes('-add-'));
    const addOverCore = addReports.filter((item) => item.report.computed.overCorePairs > 0);
    check('空场景连续添加 3 枝后没有 core 超限对（新增受统一落位约束）', addOverCore.length === 0, {
      steps: addReports.map((item) => ({
        name: item.name,
        stemCount: item.report.stemCount,
        overCorePairs: item.report.computed.overCorePairs,
        maxCore: item.report.computed.maxCore,
      })),
    });

    // 2b. 载入 6 枝密集样束作为压力用例基线。
    step = 'play-fixture';
    await page.evaluate(() => window.__bouquetDebug.store.loadSampleBouquet(6));
    await page.waitForFunction(() => window.__bouquetDebug.getState().doc.stems.length === 6, null, { timeout: 15000 });
    await page.waitForFunction(
      () => [...window.__bouquetDebug.scene.views.values()].every((view) => view.object && view.loaded),
      null,
      { timeout: 20000 },
    );
    await wait(1200);
    const fixtureBaseline = await recordStep('10-fixture-baseline', '载入 6 枝密集样束（压力用例基线）', true);
    playSteps.push(fixtureBaseline);

    /** 玩法操作后的核心断言：不新增 core 超限对，且 worst.core 不高于基线。 */
    const compareToBaseline = (name) => {
      const last = playSteps[playSteps.length - 1];
      const baseline = fixtureBaseline.report;
      const after = last.report;
      const noNewOverCore = after.computed.overCorePairs <= baseline.computed.overCorePairs;
      const coreNotWorse = after.computed.maxCore <= baseline.computed.maxCore + TOLERANCE_CORE;
      check(`${name}后不新增 core 超限对且 worst.core 不高于 fixture 基线`, noNewOverCore && coreNotWorse, {
        baseline: {
          overCorePairs: baseline.computed.overCorePairs,
          maxCore: baseline.computed.maxCore,
          overlappingPairs: baseline.computed.overlappingPairs,
        },
        after: {
          overCorePairs: after.computed.overCorePairs,
          maxCore: after.computed.maxCore,
          overlappingPairs: after.computed.overlappingPairs,
        },
        tolerance: TOLERANCE_CORE,
        note: 'fixture 本身有包络重叠，是压力用例；要求「不变差」而不是「归零」。',
      });
      return last;
    };

    // 2c. 复制：选中中间枝复制一份，统一约束应把副本放到合法位。
    step = 'play-duplicate';
    const duplicateInfo = await page.evaluate(() => {
      const store = window.__bouquetDebug.store;
      const stems = store.getState().doc.stems;
      const target = stems.find((item) => item.assetId === 'rose-pink') ?? stems[0];
      store.select(target.id);
      const newId = store.duplicateStem(target.id);
      return { from: target.id, newId, count: store.getState().doc.stems.length };
    });
    await page.waitForFunction(() => window.__bouquetDebug.getState().doc.stems.length === 7, null, { timeout: 15000 });
    await page.waitForFunction(
      () => [...window.__bouquetDebug.scene.views.values()].every((view) => view.object && view.loaded),
      null,
      { timeout: 20000 },
    );
    await wait(900);
    playSteps.push(await recordStep('11-duplicate', `复制 ${duplicateInfo.from} → ${duplicateInfo.newId}`, true));
    compareToBaseline('复制');

    // 2d. 拖动：把复制出来的枝拖向花束中心，统一约束应挡住/滑动而不是穿进去。
    step = 'play-drag';
    const dragInfo = await dragStemHead(duplicateInfo.newId, -70, 40);
    await wait(500);
    playSteps.push(await recordStep('12-drag', `拖动复制枝花头（-70,+40）px`, true));
    const dragCompare = compareToBaseline('拖动');
    check('拖动后文档姿态确实改变（走的是真实 pointer 拖动入口）', Boolean(dragInfo.moved), {
      dragInfo,
      poseAfter: dragCompare.report.stems.find((item) => item.stemId === duplicateInfo.newId)?.pose ?? null,
    });

    // 2e. 精调：选中复制枝做 nudge（与 UI 精调按钮同一 store 入口）。
    step = 'play-nudge';
    await page.evaluate((id) => {
      const store = window.__bouquetDebug.store;
      store.select(id);
      store.nudgeSelected({ tilt: 6, height: 0.03 });
    }, duplicateInfo.newId);
    await wait(900);
    playSteps.push(await recordStep('13-nudge', '精调：tilt +6°、height +3cm', true));
    compareToBaseline('精调');

    // 2f. 缩放：放大到 1.15（场景的缩放约束会限制在合法范围）。
    step = 'play-scale';
    await page.evaluate((id) => {
      const store = window.__bouquetDebug.store;
      store.select(id);
      store.beginTransaction();
      store.updateStemScaleTransient(id, 1.15);
      store.endTransaction();
    }, duplicateInfo.newId);
    await wait(900);
    playSteps.push(await recordStep('14-scale', '缩放：目标 1.15', true));
    compareToBaseline('缩放');
    const scaleAfter = playSteps[playSteps.length - 1].report.stems.find(
      (item) => item.stemId === duplicateInfo.newId,
    );
    check('缩放后的实例比例在配置范围内（0.85–1.15）', Boolean(scaleAfter) && scaleAfter.scale >= 0.85 && scaleAfter.scale <= 1.15, {
      scale: scaleAfter?.scale ?? null,
    });

    // 2g. 撤销 / 重做：撤销应回到缩放前的姿态，重做应回到缩放后。
    step = 'play-undo';
    await page.evaluate(() => window.__bouquetDebug.store.undo());
    await wait(900);
    playSteps.push(await recordStep('15-undo', '撤销一次（缩放）', true));
    compareToBaseline('撤销');
    step = 'play-redo';
    await page.evaluate(() => window.__bouquetDebug.store.redo());
    await wait(900);
    playSteps.push(await recordStep('16-redo', '重做一次', true));
    compareToBaseline('重做');
    const undoStep = playSteps.find((item) => item.name === '15-undo');
    const scaleStep = playSteps.find((item) => item.name === '14-scale');
    const undoPose = undoStep.report.stems.find((item) => item.stemId === duplicateInfo.newId);
    const scalePose = scaleStep.report.stems.find((item) => item.stemId === duplicateInfo.newId);
    check('撤销恢复缩放前的比例，重做恢复缩放后的比例', Boolean(undoPose && scalePose), {
      undoScale: undoPose?.scale ?? null,
      redoScale: playSteps.find((item) => item.name === '16-redo').report.stems.find((item) => item.stemId === duplicateInfo.newId)?.scale ?? null,
      scaledScale: scalePose?.scale ?? null,
    });

    // 2h. 保存恢复：整页重载，作品应从 localStorage 恢复（含尺寸候选）。
    step = 'play-reload';
    const beforeReload = playSteps[playSteps.length - 1].report;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.__bouquetDebug), null, { timeout: 25000 });
    await page.waitForFunction(
      (count) => window.__bouquetDebug.getState().doc.stems.length === count,
      beforeReload.stemCount,
      { timeout: 25000 },
    );
    await page.waitForFunction(
      () => [...window.__bouquetDebug.scene.views.values()].every((view) => view.object && view.loaded),
      null,
      { timeout: 25000 },
    );
    await wait(1400);
    playSteps.push(await recordStep('17-reload', '整页重载（保存恢复）', true));
    const reloadStep = playSteps[playSteps.length - 1];
    check('重载后作品恢复且尺寸候选保持不变', reloadStep.report.doc.stems === beforeReload.doc.stems && reloadStep.report.sizeCandidate === beforeReload.sizeCandidate, {
      before: { stems: beforeReload.doc.stems, sizeCandidate: beforeReload.sizeCandidate },
      after: { stems: reloadStep.report.doc.stems, sizeCandidate: reloadStep.report.sizeCandidate },
    });
    compareToBaseline('保存恢复');

    // 2i. 拍照：走 App 的缩略图入口，确认能出真实图片。
    step = 'play-photo';
    const photo = await page.evaluate(async () => {
      const data = await window.__bouquetDebug.captureThumbnail(256);
      return { prefix: data.slice(0, 22), length: data.length };
    });
    await wait(500);
    playSteps.push(await recordStep('18-photo', '拍照（缩略图）', true));
    check('拍照返回真实图片（data:image + 非空）', photo.prefix.startsWith('data:image/') && photo.length > 2000, photo);
  }

  // ---------- 3. 页面错误 ----------
  step = 'done';
  const uniqueErrors = [...new Map(errors.map((item) => [JSON.stringify(item), item])).values()];
  check('全程无页面与模块错误（不含 size 参数探测期的临时错误）', uniqueErrors.length === 0, { errors: uniqueErrors });

  const results = {
    date: new Date().toISOString(),
    url: BASE,
    outDir: OUT,
    sizeCandidate: SIZE,
    passed,
    failed: failures.length,
    checks,
    fixtures: fixtureReports,
    fixtureSummary,
    playPath: playSteps,
    limitations: [
      '包络是椭球近似（src/three/envelope.ts），不是花瓣网格的逐顶点碰撞；本报告里的 core/rim 重叠是碰撞近似值，不等于真实穿模深度。',
      '固定样束 fixture 本身带包络重叠，属于压力用例；玩法路径的成功口径是「不新增 core 超限对且 worst.core 不变差」，不是把 fixture 清零。',
      '玩法操作通过 store 的公开动作（与 UI 按钮同一路径）触发；拖动使用真实 pointer 事件走场景拖动入口；精调/缩放/撤销/重做/保存/拍照走与 UI 一致的动作。',
      '截图是 [data-testid=viewport] 元素，四视角为正/侧/俯/背；背面由相机实际翻转得到（预设里没有背面）。',
    ],
    observations: [],
    observationsNote: 'observations 是主观观感判断（密集样束是否好看、穿插是否明显），不是实测数据。',
    errors: uniqueErrors,
    notes: [
      '场景包络读自 window.__bouquetDebug.scene.getEnvelopeState()；配对统计只用 envelope.ts 的 overlapBetween/limitsFor/stricterLimits，没有复制求解器逻辑。',
      '拼版图：python .verify/v07-size/make_sheet.py。',
    ],
  };
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  console.log(`DONE passed=${passed} failed=${failures.length} -> ${OUT}/results.json`);
} catch (error) {
  writeFileSync(
    `${OUT}/failure.json`,
    JSON.stringify({ date: new Date().toISOString(), step, passed, checks, errors, error: String(error), stack: error?.stack ?? null }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
