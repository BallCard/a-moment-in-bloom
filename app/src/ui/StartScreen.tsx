import {useState} from 'react';
import {store} from '../state/store';
import {SETTINGS_KEY, STORAGE_KEY} from '../config';
import {createEmptyDocument, sanitizeDocument} from '../data/document';
import {ShowcaseGallery} from './ShowcaseGallery';
import {BRAND} from '../data/brand';
import './start-screen.css';

const BACKUP_KEY = 'bouquet-workbench.before-new.v1';

/** Write the recovery copy before replacing the live document. Storage failure
 * leaves the current work untouched. Keep commission context with the copy. */
function startBlank(): boolean {
  const state = store.getState();
  if (state.doc.stems.length) {
    try {
      localStorage.setItem(BACKUP_KEY, JSON.stringify({doc: store.getDocumentForExport(), settings: localStorage.getItem(SETTINGS_KEY)}));
    } catch { return false; }
  }
  store.replaceDocument(createEmptyDocument(state.catalog.assetsVersion, state.sizeCandidate));
  store.setMode('free');
  store.setStage('arrange');
  return true;
}

function hasBackup(): boolean {
  try { return Boolean(localStorage.getItem(BACKUP_KEY)); } catch { return false; }
}

export function StartScreen({galleryInitially = false, onContinue}: {galleryInitially?: boolean; onContinue: () => void}): React.JSX.Element {
  const [gallery, setGallery] = useState(galleryInitially);
  const [error, setError] = useState('');
  const count = store.getState().doc.stems.length;
  const restore = (): void => {
    try {
      const saved = JSON.parse(localStorage.getItem(BACKUP_KEY) ?? 'null');
      const result = sanitizeDocument(saved?.doc, store.getState().catalog.assetsVersion);
      if (!result.doc) throw Error();
      // Reload restores the saved commission session through the usual Store path.
      if (saved.settings) localStorage.setItem(SETTINGS_KEY, saved.settings);
      else localStorage.removeItem(SETTINGS_KEY);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(result.doc));
      store.replaceDocument(result.doc);
      location.assign(location.pathname);
    } catch { setError('备份暂时无法恢复，当前花束仍保留。'); }
  };
  return <main className={`start-screen${gallery ? ' has-gallery' : ''}`}>
    <section className="start-intro" aria-labelledby="start-title">
      <img src={BRAND.logo} alt="" width="72" height="72" />
      <p className="start-eyebrow">A MOMENT IN BLOOM</p>
      <h1 id="start-title">花间一刻</h1>
      <p className="start-tagline">把心意，慢慢做成一束花。</p>
      <div className="start-choices">
        {count > 0 ? <button autoFocus className="btn is-on" data-testid="start-continue" onClick={onContinue}>继续上次的花束 <small>{count} 枝 · 本机存档</small></button> : <button autoFocus className="btn is-on" data-testid="start-begin" onClick={onContinue}>开始插花</button>}
        {count > 0 ? <button className="btn" data-testid="start-blank" onClick={() => {if (startBlank()) onContinue(); else setError('本机存储空间不足，未能备份，所以还没有新建。请先继续原作品并导出备份。');}}>从空白开始</button> : null}
        <button className="btn" data-testid="start-gallery" aria-expanded={gallery} onClick={() => setGallery(!gallery)}>{gallery ? '收起作品展' : '看作品展'}</button>
      </div>
      <p className="start-note">{gallery ? '慢慢看。喜欢哪一束的配色，就直接从它开始。' : count ? '从空白开始会保留一份新建前备份。仅保留最近一份，长期收藏请存相册。' : '选几枝喜欢的花，开始今天的创作。'}</p>
      {hasBackup() ? <button className="btn btn-small" data-testid="start-restore" onClick={restore}>找回新建前的花束</button> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
    {gallery ? <section className="start-gallery" aria-label="作品集"><ShowcaseGallery variant="stage" /></section> : null}
  </main>;
}
