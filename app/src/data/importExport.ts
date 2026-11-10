/**
 * 作品 JSON 的导出与导入校验。
 *
 * 导入原则：先完整校验、一次性应用；任何一步失败都抛 ImportError，
 * 调用方不得改动当前作品。这样损坏/旧版本文件不会覆盖用户正在编辑的花束。
 */

import { MAX_STEMS, SCHEMA_VERSION } from '../config';
import { sanitizeDocument } from './document';
import type { BouquetDocument, RuntimeCatalog } from './types';

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ImportPreview {
  doc: BouquetDocument;
  /** 文件里写的结构版本。 */
  sourceVersion: number;
  sourceAssetsVersion: string;
  /** 自动修正/兼容时的提示。 */
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function serializeDocument(doc: BouquetDocument): string {
  return JSON.stringify(doc, null, 2);
}

export function parseImportedDocument(text: string, catalog: RuntimeCatalog): ImportPreview {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ImportError('这个文件不是有效的作品 JSON，当前作品没动');
  }
  if (!isRecord(raw)) {
    throw new ImportError('作品文件内容不对，当前作品没动');
  }

  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new ImportError('作品文件缺少版本号，导入已取消，当前作品没动');
  }
  if (version > SCHEMA_VERSION) {
    throw new ImportError(
      `作品版本 v${version} 比当前工作台（v${SCHEMA_VERSION}）新，暂时打不开，当前作品没动`,
    );
  }

  if (!Array.isArray(raw.stems)) {
    throw new ImportError('作品里没有可读取的花枝列表，导入已取消，当前作品没动');
  }
  if (raw.stems.length > MAX_STEMS) {
    throw new ImportError(
      `作品有 ${raw.stems.length} 枝花，超过 ${MAX_STEMS} 枝上限，导入已取消，当前作品没动`,
    );
  }

  const missingAssets: string[] = [];
  for (const item of raw.stems) {
    if (!isRecord(item) || typeof item.assetId !== 'string' || !item.assetId.trim()) {
      throw new ImportError('作品里有花枝数据读不出来，导入已取消，当前作品没动');
    }
    const assetId = item.assetId.trim();
    if (!catalog.entriesById[assetId] && !missingAssets.includes(assetId)) {
      missingAssets.push(assetId);
    }
  }
  if (missingAssets.length > 0) {
    const preview = missingAssets.slice(0, 3).join('、');
    const suffix = missingAssets.length > 3 ? ' 等' : '';
    throw new ImportError(
      `作品里有当前清单没有的花材（${preview}${suffix}），导入已取消，当前作品没动`,
    );
  }

  const { doc, issues } = sanitizeDocument(raw, catalog.assetsVersion);
  if (doc.stems.length !== raw.stems.length) {
    throw new ImportError(
      `作品里有 ${raw.stems.length - doc.stems.length} 枝数据不完整，导入已取消，当前作品没动`,
    );
  }

  const warnings = [...issues];
  if (version < SCHEMA_VERSION) {
    warnings.push(`这是旧版 v${version} 作品，已自动补齐包装、丝带、卡片和分步包装字段`);
  }

  return {
    doc,
    sourceVersion: version,
    sourceAssetsVersion:
      typeof raw.assetsVersion === 'string' && raw.assetsVersion
        ? raw.assetsVersion
        : '未知',
    warnings,
  };
}
