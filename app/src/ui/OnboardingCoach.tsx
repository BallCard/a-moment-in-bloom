/**
 * 新手引导（V16 §2）：四步「挑花 → 陪衬 → 叶材 → 自由调整」。
 *
 * 原则（docs/flower-workflow-upgrade-plan.md §2）：
 * - 只在当前需要时出现一句话 + 少量可点击候选，不连续弹教程；
 * - 点候选只是**进入取花（放置）状态**，和点花材卡完全同一条路径；
 *   不经过点击不会往作品里加花；
 * - 首轮把主花 / 配花 / 叶材的用途讲清楚（每步的 purpose）；
 * - 可跳过、可从帮助入口重看（监听 `bouquet:onboarding-replay`）；
 *   跳过后不再自动出现；老用户（本机已有作品 / 已跳过）不强制重教；
 * - 与 EmptyGuide 的「第一次放花」提示不重复：引导激活时给 <html> 加
 *   `onboarding-active`，由 onboarding.css 临时收起那条既有提示
 *   （不改 EmptyGuide 组件本身）。
 *
 * 挂载方式：由 PalettePanel 通过 portal 挂到 body，不依赖 App.tsx。
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  candidateAssetId,
  isReturningUser,
  ONBOARDING_STEPS,
  readOnboardingRecord,
  rememberOnboardingStep,
  stepById,
  writeOnboardingRecord,
  type OnboardingStepId,
} from '../data/onboarding';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';
import { useReducedMotion } from './workflow';
import './onboarding.css';

export interface OnboardingSnapshot {
  active: boolean;
  stepId: OnboardingStepId;
}

interface OnboardingDebugApi {
  active: () => boolean;
  step: () => OnboardingStepId;
  replay: () => void;
  skip: () => void;
  finish: () => void;
}

declare global {
  interface Window {
    __bouquetOnboarding?: OnboardingDebugApi;
  }
}

// ---------- 模块级状态：引导激活时花材架要据此高亮候选 ----------

let snapshot: OnboardingSnapshot = { active: false, stepId: 'flower' };
const listeners = new Set<() => void>();

function emit(next: OnboardingSnapshot): void {
  if (next.active === snapshot.active && next.stepId === snapshot.stepId) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 花材架读取：引导是否激活、当前在第几步（候选高亮用）。 */
export function useOnboardingSnapshot(): OnboardingSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

/** 当前引导步骤的候选花科：花材架据此把对应卡片高亮出来。 */
export function useOnboardingHighlight(): { active: boolean; families: string[] } {
  const state = useOnboardingSnapshot();
  const step = stepById(state.stepId);
  return {
    active: state.active,
    families: state.active ? step.candidates.map((candidate) => candidate.family) : [],
  };
}

const onboardingController = {
  start(stepId: OnboardingStepId = 'flower'): void {
    emit({ active: true, stepId });
  },
  goTo(stepId: OnboardingStepId): void {
    emit({ active: true, stepId });
  },
  stop(): void {
    emit({ active: false, stepId: snapshot.stepId });
  },
};

/**
 * 引导浮层。由 PalettePanel 挂 body：
 * `<KnowledgeCardHost />` 之外再渲染 `<OnboardingCoach />`。
 */
export function OnboardingCoach(): React.JSX.Element | null {
  const reducedMotion = useReducedMotion();
  const stage = useAppState((state) => state.stage);
  const catalog = useAppState((state) => state.catalog);
  const stemCount = useAppState((state) => state.doc.stems.length);
  // 修剪/切线时引导不出现：那几步要点画布上的花茎，浮层不能挡三维操作。
  const trimMode = useAppState((state) => state.trimMode);
  const state = useOnboardingSnapshot();
  const [pickedFamily, setPickedFamily] = useState<string | null>(null);
  const baselineRef = useRef(0);

  // 首次挂载：老用户不教；新用户等画面稳定后出现第一步。
  useEffect(() => {
    const rememberBaseline = (): number => {
      baselineRef.current = store.getState().doc.stems.length;
      return baselineRef.current;
    };

    const onReplay = (): void => {
      setPickedFamily(null);
      rememberBaseline();
      onboardingController.start('flower');
    };
    window.addEventListener('bouquet:onboarding-replay', onReplay);
    window.__bouquetOnboarding = {
      active: () => snapshot.active,
      step: () => snapshot.stepId,
      replay: onReplay,
      skip: () => {
        const record = readOnboardingRecord();
        writeOnboardingRecord({ done: true, skipped: true, step: record?.step ?? 'flower' });
        onboardingController.stop();
      },
      finish: () => {
        writeOnboardingRecord({ done: true, skipped: false, step: 'free' });
        onboardingController.stop();
      },
    };

    const current = store.getState();
    const shouldAutoStart =
      current.stage === 'arrange' && current.doc.stems.length === 0 && !readOnboardingRecord() && !isReturningUser();
    let timer = 0;
    if (shouldAutoStart) {
      rememberBaseline();
      timer = window.setTimeout(() => onboardingController.start('flower'), 420);
    }
    return () => {
      window.removeEventListener('bouquet:onboarding-replay', onReplay);
      window.clearTimeout(timer);
      delete window.__bouquetOnboarding;
    };
  }, []);

  // 激活期间给 <html> 打标记：onboarding.css 据此临时收起 EmptyGuide 的既有第一次提示。
  useEffect(() => {
    if (!state.active) return undefined;
    document.documentElement.classList.add('onboarding-active');
    return () => document.documentElement.classList.remove('onboarding-active');
  }, [state.active]);

  // 完成一步：作品里多了一枝就进入下一步（不评分配置，只看有没有动手）。
  useEffect(() => {
    if (!state.active) return;
    const step = stepById(state.stepId);
    if (step.advancesOn !== 'new-stem') return;
    if (stemCount <= baselineRef.current) return;
    const next = ONBOARDING_STEPS[step.index];
    baselineRef.current = stemCount;
    setPickedFamily(null);
    if (!next) {
      writeOnboardingRecord({ done: true, skipped: false, step: 'free' });
      onboardingController.stop();
      return;
    }
    rememberOnboardingStep(next.id);
    onboardingController.goTo(next.id);
  }, [stemCount, state.active, state.stepId]);

  // 换阶段/离开摆花时收起引导（不写入记录，下次回到摆花还会出现）。
  useEffect(() => {
    if (stage === 'arrange') return;
    setPickedFamily(null);
    onboardingController.stop();
  }, [stage]);

  if (!state.active || stage !== 'arrange' || trimMode) return null;

  const step = stepById(state.stepId);
  const familyName = (family: string): string =>
    catalog.families.find((item) => item.family === family)?.displayName ?? family;
  const familyColor = (family: string): string =>
    catalog.families.find((item) => item.family === family)?.entries[0]?.color ?? '#cbc2b3';

  const takeCandidate = (family: string): void => {
    const assetId = candidateAssetId(catalog, family);
    if (!assetId) return;
    // 沿用正常取花逻辑：只是进入放置模式，玩家点了工作台才真的落一枝。
    store.setPlacement(assetId);
    setPickedFamily(family);
  };

  const finish = (): void => {
    writeOnboardingRecord({ done: true, skipped: false, step: 'free' });
    setPickedFamily(null);
    onboardingController.stop();
  };

  const skip = (): void => {
    const current = readOnboardingRecord();
    writeOnboardingRecord({ done: true, skipped: true, step: current?.step ?? step.id });
    setPickedFamily(null);
    onboardingController.stop();
  };

  return createPortal(
    <section
      className="onboarding-coach"
      data-testid="onboarding-coach"
      data-step={step.id}
      data-motion={reducedMotion ? 'reduced' : undefined}
      role="note"
      aria-live="polite"
      aria-label="新手引导"
    >
      <div className="coach-head">
        <span className="coach-progress" data-testid="onboarding-progress">
          第 {step.index}/4 步 · {step.title}
        </span>
        <button type="button" className="coach-skip" data-testid="onboarding-skip" onClick={skip}>
          跳过引导
        </button>
      </div>
      <p className="coach-line" data-testid="onboarding-line">
        {step.line}
      </p>
      <p className="coach-purpose" data-testid="onboarding-purpose">
        {step.purpose}
      </p>
      {step.candidates.length ? (
        <div className="coach-candidates" data-testid="onboarding-candidates" role="group" aria-label="可以试试的花材">
          {step.candidates.map((candidate) => (
            <button
              key={candidate.family}
              type="button"
              className={`coach-candidate ${pickedFamily === candidate.family ? 'is-picked' : ''}`}
              data-testid={`onboarding-candidate-${candidate.family}`}
              data-family={candidate.family}
              title={candidate.hint}
              onClick={() => takeCandidate(candidate.family)}
            >
              <span className="coach-candidate-dot" style={{ background: familyColor(candidate.family) }} aria-hidden="true" />
              {familyName(candidate.family)}
            </button>
          ))}
        </div>
      ) : null}
      {pickedFamily ? (
        <p className="coach-picked" data-testid="onboarding-picked">
          已经拿在手上：点一下工作台把它放下，就会进入下一步。
        </p>
      ) : null}
      {step.advancesOn === 'manual' ? (
        <button type="button" className="coach-finish" data-testid="onboarding-finish" onClick={finish}>
          {step.finishLabel ?? '开始自由调整'}
        </button>
      ) : null}
    </section>,
    document.body,
  );
}
