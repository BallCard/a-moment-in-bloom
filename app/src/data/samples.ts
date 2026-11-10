/**
 * V0.7 §3：固定的 6 / 12 / 20 枝验收样束，以及比例校准用的地址栏参数。
 *
 * 这些样束是**游戏验收配方**，不是统一花艺规则：主花／配花／绿叶固定为
 * 3/2/1、5/4/3、8/7/5，方便在同样包装参数下比较花头比例。
 */

import { GRIP_Y, MAX_HEAD_RADIUS, MAX_TILT } from '../config';
import { createStem } from './document';
import type { AssetKind, RuntimeCatalog, StemInstance, ViewPreset } from './types';
import { HEAD_SCALE_MAX, HEAD_SCALE_MIN, isSizeCandidateId, type SizeCandidateId } from './size';

export type SampleSize = 6 | 12 | 20;

export interface SampleRecipe {
  main: number;
  filler: number;
  greenery: number;
}

/** 计划 §3 指定的固定配方：主花／配花／绿叶。 */
export const SAMPLE_RECIPES: Record<SampleSize, SampleRecipe> = {
  6: { main: 3, filler: 2, greenery: 1 },
  12: { main: 5, filler: 4, greenery: 3 },
  20: { main: 8, filler: 7, greenery: 5 },
};

/** 样束里的代表花材；颜色只取一种，避免把配色差异当成比例差异。 */
export const SAMPLE_ASSETS: Record<AssetKind, string> = {
  main: 'rose-pink',
  filler: 'spray-rose-pink',
  greenery: 'eucalyptus-green',
};

/** 各层的摆放规格：径向占比区间、高度区间（米）与倾斜放大。 */
const LAYER_SPEC: Record<
  AssetKind,
  { radius: [number, number]; height: [number, number]; tiltBias: number }
> = {
  // 主花：内圈偏高、外圈略低，形成中间高起的层次。
  main: { radius: [0.1, 0.56], height: [0.06, 0.11], tiltBias: 1 },
  // 配花：插在主花之间，放低一点并多打开一些，避免顶到最上面聚成一团。
  filler: { radius: [0.44, 0.8], height: [-0.01, 0.03], tiltBias: 1.35 },
  // 绿叶：最外圈、最低、最外倾，负责托住整束的轮廓。
  greenery: { radius: [0.7, 1], height: [-0.05, -0.01], tiltBias: 1.2 },
};

/** 可用摆放半径：留一点余量，避免样束顶到拖动上限。 */
const USABLE_RADIUS = MAX_HEAD_RADIUS * 0.82;

/** 确定性伪随机：同样的样束每次生成完全一致，截图才能前后对照。 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function headLever(catalog: RuntimeCatalog, assetId: string): number {
  const entry = catalog.entriesById[assetId];
  const base = entry?.transform?.headOffsetY ?? 0.36;
  // V0.7.3：枝长按尺寸候选缩短后，花头中心跟着往握点收；
  // 样束配方按「实际杠杆」反解倾角，同一半径下花头才不会挤到一处。
  return base * (entry?.size?.stemFactor ?? 1);
}

function toKindRecipe(size: SampleSize): { kind: AssetKind; index: number; count: number }[] {
  const recipe = SAMPLE_RECIPES[size];
  return [
    { kind: 'greenery', index: 0, count: recipe.greenery },
    { kind: 'filler', index: 0, count: recipe.filler },
    { kind: 'main', index: 0, count: recipe.main },
  ];
}

/**
 * 生成一份样束花枝。位置用姿态表达：花头水平半径由倾斜角换算，
 * 越靠外的层越向外打开、整体略低，形成有高低错落的层次。
 */
export function buildSampleStems(catalog: RuntimeCatalog, size: SampleSize): StemInstance[] {
  const random = seeded(size * 7919 + 17);
  const stems: StemInstance[] = [];
  for (const tier of toKindRecipe(size)) {
    if (tier.count <= 0) continue;
    const spec = LAYER_SPEC[tier.kind];
    const [minFrac, maxFrac] = spec.radius;
    const assetId = SAMPLE_ASSETS[tier.kind];
    const lever = headLever(catalog, assetId);
    for (let i = 0; i < tier.count; i += 1) {
      const frac =
        tier.count === 1 ? (minFrac + maxFrac) / 2 : minFrac + ((maxFrac - minFrac) * i) / (tier.count - 1);
      const radius = frac * USABLE_RADIUS;
      // 高度：层内按序微调 + 一点确定性抖动，避免同层花头排成一圈等高。
      const layerT = tier.count === 1 ? 0.5 : i / (tier.count - 1);
      const height =
        spec.height[1] + (spec.height[0] - spec.height[1]) * layerT + (random() - 0.5) * 0.016;
      // 姿态的 height 会一起影响花头水平位移，先按含高度的杠杆反解角度。
      const tilt = Math.min(
        MAX_TILT,
        ((Math.asin(Math.min(1, radius / Math.max(0.05, lever + height))) * 180) / Math.PI) *
          spec.tiltBias,
      );
      const direction = (360 / tier.count) * i + random() * 26 + (tier.kind === 'main' ? 0 : 47);
      stems.push(
        createStem({
          assetId,
          position: [0, GRIP_Y, 0],
          pose: {
            height: Number(height.toFixed(4)),
            tilt: Number(tilt.toFixed(2)),
            direction: Number(direction.toFixed(2)),
            spin: Number((random() * 360).toFixed(1)),
          },
        }),
      );
    }
  }
  return stems;
}

/** 样束的包装参数固定下来，比例对照才只差花头。 */
export const SAMPLE_WRAPPING = {
  enabled: true,
  paperId: 'ivory' as const,
  step: 'card' as const,
  openScale: 1,
};

export const SAMPLE_RIBBON = { colorId: 'rose' as const };

// ---------- 比例校准的地址栏入口 ----------

export interface LabParams {
  /** 覆盖玫瑰、郁金香的花头倍率；null 表示用清单默认值。 */
  headScale: number | null;
  /** 尺寸候选 a/b/c；null 表示用作品记录的候选（新作品默认 b）。 */
  sizeCandidate: SizeCandidateId | null;
  /** 直接载入固定样束。 */
  sample: SampleSize | null;
  /** 直接切到某个固定视角。 */
  view: ViewPreset | null;
}

const VIEW_KEYS: ViewPreset[] = ['front', 'quarter', 'side', 'top'];

function readSampleSize(raw: string | null): SampleSize | null {
  const value = Number(raw);
  return value === 6 || value === 12 || value === 20 ? (value as SampleSize) : null;
}

/**
 * 解析 `?head=0.8&size=b&sample=12&view=quarter`。
 * 只用于比例校准与验收，不影响正常使用路径；`size` 是 V0.7.3 的尺寸候选，
 * `head` 是只改花头的临时覆盖（隔离「花头」与「枝长」两个变量）。
 */
export function readLabParams(search: string): LabParams {
  const params = new URLSearchParams(search);
  const headRaw = Number(params.get('head'));
  const headScale =
    Number.isFinite(headRaw) && headRaw > 0
      ? Math.min(HEAD_SCALE_MAX, Math.max(HEAD_SCALE_MIN, headRaw))
      : null;
  const viewRaw = params.get('view');
  const view = viewRaw && VIEW_KEYS.includes(viewRaw as ViewPreset) ? (viewRaw as ViewPreset) : null;
  const sizeRaw = params.get('size');
  const sizeCandidate = isSizeCandidateId(sizeRaw) ? sizeRaw : null;
  return { headScale, sizeCandidate, sample: readSampleSize(params.get('sample')), view };
}
