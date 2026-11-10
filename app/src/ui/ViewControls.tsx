import { useEffect, useRef, useState } from 'react';
import type { ViewPreset } from '../data/types';
import { hasSeenFirstUse, markFirstUseSeen } from '../data/hints';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';

interface Props {
  onResetView: () => void;
  /** 右侧面板展开时向左让开，避免压住面板。 */
  panelOpen?: boolean;
}

const PRESETS: Array<{
  id: Exclude<ViewPreset, 'free'>;
  label: string;
  key: string;
  hint: string;
}> = [
  { id: 'front', label: '正面', key: '1', hint: '正对花束，看主花与对称（数字键 1）' },
  { id: 'quarter', label: '斜 45°', key: '2', hint: '默认机位，能看清层次（数字键 2）' },
  { id: 'side', label: '侧面', key: '3', hint: '看花束厚度与前后关系（数字键 3）' },
  { id: 'top', label: '俯视', key: '4', hint: '从上方看花材怎么铺开（数字键 4）' },
];

/** 右下角视角控件的两种首次提示：点眼睛选中，或拖动自动进入自由视角。 */
type ViewHintKind = 'wheel' | 'drag';

const HINT_AUTO_HIDE_MS = 6500;

/**
 * V0.7 §7 折叠视角控件：画布右下角一个「眼睛 + 当前视角名 + 下拉箭头」的小控件。
 *
 * - 眼睛亮起 = 固定视角：画布内普通滚轮按 正面 → 斜 45° → 侧面 → 俯视 循环；
 * - 眼睛关闭 = 自由视角：保留当前角度，拖动旋转、滚轮缩放；
 * - 再次点亮回到上次的固定视角（首次斜 45°），拖动空白自动熄灭；
 * - `Ctrl/⌘ + 滚轮` 调选中花枝大小，优先级高于切换视角。
 * - V0.9.1：第一次点眼睛 / 第一次拖动出自由视角时各给一次说明（本机只记一次）。
 */
export function ViewControls({ onResetView, panelOpen = false }: Props): React.JSX.Element {
  const viewPreset = useAppState((state) => state.viewPreset);
  const viewLocked = useAppState((state) => state.viewLocked);
  const lastFixedPreset = useAppState((state) => state.lastFixedPreset);
  const stage = useAppState((state) => state.stage);
  const viewDragTick = useAppState((state) => state.viewDragTick);
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState<ViewHintKind | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const current: ViewPreset =
    viewLocked && viewPreset !== 'free' ? viewPreset : viewLocked ? lastFixedPreset : 'free';
  const label = current === 'free' ? '自由' : (PRESETS.find((p) => p.id === current)?.label ?? '斜 45°');

  // 点外面或按 Esc 收起下拉；面板滚动不控制镜头，所以这里只关菜单、不碰相机。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // 首次提示几秒后自动收起；「知道了」可以提前关掉。已经记录过的机器不会再出现。
  useEffect(() => {
    if (!hint) return;
    const timer = window.setTimeout(() => setHint(null), HINT_AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [hint]);

  // 第一次拖动画面转出自由视角：说明镜头为什么亮了又灭、怎么回到固定视角。
  // 拍照阶段的自由镜头是构图需要，不在这里教，避免误解。
  useEffect(() => {
    if (viewDragTick === 0 || stage === 'finish') return;
    if (hasSeenFirstUse('view-drag')) return;
    markFirstUseSeen('view-drag');
    setHint('drag');
  }, [viewDragTick, stage]);

  const choose = (preset: ViewPreset): void => {
    setHint(null);
    store.setViewPreset(preset);
    setOpen(false);
  };

  const toggleEye = (): void => {
    const next = !viewLocked;
    store.setViewLocked(next);
    if (!hasSeenFirstUse('view-wheel')) {
      markFirstUseSeen('view-wheel');
      setHint('wheel');
    }
  };

  return (
    <div
      ref={rootRef}
      className={`view-dock card ${panelOpen ? 'is-shifted' : ''}`}
      data-testid="view-controls"
      data-locked={viewLocked ? 'true' : 'false'}
      data-preset={current}
      role="group"
      aria-label="视角"
    >
      <button
        type="button"
        className={`view-eye ${viewLocked ? 'is-on' : ''}`}
        data-testid="view-eye"
        aria-pressed={viewLocked}
        aria-label={viewLocked ? '固定视角（点一下进入自由视角）' : '自由视角（点一下回到固定视角）'}
        title={
          viewLocked
            ? '固定视角：画布内滚动滚轮按 正面 → 斜 45° → 侧面 → 俯视 切换'
            : '自由视角：拖动旋转、滚轮缩放；点一下回到固定视角'
        }
        onClick={toggleEye}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M2.6 12S6.2 5.8 12 5.8 21.4 12 21.4 12 17.8 18.2 12 18.2 2.6 12 2.6 12Z"
            fill="none"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="12" r="3.1" fill="none" strokeWidth="1.6" />
        </svg>
      </button>
      <button
        type="button"
        className="view-current"
        data-testid="view-current"
        aria-haspopup="menu"
        aria-expanded={open}
        title="选择固定视角（数字键 1–4 也可以）"
        onClick={() => {
          if (!open) setHint(null);
          setOpen((value) => !value);
        }}
      >
        <span className="view-name">{label}</span>
        <span className="view-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {hint ? (
        <div
          className="view-hint"
          data-testid="view-hint"
          data-hint={hint}
          role="status"
          aria-live="polite"
        >
          <button
            type="button"
            className="view-hint-close"
            data-testid="view-hint-close"
            aria-label="知道这个提示了"
            onClick={() => setHint(null)}
          >
            知道了
          </button>
          <strong className="view-hint-title">
            {hint === 'wheel'
              ? viewLocked
                ? '视角已选中'
                : '视角可以选中'
              : '已切到自由视角'}
          </strong>
          <p className="view-hint-text">
            {hint === 'wheel'
              ? '眼睛亮起＝固定视角；选中后滚动滚轮快速切换：正面 → 斜 45° → 侧面 → 俯视。'
              : '点眼睛可以选中固定视角；选中后用滚轮快速切换，拖动继续旋转、滚轮缩放。'}
          </p>
        </div>
      ) : null}
      {open ? (
        <div className="view-menu" role="menu" data-testid="view-menu">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="menuitemradio"
              aria-checked={current === preset.id}
              aria-pressed={current === preset.id}
              className={`view-option ${current === preset.id ? 'is-on' : ''}`}
              data-testid={`view-${preset.id}`}
              title={preset.hint}
              onClick={() => choose(preset.id)}
            >
              <span className="view-option-name">{preset.label}</span>
              <span className="view-option-key">{preset.key}</span>
            </button>
          ))}
          <div className="view-divider" />
          <button
            type="button"
            role="menuitemradio"
            aria-checked={current === 'free'}
            aria-pressed={current === 'free'}
            className={`view-option ${current === 'free' ? 'is-on' : ''}`}
            data-testid="view-free"
            title="拖动旋转、滚轮缩放"
            onClick={() => choose('free')}
          >
            <span className="view-option-name">自由视角</span>
            <span className="view-option-key">拖动</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="view-option"
            data-testid="view-reset"
            title="回到当前阶段的默认机位（Home 键）"
            onClick={() => {
              setHint(null);
              setOpen(false);
              onResetView();
            }}
          >
            <span className="view-option-name">复位</span>
            <span className="view-option-key">Home</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
