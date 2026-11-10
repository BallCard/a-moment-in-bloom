import * as THREE from 'three';
import { TABLE_TOP_Y } from '../../config';
import { RIBBON_PRESETS } from '../../data/decor';
import { VESSELS, type VesselKind } from '../../data/presentation';
import type { RibbonColorId } from '../../data/types';
import { createBasket } from './basket';
import { createGiftBox } from './giftbox';

/**
 * 花器程序化模型统一入口（运行时兜底 + 花瓶/陶罐的正式外观）。
 * 组原点都在容器底部中心（底面 y=0），这里统一抬到 TABLE_TOP_Y；
 * 有 Lux3D GLB 的形态会由 vessel-load.ts 在加载完成后替换外观，本文件始终保证「有东西可看」。
 * 花礼盒的腰线缎带跟当前丝带配色走（纸包才有丝带步骤，这里让花色继续生效）。
 */
export function createVessel(kind: VesselKind, ribbonColorId: RibbonColorId = 'rose'): THREE.Group {
  if (kind === 'basket') {
    const basket = createBasket();
    basket.position.y = TABLE_TOP_Y;
    return basket;
  }
  if (kind === 'box') {
    const box = createGiftBox(RIBBON_PRESETS[ribbonColorId].color);
    box.position.y = TABLE_TOP_Y;
    return box;
  }
  const wrapper = new THREE.Group();
  wrapper.name = `vessel-${kind}`;
  wrapper.position.y = TABLE_TOP_Y;
  wrapper.add(createFallbackBody(kind));
  return wrapper;
}

/** 花瓶/陶罐/抱抱桶/手提花袋/木条花箱的程序化兜底：按 VESSELS 尺寸回转一条截面。 */
function createFallbackBody(kind: VesselKind): THREE.Mesh {
  const v = VESSELS[kind];
  // 细口花瓶/陶罐保留原来的收口曲线；新增的浅口/直筒容器用更简单的直壁截面。
  const points =
    kind === 'vase' || kind === 'pot'
      ? [new THREE.Vector2(0, 0.008), new THREE.Vector2(v.base * .85, 0.008), new THREE.Vector2(v.base, 0.035), new THREE.Vector2(v.base * 1.08, v.height * .43), new THREE.Vector2(v.mouth * 1.08, v.height * .84), new THREE.Vector2(v.mouth * 1.08, v.height), new THREE.Vector2(v.mouth, v.height + .003), new THREE.Vector2(v.mouth * .94, v.height - .006), new THREE.Vector2(v.mouth * .94, v.height * .83), new THREE.Vector2(v.base * .90, v.height * .42), new THREE.Vector2(v.base * .77, 0.025), new THREE.Vector2(0, 0.025)]
      : [new THREE.Vector2(0, 0.006), new THREE.Vector2(v.base * .92, 0.006), new THREE.Vector2(v.base, v.height * .12), new THREE.Vector2(v.mouth * 1.02, v.height * .94), new THREE.Vector2(v.mouth * 1.04, v.height), new THREE.Vector2(v.mouth * .95, v.height), new THREE.Vector2(v.mouth * .93, v.height * .93), new THREE.Vector2(v.base * .86, v.height * .12), new THREE.Vector2(0, 0.02)];
  const material = new THREE.MeshStandardMaterial({ color: v.color, roughness: .85, metalness: 0, side: THREE.DoubleSide });
  const body = new THREE.Mesh(new THREE.LatheGeometry(points, 64), material);
  body.castShadow = true;
  body.receiveShadow = true;
  body.name = `ceramic-${kind}`;
  return body;
}

export function disposeVessel(group: THREE.Group): void {
  group.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose(); } });
}
