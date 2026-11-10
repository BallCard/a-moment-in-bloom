/**
 * 整理能力与一键整理规则（V16 §3）。
 *
 * 原则：
 * - 只显示这枝花 / 这只容器**实际支持**的操作，不出现「点了没变化」的假按钮；
 * - 翻瓣是风格选择，独立于「一键整理」，整束整理不自动翻瓣；
 * - 一键与手动得到同一种可保存状态（都写 stem.preparation）；
 * - 一键整理保留玩家刻意保留的外露叶片与花头位置，只处理影响容器适配的部分。
 */

import type { Preparation, PresentationKind } from './presentation';
import type { AssetKind } from './types';

/** 可翻瓣花材：经过验证、外圈花瓣能实际外翻的少数款式（先只放玫瑰族）。 */
export const FLIP_FAMILIES: string[] = ['rose'];

/** 可去刺花材：模型有茎段结构的玫瑰族（不对整族按名字无条件开放）。 */
export const THORN_FAMILIES: string[] = ['rose'];

/** 能分离花头/叶片、支持逐叶修剪的花材（与 three/assets/preparation.ts 一致）。 */
export const PREPARED_FAMILIES: string[] = ['rose', 'tulip'];

/** 翻瓣程度分三档，手动逐档推进时每次 +1/3，一键直接到 1。 */
export const PETAL_FLIP_STEPS = [0, 1 / 3, 2 / 3, 1] as const;

/** 花材整理能力。 */
export interface FlowerOrganizeCapability {
  flip: boolean;
  thorns: boolean;
  /**
   * 可剪短余茎：真实 GLB 里只有玫瑰/郁金香有独立茎尾（prepared-tail，握点下 22 cm），
   * 其它花材整枝单网格、茎下端只到握点下方约 2 cm，没有可剪的多余茎段。
   * 因此这里按「实际支持」收敛，避免出现点了没有变化的假剪短按钮。
   */
  trimTail: boolean;
  /** 可逐叶修剪（只有能分离叶片的款式）。 */
  trimLeaves: boolean;
}

export function flowerOrganizeCapability(family: string): FlowerOrganizeCapability {
  const prepared = PREPARED_FAMILIES.includes(family);
  return {
    flip: FLIP_FAMILIES.includes(family),
    thorns: THORN_FAMILIES.includes(family),
    trimTail: prepared,
    trimLeaves: prepared,
  };
}

/** 适用花泥的容器见 data/decor-capability.ts 的 FOAM_KINDS / supportsFoam。 */

/**
 * 一键整理的作用范围（给界面讲清楚「会动哪些、不会动哪些」）。
 * 花泥由容器自己承担，这里只描述花枝。
 */
export interface OrganizeScope {
  tail: boolean;
  leaves: boolean;
  thorns: boolean;
  flip: boolean;
}

export function organizeScope(hasStems: boolean): OrganizeScope {
  return {
    tail: hasStems,
    // 只整理「影响容器适配」的下部叶；外露叶与花头位置保持。
    leaves: true,
    thorns: hasStems,
    // 翻瓣始终独立，不包含在整束整理里。
    flip: false,
  };
}

export interface OrganizeTarget {
  /** 当前呈现形态下，整理后保留的余茎长度（米）。 */
  tailLength: number;
  /** 是否去掉最下一片叶（只影响下部枝叶，不动外露叶）。 */
  removeLowLeaf: boolean;
  /** 是否给适用花材去刺。 */
  removeThorns: boolean;
}

/**
 * 一键整理对单枝的目标状态。
 * 纸包：保留较长余茎（手绑花束的握点下方留一截）；容器：贴容器内腔。
 */
export function organizeTarget(
  kind: PresentationKind,
  vesselTailLength: number,
  capability: FlowerOrganizeCapability,
): OrganizeTarget {
  const tail = kind === 'paper' ? 0.16 : vesselTailLength;
  return {
    tailLength: Math.max(0.1, Math.min(0.24, tail)),
    removeLowLeaf: capability.trimLeaves,
    removeThorns: capability.thorns,
  };
}

/** 单枝是否已经被整理过（一键状态可与手动修剪区分）。 */
export function isOrganized(prep: Preparation, target: OrganizeTarget): boolean {
  if (Math.abs(prep.tailLength - target.tailLength) > 0.005) return false;
  if (target.removeLowLeaf && !prep.removedLeaves.includes(0)) return false;
  if (target.removeThorns && prep.thornsRemoved !== true) return false;
  return prep.autoTrim === true;
}

/** 界面文案用：这枝花支持哪些整理动作。 */
export function flowerOrganizeSummary(kind: AssetKind, capability: FlowerOrganizeCapability): string {
  const parts: string[] = [];
  if (capability.flip) parts.push('翻瓣');
  if (capability.thorns) parts.push('去刺');
  if (capability.trimTail) parts.push('修枝');
  if (capability.trimLeaves) parts.push('修叶');
  if (parts.length === 0) return kind === 'greenery' ? '叶材暂不支持整理' : '这枝暂不支持整理';
  return parts.join(' · ');
}
