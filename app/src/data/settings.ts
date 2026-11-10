/**
 * 本机会话设置的默认值与容错读取。
 *
 * 辅助开关（吸附 / 建议）、动态偏好、预设视角和已完成委托属于「这台电脑上怎么用」，
 * 不属于作品内容：它们写在独立的 SETTINGS_KEY 里，不进入作品 JSON、不参与撤销、不影响导出。
 */

import { DEFAULT_AUDIO_VOLUME } from '../config';
import type { AssistSettings, AudioSettings, GameMode, MotionPreference, ViewPreset } from './types';

export const DEFAULT_ASSIST: AssistSettings = { snapping: true, suggestions: true };
export const DEFAULT_MOTION: MotionPreference = 'auto';
export const DEFAULT_VIEW_PRESET: ViewPreset = 'quarter';
export const DEFAULT_MODE: GameMode = 'free';
export const DEFAULT_AUDIO: AudioSettings = { muted: false, volume: DEFAULT_AUDIO_VOLUME, bgm: true };

/** 工作台上的委托上下文：刷新后接着做，而不是掉回自由模式。 */
export interface StoredCommissionSession {
  id: string;
  deliveredAt: string | null;
  response: string | null;
}

export function readGameMode(value: unknown): GameMode {
  return value === 'commission' ? 'commission' : DEFAULT_MODE;
}

/** 读制作中的委托上下文；id 缺失/类型不对就当没有。 */
export function readCommissionSession(value: unknown): StoredCommissionSession | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id.trim()) return null;
  const deliveredAt = typeof record.deliveredAt === 'string' ? record.deliveredAt : null;
  const response = typeof record.response === 'string' ? record.response : null;
  return { id: record.id, deliveredAt, response };
}

export function isMotionPreference(value: unknown): value is MotionPreference {
  return value === 'auto' || value === 'reduced';
}

export function isViewPreset(value: unknown): value is ViewPreset {
  return value === 'front' || value === 'quarter' || value === 'side' || value === 'top' || value === 'free';
}

/** 读辅助开关：缺字段或类型不对时用默认值，绝不因为存档坏掉而丢掉另一个开关。 */
export function readAssistSettings(value: unknown): AssistSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...DEFAULT_ASSIST };
  }
  const record = value as Record<string, unknown>;
  return {
    snapping: typeof record.snapping === 'boolean' ? record.snapping : DEFAULT_ASSIST.snapping,
    suggestions:
      typeof record.suggestions === 'boolean' ? record.suggestions : DEFAULT_ASSIST.suggestions,
  };
}

export function readMotionPreference(value: unknown): MotionPreference {
  return isMotionPreference(value) ? value : DEFAULT_MOTION;
}

/** 视角预设：v1 设置没有这个字段，回落默认的斜 45°。 */
export function readViewPreset(value: unknown): ViewPreset {
  return isViewPreset(value) ? value : DEFAULT_VIEW_PRESET;
}

/** 读音频偏好：只在 0–1 之间接受音量；旧版本没有 bgm 字段时默认开启。 */
export function readAudioSettings(value: unknown): AudioSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...DEFAULT_AUDIO };
  }
  const record = value as Record<string, unknown>;
  const volume =
    typeof record.volume === 'number' && Number.isFinite(record.volume)
      ? Math.min(1, Math.max(0, record.volume))
      : DEFAULT_AUDIO.volume;
  return {
    muted: record.muted === true,
    volume,
    bgm: record.bgm !== false,
  };
}

/** 已完成委托 id 列表：只接受字符串，去重并夹到 20 条。 */
export function readCompletedCommissions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) continue;
    if (!ids.includes(item)) ids.push(item);
    if (ids.length >= 20) break;
  }
  return ids;
}
