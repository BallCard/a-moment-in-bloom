/**
 * V0.7.3 §3/§5：花枝包络（碰撞近似的公共口径）。
 *
 * 为什么不继续用「花头一个球心 + 一个半径」：
 * - 玫瑰可见花头是 22 × 13 × 22cm 的扁盘，实心球要么低估横向尺寸（对角线穿模），
 *   要么把花头当成直径 22cm 的球（相邻花头推得太开、整束变散）。
 * - 多头花、长条花、绿叶的形状差异大，一个半径表达不了。
 *
 * 这里用**世界坐标下的椭球**（球是椭球特例）：
 * - 椭球半径与真实朝向一致（花枝局部 y 轴沿枝，水平 x/z 为花头展开方向）；
 * - 支撑函数沿花心连线只做粗筛，不能拿投影相交当作椭球相交。
 *   V0.7.4 改用 Perram–Wertheim 接触函数求径向接触距离与法线，
 *   消除扁花头斜向靠近时的「空气墙」；球仍走解析快路。
 * - 核心椭球（radii × coreScale）严格避让，完整椭球（外缘）允许按花材宽容度
 *   轻微接触：这就是「花头核心不穿、花瓣边缘可以挤一点」。
 *
 * 该模块是纯 TS（不 import three），供 contact.ts（柔性接触）、placement.ts
 * （有效落位）、BouquetScene（把局部包络变换到世界）与验收脚本共用同一口径。
 * 注意：包络重叠 ≠ 花瓣网格穿透深度，验收报告里必须分开表述。
 */

import type { AssetKind, Vec3 } from '../data/types';

/** 单位四元数（xyzw），表示「花枝局部 → 世界」的旋转。 */
export type Quat = [number, number, number, number];

/**
 * 一个包络椭球。`center` / `radii` 的坐标系由调用方决定：
 * - headVolume()/partVolume() 返回**花枝局部**坐标（握点为原点、y 向上）；
 * - BouquetScene 用 transformVolume() 变换成世界坐标后再交给求解器；
 * - 求解器（contact/placement）约定只接收同一坐标系（世界）的包络。
 */
export interface EnvelopeVolume {
  center: Vec3;
  /** 局部半轴长（米）：[x, y, z]。 */
  radii: Vec3;
  /** 局部 → 世界旋转；缺省为单位旋转（局部轴与世界轴一致）。 */
  rotation?: Quat;
  /** 核心椭球比例：核心 = radii × coreScale，外缘 = 完整椭球。 */
  coreScale?: number;
  /** 花头 / 多头花的单个头 / 叶面：只用于报告分类，不影响几何。 */
  part?: 'head' | 'part' | 'foliage';
}

/** 两种花材相碰时允许的穿透（米）：核心严格，外缘留给花瓣/叶片一点柔性。 */
export interface EnvelopeLimits {
  core: number;
  rim: number;
}

/** 默认核心半轴为外缘的 72%（不是体积的 72%）。 */
export const DEFAULT_CORE_SCALE = 0.72;
/** 核心的游戏接触余量 6mm；这是设计容差，不是浮点误差。 */
export const CORE_EPSILON = 0.006;

const KIND_LIMITS: Record<AssetKind, EnvelopeLimits> = {
  // 主花：核心基本不许穿（6mm），外缘花瓣允许 1.8cm 交叠。
  main: { core: CORE_EPSILON, rim: 0.018 },
  // 配花：花头小、常被主花夹着，外缘宽容一点。
  filler: { core: CORE_EPSILON, rim: 0.028 },
  // 绿叶：叶面本来就会互相搭着，外缘放宽，但核心仍不许穿。
  greenery: { core: 0.012, rim: 0.045 },
};

/** 该花材的接触宽容度。 */
export function limitsFor(kind: AssetKind): EnvelopeLimits {
  return { ...KIND_LIMITS[kind] };
}

/** 两个花材相碰时取更严格的一方：主花 vs 绿叶按主花算，不能让叶片把主花顶穿。 */
export function stricterLimits(a: EnvelopeLimits, b: EnvelopeLimits): EnvelopeLimits {
  return { core: Math.min(a.core, b.core), rim: Math.min(a.rim, b.rim) };
}

/** 花头实测盒（花枝局部，已含整枝等比缩放；见 preparation.HeadMetrics）。 */
export interface HeadBox {
  width: number;
  depth: number;
  height: number;
  centerY: number;
  centerX?: number;
  centerZ?: number;
}

const MIN_HALF_AXIS = 0.008;

function clampRadius(value: number): number {
  return Number.isFinite(value) ? Math.max(MIN_HALF_AXIS, value) : MIN_HALF_AXIS;
}

/**
 * 单头花的包络：与真实朝向一致的椭球。
 * 花头局部 y 轴沿枝，x/z 为花头横向展开；默认核心比例 0.72。
 */
export function headVolume(box: HeadBox, scale = 1): EnvelopeVolume {
  return {
    center: [(box.centerX ?? 0) * scale, box.centerY * scale, (box.centerZ ?? 0) * scale],
    radii: [
      clampRadius((box.width / 2) * scale),
      clampRadius((box.height / 2) * scale),
      clampRadius((box.depth / 2) * scale),
    ],
    coreScale: DEFAULT_CORE_SCALE,
    part: 'head',
  };
}

/**
 * 多头花 / 散枝花的单个花头：逐个登记的局部偏移 + 半径（球）。
 * 多头花必须逐个登记，不能用一个包围整枝的大椭球，否则枝间空隙会被当成实心。
 */
export function partVolume(offset: Vec3, radius: number, scale = 1): EnvelopeVolume {
  const r = clampRadius(radius * scale);
  return {
    center: [offset[0] * scale, offset[1] * scale, offset[2] * scale],
    radii: [r, r, r],
    part: 'part',
  };
}

/** 长条花枝（细长花头）用「细长椭球」表达：竖向半轴明显大于横向。 */
export function longVolume(centerY: number, radius: number, halfLength: number, scale = 1): EnvelopeVolume {
  const r = clampRadius(radius * scale);
  const half = clampRadius(halfLength * scale);
  return {
    center: [0, centerY * scale, 0],
    radii: [r, half, r],
    coreScale: DEFAULT_CORE_SCALE,
    part: 'head',
  };
}

// ---------- 四元数 / 向量（纯函数，避免依赖 three） ----------

export function quatNormalize(q: Quat): Quat {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(length > 1e-9)) return [0, 0, 0, 1];
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

/** 用四元数旋转向量：world = q · local · q⁻¹。 */
export function rotateByQuat(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 * (q.xyz × v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** 四元数的逆（单位四元数时就是共轭）：把世界方向转到局部。 */
export function inverseQuat(q: Quat): Quat {
  const n = quatNormalize(q);
  return [-n[0], -n[1], -n[2], n[3]];
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/**
 * 把花枝局部的包络变换到世界：世界中心 = position + R·(center × scale)，
 * 世界旋转 = R，半轴按 scale 缩放。端点（握点）就是 position。
 */
export function transformVolume(
  volume: EnvelopeVolume,
  position: Vec3,
  rotation: Quat,
  scale = 1,
): EnvelopeVolume {
  const q = quatNormalize(rotation);
  const local: Vec3 = [
    volume.center[0] * scale,
    volume.center[1] * scale,
    volume.center[2] * scale,
  ];
  const rotated = rotateByQuat(q, local);
  const own = volume.rotation ? quatNormalize(volume.rotation) : null;
  return {
    center: [position[0] + rotated[0], position[1] + rotated[1], position[2] + rotated[2]],
    radii: [
      clampRadius(volume.radii[0] * scale),
      clampRadius(volume.radii[1] * scale),
      clampRadius(volume.radii[2] * scale),
    ],
    rotation: own ? quatMultiply(q, own) : q,
    coreScale: volume.coreScale,
    part: volume.part,
  };
}

/** 沿世界方向 n 的椭球支撑半径：sqrt(Σ (rᵢ·nᵢˡᵒᶜᵃˡ)²)。 */
export function supportRadius(volume: EnvelopeVolume, direction: Vec3, scaleFactor = 1): number {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(length > 1e-9)) {
    // 方向退化时取最大半轴，宁可保守也不要返回 0。
    const r = Math.max(volume.radii[0], volume.radii[1], volume.radii[2]);
    return r * scaleFactor;
  }
  const n: Vec3 = [direction[0] / length, direction[1] / length, direction[2] / length];
  const local = volume.rotation ? rotateByQuat(inverseQuat(volume.rotation), n) : n;
  return Math.hypot(
    volume.radii[0] * scaleFactor * local[0],
    volume.radii[1] * scaleFactor * local[1],
    volume.radii[2] * scaleFactor * local[2],
  );
}

// Symmetric shape matrix Q = R diag(r²) Rᵀ, stored as xx, yy, zz, xy, xz, yz.
type Shape = [number, number, number, number, number, number];
function shapeOf(volume: EnvelopeVolume, scale = 1): Shape {
  if (!volume.rotation) return [(volume.radii[0]*scale)**2, (volume.radii[1]*scale)**2, (volume.radii[2]*scale)**2, 0, 0, 0];
  const q: Shape = [0, 0, 0, 0, 0, 0];
  const rotation = volume.rotation ? quatNormalize(volume.rotation) : [0, 0, 0, 1] as Quat;
  for (let i = 0; i < 3; i++) {
    const axis: Vec3 = [0, 0, 0];
    axis[i] = 1;
    const [x, y, z] = rotateByQuat(rotation, axis);
    const r2 = (volume.radii[i]! * scale) ** 2;
    q[0] += r2 * x * x; q[1] += r2 * y * y; q[2] += r2 * z * z;
    q[3] += r2 * x * y; q[4] += r2 * x * z; q[5] += r2 * y * z;
  }
  return q;
}

/** Perram–Wertheim contact function, not a projection onto the center line.
 * f(λ) = λ(1−λ) nᵀ [(1−λ)Qa + λQb]⁻¹ n; reach = 1/√max f.
 * Reference/formula: https://sbrisard.github.io/pw85/theory.html (11).
 * This is radial contact distance, NOT minimum mesh penetration depth.
 */
function contactReach(a: Shape, b: Shape, n: Vec3): { reach: number; normal: Vec3 } {
  const diagonal = a[3] === 0 && a[4] === 0 && a[5] === 0 && b[3] === 0 && b[4] === 0 && b[5] === 0;
  const sample = (t: number): { value: number; vector: Vec3 } => {
    const xx = a[0] + (b[0]-a[0])*t, yy = a[1] + (b[1]-a[1])*t, zz = a[2] + (b[2]-a[2])*t;
    if (diagonal) {
      const vector: Vec3 = [n[0]/xx, n[1]/yy, n[2]/zz];
      return { value: t*(1-t)*(n[0]*vector[0]+n[1]*vector[1]+n[2]*vector[2]), vector };
    }
    const xy = a[3] + (b[3]-a[3])*t, xz = a[4] + (b[4]-a[4])*t, yz = a[5] + (b[5]-a[5])*t;
    const c00 = yy * zz - yz * yz, c11 = xx * zz - xz * xz, c22 = xx * yy - xy * xy;
    const c01 = xz * yz - xy * zz, c02 = xy * yz - xz * yy, c12 = xy * xz - xx * yz;
    const determinant = xx * c00 + xy * c01 + xz * c02;
    const vector: Vec3 = [
      (c00 * n[0] + c01 * n[1] + c02 * n[2]) / determinant,
      (c01 * n[0] + c11 * n[1] + c12 * n[2]) / determinant,
      (c02 * n[0] + c12 * n[1] + c22 * n[2]) / determinant,
    ];
    return { value: t * (1 - t) * (n[0] * vector[0] + n[1] * vector[1] + n[2] * vector[2]), vector };
  };
  // Concave one-dimensional maximization, fixed work and deterministic results.
  const golden = (Math.sqrt(5) - 1) / 2;
  let lo = 0, hi = 1, left = 1 - golden, right = golden;
  let l = sample(left), r = sample(right);
  for (let i = 0; i < 22; i++) {
    if (l.value < r.value) {
      lo = left; left = right; l = r; right = lo + golden * (hi - lo); r = sample(right);
    } else {
      hi = right; right = left; r = l; left = hi - golden * (hi - lo); l = sample(left);
    }
  }
  const best = sample((lo + hi) / 2);
  const length = Math.hypot(...best.vector);
  return { reach: 1 / Math.sqrt(best.value), normal: best.vector.map(v => v / length) as Vec3 };
}

/** 两个包络中心的距离与方向（a→b）；重合时方向退化为 +y。 */
function axisBetween(a: EnvelopeVolume, b: EnvelopeVolume): { distance: number; normal: Vec3 } {
  const dx = b.center[0] - a.center[0];
  const dy = b.center[1] - a.center[1];
  const dz = b.center[2] - a.center[2];
  const distance = Math.hypot(dx, dy, dz);
  if (distance < 1e-9) return { distance: 0, normal: [0, 1, 0] };
  return { distance, normal: [dx / distance, dy / distance, dz / distance] };
}

export interface EnvelopeOverlap {
  /** 核心椭球穿透深度（米，≥0）：花头内部是否真的插进去了。 */
  core: number;
  /** 完整椭球（含外缘）穿透深度（米，≥0）：可见轮廓是否叠在一起。 */
  rim: number;
}

const NO_OVERLAP: EnvelopeOverlap = { core: 0, rim: 0 };

/** 椭球实际接触距离及法线；球走解析快路。沿中心连线的投影重叠仅作粗筛。 */
export function contactBetween(a: EnvelopeVolume, b: EnvelopeVolume): EnvelopeOverlap & { normal: Vec3; reach: number } {
  const { distance, normal } = axisBetween(a, b);
  const ka = a.coreScale ?? DEFAULT_CORE_SCALE, kb = b.coreScale ?? DEFAULT_CORE_SCALE;
  const sphere = (v: EnvelopeVolume) => Math.abs(v.radii[0] - v.radii[1]) < 1e-10 && Math.abs(v.radii[0] - v.radii[2]) < 1e-10;
  if (sphere(a) && sphere(b)) {
    const reach = a.radii[0] + b.radii[0];
    return { rim: Math.max(0, reach - distance), core: Math.max(0, a.radii[0] * ka + b.radii[0] * kb - distance), normal, reach };
  }
  const bound = supportRadius(a, normal) + supportRadius(b, normal);
  if (bound <= distance) return { core: 0, rim: 0, normal, reach: bound };
  const hit = contactReach(shapeOf(a), shapeOf(b), normal);
  if (hit.reach <= distance) return { ...NO_OVERLAP, normal: hit.normal, reach: hit.reach };
  const coreReach = Math.abs(ka - kb) < 1e-10 ? hit.reach * ka : contactReach(shapeOf(a, ka), shapeOf(b, kb), normal).reach;
  return { rim: hit.reach - distance, core: Math.max(0, coreReach - distance), normal: hit.normal, reach: hit.reach };
}

/** 径向接触距离差（米）；只对球等于最短穿透，不能当成花瓣网格穿深。 */
export function overlapBetween(a: EnvelopeVolume, b: EnvelopeVolume): EnvelopeOverlap {
  const { core, rim } = contactBetween(a, b);
  return { core, rim };
}

/** 穿透是否在允许范围内（核心严格、外缘按花材宽容度）。 */
export function allowed(overlap: EnvelopeOverlap, limits: EnvelopeLimits): boolean {
  return overlap.core <= limits.core + 1e-9 && overlap.rim <= limits.rim + 1e-9;
}

/** 超过宽容度的净穿透（米）：只对这部分做柔性接触/分离。 */
export function residualOverlap(overlap: EnvelopeOverlap, limits: EnvelopeLimits): EnvelopeOverlap {
  return {
    core: Math.max(0, overlap.core - limits.core),
    rim: Math.max(0, overlap.rim - limits.rim),
  };
}

/** 场景/求解器共用的占用者：一根花枝可以有多个包络（多头花）。 */
export interface EnvelopeOccupant {
  stemId: string | null;
  kind: AssetKind;
  volumes: EnvelopeVolume[];
}

export interface OccupantOverlap extends EnvelopeOverlap {
  valid: boolean;
  /** 重叠最深的另一枝（没有重叠时为 null）。 */
  partnerId: string | null;
}

/**
 * 一个候选包络与场景里所有占用者的最坏重叠。
 * 同一 stemId 的包络之间不互算（它们是一根花枝上的多个头，不是碰撞对象）。
 */
export function overlapWithOccupants(
  volume: EnvelopeVolume,
  kind: AssetKind,
  occupants: EnvelopeOccupant[],
  ownStemId: string | null = null,
): OccupantOverlap {
  const ownLimits = limitsFor(kind);
  let core = 0;
  let rim = 0;
  let partnerId: string | null = null;
  let valid = true;
  for (const occupant of occupants) {
    if (occupant.stemId !== null && occupant.stemId === ownStemId) continue;
    const pairLimits = stricterLimits(ownLimits, limitsFor(occupant.kind));
    // 一根枝可能多个包络（多头花）：逐个比，取最坏。
    for (const other of occupant.volumes) {
      const overlap = overlapBetween(volume, other);
      if (overlap.core > core || overlap.rim > rim) {
        core = Math.max(core, overlap.core);
        rim = Math.max(rim, overlap.rim);
        partnerId = occupant.stemId;
      }
      if (!allowed(overlap, pairLimits)) valid = false;
    }
  }
  return { core, rim, valid, partnerId };
}

/**
 * 一组包络与占用者之间的最坏重叠（用于验收与场景自检）。
 * 返回的 core/rim 是原始穿透深度；valid 已按双方更严格的宽容度判断。
 */
export function worstOverlap(
  volumes: EnvelopeVolume[],
  kind: AssetKind,
  occupants: EnvelopeOccupant[],
  ownStemId: string | null = null,
): OccupantOverlap {
  let core = 0;
  let rim = 0;
  let partnerId: string | null = null;
  let valid = true;
  for (const volume of volumes) {
    const result = overlapWithOccupants(volume, kind, occupants, ownStemId);
    core = Math.max(core, result.core);
    rim = Math.max(rim, result.rim);
    partnerId = partnerId ?? result.partnerId;
    if (!result.valid) valid = false;
  }
  return { core, rim, valid, partnerId };
}

/**
 * 分辨两个包络之间的相对方向（a→b，世界单位向量）。
 * 接触求解用它决定「往哪边让」。
 */
export function separationDirection(a: EnvelopeVolume, b: EnvelopeVolume): Vec3 {
  return contactBetween(a, b).normal;
}

/** 两个包络中心距离（米）。 */
export function centerDistance(a: EnvelopeVolume, b: EnvelopeVolume): number {
  return axisBetween(a, b).distance;
}
