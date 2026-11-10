/**
 * V0.7.3 §3：统一有效落位求解（新增 / 复制 / 拖动 / 精调 / 缩放共用）。
 *
 * 为什么要有它（见 docs/v7-size-contact-diagnosis.md「建议实施顺序 3」）：
 * - 旧的 limitDragDepth 只在指针拖动里生效，而且遇到碰撞就把径向距离乘 0.82，
 *   总是朝花束中心退；中心本来就有花时会把重叠从 49.50% 恶化到 81.44%，
 *   仍然返回结果。它也没有覆盖点击添加、复制、精调、缩放。
 * - 这里改成「路径扫掠 + 表面滑动 + 最近有效位」：沿运动路径逐段检查，碰到阻挡
 *   就停在最后一个**有效**位，再沿接触面（方向 / 高度 / tilt / 径向往外）找仍然
 *   有效且离目标最近的位置——人能贴着一侧滑进去，而不是被一律推回中心。
 * - 对**已经重叠**的旧作品不锁死：没有任何有效位时，允许「最坏重叠不增大」的
 *   移动（不变差即可），绝不返回已知更差的位置。
 * - 新枝没有「上一有效位」，to 又被挡住时，会在可编辑姿态空间里找离目标最近的
 *   有效位（有界网格），而不是把一枝花塞进另一枝里。
 *
 * 纯 TS，不 import three。判定口径全部复用 three/envelope.ts（椭球包络 +
 * 核心/外缘宽容度），保证画面、接触求解与验收脚本是同一套几何：
 * 核心椭球严格避让（主花 6mm 级通融），外缘允许花瓣/叶片小范围交叠。
 */

import { HEIGHT_MAX, HEIGHT_MIN, MAX_TILT, MIN_TILT } from '../config';
import type { AssetKind } from '../data/types';
import type {
  EnvelopeLimits,
  EnvelopeOccupant,
  EnvelopeOverlap,
  EnvelopeVolume,
} from './envelope';
import { limitsFor, worstOverlap } from './envelope';

export type {
  EnvelopeLimits,
  EnvelopeOccupant,
  EnvelopeOverlap,
  EnvelopeVolume,
} from './envelope';

/** 路径扫掠步数：24 步在 0.4m 级的运动上能分辨约 1.7cm 的阻挡区，够挡住快速横穿。 */
export const PLACEMENT_SWEEP_STEPS = 24;

/** 表面滑动的方向候选（度）。 */
export const SLIDE_DIRECTION_DEG = [4, 8, 15, 25] as const;
/** 表面滑动的高度候选（米）。 */
export const SLIDE_HEIGHT_M = [0.01, 0.02, 0.03] as const;
/** 表面滑动的倾斜候选（度）。 */
export const SLIDE_TILT_DEG = [2] as const;
/** 径向往外（同一方向、加大倾斜 + 抬高）的倾斜增量（度）。 */
export const RADIAL_OUTWARD_TILT_DEG = [2, 4, 6] as const;
/** 径向往外的抬高增量（米）。 */
export const RADIAL_OUTWARD_HEIGHT_M = [0, 0.01, 0.02, 0.03] as const;

/** 重叠「变差」的容差（米，0.1mm）：小于它视为原地不动，不当作恶化。 */
export const OVERLAP_TOLERANCE = 1e-4;

/** 「最近有效位」有界搜索的网格（仅在 to 无效且没有可回退姿态时使用）。 */
const NEAREST_DIRECTION_STEP_DEG = 15;
const NEAREST_TILT_STEP_DEG = 5;
const NEAREST_HEIGHT_STEP_M = 0.05;

/** 位姿距离里 1 米高度折算多少「度」：1cm ≈ 1.8°，略优先于 4° 的方向滑动。 */
const HEIGHT_DISTANCE_WEIGHT = 180;

/** 位姿距离的零阈值。 */
const POSE_EPSILON = 1e-6;

/**
 * 落位姿态（只含可编辑的三个自由度）。
 * 与 data/types.ts 的 StemPose 同口径，但不带 spin——spin 不影响花头占位。
 */
export interface PlacementPose {
  /** 与竖直方向的夹角（度）。 */
  tilt: number;
  /** 倾斜方向（度，0 = +Z）。 */
  direction: number;
  /** 沿茎方向的位移（米）。 */
  height: number;
}

/** 场景占用者的别名：直接用 envelope.ts 的 EnvelopeOccupant（世界坐标）。 */
export type Occupant = EnvelopeOccupant;

/** 结果里带上的重叠度量：core/rim 是原始穿透深度，valid 已按宽容度判断。 */
export interface PlacementEvaluation extends EnvelopeOverlap {
  valid: boolean;
}

/** 额外收紧的上限（与花材自身宽容度取更严格者）；两项都可省略。 */
export type PlacementLimits = Partial<EnvelopeLimits>;

/** evaluate 的可选参数：花材种类 + 自身 stemId + 额外上限。 */
export type EvaluateOptions = PlacementLimits & {
  /** 候选花材的种类（决定核心/外缘宽容度），默认 'main'。 */
  kind?: AssetKind;
  /** 候选花枝的 id：占位者里同一枝的包络不参与碰撞，默认 null（新枝）。 */
  ownStemId?: string | null;
};

/** 落位结果的分类。 */
export type PlacementReason =
  /** 目标位姿本身有效，原样落位。 */
  | 'free'
  /** 路径被挡，停在最后一个有效位（没有更近的表面滑动位）。 */
  | 'blocked'
  /** 被挡/被压住，但滑到了仍有效、且比原来更接近（或至少逃出无效位）的位置。 */
  | 'slid'
  /** 停在原地：原本的有效位就是能到的最好结果。 */
  | 'kept'
  /** 没有有效位：返回「最坏重叠不比原姿态差」且离目标最近的位（可能仍重叠）。 */
  | 'no-space';

export interface PlacementResult {
  pose: PlacementPose;
  /** 是否被修正过（结果位姿不等于请求位姿）。 */
  clamped: boolean;
  reason: PlacementReason;
  /** 结果位姿对场景的最坏重叠（原始穿透深度，米；valid 已按宽容度判断）。 */
  overlap: PlacementEvaluation;
  /**
   * 停在扫掠的第几步（1..steps）：被挡在第 k 个样本时，k-1 就是最后有效位。
   * 'free' 时为 steps（扫完都有效），没有扫掠（from 与 to 同位）时为 0。
   * 接线脚本用它区分「顶在路径中途」和「滑开」。
   */
  sampleIndex: number;
  /** 滑动基准位姿：'slid' 时给出从哪滑开，其余情况为 undefined。 */
  slidFrom?: PlacementPose;
  /** 本次求解评估了多少个位姿（性能与可观测性用）。 */
  probes: number;
}

export interface PlacementInput {
  /** 上一有效姿态；没有时按「从目标位姿出发」处理（新枝、复制后的第一落位）。 */
  from: PlacementPose | null;
  /** 本次请求的目标位姿。 */
  to: PlacementPose;
  /** 把姿态换成世界坐标包络（由场景提供：多头花返回多枚）。 */
  build: (pose: PlacementPose) => EnvelopeVolume[];
  /** 场景里已有的占位者（世界坐标包络）。 */
  occupants: EnvelopeOccupant[];
  /** 候选花材种类，默认 'main'。 */
  kind?: AssetKind;
  /** 正在移动的花枝 id；占位者里同一枝的包络跳过，默认 null。 */
  ownStemId?: string | null;
  /** 额外收紧的上限（例如整束验收时临时更严格）。 */
  limits?: PlacementLimits;
  /** 扫掠步数，默认 PLACEMENT_SWEEP_STEPS。 */
  steps?: number;
  /**
   * 高度锁定：把高度固定在 to.height，滑动 / 最近有效位都不许改高度。
   *
   * 指针拖动只有 tilt / direction 两个自由度（场景的 updateDrag 就是这么传的），
   * 而滑动候选里有 ±1/2/3cm 的高度偏移；不锁的话，每次 pointermove 都可能把
   * 结果高度往上/下抬一点，连续拖动会看到花枝慢慢「长高」。
   * 精调 / 缩放 / 新增这些明确要改高度的入口不要开这个开关。
   */
  lockHeight?: boolean;
}

/** 重叠差值：正值表示 a 比 b 更糟。 */
export interface OverlapDelta {
  core: number;
  rim: number;
  /** a 是否比 b 更糟（超过 OVERLAP_TOLERANCE 才算）。 */
  worse: boolean;
}

// ---------- 基础数学 ----------

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** 归一化到 [0, 360)。 */
export function normalizeAngle(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** 两个方向的夹角（度，0–180）。 */
export function angularDistance(a: number, b: number): number {
  const diff = normalizeAngle(a - b);
  return diff > 180 ? 360 - diff : diff;
}

/** 从 from 转到 to 的最短角度增量（度，-180–180）。 */
function shortestAngleDelta(from: number, to: number): number {
  const diff = normalizeAngle(to - from);
  return diff > 180 ? diff - 360 : diff;
}

/**
 * 位姿距离（用于「离目标最近」的排序）：方向与 tilt 按度、高度按 1cm≈1.8° 折算。
 * tilt 在 0.36m 杠杆上 1° 约 0.63cm 横向位移，所以这个权重和几何量级相当。
 */
export function poseDistance(a: PlacementPose, b: PlacementPose): number {
  return (
    angularDistance(a.direction, b.direction) +
    Math.abs(a.tilt - b.tilt) +
    Math.abs(a.height - b.height) * HEIGHT_DISTANCE_WEIGHT
  );
}

/** 按比例插值位姿（direction 走最短弧），并夹到可编辑范围内。 */
export function lerpPose(from: PlacementPose, to: PlacementPose, t: number): PlacementPose {
  const ratio = clamp(Number.isFinite(t) ? t : 0, 0, 1);
  return sanitizePose({
    tilt: from.tilt + (to.tilt - from.tilt) * ratio,
    direction: from.direction + shortestAngleDelta(from.direction, to.direction) * ratio,
    height: from.height + (to.height - from.height) * ratio,
  });
}

/** 把姿态夹到可编辑范围（height / tilt 有上下限，direction 归一化），并挡住 NaN。 */
export function sanitizePose(pose: PlacementPose): PlacementPose {
  return {
    tilt: clamp(Number.isFinite(pose.tilt) ? pose.tilt : 0, MIN_TILT, MAX_TILT),
    direction: normalizeAngle(Number.isFinite(pose.direction) ? pose.direction : 0),
    height: clamp(Number.isFinite(pose.height) ? pose.height : 0, HEIGHT_MIN, HEIGHT_MAX),
  };
}

/**
 * 「不变差」判断：a 的重叠是否比 b 更糟。
 * 用容差而不是严格大于，避免 0.1mm 级的浮点抖动把一次正常拖动判成恶化。
 */
export function overlapDelta(a: EnvelopeOverlap, b: EnvelopeOverlap): OverlapDelta {
  const core = (a.core ?? 0) - (b.core ?? 0);
  const rim = (a.rim ?? 0) - (b.rim ?? 0);
  return {
    core,
    rim,
    worse: core > OVERLAP_TOLERANCE || rim > OVERLAP_TOLERANCE,
  };
}

function normalizeLimits(limits?: PlacementLimits): PlacementLimits {
  if (!limits) return {};
  const core = typeof limits.core === 'number' && Number.isFinite(limits.core) ? limits.core : undefined;
  const rim = typeof limits.rim === 'number' && Number.isFinite(limits.rim) ? limits.rim : undefined;
  return { core, rim };
}

// ---------- 核心判定 ----------

/**
 * 一组候选包络对场景的最坏重叠。
 *
 * 判定口径与 envelope.ts 一致：每对取双方更严格的宽容度（主花 vs 绿叶按主花算），
 * 核心严格、外缘宽容；同一 stemId 的包络不互算（多头花是一根枝）。
 * `options.core/rim` 只用于额外收紧，不会放宽花材自身的宽容度。
 */
export function evaluate(
  volumes: EnvelopeVolume[],
  occupants: EnvelopeOccupant[],
  options: EvaluateOptions = {},
): PlacementEvaluation {
  const kind = options.kind ?? 'main';
  const ownStemId = options.ownStemId ?? null;
  const worst = worstOverlap(volumes, kind, occupants, ownStemId);
  const ownLimits = limitsFor(kind);
  const core = typeof options.core === 'number' && Number.isFinite(options.core)
    ? Math.min(ownLimits.core, options.core)
    : ownLimits.core;
  const rim = typeof options.rim === 'number' && Number.isFinite(options.rim)
    ? Math.min(ownLimits.rim, options.rim)
    : ownLimits.rim;
  return {
    core: worst.core,
    rim: worst.rim,
    valid: worst.valid && worst.core <= core + 1e-9 && worst.rim <= rim + 1e-9,
  };
}

// ---------- 候选位姿 ----------

interface PoseCandidate {
  pose: PlacementPose;
  /** 到目标位姿的位姿距离，用于升序排序（先试最接近目标的偏移）。 */
  distance: number;
}

/**
 * 接触面滑动候选：以 base 为中心，在方向 / 高度 / tilt 上做小偏移（含单轴变化，
 * 即另外两轴取 0），并额外加入「同一方向径向往外」的倾斜 + 抬高组合。
 *
 * 为什么单独加径向往外：花头是绕握点旋转的，两个花头顶住时纯角度（方向 ±4/8/15/25°）
 * 常常原地打转，而「往外让一点」才是真实花束里的让位方式。用 tilt 增大近似——
 * 0.36m 杠杆上 1° 约 0.6cm 横向，2/4/6° 对应约 1/2.5/4cm 外移。
 *
 * 全部候选按离 to 的位姿距离升序返回；只做小偏移是有意的：滑动是「贴着旁边那朵
 * 花让一点」，不是重新找位置——大幅重排属于用户自己的操作。
 */
/** 滑动候选的生成选项：`lockHeight` 时只做方向 / tilt 偏移，不动高度。 */
export interface SlideOptions {
  lockHeight?: boolean;
}

export function surfaceSlideCandidates(
  base: PlacementPose,
  to: PlacementPose,
  options: SlideOptions = {},
): PoseCandidate[] {
  const directionDeltas = [0];
  for (const value of SLIDE_DIRECTION_DEG) directionDeltas.push(value, -value);
  const heightDeltas = [0];
  if (!options.lockHeight) {
    for (const value of SLIDE_HEIGHT_M) heightDeltas.push(value, -value);
  }
  const tiltDeltas = [0];
  for (const value of SLIDE_TILT_DEG) tiltDeltas.push(value, -value);

  const poses: PlacementPose[] = [];
  const seen = new Set<string>();
  const push = (pose: PlacementPose): void => {
    const clean = sanitizePose(pose);
    const key = `${clean.tilt.toFixed(3)}|${clean.direction.toFixed(3)}|${clean.height.toFixed(4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    poses.push(clean);
  };

  for (const direction of directionDeltas) {
    for (const height of heightDeltas) {
      for (const tilt of tiltDeltas) {
        push({
          tilt: base.tilt + tilt,
          direction: base.direction + direction,
          height: base.height + height,
        });
      }
    }
  }
  // 径向往外：方向不变，倾斜与高度一起加（只增不减，沿用用户当前这一侧）。
  // 锁定高度时只加倾斜——只靠倾斜也能把花头往外推，且不会让花枝长高。
  const radialHeights = options.lockHeight ? [0] : RADIAL_OUTWARD_HEIGHT_M;
  for (const tilt of RADIAL_OUTWARD_TILT_DEG) {
    for (const height of radialHeights) {
      push({ tilt: base.tilt + tilt, direction: base.direction, height: base.height + height });
    }
  }

  const candidates = poses.map((pose) => ({ pose, distance: poseDistance(pose, to) }));
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates;
}

// ---------- 求解 ----------

interface ScoredPose {
  pose: PlacementPose;
  overlap: PlacementEvaluation;
  /** 到目标位姿的位姿距离（越小越接近用户想要的位置）。 */
  distance: number;
}

function score(candidate: PoseCandidate, probe: (pose: PlacementPose) => PlacementEvaluation): ScoredPose {
  return {
    pose: candidate.pose,
    overlap: probe(candidate.pose),
    distance: candidate.distance,
  };
}

/** 组装结果：clamped 由「结果位姿是否仍等于目标位姿」推出，避免调用方再算一次。 */
function makeResult(
  scored: ScoredPose,
  to: PlacementPose,
  reason: PlacementReason,
  probes: number,
  sampleIndex: number,
  slidFrom?: PlacementPose,
): PlacementResult {
  return {
    pose: scored.pose,
    clamped: poseDistance(scored.pose, to) > POSE_EPSILON,
    reason,
    overlap: scored.overlap,
    sampleIndex,
    slidFrom,
    probes,
  };
}

/**
 * 沿 from → to 扫掠采样。
 * `stopAtFirstInvalid` 为 true 时遇到第一个无效样本就停（防止快速横穿跳过阻挡区）；
 * 为 false 时全程扫完（用于从「本来就重叠」的姿态里找第一个有效位）。
 */
function sweepPath(
  from: PlacementPose,
  to: PlacementPose,
  steps: number,
  probe: (pose: PlacementPose) => PlacementEvaluation,
  stopAtFirstInvalid: boolean,
): ScoredPose[] {
  const samples: ScoredPose[] = [];
  for (let index = 1; index <= steps; index += 1) {
    const pose = lerpPose(from, to, index / steps);
    const scored = score({ pose, distance: poseDistance(pose, to) }, probe);
    samples.push(scored);
    if (stopAtFirstInvalid && !scored.overlap.valid) break;
  }
  return samples;
}

/** 在「不比参考重叠更糟」的候选里，挑离目标最近的一个（并列时取核心穿透更小的）。 */
function pickNonWorsening(candidates: ScoredPose[], reference: EnvelopeOverlap): ScoredPose | null {
  let best: ScoredPose | null = null;
  for (const candidate of candidates) {
    if (overlapDelta(candidate.overlap, reference).worse) continue;
    if (
      !best ||
      candidate.distance < best.distance - 1e-9 ||
      (Math.abs(candidate.distance - best.distance) <= 1e-9 && candidate.overlap.core < best.overlap.core)
    ) {
      best = candidate;
    }
  }
  return best;
}

interface SlideSearch {
  /** 选中的有效位；base 本身有效且没有更近的滑动位时就是 base。 */
  scored: ScoredPose | null;
  /** true = 赢家是真正的偏移位（'slid'），false = 停在 base（'blocked'）。 */
  usedSlide: boolean;
  /** 已经评估过的滑动候选（无有效位时给「不变差」兜底复用，避免重复计算）。 */
  evaluated: ScoredPose[];
}

/**
 * 从 base 出发找离 to 最近的**有效**滑动位。
 *
 * 候选按离 to 的距离升序，所以第一个有效位就是最近的。base 有效时只需要看比 base
 * 更接近目标的候选（再远不如原地不动）；base 无效时接受任何有效位（先逃出重叠）。
 */
function findSlide(
  base: ScoredPose,
  to: PlacementPose,
  probe: (pose: PlacementPose) => PlacementEvaluation,
  lockHeight = false,
): SlideSearch {
  const evaluated: ScoredPose[] = [];
  const baseValid = base.overlap.valid;
  for (const candidate of surfaceSlideCandidates(base.pose, to, { lockHeight })) {
    if (poseDistance(candidate.pose, base.pose) <= POSE_EPSILON) continue;
    if (baseValid && candidate.distance >= base.distance - 1e-9) break;
    const scored = score(candidate, probe);
    evaluated.push(scored);
    if (scored.overlap.valid) return { scored, usedSlide: true, evaluated };
  }
  return { scored: baseValid ? base : null, usedSlide: false, evaluated };
}

/**
 * 有界的「最近有效位」搜索：在可编辑姿态空间里铺网格（方向 15°、tilt 5°、height 5cm），
 * 按离目标的位姿距离升序找第一个有效位。
 *
 * 只在「请求位姿本身无效、且没有上一有效姿态可回退」时使用（例如新枝点到别人花上）。
 * 20 枝场景里网格约有 1700 个候选，正常情况很快命中，属于点击级的偶发开销。
 */
function findNearestValid(
  reference: ScoredPose,
  to: PlacementPose,
  probe: (pose: PlacementPose) => PlacementEvaluation,
  lockHeight = false,
): ScoredPose | null {
  const candidates: PoseCandidate[] = [];
  const heights: number[] = [];
  if (lockHeight) heights.push(to.height);
  else {
    for (let height = HEIGHT_MIN; height <= HEIGHT_MAX + 1e-9; height += NEAREST_HEIGHT_STEP_M) {
      heights.push(height);
    }
  }
  for (let direction = 0; direction < 360; direction += NEAREST_DIRECTION_STEP_DEG) {
    for (let tilt = MIN_TILT; tilt <= MAX_TILT + 1e-9; tilt += NEAREST_TILT_STEP_DEG) {
      for (const height of heights) {
        const pose = sanitizePose({ tilt, direction, height });
        const distance = poseDistance(pose, to);
        if (distance <= POSE_EPSILON) continue;
        candidates.push({ pose, distance });
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  for (const candidate of candidates) {
    if (candidate.distance <= reference.distance + POSE_EPSILON) continue;
    const scored = score(candidate, probe);
    if (scored.overlap.valid) return scored;
  }
  return null;
}

/**
 * 求一个有效落位。
 *
 * 算法（task-2 规格 + 三种入口）：
 * A. 新枝（`from` 为空）：只判目标位姿；无效时先做局部滑动，仍无效再用有界姿态网格
 *    找离目标最近的有效位。整个可编辑空间都放不下才返回 'no-space' 且 valid=false，
 *    由调用方提示「这里放不下」——绝不把新枝静默塞进别人的花头里。
 * B. 参考姿态有效（正常拖动/精调）：沿 from → to 扫掠 N=24 步，**顺序**检查；遇到
 *    第一个无效样本就停下（不跳过阻挡区，所以快速横穿不会从一朵花穿到另一边），
 *    记下最后一个有效样本；被挡时以它（一个有效样本都没有时用 from）为基准做表面
 *    滑动，按离 to 的距离升序取第一个有效位：比停住处更近 → 'slid'，否则 'blocked'。
 *    一步都走不动就原样返回（'kept'）。
 * C. 参考姿态已重叠（旧作品）：不能被锁死。沿路径找第一个有效样本（优先同时
 *    「不变差」的）；没有就从「不变差且离 to 最近」的采样位做局部滑动；仍然没有就
 *    返回最坏重叠不增大的位（'no-space'），没有更近的就原样返回（'kept'）。
 *
 * 结果一定不会比参考姿态更糟；「无空间」时调用方仍可叠加柔性接触，但不能拿到
 * 一个已知更差的位置。
 */
export function resolvePlacement(input: PlacementInput): PlacementResult {
  const kind = input.kind ?? 'main';
  const ownStemId = input.ownStemId ?? null;
  const steps = clamp(Math.round(input.steps ?? PLACEMENT_SWEEP_STEPS), 1, 240);
  const limits = normalizeLimits(input.limits);
  const lockHeight = input.lockHeight === true;
  const to = sanitizePose(input.to);
  const from = input.from ? sanitizePose(input.from) : { ...to };
  // 锁定高度时把参考姿态的高度也对齐到目标：整条路径与所有候选都只变 tilt / direction，
  // 结果高度恒等于 to.height，连续 pointermove 也就不会把花枝慢慢「抬高」。
  if (lockHeight) from.height = to.height;

  let probes = 0;
  const probe = (pose: PlacementPose): PlacementEvaluation => {
    probes += 1;
    return evaluate(input.build(pose), input.occupants, {
      kind,
      ownStemId,
      core: limits.core,
      rim: limits.rim,
    });
  };

  const fromScored: ScoredPose = {
    pose: from,
    overlap: probe(from),
    distance: poseDistance(from, to),
  };

  // A. 新枝（没有上一有效位）：只判目标位姿；无效时找最近有效位，绝不静默塞进去。
  if (input.from === null) {
    if (fromScored.overlap.valid) {
      return { pose: to, clamped: false, reason: 'free', overlap: fromScored.overlap, sampleIndex: 0, probes };
    }
    const slide = findSlide(fromScored, to, probe, lockHeight);
    if (slide.scored) return makeResult(slide.scored, to, 'slid', probes, 0, fromScored.pose);
    const nearest = findNearestValid(fromScored, to, probe, lockHeight);
    if (nearest) return makeResult(nearest, to, 'slid', probes, 0, fromScored.pose);
    return {
      pose: from,
      clamped: false,
      reason: 'no-space',
      overlap: fromScored.overlap,
      sampleIndex: 0,
      probes,
    };
  }

  // C. 旧作品里这枝本来就重叠：允许沿路径找有效位、或做「不变差」的移动，不锁死。
  if (!fromScored.overlap.valid) {
    if (fromScored.distance <= POSE_EPSILON) {
      const slide = findSlide(fromScored, to, probe, lockHeight);
      if (slide.scored) return makeResult(slide.scored, to, 'slid', probes, 0, fromScored.pose);
      const best = pickNonWorsening([fromScored, ...slide.evaluated], fromScored.overlap) ?? fromScored;
      const reason: PlacementReason = best.distance <= POSE_EPSILON ? 'kept' : 'no-space';
      return makeResult(best, to, reason, probes, 0);
    }

    const sweep = sweepPath(from, to, steps, probe, false);
    const validAlongPath = sweep.filter((sample) => sample.overlap.valid);
    if (validAlongPath.length > 0) {
      // 优先「不变差」的有效位；没有就退到路径上第一个有效位（仍比原来的重叠好）。
      const pick =
        validAlongPath.find((sample) => !overlapDelta(sample.overlap, fromScored.overlap).worse) ??
        (validAlongPath[0] as ScoredPose);
      return makeResult(pick, to, 'slid', probes, 0, fromScored.pose);
    }

    // 路径上没有有效位：从「不变差且最近」的采样位做局部滑动，尽量让重叠下降。
    const seed = pickNonWorsening([fromScored, ...sweep], fromScored.overlap) ?? fromScored;
    const slide = findSlide(seed, to, probe, lockHeight);
    if (slide.scored) return makeResult(slide.scored, to, 'slid', probes, 0, seed.pose);
    const best =
      pickNonWorsening([seed, fromScored, ...sweep, ...slide.evaluated], fromScored.overlap) ?? fromScored;
    const reason: PlacementReason = best.distance <= POSE_EPSILON ? 'kept' : 'no-space';
    return makeResult(best, to, reason, probes, 0);
  }

  // B. 参考姿态有效：没有路径时直接成功；有路径就扫掠 + 表面滑动。
  if (fromScored.distance <= POSE_EPSILON) {
    return { pose: to, clamped: false, reason: 'free', overlap: fromScored.overlap, sampleIndex: 0, probes };
  }

  const sweep = sweepPath(from, to, steps, probe, true);
  const blocked = sweep.length > 0 && !(sweep[sweep.length - 1] as ScoredPose).overlap.valid;
  if (!blocked) {
    // 一路都有效：目标位姿有效，原样落位。
    const last = sweep[sweep.length - 1] as ScoredPose;
    return { pose: to, clamped: false, reason: 'free', overlap: last.overlap, sampleIndex: steps, probes };
  }

  // 被挡：最后有效位 = 倒数第二个样本；一个有效样本都没有时用参考姿态。
  const stopped = sweep.length >= 2 ? (sweep[sweep.length - 2] as ScoredPose) : null;
  let base = stopped ?? fromScored;
  const baseIndex = stopped ? sweep.length - 2 : 0;

  // 粗扫掠只定位阻挡区间，再二分贴近真正的边界。
  // 直接停在前一个 1/24 样本会随鼠标步长留出毫米到厘米级的空气缝。
  let blockedPose = (sweep[sweep.length - 1] as ScoredPose).pose;
  for (let i = 0; i < 10; i++) {
    const pose = lerpPose(base.pose, blockedPose, 0.5);
    const candidate = score({ pose, distance: poseDistance(pose, to) }, probe);
    if (candidate.overlap.valid) base = candidate;
    else blockedPose = pose;
  }

  // 从停住处沿接触面滑动，取离目标最近的有效位。
  const slide = findSlide(base, to, probe, lockHeight);
  if (slide.scored) {
    const reason: PlacementReason = slide.usedSlide ? 'slid' : 'blocked';
    return makeResult(slide.scored, to, reason, probes, baseIndex, slide.usedSlide ? base.pose : undefined);
  }
  // 参考姿态有效但被完全挡住：停在原地，至少不比现在差。
  return makeResult(fromScored, to, 'kept', probes, baseIndex);
}
