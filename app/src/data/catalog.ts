/** manifest 解析与运行时资产目录。 */

import {
  PROCEDURAL_KEYS,
  type AssetEntry,
  type AssetFamily,
  type AssetKind,
  type AssetTransform,
  type ProceduralKey,
  type RecolorMode,
  type RecolorSpec,
  type RuntimeCatalog,
} from './types';
import { buildBuiltinCatalog, buildV07Entries, extensionEntries, familyMeta } from './builtin';
import { readSizeConfig } from './size';

export const KIND_LABEL: Record<AssetKind, string> = {
  main: '主花',
  filler: '配花',
  greenery: '绿叶',
};

/** 清单缺了 fallback.color 时的兜底色；未单列的花型统一用中性粉/绿。 */
const DEFAULT_COLOR: Partial<Record<ProceduralKey, string>> = {
  spray:'#c96d89', daisy:'#e9b452',
  tulip: '#e8a4ba',
  rose: '#e79fb1',
  eucalyptus: '#9db08f',
};

/** 新花型没有单列兜底色时：绿叶给绿色，其余给浅粉。 */
function defaultColorOf(procedural: ProceduralKey): string {
  const fixed = DEFAULT_COLOR[procedural];
  if (fixed) return fixed;
  return GREEN_FAMILIES.includes(procedural) ? '#6f8a63' : '#e8a4ba';
}

const GREEN_FAMILIES: ProceduralKey[] = [
  'ruscus',
  'salal',
  'asparagus-fern',
  'leatherleaf',
  'boston-fern',
  'ivy',
  'fatsia',
  'aspidistra',
  'bear-grass',
  'eucalyptus',
];

/**
 * 清单里 `fallback.procedural` 的合法值：与 `data/types.ts` 的 `PROCEDURAL_KEYS`
 * 同源（30 种花型）。这里只查表，不再手写字符串副本，新增花型不会漏判。
 */
export function isProceduralKey(value: unknown): value is ProceduralKey {
  return typeof value === 'string' && (PROCEDURAL_KEYS as readonly string[]).includes(value);
}

/**
 * 按资产 id 猜花型，用于「存档引用了当前清单没有的 assetId」时的保底。
 *
 * 先按「花科-序号」的**最长前缀**匹配 30 花型，再退回模糊关键词：
 * 否则 `tulip-rose` 里的 `rose` 会抢在 `tulip` 前面命中，回退成错误的占位花。
 */
export function inferProceduralKey(id: string): ProceduralKey {
  const key = (id || '').toLowerCase();
  let best: ProceduralKey | null = null;
  for (const candidate of PROCEDURAL_KEYS) {
    if (key === candidate || key.startsWith(`${candidate}-`)) {
      if (!best || candidate.length > best.length) best = candidate;
    }
  }
  if (best) return best;
  if (key.includes('rose') || key.includes('玫瑰')) return 'rose';
  if (key.includes('euca') || key.includes('leaf') || key.includes('green') || key.includes('叶')) {
    return 'eucalyptus';
  }
  return 'tulip';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFinite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeKind(value: unknown, procedural: ProceduralKey): AssetKind {
  if (value === 'main' || value === 'filler' || value === 'greenery') return value;
  return procedural === 'eucalyptus' ? 'greenery' : 'main';
}

function normalizeTransform(value: unknown): AssetTransform {
  const raw = asRecord(value) ?? {};
  return {
    scale: Math.min(4, Math.max(0.05, asFinite(raw.scale, 1))),
    rotationY: asFinite(raw.rotationY, 0),
    gripAt: asFinite(raw.gripAt, 0),
    headOffsetY: Math.min(1.5, Math.max(0.05, asFinite(raw.headOffsetY, 0.38))),
  };
}

/**
 * 静态缩略图路径：相对 `assets/` 解析。读不懂的取值（空串、绝对路径、
 * 带 `..` 的穿越路径、非字符串）一律忽略，让花材架回退到运行时渲染。
 */
function normalizeThumb(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const clean = raw.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!clean || clean.startsWith('/') || clean.split('/').includes('..')) return undefined;
  return clean;
}

const RECOLOR_MODES: readonly RecolorMode[] = ['petals', 'foliage', 'all'];

function isRecolorMode(value: unknown): value is RecolorMode {
  return typeof value === 'string' && (RECOLOR_MODES as readonly string[]).includes(value);
}

/** 色相窗口：只接受两个有限数字，规范化到 0–360°；坏的取值返回 undefined 走默认窗口。 */
function readHueWindow(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const [a, b] = value;
  if (typeof a !== 'number' || typeof b !== 'number') return undefined;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  const wrap = (n: number): number => ((n % 360) + 360) % 360;
  return [wrap(a), wrap(b)];
}

/**
 * 解析 `recolor`：字符串形式用默认色相窗口；对象形式 `{mode, hue:[a,b]}`
 * 用自定义环绕窗口。mode 读不懂就整条忽略（当作不换色），hue 读不懂只丢窗口。
 */
function parseRecolor(value: unknown): RecolorSpec | undefined {
  if (isRecolorMode(value)) return value;
  const record = asRecord(value);
  if (!record) return undefined;
  if (!isRecolorMode(record.mode)) return undefined;
  const hue = readHueWindow(record.hue);
  return hue ? { mode: record.mode, hue } : record.mode;
}

/** 按家族分组的运行时目录。manifest 与内置数据共用这一层。 */
export function createCatalog(
  entries: AssetEntry[],
  mode: RuntimeCatalog['mode'],
  assetsVersion: string,
  notice?: string,
): RuntimeCatalog {
  const entriesById: Record<string, AssetEntry> = {};
  const families: AssetFamily[] = [];
  for (const asset of entries) {
    if (entriesById[asset.assetId]) continue;
    entriesById[asset.assetId] = asset;
    const existing = families.find((f) => f.family === asset.family);
    if (existing) {
      existing.entries.push(asset);
    } else {
      const meta = familyMeta(asset.family);
      families.push({
        family: asset.family,
        displayName: meta?.displayName ?? asset.familyName,
        kind: asset.kind,
        note:
          meta?.note ??
          (asset.kind === 'main'
            ? '主花，负责整束的重点'
            : asset.kind === 'filler'
              ? '配花，用来填补空隙'
              : '绿叶，让花束更透气'),
        entries: [],
      });
      families[families.length - 1].entries.push(asset);
    }
  }
  const uniqueEntries = entries.filter((e) => entriesById[e.assetId] === e);
  return { mode, assetsVersion, entries: uniqueEntries, entriesById, families, notice };
}

/**
 * 解析 public/assets/manifest.json。
 * 结构见 docs 与 app/README.md；容错：跳过读不懂的条目并给出提示。
 */
export function parseManifest(raw: unknown): RuntimeCatalog {
  const root = asRecord(raw);
  if (!root) throw new Error('清单不是一个 JSON 对象');
  const assetsRaw = root.assets;
  if (!Array.isArray(assetsRaw)) throw new Error('清单缺少 assets 数组');

  const assetsVersion = asString(root.assetsVersion) ?? 'manifest';
  const entries: AssetEntry[] = [];
  const skipped: string[] = [];

  for (const item of assetsRaw) {
    const asset = asRecord(item);
    if (!asset) {
      skipped.push('条目不是对象');
      continue;
    }
    const assetId = asString(asset.id);
    const glb = asString(asset.glb);
    if (!assetId || !glb) {
      skipped.push(assetId ?? '无 id 的条目');
      continue;
    }
    if (entries.some((e) => e.assetId === assetId)) {
      skipped.push(`${assetId}（重复）`);
      continue;
    }
    const fallback = asRecord(asset.fallback) ?? {};
    const procedural = isProceduralKey(fallback.procedural)
      ? fallback.procedural
      : inferProceduralKey(assetId);
    const family = asString(fallback.procedural) ?? procedural;
    const displayName = asString(asset.displayName) ?? assetId;
    // 约定单枝名用「郁金香 · 粉」这种形式，用中点拆出种类名与颜色名。
    const [familyName, variantName] = displayName.includes('·')
      ? (displayName.split('·') as [string, string?])
      : [displayName, undefined];
    const color = asString(fallback.color) ?? defaultColorOf(procedural);
    const kind = normalizeKind(asset.kind, procedural);
    const recolor = parseRecolor(asset.recolor);
    const thumb = normalizeThumb(asset.thumb);

    entries.push({
      assetId,
      family,
      kind,
      displayName,
      familyName: familyName.trim() || displayName,
      variantName: (variantName ?? '标准色').trim() || '标准色',
      color,
      glb,
      thumb,
      transform: normalizeTransform(asset.transform),
      // V0.7 §3：花头 / 枝长 / 叶片展开的尺寸配置；清单没写就按花型默认值补。
      // 清单条目按「真实模型」解析：不继承程序化的多头登记与整枝标定值。
      size: readSizeConfig(asset.size, procedural, { manifest: true }),
      procedural,
      source: 'manifest',
      recolor,
    });
  }

  if (entries.length === 0) {
    throw new Error('清单里没有可用的花材');
  }

  const notice =
    skipped.length > 0 ? `花材清单里有 ${skipped.length} 条没读明白，已跳过` : undefined;
  return createCatalog([...entries, ...extensionEntries(), ...buildV07Entries()], 'manifest', assetsVersion, notice);
}

/**
 * 清单地址。
 *
 * 生产默认是 `${BASE_URL}assets/manifest.json`。地址栏带 `?manifest=<相对路径>`
 * 时改读该文件，**只给验证脚本用**（fixture 放在 `app/public/assets/` 之外，
 * 例如 `.verify/manifest-fixture.json`，跑全量目录前不必等管线）。
 * 相对路径按文档 base 解析，所以 `glb` / `thumb` 仍然相对 `assets/` 解析，
 * 不因清单换位置而改变（见 `AssetLoader` 与 `thumbnails.ts`）。
 */
function manifestUrl(): string {
  const fallback = `${import.meta.env.BASE_URL}assets/manifest.json`;
  if (typeof window === 'undefined') return fallback;
  try {
    const param = new URLSearchParams(window.location.search).get('manifest');
    if (!param) return fallback;
    return new URL(param, document.baseURI).href;
  } catch {
    return fallback;
  }
}

/**
 * 读取运行时目录。
 * - manifest 不存在（404 / SPA 回退返回 HTML）属正常默认情况：静默使用内置占位花。
 * - 存在但读不出来：回退到占位花，并带上一条不打断操作的提示。
 */
export async function fetchRuntimeCatalog(): Promise<RuntimeCatalog> {
  const url = manifestUrl();
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    if (response.status === 404) return buildBuiltinCatalog();
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) return buildBuiltinCatalog();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json: unknown = await response.json();
    return parseManifest(json);
  } catch (error) {
    console.info('[bouquet] 花材清单读取失败，已用占位花回退：', error);
    const builtin = buildBuiltinCatalog();
    return {
      ...builtin,
      notice: '花材清单没读出来，先用占位花顶上',
    };
  }
}
