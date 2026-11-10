/** 程序化丝带：束口一圏环形 + 蝴蝶结，尺寸跟着包装开口变化。 */

import * as THREE from 'three';
import { WRAP_BOTTOM_Y } from '../../config';
import { RIBBON_PRESETS } from '../../data/decor';
import type { PaperSheet } from '../../data/presentation';
import type { RibbonColorId } from '../../data/types';

export interface RibbonObject {
  group: THREE.Group;
  material: THREE.MeshStandardMaterial;
  /** 环形主体，用于调试尺寸。 */
  ring: THREE.Mesh;
  bow: THREE.Group;
  /** 建这圈丝带时的包装开口半径。 */
  radius: number;
  /** 蝴蝶结的基础缩放，做「成结」动画时按它乘系数。 */
  baseBowScale: number;
}

/**
 * 纸包「束腰」在纸片几何里的局部高度（米）。
 * 与 `three/decor/wrapping.ts` 的 `rows[2] = 0.2` 对齐：合拢后纸片在最窄的一行收成一握，
 * 丝带就系在这一行上。纸包尺寸再调时要同步改这里（`v16-organize-visual` 会量纸面几何校验）。
 */
export const RIBBON_WAIST_LOCAL_Y = 0.2;

export interface RibbonWaist {
  /** 纸腰在世界坐标里的高度（米）。 */
  y: number;
  /** 纸腰收口后的实际半径（米）。 */
  radius: number;
}

/**
 * 丝带应该挂在哪：纸腰的真实高度与半径。
 * - 高度 = 包装纸组底面高度 + 第一张纸片的高度偏移 + 束腰行；
 * - 半径 = 束腰行半径，和 `buildPaperGeometry` 的 row 2 用同一个公式（收口 gather × 合拢 fold）。
 */
export function ribbonWaist(sheets: PaperSheet[] | undefined, fold: number): RibbonWaist {
  const sheet = sheets?.[0];
  const gather = THREE.MathUtils.clamp(Number.isFinite(fold) ? fold : 1, 0, 1) * (sheet?.gather ?? 0.8);
  return {
    y: WRAP_BOTTOM_Y + (sheet?.height ?? 0) + RIBBON_WAIST_LOCAL_Y,
    radius: 0.045 + (1 - gather) * 0.055,
  };
}

/** 把丝带环贴到纸腰上：Y 跟随纸腰，半径按实际纸腰缩放（不重建几何，所以能跟动画每帧同步）。 */
export function fitRibbonToWaist(ribbon: RibbonObject, waist: RibbonWaist): void {
  ribbon.group.position.y = waist.y;
  const scale = THREE.MathUtils.clamp(waist.radius / Math.max(0.001, ribbon.radius), 0.5, 1.8);
  ribbon.group.scale.set(scale, 1, scale);
}

const BOW_AZIMUTH = 0.72;


export function createRibbonObject(topRadius: number, colorId: RibbonColorId): RibbonObject {
  const color = new THREE.Color(RIBBON_PRESETS[colorId].color);
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.42,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });
  const group = new THREE.Group();
  group.name = 'ribbon';

  const ringRadius = Math.max(0.045, topRadius);
  const ring = new THREE.Mesh(
    new THREE.CylinderGeometry(ringRadius, ringRadius, .022, 64, 1, true),
    material,
  );

  ring.castShadow = true;
  group.add(ring);

  const bow = new THREE.Group();
  // 蝴蝶结跟着纸口变，但别把小纸口配出大蝴蝶结：上限压到 1.0。
  const bowScale = THREE.MathUtils.clamp(0.5 + topRadius * 0.95, 0.72, 1.0);
  bow.scale.setScalar(bowScale);
  bow.position.set(
    Math.sin(BOW_AZIMUTH) * (ringRadius + 0.006),
    0.004,
    Math.cos(BOW_AZIMUTH) * (ringRadius + 0.006),
  );
  bow.rotation.y = BOW_AZIMUTH;
  group.add(bow);

  addBow(bow, material);

  return { group, material, ring, bow, radius: ringRadius, baseBowScale: bowScale };
}

function addBow(bow: THREE.Group, material: THREE.Material): void {
  // 两个环圈相对展开，像手工系出来的蝴蝶结。
  for (const side of [-1, 1]) {
    const loop = new THREE.Mesh(
      flatStrip(new THREE.CatmullRomCurve3([new THREE.Vector3(0,0,0),new THREE.Vector3(side*.05,.035,.012),new THREE.Vector3(side*.08,.01,.025),new THREE.Vector3(0,0,.008)]),.018),
      material,
    );
    loop.position.set(side * 0.033, 0.008, 0.002);
    loop.rotation.z = side * 0.5;
    loop.castShadow = true;
    bow.add(loop);
  }

  const knot = new THREE.Mesh(new THREE.SphereGeometry(0.014, 14, 10), material);
  knot.scale.set(1.1, 0.9, 0.85);
  knot.castShadow = true;
  bow.add(knot);

  // 两条垂下来的带尾。
  for (const side of [-1, 1]) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(side * 0.008, -0.004, 0.004),
      new THREE.Vector3(side * 0.024, -0.052, 0.006),
      new THREE.Vector3(side * 0.045, -0.118, 0.002),
      new THREE.Vector3(side * 0.04, -0.15, -0.002),
    ]);
    const tail = new THREE.Mesh(
      flatStrip(curve,.018),
      material,
    );
    tail.castShadow = true;
    bow.add(tail);
  }
}

/** 缓出回弹：丝带结出现时有一点"收紧"的手感。 */
function easeOutBack(t: number): number {
  const c1 = 1.28;
  const c3 = c1 + 1;
  const p = t - 1;
  return 1 + c3 * p * p * p + c1 * p * p;
}

/**
 * 丝带「成结」进度：0 = 没出现，1 = 系好。
 * 只改材质透明度与蝴蝶结缩放/转角，不改几何，所以随时可被新状态打断。
 */
export function setRibbonAppear(ribbon: RibbonObject, progress: number): void {
  const t = THREE.MathUtils.clamp(progress, 0, 1);
  ribbon.group.visible = t > 0.002;
  if (!ribbon.group.visible) return;
  const eased = THREE.MathUtils.clamp(easeOutBack(t), 0.05, 1.16);
  ribbon.material.opacity = Math.min(1, t * 1.35);
  ribbon.material.transparent = t < 0.995;
  ribbon.material.depthWrite = t > 0.995;
  ribbon.ring.scale.setScalar(0.94 + 0.06 * Math.min(1, t * 1.2));
  ribbon.bow.scale.setScalar(ribbon.baseBowScale * (0.35 + 0.65 * eased));
  ribbon.bow.rotation.y = BOW_AZIMUTH + (1 - Math.min(1, t * 1.25)) * -1.3;
}

export function disposeRibbon(ribbon: RibbonObject): void {
  ribbon.group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) mesh.geometry.dispose();
  });
  ribbon.material.dispose();
}

function flatStrip(curve:THREE.Curve<THREE.Vector3>,width:number):THREE.BufferGeometry {
  const p:number[]=[],idx:number[]=[];
  for(let i=0;i<=24;i++){const t=i/24,center=curve.getPoint(t), tangent=curve.getTangent(t);const across=new THREE.Vector3(-tangent.y,tangent.x,0).normalize().multiplyScalar(width/2);for(const sign of [-1,1]){const v=center.clone().addScaledVector(across,sign);p.push(v.x,v.y,v.z);}}
  for(let i=0;i<24;i++){const a=i*2;idx.push(a,a+1,a+2,a+1,a+3,a+2);}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setIndex(idx);g.computeVertexNormals();return g;
}
