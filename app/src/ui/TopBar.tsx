import { useEffect, useRef, useState } from 'react';
import { MAX_STEMS } from '../config';
import { BRAND } from '../data/brand';
import { getCommission } from '../data/commissions';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';
import { AudioToggle } from './AudioToggle';
import { FileTools } from './FileTools';
import {
  setAssist,
  setMotion,
  useAssistSnapping,
  useAssistSuggestions,
  useMotion,
} from './workflow';

interface Props {
  onOpenStart: () => void;
  onOpenGallery: () => void;
  onResetView: () => void;
  onOpenCommissions: () => void;
  onOpenAlbum: () => void;
  onExportPng: () => Promise<{ blob: Blob; width: number; height: number }>;
  onImported: () => void;
}

function formatSavedAt(savedAt: number | null): string {
  if (!savedAt) return '自动保存开着';
  const date = new Date(savedAt);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `已保存 ${time}`;
}

type Popover = 'assist' | 'more' | null;

/**
 * 顶栏只留「每一步都会用到」的东西：阶段、撤销/重做、辅助开关、相册。
 * 清空、重置视角、导入导出、调试都收进「更多」，避免一排按钮压着画面。
 */
export function TopBar({
  onOpenStart,
  onOpenGallery,
  onResetView,
  onOpenCommissions,
  onOpenAlbum,
  onExportPng,
  onImported,
}: Props): React.JSX.Element {
  const canUndo = useAppState((state) => state.pastCount > 0);
  const canRedo = useAppState((state) => state.futureCount > 0);
  const stemCount = useAppState((state) => state.doc.stems.length);
  const savedAt = useAppState((state) => state.savedAt);
  const debugVisible = useAppState((state) => state.debugVisible);
  const mode = useAppState((state) => state.mode);
  const commissionId = useAppState((state) => state.commissionId);
  const snapping = useAssistSnapping();
  const suggestionsOn = useAssistSuggestions();
  const motion = useMotion();
  const [openMenu, setOpenMenu] = useState<Popover>(null);
  const [clearArmed, setClearArmed] = useState(false);
  const clearTimer = useRef<number | null>(null);
  const barRef = useRef<HTMLElement>(null);
  const commission = getCommission(commissionId);

  const disarmClear = (): void => {
    if (clearTimer.current !== null) {
      window.clearTimeout(clearTimer.current);
      clearTimer.current = null;
    }
    setClearArmed(false);
  };

  const handleClear = (): void => {
    if (!clearArmed) {
      setClearArmed(true);
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
      clearTimer.current = window.setTimeout(() => {
        clearTimer.current = null;
        setClearArmed(false);
      }, 3500);
      return;
    }
    disarmClear();
    store.clearStems();
    setOpenMenu(null);
  };

  useEffect(() => () => {
    if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
  }, []);

  // 点空白或按 Esc 收起浮层；点浮层内部不收起。
  useEffect(() => {
    if (!openMenu) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (barRef.current && !barRef.current.contains(event.target as Node)) setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenu]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        // 浏览器保存网页的快捷键在这里没有意义，顺便挡一下。
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <header className="topbar" ref={barRef}>
      <div className="brand card">
        <img className="brand-mark" src={BRAND.logo} alt="" width="38" height="38" />
        <div className="brand-text">
          <h1>{BRAND.name}</h1>
          <p>{BRAND.tagline}</p>
        </div>
      </div>

      <div className="mode-switch card" role="group" aria-label="模式">
        <button
          type="button"
          className={`mode-btn ${mode === 'free' ? 'is-on' : ''}`}
          data-testid="mode-free"
          aria-pressed={mode === 'free'}
          onClick={() => store.setMode('free')}
          title="自己挑花、自己搭配，不受要求限制"
        >
          自由制作
        </button>
        <button
          type="button"
          className={`mode-btn ${mode === 'commission' ? 'is-on' : ''}`}
          data-testid="mode-commission"
          aria-pressed={mode === 'commission'}
          onClick={onOpenCommissions}
          title="接一张顾客委托，按心愿做花束"
        >
          委托
        </button>
        {mode === 'commission' && commission ? (
          <span className="mode-badge" title={commission.title}>
            {commission.customer}
          </span>
        ) : null}
      </div>

      <div className="top-actions card">
        <button type="button" className="btn" data-testid="new-bouquet" onClick={onOpenStart}>新建一束</button>
        <button type="button" className="btn" data-testid="gallery-open" onClick={onOpenGallery}>作品展</button>
        <span className="pill" data-testid="stem-count">
          {stemCount}/{MAX_STEMS} 枝
        </span>
        <button
          type="button"
          className="btn"
          data-testid="undo"
          disabled={!canUndo}
          onClick={() => store.undo()}
          title="撤销上一步（Ctrl+Z）"
        >
          撤销
        </button>
        <button
          type="button"
          className="btn"
          data-testid="redo"
          disabled={!canRedo}
          onClick={() => store.redo()}
          title="重做（Ctrl+Shift+Z）"
        >
          重做
        </button>

        <div className="top-menu-wrap">
          <button
            type="button"
            className={`btn ${openMenu === 'assist' ? 'is-on' : ''}`}
            data-testid="assist-menu-toggle"
            aria-expanded={openMenu === 'assist'}
            onClick={() => setOpenMenu(openMenu === 'assist' ? null : 'assist')}
            title="轻吸附、摆放建议、动效设置"
          >
            辅助
          </button>
          {openMenu === 'assist' ? (
            <div className="top-menu assist-menu" role="dialog" aria-label="辅助设置" data-testid="assist-menu">
              <p className="menu-title">上手辅助</p>
              <button
                type="button"
                className={`menu-row ${snapping ? 'is-on' : ''}`}
                data-testid="assist-snapping"
                aria-pressed={snapping}
                onClick={() => setAssist({ snapping: !snapping })}
              >
                <span>
                  <b>轻吸附</b>
                  <em>靠近建议位时轻轻吸过去，不会停在你松手的位置</em>
                </span>
                <span className="switch" aria-hidden="true">{snapping ? '开' : '关'}</span>
              </button>
              <button
                type="button"
                className={`menu-row ${suggestionsOn ? 'is-on' : ''}`}
                data-testid="assist-suggestions"
                aria-pressed={suggestionsOn}
                onClick={() => setAssist({ suggestions: !suggestionsOn })}
              >
                <span>
                  <b>摆放建议</b>
                  <em>摆放时在画面上标 2–3 个建议位，并说明理由</em>
                </span>
                <span className="switch" aria-hidden="true">{suggestionsOn ? '开' : '关'}</span>
              </button>
              <button
                type="button"
                className={`menu-row ${motion === 'reduced' ? 'is-on' : ''}`}
                data-testid="motion-toggle"
                aria-pressed={motion === 'reduced'}
                onClick={() => setMotion(motion === 'reduced' ? 'auto' : 'reduced')}
              >
                <span>
                  <b>动效：{motion === 'reduced' ? '精简' : '完整'}</b>
                  <em>
                    完整：镜头会平滑推到新视角，面板和包装有过渡。精简：去掉镜头移动与滑动，只保留必要淡入，操作立刻到位，适合容易晕或想更快的人。
                  </em>
                </span>
                <span className="switch" aria-hidden="true">{motion === 'reduced' ? '精简' : '完整'}</span>
              </button>
              <p className="menu-note">系统开启「减少动态效果」时，会自动按精简动效运行。</p>
            </div>
          ) : null}
        </div>

        <AudioToggle />

        <button
          type="button"
          className="btn"
          data-testid="album-open"
          onClick={() => {
            setOpenMenu(null);
            onOpenAlbum();
          }}
          title="打开相册，看看做过的花束"
        >
          相册
        </button>

        <div className="top-menu-wrap">
          <button
            type="button"
            className={`btn ${openMenu === 'more' ? 'is-on' : ''}`}
            data-testid="more-menu-toggle"
            aria-expanded={openMenu === 'more'}
            onClick={() => setOpenMenu(openMenu === 'more' ? null : 'more')}
            title="视角、清空、调试等"
          >
            更多
          </button>
          {openMenu === 'more' ? (
            <div className="top-menu more-menu" role="menu" aria-label="更多操作" data-testid="more-menu">
              <a className="menu-row about-link" href="?exhibit=morning" data-testid="exhibit-open">
                <span><b>花间作品展</b><em>旋转欣赏花间成品 · Lux3D 整束生成</em></span>
              </a>
              <a className="menu-row about-link" href={BRAND.about} target="_blank" rel="noopener noreferrer">
                <span><b>关于{BRAND.name}</b><em>{BRAND.category} · 了解作品</em></span>
              </a>
              <button type="button" className="menu-row" data-testid="reset-view" onClick={() => { onResetView(); setOpenMenu(null); }}>
                <span>
                  <b>重置视角</b>
                  <em>回到当前阶段的斜 45° 机位</em>
                </span>
              </button>
              <button
                type="button"
                className={`menu-row ${debugVisible ? 'is-on' : ''}`}
                data-testid="toggle-debug"
                onClick={() => store.setDebugVisible(!debugVisible)}
              >
                <span>
                  <b>调试信息</b>
                  <em>显示帧率、三角形数与花枝数</em>
                </span>
                <span className="switch" aria-hidden="true">{debugVisible ? '开' : '关'}</span>
              </button>
              <button
                type="button"
                className={`menu-row menu-row-danger ${clearArmed ? 'is-on' : ''}`}
                data-testid="clear-all"
                data-armed={clearArmed ? 'true' : 'false'}
                onClick={handleClear}
              >
                <span>
                  <b>{clearArmed ? '再点一次清空' : '清空重来'}</b>
                  <em>{clearArmed ? '再点一次确认，清空后仍可撤销' : '清空所有花枝（会先确认一次）'}</em>
                </span>
              </button>
              <FileTools
                onExportPng={onExportPng}
                onImported={() => {
                  onImported();
                  setOpenMenu(null);
                }}
              />
            </div>
          ) : null}
        </div>

        <span className="save-hint">{formatSavedAt(savedAt)}</span>
      </div>
    </header>
  );
}
