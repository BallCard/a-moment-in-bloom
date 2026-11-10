import { useMemo, useRef, useState } from 'react';
import { ALBUM_LIMIT } from '../config';
import { flowersFromDocument, formatAlbumBytes } from '../data/album';
import { serializeAlbumBackup, type AlbumRestoreMode } from '../data/album-backup';
import { getCommission } from '../data/commissions';
import { PRESENTATION_LABELS } from '../data/presentation';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';
import { CustomerPortrait } from './CustomerPortrait';
import {
  AlbumBlockDialog,
  AlbumRestoreDialog,
  downloadAlbumBackup,
  type AlbumRestoreDialogState,
} from './AlbumBackup';
interface Props { onCaptureThumbnail:()=>Promise<string> }
/** 点评时间：坏时间显示「时间未知」，不把 Invalid Date 丢给玩家。 */
const formatReviewTime=(value:string):string=>{const date=new Date(value);return Number.isNaN(date.getTime())?'时间未知':date.toLocaleString('zh-CN');};
export function AlbumPanel({onCaptureThumbnail}:Props):React.JSX.Element|null {
  const open=useAppState(s=>s.albumOpen),album=useAppState(s=>s.album),count=useAppState(s=>s.doc.stems.length);
  const [filter,setFilter]=useState('all'),[selected,setSelected]=useState<string|null>(null),[photoId,setPhotoId]=useState('');
  const [armed,setArmed]=useState(''),[editing,setEditing]=useState(''),[name,setName]=useState(''),[busy,setBusy]=useState(false);
  const [restore,setRestore]=useState<AlbumRestoreDialogState|null>(null);
  const fileRef=useRef<HTMLInputElement>(null);
  const catalog=useAppState(s=>s.catalog);
  // 相册体积按完整备份的序列化字节估算（只读），帮助玩家区分「数量满」和「容量满」。
  const bytes=useMemo(()=>album.length?serializeAlbumBackup(album).bytes:0,[album]);
  const entry=album.find(item=>item.id===selected);
  const photo=entry?.photos.find(item=>item.id===photoId)??entry?.photos.find(item=>item.id===entry.coverId)??entry?.photos[0];
  const save=async ():Promise<void>=>{setBusy(true);try{store.saveToAlbum(await onCaptureThumbnail());}catch{/* reported by capture */}finally{setBusy(false);}};
  const close=():void=>{store.closeAlbum();setSelected(null);setArmed('');setRestore(null);};
  const pickBackup=async (event:React.ChangeEvent<HTMLInputElement>):Promise<void>=>{
    const file=event.target.files?.[0];event.target.value='';
    if(!file)return;
    try{const text=await file.text();setRestore({fileName:file.name,parse:store.parseAlbumBackup(text)});}
    catch{store.toast('备份文件读取失败，原相册未动','warn');}
  };
  const confirmRestore=(mode:AlbumRestoreMode):void=>{
    if(!restore?.parse.ok)return;
    const result=store.restoreAlbumBackup(restore.parse.preview,mode);
    // 失败（超额/容量不足/存储不可用）已由 store 提示并保留原相册；弹层保留计数供玩家调整。
    if(result.ok)setRestore(null);
  };
  const dialogs=<><AlbumBlockDialog/><AlbumRestoreDialog state={restore} onClose={()=>setRestore(null)} onConfirm={confirmRestore}/></>;
  if(!open)return <>{dialogs}</>;
  return <>{<div className="modal-backdrop" onPointerDown={e=>e.target===e.currentTarget&&close()}><div className="modal album-panel" role="dialog" aria-modal="true" aria-label="相册" data-testid="album-panel">
    <div className="modal-head"><div><p className="modal-eyebrow">花间相册</p><h2>{entry?entry.name:'把做过的花，留在这里。'}</h2><p className="modal-note">本机保存 · {album.length}/{ALBUM_LIMIT} 件作品 · 每件最多 6 张照片{bytes?<span data-testid="album-storage-note"> · 约 {formatAlbumBytes(bytes)}</span>:null}</p></div><button className="modal-close" data-testid="album-close" onClick={close} aria-label="关闭">×</button></div>
    {entry&&photo?<div className="album-detail"><div><img className="album-large-photo" src={photo.thumbnail} alt={entry.name}/><div className="album-filmstrip">{entry.photos.map((item,i)=><button key={item.id} className={`btn ${item.id===photo.id?'is-on':''}`} onClick={()=>setPhotoId(item.id)}><img src={item.thumbnail} alt={`照片 ${i+1}`}/>{item.id===entry.coverId?'封面':`照片 ${i+1}`}{item.review?' · 已点评':''}</button>)}</div></div><aside>
      <button className="btn btn-small" onClick={()=>setSelected(null)}>返回相册</button><p>{new Date(photo.createdAt).toLocaleString('zh-CN')}</p>
      {photo.review?<div className="album-photo-review" data-testid="album-photo-review"><p className="album-review-score" data-testid="album-photo-review-score">{photo.review.score}<small> / 100</small></p>{photo.review.summary?<p>{photo.review.summary}</p>:null}{photo.review.strengths.map((item,index)=><p key={`rs${index}`}>✦ {item}</p>)}{photo.review.suggestions.map((item,index)=><p key={`ra${index}`}>建议：{item}</p>)}<p className="review-meta" data-testid="album-photo-review-meta">{photo.review.model?`点评 ${photo.review.model}`:'点评模型未知'}{photo.review.visionModel?` · 视觉 ${photo.review.visionModel}`:''} · {formatReviewTime(photo.review.createdAt)}</p></div>:<p className="decor-note" data-testid="album-photo-review-empty">这张照片没有点评。</p>}
      {entry.commission?<><CustomerPortrait id={entry.commission.commissionId} small/><p className="album-commission" data-testid="album-commission">{entry.commission.customer} · {entry.commission.title}</p><blockquote>{entry.commission.response||(entry.commission.complete?getCommission(entry.commission.commissionId)?.responseComplete:getCommission(entry.commission.commissionId)?.responsePartial)}</blockquote><details><summary>当时的心愿</summary><p>{getCommission(entry.commission.commissionId)?.brief}</p></details></>:null}
      <details><summary>花材与制作记录</summary><p>{photo.doc.stems.length} 枝 · {PRESENTATION_LABELS[photo.doc.presentation.kind]}</p><p>{flowersFromDocument(photo.doc,catalog).map(f=>`${f.name} ×${f.count}`).join('、')}</p><p>每张照片对应拍摄当时的花枝、纸片与构图。</p></details>
      <div className="album-detail-actions"><button className="btn" data-testid="album-open-entry" onClick={()=>store.openAlbumEntry(entry.id,photo.id)}>打开这个版本 / 再拍</button><button className="btn" onClick={()=>store.setAlbumCover(entry.id,photo.id)} disabled={entry.coverId===photo.id}>设为封面</button><button className="btn" data-testid="album-copy" onClick={()=>store.copyAlbumEntryToFree(entry.id,photo.id)}>复制后修改</button>
      {editing===entry.id?<input className="input" aria-label="作品名" data-testid="album-rename-input" autoFocus value={name} maxLength={24} onChange={e=>setName(e.target.value)} onBlur={()=>{store.renameAlbumEntry(entry.id,name);setEditing('');}} onKeyDown={e=>e.key==='Enter'&&e.currentTarget.blur()}/>:<button className="btn" data-testid="album-rename" onClick={()=>{setEditing(entry.id);setName(entry.name);}}>改名</button>}
      <button className="btn btn-danger" data-testid="album-delete" data-armed={armed===entry.id} onClick={()=>{if(armed===entry.id){store.deleteAlbumEntry(entry.id);setSelected(null);}else setArmed(entry.id);}}>{armed===entry.id?'再点删除':'删除作品'}</button></div><p className="modal-note">打开会恢复这张照片的制作版本，原照片保留。</p>
    </aside></div>:<><div className="album-actions"><div className="presentation-tabs">{[['all','全部'],['commission','心愿作品'],['free','自由创作']].map(([id,label])=><button className={`btn ${filter===id?'is-on':''}`} key={id} onClick={()=>setFilter(id)}>{label}</button>)}</div><div className="album-actions-buttons"><button className="btn" data-testid="album-save-current" disabled={!count||busy} onClick={()=>void save()}>{busy?'正在拍照…':'拍下当前作品'}</button><button className="btn" data-testid="album-backup-download" onClick={()=>downloadAlbumBackup()}>下载备份</button><button className="btn" data-testid="album-backup-restore" onClick={()=>fileRef.current?.click()}>恢复备份</button><input ref={fileRef} hidden type="file" accept="application/json,.json" data-testid="album-backup-input" onChange={event=>void pickBackup(event)}/></div></div>
    {!album.length?<div className="album-empty" data-testid="album-empty">相册还是空的，先做一束喜欢的花吧。</div>:<div className="album-grid">{album.filter(item=>filter==='all'||item.mode===filter).map(item=><article className="album-entry" data-testid="album-entry" key={item.id}><button className="album-cover-button" onClick={()=>{setSelected(item.id);setPhotoId(item.coverId);}}><img src={item.thumbnail} alt={item.name} loading="lazy"/><h3>{item.name}</h3><p>{item.commission?`${item.commission.customer}的心愿`:'自由创作'} · {item.photos.length} 张照片</p></button></article>)}</div>}</>}
  </div></div>}{dialogs}</>;
}
