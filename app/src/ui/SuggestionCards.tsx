import { useAppState } from '../state/useStore';
import {
  MAX_SUGGESTION_CARDS,
  SUGGESTION_KIND_LABEL,
  pinSuggestion,
  useActiveSuggestionId,
  usePinnedSuggestionId,
  useSuggestions,
} from './workflow';

/**
 * 建议卡：只在放置花材且场景给出候选时出现，最多 2–3 张纸片。
 * 点一张会把花影钉到那个位置（再点一次取消）。
 */
export function SuggestionCards(): React.JSX.Element | null {
  const placement = useAppState((state) => state.placement);
  const suggestions = useSuggestions();
  const pinnedId = usePinnedSuggestionId();
  const activeId = useActiveSuggestionId();

  if (!placement || suggestions.length === 0) return null;

  const cards = suggestions.slice(0, MAX_SUGGESTION_CARDS);

  return (
    <div className="suggestion-dock" data-testid="suggestion-dock">
      <p className="suggestion-title">
        建议位
        <span>点一张钉住，靠近会轻轻吸附</span>
      </p>
      <div className="suggestion-row">
        {cards.map((candidate, index) => {
          const pinned = candidate.id === pinnedId;
          const active = candidate.id === activeId;
          return (
            <button
              key={candidate.id}
              type="button"
              className={`suggestion-card kind-${candidate.kind} ${pinned ? 'is-pinned' : ''} ${active ? 'is-active' : ''}`}
              data-testid="suggestion-card"
              data-suggestion-id={candidate.id}
              style={{ animationDelay: `${index * 45}ms` }}
              aria-pressed={pinned}
              onClick={() => pinSuggestion(pinned ? null : candidate.id)}
              title={pinned ? '再点一次取消钉住' : '钉到这个建议位'}
            >
              <span className="suggestion-top">
                <span className="suggestion-index" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="suggestion-kind">{SUGGESTION_KIND_LABEL[candidate.kind] ?? '建议'}</span>
                {pinned ? <span className="suggestion-pin">已钉住</span> : null}
              </span>
              <span className="suggestion-reason">{candidate.reason}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
