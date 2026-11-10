import { useEffect, useState } from 'react';
import { useAppState } from '../state/useStore';
const KEY='bouquet.first-flower-placed';
export function EmptyGuide():React.JSX.Element|null {
  const count=useAppState(s=>s.doc.stems.length),stage=useAppState(s=>s.stage),placement=useAppState(s=>s.placement);
  const [done,setDone]=useState(()=>{try{return localStorage.getItem(KEY)==='1';}catch{return false;}});
  useEffect(()=>{if(count>0){setDone(true);try{localStorage.setItem(KEY,'1');}catch{/* remember for this session */}}},[count]);
  if(done||count||placement||stage!=='arrange')return null;
  return <div className="empty-guide first-flower-hint" data-testid="empty-guide"><p>从左边拿一枝花，放到工作台上。</p></div>;
}
