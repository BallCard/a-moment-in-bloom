import { CARD_FROM_MAX, CARD_MESSAGE_MAX, CARD_TO_MAX, GRIP_Y, MAX_ORNAMENTS, MAX_STEMS, SCHEMA_VERSION } from '../config';
import {
  DEFAULT_CARD,
  DEFAULT_RIBBON,
  DEFAULT_WRAPPING,
  clampOpenScale,
  clampText,
  defaultPackageStep,
  isPackageStep,
  isPaperId,
  isRibbonColorId,
} from './decor';
import {
  clampPose,
  clampScale,
  derivePoseFromRotation,
  poseToEuler,
} from './pose';
import type { BouquetDocument, CardState, OrnamentInstance, StemInstance, StemPose, Vec3 } from './types';
import { readPreparation, readPresentation, readPhoto } from './presentation';
import { isOrnamentKind } from './ornaments';

export function createEmptyDocument(
  assetsVersion: string,
  sizeCandidate?: BouquetDocument['sizeCandidate'],
): BouquetDocument {
  const now = new Date().toISOString();
  return {
    version: SCHEMA_VERSION,
    assetsVersion,
    ...(sizeCandidate ? { sizeCandidate } : {}),
    createdAt: now,
    updatedAt: now,
    stems: [],
    wrapping: { ...DEFAULT_WRAPPING },
    ribbon: { ...DEFAULT_RIBBON },
    card: { ...DEFAULT_CARD },
    presentation: readPresentation(null, DEFAULT_WRAPPING.paperId),
    photo: readPhoto(null),
    ornaments: [],
  };
}

export function makeStemId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `stem_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
  }
  return `stem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function createStem(options: {
  assetId: string;
  position: Vec3;
  pose: StemPose;
  scale?: number;
}): StemInstance {
  const pose = clampPose(options.pose);
  const scale = clampScale(options.scale ?? 1);
  return {
    id: makeStemId(),
    assetId: options.assetId,
    variant: 0,
    position: [options.position[0], options.position[1], options.position[2]],
    rotation: poseToEuler(pose),
    scale,
    pose,
    preparation: readPreparation(null),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readVec3(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length < 3) return fallback;
  return [finite(value[0], fallback[0]), finite(value[1], fallback[1]), finite(value[2], fallback[2])];
}

function readPose(value: unknown): StemPose | null {
  if (!isRecord(value)) return null;
  const hasAny = ['height', 'tilt', 'direction', 'spin'].some((k) => typeof value[k] === 'number');
  if (!hasAny) return null;
  return clampPose({
    height: finite(value.height, 0),
    tilt: finite(value.tilt, 0),
    direction: finite(value.direction, 0),
    spin: finite(value.spin, 0),
  });
}

function readText(value: unknown, max: number): string {
  return clampText(typeof value === 'string' ? value : '', max);
}

function readWrapping(value: unknown): BouquetDocument['wrapping'] {
  if (!isRecord(value)) return { ...DEFAULT_WRAPPING };
  const enabled = value.enabled === true;
  return {
    enabled,
    paperId: isPaperId(value.paperId) ? value.paperId : DEFAULT_WRAPPING.paperId,
    // v1/v2 存档没有分步字段：已包装的视为做到丝带一步，未包装的停在摆纸。
    step: isPackageStep(value.step) ? value.step : defaultPackageStep(enabled),
    openScale: clampOpenScale(finite(value.openScale, DEFAULT_WRAPPING.openScale)),
  };
}

function readRibbon(value: unknown): BouquetDocument['ribbon'] {
  if (!isRecord(value)) return { ...DEFAULT_RIBBON };
  return {
    colorId: isRibbonColorId(value.colorId) ? value.colorId : DEFAULT_RIBBON.colorId,
  };
}

function readCard(value: unknown): CardState {
  if (!isRecord(value)) return { ...DEFAULT_CARD };
  return {
    to: readText(value.to, CARD_TO_MAX),
    message: readText(value.message, CARD_MESSAGE_MAX),
    from: readText(value.from, CARD_FROM_MAX),
  };
}

/**
 * 读装饰列表（V16 §5）。容错原则与花枝一致：
 * - 只接受已知款式；坏条目跳过，不让整份存档失败；
 * - 位置/大小/亮度夹到可用范围，旧档没有这个字段就是空列表。
 */
function readOrnaments(value: unknown): OrnamentInstance[] {
  if (!Array.isArray(value)) return [];
  const list: OrnamentInstance[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (list.length >= MAX_ORNAMENTS) break;
    if (!isRecord(item)) continue;
    if (!isOrnamentKind(item.kind)) continue;
    let id = typeof item.id === 'string' && item.id.trim() ? item.id.trim().slice(0, 80) : `orn_restored_${list.length}`;
    if (seen.has(id)) id = `${id}_${list.length}`;
    seen.add(id);
    const position = readVec3(item.position, [0, GRIP_Y, 0]);
    list.push({
      id,
      kind: item.kind,
      colorId: typeof item.colorId === 'string' && item.colorId ? item.colorId.slice(0, 20) : 'warm',
      position: [
        Math.min(0.8, Math.max(-0.8, position[0])),
        Math.min(1.5, Math.max(0.2, position[1])),
        Math.min(0.8, Math.max(-0.8, position[2])),
      ],
      rotation: ((finite(item.rotation, 0) % 360) + 360) % 360,
      scale: Math.min(1.3, Math.max(0.7, finite(item.scale, 1))),
      intensity: Math.min(1, Math.max(0, finite(item.intensity, 0.75))),
      variant: Math.max(0, Math.min(2, Math.round(finite(item.variant, 0)))),
    });
  }
  return list;
}

/**
 * 容错读取存档。结构不对、数值越界、版本不符都尽量恢复成可继续编辑的状态，
 * 返回给调用方展示提示。真正的资产是否存在由渲染层再兜底。
 */
export function sanitizeDocument(
  raw: unknown,
  fallbackAssetsVersion: string,
): { doc: BouquetDocument; issues: string[] } {
  const issues: string[] = [];
  const empty = (): BouquetDocument => createEmptyDocument(fallbackAssetsVersion);

  if (!isRecord(raw)) {
    return { doc: empty(), issues: ['存档内容不是有效对象，已新建空白花束'] };
  }

  const version = finite(raw.version, SCHEMA_VERSION);
  if (version > SCHEMA_VERSION) {
    issues.push(`存档版本 v${version} 比当前版本新，已尽量恢复`);
  }
  // v1 → v2：旧存档没有包装/卡片字段，用默认值补齐，不打扰用户。
  // v2 → v3：包装补 step / openScale（已包装视为做到丝带、未包装停在摆纸），同样静默补齐。
  if (!Array.isArray(raw.stems)) {
    if (raw.stems !== undefined) issues.push('花枝列表格式不对，已忽略');
    const doc = empty();
    doc.assetsVersion =
      typeof raw.assetsVersion === 'string' ? raw.assetsVersion : fallbackAssetsVersion;
    return { doc, issues };
  }

  const stems: StemInstance[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let poseFallback = 0;

  for (const item of raw.stems) {
    if (!isRecord(item)) {
      dropped += 1;
      continue;
    }
    if (stems.length >= MAX_STEMS) {
      issues.push(`存档超过 ${MAX_STEMS} 枝，多出来的已忽略`);
      break;
    }
    const assetId = typeof item.assetId === 'string' ? item.assetId.trim() : '';
    if (!assetId) {
      dropped += 1;
      continue;
    }
    let id =
      typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `stem_restored_${stems.length}`;
    if (seen.has(id)) id = `${id}_${stems.length}`;
    seen.add(id);

    const position = readVec3(item.position, [0, GRIP_Y, 0]);
    position[0] = Math.min(0.8, Math.max(-0.8, position[0]));
    position[1] = Math.min(1.5, Math.max(0.2, position[1]));
    position[2] = Math.min(0.8, Math.max(-0.8, position[2]));

    const storedRotation = readVec3(item.rotation, [0, 0, 0]);
    let pose = readPose(item.pose);
    if (!pose) {
      pose = derivePoseFromRotation(storedRotation);
      poseFallback += 1;
    }
    const rotation =
      Array.isArray(item.rotation) && item.rotation.length >= 3
        ? storedRotation
        : poseToEuler(pose);

    stems.push({
      id,
      assetId,
      variant: Math.max(0, Math.round(finite(item.variant, 0))),
      position,
      rotation,
      scale: clampScale(finite(item.scale, 1)),
      pose,
      preparation: readPreparation(item.preparation),
    });
  }

  if (dropped > 0) issues.push(`有 ${dropped} 枝读不出来，已跳过`);
  if (poseFallback > 0) issues.push('部分花枝姿态缺失，已按旋转角恢复');

  const now = new Date().toISOString();
  const doc: BouquetDocument = {
    version: SCHEMA_VERSION,
    assetsVersion:
      typeof raw.assetsVersion === 'string' && raw.assetsVersion
        ? raw.assetsVersion
        : fallbackAssetsVersion,
    // V0.7.3：旧存档没有 sizeCandidate → 记录 undefined，读回按候选 a（原比例）处理；
    // 新作品写入当时默认候选。不在读取时补默认值，避免把旧作品悄悄改成新比例。
    ...(raw.sizeCandidate === 'a' || raw.sizeCandidate === 'b' || raw.sizeCandidate === 'c'
      ? { sizeCandidate: raw.sizeCandidate }
      : {}),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
    stems,
    wrapping: readWrapping(raw.wrapping),
    ribbon: readRibbon(raw.ribbon),
    card: readCard(raw.card),
    presentation: readPresentation(raw.presentation, readWrapping(raw.wrapping).paperId),
    photo: readPhoto(raw.photo),
    ornaments: readOrnaments(raw.ornaments),
  };
  if (stems.length === 0 && raw.stems.length > 0) {
    issues.push('存档里的花枝都没能恢复，已新建空白花束');
  }
  return { doc, issues };
}
