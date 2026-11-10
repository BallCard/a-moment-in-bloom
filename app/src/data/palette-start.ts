/**
 * 作品展 → 工作台：用作品配色的起始作品。
 *
 * 作品展里每件作品都有一份 palette（真实 manifest 花材 id + 纸色 / 丝带 / 器型 / 场景）。
 * 这里把它变成一份可继续编辑的 BouquetDocument：8–12 枝按「主花在内、配花居中、绿叶在外」
 * 的自然层次摆好，纸色与器型直接应用到「完成」步骤，用户进来就能接着改。
 *
 * 布局是确定性的（按作品 id 播种）：同一个入口每次开局一致，验证脚本和截图才能对照。
 */
import { GRIP_Y, MAX_HEAD_RADIUS } from '../config';
import { createEmptyDocument, createStem } from './document';
import { switchPresentation } from './presentation';
import { findShowcase } from './showcase';
import type { BouquetDocument, StemInstance } from './types';

/** 起始作品最多用到的摆位半径（留一点余量，不顶到拖动上限）。 */
const USABLE_RADIUS = MAX_HEAD_RADIUS * 0.8;

type Layer = 'main' | 'filler' | 'greenery';

/**
 * 布局启发式：按 manifest 花型家族分层。
 * 植物学上「主花/配花/绿叶」的划分来自清单（fallback.procedural + kind），这里只是
 * 用花材 id 前缀复位到同一家族名，让花头高度、倾斜与缩放各归其位。
 */
const GREENERY_FAMILIES = [
  'eucalyptus', 'ruscus', 'salal', 'asparagus-fern', 'leatherleaf',
  'boston-fern', 'ivy', 'fatsia', 'aspidistra', 'bear-grass',
];
const FILLER_FAMILIES = [
  'spray-chrysanthemum', 'spray-rose', 'spray', 'lisianthus', 'alstroemeria',
  'babys-breath', 'statice', 'waxflower', 'rice-flower', 'veronica', 'snapdragon',
];

function familyOf(assetId: string): string | null {
  const id = assetId.toLowerCase();
  const all = [...GREENERY_FAMILIES, ...FILLER_FAMILIES].sort((a, b) => b.length - a.length);
  return all.find((family) => id === family || id.startsWith(`${family}-`)) ?? null;
}

function layerOf(assetId: string): Layer {
  const family = familyOf(assetId);
  if (!family) return 'main';
  if (GREENERY_FAMILIES.includes(family)) return 'greenery';
  return 'filler';
}

/**
 * 每一层的摆放规格：
 * - radius：花头目标水平半径（占可用半径的比例）；
 * - height：姿态里的整体升降（米），主花略抬、绿叶压低；
 * - lever：该层花头中心到握点的典型高度，用来反解倾角；
 * - tiltBias：配花/绿叶多打开一些，轮廓更透气；
 * - scale：绿叶缩到 0.88，避免高挑的枝叶盖住主花（manifset 里绿叶花头天然更高）。
 */
const LAYER_SPEC: Record<
  Layer,
  { radius: [number, number]; height: [number, number]; lever: number; tiltBias: number; scale: number; angleOffset: number }
> = {
  main: { radius: [0.14, 0.58], height: [0.02, 0.09], lever: 0.37, tiltBias: 1, scale: 1, angleOffset: 0 },
  filler: { radius: [0.46, 0.82], height: [-0.005, 0.03], lever: 0.37, tiltBias: 1.25, scale: 0.95, angleOffset: 23 },
  greenery: { radius: [0.76, 1], height: [-0.05, -0.03], lever: 0.44, tiltBias: 1.4, scale: 0.88, angleOffset: 47 },
};

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function hashText(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const lerp = (range: [number, number], t: number): number => range[0] + (range[1] - range[0]) * t;

/**
 * 按 palette 顺序生成花枝：主花在内圈偏高，配花插在空隙，绿叶最外圈、最外倾、压低高度，
 * 这样整束有高低错落的层次，也不会被高挑的枝叶盖住主花。
 */
export function buildPaletteStems(paletteId: string, assetIds: string[]): StemInstance[] {
  const random = seeded(hashText(paletteId));
  const layers = assetIds.map(layerOf);
  const totals: Record<Layer, number> = { main: 0, filler: 0, greenery: 0 };
  for (const layer of layers) totals[layer] += 1;
  const seen: Record<Layer, number> = { main: 0, filler: 0, greenery: 0 };

  return assetIds.map((assetId, index) => {
    const layer = layers[index];
    const spec = LAYER_SPEC[layer];
    const slot = seen[layer];
    seen[layer] += 1;
    const t = totals[layer] <= 1 ? 0.5 : slot / (totals[layer] - 1);
    const radius = lerp(spec.radius, t) * USABLE_RADIUS;
    const height = lerp(spec.height, 1 - t) + (random() - 0.5) * 0.012;
    const tilt = Math.min(
      52,
      (Math.asin(Math.min(1, radius / (spec.lever + Math.max(0, height)))) * 180 * spec.tiltBias) / Math.PI,
    );
    const direction = index * 137.508 + spec.angleOffset + random() * 30;
    return createStem({
      assetId,
      position: [0, GRIP_Y, 0],
      pose: {
        height: round(height, 4),
        tilt: round(tilt, 2),
        direction: round(((direction % 360) + 360) % 360, 2),
        spin: round(random() * 360, 1),
      },
      scale: round(spec.scale + (random() - 0.5) * 0.03, 2),
    });
  });
}

/**
 * 用作品配色建一份起始文档；找不到作品时返回 null。
 * `assetsVersion` 传当前清单版本，保证打开后与工作台目录一致。
 */
export function buildPaletteDocument(
  paletteId: string,
  assetsVersion: string,
  sizeCandidate?: BouquetDocument['sizeCandidate'],
): BouquetDocument | null {
  const item = findShowcase(paletteId);
  if (!item) return null;
  const { palette } = item;
  const empty = createEmptyDocument(assetsVersion, sizeCandidate);
  const stems = buildPaletteStems(item.id, palette.assetIds);
  const base: BouquetDocument = {
    ...empty,
    stems,
    wrapping: {
      ...empty.wrapping,
      enabled: true,
      paperId: palette.paperId,
      step: 'card',
      openScale: 1,
    },
    ribbon: { colorId: palette.ribbonColorId },
    photo: { ...empty.photo, scene: palette.photoScene },
  };
  if (palette.presentationKind === 'paper') {
    return { ...base, presentation: { ...base.presentation, kind: 'paper' } };
  }
  // 花器形态要走 switchPresentation：支点收进口沿、倾角按器型夹紧，插花姿态才自然。
  const switched = switchPresentation(base, palette.presentationKind);
  return {
    ...base,
    stems: switched.stems,
    presentation: switched.presentation,
    wrapping: {
      ...switched.wrapping,
      paperId: palette.paperId,
      step: 'card',
      openScale: 1,
    },
  };
}
