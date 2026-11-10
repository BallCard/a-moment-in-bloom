/**
 * 花材知识浮窗（V16 §4）。
 *
 * 交互（严格按计划 §4）：
 * - 鼠标进入花材卡约 300ms 后在右侧原调整区位置出现磨砂浮窗；
 * - 同一张卡连续悬停满 2 秒（从进入计时）固定；未满 2 秒移开消失；
 *   快速经过其他花材时重置计时；
 * - 固定后可移入阅读/滚动，不因经过其他花材换内容；
 * - 点击浮窗外 / 关闭按钮 / Esc 关闭；空白点击只关闭、不穿透三维操作；
 *   点另一张花材先关闭，再照常执行取花点击；开始拖取立即取消预览与计时；
 * - 打开前的选中、相机与调整状态完全不动（本组件不调用任何文档写方法）；
 * - 窄屏/触屏走卡片上的「了解」入口打开同一内容；键盘可进入和退出，
 *   关闭后焦点回到触发按钮。
 *
 * 挂载方式：本文件导出 `KnowledgeCardHost`，由 PalettePanel 通过 portal 挂到 body，
 * 不依赖 App.tsx；悬停计时用模块级控制器，花材架只需要调用 `knowledgePanel`。
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { KNOWLEDGE_PIN_DELAY_MS, KNOWLEDGE_PREVIEW_DELAY_MS } from '../config';
import { categoryLabel, categoryOf } from '../data/categories';
import { KIND_LABEL } from '../data/catalog';
import {
  KNOWLEDGE_CARE_NOTE,
  KNOWLEDGE_IMAGE_NOTE,
  KNOWLEDGE_MEANING_NOTE,
  knowledgeFamilies,
  knowledgeFor,
  sourceLabel,
  type FlowerKnowledge,
} from '../data/knowledge';
import type { AssetEntry } from '../data/types';
import { useAppState } from '../state/useStore';
import { ModelThumbnail } from './ModelThumbnail';
import { useReducedMotion } from './workflow';
import './knowledge-card.css';

export type KnowledgePhase = 'hidden' | 'preview' | 'pinned';

export interface KnowledgeSnapshot {
  phase: KnowledgePhase;
  family: string | null;
}

interface KnowledgeDebugApi {
  phase: () => KnowledgePhase;
  family: () => string | null;
  open: (family: string) => void;
  close: (reason?: string) => void;
  /** 内容自检入口：32 花型的三节内容与来源（验收脚本用，只读）。 */
  families: () => string[];
  entry: (family: string) => ReturnType<typeof knowledgeFor>;
}

declare global {
  interface Window {
    __bouquetKnowledge?: KnowledgeDebugApi;
  }
}

// ---------- 模块级控制器：花材架悬停 / 了解按钮 / 关闭共用同一份状态 ----------

let snapshot: KnowledgeSnapshot = { phase: 'hidden', family: null };
const listeners = new Set<() => void>();
let previewTimer: number | null = null;
let pinTimer: number | null = null;
/** 当前指针停留的花材卡（用来判断计时是否仍然有效）。 */
let hoveredFamily: string | null = null;
/** 通过「了解」入口打开时，关闭后要还回焦点的元素。 */
let returnFocus: HTMLElement | null = null;
/** 下一次打开时是否把焦点移进浮窗（键盘进入时）。 */
let focusInsideOnOpen = false;

function emit(next: KnowledgeSnapshot): void {
  if (next.phase === snapshot.phase && next.family === snapshot.family) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function clearTimers(): void {
  if (previewTimer !== null) {
    window.clearTimeout(previewTimer);
    previewTimer = null;
  }
  if (pinTimer !== null) {
    window.clearTimeout(pinTimer);
    pinTimer = null;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface KnowledgePanelApi {
  /** 指针进入某张花材卡。 */
  hoverStart: (family: string) => void;
  /** 指针离开某张花材卡。 */
  hoverEnd: (family: string) => void;
  /** 「了解」入口打开（点击或键盘）。 */
  open: (family: string, trigger?: HTMLElement | null) => void;
  /** 主动关闭：outside / escape / button；按键关闭会把焦点还给触发元素。 */
  close: (reason?: string) => void;
  /** 开始拖取 / 取花：立即取消预览与固定，不还焦点。 */
  cancel: (reason?: string) => void;
  /** 测试与调试用快照。 */
  snapshot: () => KnowledgeSnapshot;
}

export const knowledgePanel: KnowledgePanelApi = {
  hoverStart(family) {
    // 已固定时不因经过其他花材换内容（计划 §4）。
    if (snapshot.phase === 'pinned') return;
    hoveredFamily = family;
    clearTimers();
    if (snapshot.phase !== 'hidden' && snapshot.family !== family) {
      emit({ phase: 'hidden', family: null });
    }
    previewTimer = window.setTimeout(() => {
      if (hoveredFamily !== family) return;
      emit({ phase: 'preview', family });
    }, KNOWLEDGE_PREVIEW_DELAY_MS);
    pinTimer = window.setTimeout(() => {
      if (hoveredFamily !== family) return;
      if (snapshot.phase !== 'preview') return;
      emit({ phase: 'pinned', family });
    }, KNOWLEDGE_PIN_DELAY_MS);
  },
  hoverEnd(family) {
    if (hoveredFamily !== family) return;
    hoveredFamily = null;
    if (snapshot.phase === 'pinned') return;
    clearTimers();
    emit({ phase: 'hidden', family: null });
  },
  open(family, trigger) {
    clearTimers();
    hoveredFamily = null;
    returnFocus = trigger ?? null;
    focusInsideOnOpen = true;
    emit({ phase: 'pinned', family });
  },
  close() {
    if (snapshot.phase === 'hidden') {
      clearTimers();
      hoveredFamily = null;
      return;
    }
    clearTimers();
    hoveredFamily = null;
    emit({ phase: 'hidden', family: null });
    const target = returnFocus;
    returnFocus = null;
    focusInsideOnOpen = false;
    if (target) {
      window.requestAnimationFrame(() => {
        if (target.isConnected) target.focus({ preventScroll: true });
      });
    }
  },
  cancel() {
    clearTimers();
    hoveredFamily = null;
    returnFocus = null;
    focusInsideOnOpen = false;
    if (snapshot.phase !== 'hidden') emit({ phase: 'hidden', family: null });
  },
  snapshot: () => snapshot,
};

/** 花材架需要高亮「正在预览/固定」的那张卡时用这个 hook。 */
export function useKnowledgeSnapshot(): KnowledgeSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

// ---------- 浮窗本体 ----------

/** 空目录兜底：目录里找不到这种花料时仍然给出名字与一句说明。 */
function fallbackKnowledge(family: string, displayName: string): FlowerKnowledge {
  return {
    family,
    displayName,
    identify: '这一种花材的资料还没整理完，先按目录里的分类挑用。',
    meaning: '暂无整理好的花语说明。',
    pairing: ['按它在目录里的分类（主花 / 配花 / 叶材）决定放在什么位置。'],
    care: ['切花养护的通用做法：斜剪茎脚、勤换水、避免暴晒。'],
    unverified: true,
  };
}

interface Props {
  knowledge: FlowerKnowledge;
  family: string;
  displayName: string;
  entry?: AssetEntry;
  phase: KnowledgePhase;
}

function KnowledgeCardContent({ knowledge, family, displayName, entry, phase }: Props): React.JSX.Element {
  const catalog = useAppState((state) => state.catalog);
  const kind = entry?.kind ?? catalog.families.find((item) => item.family === family)?.kind;
  const category = categoryOf(family, kind);
  // 没有 glb 的花材是程序化占位模型（新增的绣球 / 蝴蝶兰即属此类），要如实标注。
  const proceduralOnly = Boolean(entry) && !entry?.glb;
  return (
    <>
      <header className="knowledge-head">
        <div className="knowledge-titles">
          <h3 className="knowledge-name" data-testid="knowledge-name">
            {displayName}
          </h3>
          <p className="knowledge-meta" data-testid="knowledge-meta">
            {categoryLabel(category)}
            {kind ? ` · ${KIND_LABEL[kind]}` : ''}
            {proceduralOnly ? ' · 占位模型' : ''}
          </p>
        </div>
        <button
          type="button"
          className="knowledge-close"
          data-testid="knowledge-close"
          aria-label="关闭花材知识卡"
          title="关闭（Esc）"
          onClick={() => knowledgePanel.close('button')}
        >
          ×
        </button>
      </header>

      <p className={`knowledge-phase-line is-${phase}`} data-testid="knowledge-phase" data-phase={phase}>
        {phase === 'pinned'
          ? '已固定 · 可以移进来滚动阅读；经过其他花材不会换内容'
          : '预览 · 在同一张花材卡上停满 2 秒即可固定'}
      </p>

      <div className="knowledge-scroll" data-testid="knowledge-scroll">
        <figure className="knowledge-figure" data-testid="knowledge-figure">
          {entry ? (
            <ModelThumbnail entry={entry} catalog={catalog} />
          ) : (
            <span className="knowledge-figure-empty">{displayName}</span>
          )}
          <figcaption data-testid="knowledge-image-note">{KNOWLEDGE_IMAGE_NOTE}</figcaption>
        </figure>

        {knowledge.aka?.length ? (
          <p className="knowledge-aka" data-testid="knowledge-aka">
            也叫：{knowledge.aka.join(' / ')}
          </p>
        ) : null}

        <section className="knowledge-section" data-testid="knowledge-section-identify">
          <h4>认识它</h4>
          <p>{knowledge.identify}</p>
          <p className="knowledge-note">
            <strong>花语</strong>：{knowledge.meaning}
          </p>
          <p className="knowledge-tiny">{KNOWLEDGE_MEANING_NOTE}</p>
        </section>

        <section className="knowledge-section" data-testid="knowledge-section-pairing">
          <h4>怎么搭</h4>
          <ul>
            {knowledge.pairing.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        <section className="knowledge-section" data-testid="knowledge-section-care">
          <h4>照顾它</h4>
          <ul>
            {knowledge.care.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="knowledge-tiny">{KNOWLEDGE_CARE_NOTE}</p>
        </section>

        <details className="knowledge-sources" data-testid="knowledge-sources">
          <summary>来源与核对日期</summary>
          {knowledge.unverified || !knowledge.sources?.length ? (
            <p data-testid="knowledge-unverified">
              这一条还没有可核对的来源（unverified），内容是通用整理，仅供参考。
            </p>
          ) : (
            <ul>
              {knowledge.sources.map((source) => (
                <li key={source.url ?? source.name}>
                  {source.url ? (
                    <a href={source.url} target="_blank" rel="noreferrer noopener">
                      {sourceLabel(source)}
                    </a>
                  ) : (
                    sourceLabel(source)
                  )}
                </li>
              ))}
            </ul>
          )}
        </details>
      </div>
    </>
  );
}

/**
 * 浮窗宿主：挂在 body 上，固定在右侧原调整区的位置。
 * 关闭动画/卸载完全由 phase 控制，不修改任何作品数据。
 */
export function KnowledgeCardHost(): React.JSX.Element | null {
  const snap = useKnowledgeSnapshot();
  const catalog = useAppState((state) => state.catalog);
  const reducedMotion = useReducedMotion();
  const cardRef = useRef<HTMLElement | null>(null);
  const open = snap.phase !== 'hidden';

  // 打开时把焦点送进浮窗（仅「了解」入口）；关闭时控制器负责把焦点还回触发按钮。
  useEffect(() => {
    if (!open) return;
    if (focusInsideOnOpen) {
      focusInsideOnOpen = false;
      cardRef.current?.querySelector<HTMLElement>('[data-testid="knowledge-close"]')?.focus({ preventScroll: true });
    }
  }, [open]);

  // 浮窗打开期间接管「浮窗之外」的点击：关闭，但三维操作不响应。
  useEffect(() => {
    if (!open) return undefined;

    /** 空白/画布上的按下：只关闭，不把这次手势交给 3D 场景。 */
    const suppressGesture = (): void => {
      const swallow = (event: Event): void => {
        event.stopPropagation();
      };
      // pointerup 在 window 冒泡阶段被场景使用；这里在 document 上一次性截住，
      // 避免「关浮窗」顺带在画布上落了一枝花。
      document.addEventListener('pointerup', swallow, { capture: true, once: true });
      window.setTimeout(() => {
        document.removeEventListener('pointerup', swallow, { capture: true });
      }, 800);
    };

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (cardRef.current?.contains(target)) return;
      // 花材架 / 左侧面板：关闭后照常执行原来的点击（取花、搜索、切标签）。
      if (target.closest('.shelf-panel')) {
        knowledgePanel.close('outside');
        return;
      }
      knowledgePanel.close('outside');
      // 只有落在三维画面上的空白点击才需要「关闭但不穿透」。
      if (target.closest('.viewport')) {
        event.stopPropagation();
        suppressGesture();
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      knowledgePanel.close('escape');
      // 只关浮窗，不要让 Esc 同时取消放置模式 / 清空选中（App 的 Esc 在 window 冒泡阶段）。
      event.stopPropagation();
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  // 自动化验证入口：只读状态 + 打开/关闭，不绕开正常交互。
  useEffect(() => {
    window.__bouquetKnowledge = {
      phase: () => knowledgePanel.snapshot().phase,
      family: () => knowledgePanel.snapshot().family,
      open: (family: string) => knowledgePanel.open(family),
      close: (reason?: string) => knowledgePanel.close(reason),
      families: () => knowledgeFamilies(),
      entry: (family: string) => knowledgeFor(family),
    };
    return () => {
      delete window.__bouquetKnowledge;
    };
  }, []);

  if (!open || !snap.family) return null;
  const family = snap.family;
  const group = catalog.families.find((item) => item.family === family);
  const displayName = group?.displayName ?? knowledgeFor(family)?.displayName ?? family;
  const entry = group?.entries[0];
  const knowledge = knowledgeFor(family) ?? fallbackKnowledge(family, displayName);

  return createPortal(
    <section
      ref={cardRef}
      className={`knowledge-card is-${snap.phase}`}
      role="dialog"
      aria-label={`${displayName}的知识卡`}
      aria-modal="false"
      data-testid="knowledge-card"
      data-phase={snap.phase}
      data-family={family}
      data-motion={reducedMotion ? 'reduced' : undefined}
    >
      <KnowledgeCardContent
        knowledge={knowledge}
        family={family}
        displayName={displayName}
        entry={entry}
        phase={snap.phase}
      />
    </section>,
    document.body,
  );
}
