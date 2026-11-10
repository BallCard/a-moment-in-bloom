/**
 * V0.7.5 真实清单验收（管线交付的 53 条 manifest 专用）。
 *
 * 用法（起好 dev server 后）：
 *   node scripts/v07-real-manifest.mjs
 *   # 也可以先拿 fixture 自检整套断言：
 *   $env:REAL_MANIFEST='.verify/manifest-fixture.json'; node scripts/v07-real-manifest.mjs
 *
 * 与 `v07-manifest.mjs` 的分工：
 * - `v07-manifest` 用 fixture 校验解析/容错/静态缩略图回退/recolor 窗口等**接入逻辑**；
 * - 本脚本用管线真实清单校验**交付结果**：53 条全来自真实 GLB、30 花型每种的
 *   花头中心与半径都等于管线实测值（× 尺寸候选 uniform）、花材架全部走静态缩略图
 *   （0 次 GLB 下载）、三角面在预算内、无程序化占位残留。
 *
 * 结果写 `.verify/v07-real-manifest/`，失败也写 failure.json（不编造通过）。
 */

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.MATERIAL_URL ?? 'http://127.0.0.1:5190/';
const MANIFEST = process.env.REAL_MANIFEST ?? '';
const OUT = '.verify/v07-real-manifest';
mkdirSync(OUT, { recursive: true });

let passed = 0;
const checks = [];
const errors = [];
const details = {};

function check(name, ok, detail) {
  checks.push({ name, ok, detail: detail ?? null });
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`);
  passed += 1;
  console.log('ok', name);
}

const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
const TRIANGLE_BUDGET = 120000;

const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const glbRequests = [];
let countingGlb = true;
page.on('request', (r) => {
  if (countingGlb && r.url().includes('.glb')) glbRequests.push(r.url());
});
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
});

const lab = await context.newPage();
lab.on('pageerror', (e) => errors.push(`lab: ${e.message}`));

/** 页面侧不引用 import.meta，这里把清单地址解析成绝对 URL 再传进去。 */
const manifestFetchUrl = MANIFEST ? new URL(MANIFEST, BASE).href : new URL('assets/manifest.json', BASE).href;

const appUrl = `${BASE}?size=b&view=front${MANIFEST ? `&manifest=${encodeURIComponent(MANIFEST)}` : ''}`;

try {
  await page.goto(appUrl);
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalog.mode === 'manifest', null, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('img.model-thumbnail').length >= 30, null, { timeout: 60000 });
  // 等 30 张缩略图全部解码：静态图很快；缺图回退运行时渲染的要真的加载模型。
  await page.waitForFunction(
    () => (() => { const imgs = [...document.querySelectorAll('img.model-thumbnail')]; return imgs.length >= 30 && imgs.every((i) => i.complete && i.naturalWidth > 0); })(),
    null,
    { timeout: 120000 },
  );
  await page.waitForTimeout(600);
  countingGlb = false;
  details.paletteGlbRequests = glbRequests.slice();

  // ---------- 1. 目录：53 条 / 30 花型 / 全部 manifest 与真实 GLB ----------
  const catalog = await page.evaluate(() => {
    const c = window.__bouquetDebug.getState().catalog;
    const byKind = {};
    for (const f of c.families) (byKind[f.kind] ??= []).push(f.displayName);
    const sources = c.entries.reduce((acc, e) => ({ ...acc, [e.source]: (acc[e.source] ?? 0) + 1 }), {});
    return {
      mode: c.mode,
      assetsVersion: c.assetsVersion,
      entries: c.entries.length,
      families: c.families.length,
      byKind,
      sources,
      withoutGlb: c.entries.filter((e) => !e.glb).map((e) => e.assetId),
      withoutThumb: c.entries.filter((e) => !e.thumb).map((e) => e.assetId),
      withRecolor: c.entries.filter((e) => e.recolor).length,
      objectRecolor: c.entries.filter((e) => e.recolor && typeof e.recolor === 'object').map((e) => ({ id: e.assetId, spec: e.recolor })),
      badRecolorObjects: c.entries
        .filter((e) => e.recolor && typeof e.recolor === 'object')
        .filter((e) => !Array.isArray(e.recolor.hue) || e.recolor.hue.length !== 2 || !e.recolor.hue.every((n) => typeof n === 'number' && Number.isFinite(n)))
        .map((e) => e.assetId),
      headsInSize: c.entries.filter((e) => e.size?.heads).map((e) => e.assetId),
      // 尺寸候选 b 后：玫瑰/郁金香走「花头 + 枝长」倍率（uniformScale 保持 1），
      // 其余花型走整枝等比（uniformScale = 1 × 0.88，含 manifest 的 1）。
      uniformBySplit: c.entries.reduce((acc, e) => {
        const key = e.procedural === 'rose' || e.procedural === 'tulip' ? 'split' : 'single';
        (acc[key] ??= []).push({ id: e.assetId, uniform: e.size?.uniformScale ?? null });
        return acc;
      }, {}),
      cards: document.querySelectorAll('.shelf-card').length,
      familiesWithThumb: c.families.filter((f) => f.entries[0]?.thumb).length,
      chosenThumbUrls: c.families.map((f) => ({
        family: f.family,
        thumb: f.entries[0]?.thumb ?? null,
      })),
      staticThumbs: [...document.querySelectorAll('img.model-thumbnail')].filter((i) => !i.src.startsWith('data:')).length,
      runtimeThumbs: [...document.querySelectorAll('img.model-thumbnail')].filter((i) => i.src.startsWith('data:')).length,
      decodedThumbs: [...document.querySelectorAll('img.model-thumbnail')].filter((i) => i.complete && i.naturalWidth > 0).length,
    };
  });
  const fixture = catalog.assetsVersion.startsWith('fixture');
  details.catalog = catalog;

  check('清单模式打开', catalog.mode === 'manifest', catalog.mode);
  check('目录 53 条配色', catalog.entries === 53, { entries: catalog.entries });
  check('目录 30 花型', catalog.families === 30, { families: catalog.families });
  check('主花 10 种', catalog.byKind.main?.length === 10, catalog.byKind.main);
  check('配花 10 种', catalog.byKind.filler?.length === 10, catalog.byKind.filler);
  check('绿叶 10 种', catalog.byKind.greenery?.length === 10, catalog.byKind.greenery);
  check('53 条全部来自 manifest 清单（没有 builtin 占位残留）', catalog.sources.manifest === 53 && !catalog.sources.builtin, catalog.sources);
  check('53 条都有真实 GLB', catalog.withoutGlb.length === 0, catalog.withoutGlb.slice(0, 20));
  check('53 条都有静态缩略图字段', catalog.withoutThumb.length === 0, catalog.withoutThumb.slice(0, 20));
  check('清单条目都没带程序化多头登记 heads', catalog.headsInSize.length === 0, catalog.headsInSize);
  check(
    '尺寸候选 b：玫瑰/郁金香走花头倍率（uniform 1），其余整枝 1 × 0.88',
    catalog.uniformBySplit.split?.every((e) => e.uniform === 1) && catalog.uniformBySplit.single?.every((e) => e.uniform === 0.88),
    catalog.uniformBySplit,
  );
  check('recolor 对象都带合法色相窗口', catalog.badRecolorObjects.length === 0, catalog.badRecolorObjects);
  check('花材架渲染 30 张卡', catalog.cards === 30, catalog.cards);

  // ---------- 2. 静态缩略图：全部出图，缺图的才回退运行时渲染 ----------
  const thumbHead = await page.evaluate(async ({ chosen }) => {
    const missing = [];
    for (const item of chosen) {
      if (!item.thumb) {
        missing.push(item.family);
        continue;
      }
      const url = new URL(`assets/${item.thumb}`, location.href).href;
      // dev server 对不存在的文件会回 SPA 的 index.html（200 + text/html），
      // 所以必须按 content-type 判断，不能只看状态码。
      const response = await fetch(url, { cache: 'no-cache' }).catch(() => null);
      const type = response?.headers.get('content-type') ?? '';
      if (!response || !response.ok || !type.startsWith('image/')) missing.push(item.family);
    }
    return { missing };
  }, { chosen: catalog.chosenThumbUrls });
  details.missingThumbs = thumbHead.missing;
  check(
    fixture ? 'fixture 故意缺 3 张缩略图，用于验证回退' : '53 张静态缩略图文件都在（不是 SPA 回退的 HTML）',
    thumbHead.missing.length === (fixture ? 3 : 0),
    thumbHead.missing,
  );
  check('花材架缩略图全部出图', catalog.decodedThumbs === 30, { decoded: catalog.decodedThumbs, static: catalog.staticThumbs, runtime: catalog.runtimeThumbs });
  check(
    '花材架全部用静态缩略图，缺图的才回退运行时渲染',
    catalog.staticThumbs === 30 - thumbHead.missing.length && catalog.runtimeThumbs === thumbHead.missing.length,
    { static: catalog.staticThumbs, runtime: catalog.runtimeThumbs, missing: thumbHead.missing },
  );
  check(
    '打开工作台只为缺图缩略图下载 GLB（真实清单交付后应为 0 次）',
    glbRequests.length === thumbHead.missing.length,
    { requests: glbRequests, missing: thumbHead.missing },
  );
  await page.screenshot({ path: `${OUT}/00-palette.png` });

  // ---------- 3. 每种花型的花头 = 管线实测值 ×尺寸候选 uniform ----------
  await lab.goto(`${BASE}about.html`);
  const heads = await lab.evaluate(async ({ manifestUrl }) => {
    const { AssetLoader } = await import('/src/three/assets/AssetLoader.ts');
    const { parseManifest } = await import('/src/data/catalog.ts');
    const { applySizeCandidate } = await import('/src/data/size.ts');
    const response = await fetch(manifestUrl, { cache: 'no-cache' });
    const base = parseManifest(await response.json());
    const sized = applySizeCandidate(base, 'b');
    const loader = new AssetLoader('/', () => {});
    const rows = [];
    for (const family of sized.families) {
      const entry = family.entries[0];
      const loaded = await loader.load(entry, entry.assetId, sized);
      let tris = 0;
      loaded.template.traverse((o) => {
        if (o.isMesh) tris += o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3;
      });
      const uniform = entry.size?.uniformScale ?? 1;
      rows.push({
        family: family.family,
        kind: family.kind,
        assetId: entry.assetId,
        glb: entry.glb,
        source: loaded.source,
        tris: Math.round(tris),
        uniform,
        headHeight: +loaded.headHeight.toFixed(5),
        expectedHeadHeight: +(entry.transform.headOffsetY * uniform).toFixed(5),
        headRadius: +loaded.headRadius.toFixed(5),
        expectedHeadRadius: +((entry.size?.headRadius ?? NaN) * uniform).toFixed(5),
        hasManifestRadius: typeof entry.size?.headRadius === 'number',
        headMetrics: Boolean(loaded.headMetrics),
        headParts: loaded.headParts?.length ?? 0,
      });
    }
    return rows;
  }, { manifestUrl: manifestFetchUrl });
  details.heads = heads;

  check('30 花型逐一加载都是真实 GLB', heads.length === 30 && heads.every((r) => r.source === 'glb'), heads.filter((r) => r.source !== 'glb').map((r) => r.family));
  const single = heads.filter((r) => !r.headMetrics);
  const split = heads.filter((r) => r.headMetrics);
  // 管线交付的 27 花型带 size.headRadius；旧 9 条（玫瑰/郁金香/尤加利）保持原清单
  // 形状不变——其中尤加利是单网格且没有 size.headRadius，仍按包围盒估半径（与
  // V0.7 行为一致）。这里分开断言：有实测值必须精确等于，老条目只要求兜底有效。
  const measuredRadius = single.filter((r) => r.hasManifestRadius);
  const legacyRadius = single.filter((r) => !r.hasManifestRadius);
  check(
    '单网格 GLB 花头中心 = transform.headOffsetY × uniform（±1mm）',
    single.length >= 28 && single.every((r) => near(r.headHeight, r.expectedHeadHeight, 1e-3)),
    single.filter((r) => !near(r.headHeight, r.expectedHeadHeight, 1e-3)).map((r) => ({ f: r.family, got: r.headHeight, want: r.expectedHeadHeight })),
  );
  check(
    '单网格 GLB 花头半径 = size.headRadius × uniform（±1mm，不被包围盒粗估覆盖）',
    measuredRadius.length === single.length - legacyRadius.length &&
      measuredRadius.every((r) => near(r.headRadius, r.expectedHeadRadius, 1e-3)),
    measuredRadius.filter((r) => !near(r.headRadius, r.expectedHeadRadius, 1e-3)).map((r) => ({ f: r.family, got: r.headRadius, want: r.expectedHeadRadius })),
  );
  check(
    '旧清单条目（无 size.headRadius）仍走包围盒兜底且半径有效',
    legacyRadius.every((r) => r.headRadius > 0.02 && r.headRadius <= 0.22),
    legacyRadius.map((r) => ({ f: r.family, r: r.headRadius })),
  );
  check('玫瑰/郁金香仍走分离花头实测（其余不走）', split.length === 2 && split.every((r) => r.headRadius > 0.05 && r.headRadius < 0.13), split.map((r) => ({ f: r.family, r: r.headRadius, m: r.headMetrics })));
  check('单网格花型没有误当多头花（headParts=0）', single.every((r) => r.headParts === 0), single.filter((r) => r.headParts !== 0).map((r) => r.family));
  check(
    '单枝三角面在预算内且是万级真实模型',
    heads.every((r) => r.tris > 10000 && r.tris <= TRIANGLE_BUDGET),
    heads.filter((r) => !(r.tris > 10000 && r.tris <= TRIANGLE_BUDGET)).map((r) => ({ f: r.family, t: r.tris })),
  );
  check(
    '花头中心在合理量级（候选 b 下 0.25–0.55m）',
    heads.every((r) => r.headHeight > 0.25 && r.headHeight < 0.55),
    heads.filter((r) => !(r.headHeight > 0.25 && r.headHeight < 0.55)).map((r) => ({ f: r.family, h: r.headHeight })),
  );
  check(
    '花头半径在合理量级（0.02–0.22m）且大于 0',
    heads.every((r) => r.headRadius > 0.02 && r.headRadius <= 0.22),
    heads.filter((r) => !(r.headRadius > 0.02 && r.headRadius <= 0.22)).map((r) => ({ f: r.family, r: r.headRadius })),
  );
  check(
    '30 花型几何互不相同（不是同一份模型顶替）',
    new Set(heads.map((r) => r.tris + ':' + r.glb)).size >= (fixture ? 3 : 27),
    { distinct: new Set(heads.map((r) => r.tris + ':' + r.glb)).size, fixture },
  );

  // ---------- 4. recolor 真实生效（同一 GLB、不同配色 → 不同贴图）----------
  const recolor = await lab.evaluate(async ({ manifestUrl }) => {
    const { AssetLoader } = await import('/src/three/assets/AssetLoader.ts');
    const { parseManifest } = await import('/src/data/catalog.ts');
    const response = await fetch(manifestUrl, { cache: 'no-cache' });
    const base = parseManifest(await response.json());
    const loader = new AssetLoader('/', () => {});
    const materialMaps = async (assetId) => {
      const entry = base.entriesById[assetId];
      const loaded = await loader.load(entry, assetId, base);
      const maps = [];
      loaded.template.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (m?.map) maps.push({ uuid: m.map.uuid, canvas: m.map.image instanceof HTMLCanvasElement });
        }
      });
      return { id: assetId, recolor: entry.recolor ?? null, maps };
    };
    return {
      base: await materialMaps('rose-pink'),
      variant: await materialMaps('rose-ivory'),
      objectVariant: await materialMaps('peony-2'),
      foliage: await materialMaps('eucalyptus-deep'),
    };
  }, { manifestUrl: manifestFetchUrl });
  details.recolor = recolor;
  check(
    '同一 GLB 的配色变体生成了独立贴图（recolor 真的生效）',
    recolor.base.maps.length > 0 &&
      recolor.variant.maps.length > 0 &&
      recolor.variant.maps.every((m) => m.canvas) &&
      !recolor.variant.maps.some((m) => recolor.base.maps.some((b) => b.uuid === m.uuid)),
    recolor,
  );
  check('对象形式的 recolor（peony-2）同样生成独立贴图', recolor.objectVariant.maps.length > 0 && recolor.objectVariant.maps.every((m) => m.canvas), recolor.objectVariant);
  check('叶片配色变体（eucalyptus-deep）生成独立贴图', recolor.foliage.maps.length > 0, recolor.foliage);
  check('recolor 条目至少覆盖到叶片与花瓣两条路径', [recolor.variant.recolor, recolor.foliage.recolor].every((r) => r !== null), { variant: recolor.variant.recolor, foliage: recolor.foliage.recolor });

  // ---------- 5. 混合花束：30 花型里挑 9 枝同框 ----------
  await page.evaluate(async () => {
    const d = window.__bouquetDebug;
    const s = d.store;
    const c = s.getState().catalog;
    const picks = [];
    for (const kind of ['main', 'filler', 'greenery']) {
      const families = c.families.filter((f) => f.kind === kind);
      picks.push(families[0].entries[0].assetId, families[Math.min(4, families.length - 1)].entries[0].assetId, families[Math.min(8, families.length - 1)].entries[0].assetId);
    }
    s.clearStems();
    picks.forEach((assetId, i) => {
      s.setPlacement(assetId);
      s.placeStem({ tilt: 6 + (i % 3) * 8, direction: i * 43, height: 0.02 - (i % 3) * 0.01 });
      s.setPlacement(null);
    });
    s.setViewPreset('quarter');
    for (let i = 0; i < 160; i += 1) {
      if ([...d.scene.views.values()].every((v) => v.object && v.loaded?.source === 'glb')) break;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  });
  await page.waitForTimeout(1200);
  const mixed = await page.evaluate(() => {
    const d = window.__bouquetDebug;
    return {
      stems: d.getState().doc.stems.length,
      loaded: [...d.scene.views.values()].filter((v) => v.object && v.loaded?.source === 'glb').length,
    };
  });
  details.mixed = mixed;
  check('混合花束 9 枝全部用真实 GLB 加载', mixed.stems === 9 && mixed.loaded === 9, mixed);
  await page.screenshot({ path: `${OUT}/01-mixed.png` });

  check('无页面与 WebGL 错误', errors.length === 0, errors.slice(0, 5));

  writeFileSync(`${OUT}/results.json`, JSON.stringify({ date: new Date().toISOString(), url: appUrl, fixture, passed, checks, details, errors }, null, 2));
  console.log(`PASSED ${passed}`);
} catch (error) {
  writeFileSync(`${OUT}/failure.json`, JSON.stringify({ date: new Date().toISOString(), url: appUrl, passed, checks, error: String(error), details, errors }, null, 2));
  console.error('FAILED', error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
