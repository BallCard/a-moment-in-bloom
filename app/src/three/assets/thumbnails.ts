import * as THREE from 'three';
import { AssetLoader } from './AssetLoader';
import type { AssetEntry, RuntimeCatalog } from '../../data/types';

const loader = new AssetLoader(import.meta.env.BASE_URL,()=>{});
const cache = new Map<string,Promise<string>>();
let queue:Promise<unknown>=Promise.resolve();

/**
 * 清单里的静态缩略图 URL：`thumb` 相对 `assets/` 解析（如 `thumbs/peony-1.png`
 * → `${BASE_URL}assets/thumbs/peony-1.png`）。没有 thumb 时返回 null。
 */
export function staticThumbnailUrl(entry:AssetEntry):string|null{
  const thumb=entry.thumb;
  if(!thumb)return null;
  return `${import.meta.env.BASE_URL}assets/${thumb}`;
}

export interface ThumbnailOptions {
  /** 绕过静态缩略图，强制按真实模型渲染一次（给 <img onError> 回退用）。 */
  forceRuntime?: boolean;
}

/**
 * 花材架缩略图。
 *
 * 优先用清单给的静态图：53 条配色只加载 53 张小图，不再为每条配色下载 7–8 MB
 * 的 GLB。静态图缺失（老清单没有 thumb）或加载失败时（调用方带
 * forceRuntime 再调一次），才回退到「加载真实模型 + 离屏渲染」的旧路径。
 * 渲染使用同一套灯光与机位，保证同一花型的不同配色看起来一致。
 */
export function assetThumbnail(
  entry:AssetEntry,
  catalog:RuntimeCatalog,
  options?:ThumbnailOptions,
):Promise<string>{
  const staticUrl=options?.forceRuntime?null:staticThumbnailUrl(entry);
  if(staticUrl)return Promise.resolve(staticUrl);
  const key=`runtime:${catalog.assetsVersion}:${entry.assetId}`;
  const existing=cache.get(key);if(existing)return existing;
  const task=queue.then(async()=>{
    const loaded=await loader.load(entry,entry.assetId,catalog);
    const renderer=new THREE.WebGLRenderer({alpha:true,antialias:true});
    try {
      renderer.setSize(160,190);renderer.setPixelRatio(1);renderer.outputColorSpace=THREE.SRGBColorSpace;
      const scene=new THREE.Scene();const object=loaded.template.clone(true);scene.add(object);
      scene.add(new THREE.HemisphereLight('#ffffff','#a59b89',2.4));
      const light=new THREE.DirectionalLight('#fff6e9',3);light.position.set(-1,2,3);scene.add(light);
      const box=new THREE.Box3().setFromObject(object),center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3());
      const camera=new THREE.PerspectiveCamera(28,160/190,.01,10);
      const d=Math.max(size.y,size.x*1.4)*2.4;camera.position.copy(center).add(new THREE.Vector3(.18,.1,1).normalize().multiplyScalar(d));camera.lookAt(center);
      renderer.render(scene,camera);return renderer.domElement.toDataURL('image/png');
    } finally {renderer.dispose();renderer.forceContextLoss();}
  });
  cache.set(key,task);queue=task.catch(()=>{});return task;
}
