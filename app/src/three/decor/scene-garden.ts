/**
 * 「庭院午后」摄影布景（拍照阶段使用）。
 *
 * 空间约定与 photo.ts 的 createWindowSet / createGallerySet 保持一致：
 * - 原点 (0,0,0) 是花束位置，石板台面顶面严格落在 TABLE_TOP_Y（0.66 米），花材尾部落在台面上；
 * - 相机在 +z 方向看向原点，正面（z>0）只留低矮、浅色的东西，不挡主体；
 * - 返回的 Group 默认 visible = false，由 BouquetScene 在拍照阶段切显隐，本文件不把组加进 scene。
 *
 * 元素：浅色石板台面 + 远处浅色天空大平面 + 低矮绿篱与木格栅 + 三个陶盆绿植 + 柔和暖阳。
 * 整体色淡、留白多，对比交给花束；全部程序化，不加载外部贴图。
 * 三角面约 1.4k，远低于 3 万预算。
 */

import * as THREE from 'three';
import { TABLE_TOP_Y } from '../../config';

/** 石板台面顶面高度：必须等于花束底座高度，不能再高。 */
const TERRACE_TOP = TABLE_TOP_Y;
/** 石板台面尺寸（米）：宽、深、中心 z。前沿伸到相机身后，俯视时不漏底。 */
const TERRACE_W = 6.0;
const TERRACE_D = 4.6;
const TERRACE_Z = -0.5;
/** 绿篱 / 木格栅 / 天空平面所在 z，逐层后退，形成景深。 */
const HEDGE_Z = -1.65;
const FENCE_Z = -2.2;
const SKY_Z = -3.0;

interface GardenMaterials {
  stone: THREE.Material;
  hedge: THREE.Material[];
  wood: THREE.Material;
  terracotta: THREE.Material;
  soil: THREE.Material;
  foliage: THREE.Material[];
}

/** 陶盆绿植复用的几何：花盆本体 / 盆沿 / 土面 / 叶团，靠 Group 缩放做大小差异。 */
interface GardenParts {
  potBody: THREE.CylinderGeometry;
  potRim: THREE.CylinderGeometry;
  potSoil: THREE.CircleGeometry;
  foliage: THREE.SphereGeometry;
}

export function createGardenSet(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'garden-set';
  group.visible = false;

  const stoneTexture = createStoneTexture();
  const skyTexture = createSkyTexture();

  // ---- 共享材质：浅色、低饱和，亮度留给花束 ----
  const materials: GardenMaterials = {
    stone: new THREE.MeshStandardMaterial({ color: '#f1ece0', map: stoneTexture, roughness: 0.95, metalness: 0 }),
    hedge: [
      new THREE.MeshStandardMaterial({ color: '#a1b389', roughness: 1, metalness: 0 }),
      new THREE.MeshStandardMaterial({ color: '#99ac80', roughness: 1, metalness: 0 }),
      new THREE.MeshStandardMaterial({ color: '#adbd94', roughness: 1, metalness: 0 }),
    ],
    wood: new THREE.MeshStandardMaterial({ color: '#d9caae', roughness: 0.92, metalness: 0 }),
    terracotta: new THREE.MeshStandardMaterial({ color: '#c98a63', roughness: 0.88, metalness: 0 }),
    soil: new THREE.MeshStandardMaterial({ color: '#6b5a44', roughness: 1, metalness: 0 }),
    foliage: [
      new THREE.MeshStandardMaterial({ color: '#7f9561', roughness: 1, metalness: 0 }),
      new THREE.MeshStandardMaterial({ color: '#8ba66c', roughness: 1, metalness: 0 }),
      new THREE.MeshStandardMaterial({ color: '#728a58', roughness: 1, metalness: 0 }),
    ],
  };

  const parts: GardenParts = {
    potBody: new THREE.CylinderGeometry(0.17, 0.125, 0.26, 16),
    potRim: new THREE.CylinderGeometry(0.181, 0.181, 0.045, 16),
    potSoil: new THREE.CircleGeometry(0.158, 16),
    foliage: new THREE.SphereGeometry(1, 8, 6),
  };

  // ---- 石板台面：整块落到地面，侧边不留悬空缝；顶面正好 0.66 ----
  addBox(group, TERRACE_W, TERRACE_TOP, TERRACE_D, 0, TERRACE_TOP / 2, TERRACE_Z, materials.stone, false, true);

  // ---- 远处浅色天空：MeshBasicMaterial + 关闭 tone mapping，保持淡、透气、不受灯影响 ----
  const sky = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 8),
    new THREE.MeshBasicMaterial({ map: skyTexture, toneMapped: false, side: THREE.DoubleSide }),
  );
  sky.name = 'garden-sky';
  sky.position.set(0, 2.2, SKY_Z);
  group.add(sky);

  // ---- 远处树丛剪影：透明底 + 起伏轮廓，比一条硬边绿墙更像远景 ----
  const treeline = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 1.0),
    new THREE.MeshBasicMaterial({ map: createTreelineTexture(), transparent: true, depthWrite: false }),
  );
  treeline.name = 'garden-treeline';
  treeline.position.set(0, TERRACE_TOP + 0.5, SKY_Z + 0.25);
  group.add(treeline);

  // ---- 木格栅：左侧一段，绿篱之上露出竖条，给出庭院纵深 ----
  addTrellis(group, materials.wood);

  // ---- 低矮绿篱：z≈-1.65，三块高度错开，中央压到 1.0 米以下不抢花头 ----
  addBox(group, 2.1, 0.42, 0.52, -1.55, TERRACE_TOP + 0.21, HEDGE_Z, materials.hedge[0]);
  addBox(group, 2.1, 0.42, 0.52, 1.55, TERRACE_TOP + 0.21, HEDGE_Z, materials.hedge[1]);
  addBox(group, 1.0, 0.34, 0.56, 0, TERRACE_TOP + 0.17, HEDGE_Z - 0.04, materials.hedge[2]);

  // ---- 三个陶盆绿植：都放在台面后侧与两侧，花束半径内保持空台面 ----
  addPottedPlant(group, materials, parts, -1.45, -0.95, 1.15, 4);
  addPottedPlant(group, materials, parts, -2.25, -0.6, 0.9, 3);
  addPottedPlant(group, materials, parts, 0.45, -1.15, 0.72, 3);

  // ---- 柔和暖阳：方向光，强度只补充一点侧向暖色，不压过场景主光 ----
  const sun = new THREE.DirectionalLight(0xfff1da, 0.55);
  sun.position.set(-2.4, 3.4, 1.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -6;
  sun.shadow.camera.right = 6;
  sun.shadow.camera.top = 5;
  sun.shadow.camera.bottom = -5;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 16;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 3;
  sun.target.position.set(0, 0.9, -1.0);
  group.add(sun);
  group.add(sun.target);

  return group;
}

/** 左侧木格栅：竖条 + 两道横档，颜色浅，像被晒过。放在拍照默认机位的左侧可见区。 */
function addTrellis(parent: THREE.Object3D, material: THREE.Material): void {
  const slatGeo = new THREE.BoxGeometry(0.05, 1.5, 0.045);
  for (const x of [-3.3, -2.9, -2.5, -2.1, -1.7, -1.3]) {
    addMesh(parent, slatGeo, material, x, TERRACE_TOP + 0.75, FENCE_Z);
  }
  const railGeo = new THREE.BoxGeometry(2.1, 0.06, 0.045);
  for (const y of [TERRACE_TOP + 0.34, TERRACE_TOP + 1.29]) {
    addMesh(parent, railGeo, material, -2.3, y, FENCE_Z);
  }
}

/** 陶盆绿植：花盆本体 + 盆沿 + 土面 + 几个叶团，整组按 size 缩放。 */
function addPottedPlant(
  parent: THREE.Object3D,
  materials: GardenMaterials,
  parts: GardenParts,
  x: number,
  z: number,
  size: number,
  blobs: number,
): void {
  const pot = new THREE.Group();
  pot.position.set(x, TERRACE_TOP, z);
  pot.scale.setScalar(size);
  parent.add(pot);

  const body = new THREE.Mesh(parts.potBody, materials.terracotta);
  body.position.y = 0.13;
  body.castShadow = true;
  body.receiveShadow = true;
  pot.add(body);

  const rim = new THREE.Mesh(parts.potRim, materials.terracotta);
  rim.position.y = 0.245;
  rim.castShadow = true;
  rim.receiveShadow = true;
  pot.add(rim);

  const soil = new THREE.Mesh(parts.potSoil, materials.soil);
  soil.rotation.x = -Math.PI / 2;
  soil.position.y = 0.238;
  pot.add(soil);

  for (let index = 0; index < blobs; index += 1) {
    // 黄金角散开，几个球读成一丛，不需要更多几何。
    const angle = index * 2.399 + 0.5;
    const radius = index === 0 ? 0 : 0.085;
    const blob = new THREE.Mesh(parts.foliage, materials.foliage[index % materials.foliage.length]);
    blob.position.set(Math.cos(angle) * radius, 0.4 + (index % 2) * 0.09, Math.sin(angle) * radius);
    blob.scale.set(0.15, 0.115, 0.15);
    blob.castShadow = true;
    blob.receiveShadow = true;
    pot.add(blob);
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

/** 浅色石板：三乘三错缝的板块 + 细缝 + 砂粒，避免台面变成一整块塑料。 */
function createStoneTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#ddd6c7';
    context.fillRect(0, 0, size, size);
    const palette = ['#e6e0d3', '#dad3c3', '#d1c9b8', '#e9e4d8', '#cfc7b5', '#d5cebd'];
    const cells = 3;
    const step = size / cells;
    for (let row = 0; row < cells; row += 1) {
      for (let column = 0; column < cells; column += 1) {
        const inset = 2 + Math.random() * 2;
        context.fillStyle = palette[(row * cells + column) % palette.length];
        context.fillRect(column * step + inset, row * step + inset, step - inset * 2, step - inset * 2);
      }
    }
    // 板块之间的缝：稍深的细线。
    context.strokeStyle = 'rgba(150, 141, 122, 0.5)';
    context.lineWidth = 2;
    for (let index = 0; index <= cells; index += 1) {
      context.beginPath();
      context.moveTo(index * step, 0);
      context.lineTo(index * step, size);
      context.stroke();
      context.beginPath();
      context.moveTo(0, index * step);
      context.lineTo(size, index * step);
      context.stroke();
    }
    // 细砂粒与浅色高光。
    for (let index = 0; index < 2600; index += 1) {
      const light = Math.random() > 0.5;
      context.fillStyle = light ? 'rgba(255, 252, 244, 0.22)' : 'rgba(142, 134, 118, 0.16)';
      context.fillRect(Math.random() * size, Math.random() * size, 1.2, 1.2);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** 远景树丛剪影：透明底 + 起伏轮廓，像隔着空气的浅色灌木带。 */
function createTreelineTexture(): THREE.CanvasTexture {
  const width = 512;
  const height = 128;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context) {
    context.clearRect(0, 0, width, height);
    // 从轮廓线往下铺浅绿，最底下一层略亮，像被日光照到的叶面。
    const gradient = context.createLinearGradient(0, height * 0.34, 0, height);
    gradient.addColorStop(0, 'rgba(186, 200, 170, 0.94)');
    gradient.addColorStop(1, 'rgba(204, 214, 190, 0.98)');
    context.fillStyle = gradient;
    context.fillRect(0, height * 0.34, width, height * 0.66);
    // 树冠：一排重叠的圆，做出起伏的天际线。
    for (let index = 0; index < 40; index += 1) {
      const cx = (index / 39) * width;
      const radius = 10 + Math.random() * 18;
      const cy = height * 0.34 + (Math.random() - 0.5) * 8;
      context.fillStyle = index % 3 === 0 ? 'rgba(192, 205, 176, 0.94)' : 'rgba(180, 195, 163, 0.94)';
      context.beginPath();
      context.arc(cx, cy, radius, 0, Math.PI * 2);
      context.fill();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 2;
  return texture;
}

/** 浅色天空：上淡蓝下暖白，横着铺开成很轻的云带。 */function createSkyTexture(): THREE.CanvasTexture {
  const width = 64;
  const height = 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#cfe2ee');
    gradient.addColorStop(0.5, '#e6eff0');
    gradient.addColorStop(0.78, '#f6f1e2');
    gradient.addColorStop(1, '#fbf6ea');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    // 几团很淡的云带，横向拉伸后就是天光里的薄云。
    for (let index = 0; index < 7; index += 1) {
      const y = height * (0.12 + Math.random() * 0.34);
      const radius = 14 + Math.random() * 22;
      const cloud = context.createRadialGradient(width / 2, y, 0, width / 2, y, radius);
      cloud.addColorStop(0, 'rgba(255, 255, 255, 0.5)');
      cloud.addColorStop(1, 'rgba(255, 255, 255, 0)');
      context.fillStyle = cloud;
      context.fillRect(0, y - radius, width, radius * 2);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 2;
  return texture;
}
