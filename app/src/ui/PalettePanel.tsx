import { MAX_STEMS } from '../config';
import {
  CATEGORIES,
  CATEGORY_GROUPS,
  categoryLabel,
  categoryOf,
  categoriesInGroup,
  type CategoryGroupId,
  type CategoryId,
} from '../data/categories';
import { KIND_LABEL } from '../data/catalog';
import { commissionWishes } from '../data/commissions';
import { flowerOrganizeCapability } from '../data/organize';
import type { AssetEntry, AssetFamily } from '../data/types';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';
import { useEffect, useRef, useState } from 'react';
import { KnowledgeCardHost, knowledgePanel, useKnowledgeSnapshot } from './KnowledgeCard';
import { ModelThumbnail } from './ModelThumbnail';
import { OnboardingCoach, useOnboardingHighlight } from './OnboardingCoach';
import './flower-shelf.css';

/**
 * 花材架（V13 提效版 + V16 类目/知识/引导）。
 *
 * - 两列紧凑卡片：缩略图只露花头（静态图是整枝图，用 CSS 裁切放大上半段），
 *   桌面 1366×768 一屏能看到 8 种以上花材；
 * - 名称搜索 + 色系筛选 + 最近使用（localStorage），三个维度可以叠加；
 * - V16 §2：常驻的第三行不再是「主花/配花/绿叶」直接当筛选项，而是**类目入口**：
 *   一行主花/配花/叶材分组，点开才展开该类目下的小类（12 类），不新增多排常驻筛选；
 * - 卡片左上角「了解」打开花材知识浮窗（悬停 300ms 预览、满 2s 固定，见 KnowledgeCard）；
 * - 没有 glb 的程序化花材在卡片上标「占位」，不冒充真实模型；
 * - 新手引导激活时，当前步骤的候选花材卡带高亮；
 * - 颜色色点只在该花材进入放置模式（也就是「选中」）后展开，避免每张卡片常驻一排点；
 * - 委托模式下按 commissionWishes() 的心愿给卡片加「心愿」标记，并在顶部给一行说明。
 *
 * 取花仍然保留两种方式：点一下进入放置模式；按住拖到画布由 3D 场景落位。
 */
const COLOR_KEY = 'bouquet.palette-colors';
const RECENT_KEY = 'bouquet.shelf-recent';
const RECENT_LIMIT = 8;

type ColorTone =
  | 'pink'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'white'
  | 'other';

const TONES: { key: ColorTone; label: string; dot: string }[] = [
  { key: 'pink', label: '粉', dot: '#e8a0b4' },
  { key: 'red', label: '红', dot: '#b34256' },
  { key: 'orange', label: '橙', dot: '#e79664' },
  { key: 'yellow', label: '黄', dot: '#e9c45a' },
  { key: 'white', label: '白', dot: '#f4eee2' },
  { key: 'purple', label: '紫', dot: '#bd9fd6' },
  { key: 'blue', label: '蓝', dot: '#8fa6d4' },
  { key: 'green', label: '绿', dot: '#7c9a6a' },
  { key: 'other', label: '其他', dot: '#b9a48c' },
];

/** 把清单里的十六进制配色归到「粉/红/黄/橙/白/紫/蓝/绿/其他」。 */
export function colorTone(hex: string): ColorTone {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return 'other';
  let value = match[1];
  if (value.length === 3) value = value.split('').map((part) => part + part).join('');
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  // 奶白／象牙：极亮，或「暖调低饱和 + 高明度」。浅粉靠色相区分，不会被吞。
  if (lightness >= 0.93 || saturation <= 0.12) return 'white';
  if (lightness >= 0.84 && saturation <= 0.5 && hue >= 20 && hue <= 65) return 'white';
  if (hue >= 300 || hue < 15) return lightness >= 0.58 ? 'pink' : 'red';
  if (hue < 38) return 'orange';
  if (hue < 70) return 'yellow';
  if (hue < 165) return 'green';
  if (hue < 250) return 'blue';
  return 'purple';
}

function readRemembered(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(COLOR_KEY) ?? '{}');
    return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function readRecent(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((id): id is string => typeof id === 'string').slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式下写不进 localStorage，内存状态仍然生效 */
  }
}

/**
 * 花材架。embedded：嵌进「花材与花枝」面板时不再画外层卡片，只保留筛选与列表。
 */
export function PalettePanel({ embedded = false }: { embedded?: boolean }): React.JSX.Element {
  const catalog = useAppState((state) => state.catalog);
  const families = useAppState((state) => state.catalog.families);
  const catalogStatus = useAppState((state) => state.catalogStatus);
  const entryCount = useAppState((state) => state.catalog.entries.length);
  const placement = useAppState((state) => state.placement);
  const stemCount = useAppState((state) => state.doc.stems.length);
  const commissionId = useAppState((state) => state.commissionId);

  const [category, setCategory] = useState<'all' | CategoryId>('all');
  const [openGroup, setOpenGroup] = useState<CategoryGroupId | null>(null);
  const [query, setQuery] = useState('');
  const [tone, setTone] = useState<'all' | ColorTone>('all');
  const [remembered, setRemembered] = useState<Record<string, string>>(readRemembered);
  const [recent, setRecent] = useState<string[]>(readRecent);
  const drag = useRef<{ x: number; y: number; assetId: string; started: boolean } | null>(null);
  const suppressClick = useRef(false);
  const knowledge = useKnowledgeSnapshot();
  const coach = useOnboardingHighlight();
  const coachFamilies = coach.families;

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      const current = drag.current;
      if (current && !current.started && Math.hypot(event.clientX - current.x, event.clientY - current.y) > 6) {
        current.started = true;
        suppressClick.current = true;
        store.setPlacement(current.assetId);
      }
    };
    const end = (event: PointerEvent): void => {
      if (drag.current?.started && !(event.target instanceof HTMLCanvasElement)) store.setPlacement(null);
      drag.current = null;
    };
    const cancel = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        drag.current = null;
        suppressClick.current = true;
      }
    };
    window.addEventListener('keydown', cancel);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('keydown', cancel);
    };
  }, []);

  // 任何进入放置模式的花材都算「最近用过」——点击和拖拽两条路径都覆盖。
  const placementId = placement?.assetId;
  useEffect(() => {
    if (!placementId) return;
    if (!catalog.entriesById[placementId]) return;
    if (recent[0] === placementId) return;
    const next = [placementId, ...recent.filter((id) => id !== placementId)].slice(0, RECENT_LIMIT);
    setRecent(next);
    writeStorage(RECENT_KEY, next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placementId, recent]);

  const wish = commissionWishes(commissionId);
  const wishAssetIds = new Set(wish?.assetIds ?? []);
  const hasWish = Boolean(wish && (wish.families.length || wish.assetIds.length || wish.kinds.length));

  const familyWished = (family: AssetFamily): boolean => {
    if (!wish) return false;
    if (wish.families.includes(family.family) || wish.kinds.includes(family.kind)) return true;
    return family.entries.some((entry) => wishAssetIds.has(entry.assetId));
  };
  const entryWished = (family: AssetFamily, entry: AssetEntry): boolean => {
    if (!wish) return false;
    if (wish.families.includes(family.family) || wish.kinds.includes(family.kind)) return true;
    return wishAssetIds.has(entry.assetId);
  };

  const full = stemCount >= MAX_STEMS;
  const normalizedQuery = query.trim().toLowerCase();
  // 分组入口只显示当前目录里真有花材的组，避免点进去空类目。
  const categoryGroups = CATEGORY_GROUPS.filter((group) =>
    group.categories.some((id) => families.some((family) => categoryOf(family.family, family.kind) === id)),
  );
  const subCategories = openGroup ? categoriesInGroup(openGroup) : [];
  const selectedGroup =
    category === 'all' ? null : (CATEGORY_GROUPS.find((group) => group.categories.includes(category))?.id ?? null);

  const matchesQuery = (family: AssetFamily): boolean => {
    if (!normalizedQuery) return true;
    const haystack = [
      family.displayName,
      family.family,
      family.note,
      ...family.entries.map((entry) => `${entry.displayName} ${entry.variantName}`),
    ];
    return haystack.some((text) => text.toLowerCase().includes(normalizedQuery));
  };

  const visibleFamilies = families.filter((family) => {
    if (category !== 'all' && categoryOf(family.family, family.kind) !== category) return false;
    if (tone !== 'all' && !family.entries.some((entry) => colorTone(entry.color) === tone)) return false;
    return matchesQuery(family);
  });

  const filtersActive = category !== 'all' || tone !== 'all' || normalizedQuery.length > 0;
  const resetFilters = (): void => {
    setCategory('all');
    setOpenGroup(null);
    setTone('all');
    setQuery('');
  };

  const remember = (family: string, assetId: string): void => {
    const next = { ...remembered, [family]: assetId };
    setRemembered(next);
    writeStorage(COLOR_KEY, next);
  };

  const chosenEntry = (family: AssetFamily): AssetEntry => {
    if (tone !== 'all') {
      const toneMatch =
        family.entries.find((entry) => entry.assetId === remembered[family.family] && colorTone(entry.color) === tone) ??
        family.entries.find((entry) => colorTone(entry.color) === tone);
      if (toneMatch) return toneMatch;
    }
    return family.entries.find((entry) => entry.assetId === remembered[family.family]) ?? family.entries[0];
  };

  const take = (assetId: string | undefined): void => {
    knowledgePanel.cancel('take');
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (!assetId) return;
    store.setPlacement(assetId);
  };

  const takeEntry = (family: AssetFamily, entry: AssetEntry): void => {
    remember(family.family, entry.assetId);
    take(entry.assetId);
  };

  const recentEntries = recent
    .map((id) => catalog.entriesById[id])
    .filter((entry): entry is AssetEntry => Boolean(entry))
    .slice(0, RECENT_LIMIT);

  const wishNames = hasWish ? families.filter(familyWished).map((family) => family.displayName) : [];

  const searchRow = (
    <div className="shelf-search-row">
      <label className="shelf-search">
        <span className="shelf-search-icon" aria-hidden="true">
          ⌕
        </span>
        <input
          type="search"
          value={query}
          data-testid="shelf-search"
          placeholder="搜索花材名称"
          aria-label="搜索花材名称"
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button
            type="button"
            className="shelf-search-clear"
            data-testid="shelf-search-clear"
            aria-label="清空搜索"
            onClick={() => setQuery('')}
          >
            ×
          </button>
        ) : null}
      </label>
      <span className="shelf-count" data-testid="shelf-count">
        {visibleFamilies.length}/{families.length}
      </span>
    </div>
  );

  const body = (
    <div className="shelf-root">
      {embedded ? null : (
        <>
          <div className="panel-head">
            <h2>花材架</h2>
            <span className="panel-meta">
              {catalogStatus === 'manifest' ? `${families.length} 花型 · ${entryCount} 配色` : '程序化占位'}
            </span>
          </div>
          <p className="panel-note">拖一枝到花束上，或者点一下再点工作台。</p>
        </>
      )}
      {embedded && catalogStatus === 'builtin' ? (
        <p className="panel-note panel-note-quiet">真实花材还在路上，先用占位花练手。</p>
      ) : null}

      {searchRow}

      {/* V16 §2：紧凑类目入口——三组常驻，点开才展开该类目下的小类。 */}
      <div className="shelf-filter-row shelf-cat-row" role="group" aria-label="花材类目">
        <button
          type="button"
          className={`shelf-chip ${category === 'all' ? 'is-on' : ''}`}
          data-testid="shelf-cat-all"
          aria-pressed={category === 'all'}
          onClick={() => {
            setCategory('all');
            setOpenGroup(null);
          }}
        >
          全部
        </button>
        {categoryGroups.map((group) => (
          <button
            key={group.id}
            type="button"
            className={`shelf-chip shelf-group-chip ${selectedGroup === group.id ? 'is-on' : ''}`}
            data-testid={`shelf-group-${group.id}`}
            aria-expanded={openGroup === group.id}
            aria-pressed={selectedGroup === group.id}
            title={group.note}
            onClick={() => {
              setOpenGroup(openGroup === group.id ? null : group.id);
            }}
          >
            {group.label}
            <span aria-hidden="true">{openGroup === group.id ? ' ▾' : ' ▸'}</span>
          </button>
        ))}
      </div>

      {openGroup ? (
        <div className="shelf-filter-row shelf-subcat-row" role="group" aria-label="花材细分类目" data-testid="shelf-subcats">
          <span className="shelf-subcat-note">{CATEGORY_GROUPS.find((item) => item.id === openGroup)?.note}</span>
          {subCategories.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`shelf-chip shelf-subcat-chip ${category === item.id ? 'is-on' : ''}`}
              data-testid={`shelf-cat-${item.id}`}
              aria-pressed={category === item.id}
              title={item.note}
              onClick={() => setCategory(category === item.id ? 'all' : item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
      {category !== 'all' ? (
        <p className="shelf-cat-note" data-testid="shelf-cat-note">
          {categoryLabel(category)}：{CATEGORIES.find((item) => item.id === category)?.note}
          <button type="button" className="shelf-cat-clear" onClick={() => setCategory('all')}>
            看全部
          </button>
        </p>
      ) : null}

      <div className="shelf-filter-row shelf-tone-row" role="group" aria-label="按色系筛选">
        <button
          type="button"
          className={`shelf-chip ${tone === 'all' ? 'is-on' : ''}`}
          data-testid="shelf-color-all"
          aria-pressed={tone === 'all'}
          onClick={() => setTone('all')}
        >
          全部色
        </button>
        {TONES.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`shelf-chip ${tone === item.key ? 'is-on' : ''}`}
            data-testid={`shelf-color-${item.key}`}
            aria-pressed={tone === item.key}
            onClick={() => setTone(tone === item.key ? 'all' : item.key)}
          >
            <span className="shelf-chip-dot" style={{ background: item.dot }} aria-hidden="true" />
            {item.label}
          </button>
        ))}
      </div>

      {recentEntries.length ? (
        <div className="shelf-recent" data-testid="shelf-recent">
          <span className="shelf-recent-label">最近</span>
          <div className="shelf-recent-track">
            {recentEntries.map((entry) => (
              <button
                key={entry.assetId}
                type="button"
                className="shelf-recent-chip"
                data-testid="shelf-recent-chip"
                data-asset-id={entry.assetId}
                title={`最近用过：${entry.displayName}`}
                onClick={() => {
                  remember(entry.family, entry.assetId);
                  store.setPlacement(entry.assetId);
                }}
              >
                <span className="shelf-tone-dot" style={{ background: entry.color }} aria-hidden="true" />
                {entry.familyName}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="shelf-recent-clear"
            data-testid="shelf-recent-clear"
            onClick={() => {
              setRecent([]);
              writeStorage(RECENT_KEY, []);
            }}
          >
            清除
          </button>
        </div>
      ) : null}

      {hasWish && wishNames.length ? (
        <div className="shelf-wish-line" data-testid="shelf-wish-line">
          <span className="shelf-wish-label">委托心愿</span>
          <strong title={wishNames.join('、')}>{wishNames.join(' · ')}</strong>
        </div>
      ) : null}

      <div className="shelf-scroll">
        {visibleFamilies.length === 0 ? (
          <div className="shelf-empty" data-testid="shelf-empty">
            没有找到匹配的花材。
            <button type="button" onClick={resetFilters}>
              清空筛选
            </button>
          </div>
        ) : (
          <div className="shelf-grid" data-testid="shelf-grid">
            {visibleFamilies.map((family) => {
              const chosen = chosenEntry(family);
              const active = placement
                ? family.entries.some((entry) => entry.assetId === placement.assetId)
                : false;
              const expanded = active && family.entries.length > 1;
              const wished = familyWished(family);
              return (
                <article
                  key={family.family}
                  className={`shelf-card ${active ? 'is-active' : ''} ${wished ? 'is-wish' : ''} ${coach.active && coachFamilies.includes(family.family) ? 'is-coach' : ''}`}
                  data-testid={`shelf-card-${family.family}`}
                  data-family={family.family}
                  data-kind={family.kind}
                  data-wish={wished ? '1' : '0'}
                  data-phase={knowledge.phase}
                  onPointerEnter={() => knowledgePanel.hoverStart(family.family)}
                  onPointerLeave={() => knowledgePanel.hoverEnd(family.family)}
                >
                  <button
                    type="button"
                    className="shelf-card-main"
                    data-testid={`palette-${family.family}`}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      // 开始取花/拖取时立即取消知识浮窗与计时，保证原拖取行为。
                      knowledgePanel.cancel('drag');
                      suppressClick.current = false;
                      drag.current = {
                        x: event.clientX,
                        y: event.clientY,
                        assetId: chosen.assetId,
                        started: false,
                      };
                    }}
                    onDragStart={(event) => event.preventDefault()}
                    onClick={() => takeEntry(family, chosen)}
                    title={`拿一枝${family.displayName}（按住可拖到花束上）`}
                  >
                    {/* 占位/可翻瓣小标签绝对定位，不进入花名文本，避免影响搜索与读屏的花名。 */}
                    {!chosen.glb || flowerOrganizeCapability(family.family).flip ? (
                      <span className="shelf-badges" aria-hidden="true">
                        {!chosen.glb ? (
                          <span className="shelf-placeholder-badge" title="程序化占位模型，真实模型待生成">
                            占位
                          </span>
                        ) : null}
                        {flowerOrganizeCapability(family.family).flip ? (
                          <span className="shelf-flip-badge" title="这枝花支持整理里的翻瓣">
                            可翻瓣
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                    <span className="shelf-thumb">
                      <ModelThumbnail entry={chosen} catalog={catalog} />
                    </span>
                    <span className="shelf-card-text">
                      <span className="shelf-name">{family.displayName}</span>
                      <span className="shelf-sub">
                        <span className="shelf-tone-dot" style={{ background: chosen.color }} aria-hidden="true" />
                        {KIND_LABEL[family.kind]} · {chosen.variantName}
                      </span>
                    </span>
                    {wished ? (
                      <span className="shelf-wish-badge" title="符合本期委托心愿">
                        心愿
                      </span>
                    ) : null}
                  </button>
                  {/* V16 §4：「了解」入口（窄屏/触屏也能打开同一份知识卡）。 */}
                  <button
                    type="button"
                    className="shelf-know"
                    data-testid={`shelf-know-${family.family}`}
                    aria-label={`了解${family.displayName}`}
                    title={`了解${family.displayName}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      knowledgePanel.open(family.family, event.currentTarget);
                    }}
                  >
                    了解
                  </button>
                  {expanded ? (
                    <div className="shelf-variants" data-testid={`shelf-variants-${family.family}`}>
                      {family.entries.map((entry) => (
                        <button
                          key={entry.assetId}
                          type="button"
                          className={`variant-dot shelf-variant ${chosen.assetId === entry.assetId ? 'is-on' : ''} ${entryWished(family, entry) ? 'is-wish' : ''}`}
                          data-testid={`palette-${entry.assetId}`}
                          style={{ background: entry.color }}
                          title={`${entry.displayName}${full ? '（已满 20 枝）' : ''}`}
                          aria-label={`选${entry.displayName}`}
                          onPointerDown={(event) => {
                            if (event.button !== 0) return;
                            remember(family.family, entry.assetId);
                            suppressClick.current = false;
                            drag.current = {
                              x: event.clientX,
                              y: event.clientY,
                              assetId: entry.assetId,
                              started: false,
                            };
                          }}
                          onDragStart={(event) => event.preventDefault()}
                          onClick={() => takeEntry(family, entry)}
                        />
                      ))}
                      <span className="shelf-variant-name">{chosen.variantName}</span>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
        {filtersActive && visibleFamilies.length > 0 ? (
          <button type="button" className="shelf-reset-filters" data-testid="shelf-reset-filters" onClick={resetFilters}>
            清空筛选
          </button>
        ) : null}
      </div>
      {full ? (
        <p className="panel-warn shelf-full-warn" data-testid="shelf-full-warn">
          已经放满 {MAX_STEMS} 枝，先删一枝再放新的。
        </p>
      ) : null}
      {/* V16 §4 / §2：知识浮窗与新手引导都由花材架触发，用 portal 挂到 body。 */}
      <KnowledgeCardHost />
      <OnboardingCoach />
    </div>
  );

  if (embedded) {
    return (
      <div className="palette-inner palette-panel shelf-panel" data-testid="palette-panel" aria-label="花材架">
        {body}
      </div>
    );
  }
  return (
    <section className="panel palette-panel shelf-panel" aria-label="花材架" data-testid="palette-panel">
      {body}
    </section>
  );
}
