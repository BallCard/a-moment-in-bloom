/**
 * 「家居客厅」摄影布景（拍照阶段使用）。
 *
 * 空间约定与 photo.ts / scene-florist.ts / scene-garden.ts 保持一致：
 * - 原点 (0,0,0) 是花束位置，边柜台面顶面严格落在 TABLE_TOP_Y（0.66 米），花材尾部落在台面上；
 * - 相机在 +z 方向看向原点，正面（z>0）与花束 0.6 米半径内保持通透，道具都放在后侧与两侧；
 * - 返回的 Group 默认 visible = false，由 BouquetScene 在拍照阶段切显隐，本文件不把组加进 scene。
 *
 * 元素：暖米白泥墙 + 浅木地板 + 木色边柜（台面顶面 0.66）+ 墙上抽象小画 + 布罩台灯（含一个
 * 克制的暖色点光源）+ 后侧偏左的沙发一角 + 台面上的书与陶罐干花。
 * 空间与家具全部为程序化几何 + canvas 纹理（不加载外部贴图）；V12 起「台灯」与「干花小瓶」
 * 优先换成 Lux3D 真实模型（GLB，见 scene-props.ts / data/props.ts），程序化版本只隐藏不删除，
 * 加载失败时继续兜底。重复小物共用 geometry / material，三角面约 2k，远低于 3 万预算。
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { TABLE_TOP_Y } from '../../config';
import { mountSceneProps, type PropPlacement } from './scene-props';

/** 边柜台面顶面高度：必须等于花束底座高度，不能再高。 */
const TABLE_TOP = TABLE_TOP_Y;
/** 台面厚度（米）。 */
const TOP_THICK = 0.07;
/** 边柜宽 / 深（米）。宽到默认取景框看不到左右边缘，避免露出布景边界。 */
const CONSOLE_W = 5.2;
const CONSOLE_D = 1.5;
/** 边柜中心 z：前沿留在画外，后沿与沙发之间留一段地板，房间才有纵深。 */
const CONSOLE_Z = -0.15;
/** 柜体比台面内收一点，形成一圈台沿。 */
const BODY_W = CONSOLE_W - 0.08;
const BODY_D = CONSOLE_D - 0.12;
const BODY_H = 0.58;
/** 柜体正面 z：门板贴着它往前一点。 */
const BODY_FRONT_Z = CONSOLE_Z + BODY_D / 2;

/** 背墙：往后退到 z=-1.9（比花店一角更远），墙与边柜之间留出地板。 */
const WALL_Z = -1.9;
const WALL_THICK = 0.1;
const WALL_W = 7.4;
const WALL_H = 3.4;
/** 墙面朝 +z 的那一面：画框与踢脚线都贴着它。 */
const WALL_FRONT_Z = WALL_Z + WALL_THICK / 2;

/** 墙上的小画：挂在沙发上方偏左的空墙里，默认机位下在花头之上露出来。 */
const ART_X = -2.15;
const ART_Y = 1.7;
const ART_W = 0.82;
const ART_H = 1.06;

/** 台灯：靠台面左后，距原点 1.27 米，在花束 0.6 米半径之外。 */
const LAMP_X = -1.15;
const LAMP_Z = -0.55;
/**
 * Lux3D 台灯的归一化高度（米），与 data/props.ts 的 displayHeight 一致；
 * GLB 实测：底座落在 0~0.06、细灯杆到 0.28、灯罩从 0.281 到 0.45（下沿半径约 0.119）。
 */
const LAMP_HEIGHT = 0.45;
/**
 * 台灯点光的高度（米）：压在 GLB 灯罩中段（灯罩 0.941–1.11 米），
 * 也仍在程序化兜底灯罩（1.024–1.224 米）之内，两条路径都说得通。
 */
const LAMP_LIGHT_Y = TABLE_TOP + 0.38;

/** 沙发：贴墙放在后侧偏左，只从边柜上方露出一截靠背和抱枕。 */
const SOFA_X = -2.05;
const SOFA_Z = -1.34;
const SOFA_W = 1.62;
const SOFA_D = 0.84;

/** 台面左侧的一摞书（扁平盒），在台灯前方，距原点 0.9 米。 */
const BOOK_X = -0.88;
const BOOK_Z = -0.18;
/** 台面左侧的小陶罐，插几根干花。 */
const VASE_X = -0.78;
const VASE_Z = -0.42;
/** Lux3D 干花小瓶的归一化高度（米）：含瓶子与花头，与 data/props.ts 一致。 */
const DRIED_HEIGHT = 0.28;

interface LivingMaterials {
  wall: THREE.Material;
  floor: THREE.Material;
  consoleTop: THREE.Material;
  consoleSide: THREE.Material;
  consoleBody: THREE.Material;
  consolePanel: THREE.Material;
  baseboard: THREE.Material;
  frameWood: THREE.Material;
  artwork: THREE.Material;
  lampMetal: THREE.Material;
  lampShade: THREE.Material;
  lampBulb: THREE.Material;
  sofa: THREE.Material;
  seat: THREE.Material;
  pillowCream: THREE.Material;
  pillowSage: THREE.Material;
  throw: THREE.Material;
  ceramic: THREE.Material;
  driedStem: THREE.Material;
  driedHead: THREE.Material;
  bookPages: THREE.Material;
  bookCovers: THREE.Material[];
}

export function createLivingSet(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'living-set';
  group.visible = false;

  const wallTexture = createPlasterTexture();
  const floorTexture = createPlankTexture();
  const woodTexture = createWoodTexture();
  const linenTexture = createLinenTexture();
  const artworkTexture = createArtworkTexture();

  // ---- 共享材质：整间客厅只有一张材质表，重复小物共用，减少材质切换 ----
  const materials: LivingMaterials = {
    wall: new THREE.MeshStandardMaterial({ map: wallTexture, roughness: 1, metalness: 0 }),
    floor: new THREE.MeshStandardMaterial({ map: floorTexture, roughness: 0.9, metalness: 0 }),
    consoleTop: new THREE.MeshStandardMaterial({ map: woodTexture, color: '#d2ae80', roughness: 0.62, metalness: 0 }),
    consoleSide: new THREE.MeshStandardMaterial({ map: woodTexture, color: '#bb976e', roughness: 0.78, metalness: 0 }),
    consoleBody: new THREE.MeshStandardMaterial({ map: woodTexture, color: '#b48f66', roughness: 0.84, metalness: 0 }),
    consolePanel: new THREE.MeshStandardMaterial({ map: woodTexture, color: '#a98459', roughness: 0.88, metalness: 0 }),
    baseboard: new THREE.MeshStandardMaterial({ color: '#eadfcd', roughness: 0.92, metalness: 0 }),
    frameWood: new THREE.MeshStandardMaterial({ map: woodTexture, color: '#b8936a', roughness: 0.68, metalness: 0 }),
    artwork: new THREE.MeshStandardMaterial({ map: artworkTexture, roughness: 0.95, metalness: 0 }),
    lampMetal: new THREE.MeshStandardMaterial({ color: '#8b7f6d', roughness: 0.52, metalness: 0.35 }),
    lampShade: new THREE.MeshStandardMaterial({
      color: '#d5bd97',
      roughness: 0.95,
      metalness: 0,
      emissive: new THREE.Color('#ffa763'),
      emissiveIntensity: 0.5,
      side: THREE.DoubleSide,
    }),
    lampBulb: new THREE.MeshBasicMaterial({ color: '#ffdcaa', toneMapped: false }),
    sofa: new THREE.MeshStandardMaterial({ map: linenTexture, color: '#b8a893', roughness: 0.98, metalness: 0 }),
    seat: new THREE.MeshStandardMaterial({ map: linenTexture, color: '#c6b7a2', roughness: 0.98, metalness: 0 }),
    pillowCream: new THREE.MeshStandardMaterial({ map: linenTexture, color: '#ddcfb9', roughness: 1, metalness: 0 }),
    pillowSage: new THREE.MeshStandardMaterial({ map: linenTexture, color: '#a8ad90', roughness: 1, metalness: 0 }),
    throw: new THREE.MeshStandardMaterial({ map: linenTexture, color: '#a99c86', roughness: 1, metalness: 0 }),
    ceramic: new THREE.MeshStandardMaterial({ color: '#c3b298', roughness: 0.9, metalness: 0 }),
    driedStem: new THREE.MeshStandardMaterial({ color: '#9d8560', roughness: 1, metalness: 0 }),
    driedHead: new THREE.MeshStandardMaterial({ color: '#c2a884', roughness: 1, metalness: 0 }),
    bookPages: new THREE.MeshStandardMaterial({ color: '#e9dfcd', roughness: 0.96, metalness: 0 }),
    bookCovers: [
      new THREE.MeshStandardMaterial({ color: '#c1a077', roughness: 0.9, metalness: 0 }),
      new THREE.MeshStandardMaterial({ color: '#9fa68b', roughness: 0.9, metalness: 0 }),
      new THREE.MeshStandardMaterial({ color: '#ab988d', roughness: 0.9, metalness: 0 }),
    ],
  };

  // ---- 浅木地板：压在场景自带地面（y=0）上方 4 毫米，避免 z-fighting ----
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 12), materials.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0.004, -0.5);
  floor.receiveShadow = true;
  group.add(floor);

  // ---- 暖米白背墙：底边落到地板，边柜贴墙放，中间不留缝 ----
  addBox(group, WALL_W, WALL_H, WALL_THICK, 0, WALL_H / 2, WALL_Z, materials.wall, false, true);
  // 踢脚线：贴着墙根的一道窄条，让墙与地板的交界有厚度（默认机位下被边柜挡住）。
  addBox(group, WALL_W, 0.085, 0.032, 0, 0.0425, WALL_FRONT_Z + 0.016, materials.baseboard, false, true);

  // ---- 边柜：台面顶面必须正好是 0.66 ----
  addBox(group, CONSOLE_W, TOP_THICK, CONSOLE_D, 0, TABLE_TOP - TOP_THICK / 2, CONSOLE_Z, [
    materials.consoleSide,
    materials.consoleSide,
    materials.consoleTop,
    materials.consoleSide,
    materials.consoleSide,
    materials.consoleSide,
  ]);
  // 柜体比台面内收，落在木地板上而不是悬空；柜体顶面正好接住台面下沿。
  addBox(group, BODY_W, BODY_H, BODY_D, 0, BODY_H / 2 + 0.01, CONSOLE_Z, materials.consoleBody, true, true);
  // 正面三块简单门板：低机位时柜体不至于是一大块空白。
  const panelGeo = new THREE.BoxGeometry(1.06, 0.4, 0.016);
  for (const panelX of [-1.55, 0, 1.55]) {
    addMesh(group, panelGeo, materials.consolePanel, panelX, 0.34, BODY_FRONT_Z + 0.008, false, true);
  }

  // ---- 墙上的小画：细木框 + 略退进去的画布，默认机位下在左上角的空墙里 ----
  addWallArt(group, materials);

  // ---- 台灯 + 很弱的暖色点光源（放在台面左后，不压花束正面） ----
  addTableLamp(group, materials);

  // ---- 后侧偏左的沙发一角：只露出靠背、扶手和两个抱枕 ----
  addSofaCorner(group, materials);

  // ---- 台面点缀：台灯前的一摞书、左侧陶罐干花，都在花束 0.6 米半径之外 ----
  addBookStack(group, materials);
  addCeramicVase(group, materials);

  // ---- V12：近景道具换成 Lux3D 真实模型，空间仍是程序化几何 ----
  // 程序化版本只隐藏、不删除：GLB 加载失败时继续当兜底（失败由 scene-props 静默处理）。
  // 每件道具单独发起一次挂载：节点名是 `scene-prop-<id>-<该次调用内的序号>`，
  // 分开调用能让两件道具都落在 0 号位，方便调试与自动化断言直接按名字定位。
  const lampPlacement: PropPlacement = {
    // 台灯落点 = 原程序化台灯位置（台面上 y=0.66），高度 0.45 米；
    // 灯罩里的点光 living-lamp-light 不随网格隐藏，仍在灯罩内部（见 addTableLamp）。
    id: 'table-lamp',
    position: [LAMP_X, TABLE_TOP, LAMP_Z],
    height: LAMP_HEIGHT,
    hide: ['living-lamp-procedural'],
  };
  mountSceneProps(group, [lampPlacement]);
  const driedPlacement: PropPlacement = {
    // 干花小瓶落点 = 原陶罐位置，落在台面上（y=0.66），高度 0.28 米。
    id: 'dried-bouquet',
    position: [VASE_X, TABLE_TOP, VASE_Z],
    height: DRIED_HEIGHT,
    hide: ['living-vase'],
  };
  mountSceneProps(group, [driedPlacement]);

  return group;
}

/** 墙上挂画：四根木条围成边框，画布平面略退进框内，边缘藏在框后。 */
function addWallArt(parent: THREE.Object3D, materials: LivingMaterials): void {
  const bar = 0.05;
  const depth = 0.045;
  const z = WALL_FRONT_Z + depth / 2;
  const verticalGeo = new THREE.BoxGeometry(bar, ART_H, depth);
  const horizontalGeo = new THREE.BoxGeometry(ART_W, bar, depth);
  for (const dx of [-(ART_W - bar) / 2, (ART_W - bar) / 2]) {
    addMesh(parent, verticalGeo, materials.frameWood, ART_X + dx, ART_Y, z, false, true);
  }
  for (const dy of [-(ART_H - bar) / 2, (ART_H - bar) / 2]) {
    addMesh(parent, horizontalGeo, materials.frameWood, ART_X, ART_Y + dy, z, false, true);
  }
  const canvasGeo = new THREE.PlaneGeometry(ART_W - bar + 0.008, ART_H - bar + 0.008);
  addMesh(parent, canvasGeo, materials.artwork, ART_X, ART_Y, z - 0.004, false, true);
}

/**
 * 台灯：程序化兜底（圆底盘 + 细灯杆 + 布灯罩）+ 暖色点光源。
 *
 * 兜底网格统一挂在 `living-lamp-procedural` 组里：Lux3D 台灯就位后由
 * `mountSceneProps` 只把这个组设为不可见；点光与灯泡不在组内，替换后仍然亮着。
 */
function addTableLamp(parent: THREE.Object3D, materials: LivingMaterials): void {
  const fallback = new THREE.Group();
  fallback.name = 'living-lamp-procedural';
  parent.add(fallback);

  addMesh(
    fallback,
    new THREE.CylinderGeometry(0.085, 0.095, 0.024, 18),
    materials.lampMetal,
    LAMP_X,
    TABLE_TOP + 0.012,
    LAMP_Z,
  );
  addMesh(
    fallback,
    new THREE.CylinderGeometry(0.011, 0.011, 0.34, 8),
    materials.lampMetal,
    LAMP_X,
    TABLE_TOP + 0.194,
    LAMP_Z,
  );
  // 灯罩双面可见，内侧也能看到暖光；顶部与底部都不封口。
  addMesh(
    fallback,
    new THREE.CylinderGeometry(0.098, 0.152, 0.2, 20, 1, true),
    materials.lampShade,
    LAMP_X,
    TABLE_TOP + 0.464,
    LAMP_Z,
    true,
    false,
  );
  // 灯泡放在兜底组外面：GLB 灯罩是闭合的，它藏在里面看不见也无害；
  // 万一 GLB 加载失败，它就是兜底灯罩里的那点暖光。
  addMesh(
    parent,
    new THREE.SphereGeometry(0.028, 10, 8),
    materials.lampBulb,
    LAMP_X,
    TABLE_TOP + 0.41,
    LAMP_Z,
    false,
    false,
  );
  // 强度比主光低一个量级：只在台面左侧和背后墙上留一团暖光，不改变花束的受光关系。
  const light = new THREE.PointLight(0xffcda2, 2.2, 2.8, 2);
  light.position.set(LAMP_X, LAMP_LIGHT_Y, LAMP_Z);
  light.name = 'living-lamp-light';
  parent.add(light);
}

/** 沙发一角：低矮软包 + 两块坐垫 + 靠背 + 两侧扶手 + 两个抱枕。 */
function addSofaCorner(parent: THREE.Object3D, materials: LivingMaterials): void {
  const sofa = new THREE.Group();
  sofa.name = 'living-sofa';
  sofa.position.set(SOFA_X, 0, SOFA_Z);
  parent.add(sofa);

  addRoundedBox(sofa, SOFA_W, 0.3, SOFA_D, 0, 0.15, 0, materials.sofa, 0.05);
  const seatGeo = new RoundedBoxGeometry(0.68, 0.17, 0.7, 1, 0.05);
  addMesh(sofa, seatGeo, materials.seat, -0.36, 0.385, 0.05);
  addMesh(sofa, seatGeo, materials.seat, 0.36, 0.385, 0.05);
  // 靠背顶面 1.0：从 0.66 的台面之上露出约 0.35 米，正好是「沙发在边柜后面」的读法。
  addRoundedBox(sofa, SOFA_W, 0.7, 0.24, 0, 0.65, -SOFA_D / 2 + 0.12, materials.sofa, 0.06);
  const armGeo = new RoundedBoxGeometry(0.2, 0.42, SOFA_D, 1, 0.06);
  addMesh(sofa, armGeo, materials.sofa, -(SOFA_W - 0.2) / 2, 0.51, 0);
  addMesh(sofa, armGeo, materials.sofa, (SOFA_W - 0.2) / 2, 0.51, 0);

  // 两个抱枕斜靠在靠背上，一浅一灰绿，只露出上缘。
  const pillowGeo = new RoundedBoxGeometry(0.42, 0.38, 0.16, 1, 0.07);
  const cream = addMesh(sofa, pillowGeo, materials.pillowCream, -0.36, 0.63, -0.13);
  cream.rotation.x = -0.26;
  cream.rotation.z = 0.06;
  const sage = addMesh(sofa, pillowGeo, materials.pillowSage, 0.32, 0.6, -0.14);
  sage.rotation.x = -0.3;
  sage.rotation.z = -0.05;
  // 靠背上搭一条薄毯，边缘垂下来一点：一眼就能读成「有人住的客厅」。
  const throwBlanket = addRoundedBox(sofa, 0.92, 0.05, 0.34, -0.2, 0.995, -SOFA_D / 2 + 0.13, materials.throw, 0.02);
  throwBlanket.rotation.z = 0.03;
}

/** 台面左侧的一摞书：三本扁平盒错开叠放，书页朝向镜头一侧露一条浅色边。 */
function addBookStack(parent: THREE.Object3D, materials: LivingMaterials): void {
  const bookGeo = new THREE.BoxGeometry(1, 1, 1);
  const specs = [
    { width: 0.27, height: 0.036, depth: 0.2, rest: 0.018, angle: 0.06, cover: 0 },
    { width: 0.25, height: 0.03, depth: 0.185, rest: 0.081, angle: -0.05, cover: 1 },
    { width: 0.23, height: 0.026, depth: 0.17, rest: 0.109, angle: 0.16, cover: 2 },
  ] as const;
  for (const spec of specs) {
    const cover = materials.bookCovers[spec.cover];
    // 六面材质：+z（朝镜头的那条边）是书页，其余是封面。
    const book = new THREE.Mesh(bookGeo, [cover, cover, cover, cover, materials.bookPages, cover]);
    book.position.set(BOOK_X, TABLE_TOP + spec.rest, BOOK_Z);
    book.scale.set(spec.width, spec.height, spec.depth);
    book.rotation.y = spec.angle;
    book.castShadow = true;
    book.receiveShadow = true;
    parent.add(book);
  }
}

/**
 * 台面左侧的小陶罐：罐身 + 收口 + 三根很短的干花，高度压在花头之下。
 *
 * 全部挂在 `living-vase` 组里：Lux3D 干花小瓶就位后整组隐藏，作为加载失败时的兜底。
 */
function addCeramicVase(parent: THREE.Object3D, materials: LivingMaterials): void {
  const fallback = new THREE.Group();
  fallback.name = 'living-vase';
  parent.add(fallback);

  addMesh(
    fallback,
    new THREE.CylinderGeometry(0.052, 0.042, 0.14, 16),
    materials.ceramic,
    VASE_X,
    TABLE_TOP + 0.07,
    VASE_Z,
  );
  addMesh(
    fallback,
    new THREE.CylinderGeometry(0.045, 0.05, 0.022, 16),
    materials.ceramic,
    VASE_X,
    TABLE_TOP + 0.151,
    VASE_Z,
  );
  const stemGeo = new THREE.CylinderGeometry(0.0032, 0.0032, 0.15, 5, 1, true);
  const headGeo = new THREE.SphereGeometry(0.011, 6, 4);
  for (let index = 0; index < 3; index += 1) {
    // 黄金角散开，三根茎读成一小把干花。
    const angle = index * 2.399 + 0.4;
    const dx = Math.cos(angle) * 0.022;
    const dz = Math.sin(angle) * 0.022;
    const stem = addMesh(fallback, stemGeo, materials.driedStem, VASE_X + dx, TABLE_TOP + 0.237, VASE_Z + dz);
    stem.rotation.z = dx * 2.4;
    stem.rotation.x = -dz * 2.4;
    const head = addMesh(fallback, headGeo, materials.driedHead, VASE_X + dx * 2.6, TABLE_TOP + 0.32, VASE_Z + dz * 2.6);
    head.rotation.z = stem.rotation.z;
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

/** 软包用小圆角盒：沙发与抱枕靠它读成「软」的，冰角会立刻变成硬家具。 */
function addRoundedBox(
  parent: THREE.Object3D,
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  material: THREE.Material,
  radius: number,
  castShadow = true,
  receiveShadow = true,
): THREE.Mesh {
  return addMesh(
    parent,
    new RoundedBoxGeometry(width, height, depth, 1, radius),
    material,
    x,
    y,
    z,
    castShadow,
    receiveShadow,
  );
}

// ---------- 程序化纹理 ----------

/** 可复现的伪随机数（mulberry32）：同一版纹理每次生成都一致，重建布景不会变样。 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** 暖米白泥墙：抹刀起伏的深浅斑块 + 极细砂粒，避免整面墙是一块纯色。 */
function createPlasterTexture(): THREE.CanvasTexture {
  const size = 256;
  const random = createRandom(20261107);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#dccdb8';
    context.fillRect(0, 0, size, size);
    for (let index = 0; index < 70; index += 1) {
      const x = random() * size;
      const y = random() * size;
      const radius = 12 + random() * 52;
      const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, random() > 0.5 ? 'rgba(252, 246, 236, 0.18)' : 'rgba(186, 168, 145, 0.12)');
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      context.fillStyle = gradient;
      context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    for (let index = 0; index < 1400; index += 1) {
      context.fillStyle = random() > 0.5 ? 'rgba(255, 251, 243, 0.14)' : 'rgba(140, 124, 104, 0.1)';
      context.fillRect(random() * size, random() * size, 1, 1);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 1.3);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** 浅木地板：横向长条板 + 错开的接缝 + 很淡的顺纹，一间干净的原木客厅。 */
function createPlankTexture(): THREE.CanvasTexture {
  const size = 512;
  const random = createRandom(1207);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#d8c2a2';
    context.fillRect(0, 0, size, size);
    const rows = 7;
    const rowHeight = size / rows;
    const tints = ['#ddc8a9', '#d5bf9e', '#e1cdb0', '#d9c3a3', '#d2bb9a', '#dfc9ab', '#dbc5a5'];
    for (let row = 0; row < rows; row += 1) {
      const y = row * rowHeight;
      let x = -random() * 180;
      let segment = 0;
      while (x < size) {
        const length = 150 + random() * 190;
        context.fillStyle = tints[(row * 3 + segment) % tints.length];
        context.fillRect(x + 1.5, y + 1.2, length - 3, rowHeight - 2.4);
        // 每块板几条很淡的顺纹，木纹方向统一，地板就不会花。
        for (let line = 0; line < 4; line += 1) {
          context.strokeStyle = line % 2 === 0 ? 'rgba(150, 118, 82, 0.13)' : 'rgba(248, 238, 222, 0.22)';
          context.lineWidth = 0.8;
          const baseY = y + rowHeight * (0.16 + 0.21 * line);
          context.beginPath();
          for (let step = 0; step <= 24; step += 1) {
            const px = x + (step / 24) * length;
            const wave = Math.sin(step * 0.55 + line + row) * 1.1;
            if (step === 0) context.moveTo(px, baseY + wave);
            else context.lineTo(px, baseY + wave);
          }
          context.stroke();
        }
        // 板与板之间的横缝：一深一浅，读起来像真实的企口缝。
        context.fillStyle = 'rgba(126, 99, 70, 0.4)';
        context.fillRect(x, y, 1.6, rowHeight);
        context.fillStyle = 'rgba(252, 245, 232, 0.3)';
        context.fillRect(x + 1.6, y, 1, rowHeight);
        x += length;
        segment += 1;
      }
      context.fillStyle = 'rgba(126, 99, 70, 0.38)';
      context.fillRect(0, y, size, 1.6);
      context.fillStyle = 'rgba(252, 245, 232, 0.28)';
      context.fillRect(0, y + 1.6, size, 1);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(7, 6);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** 浅橡木：横向长纹 + 两个木节，边柜与画框共用一张，靠材质颜色区分明暗。 */
function createWoodTexture(): THREE.CanvasTexture {
  const size = 256;
  const random = createRandom(4919);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#e5cfae';
    context.fillRect(0, 0, size, size);
    for (let index = 0; index < 30; index += 1) {
      const y = (index / 30) * size + random() * 3;
      context.strokeStyle = index % 3 === 0 ? 'rgba(132, 96, 60, 0.22)' : 'rgba(158, 120, 82, 0.14)';
      context.lineWidth = index % 3 === 0 ? 1.8 : 1;
      context.beginPath();
      for (let x = 0; x <= size; x += 8) {
        const wave = Math.sin(x * 0.024 + index * 1.3) * 2.4 + Math.sin(x * 0.008 + index * 0.7) * 1.8;
        if (x === 0) context.moveTo(x, y + wave);
        else context.lineTo(x, y + wave);
      }
      context.stroke();
    }
    context.strokeStyle = 'rgba(126, 90, 58, 0.2)';
    context.lineWidth = 1.2;
    for (let index = 0; index < 3; index += 1) {
      const cx = random() * size;
      const cy = random() * size;
      for (let ring = 0; ring < 3; ring += 1) {
        context.beginPath();
        context.ellipse(cx, cy, 7 + ring * 5, 3 + ring * 2, 0.35, 0, Math.PI * 2);
        context.stroke();
      }
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

/** 细棉麻：经纬各一层浅线 + 一点绒面噪点，沙发和抱枕近看有布纹。 */
function createLinenTexture(): THREE.CanvasTexture {
  const size = 128;
  const random = createRandom(77);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#f6f1e8';
    context.fillRect(0, 0, size, size);
    for (let index = 0; index < size; index += 2) {
      const dark = index % 4 === 0;
      context.fillStyle = dark ? 'rgba(196, 182, 162, 0.1)' : 'rgba(255, 252, 246, 0.16)';
      context.fillRect(0, index, size, 1);
      context.fillStyle = dark ? 'rgba(196, 182, 162, 0.08)' : 'rgba(255, 252, 246, 0.12)';
      context.fillRect(index, 0, 1, size);
    }
    for (let index = 0; index < 500; index += 1) {
      context.fillStyle = random() > 0.5 ? 'rgba(255, 255, 255, 0.12)' : 'rgba(160, 146, 126, 0.07)';
      context.fillRect(random() * size, random() * size, 2, 1);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 3);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 2;
  return texture;
}

/** 墙上的小画：暖白底 + 几团低饱和晕染 + 一条很淡的地平线，抽象小幅风景。 */
function createArtworkTexture(): THREE.CanvasTexture {
  const width = 256;
  const height = 320;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#f0e6d4';
    context.fillRect(0, 0, width, height);
    const washes: [number, number, number, string][] = [
      [0.32, 0.34, 0.42, 'rgba(170, 126, 110, 0.72)'],
      [0.64, 0.46, 0.38, 'rgba(112, 130, 106, 0.62)'],
      [0.42, 0.74, 0.34, 'rgba(190, 156, 108, 0.68)'],
      [0.78, 0.16, 0.26, 'rgba(214, 196, 168, 0.6)'],
    ];
    for (const [cx, cy, radius, color] of washes) {
      const gradient = context.createRadialGradient(
        width * cx,
        height * cy,
        0,
        width * cx,
        height * cy,
        width * radius,
      );
      gradient.addColorStop(0, color);
      gradient.addColorStop(0.62, color);
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
    }
    // 一条地平线，给抽象色块一个落点。
    context.strokeStyle = 'rgba(92, 82, 68, 0.5)';
    context.lineWidth = 2.4;
    context.beginPath();
    context.moveTo(width * 0.16, height * 0.6);
    context.lineTo(width * 0.84, height * 0.6);
    context.stroke();
    // 一小块实色方形，画面不至于全是虚的。
    context.fillStyle = 'rgba(124, 104, 82, 0.6)';
    context.fillRect(width * 0.56, height * 0.28, width * 0.15, height * 0.1);
    // 装裱内衬：一圈更亮的窄边。
    context.strokeStyle = 'rgba(248, 242, 230, 0.95)';
    context.lineWidth = 12;
    context.strokeRect(6, 6, width - 12, height - 12);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
