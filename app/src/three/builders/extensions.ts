import * as THREE from 'three';
import { hexToRgb, type RGB } from '../../data/color';
import { createSphere, createTube, mergeParts, placePetal } from './geometryUtils';
import { buildRose } from './rose';
import type { BuiltFlower } from './tulip';
export function buildExtension(kind:'spray'|'daisy',color:RGB):BuiltFlower {
  const green=hexToRgb('#536d43'),parts:THREE.BufferGeometry[]=[];
  parts.push(createTube([[0,-.22,0],[0,0,0],[0,.2,0],[0,.34,0]],.0035,green));
  if(kind==='spray'){
    for(const [x,y,z] of [[-.065,.33,.015],[.065,.38,-.015],[0,.46,.01]]){
      const rose=buildRose(color).geometry;
      const p=rose.getAttribute('position'),indices:number[]=[];
      for(let i=0;i<p.count;i+=3)if(Math.min(p.getY(i),p.getY(i+1),p.getY(i+2))>.26)indices.push(i,i+1,i+2);
      rose.setIndex(indices);rose.translate(0,-.34,0).scale(.58,.58,.58).translate(x,y,z);parts.push(rose);
      parts.push(createTube([[0,.12,0],[x*.4,.24,z*.4],[x,y-.025,z]],.0025,green));
    }
  }else{
    for(let layer=0;layer<2;layer++)for(let i=0;i<20;i++)placePetal(parts,{length:.09-layer*.018,width:.011,bend:.006,cup:.18,baseColor:color,tipColor:color,segmentsU:3,segmentsV:8},{y:.34+layer*.003,azimuth:i*Math.PI/10+layer*.16,lean:1.32+layer*.12});
    parts.push(createSphere(.024,hexToRgb('#805126'),[0,.35,0],[1,.35,1]));
    for(let i=0;i<24;i++){const a=i*2.4,r=.019*Math.sqrt(i/24);parts.push(createSphere(.0025,hexToRgb('#d2a044'),[Math.cos(a)*r,.358,Math.sin(a)*r]));}
  }
  return {geometry:mergeParts(parts),headHeight:kind==='spray'?.39:.35,roughness:.8};
}
