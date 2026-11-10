/**
 * V0.7.3 §4：轻量柔性接触（多椭球包络版）。
 *
 * 不是物理模拟，而是一层确定性的「接触形变」：用与真实朝向一致的简化包络
 * 算重叠，外缘一接触便收拢花头（≤12%）；超过落位余量的旧重叠才追加
 * 枝条偏转（≤5°）、正在拖动的那枝沿接触面让一点位置（≤2.5cm），
 * 再加一层按整枝聚合的位置分离（≤6cm）。花枝本身的基础姿态、尺寸和作品文档
 * 都不被改写，所以反复拖动不会越挤越小，撤销也只记一次。
 *
 * 为什么不用逐顶点碰撞：20 枝 × 5 万面的模型在浏览器里跑实时碰撞不现实，
 * 而且这一轮的目标是「看着不互相穿过」，不是真实揉纸（见计划 §9）。
 *
 * V0.7.3 改动（诊断 §3）：
 * - 从「每枝一个球心 + 半径」换成 `EnvelopeVolume`（椭球，可带朝向与核心比例），
 *   一枝多包络（多头花、散枝）逐个参与，不再用一个包围整枝的大球。
 * - V0.7.4：合法柔性区内就产生压缩，但不产生整枝偏转/平移。
 *   旧版等超过 placement 上限才开始形变，使正常拖动永远无法触发挤压。
 *   residualOverlap 仍只用于超限后的分离补救和报告。
 * - 位置分离按 stemId 聚合后夹到 6cm：旧版按花头逐对写回、后一个覆盖前一个，
 *   多头花只解到最后一个头；现在同一枝所有包络的位移求和。
 *
 * V0.7.1 修正保留（用户验收反馈「花抽搐」）：求解器只给出**目标**，真正的形变
 * 由场景里的临界阻尼弹簧积分（见下），所以接触目标突变时是「被推弯」而不是
 * 「瞬移」；偏转从「每帧取最大的一对」改为**按向量叠加**，多枝同时挤压时
 * 方向是合力，不会在两对接触之间来回翻符号。
 */

import type { AssetKind, Vec3 } from '../data/types';
import {
  type EnvelopeLimits,
  type EnvelopeOverlap,
  type EnvelopeVolume,
  centerDistance,
  contactBetween,
  limitsFor,
  residualOverlap as netOverlap,
  stricterLimits,
} from './envelope';

/** 接触方向上的最大压缩比例。 */
export const CONTACT_SQUASH_MAX = 0.12;
/** 枝条附加偏转上限（弧度，5°）。 */
export const CONTACT_DEFLECT_MAX = (5 * Math.PI) / 180;
/** 主动操作的花枝最多让出多少位置（米），避免整束漂移。 */
export const CONTACT_PUSH_MAX = 0.025;
/** 周围花枝的响应权重：只让一点点，主体仍由被操作的花枝承担。 */
export const CONTACT_NEIGHBOR_WEIGHT = 0.45;

/**
 * 位置分离（V0.7.2 引入，V0.7.3 改为按枝聚合）：光靠「收拢花头 + 绕握点偏转」
 * 补不掉几厘米级的重叠，所以对重叠的包络对做几轮位置松弛，真的把花头沿接触面
 * 推开——像真花束里花头互相挤着让位。分离量是叠加层，同样不写文档。
 *
 * 每枝总分离量上限 6cm：足够化解一两枝的推挤，又不会让整束被挤散。
 */
export const CONTACT_SEPARATION_MAX = 0.06;
/** 位置松弛轮数：多轮让密集区域也能收敛（每轮 O(n²)，20 枝可忽略）。 */
export const CONTACT_SEPARATION_ITERATIONS = 4;
/** 拖动时允许的最大重叠比例：再往里推就"顶住"，不再让这一枝继续深入。 */
export const CONTACT_DRAG_DEPTH_LIMIT = 0.35;

/**
 * 弹簧角频率（rad/s）。挤入时偏硬（约 0.2 s 到位），恢复时偏软（约 0.4 s），
 * 读起来像「花枝被压弯 → 松手自己弹回来」，不会一帧一个样。
 */
export const CONTACT_SPRING_IN = 16;
export const CONTACT_SPRING_OUT = 8;

/**
 * 参与接触求解的一根花枝：包络是**世界坐标**（场景用
 * envelope.transformVolume 把花枝局部包络变换到世界后再传进来）。
 * 一根枝可以有多个包络（多头花、散枝），它们作为同一根刚体共同求解。
 */
export interface ContactStem {
  stemId: string;
  kind: AssetKind;
  volumes: EnvelopeVolume[];
}

export interface ContactResult {
  /** 花头在 axis 方向上收拢的比例（0–0.12）。 */
  squash: number;
  /** 世界坐标下的接触方向（从本花头指向撞到的那一头）。 */
  axis: Vec3;
  /** 枝条偏转角度（弧度，0–5°，方向见 bendAxis）。 */
  deflect: number;
  /** 世界坐标下的偏转旋转轴（单位向量，水平方向）。 */
  bendAxis: Vec3;
  /** 位置让步（米，世界坐标，只给正在操作的花枝，≤2.5cm）。 */
  offset: Vec3;
  /**
   * 位置分离（米，世界坐标，≤6cm）：把重叠的花头真正推开，
   * 和 offset 一样是叠加层，不写文档。
   */
  separation: Vec3;
}

const ZERO: ContactResult = {
  squash: 0,
  axis: [0, 1, 0],
  deflect: 0,
  bendAxis: [0, 0, -1],
  offset: [0, 0, 0],
  separation: [0, 0, 0],
};

export const NO_CONTACT: ContactResult = ZERO;

const ZERO_VEC: Vec3 = [0, 0, 0];

/** 椭球的最大半轴：只用于粗筛（球心距 ≥ 两边最大半轴之和时必然不相交）。 */
function maxRadius(volume: EnvelopeVolume): number {
  return Math.max(volume.radii[0], volume.radii[1], volume.radii[2]);
}

/**
 * 接触法线对应的「让花头往旁边倒」的旋转轴：Y × normal。
 * 法线接近竖直（一朵花在另一朵正上方）时叉积退化，退到固定的水平轴，
 * 保证结果有确定方向而不是突然没有偏转。
 */
function bendAxisFor(normal: Vec3): Vec3 {
  const x = normal[2];
  const z = -normal[0];
  const length = Math.hypot(x, z);
  if (length < 1e-4) return [0, 0, -1];
  return [x / length, 0, z / length];
}

function scaleVec(vec: Vec3, k: number): Vec3 {
  return [vec[0] * k, vec[1] * k, vec[2] * k];
}

function addVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function lengthOf(vec: Vec3): number {
  return Math.hypot(vec[0], vec[1], vec[2]);
}

/**
 * 一对接触的原始重叠与净穿透分开返回：原始量驱动花头收拢，
 * 扣掉宽容度的净穿透才驱动整枝分离，避免把合法接触的花推开。
 */
function effectivePenetration(
  a: EnvelopeVolume,
  b: EnvelopeVolume,
  limits: EnvelopeLimits,
): { overlap: EnvelopeOverlap; net: EnvelopeOverlap; effective: number; distance: number; normal: Vec3; reach: number } | null {
  const distance = centerDistance(a, b);
  // 粗筛：椭球最大半轴之和是保守上界，能省掉绝大多数远处的对。
  if (distance >= maxRadius(a) + maxRadius(b)) return null;
  const overlap = contactBetween(a, b);
  if (!(overlap.rim > 0)) return null;
  const net = netOverlap(overlap, limits);
  const effective = Math.max(net.core, net.rim);
  // 外缘一接触就收拢；净穿透只用于超限后的位移补救。
  // 不能等到超过 placement 的硬上限才开始动画，否则合法拖动永远没有挤压。
  return { overlap, net, effective, distance, normal: overlap.normal, reach: overlap.reach };
}

interface Accumulator {
  squash: number;
  axis: Vec3;
  /** 世界坐标弯曲向量（旋转轴 × 角度），多对接触按向量叠加。 */
  bend: Vec3;
  offset: Vec3;
  /** 按整枝聚合后的位置分离（单独求解，见 solveSeparations）。 */
  separation: Vec3;
}

/**
 * 算一帧的接触形变目标。
 *
 * `activeStemId` 是当前被拖动/选中的花枝：它承担位置让步与全部偏转；
 * 周围花枝只做小幅收拢与偏转，不会整体被推走。
 *
 * 返回的是**目标值**：场景每帧用临界阻尼弹簧向它收敛，突变的接触目标
 * 会被弹簧吸收成一段平滑的形变，而不是一帧内跳到新姿态。
 */
export function solveContacts(
  stems: readonly ContactStem[],
  activeStemId: string | null,
): Map<string, ContactResult> {
  const acc = new Map<string, Accumulator>();

  const accumulate = (
    stemId: string,
    squash: number,
    axis: Vec3,
    bendContribution: Vec3,
    offset: Vec3,
  ): void => {
    const current = acc.get(stemId);
    if (!current) {
      acc.set(stemId, {
        squash,
        axis,
        bend: [bendContribution[0], bendContribution[1], bendContribution[2]],
        offset: [offset[0], offset[1], offset[2]],
        separation: [0, 0, 0],
      });
      return;
    }
    if (squash > current.squash) {
      current.squash = squash;
      current.axis = axis;
    }
    current.bend = addVec(current.bend, bendContribution);
    current.offset = addVec(current.offset, offset);
  };

  const visible = stems.filter((stem) => stem.volumes.length > 0);

  for (let i = 0; i < visible.length; i += 1) {
    const a = visible[i]!;
    for (let j = i + 1; j < visible.length; j += 1) {
      const b = visible[j]!;
      // 同一枝的多个包络（多头花）之间不互算，它们是同一个刚体。
      if (a.stemId === b.stemId) continue;
      const pairLimits = stricterLimits(limitsFor(a.kind), limitsFor(b.kind));
      const weightA = a.stemId === activeStemId ? 1 : CONTACT_NEIGHBOR_WEIGHT;
      const weightB = b.stemId === activeStemId ? 1 : CONTACT_NEIGHBOR_WEIGHT;

      for (const va of a.volumes) {
        for (const vb of b.volumes) {
          const hit = effectivePenetration(va, vb, pairLimits);
          if (!hit) continue;
          const normal = hit.normal;
          // 接触方向上的可达距离 ≈ 两边支撑半径之和 = 球心距 + 外缘穿深。
          const reach = Math.max(1e-5, hit.reach);
          // 允许的收拢上限按接触方向尺寸算：挤入越来越难，到上限后不再继续缩。
          const cap = CONTACT_SQUASH_MAX * reach;
          const t = Math.min(1, hit.effective / cap);
          // 留少量花瓣交搭，不把整朵花收缩到刚好分开而产生空气缝。
          const squash = Math.min(CONTACT_SQUASH_MAX, 0.85 * hit.overlap.rim / reach);
          const bendAxis = bendAxisFor(normal);
          const bendA = -CONTACT_DEFLECT_MAX * t * weightA;
          const bendB = CONTACT_DEFLECT_MAX * t * weightB;

          accumulate(a.stemId, squash, normal, scaleVec(bendAxis, bendA), ZERO_VEC);
          accumulate(
            b.stemId,
            squash,
            scaleVec(normal, -1),
            scaleVec(bendAxis, bendB),
            ZERO_VEC,
          );

          // 超过压缩上限的净穿透才转成位置让步，且只给正在操作的那枝。
          const excess = hit.effective - cap;
          if (excess > 0) {
            const push = Math.min(excess, CONTACT_PUSH_MAX);
            if (a.stemId === activeStemId) {
              accumulate(a.stemId, 0, normal, ZERO_VEC, scaleVec(normal, -push));
            } else if (b.stemId === activeStemId) {
              accumulate(b.stemId, 0, normal, ZERO_VEC, scaleVec(normal, push));
            }
          }
        }
      }
    }
  }

  // 位置分离目标和压缩/偏转一起给场景，由弹簧平滑后叠加到画面上。
  const separations = solveSeparations(visible, activeStemId);
  for (const [stemId, separation] of separations) {
    const current = acc.get(stemId);
    if (!current) {
      acc.set(stemId, {
        squash: 0,
        axis: [0, 1, 0],
        bend: [0, 0, 0],
        offset: [0, 0, 0],
        separation,
      });
      continue;
    }
    current.separation = separation;
  }

  const result = new Map<string, ContactResult>();
  for (const [stemId, value] of acc) {
    const bendLength = lengthOf(value.bend);
    const clampedLength = Math.min(bendLength, CONTACT_DEFLECT_MAX);
    const bendAxis: Vec3 =
      bendLength > 1e-6 ? scaleVec(value.bend, 1 / bendLength) : [0, 0, -1];
    result.set(stemId, {
      squash: value.squash,
      axis: value.axis,
      deflect: clampedLength,
      bendAxis,
      offset: value.offset,
      separation: separations.get(stemId) ?? ZERO_VEC,
    });
  }
  return result;
}

interface VirtualVolume {
  stemId: string;
  kind: AssetKind;
  /** 虚拟位置的包络（中心会被松弛推动，不改调用方数据）。 */
  volume: EnvelopeVolume;
  /** 该包络从初始位置累计移动了多少（世界坐标）。 */
  moved: Vec3;
}

function shifted(volume: EnvelopeVolume, offset: Vec3): EnvelopeVolume {
  return {
    ...volume,
    center: [
      volume.center[0] + offset[0],
      volume.center[1] + offset[1],
      volume.center[2] + offset[2],
    ],
  };
}

/**
 * 位置分离目标（V0.7.3：按整枝聚合）。
 *
 * 结构上不能只靠收拢/偏转：花头半径 10cm 级时，重叠常常是 5–20cm，
 * 而压缩 + 偏转只补得动 2–4cm。这里在**虚拟位置**上做几轮松弛，
 * 把净穿透按权重分摊到两枝（正在拖的那枝让得多），得到每枝的分离量目标。
 * 虚拟位置不写回文档，所以反复拖动也不会越推越散。
 *
 * 关键修复：同一枝的多个包络（多头花）各自都会算出位移，旧版按花头逐对写回
 * 导致后者覆盖前者；这里把同一枝所有包络的位移**求和**后夹到 6cm 再写回。
 */
function solveSeparations(
  stems: ContactStem[],
  activeStemId: string | null,
): Map<string, Vec3> {
  const separation = new Map<string, Vec3>();
  const virtual: VirtualVolume[] = [];
  for (const stem of stems) {
    for (const volume of stem.volumes) {
      virtual.push({
        stemId: stem.stemId,
        kind: stem.kind,
        volume: { ...volume, center: [volume.center[0], volume.center[1], volume.center[2]] },
        moved: [0, 0, 0],
      });
    }
  }
  if (virtual.length < 2) return separation;

  for (let iteration = 0; iteration < CONTACT_SEPARATION_ITERATIONS; iteration += 1) {
    for (let i = 0; i < virtual.length; i += 1) {
      const a = virtual[i]!;
      for (let j = i + 1; j < virtual.length; j += 1) {
        const b = virtual[j]!;
        // 同一枝的多个包络不互算（它们是同一个刚体）。
        if (a.stemId === b.stemId) continue;
        const pairLimits = stricterLimits(limitsFor(a.kind), limitsFor(b.kind));
        const hit = effectivePenetration(a.volume, b.volume, pairLimits);
        if (!hit || hit.effective <= 0) continue;
        const normal = hit.normal;
        // 每轮只解一半，几轮下来收敛但不至于一帧弹开。
        const step = Math.min(hit.effective, 0.05) * 0.5;
        const activeA = a.stemId === activeStemId;
        const activeB = b.stemId === activeStemId;
        const weightA = activeA ? 0.68 : activeB ? 0.32 : 0.5;
        const weightB = 1 - weightA;
        const moveA = scaleVec(normal, -step * weightA);
        const moveB = scaleVec(normal, step * weightB);
        a.volume = shifted(a.volume, moveA);
        b.volume = shifted(b.volume, moveB);
        a.moved = addVec(a.moved, moveA);
        b.moved = addVec(b.moved, moveB);
      }
    }
  }

  // 按 stemId 聚合：同一枝所有包络的位移求和，再整体夹到 6cm。
  const byStem = new Map<string, Vec3>();
  for (const item of virtual) {
    if (lengthOf(item.moved) < 1e-9) continue;
    byStem.set(item.stemId, addVec(byStem.get(item.stemId) ?? ZERO_VEC, item.moved));
  }
  for (const [stemId, sum] of byStem) {
    const length = lengthOf(sum);
    if (length < 1e-5) continue;
    const k = length > CONTACT_SEPARATION_MAX ? CONTACT_SEPARATION_MAX / length : 1;
    separation.set(stemId, scaleVec(sum, k));
  }
  return separation;
}

/**
 * 当前包络的残余净重叠（米）：core = 最坏核心净穿透，rim = 最坏外缘净穿透。
 *
 * 供场景自检与验收脚本查询**同一口径**的残余量（包络重叠 ≠ 花瓣网格穿模，
 * 报告里必须分开表述）。同一枝上的包络之间不算；宽容度内的搭叠是 0。
 */
export function residualOverlap(stems: readonly ContactStem[]): EnvelopeOverlap {
  let core = 0;
  let rim = 0;
  const visible = stems.filter((stem) => stem.volumes.length > 0);
  for (let i = 0; i < visible.length; i += 1) {
    const a = visible[i]!;
    for (let j = i + 1; j < visible.length; j += 1) {
      const b = visible[j]!;
      if (a.stemId === b.stemId) continue;
      const pairLimits = stricterLimits(limitsFor(a.kind), limitsFor(b.kind));
      for (const va of a.volumes) {
        for (const vb of b.volumes) {
          const hit = effectivePenetration(va, vb, pairLimits);
          if (!hit) continue;
          if (hit.net.core > core) core = hit.net.core;
          if (hit.net.rim > rim) rim = hit.net.rim;
        }
      }
    }
  }
  return { core, rim };
}

/**
 * 临界阻尼弹簧的单步精确解。
 *
 * 对 x'' = ω²(target - x) - 2ωx' 解析积分，任意 dt 都稳定（不会因为掉帧炸掉），
 * 且**不会过冲**：形变到位后停住，不会自己来回抖。
 */
export function criticallyDampedStep(
  value: number,
  velocity: number,
  target: number,
  omega: number,
  dt: number,
): [number, number] {
  const decay = Math.exp(-omega * dt);
  const delta = value - target;
  const slope = velocity + omega * delta;
  return [target + (delta + slope * dt) * decay, (velocity - omega * slope * dt) * decay];
}

/** 位置让步总量要再夹一次，避免密集区域累加出明显漂移。 */
export function clampOffset(offset: Vec3): Vec3 {
  const length = Math.hypot(offset[0], offset[1], offset[2]);
  if (length <= CONTACT_PUSH_MAX) return offset;
  const k = CONTACT_PUSH_MAX / length;
  return [offset[0] * k, offset[1] * k, offset[2] * k];
}
