import { useEffect, useRef, useState } from 'react';
import { CustomerPortrait } from './CustomerPortrait';
import {
  COMMISSIONS,
  commissionWishes,
  isCommissionUnlocked,
  type CommissionWish,
} from '../data/commissions';
import { KIND_LABEL } from '../data/catalog';
import { PAPER_PRESETS, RIBBON_PRESETS } from '../data/decor';
import { ORNAMENT_DEFS } from '../data/ornaments';
import { PRESENTATION_LABELS } from '../data/presentation';
import type { PaperId, RibbonColorId, RuntimeCatalog } from '../data/types';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';
import './commission.css';

interface Props { open: boolean; busyId: string | null; onClose: () => void; onStart: (id: string) => void }

interface WishTag { key: string; label: string }

interface WishTags {
  /** 花材心愿：点名配色、同科任意配色、或整类任选。 */
  materials: WishTag[];
  /** 包装与器型心愿：花篮/陶罐/礼盒、纸色、丝带色。 */
  packaging: WishTag[];
}

/**
 * 把 commissionWishes() 的派生结果翻成看得懂的标签。
 *
 * 这里只做展示，不重新解释 CommissionCheck：花材架与判定仍然共用
 * data/commissions.ts 那一份结果，避免两处各写一套「心愿」。
 */
function wishTags(wish: CommissionWish | null, catalog: RuntimeCatalog): WishTags {
  if (!wish) return { materials: [], packaging: [] };
  const familyName = (family: string): string =>
    catalog.families.find((item) => item.family === family)?.displayName ?? family;
  const entryName = (assetId: string): string =>
    catalog.entriesById[assetId]?.displayName ?? assetId;

  const materials: WishTag[] = [
    ...wish.assetIds.map((assetId) => ({ key: `id-${assetId}`, label: entryName(assetId) })),
    ...wish.families.map((family) => ({ key: `family-${family}`, label: `${familyName(family)}（任一颜色）` })),
    ...wish.kinds.map((kind) => ({ key: `kind-${kind}`, label: `任选${KIND_LABEL[kind]}` })),
  ];
  const packaging: WishTag[] = [];
  if (wish.presentationKind) {
    packaging.push({ key: 'presentation', label: PRESENTATION_LABELS[wish.presentationKind] });
  }
  if (wish.paperId) packaging.push({ key: 'paper', label: `${PAPER_PRESETS[wish.paperId as PaperId].label}包装纸` });
  if (wish.ribbonColorId) {
    packaging.push({ key: 'ribbon', label: `${RIBBON_PRESETS[wish.ribbonColorId as RibbonColorId].label}色丝带` });
  }
  if (wish.ornamentKind) {
    packaging.push({ key: 'ornament', label: ORNAMENT_DEFS[wish.ornamentKind].label });
  }
  return { materials, packaging };
}

export function CommissionPicker({ open, busyId, onClose, onStart }: Props): React.JSX.Element | null {
  const completed=useAppState(s=>s.completedCommissions),currentId=useAppState(s=>s.commissionId),stemCount=useAppState(s=>s.doc.stems.length);
  const catalog=useAppState(s=>s.catalog);
  const [index,setIndex]=useState(0);
  const dialog=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(!open)return;const previous=document.activeElement as HTMLElement|null;dialog.current?.focus();return()=>previous?.focus();},[open]);
  const swipe=useRef<{x:number;y:number}|null>(null);
  useEffect(()=>{if(open)setIndex(Math.max(0,COMMISSIONS.findIndex(d=>d.id===currentId)));},[open,currentId]);
  if(!open)return null;
  const def=COMMISSIONS[index],done=completed.includes(def.id),unlocked=isCommissionUnlocked(def,completed);
  const tags=wishTags(commissionWishes(def.id),catalog);
  const move=(delta:number):void=>setIndex(i=>Math.max(0,Math.min(COMMISSIONS.length-1,i+delta)));
  return <div className="modal-backdrop" onPointerDown={e=>e.target===e.currentTarget&&onClose()}>
    <div ref={dialog} tabIndex={-1} className="modal commission-picker" role="dialog" aria-modal="true" aria-label="顾客委托" data-testid="commission-picker"
      onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();e.stopPropagation();move(e.key==='ArrowLeft'?-1:1);}}}>
      <div className="modal-head"><div><p className="modal-eyebrow">顾客委托</p><h2>一封来信，一束心意</h2></div><button className="modal-close" data-testid="commission-close" aria-label="关闭" onClick={onClose}>×</button></div>
      <div className="commission-pager"><button className="btn btn-small" aria-label="上一张心愿单" disabled={index===0} onClick={()=>move(-1)}>← 上一封</button><span aria-live="polite">{index+1} / {COMMISSIONS.length}</span><button className="btn btn-small" aria-label="下一张心愿单" disabled={index===COMMISSIONS.length-1} onClick={()=>move(1)}>下一封 →</button></div>
      <article key={def.id} className={`commission-card commission-letter ${unlocked?'':'is-locked'}`} data-testid="commission-card" data-commission-id={def.id}
        onPointerDown={e=>{swipe.current=null;if(!(e.target as HTMLElement).closest('button,summary,details'))swipe.current={x:e.clientX,y:e.clientY};}}
        onPointerCancel={()=>{swipe.current=null;}}
        onPointerUp={e=>{const start=swipe.current;swipe.current=null;if(start&&Math.abs(e.clientX-start.x)>65&&Math.abs(e.clientY-start.y)<45)move(e.clientX<start.x?1:-1);}}>
        <CustomerPortrait id={def.id}/><div className="commission-body"><p className="commission-kicker">{def.customer} · {def.occasion}</p><h3>{def.title}</h3><blockquote className="commission-brief">{def.brief}</blockquote>
          <details><summary>看看具体心愿 · {def.checks.length} 项</summary>
            {tags.materials.length||tags.packaging.length?<div className="commission-wish-tags" data-testid="commission-wishes">
              {tags.materials.length?<div className="wish-tag-row">
                <span className="wish-tag-caption">花材</span>
                {tags.materials.map(tag=><span key={tag.key} className="wish-tag" data-testid="commission-wish-chip">{tag.label}</span>)}
              </div>:null}
              {tags.packaging.length?<div className="wish-tag-row">
                <span className="wish-tag-caption">包装 / 器型</span>
                {tags.packaging.map(tag=><span key={tag.key} className="wish-tag wish-tag-pack" data-testid="commission-wish-chip">{tag.label}</span>)}
              </div>:null}
            </div>:null}
            <ul className="commission-checks">{def.checks.map(c=><li key={c.id}>{c.label}</li>)}</ul>
            {tags.materials.length?<p className="commission-wish-note" data-testid="commission-wish-note">花材架上已标出符合心愿的花材，照着取花就行。</p>:null}
          </details>
          <div className="commission-foot">{done?<span className="tag tag-done">已交付</span>:null}{currentId===def.id?<span className="tag">进行中</span>:null}{!unlocked?<span className="tag">先完成上一封心愿</span>:null}<button className="btn btn-primary" data-testid={`commission-start-${def.id}`} disabled={!unlocked||busyId!==null} onClick={()=>onStart(def.id)}>{busyId===def.id?'正在准备…':done?'再做一束':unlocked?'接下这份心愿':'尚未解锁'}</button></div>
        </div>
      </article>
      <p className="modal-note">左右翻阅，也可用方向键。{stemCount>0?'接单前会把手上这束存进相册。':'做好后在拍照阶段交付。'}</p>
      {COMMISSIONS.every(d=>completed.includes(d.id))?<button className="btn" data-testid="commission-leave" onClick={()=>{store.leaveCommission();onClose();}}>回到自由制作</button>:null}
    </div>
  </div>;
}
