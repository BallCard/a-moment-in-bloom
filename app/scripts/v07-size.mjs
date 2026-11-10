/**
 * V7 §2 尺寸候选验收证据：尺寸依据实测 + a/b/c 候选对照。
 *
 * 用法（先确认 dev 服务已在跑，默认 127.0.0.1:5190）：
 *   node scripts/v07-size.mjs                      # 自动探测 ?size=，能跑哪些候选跑哪些
 *   node scripts/v07-size.mjs --sizes=a,b,c        # 指定候选
 *   node scripts/v07-size.mjs --bundles=6,12,20    # 指定样束
 *   node scripts/v07-size.mjs --views=front,side,top,back
 *   node scripts/v07-size.mjs --measure-only       # 只做逐种尺寸依据测量，不截图
 *   SIZE_OUT=before node scripts/v07-size.mjs      # 输出到 .verify/v07-size/before/（before 基线）
 *
 * 产出（默认目录 .verify/v07-size/，可用 SIZE_OUT 加子目录）：
 *   - results.json：真实测量、候选对照表、断言结果、相机取景与主观观察占位
 *   - <bundle>-<candidate>-<view>.png：6/12/20 枝 × a/b/c × 正/侧/俯/背
 *   - <bundle>-<candidate>-front-fixedcam.png：固定取景（消除相机自动拉远的影响）
 *   - headonly-<value>-front.png：只改花头（?head=0.80/0.64/0.56）的 12 枝对照
 *   - 拼版图由同目录 make_sheet.py 生成（见脚本末尾注释）
 *
 * 设计说明：
 *   - 「可见花头」= 只统计实际渲染索引（index）引用的顶点，避免把 prepareFlower
 *     裁掉却仍留在 position 里的顶点算进花头包围盒。这个测量独立于
 *     loaded.headMetrics，用来验证尺寸依据是否修好。
 *   - 只读页面状态，不写作品；截图统一截 [data-testid=viewport] 元素。
 *   - 断言失败不中断：全部写进 results.json，交给 Lead 判断修没修好。
 *   - 观感（比例是否协调、四面是否好看）放 observations 字段，明确标注主观。
 */

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const BASE = process.env.SIZE_URL ?? 'http://127.0.0.1:5190/';
const args = new Map(
  process.argv
    .slice(2)
    .filter((item) => item.startsWith('--'))
    .map((item) => {
      const [key, value = '1'] = item.replace(/^--/, '').split('=');
      return [key, value];
    }),
);
const OUT = `.verify/v07-size${process.env.SIZE_OUT ? `/${process.env.SIZE_OUT}` : ''}`;
mkdirSync(OUT, { recursive: true });

const MEASURE_ONLY = args.has('measure-only');
const HEADED = process.env.HEADED === '1';
const BUNDLES = (args.get('bundles') ?? '6,12,20').split(',').map(Number).filter(Boolean);
const VIEWS = (args.get('views') ?? 'front,side,top,back').split(',').filter(Boolean);
const CANDIDATE_META = {
  a: { label: 'a（当前尺寸，花头 0.80）', head: 0.8, note: '基线：玫瑰/郁金香花头 0.80，枝长/叶片不变' },
  b: { label: 'b（花头 0.64、枝长 -12%、叶片 -15%、程序花 ×0.88）', head: 0.64, note: '候选 b' },
  c: { label: 'c（花头 0.56、枝长 -15%、叶片 -20%、程序花 ×0.85）', head: 0.56, note: '候选 c' },
};
const HEAD_ONLY = [0.8, 0.64, 0.56];

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
  headless: !HEADED,
  args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on('pageerror', (error) =>
  errors.push({ step, message: error.message, stack: (error.stack ?? '').slice(0, 1200) }),
);
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('404')) errors.push({ step, message: message.text() });
});

const wait = (ms) => page.waitForTimeout(ms);

/** 打开一个带校准参数的页面，等目录与所有花枝视图就绪。返回 ready 状态，失败时抛错。 */
async function open(query, { expectStems = 1 } = {}) {
  const url = `${BASE}?${query}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalog.mode === 'manifest', null, {
    timeout: 25000,
  });
  await page.waitForFunction(
    (minStems) => {
      const state = window.__bouquetDebug.getState();
      if (state.doc.stems.length < minStems) return false;
      const views = window.__bouquetDebug.scene.views;
      return [...views.values()].every((view) => view.object && view.loaded);
    },
    expectStems,
    { timeout: 25000 },
  );
  // 等相机取景与接触弹簧收敛，截图才稳定。
  await wait(1300);
}

async function shot(name) {
  await page.locator('[data-testid=viewport]').screenshot({ path: `${OUT}/${name}.png` });
}

/** 用实际渲染索引统计花头包围盒（模板/实例的世界矩阵都算进去）。 */
function indexedHeadMeasure() {
  // 这个函数会被序列化到页面里执行，不能引用 Node 侧变量。
  return async () => {
    const d = window.__bouquetDebug;
    const state = d.getState();
    const pose = await import('/src/data/pose.ts');

    /** 只遍历 index 引用的顶点；没有 index 的几何退化为全顶点。 */
    function indexedBounds(mesh) {
      const geometry = mesh.geometry;
      const position = geometry?.getAttribute?.('position');
      if (!position) return null;
      mesh.updateWorldMatrix(true, false);
      const e = mesh.matrixWorld.elements;
      const index = geometry.index;
      const count = index ? index.count : position.count;
      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < count; i += 1) {
        const vertex = index ? index.getX(i) : i;
        const x = position.getX(vertex);
        const y = position.getY(vertex);
        const z = position.getZ(vertex);
        const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
        const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
        const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
        if (wx < minX) minX = wx;
        if (wy < minY) minY = wy;
        if (wz < minZ) minZ = wz;
        if (wx > maxX) maxX = wx;
        if (wy > maxY) maxY = wy;
        if (wz > maxZ) maxZ = wz;
      }
      if (!Number.isFinite(minX)) return null;
      return {
        width: maxX - minX,
        depth: maxZ - minZ,
        height: maxY - minY,
        bottom: minY,
        top: maxY,
        centerY: (minY + maxY) / 2,
        centerX: (minX + maxX) / 2,
        centerZ: (minZ + maxZ) / 2,
        vertices: count,
      };
    }

    /** 收集一个对象下所有「花头」网格的索引包围盒（合并）。 */
    function headBounds(root) {
      const boxes = [];
      root.updateMatrixWorld(true);
      root.traverse((object) => {
        const mesh = object;
        if (!mesh.isMesh) return;
        if (!/flower-head|head/i.test(mesh.name ?? '')) return;
        const box = indexedBounds(mesh);
        if (box) boxes.push(box);
      });
      if (boxes.length === 0) return null;
      return {
        width: Math.max(...boxes.map((b) => b.width)),
        depth: Math.max(...boxes.map((b) => b.depth)),
        height: Math.max(...boxes.map((b) => b.top)) - Math.min(...boxes.map((b) => b.bottom)),
        bottom: Math.min(...boxes.map((b) => b.bottom)),
        top: Math.max(...boxes.map((b) => b.top)),
        centerY: (Math.min(...boxes.map((b) => b.bottom)) + Math.max(...boxes.map((b) => b.top))) / 2,
        parts: boxes.length,
        vertices: boxes.reduce((sum, b) => sum + b.vertices, 0),
      };
    }

    // ---------- 1. 逐种：loaded.headMetrics vs 索引顶点实测 ----------
    const catalog = state.catalog;
    const strictBounds = (loaded) => {
      // headMetrics 是模板空间尺寸（已含整枝 uniform），所以用模板 matrixWorld 量。
      return headBounds(loaded.template);
    };

    const assets = [];
    for (const entry of catalog.entries) {
      let loaded = null;
      let error = null;
      try {
        loaded = await d.scene.assetLoader.load(entry, entry.assetId, catalog);
      } catch (caught) {
        error = String(caught);
      }
      if (!loaded) {
        assets.push({ assetId: entry.assetId, procedural: entry.procedural, kind: entry.kind, error });
        continue;
      }
      const visible = strictBounds(loaded);
      const upper = loaded.template.getObjectByName('prepared-upper-stem');
      let upperTop = null;
      if (upper) {
        upper.updateWorldMatrix(true, false);
        const e = upper.matrixWorld.elements;
        const full =
          typeof upper.userData?.fullHeight === 'number' ? upper.userData.fullHeight : null;
        if (full != null) {
          // 圆柱局部坐标 y ∈ [-full/2, +full/2]，mesh 自身 scale.y 与 position.y 都进 matrixWorld。
          const localTop = full / 2;
          upperTop = e[1] * 0 + e[5] * localTop + e[9] * 0 + e[13];
        }
      }
      // 整枝（含花头/茎/叶）索引包围盒：用于记录可见高度。
      assets.push({
        assetId: entry.assetId,
        procedural: entry.procedural,
        kind: entry.kind,
        mode: catalog.mode,
        uniform: entry.size?.uniformScale ?? null,
        config: entry.size ?? null,
        headHeight: loaded.headHeight,
        headRadius: loaded.headRadius,
        headParts: loaded.headParts?.length ?? 0,
        headMetrics: loaded.headMetrics ?? null,
        visibleHead: visible,
        upperStemTop: upperTop,
      });
    }

    return {
      assets,
      catalog: { mode: catalog.mode, assetsVersion: catalog.assetsVersion, count: catalog.entries.length },
    };
  };
}

/** 采集页面状态：花枝世界姿态、可见花头、整束外廓、相机、包装半径、候选配置。 */
function collectScene() {
  return async () => {
    const d = window.__bouquetDebug;
    const state = d.getState();
    const pose = await import('/src/data/pose.ts');

    function indexedBounds(mesh) {
      const geometry = mesh.geometry;
      const position = geometry?.getAttribute?.('position');
      if (!position) return null;
      mesh.updateWorldMatrix(true, false);
      const e = mesh.matrixWorld.elements;
      const index = geometry.index;
      const count = index ? index.count : position.count;
      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < count; i += 1) {
        const vertex = index ? index.getX(i) : i;
        const x = position.getX(vertex);
        const y = position.getY(vertex);
        const z = position.getZ(vertex);
        const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
        const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
        const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
        if (wx < minX) minX = wx;
        if (wy < minY) minY = wy;
        if (wz < minZ) minZ = wz;
        if (wx > maxX) maxX = wx;
        if (wy > maxY) maxY = wy;
        if (wz > maxZ) maxZ = wz;
      }
      if (!Number.isFinite(minX)) return null;
      return {
        width: maxX - minX,
        depth: maxZ - minZ,
        height: maxY - minY,
        bottom: minY,
        top: maxY,
        centerY: (minY + maxY) / 2,
        centerX: (minX + maxX) / 2,
        centerZ: (minZ + maxZ) / 2,
      };
    }

    function headWorldBounds(object) {
      const parts = [];
      object.updateMatrixWorld(true);
      object.traverse((mesh) => {
        if (!mesh.isMesh) return;
        if (!/flower-head|head/i.test(mesh.name ?? '')) return;
        const box = indexedBounds(mesh);
        if (box) parts.push(box);
      });
      if (parts.length === 0) return null;
      return {
        width: Math.max(...parts.map((b) => b.width)),
        depth: Math.max(...parts.map((b) => b.depth)),
        height: Math.max(...parts.map((b) => b.top)) - Math.min(...parts.map((b) => b.bottom)),
        bottom: Math.min(...parts.map((b) => b.bottom)),
        top: Math.max(...parts.map((b) => b.top)),
        centerY: (Math.min(...parts.map((b) => b.bottom)) + Math.max(...parts.map((b) => b.top))) / 2,
        parts: parts.length,
      };
    }

    const stems = [];
    for (const stem of state.doc.stems) {
      const viewed = d.scene.views.get(stem.id);
      const loaded = viewed?.loaded ?? null;
      const headHeight = loaded?.headHeight ?? null;
      const head = headHeight == null ? null : pose.headWorldPosition(stem, headHeight * stem.scale);
      const contact = d.scene.contacts?.get?.(stem.id) ?? null;
      const renderedHead =
        head && contact
          ? {
              x: head.x + contact.offset[0] + contact.separation[0],
              y: head.y + contact.offset[1] + contact.separation[1],
              z: head.z + contact.offset[2] + contact.separation[2],
            }
          : head
            ? { x: head.x, y: head.y, z: head.z }
            : null;
      const around =
        renderedHead == null
          ? 0
          : Math.hypot(renderedHead.x - stem.position[0], renderedHead.z - stem.position[2]);
      const metrics = loaded?.headMetrics ?? null;
      stems.push({
        stemId: stem.id,
        assetId: stem.assetId,
        kind: state.catalog.entriesById[stem.assetId]?.kind ?? null,
        scale: stem.scale,
        pose: stem.pose,
        headHeight: loaded?.headHeight ?? null,
        headRadius: loaded?.headRadius ?? null,
        headMetrics: metrics,
        headParts: loaded?.headParts ?? null,
        head,
        renderedHead,
        reach: head ? Math.hypot(head.x - stem.position[0], head.y - stem.position[1], head.z - stem.position[2]) : null,
        horizontalRadius: around,
        visibleHead: viewed?.object ? headWorldBounds(viewed.object) : null,
        contact: contact
          ? { squash: contact.squash, deflect: contact.deflect, offset: contact.offset, separation: contact.separation }
          : null,
        upperStemTop: (() => {
          const upper = viewed?.object?.getObjectByName('prepared-upper-stem');
          if (!upper) return null;
          upper.updateWorldMatrix(true, false);
          const e = upper.matrixWorld.elements;
          const full = typeof upper.userData?.fullHeight === 'number' ? upper.userData.fullHeight : 0.34;
          return e[1] * 0 + e[5] * (full / 2) + e[9] * 0 + e[13];
        })(),
      });
    }

    const sceneState = d.scene.getSceneState();
    const top = stems.reduce((max, stem) => {
      const world =
        stem.renderedHead?.y ??
        stem.head?.y ??
        null;
      const radius = (stem.headRadius ?? 0.08) * stem.scale;
      return world == null ? max : Math.max(max, world + radius);
    }, 0);
    const maxRadius = stems.reduce((max, stem) => {
      const world = stem.renderedHead;
      if (!world) return max;
      return Math.max(max, Math.hypot(world.x, world.z) + (stem.headRadius ?? 0.08) * stem.scale);
    }, 0);
    const roseStem = stems.find((stem) => stem.assetId === 'rose-pink') ?? null;
    const paperRadius = sceneState.package?.paperRadius ?? null;

    return {
      stems,
      summary: {
        stemCount: stems.length,
        top: +top.toFixed(4),
        maxRadius: +maxRadius.toFixed(4),
        // 可见宽度含接触收拢（同一株在不同候选下挤压程度不同）；模板 headMetrics 不含，作对照。
        roseHeadWidth: roseStem?.visibleHead?.width ?? null,
        roseHeadHeight: roseStem?.visibleHead?.height ?? null,
        roseMetricsWidth: roseStem?.headMetrics?.width ?? null,
        roseMetricsHeight: roseStem?.headMetrics?.height ?? null,
        roseHeadRadius: roseStem?.headRadius ?? null,
        roseReach: roseStem?.reach ?? null,
        paperRadius,
        contactHeads: stems.filter((stem) => stem.contact).length,
      },
      camera: sceneState.camera,
      viewPreset: sceneState.viewPreset,
      config: {
        rose: state.catalog.entriesById['rose-pink']?.size ?? null,
        tulip: state.catalog.entriesById['tulip-pink']?.size ?? null,
        spray: state.catalog.entriesById['spray-rose-pink']?.size ?? null,
        peony: state.catalog.entriesById['peony-1']?.size ?? null,
      },
      sizeCandidate: state.sizeCandidate ?? null,
      assetsVersion: state.catalog.assetsVersion ?? null,
      image: null,
    };
  };
}

/** 每个候选下直接量 8 个代表花型的模板尺寸（不经接触收拢，口径干净）。 */
function collectKeyAssets() {
  return async (ids) => {
    const d = window.__bouquetDebug;
    const state = d.getState();
    const catalog = state.catalog;
    const out = { sizeCandidate: state.sizeCandidate ?? null, assetsVersion: catalog.assetsVersion ?? null, assets: {} };
    for (const assetId of ids) {
      const entry = catalog.entriesById[assetId];
      if (!entry) {
        out.assets[assetId] = { missing: true };
        continue;
      }
      try {
        const loaded = await d.scene.assetLoader.load(entry, assetId, catalog);
        out.assets[assetId] = {
          headMetrics: loaded.headMetrics
            ? {
                width: +loaded.headMetrics.width.toFixed(4),
                depth: +loaded.headMetrics.depth.toFixed(4),
                height: +loaded.headMetrics.height.toFixed(4),
                bottom: +loaded.headMetrics.bottom.toFixed(4),
                centerY: +loaded.headMetrics.centerY.toFixed(4),
              }
            : null,
          headRadius: +loaded.headRadius.toFixed(4),
          headHeight: +loaded.headHeight.toFixed(4),
          headParts: loaded.headParts?.length ?? 0,
          config: entry.size ?? null,
          kind: entry.kind,
        };
      } catch (error) {
        out.assets[assetId] = { error: String(error) };
      }
    }
    // 包络椭球半径用同一套口径算一份，方便和 Lead 的数字对照。
    const env = await import('/src/three/envelope.ts');
    for (const item of Object.values(out.assets)) {
      if (!item.headMetrics) continue;
      const volume = env.headVolume(
        { width: item.headMetrics.width, depth: item.headMetrics.depth, height: item.headMetrics.height, centerY: item.headMetrics.centerY },
        1,
      );
      item.envelopeRadii = volume.radii.map((n) => +n.toFixed(4));
      item.coreRadii = volume.radii.map((n) => +(n * (volume.coreScale ?? env.DEFAULT_CORE_SCALE)).toFixed(4));
    }
    return out;
  };
}

/** 视角切换与背面翻转（预设里没有背面，用相机实际翻转，保留其他参数）。 */
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

/** 固定取景：套用参考相机（消除相机自动拉远对审美的干扰）。 */
async function applyCamera(camera) {
  await page.evaluate((value) => {
    const debug = window.__bouquetDebug;
    debug.scene.camera.position.set(value.position[0], value.position[1], value.position[2]);
    debug.scene.controls.target.set(value.target[0], value.target[1], value.target[2]);
    debug.scene.controls.update();
  }, camera);
  await wait(600);
}

/** 记录玫瑰可见头宽的比例（用于判断 ?size= 是否真的生效）。 */
async function probeSizeCandidate(candidate) {
  await open(`sample=12&view=front&size=${candidate}`);
  const scene = await page.evaluate(collectScene());
  return {
    candidate,
    config: scene.config,
    roseHeadWidth: scene.summary.roseHeadWidth,
    roseHeadHeight: scene.summary.roseHeadHeight,
    top: scene.summary.top,
    paperRadius: scene.summary.paperRadius,
  };
}

const recorded = {
  assets: null,
  candidates: {},
  headOnly: {},
  sizeProbe: null,
  fixedCamera: {},
};

try {
  // ---------- 0. 探测 ?size= 是否已生效 ----------
  step = 'probe-size';
  const requested = (args.get('sizes') ?? 'a,b,c').split(',').filter((value) => CANDIDATE_META[value]);
  const probeA = await probeSizeCandidate('a');
  const probeC = await probeSizeCandidate('c');
  const roseA = probeA.candidate && probeA.config?.rose?.headWidth;
  const roseC = probeC.config?.rose?.headWidth;
  const widthA = probeA.roseHeadWidth;
  const widthC = probeC.roseHeadWidth;
  const configChanged = Number.isFinite(roseA) && Number.isFinite(roseC) && Math.abs(roseA - roseC) > 1e-3;
  const measuredChanged =
    Number.isFinite(widthA) && Number.isFinite(widthC) && widthA > 0 && Math.abs(widthC / widthA - 1) > 0.02;
  const sizeSupported = configChanged || measuredChanged;
  recorded.sizeProbe = {
    supported: sizeSupported,
    configChanged,
    measuredChanged,
    a: probeA,
    c: probeC,
    note: sizeSupported
      ? '?size= 已生效：候选按地址栏参数区分。'
      : '?size= 尚未生效（本次运行与 a 相同），本次只作为 before 基线；Lead 接好参数后重跑。',
  };
  check('?size= 地址栏候选参数已生效（a/b/c 能区分）', sizeSupported, {
    configChanged,
    measuredChanged,
    roseA,
    roseC,
    widthA,
    widthC,
  });

  const sizes = sizeSupported ? requested : requested.filter((value) => value === 'a');
  recorded.requestedSizes = requested;
  recorded.sizes = sizes;
  if (!sizeSupported) {
    console.log('note: ?size= 未生效，只跑候选 a 作为 before 基线。');
  }

  // ---------- 1. 逐种加载 30 花型：尺寸依据实测 ----------
  step = 'assets-30';
  await open('sample=12&view=front' + (sizeSupported ? '&size=a' : ''));
  const assetReport = await page.evaluate(indexedHeadMeasure());
  recorded.assets = assetReport;
  const assets = assetReport.assets;
  const loadedCount = assets.filter((item) => !item.error).length;
  const proceduralTypes = new Set(assets.filter((item) => !item.error).map((item) => item.procedural));
  check(`全部花材条目加载成功（${proceduralTypes.size} 花型 / ${assets.length} 色）`, loadedCount === assets.length, {
    loaded: loadedCount,
    total: assets.length,
    proceduralTypes: [...proceduralTypes].length,
    errors: assets.filter((item) => item.error).map((item) => ({ assetId: item.assetId, error: item.error })),
  });

  const splitHead = assets.filter((item) => item.headMetrics && item.visibleHead);
  const splitOffenders = [];
  for (const item of splitHead) {
    const metrics = item.headMetrics;
    const visible = item.visibleHead;
    const deltas = {
      height: Math.abs(metrics.height - visible.height),
      bottom: Math.abs(metrics.bottom - visible.bottom),
      centerY: Math.abs(metrics.centerY - visible.centerY),
    };
    item.metricsDelta = deltas;
    if (deltas.height > 0.002 || deltas.bottom > 0.002 || deltas.centerY > 0.002) {
      splitOffenders.push({ assetId: item.assetId, deltas: Object.fromEntries(Object.entries(deltas).map(([k, v]) => [k, +v.toFixed(4)])) });
    }
  }
  check('分离花头：headMetrics（高/底/中心）与只统计渲染索引的可见花头一致（≤2mm）', splitOffenders.length === 0, {
    checked: splitHead.length,
    offenders: splitOffenders,
  });

  const radiusOffenders = [];
  for (const item of assets) {
    if (!item.visibleHead || !Number.isFinite(item.headRadius)) continue;
    const halfWidth = item.visibleHead.width / 2;
    const delta = Math.abs(item.headRadius - halfWidth);
    item.radiusDelta = delta;
    if (item.procedural === 'rose' || item.procedural === 'tulip') {
      if (delta > 0.005) {
        radiusOffenders.push({ assetId: item.assetId, headRadius: +item.headRadius.toFixed(4), halfWidth: +halfWidth.toFixed(4), delta: +delta.toFixed(4) });
      }
    }
  }
  check('玫瑰/郁金香：headRadius ≈ 可见花头宽/2（±5mm）', radiusOffenders.length === 0, {
    checked: assets.filter((item) => item.procedural === 'rose' || item.procedural === 'tulip').length,
    offenders: radiusOffenders,
  });

  const upperOffenders = [];
  for (const item of assets) {
    if (item.visibleHead == null || item.upperStemTop == null) continue;
    const delta = Math.abs(item.upperStemTop - item.visibleHead.bottom);
    item.upperDelta = delta;
    if (delta > 0.01) {
      upperOffenders.push({ assetId: item.assetId, upperStemTop: +item.upperStemTop.toFixed(4), headBottom: +item.visibleHead.bottom.toFixed(4), delta: +delta.toFixed(4) });
    }
  }
  check('上半段茎顶端 ≈ 可见花头底部（±1cm，分离花头花型）', upperOffenders.length === 0, {
    checked: assets.filter((item) => item.upperStemTop != null).length,
    offenders: upperOffenders,
  });

  const centerOffenders = [];
  for (const item of assets) {
    if (!item.headMetrics) continue;
    const delta = Math.abs(item.headHeight - item.headMetrics.centerY);
    item.centerDelta = delta;
    if (delta > 0.005) {
      centerOffenders.push({ assetId: item.assetId, headHeight: +item.headHeight.toFixed(4), centerY: +item.headMetrics.centerY.toFixed(4), delta: +delta.toFixed(4) });
    }
  }
  check('花头中心（loaded.headHeight）≈ 实测 centerY（±5mm）', centerOffenders.length === 0, {
    checked: assets.filter((item) => item.headMetrics).length,
    offenders: centerOffenders,
  });

  const metricsMissing = assets.filter((item) => !item.headMetrics && !item.headParts);
  recorded.metricsCoverage = {
    total: assets.length,
    withHeadMetrics: assets.filter((item) => item.headMetrics).length,
    withHeadParts: assets.filter((item) => item.headParts).length,
    withoutEither: metricsMissing.map((item) => item.assetId),
    note: '没有分离花头也没有多头登记的花材（当前 3 条尤加利 GLB）headMetrics 为 null，场景用 headRadius 兜底包络；其余花型都走实测 headMetrics。',
  };

  // 代表花型（用于人工审阅的候选对照拼版图）：玫瑰/郁金香/多头玫瑰/尤加利/芍药/康乃馨/百合/向日葵。
  const REP_TYPES = [
    'rose-pink',
    'tulip-pink',
    'spray-rose-pink',
    'eucalyptus-green',
    'peony-1',
    'carnation-1',
    'lily-1',
    'sunflower-1',
  ];

  // ---------- 2. 候选对照：6/12/20 × a/b/c × 四视角 ----------
  if (!MEASURE_ONLY) {
    for (const size of sizes) {
      const meta = CANDIDATE_META[size];
      const candidateData = { meta, bundles: {} };
      for (const bundle of BUNDLES) {
        step = `candidate-${size}-bundle-${bundle}`;
        await open(`sample=${bundle}&view=front&size=${size}`);
        const front = await page.evaluate(collectScene());
        await shot(`${bundle}-${size}-front`);
        for (const view of VIEWS) {
          if (view === 'front') continue;
          if (view === 'back') {
            await setPreset('front');
            await flipToBack();
          } else {
            await setPreset(view);
          }
          await shot(`${bundle}-${size}-${view}`);
        }
        const back = await page.evaluate(collectScene());
        // 固定取景：a 的相机作为参考，b/c 套用同一机位，排除自动拉远的影响。
        let fixed = null;
        if (size === 'a') {
          recorded.fixedCamera[bundle] = front.camera;
          // a 也留一张同后缀的固定机位图，拼版图同一行才能三档对齐。
          await shot(`${bundle}-${size}-front-fixedcam`);
        } else if (recorded.fixedCamera[bundle]) {
          await applyCamera(recorded.fixedCamera[bundle]);
          await shot(`${bundle}-${size}-front-fixedcam`);
          fixed = await page.evaluate(collectScene());
        }
        candidateData.bundles[bundle] = { front, back, fixed };
        // 12 枝那一页顺便直接量 8 个代表花型的模板尺寸（不含接触收拢）。
        if (bundle === 12) {
          candidateData.keyAssets = await page.evaluate(collectKeyAssets(), REP_TYPES);
        }
      }
      recorded.candidates[size] = candidateData;
      console.log(`candidate ${size} done`);
    }

    // ---------- 3. 只改花头：?head=0.80/0.64/0.56 的 12 枝对照 ----------
    // 固定候选 a 作为底座（枝长/叶片/程序花都不动），只让 ?head 改花头，
    // 这样「花头」与「枝长」两个变量才真正隔离（之前不写 size 会继承上一页 localStorage 的候选）。
    step = 'head-only';
    await open('sample=12&view=front&size=a');
    const headBase = await page.evaluate(collectScene());
    for (const head of HEAD_ONLY) {
      const label = head.toFixed(2).replace('.', '');
      await open(`sample=12&view=front&size=a&head=${head}`);
      const data = await page.evaluate(collectScene());
      await shot(`headonly-${label}-front`);
      recorded.headOnly[head] = {
        data,
        // 用模板 headMetrics 宽（不含接触收拢）比，口径稳定。
        widthRatio:
          headBase.summary.roseMetricsWidth && data.summary.roseMetricsWidth
            ? +(data.summary.roseMetricsWidth / headBase.summary.roseMetricsWidth).toFixed(4)
            : null,
        visibleRatio:
          headBase.summary.roseHeadWidth && data.summary.roseHeadWidth
            ? +(data.summary.roseHeadWidth / headBase.summary.roseHeadWidth).toFixed(4)
            : null,
      };
    }
    const headRatios = Object.fromEntries(
      Object.entries(recorded.headOnly).map(([head, item]) => [head, item.widthRatio]),
    );
    const headOffenders = Object.entries(recorded.headOnly)
      .filter(([head, item]) => item.widthRatio == null || Math.abs(item.widthRatio - Number(head) / 0.8) > 0.03)
      .map(([head, item]) => ({ head: Number(head), widthRatio: item.widthRatio, expected: Number(head) / 0.8 }));
    check('只改花头：?head=0.64/0.56 的花头宽比随参数线性变化（隔离枝长变量）', headOffenders.length === 0, {
      ratios: headRatios,
      offenders: headOffenders,
      note: '以 ?size=a 同一底座为基准，?head=0.80 的宽比应为 1.00、0.64 为 0.80、0.56 为 0.70。',
    });

    // ---------- 3b. 8 个代表花型的单枝对照（每个候选 × 每个花型一张 front 截图） ----------
    step = 'representative';
    const repShots = [];
    for (const size of sizes) {
      await open(`size=${size}`, { expectStems: 0 });
      for (const assetId of REP_TYPES) {
        const placed = await page.evaluate(async (value) => {
          const d = window.__bouquetDebug;
          const store = d.store;
          if (store.getState().doc.stems.length > 0) store.clearStems();
          store.setPlacement(value.assetId);
          const ok = store.placeStem({ tilt: 14, direction: 0, height: 0.03, scale: 1 });
          for (let i = 0; i < 120; i += 1) {
            const state = store.getState();
            const stem = state.doc.stems.find((item) => item.assetId === value.assetId);
            const view = stem ? d.scene.views.get(stem.id) : null;
            if (ok && stem && view?.object) return true;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return false;
        }, { assetId });
        await wait(800);
        // 取消选中：去掉选中提示卡/编辑工具条，避免遮挡花头影响审阅。
        await page.evaluate(() => window.__bouquetDebug.store.select(null));
        await wait(350);
        await shot(`single-${assetId}-${size}-front`);
        repShots.push({ assetId, size, placed });
      }
    }
    recorded.representative = {
      assets: REP_TYPES,
      sizes,
      count: repShots.length,
      failed: repShots.filter((item) => !item.placed).map((item) => `${item.assetId}-${item.size}`),
    };
    check('8 个代表花型 × 候选全部单枝加载并截图成功', recorded.representative.failed.length === 0, {
      count: repShots.length,
      failed: recorded.representative.failed,
    });
  }

  // ---------- 4. 相机取景记录：候选之间的自动拉远是否抵消了缩小观感 ----------
  const cameraRows = {};
  for (const size of sizes) {
    cameraRows[size] = {};
    for (const bundle of BUNDLES) {
      const item = recorded.candidates[size]?.bundles?.[bundle];
      if (!item) continue;
      cameraRows[size][bundle] = {
        distance: +Math.hypot(
          item.front.camera.position[0] - item.front.camera.target[0],
          item.front.camera.position[1] - item.front.camera.target[1],
          item.front.camera.position[2] - item.front.camera.target[2],
        ).toFixed(4),
        top: item.front.summary.top,
        maxRadius: item.front.summary.maxRadius,
        paperRadius: item.front.summary.paperRadius,
        roseHeadWidth: item.front.summary.roseHeadWidth,
        roseMetricsWidth: item.front.summary.roseMetricsWidth,
        roseMetricsHeight: item.front.summary.roseMetricsHeight,
        headOverHeight:
          item.front.summary.roseHeadHeight != null
            ? +(item.front.summary.roseHeadHeight / Math.max(0.15, item.front.summary.top - 0.66)).toFixed(4)
            : null,
        headWidthOverHeight:
          item.front.summary.roseHeadWidth != null
            ? +(item.front.summary.roseHeadWidth / Math.max(0.15, item.front.summary.top - 0.66)).toFixed(4)
            : null,
        metricsHeadOverHeight:
          item.front.summary.roseMetricsHeight != null
            ? +(item.front.summary.roseMetricsHeight / Math.max(0.15, item.front.summary.top - 0.66)).toFixed(4)
            : null,
      };
    }
  }
  // 8 个代表花型在每个候选下的模板尺寸（干净口径，不含接触收拢）。
  const keyAssetRows = {};
  for (const size of sizes) {
    const assetsOfCandidate = recorded.candidates[size]?.keyAssets?.assets ?? null;
    if (!assetsOfCandidate) continue;
    keyAssetRows[size] = Object.fromEntries(
      Object.entries(assetsOfCandidate).map(([assetId, item]) => [
        assetId,
        {
          kind: item.kind ?? null,
          headMetrics: item.headMetrics ?? null,
          headRadius: item.headRadius ?? null,
          headHeight: item.headHeight ?? null,
          headParts: item.headParts ?? null,
          envelopeRadii: item.envelopeRadii ?? null,
          coreRadii: item.coreRadii ?? null,
          config: item.config ?? null,
        },
      ]),
    );
  }
  recorded.keyAssets = keyAssetRows;
  recorded.cameraFit = cameraRows;
  recorded.metricDefinitions = {
    roseHeadWidth: '玫瑰实例花头网格只统计渲染索引顶点后，经世界矩阵量得的宽度（米）。',
    roseHeadHeight: '同上，可见花头高度（米）。',
    headOverHeight: '可见花头高度 ÷ (整束最高点 - 台面 0.66m)，即「花头占总高比」的口径。',
    headWidthOverHeight: '可见花头宽度 ÷ (整束最高点 - 台面 0.66m)。',
    top: '整束花头顶（花头世界中心 y + 花头半径 × 实例缩放）的最高值。',
    maxRadius: '花头水平半径 + 花头半径的最大值（米）。',
    cameraDistance: '相机到 controls.target 的距离；b/c 若自动拉远，会抵消「看起来变小」的效果。',
  };

  // ---------- 5. 页面错误 ----------
  step = 'done';
  const uniqueErrors = [...new Map(errors.map((item) => [JSON.stringify(item), item])).values()];
  check('全程无页面与模块错误（不含 size 参数探测期的临时错误）', uniqueErrors.length === 0, { errors: uniqueErrors });

  // 主观观察单独放 observations：可以是空的，但必须标明是主观判断。
  const observations = [];
  const results = {
    date: new Date().toISOString(),
    url: BASE,
    outDir: OUT,
    passed,
    failed: failures.length,
    checks,
    sizeSupport: recorded.sizeProbe,
    sizes: sizes,
    assets: recorded.assets,
    metricsCoverage: recorded.metricsCoverage,
    candidates: recorded.candidates,
    representative: recorded.representative ?? null,
    headOnly: recorded.headOnly,
    cameraFit: recorded.cameraFit,
    keyAssets: recorded.keyAssets ?? null,
    metricDefinitions: recorded.metricDefinitions,
    observations,
    observationsNote: 'observations 是主观观感判断（比例是否协调、四视角是否好看），不是实测数据。',
    errors: uniqueErrors,
    notes: [
      '可见花头 = 只统计 geometry.index 引用顶点后、经 matrixWorld 变换的包围盒。',
      'roseHeadWidth / roseHeadHeight 是实例可见尺寸（含接触收拢）；roseMetricsWidth / Height 是模板实测尺寸（不含接触），两者都记录。',
      '尺寸依据断言失败不中断脚本：失败项在 checks 里，表示当前代码还没修好或与验收口径不同。',
      '单枝代表截图 single-<assetId>-<candidate>-front.png 用于看 8 个花型各自的比例；四视角截图为 <bundle>-<candidate>-<view>.png。',
      '拼版图：python .verify/v07-size/make_sheet.py（见脚本注释）。',
    ],
  };
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  console.log(`DONE passed=${passed} failed=${failures.length} -> ${OUT}/results.json`);
} catch (error) {
  writeFileSync(
    `${OUT}/failure.json`,
    JSON.stringify({ date: new Date().toISOString(), passed, checks, errors, error: String(error), stack: error?.stack ?? null }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}

/*
 * 拼版图（人工审阅用，python + Pillow）：
 *   python app/.verify/v07-size/make_sheet.py            # 生成 contact-sheet-size.png / contact-sheet-head.png
 * 说明：脚本本身只产截图与 results.json；拼版图在 .verify/v07-size/make_sheet.py 里，
 * 因为它需要 Pillow，而项目验证脚本只用 playwright-core。
 */
