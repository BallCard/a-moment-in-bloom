/**
 * 「咖啡馆桌面」摄影布景（拍照阶段使用）。
 *
 * 空间约定与 photo.ts 的 createWindowSet / createGallerySet 以及 scene-florist.ts /
 * scene-garden.ts 保持一致：
 * - 原点 (0,0,0) 是花束位置，桌面顶面严格落在 TABLE_TOP_Y（0.66 米），花材尾部落在桌面上；
 * - 相机在 +z 方向看向原点，花束正面与半径 0.6 米内保持通透，道具都放在半径之外的低处；
 * - 返回的 Group 默认 visible = false，由 BouquetScene 在拍照阶段切显隐，本文件不把组加进 scene。
 *
 * 元素：浅橡木桌面 + 暖灰泥背墙 + 右侧深木窗框与柔和天光玻璃 + 左侧菜单板
 *       + 咖啡杯碟勺 / 合上的杂志 / 陶盆小绿植 + 桌面上一道很浅的窗光。
 * 空间骨架全部为程序化几何与 canvas 纹理（不加载外部贴图）；近景咖啡杯碟用 Lux3D
 * 真实 GLB（由 scene-props.ts 异步挂载，加载失败时继续用程序化杯碟兜底）。
 * 实测 45 个程序化 mesh、约 1.4k 三角面、约 50 draw call、21 份材质，远低于 3 万 / 90 的预算。
 */

import * as THREE from 'three';
import { TABLE_TOP_Y } from '../../config';
import { mountSceneProps, type PropPlacement } from './scene-props';

/** 桌面顶面高度：必须等于花束底座高度，不能再高。 */
const TABLE_TOP = TABLE_TOP_Y;
/** 桌面尺寸（米）：宽、深、中心 z。宽到取景框外，前沿伸向相机，俯视时不漏底。 */
const TABLE_W = 5.2;
const TABLE_D = 2.1;
const TABLE_Z = -0.03;
/** 桌面板厚（米）。 */
const TABLE_THICK = 0.055;

/** 背墙（墙面朝 +z）：底边正好压在桌面上，中间不留缝；宽到取景框外。 */
const WALL_Z = -0.95;
const WALL_W = 7.0;
const WALL_H = 2.6;
const WALL_D = 0.12;
/** 墙面前沿 z：窗框、菜单板都以它为基准往 +z 贴。 */
const WALL_FRONT = WALL_Z + WALL_D / 2;

/** 窗户（右后方）：深色木框 + 柔和天光玻璃。整体偏右，给花束右边留一点街角光线。 */
const WINDOW_X = 0.85;
const WINDOW_Y = 1.62;
const GLASS_W = 1.3;
const GLASS_H = 1.2;
const FRAME_Z = WALL_FRONT + 0.025;
/** 窗台顶面高度：由窗框下沿推出来，避免悬空。 */
const SILL_Y = WINDOW_Y - (GLASS_H / 2 + 0.035) - 0.0575;

/** 菜单板（左后方）：木框 + 深色板面，只用浅色横线示意字迹，不写真实文字。 */
const BOARD_X = -1.5;
const BOARD_Y = 1.72;
const BOARD_W = 1.0;
const BOARD_H = 0.72;

/** 咖啡杯碟（左侧，距原点约 0.85 米，低矮、不挡花，同时在窗光条里）。 */
const CUP_X = -0.84;
const CUP_Z = 0;
/** 碟子顶面高度：杯身坐在碟子上。 */
const SAUCER_TOP = TABLE_TOP + 0.012;

/**
 * Lux3D 咖啡杯碟（coffee-set）挂载参数。
 *
 * 入库 GLB 的原始姿态就是直立的（杯口朝上、碟子平放、杯把朝 +x），manifest 四视角
 * 目检已把 `posture` 订正为 upright、rotation 0°；`data/props.ts` 不再加任何旋转，
 * 归一化高度 0.085m（碟径约 0.175m，接近真实杯碟）。落点直接用原杯碟位置。
 */

/** 程序化杯碟勺的节点名：GLB 就位后由 mountSceneProps 按名隐藏（只隐藏，不删除兜底）。 */
const PROCEDURAL_CUP_PARTS = [
  'cafe-saucer',
  'cafe-cup-body',
  'cafe-cup-coffee',
  'cafe-cup-rim',
  'cafe-cup-handle',
  'cafe-spoon',
  'cafe-spoon-handle',
  'cafe-spoon-bowl',
] as const;

/** 合上的杂志（右后，距原点约 0.89 米，薄薄一层不挡主体，靠墙摊在桌上）。 */
const MAGAZINE_X = 0.42;
const MAGAZINE_Z = -0.78;

/** 陶盆小绿植（左后角，在菜单板下方，距原点约 1.4 米）。 */
const PLANT_X = -1.28;
const PLANT_Z = -0.58;

/** 布景里所有材质的集合：同色系小物只建一份，减少材质切换。 */
interface CafeMaterials {
  tableTop: THREE.Material;
  tableSide: THREE.Material;
  leg: THREE.Material;
  floor: THREE.Material;
  wall: THREE.Material;
  frame: THREE.Material;
  glass: THREE.Material;
  boardFrame: THREE.Material;
  board: THREE.Material;
  chalk: THREE.Material;
  ceramic: THREE.Material;
  coffee: THREE.Material;
  metal: THREE.Material;
  paper: THREE.Material;
  spine: THREE.Material;
  terracotta: THREE.Material;
  soil: THREE.Material;
  foliage: THREE.Material[];
  lightBand: THREE.Material;
}

export function createCafeSet(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'cafe-set';
  group.visible = false;

  // ---- 程序化纹理：桌面木纹 / 地板木纹 / 暖灰泥 / 天光玻璃 / 窗光条 ----
  const tableWood = createWoodTexture({ base: '#dcc6a6', light: '#ebdcc2', dark: '#b08f68' }, 3, 1.6);
  const floorWood = createWoodTexture({ base: '#b79b7b', light: '#c8ae8d', dark: '#8f7253' }, 6, 6);
  const plaster = createPlasterTexture();
  const daylight = createDaylightTexture();
  const windowLight = createWindowLightTexture();

  // ---- 共享材质：低饱和、明亮、留白多，亮度留给花 ----
  const materials: CafeMaterials = {
    tableTop: new THREE.MeshStandardMaterial({ map: tableWood, roughness: 0.78, metalness: 0 }),
    tableSide: new THREE.MeshStandardMaterial({ color: '#cbb08b', roughness: 0.84, metalness: 0 }),
    leg: new THREE.MeshStandardMaterial({ color: '#b2946f', roughness: 0.86, metalness: 0 }),
    floor: new THREE.MeshStandardMaterial({ map: floorWood, roughness: 0.95, metalness: 0 }),
    wall: new THREE.MeshStandardMaterial({ map: plaster, roughness: 1, metalness: 0 }),
    // 深色胡桃木窗框：给右侧一点硬朗的深色轮廓。
    frame: new THREE.MeshStandardMaterial({ color: '#4a392c', roughness: 0.72, metalness: 0 }),
    // 玻璃用 Basic + 天光渐变：不参与灯光与反射，避免把花束倒映进去。
    glass: new THREE.MeshBasicMaterial({ map: daylight, toneMapped: false }),
    boardFrame: new THREE.MeshStandardMaterial({ color: '#7d6047', roughness: 0.8, metalness: 0 }),
    // 菜单板面：深灰绿粉笔板，和浅色桌面形成一块安静的深色背景。
    board: new THREE.MeshStandardMaterial({ color: '#414d46', roughness: 0.96, metalness: 0 }),
    chalk: new THREE.MeshBasicMaterial({ color: '#ded6c4', toneMapped: false }),
    ceramic: new THREE.MeshStandardMaterial({ color: '#f0e9dc', roughness: 0.45, metalness: 0 }),
    coffee: new THREE.MeshStandardMaterial({ color: '#3a2a1e', roughness: 0.28, metalness: 0 }),
    metal: new THREE.MeshStandardMaterial({ color: '#c4beb2', roughness: 0.3, metalness: 0.6 }),
    paper: new THREE.MeshStandardMaterial({ color: '#e2d7c4', roughness: 0.94, metalness: 0 }),
    spine: new THREE.MeshStandardMaterial({ color: '#8d7257', roughness: 0.86, metalness: 0 }),
    terracotta: new THREE.MeshStandardMaterial({ color: '#bd8a66', roughness: 0.88, metalness: 0 }),
    soil: new THREE.MeshStandardMaterial({ color: '#5b4a39', roughness: 1, metalness: 0 }),
    foliage: [
      new THREE.MeshStandardMaterial({ color: '#7a9066', roughness: 1, metalness: 0 }),
      new THREE.MeshStandardMaterial({ color: '#8aa274', roughness: 1, metalness: 0 }),
      new THREE.MeshStandardMaterial({ color: '#6b8459', roughness: 1, metalness: 0 }),
    ],
    lightBand: new THREE.MeshBasicMaterial({
      map: windowLight,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      toneMapped: false,
    }),
  };

  // ---- 木地板：压在场景自带地面（y=0）上方 4 毫米，避免 z-fighting；宽到取景框外 ----
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 10), materials.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.004;
  floor.receiveShadow = true;
  group.add(floor);

  // ---- 桌面：台面顶面必须正好是 0.66 ----
  addBox(group, TABLE_W, TABLE_THICK, TABLE_D, 0, TABLE_TOP - TABLE_THICK / 2, TABLE_Z, [
    materials.tableSide,
    materials.tableSide,
    materials.tableTop,
    materials.tableSide,
    materials.tableSide,
    materials.tableSide,
  ]);
  // 桌裙：藏在台面下，侧面看不至于是一块悬空的板。
  addBox(group, TABLE_W - 0.06, 0.1, TABLE_D - 0.1, 0, 0.555, TABLE_Z, materials.tableSide, true, true);
  // 四条桌腿：从地板起到桌裙底，避免桌下空得只剩背景色。
  const legGeo = new THREE.BoxGeometry(0.07, 0.501, 0.07);
  for (const legX of [-TABLE_W / 2 + 0.18, TABLE_W / 2 - 0.18]) {
    for (const legZ of [TABLE_Z - TABLE_D / 2 + 0.18, TABLE_Z + TABLE_D / 2 - 0.18]) {
      addMesh(group, legGeo, materials.leg, legX, 0.2545, legZ, true, true);
    }
  }

  // ---- 暖灰泥背墙：底边正好落在台面上；宽到取景框外，不露出墙的边界 ----
  addBox(group, WALL_W, WALL_H, WALL_D, 0, TABLE_TOP + WALL_H / 2, WALL_Z, materials.wall, false, true);

  // ---- 墙面元素：右侧窗、左侧菜单板 ----
  addWindow(group, materials);
  addMenuBoard(group, materials);

  // ---- 桌面道具：全部在花束半径 0.6 米之外 ----
  addCupSet(group, materials);
  addMagazine(group, materials);
  addPottedPlant(group, materials);

  // ---- 桌面窗光条：极浅的渐变平面，假装光从窗口斜落在桌面上，不做体积光 ----
  // 几何体先平铺再绕 y 轻转，保证整块都在桌面范围内、且不压到花束位。
  const lightGeo = new THREE.PlaneGeometry(0.62, 1.8);
  lightGeo.rotateX(-Math.PI / 2);
  lightGeo.rotateY(-0.3);
  const light = new THREE.Mesh(lightGeo, materials.lightBand);
  light.name = 'cafe-window-light';
  light.position.set(-0.95, TABLE_TOP + 0.0012, -0.1);
  light.renderOrder = 2;
  group.add(light);

  // ---- 左侧窗光：强度克制，只补一点暖色与接触阴影，不压过场景主光 ----
  const windowSun = new THREE.DirectionalLight(0xfff2e0, 0.45);
  windowSun.name = 'cafe-window-sun';
  windowSun.position.set(-2.6, 3.1, 1.7);
  windowSun.castShadow = true;
  windowSun.shadow.mapSize.set(1024, 1024);
  windowSun.shadow.camera.left = -3.4;
  windowSun.shadow.camera.right = 3.4;
  windowSun.shadow.camera.top = 2.8;
  windowSun.shadow.camera.bottom = -2.6;
  windowSun.shadow.camera.near = 0.6;
  windowSun.shadow.camera.far = 11;
  windowSun.shadow.bias = -0.0004;
  windowSun.shadow.normalBias = 0.02;
  windowSun.shadow.radius = 3;
  windowSun.target.position.set(0, 0.85, -0.5);
  group.add(windowSun);
  group.add(windowSun.target);

  // ---- Lux3D 近景道具：真实咖啡杯碟替换程序化杯碟勺 ----
  // 异步加载：模型就位后挂到组内并隐藏 PROCEDURAL_CUP_PARTS；加载失败则什么都不做，
  // 程序化杯碟继续当兜底。落点仍是原杯碟位置（视觉底面 y=0.66）。
  const coffeeSetPlacement: PropPlacement = {
    id: 'coffee-set',
    position: [CUP_X, TABLE_TOP, CUP_Z],
    hide: [...PROCEDURAL_CUP_PARTS],
  };
  mountSceneProps(group, [coffeeSetPlacement]);

  return group;
}

/** 右后方的窗：深色木框 + 中竖梃 + 一道横档 + 天光玻璃 + 窗台。 */
function addWindow(parent: THREE.Object3D, materials: CafeMaterials): void {
  // 玻璃略微退到窗框后面，避免和框条 z-fighting。
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(GLASS_W, GLASS_H), materials.glass);
  glass.name = 'cafe-window-glass';
  glass.position.set(WINDOW_X, WINDOW_Y, WALL_FRONT + 0.006);
  parent.add(glass);

  // 外框：左右两根竖料共用 geometry，上下两根横料共用 geometry。
  const sideGeo = new THREE.BoxGeometry(0.07, GLASS_H + 0.14, 0.05);
  addMesh(parent, sideGeo, materials.frame, WINDOW_X - (GLASS_W / 2 + 0.035), WINDOW_Y, FRAME_Z);
  addMesh(parent, sideGeo, materials.frame, WINDOW_X + (GLASS_W / 2 + 0.035), WINDOW_Y, FRAME_Z);
  const barGeo = new THREE.BoxGeometry(GLASS_W + 0.14, 0.07, 0.05);
  addMesh(parent, barGeo, materials.frame, WINDOW_X, WINDOW_Y - (GLASS_H / 2 + 0.035), FRAME_Z);
  addMesh(parent, barGeo, materials.frame, WINDOW_X, WINDOW_Y + (GLASS_H / 2 + 0.035), FRAME_Z);

  // 中竖梃 + 上部横档：把玻璃分成三格，读起来像街角咖啡馆的老窗。
  addMesh(parent, new THREE.BoxGeometry(0.028, GLASS_H, 0.035), materials.frame, WINDOW_X, WINDOW_Y, FRAME_Z + 0.004);
  addMesh(
    parent,
    new THREE.BoxGeometry(GLASS_W, 0.028, 0.035),
    materials.frame,
    WINDOW_X,
    WINDOW_Y + 0.32,
    FRAME_Z + 0.004,
  );

  // 窗台：略微探出墙面，给右后方一点层次。
  addBox(parent, GLASS_W + 0.26, 0.045, 0.13, WINDOW_X, SILL_Y, WALL_FRONT + 0.04, materials.frame, true, true);
}

/** 左后方的菜单板：木框 + 深色板面 + 几道浅色横线（示意字迹，不写真文字）。 */
function addMenuBoard(parent: THREE.Object3D, materials: CafeMaterials): void {
  const faceZ = WALL_FRONT + 0.012;

  // 板面：薄板贴在墙上，前面再压一圈木框。
  addBox(parent, BOARD_W, BOARD_H, 0.014, BOARD_X, BOARD_Y, faceZ - 0.007, materials.board, false, true);

  const sideGeo = new THREE.BoxGeometry(0.045, BOARD_H + 0.09, 0.045);
  const frameZ = WALL_FRONT + 0.017;
  addMesh(parent, sideGeo, materials.boardFrame, BOARD_X - (BOARD_W / 2 + 0.0225), BOARD_Y, frameZ);
  addMesh(parent, sideGeo, materials.boardFrame, BOARD_X + (BOARD_W / 2 + 0.0225), BOARD_Y, frameZ);
  const barGeo = new THREE.BoxGeometry(BOARD_W + 0.135, 0.045, 0.045);
  addMesh(parent, barGeo, materials.boardFrame, BOARD_X, BOARD_Y + (BOARD_H / 2 + 0.0225), frameZ);
  addMesh(parent, barGeo, materials.boardFrame, BOARD_X, BOARD_Y - (BOARD_H / 2 + 0.0225), frameZ);

  // 浅色横线：共用一根 1 米长的细条，按行宽缩放；只示意「有字」，不落真实文本。
  const lineGeo = new THREE.BoxGeometry(1, 0.012, 0.004);
  const lines: readonly { width: number; offsetY: number; weight: number }[] = [
    { width: 0.58, offsetY: 0.2, weight: 1.5 },
    { width: 0.44, offsetY: 0.07, weight: 1 },
    { width: 0.52, offsetY: -0.06, weight: 1 },
    { width: 0.3, offsetY: -0.19, weight: 1 },
  ];
  for (const line of lines) {
    const mesh = addMesh(
      parent,
      lineGeo,
      materials.chalk,
      BOARD_X - BOARD_W / 2 + 0.07 + line.width / 2,
      BOARD_Y + line.offsetY,
      faceZ + 0.005,
      false,
      false,
    );
    mesh.scale.set(line.width, line.weight, 1);
  }
}

/** 咖啡杯 + 碟子 + 小勺：杯身开口圆柱、杯口一圈、Torus 半环杯把、深色咖啡液面。 */
function addCupSet(parent: THREE.Object3D, materials: CafeMaterials): void {
  // 碟子：上大下小的圆盘，顶面 0.672。
  const saucer = addMesh(
    parent,
    new THREE.CylinderGeometry(0.088, 0.078, 0.012, 24),
    materials.ceramic,
    CUP_X,
    TABLE_TOP + 0.006,
    CUP_Z,
    true,
    true,
  );
  saucer.name = 'cafe-saucer';

  // 杯身：上宽下窄的开口圆柱，坐在碟子上。
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.033, 0.072, 20, 1, true), materials.ceramic);
  body.name = 'cafe-cup-body';
  body.position.set(CUP_X, SAUCER_TOP + 0.036, CUP_Z);
  body.castShadow = true;
  body.receiveShadow = true;
  parent.add(body);

  // 咖啡液面：略低于杯口，深褐色、低粗糙度带一点反光。
  const coffee = new THREE.Mesh(new THREE.CircleGeometry(0.038, 20), materials.coffee);
  coffee.name = 'cafe-cup-coffee';
  coffee.rotation.x = -Math.PI / 2;
  coffee.position.set(CUP_X, SAUCER_TOP + 0.064, CUP_Z);
  parent.add(coffee);

  // 杯口收边：一圈细圆环，收掉开口圆柱的锐边。
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.042, 0.0032, 5, 20), materials.ceramic);
  rim.name = 'cafe-cup-rim';
  rim.rotation.x = Math.PI / 2;
  rim.position.set(CUP_X, SAUCER_TOP + 0.072, CUP_Z);
  rim.castShadow = true;
  parent.add(rim);

  // 杯把：Torus 半环，开口朝杯身；旋转后两端正好埋进杯壁。
  const handle = new THREE.Mesh(
    new THREE.TorusGeometry(0.028, 0.0072, 6, 16, Math.PI * 1.5),
    materials.ceramic,
  );
  handle.name = 'cafe-cup-handle';
  handle.position.set(CUP_X + 0.062, SAUCER_TOP + 0.036, CUP_Z);
  handle.rotation.z = -Math.PI * 0.75;
  handle.castShadow = true;
  parent.add(handle);

  addSpoon(parent, materials);
}

/** 小勺：细长方柄 + 压扁的椭球勺头，平放在碟子右前方的桌面上。 */
function addSpoon(parent: THREE.Object3D, materials: CafeMaterials): void {
  const spoon = new THREE.Group();
  spoon.name = 'cafe-spoon';
  spoon.position.set(CUP_X + 0.155, TABLE_TOP, CUP_Z + 0.02);
  spoon.rotation.y = 0.55;
  parent.add(spoon);

  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.004, 0.009), materials.metal);
  handle.name = 'cafe-spoon-handle';
  handle.position.set(-0.012, 0.002, 0);
  handle.castShadow = true;
  handle.receiveShadow = true;
  spoon.add(handle);

  // 勺头：球压扁成浅碟形，比再做一套曲面便宜。
  const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.013, 8, 6), materials.metal);
  bowl.name = 'cafe-spoon-bowl';
  bowl.scale.set(1, 0.32, 0.62);
  bowl.position.set(0.03, 0.0044, 0);
  bowl.castShadow = true;
  bowl.receiveShadow = true;
  spoon.add(bowl);
}

/** 合上的杂志：薄盒当内页 + 稍浅的封面 + 深色书脊，不写真实文字。 */
function addMagazine(parent: THREE.Object3D, materials: CafeMaterials): void {
  const magazine = new THREE.Group();
  magazine.position.set(MAGAZINE_X, TABLE_TOP, MAGAZINE_Z);
  magazine.rotation.y = -0.26;
  parent.add(magazine);

  const pages = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.012, 0.33), materials.paper);
  pages.position.y = 0.006;
  pages.castShadow = true;
  pages.receiveShadow = true;
  magazine.add(pages);

  const cover = new THREE.Mesh(new THREE.BoxGeometry(0.228, 0.002, 0.306), materials.ceramic);
  cover.position.y = 0.013;
  cover.castShadow = true;
  cover.receiveShadow = true;
  magazine.add(cover);

  // 书脊：封面左侧一道深色窄条，一眼能读出是「合上的册子」。
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.0025, 0.306), materials.spine);
  spine.position.set(-0.106, 0.0135, 0);
  spine.castShadow = true;
  magazine.add(spine);
}

/** 陶盆小绿植：陶盆 + 盆沿 + 土面 + 几个叶团（夹杂两支锥形叶），整组略缩。 */
function addPottedPlant(parent: THREE.Object3D, materials: CafeMaterials): void {
  const plant = new THREE.Group();
  plant.position.set(PLANT_X, TABLE_TOP, PLANT_Z);
  plant.scale.setScalar(0.82);
  parent.add(plant);

  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.082, 0.058, 0.15, 14), materials.terracotta);
  pot.position.y = 0.075;
  pot.castShadow = true;
  pot.receiveShadow = true;
  plant.add(pot);

  const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.03, 14), materials.terracotta);
  rim.position.y = 0.16;
  rim.castShadow = true;
  rim.receiveShadow = true;
  plant.add(rim);

  const soil = new THREE.Mesh(new THREE.CircleGeometry(0.078, 14), materials.soil);
  soil.rotation.x = -Math.PI / 2;
  soil.position.y = 0.168;
  plant.add(soil);

  // 叶团：共用一个单位球，靠位置与缩放错开；黄金角散开，不像一排复制品。
  const blobGeo = new THREE.SphereGeometry(1, 8, 6);
  const blobs: readonly [number, number, number, number][] = [
    // x, y, z, 球半径（米）
    [0, 0.24, 0, 0.115],
    [0.075, 0.285, -0.03, 0.088],
    [-0.065, 0.27, 0.045, 0.082],
    [0.01, 0.33, 0.015, 0.072],
  ];
  blobs.forEach(([x, y, z, size], index) => {
    const blob = new THREE.Mesh(blobGeo, materials.foliage[index % materials.foliage.length]);
    blob.position.set(x, y, z);
    blob.scale.set(size, size * 0.78, size);
    blob.castShadow = true;
    blob.receiveShadow = true;
    plant.add(blob);
  });

  // 两支锥形叶：从叶团缝里探出来，给轮廓一点尖，不像一盆球。
  const leafGeo = new THREE.ConeGeometry(0.032, 0.15, 6);
  const leafA = new THREE.Mesh(leafGeo, materials.foliage[1]);
  leafA.position.set(0.055, 0.4, 0.03);
  leafA.rotation.z = -0.32;
  leafA.rotation.x = 0.12;
  leafA.castShadow = true;
  plant.add(leafA);
  const leafB = new THREE.Mesh(leafGeo, materials.foliage[2]);
  leafB.position.set(-0.045, 0.405, -0.04);
  leafB.rotation.z = 0.28;
  leafB.rotation.x = -0.16;
  leafB.castShadow = true;
  plant.add(leafB);
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

/** 木纹配色：base 底色、light 高光纹理、dark 深色年轮。 */
interface WoodPalette {
  base: string;
  light: string;
  dark: string;
}

/** 浅橡木 / 旧木地板：低饱和横向年轮 + 两道细木节，避免桌面变成一块塑料板。 */
function createWoodTexture(palette: WoodPalette, repeatX: number, repeatY: number): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = palette.base;
    context.fillRect(0, 0, size, size);

    // 横向年轮：每隔几像素一条微微起伏的线，颜色在深浅之间轮换。
    for (let index = 0; index < 44; index += 1) {
      const y = (index / 44) * size + Math.sin(index * 1.7) * 4;
      context.strokeStyle = index % 3 === 0 ? `${palette.dark}38` : `${palette.light}55`;
      context.lineWidth = index % 3 === 0 ? 2 : 1;
      context.beginPath();
      for (let x = 0; x <= size; x += 10) {
        const wave = Math.sin(x * 0.026 + index * 0.9) * 3 + Math.sin(x * 0.009 + index) * 2;
        if (x === 0) context.moveTo(x, y + wave);
        else context.lineTo(x, y + wave);
      }
      context.stroke();
    }

    // 两道木节：几圈同心椭圆，位置错开，像一块真木头。
    for (const [cx, cy] of [
      [size * 0.26, size * 0.64],
      [size * 0.76, size * 0.28],
    ] as const) {
      context.strokeStyle = `${palette.dark}30`;
      context.lineWidth = 1.4;
      for (let ring = 0; ring < 3; ring += 1) {
        context.beginPath();
        context.ellipse(cx, cy, 10 + ring * 6, 4 + ring * 2.6, 0.35, 0, Math.PI * 2);
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
    context.fillStyle = '#d8cdbe';
    context.fillRect(0, 0, size, size);
    for (let index = 0; index < 70; index += 1) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const radius = 12 + Math.random() * 44;
      const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
      const light = Math.random() > 0.5;
      gradient.addColorStop(0, light ? 'rgba(248, 242, 232, 0.14)' : 'rgba(176, 160, 138, 0.09)');
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      context.fillStyle = gradient;
      context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    for (let index = 0; index < 1400; index += 1) {
      context.fillStyle = Math.random() > 0.5 ? 'rgba(255, 251, 242, 0.12)' : 'rgba(138, 122, 102, 0.1)';
      context.fillRect(Math.random() * size, Math.random() * size, 1, 1);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 1.6);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** 窗玻璃：上冷下暖的日间天光渐变 + 一团很淡的亮部，像窗外阴天的漫反射。 */
function createDaylightTexture(): THREE.CanvasTexture {
  const width = 128;
  const height = 128;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#ccdad8');
    gradient.addColorStop(0.55, '#dfe2d6');
    gradient.addColorStop(1, '#ece5d5');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    const glow = context.createRadialGradient(width * 0.32, height * 0.24, 0, width * 0.32, height * 0.24, height * 0.7);
    glow.addColorStop(0, 'rgba(255, 255, 250, 0.4)');
    glow.addColorStop(1, 'rgba(255, 255, 250, 0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 2;
  return texture;
}

/**
 * 桌面窗光条：横向中间亮、两侧透明的柔和白带，纵向两端再淡出。
 * 只作为贴在桌面上方 1 毫米的装饰层用，不产生真实光照与阴影。
 */
function createWindowLightTexture(): THREE.CanvasTexture {
  const width = 128;
  const height = 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context) {
    const across = context.createLinearGradient(0, 0, width, 0);
    across.addColorStop(0, 'rgba(255, 250, 236, 0)');
    across.addColorStop(0.28, 'rgba(255, 250, 236, 0.55)');
    across.addColorStop(0.5, 'rgba(255, 252, 242, 0.9)');
    across.addColorStop(0.72, 'rgba(255, 250, 236, 0.55)');
    across.addColorStop(1, 'rgba(255, 250, 236, 0)');
    context.fillStyle = across;
    context.fillRect(0, 0, width, height);

    // 纵向淡出：用 destination-in 把两端擦成透明，避免光条像一张方形贴纸。
    const along = context.createLinearGradient(0, 0, 0, height);
    along.addColorStop(0, 'rgba(255, 255, 255, 0)');
    along.addColorStop(0.22, 'rgba(255, 255, 255, 1)');
    along.addColorStop(0.78, 'rgba(255, 255, 255, 1)');
    along.addColorStop(1, 'rgba(255, 255, 255, 0)');
    context.globalCompositeOperation = 'destination-in';
    context.fillStyle = along;
    context.fillRect(0, 0, width, height);
    context.globalCompositeOperation = 'source-over';
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 2;
  return texture;
}
