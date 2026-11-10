/**
 * 辅助装饰（V16 §5）。
 *
 * 只放数据与规则，不依赖 Three.js：
 * - 款式定义（分组、名称、说明、默认参数、可调范围）；
 * - 颜色预设；
 * - 每种呈现方式**实际支持**的装饰与丝带能力（scene / UI / 委托检查共用同一张表）。
 *
 * 取舍见 docs/flower-workflow-upgrade-plan.md §5：没有可靠挂点/系结处的容器
 * 不显示丝带与系结控件，避免出现「有按钮但模型没有对应效果」。
 */

import type { OrnamentInstance, OrnamentKind, Vec3 } from './types';

export type OrnamentGroup = 'lights' | 'strands' | 'picks' | 'ties';

export const ORNAMENT_GROUP_LABEL: Record<OrnamentGroup, string> = {
  lights: '灯串',
  strands: '串饰',
  picks: '插饰',
  ties: '系结与吊饰',
};

export const ORNAMENT_GROUP_HINT: Record<OrnamentGroup, string> = {
  lights: '沿花束或包装绕一圈，点亮轮廓',
  strands: '珍珠或细线垂挂下来，走动时会轻轻晃',
  picks: '插在花与花之间，随手就能挪',
  ties: '只在有合适位置时出现',
};

export interface OrnamentDef {
  kind: OrnamentKind;
  group: OrnamentGroup;
  label: string;
  /** 一句说明，界面直接用。 */
  note: string;
  /** 参数默认值。 */
  scale: number;
  intensity: number;
  variant: number;
  /** 可调范围。 */
  scaleRange: [number, number];
  /** 灯饰才有亮度；其余不给这个控件。 */
  dimmable: boolean;
  /** 可摆放的样式说明（variant 的含义）。 */
  variants: string[];
  /** 同一作品里最多几个。 */
  max: number;
}

export const ORNAMENT_DEFS: Record<OrnamentKind, OrnamentDef> = {
  'light-string': {
    kind: 'light-string',
    group: 'lights',
    label: '细灯串',
    note: '一串很小的暖光，绕在花束外圈',
    scale: 1,
    intensity: 0.72,
    variant: 0,
    scaleRange: [0.75, 1.3],
    dimmable: true,
    variants: ['绕一圈', '斜挂', '只绕一半'],
    max: 2,
  },
  'star-lights': {
    kind: 'star-lights',
    group: 'lights',
    label: '星星灯',
    note: '带小星罩的灯串，光点更明显',
    scale: 1,
    intensity: 0.8,
    variant: 0,
    scaleRange: [0.75, 1.3],
    dimmable: true,
    variants: ['绕一圈', '斜挂', '只绕一半'],
    max: 2,
  },
  'pearl-strand': {
    kind: 'pearl-strand',
    group: 'strands',
    label: '珍珠串',
    note: '沿包装垂下来的一串小珍珠',
    scale: 1,
    intensity: 1,
    variant: 0,
    scaleRange: [0.8, 1.25],
    dimmable: false,
    variants: ['垂在正面', '垂在侧面', '绕口沿'],
    max: 2,
  },
  'silk-thread': {
    kind: 'silk-thread',
    group: 'strands',
    label: '装饰细线',
    note: '很细的一条丝线，不抢花',
    scale: 1,
    intensity: 1,
    variant: 0,
    scaleRange: [0.8, 1.25],
    dimmable: false,
    variants: ['垂在正面', '垂在侧面', '绕口沿'],
    max: 2,
  },
  butterfly: {
    kind: 'butterfly',
    group: 'picks',
    label: '蝴蝶插饰',
    note: '停在花间的小蝴蝶，可挪可转',
    scale: 1,
    intensity: 1,
    variant: 0,
    scaleRange: [0.7, 1.3],
    dimmable: false,
    variants: ['停在花间'],
    max: 3,
  },
  'star-pick': {
    kind: 'star-pick',
    group: 'picks',
    label: '星形插饰',
    note: '一颗小星星，插在缝隙里',
    scale: 1,
    intensity: 1,
    variant: 0,
    scaleRange: [0.7, 1.3],
    dimmable: false,
    variants: ['插在花间'],
    max: 3,
  },
  'heart-pick': {
    kind: 'heart-pick',
    group: 'picks',
    label: '爱心插饰',
    note: '小小的爱心，适合送人的花',
    scale: 1,
    intensity: 1,
    variant: 0,
    scaleRange: [0.7, 1.3],
    dimmable: false,
    variants: ['插在花间'],
    max: 3,
  },
  bow: {
    kind: 'bow',
    group: 'ties',
    label: '蝴蝶结',
    note: '系在收口处的一枚小蝴蝶结',
    scale: 1,
    intensity: 1,
    variant: 0,
    scaleRange: [0.8, 1.2],
    dimmable: false,
    variants: ['系在收口'],
    max: 1,
  },
  tag: {
    kind: 'tag',
    group: 'ties',
    label: '吊牌',
    note: '一张空白小吊牌，挂上去就好',
    scale: 1,
    intensity: 1,
    variant: 0,
    scaleRange: [0.8, 1.2],
    dimmable: false,
    variants: ['挂在正面', '挂在侧面'],
    max: 1,
  },
};

export const ORNAMENT_KINDS = Object.keys(ORNAMENT_DEFS) as OrnamentKind[];

export interface OrnamentColor {
  id: string;
  label: string;
  color: string;
}

/** 装饰颜色预设（跟随手作调色盘的低饱和色）。 */
export const ORNAMENT_COLORS: OrnamentColor[] = [
  { id: 'warm', label: '暖金', color: '#e8c47a' },
  { id: 'rose', label: '玫瑰粉', color: '#dfa0b0' },
  { id: 'ivory', label: '象牙白', color: '#f0e4d2' },
  { id: 'sage', label: '灰绿', color: '#9fb096' },
  { id: 'mist', label: '雾蓝', color: '#a8bcc8' },
  { id: 'wine', label: '酒红', color: '#a05c5f' },
];

export function ornamentColor(id: string): OrnamentColor {
  return ORNAMENT_COLORS.find((item) => item.id === id) ?? ORNAMENT_COLORS[0];
}

export function isOrnamentKind(value: unknown): value is OrnamentKind {
  return typeof value === 'string' && (ORNAMENT_KINDS as string[]).includes(value);
}

export function ornamentDef(kind: OrnamentKind): OrnamentDef {
  return ORNAMENT_DEFS[kind];
}

/** 新建装饰实例的默认参数（位置由 store 按当前花束尺寸给一个可用的初始点）。 */
export function newOrnament(
  kind: OrnamentKind,
  position: Vec3,
  fallbackColor = 'warm',
): OrnamentInstance {
  const def = ORNAMENT_DEFS[kind];
  const color =
    kind === 'light-string' || kind === 'star-lights'
      ? 'warm'
      : kind === 'pearl-strand'
        ? 'ivory'
        : fallbackColor;
  return {
    id: `orn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    kind,
    colorId: ornamentColor(color).id,
    position: [position[0], position[1], position[2]],
    rotation: 0,
    scale: def.scale,
    intensity: def.intensity,
    variant: def.variant,
  };
}
