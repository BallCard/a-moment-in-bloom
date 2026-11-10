import * as THREE from 'three';
import type { PhotoSettings } from '../../data/presentation';

export function createWindowSet():THREE.Group {
  const group=new THREE.Group();group.name='photography-window';
  const plaster=new THREE.MeshStandardMaterial({color:'#9caa98',roughness:1});
  const wood=new THREE.MeshStandardMaterial({color:'#67513c',roughness:.8});
  const sill=new THREE.MeshStandardMaterial({color:'#b3a28b',roughness:.95});
  const glass=new THREE.MeshBasicMaterial({color:'#dce5de'});
  const box=(w:number,h:number,d:number,x:number,y:number,z:number,material:THREE.Material):void=>{
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;group.add(mesh);
  };
  box(4,.1,1.6,0,.61,-.1,sill);
  box(1.6,3,.08,1.3,1.8,-.9,plaster);
  box(1.2,3,.08,-1.8,1.8,-.9,plaster);
  box(2,.5,.08,-.4,.7,-.9,plaster);
  box(2,1,.08,-.4,2.9,-.9,plaster);
  box(1.7,1.65,.025,-.4,1.8,-.92,glass);
  for(const x of [-1.25,-.4,.45])box(.035,1.72,.07,x,1.8,-.84,wood);
  for(const y of [.94,1.8,2.66])box(1.75,.035,.07,-.4,y,-.84,wood);
  // Linen curtain, real folds rather than a baked scene image.
  const g=new THREE.PlaneGeometry(.36,1.8,24,12),p=g.getAttribute('position');
  for(let i=0;i<p.count;i++)p.setZ(i,Math.sin(p.getX(i)*85)*.025);
  g.computeVertexNormals();
  const curtain=new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:'#f5eee0',roughness:1,side:THREE.DoubleSide}));curtain.position.set(-1.14,1.78,-.74);curtain.castShadow=true;group.add(curtain);
  return group;
}

/** The same compositor serves live preview, album and PNG. */
export function framePhoto(source:HTMLCanvasElement,settings:PhotoSettings):HTMLCanvasElement {
  const canvas=document.createElement('canvas');canvas.width=source.width;canvas.height=source.height;
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('照片画布创建失败');
  ctx.fillStyle='#f6f1e6';ctx.fillRect(0,0,canvas.width,canvas.height);
  const border=settings.frame==='none'?0:Math.round(canvas.width*.035);
  const bottom=settings.frame==='postcard'?Math.round(canvas.height*.14):border;
  const w=canvas.width-border*2,h=canvas.height-border-bottom;
  const scale=Math.max(w/source.width,h/source.height),sw=w/scale,sh=h/scale;
  ctx.drawImage(source,(source.width-sw)/2,(source.height-sh)/2,sw,sh,border,border,w,h);
  if(settings.frame==='postcard'){
    ctx.fillStyle='#635b50';ctx.font=`${Math.round(canvas.width*.025)}px serif`;ctx.textAlign='center';
    ctx.fillText(settings.title||'把这一刻，留在花里。',canvas.width/2,canvas.height-bottom*.43,canvas.width*.85);
  }
  return canvas;
}

export function createGallerySet():THREE.Group {
  const group=new THREE.Group();group.name='photography-gallery';
  const floor=new THREE.Mesh(new THREE.BoxGeometry(12,.08,12),new THREE.MeshStandardMaterial({color:'#384b42',roughness:1}));floor.position.y=.60;floor.receiveShadow=true;group.add(floor);
  const plinth=new THREE.Mesh(new THREE.CylinderGeometry(.40,.42,.05,64),new THREE.MeshStandardMaterial({color:'#716354',roughness:.92}));plinth.position.y=.64;plinth.receiveShadow=true;group.add(plinth);
  const wall=new THREE.Mesh(new THREE.PlaneGeometry(12,8),new THREE.MeshStandardMaterial({color:'#29463d',roughness:1,side:THREE.DoubleSide}));wall.position.set(0,3,-1.6);wall.receiveShadow=true;group.add(wall);
  return group;
}
