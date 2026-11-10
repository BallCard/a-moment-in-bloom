/**
 * 一键适配花束取景（V13 拍照完成体验）。
 *
 * 为什么要有这个文件：
 * - 导出的照片不是「当前窗口截图」，而是 `BouquetScene.renderPhoto()` 里另算的一台
 *   相机：按花束 + 包装 + 台面的世界包围盒自动取景，再叠加 `photo.zoom/offsetX/offsetY`。
 *   几个手调滑杆就能把花头推出取景框，用户看不出「现在到底拍成什么样」。
 * - 这里按同一套取景规则（包围盒、二分距离、NDC ±0.84 留白）预测花头在成片里的位置，
 *   反算出「让所有花头带留白地落在框内」的 zoom/offset，写回 store，之后仍可手调。
 *
 * 约束：不改 `BouquetScene.ts`。它把 `views / camera / controls / paper / vessel` 等
 * 标成 private，但运行时就是普通字段；这里用一次窄类型断言只读它们，不写场景。
 * 相机 FOV 也复用场景实例上的值，避免两处硬编码漂移。
 */
import * as THREE from 'three';
import { headWorldPosition } from '../data/pose';
import type { PhotoSettings } from '../data/presentation';
import type { StemInstance } from '../data/types';
import { store } from '../state/store';
import type { BouquetScene } from './BouquetScene';

/** 与 BouquetScene.renderPhoto/frameExportCamera 对齐的常量。 */
const FRAME_LIMIT = 0.84;
const FOV_FALLBACK = 38;
/** 适配后花头最外沿的目标 NDC（含花头半径）；0.78 ≈ 四边各留 11%。 */
const FIT_TARGET = 0.78;
/** 预测值超过它就要再拉远一点，保证「仍在画面内」。 */
const FIT_MAX = 0.9;
const ZOOM_MIN = 0.75;
const ZOOM_MAX = 1.3;
/** 与 data/presentation.readPhoto 的范围一致（超出的值会被读档夹掉）。 */
const OFFSET_LIMIT = 0.2;

interface HeadLike {
  center: THREE.Vector3;
  /** 世界坐标下的花头半径（已含枝缩放）。 */
  radius: number;
}

interface HeadMetricsLike {
  width: number;
  depth: number;
  height: number;
  bottom: number;
  top: number;
  centerY: number;
  centerX?: number;
  centerZ?: number;
}

interface StemViewLike {
  root: THREE.Object3D;
  object: THREE.Object3D | null;
  loaded: {
    headHeight: number;
    headRadius: number;
    headMetrics?: HeadMetricsLike | null;
  } | null;
}

/** BouquetScene 的私有字段在运行时仍是普通属性，这里只读、不写。 */
interface SceneInternals {
  scene: THREE.Scene;
  views: Map<string, StemViewLike>;
  camera: THREE.PerspectiveCamera;
  controls: { target: THREE.Vector3 };
  tableGroup: THREE.Object3D;
  paper: { group: THREE.Object3D } | null;
  vessel: THREE.Object3D | null;
  ribbon: { group: THREE.Object3D } | null;
  card: { group: THREE.Object3D } | null;
}

export interface PhotoFitResult {
  ok: boolean;
  reason?: 'empty' | 'no-scene';
  zoom: number;
  offsetX: number;
  offsetY: number;
  /** 适配后预测的最大 |NDC|（含花头半径，1 = 刚好贴边）。 */
  maxNdc: number;
  /** 花束在画面里的占比（%），用于界面提示。 */
  fill: number;
  heads: number;
  /** 预测所有花头仍在画面内。 */
  onScreen: boolean;
  changed: boolean;
}

interface FitProjection {
  maxAbs: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function failure(reason: 'empty' | 'no-scene'): PhotoFitResult {
  return {
    ok: false,
    reason,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    maxNdc: 0,
    fill: 0,
    heads: 0,
    onScreen: false,
    changed: false,
  };
}

function internalsOf(scene: BouquetScene): SceneInternals {
  return scene as unknown as SceneInternals;
}

/** 与 BouquetScene.frameExportCamera 相同口径的取景包围盒。 */
function photoBounds(internals: SceneInternals): THREE.Box3 {
  internals.scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  for (const view of internals.views.values()) {
    if (view.root.visible) bounds.expandByObject(view.root);
  }
  if (internals.vessel?.visible) bounds.expandByObject(internals.vessel);
  if (internals.paper?.group.visible) bounds.expandByObject(internals.paper.group);
  if (internals.ribbon?.group.visible) bounds.expandByObject(internals.ribbon.group);
  if (internals.card?.group.visible) bounds.expandByObject(internals.card.group);
  if (bounds.isEmpty()) bounds.setFromObject(internals.tableGroup);
  return bounds;
}

/** 花头世界坐标：优先读场景里已加载的花头实测中心（与选中环同一口径）。 */
function collectHeads(internals: SceneInternals, stems: StemInstance[]): HeadLike[] {
  return stems.map((stem) => {
    const view = internals.views.get(stem.id);
    const loaded = view?.loaded;
    const headHeight = loaded?.headHeight ?? 0.35;
    const metrics = loaded?.headMetrics;
    const radius = (loaded?.headRadius ?? 0.085) * stem.scale;
    if (view) {
      // 与 BouquetScene.getHeadWorld 一致：局部中心 ×枝缩放 → 根四元数 → 根位置。
      const local = new THREE.Vector3(metrics?.centerX ?? 0, headHeight, metrics?.centerZ ?? 0);
      local.multiplyScalar(stem.scale);
      const center = local.applyQuaternion(view.root.quaternion).add(view.root.position);
      return { center, radius };
    }
    // 资产还没加载完时按文档姿态近似，不让按钮直接失效。
    return { center: headWorldPosition(stem, headHeight * stem.scale), radius };
  });
}

/** 复刻 frameExportCamera 的二分：让包围盒八角落在 NDC ±0.84 内。 */
function solveFrameDistance(
  target: THREE.Vector3,
  direction: THREE.Vector3,
  corners: THREE.Vector3[],
  fov: number,
  aspect: number,
): number {
  const camera = new THREE.PerspectiveCamera(fov, aspect, 0.08, 60);
  let low = 0.5;
  let high = 10;
  for (let step = 0; step < 30; step += 1) {
    const distance = (low + high) / 2;
    camera.position.copy(target).addScaledVector(direction, distance);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
    let maxAbs = 0;
    for (const corner of corners) {
      const projected = corner.clone().project(camera);
      maxAbs = Math.max(maxAbs, Math.abs(projected.x), Math.abs(projected.y));
    }
    if (maxAbs > FRAME_LIMIT) low = distance;
    else high = distance;
  }
  return high;
}

/**
 * 复刻 renderPhoto 里叠加 zoom / offset 之后的导出机位，投影所有花头。
 * offset 的符号与 BouquetScene 一致：目标与相机一起沿「右方 / 上方」平移，
 * 画面内容向反方向移动，因此 offsetX ≈ 花头中心的 NDC × 该距离的半幅宽。
 */
function projectHeads(
  heads: HeadLike[],
  targetBase: THREE.Vector3,
  direction: THREE.Vector3,
  baseDistance: number,
  zoom: number,
  offsetX: number,
  offsetY: number,
  fov: number,
  aspect: number,
): FitProjection {
  const right = new THREE.Vector3().crossVectors(direction, new THREE.Vector3(0, 1, 0));
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  else right.normalize();
  const offset = new THREE.Vector3(right.x * offsetX, offsetY, right.z * offsetX);
  const target = targetBase.clone().add(offset);
  const camera = new THREE.PerspectiveCamera(fov, aspect, 0.08, 60);
  camera.position
    .copy(targetBase)
    .addScaledVector(direction, baseDistance / zoom)
    .add(offset);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  const forward = target.clone().sub(camera.position).normalize();
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(fov / 2));
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const head of heads) {
    const ndc = head.center.clone().project(camera);
    const depth = head.center.clone().sub(camera.position).dot(forward);
    const halfHeight = Math.max(tanHalf * Math.max(depth, 0.1), 0.01);
    const rx = head.radius / (halfHeight * Math.max(aspect, 0.2));
    const ry = head.radius / halfHeight;
    minX = Math.min(minX, ndc.x - rx);
    maxX = Math.max(maxX, ndc.x + rx);
    minY = Math.min(minY, ndc.y - ry);
    maxY = Math.max(maxY, ndc.y + ry);
  }
  const maxAbs = Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY));
  return { maxAbs, minX, maxX, minY, maxY };
}

/** 纯计算：不写 store，方便单测/脚本直接复用。 */
export function computePhotoFit(
  scene: BouquetScene,
  stems: StemInstance[],
  photo: PhotoSettings,
): PhotoFitResult {
  if (stems.length === 0) return failure('empty');
  const internals = internalsOf(scene);
  const heads = collectHeads(internals, stems);
  if (heads.length === 0) return failure('empty');
  const bounds = photoBounds(internals);
  if (bounds.isEmpty()) return failure('empty');

  const targetBase = bounds.getCenter(new THREE.Vector3());
  const direction = new THREE.Vector3().subVectors(
    internals.camera.position,
    internals.controls.target,
  );
  if (direction.lengthSq() < 1e-8) direction.set(0, 0.35, 1);
  direction.normalize();

  // renderPhoto 里竖幅的相机 aspect = size / (size × 1.25) = 0.8。
  const aspect = photo.format === 'portrait' ? 1 / 1.25 : 1;
  const fov =
    Number.isFinite(internals.camera.fov) && internals.camera.fov > 0
      ? internals.camera.fov
      : FOV_FALLBACK;
  const corners: THREE.Vector3[] = [];
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) corners.push(new THREE.Vector3(x, y, z));
    }
  }
  const baseDistance = solveFrameDistance(targetBase, direction, corners, fov, aspect);

  const atOne = projectHeads(heads, targetBase, direction, baseDistance, 1, 0, 0, fov, aspect);
  let zoom = THREE.MathUtils.clamp(FIT_TARGET / Math.max(atOne.maxAbs, 1e-3), ZOOM_MIN, ZOOM_MAX);
  let offsetX = 0;
  let offsetY = 0;
  let projection = projectHeads(heads, targetBase, direction, baseDistance, zoom, 0, 0, fov, aspect);

  // 迭代：先按花头中心补 offset，仍然超出就把镜头拉远。
  for (let step = 0; step < 5; step += 1) {
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(fov / 2)) * (baseDistance / zoom);
    const halfWidth = halfHeight * aspect;
    const centerX = (projection.minX + projection.maxX) / 2;
    const centerY = (projection.minY + projection.maxY) / 2;
    offsetX = THREE.MathUtils.clamp(centerX * halfWidth, -OFFSET_LIMIT, OFFSET_LIMIT);
    offsetY = THREE.MathUtils.clamp(centerY * halfHeight, -OFFSET_LIMIT, OFFSET_LIMIT);
    projection = projectHeads(
      heads,
      targetBase,
      direction,
      baseDistance,
      zoom,
      offsetX,
      offsetY,
      fov,
      aspect,
    );
    if (projection.maxAbs <= FIT_MAX) break;
    zoom = THREE.MathUtils.clamp(zoom * (FIT_MAX / projection.maxAbs) * 0.98, ZOOM_MIN, ZOOM_MAX);
  }

  // 滑杆步进是 0.01 / 0.001，按最终值再预测一次，界面显示的数字才是真实成片。
  zoom = Math.round(zoom * 100) / 100;
  offsetX = Math.round(offsetX * 1000) / 1000;
  offsetY = Math.round(offsetY * 1000) / 1000;
  const final = projectHeads(
    heads,
    targetBase,
    direction,
    baseDistance,
    zoom,
    offsetX,
    offsetY,
    fov,
    aspect,
  );
  const span = Math.max(final.maxX - final.minX, final.maxY - final.minY);
  const changed =    Math.abs(zoom - photo.zoom) > 0.0005 ||
    Math.abs(offsetX - photo.offsetX) > 0.0005 ||
    Math.abs(offsetY - photo.offsetY) > 0.0005;

  return {
    ok: true,
    zoom,
    offsetX,
    offsetY,
    maxNdc: Math.round(final.maxAbs * 1000) / 1000,
    fill: Math.round(THREE.MathUtils.clamp(span / 2, 0, 1) * 100),
    heads: heads.length,
    onScreen: final.maxAbs <= 1,
    changed,
  };
}

/** 计算并写回 store；之后用户仍可用滑杆微调。 */
export function applyPhotoFit(scene: BouquetScene | null): PhotoFitResult {
  if (!scene) return failure('no-scene');
  const state = store.getState();
  const result = computePhotoFit(scene, state.doc.stems, state.doc.photo);
  if (!result.ok) return result;
  if (!result.changed) return result;
  store.updatePhoto({ zoom: result.zoom, offsetX: result.offsetX, offsetY: result.offsetY });
  store.endTransaction();
  return result;
}
