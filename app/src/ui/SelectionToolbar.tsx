import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';
import {
  useSelectionAnchor,
  useStage,
} from './workflow';

interface Props {
  onOpenInspector: () => void;
}

const GAP = 46;

/**
 * 就近精调工具条：跟着选中花头的屏幕位置走，放在花头侧边，不压住花。
 * 锚点不可用（出画、无选中、非摆花阶段）时不渲染，功能仍在右栏面板里。
 */
export function SelectionToolbar({ onOpenInspector }: Props): React.JSX.Element | null {
  const stage = useStage();
  const anchor = useSelectionAnchor();
  const selectedId = useAppState((state) => state.selectedId);
  const stems = useAppState((state) => state.doc.stems);
  const catalog = useAppState((state) => state.catalog);
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === 'undefined' ? 1366 : window.innerWidth,
    h: typeof window === 'undefined' ? 768 : window.innerHeight,
  }));
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 322, h: 112 });
  // V16 第二轮：右栏可以拖宽了，工具条按右栏实际宽度让位，别压到面板边缘。
  const [reserveRight, setReserveRight] = useState(14);

  useEffect(() => {
    const panel = document.querySelector('.side-right');
    const measure = (): void => {
      const width = panel instanceof HTMLElement ? Math.round(panel.getBoundingClientRect().width) : 0;
      setReserveRight(width > 0 ? width + 14 : 14);
    };
    measure();
    const onResize = (): void => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
      measure();
    };
    window.addEventListener('resize', onResize);
    // 右栏开合、拖宽都会改变它的实际宽度：每次渲染重新挂一个观察器（很便宜），
    // 这样不用把右栏状态硬塞进 props，也不会在面板刚打开时漏掉。
    const observer = typeof ResizeObserver === 'function' && panel ? new ResizeObserver(measure) : null;
    if (observer && panel) observer.observe(panel);
    return () => {
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
    };
  });

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    if (width !== size.w || height !== size.h) setSize({ w: width, h: height });
  }, [selectedId, viewport, size.w, size.h]);

  if (stage !== 'arrange' || !selectedId || !anchor || !anchor.visible) return null;

  const stem = stems.find((item) => item.id === selectedId);
  if (!stem) return null;
  const index = stems.findIndex((item) => item.id === selectedId) + 1;
  const displayName = catalog.entriesById[stem.assetId]?.displayName ?? stem.assetId;

  const rightEdge = Math.max(14, viewport.w - reserveRight);
  let x = anchor.x + GAP;
  let y = anchor.y - size.h / 2;
  if (x + size.w > rightEdge) x = anchor.x - GAP - size.w;
  x = Math.min(Math.max(x, 14), Math.max(14, rightEdge - size.w));
  y = Math.min(Math.max(y, 84), Math.max(84, viewport.h - size.h - 96));

  return (
    <div
      ref={ref}
      className="near-toolbar"
      data-testid="near-toolbar"
      style={{ left: `${x}px`, top: `${y}px` }}
      role="toolbar"
      aria-label={`第 ${index} 枝就近微调`}
    >
      <div className="near-head">
        <span className="near-name">
          第 {index} 枝 · {displayName}
        </span>
        <button
          type="button"
          className="near-close"
          data-testid="near-close"
          aria-label="收起工具条"
          onClick={() => store.select(null)}
        >
          ×
        </button>
      </div>
      <div className="near-row">
        <button
          type="button"
          className="near-btn near-btn-wide"
          data-testid="near-more"
          onClick={onOpenInspector}
        >
          整理 / 微调
        </button>
        <details className="near-extra"><summary>更多</summary><button className="btn btn-small" data-testid="near-duplicate" onClick={()=>store.duplicateStem(selectedId)}>复制</button><button className="btn btn-small" data-testid="near-delete" onClick={()=>store.deleteStem(selectedId)}>删除</button></details>
      </div>
    </div>
  );
}
