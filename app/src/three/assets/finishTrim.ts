import * as THREE from 'three';
import type { PresentationKind } from '../../data/presentation';
/** Conservative, reversible lower-stem cleanup. Never changes the head or source geometry. */
export function applyFinishTrim(root:THREE.Object3D,enabled:boolean,kind:PresentationKind,headHeight:number):void {
  root.traverse(object=>{
    const mesh=object as THREE.Mesh;if(!mesh.isMesh||mesh.name==='prepared-cut-line')return;
    const data=mesh.userData;
    if(!enabled){if(data.trimSource){mesh.geometry=data.trimSource;data.trimGeometry?.dispose();delete data.trimGeometry;delete data.trimSource;delete data.trimKey;}return;}
    if(mesh.name==='original-flower-head')return;
    const key=kind+mesh.matrixWorld.elements.join(',');if(data.trimKey===key)return;
    const source:THREE.BufferGeometry=data.trimSource??mesh.geometry;
    data.trimSource=source;data.trimGeometry?.dispose();
    const geometry=source.clone(),p=source.getAttribute('position'),idx=source.index,kept:number[]=[];
    const local=new THREE.Vector3(),world=new THREE.Vector3();
    const outside=(i:number):boolean=>{
      local.fromBufferAttribute(p,i);world.copy(local).applyMatrix4(mesh.matrixWorld);
      // Upper silhouette and all flower heads are protected, including multi-head branches.
      if(world.y>.98||(!mesh.name.startsWith('prepared-')&&local.y>Math.min(.22,headHeight-.12)))return false;
      // 容器类只清理露在器口之外的茎段；花篮/花盒/花箱口沿更宽，清理半径跟容器口径走。
      const radius=kind==='paper'?Math.max(.025,.045+(world.y-.76)*.55):kind==='vase'?.052:kind==='pot'?.095:kind==='basket'?.19:kind==='crate'?.17:kind==='bag'?.11:kind==='bucket'?.08:.16;
      return world.y<.675||Math.hypot(world.x,world.z)>radius;
    };
    for(let n=0;n<(idx?.count??p.count);n+=3){const a=idx?idx.getX(n):n,b=idx?idx.getX(n+1):n+1,c=idx?idx.getX(n+2):n+2;if(!outside(a)&&!outside(b)&&!outside(c))kept.push(a,b,c);}
    geometry.setIndex(kept);mesh.geometry=geometry;data.trimGeometry=geometry;data.trimKey=key;
  });
}
