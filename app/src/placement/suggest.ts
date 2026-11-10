/**
 * 建议位算法：纯几何、纯函数，不依赖 Three.js 与 store。
 *
 * 输入是已放花枝的花头世界坐标 + 待放花材的茎长 / 占用半径，
 * 输出不超过 MAX_SUGGESTIONS 个固定于花束坐标的候选：
 * 姿态（height/tilt/direction）+ 花头世界坐标 + 一句中文理由 + 类型。
 *
 * 设计约束（见 docs/round-plan.md 3.2）：
 * - 结果只由花束几何与待放花材决定，跟相机无关，所以转视角不会跳动；
 * - 调用方只在「放置模式 / 花枝 / 辅助开关」变化时重算，指针事件里只做屏幕距离比较；
 * - 只有两枝花时也给出多个不同可能，宁可给不同方向的不同答案；
 * - 找不到合格位置就返回空数组，不强推。
 */

import {
  GRIP_Y,
  HEIGHT_MAX,
  HEIGHT_MIN,
  MAX_HEAD_RADIUS,
  MAX_SUGGESTIONS,
  MAX_TILT,
} from '../config';
import type { AssetKind, SuggestionCandidate, SuggestionKind, Vec3 } from '../data/types';

const DEG = Math.PI / 180;

/** 默认展示方向的水平前向（相机在右前方，正对花束）。转视角不改理由，所以固定一次。 */
const VIEW_FORWARD_X = 0.617;
const VIEW_FORWARD_Z = 0.786;

/** 花头中心相对握点的竖直位移范围（米）：太低会被包装纸口挡住，太高会散。 */
const HEAD_Y_MIN = 0.19;
const HEAD_Y_MAX = 0.52;

/** 花头之间的最小净空（米）。低于它视为明显穿插，直接丢弃候选。 */
const MIN_HEAD_CLEARANCE = -0.004;

/** 候选方向网格（度）。固定网格让 id 与位置稳定，不随指针或相机漂移。 */
const AZIMUTH_STEP = 15;

export interface PlacedHead {
  id: string;
  kind: AssetKind;
  /** 花头世界坐标（花束坐标）。 */
  head: Vec3;
  /** 花头占用半径（米）。 */
  radius: number;
}

export interface PendingStem {
  assetId: string;
  kind: AssetKind;
  /** 握点到花头中心的茎长（米，含 height 偏移之前的花头高度）。 */
  lever: number;
  /** 花头占用半径（米）。 */
  radius: number;
}

export interface SuggestRequest {
  placed: PlacedHead[];
  pending: PendingStem;
  /** 最多给几个候选，默认 MAX_SUGGESTIONS。 */
  limit?: number;
}

interface ScoredCandidate {
  id: string;
  azimuth: number;
  head: Vec3;
  height: number;
  tilt: number;
  score: number;
  fits: Record<SuggestionKind, number>;
  kind: SuggestionKind;
}

const KIND_ORDER: SuggestionKind[] = ['gap', 'showcase', 'layer'];

/** 相机默认方位角（相对 +Z），用于把候选方向翻译成「右前 / 左侧」这类人话。 */
const CAMERA_AZIMUTH = 38;
const DIRECTION_WORDS = ['正前', '右前', '右侧', '右后', '正后', '左后', '左侧', '左前'];

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function normalizeAngle(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function angularDistance(a: number, b: number): number {
  const diff = Math.abs(normalizeAngle(a - b));
  return diff > 180 ? 360 - diff : diff;
}

function azimuthOf(head: Vec3): number {
  return normalizeAngle((Math.atan2(head[0], head[2]) * 180) / Math.PI);
}

/** 按 0.012 / 0.02 这类最小间隔去重，避免三个候选几乎重叠。 */
function uniqueValues(values: number[], minGap: number): number[] {
  const result: number[] = [];
  for (const value of values) {
    if (result.every((existing) => Math.abs(existing - value) >= minGap)) result.push(value);
  }
  return result;
}

function directionWord(azimuth: number): string {
  const relative = normalizeAngle(azimuth - CAMERA_AZIMUTH);
  return DIRECTION_WORDS[Math.round(relative / 45) % DIRECTION_WORDS.length] ?? '正前';
}

function reasonFor(kind: SuggestionKind, word: string, pending: PendingStem): string {
  if (pending.kind === 'greenery') {
    if (kind === 'layer') return `${word}稍高，叶影更自然`;
    if (kind === 'showcase') return `${word}往外展，轮廓更透气`;
    return `${word}补一片叶，空隙更自然`;
  }
  if (kind === 'layer') return `${word}稍高，层次更清楚`;
  if (kind === 'showcase') return `${word}稍靠前，主花更显眼`;
  return `${word}有空隙，补上更饱满`;
}

interface WeightSet {
  clearance: number;
  gap: number;
  layer: number;
  visibility: number;
  reach: number;
}

const WEIGHTS: Record<'flower' | 'greenery' | 'filler', WeightSet> = {
  flower: { clearance: 0.3, gap: 0.22, layer: 0.2, visibility: 0.24, reach: 0.04 },
  greenery: { clearance: 0.28, gap: 0.3, layer: 0.1, visibility: 0.18, reach: 0.14 },
  filler: { clearance: 0.28, gap: 0.26, layer: 0.16, visibility: 0.22, reach: 0.08 },
};

function weightsFor(kind: AssetKind): WeightSet {
  if (kind === 'greenery') return WEIGHTS.greenery;
  if (kind === 'filler') return WEIGHTS.filler;
  return WEIGHTS.flower;
}

/**
 * 把「方向 + 水平半径 + 花头高度」换算成可落位的姿态。
 * 姿态里 height 是沿茎方向的位移，tilt/direction 决定花头在包络里的位置。
 */
function buildCandidatePose(
  azimuth: number,
  radialTarget: number,
  headYTarget: number,
  pending: PendingStem,
): { head: Vec3; height: number; tilt: number } | null {
  const radial = clamp(radialTarget, 0, MAX_HEAD_RADIUS * 0.98);
  const desiredDy = clamp(headYTarget - GRIP_Y, HEAD_Y_MIN, HEAD_Y_MAX);
  let lever = Math.hypot(radial, desiredDy);
  let height = lever - pending.lever;
  if (height < HEIGHT_MIN) height = HEIGHT_MIN;
  if (height > HEIGHT_MAX) height = HEIGHT_MAX;
  // height 被范围裁过以后，重新按真实茎长算倾斜与花头高度，避免姿态与坐标对不上。
  lever = pending.lever + height;
  if (lever <= radial + 0.02) return null;
  const dy = Math.sqrt(lever * lever - radial * radial);
  if (dy < HEAD_Y_MIN - 0.04) return null;
  const tiltDeg = (Math.acos(clamp(dy / lever, -1, 1)) * 180) / Math.PI;
  if (tiltDeg > MAX_TILT) return null;
  const azimuthRad = azimuth * DEG;
  const head: Vec3 = [
    radial * Math.sin(azimuthRad),
    GRIP_Y + dy,
    radial * Math.cos(azimuthRad),
  ];
  return { head, height, tilt: tiltDeg };
}

function scoreCandidate(
  head: Vec3,
  height: number,
  pending: PendingStem,
  placed: PlacedHead[],
): ScoredCandidate['fits'] & { total: number } {
  const headAzimuth = azimuthOf(head);
  const headRadial = Math.hypot(head[0], head[2]);
  let minClearance = Number.POSITIVE_INFINITY;
  let nearestAngular = 180;
  let layerScore = 0;
  let occlusion = 0;
  let maxNeighborY = -Infinity;
  let minNeighborY = Infinity;

  for (const placedHead of placed) {
    const dx = head[0] - placedHead.head[0];
    const dy = head[1] - placedHead.head[1];
    const dz = head[2] - placedHead.head[2];
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const clearance = distance - placedHead.radius - pending.radius;
    if (clearance < minClearance) minClearance = clearance;
    const angular = angularDistance(headAzimuth, azimuthOf(placedHead.head));
    if (angular < nearestAngular) nearestAngular = angular;
    const dyDiff = Math.abs(dy);
    // 层次：同高会糊成一片，略差一点最好看，差太多像两根独立的花。
    const layerForNeighbor = dyDiff < 0.014 ? 0.14 : dyDiff <= 0.095 ? 1 : 0.52;
    if (layerForNeighbor > layerScore) layerScore = layerForNeighbor;
    if (dy > maxNeighborY) maxNeighborY = dy;
    if (dy < minNeighborY) minNeighborY = dy;
    // 遮挡：邻居如果比候选更靠近默认相机、且横向投影相近，就会挡住候选。
    const depth =
      (placedHead.head[0] - head[0]) * VIEW_FORWARD_X +
      (placedHead.head[2] - head[2]) * VIEW_FORWARD_Z;
    if (depth > 0.005) {
      const lateral =
        (placedHead.head[0] - head[0]) * VIEW_FORWARD_Z -
        (placedHead.head[2] - head[2]) * VIEW_FORWARD_X;
      const spread = Math.max(0.02, placedHead.radius + pending.radius);
      const overlap = 1 - clamp01(Math.abs(lateral) / spread);
      if (overlap > occlusion) occlusion = overlap;
    }
  }

  if (!Number.isFinite(minClearance)) minClearance = 0.2;
  if (!Number.isFinite(maxNeighborY)) maxNeighborY = 0;
  if (!Number.isFinite(minNeighborY)) minNeighborY = 0;

  const clearanceScore = clamp01(minClearance / 0.07);
  const gapScore = clamp01((nearestAngular - 18) / 62);
  const front = clamp(
    (head[0] * VIEW_FORWARD_X + head[2] * VIEW_FORWARD_Z) / Math.max(0.02, headRadial),
    -1,
    1,
  );
  const visibility = clamp01((front + 1) / 2) * (1 - 0.55 * occlusion);
  const radialRatio = clamp01(headRadial / MAX_HEAD_RADIUS);
  const reachPreference = pending.kind === 'greenery' ? 0.88 : 0.74;
  const reachScore = clamp01(1 - Math.abs(radialRatio - reachPreference) / 0.55);
  // 比周围都低的花头容易被纸口和叶片吃掉，轻微惩罚。
  const lowPenalty = height <= HEIGHT_MIN + 0.006 && head[1] < minNeighborY ? 0.75 : 1;

  const weights = weightsFor(pending.kind);
  const total =
    (weights.clearance * clearanceScore +
      weights.gap * gapScore +
      weights.layer * layerScore +
      weights.visibility * visibility +
      weights.reach * reachScore) *
    lowPenalty;

  const gapFit = 0.62 * gapScore + 0.38 * clearanceScore;
  const showcaseFit = 0.72 * visibility + 0.28 * clamp01(1 - Math.abs(radialRatio - 0.62) / 0.6);
  const layerFit =
    0.68 * layerScore +
    0.32 * clamp01(0.5 + (head[1] - GRIP_Y - (maxNeighborY + minNeighborY) / 2) * 6);

  return { total, gap: gapFit, showcase: showcaseFit, layer: layerFit };
}

function classify(fits: Record<SuggestionKind, number>): SuggestionKind {
  let best: SuggestionKind = 'gap';
  let bestValue = -Infinity;
  for (const kind of KIND_ORDER) {
    const value = fits[kind];
    if (value > bestValue + 1e-6) {
      bestValue = value;
      best = kind;
    }
  }
  return best;
}

/**
 * 计算建议位。返回数组顺序即建议优先级，最多 limit 个；没有合格位置返回 []。
 */
export function suggestPlacements(request: SuggestRequest): SuggestionCandidate[] {
  const { placed, pending } = request;
  if (placed.length === 0) return [];
  if (!Number.isFinite(pending.lever) || pending.lever <= 0.05) return [];
  const limit = clamp(Math.floor(request.limit ?? MAX_SUGGESTIONS), 1, MAX_SUGGESTIONS);

  const headYs = placed.map((item) => item.head[1]);
  const radials = placed.map((item) => Math.hypot(item.head[0], item.head[2]));
  const meanY = average(headYs);
  const minY = Math.min(...headYs);
  const maxY = Math.max(...headYs);
  const meanRadial = radials.length > 0 ? average(radials) : 0.18;

  const headYOptions = uniqueValues(
    [
      clamp(minY - 0.035, GRIP_Y + HEAD_Y_MIN, GRIP_Y + HEAD_Y_MAX),
      clamp(meanY + 0.012, GRIP_Y + HEAD_Y_MIN, GRIP_Y + HEAD_Y_MAX),
      clamp(maxY + 0.042, GRIP_Y + HEAD_Y_MIN, GRIP_Y + HEAD_Y_MAX),
    ],
    0.012,
  );
  const radialOptions = uniqueValues(
    [
      clamp(meanRadial * 0.6, 0.07, MAX_HEAD_RADIUS * 0.78),
      clamp(meanRadial * 0.9 + 0.035, 0.11, MAX_HEAD_RADIUS * 0.88),
      clamp(meanRadial + 0.09, 0.15, MAX_HEAD_RADIUS * 0.95),
    ],
    0.02,
  );

  const gridCount = Math.round(360 / AZIMUTH_STEP);
  const scored: ScoredCandidate[] = [];

  for (let azimuthIndex = 0; azimuthIndex < gridCount; azimuthIndex += 1) {
    const azimuth = azimuthIndex * AZIMUTH_STEP;
    for (let radialIndex = 0; radialIndex < radialOptions.length; radialIndex += 1) {
      const radial = radialOptions[radialIndex] ?? 0.2;
      for (let headYIndex = 0; headYIndex < headYOptions.length; headYIndex += 1) {
        const headY = headYOptions[headYIndex] ?? GRIP_Y + 0.3;
        const built = buildCandidatePose(azimuth, radial, headY, pending);
        if (!built) continue;
        const fits = scoreCandidate(built.head, built.height, pending, placed);
        // 明显穿插的花头不进入候选。
        if (fits.total <= 0) continue;
        if (hasHeadCollision(built.head, pending.radius, placed)) continue;
        const kindFits: Record<SuggestionKind, number> = {
          gap: fits.gap,
          showcase: fits.showcase,
          layer: fits.layer,
        };
        scored.push({
          id: `sug-${azimuthIndex}-${radialIndex}-${headYIndex}`,
          azimuth,
          head: built.head,
          height: built.height,
          tilt: built.tilt,
          score: fits.total,
          fits: kindFits,
          kind: classify(kindFits),
        });
      }
    }
  }

  if (scored.length === 0) return [];

  scored.sort((a, b) => b.score - a.score);

  const picked: ScoredCandidate[] = [];
  const isDistinct = (candidate: ScoredCandidate): boolean =>
    picked.every(
      (existing) =>
        angularDistance(existing.azimuth, candidate.azimuth) >= 50 ||
        Math.abs(existing.head[1] - candidate.head[1]) >= 0.05 ||
        Math.abs(Math.hypot(existing.head[0], existing.head[2]) - Math.hypot(candidate.head[0], candidate.head[2])) >=
          0.06,
    );

  // 先按三种类型各挑一个最好的，保证「补空隙 / 强化展示面 / 丰富层次」至少各有一个代表。
  for (const kind of KIND_ORDER) {
    for (const candidate of scored) {
      if (candidate.kind !== kind) continue;
      if (!isDistinct(candidate)) continue;
      picked.push(candidate);
      break;
    }
  }

  // 类型不够三个（例如全都被邻居挡住），用综合分从高到低补满，仍然要求彼此有差异。
  for (const candidate of scored) {
    if (picked.length >= limit) break;
    if (picked.includes(candidate)) continue;
    if (!isDistinct(candidate)) continue;
    picked.push(candidate);
  }

  picked.sort((a, b) => b.score - a.score);

  return picked.slice(0, limit).map((candidate) => {
    const kind = classify(candidate.fits);
    const word = directionWord(candidate.azimuth);
    const pose = {
      height: round(candidate.height, 3),
      tilt: round(candidate.tilt, 2),
      direction: round(normalizeAngle(candidate.azimuth), 1),
    };
    return {
      id: candidate.id,
      pose,
      head: [round(candidate.head[0], 3), round(candidate.head[1], 3), round(candidate.head[2], 3)],
      reason: reasonFor(kind, word, pending),
      kind,
    };
  });
}

function hasHeadCollision(head: Vec3, radius: number, placed: PlacedHead[]): boolean {
  for (const placedHead of placed) {
    const dx = head[0] - placedHead.head[0];
    const dy = head[1] - placedHead.head[1];
    const dz = head[2] - placedHead.head[2];
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance - placedHead.radius - radius < MIN_HEAD_CLEARANCE) return true;
  }
  return false;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
