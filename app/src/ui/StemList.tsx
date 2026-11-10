import { useEffect, useState } from 'react';
import { MAX_STEMS } from '../config';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';
import type { StemInstance } from '../data/types';

interface StemGroup {
  key: string;
  label: string;
  color: string;
  stems: StemInstance[];
}

/**
 * 花枝列表：按花种分组，被挡住的花枝也能从这里选中。
 * 默认只展开前两组，选中藏在折叠组里的花枝时自动展开该组，避免左侧常驻过长。
 *
 * embedded：嵌进合并面板时去掉外层卡片和标题，只留分组列表。
 */
export function StemList({ embedded = false }: { embedded?: boolean }): React.JSX.Element {
  const stems = useAppState((state) => state.doc.stems);
  const selectedId = useAppState((state) => state.selectedId);
  const hoveredId = useAppState((state) => state.hoveredId);
  const catalog = useAppState((state) => state.catalog);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [defaulted, setDefaulted] = useState(false);

  const groups: StemGroup[] = [];
  const groupIndex = new Map<string, StemGroup>();
  for (const stem of stems) {
    const entry = catalog.entriesById[stem.assetId];
    const key = entry?.family ?? stem.assetId;
    let group = groupIndex.get(key);
    if (!group) {
      group = {
        key,
        label: entry?.familyName ?? entry?.displayName ?? stem.assetId,
        color: entry?.color ?? '#b9a48c',
        stems: [],
      };
      groupIndex.set(key, group);
      groups.push(group);
    }
    group.stems.push(stem);
  }

  // 首次有花枝时，只展开前两组；后续新增花种保持用户的手动展开状态。
  useEffect(() => {
    if (defaulted || groups.length <= 2) return;
    setDefaulted(true);
    setCollapsed(new Set(groups.slice(2).map((group) => group.key)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.length, defaulted]);

  // 选中被折叠组里的花枝时自动展开，避免「点了列表却看不到选中项」。
  useEffect(() => {
    if (!selectedId) return;
    const group = groups.find((item) => item.stems.some((stem) => stem.id === selectedId));
    if (!group) return;
    setCollapsed((previous) => {
      if (!previous.has(group.key)) return previous;
      const next = new Set(previous);
      next.delete(group.key);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, stems]);

  const toggle = (key: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const empty = (
    <p className="panel-empty">
      {embedded ? '还没有花枝，切到「挑选花材」拿一枝。' : '还没有花枝，先从花材架拿一枝。'}
    </p>
  );

  const list = stems.length === 0 ? empty : (
    <div className="stem-groups">
      {groups.map((group) => {
        const folded = collapsed.has(group.key);
        return (
          <div className="stem-group" key={group.key} data-testid="stem-group">
            <button
              type="button"
              className={`stem-group-head ${folded ? 'is-folded' : ''}`}
              data-testid="stem-group-toggle"
              aria-expanded={!folded}
              onClick={() => toggle(group.key)}
            >
              <span className="group-dot" style={{ background: group.color }} aria-hidden="true" />
              <span className="group-name">{group.label}</span>
              <span className="group-count">×{group.stems.length}</span>
              <span className="group-chevron" aria-hidden="true">
                {folded ? '▸' : '▾'}
              </span>
            </button>
            {folded ? null : (
              <div className="stem-list">
                {group.stems.map((stem) => {
                  const entry = catalog.entriesById[stem.assetId];
                  const index = stems.findIndex((item) => item.id === stem.id);
                  const selected = stem.id === selectedId;
                  const hovered = stem.id === hoveredId;
                  return (
                    <button
                      key={stem.id}
                      type="button"
                      className={`stem-item ${selected ? 'is-selected' : ''} ${hovered ? 'is-hovered' : ''}`}
                      data-testid="stem-item"
                      data-stem-id={stem.id}
                      onClick={() => store.select(stem.id)}
                      onMouseEnter={() => store.setHovered(stem.id)}
                      onMouseLeave={() => store.setHovered(null)}
                      title={entry ? `第 ${index + 1} 枝 · ${entry.displayName}` : `第 ${index + 1} 枝 · ${stem.assetId}（资产缺失）`}
                    >
                      <span className="stem-index">{index + 1}</span>
                      <span className="stem-name">
                        {entry?.displayName ?? stem.assetId}
                        {!entry ? <em>资产缺失，占位显示</em> : null}
                      </span>
                      <span className="stem-tilt">{Math.round(stem.pose.tilt)}°</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  if (embedded) {
    return (
      <div className="stem-embedded" data-testid="stem-list">
        {stems.length > 0 ? (
          <p className="panel-note panel-note-quiet stem-embedded-note">
            {stems.length}/{MAX_STEMS} 枝 · 被挡住的花枝，点这里也能选中
          </p>
        ) : null}
        {list}
      </div>
    );
  }

  return (
    <section className="panel stem-panel" aria-label="花枝列表" data-testid="stem-list">
      <div className="panel-head">
        <h2>花枝列表</h2>
        <span className="panel-meta">
          {stems.length}/{MAX_STEMS}
        </span>
      </div>
      {stems.length > 0 ? (
        <p className="panel-note panel-note-quiet">被挡住的花枝，点这里也能选中。</p>
      ) : null}
      {list}
    </section>
  );
}
