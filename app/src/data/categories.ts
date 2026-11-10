/**
 * 商品类目式花材分类（V16 §2）。
 *
 * 设计口径（见 docs/flower-workflow-upgrade-plan.md §2）：
 * - 主目录按「花店商品类目」浏览，而不是只有花名列表：玫瑰、多头玫瑰、郁金香、
 *   百合、康乃馨、菊类、绣球、洋桔梗、兰花、其他鲜花、草花/配花、叶材，共 12 类；
 * - **不加入产地 / 进口 / 价格**等来源属性，这些不是本游戏的决策信息；
 * - 类目的作用只是「浏览入口」，不改变花材本身可承担的角色；同一种花可以按需要
 *   当主花、陪衬或线条用，所以 `note` 一律写成「可以怎样用」而不是硬性配方；
 * - 需要新增类目时：同时在 `CATEGORIES` 里加类目、在 `CATEGORY_GROUPS` 的对应组里
 *   挂上它的 id，并把花科补进 `families`。程序头部有 `assertCategoriesCovered`
 *   思路的纯函数 `unmappedFamilies` 供验收脚本/数据自检使用。
 *
 * 本文件是纯数据 + 纯函数，不依赖 Three.js 与 React。
 */

import type { AssetKind } from './types';

/** 类目归组：紧凑入口按「主花 / 配花 / 叶材」三组展开。 */
export type CategoryGroupId = 'main' | 'filler' | 'greenery';

export type CategoryId =
  | 'rose'
  | 'spray-rose'
  | 'tulip'
  | 'lily'
  | 'carnation'
  | 'chrysanthemum'
  | 'hydrangea'
  | 'lisianthus'
  | 'orchid'
  | 'other-flowers'
  | 'filler-mix'
  | 'greenery';

export interface FlowerCategory {
  id: CategoryId;
  label: string;
  group: CategoryGroupId;
  /** 一句「这类花通常拿来做什么」，界面与引导直接用，不当硬性规则。 */
  note: string;
  /** 该类目下的花科（family）清单，顺序即花材架里的显示顺序。 */
  families: readonly string[];
}

/**
 * 12 个初始类目。
 *
 * 花科与 `data/builtin.ts` 的 family 一致；这里不写显示名，显示名以目录为准，
 * 避免同一种花在两个地方出现不同名字。
 */
export const CATEGORIES: readonly FlowerCategory[] = [
  {
    id: 'rose',
    label: '玫瑰',
    group: 'main',
    note: '最常用来定调的主花，也可以单枝当焦点',
    families: ['rose'],
  },
  {
    id: 'spray-rose',
    label: '多头玫瑰',
    group: 'main',
    note: '一枝多朵，可以当主花，也能填补边缘',
    families: ['spray'],
  },
  {
    id: 'tulip',
    label: '郁金香',
    group: 'main',
    note: '线条干净，适合两三枝成组做主花',
    families: ['tulip'],
  },
  {
    id: 'lily',
    label: '百合',
    group: 'main',
    note: '花头大、有存在感，适合当视觉重点',
    families: ['lily'],
  },
  {
    id: 'carnation',
    label: '康乃馨',
    group: 'main',
    note: '耐看的圆顶花，做主角或陪衬都行',
    families: ['carnation'],
  },
  {
    id: 'chrysanthemum',
    label: '菊类',
    group: 'main',
    note: '平展的花盘与多头小菊，适合铺开层次',
    families: ['daisy', 'spray-chrysanthemum'],
  },
  {
    id: 'hydrangea',
    label: '绣球',
    group: 'main',
    note: '一团就能占住画面，适合当大块面',
    families: ['hydrangea'],
  },
  {
    id: 'lisianthus',
    label: '洋桔梗',
    group: 'main',
    note: '叠瓣的杯形花，可当主花也可填缝',
    families: ['lisianthus'],
  },
  {
    id: 'orchid',
    label: '兰花',
    group: 'main',
    note: '形态独特，一两枝就有造型感',
    families: ['orchid'],
  },
  {
    id: 'other-flowers',
    label: '其他鲜花',
    group: 'main',
    note: '牡丹、向日葵、马蹄莲这类有自己形状的鲜花',
    families: ['peony', 'herbaceous-peony', 'sunflower', 'dahlia', 'calla', 'alstroemeria'],
  },
  {
    id: 'filler-mix',
    label: '草花/配花',
    group: 'filler',
    note: '细碎小花与花穗，用来补空、加层次、拉线条',
    families: ['babys-breath', 'statice', 'waxflower', 'rice-flower', 'veronica', 'snapdragon'],
  },
  {
    id: 'greenery',
    label: '叶材',
    group: 'greenery',
    note: '衬托花头、组织轮廓，也决定整束的松紧',
    families: [
      'eucalyptus',
      'ruscus',
      'salal',
      'asparagus-fern',
      'leatherleaf',
      'boston-fern',
      'ivy',
      'fatsia',
      'aspidistra',
      'bear-grass',
    ],
  },
];

export interface CategoryGroup {
  id: CategoryGroupId;
  label: string;
  /** 组的一句话说明，紧凑入口展开时显示。 */
  note: string;
  categories: readonly CategoryId[];
}

/**
 * 紧凑入口的三组。组只用于导航，不等于花材角色：
 * 「其他鲜花」类目里的花同样可能被当配花用，界面不锁死用途。
 */
export const CATEGORY_GROUPS: readonly CategoryGroup[] = [
  {
    id: 'main',
    label: '主花',
    note: '先挑喜欢的花，确定这束花的感觉',
    categories: ['rose', 'spray-rose', 'tulip', 'lily', 'carnation', 'chrysanthemum', 'hydrangea', 'lisianthus', 'orchid', 'other-flowers'],
  },
  {
    id: 'filler',
    label: '配花',
    note: '补空、加层次、把主花托起来',
    categories: ['filler-mix'],
  },
  {
    id: 'greenery',
    label: '叶材',
    note: '衬托花头，组织整束的轮廓',
    categories: ['greenery'],
  },
];

const CATEGORY_BY_ID: Record<CategoryId, FlowerCategory> = Object.fromEntries(
  CATEGORIES.map((category) => [category.id, category]),
) as Record<CategoryId, FlowerCategory>;

/** family → 类目；同一花科只归一个类目。 */
const FAMILY_CATEGORY: Record<string, CategoryId> = (() => {
  const map: Record<string, CategoryId> = {};
  for (const category of CATEGORIES) {
    for (const family of category.families) map[family] = category.id;
  }
  return map;
})();

/** 花科所在的类目。未知花科按角色兜底，保证筛选时不会「消失」。 */
export function categoryOf(family: string, kind?: AssetKind): CategoryId {
  const known = FAMILY_CATEGORY[family];
  if (known) return known;
  if (kind === 'greenery') return 'greenery';
  if (kind === 'filler') return 'filler-mix';
  return 'other-flowers';
}

/** 该类目下的花科清单（副本，调用方可以随意排序）。 */
export function flowersInCategory(category: CategoryId): readonly string[] {
  return CATEGORY_BY_ID[category]?.families ?? [];
}

/** 类目中文名。 */
export function categoryLabel(category: CategoryId): string {
  return CATEGORY_BY_ID[category]?.label ?? '其他鲜花';
}

/** 某个归组下的类目（紧凑入口展开时按这个顺序出 chip）。 */
export function categoriesInGroup(group: CategoryGroupId): FlowerCategory[] {
  const entry = CATEGORY_GROUPS.find((item) => item.id === group);
  if (!entry) return [];
  return entry.categories.map((id) => CATEGORY_BY_ID[id]).filter(Boolean);
}

/** 类目对应的归组（主花 / 配花 / 叶材），用于入口高亮与引导。 */
export function categoryGroupOf(category: CategoryId): CategoryGroupId {
  return CATEGORY_BY_ID[category]?.group ?? 'main';
}

/**
 * 数据自检：目录里出现了、但没有被任何类目收进去的花科。
 * 正常情况下应为空；验收脚本也会用它断言「避免空类目 / 不漏花材」。
 */
export function unmappedFamilies(families: readonly string[]): string[] {
  return families.filter((family) => !FAMILY_CATEGORY[family]);
}

/**
 * 数据自检：每个类目实际能命中多少花科（传入当前目录的花科列表）。
 * 空类目意味着类目入口点进去什么都没有，属于数据错误。
 */
export function categoryCounts(
  families: readonly string[],
): { category: CategoryId; label: string; count: number }[] {
  return CATEGORIES.map((category) => ({
    category: category.id,
    label: category.label,
    count: families.filter((family) => categoryOf(family) === category.id).length,
  }));
}
