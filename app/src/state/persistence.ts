/** localStorage 读写。所有异常都在这里吞掉，避免影响页面启动。 */

import { BUILTIN_ASSETS_VERSION, SETTINGS_KEY, STORAGE_KEY } from '../config';
import { sanitizeDocument } from '../data/document';
import {
  DEFAULT_ASSIST,
  DEFAULT_AUDIO,
  DEFAULT_MODE,
  DEFAULT_MOTION,
  DEFAULT_VIEW_PRESET,
  readAssistSettings,
  readAudioSettings,
  readCommissionSession,
  readCompletedCommissions,
  readGameMode,
  readMotionPreference,
  readViewPreset,
  type StoredCommissionSession,
} from '../data/settings';
import type { AssistSettings, AudioSettings, BouquetDocument, GameMode, MotionPreference, ViewPreset } from '../data/types';

export interface LoadResult {
  doc: BouquetDocument | null;
  issues: string[];
}

/** 本机会话设置 v4：辅助开关 + 动态偏好 + 预设视角 + 已完成委托 + 制作中的委托上下文 + 音频偏好。 */
export interface StoredSettings {
  assist: AssistSettings;
  motion: MotionPreference;
  viewPreset: ViewPreset;
  completedCommissions: string[];
  mode: GameMode;
  commission: StoredCommissionSession | null;
  audio: AudioSettings;
}

export function defaultSettings(): StoredSettings {
  return {
    assist: { ...DEFAULT_ASSIST },
    motion: DEFAULT_MOTION,
    viewPreset: DEFAULT_VIEW_PRESET,
    completedCommissions: [],
    mode: DEFAULT_MODE,
    commission: null,
    audio: { ...DEFAULT_AUDIO },
  };
}

export function loadStoredDocument(): LoadResult {
  if (typeof localStorage === 'undefined') return { doc: null, issues: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { doc: null, issues: [] };
    const parsed: unknown = JSON.parse(raw);
    return sanitizeDocument(parsed, BUILTIN_ASSETS_VERSION);
  } catch {
    return { doc: null, issues: ['本地存档读不出来，已新建空白花束'] };
  }
}

export function saveStoredDocument(doc: BouquetDocument): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
    return true;
  } catch {
    return false;
  }
}

/**
 * 读本机设置。读不出来就静默回落默认值：
 * 辅助开关坏了不值得打断用户，更不该让页面启动失败。
 * v1 只有 assist / motion，缺的字段按默认值补齐。
 */
export function loadStoredSettings(): StoredSettings {
  const defaults = defaultSettings();
  if (typeof localStorage === 'undefined') return defaults;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaults;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return defaults;
    const record = parsed as Record<string, unknown>;
    return {
      assist: readAssistSettings(record.assist),
      motion: readMotionPreference(record.motion),
      viewPreset: readViewPreset(record.viewPreset),
      completedCommissions: readCompletedCommissions(record.completedCommissions),
      mode: readGameMode(record.mode),
      commission: readCommissionSession(record.commission),
      audio: readAudioSettings(record.audio),
    };
  } catch {
    return defaults;
  }
}

/** 写本机设置；失败（隐私模式 / 空间不足）静默忽略。 */
export function saveStoredSettings(settings: StoredSettings): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}
