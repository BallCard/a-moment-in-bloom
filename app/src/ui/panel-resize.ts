/**
 * 左右侧栏宽度可拉伸（V16 第二轮：面板自由拉伸 + 内容自适应）。
 *
 * 做法：
 * - 宽度只由两个 CSS 变量驱动（`--panel-left-w` / `--panel-right-w`），写在 `.app` 上；
 *   没有用户宽度时把变量移除，样式表里的断点默认值（styles.css）继续生效。
 * - 把手是 `.side-left` / `.side-right` 内边缘上一个常驻的 18px 命中区（React 元素在
 *   App.tsx 里渲染，本文件只提供属性与逻辑），拖动用 pointer capture，键盘 ←/→ 可调。
 * - 宽度按 `min/max` 夹住；上限还会按视口再收一层，避免两侧同开时把画布挤没。
 * - 持久化到独立的 localStorage key；读失败 / 坏的 JSON 都回落到默认宽度。
 * - 视口 ≤760px 时整个模块退出：不渲染把手、移除变量，回到既有的窄屏布局。
 *
 * 这里不碰三维场景：拖动事件只落在把手上，画布收不到 pointerdown，因此不会误触相机。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import './panel-resize.css';

export type PanelSide = 'left' | 'right';

/** 独立 key：不和最近花材、音频偏好等其它本机设置混用。 */
const STORAGE_KEY = 'bouquet.panel-widths.v1';
/** 窄屏沿用既有的固定布局：不渲染把手、也不应用用户宽度。 */
const NARROW_QUERY = '(max-width: 760px)';
const WIDTH_VAR: Record<PanelSide, string> = {
  left: '--panel-left-w',
  right: '--panel-right-w',
};
const SIDE_SELECTOR: Record<PanelSide, string> = {
  left: '.side-left',
  right: '.side-right',
};
/** 静态上下限；上限另按视口收一层（见 maxWidthFor）。 */
const LIMITS: Record<PanelSide, { min: number; max: number; fallback: number }> = {
  left: { min: 240, max: 420, fallback: 258 },
  right: { min: 300, max: 460, fallback: 300 },
};
const VIEW_SHARE: Record<PanelSide, number> = { left: 0.32, right: 0.36 };
const ARROW_STEP = 16;
const ARROW_STEP_LARGE = 32;

interface Widths {
  left: number | null;
  right: number | null;
}

interface DragState {
  side: PanelSide;
  pointerId: number;
  startX: number;
  startWidth: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 视口越宽允许拉得越宽，但不超过静态上限；两侧同开也给中间画布留空间。 */
function maxWidthFor(side: PanelSide, viewWidth: number): number {
  const scoped = Math.round(viewWidth * VIEW_SHARE[side]);
  return Math.max(LIMITS[side].min, Math.min(LIMITS[side].max, scoped));
}

function readStoredWidths(): Widths {
  const widths: Widths = { left: null, right: null };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return widths;
    const parsed = JSON.parse(raw) as Partial<Record<PanelSide, unknown>>;
    for (const side of ['left', 'right'] as const) {
      const value = parsed?.[side];
      if (typeof value === 'number' && Number.isFinite(value)) {
        widths[side] = clamp(Math.round(value), LIMITS[side].min, LIMITS[side].max);
      }
    }
  } catch {
    /* 读失败 / 不是 JSON：用默认宽度，不影响打开工作台。 */
  }
  return widths;
}

function writeStoredWidths(widths: Widths): void {
  try {
    const payload: Partial<Record<PanelSide, number>> = {};
    if (widths.left !== null) payload.left = widths.left;
    if (widths.right !== null) payload.right = widths.right;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* 存储不可用（隐私模式 / 配额满）只是下次打开回到默认宽度。 */
  }
}

/** 通过 App.tsx 的 JSX 展开到把手 `<div>` 上；不是组件，避免新建 .tsx。 */
export interface PanelResizeHandleProps {
  className: string;
  role: 'separator';
  tabIndex: number;
  'aria-orientation': 'vertical';
  'aria-label': string;
  'aria-valuemin': number;
  'aria-valuemax': number;
  'aria-valuenow': number;
  'aria-valuetext': string;
  title: string;
  'data-testid': string;
  'data-side': PanelSide;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

export interface PanelResizeApi {
  /** 挂到 `.app` 根节点：宽度变量与 `data-panel-resizing` 都写在这里。 */
  appRef: RefObject<HTMLDivElement | null>;
  /** 正在拖动：给全局 cursor: col-resize 用，也暂停宽度过渡。 */
  resizing: boolean;
  /** 窄屏时两侧都是 null（不渲染把手）。 */
  handles: { left: PanelResizeHandleProps | null; right: PanelResizeHandleProps | null };
}

export function usePanelResize(): PanelResizeApi {
  const appRef = useRef<HTMLDivElement | null>(null);
  const widthsRef = useRef<Widths>({ left: null, right: null });
  const dragRef = useRef<DragState | null>(null);
  const [resizing, setResizing] = useState(false);
  const [narrow, setNarrow] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches,
  );

  /** 把 aria-valuenow/min/max 同步成真实像素宽度（CSS 默认宽度也算进去）。 */
  const syncAria = useCallback(() => {
    const app = appRef.current;
    if (!app) return;
    for (const side of ['left', 'right'] as const) {
      const handle = app.querySelector<HTMLElement>(`[data-testid="panel-resize-${side}"]`);
      const panel = app.querySelector<HTMLElement>(SIDE_SELECTOR[side]);
      if (!handle || !panel) continue;
      const measured = Math.round(panel.getBoundingClientRect().width);
      // 用户设定过宽度时用「目标宽度」而不是过渡中的实测值，否则键盘微调后
      // aria 会读到上一步的宽度（宽度有 150ms 过渡）。
      const stored = widthsRef.current[side];
      const width =
        stored === null
          ? measured
          : clamp(stored, LIMITS[side].min, maxWidthFor(side, window.innerWidth));
      handle.setAttribute('aria-valuenow', String(width));
      handle.setAttribute('aria-valuemin', String(LIMITS[side].min));
      handle.setAttribute('aria-valuemax', String(maxWidthFor(side, window.innerWidth)));
      handle.setAttribute('aria-valuetext', `${width} 像素`);
    }
  }, []);

  /** 写入 CSS 变量；无用户宽度或窄屏时移除变量，让样式表的断点默认值接管。 */
  const apply = useCallback(() => {
    const app = appRef.current;
    if (!app) return;
    const isNarrow = window.matchMedia(NARROW_QUERY).matches;
    for (const side of ['left', 'right'] as const) {
      const width = widthsRef.current[side];
      if (isNarrow || width === null) {
        app.style.removeProperty(WIDTH_VAR[side]);
        continue;
      }
      const next = clamp(width, LIMITS[side].min, maxWidthFor(side, window.innerWidth));
      app.style.setProperty(WIDTH_VAR[side], `${next}px`);
    }
    syncAria();
  }, [syncAria]);

  /** 当前真实宽度：优先用户设定，否则读面板实测值（含断点默认宽度）。 */
  const currentWidth = useCallback((side: PanelSide): number => {
    const measured = appRef.current?.querySelector<HTMLElement>(SIDE_SELECTOR[side]);
    const width = measured ? Math.round(measured.getBoundingClientRect().width) : 0;
    return widthsRef.current[side] ?? (width > 0 ? width : LIMITS[side].fallback);
  }, []);

  const commit = useCallback(
    (side: PanelSide, width: number): number => {
      const next = clamp(Math.round(width), LIMITS[side].min, maxWidthFor(side, window.innerWidth));
      widthsRef.current[side] = next;
      apply();
      return next;
    },
    [apply],
  );

  const beginDrag = useCallback(
    (side: PanelSide, event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return;
      // 只落在把手上：不让画布/选中逻辑收到这次按下。
      event.preventDefault();
      event.stopPropagation();
      const handle = event.currentTarget;
      const startWidth = currentWidth(side);
      dragRef.current = { side, pointerId: event.pointerId, startX: event.clientX, startWidth };
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* 没有 pointer capture 也能靠 pointermove 拖动（测试环境偶发）。 */
      }
      handle.setAttribute('data-active', 'true');
      handle.focus({ preventScroll: true });
      setResizing(true);
      syncAria();
    },
    [currentWidth, syncAria],
  );

  const moveDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      // 左侧把手往右拖变宽；右侧把手往左拖变宽。
      const delta = drag.side === 'left' ? event.clientX - drag.startX : drag.startX - event.clientX;
      commit(drag.side, drag.startWidth + delta);
    },
    [commit],
  );

  const finishDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      event.currentTarget.removeAttribute('data-active');
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          /* 已释放或环境不支持：忽略。 */
        }
      }
      setResizing(false);
      writeStoredWidths(widthsRef.current);
      syncAria();
    },
    [syncAria],
  );

  const adjustByKeyboard = useCallback(
    (side: PanelSide, event: ReactKeyboardEvent<HTMLDivElement>): void => {
      const isArrow = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
      if (!isArrow) return;
      // 方向键留给把手：不要被 App 的全局快捷键当成切换视角。
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? ARROW_STEP_LARGE : ARROW_STEP;
      const widen = side === 'left' ? event.key === 'ArrowRight' : event.key === 'ArrowLeft';
      commit(side, currentWidth(side) + (widen ? step : -step));
      writeStoredWidths(widthsRef.current);
      syncAria();
    },
    [commit, currentWidth, syncAria],
  );

  // 首帧就把存储的宽度画上，避免刷新时先窄后宽闪一下。
  useLayoutEffect(() => {
    widthsRef.current = readStoredWidths();
    apply();
  }, [apply]);

  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const onQueryChange = (): void => {
      setNarrow(query.matches);
      apply();
    };
    const onResize = (): void => apply();
    query.addEventListener('change', onQueryChange);
    window.addEventListener('resize', onResize);
    return () => {
      query.removeEventListener('change', onQueryChange);
      window.removeEventListener('resize', onResize);
    };
  }, [apply]);

  const buildHandle = (side: PanelSide): PanelResizeHandleProps => ({
    className: 'panel-resize-handle',
    role: 'separator',
    tabIndex: 0,
    'aria-orientation': 'vertical',
    'aria-label': `${side === 'left' ? '左' : '右'}侧面板宽度：拖动或按左右方向键调整`,
    'aria-valuemin': LIMITS[side].min,
    'aria-valuemax': maxWidthFor(side, typeof window === 'undefined' ? 1366 : window.innerWidth),
    'aria-valuenow': widthsRef.current[side] ?? LIMITS[side].fallback,
    'aria-valuetext': `${widthsRef.current[side] ?? LIMITS[side].fallback} 像素`,
    title: '拖动边缘调整面板宽度；聚焦后按 ← / → 微调',
    'data-testid': `panel-resize-${side}`,
    'data-side': side,
    onPointerDown: (event) => beginDrag(side, event),
    onPointerMove: moveDrag,
    onPointerUp: finishDrag,
    onPointerCancel: finishDrag,
    onKeyDown: (event) => adjustByKeyboard(side, event),
  });

  return {
    appRef,
    resizing,
    handles: {
      left: narrow ? null : buildHandle('left'),
      right: narrow ? null : buildHandle('right'),
    },
  };
}
