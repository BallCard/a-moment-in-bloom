/**
 * 摆放建议位的校验与比较。
 *
 * 候选由场景（app/src/placement/**）按当前花束实时计算，store 只接收并存放：
 * 这里做一次轻量清理（丢弃形状不对的项、夹紧理由字数、限量、去重），
 * 但**不改动**姿态和花头坐标 —— 否则 3D 里画出的花影与实际落点会对不上。
 */

import { MAX_SUGGESTIONS } from '../config';
import { clampText } from './decor';
import type { SuggestionCandidate, SuggestionKind } from './types';

/** 建议理由的口径：中文一句，≤ 18 字。 */
export const SUGGESTION_REASON_MAX = 18;

export function isSuggestionKind(value: unknown): value is SuggestionKind {
  return value === 'gap' || value === 'showcase' || value === 'layer';
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 清理一批候选：最多 MAX_SUGGESTIONS 个，id 重复的只保留第一个。
 * pose 缺字段时补 0（与 document.ts 读档口径一致），花头坐标读不出来才丢弃。
 */
export function sanitizeSuggestionList(list: unknown): SuggestionCandidate[] {
  if (!Array.isArray(list)) return [];
  const result: SuggestionCandidate[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (result.length >= MAX_SUGGESTIONS) break;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || seen.has(id)) continue;
    const kind = record.kind;
    if (!isSuggestionKind(kind)) continue;

    const poseRaw = record.pose;
    if (typeof poseRaw !== 'object' || poseRaw === null || Array.isArray(poseRaw)) continue;
    const pose = poseRaw as Record<string, unknown>;
    const hasPoseValue = ['height', 'tilt', 'direction'].some(
      (key) => typeof pose[key] === 'number',
    );
    if (!hasPoseValue) continue;

    const head = record.head;
    if (!Array.isArray(head) || head.length < 3) continue;
    const hx = head[0];
    const hy = head[1];
    const hz = head[2];
    if (
      typeof hx !== 'number' ||
      !Number.isFinite(hx) ||
      typeof hy !== 'number' ||
      !Number.isFinite(hy) ||
      typeof hz !== 'number' ||
      !Number.isFinite(hz)
    ) {
      continue;
    }

    seen.add(id);
    result.push({
      id,
      kind,
      pose: {
        height: finite(pose.height, 0),
        tilt: finite(pose.tilt, 0),
        direction: finite(pose.direction, 0),
      },
      head: [hx, hy, hz],
      reason: clampText(typeof record.reason === 'string' ? record.reason : '', SUGGESTION_REASON_MAX),
    });
  }
  return result;
}

/** 两批建议是否完全相同（数量、顺序、id、姿态、坐标、理由、类型）。 */
export function sameSuggestions(
  a: readonly SuggestionCandidate[],
  b: readonly SuggestionCandidate[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left.id !== right.id || left.kind !== right.kind || left.reason !== right.reason) {
      return false;
    }
    if (
      left.pose.height !== right.pose.height ||
      left.pose.tilt !== right.pose.tilt ||
      left.pose.direction !== right.pose.direction
    ) {
      return false;
    }
    if (
      left.head[0] !== right.head[0] ||
      left.head[1] !== right.head[1] ||
      left.head[2] !== right.head[2]
    ) {
      return false;
    }
  }
  return true;
}
