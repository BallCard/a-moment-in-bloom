import { store } from '../state/store';
import { useAppState } from '../state/useStore';
import { useSuggestions } from './workflow';

export function PlacementBanner(): React.JSX.Element | null {
  const placement = useAppState((state) => state.placement);
  const catalog = useAppState((state) => state.catalog);
  const suggestions = useSuggestions();
  if (!placement) return null;
  const entry = catalog.entriesById[placement.assetId];
  return (
    <div className="placement-banner" data-testid="placement-banner">
      <span className="placement-dot" style={{ background: entry?.color ?? '#e8a4ba' }} />
      <span className="placement-text">
        正在放「{entry?.displayName ?? '花枝'}」
        <em>
          {suggestions.length > 0
            ? `看见 ${suggestions.length} 个建议位，靠近会轻轻吸附`
            : '拖到花束上松开，或点工作台放下'}
        </em>
      </span>
      <span className="placement-kbd">Esc</span>
      <button
        type="button"
        className="btn btn-small"
        data-testid="cancel-placement"
        onClick={() => store.setPlacement(null)}
      >
        先不放
      </button>
    </div>
  );
}
