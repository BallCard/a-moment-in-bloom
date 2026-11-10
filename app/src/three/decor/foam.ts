/**
 * 花泥视觉（V16 §3）。纯 three.js：只负责在适用容器内腔放一块程序化花泥，
 * 状态始终来自 `doc.presentation.foam = { fitted, cut }`，本模块不改文档。
 *
 * 尺寸来源：
 * - 站在容器组（组原点 = 容器底面中心，与 `three/decor/vessel.ts` / `vessel-load.ts`
 *   的归一化一致）里按**实际网格**量：先量整体包围盒，再用口沿附近一圈顶点量
 *   真实口沿半径，所以 GLB 提手/盒盖不会把花泥顶到容器上方，花泥也不会穿侧壁；
 * - 容器还没挂上 GLB（程序化兜底）时同样能量到；模型异步挂载后由轻量看门狗
 *   重新量一次并刷新，不需要调用方额外通知。
 *
 * 状态表现（cut 0→1 有可见差异）：
 * - cut = 0（刚放入、未按内腔裁）：花泥明显高出器口、半径贴近内壁；
 * - cut = 1（按内腔裁好）：花泥落到口沿之下、半径收小 10%，露出平整切面。
 *
 * 透明花瓶 / 纸片包装 `supportsFoam()` 为 false：不创建、不显示花泥。
 */

import * as THREE from 'three';
import type { FoamState, PresentationKind } from '../../data/presentation';
import { VESSELS } from '../../data/presentation';
import { supportsFoam } from '../../data/decor-capability';

export interface FoamDebug {
  /** 当前是否真的有一块可见花泥。 */
  exists: boolean;
  kind: string;
  fitted: boolean;
  cut: number;
  visible: boolean;
  /** 花泥半径（米）。 */
  radius: number;
  /** 花泥顶面高度（容器局部坐标 y，米）。 */
  topY: number;
  /** 花泥块高度（米）。 */
  height: number;
  /** 量到的容器口沿高度（容器局部坐标 y，米）。 */
  rimY: number;
  /** 花泥半径到口沿内壁的余量（米，≥0 表示没穿侧壁）。 */
  wallGap: number;
}

interface FoamEntry {
  parent: THREE.Object3D;
  group: THREE.Group;
  kind: PresentationKind;
  state: FoamState;
  debug: FoamDebug;
  material: THREE.MeshStandardMaterial | null;
  cutMaterial: THREE.MeshStandardMaterial | null;
  geometry: THREE.BufferGeometry | null;
  cutGeometry: THREE.BufferGeometry | null;
  /** 上次量尺寸时的结构签名（网格数量），模型异步挂载后据此重算。 */
  signature: string;
  disposed: boolean;
}

const GROUP_NAME = 'organize-foam';
const registry = new Map<string, FoamEntry>();
let watchdog: ReturnType<typeof setInterval> | null = null;

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function signatureOf(parent: THREE.Object3D): string {
  let meshes = 0;
  parent.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && !isFoamObject(mesh)) meshes += 1;
  });
  return `${parent.children.length}:${meshes}`;
}

function isFoamObject(object: THREE.Object3D): boolean {
  let node: THREE.Object3D | null = object;
  while (node) {
    if (node.name === GROUP_NAME) return true;
    node = node.parent;
  }
  return false;
}

interface VesselMetrics {
  rimY: number;
  bottomY: number;
  mouthRadius: number;
  centerX: number;
  centerZ: number;
}

/**
 * 量容器内腔：整体包围盒给高度范围，口沿附近一圈顶点给真实口沿半径与中心。
 * 提手/盒盖会让整体包围盒偏高，所以口沿高度再被 `VESSELS[kind].height` 夹一次。
 */
function measureVessel(parent: THREE.Object3D, kind: PresentationKind): VesselMetrics {
  parent.updateMatrixWorld(true);
  const inverse = parent.matrixWorld.clone().invert();
  const local = new THREE.Vector3();
  const bounds = new THREE.Box3();
  const points: THREE.Vector3[] = [];
  let sampled = 0;
  parent.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || isFoamObject(mesh)) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position) return;
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox;
    if (box) {
      for (let i = 0; i < 8; i += 1) {
        local.set(
          i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z,
        );
        local.applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
        bounds.expandByPoint(local);
      }
    }
    // 顶点按比例抽样，够量口沿半径就行（GLB 动辄 4 万面）。
    const stride = Math.max(1, Math.floor(position.count / 6000));
    for (let i = 0; i < position.count; i += stride) {
      local.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
      points.push(local.clone());
      sampled += 1;
      if (sampled > 24000) break;
    }
  });
  const spec = VESSELS[kind as Exclude<PresentationKind, 'paper'>];
  if (!bounds.isEmpty()) {
    const boxHeight = bounds.max.y - bounds.min.y;
    // 口沿：优先用实际包围盒顶（GLB 归一化后底面在 y=0）；但提手/盒盖会高出器身，
    // 用设计尺寸 + 2cm 作上限，别把花泥放到提手位置。
    const designTop = spec ? spec.height + 0.02 : 0;
    const rimY = designTop > 0 ? Math.min(bounds.max.y, designTop) : bounds.max.y;
    const bottomY = Math.max(bounds.min.y, rimY - 0.09);
    const bandLow = rimY - 0.055;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let count = 0;
    for (const point of points) {
      if (point.y < bandLow || point.y > rimY + 0.012) continue;
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
      count += 1;
    }
    if (count >= 20 && maxX > minX && maxZ > minZ) {
      return {
        rimY,
        bottomY,
        mouthRadius: Math.min(maxX - minX, maxZ - minZ) / 2,
        centerX: (minX + maxX) / 2,
        centerZ: (minZ + maxZ) / 2,
      };
    }
    if (boxHeight > 0.02) {
      return {
        rimY,
        bottomY,
        mouthRadius: Math.min(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) / 2,
        centerX: (bounds.min.x + bounds.max.x) / 2,
        centerZ: (bounds.min.z + bounds.max.z) / 2,
      };
    }
  }
  // 完全没有网格（容器还没挂上）时按设计尺寸兜底，保证有东西可量。
  const height = spec?.height ?? 0.18;
  return { rimY: height, bottomY: 0, mouthRadius: (spec?.mouth ?? 0.14) * 0.9, centerX: 0, centerZ: 0 };
}

function ensureGroup(parent: THREE.Object3D): THREE.Group {
  const existing = parent.getObjectByName(GROUP_NAME);
  if (existing instanceof THREE.Group) return existing;
  const group = new THREE.Group();
  group.name = GROUP_NAME;
  group.userData.organizeFoam = true;
  parent.add(group);
  return group;
}

function clearEntryVisuals(entry: FoamEntry): void {
  for (const child of [...entry.group.children]) {
    entry.group.remove(child);
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) mesh.geometry.dispose();
  }
  entry.material?.dispose();
  entry.cutMaterial?.dispose();
  entry.material = null;
  entry.cutMaterial = null;
  entry.geometry = null;
  entry.cutGeometry = null;
}

function buildFoam(
  entry: FoamEntry,
  metrics: VesselMetrics,
  foam: FoamState,
  kind: PresentationKind,
): void {
  clearEntryVisuals(entry);
  const cut = clamp01(foam.cut);
  // 半径始终小于口沿内壁，避免穿侧壁；cut 后明显收小，和「刚塞进去偏大 → 裁好贴合」对应。
  const wallRadius = metrics.mouthRadius * 0.78;
  const radius = wallRadius * (1 - 0.1 * cut);
  // cut=0 明显高出器口（一眼看出还没裁贴合），cut=1 落到口沿下方。
  const topY = metrics.rimY + 0.02 * (1 - cut) - 0.01 * cut;
  const bottomY = Math.max(metrics.bottomY + 0.008, topY - 0.058);
  const height = Math.max(0.012, topY - bottomY);
  const geometry = new THREE.CylinderGeometry(radius, radius * 0.97, height, 32, 1, false);
  // 花泥是深绿、哑光的吸水块；略深的侧壁 + 稍亮的切面，两档裁切状态分得出来。
  const material = new THREE.MeshStandardMaterial({
    color: '#4d6538',
    roughness: 0.96,
    metalness: 0,
  });
  const body = new THREE.Mesh(geometry, material);
  body.name = 'organize-foam-body';
  body.position.set(metrics.centerX, (topY + bottomY) / 2, metrics.centerZ);
  body.castShadow = false;
  body.receiveShadow = true;
  entry.group.add(body);

  const cutGeometry = new THREE.CircleGeometry(radius * 0.995, 32);
  cutGeometry.rotateX(-Math.PI / 2);
  const cutMaterial = new THREE.MeshStandardMaterial({
    color: cut >= 0.999 ? '#5d7a45' : '#54703f',
    roughness: 0.9,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const face = new THREE.Mesh(cutGeometry, cutMaterial);
  face.name = 'organize-foam-face';
  face.position.set(metrics.centerX, topY + 0.0006, metrics.centerZ);
  entry.group.add(face);

  entry.material = material;
  entry.cutMaterial = cutMaterial;
  entry.geometry = geometry;
  entry.cutGeometry = cutGeometry;
  entry.group.visible = true;
  entry.debug = {
    exists: true,
    kind,
    fitted: true,
    cut,
    visible: true,
    radius: Number(radius.toFixed(4)),
    topY: Number(topY.toFixed(4)),
    height: Number(height.toFixed(4)),
    rimY: Number(metrics.rimY.toFixed(4)),
    wallGap: Number((metrics.mouthRadius - radius).toFixed(4)),
  };
}

/**
 * 同步花泥视觉。`parent` 是容器组（组原点 = 容器底面中心，见 `createVessel`），
 * 花泥作为它的子节点放在内腔，随容器一起移动/隐藏。
 *
 * 幂等：状态没变时只做一次签名检查；适配容器或状态变化时才重建几何。
 */
export function syncFoam(parent: THREE.Object3D, kind: PresentationKind, foam: FoamState): void {
  const supported = supportsFoam(kind);
  const fitted = foam.fitted === true && supported;
  const entered: FoamState = { fitted, cut: clamp01(foam.cut) };
  const key = parent.uuid;
  let entry = registry.get(key);
  if (!entry) {
    entry = {
      parent,
      group: ensureGroup(parent),
      kind,
      state: entered,
      debug: {
        exists: false,
        kind,
        fitted: false,
        cut: 0,
        visible: false,
        radius: 0,
        topY: 0,
        height: 0,
        rimY: 0,
        wallGap: 0,
      },
      material: null,
      cutMaterial: null,
      geometry: null,
      cutGeometry: null,
      signature: '',
      disposed: false,
    };
    registry.set(key, entry);
    startWatchdog();
  }
  if (entry.disposed) return;
  const signature = signatureOf(parent);
  const structChanged = signature !== entry.signature;
  const stateChanged =
    entry.kind !== kind ||
    entry.state.fitted !== entered.fitted ||
    Math.abs(entry.state.cut - entered.cut) > 1e-4;
  if (!fitted) {
    // 不适用 / 没放入：隐藏并释放视觉，不留悬空花泥。
    if (entry.group.visible || entry.group.children.length > 0) {
      for (const child of [...entry.group.children]) {
        entry.group.remove(child);
        (child as THREE.Mesh).geometry?.dispose();
      }
      entry.group.visible = false;
    }
    entry.material?.dispose();
    entry.cutMaterial?.dispose();
    entry.material = null;
    entry.cutMaterial = null;
    entry.group.visible = false;
    entry.kind = kind;
    entry.state = entered;
    entry.signature = signature;
    entry.debug = {
      exists: false,
      kind,
      fitted: false,
      cut: 0,
      visible: false,
      radius: 0,
      topY: 0,
      height: 0,
      rimY: 0,
      wallGap: 0,
    };
    return;
  }
  if (!entry.group.visible || stateChanged || structChanged || entry.group.children.length === 0) {
    const metrics = measureVessel(parent, kind);
    buildFoam(entry, metrics, entered, kind);
  }
  entry.kind = kind;
  entry.state = entered;
  entry.group.visible = true;
  entry.signature = signature;
}

/** 轻量看门狗：容器 GLB 异步挂载后（结构签名变化）自动重算一次尺寸。 */
function startWatchdog(): void {
  if (watchdog) return;
  watchdog = setInterval(() => {
    if (registry.size === 0) {
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
      return;
    }
    for (const entry of [...registry.values()]) {
      if (entry.disposed) {
        registry.delete(entry.parent.uuid);
        continue;
      }
      if (!entry.state.fitted) continue;
      if (signatureOf(entry.parent) === entry.signature) continue;
      syncFoam(entry.parent, entry.kind, entry.state);
    }
  }, 700);
  // Node/SSR 环境下 interval 不会阻止退出。
  (watchdog as unknown as { unref?: () => void }).unref?.();
}

/** 供验证脚本读取：最近一次同步出来的花泥状态（存在性、半径、高度、口沿余量）。 */
export function getFoamDebug(): FoamDebug | null {
  let fallback: FoamDebug | null = null;
  for (const entry of registry.values()) {
    if (entry.debug.exists && entry.debug.visible) return { ...entry.debug };
    if (!fallback) fallback = { ...entry.debug };
  }
  return fallback;
}

/** 花枝删除 / 换场景时释放（`parent` 是传给 syncFoam 的容器组）。 */
export function disposeFoam(parent: THREE.Object3D): void {
  const entry = registry.get(parent.uuid);
  if (!entry) return;
  entry.disposed = true;
  registry.delete(parent.uuid);
  clearEntryVisuals(entry);
  parent.remove(entry.group);
  if (registry.size === 0 && watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
}
