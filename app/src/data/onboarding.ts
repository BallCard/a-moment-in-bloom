/**
 * 新手引导的四步内容与本机状态（V16 §2）。
 *
 * 依据 docs/flower-workflow-upgrade-plan.md §2「新手如何开始」：
 * - 只在当前需要时出现一句话 + 少量可点击候选，不连续弹教程；
 * - 点候选仍然走正常的取花逻辑（组件里调用 store.setPlacement），
 *   **不经过点击不会往作品里加花**；
 * - 主花/配花/叶材的分类从主导航移出后，首轮引导必须讲清这三种用途；
 * - 可跳过、可从帮助入口重看；跳过后不再反复打断；老用户不强制重教；
 * - 没有固定数量、比例或唯一配方，不因偏离示例扣分。
 *
 * 本文件只放数据与 localStorage 读写，不依赖 React。
 */

import { STORAGE_KEY } from '../config';
import type { RuntimeCatalog } from './types';

export type OnboardingStepId = 'flower' | 'companion' | 'greenery' | 'free';

export interface OnboardingCandidate {
  /** 花科 key，取花时用该花科下的第一个配色（尊重花材架里记过的颜色）。 */
  family: string;
  /** 候选下面一句短说明，讲它在这束花里能做什么。 */
  hint: string;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  /** 1–4，界面显示「第 n 步 / 4」。 */
  index: number;
  title: string;
  /** 一句话，只说这一步要做的动作。 */
  line: string;
  /** 搭配用途说明；首轮必须让玩家知道主花/配花/叶材各自干嘛。 */
  purpose: string;
  candidates: OnboardingCandidate[];
  /** new-stem：作品里多一枝就进入下一步；manual：最后一步，等玩家自己结束。 */
  advancesOn: 'new-stem' | 'manual';
  /** 最后一步的结束按钮文案。 */
  finishLabel?: string;
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: 'flower',
    index: 1,
    title: '挑一朵最喜欢的花',
    line: '从这几朵里挑一朵，它会成为这束花的视觉重点。',
    purpose: '主花决定整束花的感觉。先选一朵喜欢的，不用一次想好全部。',
    candidates: [
      { family: 'rose', hint: '层叠花瓣，最稳的焦点' },
      { family: 'tulip', hint: '线条干净，轻盈好搭' },
      { family: 'hydrangea', hint: '一团花球，直接占住画面' },
    ],
    advancesOn: 'new-stem',
  },
  {
    id: 'companion',
    index: 2,
    title: '添一点陪衬',
    line: '再放一枝小花，让主花周围有层次。',
    purpose: '配花用来补空、加层次；小花或线条都行，数量不必多。',
    candidates: [
      { family: 'spray-chrysanthemum', hint: '几个小圆头，补空隙' },
      { family: 'babys-breath', hint: '细碎小点，让画面透气' },
      { family: 'veronica', hint: '一条花穗，拉高线条' },
    ],
    advancesOn: 'new-stem',
  },
  {
    id: 'greenery',
    index: 3,
    title: '试一点叶材',
    line: '加一点叶材，把花的轮廓托起来；不想加也可以跳过。',
    purpose: '叶材衬托花头、组织轮廓，也决定整束看起来松还是紧。',
    candidates: [
      { family: 'eucalyptus', hint: '细碎圆叶，最百搭' },
      { family: 'ruscus', hint: '硬一点的假叶，撑住轮廓' },
      { family: 'salal', hint: '大叶托底，显体量' },
    ],
    advancesOn: 'new-stem',
  },
  {
    id: 'free',
    index: 4,
    title: '看看整体，继续自由调整',
    line: '现在这束花已经能看了。没有固定的数量、比例或唯一配方，按你喜欢继续加。',
    purpose: '可以继续加花、挪位置、换颜色；拿错了随时撤销，不会因为和示例不一样而扣分。',
    candidates: [],
    advancesOn: 'manual',
    finishLabel: '好的，自由调整',
  },
];

/** 引导的本机记录键（与作品 JSON、hints.ts 的键分开）。 */
export const ONBOARDING_KEY = 'bouquet-workbench.onboarding.v1';

export interface OnboardingRecord {
  /** 走完第 4 步或点「完成」后为 true。 */
  done: boolean;
  /** 玩家主动跳过（与走完区分：跳过的老用户也不该再次被自动教学）。 */
  skipped: boolean;
  /** 停在第几步。 */
  step: OnboardingStepId;
  updatedAt: string;
}

export function stepById(id: OnboardingStepId): OnboardingStep {
  return ONBOARDING_STEPS.find((step) => step.id === id) ?? ONBOARDING_STEPS[0];
}

/** 读本机引导记录；读不到/格式不对一律当「没有记录」。 */
export function readOnboardingRecord(): OnboardingRecord | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(ONBOARDING_KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return null;
    const record = raw as Record<string, unknown>;
    if (typeof record.done !== 'boolean') return null;
    return {
      done: record.done,
      skipped: record.skipped === true,
      step:
        record.step === 'flower' ||
        record.step === 'companion' ||
        record.step === 'greenery' ||
        record.step === 'free'
          ? record.step
          : 'flower',
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    };
  } catch {
    return null;
  }
}

/** 写引导记录；隐私模式下写不进也不影响本次会话。 */
export function writeOnboardingRecord(
  record: Pick<OnboardingRecord, 'done' | 'skipped' | 'step'>,
): OnboardingRecord {
  const next: OnboardingRecord = { ...record, updatedAt: new Date().toISOString() };
  try {
    localStorage.setItem(ONBOARDING_KEY, JSON.stringify(next));
  } catch {
    /* 记不住就这次先算数，不打断玩家 */
  }
  return next;
}

/** 一边看一边记进度：保留 done/skipped，只更新 step。 */
export function rememberOnboardingStep(id: OnboardingStepId): OnboardingRecord {
  const current = readOnboardingRecord();
  return writeOnboardingRecord({
    done: current?.done ?? false,
    skipped: current?.skipped ?? false,
    step: id,
  });
}

/** 老用户判定：本机已有作品、已经放过花，或者已经完成/跳过过引导。 */
export function isReturningUser(): boolean {
  const record = readOnboardingRecord();
  if (record) return true;
  try {
    if (localStorage.getItem('bouquet.first-flower-placed') === '1') return true;
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (typeof raw === 'object' && raw !== null) {
      const stems = (raw as Record<string, unknown>).stems;
      if (Array.isArray(stems) && stems.length > 0) return true;
    }
  } catch {
    /* localStorage 不可用时按新用户处理，但只提示一次（见组件里的 session 标记） */
  }
  return false;
}

/**
 * 从当前目录里取某个花科的第一个可用配色 assetId。
 * 先按花材架记过的颜色（`bouquet.palette-colors`）选，再退回第一个配色，
 * 这样引导候选和玩家自己在花架上挑到的是同一种颜色。
 */
export function candidateAssetId(catalog: RuntimeCatalog, family: string): string | null {
  const group = catalog.families.find((item) => item.family === family);
  if (!group || group.entries.length === 0) return null;
  let remembered: Record<string, string> | null = null;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem('bouquet.palette-colors') ?? 'null');
    if (raw && typeof raw === 'object') remembered = raw as Record<string, string>;
  } catch {
    remembered = null;
  }
  const preferred = remembered?.[family];
  return group.entries.find((entry) => entry.assetId === preferred)?.assetId ?? group.entries[0].assetId;
}
