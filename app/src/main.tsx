import { createRoot } from 'react-dom/client';
import {lazy, Suspense, useState, useEffect} from 'react';
import {StartScreen} from './ui/StartScreen';
import './styles.css';
import {findShowcase} from './data/showcase';
import {store} from './state/store';

const App = lazy(() => import('./App'));

// 被魔搭等平台嵌进 iframe 时，右上角常有平台浮层；提前打标记，
// 让右侧面板整体避开浮层（见 styles.css 的 .is-embedded 规则）。
if (window.self !== window.top) {
  document.documentElement.classList.add('is-embedded');
}

const container = document.getElementById('root');
if (!container) throw new Error('页面缺少 #root 容器');

const params = new URLSearchParams(location.search);
// 作品展 →「用这个配色开始创作」：地址栏带 ?palette=<作品 id>。
// 必须在 createRoot 之前应用，才能覆盖 Store 构造时恢复的上次作品；
// 应用成功后把参数从地址栏清掉，避免刷新或后退时重复覆盖用户改过的花束。
const paletteId = params.get('palette');
const paletteApplied = paletteId ? store.loadPaletteBouquet(paletteId) : false;
if (paletteId && paletteApplied) {
  params.delete('palette');
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

// palette 入口优先于作品展详情：两者同时出现时按「来动手」处理，直接进工作台。
const exhibitId = paletteApplied ? null : params.get('exhibit');
const exhibit = exhibitId !== null;
const item = findShowcase(exhibitId);
const BouquetExhibit = lazy(() => import('./ui/BouquetExhibit'));
const loadingMarkup = document.getElementById('boot-splash')?.innerHTML ?? '';
function LoadingScreen(): React.JSX.Element {
  return <div className="bloom-boot" role="status" dangerouslySetInnerHTML={{__html: loadingMarkup}} />;
}
function Ready(): null {
  useEffect(() => {
    const splash = document.getElementById('boot-splash');
    if (!splash) return;
    splash.classList.add('leaving');
    const timer = window.setTimeout(() => splash.remove(), 360);
    return () => window.clearTimeout(timer);
  }, []);
  return null;
}
function WorkbenchEntry(): React.JSX.Element {
  const [entry, setEntry] = useState<'workbench' | 'start' | 'gallery'>(() =>
    !paletteApplied && !params.has('sample') && store.getState().doc.stems.length > 0 ? 'start' : 'workbench');
  return entry === 'workbench'
    ? <Suspense fallback={<LoadingScreen />}><App onOpenStart={() => setEntry('start')} onOpenGallery={() => setEntry('gallery')} /><Ready /></Suspense>
    : <><StartScreen galleryInitially={entry === 'gallery'} onContinue={() => setEntry('workbench')} /><Ready /></>;
}
createRoot(container).render(exhibit ? <Suspense fallback={<LoadingScreen />}><BouquetExhibit item={item} /><Ready /></Suspense> : <WorkbenchEntry />);
