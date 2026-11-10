/**
 * V0.7.5 清单接入验证（不依赖资产管线进度）。
 *
 * 用法：
 *   1) npm run dev -- --port 5190 --strictPort
 *   2) node scripts/make-manifest-fixture.mjs          # 生成 .verify/manifest-fixture.json
 *   3) node scripts/v07-manifest.mjs                   # 默认用 fixture 跑全量目录
 *      MANIFEST_TEST_URL=http://127.0.0.1:5190/ node scripts/v07-manifest.mjs
 *
 * 检查：
 * - 30 花型 / 53 条配色；manifest 覆盖到的 family 分组、中文名与 builtin 一致；
 * - `thumb` 静态缩略图：花材架用静态图，只有缺文件的那几条才回退到运行时渲染
 *   （按网络请求统计「不为 53 条配色逐个下载 GLB」）；
 * - `recolor` 字符串与 `{mode, hue:[a,b]}` 对象：默认窗口、环绕窗口、all、
 *   以及坏字段的容错；
 * - 单网格 GLB 的花头取值：headHeight = transform.headOffsetY × uniform、
 *   headRadius = size.headRadius × uniform（候选 b 再乘 0.88），
 *   不继承程序化多头登记（spray 不再出现 SPRAY_HEADS）；
 * - ProceduralKey 30 种与 builtin 的 V07_SPECIES / isProceduralKey 同源；
 * - 真实 manifest（当前 9 条）解析后仍能补齐 30 花型，旧路径不坏。
 *
 * 结果写 `.verify/v07-manifest/`（results.json + 截图），失败写 failure.json。
 */

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.MANIFEST_TEST_URL ?? 'http://127.0.0.1:5190/';
const FIXTURE = process.env.MANIFEST_FIXTURE ?? '.verify/manifest-fixture.json';
const OUT = '.verify/v07-manifest';
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

const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
});

const glbRequests = [];
let countingGlb = true;
page.on('request', (r) => {
  if (countingGlb && r.url().includes('.glb')) glbRequests.push(r.url());
});

const exec = (fn, arg) => page.evaluate(fn, arg);
const wait = (ms) => page.waitForTimeout(ms);
const near = (actual, expected, tolerance) => Math.abs(actual - expected) <= tolerance;

// 模块级断言放在第二个页面（about.html，同源但不启动工作台）：避免和花材架
// 已经占用的 GLB 模板 / WebGL 上下文抢内存——单网格 GLB 的花头实测要连开
// 好几份 7–8 MB 模板，混在一个页面里偶发内存压力会让加载失败走占位回退。
const lab = await context.newPage();
lab.on('pageerror', (e) => errors.push(`lab: ${e.message}`));
lab.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) errors.push(`lab: ${m.text()}`);
});
const labExec = (fn, arg) => lab.evaluate(fn, arg);

try {
  // ---------- 1. 用 fixture 清单打开应用 ----------
  await page.goto(`${BASE}?manifest=${encodeURIComponent(FIXTURE)}&size=b&view=front`);
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalog.mode === 'manifest', null, { timeout: 60000 });
  // 等花材架缩略图全部落定（静态图 onload / 坏图 onerror 回退后重渲染）。
  await page.waitForFunction(
    () => document.querySelectorAll('img.model-thumbnail').length >= 30,
    null,
    { timeout: 60000 },
  );
  await wait(2500);
  countingGlb = false;
  details.paletteGlbRequests = glbRequests.slice();

  const catalog = await exec(() => {
    const c = window.__bouquetDebug.getState().catalog;
    const byKind = {};
    for (const f of c.families) (byKind[f.kind] ??= []).push(f.displayName);
    return {
      mode: c.mode,
      assetsVersion: c.assetsVersion,
      entries: c.entries.length,
      families: c.families.length,
      byKind,
      sources: c.entries.reduce((acc, e) => ({ ...acc, [e.source]: (acc[e.source] ?? 0) + 1 }), {}),
      withThumb: c.entries.filter((e) => e.thumb).length,
      familyNames: c.families.map((f) => ({ family: f.family, name: f.displayName, kind: f.kind, note: f.note })),
      cards: document.querySelectorAll('.shelf-card').length,
    };
  });
  details.catalog = catalog;

  check('fixture 清单被读成 manifest 模式', catalog.mode === 'manifest', catalog.mode);
  check('目录 30 花型', catalog.families === 30, { families: catalog.families });
  check('目录 53 条配色', catalog.entries === 53, { entries: catalog.entries, sources: catalog.sources });
  check('主花 10 种', catalog.byKind.main?.length === 10, catalog.byKind.main);
  check('配花 10 种', catalog.byKind.filler?.length === 10, catalog.byKind.filler);
  check('绿叶 10 种', catalog.byKind.greenery?.length === 10, catalog.byKind.greenery);
  check('53 条全部来自 manifest 清单', catalog.sources.manifest === 53 && !catalog.sources.builtin, catalog.sources);
  check('花材架渲染 30 张卡', catalog.cards === 30, catalog.cards);
  check('53 条都带静态缩略图字段', catalog.withThumb === 53, catalog.withThumb);

  const familyNames = Object.fromEntries(catalog.familyNames.map((f) => [f.family, f]));
  check('花科中文名从 V07_SPECIES / familyMeta 取到', familyNames.peony?.name === '牡丹' && familyNames.spray?.name === '多头玫瑰' && familyNames.daisy?.name === '非洲菊' && familyNames['spray-chrysanthemum']?.name === '多头小菊' && familyNames['babys-breath']?.name === '满天星', familyNames);
  check('花材架分类与 kind 一致（主/配/绿各 10）', familyNames.peony?.kind === 'main' && familyNames.spray?.kind === 'filler' && familyNames.ruscus?.kind === 'greenery', null);

  // ---------- 2. 静态缩略图：只对缺文件的 3 条回退到运行时渲染 ----------
  const palette = await exec(() => {
    const images = [...document.querySelectorAll('img.model-thumbnail')];
    return {
      total: images.length,
      staticCount: images.filter((i) => !i.src.startsWith('data:')).length,
      runtimeCount: images.filter((i) => i.src.startsWith('data:')).length,
      decoded: images.filter((i) => i.complete && i.naturalWidth > 0).length,
      srcs: images.map((i) => (i.src.startsWith('data:') ? 'runtime' : i.src)),
    };
  });
  details.palette = { ...palette, srcs: undefined };
  check('花材架 30 张缩略图都有图', palette.total === 30 && palette.decoded === 30, { total: palette.total, decoded: palette.decoded });
  check('27 张用静态缩略图（不下载 GLB）', palette.staticCount === 27, { staticCount: palette.staticCount });
  check('3 条缺文件缩略图回退到运行时渲染', palette.runtimeCount === 3, { runtimeCount: palette.runtimeCount });
  check('花材架只加载 3 个 GLB（不是 53 条配色各下一次）', glbRequests.length === 3, glbRequests);

  await lab.goto(`${BASE}about.html`);

  // ---------- 3. 清单解析：尺寸口径 / recolor / thumb / 字段容错 ----------
  const parse = await labExec(async ({ fixture }) => {
    const { parseManifest } = await import('/src/data/catalog.ts');
    const response = await fetch(new URL(fixture, document.baseURI).href, { cache: 'no-cache' });
    const catalog = parseManifest(await response.json());
    const pick = (id) => {
      const entry = catalog.entriesById[id];
      if (!entry) return null;
      return {
        id,
        thumb: entry.thumb ?? null,
        recolor: entry.recolor ?? null,
        size: entry.size ?? null,
        family: entry.family,
        kind: entry.kind,
        headOffsetY: entry.transform?.headOffsetY,
        glb: entry.glb,
      };
    };
    return {
      fixtures: catalog.entries.map((e) => ({
        assetId: e.assetId,
        size: e.size ?? null,
        thumb: e.thumb ?? null,
        source: e.source,
        recolor: e.recolor ?? null,
      })),
      picks: ['peony-1', 'carnation-1', 'carnation-2', 'lily-2', 'calla-2', 'statice-2', 'sunflower-2', 'daisy-cream', 'spray-rose-pink', 'rose-pink'].map(pick),
    };
  }, { fixture: FIXTURE });
  details.parse = parse.picks;
  const byId = Object.fromEntries(parse.picks.map((p) => [p.id, p]));

  check('清单条目 size.uniformScale 显式 1（不继承程序化标定）', parse.fixtures.every((e) => e.size?.uniformScale === 1), parse.fixtures.filter((e) => e.size?.uniformScale !== 1).slice(0, 5));
  check('清单条目不带程序化多头登记 heads', parse.fixtures.every((e) => !e.size?.heads), parse.fixtures.filter((e) => e.size?.heads).slice(0, 5));
  check('单网格花型保留 size.headRadius（管线实测）', byId['peony-1']?.size?.headRadius === 0.099 && byId['spray-rose-pink']?.size?.headRadius === 0.058, { peony: byId['peony-1']?.size, spray: byId['spray-rose-pink']?.size });
  check('玫瑰/郁金香仍按花型默认保留花头倍率 0.8', parse.fixtures.find((e) => e.assetId === 'rose-pink')?.size?.headWidth === 0.8, parse.fixtures.find((e) => e.assetId === 'rose-pink')?.size);
  check('thumb 解析为相对 assets/ 的路径', byId['peony-1']?.thumb === 'thumbs/peony-1.png', byId['peony-1']?.thumb);
  check('坏 recolor mode 整条忽略（不换色）', byId['carnation-2']?.recolor === null, byId['carnation-2']?.recolor);
  check('坏 hue 只丢窗口，保留 petals 默认窗口', byId['lily-2']?.recolor === 'petals', byId['lily-2']?.recolor);
  check('haiku 多给一项的 hue 仍取前两位', JSON.stringify(byId['statice-2']?.recolor) === JSON.stringify({ mode: 'petals', hue: [300, 60] }), byId['statice-2']?.recolor);
  check('recolor 对象 {mode,hue} 解析出环绕窗口', JSON.stringify(byId['daisy-cream']?.recolor) === JSON.stringify({ mode: 'petals', hue: [300, 60] }), byId['daisy-cream']?.recolor);
  check('recolor {mode:"all"} 解析为 all', byId['sunflower-2']?.recolor === 'all', byId['sunflower-2']?.recolor);
  check('坏 headRadius（非数字）忽略并走回退', byId['calla-2']?.size?.headRadius === undefined && byId['calla-2']?.size?.uniformScale === 1, byId['calla-2']?.size);
  check('坏 thumb（缺文件）保留路径，交给 <img onError> 回退', byId['carnation-1']?.thumb === 'thumbs/carnation-1.png', byId['carnation-1']?.thumb);

  // ---------- 4. ProceduralKey 30 种与清单同源 ----------
  const keys = await labExec(async () => {
    const types = await import('/src/data/types.ts');
    const builtin = await import('/src/data/builtin.ts');
    const catalogModule = await import('/src/data/catalog.ts');
    const keys = types.PROCEDURAL_KEYS;
    return {
      count: keys.length,
      unique: new Set(keys).size,
      allRecognized: keys.every((k) => catalogModule.isProceduralKey(k)),
      bogusRejected: !catalogModule.isProceduralKey('not-a-flower') && !catalogModule.isProceduralKey(42) && !catalogModule.isProceduralKey(null),
      species: builtin.V07_SPECIES.length,
      speciesKeys: builtin.V07_SPECIES.map((s) => s.key),
      metaMatches: builtin.PROCEDURAL_KEYS_MATCH_SPECIES,
      inferred: {
        'tulip-rose': catalogModule.inferProceduralKey('tulip-rose'),
        'spray-chrysanthemum-1': catalogModule.inferProceduralKey('spray-chrysanthemum-1'),
        'peony-3': catalogModule.inferProceduralKey('peony-3'),
        'bear-grass-1': catalogModule.inferProceduralKey('bear-grass-1'),
      },
      families: keys.map((k) => builtin.familyMeta(k)?.displayName ?? null),
    };
  });
  details.keys = keys;
  check('ProceduralKey 共 30 种且唯一', keys.count === 30 && keys.unique === 30, { count: keys.count, unique: keys.unique });
  check('isProceduralKey 认全 30 种、拒绝坏值', keys.allRecognized && keys.bogusRejected, null);
  check('V07_SPECIES 25 种 + 5 个既有花型 = 30', keys.species === 25 && keys.metaMatches === true, { species: keys.species });
  check('30 花型都有中文名', keys.families.every((n) => typeof n === 'string' && n.length > 0), keys.families.filter((n) => !n));
  check(
    '缺资产 id 按 family 前缀回退（tulip-rose → tulip，spray-chrysanthemum 不被 spray 抢先）',
    keys.inferred['tulip-rose'] === 'tulip' && keys.inferred['spray-chrysanthemum-1'] === 'spray-chrysanthemum' && keys.inferred['peony-3'] === 'peony' && keys.inferred['bear-grass-1'] === 'bear-grass',
    keys.inferred,
  );

  // ---------- 5. recolor：默认窗口 / 环绕窗口 / all ----------
  const recolor = await labExec(async () => {
    // 页面里没有 import map，裸模块名要交给 Vite 的 /@id/ 解析。
    const THREE = await import('/@id/three');
    const { applyColorVariant } = await import('/src/three/assets/recolor.ts');

    const hslToRgb = (h, s, l) => {
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
      const m = l - c / 2;
      let r = 0; let g = 0; let b = 0;
      if (h < 60) [r, g, b] = [c, x, 0];
      else if (h < 120) [r, g, b] = [x, c, 0];
      else if (h < 180) [r, g, b] = [0, c, x];
      else if (h < 240) [r, g, b] = [0, x, c];
      else if (h < 300) [r, g, b] = [x, 0, c];
      else [r, g, b] = [c, 0, x];
      return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
    };

    const run = (spec) => {
      const canvas = document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      // 4 个像素：紫红 320° / 橙红 30° / 青绿 170° / 近灰(s=0.02)
      const pixels = [hslToRgb(320, 0.8, 0.55), hslToRgb(30, 0.9, 0.5), hslToRgb(170, 0.7, 0.45), [128, 128, 131]];
      pixels.forEach((rgb, i) => {
        ctx.fillStyle = `rgb(${rgb.map((n) => Math.round(n)).join(',')})`;
        ctx.fillRect(i, 0, 1, 1);
      });
      const texture = new THREE.CanvasTexture(canvas);
      const material = new THREE.MeshStandardMaterial({ map: texture });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      applyColorVariant(mesh, spec, '#22cc44');
      const nextCanvas = mesh.material.map.image;
      const data = nextCanvas.getContext('2d').getImageData(0, 0, 4, 1).data;
      return [0, 1, 2, 3].map((i) => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
    };
    const source = [
      [hslToRgb(320, 0.8, 0.55), hslToRgb(30, 0.9, 0.5), hslToRgb(170, 0.7, 0.45), [128, 128, 131]],
    ][0].map((rgb) => rgb.map((n) => Math.round(n)));
    const wrap = run({ mode: 'petals', hue: [300, 60] });
    const petals = run('petals');
    const foliage = run('foliage');
    const all = run('all');
    const changed = (a, b) => a.some((v, i) => Math.abs(v - b[i]) > 6);
    const greenish = (rgb) => rgb[1] > rgb[0] && rgb[1] > rgb[2];
    return {
      source,
      wrap: { pixels: wrap, changed: source.map((rgb, i) => changed(rgb, wrap[i])) },
      petals: { changed: source.map((rgb, i) => changed(rgb, petals[i])) },
      foliage: { changed: source.map((rgb, i) => changed(rgb, foliage[i])) },
      all: { changed: source.map((rgb, i) => changed(rgb, all[i])), greenish: all.slice(0, 3).map(greenish) },
    };
  });
  details.recolor = recolor;
  check('环绕窗口 [300,60]：320° 与 30° 都改色', recolor.wrap.changed[0] && recolor.wrap.changed[1], recolor.wrap.changed);
  check('环绕窗口 [300,60]：170° 与近灰像素不改', !recolor.wrap.changed[2] && !recolor.wrap.changed[3], recolor.wrap.changed);
  check("字符串 'petals' 默认窗口仍覆盖 320°/30°、不碰 170°", recolor.petals.changed.slice(0, 3).join(',') === 'true,true,false', recolor.petals.changed);
  check("字符串 'foliage' 默认窗口覆盖 170°、不碰 320°/30°", recolor.foliage.changed.join(',') === 'false,false,true,false', recolor.foliage.changed);
  check("mode 'all' 改所有有彩像素、近灰不动", recolor.all.changed.join(',') === 'true,true,true,false' && recolor.all.greenish.every(Boolean), recolor.all);

  // ---------- 6. 缩略图模块：静态 URL / 强制运行时渲染 ----------
  const thumbs = await labExec(async ({ fixture }) => {
    const { assetThumbnail } = await import('/src/three/assets/thumbnails.ts');
    const { parseManifest } = await import('/src/data/catalog.ts');
    const response = await fetch(new URL(fixture, document.baseURI).href, { cache: 'no-cache' });
    const catalog = parseManifest(await response.json());
    const broken = catalog.entriesById['peony-1'];
    const staticUrl = await assetThumbnail(broken, catalog);
    const staticResolved = new URL(staticUrl, location.href).href;
    const started = performance.now();
    const runtime = await assetThumbnail(broken, catalog, { forceRuntime: true });
    return {
      staticUrl,
      staticResolved,
      runtimePrefix: runtime.slice(0, 22),
      runtimeBytes: Math.round((runtime.length - runtime.indexOf(',') - 1) * 3 / 4),
      runtimeMs: Math.round(performance.now() - started),
    };
  }, { fixture: FIXTURE });
  details.thumbs = thumbs;
  check('静态缩略图返回相对 assets/ 的 URL', thumbs.staticResolved.endsWith('/assets/thumbs/peony-1.png'), thumbs.staticResolved);
  check('forceRuntime 绕过静态图、渲染出 PNG', thumbs.runtimePrefix === 'data:image/png;base64,' && thumbs.runtimeBytes > 1500, thumbs);

  // ---------- 7. 单网格 GLB 的花头取值（候选 a 基准 / 候选 b 缩放）----------
  const heads = await labExec(async ({ fixture }) => {
    const { AssetLoader } = await import('/src/three/assets/AssetLoader.ts');
    const { parseManifest } = await import('/src/data/catalog.ts');
    const { applySizeCandidate } = await import('/src/data/size.ts');
    const response = await fetch(new URL(fixture, document.baseURI).href, { cache: 'no-cache' });
    const base = parseManifest(await response.json());
    const sized = applySizeCandidate(base, 'b');
    const failures = [];
    const loader = new AssetLoader('/', () => {}, {
      onFailure: (assetId, message) => failures.push({ assetId, message }),
    });

    const measure = async (catalog, assetId, label) => {
      const entry = catalog.entriesById[assetId];
      const loaded = await loader.load(entry, assetId, catalog);
      return {
        label,
        assetId,
        source: loaded.source,
        headHeight: +loaded.headHeight.toFixed(5),
        headRadius: +loaded.headRadius.toFixed(5),
        headMetrics: loaded.headMetrics
          ? { centerY: +loaded.headMetrics.centerY.toFixed(5), width: +loaded.headMetrics.width.toFixed(5), depth: +loaded.headMetrics.depth.toFixed(5) }
          : null,
        headParts: loaded.headParts ?? null,
        uniform: entry.size?.uniformScale ?? null,
        manifestHeadOffsetY: entry.transform?.headOffsetY ?? null,
        manifestHeadRadius: entry.size?.headRadius ?? null,
      };
    };
    const result = {
      peonyA: await measure(base, 'peony-1', 'a'),
      peonyB: await measure(sized, 'peony-1', 'b'),
      sprayA: await measure(base, 'spray-rose-pink', 'a'),
      required: {
        peonyA: await measure(base, 'herbaceous-peony-1', 'a'),
        greeneryA: await measure(base, 'ruscus-1', 'a'),
      },
      rose: await measure(sized, 'rose-pink', 'b'),
      tulip: await measure(sized, 'tulip-cream', 'b'),
      failures,
    };
    return result;
  }, { fixture: FIXTURE });
  details.heads = heads;

  const peonyA = heads.peonyA;
  check('单网格 GLB 走真实模型（非占位）', peonyA.source === 'glb' && heads.sprayA.source === 'glb', { peony: peonyA.source, spray: heads.sprayA.source });
  check('单网格 GLB 没有分离花头（headMetrics 为 null）', peonyA.headMetrics === null, peonyA.headMetrics);
  check('manifest 条目不再继承程序化多头登记（spray 单网格）', heads.sprayA.headParts === null && heads.sprayA.headMetrics === null, { parts: heads.sprayA.headParts });
  check(
    '花头中心 = transform.headOffsetY × uniform（候选 a uniform=1）',
    near(peonyA.headHeight, peonyA.manifestHeadOffsetY, 1e-4) &&
      near(heads.required.peonyA.headHeight, heads.required.peonyA.manifestHeadOffsetY, 1e-4) &&
      near(heads.required.greeneryA.headHeight, heads.required.greeneryA.manifestHeadOffsetY, 1e-4),
    { peonyA, required: heads.required },
  );
  check(
    '花头半径 = size.headRadius × uniform（不被包围盒粗估覆盖）',
    near(peonyA.headRadius, peonyA.manifestHeadRadius, 1e-4) &&
      near(heads.sprayA.headRadius, heads.sprayA.manifestHeadRadius, 1e-4) &&
      near(heads.required.greeneryA.headRadius, heads.required.greeneryA.manifestHeadRadius, 1e-4),
    { peonyA, sprayA: heads.sprayA, greeneryA: heads.required.greeneryA },
  );
  check(
    '候选 b：GLB 条目 uniformScale 1 → 0.88，花头随之等比',
    heads.peonyB.uniform === 0.88 && near(heads.peonyB.headHeight, peonyA.manifestHeadOffsetY * 0.88, 1e-4) && near(heads.peonyB.headRadius, peonyA.manifestHeadRadius * 0.88, 1e-4),
    heads.peonyB,
  );
  check('玫瑰/郁金香仍走分离花头实测（headMetrics 非空）', heads.rose.headMetrics !== null && heads.tulip.headMetrics !== null, { rose: heads.rose.headMetrics, tulip: heads.tulip.headMetrics });
  check('花头中心与半径都在合理量级', [peonyA, heads.sprayA, heads.required.greeneryA].every((item) => item.headHeight > 0.2 && item.headHeight < 0.6 && item.headRadius > 0.02 && item.headRadius <= 0.22), [peonyA, heads.sprayA, heads.required.greeneryA]);

  // ---------- 8. 场景内放置：花头/半径与接触包络 ----------
  const placed = await exec(async () => {
    const d = window.__bouquetDebug;
    const s = d.store;
    s.clearStems();
    s.setPlacement('peony-1');
    s.placeStem({ tilt: 6, direction: 0, height: 0.02 });
    s.setPlacement(null);
    const id = s.getState().doc.stems[0]?.id;
    for (let i = 0; i < 120; i += 1) {
      if (d.scene.views.get(id)?.loaded) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const view = d.scene.views.get(id);
    const loaded = view?.loaded ?? null;
    const entry = s.getState().catalog.entriesById['peony-1'];
    return {
      stem: s.getState().doc.stems.length,
      source: loaded?.source ?? null,
      headHeight: loaded ? +loaded.headHeight.toFixed(5) : null,
      headRadius: loaded ? +loaded.headRadius.toFixed(5) : null,
      expected: {
        uniform: entry.size?.uniformScale,
        headOffsetY: entry.transform?.headOffsetY,
        headRadius: entry.size?.headRadius,
      },
      screen: d.getStemScreenPoint(id),
      sceneState: d.getSceneState(),
    };
  });
  details.placed = placed;
  check(
    '场景实际放置使用管线实测花头（候选 b）',
    placed.stem === 1 && placed.source === 'glb' && near(placed.headHeight, placed.expected.headOffsetY * placed.expected.uniform, 1e-4) && near(placed.headRadius, placed.expected.headRadius * placed.expected.uniform, 1e-4),
    placed,
  );
  check('选中锚点落在视口内', placed.screen && placed.screen.visible && placed.screen.x > 0 && placed.screen.y > 0, placed.screen);
  await page.screenshot({ path: `${OUT}/01-static-thumbs.png` });

  // 混合花束截图：确认 30 花型都能在场景里用同一份 GLB 冒充渲染。
  await exec(async () => {
    const d = window.__bouquetDebug;
    const s = d.store;
    s.clearStems();
    const catalog = s.getState().catalog;
    const picks = ['peony-1', 'lily-2', 'sunflower-1', 'lisianthus-1', 'babys-breath-1', 'statice-2', 'ruscus-1', 'ivy-1', 'eucalyptus-green'];
    picks.forEach((assetId, i) => {
      s.setPlacement(assetId);
      s.placeStem({ tilt: 6 + (i % 4) * 7, direction: i * 47, height: 0.03 - (i % 3) * 0.01 });
      s.setPlacement(null);
    });
    for (let i = 0; i < 160; i += 1) {
      if ([...d.scene.views.values()].every((v) => v.object)) break;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    s.setViewPreset('quarter');
  });
  await wait(1200);
  await page.screenshot({ path: `${OUT}/02-mixed.png` });

  // ---------- 9. 真实 manifest（当前 9 条）仍可用且补齐 30 花型 ----------
  const legacy = await exec(async () => {
    const { parseManifest } = await import('/src/data/catalog.ts');
    const response = await fetch('/assets/manifest.json', { cache: 'no-cache' });
    const raw = await response.json();
    const catalog = parseManifest(raw);
    const manifestEntries = catalog.entries.filter((e) => e.source === 'manifest');
    return {
      rawCount: Array.isArray(raw.assets) ? raw.assets.length : -1,
      entries: catalog.entries.length,
      families: catalog.families.length,
      manifestCount: manifestEntries.length,
      proceduralCount: catalog.entries.filter((e) => e.source === 'builtin' && !e.glb).length,
      glbCount: catalog.entries.filter((e) => Boolean(e.glb)).length,
      kinds: catalog.families.reduce((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] ?? 0) + 1 }), {}),
    };
  });
  details.legacy = legacy;
  check('真实 manifest 仍按原样解析', legacy.rawCount === 9 && legacy.manifestCount === 9, legacy);
  check('真实 manifest 未覆盖的花型用 builtin 占位补齐（30 花型）', legacy.families === 30 && legacy.entries === 53 && legacy.glbCount === 9, legacy);
  check('补齐部分仍是程序化占位（等管线交付）', legacy.proceduralCount === 44, legacy);

  check('无页面与 WebGL 错误', errors.length === 0, errors.slice(0, 5));

  writeFileSync(
    `${OUT}/results.json`,
    JSON.stringify({ date: new Date().toISOString(), base: BASE, fixture: FIXTURE, passed, checks, details, errors }, null, 2),
  );
  console.log(`PASSED ${passed}`);
} catch (error) {
  writeFileSync(
    `${OUT}/failure.json`,
    JSON.stringify({ date: new Date().toISOString(), passed, checks, error: String(error), details, errors }, null, 2),
  );
  console.error('FAILED', error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
