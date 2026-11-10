/**
 * V0.7 §3：花材尺寸配置的默认值、解析与校准覆盖。
 *
 * 目标：花头大小、枝长、叶片展开三件事分开调。当前实现里枝长与花头中心
 * （transform.headOffsetY）保持不变，只把花头几何本身按倍率缩放，
 * 因此「花头缩小、枝长不变」是结构上成立的，而不是靠整体缩放凑出来的。
 */

import type {
  AssetEntry,
  AssetSizeConfig,
  ProceduralKey,
  RuntimeCatalog,
  Vec3,
} from './types';

/** 花头倍率校准档位：玫瑰、郁金香按原尺寸的 70% / 80% / 90% 做对照。 */
export const HEAD_SCALE_STEPS = [0.7, 0.8, 0.9] as const;

/** 计划 §3 指定的起始校准值（候选 a 的原尺寸）。 */
export const CALIBRATED_HEAD_SCALE = 0.8;

// ---------- V0.7.3 尺寸候选（a / b / c） ----------

/**
 * 尺寸候选：用户反馈「整体模型偏大」后，按计划给出的三档对照。
 *
 * - a：V0.7 原尺寸（玫瑰/郁金香花头 80%，程序花整枝标定值不缩）——对照组；
 * - b：花头 64%（比 a 小 20%）、枝长缩 12%、叶片收 15%、程序花整枝 ×0.88；
 * - c：花头 56%（比 a 小 30%）、枝长缩 15%、叶片收 20%、程序花整枝 ×0.85。
 *
 * 这是**审美候选**，不是已定稿值：b 作为新作品默认值，等用户看对照截图确认；
 * 旧存档按自己没有 sizeCandidate 字段读成 a，比例保持不变。
 */
export type SizeCandidateId = 'a' | 'b' | 'c';

export interface SizeCandidate {
  id: SizeCandidateId;
  label: string;
  /** 能分离花头的花材（玫瑰、郁金香）的花头倍率。 */
  headScale: number;
  /** 枝长倍率：花头中心与可见花头底部一起往握点收。 */
  stemFactor: number;
  /** 叶片展开倍率（玫瑰/郁金香的分枝叶片）。 */
  leafSpread: number;
  /** 程序化花材整枝等比倍率的乘数（它们没有分离花头，只能整枝缩）。 */
  uniformFactor: number;
  note: string;
}

export const SIZE_CANDIDATES: Record<SizeCandidateId, SizeCandidate> = {
  a: {
    id: 'a',
    label: '原尺寸',
    headScale: CALIBRATED_HEAD_SCALE,
    stemFactor: 1,
    leafSpread: 1,
    uniformFactor: 1,
    note: 'V0.7 已推送的比例，作为对照基线',
  },
  b: {
    id: 'b',
    label: '缩小 20%',
    headScale: 0.64,
    stemFactor: 0.88,
    leafSpread: 0.85,
    uniformFactor: 0.88,
    note: '花头 64%、枝长 -12%、叶片 -15%；新作品默认',
  },
  c: {
    id: 'c',
    label: '缩小 30%',
    headScale: 0.56,
    stemFactor: 0.85,
    leafSpread: 0.8,
    uniformFactor: 0.85,
    note: '花头 56%、枝长 -15%、叶片 -20%；最紧凑的一档',
  },
};

export const DEFAULT_SIZE_CANDIDATE: SizeCandidateId = 'b';

export function isSizeCandidateId(raw: unknown): raw is SizeCandidateId {
  return raw === 'a' || raw === 'b' || raw === 'c';
}

export function sizeCandidateOf(id: SizeCandidateId | undefined | null): SizeCandidate {
  return SIZE_CANDIDATES[id ?? DEFAULT_SIZE_CANDIDATE] ?? SIZE_CANDIDATES.a;
}

/** 花头倍率的允许范围，防止清单写坏把花头放大到失真。 */
export const HEAD_SCALE_MIN = 0.5;
export const HEAD_SCALE_MAX = 1.5;

/** 枝长倍率的允许范围：不允许把花头压进握点，也不允许把枝拉长到失真。 */
export const STEM_FACTOR_MIN = 0.8;
export const STEM_FACTOR_MAX = 1.05;

/** 整枝等比缩放的允许范围；上限按最矮的程序化花型（0.54m → 0.95m）留余量。 */
export const UNIFORM_SCALE_MIN = 0.5;
export const UNIFORM_SCALE_MAX = 2.4;

/** 能分出独立花头的花型；其他花型只有整体几何，花头倍率对它们不生效。 */
export const SPLIT_HEAD_FAMILIES: ProceduralKey[] = ['rose', 'tulip'];

/** 程序多头玫瑰的三个花头：逐个登记的局部偏移与接触半径（米）。 */
export const SPRAY_HEADS: { offset: Vec3; radius: number }[] = [
  { offset: [-0.065, 0.33, 0.015], radius: 0.044 },
  { offset: [0.065, 0.38, -0.015], radius: 0.044 },
  { offset: [0, 0.46, 0.01], radius: 0.044 },
];

/**
 * 各花型默认尺寸。玫瑰、郁金香先按计划的 80% 起步；其余花材保持原尺寸，
 * 花头倍率对它们不生效（这些花型没有分离花头，见 SPLIT_HEAD_FAMILIES）。
 *
 * `uniformScale` 是 V0.7 §5 的整枝等比缩放，只给 25 种新程序化花材用。
 * 口径说明：这几个花型由构建器按「花头贴着枝顶」建模，可见高度
 * （握点到花头顶）只有 0.32–0.42m，而玫瑰/郁金香的可见高度在 0.50m，
 * 枝条和花头一起放会明显偏小。倍数按「花头顶不超过 0.50m、花头别超过
 * 主花该有的体量」两个约束反算（实测见 `.verify/probe-heads.json`）：
 * 主花 1.35（马蹄莲枝长，收到 1.24）、配花 1.15、绿叶 1.25 —— 配花刻意
 * 比主花矮一档，绿叶居中，混插时才有高低层次，而不是一样高一样大。
 *
 * 花头位置与半径不写死在这里：程序化花材没有分离花头，构建器声明的
 * headHeight 只是意图值（实测常偏 3–8cm），交给 AssetLoader 从几何实测
 * （见 `measureProceduralHead`），接触形变、选中环和相机对焦才落在真花头上。
 */
const FAMILY_SIZE: Partial<Record<ProceduralKey, Partial<AssetSizeConfig>>> = {
  rose: { headWidth: CALIBRATED_HEAD_SCALE, headHeight: CALIBRATED_HEAD_SCALE, leafSpread: 1 },
  tulip: { headWidth: CALIBRATED_HEAD_SCALE, headHeight: CALIBRATED_HEAD_SCALE, leafSpread: 1 },
  eucalyptus: { headWidth: 1, headHeight: 1, leafSpread: 1 },
  spray: { headWidth: 1, headHeight: 1, leafSpread: 1, heads: SPRAY_HEADS },
  daisy: { headWidth: 1, headHeight: 1, leafSpread: 1 },
  // ---- 主花：花头顶 ≈0.47–0.50m ----
  'peony': { uniformScale: 1.35 },
  'herbaceous-peony': { uniformScale: 1.35 },
  'carnation': { uniformScale: 1.35 },
  'lily': { uniformScale: 1.35 },
  'sunflower': { uniformScale: 1.35 },
  'dahlia': { uniformScale: 1.35 },
  'calla': { uniformScale: 1.24 },
  // V16 §2：真实 GLB 已于 2026-11-10 接入清单，数值归一化由管线测量（targetHeight 0.5m）决定，
  // 清单条目按约定不继承这里的整枝倍率（见 familyBase 的 manifest 分支）。
  // 这两个值只在模型加载失败、回退到程序化几何时生效：绣球整枝等比放到主花体量，
  // 花球本身按 0.15m 直径建模；蝴蝶兰按 0.42m 可见高度建模。
  'hydrangea': { uniformScale: 1.32 },
  'orchid': { uniformScale: 1.35 },
  // ---- 配花：比主花矮一档 ----
  'lisianthus': { uniformScale: 1.15 },
  'alstroemeria': { uniformScale: 1.15 },
  'spray-chrysanthemum': { uniformScale: 1.15 },
  'babys-breath': { uniformScale: 1.15 },
  'statice': { uniformScale: 1.15 },
  'waxflower': { uniformScale: 1.15 },
  'rice-flower': { uniformScale: 1.15 },
  'veronica': { uniformScale: 1.15 },
  'snapdragon': { uniformScale: 1.15 },
  // ---- 绿叶：不再放大 ----
  // 绿叶的参考对象是尤加利（实测叶面铺开半径 0.188m），新绿叶本来就落在
  // 0.15–0.21m，已经对得上；再等比放大只会让叶片压过主花，所以保持 1。
  'ruscus': { uniformScale: 1 },
  'salal': { uniformScale: 1 },
  'asparagus-fern': { uniformScale: 1 },
  'leatherleaf': { uniformScale: 1 },
  'boston-fern': { uniformScale: 1 },
  'ivy': { uniformScale: 1 },
  'fatsia': { uniformScale: 1 },
  'aspidistra': { uniformScale: 1 },
  'bear-grass': { uniformScale: 1 },
};

const FALLBACK_SIZE: AssetSizeConfig = { headWidth: 1, headHeight: 1, leafSpread: 1 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readHeads(raw: unknown): { offset: Vec3; radius: number }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const heads: { offset: Vec3; radius: number }[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const offset = record.offset;
    if (!Array.isArray(offset) || offset.length < 3) continue;
    const [x, y, z] = offset;
    if (![x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    const radius = typeof record.radius === 'number' && Number.isFinite(record.radius) ? record.radius : 0.044;
    heads.push({ offset: [x as number, y as number, z as number], radius: clamp(radius, 0.01, 0.2) });
  }
  return heads.length > 0 ? heads : undefined;
}

/**
 * 花型默认值 + 兜底，成员可以只写自己关心的字段。
 *
 * `manifest` 为真表示这是清单条目（真实 GLB）：程序化的整枝标定值
 * （`uniformScale` 1.15–1.35）与多头偏移（spray 的 `SPRAY_HEADS`）都是为
 * 合并几何写的，不能套到单网格真实模型上——这类条目改由管线实测的
 * `transform.headOffsetY` / `size.headRadius` 决定花头，`size` 缺省即
 * 「整枝 1 倍、无多头登记」。
 */
function familyBase(procedural: ProceduralKey, manifest = false): AssetSizeConfig {
  const custom = FAMILY_SIZE[procedural] ?? {};
  return {
    headWidth: custom.headWidth ?? FALLBACK_SIZE.headWidth,
    headHeight: custom.headHeight ?? FALLBACK_SIZE.headHeight,
    leafSpread: custom.leafSpread ?? FALLBACK_SIZE.leafSpread,
    stemFactor: custom.stemFactor ?? 1,
    headRadius: custom.headRadius,
    uniformScale: manifest ? 1 : custom.uniformScale,
    heads: manifest ? undefined : custom.heads,
  };
}

/**
 * 把 manifest 里的 size 字段洗成可用配置；读不懂的字段按默认值补。
 * `options.manifest` 见 `familyBase`：清单条目不继承程序化的多头/整枝值。
 */
export function readSizeConfig(
  raw: unknown,
  procedural: ProceduralKey,
  options?: { manifest?: boolean },
): AssetSizeConfig {
  const base = familyBase(procedural, options?.manifest === true);
  if (typeof raw !== 'object' || raw === null) return { ...base };
  const record = raw as Record<string, unknown>;
  const number = (key: string, fallback: number): number => {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };
  const headWidth = clamp(number('headWidth', base.headWidth), HEAD_SCALE_MIN, HEAD_SCALE_MAX);
  const headHeight = clamp(
    number('headHeight', base.headHeight ?? headWidth),
    HEAD_SCALE_MIN,
    HEAD_SCALE_MAX,
  );
  const leafSpread = clamp(number('leafSpread', base.leafSpread ?? 1), 0.6, 1.4);
  const stemFactor = clamp(
    number('stemFactor', base.stemFactor ?? 1),
    STEM_FACTOR_MIN,
    STEM_FACTOR_MAX,
  );
  const headRadiusRaw = record.headRadius;
  const headRadius =
    typeof headRadiusRaw === 'number' && Number.isFinite(headRadiusRaw)
      ? clamp(headRadiusRaw, 0.02, 0.2)
      : base.headRadius;
  const heads = readHeads(record.heads) ?? base.heads;
  const uniformScaleRaw = record.uniformScale;
  const uniformScale = clamp(
    typeof uniformScaleRaw === 'number' && Number.isFinite(uniformScaleRaw)
      ? uniformScaleRaw
      : base.uniformScale ?? 1,
    UNIFORM_SCALE_MIN,
    UNIFORM_SCALE_MAX,
  );
  return { headWidth, headHeight, leafSpread, stemFactor, headRadius, heads, uniformScale };
}

/** 没有清单 size 字段时，按花型补一份默认配置。 */
export function defaultSizeFor(procedural: ProceduralKey): AssetSizeConfig {
  return familyBase(procedural);
}

/** 统一改写目录条目：entries / entriesById / families 三处保持一致。 */
function mapCatalog(
  catalog: RuntimeCatalog,
  mapper: (entry: AssetEntry) => AssetEntry,
  assetsVersion = catalog.assetsVersion,
): RuntimeCatalog {
  const entries = catalog.entries.map(mapper);
  const entriesById = Object.fromEntries(entries.map((entry) => [entry.assetId, entry]));
  const families = catalog.families.map((family) => ({
    ...family,
    entries: family.entries.map((entry) => entriesById[entry.assetId] ?? entry),
  }));
  return { ...catalog, assetsVersion, entries, entriesById, families };
}

/**
 * 把尺寸候选套到整份目录上（V0.7.3）。
 *
 * 基准是 V0.7 原尺寸（候选 a）：目录里的 size 字段就是基准值，所以这里
 * 用「绝对覆盖」而不是相对倍率，重复调用同一候选结果一致。assetsVersion
 * 带上 `+size-<id>` 后缀：AssetLoader 的缓存键与存档记录都靠它区分比例版本。
 */
export function applySizeCandidate(
  catalog: RuntimeCatalog,
  id: SizeCandidateId,
): RuntimeCatalog {
  const candidate = sizeCandidateOf(id);
  const baseVersion = catalog.assetsVersion.replace(/\+size-[abc]$/, '');
  return mapCatalog(
    catalog,
    (entry): AssetEntry => {
      const base = entry.size ?? defaultSizeFor(entry.procedural);
      const size: AssetSizeConfig = SPLIT_HEAD_FAMILIES.includes(entry.procedural)
        ? {
            ...base,
            headWidth: candidate.headScale,
            headHeight: candidate.headScale,
            stemFactor: candidate.stemFactor,
            leafSpread: candidate.leafSpread,
          }
        : {
            ...base,
            leafSpread: candidate.leafSpread,
            uniformScale: (base.uniformScale ?? 1) * candidate.uniformFactor,
          };
      return { ...entry, size };
    },
    `${baseVersion}+size-${candidate.id}`,
  );
}

/**
 * 校准覆盖：把指定倍率套到所有能分花头的花材上（玫瑰、郁金香）。
 * 只用于比例对照与样束验收，不写进作品，也不改清单文件。
 */
export function applyHeadScaleOverride(
  catalog: RuntimeCatalog,
  headScale: number,
): RuntimeCatalog {
  const value = clamp(headScale, HEAD_SCALE_MIN, HEAD_SCALE_MAX);
  return mapCatalog(catalog, (entry): AssetEntry => {
    if (!SPLIT_HEAD_FAMILIES.includes(entry.procedural)) return entry;
    const size = entry.size ?? defaultSizeFor(entry.procedural);
    return { ...entry, size: { ...size, headWidth: value, headHeight: value } };
  });
}

/** 当前生效的花头倍率（用于界面与证据记录）。 */
export function headScaleOf(entry: AssetEntry | undefined): number {
  if (!entry?.size) return 1;
  return entry.size.headWidth;
}

/** 当前生效的枝长倍率。 */
export function stemFactorOf(entry: AssetEntry | undefined): number {
  return entry?.size?.stemFactor ?? 1;
}
