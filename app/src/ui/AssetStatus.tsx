import { store } from '../state/store';
import { useAppState } from '../state/useStore';

export function AssetStatus(): React.JSX.Element | null {
  const loading = useAppState((state) => state.loading);
  const failure = useAppState((state) => state.assetFailure);

  if (!loading.active && !failure) return null;

  const percent =
    loading.progress === null ? null : Math.round(loading.progress * 100);

  return (
    <div className="asset-status" aria-live="polite">
      {loading.active ? (
        <div className="asset-loading card" data-testid="asset-loading">
          <span className="loading-dot" aria-hidden="true" />
          <span className="asset-loading-label">{loading.label}</span>
          {percent !== null ? <span className="asset-loading-percent">{percent}%</span> : null}
          <span className="loading-track" aria-hidden="true">
            <span
              className="loading-fill"
              style={{ width: `${percent ?? 18}%` }}
            />
          </span>
        </div>
      ) : null}
      {failure ? (
        <div className="asset-failure card" data-testid="asset-failure">
          <span>花材没加载出来，先用占位花顶着。</span>
          <button
            type="button"
            className="btn btn-small"
            data-testid="retry-assets"
            onClick={() => store.retryAssets()}
          >
            重试
          </button>
        </div>
      ) : null}
    </div>
  );
}
