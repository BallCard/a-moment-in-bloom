/**
 * V0.7.3 §4 轻量柔性接触验证（多椭球包络版）。
 *
 * 用法：先确保 dev server 在 127.0.0.1:5190，再 node scripts/v07-contact.mjs
 *
 * 分两层：
 * 1) 求解器单元检查（页面里 import /src/three/contact.ts + envelope.ts，纯函数）：
 *    完全重合/轻触/分开的上下限、宽容度内不产生形变（净穿透为 0 当且仅当无响应）、
 *    主动枝与邻枝权重、同枝多包络不互算、**同枝多包络的 separation 按整枝聚合**、
 *    6cm 夹取、残差 residualOverlap 随分离下降、弹簧无过冲、常量口径。
 * 2) 场景集成检查：挤在一起时确实收拢/偏转、动的是正在操作的那枝、
 *    松开维持形态、删邻枝平滑恢复、反复拖动不累积、一次拖动只记一次撤销、拍照阶段冻结。
 *
 * 说明：包络重叠 ≠ 花瓣网格穿模；这里量的是同一口径的碰撞近似。
 */

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.CONTACT_URL ?? 'http://127.0.0.1:5190/';
const OUT = '.verify/v07-contact';
mkdirSync(OUT, { recursive: true });

let passed = 0;
const checks = [];
const errors = [];
/**
 * 并发编辑噪声：Lead/其他 agent 正在改源码时 Vite 会反复热重载并打印 `[vite] ...`
 * 报错，不能算这次验收的应用错误；单独归档，最后一项只断言真正的页面/WebGL 错误。
 */
const hmrNoise = [];
function pushError(text) {
  if (text.startsWith('[vite]') || text.includes('Failed to reload')) hmrNoise.push(text);
  else errors.push(text);
}
function check(name, ok, detail) {
  checks.push({ name, ok, detail: detail ?? null });
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`);
  passed += 1;
  console.log('ok', name);
}

const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => pushError(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) pushError(m.text());
});

const exec = (fn, arg) => page.evaluate(fn, arg);
const wait = (ms) => page.waitForTimeout(ms);
const state = () => exec(() => window.__bouquetDebug.getState());
const contacts = () => exec(() => window.__bouquetDebug.scene.getContactState());

try {
  // ---------- 1. 求解器单元检查 ----------
  // 直接用模块页跑纯函数：不依赖 App/BouquetScene 是否正被改动，
  // 别人改坏应用外壳时求解器的边界证据仍然成立。
  const unitPage = await context.newPage();
  unitPage.on('pageerror', (e) => pushError(e.message));
  unitPage.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) pushError(m.text());
  });
  await unitPage.goto(`${BASE}src/three/contact.ts`);
  const unit = await unitPage.evaluate(async () => {
    const mod = await import('/src/three/contact.ts');
    const env = await import('/src/three/envelope.ts');
    /** 世界坐标球（椭球特例）：用于精确手算穿深。 */
    const ball = (x, y, z, r) => ({ center: [x, y, z], radii: [r, r, r], part: 'head' });
    const stem = (id, kind, volumes) => ({ stemId: id, kind, volumes });
    const len = (v) => Math.hypot(v[0], v[1], v[2]);
    const out = {};

    // (a) 完全重合：压缩到上限、让步到上限、偏转在上限内
    let solved = mod.solveContacts(
      [stem('a', 'main', [ball(0, 1, 0, 0.1)]), stem('b', 'main', [ball(0, 1, 0, 0.1)])],
      'a',
    );
    out.touching = {
      squash: solved.get('a').squash,
      deflect: solved.get('a').deflect,
      offset: len(solved.get('a').offset),
      bendAxis: solved.get('a').bendAxis,
      neighborOffset: len(solved.get('b').offset),
    };

    // (b) 完全分开：没有任何接触
    solved = mod.solveContacts(
      [stem('a', 'main', [ball(0, 1, 0, 0.1)]), stem('b', 'main', [ball(0, 1.5, 0, 0.1)])],
      'a',
    );
    out.apart = solved.size;

    // (c) 合法柔性区也必须收拢；净穿透为 0 时不应推开整枝。
    solved = mod.solveContacts(
      [stem('a', 'main', [ball(0, 1, 0, 0.1)]), stem('b', 'main', [ball(0.19, 1, 0, 0.1)])],
      'a',
    );
    out.withinTolerance = { size: solved.size, response: solved.get('a'), residual: mod.residualOverlap([
      stem('a', 'main', [ball(0, 1, 0, 0.1)]),
      stem('b', 'main', [ball(0.19, 1, 0, 0.1)]),
    ]) };

    // (d) 轻微超限（外缘 2cm，净穿透 2mm）：只压一部分
    solved = mod.solveContacts(
      [stem('a', 'main', [ball(0, 1, 0, 0.1)]), stem('b', 'main', [ball(0.18, 1, 0, 0.1)])],
      'a',
    );
    out.light = { squash: solved.get('a').squash, offset: len(solved.get('a').offset) };

    // (e) 净穿透刚过 0 就一定有响应（iff 的另一半）
    solved = mod.solveContacts(
      [stem('a', 'main', [ball(0, 1, 0, 0.1)]), stem('b', 'main', [ball(0.1819, 1, 0, 0.1)])],
      'a',
    );
    out.justOver = { size: solved.size, squash: solved.size ? solved.get('a').squash : 0 };

    // (f) 主动枝 vs 周围枝：主动枝偏转更大，周围枝只有有限响应
    solved = mod.solveContacts(
      [stem('a', 'main', [ball(0, 1, 0, 0.1)]), stem('b', 'main', [ball(0.18, 1, 0, 0.1)])],
      'a',
    );
    out.weights = {
      active: solved.get('a').deflect,
      neighbor: solved.get('b').deflect,
      neighborSquash: solved.get('b').squash,
    };

    // (g) 同一枝的多个包络不互算（同一根刚体，不自己推自己）
    solved = mod.solveContacts(
      [stem('a', 'main', [ball(0, 1, 0, 0.1), ball(0.05, 1.02, 0, 0.1)])],
      'a',
    );
    out.sameStem = solved.size;

    // (h) 同枝多包络 + 另一枝：separation 必须按整枝聚合（旧版最后一个头覆盖前面）
    const both = [
      stem('a', 'main', [ball(0, 1, 0, 0.1), ball(0.06, 1, 0, 0.1)]),
      stem('b', 'main', [ball(0.14, 1, 0, 0.1)]),
    ];
    const onlyOne = [
      stem('a', 'main', [ball(0, 1, 0, 0.1)]),
      stem('b', 'main', [ball(0.14, 1, 0, 0.1)]),
    ];
    const aggSep = mod.solveContacts(both, 'a').get('a').separation;
    const singleSep = mod.solveContacts(onlyOne, 'a').get('a').separation;
    out.aggregate = {
      aggregate: ln(aggSep),
      single: ln(singleSep),
      perVolume: both[0].volumes.map((_, index) => {
        // 每个包络单独一枝时各自的分离量：聚合应≈两者之和（夹取前）。
        const one = [
          stem('a', 'main', [both[0].volumes[index]]),
          stem('b', 'main', [ball(0.14, 1, 0, 0.1)]),
        ];
        return ln(mod.solveContacts(one, 'a').get('a')?.separation ?? [0, 0, 0]);
      }),
      directionDot: (() => {
        // 主动枝应当被推离 B（沿 a→b 的反方向）。
        const normal = env.separationDirection(both[0].volumes[0], both[1].volumes[0]);
        return aggSep[0] * normal[0] + aggSep[1] * normal[1] + aggSep[2] * normal[2];
      })(),
    };

    // (i) 同枝很多包络同时挤：聚合后仍夹在 6cm
    const many = [
      stem('a', 'main', Array.from({ length: 8 }, () => ball(0, 1, 0, 0.1))),
      stem('b', 'main', [ball(0.14, 1, 0, 0.1)]),
    ];
    const manySep = mod.solveContacts(many, 'a').get('a').separation;
    out.clamp = { value: ln(manySep), cap: mod.CONTACT_SEPARATION_MAX };

    // (j) 残差随分离下降：把解出的 separation 虚拟加到包络上，再量净穿透
    const tight = [
      stem('a', 'main', [ball(0, 1, 0, 0.1)]),
      stem('b', 'main', [ball(0.12, 1, 0, 0.1)]),
    ];
    const before = mod.residualOverlap(tight);
    const tightSolved = mod.solveContacts(tight, 'a');
    const moved = tight.map((item) => {
      const shift = tightSolved.get(item.stemId)?.separation ?? [0, 0, 0];
      return {
        ...item,
        volumes: item.volumes.map((volume) => ({
          ...volume,
          center: [volume.center[0] + shift[0], volume.center[1] + shift[1], volume.center[2] + shift[2]],
        })),
      };
    });
    const after = mod.residualOverlap(moved);
    out.residual = { before, after, separation: len(tightSolved.get('a').separation) };

    // (k) 偏转向量叠加：三枝夹挤时方向是合力，不是任意一对（不能退化成 0 向量）
    const squeezed = mod.solveContacts(
      [
        stem('a', 'main', [ball(0, 1, 0, 0.1)]),
        stem('b', 'main', [ball(0.15, 1, 0, 0.1)]),
        stem('c', 'main', [ball(0, 1, 0.15, 0.1)]),
      ],
      'a',
    );
    out.bendSum = {
      a: { deflect: squeezed.get('a').deflect, axis: squeezed.get('a').bendAxis },
      max: mod.CONTACT_DEFLECT_MAX,
    };

    // (l) 弹簧：不过冲、大 dt 稳定、能恢复
    let value = 0;
    let velocity = 0;
    let overshoot = 0;
    for (let i = 0; i < 240; i += 1) {
      [value, velocity] = mod.criticallyDampedStep(value, velocity, 1, mod.CONTACT_SPRING_IN, 1 / 60);
      overshoot = Math.max(overshoot, value);
    }
    const [bigValue, bigVelocity] = mod.criticallyDampedStep(0, 0, 1, mod.CONTACT_SPRING_IN, 0.5);
    let recover = 1;
    let recoverVelocity = 0;
    for (let i = 0; i < 60; i += 1) {
      [recover, recoverVelocity] = mod.criticallyDampedStep(recover, recoverVelocity, 0, mod.CONTACT_SPRING_OUT, 1 / 60);
    }
    out.spring = {
      settled: value,
      overshoot,
      bigDt: { value: bigValue, velocity: bigVelocity, finite: Number.isFinite(bigValue) && Number.isFinite(bigVelocity) },
      recovered: recover,
    };

    // (m) 常量与夹取
    out.constants = {
      squashMax: mod.CONTACT_SQUASH_MAX,
      deflectMaxDeg: (mod.CONTACT_DEFLECT_MAX * 180) / Math.PI,
      pushMax: mod.CONTACT_PUSH_MAX,
      separationMax: mod.CONTACT_SEPARATION_MAX,
      neighborWeight: mod.CONTACT_NEIGHBOR_WEIGHT,
      springIn: mod.CONTACT_SPRING_IN,
      springOut: mod.CONTACT_SPRING_OUT,
      dragDepthLimit: mod.CONTACT_DRAG_DEPTH_LIMIT,
    };
    out.clampOffset = len(mod.clampOffset([1, 0, 0]));
    out.noContact = mod.NO_CONTACT;

    function ln(v) {
      return Math.hypot(v[0], v[1], v[2]);
    }
    return out;
  });

  check('求解器：完全重合时压缩到 12% 上限', Math.abs(unit.touching.squash - 0.12) < 1e-9, unit.touching);
  check(
    '求解器：完全重合时位置让步到 2.5cm 上限',
    Math.abs(unit.touching.offset - 0.025) < 1e-9,
    { offset: unit.touching.offset },
  );
  check(
    '求解器：让步只给正在操作的那枝',
    unit.touching.neighborOffset === 0,
    { neighborOffset: unit.touching.neighborOffset },
  );
  check('求解器：完全分开时没有接触', unit.apart === 0, { size: unit.apart });
  check(
    '求解器：合法接触区先压缩，但不产生整枝分离',
    unit.withinTolerance.size === 2 &&
      unit.withinTolerance.response.squash > 0 &&
      unit.withinTolerance.response.deflect === 0 &&
      Math.hypot(...unit.withinTolerance.response.offset, ...unit.withinTolerance.response.separation) === 0 &&
      unit.withinTolerance.residual.core === 0 &&
      unit.withinTolerance.residual.rim === 0,
    unit.withinTolerance,
  );
  check(
    '求解器：净穿透刚过 0（外缘超限 1mm）就有响应（iff 的另一半）',
    unit.justOver.size > 0 && unit.justOver.squash > 0 && unit.justOver.squash < 0.12,
    unit.justOver,
  );
  check(
    '求解器：轻微超限只压一部分（0 < squash < 12%）',
    unit.light.squash > 0 && unit.light.squash < 0.12 && unit.light.offset === 0,
    unit.light,
  );
  check(
    '求解器：周围花枝偏转小于主动枝且不为 0',
    unit.weights.neighbor < unit.weights.active && unit.weights.neighbor > 0,
    unit.weights,
  );
  check('求解器：同一枝多个包络不互算', unit.sameStem === 0, { size: unit.sameStem });
  check(
    '求解器：同枝多包络的 separation 按整枝聚合（大于单包络，不是后者覆盖）',
    unit.aggregate.aggregate > unit.aggregate.single * 1.15 &&
      unit.aggregate.perVolume.every((value) => value > 0) &&
      unit.aggregate.aggregate <= unit.constants.separationMax + 1e-9,
    unit.aggregate,
  );
  check(
    '求解器：分离方向把主动枝推离对方（方向点积 < 0）',
    unit.aggregate.directionDot < 0,
    { directionDot: unit.aggregate.directionDot },
  );
  check(
    '求解器：同枝多包络聚合后仍夹在 6cm 内',
    unit.clamp.value <= unit.clamp.cap + 1e-9 && unit.clamp.value > 0.05,
    unit.clamp,
  );
  check(
    '求解器：残差 residualOverlap 随分离下降（核心与外缘都降）',
    unit.residual.before.core > 0 &&
      unit.residual.before.rim > 0 &&
      unit.residual.after.core < unit.residual.before.core &&
      unit.residual.after.rim < unit.residual.before.rim,
    unit.residual,
  );
  check(
    '求解器：偏转上限 5°、且三枝夹挤时按向量叠加（不退化为 0）',
    Math.abs(unit.constants.deflectMaxDeg - 5) < 1e-9 &&
      unit.bendSum.a.deflect <= unit.bendSum.max + 1e-9 &&
      unit.bendSum.a.deflect > 0,
    unit.bendSum,
  );
  check(
    '求解器：临界阻尼弹簧不过冲、收敛到目标',
    unit.spring.overshoot <= 1.0005 && Math.abs(unit.spring.settled - 1) < 0.01,
    unit.spring,
  );
  check(
    '求解器：大时间步仍稳定（不掉帧炸掉）',
    unit.spring.bigDt.finite && unit.spring.bigDt.value >= -1e-9 && unit.spring.bigDt.value <= 1.001,
    unit.spring.bigDt,
  );
  check(
    '求解器：拉开后平滑恢复（0.4s 内降到 1% 以下）',
    unit.spring.recovered >= 0 && unit.spring.recovered < 0.01,
    { recovered: unit.spring.recovered },
  );
  check(
    '求解器：常量口径保持兼容（12% / 5° / 2.5cm / 6cm）',
    Math.abs(unit.constants.squashMax - 0.12) < 1e-9 &&
      Math.abs(unit.constants.pushMax - 0.025) < 1e-9 &&
      Math.abs(unit.constants.separationMax - 0.06) < 1e-9 &&
      unit.constants.springIn > unit.constants.springOut,
    unit.constants,
  );
  check(
    '求解器：clampOffset 与外置零值仍可用',
    Math.abs(unit.clampOffset - 0.025) < 1e-9 &&
      unit.noContact.squash === 0 &&
      unit.noContact.separation.length === 3,
    { clampOffset: unit.clampOffset, noContact: unit.noContact },
  );
  await unitPage.close();

  // ---------- 2. 场景集成：载入 6 枝样束 ----------
  // 同样直接走 store 的公开入口，不依赖地址栏 `?sample=` 分支。
  await page.goto(BASE);
  await page.waitForFunction(() => Boolean(window.__bouquetDebug));
  const boot = await exec(() => {
    const d = window.__bouquetDebug;
    const loaded = d.getState().doc.stems.length === 6 ? true : d.store.loadSampleBouquet(6);
    d.store.setViewPreset('quarter');
    return { loaded, stems: d.getState().doc.stems.length };
  });
  await page.waitForFunction(() => window.__bouquetDebug.getState().doc.stems.length === 6);
  await page.waitForFunction(() =>
    [...window.__bouquetDebug.scene.views.values()].every((v) => v.object),
  );
  await wait(1200);
  check('场景：载入 6 枝验收样束', boot.loaded && boot.stems === 6, boot);

  // ---------- 3. 场景：只留两枝主花，便于确定性验证 ----------
  const forced = await exec(() => {
    const d = window.__bouquetDebug;
    const s = d.store;
    const keep = d
      .getState()
      .doc.stems.filter((x) => d.getState().catalog.entriesById[x.assetId]?.kind === 'main')
      .slice(0, 2)
      .map((x) => x.id);
    for (const stem of d.getState().doc.stems) {
      if (!keep.includes(stem.id)) s.deleteStem(stem.id);
    }
    const [a, b] = keep;
    s.beginTransaction();
    s.updateStemPoseTransient(a, { tilt: 0, direction: 0, height: 0.02 });
    s.updateStemPoseTransient(b, { tilt: 0, direction: 0, height: 0.02 });
    s.endTransaction();
    return { a, b };
  });
  await wait(900);
  const squeezed = await contacts();
  const squeezeA = squeezed.find((c) => c.stemId === forced.a);
  check('挤在一起后出现接触形变', squeezed.length > 0 && Boolean(squeezeA), squeezed);
  check('花头收拢不超过 12%', squeezeA.squash <= unit.constants.squashMax + 1e-4, {
    squash: squeezeA.squash,
  });
  check('枝条偏转不超过 5°', Math.abs(squeezeA.deflect) <= (unit.constants.deflectMaxDeg * Math.PI) / 180 + 1e-4, {
    deflect: squeezeA.deflect,
  });
  check('位置分离不超过 6cm', Math.hypot(...squeezeA.separation) <= unit.constants.separationMax + 1e-4, {
    separation: Math.hypot(...squeezeA.separation),
  });
  const docNow = await state();
  const stemA = docNow.doc.stems.find((s) => s.id === forced.a);
  check(
    '接触形变不写进文档（位置/缩放不变）',
    stemA.position[0] === 0 && stemA.position[1] === 0.9 && typeof stemA.scale === 'number',
    { pos: stemA.position, scale: stemA.scale },
  );
  await page.screenshot({ path: `${OUT}/01-squeezed.png` });

  // 静止时不应抖动：连续两次采样一致
  const stable1 = await contacts();
  await wait(600);
  const stable2 = await contacts();
  const drifting = stable1.some((c, i) => {
    const d = stable2[i];
    return !d || Math.abs(c.squash - d.squash) > 0.002 || Math.abs(c.deflect - d.deflect) > 0.002;
  });
  check('接触形态静止时不抖动', !drifting, { stable1, stable2 });

  // ---------- 3. 拉开后平滑恢复 ----------
  await exec(({ a, b }) => {
    const s = window.__bouquetDebug.store;
    s.beginTransaction();
    s.updateStemPoseTransient(a, { tilt: 30, direction: 0 });
    s.updateStemPoseTransient(b, { tilt: 30, direction: 180 });
    s.endTransaction();
  }, forced);
  await wait(1400);
  const apart = await contacts();
  check(
    '拉开后接触形变归零',
    apart.every(
      (c) => c.squash < 0.002 && Math.hypot(...c.offset) < 0.002 && Math.hypot(...c.separation) < 0.002,
    ),
    apart,
  );

  // ---------- 4. 反复挤压不累积 ----------
  const scalesBefore = (await state()).doc.stems.map((s) => s.scale);
  for (let i = 0; i < 5; i += 1) {
    await exec(({ a, b }) => {
      const s = window.__bouquetDebug.store;
      s.beginTransaction();
      s.updateStemPoseTransient(a, { tilt: 0, direction: 0 });
      s.updateStemPoseTransient(b, { tilt: 0, direction: 0 });
      s.endTransaction();
    }, forced);
    await wait(260);
    await exec(({ a, b }) => {
      const s = window.__bouquetDebug.store;
      s.beginTransaction();
      s.updateStemPoseTransient(a, { tilt: 30, direction: 0 });
      s.updateStemPoseTransient(b, { tilt: 30, direction: 180 });
      s.endTransaction();
    }, forced);
    await wait(260);
  }
  await wait(600);
  const scalesAfter = (await state()).doc.stems.map((s) => s.scale);
  const finalContacts = await contacts();
  check('反复挤压 5 次后文档尺寸不变（不越挤越小）', scalesBefore.every((v, i) => v === scalesAfter[i]), {
    scalesBefore,
    scalesAfter,
  });
  check(
    '反复挤压后接触形变回到零（含分离量）',
    finalContacts.every((c) => c.squash < 0.002 && Math.hypot(...c.separation) < 0.002),
    finalContacts,
  );

  // ---------- 5. 松开维持形态 / 删邻枝恢复 ----------
  await exec(({ a, b }) => {
    const s = window.__bouquetDebug.store;
    s.beginTransaction();
    s.updateStemPoseTransient(a, { tilt: 0, direction: 0 });
    s.updateStemPoseTransient(b, { tilt: 0, direction: 0 });
    s.endTransaction();
    s.select(null);
  }, forced);
  await wait(900);
  const keepContacts = await contacts();
  check('没有选中时仍保持接触形态', keepContacts.some((c) => c.squash > 0.01), keepContacts);
  await exec(({ b }) => window.__bouquetDebug.store.deleteStem(b), forced);
  await wait(1400);
  const afterDelete = await contacts();
  check(
    '删掉邻枝后平滑恢复',
    afterDelete.every(
      (c) => c.squash < 0.002 && Math.hypot(...c.offset) < 0.002 && Math.hypot(...c.separation) < 0.002,
    ),
    afterDelete,
  );

  // ---------- 6. 一次拖动只记一次撤销 ----------
  const undoBefore = (await state()).pastCount;
  const dragId = (await state()).doc.stems[0].id;
  await exec(({ id }) => {
    const s = window.__bouquetDebug.store;
    const d = window.__bouquetDebug;
    d.store.select(id);
    s.beginTransaction();
    for (let i = 0; i < 8; i += 1) s.updateStemPoseTransient(id, { tilt: 10 + i * 3, direction: i * 30 });
    s.endTransaction();
  }, { id: dragId });
  await wait(400);
  const undoAfter = (await state()).pastCount;
  check('一次拖动只产生一条撤销记录', undoAfter - undoBefore === 1, { before: undoBefore, after: undoAfter });

  // ---------- 7. 拍照阶段冻结同一形变 ----------
  await exec(({ a, b }) => {
    const s = window.__bouquetDebug.store;
    s.beginTransaction();
    s.updateStemPoseTransient(a, { tilt: 0, direction: 0 });
    s.updateStemPoseTransient(b, { tilt: 0, direction: 0 });
    s.endTransaction();
  }, forced).catch(() => {});
  await wait(700);
  const beforeFinishContacts = await contacts();
  await exec(() => window.__bouquetDebug.store.setStage('finish'));
  await wait(1200);
  const finishContacts = await contacts();
  check(
    '拍照阶段保留同一接触形变（冻结）',
    JSON.stringify(beforeFinishContacts) === JSON.stringify(finishContacts),
    { before: beforeFinishContacts, finish: finishContacts },
  );
  const photo = await exec(async () => {
    const d = window.__bouquetDebug;
    const url = await d.captureThumbnail(240);
    return { len: url.length, head: url.slice(0, 22) };
  });
  check('拍照能正常出图', photo.len > 2000 && photo.head.startsWith('data:image/'), photo);
  await page.screenshot({ path: `${OUT}/02-finish.png` });

  check('无页面与 WebGL 错误', errors.length === 0, errors);
  writeFileSync(
    `${OUT}/results.json`,
    JSON.stringify(
      { date: new Date().toISOString(), passed, checks, unit, scene: { squeezed, finalContacts, afterDelete }, errors, hmrNoise },
      null,
      2,
    ),
  );
  console.log(`PASSED ${passed}`);
} catch (error) {
  writeFileSync(
    `${OUT}/failure.json`,
    JSON.stringify(
      { date: new Date().toISOString(), passed, checks, error: String(error), errors, hmrNoise },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
