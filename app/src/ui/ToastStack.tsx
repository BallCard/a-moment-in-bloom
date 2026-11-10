import { useAppState } from '../state/useStore';

export function ToastStack(): React.JSX.Element {
  const toasts = useAppState((state) => state.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`} data-testid="toast">
          {toast.text}
        </div>
      ))}
    </div>
  );
}
