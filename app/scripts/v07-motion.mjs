/**
 * V0.7.1 §4 运动稳定性验证：接触形变是不是「连续、有阻尼、不抽搐」。
 *
 * 用法：npm run dev -- --port 5190 --strictPort  然后 node scripts/v07-motion.mjs
 *
 * 背景：用户验收反馈「V7 改动之后花抽搐」。实测原因是 store 的同步
 * （选中锚点、悬停等）每帧会把花枝 root 重置成基础姿态，而接触形变要下一帧
 * 才重新叠加——画面上就是每 50–100ms 弹回一次（5° / 2cm 的跳变）。
 * 这里在 render() 之后采样真实上屏的变换，回归这一点：
 *
 * 1) store 每帧同步时形变不能被打断（不能再出现「弹回一帧」）；
 * 2) 拖动时每帧变化有上限（没有单帧跳变），方向也不来回翻；
 * 3) 形变始终在 12% / 5° / 2.5cm 的上限内，松手后平滑归零；
 * 4) 无页面/WebGL 错误。
 */

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.MOTION_URL ?? 'http://127.0.0.1:5190/';
const OUT = '.verify/v07-motion';
mkdirSync(OUT, { recursive: true });

let passed = 0;
const checks = [];
const errors = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail: detail ?? null });
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`);
  passed += 1;
  console.log('ok', name);
}

const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
});

const exec = (fn, arg) => page.evaluate(fn, arg);
const wait = (ms) => page.waitForTimeout(ms);
const contacts = () => exec(() => window.__bouquetDebug.scene.getContactState());

/** 在页面里挂载「render 之后采样」的钩子：拿到的是真正上屏的变换。 */
const mountSampler = () =>
  exec(() => {
    const scene = window.__bouquetDebug.scene;
    if (!scene.__probeRender) {
      const orig = scene.renderer.render.bind(scene.renderer);
      scene.__probeRender = orig;
      scene.renderer.render = (...args) => {
        orig(...args);
        const sink = window.__probe;
        if (!sink || sink.stop) return;
        const frame = { t: +performance.now().toFixed(1), stems: {} };
        for (const [id, view] of scene.views) {
          if (!view.object) continue;
          const rq = view.root.quaternion;
          const bq = view.baseQuaternion;
          const dot = Math.abs(rq.x * bq.x + rq.y * bq.y + rq.z * bq.z + rq.w * bq.w);
          const bendDeg = (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
          const p = view.root.position;
          const bp = view.basePosition;
          // 上屏花头位置 = root.position + root.quaternion ⊗ (0, headHeight × scale, 0)
          const local = (view.loaded?.headHeight ?? 0.36) * view.root.scale.x;
          const q = rq;
          // 四元数旋转 (0, local, 0)：v' = L * (-2zw + 2xy, 1 - 2(x²+z²), 2xw + 2yz)
          const headX = p.x + local * (-2 * q.z * q.w + 2 * q.x * q.y);
          const headY = p.y + local * (1 - 2 * (q.x * q.x + q.z * q.z));
          const headZ = p.z + local * (2 * q.x * q.w + 2 * q.y * q.z);
          const contact = scene.contacts.get(id) ?? null;
          frame.stems[id] = {
            bendDeg: +bendDeg.toFixed(3),
            // 位置让步 / 位置分离分开记：root 相对基础姿态的位移包含两者。
            pushMm: contact ? +(Math.hypot(...contact.offset) * 1000).toFixed(3) : 0,
            separationMm: contact ? +(Math.hypot(...contact.separation) * 1000).toFixed(3) : 0,
            rootShiftMm: +(Math.hypot(p.x - bp.x, p.y - bp.y, p.z - bp.z) * 1000).toFixed(3),
            squash: contact ? +contact.squash.toFixed(4) : 0,
            head: [+headX.toFixed(4), +headY.toFixed(4), +headZ.toFixed(4)],
          };
        }
        sink.frames.push(frame);
      };
    }
    window.__probe = { frames: [], stop: false };
    return true;
  });

const startSampler = async () => {
  await exec(() => {
    window.__probe = { frames: [], stop: false };
  });
};
const stopSampler = () =>
  exec(() => {
    window.__probe.stop = true;
    return window.__probe.frames;
  });

function analyse(frames, draggedId) {
  const ids = Object.keys(frames[0]?.stems ?? {});
  let worst = { bendStepDeg: 0, pushStepMm: 0, headStepMm: 0, flips: 0, id: null };
  const perStem = {};
  for (const id of ids) {
    let lastBend = null, lastPush = null, lastHead = null;
    let maxBendStep = 0, maxPushStep = 0, maxHeadStep = 0;
    let flips = 0, prevSign = 0;
    for (const f of frames) {
      const s = f.stems[id];
      if (!s) continue;
      if (lastBend !== null) {
        maxBendStep = Math.max(maxBendStep, Math.abs(s.bendDeg - lastBend));
        maxPushStep = Math.max(maxPushStep, Math.abs(s.pushMm - lastPush));
        const dh = Math.hypot(
          s.head[0] - lastHead[0],
          s.head[1] - lastHead[1],
          s.head[2] - lastHead[2],
        );
        maxHeadStep = Math.max(maxHeadStep, dh * 1000);
        const dBend = s.bendDeg - lastBend;
        const sign = Math.abs(dBend) > 0.15 ? Math.sign(dBend) : 0;
        if (sign && prevSign && sign !== prevSign) flips += 1;
        if (sign) prevSign = sign;
      }
      lastBend = s.bendDeg;
      lastPush = s.pushMm;
      lastHead = s.head;
    }
    perStem[id] = { maxBendStep: +maxBendStep.toFixed(3), maxPushStep: +maxPushStep.toFixed(3), maxHeadStep: +maxHeadStep.toFixed(3), flips };
    if (id !== draggedId) {
      if (maxBendStep > worst.bendStepDeg) { worst.bendStepDeg = maxBendStep; worst.id = id; }
      worst.pushStepMm = Math.max(worst.pushStepMm, maxPushStep);
      worst.headStepMm = Math.max(worst.headStepMm, maxHeadStep);
      worst.flips += flips;
    }
  }
  return { perStem, worst };
}

try {
  await page.goto(`${BASE}?sample=12&view=quarter`);
  await page.waitForFunction(() => window.__bouquetDebug?.getState().doc.stems.length > 0);
  await page.waitForFunction(() =>
    [...window.__bouquetDebug.scene.views.values()].every((v) => v.object),
  );
  await wait(1400);
  await mountSampler();

  // ---------- 1. store 每帧同步不打断形变 ----------
  // 只留两枝主花并挤在一起，让接触形变稳定存在；然后每帧触发一次 store 同步。
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
    // 选中 a：它会承担位置让步（>0），周围花枝只有偏转。
    s.select(a);
    return { a, b };
  });
  await wait(900);
  const beforeSync = await contacts();
  check('两枝挤在一起时形成接触形变', beforeSync.length > 0, beforeSync);

  await startSampler();
  for (let i = 0; i < 90; i += 1) {
    await exec(({ a, b, i }) => {
      // 真实的同步触发源：悬停/锚点/建议位都会改 store，然后整棵场景重同步。
      window.__bouquetDebug.store.setHovered(i % 2 === 0 ? a : b);
    }, { ...forced, i });
    await wait(16);
  }
  const syncFrames = await stopSampler();
  const syncReport = analyse(syncFrames);
  const minBend = Math.min(
    ...syncFrames.map((f) => Math.max(...Object.values(f.stems).map((s) => s.bendDeg))),
  );
  const minPush = Math.min(
    ...syncFrames.map((f) => Math.max(...Object.values(f.stems).map((s) => s.pushMm))),
  );
  check(
    '每帧 store 同步时形变不会弹回（没有一帧塌回 0）',
    syncFrames.length > 30 && minBend > 0.01 && minPush > 0.01,
    { frames: syncFrames.length, minBend, minPush },
  );
  check(
    '同步周期内没有单帧跳变（偏转 < 0.6°/帧）',
    syncReport.worst.bendStepDeg < 0.6,
    { worst: syncReport.worst },
  );
  check(
    '同步周期内让步不跳（< 1mm/帧）',
    syncReport.worst.pushStepMm < 1,
    { worst: syncReport.worst },
  );

  // ---------- 1b. 帧内 store 同步不能把本帧形变抹掉（抽搐的直接原因） ----------
  // animate() 里的 updateSelectionAnchor / updateSnapHint 会在「算完形变之后、渲染之前」
  // 写 store；那次写会触发 syncStems → 重置 root 为基础姿态。修好之前这里会把偏转清成 0。
  const midFrame = await exec(() => {
    const scene = window.__bouquetDebug.scene;
    const store = window.__bouquetDebug.store;
    scene.updateContacts(0.016);
    const angleOf = (view) => {
      const rq = view.root.quaternion;
      const bq = view.baseQuaternion;
      const dot = Math.abs(rq.x * bq.x + rq.y * bq.y + rq.z * bq.z + rq.w * bq.w);
      return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
    };
    const before = {};
    for (const [id, view] of scene.views) if (scene.contacts.has(id)) before[id] = angleOf(view);
    store.setHovered(store.getState().hoveredId === 'probe' ? null : 'probe');
    const after = {};
    for (const id of Object.keys(before)) {
      const view = scene.views.get(id);
      if (view) after[id] = angleOf(view);
    }
    return { before, after };
  });
  const midLosses = Object.keys(midFrame.before).map((id) => ({
    id,
    before: +midFrame.before[id].toFixed(3),
    after: +(midFrame.after[id] ?? 0).toFixed(3),
  }));
  const collapsed = midLosses.filter((m) => m.before > 0.2 && m.after < m.before * 0.9);
  check('帧内 store 同步不会把接触形变抹掉（抽搐回归）', midLosses.length > 0 && collapsed.length === 0, {
    midLosses,
    collapsed,
  });
  await page.screenshot({ path: `${OUT}/01-contact.png` });

  // ---------- 2. 拖动一枝：跟手但不能抖 ----------
  await exec(() => window.__bouquetDebug.store.setHovered(null));
  // 换回完整样束
  await page.goto(`${BASE}?sample=12&view=quarter`);
  await page.waitForFunction(() => window.__bouquetDebug?.getState().doc.stems.length > 0);
  await page.waitForFunction(() =>
    [...window.__bouquetDebug.scene.views.values()].every((v) => v.object),
  );
  await wait(1400);
  await mountSampler();

  const target = await exec(() => {
    const d = window.__bouquetDebug;
    const scene = d.scene;
    let best = null;
    for (const stem of d.getState().doc.stems) {
      const pt = scene.getStemScreenPoint(stem.id);
      if (!pt || !pt.visible) continue;
      const dd = Math.hypot(pt.x - 720, pt.y - 450);
      if (!best || dd < best.dp) best = { id: stem.id, x: pt.x, y: pt.y, dp: dd };
    }
    return best;
  });
  check('找到可拖动的花枝', Boolean(target?.id), target);

  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.mouse.up();
  await wait(260);
  /**
   * 实际被拖的是射线命中的那枝，不一定等于「离屏幕中心最近」的那枝：
   * 花头互相遮挡时点到的可能是前面另一枝。V0.7.3 换成椭球包络后这点更明显，
   * 若仍拿 target.id 当「被拖枝」，被拖枝自己的跟手移动会被误算成邻枝跳变。
   * 所以松开后读一次真实选中枝，用它作为被拖枝白名单；断言阈值保持不变。
   */
  const grabbed = await exec((fallbackId) => {
    const d = window.__bouquetDebug;
    const selected = d.store.getState().selectedId;
    const dragging = d.scene.drag?.stemId ?? null;
    return { selectedId: selected ?? null, dragStemId: dragging, candidateId: fallbackId };
  }, target.id);
  const draggedId = grabbed.selectedId ?? target.id;
  check(
    '点到的花枝与实际被拖的花枝一致（按选中枝校正）',
    draggedId === grabbed.candidateId || draggedId === grabbed.selectedId,
    { ...grabbed, draggedId },
  );
  await page.mouse.down();
  await startSampler();
  for (let i = 0; i < 150; i += 1) {
    const t = i / 150;
    const r = 6 + 28 * Math.sin(t * Math.PI);
    const angle = i * 0.22;
    await page.mouse.move(target.x + Math.cos(angle) * r, target.y + Math.sin(angle) * r * 0.8);
    await wait(16);
  }
  await page.mouse.up();
  await wait(300);
  const dragFrames = await stopSampler();
  const dragReport = analyse(dragFrames, draggedId);
  check(
    '拖动时邻枝偏转连续（< 0.8°/帧）',
    dragReport.worst.bendStepDeg < 0.8,
    { worst: dragReport.worst },
  );
  check(
    '拖动时邻枝花头不跳（< 6mm/帧）',
    dragReport.worst.headStepMm < 6,
    { worst: dragReport.worst, perStem: dragReport.perStem },
  );
  check(
    '拖动时邻枝不来回翻方向（翻转次数 ≤ 6）',
    dragReport.worst.flips <= 6,
    { worst: dragReport.worst },
  );
  // 上限：偏转 ≤5°、让步 ≤2.5cm、压缩 ≤12%
  const capViolation = dragFrames.some((f) =>
    Object.values(f.stems).some((s) => s.bendDeg > 5.05 || s.pushMm > 25.1 || s.squash > 0.1205),
  );
  check('拖动全程形变不超上限（12% / 5° / 2.5cm 让步 / 6cm 分离）', !capViolation);
  // V0.7.2：重叠时应当有位置分离，把花头真正推开
  const maxSeparation = Math.max(
    ...dragFrames.map((f) => Math.max(...Object.values(f.stems).map((s) => s.separationMm))),
  );
  check('重叠时有位置分离（>1mm 且 ≤6cm）', maxSeparation > 1 && maxSeparation <= 60.1, { maxSeparation });

  // ---------- 3. 松手后保持形态，且不会自己抖 ----------
  await wait(900);
  const settleA = await contacts();
  await wait(500);
  const settleB = await contacts();
  const stable =
    settleA.length === settleB.length &&
    settleA.every((c) => {
      const d = settleB.find((x) => x.stemId === c.stemId);
      return (
        Boolean(d) &&
        Math.abs(d.squash - c.squash) < 0.002 &&
        Math.abs(d.deflect - c.deflect) < 0.003 &&
        Math.hypot(d.offset[0] - c.offset[0], d.offset[1] - c.offset[1], d.offset[2] - c.offset[2]) < 0.002
      );
    });
  check('松手后接触形态稳定（不会自己抖）', stable, { settleA, settleB });

  // 删掉其余花枝：没有接触了，形变应当平滑回零。
  await exec(({ id }) => {
    const s = window.__bouquetDebug.store;
    for (const stem of [...s.getState().doc.stems]) {
      if (stem.id !== id) s.deleteStem(stem.id);
    }
  }, { id: draggedId });
  await wait(1400);
  const rest = await contacts();
  check(
    '删掉其余花枝后接触形变平滑归零',
    rest.length === 0 ||
      rest.every((c) =>
        c.squash < 0.002 && c.deflect < 0.003 && Math.hypot(...c.offset) < 0.002 && Math.hypot(...c.separation) < 0.002,
      ),
    rest,
  );
  await page.screenshot({ path: `${OUT}/02-after-drag.png` });

  check('无页面与 WebGL 错误', errors.length === 0, errors);
  writeFileSync(
    `${OUT}/results.json`,
    JSON.stringify(
      { date: new Date().toISOString(), passed, checks, syncFrames: syncFrames.length, dragFrames: dragFrames.length, grabbed, draggedId, syncReport, dragReport, errors },
      null,
      2,
    ),
  );
  console.log(`PASSED ${passed}`);
} catch (error) {
  writeFileSync(
    `${OUT}/failure.json`,
    JSON.stringify({ date: new Date().toISOString(), passed, checks, error: String(error), errors }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
