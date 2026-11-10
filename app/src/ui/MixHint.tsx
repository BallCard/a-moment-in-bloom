import { useEffect, useState } from 'react';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';

/**
 * 轻量搭配提示：只在摆花阶段、已有两枝以上时出现。
 * 只推荐当前清单里真实存在且缺少的角色（先配叶、再换一种主花），点一下拿起，不自动添加。
 */
export function MixHint(): React.JSX.Element | null {
  const stems = useAppState((state) => state.doc.stems);
  const placement = useAppState((state) => state.placement);
  const catalog = useAppState((state) => state.catalog);
  const stage = useAppState((state) => state.stage);
  const [dismissed, setDismissed] = useState(false);

  // 花束变化后重新给建议；用户明确关掉后，直到下一次加花才再出现。
  useEffect(() => {
    setDismissed(false);
  }, [stems.length]);

  if (dismissed || placement || stage !== 'arrange' || stems.length < 2) return null;

  const byId = new Map(catalog.entries.map((entry) => [entry.assetId, entry]));
  const used = stems
    .map((stem) => byId.get(stem.assetId))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  if (used.length === 0) return null;

  const kinds = new Set(used.map((entry) => entry.kind));
  const families = new Set(used.map((entry) => entry.familyName));

  let target: { assetId: string; action: string; text: string } | null = null;
  if (!kinds.has('greenery')) {
    const greenery = catalog.entries.find((entry) => entry.kind === 'greenery');
    if (greenery) {
      target = {
        assetId: greenery.assetId,
        action: `拿一枝${greenery.familyName}`,
        text: '还差一点配叶：补一枝尤加利，花束轮廓会更松、更完整。',
      };
    }
  } else if (families.size < 2) {
    const other = catalog.entries.find(
      (entry) => entry.kind === 'main' && !families.has(entry.familyName),
    );
    if (other) {
      target = {
        assetId: other.assetId,
        action: `拿一枝${other.familyName}`,
        text: '目前只有一种主花：再换一种花材，层次和颜色会更丰富。',
      };
    }
  }

  if (!target) return null;

  return (
    <div className="mix-hint" data-testid="mix-hint">
      <p className="mix-hint-text">{target.text}</p>
      <div className="mix-hint-actions">
        <button
          type="button"
          className="btn btn-small"
          data-testid="mix-hint-take"
          onClick={() => store.setPlacement(target.assetId)}
        >
          {target.action}
        </button>
        <button
          type="button"
          className="mix-hint-dismiss"
          data-testid="mix-hint-dismiss"
          aria-label="先不用搭配提示"
          onClick={() => setDismissed(true)}
        >
          先不用
        </button>
      </div>
    </div>
  );
}
