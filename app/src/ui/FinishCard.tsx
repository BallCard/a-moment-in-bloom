import { useState } from 'react';
import { BRAND } from '../data/brand';
import { useAppState } from '../state/useStore';
import { getCommission } from '../data/commissions';
import { CustomerPortrait } from './CustomerPortrait';
import { store } from '../state/store';
import type { AlbumEntry } from '../data/types';
interface Props { onDeliver: () => Promise<void>; onSaveAlbum: () => Promise<AlbumEntry | null> }

/**
 * 保存成功卡（V13）：拍照存相册后替代「已保存」的空状态。
 *
 * 显示 saveToAlbum 返回的 AlbumEntry.name 与这张照片的缩略图，并给两个出口：
 * 「继续创作」回到摆花 / 「查看相册」打开相册。样式在 photo-stage.css。
 */
export function SavedWorkCard({
  entry,
  onContinue,
  onOpenAlbum,
}: {
  entry: AlbumEntry;
  onContinue: () => void;
  onOpenAlbum: () => void;
}): React.JSX.Element {
  const latest = entry.photos[entry.photos.length - 1];
  const cover = latest?.thumbnail || entry.thumbnail;
  return (
    <div className="photo-save-success" data-testid="photo-save-success" data-name={entry.name}>
      <p className="finish-eyebrow">已存进相册</p>
      <div className="photo-save-row">
        {cover ? <img src={cover} alt={`「${entry.name}」的照片缩略图`} /> : null}
        <div className="photo-save-meta">
          <strong data-testid="photo-save-name">{entry.name}</strong>
          <p>这件作品已经有 {entry.photos.length} 张照片，拍摄时的作品版本一起留着。</p>
        </div>
      </div>
      <div className="photo-save-actions">
        <button type="button" className="btn btn-small" data-testid="photo-continue" onClick={onContinue}>
          继续创作
        </button>
        <button type="button" className="btn btn-small" data-testid="photo-open-album" onClick={onOpenAlbum}>
          查看相册
        </button>
      </div>
    </div>
  );
}
export function FinishCard({ onDeliver }: Props): React.JSX.Element {
  const mode=useAppState(s=>s.mode), id=useAppState(s=>s.commissionId);
  const delivered=useAppState(s=>s.commissionDeliveredAt), response=useAppState(s=>s.commissionResponse);
  const def=getCommission(id); const [busy,setBusy]=useState(false);
  const deliver=async ():Promise<void>=>{setBusy(true);try{await onDeliver();}catch{/* capture handles errors */}finally{setBusy(false);}};
  return <section className="panel finish-card" aria-label="作品与回应" data-testid="finish-card">
    <p className="finish-eyebrow">{BRAND.name}</p><h2>{mode==='commission'&&def?def.title:'给自己的花，留张照片。'}</h2>
    {mode==='commission'&&def?<><CustomerPortrait id={def.id}/><p className="finish-customer">{def.customer} · {def.occasion}</p>
      {delivered?<div className="finish-response" data-testid="finish-response"><p className="finish-response-label">顾客来信</p><p>{response}</p><button className="btn btn-small" onClick={()=>store.openAlbum()}>看看相册里的这束花</button></div>:<><p>{def.brief}</p><button className="btn btn-primary" data-testid="commission-deliver" disabled={busy} onClick={()=>void deliver()}>{busy?'正在交付…':'交付给顾客'}</button><p className="finish-action-note">交付会保存照片，回应只依据明确心愿。</p></>}
    </>:<p className="finish-note">选一处光线，转到喜欢的角度。也可以为同一束花拍几张不同的照片。</p>}
  </section>;
}
