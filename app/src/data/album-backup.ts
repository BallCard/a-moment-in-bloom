/**
 * 相册完整备份与恢复（V6 P0-A）。
 *
 * 备份文件只包含相册记录本身：照片（含拍摄时的制作版本）、封面、花材摘要、
 * 委托记录与人物回应、制作版本号；不写凭据、密钥或任何 URL 凭证。
 *
 * 恢复原则：
 * - 先整份校验（格式/版本/条目），任何一条读不出来就停止恢复，原相册不动。
 * - 按稳定 ID（entry.id + photo.id）识别重复，向玩家报告新增/重复/超额数量。
 * - 由玩家选择「跳过重复只加新」或「用备份替换同名记录」，不静默覆盖。
 * - 恢复后超过数量上限时停止写入并保留原相册。
 */

import { ALBUM_LIMIT, SCHEMA_VERSION } from '../config';
import { ALBUM_PHOTOS_PER_ENTRY, sanitizeAlbumEntry, utf8Bytes } from './album';
import type { AlbumEntry } from './types';

export const ALBUM_BACKUP_FORMAT = 'huajian-album-backup';
export const ALBUM_BACKUP_VERSION = 1;

export interface AlbumBackupFile {
  format: string;
  version: number;
  exportedAt: string;
  /** 备份时应用的文档结构版本，便于以后兼容旧备份。 */
  schemaVersion: number;
  entries: AlbumEntry[];
}

export interface AlbumBackupPayload {
  text: string;
  bytes: number;
  entryCount: number;
  photoCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只挑选相册记录已有的字段，确保备份里不会夹带未知/敏感字段。 */
function projectEntry(entry: AlbumEntry): AlbumEntry {
  const photos = entry.photos.map((photo) => ({
    id: photo.id,
    createdAt: photo.createdAt,
    thumbnail: photo.thumbnail,
    doc: photo.doc,
    // V6 P0-B：照片上的点评也要备份，否则恢复后点评会丢。
    ...(photo.review
      ? {
          review: {
            score: photo.review.score,
            summary: photo.review.summary,
            strengths: [...photo.review.strengths],
            suggestions: [...photo.review.suggestions],
            ...(photo.review.model ? { model: photo.review.model } : null),
            ...(photo.review.visionModel ? { visionModel: photo.review.visionModel } : null),
            createdAt: photo.review.createdAt,
            snapshot: photo.review.snapshot,
          },
        }
      : null),
  }));
  return {
    id: entry.id,
    name: entry.name,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    mode: entry.mode,
    coverId: entry.coverId,
    thumbnail: entry.thumbnail,
    flowers: entry.flowers.map((item) => ({
      assetId: item.assetId,
      name: item.name,
      color: item.color,
      count: item.count,
    })),
    stemCount: entry.stemCount,
    doc: entry.doc,
    photos,
    ...(entry.commission
      ? {
          commission: {
            commissionId: entry.commission.commissionId,
            title: entry.commission.title,
            customer: entry.commission.customer,
            complete: entry.commission.complete,
            metCount: entry.commission.metCount,
            total: entry.commission.total,
            deliveredAt: entry.commission.deliveredAt,
            response: entry.commission.response,
          },
        }
      : null),
  };
}

/** 生成完整相册备份 JSON（只含相册记录，不含凭据）。 */
export function serializeAlbumBackup(
  entries: AlbumEntry[],
  exportedAt = new Date().toISOString(),
): AlbumBackupPayload {
  const file: AlbumBackupFile = {
    format: ALBUM_BACKUP_FORMAT,
    version: ALBUM_BACKUP_VERSION,
    exportedAt,
    schemaVersion: SCHEMA_VERSION,
    entries: entries.map(projectEntry),
  };
  const text = JSON.stringify(file);
  return {
    text,
    bytes: utf8Bytes(text),
    entryCount: file.entries.length,
    photoCount: file.entries.reduce((sum, entry) => sum + entry.photos.length, 0),
  };
}

export interface AlbumRestorePreview {
  exportedAt: string | null;
  backupVersion: number;
  schemaVersion: number | null;
  bytes: number;
  /** 备份里的作品数 / 照片数。 */
  totalEntries: number;
  totalPhotos: number;
  /** 与当前相册比对：新作品、重复作品。 */
  newEntries: number;
  duplicateEntries: number;
  /** 备份里当前相册没有的照片 / 已经存在的照片。 */
  newPhotos: number;
  duplicatePhotos: number;
  /** 重复作品在「跳过重复」模式下因已满 6 照而无法追加的照片数。 */
  skippedPhotos: number;
  /** 按「跳过重复只加新」恢复后会超出 12 件上限的件数（>0 时不能写入）。 */
  overLimit: number;
  /** 校验通过的备份记录（不落盘，仅本次恢复使用）。 */
  entries: AlbumEntry[];
}

export type AlbumRestoreParse =
  | { ok: true; preview: AlbumRestorePreview }
  | { ok: false; message: string };

const MAX_BACKUP_BYTES = 40 * 1024 * 1024;

/** 解析并校验备份文件；不修改当前相册。 */
export function parseAlbumBackup(
  text: string,
  current: AlbumEntry[],
  fallbackAssetsVersion: string,
): AlbumRestoreParse {
  const bytes = utf8Bytes(text);
  if (bytes > MAX_BACKUP_BYTES) {
    return { ok: false, message: '备份文件太大，超过了 40MB，已停止读取，原相册未动' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: '这个文件不是有效的相册备份 JSON，原相册未动' };
  }
  if (!isRecord(raw)) {
    return { ok: false, message: '备份文件内容不对，原相册未动' };
  }
  if (raw.format !== ALBUM_BACKUP_FORMAT) {
    return { ok: false, message: '这不是花间一刻的相册备份文件，原相册未动' };
  }
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, message: '备份文件缺少版本号，原相册未动' };
  }
  if (version > ALBUM_BACKUP_VERSION) {
    return {
      ok: false,
      message: `备份版本 v${version} 比当前相册（v${ALBUM_BACKUP_VERSION}）新，暂时打不开，原相册未动`,
    };
  }
  if (!Array.isArray(raw.entries)) {
    return { ok: false, message: '备份里没有可读取的作品列表，原相册未动' };
  }
  if (raw.entries.length === 0) {
    return { ok: false, message: '这份备份是空的，没有可恢复的作品，原相册未动' };
  }

  const entries: AlbumEntry[] = [];
  const backupIds = new Set<string>();
  let invalid = 0;
  let duplicateInBackup = 0;
  for (const item of raw.entries) {
    const entry = sanitizeAlbumEntry(item, fallbackAssetsVersion);
    if (!entry) {
      invalid += 1;
      continue;
    }
    if (backupIds.has(entry.id)) {
      duplicateInBackup += 1;
      continue;
    }
    backupIds.add(entry.id);
    entries.push(entry);
  }
  if (invalid > 0) {
    return {
      ok: false,
      message: `备份里有 ${invalid} 条作品读不出来，已停止恢复，原相册未动`,
    };
  }
  if (entries.length === 0) {
    return { ok: false, message: '备份里没有可恢复的作品，原相册未动' };
  }

  const currentById = new Map(current.map((entry) => [entry.id, entry]));
  let newEntries = 0;
  let duplicateEntries = duplicateInBackup;
  let newPhotos = 0;
  let duplicatePhotos = 0;
  let skippedPhotos = 0;
  for (const entry of entries) {
    const local = currentById.get(entry.id);
    if (!local) {
      newEntries += 1;
      newPhotos += entry.photos.length;
      continue;
    }
    duplicateEntries += 1;
    const localPhotoIds = new Set(local.photos.map((photo) => photo.id));
    let room = Math.max(0, ALBUM_PHOTOS_PER_ENTRY - local.photos.length);
    for (const photo of entry.photos) {
      if (localPhotoIds.has(photo.id)) {
        duplicatePhotos += 1;
      } else if (room > 0) {
        newPhotos += 1;
        room -= 1;
      } else {
        skippedPhotos += 1;
      }
    }
  }

  const cap = Math.max(ALBUM_LIMIT, current.length);
  const overLimit = Math.max(0, current.length + newEntries - cap);
  const schemaVersion =
    typeof raw.schemaVersion === 'number' && Number.isFinite(raw.schemaVersion)
      ? raw.schemaVersion
      : null;
  const exportedAt = typeof raw.exportedAt === 'string' && raw.exportedAt ? raw.exportedAt : null;

  return {
    ok: true,
    preview: {
      exportedAt,
      backupVersion: version,
      schemaVersion,
      bytes,
      totalEntries: entries.length,
      totalPhotos: entries.reduce((sum, entry) => sum + entry.photos.length, 0),
      newEntries,
      duplicateEntries,
      newPhotos,
      duplicatePhotos,
      skippedPhotos,
      overLimit,
      entries,
    },
  };
}

export type AlbumRestoreMode = 'skip' | 'replace';

export interface AlbumRestorePlanOk {
  ok: true;
  next: AlbumEntry[];
  addedEntries: number;
  addedPhotos: number;
  duplicateEntries: number;
  replacedEntries: number;
  skippedPhotos: number;
}

export interface AlbumRestorePlanFail {
  ok: false;
  reason: 'over-limit';
  excess: number;
}

/** 按玩家选择的保留方式生成恢复后的相册（不写盘）。 */
export function planAlbumRestore(
  current: AlbumEntry[],
  preview: AlbumRestorePreview,
  mode: AlbumRestoreMode,
): AlbumRestorePlanOk | AlbumRestorePlanFail {
  const currentById = new Map(current.map((entry) => [entry.id, entry]));
  const backupById = new Map(preview.entries.map((entry) => [entry.id, entry]));
  const newEntries = preview.entries.filter((entry) => !currentById.has(entry.id));
  let addedPhotos = 0;
  let duplicateEntries = 0;
  let replacedEntries = 0;
  let skippedPhotos = 0;

  let mergedCurrent: AlbumEntry[];
  if (mode === 'replace') {
    mergedCurrent = current.map((local) => {
      const backup = backupById.get(local.id);
      if (!backup) return local;
      replacedEntries += 1;
      return backup;
    });
    addedPhotos = newEntries.reduce((sum, entry) => sum + entry.photos.length, 0);
  } else {
    mergedCurrent = current.map((local) => {
      const backup = backupById.get(local.id);
      if (!backup) return local;
      duplicateEntries += 1;
      const localPhotoIds = new Set(local.photos.map((photo) => photo.id));
      const incoming = backup.photos.filter((photo) => !localPhotoIds.has(photo.id));
      const room = Math.max(0, ALBUM_PHOTOS_PER_ENTRY - local.photos.length);
      const appended = incoming.slice(0, room);
      skippedPhotos += incoming.length - appended.length;
      addedPhotos += appended.length;
      if (appended.length === 0) return local;
      return {
        ...local,
        photos: [...local.photos, ...appended],
        updatedAt: backup.updatedAt || local.updatedAt,
      };
    });
    addedPhotos += newEntries.reduce((sum, entry) => sum + entry.photos.length, 0);
  }

  const next = [...newEntries, ...mergedCurrent];
  const cap = Math.max(ALBUM_LIMIT, current.length);
  if (next.length > cap) {
    return { ok: false, reason: 'over-limit', excess: next.length - cap };
  }
  return {
    ok: true,
    next,
    addedEntries: newEntries.length,
    addedPhotos,
    duplicateEntries,
    replacedEntries,
    skippedPhotos,
  };
}
