/**
 * 整理动作的三维视觉（V16 §3）。纯 three.js，不改文档、不进撤销栈：
 *
 * - `applyPetalFlip`：可翻瓣花材（rose）外圈花瓣外翻/打开。做法是对花头几何做
 *   **逐顶点径向 + 切向**形变（外圈按权重绕花托枢轴向外翻、略向下压），
 *   0 = 原样、1 = 完全翻开。每枝第一次使用时把花头几何**克隆一份**再改写，
 *   绝不修改模板共享几何；所有结果都从保存的原始顶点重算，因此幂等、可恢复。
 * - `applyThorns`：可去刺花材（rose）在可见茎段生成几枚程序化小刺（与茎同色系），
 *   removed=true 时短淡出并隐藏；非适用花材直接不生成。
 * - `applyLowerStemTrim`：对非 prepared 花材按余茎长度裁掉下部茎段（按三角形丢面 +
 *   收口小盖片），可恢复。**真实资产核对结论**：非玫瑰/郁金香 GLB 是整枝单网格，
 *   茎下端只到握点下方约 2 cm，没有多余茎尾（见 `getOrganizeVisualDebug().lowerTrim`），
 *   所以界面对这类花材不显示「剪短」，这里只返回状态（`reason: 'no-surplus-stem'`）；
 *   若将来换到带余茎的资产，同一函数会真的按三角形裁并加收口盖片。
 *
 * 调用位置（由 BouquetScene 接线）：
 * - 每枝模板加载完成、`applyPreparation` 之后调用一次 `applyPetalFlip(object, prep.petalFlip ?? 0)`；
 * - 同一处调用 `applyThorns(object, family, prep.thornsRemoved === true)`；
 * - 同一处调用 `applyLowerStemTrim(object, kind, prep.tailLength, family)`；
 * - 删除花枝 / 场景销毁时调用 `disposeOrganizeVisual(object)` 释放私有几何与材质。
 */

import * as THREE from 'three';
import { PREPARED_FAMILIES } from '../../data/organize';
import type { PresentationKind } from '../../data/presentation';

// ---------- 公共类型 ----------

export interface OrganizeVisualDebug {
  /** 花头数量（可翻瓣的网格数）。 */
  headMeshes: number;
  /** 当前翻瓣程度 0–1。 */
  petalFlip: number;
  /** 花头外圈半径（米，几何级实测）。 */
  headRadius: number;
  /** 小刺：是否适用、是否显示、数量。 */
  thorns: { supported: boolean; visible: boolean; count: number };
  /** 下部茎裁剪状态。 */
  lowerTrim: LowerStemTrimResult;
}

export type LowerStemTrimReason =
  | 'prepared'
  | 'no-surplus-stem'
  | 'trimmed'
  | 'restored'
  | 'missing-geometry';

export interface LowerStemTrimResult {
  /** 是否真的改了可见几何。 */
  applied: boolean;
  reason: LowerStemTrimReason;
  /** 裁剪平面（花枝局部坐标 y，米）。 */
  cutY: number;
  /** 可见几何最低点（花枝局部坐标 y，米）。 */
  minY: number;
  /** 被裁的网格数。 */
  trimmedMeshes: number;
}

// ---------- 翻瓣 ----------

interface HeadFlipData {
  mesh: THREE.Mesh;
  /** 每枝私有的几何（第一次调用时克隆，之后一直复用，不碰模板共享几何）。 */
  geometry: THREE.BufferGeometry;
  /** 原始顶点（只保存被索引引用的顶点坐标，恢复时用）。 */
  base: Float32Array;
  /** 原始法线，用于精确恢复原样。 */
  baseNormals: Float32Array | null;
  /** 被索引引用的唯一顶点序号。 */
  indices: Uint32Array;
  centerX: number;
  centerZ: number;
  radius: number;
  yMin: number;
  yMax: number;
}

interface FlipCache {
  heads: HeadFlipData[];
  amount: number;
}

const FLIP_TAG = 'organizePetalFlip';

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / Math.max(1e-6, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** 找到花枝里可翻瓣的花头网格（玫瑰/郁金香在 prepareFlower 里被命名）。 */
function headMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.name === 'original-flower-head') found.push(mesh);
  });
  return found;
}

function uniqueIndices(geometry: THREE.BufferGeometry): Uint32Array {
  const index = geometry.index;
  const attribute = geometry.getAttribute('position');
  if (!index) {
    const linear = new Uint32Array(attribute.count);
    for (let i = 0; i < attribute.count; i += 1) linear[i] = i;
    return linear;
  }
  const seen = new Uint8Array(attribute.count);
  const list: number[] = [];
  for (let i = 0; i < index.count; i += 1) {
    const vertex = index.getX(i);
    if (vertex < 0 || vertex >= attribute.count || seen[vertex]) continue;
    seen[vertex] = 1;
    list.push(vertex);
  }
  return Uint32Array.from(list);
}

function buildHeadData(mesh: THREE.Mesh): HeadFlipData | null {
  const source = mesh.geometry;
  const position = source.getAttribute('position');
  if (!position) return null;
  // 关键：先克隆一份私有几何。模板几何在实例之间共享，绝不能就地改写。
  const geometry = source.clone();
  const indices = uniqueIndices(geometry);
  if (indices.length === 0) {
    geometry.dispose();
    return null;
  }
  const base = new Float32Array(indices.length * 3);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < indices.length; i += 1) {
    const vertex = indices[i];
    const x = position.getX(vertex);
    const y = position.getY(vertex);
    const z = position.getZ(vertex);
    base[i * 3] = x;
    base[i * 3 + 1] = y;
    base[i * 3 + 2] = z;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const normal = source.getAttribute('normal');
  let baseNormals: Float32Array | null = null;
  if (normal) {
    baseNormals = new Float32Array(indices.length * 3);
    for (let i = 0; i < indices.length; i += 1) {
      const vertex = indices[i];
      baseNormals[i * 3] = normal.getX(vertex);
      baseNormals[i * 3 + 1] = normal.getY(vertex);
      baseNormals[i * 3 + 2] = normal.getZ(vertex);
    }
  }
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  let radius = 0;
  for (let i = 0; i < indices.length; i += 1) {
    radius = Math.max(radius, Math.hypot(base[i * 3] - centerX, base[i * 3 + 2] - centerZ));
  }
  // 换上私有几何：之后所有形变都写在这份几何上，模板与其它实例不受影响。
  mesh.geometry = geometry;
  return {
    mesh,
    geometry,
    base,
    baseNormals,
    indices,
    centerX,
    centerZ,
    radius: Math.max(radius, 1e-5),
    yMin: minY,
    yMax: Math.max(maxY, minY + 1e-4),
  };
}

/** 把翻瓣程度（0–1）写进几何；重复调用同一数值是空操作。 */
export function applyPetalFlip(root: THREE.Object3D, amount: number): number {
  const target = clamp01(Number.isFinite(amount) ? amount : 0);
  let cache = root.userData[FLIP_TAG] as FlipCache | undefined;
  if (!cache) {
    const heads = headMeshes(root)
      .map((mesh) => buildHeadData(mesh))
      .filter((item): item is HeadFlipData => item !== null);
    cache = { heads, amount: -1 };
    root.userData[FLIP_TAG] = cache;
  }
  if (cache.heads.length === 0) return 0;
  if (Math.abs(cache.amount - target) < 1e-4) return target;
  cache.amount = target;

  for (const head of cache.heads) {
    const position = head.geometry.getAttribute('position') as THREE.BufferAttribute;
    const array = position.array as Float32Array;
    const height = head.yMax - head.yMin;
    const rStart = head.radius * 0.42;
    const pivotY = head.yMin + height * 0.28;
    const pivotR = head.radius * 0.34;

    if (target <= 1e-4) {
      // 0 = 原样：直接还原保存的顶点与法线，避免累积误差。
      for (let i = 0; i < head.indices.length; i += 1) {
        const vertex = head.indices[i];
        array[vertex * 3] = head.base[i * 3];
        array[vertex * 3 + 1] = head.base[i * 3 + 1];
        array[vertex * 3 + 2] = head.base[i * 3 + 2];
      }
      position.needsUpdate = true;
      restoreNormals(head);
      head.geometry.computeBoundingSphere();
      continue;
    }

    for (let i = 0; i < head.indices.length; i += 1) {
      const vertex = head.indices[i];
      const x = head.base[i * 3];
      const y = head.base[i * 3 + 1];
      const z = head.base[i * 3 + 2];
      const dx = x - head.centerX;
      const dz = z - head.centerZ;
      const r = Math.hypot(dx, dz);
      if (r < 1e-6) continue;
      // 只有外圈（花苞外壳）参与外翻；越靠外、越靠上的花瓣翻得越多。
      const radial = smoothstep(rStart, head.radius, r);
      const hNorm = (y - head.yMin) / height;
      const lift = smoothstep(0.06, 0.94, hNorm);
      // V16.1：花头最下面 20–46% 是萼片 / 花瓣基部（真实花里连着花托），
      // 把它一起往外推会在花头下缘留下「浮空的绿片」。权重在这里收敛到 0，
      // 下面的萼片与花瓣基部保持原位，只有上半段花瓣真正外翻。
      const bottomConverge = smoothstep(0.2, 0.46, hNorm);
      const weight = radial * (0.16 + 0.84 * lift) * bottomConverge;
      if (weight < 1e-4) continue;
      const angle = target * 1.32 * weight;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const dr = Math.max(0, r - pivotR);
      const dy = y - pivotY;
      // 绕花托外沿的切向轴向外翻：外圈花瓣尖端外移、下沉，像被手指剥开。
      const nextR = pivotR + dr * cos + dy * sin + head.radius * 0.05 * weight * target;
      const nextY = pivotY - dr * sin + dy * cos;
      const scale = nextR / r;
      array[vertex * 3] = head.centerX + dx * scale;
      array[vertex * 3 + 1] = nextY;
      array[vertex * 3 + 2] = head.centerZ + dz * scale;
    }
    position.needsUpdate = true;
    // 法线跟着几何重算，翻瓣处的高光才会跟着走；只在数值真的变了时付这个代价。
    head.geometry.computeVertexNormals();
    head.geometry.computeBoundingSphere();
  }
  return target;
}

function restoreNormals(head: HeadFlipData): void {
  if (!head.baseNormals) {
    head.geometry.computeVertexNormals();
    return;
  }
  const normal = head.geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (!normal) {
    head.geometry.computeVertexNormals();
    return;
  }
  const array = normal.array as Float32Array;
  for (let i = 0; i < head.indices.length; i += 1) {
    const vertex = head.indices[i];
    array[vertex * 3] = head.baseNormals[i * 3];
    array[vertex * 3 + 1] = head.baseNormals[i * 3 + 1];
    array[vertex * 3 + 2] = head.baseNormals[i * 3 + 2];
  }
  normal.needsUpdate = true;
}

// ---------- 去刺 ----------

const THORNS_TAG = 'organizeThorns';
const THORN_FAMILY = 'rose';
const THORN_COUNT = 6;

interface ThornsCache {
  group: THREE.Group;
  material: THREE.MeshStandardMaterial;
  visible: boolean;
  fade: { value: number; target: number; frame: number } | null;
}

/** 找到可见茎段在花枝局部坐标里的位置与半径，刺沿着它排布。 */
function stemFrame(root: THREE.Object3D): { yMin: number; yMax: number; radius: number } | null {
  const stem = root.getObjectByName('prepared-upper-stem') as THREE.Mesh | null;
  if (!stem || !stem.isMesh) return null;
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  const box = stem.geometry.boundingBox ?? (stem.geometry.computeBoundingBox(), stem.geometry.boundingBox);
  if (!box) return null;
  const min = box.min.clone();
  const max = box.max.clone();
  const corners = [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z),
  ];
  let yMin = Infinity;
  let yMax = -Infinity;
  let radius = 0;
  const local = new THREE.Vector3();
  for (const corner of corners) {
    local.copy(corner).applyMatrix4(stem.matrixWorld).applyMatrix4(inverse);
    yMin = Math.min(yMin, local.y);
    yMax = Math.max(yMax, local.y);
    radius = Math.max(radius, Math.hypot(local.x, local.z));
  }
  if (!Number.isFinite(yMin) || yMax - yMin < 0.02) return null;
  return { yMin, yMax, radius: Math.max(radius, 0.0015) };
}

/** 确定性伪随机：同一枚刺每次加载形状一致，不会每次刷新都换一个样子。 */
function seeded(seed: number, salt: number): number {
  const v = Math.sin(seed * 127.1 + salt * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

interface ClawGeometry {
  geometry: THREE.BufferGeometry;
  length: number;
  bend: number;
}

/**
 * 小刺几何（task-10 收敛版）：细小、低饱和的绿褐色短刺，略微向后弯。
 *
 * 用一条很浅的 CatmullRom 曲线扫 6 圈截面：基部略粗、尖端收细，只带一点点弧度；
 * 目的是「近看是自然的小刺」，不是显眼的爪状装饰。颜色由材质统一给低饱和绿褐。
 */
function clawGeometry(seed: number): ClawGeometry {
  const length = 0.0068 + seeded(seed, 1) * 0.0024;
  const baseRadius = 0.0012 + seeded(seed, 2) * 0.0004;
  const bend = 0.16 + seeded(seed, 3) * 0.12;
  const rings = 6;
  const sides = 6;
  const positions: number[] = [];
  const indices: number[] = [];
  // 基部沿 +Y 长出，越往上越往 -Z 轻微勾一点。
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, length * 0.45, -bend * length * 0.08),
    new THREE.Vector3(0, length * 0.78, -bend * length * 0.35),
    new THREE.Vector3(0, length * 0.95, -bend * length * 0.85),
  ]);
  const point = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const binormal = new THREE.Vector3();
  const reference = new THREE.Vector3(0, 0, 1);
  for (let r = 0; r <= rings; r += 1) {
    const t = r / rings;
    curve.getPoint(t, point);
    curve.getTangent(t, tangent).normalize();
    normal.crossVectors(tangent, reference);
    if (normal.lengthSq() < 1e-6) normal.set(1, 0, 0);
    normal.normalize();
    binormal.crossVectors(tangent, normal).normalize();
    // 基部略粗 → 尖端收细；不做膨大球根。
    const radius = Math.max(0.00012, baseRadius * (1.15 - 0.75 * t) * Math.pow(1 - t, 0.35));
    for (let s = 0; s < sides; s += 1) {
      const angle = (s / sides) * Math.PI * 2;
      positions.push(
        point.x + (normal.x * Math.cos(angle) + binormal.x * Math.sin(angle)) * radius,
        point.y + (normal.y * Math.cos(angle) + binormal.y * Math.sin(angle)) * radius,
        point.z + (normal.z * Math.cos(angle) + binormal.z * Math.sin(angle)) * radius,
      );
    }
  }
  const baseCenter = (rings + 1) * sides;
  const tipCenter = baseCenter + 1;
  curve.getPoint(0, point);
  positions.push(point.x, point.y, point.z);
  curve.getPoint(1, point);
  positions.push(point.x, point.y, point.z);
  for (let r = 0; r < rings; r += 1) {
    for (let s = 0; s < sides; s += 1) {
      const a = r * sides + s;
      const b = r * sides + ((s + 1) % sides);
      const c = (r + 1) * sides + s;
      const d = (r + 1) * sides + ((s + 1) % sides);
      indices.push(a, c, b, b, c, d);
    }
  }
  // 封底 + 封尖（避免近看能看到刺是空心管）
  for (let s = 0; s < sides; s += 1) {
    const a = s;
    const b = (s + 1) % sides;
    indices.push(baseCenter, b, a);
  }
  const lastRing = rings * sides;
  for (let s = 0; s < sides; s += 1) {
    const a = lastRing + s;
    const b = lastRing + ((s + 1) % sides);
    indices.push(tipCenter, a, b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return { geometry, length, bend };
}

function buildThorns(root: THREE.Object3D): ThornsCache | null {
  const frame = stemFrame(root);
  if (!frame) return null;
  const group = new THREE.Group();
  group.name = 'organize-thorns';
  const material = new THREE.MeshStandardMaterial({
    // 低饱和的绿褐：和茎（#567348）同色系、略深一点，近看不抢眼。
    // **必须不透明**：之前 transparent:true 在浅背景里会渲染成半透明淡绿碎片；
    // 去掉时用缩放淡出（stepFade），材质始终 opaque。
    color: '#586a3f',
    roughness: 0.82,
    metalness: 0,
    transparent: false,
    opacity: 1,
    depthWrite: true,
    side: THREE.FrontSide,
  });
  const length = frame.yMax - frame.yMin;
  // stemFrame 的 radius 是茎包围盒角点距离（≈ 真实半径 × √2），先还原成真实半径，
  // 再把刺根埋到表面以内：原来按角点半径取位，刺根会悬在茎外半个毫米，近看是浮空的。
  const stemRadius = frame.radius * 0.7071;
  const up = new THREE.Vector3(0, 1, 0);
  const geometries: THREE.BufferGeometry[] = [];
  for (let i = 0; i < THORN_COUNT; i += 1) {
    const claw = clawGeometry(i + 1);
    geometries.push(claw.geometry);
    const thorn = new THREE.Mesh(claw.geometry, material);
    thorn.name = `organize-thorn-${i}`;
    const t = 0.1 + (0.82 * i) / Math.max(1, THORN_COUNT - 1);
    // 方位与高度带一点确定性随机，排布不像一圈规则的小锥。
    const angle = i * 2.39996 + (seeded(i, 5) - 0.5) * 0.5;
    const height = frame.yMin + length * (t + (seeded(i, 6) - 0.5) * 0.05);
    const radial = stemRadius * (0.42 + seeded(i, 7) * 0.08);
    thorn.position.set(Math.cos(angle) * radial, height, Math.sin(angle) * radial);
    // 朝向：大体朝外略向上；再绕自身轴转一下，让轻微弯曲方向朝下。
    const direction = new THREE.Vector3(
      Math.cos(angle) * 0.96,
      0.22 + seeded(i, 8) * 0.12,
      Math.sin(angle) * 0.96,
    ).normalize();
    const align = new THREE.Quaternion().setFromUnitVectors(up, direction);
    const bendWorld = new THREE.Vector3(0, 0, -1).applyQuaternion(align);
    const desired = new THREE.Vector3(Math.cos(angle), -0.6, Math.sin(angle));
    desired.addScaledVector(direction, -desired.dot(direction));
    if (desired.lengthSq() < 1e-6) desired.set(0, -1, 0);
    desired.normalize();
    const current = bendWorld.clone();
    current.addScaledVector(direction, -current.dot(direction));
    if (current.lengthSq() < 1e-6) current.set(0, 0, 1);
    current.normalize();
    const signed = Math.atan2(
      direction.dot(new THREE.Vector3().crossVectors(current, desired)),
      current.dot(desired),
    );
    const twist = new THREE.Quaternion().setFromAxisAngle(direction, signed);
    thorn.quaternion.copy(twist.multiply(align));
    thorn.scale.setScalar(0.9 + seeded(i, 9) * 0.16);
    thorn.castShadow = false;
    thorn.userData.organizeThorn = true;
    group.add(thorn);
  }
  group.userData.organizeThornGeometries = geometries;
  root.add(group);
  return { group, material, visible: true, fade: null };
}

function stepFade(cache: ThornsCache): void {
  const fade = cache.fade;
  if (!fade) return;
  fade.frame = requestAnimationFrame(() => {
    const next = fade.value + (fade.target - fade.value) * 0.34;
    const done = Math.abs(fade.target - next) < 0.02;
    fade.value = done ? fade.target : next;
    // 缩放淡出/淡入：材质始终不透明，浅背景下不会再出现半透明碎片。
    cache.group.scale.setScalar(Math.max(0.001, fade.value));
    if (done) {
      cache.visible = fade.target > 0.5;
      cache.group.visible = cache.visible;
      cache.group.scale.setScalar(1);
      cache.fade = null;
      return;
    }
    stepFade(cache);
  });
}

function scheduleFade(cache: ThornsCache, target: number): void {
  // 淡出/淡入播到一半时，场景每帧的同步会重复调用 applyThorns；同向的重复调用不能
  // 取消并重排动画帧，否则动画永远来不及执行（真实页面实测：刺一直不消失）。
  if (cache.fade) {
    if (Math.abs(cache.fade.target - target) < 0.01) return;
    cancelAnimationFrame(cache.fade.frame);
    cache.fade = null;
  }
  const current = cache.visible ? cache.group.scale.x : 0;
  if (Math.abs(current - target) < 0.02) {
    cache.group.scale.setScalar(1);
    cache.visible = target > 0.5;
    cache.group.visible = cache.visible;
    return;
  }
  if (target > 0.5) cache.group.visible = true;
  cache.fade = { value: current, target, frame: 0 };
  stepFade(cache);
}

/**
 * 生成/隐藏小刺。`family` 不是可去刺花材时完全不显示（也不创建几何）。
 * removed=true 时做约 0.2 秒淡出再隐藏；恢复时淡入。
 */
export function applyThorns(root: THREE.Object3D, family: string, removed: boolean): void {
  const supported = family === THORN_FAMILY;
  let cache = root.userData[THORNS_TAG] as ThornsCache | undefined;
  if (!supported) {
    if (cache) disposeThorns(root, cache);
    return;
  }
  if (!cache) {
    cache = buildThorns(root) ?? undefined;
    if (!cache) return;
    root.userData[THORNS_TAG] = cache;
  }
  const wantVisible = !removed;
  if (cache.visible === wantVisible && !cache.fade) return;
  scheduleFade(cache, wantVisible ? 1 : 0);
}

function disposeThorns(root: THREE.Object3D, cache: ThornsCache): void {
  if (cache.fade) cancelAnimationFrame(cache.fade.frame);
  root.remove(cache.group);
  cache.group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) mesh.castShadow = false;
  });
  const geometries = (cache.group.userData.organizeThornGeometries as THREE.BufferGeometry[] | undefined) ?? [];
  for (const geometry of geometries) geometry.dispose();
  cache.material.dispose();
  delete root.userData[THORNS_TAG];
}

// ---------- 下部茎裁剪（非玫瑰/郁金香） ----------

const TRIM_TAG = 'organizeLowerTrim';

interface MeshTrimData {
  mesh: THREE.Mesh;
  /** 裁剪前的几何（实例私有克隆的原件引用，恢复时换回）。 */
  source: THREE.BufferGeometry;
  /** 裁剪后的几何（丢面后的索引）。 */
  working: THREE.BufferGeometry;
}

interface LowerTrimCache {
  meshes: MeshTrimData[];
  cap: THREE.Mesh | null;
  capMaterial: THREE.MeshStandardMaterial | null;
  result: LowerStemTrimResult;
}

/** 把一个网格的几何量到花枝局部坐标里的最低点与茎半径（粗估）。 */
function meshFrame(
  mesh: THREE.Mesh,
  root: THREE.Object3D,
): { minY: number; radius: number } | null {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  if (!position || position.count === 0) return null;
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  const matrix = mesh.matrixWorld;
  const local = new THREE.Vector3();
  let minY = Infinity;
  let radius = 0;
  const stride = Math.max(1, Math.floor(position.count / 4000));
  for (let i = 0; i < position.count; i += stride) {
    local.fromBufferAttribute(position, i).applyMatrix4(matrix).applyMatrix4(inverse);
    minY = Math.min(minY, local.y);
    radius = Math.max(radius, Math.hypot(local.x, local.z));
  }
  if (!Number.isFinite(minY)) return null;
  return { minY, radius };
}

/** 建一个收口小盖片：盖住丢面后露出的茎端口，颜色取茎的同色系。 */
function buildCap(
  root: THREE.Object3D,
  cutY: number,
  radius: number,
  color: string,
): { mesh: THREE.Mesh; material: THREE.MeshStandardMaterial } {
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.9,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const geometry = new THREE.CircleGeometry(Math.max(0.002, radius), 18);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'organize-trim-cap';
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = cutY;
  root.add(mesh);
  return { mesh, material };
}

function clearLowerTrim(root: THREE.Object3D): LowerStemTrimResult {
  const cache = root.userData[TRIM_TAG] as LowerTrimCache | undefined;
  if (!cache) {
    return { applied: false, reason: 'restored', cutY: 0, minY: 0, trimmedMeshes: 0 };
  }
  for (const data of cache.meshes) {
    data.mesh.geometry = data.source;
    data.working.dispose();
  }
  if (cache.cap) {
    root.remove(cache.cap);
    cache.cap.geometry.dispose();
    cache.capMaterial?.dispose();
  }
  delete root.userData[TRIM_TAG];
  return { applied: false, reason: 'restored', cutY: cache.result.cutY, minY: cache.result.minY, trimmedMeshes: 0 };
}

/**
 * 非 prepared 花材的下部茎裁剪：按余茎长度 `tailLength`（花枝局部坐标 y = -tailLength）
 * 丢掉整段在裁剪面以下的三角形，并在裁剪面加一枚收口盖片；再次调用（或 tailLength
 * 回到不可能裁到几何的区间）会恢复原状。玫瑰/郁金香返回 `prepared`，由
 * `applyPreparation` 处理（那边有独立的 `prepared-tail` 网格）。
 */
export function applyLowerStemTrim(
  root: THREE.Object3D,
  kind: PresentationKind,
  tailLength: number,
  family: string,
): LowerStemTrimResult {
  void kind;
  // 生产状态里 tailLength 由 store 夹在 0.1–0.24，所以这条裁剪路径对当前「没有多余茎尾」
  // 的整枝模型不会触发；下限放小只是让算法本身可以被直接调用验证（见 scripts/v16-organize.mjs）。
  const cutY = -Math.max(0.003, Math.min(0.4, Number.isFinite(tailLength) ? tailLength : 0.22));
  if (PREPARED_FAMILIES.includes(family)) {
    // 玫瑰/郁金香由 applyPreparation 的 prepared-tail 处理，这里不动几何。
    return { applied: false, reason: 'prepared', cutY, minY: 0, trimmedMeshes: 0 };
  }
  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.name.startsWith('prepared-')) return;
    if (mesh.name === 'original-flower-head') return;
    if (mesh.userData.organizeThorn || mesh.name === 'organize-trim-cap') return;
    meshes.push(mesh);
  });
  if (meshes.length === 0) {
    return { applied: false, reason: 'missing-geometry', cutY, minY: 0, trimmedMeshes: 0 };
  }
  let minY = Infinity;
  let stemRadius = 0;
  const frames = new Map<THREE.Mesh, { minY: number; radius: number }>();
  for (const mesh of meshes) {
    const frame = meshFrame(mesh, root);
    if (!frame) continue;
    frames.set(mesh, frame);
    minY = Math.min(minY, frame.minY);
    stemRadius = Math.max(stemRadius, frame.radius);
  }
  if (!Number.isFinite(minY)) {
    return { applied: false, reason: 'missing-geometry', cutY, minY: 0, trimmedMeshes: 0 };
  }
  const surplus = -minY - Math.abs(cutY);
  if (surplus <= 0.004) {
    // 真实资产：整枝模型下端就在握点下方约 2 cm，没有多余茎尾可剪。恢复后返回状态。
    const restored = clearLowerTrim(root);
    return { ...restored, reason: 'no-surplus-stem', cutY, minY };
  }

  const cached = root.userData[TRIM_TAG] as LowerTrimCache | undefined;
  if (cached) {
    // 换一个裁剪面：先恢复再重裁，避免拿裁过的索引继续裁。
    clearLowerTrim(root);
  }
  const trimData: MeshTrimData[] = [];
  let trimmedMeshes = 0;
  let cutRadius = 0;
  for (const mesh of meshes) {
    const frame = frames.get(mesh);
    if (!frame || -frame.minY - Math.abs(cutY) <= 0.004) continue;
    const source = mesh.geometry;
    const working = source.clone();
    const position = working.getAttribute('position');
    root.updateMatrixWorld(true);
    const inverse = root.matrixWorld.clone().invert();
    const matrix = mesh.matrixWorld;
    const index = working.index;
    const ys = new Float32Array(position.count);
    const local = new THREE.Vector3();
    for (let i = 0; i < position.count; i += 1) {
      local.fromBufferAttribute(position, i).applyMatrix4(matrix).applyMatrix4(inverse);
      ys[i] = local.y;
    }
    const kept: number[] = [];
    const count = index?.count ?? position.count;
    for (let i = 0; i < count; i += 3) {
      const a = index ? index.getX(i) : i;
      const b = index ? index.getX(i + 1) : i + 1;
      const c = index ? index.getX(i + 2) : i + 2;
      // 只保留三个顶点都在裁剪面之上的三角形；跨面的三角形一起丢掉，由盖片收口。
      if (ys[a] >= cutY && ys[b] >= cutY && ys[c] >= cutY) kept.push(a, b, c);
    }
    // 收口盖片按「裁剪面附近那圈顶点」估半径，别拿整枝最宽的叶片当茎径。
    for (let i = 0; i < position.count; i += 1) {
      if (Math.abs(ys[i] - cutY) > 0.012) continue;
      const x = position.getX(i);
      const z = position.getZ(i);
      cutRadius = Math.max(cutRadius, Math.hypot(x, z));
    }
    working.setIndex(kept);
    working.computeBoundingSphere();
    mesh.geometry = working;
    trimData.push({ mesh, source, working });
    trimmedMeshes += 1;
  }
  if (trimmedMeshes === 0) {
    return { applied: false, reason: 'no-surplus-stem', cutY, minY, trimmedMeshes: 0 };
  }
  // 盖片颜色取第一个网格材质的颜色（GLB 的茎叶材质），没有就用茎绿兜底。
  let color = '#5f7a4b';
  const first = trimData[0].mesh.material;
  const material = Array.isArray(first) ? first[0] : first;
  if (material instanceof THREE.MeshStandardMaterial) color = `#${material.color.getHexString()}`;
  const cap = buildCap(root, cutY, cutRadius > 0.001 ? cutRadius * 1.08 : stemRadius * 0.35, color);
  const result: LowerStemTrimResult = { applied: true, reason: 'trimmed', cutY, minY, trimmedMeshes };
  root.userData[TRIM_TAG] = { meshes: trimData, cap: cap.mesh, capMaterial: cap.material, result };
  return result;
}

// ---------- 调试与清理 ----------

export function getOrganizeVisualDebug(root: THREE.Object3D): OrganizeVisualDebug {
  const flip = root.userData[FLIP_TAG] as FlipCache | undefined;
  const thorns = root.userData[THORNS_TAG] as ThornsCache | undefined;
  const trim = root.userData[TRIM_TAG] as LowerTrimCache | undefined;
  const head = flip?.heads?.[0];
  return {
    headMeshes: flip?.heads.length ?? 0,
    petalFlip: flip ? Math.max(0, flip.amount) : 0,
    headRadius: head ? head.radius : 0,
    thorns: {
      supported: thorns !== undefined || head !== undefined,
      visible: Boolean(thorns?.visible),
      count: thorns ? thorns.group.children.length : 0,
    },
    lowerTrim: trim
      ? trim.result
      : { applied: false, reason: 'restored', cutY: 0, minY: 0, trimmedMeshes: 0 },
  };
}

/** 删除花枝 / 场景销毁时调用：只释放本模块创建的私有几何与材质。 */
export function disposeOrganizeVisual(root: THREE.Object3D): void {
  const flip = root.userData[FLIP_TAG] as FlipCache | undefined;
  if (flip) {
    for (const head of flip.heads) head.geometry.dispose();
    delete root.userData[FLIP_TAG];
  }
  const thorns = root.userData[THORNS_TAG] as ThornsCache | undefined;
  if (thorns) disposeThorns(root, thorns);
  const trim = root.userData[TRIM_TAG] as LowerTrimCache | undefined;
  if (trim) {
    for (const data of trim.meshes) {
      if (data.mesh.geometry !== data.source) {
        // working 已经挂在 mesh 上，恢复成 source 后释放 working。
        data.mesh.geometry = data.source;
        data.working.dispose();
      }
    }
    if (trim.cap) {
      root.remove(trim.cap);
      trim.cap.geometry.dispose();
      trim.capMaterial?.dispose();
    }
    delete root.userData[TRIM_TAG];
  }
  // 上面这些几何是实例私有克隆；模板共享几何不在其中，不会被误释放。
}
