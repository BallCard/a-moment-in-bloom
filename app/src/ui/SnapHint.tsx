import { useAppState } from '../state/useStore';

/**
 * 轻吸附的可见提示：指针进入建议位时，在画面对应位置给出「会吸到这里」。
 * 用户反馈「不知道点下去会吸附，以为会停在我选的位置」，这个标签就是答案。
 */
export function SnapHint(): React.JSX.Element | null {
  const hint = useAppState((state) => state.snapHint);
  if (!hint) return null;

  const width = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const x = Math.min(Math.max(hint.x, 118), Math.max(118, width - 118));
  const above = hint.y > 96;
  const y = above ? hint.y - 48 : hint.y + 42;

  return (
    <div
      className={`snap-hint ${hint.pinned ? 'is-pinned' : ''}`}
      data-testid="snap-hint"
      data-pinned={hint.pinned ? 'true' : 'false'}
      data-reason={hint.reason}
      style={{ left: `${x}px`, top: `${y}px` }}
      role="status"
      aria-live="polite"
    >
      <span className="snap-hint-dot" aria-hidden="true" />
      <span>{hint.pinned ? '已钉住 · 点击放到这里' : '会吸附到这里 · 点击放到这里'}</span>
    </div>
  );
}
