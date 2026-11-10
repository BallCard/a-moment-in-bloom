/** 包装纸 / 丝带预设与卡片默认值。纯数据，不依赖 Three.js。 */

import {
  CARD_FROM_MAX,
  CARD_MESSAGE_MAX,
  CARD_TO_MAX,
  PAPER_OPEN_SCALE_MAX,
  PAPER_OPEN_SCALE_MIN,
} from '../config';
import type {
  CardState,
  PackageStep,
  PaperId,
  RibbonColorId,
  RibbonState,
  WrappingState,
} from './types';

export interface PaperPreset {
  label: string;
  /** 纸面主色。 */
  outer: string;
  /** 内折面 / 阴影面颜色。 */
  inner: string;
}

export const PAPER_PRESETS: Record<PaperId, PaperPreset> = {
  // V13：暖白纸原来在米白台面和窗边背景下几乎融成一片，稍微压深一点，
  // 让包装的折线与纸口在浅色环境里也有轮廓（仍保持柔和的暖白调）。
  ivory: { label: '暖白', outer: '#dcc09c', inner: '#b08a5f' },
  kraft: { label: '牛皮', outer: '#bb9368', inner: '#9a7751' },
  sage: { label: '灰绿', outer: '#9fae95', inner: '#7c8b74' },
  mist: { label: '雾蓝', outer: '#a9bcc4', inner: '#7f949d' },
  clay: { label: '豆沙', outer: '#c9a79c', inner: '#a88379' },
  wine: { label: '酒红', outer: '#9d5f60', inner: '#7c4849' },
};

export interface RibbonPreset {
  label: string;
  color: string;
}

export const RIBBON_PRESETS: Record<RibbonColorId, RibbonPreset> = {
  rose: { label: '玫瑰', color: '#d98da0' },
  cream: { label: '奶油', color: '#e9d4b8' },
  sage: { label: '灰绿', color: '#8ba37b' },
  champagne: { label: '香槟', color: '#e5c79b' },
  mist: { label: '雾蓝', color: '#9fb7c1' },
  clay: { label: '豆沙', color: '#c79b93' },
};

export const PAPER_IDS: PaperId[] = ['ivory', 'kraft', 'sage', 'mist', 'clay', 'wine'];
export const RIBBON_COLOR_IDS: RibbonColorId[] = ['rose', 'cream', 'sage', 'champagne', 'mist', 'clay'];
/** 包装步骤的固定顺序，供 UI / 场景判断前进后退。 */
export const PACKAGE_STEPS: PackageStep[] = ['paper', 'fold', 'ribbon', 'card'];

export const DEFAULT_WRAPPING: WrappingState = {
  enabled: false,
  paperId: 'ivory',
  step: 'paper',
  openScale: 1,
};
export const DEFAULT_RIBBON: RibbonState = { colorId: 'rose' };
export const DEFAULT_CARD: CardState = { to: '', message: '', from: '' };

export function isPaperId(value: unknown): value is PaperId {
  return PAPER_IDS.includes(value as PaperId);
}

export function isRibbonColorId(value: unknown): value is RibbonColorId {
  return RIBBON_COLOR_IDS.includes(value as RibbonColorId);
}

export function isPackageStep(value: unknown): value is PackageStep {
  return value === 'paper' || value === 'fold' || value === 'ribbon' || value === 'card';
}

/** 摆纸开口大小的夹紧（0.85–1.12）；非有限数回落到 1。 */
export function clampOpenScale(scale: number): number {
  const value = Number.isFinite(scale) ? scale : 1;
  return Math.min(PAPER_OPEN_SCALE_MAX, Math.max(PAPER_OPEN_SCALE_MIN, value));
}

/**
 * 旧存档（v1/v2）补分步包装字段的默认值：
 * 已包装的作品视为做到丝带一步，未包装的停在摆纸。
 */
export function defaultPackageStep(enabled: boolean): PackageStep {
  return enabled ? 'ribbon' : 'paper';
}

/** 按 Unicode 字符截断，中文一个字符算一个。 */
export function clampText(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join('') : value;
}

export function cardLimits(): Record<keyof CardState, number> {
  return { to: CARD_TO_MAX, message: CARD_MESSAGE_MAX, from: CARD_FROM_MAX };
}
