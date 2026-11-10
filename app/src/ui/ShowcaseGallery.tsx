import {useEffect, useRef, useState} from 'react';
import {SHOWCASE_ITEMS, SHOWCASE_HANDMADE_ITEMS, SHOWCASE_LUX3D_ITEMS, showcaseAsset, type ShowcaseItem} from '../data/showcase';
import './showcase-gallery.css';

/** 滚轮累计到这么多像素才换一件，避免触控板轻微滑动就跳图。 */
const WHEEL_SWITCH_DISTANCE = 30;
/** 两次切换之间的最短间隔（毫秒），连续快速滚动时保持克制。 */
const WHEEL_SWITCH_COOLDOWN = 320;
/** 文案先淡出，再换内容淡入。 */
const CAPTION_SWAP_MS = 150;

function sourceLabel(item: ShowcaseItem): string {
  return item.source === 'handmade' ? '逐枝搭配 · 拍下的成品' : '整束作品 · 慢慢欣赏';
}

function GalleryCard({item}: {item: ShowcaseItem}): React.JSX.Element {
  const handmade = item.source === 'handmade';
  return <article className="gallery-item" data-testid={`gallery-${item.id}`} data-source={item.source}>
    <a className="gallery-cover" href={`?exhibit=${item.id}`} aria-label={`欣赏${item.title}`}>
      <img src={showcaseAsset(item.cover)} alt={`${item.title}成品封面`} loading="lazy" width="1200" height="1400"/>
      <span>{handmade ? '看看成品 ↗' : '欣赏三维作品 ↗'}</span>
    </a>
    <div className="gallery-label">
      <span>{item.number}</span>
      <div>
        <h3>{item.title}</h3>
        <p>{item.flowers}</p>
        {handmade ? <span className="gallery-tag" data-testid="gallery-handmade-tag">工作台手作</span> : null}
      </div>
    </div>
    <a className="gallery-start" href={`?palette=${item.id}`} data-testid={`gallery-palette-${item.id}`}>↓ 用这个配色开始创作</a>
  </article>;
}

/** 工作台右栏用的卡片列表（原样保留）。 */
function PanelGallery(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <aside className={`showcase-gallery${open ? ' is-open' : ''}`} aria-label="花间作品展" data-testid="showcase-gallery">
    <button className="gallery-mobile-toggle btn" onClick={()=>setOpen(!open)} aria-expanded={open} aria-controls="gallery-collection">{open?'收起作品展':'看看花间作品'}</button>
    <div className="gallery-collection" id="gallery-collection">
      <header className="gallery-heading"><div><p>THE BLOOM COLLECTION</p><h2>花间作品展</h2></div><span>{String(SHOWCASE_ITEMS.length).padStart(2,'0')}</span></header>
      <p className="gallery-intro">先欣赏一束花，<br/>再慢慢做出自己的心意。</p>
      <p className="gallery-group">整束生成 · Lux3D</p>
      <div className="gallery-list">{SHOWCASE_LUX3D_ITEMS.map(item=><GalleryCard item={item} key={item.id}/>)}</div>
      <p className="gallery-group" data-testid="gallery-group-handmade">工作台手作 · 逐枝搭配后拍摄</p>
      <div className="gallery-list">{SHOWCASE_HANDMADE_ITEMS.map(item=><GalleryCard item={item} key={item.id}/>)}</div>
      <p className="gallery-foot">整束生成作品 · 可旋转欣赏<br/>手作作品 · 在工作台里一步步做出来</p>
    </div>
  </aside>;
}

/**
 * 开屏右侧的作品展示：没有卡片、边框和滚动条，作品图铺满整个右半屏，
 * 文字压在图上；鼠标在右侧时滚轮换一件，窄屏和触屏用左右按钮。
 * 样式在 start-screen.css 的「展开作品展」一节（跟随开屏版面，不是右栏卡片）。
 */
function StageGallery(): React.JSX.Element {
  const total = SHOWCASE_ITEMS.length;
  const [index, setIndex] = useState(0);
  const [swapping, setSwapping] = useState(false);
  const root = useRef<HTMLElement | null>(null);
  const swapTimer = useRef<number | undefined>(undefined);
  const wheelAcc = useRef(0);
  const wheelAt = useRef(0);

  const active = SHOWCASE_ITEMS[index];

  const moveTo = (resolve: (current: number) => number): void => {
    window.clearTimeout(swapTimer.current);
    setSwapping(true);
    swapTimer.current = window.setTimeout(() => {
      setIndex(current => (resolve(current) + total) % total);
      setSwapping(false);
    }, CAPTION_SWAP_MS);
  };
  const shift = (direction: number): void => {
    if (total < 2) return;
    moveTo(current => current + direction);
  };
  // 滚轮监听只挂一次，用 ref 取到最新的 shift。
  const shiftRef = useRef(shift);
  shiftRef.current = shift;

  useEffect(() => () => window.clearTimeout(swapTimer.current), []);

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const onWheel = (event: WheelEvent): void => {
      // 浏览器缩放（Ctrl/⌘+滚轮）和横向滚动不当作换作品。
      if (event.ctrlKey || event.metaKey) return;
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (Math.abs(delta) < 1) return;
      // 滚轮只在这一块里换作品，不会带着整页滚。
      event.preventDefault();
      const now = performance.now();
      if (now - wheelAt.current < WHEEL_SWITCH_COOLDOWN) {
        wheelAcc.current = 0;
        return;
      }
      wheelAcc.current += delta;
      if (Math.abs(wheelAcc.current) < WHEEL_SWITCH_DISTANCE) return;
      wheelAt.current = now;
      wheelAcc.current = 0;
      shiftRef.current(delta > 0 ? 1 : -1);
    };
    node.addEventListener('wheel', onWheel, {passive: false});
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      shift(1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      shift(-1);
    }
  };

  const handmade = active.source === 'handmade';

  return <aside
    ref={root}
    className={`showcase-gallery is-stage${swapping ? ' is-swapping' : ''}`}
    data-testid="showcase-gallery"
    data-active-id={active.id}
    data-index={index}
    aria-label="花间作品展"
    onKeyDown={onKeyDown}
  >
    <div className="stage-frames">
      {SHOWCASE_ITEMS.map((item, position) => (
        <figure
          key={item.id}
          className={`stage-frame${position === index ? ' is-active' : ''}`}
          data-testid={`stage-${item.id}`}
          data-source={item.source}
          aria-hidden={position !== index}
        >
          <img
            src={showcaseAsset(item.cover)}
            alt={`${item.title}成品封面`}
            width="480"
            height="560"
            draggable={false}
            loading={position === 0 ? 'eager' : 'lazy'}
          />
        </figure>
      ))}
    </div>

    <div className="stage-top">
      <p className="stage-eyebrow">THE BLOOM COLLECTION</p>
      <div className="stage-meta">
        <p className="stage-index" data-testid="gallery-index">
          <span className="stage-index-now">{active.number}</span>
          <span className="stage-index-total">/ {String(total).padStart(2, '0')}</span>
        </p>
        <nav className="stage-dots" aria-label="切换作品">
          {SHOWCASE_ITEMS.map((item, position) => (
            <button
              key={item.id}
              type="button"
              className={`stage-dot${position === index ? ' is-on' : ''}`}
              data-testid={`gallery-dot-${item.number}`}
              aria-label={`第 ${Number(item.number)} 件：${item.title}`}
              aria-current={position === index ? 'true' : undefined}
              onClick={() => { if (position !== index) moveTo(() => position); }}
            />
          ))}
        </nav>
      </div>
    </div>

    <div className="stage-caption" data-testid="gallery-caption">
      <p className="stage-kicker">{sourceLabel(active)}</p>
      <h2 className="stage-title">{active.title}</h2>
      <p className="stage-english">{active.english}</p>
      <p className="stage-desc">{active.description}</p>
      <p className="stage-flowers">{active.flowers}</p>
      {handmade ? <span className="stage-tag" data-testid="gallery-handmade-tag">工作台手作</span> : null}
      <div className="stage-actions">
        <a className="stage-start" href={`?palette=${active.id}`} data-testid={`gallery-palette-${active.id}`}>用这个配色开始创作</a>
        <a className="stage-view" href={`?exhibit=${active.id}`}>欣赏这件作品 ↗</a>
      </div>
    </div>

    <div className="stage-nav">
      <p className="stage-hint">
        <span className="hint-wheel">滚动滚轮，换一件作品</span>
        <span className="hint-touch">点左右按钮，换一件作品</span>
      </p>
      <div className="stage-arrows">
        <button type="button" className="stage-arrow" data-testid="gallery-prev" aria-label="上一件作品" onClick={() => shift(-1)}>←</button>
        <button type="button" className="stage-arrow" data-testid="gallery-next" aria-label="下一件作品" onClick={() => shift(1)}>→</button>
      </div>
    </div>
  </aside>;
}

export function ShowcaseGallery({variant = 'panel'}: {variant?: 'panel' | 'stage'} = {}): React.JSX.Element {
  return variant === 'stage' ? <StageGallery /> : <PanelGallery />;
}
