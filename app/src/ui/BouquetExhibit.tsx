import {useEffect, useRef, useState} from 'react';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {SHOWCASE_ITEMS, showcaseAsset, type ShowcaseItem} from '../data/showcase';
import './bouquet-exhibit.css';

interface ExhibitActions { reset:()=>void; capture:()=>void }

export default function BouquetExhibit({item}: {item?: ShowcaseItem}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const actions = useRef<ExhibitActions | null>(null);
  const rotating = useRef(false);
  const [auto, setAuto] = useState(false);
  const [status, setStatus] = useState<'loading'|'ready'|'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState('');

  useEffect(()=>{
    const container=host.current;
    if(!container || !item)return;
    // 工作台手作只有真实拍摄的成品封面，没有一体模型：不建 WebGL 场景。
    if(!item.model){setStatus('ready');setNotice('');return;}
    setStatus('loading');setNotice('');rotating.current=false;setAuto(false);
    let disposed=false,frame=0,object:THREE.Object3D|null=null,renderer:THREE.WebGLRenderer;
    try { renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true}); }
    catch { setStatus('error');return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    renderer.outputColorSpace=THREE.SRGBColorSpace;
    renderer.toneMapping=THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure=.93;
    renderer.shadowMap.enabled=true;
    renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    renderer.domElement.setAttribute('aria-label',`${item.title}三维花束，拖动旋转，滚轮缩放`);
    renderer.domElement.setAttribute('role','img');
    container.append(renderer.domElement);
    const scene=new THREE.Scene();
    const camera=new THREE.PerspectiveCamera(34,1,.01,20);
    const controls=new OrbitControls(camera,renderer.domElement);
    controls.enableDamping=true;controls.enablePan=false;
    let distance=1.04;
    const halfSize=new THREE.Vector3(.16,.225,.15);
    controls.minDistance=.4;controls.maxDistance=2;
    controls.minPolarAngle=.35;controls.maxPolarAngle=2.5;
    const reset=()=>{ camera.position.set(distance*.045,distance*.145,distance);controls.target.set(0,.012,0);controls.update(); };
    reset();
    scene.add(new THREE.HemisphereLight('#fffaf3','#81766a',1.5));
    const key=new THREE.DirectionalLight('#fff6ec',2.1);key.position.set(-.7,2.8,1.8);key.castShadow=true;key.shadow.mapSize.set(2048,2048);key.shadow.camera.left=-.6;key.shadow.camera.right=.6;key.shadow.camera.top=.7;key.shadow.camera.bottom=-.7;key.shadow.normalBias=.001;key.shadow.bias=-.0001;key.shadow.radius=3;scene.add(key);
    const fill=new THREE.DirectionalLight('#eef2ed',.65);fill.position.set(1.2,.6,1);scene.add(fill);
    const rim=new THREE.DirectionalLight('#fff7ec',1.1);rim.position.set(.4,1,-1.2);scene.add(rim);
    const ground=new THREE.Mesh(new THREE.PlaneGeometry(5,5),new THREE.ShadowMaterial({opacity:.075}));ground.rotation.x=-Math.PI/2;ground.position.y=-.228;ground.receiveShadow=true;scene.add(ground);
    const fit=()=>{const v=THREE.MathUtils.degToRad(camera.fov)/2;const h=Math.atan(Math.tan(v)*camera.aspect);distance=Math.max((halfSize.y+.012)/Math.tan(v),halfSize.x/Math.tan(h))*1.12+halfSize.z;controls.minDistance=distance*.58;controls.maxDistance=distance*2;reset();};
    const resize=()=>{const {width,height}=container.getBoundingClientRect();if(!width||!height)return;renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();fit();};
    const observer=new ResizeObserver(resize);observer.observe(container);resize();
    const release=(root:THREE.Object3D)=>{const materials=new Set<THREE.Material>(),textures=new Set<THREE.Texture>();root.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material]){materials.add(m);for(const value of Object.values(m))if(value instanceof THREE.Texture)textures.add(value);}}});textures.forEach(t=>t.dispose());materials.forEach(m=>m.dispose());};
    const loader=new GLTFLoader();
    void loader.loadAsync(showcaseAsset(item.model)).then(gltf=>{
      if(disposed){release(gltf.scene);return;}
      object=gltf.scene;
      const bounds=new THREE.Box3().setFromObject(object);
      const size=bounds.getSize(new THREE.Vector3());
      const scale=.45/Math.max(size.y,size.x,size.z,.001);
      halfSize.copy(size).multiplyScalar(scale*.5);
      const center=bounds.getCenter(new THREE.Vector3());
      object.scale.multiplyScalar(scale);object.position.addScaledVector(center,-scale);
      object.traverse(o=>{if(o instanceof THREE.Mesh){o.castShadow=true;o.receiveShadow=true;const material=o.material;if(material instanceof THREE.MeshStandardMaterial&&material.map)material.map.anisotropy=renderer.capabilities.getMaxAnisotropy();}});
      ground.position.y=-halfSize.y-.003;scene.add(object);fit();setStatus('ready');
    }).catch(()=>{if(!disposed)setStatus('error');});
    const pause=()=>{rotating.current=false;setAuto(false);};
    controls.addEventListener('start',pause);
    actions.current={reset:()=>{pause();reset();},capture:()=>{
      renderer.render(scene,camera);
      renderer.domElement.toBlob(blob=>{if(disposed)return;if(!blob){setNotice('图片没有生成，请重试');return;}const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`花间一刻-${item.title}-Lux3D整束.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setNotice('已发起图片下载，请查看浏览器下载记录');},'image/png');
    }};
    const clock=new THREE.Clock();let angle=0;
    const animate=()=>{frame=requestAnimationFrame(animate);const dt=Math.min(clock.getDelta(),.05);if(object&&rotating.current){angle+=dt*.34;object.rotation.y=Math.sin(angle)*.42;}else if(object){object.rotation.y=THREE.MathUtils.damp(object.rotation.y,0,7,dt);}controls.update();renderer.render(scene,camera);};animate();
    return()=>{disposed=true;cancelAnimationFrame(frame);observer.disconnect();controls.removeEventListener('start',pause);controls.dispose();release(scene);renderer.dispose();renderer.domElement.remove();actions.current=null;};
  },[attempt,item]);

  const toggle=()=>{rotating.current=!rotating.current;setAuto(rotating.current);};
  if(!item)return <main className="exhibit-missing"><p>这件作品尚未收录</p><a className="btn" href="?exhibit=morning">打开花间作品展</a><a className="btn" href="./">返回花艺工作台</a></main>;
  const handmade=item.source==='handmade';
  const paletteCount=item.palette.assetIds.length;
  return <main className="bouquet-exhibit" data-testid="bouquet-exhibit" data-source={item.source} style={{backgroundColor:item.background}}>
    <header className="exhibit-header"><a className="exhibit-brand" href="./">花间一刻<span>A MOMENT IN BLOOM</span></a><a className="btn" href="./" data-testid="exhibit-back">返回花艺工作台 ↗</a></header>
    <section className="exhibit-copy"><p className="exhibit-kicker">THE BLOOM COLLECTION / {item.number}</p><h1>{item.title}</h1><p className="exhibit-english">{item.english}</p><div className="exhibit-rule"/><p className="exhibit-description">{item.description}</p><p className="exhibit-flowers">{item.flowers}</p><p className="exhibit-source">{handmade?'工作台手作 · 逐枝搭配后拍摄':'Lux3D 整束生成作品'}</p><p className="exhibit-note">{handmade?'这束是在工作台里一枝一枝做出来的。':'拖动，看看花束的另一面。'}<br/>想亲手逐枝搭配？做一束自己的花。</p><div className="exhibit-actions"><a className="btn btn-primary" href={`./?palette=${item.id}`} data-testid="exhibit-start-palette">用这个配色开始创作 ↗</a><a className="btn" href="./" data-testid="exhibit-start-blank">先看看空白工作台</a></div><p className="exhibit-palette-note">会按这束花的配色，先摆好 {paletteCount} 枝可编辑的起点，接着调整就好。</p>
    {SHOWCASE_ITEMS.length>1?<nav className="exhibit-collection" aria-label="切换作品">{SHOWCASE_ITEMS.map(work=><a key={work.id} href={`?exhibit=${work.id}`} aria-current={item.id===work.id?'page':undefined}><span>{work.number}</span>{work.title}{work.source==='handmade'?<em>手作</em>:null}</a>)}</nav>:null}</section>
    <section className="exhibit-art" aria-label={handmade?'作品成品封面':'三维作品展示'} data-testid="exhibit-art">
      {handmade?<figure className="exhibit-cover" data-testid="exhibit-handmade"><img src={showcaseAsset(item.cover)} alt={`${item.title}成品封面，由工作台拍摄`} data-testid="exhibit-cover" width="900" height="1125"/><figcaption>工作台手作 · 逐枝搭配后拍摄的成品封面</figcaption></figure>:<>
      <div ref={host} className="exhibit-canvas" data-testid="exhibit-canvas" data-status={status}/>
      {status==='loading'?<p className="exhibit-state" role="status">正在展开这束花…</p>:null}
      {status==='error'?<div className="exhibit-state" role="alert"><p>这束花暂时没有加载好</p><button className="btn" onClick={()=>{setStatus('loading');setAttempt(n=>n+1);}}>重新加载</button><p className="exhibit-note">也可以返回工作台继续创作。</p></div>:null}
      <div className="exhibit-controls"><p>拖动欣赏 · 滚轮缩放</p><div><button className="btn" disabled={status!=='ready'} aria-pressed={auto} onClick={toggle} data-testid="exhibit-rotate">{auto?'暂停摆动':'轻轻转动'}</button><button className="btn" disabled={status!=='ready'} onClick={()=>actions.current?.reset()} data-testid="exhibit-reset">最佳视角</button><button className="btn" disabled={status!=='ready'} onClick={()=>actions.current?.capture()} data-testid="exhibit-export">导出成品图</button></div><span role="status">{notice}</span></div>
      </>}
    </section>
    <footer className="exhibit-footer"><span>把心意，慢慢做成一束花。</span><span>{handmade?'工作台手作 · 可逐枝继续编辑':'一体模型展示 · 不支持逐枝编辑'}</span></footer>
  </main>;
}
