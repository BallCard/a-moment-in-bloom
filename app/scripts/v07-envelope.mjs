/**
 * V0.7.3 §3：包络（envelope.ts）近似验证。
 *
 * 用法：先确保 dev server 在 127.0.0.1:5190，再 node scripts/v07-envelope.mjs
 *
 * 背景：诊断文档 §3「接触包络与画面、花型不完全一致」——旧版多数花型只有一个
 * 球形包络，长形/扁形/散枝花和绿叶表达不了。envelope.ts 改用与真实朝向一致的
 * 椭球（核心 = 外缘 × coreScale），本脚本用**页面内 import 真实模块**验证：
 *
 * 1) 尺寸口径：headVolume/partVolume/longVolume 的半轴与输入尺寸一致，
 *    核心比例在 (0,1)，多头花逐个登记（不是一根大球）；
 * 2) 支撑函数：沿最长轴端点的 rim 边界 = 该半轴，方向退化时保守取最大半轴；
 * 3) 宽容度边界：allowed 在 limits 边界为真、超界为假；stricterLimits 取更严格；
 * 4) 重叠换算：球/椭球穿深是解析值（rim = Σ支撑 - 距离，core = Σ核心支撑 - 距离），
 *    residualOverlap 只留下超过宽容度的净穿透，transformVolume 世界化正确。
 *
 * 说明：包络重叠 ≠ 花瓣网格穿模，这里量的是同一口径的碰撞近似，
 * 不能当作渲染穿模率。
 */

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.ENVELOPE_URL ?? 'http://127.0.0.1:5190/';
const OUT = '.verify/v07-envelope';
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

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
/**
 * 并发编辑噪声：别的 agent/Lead 正在改源码时 Vite 会反复热重载并打印
 * `[vite] ...` 报错，不能算这次验收的应用错误；单独归档，最后一项只断言
 * 真正的页面/WebGL 错误为空。
 */
const hmrNoise = [];
function pushError(text) {
  if (text.startsWith('[vite]') || text.includes('Failed to reload')) hmrNoise.push(text);
  else errors.push(text);
}
page.on('pageerror', (e) => pushError(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) pushError(m.text());
});

const exec = (fn, arg) => page.evaluate(fn, arg);
const wait = (ms) => page.waitForTimeout(ms);

try {
  // 样束直接走 store 的公开入口载入：地址栏 `?sample=` 依赖 App 的校准参数分支，
  // 那条分支在多人同时改 App.tsx 时可能临时抛错，验收脚本不该被它带崩。
  await page.goto(BASE);
  await page.waitForFunction(() => Boolean(window.__bouquetDebug));
  const boot = await exec(() => {
    const d = window.__bouquetDebug;
    const loaded = d.getState().doc.stems.length === 12 ? true : d.store.loadSampleBouquet(12);
    d.store.setViewPreset('quarter');
    return { loaded, stems: d.getState().doc.stems.length };
  });
  await page.waitForFunction(() => window.__bouquetDebug.getState().doc.stems.length === 12);
  await page.waitForFunction(() =>
    [...window.__bouquetDebug.scene.views.values()].every((v) => v.object),
  );
  await wait(1200);
  check('载入 12 枝验收样束', boot.loaded && boot.stems === 12, boot);

  // 郁金香不在 12 枝样束里（样束固定用玫瑰/多头玫瑰/尤加利），走正常放置入口
  // 真放一枝，场景会加载它真实的 headMetrics；这样才能同时拿到 4 类样本。
  await exec(() => {
    const s = window.__bouquetDebug.store;
    s.setPlacement('tulip-pink');
    const placed = s.placeStem({ tilt: 24, direction: 30, height: 0.04, scale: 1 });
    return placed;
  });
  await page.waitForFunction(() => {
    const d = window.__bouquetDebug;
    const stem = d.getState().doc.stems.find((x) => x.assetId === 'tulip-pink');
    return Boolean(stem && d.scene.views.get(stem.id)?.loaded);
  });
  await wait(600);

  // ---------- 真实花材样本：直接从场景已加载的 LoadedAsset 取 ----------
  const samples = await exec(() => {
    const d = window.__bouquetDebug;
    const state = d.getState();
    const out = {};
    for (const stem of state.doc.stems) {
      const view = d.scene.views.get(stem.id);
      const loaded = view?.loaded;
      if (!loaded) continue;
      const entry = state.catalog.entriesById[stem.assetId];
      if (out[stem.assetId]) continue;
      out[stem.assetId] = {
        assetId: stem.assetId,
        displayName: loaded.displayName,
        kind: entry?.kind ?? 'main',
        source: loaded.source,
        headMetrics: loaded.headMetrics ?? null,
        headParts: loaded.headParts ?? null,
        headRadius: loaded.headRadius,
        headHeight: loaded.headHeight,
        stemScale: stem.scale,
      };
    }
    return out;
  });
  check('取到 4 类真实样本（玫瑰/郁金香/多头玫瑰/绿叶）', Boolean(
    samples['rose-pink'] && samples['tulip-pink'] && samples['spray-rose-pink'] && samples['eucalyptus-green'],
  ), Object.keys(samples));

  const sampleSummary = Object.fromEntries(
    Object.entries(samples).map(([id, s]) => [
      id,
      {
        kind: s.kind,
        displayName: s.displayName,
        source: s.source,
        headMetrics: s.headMetrics
          ? {
              width: +s.headMetrics.width.toFixed(4),
              depth: +s.headMetrics.depth.toFixed(4),
              height: +s.headMetrics.height.toFixed(4),
              centerY: +s.headMetrics.centerY.toFixed(4),
            }
          : null,
        headParts: s.headParts
          ? s.headParts.map((p) => ({ radius: +p.radius.toFixed(4), offset: p.offset.map((n) => +n.toFixed(4)) }))
          : null,
        headRadius: +s.headRadius.toFixed(4),
      },
    ]),
  );

  // ---------- 1. 尺寸口径：椭球半轴 / 核心比例 / 多头逐个登记 ----------
  const geometry = await exec(async () => {
    const env = await import('/src/three/envelope.ts');
    const box = { width: 0.22, depth: 0.2, height: 0.13, centerY: 0.3 };
    const v = env.headVolume(box);
    const part = env.partVolume([0.05, 0.24, -0.02], 0.036);
    const long = env.longVolume(0.32, 0.03, 0.15);
    const scaled = env.headVolume(box, 0.8);
    return {
      head: { center: v.center, radii: v.radii, coreScale: v.coreScale, part: v.part },
      part: { center: part.center, radii: part.radii, coreScale: part.coreScale, part: part.part },
      long: { center: long.center, radii: long.radii, coreScale: long.coreScale },
      scaled: { center: scaled.center, radii: scaled.radii },
      defaultCoreScale: env.DEFAULT_CORE_SCALE,
      coreEpsilon: env.CORE_EPSILON,
    };
  });

  check(
    'headVolume：半轴 = 实测宽/深/高的一半，中心在 centerY',
    near(geometry.head.radii[0], 0.11) &&
      near(geometry.head.radii[2], 0.1) &&
      near(geometry.head.radii[1], 0.065) &&
      near(geometry.head.center[1], 0.3) &&
      geometry.head.part === 'head',
    geometry.head,
  );
  check(
    'headVolume：核心比例在 (0,1)，核心半轴 = 外缘 × 比例',
    geometry.head.coreScale > 0 &&
      geometry.head.coreScale < 1 &&
      geometry.head.coreScale === geometry.defaultCoreScale &&
      near(geometry.head.radii[0] * geometry.head.coreScale, 0.11 * geometry.defaultCoreScale),
    { coreScale: geometry.head.coreScale, halfAxis: geometry.head.radii[0] },
  );
  check(
    'partVolume：多头花单个头是球（三轴相等）且 offset 逐个登记',
    near(geometry.part.radii[0], 0.036) &&
      near(geometry.part.radii[1], 0.036) &&
      near(geometry.part.radii[2], 0.036) &&
      near(geometry.part.center[0], 0.05) &&
      near(geometry.part.center[1], 0.24) &&
      geometry.part.part === 'part',
    geometry.part,
  );
  check(
    'longVolume：长条花竖向半轴 > 横向半径（不再是单球）',
    near(geometry.long.radii[0], 0.03) &&
      near(geometry.long.radii[1], 0.15) &&
      near(geometry.long.radii[2], 0.03),
    geometry.long,
  );
  check(
    '缩放：整枝比例只乘一次（半轴与中心同比）',
    near(geometry.scaled.radii[0], 0.088) && near(geometry.scaled.center[1], 0.24),
    geometry.scaled,
  );

  // 真实样本：玫瑰/郁金香的 headVolume 与实测尺寸一致；多头玫瑰逐头登记。
  const realGeometry = await exec(
    async ({ samples }) => {
      const env = await import('/src/three/envelope.ts');
      const out = {};
      for (const [assetId, sample] of Object.entries(samples)) {
        if (sample.headMetrics) {
          const v = env.headVolume(sample.headMetrics, sample.stemScale);
          out[assetId] = {
            kind: 'head',
            radii: v.radii,
            coreRadii: v.radii.map((r) => r * (v.coreScale ?? env.DEFAULT_CORE_SCALE)),
            centerY: v.center[1],
            expected: {
              x: (sample.headMetrics.width / 2) * sample.stemScale,
              y: (sample.headMetrics.height / 2) * sample.stemScale,
              z: (sample.headMetrics.depth / 2) * sample.stemScale,
              centerY: sample.headMetrics.centerY * sample.stemScale,
            },
          };
          continue;
        }
        const parts = (sample.headParts ?? []).map((p) =>
          env.partVolume(p.offset, p.radius, sample.stemScale),
        );
        if (parts.length > 0) {
          out[assetId] = {
            kind: 'parts',
            count: parts.length,
            radii: parts.map((p) => p.radii),
            centers: parts.map((p) => p.center),
            expected: (sample.headParts ?? []).map((p) => ({
              radius: p.radius * sample.stemScale,
              offset: p.offset.map((n) => n * sample.stemScale),
            })),
          };
          continue;
        }
        // 没有分离花头的花型（绿叶/程序化花材）：场景侧只能按实测的
        // headHeight + headRadius 兜底构造包络。这里如实记录兜底参数与
        // 由它构造出的包络，不假装它是精确花头盒。
        const fallback = env.partVolume(
          [0, sample.headHeight, 0],
          sample.headRadius * 0.6,
          sample.stemScale,
        );
        out[assetId] = {
          kind: 'fallback',
          headHeight: sample.headHeight,
          headRadius: sample.headRadius,
          radii: fallback.radii,
          center: fallback.center,
        };
      }
      return out;
    },
    { samples },
  );

  const rose = realGeometry['rose-pink'];
  const tulip = realGeometry['tulip-pink'];
  check(
    '玫瑰：椭球半轴 = 实测花头 宽/高/深 的一半（±1e-6）',
    rose.kind === 'head' &&
      near(rose.radii[0], rose.expected.x) &&
      near(rose.radii[1], rose.expected.y) &&
      near(rose.radii[2], rose.expected.z),
    rose,
  );
  check(
    '郁金香：椭球半轴 = 实测花头 宽/高/深 的一半（±1e-6）',
    tulip.kind === 'head' &&
      near(tulip.radii[0], tulip.expected.x) &&
      near(tulip.radii[1], tulip.expected.y) &&
      near(tulip.radii[2], tulip.expected.z),
    tulip,
  );
  const spray = realGeometry['spray-rose-pink'];
  // V9：多头玫瑰已换成真实单网格 GLB（lux-spray.glb），没有程序化多头登记，
  // 场景走“单个实测花头”的兜底包络；程序化兜底（builtin 模式 / GLB 失败）仍是
  // 三个注册花头，各自一个球。两条路径分别断言，旧的精确性检查保留。
  const sprayEntry = await page.evaluate(() => {
    const entry = window.__bouquetDebug.getState().catalog.entriesById['spray-rose-pink'];
    return entry ? { glb: entry.glb ?? null, source: entry.source } : null;
  });
  if (sprayEntry?.glb) {
    check(
      `多头玫瑰（真实单网格 GLB ${sprayEntry.glb}）：没有程序化多头登记，按单个实测花头取兜底包络`,
      spray.kind === 'fallback' && spray.headRadius > 0.02 && spray.headHeight > 0.2,
      spray,
    );
    check(
      '该兜底包络是实心球（半径 = 实测半径 × 0.6），不会虚构成多个花头',
      spray.radii.length === 3 && spray.radii.every((n) => near(n, spray.radii[0]) && n > 0.01) && near(spray.radii[0], spray.headRadius * 0.6),
      spray,
    );
  } else {
    check(
      '多头玫瑰：每个花头单独一个球（数量与登记一致，不是一根大球）',
      spray.kind === 'parts' && spray.count >= 2 && spray.count === spray.expected.length,
      spray,
    );
    check(
      '多头玫瑰：每个球的半径与登记半径一致，中心按偏移分开',
      spray.radii.every((r, i) => near(r[0], spray.expected[i].radius)) &&
        spray.centers.every((c, i) =>
          c.every((n, k) => near(n, spray.expected[i].offset[k])),
        ) &&
        Math.hypot(
          spray.centers[0][0] - spray.centers[1][0],
          spray.centers[0][1] - spray.centers[1][1],
          spray.centers[0][2] - spray.centers[1][2],
        ) > 0.01,
      spray,
    );
  }
  const eu = realGeometry['eucalyptus-green'];
  check(
    '绿叶样本：没有分离花头，按实测 headHeight/headRadius 兜底构造包络（如实记录）',
    eu.kind === 'fallback' &&
      eu.headRadius > 0 &&
      eu.headHeight > 0 &&
      eu.radii.every((r) => r > 0),
    eu,
  );

  // ---------- 2. 支撑函数：最长轴端点 rim 边界 ----------
  const support = await exec(async () => {
    const env = await import('/src/three/envelope.ts');
    const long = env.longVolume(0.32, 0.03, 0.15);
    const box = { width: 0.22, depth: 0.2, height: 0.13, centerY: 0.3 };
    const head = env.headVolume(box);
    // 绕 Y 轴 90°：局部 x 轴转到世界 z 方向，支撑半径应互换。
    const yaw = env.quatNormalize([0, Math.sqrt(0.5), 0, Math.sqrt(0.5)]);
    const rotated = { ...head, rotation: yaw };
    const partA = env.partVolume([0, 1.0, 0], 0.1);
    const partB = env.partVolume([0, 1.18, 0], 0.1);
    const longA = { ...env.longVolume(0, 0.03, 0.15), center: [0, 1.0, 0] };
    const longB = { ...env.longVolume(0, 0.03, 0.15), center: [0, 1.28, 0] };
    return {
      longX: env.supportRadius(long, [1, 0, 0]),
      longY: env.supportRadius(long, [0, 1, 0]),
      longDegenerate: env.supportRadius(long, [0, 0, 0]),
      longMaxHalfAxis: Math.max(long.radii[0], long.radii[1], long.radii[2]),
      headX: env.supportRadius(head, [1, 0, 0]),
      headY: env.supportRadius(head, [0, 1, 0]),
      headZ: env.supportRadius(head, [0, 0, 1]),
      rotatedX: env.supportRadius(rotated, [1, 0, 0]),
      rotatedZ: env.supportRadius(rotated, [0, 0, 1]),
      sphereOverlap: env.overlapBetween(partA, partB),
      longOverlap: env.overlapBetween(longA, longB),
      diagonal: env.supportRadius(head, [1, 0, 1]),
    };
  });
  check(
    '支撑函数：沿最长轴端点的 rim 边界 = 该半轴（长条花 15cm）',
    near(support.longY, 0.15) && near(support.longX, 0.03),
    { x: support.longX, y: support.longY },
  );
  check(
    '支撑函数：方向退化时保守取最大半轴（不返回 0）',
    near(support.longDegenerate, support.longMaxHalfAxis),
    { degenerate: support.longDegenerate, maxHalfAxis: support.longMaxHalfAxis },
  );
  check(
    '支撑函数：椭球沿三轴取对应半轴，斜向按 sqrt(Σ(rᵢnᵢ)²)',
    near(support.headX, 0.11) &&
      near(support.headY, 0.065) &&
      near(support.headZ, 0.1) &&
      near(support.diagonal, Math.hypot(0.11 * Math.SQRT1_2, 0.1 * Math.SQRT1_2)),
    support,
  );
  check(
    '支撑函数：带朝向旋转后 x/z 支撑半径互换（花头朝向参与碰撞）',
    near(support.rotatedX, 0.1) && near(support.rotatedZ, 0.11),
    { rotatedX: support.rotatedX, rotatedZ: support.rotatedZ },
  );
  check(
    '沿最长轴两端相向：球穿深 = 半径和 - 中心距（r=0.1, 距离 0.18 → 2cm）',
    near(support.sphereOverlap.rim, 0.02) && near(support.sphereOverlap.core, 0),
    support.sphereOverlap,
  );
  check(
    '沿最长轴两端相向：长条椭球穿深 = 纵向半轴和 - 中心距（15+15-28=2cm）',
    near(support.longOverlap.rim, 0.02),
    support.longOverlap,
  );

  // ---------- 3. 宽容度边界：allowed / stricterLimits / residualOverlap ----------
  const limits = await exec(async () => {
    const env = await import('/src/three/envelope.ts');
    const sphere = (d, r = 0.1) => ({
      a: { center: [0, 0, 0], radii: [r, r, r], part: 'part' },
      b: { center: [d, 0, 0], radii: [r, r, r], part: 'part' },
    });
    const pair = sphere(0.182); // rim = 0.018 = main.rim 边界
    const beyond = sphere(0.18); // rim = 0.020 > main.rim
    const deep = sphere(0.1); // rim = 0.1、core = 0.044 都远超宽容度
    const kinds = {
      main: env.limitsFor('main'),
      filler: env.limitsFor('filler'),
      greenery: env.limitsFor('greenery'),
    };
    const overlapAtLimit = env.overlapBetween(pair.a, pair.b);
    const overlapBeyond = env.overlapBetween(beyond.a, beyond.b);
    const overlapDeep = env.overlapBetween(deep.a, deep.b);
    return {
      kinds,
      overlapAtLimit,
      allowedAtLimit: env.allowed(overlapAtLimit, kinds.main),
      overlapBeyond,
      allowedBeyond: env.allowed(overlapBeyond, kinds.main),
      residualBeyond: env.residualOverlap(overlapBeyond, kinds.main),
      overlapDeep,
      residualDeep: env.residualOverlap(overlapDeep, kinds.main),
      // 核心与外缘同时压线在几何上不可能（核心支撑总比外缘少固定一段），
      // 所以核心边界用纯对象验证 allowed 的判定语义。
      coreAtLimit: env.allowed({ core: kinds.main.core, rim: 0 }, kinds.main),
      coreBeyond: env.allowed({ core: kinds.main.core + 1e-6, rim: 0 }, kinds.main),
      rimAtLimitGreenery: env.allowed({ core: 0, rim: kinds.greenery.rim }, kinds.greenery),
      rimBeyondGreenery: env.allowed({ core: 0, rim: kinds.greenery.rim + 1e-6 }, kinds.greenery),
      stricterMainGreenery: env.stricterLimits(kinds.main, kinds.greenery),
      stricterMainFiller: env.stricterLimits(kinds.main, kinds.filler),
      coreEpsilon: env.CORE_EPSILON,
    };
  });
  check(
    '宽容度：外缘穿深正好等于 limits.rim 时仍算允许',
    near(limits.overlapAtLimit.rim, 0.018, 1e-9) && limits.allowedAtLimit === true,
    { overlap: limits.overlapAtLimit, allowed: limits.allowedAtLimit },
  );
  check(
    '宽容度：外缘穿深超过 limits.rim 时判为不允许',
    limits.overlapBeyond.rim > 0.018 && limits.allowedBeyond === false,
    { overlap: limits.overlapBeyond, allowed: limits.allowedBeyond },
  );
  check(
    '宽容度：核心穿深正好等于 limits.core 仍允许、超 1e-6 即不允许',
    limits.coreAtLimit === true && limits.coreBeyond === false,
    { atLimit: limits.coreAtLimit, beyond: limits.coreBeyond, core: limits.kinds.main.core },
  );
  check(
    '宽容度：绿叶外缘边界（4.5cm）同样按 allowed 判定',
    limits.rimAtLimitGreenery === true && limits.rimBeyondGreenery === false,
    { atLimit: limits.rimAtLimitGreenery, beyond: limits.rimBeyondGreenery },
  );
  check(
    '宽容度：花材分级（绿叶外缘最宽、核心仍严格）',
    limits.kinds.greenery.rim > limits.kinds.filler.rim &&
      limits.kinds.filler.rim > limits.kinds.main.rim &&
      limits.kinds.main.core <= limits.coreEpsilon + 1e-12,
    limits.kinds,
  );
  check(
    '宽容度：两枝相碰取更严格的一方（主花 vs 绿叶按主花）',
    limits.stricterMainGreenery.core === limits.kinds.main.core &&
      limits.stricterMainGreenery.rim === limits.kinds.main.rim &&
      limits.stricterMainFiller.rim === limits.kinds.main.rim,
    { mainGreenery: limits.stricterMainGreenery, mainFiller: limits.stricterMainFiller },
  );
  check(
    '非空重叠换算：residualOverlap 只留下超过宽容度的净穿透（2cm-1.8cm=2mm）',
    near(limits.residualBeyond.rim, 0.002, 1e-9) && near(limits.residualBeyond.core, 0),
    limits.residualBeyond,
  );
  check(
    '非空重叠换算：核心/外缘同时超限时两者都留下净穿透',
    limits.overlapDeep.core > limits.kinds.main.core &&
      limits.overlapDeep.rim > limits.kinds.main.rim &&
      near(limits.residualDeep.core, limits.overlapDeep.core - limits.kinds.main.core, 1e-9) &&
      near(limits.residualDeep.rim, limits.overlapDeep.rim - limits.kinds.main.rim, 1e-9),
    { overlap: limits.overlapDeep, residual: limits.residualDeep },
  );

  // ---------- 4. transformVolume：局部包络 → 世界 ----------
  const transformed = await exec(async () => {
    const env = await import('/src/three/envelope.ts');
    const part = env.partVolume([0.1, 0.2, 0], 0.05);
    // 绕 Y 轴 90°：(x,y,z) → (z, y, -x)
    const yaw = env.quatNormalize([0, Math.sqrt(0.5), 0, Math.sqrt(0.5)]);
    const world = env.transformVolume(part, [0, 0.8, 0], yaw, 1.5);
    const scaled = env.transformVolume(part, [0, 0.8, 0], [0, 0, 0, 1], 1.5);
    return {
      world: { center: world.center, radii: world.radii, rotation: world.rotation },
      scaled: { center: scaled.center, radii: scaled.radii },
      direction: env.separationDirection(world, { ...world, center: [world.center[0], world.center[1] + 1, world.center[2]] }),
      distance: env.centerDistance(world, { ...world, center: [world.center[0], world.center[1] + 1, world.center[2]] }),
    };
  });
  check(
    'transformVolume：中心 = 握点 + R·(局部中心×scale)，半轴同比缩放',
    near(transformed.world.center[0], 0, 1e-9) &&
      near(transformed.world.center[1], 0.8 + 0.2 * 1.5, 1e-9) &&
      near(transformed.world.center[2], -0.1 * 1.5, 1e-9) &&
      near(transformed.world.radii[0], 0.075, 1e-9),
    transformed.world,
  );
  check(
    'transformVolume：无旋转时局部 = 世界（只乘 scale）',
    near(transformed.scaled.center[0], 0.1 * 1.5) && near(transformed.scaled.center[1], 0.8 + 0.2 * 1.5),
    transformed.scaled,
  );
  check(
    'separationDirection / centerDistance：方向为 a→b 单位向量，距离是中心距',
    near(transformed.direction[0], 0) &&
      near(transformed.direction[1], 1) &&
      near(transformed.direction[2], 0) &&
      near(transformed.distance, 1),
    { direction: transformed.direction, distance: transformed.distance },
  );

  // ---------- 5. overlapWithOccupants：同枝不互算、按双方更严格宽容度判 valid ----------
  const occupants = await exec(async () => {
    const env = await import('/src/three/envelope.ts');
    const candidate = env.headVolume({ width: 0.2, depth: 0.2, height: 0.13, centerY: 0.3 });
    const world = env.transformVolume(candidate, [0, 0.8, 0], [0, 0, 0, 1], 1);
    // 与候选同心：核心穿深最大。
    const occupant = env.transformVolume(candidate, [0, 0.8, 0], [0, 0, 0, 1], 1);
    const selfOverlap = env.overlapWithOccupants(world, 'main', [{ stemId: 'a', kind: 'main', volumes: [occupant] }], 'a');
    const otherOverlap = env.overlapWithOccupants(world, 'main', [{ stemId: 'b', kind: 'main', volumes: [occupant] }], 'a');
    // 离得很远的占用者。
    const far = env.transformVolume(candidate, [0, 3.0, 0], [0, 0, 0, 1], 1);
    const farOverlap = env.overlapWithOccupants(world, 'main', [{ stemId: 'b', kind: 'main', volumes: [far] }], 'a');
    return { selfOverlap, otherOverlap, farOverlap };
  });
  check(
    'overlapWithOccupants：同一 stemId 的包络不互算（自身不判为碰撞）',
    occupants.selfOverlap.core === 0 && occupants.selfOverlap.rim === 0 && occupants.selfOverlap.valid === true,
    occupants.selfOverlap,
  );
  check(
    'overlapWithOccupants：同心另一枝核心穿深最大且判为无效',
    occupants.otherOverlap.core > 0.05 && occupants.otherOverlap.valid === false,
    occupants.otherOverlap,
  );
  check(
    'overlapWithOccupants：远处占用者不产生重叠且 valid',
    occupants.farOverlap.core === 0 && occupants.farOverlap.rim === 0 && occupants.farOverlap.valid === true,
    occupants.farOverlap,
  );

  await page.screenshot({ path: `${OUT}/01-sample.png` });

  check('无页面与 WebGL 错误', errors.length === 0, errors);
  writeFileSync(
    `${OUT}/results.json`,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        passed,
        checks,
        samples: sampleSummary,
        geometry,
        support,
        limits,
        transformed,
        occupants,
        errors,
        hmrNoise,
      },
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
