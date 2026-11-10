/**
 * V16 §3 整理功能验收（真实页面，dev server）。
 *
 * 覆盖：
 * 1) 可翻瓣花材（玫瑰）出现「可翻瓣」标签，三档 + 一键翻瓣写进 store，三维花头几何真的形变；
 * 2) 去刺只对玫瑰出现，状态可恢复，三维刺随状态显隐（含淡出）；
 * 3) 整束整理一次撤销（Ctrl+Z 回到整理前），「恢复整理前」也能回到同一状态；
 * 4) 适用容器花泥：放入 / 按内腔裁切 / 适配枝脚，document 与三维花泥状态一致；换透明花瓶不遗留花泥；
 * 5) 非玫瑰花材不出现翻瓣/去刺按钮（不显示假操作）；
 * 6) 旧 trim testid（trim-mode / trim-stem / trim-leaf-0..2）行为不回归。
 *
 * 运行：cd app && node scripts/v16-organize.mjs
 * 截图与结果：app/.verify/v16-organize/
 */

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { newStudioAwarePage } from './studio-page.mjs';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.SMOKE_OUT ?? '.verify/v16-organize';
mkdirSync(OUT, { recursive: true });

let count = 0;
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`);
  count += 1;
  console.log('ok', name, detail === undefined ? '' : JSON.stringify(detail));
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: process.env.HEADED !== '1',
  args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 2 });
const page = await newStudioAwarePage(context);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
});
const wait = (ms) => page.waitForTimeout(ms);
const state = () => page.evaluate(() => window.__bouquetDebug.getState());
const organize = () => page.evaluate(() => window.__bouquetDebug.scene.getOrganizeState());
const foamDebug = () => page.evaluate(() => window.__bouquetDebug.scene.getFoamDebug());
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
/** 搭配提示条会盖住顶部阶段按钮：先关掉它，保证点击落到真实控件上。 */
async function dismissHints() {
  const dismiss = page.getByTestId('mix-hint-dismiss');
  if (await dismiss.count()) {
    await dismiss.click({ timeout: 3000 }).catch(() => {});
    await wait(200);
  }
}
/** 等所有花枝的 3D 对象都加载出来（生产包也可能慢）。 */
const waitMeshes = () =>
  page.waitForFunction(() => {
    const d = window.__bouquetDebug;
    if (!d?.scene) return false;
    const views = [...d.scene.views.values()];
    return views.length > 0 && views.every((v) => v.object);
  }, null, { timeout: 90000 });

/** 花头「可见几何」的实测外观（米）：外接半径与高度，用可见索引顶点，避开已裁掉的顶点。 */
const headShape = (stemIndex = 0) => page.evaluate((stemIndex) => {
  const d = window.__bouquetDebug;
  const stem = d.getState().doc.stems[stemIndex];
  const view = d.scene.views.get(stem.id);
  const head = view?.object?.getObjectByName('original-flower-head');
  if (!head) return null;
  const position = head.geometry.getAttribute('position');
  const index = head.geometry.index;
  const count = index?.count ?? position.count;
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  let minY = Infinity; let maxY = -Infinity;
  let radius = 0; let cx = 0; let cz = 0;
  const xs = []; const zs = [];
  for (let i = 0; i < count; i += 3) {
    const v = index ? index.getX(i) : i;
    const x = position.getX(v); const y = position.getY(v); const z = position.getZ(v);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    xs.push(x); zs.push(z);
  }
  cx = (minX + maxX) / 2; cz = (minZ + maxZ) / 2;
  for (let i = 0; i < xs.length; i += 1) radius = Math.max(radius, Math.hypot(xs[i] - cx, zs[i] - cz));
  return { radius: +radius.toFixed(4), height: +(maxY - minY).toFixed(4), centerX: +cx.toFixed(4) };
}, stemIndex);

/** 花头在屏幕上的位置，用于截特写。 */
const stemPoint = (stemIndex = 0) => page.evaluate((stemIndex) => {
  const d = window.__bouquetDebug;
  const stem = d.getState().doc.stems[stemIndex];
  return d.getStemScreenPoint(stem.id);
}, stemIndex);

const clipAround = (pt, dx, dy, w, h) => ({
  x: Math.max(0, Math.round(pt.x + dx)),
  y: Math.max(0, Math.round(pt.y + dy)),
  width: Math.round(w),
  height: Math.round(h),
});

try {
  await page.goto(URL);
  await wait(1200);
  if (await page.getByTestId('start-continue').count()) {
    await page.getByTestId('start-continue').click();
    await wait(500);
  }
  if (await page.getByTestId('start-new').count()) {
    await page.getByTestId('start-new').click();
    await wait(500);
  }
  await page.waitForFunction(() => Boolean(window.__bouquetDebug?.getState), null, { timeout: 60000 });
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalog.mode === 'manifest', null, {
    timeout: 30000,
  });

  // ---------- 干净台面：只放一枝玫瑰 ----------
  await page.evaluate(() => {
    const s = window.__bouquetDebug.store;
    if (s.getState().doc.stems.length > 0) s.clearStems();
    s.setPresentation('paper');
    s.setStage('arrange');
    s.setPlacement('rose-pink');
    s.placeStem({ tilt: 8, direction: 20 });
    s.setPlacement(null);
    s.select(s.getState().doc.stems[0].id);
  });
  await waitMeshes();
  await wait(900);
  check('放好一枝玫瑰', (await state()).doc.stems.length === 1 && (await state()).doc.stems[0].assetId === 'rose-pink');

  // ---------- 1) 整理入口 + 翻瓣 ----------
  await page.getByTestId('near-more').click();
  await wait(400);
  check('右栏出现整理面板', (await page.getByTestId('organize-panel').count()) === 1);
  check('可翻瓣花材显示翻瓣块与「可翻瓣」标签',
    (await page.getByTestId('organize-flip-block').count()) === 1 &&
    (await page.getByTestId('organize-flip-chip').count()) === 1 &&
    (await page.getByTestId('organize-flip-chip').textContent()).includes('可翻瓣'));

  const pt = await stemPoint(0);
  check('花头在画面里可见', Boolean(pt && pt.visible));
  const headClip = clipAround(pt, -150, -110, 320, 260);
  const stemClip = clipAround(pt, -110, 60, 220, 240);

  const flip0 = await headShape();
  await page.screenshot({ path: `${OUT}/02-flip-000.png` });
  await page.screenshot({ path: `${OUT}/02-flip-000-head.png`, clip: headClip });

  // 三档手动推进：0 → 1/3 → 2/3 → 1
  await page.getByTestId('organize-flip-step').click();
  await wait(560);
  const step1 = (await state()).doc.stems[0].preparation.petalFlip;
  check('手动翻一点 = 1/3', near(step1, 1 / 3, 1e-3), step1);
  await page.screenshot({ path: `${OUT}/03-flip-033-head.png`, clip: headClip });

  await page.getByTestId('organize-flip-step').click();
  await wait(560);
  const step2 = (await state()).doc.stems[0].preparation.petalFlip;
  check('再翻一点 = 2/3', near(step2, 2 / 3, 1e-3), step2);
  await page.screenshot({ path: `${OUT}/04-flip-066-head.png`, clip: headClip });

  // 一键完成：直接到 1
  await page.getByTestId('organize-flip-full').click();
  await wait(700);
  const flipped = await state();
  const flipVisual = (await organize()).stems[0].visual;
  check('一键翻瓣写进 store（petalFlip=1）', near(flipped.doc.stems[0].preparation.petalFlip, 1));
  check('三维视觉状态同步到 petalFlip≈1', flipVisual && near(flipVisual.petalFlip, 1, 1e-3), flipVisual);
  const flip1 = await headShape();
  check('花头几何真的外翻（外观半径变大 ≥8%）',
    flip0 && flip1 && flip1.radius / flip0.radius >= 1.08,
    { before: flip0, after: flip1, ratio: flip0 ? +(flip1.radius / flip0.radius).toFixed(3) : null });
  await page.screenshot({ path: `${OUT}/05-flip-100.png` });
  await page.screenshot({ path: `${OUT}/05-flip-100-head.png`, clip: headClip });

  // 恢复原样
  await page.getByTestId('organize-flip-reset').click();
  await wait(700);
  const reset = await state();
  const resetShape = await headShape();
  check('恢复原样把 petalFlip 写回 0', near(reset.doc.stems[0].preparation.petalFlip, 0));
  check('恢复原样后花头几何回到原尺寸（误差 ≤1.5%）',
    flip0 && resetShape && Math.abs(resetShape.radius / flip0.radius - 1) <= 0.015,
    { before: flip0, reset: resetShape });

  // ---------- 2) 去刺 ----------
  check('玫瑰显示去刺块', (await page.getByTestId('organize-thorn-block').count()) === 1);
  const thornsOn = (await organize()).stems[0].visual.thorns;
  check('初始带刺且三维刺存在', thornsOn.visible === true && thornsOn.count >= 5, thornsOn);
  await page.screenshot({ path: `${OUT}/06-thorns-on.png`, clip: stemClip });

  await page.getByTestId('organize-dethorn').click();
  await wait(700);
  const thornState = await state();
  const thornsOff = (await organize()).stems[0].visual.thorns;
  check('去刺后 thornsRemoved=true', thornState.doc.stems[0].preparation.thornsRemoved === true);
  check('三维刺隐藏（淡出后 visible=false）', thornsOff.visible === false, thornsOff);
  await page.screenshot({ path: `${OUT}/07-thorns-off.png`, clip: stemClip });

  await page.getByTestId('organize-restore-thorns').click();
  await wait(700);
  const thornsBack = (await organize()).stems[0].visual.thorns;
  const thornRestored = await state();
  check('恢复刺后状态与三维都回来',
    thornRestored.doc.stems[0].preparation.thornsRemoved === false && thornsBack.visible === true,
    thornsBack);

  // ---------- 6) 旧 trim testid 不回归 ----------
  check('旧 trim testid 都在',
    (await page.getByTestId('trim-mode').count()) === 1 &&
    (await page.getByTestId('trim-stem').count()) === 1 &&
    (await page.getByTestId('trim-leaf-0').count()) === 1 &&
    (await page.getByTestId('trim-leaf-1').count()) === 1 &&
    (await page.getByTestId('trim-leaf-2').count()) === 1);
  const tailBefore = (await state()).doc.stems[0].preparation.tailLength;
  await page.getByTestId('trim-stem').click();
  await wait(250);
  const tailAfter = (await state()).doc.stems[0].preparation.tailLength;
  check('剪短 2 cm 仍按老行为生效', near(tailAfter, tailBefore - 0.02, 1e-4), { tailBefore, tailAfter });
  await page.evaluate(() => window.__bouquetDebug.store.undo());
  await wait(250);
  check('撤销后茎长恢复', near((await state()).doc.stems[0].preparation.tailLength, tailBefore, 1e-4));

  await page.getByTestId('trim-leaf-2').click();
  await wait(250);
  check('剪叶按钮仍生效', (await state()).doc.stems[0].preparation.removedLeaves.includes(2));
  await page.evaluate(() => window.__bouquetDebug.store.undo());
  await wait(250);
  check('撤销后叶片恢复', !(await state()).doc.stems[0].preparation.removedLeaves.includes(2));

  // ---------- 5) 非玫瑰花材不出现翻瓣/去刺 ----------
  await page.evaluate(() => {
    const s = window.__bouquetDebug.store;
    s.setPlacement('tulip-cream');
    s.placeStem({ tilt: 14, direction: 210 });
    s.setPlacement(null);
    s.select(s.getState().doc.stems[1].id);
  });
  await waitMeshes();
  await wait(700);
  const tulipEntry = await page.evaluate(() => {
    const d = window.__bouquetDebug;
    const stem = d.getState().doc.stems[1];
    return d.getState().catalog.entriesById[stem.assetId]?.family ?? '';
  });
  check('第二枝是郁金香', tulipEntry === 'tulip', tulipEntry);
  check('非玫瑰不显示翻瓣块', (await page.getByTestId('organize-flip-block').count()) === 0);
  check('非玫瑰不显示去刺块', (await page.getByTestId('organize-thorn-block').count()) === 0);
  const summary = await page.getByTestId('organize-stem-summary').textContent();
  check('非玫瑰的整理摘要不承诺翻瓣/去刺', !/翻瓣|去刺/.test(summary ?? ''), summary);
  await page.screenshot({ path: `${OUT}/08-non-rose-panel.png` });

  // ---------- 3) 整束整理：一次撤销 + 恢复整理前 ----------
  await page.evaluate(() => window.__bouquetDebug.store.select(null));
  await wait(300);
  await dismissHints();
  await page.getByTestId('flower-organize').click();
  await wait(400);
  check('未选中时打开整束整理', (await page.getByTestId('organize-bouquet').count()) === 1);
  check('整束整理显示影响范围', (await page.getByTestId('organize-bouquet-lead').textContent()).length > 10);
  const scopeText = await page.getByTestId('organize-scope').textContent();
  check('影响范围写明不含翻瓣', scopeText.includes('不含翻瓣'), scopeText);
  await page.screenshot({ path: `${OUT}/09-bouquet-panel.png` });

  const beforeOrganize = JSON.stringify((await state()).doc.stems.map((s) => s.preparation));
  await page.getByTestId('organize-bouquet').click();
  await wait(600);
  const organized = (await state()).doc.stems.map((s) => s.preparation);
  check('整束整理写了可保存状态', organized.some((p) => p.autoTrim === true), organized);
  check('整束整理不动翻瓣', organized.every((p) => (p.petalFlip ?? 0) === 0), organized);
  await page.keyboard.press('Control+z');
  await wait(500);
  const afterUndo = JSON.stringify((await state()).doc.stems.map((s) => s.preparation));
  check('整束整理一次 Ctrl+Z 回到整理前', afterUndo === beforeOrganize, { beforeOrganize: JSON.parse(beforeOrganize), afterUndo: JSON.parse(afterUndo) });

  await page.getByTestId('organize-bouquet').click();
  await wait(600);
  await page.getByTestId('organize-restore').click();
  await wait(600);
  const afterRestore = JSON.stringify((await state()).doc.stems.map((s) => s.preparation));
  check('「恢复整理前」回到同一状态', afterRestore === beforeOrganize, { beforeOrganize: JSON.parse(beforeOrganize), afterRestore: JSON.parse(afterRestore) });

  // ---------- 4) 花篮花泥三步 + 换透明花瓶不遗留 ----------
  await dismissHints();
  await page.getByTestId('stage-wrap').click();
  await wait(500);
  await page.getByTestId('presentation-basket').click();
  await page.getByTestId('confirm-presentation').click();
  await wait(1200);
  check('切到藤编花篮', (await state()).doc.presentation.kind === 'basket');
  check('花篮不遗留旧花泥', (await state()).doc.presentation.foam.fitted === false);

  await page.getByTestId('stage-arrange').click();
  await wait(500);
  await dismissHints();
  await page.getByTestId('flower-organize').click();
  await wait(500);
  check('适用容器显示花泥块', (await page.getByTestId('organize-foam').count()) === 1);
  check('未放入时无三维花泥', ((await foamDebug())?.exists ?? false) === false);

  await page.getByTestId('organize-foam-place').click();
  await wait(1400);
  const placed = await state();
  const placedDebug = await foamDebug();
  check('放入花泥：document fitted=true/cut=0',
    placed.doc.presentation.foam.fitted === true && placed.doc.presentation.foam.cut === 0,
    placed.doc.presentation.foam);
  check('放入花泥：三维花泥存在且可见',
    Boolean(placedDebug && placedDebug.exists && placedDebug.visible && placedDebug.fitted === true),
    placedDebug);
  check('花泥在容器内壁之内（wallGap > 0）', Boolean(placedDebug && placedDebug.wallGap > 0.005), placedDebug);
  await page.screenshot({ path: `${OUT}/10-foam-placed.png` });

  await page.getByTestId('organize-foam-cut').click();
  await wait(1400);
  const cut = await state();
  const cutDebug = await foamDebug();
  check('裁切花泥：document cut=1', cut.doc.presentation.foam.fitted === true && cut.doc.presentation.foam.cut === 1);
  check('裁切后三维花泥落得更贴合（顶面降低、半径收小）',
    Boolean(cutDebug && placedDebug && cutDebug.exists && cutDebug.topY < placedDebug.topY - 0.005 && cutDebug.radius < placedDebug.radius),
    { before: placedDebug, after: cutDebug });
  await page.screenshot({ path: `${OUT}/11-foam-cut.png` });

  const afterFitBasket = (await state()).doc.stems.map((s) => s.preparation.tailLength);
  await page.getByTestId('organize-foam-fit').click();
  await wait(600);
  const fitDebug = await foamDebug();
  check('花篮下适配枝脚后余茎仍按容器口径收齐（0.10 m）',
    afterFitBasket.every((tail) => near(tail, 0.1, 0.006)) && Boolean(fitDebug && fitDebug.exists),
    { afterFitBasket, fitDebug });

  // 抱抱桶的余茎口径更长（0.18 m）：放入花泥会先收到 0.14，「适配枝脚」再收回容器口径。
  await dismissHints();
  await page.getByTestId('stage-wrap').click();
  await wait(500);
  await page.getByTestId('presentation-bucket').click();
  await page.getByTestId('confirm-presentation').click();
  await wait(1200);
  check('切到抱抱桶（另一种适用花泥的容器）', (await state()).doc.presentation.kind === 'bucket');
  await dismissHints();
  await page.getByTestId('stage-arrange').click();
  await wait(500);
  await dismissHints();
  await page.getByTestId('flower-organize').click();
  await wait(500);
  const bucketInitial = await state();
  check('抱抱桶初始余茎为容器口径 0.18 m',
    bucketInitial.doc.stems.every((s) => near(s.preparation.tailLength, 0.18, 0.01)),
    bucketInitial.doc.stems.map((s) => s.preparation.tailLength));
  check('换到同样适用花泥的容器时花泥状态延续（重新按新内腔适配）',
    bucketInitial.doc.presentation.foam.fitted === true,
    bucketInitial.doc.presentation.foam);
  // 取出 → 再放入：放入会把枝脚先收短到 0.14，「适配枝脚」再收齐到抱抱桶口径 0.18。
  await page.getByTestId('organize-foam-remove').click();
  await wait(700);
  check('取出花泥后 document fitted=false', (await state()).doc.presentation.foam.fitted === false);
  await page.getByTestId('organize-foam-place').click();
  await wait(900);
  const afterPlaceBucket = (await state()).doc.stems.map((s) => s.preparation.tailLength);
  check('放入花泥先把枝脚收到 0.14 m', afterPlaceBucket.every((tail) => near(tail, 0.14, 0.006)), afterPlaceBucket);
  await page.getByTestId('organize-foam-cut').click();
  await wait(900);
  await page.getByTestId('organize-foam-fit').click();
  await wait(700);
  const afterFitBucket = (await state()).doc.stems.map((s) => s.preparation.tailLength);
  const fitBucketDebug = await foamDebug();
  check('适配枝脚把余茎按容器口径收齐并保留花泥',
    afterFitBucket.every((tail) => near(tail, 0.18, 0.008)) && Boolean(fitBucketDebug && fitBucketDebug.exists),
    { afterFitBucket, fitBucketDebug });
  await page.screenshot({ path: `${OUT}/11b-bucket-fit.png` });

  // 换成透明花瓶：不塞花泥、不遗留
  await dismissHints();
  await page.getByTestId('stage-wrap').click();
  await wait(500);
  await page.getByTestId('presentation-vase').click();
  await page.getByTestId('confirm-presentation').click();
  await wait(1200);
  check('切到透明花瓶', (await state()).doc.presentation.kind === 'vase');
  await page.getByTestId('stage-arrange').click();
  await wait(500);
  await dismissHints();
  await page.getByTestId('flower-organize').click();
  await wait(500);
  const vaseFoam = await state();
  const vaseDebug = await foamDebug();
  check('花瓶下 foam.fitted=false（不遗留花泥）', vaseFoam.doc.presentation.foam.fitted === false, vaseFoam.doc.presentation.foam);
  check('花瓶下没有三维花泥', ((vaseDebug?.exists ?? false) === false) && ((vaseDebug?.visible ?? false) === false), vaseDebug);
  check('花瓶形态不显示花泥操作', (await page.getByTestId('organize-foam').count()) === 0);
  await page.screenshot({ path: `${OUT}/12-vase-no-foam.png` });

  // ---------- 非 prepared 花材的下部茎裁剪：真实资产结论 + 裁剪算法自检 ----------
  if (URL.includes(':5173')) {
    const trimProbe = await page.evaluate(async () => {
      const mod = await import('/src/three/assets/organize-visuals.ts');
      const d = window.__bouquetDebug;
      const s = d.store;
      s.setPresentation('paper');
      s.setPlacement('daisy-gold');
      s.placeStem({ tilt: 6, direction: 0 });
      s.setPlacement(null);
      const stem = s.getState().doc.stems[s.getState().doc.stems.length - 1];
      // 对象可能还在异步加载
      for (let i = 0; i < 200; i += 1) {
        if (d.scene.views.get(stem.id)?.object) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const obj = d.scene.views.get(stem.id)?.object;
      if (!obj) return { error: 'daisy mesh not loaded' };
      const indexCount = () => {
        let total = 0;
        obj.traverse((o) => {
          if (o.isMesh && o.name !== 'organize-trim-cap') total += o.geometry.index?.count ?? 0;
        });
        return total;
      };
      // 一次同步执行完，避免下一条 store 同步（applyStemTransform 用生产 tailLength）把裁剪结果恢复掉。
      const natural = mod.applyLowerStemTrim(obj, 'paper', 0.22, 'daisy');
      const before = indexCount();
      const forced = mod.applyLowerStemTrim(obj, 'paper', 0.006, 'daisy');
      const after = indexCount();
      const capExists = Boolean(obj.getObjectByName('organize-trim-cap'));
      const restored = mod.applyLowerStemTrim(obj, 'paper', 0.22, 'daisy');
      const afterRestore = indexCount();
      const capAfterRestore = Boolean(obj.getObjectByName('organize-trim-cap'));
      return { natural, forced, restored, before, after, afterRestore, capExists, capAfterRestore };
    });
    check('真实资产核对：非 prepared 花材没有多余茎尾（裁剪如实返回状态）',
      trimProbe && trimProbe.natural && trimProbe.natural.applied === false && trimProbe.natural.reason === 'no-surplus-stem',
      trimProbe?.natural);
    check('三角形裁剪 + 收口盖片算法本身可用（裁掉下部茎段、可恢复）',
      Boolean(trimProbe && trimProbe.forced && trimProbe.forced.applied === true &&
        trimProbe.forced.trimmedMeshes >= 1 && trimProbe.capExists === true &&
        trimProbe.after < trimProbe.before &&
        trimProbe.restored.applied === false && trimProbe.afterRestore === trimProbe.before &&
        trimProbe.capAfterRestore === false),
      trimProbe);
    await page.screenshot({ path: `${OUT}/13-non-prepared-trim-probe.png` });
  } else {
    console.log('SKIP direct module assertion for lower-stem trim: production has no /src');
  }

  // ---------- 收尾 ----------
  check('无页面脚本错误', errors.length === 0, errors);
  writeFileSync(
    `${OUT}/results.json`,
    JSON.stringify({ date: new Date().toISOString(), url: URL, passed: count, checks, errors }, null, 2),
  );
  console.log(`PASSED ${count}`);
} catch (error) {
  writeFileSync(
    `${OUT}/failure.json`,
    JSON.stringify({ date: new Date().toISOString(), url: URL, passed: count, checks, error: String(error), errors }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
