/**
 * 「花店一角」摄影布景（拍照阶段使用）。
 *
 * 空间约定与 photo.ts 的 createWindowSet / createGallerySet 保持一致：
 * - 原点 (0,0,0) 是花束位置，柜台台面顶面严格落在 TABLE_TOP_Y（0.66 米），花材尾部落在台面上；
 * - 相机在 +z 方向看向原点，正面（z>0）不放高、暗、复杂的物件，避免遮挡主体；
 * - 返回的 Group 默认 visible = false，由 BouquetScene 在拍照阶段切显隐，本文件不把组加进 scene。
 *
 * 元素：暖灰泥背墙 + 木柜台 + 两层木搁板（玻璃/陶小罐、干花）+ 暖色壁灯 + 木地板。
 * 全部为程序化几何与 canvas 纹理，不加载外部贴图；重复小物共用 geometry / material。
 * 三角面约 1.7k，远低于 3 万预算。
 */

import * as THREE from 'three';
import { TABLE_TOP_Y } from '../../config';

/** 柜台台面顶面高度：必须等于花束底座高度，不能再高。 */
const COUNTER_TOP = TABLE_TOP_Y;
/** 柜台台面厚度（米）。 */
const COUNTER_THICK = 0.07;
/** 柜台宽 / 深（米）。宽到默认取景框看不到左右边缘，避免露出布景边界。 */
const COUNTER_W = 5.2;
const COUNTER_D = 2.1;
/** 柜台中心的 z：后沿藏进背墙，前沿留出画外，避免看到台面下的空档。 */
const COUNTER_Z = -0.03;
/** 背墙 z（墙面朝 +z，与 window set 的 z≈-0.9 同级）。 */
const WALL_Z = -0.95;
/** 搁板中心 x / z 与宽度（米）。整体略偏左，给花束右边留一块干净的墙。 */
const SHELF_X = -0.35;
const SHELF_Z = -0.86;
const SHELF_W = 2.7;
/**
 * 两层搁板高度（米，板中心）。下层落在拍照默认机位可见的背景带里；
 * 上层抬到 2.05 米，默认取景框上沿之外，缩小或平移时才露出来，避免托架悬在画面边缘。
 */
const SHELF_Y = [1.44, 2.05] as const;

interface FloristMaterials {
  stem: THREE.Material;
  driedHead: THREE.Material;
  clay: THREE.Material;
  metal: THREE.Material;
  shade: THREE.Material;
  bulb: THREE.Material;
}

export function createFloristSet(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'florist-set';
  group.visible = false;

  const wood = createWoodTexture(2, 2);
  const floorWood = createWoodTexture(5, 5);
  const plaster = createPlasterTexture();

  // ---- 共享材质：同色系小物只建一份，减少材质切换 ----
  const matPlaster = new THREE.MeshStandardMaterial({ map: plaster, roughness: 1, metalness: 0 });
  const matCounterTop = new THREE.MeshStandardMaterial({ color: '#dcc0a0', map: wood, roughness: 0.7, metalness: 0 });
  const matCounterSide = new THREE.MeshStandardMaterial({ color: '#9c7a55', map: wood, roughness: 0.84, metalness: 0 });
  const matCabinet = new THREE.MeshStandardMaterial({ color: '#a9865f', map: wood, roughness: 0.86, metalness: 0 });
  const matPanel = new THREE.MeshStandardMaterial({ color: '#8a6a48', roughness: 0.9, metalness: 0 });
  const matShelf = new THREE.MeshStandardMaterial({ color: '#d0a97f', map: wood, roughness: 0.8, metalness: 0 });
  const matBracket = new THREE.MeshStandardMaterial({ color: '#7d5f42', roughness: 0.92, metalness: 0 });
  const matFloor = new THREE.MeshStandardMaterial({ color: '#8d6b4b', map: floorWood, roughness: 0.92, metalness: 0 });
  const matGlass = new THREE.MeshStandardMaterial({
    color: '#e4ece3',
    roughness: 0.06,
    metalness: 0,
    transparent: true,
    opacity: 0.3,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const matCeramic = new THREE.MeshStandardMaterial({ color: '#e8dcca', roughness: 0.92, metalness: 0 });
  const matClay = new THREE.MeshStandardMaterial({ color: '#c1916c', roughness: 0.86, metalness: 0 });
  const matPaper = new THREE.MeshStandardMaterial({ color: '#efe3cf', roughness: 0.95, metalness: 0 });

  const floristMaterials: FloristMaterials = {
    stem: new THREE.MeshStandardMaterial({ color: '#b3986c', roughness: 1, metalness: 0 }),
    driedHead: new THREE.MeshStandardMaterial({ color: '#dcc6a4', roughness: 1, metalness: 0 }),
    clay: matClay,
    metal: new THREE.MeshStandardMaterial({ color: '#8b7b66', roughness: 0.55, metalness: 0.4 }),
    shade: new THREE.MeshStandardMaterial({
      color: '#f2e5d0',
      roughness: 0.95,
      metalness: 0,
      emissive: new THREE.Color('#ffc78c'),
      emissiveIntensity: 0.32,
      side: THREE.DoubleSide,
    }),
    bulb: new THREE.MeshBasicMaterial({ color: '#ffd9a4', toneMapped: false }),
  };

  // ---- 木地板：压在场景自带地面（y=0）上方 4 毫米，避免 z-fighting ----
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 10), matFloor);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.004;
  floor.receiveShadow = true;
  group.add(floor);

  // ---- 暖灰泥背墙：底边正好落在台面上，中间不留缝；宽到取景框外，不露出墙的边界 ----
  addBox(group, 7.0, 2.5, 0.1, 0, COUNTER_TOP + 1.25, WALL_Z, matPlaster, false, true);

  // ---- 柜台：台面顶面必须正好是 0.66 ----
  addBox(group, COUNTER_W, COUNTER_THICK, COUNTER_D, 0, COUNTER_TOP - COUNTER_THICK / 2, COUNTER_Z, [
    matCounterSide,
    matCounterSide,
    matCounterTop,
    matCounterSide,
    matCounterSide,
    matCounterSide,
  ]);
  // 柜台柜体（比台面内收，形成一圈台沿），落在木地板上而不是悬空。
  addBox(group, COUNTER_W - 0.08, 0.6, COUNTER_D - 0.12, 0, 0.31, COUNTER_Z, matCabinet, true, true);
  // 正面两块简单门板，低机位时柜台不至于是一大块空白。
  const panelGeo = new THREE.BoxGeometry(0.9, 0.42, 0.016);
  for (const x of [-1.35, 1.35]) {
    addMesh(group, panelGeo, matPanel, x, 0.35, COUNTER_Z + COUNTER_D / 2 - 0.058, false, true);
  }

  // ---- 两层木搁板 + 托架：z≈-0.86，贴在背墙前 ----
  const shelfGeo = new THREE.BoxGeometry(SHELF_W, 0.045, 0.26);
  const bracketGeo = new THREE.BoxGeometry(0.04, 0.16, 0.2);
  for (const shelfY of SHELF_Y) {
    addMesh(group, shelfGeo, matShelf, SHELF_X, shelfY, SHELF_Z);
    for (const bracketX of [SHELF_X - SHELF_W / 2 + 0.1, SHELF_X + SHELF_W / 2 - 0.1]) {
      addMesh(group, bracketGeo, matBracket, bracketX, shelfY - 0.1, SHELF_Z, false, true);
    }
  }

  const lowerTop = SHELF_Y[0] + 0.0225;
  const upperTop = SHELF_Y[1] + 0.0225;

  // ---- 玻璃 / 陶小罐：5 个，尺寸错开；拍照默认机位能看到的一排放在下层 ----
  addJar(group, -1.55, lowerTop, SHELF_Z, 0.055, 0.17, matGlass, matBracket);
  addJar(group, -1.22, lowerTop, SHELF_Z, 0.07, 0.11, matCeramic, matClay);
  addJar(group, -0.85, lowerTop, SHELF_Z, 0.045, 0.13, matGlass, matBracket);
  addJar(group, -0.5, lowerTop, SHELF_Z, 0.062, 0.15, matCeramic, matBracket);
  addJar(group, -1.42, upperTop, SHELF_Z, 0.05, 0.12, matGlass, matClay);

  // ---- 干花束：细圆柱茎 + 小球/小锥花头；两束在上层，缩小 / 平移取景时才露出来 ----
  addDriedBouquet(group, floristMaterials, -0.9, upperTop, SHELF_Z);
  addDriedBouquet(group, floristMaterials, -0.3, upperTop, SHELF_Z);

  // ---- 台面左后：陶罐插干花，给主体左侧一点纵深，位置在花束半径之外 ----
  addDriedJug(group, floristMaterials, -1.15, COUNTER_TOP, -0.45);

  // ---- 台面左前：一卷浅色包装纸卷，低矮、颜色浅，不挡主体 ----
  const rollGeo = new THREE.CylinderGeometry(0.052, 0.052, 0.3, 16);
  const roll = addMesh(group, rollGeo, matPaper, -1.35, COUNTER_TOP + 0.052, 0.24);
  roll.rotation.z = Math.PI / 2;
  const coreGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.31, 10);
  const core = addMesh(group, coreGeo, matBracket, -1.35, COUNTER_TOP + 0.052, 0.24);
  core.rotation.z = Math.PI / 2;

  // ---- 暖色壁灯（含一个克制的 PointLight），放在右墙，不压花束正面 ----
  addWallLamp(group, floristMaterials);

  return group;
}

/** 壁灯：墙面底座 + 横向支臂 + 灯罩 + 灯泡 + 点光源。 */
function addWallLamp(parent: THREE.Object3D, materials: FloristMaterials): void {
  addBox(parent, 0.1, 0.16, 0.02, 1.55, 1.78, WALL_Z + 0.055, materials.metal);
  const armGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.3, 8);
  const arm = addMesh(parent, armGeo, materials.metal, 1.55, 1.78, WALL_Z + 0.2);
  arm.rotation.x = Math.PI / 2;
  const dropGeo = new THREE.CylinderGeometry(0.01, 0.01, 0.06, 8);
  addMesh(parent, dropGeo, materials.metal, 1.55, 1.75, WALL_Z + 0.36);

  // 开口圆锥当灯罩，罩内灯泡用 Basic 材质自发光。
  const shade = addMesh(
    parent,
    new THREE.ConeGeometry(0.11, 0.15, 16, 1, true),
    materials.shade,
    1.55,
    1.665,
    WALL_Z + 0.36,
  );
  shade.receiveShadow = false;
  addMesh(parent, new THREE.SphereGeometry(0.026, 8, 6), materials.bulb, 1.55, 1.6, WALL_Z + 0.36, false, false);

  // 点光源放在灯罩下方，强度压得很低：只给右墙与柜台一点暖色，
  // 主光仍是场景里已有的 key light，避免压过工作台默认光。
  const light = new THREE.PointLight(0xffd2a0, 1.2, 3.2, 2);
  light.position.set(1.55, 1.58, WALL_Z + 0.36);
  parent.add(light);
}

/** 玻璃/陶小罐：开口圆柱 + 圆底 + 一顶盖子。 */
function addJar(
  parent: THREE.Object3D,
  x: number,
  baseY: number,
  z: number,
  radius: number,
  height: number,
  bodyMaterial: THREE.Material,
  lidMaterial: THREE.Material,
): void {
  const body = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.94, height, 16, 1, true), bodyMaterial);
  body.position.set(x, baseY + height / 2, z);
  body.castShadow = true;
  body.receiveShadow = true;
  parent.add(body);

  const bottom = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.94, 16), bodyMaterial);
  bottom.rotation.x = -Math.PI / 2;
  bottom.position.set(x, baseY + 0.002, z);
  parent.add(bottom);

  const lid = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.96, radius * 0.96, 0.022, 16), lidMaterial);
  lid.position.set(x, baseY + height + 0.011, z);
  lid.castShadow = true;
  parent.add(lid);
}

/** 一小束干花：陶罐 + 五根细茎 + 小球（少量小锥）花头。 */
function addDriedBouquet(parent: THREE.Object3D, materials: FloristMaterials, x: number, baseY: number, z: number): void {
  const can = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.028, 0.1, 12), materials.clay);
  can.position.set(x, baseY + 0.05, z);
  can.castShadow = true;
  can.receiveShadow = true;
  parent.add(can);

  const stemGeo = new THREE.CylinderGeometry(0.0032, 0.0032, 0.2, 5, 1, true);
  const headGeo = new THREE.SphereGeometry(0.012, 6, 4);
  const coneHeadGeo = new THREE.ConeGeometry(0.011, 0.034, 6);
  for (let index = 0; index < 5; index += 1) {
    const angle = (index / 5) * Math.PI * 2;
    const spread = 0.016;
    const dx = Math.cos(angle) * spread;
    const dz = Math.sin(angle) * spread;
    const stem = new THREE.Mesh(stemGeo, materials.stem);
    stem.position.set(x + dx, baseY + 0.19, z + dz);
    stem.rotation.z = dx * 3;
    stem.rotation.x = -dz * 3;
    stem.castShadow = true;
    parent.add(stem);

    // 花头放在茎顶外侧一点，形成向外散开的花冠。
    const head = new THREE.Mesh(index % 3 === 0 ? coneHeadGeo : headGeo, materials.driedHead);
    head.position.set(x + dx * 3, baseY + 0.288, z + dz * 3);
    head.rotation.z = dx * 3;
    head.castShadow = true;
    parent.add(head);
  }
}

/** 台面上的陶罐干花：罐身 + 一把细茎 + 小锥花头，约 0.5 米高。 */
function addDriedJug(parent: THREE.Object3D, materials: FloristMaterials, x: number, baseY: number, z: number): void {
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.044, 0.2, 14), materials.clay);
  body.position.set(x, baseY + 0.1, z);
  body.castShadow = true;
  body.receiveShadow = true;
  parent.add(body);

  const lip = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.02, 14), materials.clay);
  lip.position.set(x, baseY + 0.205, z);
  lip.castShadow = true;
  parent.add(lip);

  const stemGeo = new THREE.CylinderGeometry(0.0028, 0.0028, 0.3, 5, 1, true);
  const headGeo = new THREE.SphereGeometry(0.013, 6, 4);
  const coneHeadGeo = new THREE.ConeGeometry(0.01, 0.028, 6);
  for (let index = 0; index < 5; index += 1) {
    // 黄金角散开，几根茎读成一把干花。
    const angle = index * 2.399;
    const spread = index === 0 ? 0 : 0.03;
    const dx = Math.cos(angle) * spread;
    const dz = Math.sin(angle) * spread;
    const stem = new THREE.Mesh(stemGeo, materials.stem);
    stem.position.set(x + dx, baseY + 0.34, z + dz);
    stem.rotation.z = dx * 1.6;
    stem.rotation.x = -dz * 1.6;
    stem.castShadow = true;
    parent.add(stem);

    const head = new THREE.Mesh(index % 2 === 0 ? coneHeadGeo : headGeo, materials.driedHead);
    head.position.set(x + dx * 2.6, baseY + 0.5, z + dz * 2.6);
    head.rotation.z = dx * 1.6;
    head.castShadow = true;
    parent.add(head);
  }
}

// ---------- 几何 / 网格小工具 ----------

function addMesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
  x: number,
  y: number,
  z: number,
  castShadow = true,
  receiveShadow = true,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  parent.add(mesh);
  return mesh;
}

function addBox(
  parent: THREE.Object3D,
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  material: THREE.Material | THREE.Material[],
  castShadow = true,
  receiveShadow = true,
): THREE.Mesh {
  return addMesh(parent, new THREE.BoxGeometry(width, height, depth), material, x, y, z, castShadow, receiveShadow);
}

// ---------- 程序化纹理 ----------

/** 低饱和木纹：横向年轮线 + 两个木节，避免台面变成一块塑料板。 */
function createWoodTexture(repeatX: number, repeatY: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#e8d4b8';
    context.fillRect(0, 0, size, size);
    for (let i = 0; i < 26; i += 1) {
      const y = (i / 26) * size + Math.sin(i * 1.7) * 3;
      context.strokeStyle = i % 3 === 0 ? 'rgba(150, 112, 76, 0.22)' : 'rgba(172, 136, 100, 0.13)';
      context.lineWidth = i % 3 === 0 ? 1.6 : 0.9;
      context.beginPath();
      for (let x = 0; x <= size; x += 8) {
        const wave = Math.sin(x * 0.03 + i * 0.9) * 2.2 + Math.sin(x * 0.011 + i) * 1.6;
        if (x === 0) context.moveTo(x, y + wave);
        else context.lineTo(x, y + wave);
      }
      context.stroke();
    }
    for (const [cx, cy] of [
      [size * 0.28, size * 0.62],
      [size * 0.74, size * 0.3],
    ] as const) {
      context.strokeStyle = 'rgba(146, 108, 72, 0.18)';
      context.lineWidth = 1.2;
      for (let ring = 0; ring < 3; ring += 1) {
        context.beginPath();
        context.ellipse(cx, cy, 8 + ring * 5, 3 + ring * 2.2, 0.4, 0, Math.PI * 2);
        context.stroke();
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** 暖灰泥墙：抹刀起伏的深浅斑块 + 极细砂粒，避免整面墙是一块纯色。 */
function createPlasterTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#cdc0af';
    context.fillRect(0, 0, size, size);
    for (let i = 0; i < 80; i += 1) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const radius = 10 + Math.random() * 46;
      const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
      const light = Math.random() > 0.5;
      gradient.addColorStop(0, light ? 'rgba(246, 238, 224, 0.12)' : 'rgba(168, 148, 122, 0.08)');
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      context.fillStyle = gradient;
      context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    for (let i = 0; i < 1600; i += 1) {
      context.fillStyle = Math.random() > 0.5 ? 'rgba(255, 250, 240, 0.12)' : 'rgba(120, 104, 84, 0.1)';
      context.fillRect(Math.random() * size, Math.random() * size, 1, 1);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 1.4);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
