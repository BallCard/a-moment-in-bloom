/**
 * 资产加载层。
 *
 * 交互逻辑只依赖这里返回的 LoadedAsset；当前用程序化占位花实现，
 * 后续把 createFromManifest 里的 GLB 分支接到真实 Lux3D 资产即可，
 * 不改场景与交互代码。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { inferProceduralKey } from '../../data/catalog';
import type { AssetEntry, AssetTransform, RuntimeCatalog } from '../../data/types';
import { defaultSizeFor } from '../../data/size';
import { buildProceduralAsset } from '../builders';
import { applyColorVariant } from './recolor';
import { applyHeadSize, prepareFlower, type HeadMetrics } from './preparation';

export interface LoadedAsset {
  assetId: string;
  displayName: string;
  /** 供每个实例 Clone 的模板；几何/材质在实例间共享。 */
  template: THREE.Object3D;
  /** 握点到花头中心的距离（米），用于选中环和拖动换算。 */
  headHeight: number;
  /** 花头占用半径（米）。V0.7 起按缩放后的花头实测，用于建议位/碰撞/包装。 */
  headRadius: number;
  /** 多头花：逐个登记的花头局部偏移与半径（单头花不填）。 */
  headParts?: { offset: [number, number, number]; radius: number }[];
  /** 花头缩放后的实测尺寸；没有分离花头的花型为 null。 */
  headMetrics?: HeadMetrics | null;
  source: 'glb' | 'procedural';
}

export type AssetNotice = (message: string, kind: 'info' | 'warn') => void;

/** 真实 GLB 下载的进度回调；没有真实资产时不会触发。 */
export interface AssetLoadEvents {
  onStart?: (assetId: string) => void;
  onProgress?: (assetId: string, progress: number | null) => void;
  onEnd?: (assetId: string) => void;
  onFailure?: (assetId: string, message: string) => void;
}

const DEFAULT_TRANSFORM: AssetTransform = {
  scale: 1,
  rotationY: 0,
  gripAt: 0,
  headOffsetY: 0.38,
};

const FALLBACK_COLOR: Record<string, string> = {
  spray:'#ce7896', daisy:'#e7ae4b',
  tulip: '#e8a4ba',
  rose: '#e79fb1',
  eucalyptus: '#9db08f',
};

export class AssetLoader {
  private readonly cache = new Map<string, Promise<LoadedAsset>>();
  private readonly loadedTemplates: LoadedAsset[] = [];
  private readonly noticed = new Set<string>();
  private readonly gltfLoader = new GLTFLoader();
  private readonly baseUrl: string;
  private readonly notice: AssetNotice;
  private readonly events: AssetLoadEvents;

  constructor(baseUrl: string, notice: AssetNotice, events: AssetLoadEvents = {}) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.notice = notice;
    this.events = events;
  }

  /** 按目录条目加载；条目缺失时用同 id 推断的花型做保底。 */
  load(entry: AssetEntry | undefined, requestedAssetId: string, catalog: RuntimeCatalog): Promise<LoadedAsset> {
    const glb = entry?.glb ?? '';
    const key = `${catalog.mode}:${catalog.assetsVersion}:${entry?.assetId ?? requestedAssetId}:${glb || 'proc'}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const promise = this.create(entry, requestedAssetId).then((loaded) => {
      this.loadedTemplates.push(loaded);
      return loaded;
    });
    this.cache.set(key, promise);
    return promise;
  }

  private async create(entry: AssetEntry | undefined, requestedAssetId: string): Promise<LoadedAsset> {
    if (entry?.glb) {
      this.events.onStart?.(entry.assetId);
      try {
        return await this.loadGlb(entry);
      } catch (error) {
        // 具体原因留给控制台，界面只说人话；这是预期内的兜底，不上报为错误。
        console.info('[bouquet] GLB 加载失败，已用占位花回退：', entry.glb, error);
        this.events.onFailure?.(
          entry.assetId,
          error instanceof Error ? error.message : String(error),
        );
        this.notifyOnce(
          `glb:${entry.assetId}`,
          `花材「${entry.displayName}」的模型没加载出来，先用占位花顶上`,
        );
        return this.buildFallback(entry, entry.procedural, entry.color);
      } finally {
        this.events.onEnd?.(entry.assetId);
      }
    }
    if (!entry) {
      // 存档里引用了当前清单没有的 assetId：按 id 猜花型，保证作品还能看。
      const procedural = inferProceduralKey(requestedAssetId);
      this.notifyOnce(
        `missing:${requestedAssetId}`,
        `找不到花材「${requestedAssetId}」，先用占位花顶上`,
      );
      return this.buildFallback(undefined, procedural, FALLBACK_COLOR[procedural]);
    }
    return this.buildFallback(entry, entry.procedural, entry.color);
  }

  private async loadGlb(entry: AssetEntry): Promise<LoadedAsset> {
    const transform = { ...DEFAULT_TRANSFORM, ...(entry.transform ?? {}) };
    const url = `${this.baseUrl}assets/${entry.glb}`;
    const gltf = await this.gltfLoader.loadAsync(url, (event) => {
      const total = event.total > 0 ? event.total : null;
      this.events.onProgress?.(entry.assetId, total ? event.loaded / total : null);
    });
    const template = new THREE.Group();
    template.name = `glb:${entry.assetId}`;
    const inner = gltf.scene;
    inner.scale.setScalar(transform.scale);
    inner.rotation.y = THREE.MathUtils.degToRad(transform.rotationY);
    // 把模型自带的握点挪到局部原点，同时把花头留在地面上方。
    inner.position.y = -transform.gripAt;
    template.add(inner);
    template.updateMatrixWorld(true);

    const bounds = new THREE.Box3().setFromObject(template);
    const height = bounds.max.y - bounds.min.y;
    if (!Number.isFinite(height) || height < 0.05 || height > 4) {
      throw new Error(`模型尺寸异常（${Number.isFinite(height) ? height.toFixed(2) : 'NaN'}m）`);
    }

    template.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        if (mesh.geometry) mesh.geometry.computeBoundingSphere();
      }
    });

    // 配色变体：同一份 GLB，按清单里的目标色重映射花/叶贴图。
    if (entry.recolor) applyColorVariant(template, entry.recolor, entry.color);
    prepareFlower(template, transform.headOffsetY, entry.family);
    // V0.7 §3：花头按尺寸配置缩放；V0.7.3：枝长按 stemFactor 收短（握点不动）。
    const size = entry.size ?? defaultSizeFor(entry.procedural);
    const uniform = applyUniformScale(template, size.uniformScale);
    const headMetrics = scaleHeadMetrics(
      applyHeadSize(
        template,
        size.headWidth,
        size.headHeight ?? size.headWidth,
        transform.headOffsetY,
        size.leafSpread,
        size.stemFactor ?? 1,
      ),
      uniform,
    );

    return {
      assetId: entry.assetId,
      displayName: entry.displayName,
      template,
      // 花头取值优先级（V0.7.5）：
      // 1. 玫瑰 / 郁金香切出独立花头 → 按可见顶点实测（headMetrics）；
      // 2. 其余真实 GLB 是单网格花头，没有可分离的 `original-flower-head`，
      //    applyHeadSize 返回 null：花头中心取管线的 `transform.headOffsetY`，
      //    半径优先取管线实测的 `size.headRadius`，都没有才按包围盒粗估。
      //    两者都在整枝 uniformScale（含尺寸候选的 0.88 / 0.85）之后换算。
      headHeight: headMetrics ? headMetrics.centerY : transform.headOffsetY * uniform,
      headRadius: headMetrics
        ? Math.max(headMetrics.width, headMetrics.depth) / 2
        : (size.headRadius ?? estimateHeadRadius(bounds)) * uniform,
      headMetrics,
      // 多头登记只对程序化多头花（spray）有意义；manifest 条目缺省没有 heads
      // （见 data/size.ts 的 readSizeConfig），所以单网格 GLB 不会误当多头花。
      headParts: size.heads?.map((part) => ({
        offset: part.offset.map((n) => n * uniform) as [number, number, number],
        radius: part.radius * uniform,
      })),
      source: 'glb',
    };
  }

  private buildFallback(
    entry: AssetEntry | undefined,
    procedural: LoadedFallbackKey,
    color: string,
  ): LoadedAsset {
    const built = buildProceduralAsset(procedural, color);
    const group = new THREE.Group();
    group.name = `proc:${entry?.assetId ?? procedural}`;
    const mesh = new THREE.Mesh(built.geometry, built.material);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.name = `mesh:${procedural}`;
    group.add(mesh);
    prepareFlower(group, built.headHeight, procedural);
    const size = entry?.size ?? defaultSizeFor(procedural);
    // 程序化花材没有分离花头：applyHeadSize 只对玫瑰/郁金香这类分离花头生效，
    // 这里的花头尺寸与中心一律走顶部窗口实测（见 measureProceduralHead）。
    built.geometry.computeBoundingBox();
    const box = built.geometry.boundingBox;
    const width = box ? Math.max(box.max.x - box.min.x, box.max.z - box.min.z) : 0.18;
    const uniform = applyUniformScale(group, size.uniformScale);
    // 程序化花材没有分离花头，构建器声明的 headHeight 只是意图值；
    // 除非清单逐个登记了多头（spray），否则以几何实测的花头位置为准。
    const measured = size.heads ? null : measureProceduralHead(built.geometry, uniform);
    // 绿叶的「花头」是叶面铺开的位置，纵向重心在中上部而不是枝顶，顶部窗口
    // 量出来的中心会偏低，所以绿叶沿用构建器声明的枝顶高度，只取实测尺寸。
    const headHeight = measured && entry?.kind !== 'greenery' ? measured.centerY : built.headHeight * uniform;
    const headRadius =
      measured?.radius ??
      (size.headRadius ?? THREE.MathUtils.clamp(width * 0.34, 0.055, 0.16)) * uniform;
    const headMetrics: HeadMetrics | null = measured
      ? {
          width: measured.width,
          depth: measured.depth,
          height: measured.height,
          bottom: headHeight - measured.height / 2,
          top: headHeight + measured.height / 2,
          centerY: headHeight,
        }
      : null;
    return {
      assetId: entry?.assetId ?? procedural,
      displayName: entry?.displayName ?? '占位花',
      template: group,
      headHeight,
      headParts: size.heads?.map((part) => ({
        offset: part.offset.map((n) => n * uniform) as [number, number, number],
        radius: part.radius * uniform,
      })),
      headMetrics,
      headRadius,
      source: 'procedural',
    };
  }

  private notifyOnce(key: string, message: string): void {
    if (this.noticed.has(key)) return;
    this.noticed.add(key);
    this.notice(message, 'warn');
  }

  /** 重试前清空模板与缓存；调用方必须先移除仍引用这些模板的实例。 */
  clearCache(): void {
    for (const loaded of this.loadedTemplates) {
      disposeObject(loaded.template);
    }
    this.loadedTemplates.length = 0;
    this.cache.clear();
    this.noticed.clear();
  }

  dispose(): void {
    this.clearCache();
  }
}

// 这里写成类型别名，避免 LoadedFallbackKey 被误认为运行时值。
type LoadedFallbackKey = Parameters<typeof buildProceduralAsset>[0];

/**
 * V0.7 §5：整枝等比缩放。
 *
 * 新加的程序化花型按各自花头尺寸建模，整枝高度落在 0.54–0.64m，
 * 而玫瑰/郁金香这类主力花在 1m 上下。直接放进花束会明显偏短，
 * 所以按种类登记一个 uniformScale，把整枝（花头 + 茎 + 叶）一起放大，
 * 花头与茎的既定比例不变。返回实际生效的倍数，调用方据此换算 headHeight。
 */
function applyUniformScale(template: THREE.Object3D, scale: number | undefined): number {
  if (!Number.isFinite(scale) || !scale || scale === 1) return 1;
  template.scale.multiplyScalar(scale);
  template.updateMatrixWorld(true);
  return scale;
}

/**
 * 整枝等比缩放后，花头实测尺寸也要跟着放大，
 * 否则 headMetrics 会停留在缩放前的局部尺寸里。
 */
function scaleHeadMetrics(metrics: HeadMetrics | null, uniform: number): HeadMetrics | null {
  if (!metrics || uniform === 1) return metrics;
  return {
    width: metrics.width * uniform,
    depth: metrics.depth * uniform,
    height: metrics.height * uniform,
    bottom: metrics.bottom * uniform,
    top: metrics.top * uniform,
    centerY: metrics.centerY * uniform,
    centerX: (metrics.centerX ?? 0) * uniform,
    centerZ: (metrics.centerZ ?? 0) * uniform,
  };
}

/**
 * V0.7 §5：按几何实测程序化花材的花头位置与半径。
 *
 * 这批花型的茎、叶、花头是同一份合并几何，没有像玫瑰/郁金香那样分离出
 * 花头网格，构建器自己声明的 headHeight 是「设计意图」，实测常偏 3–8cm；
 * 而接触形变、选中环、相机对焦、包装高度都吃这个值，偏了就会落在花头顶上
 * 或悬空。这里把顶点按高度分箱，在上半部找横向最舒展的一层当作花头：
 * 花头（或绿叶的叶面铺开）本来就是整枝最宽的地方，比按包围盒估算稳。
 *
 * @param geometry 构建器输出的局部几何
 * @param scale    模板已套用的整枝倍数（顶点坐标要乘它才对得上世界尺寸）
 */
function measureProceduralHead(
  geometry: THREE.BufferGeometry,
  scale: number,
): { centerY: number; radius: number; width: number; depth: number; height: number } | null {
  const position = geometry.getAttribute('position');
  if (!position || position.count < 12) return null;
  const strides = Math.max(1, Math.floor(position.count / 4000));
  const ys: number[] = [];
  const rs: number[] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < position.count; i += strides) {
    const y = position.getY(i) * scale;
    const r = Math.hypot(position.getX(i), position.getZ(i)) * scale;
    ys.push(y);
    rs.push(r);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = maxY - minY;
  if (!Number.isFinite(span) || span < 0.05) return null;
  // 只看顶部这一段：花头（或绿叶铺开的面）在枝顶，往下是茎和中下部的叶子。
  // 取顶部 20% 是有意的窄窗口 —— 有些花型的下部叶片比花头还宽（康乃馨、向日葵），
  // 窗口放大就会把叶尖误当花头。
  const lower = maxY - span * 0.2;
  const bins = 24;
  const binRadius = new Array<number>(bins).fill(0);
  const binCount = new Array<number>(bins).fill(0);
  for (let i = 0; i < ys.length; i++) {
    if (ys[i] < lower) continue;
    const t = (ys[i] - lower) / Math.max(1e-6, maxY - lower);
    const index = Math.min(bins - 1, Math.floor(t * bins));
    if (rs[i] > binRadius[index]) binRadius[index] = rs[i];
    binCount[index] += 1;
  }
  let best = -1;
  let bestRadius = 0;
  for (let i = 0; i < bins; i++) {
    if (binCount[i] === 0) continue;
    if (binRadius[i] > bestRadius) {
      bestRadius = binRadius[i];
      best = i;
    }
  }
  if (best < 0 || bestRadius <= 0) return null;
  const upperSpan = maxY - lower;
  const centerY = lower + ((best + 0.5) / bins) * upperSpan;
  // 花头中心不会真的高过枝顶，也不会低过「花头顶」的一半高度。
  const clampedY = THREE.MathUtils.clamp(centerY, lower, maxY - bestRadius * 0.35);
  // 花头纵向尺度：顶部窗口的高度就是花头大致占的高度；上限 2.4 倍半径，
  // 避免长条花把整段茎都算成花头。包络里用 (宽/2, 高/2, 深/2) 三轴。
  const headHeight = Math.min(upperSpan, Math.max(0.02, bestRadius * 2.4));
  return {
    centerY: +clampedY.toFixed(4),
    // 上限放到 0.22：绿叶的叶面铺开本来就比花头宽（常春藤实测 0.205m），
    // 这个值同时用于建议位与接触判定，按真实铺开量算才不会把叶片插进别的花头。
    radius: +THREE.MathUtils.clamp(bestRadius, 0.03, 0.22).toFixed(4),
    width: +(bestRadius * 2).toFixed(4),
    depth: +(bestRadius * 2).toFixed(4),
    height: +headHeight.toFixed(4),
  };
}

/**
 * 从模型包围盒粗估花头占用半径：花的横向尺寸通常由花头/叶片撑开，
 * 取横向最大边的一半再收一点，避免把整枝的舒展范围当成花头半径。
 */
function estimateHeadRadius(bounds: THREE.Box3): number {
  const width = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z);
  if (!Number.isFinite(width) || width <= 0) return 0.09;
  return THREE.MathUtils.clamp(width * 0.34, 0.055, 0.16);
}

function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) {
      for (const item of material) materials.add(item);
    } else if (material) {
      materials.add(material);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}
