/**
 * 生成 `app/.verify/manifest-fixture.json`：**不依赖管线进度**的全量测试清单。
 *
 * 背景：真实 manifest 由资产管线产出（53 条配色 / 30 花型，每条一个真实 GLB）。
 * 在管线交付前，应用侧也需要一条「目录满编」的端到端验证路径：这里用现有
 * 3 个真实 GLB 冒充 30 花型的 44 条新配色，并把管线将要写入的字段
 * （`thumb` / `recolor` 对象 / `size.uniformScale` / `size.headRadius` /
 * `transform.headOffsetY`）按同一契约造出来，其中夹带几条**故意写坏**的字段
 * 用来验证解析容错。
 *
 * 用法：先起 dev server，再 `node scripts/make-manifest-fixture.mjs`
 * 然后用 `http://127.0.0.1:5190/?manifest=.verify/manifest-fixture.json` 打开。
 *
 * 说明：fixture 只覆盖 manifest 的 JSON 内容，不放 public/、不改任何
 * baseUrl 解析规则——`glb` / `thumb` 仍按 `assets/` 相对解析，所以
 * `glb: "rose-pink.glb"` 依然指向真实的 `/assets/rose-pink.glb`。
 */

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.MATERIAL_URL ?? 'http://127.0.0.1:5190/';
const OUT = '.verify/manifest-fixture.json';
mkdirSync('.verify', { recursive: true });

const LEGACY_KEYS = ['tulip', 'rose', 'eucalyptus'];
/** 现有 3 个真实 GLB 及其换算参数（与 app/public/assets/manifest.json 一致）。 */
const SOURCE_GLB = {
  main: { glb: 'rose-pink.glb', scale: 1, rotationY: 0, gripAt: -0.205 },
  filler: { glb: 'tulip-pink.glb', scale: 0.93333, rotationY: 0, gripAt: -0.19 },
  greenery: { glb: 'eucalyptus-green.glb', scale: 0.83333, rotationY: 0, gripAt: -0.235 },
};
/** 现有 9 条真实配色的实测花头（管线会重测，这里用已知值）。 */
const LEGACY_HEAD = {
  'tulip-pink': 0.34313,
  'tulip-cream': 0.34313,
  'tulip-butter': 0.34313,
  'rose-pink': 0.36236,
  'rose-ivory': 0.36236,
  'rose-red': 0.36236,
  'eucalyptus-green': 0.40112,
  'eucalyptus-silver': 0.40112,
  'eucalyptus-deep': 0.40112,
};
const LEGACY_RADIUS = { rose: 0.112, tulip: 0.0885, eucalyptus: 0.188 };
/** 静态缩略图：用 public/assets 下真实存在的图片充当「管线生成的 thumbs/*.png」。 */
const STATIC_THUMBS = ['characters/lin.webp', 'characters/ache.webp', 'characters/xiaoman.webp'];
/** 故意缺文件的 thumb（验证 <img onError> → 运行时渲染回退）。 */
const BROKEN_THUMBS = new Set(['peony-1', 'carnation-1', 'sunflower-1']);
/** 故意写坏的字段（验证解析容错）。 */
const BAD_FIELDS = {
  'carnation-2': { recolor: { mode: 'not-a-mode' } },
  'lily-2': { recolor: { mode: 'petals', hue: [300] } },
  'calla-2': { size: { uniformScale: 1, headRadius: 'big' } },
  'statice-2': { recolor: { mode: 'petals', hue: [300, 60, 'x'] } },
  'sunflower-2': { recolor: { mode: 'all' } },
};

/** 合成花头的中心高度 / 占用半径（米，已含 transform.scale；管线实测口径）。 */
function syntheticHead(kind, index) {
  if (kind === 'main') return { headOffsetY: 0.4 + 0.006 * index, headRadius: 0.095 + 0.004 * index };
  if (kind === 'filler') return { headOffsetY: 0.35 + 0.005 * index, headRadius: 0.055 + 0.003 * index };
  return { headOffsetY: 0.38 + 0.006 * index, headRadius: 0.1 + 0.008 * index };
}

function thumbFor(assetId, familyIndex) {
  if (BROKEN_THUMBS.has(assetId)) return `thumbs/${assetId}.png`;
  return STATIC_THUMBS[familyIndex % STATIC_THUMBS.length];
}

const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
const page = await browser.newPage();
try {
  await page.goto(BASE);
  const { builtin, real } = await page.evaluate(async () => {
    const mod = await import('/src/data/builtin.ts');
    const entries = mod.buildBuiltinEntries();
    let raw = null;
    try {
      const response = await fetch('/assets/manifest.json', { cache: 'no-cache' });
      if (response.ok) raw = await response.json();
    } catch { /* 清单缺失时 fixture 全走合成值 */ }
    return {
      builtin: entries.map((e) => ({
        assetId: e.assetId,
        family: e.family,
        kind: e.kind,
        displayName: e.displayName,
        color: e.color,
        procedural: e.procedural,
      })),
      real: raw,
    };
  });
  const realById = new Map((real?.assets ?? []).filter((a) => a && typeof a.id === 'string').map((a) => [a.id, a]));

  // 与 parseManifest 的合并口径一致：legacy 三花型以真实清单为准（9 条），
  // 其余 27 花型（spray / daisy / V07 25 种）的 44 条配色全部合成。
  const legacy = builtin.filter((e) => LEGACY_KEYS.includes(e.procedural) && realById.has(e.assetId));
  const synthetic = builtin.filter((e) => !LEGACY_KEYS.includes(e.procedural));

  const assets = [];
  for (const entry of legacy) {
    const source = realById.get(entry.assetId);
    const head = LEGACY_HEAD[entry.assetId];
    const familyIndex = assets.length;
    const asset = {
      id: entry.assetId,
      kind: source.kind ?? entry.kind,
      displayName: source.displayName ?? entry.displayName,
      glb: source.glb,
      thumb: thumbFor(entry.assetId, familyIndex),
      transform: {
        scale: source.transform?.scale ?? 1,
        rotationY: source.transform?.rotationY ?? 0,
        gripAt: source.transform?.gripAt ?? 0,
        headOffsetY: head,
      },
      size: { uniformScale: 1, headRadius: LEGACY_RADIUS[entry.procedural] ?? 0.09 },
      fallback: { procedural: entry.procedural, color: source.fallback?.color ?? entry.color },
    };
    if (source.recolor !== undefined) asset.recolor = source.recolor;
    assets.push(asset);
  }

  // 合成 44 条：每个花型共用一份「冒充」GLB，但 transform.headOffsetY /
  // size.headRadius 逐花型给出不同实测值，用来验证花头取值不是按 GLB 猜的。
  let familyIndex = legacy.length;
  const variantCount = new Map();
  for (const entry of synthetic) {
    const index = (variantCount.get(entry.family) ?? 0) + 1;
    variantCount.set(entry.family, index);
    const head = syntheticHead(entry.kind, index);
    const source = SOURCE_GLB[entry.kind === 'main' ? 'main' : entry.kind === 'filler' ? 'filler' : 'greenery'];
    const bad = BAD_FIELDS[entry.assetId] ?? {};
    const asset = {
      id: entry.assetId,
      kind: entry.kind,
      displayName: entry.displayName,
      glb: source.glb,
      thumb: thumbFor(entry.assetId, familyIndex),
      transform: {
        scale: source.scale,
        rotationY: source.rotationY,
        gripAt: source.gripAt,
        headOffsetY: head.headOffsetY,
      },
      size: { uniformScale: 1, headRadius: head.headRadius, ...(bad.size ?? {}) },
      fallback: { procedural: entry.procedural, color: entry.color },
    };
    if (bad.recolor !== undefined) asset.recolor = bad.recolor;
    else if (entry.kind === 'greenery') asset.recolor = { mode: 'foliage', hue: [90, 210] };
    else if (index >= 2) asset.recolor = { mode: 'petals', hue: [300, 60] };
    assets.push(asset);
    familyIndex += 1;
  }

  const fixture = {
    schema_version: 1,
    assetsVersion: 'fixture-53x30-3glb',
    generated_at: new Date().toISOString(),
    note: 'app/scripts/make-manifest-fixture.mjs 生成的测试清单：53 条配色 / 30 花型，用现有 3 个 GLB 冒充，不含真实管线模型。',
    assets,
  };
  writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
  const counts = assets.reduce((acc, a) => ({ ...acc, [a.kind]: (acc[a.kind] ?? 0) + 1 }), {});
  console.log(`WROTE ${OUT} entries=${assets.length}`, counts);
} finally {
  await browser.close();
}
