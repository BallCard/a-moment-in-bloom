/**
 * 本地相册：缩略图 + 可恢复作品 + 花材摘要（委托作品附结算记录）。
 *
 * 独立于作品自动存档：相册是「做过的作品」，自动存档是「手上这一束」。
 * 读取失败最多让相册少一条坏记录，不影响工作台启动。
 *
 * 数量规则（V6 P0-A）：
 * - 读取/清洗不再按 ALBUM_LIMIT 截断，坏记录跳过但好记录一条都不丢，交由写入前
 *   的显式检查决定是否允许新增，避免「载入时静默删除」。
 * - 写入不再静默截断；写入结果区分数量超限、浏览器容量不足与存储不可用。
 */

import { ALBUM_KEY } from '../config';
import { sanitizeDocument } from './document';
import type {
  AlbumEntry,
  AlbumFlowerSummary,
  BouquetDocument,
  CommissionRecord,
  GameMode,
  PhotoReview,
  RuntimeCatalog,
  Vec3,
} from './types';

export const ALBUM_VERSION = 2;

/** 单件作品最多保留的照片数（写入追加时检查，读取不截断）。 */
export const ALBUM_PHOTOS_PER_ENTRY = 6;

/** 写入相册的失败原因：数量超限 / 浏览器配额 / 存储不可用。 */
export type AlbumWriteFailure = 'limit' | 'quota' | 'unavailable';

export interface AlbumWriteResult {
  ok: boolean;
  /** 实际写入的 JSON 字节数（未写入时为计划写入的字节数）。 */
  bytes: number;
  failure?: AlbumWriteFailure;
}

interface AlbumFile {
  version: number;
  entries: AlbumEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** 字符串的 UTF-8 字节数（浏览器与 Node 都有 TextEncoder）。 */
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** 给玩家看的容量文案（1 KB = 1024 B）。 */
export function formatAlbumBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ---------- V6 P0-B：照片快照签名与点评读写 ----------

/** 相机方向保留 2 位小数（约 0.6°）：肉眼看不出的小幅移动不算换了画面。 */
function roundDirection(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** 单条点评的序列化签名上限（20 枝作品约 2–4KB，留足余量）。 */
const MAX_SNAPSHOT_LENGTH = 20_000;

/** 单条缓存的签名（同一文档 + 同一方向只序列化一次；拖动时不重复算）。 */
const signatureCache: {
  doc: BouquetDocument | null;
  directionKey: string | null;
  signature: string;
} = { doc: null, directionKey: null, signature: '' };

/**
 * 照片快照签名：只包含「会改变成片画面」的内容。
 *
 * 包含：花枝（id/assetId/位姿/缩放/整备）、包装（开关/纸/步骤/开口/纸片参数）、
 * 丝带、卡片、presentation 形式、照片设置（场景/边框/画幅/距离/偏移/题名/自动整理）
 * 与场景实时回报的实际机位方向。
 *
 * 排除：doc.version / assetsVersion / createdAt / updatedAt（更新时间、保存动作不算画面变化），
 * 以及 doc.photo.direction（拍照会把当前机位写进文档，它变化不代表画面变化；
 * 机位变化一律以场景回报的 cameraDirection 为准）。
 */
export function photoSnapshotSignature(
  doc: BouquetDocument,
  cameraDirection: Vec3 | null,
): string {
  const directionKey = cameraDirection
    ? cameraDirection.map(roundDirection).join(',')
    : 'camera:unknown';
  if (
    signatureCache.doc === doc &&
    signatureCache.directionKey === directionKey
  ) {
    return signatureCache.signature;
  }
  const payload = JSON.stringify({
    stems: doc.stems.map((stem) => [
      stem.id,
      stem.assetId,
      stem.variant,
      stem.position[0],
      stem.position[1],
      stem.position[2],
      stem.scale,
      stem.pose.height,
      stem.pose.tilt,
      stem.pose.direction,
      stem.pose.spin,
      stem.preparation.tailLength,
      stem.preparation.removedLeaves,
    ]),
    wrapping: [
      doc.wrapping.enabled,
      doc.wrapping.paperId,
      doc.wrapping.step,
      doc.wrapping.openScale,
    ],
    ribbon: doc.ribbon.colorId,
    card: [doc.card.to, doc.card.message, doc.card.from],
    presentation: [
      doc.presentation.kind,
      doc.presentation.sheets.map((sheet) => [
        sheet.paperId,
        sheet.height,
        sheet.rotation,
        sheet.width,
        sheet.leftFold,
        sheet.rightFold,
        sheet.gather,
        sheet.fixed,
      ]),
    ],
    photo: [
      doc.photo.scene,
      doc.photo.frame,
      doc.photo.format,
      doc.photo.zoom,
      doc.photo.offsetX,
      doc.photo.offsetY,
      doc.photo.title,
      doc.photo.autoTrim,
    ],
    cameraDirection: directionKey,
  });
  signatureCache.doc = doc;
  signatureCache.directionKey = directionKey;
  signatureCache.signature = payload;
  return payload;
}

/** 点评里的优点/建议：最多 3 条、每条 ≤ 250 字。 */
function reviewList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 250)
    .slice(0, max);
}

/** 读取相册里的点评；读不出来就当作这张照片没有点评（正常情况，不阻塞相册）。 */
export function readPhotoReview(value: unknown): PhotoReview | undefined {
  if (!isRecord(value)) return undefined;
  const score = value.score;
  const snapshot = text(value.snapshot);
  if (!Number.isInteger(score) || (score as number) < 0 || (score as number) > 100) return undefined;
  if (!snapshot || snapshot.length > MAX_SNAPSHOT_LENGTH) return undefined;
  const model = text(value.model);
  const visionModel = text(value.visionModel);
  return {
    score: score as number,
    summary: text(value.summary).slice(0, 500),
    strengths: reviewList(value.strengths, 3),
    suggestions: reviewList(value.suggestions, 3),
    ...(model ? { model: model.slice(0, 120) } : null),
    ...(visionModel ? { visionModel: visionModel.slice(0, 120) } : null),
    createdAt: text(value.createdAt, new Date().toISOString()),
    snapshot,
  };
}

/** 复制点评，避免相册记录与 store 里的当前点评共享数组。 */
export function copyReview(review: PhotoReview): PhotoReview {
  return {
    ...review,
    strengths: [...review.strengths],
    suggestions: [...review.suggestions],
  };
}

export function clampAlbumName(value: string, fallback = '未命名作品'): string {
  const chars = Array.from(value.trim());
  if (chars.length === 0) return fallback;
  return chars.slice(0, 24).join('');
}

export function makeAlbumId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `album_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }
  return `album_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 花材构成：按 assetId 聚合，保持首次出现的顺序。 */
export function flowersFromDocument(doc: BouquetDocument, catalog: RuntimeCatalog): AlbumFlowerSummary[] {
  const map = new Map<string, AlbumFlowerSummary>();
  for (const stem of doc.stems) {
    const existing = map.get(stem.assetId);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const entry = catalog.entriesById[stem.assetId];
    map.set(stem.assetId, {
      assetId: stem.assetId,
      name: entry?.displayName ?? stem.assetId,
      color: entry?.color ?? '#b9a98f',
      count: 1,
    });
  }
  return [...map.values()];
}

export function createAlbumEntry(options: {
  name: string;
  mode: GameMode;
  doc: BouquetDocument;
  thumbnail: string;
  catalog: RuntimeCatalog;
  commission?: CommissionRecord;
  /** 与这张照片快照匹配的点评；不匹配的点评不应传进来（见 store.matchingReview）。 */
  review?: PhotoReview;
}): AlbumEntry {
  const now = new Date().toISOString();
  const photoId = makeAlbumId();
  return {
    photos: [
      {
        id: photoId,
        createdAt: now,
        thumbnail: normalizeThumbnail(options.thumbnail),
        doc: JSON.parse(JSON.stringify(options.doc)) as BouquetDocument,
        ...(options.review ? { review: copyReview(options.review) } : null),
      },
    ],
    coverId: photoId,
    id: makeAlbumId(),
    name: clampAlbumName(options.name),
    createdAt: now,
    updatedAt: now,
    mode: options.mode,
    doc: JSON.parse(JSON.stringify(options.doc)) as BouquetDocument,
    thumbnail: normalizeThumbnail(options.thumbnail),
    flowers: flowersFromDocument(options.doc, options.catalog),
    stemCount: options.doc.stems.length,
    ...(options.commission ? { commission: options.commission } : null),
  };
}

function normalizeThumbnail(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (!value.startsWith('data:image/')) return '';
  // 一张 480px JPEG 通常 20–60KB；超过 600KB 说明不是我们生成的缩略图。
  if (value.length > 600_000) return '';
  return value;
}

function readCommission(value: unknown): CommissionRecord | undefined {
  if (!isRecord(value)) return undefined;
  const commissionId = text(value.commissionId);
  if (!commissionId) return undefined;
  const complete = value.complete === true;
  const metCount = Number.isFinite(value.metCount) ? Number(value.metCount) : 0;
  const total = Number.isFinite(value.total) ? Number(value.total) : 0;
  return {
    commissionId,
    title: text(value.title, commissionId),
    customer: text(value.customer),
    complete,
    metCount,
    total,
    deliveredAt: text(value.deliveredAt, new Date().toISOString()),
    response: text(value.response),
  };
}

/**
 * 校验并清洗一条相册记录；读不出来返回 null。
 * 照片只做校验（坏数据跳过），不再按 6 张截断——数量规则交给写入路径检查。
 */
export function sanitizeAlbumEntry(
  value: unknown,
  fallbackAssetsVersion: string,
): AlbumEntry | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  if (!id) return null;
  const { doc } = sanitizeDocument(value.doc, fallbackAssetsVersion);
  if (doc.stems.length === 0) return null;
  const flowers = Array.isArray(value.flowers)
    ? value.flowers
        .filter(isRecord)
        .map((item) => ({
          assetId: text(item.assetId),
          name: text(item.name, text(item.assetId)),
          color: text(item.color, '#b9a98f'),
          count: Number.isFinite(item.count) ? Math.max(1, Math.round(Number(item.count))) : 1,
        }))
        .filter((item) => item.assetId)
    : [];
  const createdAt = text(value.createdAt, new Date().toISOString());
  const photos: AlbumEntry['photos'] = Array.isArray(value.photos)
    ? value.photos
        .filter(isRecord)
        .map((photo, i) => {
          const review = readPhotoReview(photo.review);
          return {
            id: text(photo.id, `${id}_photo_${i}`),
            createdAt: text(photo.createdAt, createdAt),
            thumbnail: normalizeThumbnail(photo.thumbnail),
            doc: sanitizeDocument(photo.doc, fallbackAssetsVersion).doc,
            // 旧照片没有点评是正常情况；读不出来的点评按「没有点评」处理。
            ...(review ? { review } : null),
          };
        })
        // 只丢弃读不出花枝的坏照片；有效照片连第 7 张也保留，不静默截断。
        .filter((photo) => photo.doc.stems.length > 0)
    : [];
  if (!photos.length) {
    photos.push({
      id: `${id}_legacy`,
      createdAt,
      thumbnail: normalizeThumbnail(value.thumbnail),
      doc,
    });
  }
  const cover = photos.find((photo) => photo.id === value.coverId) ?? photos[0];
  return {
    id,
    photos,
    coverId: cover.id,
    name: clampAlbumName(text(value.name), '未命名作品'),
    createdAt,
    updatedAt: text(value.updatedAt, createdAt),
    mode: value.mode === 'commission' ? 'commission' : 'free',
    doc: cover.doc,
    thumbnail: cover.thumbnail,
    flowers: flowers.slice(0, 20),
    stemCount: doc.stems.length,
    commission: readCommission(value.commission),
  };
}

/** 读相册：坏条目/重复 id 跳过，但不按数量上限截断（读取不静默删除）。 */
export function sanitizeAlbum(raw: unknown, fallbackAssetsVersion: string): AlbumEntry[] {
  if (!isRecord(raw) || !Array.isArray(raw.entries)) return [];
  const entries: AlbumEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw.entries) {
    const entry = sanitizeAlbumEntry(item, fallbackAssetsVersion);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

export function loadAlbum(fallbackAssetsVersion: string): AlbumEntry[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(ALBUM_KEY);
    if (!raw) return [];
    return sanitizeAlbum(JSON.parse(raw), fallbackAssetsVersion);
  } catch {
    return [];
  }
}

/** 序列化为落盘文件（数量不再截断，调用方负责先做数量检查）。 */
export function serializeAlbumFile(entries: AlbumEntry[]): { text: string; bytes: number } {
  const file: AlbumFile = { version: ALBUM_VERSION, entries };
  const text = JSON.stringify(file);
  return { text, bytes: utf8Bytes(text) };
}

/** 写入相册文件：不截断、不重排；失败原因如实返回。 */
export function writeAlbumFile(entries: AlbumEntry[]): AlbumWriteResult {
  const { text, bytes } = serializeAlbumFile(entries);
  if (typeof localStorage === 'undefined') return { ok: false, bytes, failure: 'unavailable' };
  try {
    localStorage.setItem(ALBUM_KEY, text);
    return { ok: true, bytes };
  } catch (error) {
    // 配额超限是「相册满了」；其他异常（隐私模式禁用存储等）按存储不可用处理。
    const name = error instanceof Error ? error.name : '';
    const quota = name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
    return { ok: false, bytes, failure: quota ? 'quota' : 'unavailable' };
  }
}

/** 兼容旧调用：写成功返回 true；不静默截断。 */
export function saveAlbum(entries: AlbumEntry[]): boolean {
  return writeAlbumFile(entries).ok;
}

/**
 * 把新条目放进相册头部（同 id 覆盖）；不再按上限截断。
 * 是否允许超过 ALBUM_LIMIT 由 store 的写入检查决定，以免静默删除旧作品。
 */
export function prependAlbumEntry(entries: AlbumEntry[], entry: AlbumEntry): AlbumEntry[] {
  return [entry, ...entries.filter((item) => item.id !== entry.id)];
}
