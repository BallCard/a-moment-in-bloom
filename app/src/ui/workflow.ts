/**
 * 界面层用到的阶段 / 包装 / 辅助状态约定（见 docs/round-plan.md 3.1、3.3）。
 *
 * 状态与数据由 `state/store`、`data/types` 提供；这里只做 UI 侧的读取封装、
 * 文案顺序和一些跨组件的固定值，避免各组件各自拼一份。
 */

import { MAX_SUGGESTIONS, PAPER_OPEN_SCALE_MAX, PAPER_OPEN_SCALE_MIN } from '../config';
import type {
  AssistSettings,
  MotionPreference,
  PackageStep,
  SuggestionCandidate,
  SuggestionKind,
  WorkflowStage,
} from '../data/types';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';
import { useEffect, useState } from 'react';

export type {
  AssistSettings,
  MotionPreference,
  PackageStep,
  SelectionAnchor,
  SuggestionCandidate,
  SuggestionKind,
  WorkflowStage,
} from '../data/types';

// ---------- 会话状态读取 ----------

export const useStage = (): WorkflowStage => useAppState((state) => state.stage);

export const useAssistSnapping = (): boolean => useAppState((state) => state.assist.snapping);

export const useAssistSuggestions = (): boolean => useAppState((state) => state.assist.suggestions);

export const useMotion = (): MotionPreference => useAppState((state) => state.motion);

export const useSuggestions = (): SuggestionCandidate[] =>
  useAppState((state) => state.suggestions);

export const useActiveSuggestionId = (): string | null =>
  useAppState((state) => state.activeSuggestionId);

export const usePinnedSuggestionId = (): string | null =>
  useAppState((state) => state.pinnedSuggestionId);

export const useSelectionAnchor = () => useAppState((state) => state.selectionAnchor);

export const useShowcase = (): boolean => useAppState((state) => state.showcase);

export interface WrappingView {
  enabled: boolean;
  paperId: import('../data/types').PaperId;
  step: PackageStep;
  openScale: number;
}

/** 包装状态。 */
export function useWrapping(): WrappingView {
  const wrapping = useAppState((state) => state.doc.wrapping);
  return {
    enabled: wrapping.enabled,
    paperId: wrapping.paperId,
    step: wrapping.step,
    openScale: wrapping.openScale,
  };
}

/** 在事件回调里读当前是否在欣赏模式（不订阅，取最新值）。 */
export function isShowcaseActive(): boolean {
  return store.getState().showcase;
}

/** 减少动态效果：本机开关（store.motion）或系统偏好任一成立即生效。 */
export function useReducedMotion(): boolean {
  const motion = useMotion();
  const [prefers, setPrefers] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (): void => setPrefers(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return motion === 'reduced' || prefers;
}

// ---------- 会话动作 ----------

/** 切阶段；wrap 走 enterWrap（无花枝时会被拒绝，UI 留在原地）。 */
export function goToStage(stage: WorkflowStage): boolean {
  if (stage === 'wrap') return store.enterWrap();
  store.setStage(stage);
  return true;
}

export function setAssist(partial: Partial<AssistSettings>): void {
  store.setAssist(partial);
}

export function setMotion(motion: MotionPreference): void {
  store.setMotion(motion);
}

export function pinSuggestion(id: string | null): void {
  store.pinSuggestion(id);
}

/** 就近微调：增量语义，一次点击 = 一条撤销记录（见 docs/round-plan.md 3.3）。 */
export function nudgeSelected(partial: Parameters<typeof store.nudgeSelected>[0]): void {
  store.nudgeSelected(partial);
}

export function setPackageStep(step: PackageStep): boolean {
  return store.setPackageStep(step);
}

export function setPaperOpenScale(scale: number): void {
  store.setPaperOpenScale(scale);
}

export function startShowcase(): void {
  store.startShowcase();
}

export function stopShowcase(): void {
  store.stopShowcase();
}

// ---------- 文案与顺序 ----------

export const STAGE_ORDER: WorkflowStage[] = ['arrange', 'wrap', 'finish'];

export const STAGE_LABEL: Record<WorkflowStage, string> = {
  arrange: '摆花',
  wrap: '包装与花器',
  finish: '拍照',
};

export const STAGE_HINT: Record<WorkflowStage, string> = {
  arrange: '选花、摆位、微调',
  wrap: '选纸、合拢、装饰、卡片',
  finish: '欣赏与导出',
};

export interface PackageStepInfo {
  id: PackageStep;
  index: number;
  label: string;
  hint: string;
}

export const PACKAGE_STEP_INFO: PackageStepInfo[] = [
  { id: 'paper', index: 1, label: '选纸摆纸', hint: '挑纸色，调纸口大小' },
  { id: 'fold', index: 2, label: '合拢收口', hint: '纸张往内收，包住花茎' },
  // V16 §5：「系丝带」扩为「装饰」——只呈现当前形态实际支持的选项。
  { id: 'ribbon', index: 3, label: '装饰', hint: '按这个形态能加的东西挑一点' },
  { id: 'card', index: 4, label: '卡片成品', hint: '写一张小卡片' },
];

export function packageStepIndex(step: PackageStep): number {
  const found = PACKAGE_STEP_INFO.find((item) => item.id === step);
  return found ? found.index : 1;
}

export function nextPackageStep(step: PackageStep): PackageStep | null {
  const index = PACKAGE_STEP_INFO.findIndex((item) => item.id === step);
  return index >= 0 && index < PACKAGE_STEP_INFO.length - 1 ? PACKAGE_STEP_INFO[index + 1].id : null;
}

export function previousPackageStep(step: PackageStep): PackageStep | null {
  const index = PACKAGE_STEP_INFO.findIndex((item) => item.id === step);
  return index > 0 ? PACKAGE_STEP_INFO[index - 1].id : null;
}

export const SUGGESTION_KIND_LABEL: Record<SuggestionKind, string> = {
  gap: '补空隙',
  showcase: '露主花',
  layer: '添层次',
};

export const MAX_SUGGESTION_CARDS: number = MAX_SUGGESTIONS;
export const PAPER_OPEN_MIN: number = PAPER_OPEN_SCALE_MIN;
export const PAPER_OPEN_MAX: number = PAPER_OPEN_SCALE_MAX;

/** 阶段切换时给右栏选一个有意义的默认标签。 */
export type RightTab = 'inspect' | 'decor';

export function defaultTabFor(stage: WorkflowStage): RightTab {
  return stage === 'arrange' ? 'inspect' : 'decor';
}
