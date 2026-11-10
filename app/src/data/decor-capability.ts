/**
 * 包装能力表（V16 §5）。
 *
 * 一个呈现形态「实际支持什么」只在这里声明，界面、三维显示、点击编辑、
 * 包装流程与委托检查都读同一张表，避免出现「有控件但模型没有效果」。
 *
 * 现状核对（2026-11-10）：
 * - 纸包：独立丝带是真实几何，颜色可编辑；
 * - 花礼盒 GLB 自带固定颜色的缎带蝴蝶结，未做独立编辑前不显示换色，也不叠加新蝴蝶结；
 * - 花篮/花袋/抱抱桶/木条花箱/陶罐/花瓶没有可靠的系结点，暂不显示丝带操作；
 * - 插饰依赖花泥/花间缝隙，所有形态都可插；灯串与串饰需要可绕行的花束/包装轮廓，
 *   目前只在纸包上做；
 * - 吊牌需要可挂的收口或提手，纸包与花礼盒（放盒沿）先支持。
 */

import type { OrnamentKind } from './types';
import type { PresentationKind } from './presentation';

export interface DecorCapability {
  /** 是否显示可编辑丝带（颜色/移除）。 */
  ribbon: boolean;
  /** 该形态实际支持的装饰款式。 */
  ornaments: OrnamentKind[];
  /** 给界面的一句说明；空串表示不需要额外提示。 */
  note: string;
}

const PICKS: OrnamentKind[] = ['butterfly', 'star-pick', 'heart-pick'];

export const DECOR_CAPABILITIES: Record<PresentationKind, DecorCapability> = {
  paper: {
    ribbon: true,
    ornaments: [
      'light-string',
      'star-lights',
      'pearl-strand',
      'silk-thread',
      ...PICKS,
      'bow',
      'tag',
    ],
    note: '',
  },
  vase: {
    ribbon: false,
    ornaments: [...PICKS],
    note: '透明花瓶保留可见枝条，不塞花泥；插饰可以放在花间。',
  },
  pot: {
    ribbon: false,
    ornaments: [...PICKS],
    note: '陶罐没有可靠系结点，这一形态只提供插饰。',
  },
  basket: {
    ribbon: false,
    ornaments: [...PICKS],
    note: '花篮自带编织提手，暂不叠丝带；插饰可固定在花泥上。',
  },
  box: {
    ribbon: false,
    ornaments: [...PICKS, 'tag'],
    note: '礼盒自带的缎带是模型的一部分，不在这里换色；可以加插饰和吊牌。',
  },
  bucket: {
    ribbon: false,
    ornaments: [...PICKS],
    note: '抱抱桶口沿较窄，只提供插饰。',
  },
  bag: {
    ribbon: false,
    ornaments: [...PICKS],
    note: '纸袋提手不适合系丝带，只提供插饰。',
  },
  crate: {
    ribbon: false,
    ornaments: [...PICKS],
    note: '木条花箱外侧没有系结点，只提供插饰。',
  },
};

export function decorCapability(kind: PresentationKind): DecorCapability {
  return DECOR_CAPABILITIES[kind] ?? DECOR_CAPABILITIES.paper;
}

/** 该形态是否显示可编辑丝带。 */
export function supportsRibbon(kind: PresentationKind): boolean {
  return decorCapability(kind).ribbon;
}

/** 该形态实际支持的装饰款式（按组排序后的顺序与 ORNAMENT_KINDS 一致）。 */
export function ornamentKindsFor(kind: PresentationKind): OrnamentKind[] {
  return decorCapability(kind).ornaments;
}

/** 换容器后过滤掉不适用的装饰，避免遗留悬空装饰。 */
export function filterOrnamentsFor<T extends { kind: OrnamentKind }>(
  ornaments: T[],
  kind: PresentationKind,
): T[] {
  const allowed = new Set(ornamentKindsFor(kind));
  return ornaments.filter((item) => allowed.has(item.kind));
}

/** 适用花泥的容器（宽口浅器 / 有内腔、花泥能挡住内部枝条的形态）。 */
export const FOAM_KINDS: PresentationKind[] = ['basket', 'box', 'bucket', 'bag', 'crate'];

/** 透明花瓶保留自然可见枝条，不塞花泥；纸包不是容器。 */
export function supportsFoam(kind: PresentationKind): boolean {
  return FOAM_KINDS.includes(kind);
}
