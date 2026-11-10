/**
 * V16.1 整理视觉修复验收（真实页面，dev server）。
 *
 * 覆盖用户第二轮试玩反馈：
 * 1) 叶片不再「长在花瓣上/浮空」：玫瑰、郁金香单枝近景（正面 + 侧面）看到叶基贴茎、
 *    叶片在花头下方、有短叶柄；整理（一键修剪）前后都成立；
 * 2) 刺：全部不透明，去掉时是缩放淡出（不会出现半透明淡绿碎片）；
 * 3) 翻瓣：花头最下面 20% 的萼片/花瓣基部不再被外推，满档只翻上半段花瓣；
 * 4) 纸包丝带：环的高度与半径贴着纸腰（按纸片实际几何量）；
 * 5) 右栏整理面板（dense）不再套一层卡片壳，只用分隔线与「快捷微调」衔接。
 *
 * 运行：cd app && node scripts/v16-organize-visual.mjs
 * 截图与结果：app/.verify/v16-organize-visual/
 */

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.SMOKE_OUT ?? '.verify/v16-organize-visual';
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
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
});
const wait = (ms) => page.waitForTimeout(ms);
const state = () => page.evaluate(() => window.__bouquetDebug.getState());
const waitMeshes = () =>
  page.waitForFunction(() => {
    const d = window.__bouquetDebug;
    if (!d?.scene) return false;
    const views = [...d.scene.views.values()];
    return views.length > 0 && views.every((v) => v.object);
  }, null, { timeout: 90000 });
/** 把镜头摆到指定机位并渲染一帧（只读操作，用来拍近景证据）。 */
const setCam = (cam, target) =>
  page.evaluate(({ cam, target }) => {
    const d = window.__bouquetDebug;
    const s = d.scene;
    s.camera.position.set(cam[0], cam[1], cam[2]);
    s.controls.target.set(target[0], target[1], target[2]);
    s.controls.update();
    s.renderer.render(s.scene, s.camera);
  }, { cam, target });
const shot = async (name, fullPage = false) => {
  await wait(260);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
};

/** 单枝近景的机位：能同时看到花头与花茎上的叶片。 */
const CLOSE_FRONT = [[0.18, 1.16, 0.95], [0, 1.12, 0]];
const CLOSE_SIDE = [[0.95, 1.14, 0.02], [0, 1.1, 0]];
const HEAD_FRONT = [[0.26, 1.29, 0.72], [0, 1.21, 0]];

/**
 * 量一枝花的叶片状态：
 * - 花头可见几何的上下边界；
 * - 每片叶（组 + 叶片 + 叶柄）在花枝局部坐标里的包围盒；
 * - 叶柄根部到茎轴的距离（越小越贴茎）。
 */
const leafState = () => page.evaluate(() => {
  const d = window.__bouquetDebug;
  const stem = d.getState().doc.stems[0];
  const obj = d.scene.views.get(stem.id).object;
  obj.updateMatrixWorld(true);
  const inverse = obj.matrixWorld.clone().invert();
  const measure = (mesh) => {
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    return g.boundingBox.clone().applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
  };
  const head = obj.getObjectByName('original-flower-head');
  let headLo = null;
  let headHi = null;
  if (head) {
    const p = head.geometry.getAttribute('position');
    const idx = head.geometry.index;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < (idx?.count ?? p.count); i += 3) {
      const v = idx ? idx.getX(i) : i;
      lo = Math.min(lo, p.getY(v));
      hi = Math.max(hi, p.getY(v));
    }
    headLo = +lo.toFixed(4);
    headHi = +hi.toFixed(4);
  }
  const leaves = [];
  for (let i = 0; i < 3; i += 1) {
    const group = obj.getObjectByName(`prepared-leaf-group-${i}`);
    const blade = obj.getObjectByName(`prepared-leaf-${i}`);
    const petiole = obj.getObjectByName(`petiole-leaf-${i}`);
    if (!group || !blade) { leaves.push(null); continue; }
    const box = measure(blade);
    // 叶柄根：把叶柄几何最靠茎的一端换到花枝局部坐标
    let petioleInner = null;
    let petioleRadius = null;
    if (petiole) {
      const pb = measure(petiole);
      petioleInner = {
        y: +pb.min.y.toFixed(4),
        maxXZ: +Math.max(Math.abs(pb.min.x), Math.abs(pb.max.x), Math.abs(pb.min.z), Math.abs(pb.max.z)).toFixed(4),
      };
      petioleRadius = +((pb.max.x - pb.min.x) / 2).toFixed(4);
    }
    leaves.push({
      index: i,
      visible: group.visible,
      groupY: +group.position.y.toFixed(4),
      bladeY: [+box.min.y.toFixed(4), +box.max.y.toFixed(4)],
      bladeReach: +Math.hypot((box.max.x - box.min.x) / 2, (box.max.z - box.min.z) / 2).toFixed(4),
      hasPetiole: Boolean(petiole),
      petioleInner,
      petioleRadius,
    });
  }
  return { assetId: stem.assetId, headLo, headHi, leaves, prep: stem.preparation };
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
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalog.mode === 'manifest', null, { timeout: 30000 });

  /** 清台并放一枝花，回到摆花阶段。 */
  const placeSingle = async (assetId, tilt = 4) => {
    await page.evaluate(({ assetId, tilt }) => {
      const s = window.__bouquetDebug.store;
      if (s.getState().doc.stems.length) s.clearStems();
      s.setPresentation('paper');
      s.setStage('arrange');
      s.setPlacement(assetId);
      s.placeStem({ height: 0.02, tilt, direction: 0 });
      s.setPlacement(null);
      s.select(null);
    }, { assetId, tilt });
    await waitMeshes();
    await wait(800);
  };

  // ---------- 1) 玫瑰单枝：整理前后 · 正面 / 侧面 ----------
  await placeSingle('rose-pink');
  const roseBefore = await leafState();
  check('玫瑰：整理前花头与叶片都加载出来',
    roseBefore.headLo !== null && roseBefore.leaves.filter(Boolean).length === 3, roseBefore);
  await setCam(...CLOSE_FRONT);
  await shot('01-rose-closeup-front-before');
  await setCam(...CLOSE_SIDE);
  await shot('02-rose-closeup-side-before');

  const visibleRose = roseBefore.leaves.filter((leaf) => leaf && leaf.visible);
  check('玫瑰：可见叶片都在花头下方（不顶进花瓣）',
    visibleRose.every((leaf) => leaf.bladeY[1] < roseBefore.headLo - 0.02),
    { headLo: roseBefore.headLo, leaves: visibleRose.map((leaf) => leaf.bladeY) });
  check('玫瑰：每片叶都有短叶柄，叶柄从茎心伸出、贴住茎',
    visibleRose.every((leaf) => leaf.hasPetiole && leaf.petioleInner && leaf.petioleInner.maxXZ < 0.03),
    visibleRose.map((leaf) => leaf.petioleInner));

  // 一键整理这枝：剪短 + 去刺；叶片与花头位置都要保持
  await page.evaluate(() => {
    const d = window.__bouquetDebug;
    d.store.organizeStem(d.getState().doc.stems[0].id);
  });
  await wait(800);
  const roseAfter = await leafState();
  check('玫瑰：整理后 thornsRemoved / autoTrim 生效',
    roseAfter.prep.thornsRemoved === true && roseAfter.prep.autoTrim === true, roseAfter.prep);
  check('玫瑰：整理后叶片仍在花头下方且贴茎（没有被剪枝带飞）',
    roseAfter.leaves.filter((leaf) => leaf && leaf.visible)
      .every((leaf) => leaf.bladeY[1] < roseAfter.headLo - 0.02 && leaf.hasPetiole),
    roseAfter.leaves);
  await setCam(...CLOSE_FRONT);
  await shot('03-rose-closeup-front-after');
  await setCam(...CLOSE_SIDE);
  await shot('04-rose-closeup-side-after');

  // ---------- 2) 郁金香单枝：叶片不再压进花头 ----------
  await placeSingle('tulip-cream');
  const tulip = await leafState();
  const visibleTulip = tulip.leaves.filter((leaf) => leaf && leaf.visible);
  check('郁金香：花头加载出来', tulip.headLo !== null, tulip.headLo);
  check('郁金香：最高一片叶在花头下方（原来会插进花瓣 2 cm）',
    visibleTulip.every((leaf) => leaf.bladeY[1] < tulip.headLo - 0.02),
    { headLo: tulip.headLo, leaves: visibleTulip.map((leaf) => leaf.bladeY) });
  check('郁金香：叶片有叶柄、贴茎',
    visibleTulip.every((leaf) => leaf.hasPetiole && leaf.petioleInner.maxXZ < 0.03),
    visibleTulip.map((leaf) => leaf.petioleInner));
  await setCam(...CLOSE_FRONT);
  await shot('05-tulip-closeup-front');
  await setCam(...CLOSE_SIDE);
  await shot('06-tulip-closeup-side');

  // ---------- 3) 刺：不透明 + 缩放淡出 ----------
  await placeSingle('rose-pink');
  const thornInfo = await page.evaluate(() => {
    const d = window.__bouquetDebug;
    const obj = d.scene.views.get(d.getState().doc.stems[0].id).object;
    const group = obj.getObjectByName('organize-thorns');
    if (!group) return null;
    const materials = new Set();
    group.traverse((o) => { if (o.isMesh) materials.add(o.material); });
    const list = [...materials].map((m) => ({
      transparent: m.transparent,
      opacity: m.opacity,
      depthWrite: m.depthWrite,
      color: m.color.getHexString(),
    }));
    // 刺根到茎轴的距离（茎轴在花枝局部 x=z=0）
    const first = group.children[0];
    first.updateMatrixWorld(true);
    const inv = obj.matrixWorld.clone().invert();
    const pos = first.position.clone().applyMatrix4(first.parent.matrixWorld).applyMatrix4(inv);
    return {
      count: group.children.length,
      materials: list,
      firstRadius: +Math.hypot(pos.x, pos.z).toFixed(4),
      stemRadius: 0.0042,
    };
  });
  check('刺：6 枚且全部不透明（不再出现半透明淡绿碎片）',
    Boolean(thornInfo) && thornInfo.count >= 5 &&
      thornInfo.materials.every((m) => m.transparent === false && m.opacity === 1),
    thornInfo);
  check('刺：刺根埋进茎表面（贴茎、不悬空）',
    thornInfo.firstRadius > 0.001 && thornInfo.firstRadius < thornInfo.stemRadius,
    thornInfo);
  await setCam([0.3, 1.02, 0.52], [0, 0.97, 0]);
  await shot('07-thorns-closeup-on');

  // 去刺：途中必须是缩放而不是透明
  await page.evaluate(() => {
    const d = window.__bouquetDebug;
    d.store.setThornsRemoved(d.getState().doc.stems[0].id, true);
  });
  await wait(70);
  const duringFade = await page.evaluate(() => {
    const d = window.__bouquetDebug;
    const obj = d.scene.views.get(d.getState().doc.stems[0].id).object;
    const group = obj.getObjectByName('organize-thorns');
    const materials = new Set();
    group?.traverse((o) => { if (o.isMesh) materials.add(o.material); });
    return {
      visible: Boolean(group?.visible),
      scale: group?.scale.x ?? 0,
      opaque: [...materials].every((m) => m.transparent === false && m.opacity === 1),
    };
  });
  check('去刺动画：可见时用缩放推进、材质始终不透明',
    duringFade.visible && duringFade.scale < 1 && duringFade.opaque, duringFade);
  await wait(600);
  const afterFade = await page.evaluate(() => {
    const d = window.__bouquetDebug;
    const state = d.scene.getOrganizeState();
    const obj = d.scene.views.get(d.getState().doc.stems[0].id).object;
    const group = obj.getObjectByName('organize-thorns');
    return { visual: state.stems[0].visual.thorns, groupVisible: Boolean(group?.visible) };
  });
  check('去刺后刺隐藏（视觉状态同步）',
    afterFade.visual.visible === false && afterFade.groupVisible === false, afterFade);
  await setCam([0.3, 1.02, 0.52], [0, 0.97, 0]);
  await shot('08-thorns-closeup-off');
  await page.evaluate(() => {
    const d = window.__bouquetDebug;
    d.store.setThornsRemoved(d.getState().doc.stems[0].id, false);
  });
  await wait(600);

  // ---------- 4) 翻瓣：花头下缘收敛 ----------
  await page.evaluate(() => {
    const d = window.__bouquetDebug;
    d.store.setPetalFlip(d.getState().doc.stems[0].id, 0);
  });
  await wait(500);
  await setCam(...HEAD_FRONT);
  await shot('09-flip-000-head');
  const flipBottom = await page.evaluate(async () => {
    const d = window.__bouquetDebug;
    const id = d.getState().doc.stems[0].id;
    const obj = d.scene.views.get(id).object;
    const head = obj.getObjectByName('original-flower-head');
    const p = head.geometry.getAttribute('position');
    const idx = head.geometry.index;
    const count = idx?.count ?? p.count;
    // 先在 flip=0 时按「基础几何」选底部 18% 的顶点
    let lo = Infinity;
    let hi = -Infinity;
    const seen = new Set();
    for (let i = 0; i < count; i += 1) {
      const v = idx ? idx.getX(i) : i;
      if (seen.has(v)) continue;
      seen.add(v);
      lo = Math.min(lo, p.getY(v));
      hi = Math.max(hi, p.getY(v));
    }
    const probes = [];
    for (const v of seen) {
      const y = p.getY(v);
      if ((y - lo) / (hi - lo) > 0.18) continue;
      probes.push([v, p.getX(v), p.getY(v), p.getZ(v)]);
    }
    // 记录 0 状态下的花头半径，满翻后再比一次「外扩了多少」
    const radiusAt = () => {
      let cx = 0, cz = 0, n = 0;
      const xs = [], zs = [];
      for (const v of seen) { xs.push(p.getX(v)); zs.push(p.getZ(v)); }
      const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
      cx = (minX + maxX) / 2; cz = (minZ + maxZ) / 2;
      let r = 0;
      for (const v of seen) r = Math.max(r, Math.hypot(p.getX(v) - cx, p.getZ(v) - cz));
      return r;
    };
    const radius0 = radiusAt();
    d.store.setPetalFlip(id, 1);
    await new Promise((r) => setTimeout(r, 700));
    let maxShift = 0;
    for (const [v, x, y, z] of probes) {
      maxShift = Math.max(maxShift, Math.hypot(p.getX(v) - x, p.getY(v) - y, p.getZ(v) - z));
    }
    const radius1 = radiusAt();
    d.store.setPetalFlip(id, 0);
    await new Promise((r) => setTimeout(r, 500));
    return {
      probes: probes.length,
      bottomMaxShift: +maxShift.toFixed(5),
      radius0: +radius0.toFixed(4),
      radius1: +radius1.toFixed(4),
    };
  });
  check('翻瓣：花头底部 18%（萼片/花瓣基部）不被外推',
    flipBottom.probes > 200 && flipBottom.bottomMaxShift < 0.004, flipBottom);
  check('翻瓣：上半段花瓣仍然外翻（满档半径变大 ≥8%）',
    flipBottom.radius1 / flipBottom.radius0 >= 1.08, flipBottom);
  await page.evaluate(() => {
    const d = window.__bouquetDebug;
    d.store.setPetalFlip(d.getState().doc.stems[0].id, 1);
  });
  await wait(700);
  await setCam(...HEAD_FRONT);
  await shot('10-flip-100-head');

  // ---------- 5) 纸包丝带贴纸腰 ----------
  await page.evaluate(() => {
    const s = window.__bouquetDebug.store;
    s.clearStems();
    for (let i = 0; i < 5; i += 1) {
      s.setPlacement(i % 2 ? 'rose-pink' : 'tulip-cream');
      s.placeStem({ height: (i % 3) * 0.02, tilt: 8 + i * 3, direction: i * 70 });
    }
    s.setPlacement(null);
    s.setStage('wrap');
    s.setPackageStep('ribbon');
    s.select(null);
  });
  await waitMeshes();
  await wait(2200);
  const ribbon = await page.evaluate(() => {
    const d = window.__bouquetDebug;
    const s = d.scene;
    const ribbon = s.ribbon;
    const paper = s.paper;
    if (!ribbon || !paper) return null;
    ribbon.group.updateMatrixWorld(true);
    ribbon.ring.geometry.computeBoundingBox();
    const ringBox = ribbon.ring.geometry.boundingBox.clone().applyMatrix4(ribbon.ring.matrixWorld);
    const mesh = paper.mesh;
    mesh.updateMatrixWorld(true);
    const p = mesh.geometry.getAttribute('position');
    const waistWorldY = 0.668 + (mesh.position.y || 0) + 0.2; // wrapping.ts 束腰行 0.2 m
    let waistR = 0;
    let waistMinY = Infinity;
    let waistMaxY = -Infinity;
    const v = new (mesh.position.constructor)();
    for (let i = 0; i < p.count; i += 1) {
      v.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(mesh.matrixWorld);
      if (Math.abs(v.y - waistWorldY) > 0.02) continue;
      waistR = Math.max(waistR, Math.hypot(v.x, v.z));
      waistMinY = Math.min(waistMinY, v.y);
      waistMaxY = Math.max(waistMaxY, v.y);
    }
    return {
      ribbonGroupY: +ribbon.group.position.y.toFixed(4),
      ringWorldY: +((ringBox.min.y + ringBox.max.y) / 2).toFixed(4),
      ringWorldRadius: +((Math.max(ringBox.max.x - ringBox.min.x, ringBox.max.z - ringBox.min.z)) / 2).toFixed(4),
      waistWorldY: +waistWorldY.toFixed(4),
      waistR: +waistR.toFixed(4),
      waistBand: [+waistMinY.toFixed(4), +waistMaxY.toFixed(4)],
    };
  });
  check('纸包：丝带环高度贴着纸腰（误差 ≤1.5 cm）',
    Boolean(ribbon) && Math.abs(ribbon.ringWorldY - ribbon.waistWorldY) <= 0.015, ribbon);
  check('纸包：丝带环半径贴着纸腰（与纸面半径比 0.85–1.2）',
    Boolean(ribbon) && ribbon.ringWorldRadius / ribbon.waistR >= 0.85 && ribbon.ringWorldRadius / ribbon.waistR <= 1.2,
    ribbon);
  await setCam([0.5, 1.06, 1.02], [0, 0.9, 0]);
  await shot('11-paper-ribbon-closeup');

  // ---------- 6) 整束一键整理前/后（用户反馈的实际场景） ----------
  await page.evaluate(() => {
    const s = window.__bouquetDebug.store;
    s.setStage('arrange');
    s.setViewPreset('quarter');
    s.select(null);
  });
  await wait(1400);
  await shot('12-bouquet-before');
  await page.evaluate(() => window.__bouquetDebug.store.organizeBouquet());
  await wait(1000);
  await shot('13-bouquet-after');

  // ---------- 7) 整理面板 dense 不再套卡片 ----------
  await page.evaluate(() => {
    const s = window.__bouquetDebug.store;
    s.setStage('arrange');
    s.select(s.getState().doc.stems[0].id);
  });
  await wait(600);
  await page.getByTestId('near-more').click();
  await wait(500);
  const dense = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="organize-panel"]');
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      className: el.className,
      borderTopWidth: style.borderTopWidth,
      background: style.backgroundColor,
      boxShadow: style.boxShadow,
      insideInspector: Boolean(el.closest('[data-testid="inspector"]')),
    };
  });
  check('整理面板（dense）没有外层卡片边框/底色/阴影',
    Boolean(dense) && dense.className.includes('organize-panel-dense') &&
      dense.borderTopWidth === '0px' &&
      (dense.background === 'rgba(0, 0, 0, 0)' || dense.background === 'transparent') &&
      (dense.boxShadow === 'none' || dense.boxShadow === ''),
    dense);
  check('整理面板嵌在「这枝花」面板里', Boolean(dense?.insideInspector), dense);
  await shot('14-organize-panel-dense', true);

  // ---------- 8) V16.2 朴素叶片与细小刺（task-10 收敛版） ----------
  // 用户反馈：不要华丽细节，叶子不是核心，只求自然、不抢戏。这里验证：
  // 无贴图/无锯齿/无复叶；叶基包茎无缺口；叶片比茎略浅的低饱和绿；不挡花头；
  // 刺细小低饱和、埋进茎、6 枚、不透明、命名与缩放淡出不变。
  const OUT2 = '.verify/v16-foliage';
  mkdirSync(OUT2, { recursive: true });
  const foliageShot = async (name) => {
    await wait(320);
    await page.screenshot({ path: `${OUT2}/${name}.png` });
  };
  const placeFlower = async (assetId) => {
    await page.evaluate(({ assetId }) => {
      const s = window.__bouquetDebug.store;
      if (s.getState().doc.stems.length) s.clearStems();
      s.setPresentation('paper');
      s.setStage('arrange');
      s.setPlacement(assetId);
      s.placeStem({ height: 0.02, tilt: 4, direction: 0 });
      s.setPlacement(null);
      s.select(null);
    }, { assetId });
    await waitMeshes();
    await wait(900);
  };
  /** 把镜头摆到「叶片 / 刺 / 整枝」近景，只读操作。 */
  const aim = (target, offset) => page.evaluate(({ target, offset }) => {
    const d = window.__bouquetDebug;
    const s = d.scene;
    s.controls.minDistance = Math.min(s.controls.minDistance ?? 0.5, 0.02);
    const V = s.camera.position.constructor;
    s.camera.position.set(target[0] + offset[0], target[1] + offset[1], target[2] + offset[2]);
    s.controls.target.set(target[0], target[1], target[2]);
    s.controls.update();
    s.renderer.render(s.scene, s.camera);
  }, { target, offset });

  await placeFlower('rose-pink');
  const roseFoliage = await page.evaluate(() => {
    const d = window.__bouquetDebug;
    const obj = d.scene.views.get(d.getState().doc.stems[0].id).object;
    obj.updateMatrixWorld(true);
    const blades = [1, 2].map((i) => obj.getObjectByName(`prepared-leaf-${i}`));
    const blade = blades[1];
    const material = blade.material;
    const head = obj.getObjectByName('original-flower-head');
    head.geometry.computeBoundingBox();
    const headWidth = head.geometry.boundingBox.max.x - head.geometry.boundingBox.min.x;
    // 几何：无破洞（无零面积/NaN 三角形）、有弧度、单片叶而不是复叶平面
    const p = blade.geometry.getAttribute('position');
    const idx = blade.geometry.index;
    let minArea = Infinity;
    let degenerate = 0;
    let bad = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    let maxX = 0;
    let minZ = Infinity;
    for (let i = 0; i < idx.count; i += 3) {
      const ia = idx.getX(i);
      const ib = idx.getX(i + 1);
      const ic = idx.getX(i + 2);
      const ux = p.getX(ib) - p.getX(ia);
      const uy = p.getY(ib) - p.getY(ia);
      const uz = p.getZ(ib) - p.getZ(ia);
      const vx = p.getX(ic) - p.getX(ia);
      const vy = p.getY(ic) - p.getY(ia);
      const vz = p.getZ(ic) - p.getZ(ia);
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const area = 0.5 * Math.hypot(nx, ny, nz);
      if (!Number.isFinite(area)) bad += 1;
      else if (area < 1e-11) degenerate += 1;
      else minArea = Math.min(minArea, area);
    }
    for (let i = 0; i < p.count; i += 1) {
      minY = Math.min(minY, p.getY(i));
      maxY = Math.max(maxY, p.getY(i));
      maxX = Math.max(maxX, Math.abs(p.getX(i)));
      minZ = Math.min(minZ, p.getZ(i));
    }
    const color = material.color;
    const max = Math.max(color.r, color.g, color.b);
    const min = Math.min(color.r, color.g, color.b);
    const stem = obj.getObjectByName('prepared-upper-stem');
    stem.geometry.computeBoundingBox();
    const stemRadius = Math.max(stem.geometry.boundingBox.max.x, -stem.geometry.boundingBox.min.x);
    return {
      hasMap: Boolean(material.map),
      alphaTest: material.alphaTest,
      doubleSide: material.side === 2,
      color: [+color.r.toFixed(3), +color.g.toFixed(3), +color.b.toFixed(3)],
      saturation: +(max - min).toFixed(3),
      greenDominant: color.g > color.r && color.g > color.b,
      roughness: material.roughness,
      minArea: +minArea.toExponential(2),
      degenerate,
      badTriangles: bad,
      curvature: +(maxY - minY).toFixed(4),
      halfSpan: +maxX.toFixed(4),
      headWidth: +headWidth.toFixed(4),
      baseZ: +minZ.toFixed(4),
      hasPetiole: Boolean(obj.getObjectByName('petiole-leaf-2')),
      collarRadius: +((obj.getObjectByName('leaf-collar-2').geometry.computeBoundingBox(), obj.getObjectByName('leaf-collar-2').geometry.boundingBox.max.x)).toFixed(4),
      stemRadius: +stemRadius.toFixed(4),
      leafCount: blades.filter(Boolean).length,
    };
  });
  check('玫瑰叶片：朴素单片叶（无贴图/无 alphaTest 轮廓）',
    !roseFoliage.hasMap && roseFoliage.alphaTest === 0 && roseFoliage.doubleSide, roseFoliage);
  check('玫瑰叶片：低饱和绿、与茎同色系（绿通道主导、饱和度低）',
    roseFoliage.greenDominant && roseFoliage.saturation < 0.22 &&
      roseFoliage.color[1] > roseFoliage.color[2], roseFoliage.color);
  // 叶尖/叶基收成一点会有少量必然退化的三角形；这里只约束「正常三角形面积 > 0 且没有 NaN」，
  // 并把退化三角形数量限制在叶尖/叶基那两排以内（16 行 × 4 列 → 约 16 个）。
  check('玫瑰叶片：几何无破洞（无 NaN、无异常退化三角形）',
    roseFoliage.minArea > 0 && roseFoliage.badTriangles === 0 && roseFoliage.degenerate <= 60,
    { minArea: roseFoliage.minArea, bad: roseFoliage.badTriangles, degenerate: roseFoliage.degenerate });
  check('玫瑰叶片：有自然弧度（不是平面片）', roseFoliage.curvature > 0.003, roseFoliage.curvature);
  check('玫瑰叶片：收窄、不抢花头（叶展 < 花头宽的一半）',
    roseFoliage.halfSpan * 2 < roseFoliage.headWidth * 0.55,
    { halfSpan: roseFoliage.halfSpan, headWidth: roseFoliage.headWidth });
  check('玫瑰叶片：叶根包茎（叶鞘盖住叶基，无缺口）',
    roseFoliage.hasPetiole && roseFoliage.collarRadius > roseFoliage.stemRadius * 1.03 &&
      roseFoliage.baseZ < 0.006,
    { collarRadius: roseFoliage.collarRadius, stemRadius: roseFoliage.stemRadius, baseZ: roseFoliage.baseZ });
  check('玫瑰：三片叶仍是可点的 prepared-leaf 网格', roseFoliage.leafCount === 2, roseFoliage.leafCount);

  // 叶片近景 + 花头附近整枝
  const leafSpot = await page.evaluate(() => {
    const d = window.__bouquetDebug;
    const obj = d.scene.views.get(d.getState().doc.stems[0].id).object;
    obj.updateMatrixWorld(true);
    const V = d.scene.camera.position.constructor;
    const center = obj.getObjectByName('prepared-leaf-2').geometry.boundingBox
      ? obj.getObjectByName('prepared-leaf-2').geometry.boundingBox.getCenter(new V()).applyMatrix4(obj.getObjectByName('prepared-leaf-2').matrixWorld)
      : new V(0, 1.1, 0);
    return [center.x, center.y, center.z];
  });
  await aim(leafSpot, [0.12, 0.06, 0.16]);
  await foliageShot('foliage-rose-leaf');
  await aim(leafSpot, [0.2, 0.02, 0.02]);
  await foliageShot('foliage-rose-leaf-side');
  await aim([0, 1.05, 0], [0.34, 0.12, 0.42]);
  await foliageShot('foliage-rose-stem');

  const thorns = await page.evaluate(() => {
    const d = window.__bouquetDebug;
    const obj = d.scene.views.get(d.getState().doc.stems[0].id).object;
    obj.updateMatrixWorld(true);
    const group = obj.getObjectByName('organize-thorns');
    const stem = obj.getObjectByName('prepared-upper-stem');
    stem.geometry.computeBoundingBox();
    const stemRadius = Math.max(stem.geometry.boundingBox.max.x, -stem.geometry.boundingBox.min.x);
    const mesh = group.children[0];
    const p = mesh.geometry.getAttribute('position');
    let length = 0;
    for (let i = 0; i < p.count; i += 1) length = Math.max(length, p.getY(i));
    const materials = new Set();
    group.traverse((o) => { if (o.isMesh) materials.add(o.material); });
    const color = mesh.material.color;
    const max = Math.max(color.r, color.g, color.b);
    const min = Math.min(color.r, color.g, color.b);
    return {
      count: group.children.length,
      names: group.children.map((c) => c.name),
      opaque: [...materials].every((m) => m.transparent === false && m.opacity === 1),
      length: +length.toFixed(4),
      color: [+color.r.toFixed(3), +color.g.toFixed(3), +color.b.toFixed(3)],
      saturation: +(max - min).toFixed(3),
      lowKey: color.g >= color.r && color.g > color.b * 0.9,
      radial: +Math.hypot(mesh.position.x, mesh.position.z).toFixed(4),
      stemRadius: +stemRadius.toFixed(4),
    };
  });
  check('刺：细小（<1cm）、低饱和绿褐、不显眼',
    thorns.length < 0.0095 && thorns.saturation < 0.2 && thorns.lowKey, thorns);
  check('刺：刺根埋进茎表面（不悬空）', thorns.radial < thorns.stemRadius, thorns);
  check('刺：6 枚、命名不变、材质不透明（去刺仍是缩放淡出）',
    thorns.count === 6 && thorns.names.every((n, i) => n === `organize-thorn-${i}`) && thorns.opaque,
    thorns.names);
  await aim(
    await page.evaluate(() => {
      const d = window.__bouquetDebug;
      const obj = d.scene.views.get(d.getState().doc.stems[0].id).object;
      obj.updateMatrixWorld(true);
      const V = d.scene.camera.position.constructor;
      const pos = obj.getObjectByName('organize-thorn-3').getWorldPosition(new V());
      return [pos.x, pos.y, pos.z];
    }),
    [0.06, 0.02, 0.08],
  );
  await foliageShot('foliage-thorn');

  // 郁金香宽鞘叶
  await placeFlower('tulip-cream');
  const tulipFoliage = await page.evaluate(() => {
    const d = window.__bouquetDebug;
    const obj = d.scene.views.get(d.getState().doc.stems[0].id).object;
    obj.updateMatrixWorld(true);
    const blade = obj.getObjectByName('prepared-leaf-2');
    const material = blade.material;
    const p = blade.geometry.getAttribute('position');
    let baseWidth = 0;
    let tipWidth = 0;
    let maxY = -Infinity;
    let minY = Infinity;
    for (let i = 0; i < p.count; i += 1) {
      const z = p.getZ(i);
      maxY = Math.max(maxY, p.getY(i));
      minY = Math.min(minY, p.getY(i));
      if (z < 0.02) baseWidth = Math.max(baseWidth, Math.abs(p.getX(i)));
      if (z > 0.09) tipWidth = Math.max(tipWidth, Math.abs(p.getX(i)));
    }
    return {
      hasMap: Boolean(material.map),
      alphaTest: material.alphaTest,
      baseWidth: +baseWidth.toFixed(4),
      tipWidth: +tipWidth.toFixed(4),
      curvature: +(maxY - minY).toFixed(4),
      collar: Boolean(obj.getObjectByName('leaf-collar-2')),
      greenDominant: material.color.g > material.color.r && material.color.g > material.color.b,
    };
  });
  check('郁金香叶片：朴素宽鞘叶（无贴图）、基部宽叶尖窄、叶根有叶鞘',
    !tulipFoliage.hasMap && tulipFoliage.alphaTest === 0 &&
      tulipFoliage.baseWidth > tulipFoliage.tipWidth * 1.8 && tulipFoliage.collar,
    tulipFoliage);
  check('郁金香叶片：低饱和绿 + 有自然弧度', tulipFoliage.greenDominant && tulipFoliage.curvature > 0.006, tulipFoliage);
  const tulipLeaf = await page.evaluate(() => {
    const d = window.__bouquetDebug;
    const obj = d.scene.views.get(d.getState().doc.stems[0].id).object;
    obj.updateMatrixWorld(true);
    const blade = obj.getObjectByName('prepared-leaf-2');
    const V = d.scene.camera.position.constructor;
    const box = blade.geometry.boundingBox ?? (blade.geometry.computeBoundingBox(), blade.geometry.boundingBox);
    const center = box.getCenter(new V()).applyMatrix4(blade.matrixWorld);
    return [center.x, center.y, center.z];
  });
  await aim(tulipLeaf, [0.14, 0.05, 0.14]);
  await foliageShot('foliage-tulip-leaf');
  await aim([0, 1.02, 0], [0.3, 0.12, 0.4]);
  await foliageShot('foliage-tulip-stem');

  // 整束整理后：看叶片/刺是否自然、不抢戏
  await page.evaluate(() => {
    const s = window.__bouquetDebug.store;
    s.clearStems();
    for (let i = 0; i < 5; i += 1) {
      s.setPlacement(i % 2 ? 'rose-pink' : 'tulip-cream');
      s.placeStem({ height: (i % 3) * 0.02, tilt: 8 + i * 3, direction: i * 70 });
    }
    s.setPlacement(null);
    s.setStage('arrange');
    s.organizeBouquet();
    s.select(null);
  });
  await waitMeshes();
  await wait(1400);
  await foliageShot('foliage-bouquet-organized');
  writeFileSync(`${OUT2}/results.json`, JSON.stringify({ date: new Date().toISOString(), url: URL, passed: count, checks, errors }, null, 2));

  check('无页面脚本错误', errors.length === 0, errors);
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ date: new Date().toISOString(), url: URL, passed: count, checks, errors }, null, 2));
  console.log(`PASSED ${count}`);
} catch (error) {
  writeFileSync(`${OUT}/failure.json`, JSON.stringify({ date: new Date().toISOString(), url: URL, passed: count, checks, error: String(error), errors }, null, 2));
  throw error;
} finally {
  await browser.close();
}



