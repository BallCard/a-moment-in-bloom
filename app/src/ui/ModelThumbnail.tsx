import { useEffect, useRef, useState } from 'react';
import { assetThumbnail } from '../three/assets/thumbnails';
import type { AssetEntry,RuntimeCatalog } from '../data/types';

/**
 * 花材架缩略图。
 *
 * 清单里有 `thumb` 时直接用静态图（不下载 GLB）；静态图 404 / 解码失败时
 * 由 <img onError> 触发一次运行时渲染回退——这是真的回退到加载模型渲染，
 * 而不是把错误吞掉。两次都失败就显示种类名占位，不影响取花。
 */
export function ModelThumbnail({entry,catalog}:{entry:AssetEntry;catalog:RuntimeCatalog}):React.JSX.Element {
  const [src,setSrc]=useState('');
  const runtimeRef=useRef(false);
  useEffect(()=>{let active=true;setSrc('');runtimeRef.current=false;
    void assetThumbnail(entry,catalog).then(url=>{if(active)setSrc(url);}).catch(()=>{});
    return()=>{active=false;};
  },[entry,catalog]);
  const onError=():void=>{
    if(runtimeRef.current){setSrc('');return;}
    runtimeRef.current=true;setSrc('');
    void assetThumbnail(entry,catalog,{forceRuntime:true}).then(url=>setSrc(url)).catch(()=>setSrc(''));
  };
  return src
    ?<img src={src} alt={entry.displayName} draggable={false} className="model-thumbnail" onError={onError}/>
    :<span className="model-thumbnail-loading">{entry.familyName}</span>;
}
