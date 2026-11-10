/**
 * dev-only QA 页面逻辑（app/qa/，不参与 tsc 与 vite build）。
 *
 * 用途：
 *  1) 为 manifest 里的每条配色生成**静态缩略图**（160×190 透明 PNG），直接调用
 *     `app/src/three/assets/thumbnails.ts` 的 `assetThumbnail`——与工作台花材面板同一
 *     渲染路径（同灯光/相机/尺寸，含运行时 recolor）；
 *  2) 为每种花材渲染正/左/背/俯 4 视角接触表；
 *  3) 为同一花型的多个配色渲染并排对比（base 原色 vs 各变体换色）；
 *  4) raw vs processed 正视图并排，用于验收贴图压缩的色偏。
 *
 * 契约：Playwright 打开 /qa/，等 `window.__qa.ready === true`，然后调用
 *   window.__qa.renderAll(manifest, ids?)          → [{assetId, dataUrl}]
 *   window.__qa.renderContactSheets(manifest, families?) → [{family, dataUrl, meta}]
 *   window.__qa.renderVariantSheets(manifest, families?) → [{family, dataUrl, meta}]
 *   window.__qa.renderComparePairs(pairs)                → [{family, dataUrl, meta}]
 * manifest 由 Playwright 从磁盘读入后传入，避免读到 dev server 的旧缓存。
 *
 * 注意：本页 import app/src 下的模块（只读，不改）；<base href="/"> 是必须的，
 * 见 index.html 的注释。
 */

import * as THREE from 'three';
import { AssetLoader } from '../src/three/assets/AssetLoader';
import { assetThumbnail } from '../src/three/assets/thumbnails';
import { parseManifest } from '../src/data/catalog';
import type { AssetEntry, RuntimeCatalog } from '../src/data/types';

const ASSET_BASE = `${location.origin}/`;
const VIEWS = ['front', 'left', 'back', 'top'] as const;
type ViewName = (typeof VIEWS)[number];

const VIEW_LABEL: Record<ViewName, string> = {
  front: '正视 front',
  left: '左视 left',
  back: '背视 back',
  top: '俯视 top',
};

const VIEW_DIR: Record<ViewName, THREE.Vector3> = {
  front: new THREE.Vector3(0.18, 0.1, 1),
  left: new THREE.Vector3(-1, 0.12, 0.18),
  back: new THREE.Vector3(-0.18, 0.1, -1),
  top: new THREE.Vector3(0.15, 1, 0.35),
};

const BACKGROUND = '#f6f1e8';
const PANEL = '#fffdf9';
const INK = '#3a322c';
const SUBTLE = '#6b6057';
const ERROR_INK = '#a33b2e';

/** 面板渲染与 app 面板同一套灯光；数值抄 thumbnails.ts。 */
function addLights(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight('#ffffff', '#a59b89', 2.4));
  const light = new THREE.DirectionalLight('#fff6e9', 3);
  light.position.set(-1, 2, 3);
  scene.add(light);
}

let sharedRenderer: THREE.WebGLRenderer | null = null;

function rendererFor(width: number, height: number): THREE.WebGLRenderer {
  if (!sharedRenderer) {
    sharedRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    sharedRenderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  sharedRenderer.setPixelRatio(1);
  sharedRenderer.setSize(width, height);
  return sharedRenderer;
}

function copyCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const target = document.createElement('canvas');
  target.width = source.width;
  target.height = source.height;
  const context = target.getContext('2d');
  if (context) context.drawImage(source, 0, 0);
  return target;
}

function cameraFor(box: THREE.Box3, view: ViewName, aspect: number): THREE.PerspectiveCamera {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const camera = new THREE.PerspectiveCamera(28, aspect, 0.01, 10);
  // 与 thumbnails.ts 同一条取景公式，保证 4 视角与静态缩略图比例一致。
  const distance = Math.max(size.y, size.x * 1.4) * 2.4;
  camera.position.copy(center).add(VIEW_DIR[view].clone().normalize().multiplyScalar(distance));
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  return camera;
}

/**
 * 当前 app/src 的 parseManifest 已支持 `recolor: {mode, hue}` 对象形式与 `thumb`
 * 静态缩略图字段，本页直接透传 manifest，不做字符串降级（保真：QA 与工作台同一份解析）。
 * 静态缩略图生成必须走 `assetThumbnail(..., {forceRuntime:true})`：否则清单里已有
 * `thumb` 的条目会直接回传静态图 URL 而不是渲染 dataURL（先有鸡还是先有蛋）。
 */
function parseCatalog(manifestRaw: unknown): RuntimeCatalog {
  return parseManifest(manifestRaw);
}

function entriesOfManifest(manifestRaw: unknown, catalog: RuntimeCatalog, ids?: string[]): AssetEntry[] {
  const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null;
  const assets = (manifestRaw as { assets?: unknown }).assets;
  const out: AssetEntry[] = [];
  if (!Array.isArray(assets)) return out;
  for (const item of assets) {
    const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : null;
    if (typeof id !== 'string') continue;
    if (wanted && !wanted.has(id)) continue;
    const entry = catalog.entriesById[id];
    if (entry) out.push(entry);
  }
  return out;
}

const qaLoader = new AssetLoader(ASSET_BASE, () => {});

interface LoadedMeta {
  triangles: number;
  meshes: number;
  source: string;
  headHeight: number;
  headRadius: number;
  glb: string;
}

function metaOf(loaded: { template: THREE.Object3D; source: string; headHeight: number; headRadius: number }, glb: string): LoadedMeta {
  let triangles = 0;
  let meshes = 0;
  loaded.template.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    meshes += 1;
    const geometry = mesh.geometry;
    triangles += geometry.index ? geometry.index.count / 3 : (geometry.getAttribute('position')?.count ?? 0) / 3;
  });
  return {
    triangles: Math.round(triangles),
    meshes,
    source: loaded.source,
    headHeight: Number(loaded.headHeight.toFixed(4)),
    headRadius: Number(loaded.headRadius.toFixed(4)),
    glb,
  };
}

async function renderViews(
  entry: AssetEntry,
  catalog: RuntimeCatalog,
  views: readonly ViewName[],
  width: number,
  height: number,
): Promise<{ canvases: Record<string, HTMLCanvasElement>; meta: LoadedMeta }> {
  const loaded = await qaLoader.load(entry, entry.assetId, catalog);
  const object = loaded.template.clone(true);
  const scene = new THREE.Scene();
  scene.add(object);
  addLights(scene);
  const box = new THREE.Box3().setFromObject(object);
  const renderer = rendererFor(width, height);
  const canvases: Record<string, HTMLCanvasElement> = {};
  for (const view of views) {
    const camera = cameraFor(box, view, width / height);
    renderer.render(scene, camera);
    canvases[view] = copyCanvas(renderer.domElement);
  }
  return { canvases, meta: metaOf(loaded, entry.glb ?? '') };
}

interface Cell {
  label: string;
  canvas: HTMLCanvasElement;
  sublabel?: string;
}

/** 把若干渲染画布拼成一张带标题/标签的接触表（2D canvas 合成，输出 PNG dataURL）。 */
function composeSheet(title: string, subtitle: string, cells: Cell[], cols: number, cellWidth: number, cellHeight: number): string {
  const pad = 14;
  const gap = 10;
  const headerHeight = 52;
  const labelHeight = 32;
  const rows = Math.max(1, Math.ceil(cells.length / cols));
  const width = pad * 2 + cols * cellWidth + (cols - 1) * gap;
  const height = headerHeight + rows * (cellHeight + labelHeight) + (rows - 1) * gap + pad;

  const sheet = document.createElement('canvas');
  sheet.width = width;
  sheet.height = height;
  const context = sheet.getContext('2d');
  if (!context) throw new Error('2D canvas 不可用');

  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, width, height);
  context.fillStyle = INK;
  context.font = 'bold 17px system-ui, "Microsoft YaHei", sans-serif';
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.fillText(title, pad, 26);
  context.fillStyle = SUBTLE;
  context.font = '12px system-ui, "Microsoft YaHei", sans-serif';
  context.fillText(subtitle, pad, 44);

  cells.forEach((cell, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = pad + col * (cellWidth + gap);
    const y = headerHeight + row * (cellHeight + labelHeight + gap);
    context.fillStyle = PANEL;
    context.fillRect(x, y, cellWidth, cellHeight);
    // 细边框，方便看透明区域与画面边界
    context.strokeStyle = 'rgba(90, 80, 72, 0.18)';
    context.lineWidth = 1;
    context.strokeRect(x + 0.5, y + 0.5, cellWidth - 1, cellHeight - 1);

    const source = cell.canvas;
    const scale = Math.min(cellWidth / source.width, cellHeight / source.height);
    const drawWidth = source.width * scale;
    const drawHeight = source.height * scale;
    context.drawImage(source, x + (cellWidth - drawWidth) / 2, y + (cellHeight - drawHeight) / 2, drawWidth, drawHeight);

    context.fillStyle = INK;
    context.font = '12px system-ui, "Microsoft YaHei", sans-serif';
    context.textAlign = 'center';
    context.fillText(cell.label, x + cellWidth / 2, y + cellHeight + 17);
    if (cell.sublabel) {
      context.fillStyle = SUBTLE;
      context.font = '11px system-ui, "Microsoft YaHei", sans-serif';
      context.fillText(cell.sublabel, x + cellWidth / 2, y + cellHeight + 29);
    }
    context.textAlign = 'left';
  });
  return sheet.toDataURL('image/png');
}

function familiesOf(entries: AssetEntry[]): string[] {
  const order: string[] = [];
  for (const entry of entries) if (!order.includes(entry.family)) order.push(entry.family);
  return order;
}

function metaLine(meta: LoadedMeta): string {
  return `${meta.triangles} tris · 花头 ${meta.headHeight}m / R ${meta.headRadius}m · ${meta.glb}`;
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

async function renderAll(manifestRaw: unknown, ids?: string[]) {
  const catalog = parseCatalog(manifestRaw);
  const entries = entriesOfManifest(manifestRaw, catalog, ids);
  const results: { assetId: string; dataUrl?: string; error?: string }[] = [];
  for (const entry of entries) {
    try {
      // forceRuntime：绕过清单里的静态 thumb（本次任务就是生成它），走工作台同一渲染路径。
      const dataUrl = await assetThumbnail(entry, catalog, { forceRuntime: true });
      results.push({ assetId: entry.assetId, dataUrl });
    } catch (error) {
      results.push({ assetId: entry.assetId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

async function renderContactSheets(manifestRaw: unknown, families?: string[]) {
  const catalog = parseCatalog(manifestRaw);
  const entries = entriesOfManifest(manifestRaw, catalog);
  const targets = families && families.length > 0 ? families : familiesOf(entries);
  const sheets: { family: string; dataUrl?: string; meta?: LoadedMeta; error?: string }[] = [];
  for (const family of targets) {
    const group = entries.filter((entry) => entry.family === family);
    if (group.length === 0) continue;
    // 接触表统一用 base 造型（不换色），配色差异由 variants 表负责。
    const base = group.find((entry) => !entry.recolor) ?? group[0];
    try {
      const { canvases, meta } = await renderViews(base, catalog, VIEWS, 300, 350);
      const cells: Cell[] = VIEWS.map((view) => ({ label: VIEW_LABEL[view], canvas: canvases[view] }));
      const dataUrl = composeSheet(
        `${family} · ${base.displayName}`,
        `${base.kind} · ${metaLine(meta)}${meta.source === 'glb' ? '' : ' · ⚠ 回退到程序化占位花'}`,
        cells,
        2,
        300,
        350,
      );
      sheets.push({ family, dataUrl, meta });
    } catch (error) {
      sheets.push({ family, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return sheets;
}

async function renderVariantSheets(manifestRaw: unknown, families?: string[]) {
  const catalog = parseCatalog(manifestRaw);
  const entries = entriesOfManifest(manifestRaw, catalog);
  const targets = families && families.length > 0 ? families : familiesOf(entries);
  const sheets: { family: string; dataUrl?: string; meta?: LoadedMeta; error?: string }[] = [];
  for (const family of targets) {
    const group = entries.filter((entry) => entry.family === family);
    if (group.length < 2) continue;
    try {
      const cells: Cell[] = [];
      let lastMeta: LoadedMeta | undefined;
      for (const entry of group) {
        const { canvases, meta } = await renderViews(entry, catalog, ['front'], 260, 320);
        lastMeta = meta;
        cells.push({
          label: `${entry.variantName}${entry.recolor ? ' · 换色' : ' · 原色'}`,
          sublabel: `${entry.color}${entry.recolor ? ` · ${String(entry.recolor)}` : ''}`,
          canvas: canvases.front,
        });
      }
      const dataUrl = composeSheet(
        `${family} 配色变体`,
        `${group.length} 配色共用 ${group[0]?.glb ?? ''} · ${lastMeta ? `${lastMeta.triangles} tris` : ''}`,
        cells,
        group.length,
        260,
        320,
      );
      sheets.push({ family, dataUrl, meta: lastMeta });
    } catch (error) {
      sheets.push({ family, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return sheets;
}

interface CompareSide {
  assetId?: string;
  label?: string;
  glb?: string;
  family?: string;
  kind?: string;
  color?: string;
  transform?: Record<string, number>;
  size?: Record<string, unknown>;
}

interface ComparePair {
  family?: string;
  left?: CompareSide;
  right?: CompareSide;
}

function entryFromSide(side: CompareSide, fallbackId: string): AssetEntry {
  const family = side.family ?? 'tulip';
  return {
    assetId: side.assetId ?? fallbackId,
    family,
    kind: (side.kind as AssetEntry['kind']) ?? 'main',
    displayName: side.label ?? fallbackId,
    familyName: family,
    variantName: side.label ?? fallbackId,
    color: side.color ?? '#e8a0b4',
    glb: side.glb ?? '',
    transform: {
      scale: side.transform?.scale ?? 1,
      rotationY: side.transform?.rotationY ?? 0,
      gripAt: side.transform?.gripAt ?? 0,
      headOffsetY: side.transform?.headOffsetY ?? 0.38,
    },
    size: {
      headWidth: 1,
      headHeight: 1,
      leafSpread: 1,
      stemFactor: 1,
      uniformScale: 1,
      ...(side.size ?? {}),
    } as AssetEntry['size'],
    procedural: family as AssetEntry['procedural'],
    source: 'manifest',
  };
}

async function renderComparePairs(pairsRaw: unknown) {
  const pairs: ComparePair[] = Array.isArray((pairsRaw as { pairs?: unknown })?.pairs)
    ? ((pairsRaw as { pairs: ComparePair[] }).pairs)
    : Array.isArray(pairsRaw)
      ? (pairsRaw as ComparePair[])
      : [];
  const results: { family: string; dataUrl?: string; ok?: boolean; error?: string }[] = [];
  for (const pair of pairs) {
    const family = pair.family ?? pair.left?.family ?? 'compare';
    const left = pair.left ?? {};
    const right = pair.right ?? {};
    const leftEntry = entryFromSide(left, `cmp-left-${family}`);
    const rightEntry = entryFromSide(right, `cmp-right-${family}`);
    const catalog: RuntimeCatalog = {
      mode: 'manifest',
      assetsVersion: `qa-compare-${family}-${Date.now()}`,
      entries: [leftEntry, rightEntry],
      entriesById: { [leftEntry.assetId]: leftEntry, [rightEntry.assetId]: rightEntry },
      families: [],
    };
    try {
      const leftRender = await renderViews(leftEntry, catalog, ['front'], 300, 350);
      const rightRender = await renderViews(rightEntry, catalog, ['front'], 300, 350);
      const sameShape = leftRender.meta.triangles === rightRender.meta.triangles;
      const dataUrl = composeSheet(
        `${family} 压缩前后对照（纹理差异）`,
        `三角面 ${leftRender.meta.triangles} vs ${rightRender.meta.triangles} ${sameShape ? '一致' : '⚠ 不一致'} · ${left.glb ?? ''} → ${right.glb ?? ''}`,
        [
          { label: left.label ?? `raw ${left.glb ?? ''}`, canvas: leftRender.canvases.front },
          { label: right.label ?? `processed ${right.glb ?? ''}`, canvas: rightRender.canvases.front },
        ],
        2,
        300,
        350,
      );
      results.push({ family, dataUrl, ok: sameShape });
    } catch (error) {
      results.push({ family, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

const api = {
  ready: true,
  version: 'qa-1',
  assetBase: ASSET_BASE,
  renderAll,
  renderContactSheets,
  renderVariantSheets,
  renderComparePairs,
};

(window as unknown as Record<string, unknown>).__qa = api;
document.body.dataset.qaReady = '1';
