/**
 * 「节日暖光」摄影布景（拍照阶段使用）。
 *
 * 空间约定与 photo.ts 的 createWindowSet / createGallerySet、scene-florist.ts、scene-garden.ts 一致：
 * - 原点 (0,0,0) 是花束位置，木台面顶面严格落在 TABLE_TOP_Y（0.66 米），花材尾部落在台面上；
 * - 相机在 +z 方向看向原点，正面（z>0）与花束半径 0.6 米内只留台面与台沿桌旗，不放高、暗、复杂的物件；
 * - 返回的 Group 默认 visible = false，由 BouquetScene 在拍照阶段切显隐，本文件不把组加进 scene。
 *
 * 元素：酒红布幔背墙（带低频褶皱）+ 深胡桃木台面 + 一串下垂的暖色小串灯（细灯线 + 14 颗自发光小球
 * + 身后的加法光晕面片）+ 三个程序化小礼物盒 + 两支蜡烛 + 台沿桌旗 + 木地板。
 * 空间与大部分道具是程序化几何与 canvas 纹理（不加载外部贴图）；只有两支蜡烛在 V12 换成
 * Lux3D `candle` 近景道具（`scene-props.ts` 异步挂载），程序化烛台作兜底、GLB 就位后才隐藏。
 * 灯光只有一盏克制的暖色 PointLight（放在组内，组隐藏时整组不参与光照），灯泡只做自发光，不逐个加真实光源。
 * 三角面：程序化部分约 6.0k；两支 GLB 蜡烛各 31,706 面，合计约 69k（近景道具的主要开销在模型上）。
 * 主通道 draw call 约 30 次，远低于 80 的预算。
 *
 * 背景色（BouquetScene.syncPhotoSet 实际接入值，v11-scenes 断言）：#3b2a26。
 * 比布幔中间调略暗，墙与画面底色能分开，同时整体仍偏暖，白 / 粉 / 红花头靠亮度和对比度从暗背景里跳出来。
 */

import * as THREE from 'three';
import { TABLE_TOP_Y } from '../../config';
import { mountSceneProps, type PropPlacement } from './scene-props';

/** 台面顶面高度：必须等于花束底座高度，不能再高。 */
const TABLE_TOP = TABLE_TOP_Y;
/** 台面厚度（米）：台面是一块实心木板，正面与侧面都不漏空。 */
const TABLE_THICK = 0.075;
/** 台面宽 / 深（米）。宽到默认取景框看不到左右边缘，避免露出布景边界。 */
const TABLE_W = 6.0;
const TABLE_D = 2.2;
/** 台面中心的 z：后沿藏进背墙，前沿落在画面下方。 */
const TABLE_Z = -0.09;

/**
 * 背墙（布幔）的 z 与尺寸：与花店一角的 z≈-0.95 同级。
 * 宽度给到 10 米：拍照机位在 x≈1 斜着看向原点，画面左边缘的视线会斜穿到墙的 -4 米附近，
 * 墙窄了会在画面左侧露出墙的边（上一版 7.2 米就露了）。
 */
const WALL_Z = -0.97;
const WALL_W = 10;
const WALL_H = 3.3;

/** 串灯：两端高度、下垂量、所在 z（比布幔靠前一点，读成挂在布幔前面）。 */
const STRAND_LEFT_X = -2.55;
const STRAND_RIGHT_X = 2.55;
const STRAND_END_Y = 1.62;
const STRAND_SAG = 0.27;
const STRAND_Z = -0.85;
const STRAND_BULBS = 14;

/** 光晕面片：包住整串灯的矩形；纹理里按同一套坐标把光斑画在每颗灯泡身后。 */
const GLOW_W = 7.0;
const GLOW_H = 0.9;
const GLOW_CENTER_Y = 1.42;
const GLOW_Z = -0.9;

/** 桌旗：只铺台面前沿（世界 z 从 0.68 起），离花束中心 0.6 米以外，不占主体空间。 */
const RUNNER_W = 2.6;
const RUNNER_D = 0.44;
const RUNNER_Z = 0.9;
/**
 * 桌旗平铺段高度：比台面高 3 毫米（布料的厚度），既避开与台面顶面的 z-fighting，
 * 又让平铺段始终压不出来、不会被台面板「埋掉」；平铺段本身做平，起伏只放在垂落段。
 */
const RUNNER_TOP = TABLE_TOP + 0.003;
/** 台沿所在的世界 z：越过它以后桌旗往下垂。 */
const RUNNER_EDGE_Z = 1.01;

/**
 * 两支蜡烛：台面落点、总高（米）与朝向。
 * 总高同时用于程序化兜底和 Lux3D `candle` 道具（placement.height），
 * 这样 GLB 换上来之后烛身外观变了，但火焰高度仍然对得上。
 *
 * height 固定取 PROP_MODELS.candle.displayHeight（0.12）：`scene-props.ts` 的归一化按
 * displayHeight 做、再把「按 height 覆盖」的缩放乘在模型根节点上，而模型原点不在包围盒底部，
 * 所以只要 height ≠ 0.12，底面就会离开台面（实测 0.125 陷 2.5mm、0.11 浮 5mm）。
 * 两支蜡烛靠朝向区分，不靠尺寸。
 */
const CANDLES = [
  // 放在花束后侧左右两翼（离原点 >0.6m）：默认机位与 1600² 导出都能看到，
  // 不挡正面。原来是 x=0.8/1.0 的近桌沿位置，导出取景会裁掉。
  // height 0.15 比模型规范高度略大，让蜡烛在导出成品里有存在感（loader 会重新压底面）。
  { x: -0.5, z: -0.55, height: 0.15, rotation: 0.35 },
  { x: 0.62, z: -0.32, height: 0.15, rotation: -0.4 },
] as const;

interface FestiveMaterials {
  tableTop: THREE.Material;
  tableBody: THREE.Material;
  floor: THREE.Material;
  drape: THREE.Material;
  runner: THREE.Material;
  cord: THREE.Material;
  bulb: THREE.Material;
  glow: THREE.Material;
  wax: THREE.Material;
  flame: THREE.Material;
  brass: THREE.Material;
  ribbon: THREE.Material;
}

/** 礼物盒 / 蝴蝶结复用的几何：靠 Group / Mesh 的缩放做大小差异，避免每个礼盒都新建几何。 */
interface FestiveParts {
  giftBox: THREE.BoxGeometry;
  bowLoop: THREE.TorusGeometry;
  bowKnot: THREE.SphereGeometry;
}

export function createFestiveSet(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'festive-set';
  group.visible = false;

  // 灯泡位置先算出来：串灯几何与光晕纹理必须用同一套坐标，否则光斑会和灯泡错位。
  const bulbPositions = strandBulbPositions();

  const tableWood = createWoodTexture(2.2, 1.6);
  const bodyWood = createWoodTexture(1.4, 1.0);
  const floorWood = createWoodTexture(6, 5);
  const drapeTexture = createDrapeTexture();
  const glowTexture = createGlowTexture(bulbPositions);

  // ---- 共享材质：同色系小物只建一份，减少材质切换 ----
  const materials: FestiveMaterials = {
    tableTop: new THREE.MeshStandardMaterial({ color: '#6f4c34', map: tableWood, roughness: 0.66, metalness: 0 }),
    tableBody: new THREE.MeshStandardMaterial({ color: '#443026', map: bodyWood, roughness: 0.86, metalness: 0 }),
    floor: new THREE.MeshStandardMaterial({ color: '#3c2a20', map: floorWood, roughness: 0.94, metalness: 0 }),
    drape: new THREE.MeshStandardMaterial({
      map: drapeTexture,
      roughness: 0.96,
      metalness: 0,
      side: THREE.DoubleSide,
    }),
    runner: new THREE.MeshStandardMaterial({ color: '#502a2d', roughness: 0.94, metalness: 0, side: THREE.DoubleSide }),
    cord: new THREE.MeshStandardMaterial({ color: '#2a1d18', roughness: 1, metalness: 0 }),
    bulb: new THREE.MeshBasicMaterial({ color: '#ffdcae', toneMapped: false }),
    // 灯泡周围用加法光晕面片伪造一点点 bloom：比给每颗灯加真实光源便宜得多，也不会把花打爆。
    glow: new THREE.MeshBasicMaterial({
      map: glowTexture,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
    wax: new THREE.MeshStandardMaterial({ color: '#efe0c8', roughness: 0.72, metalness: 0 }),
    flame: new THREE.MeshBasicMaterial({ color: '#ffd39a', toneMapped: false }),
    brass: new THREE.MeshStandardMaterial({ color: '#b08a52', roughness: 0.42, metalness: 0.55 }),
    ribbon: new THREE.MeshStandardMaterial({ color: '#d9b779', roughness: 0.55, metalness: 0.2 }),
  };

  const parts: FestiveParts = {
    giftBox: new THREE.BoxGeometry(1, 1, 1),
    bowLoop: new THREE.TorusGeometry(1, 0.32, 4, 10),
    bowKnot: new THREE.SphereGeometry(1, 6, 4),
  };

  // ---- 木地板：压在场景自带地面（y=0）上方 4 毫米，避免 z-fighting ----
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 10), materials.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.004;
  floor.receiveShadow = true;
  group.add(floor);

  // ---- 酒红布幔背墙：底边落到地面，整面做褶皱，暖光打上去才有层次 ----
  const wall = new THREE.Mesh(createDrapeWallGeometry(WALL_W, WALL_H, 12), materials.drape);
  wall.name = 'festive-drape-wall';
  wall.position.set(0, WALL_H / 2, WALL_Z);
  wall.receiveShadow = true;
  group.add(wall);

  // ---- 台面：顶面必须正好 0.66；柜体比台面内收，形成一圈台沿阴影 ----
  const tableTop = addBox(
    group,
    TABLE_W,
    TABLE_THICK,
    TABLE_D,
    0,
    TABLE_TOP - TABLE_THICK / 2,
    TABLE_Z,
    materials.tableTop,
  );
  tableTop.name = 'festive-table-top';
  const tableBody = addBox(
    group,
    TABLE_W - 0.22,
    TABLE_TOP - TABLE_THICK,
    TABLE_D - 0.18,
    0,
    (TABLE_TOP - TABLE_THICK) / 2,
    TABLE_Z,
    materials.tableBody,
  );
  tableBody.name = 'festive-table-body';

  // ---- 台沿桌旗：台面上平铺一段，越过台沿后垂下去，给画面下缘加一层暗红层次 ----
  const runner = new THREE.Mesh(createRunnerGeometry(RUNNER_W, RUNNER_D, RUNNER_EDGE_Z - RUNNER_Z), materials.runner);
  runner.name = 'festive-runner';
  runner.position.set(0, RUNNER_TOP, RUNNER_Z);
  runner.receiveShadow = true;
  group.add(runner);

  // ---- 串灯：一根下垂的细灯线 + 若干自发光小球（InstancedMesh，只占一次 draw call） ----
  addStringLights(group, materials, bulbPositions);

  // ---- 礼物盒：左后两个、右后一个；尺寸 0.10–0.15 米，全部在花束半径 0.6 米之外 ----
  const winePaper = new THREE.MeshStandardMaterial({
    map: createGiftTexture('#63232a', '#d9b46e'),
    roughness: 0.55,
    metalness: 0,
  });
  const creamPaper = new THREE.MeshStandardMaterial({
    map: createGiftTexture('#e6dcc6', '#7d2f36'),
    roughness: 0.6,
    metalness: 0,
  });
  const goldPaper = new THREE.MeshStandardMaterial({
    map: createGiftTexture('#ac8a4c', '#efe2c4'),
    roughness: 0.48,
    metalness: 0.08,
  });

  addGiftBox(group, materials, parts, winePaper, -0.72, -0.3, 0.15, 0.22);
  addGiftBox(group, materials, parts, creamPaper, -0.96, -0.02, 0.1, -0.4);
  // 右后方的小金盒：默认拍照机位里正好落在花束右侧、蜡烛后面，补住右上角的空白。
  addGiftBox(group, materials, parts, goldPaper, 0.66, -0.78, 0.1, 0.55);

  // ---- 两支蜡烛：烛身用 Lux3D `candle` 近景道具（V12），程序化烛台继续兜底 ----
  for (const [index, candle] of CANDLES.entries()) {
    addCandle(group, materials, index, candle.x, candle.z, candle.height);
  }

  // ---- 组内唯一光源：暖色点光，压在花束后上方 ----
  // 给布幔一片暖光和花束背后的轮廓光，强度克制（主光仍是场景里的 key light），
  // 灯泡只做自发光，不给每颗灯加真实光源，避免拍照阶段整体过曝、花头细节被吃掉。
  // 位置压在花束后上方而不是贴着墙：贴墙会把逆平方衰减全砸在背景上，整个背景亮成一片橘色。
  const lamp = new THREE.PointLight(0xffb277, 0.85, 5.2, 2);
  lamp.name = 'festive-warm-lamp';
  lamp.position.set(0, 1.7, -0.12);
  group.add(lamp);

  // ---- V12：把 Lux3D 蜡烛挂到台面落点，模型就位后再隐藏对应的程序化烛台 ----
  // 火焰（festive-candle-flame-*）故意不放进 hide 列表：GLB 的蜡烛只有烛芯、没有火焰，
  // 保留程序化自发光火焰才「有烛有火」；加载失败时程序化烛台照常显示，火焰高度用的是同一套公式。
  const placements: PropPlacement[] = CANDLES.map((candle, index) => ({
    id: 'candle',
    position: [candle.x, TABLE_TOP, candle.z],
    rotation: [0, candle.rotation, 0],
    height: candle.height,
    hide: [`festive-candle-${index}`],
  }));
  mountSceneProps(group, placements);

  return group;
}

/** 串灯下垂曲线：中点最低、两端固定，y 随 x 抛物变化，读起来是一根自然下垂的灯线。 */
function strandY(x: number): number {
  const span = STRAND_RIGHT_X - STRAND_LEFT_X;
  const t = (x - STRAND_LEFT_X) / span;
  const u = t * 2 - 1;
  return STRAND_END_Y - STRAND_SAG * (1 - u * u);
}

/** 每颗灯泡的位置：等距 + 一点点确定性抖动，避免一眼看出机械排列。 */
function strandBulbPositions(): THREE.Vector3[] {
  const span = STRAND_RIGHT_X - STRAND_LEFT_X;
  const positions: THREE.Vector3[] = [];
  for (let index = 0; index < STRAND_BULBS; index += 1) {
    const t = (index + 0.5) / STRAND_BULBS;
    // 抖动只跟序号有关（不用随机数），保证每次进拍照阶段布景完全一致。
    const x = STRAND_LEFT_X + span * t + Math.sin(index * 2.399) * 0.018;
    positions.push(new THREE.Vector3(x, strandY(x) - 0.014, STRAND_Z));
  }
  return positions;
}

/** 串灯：灯线（细圆管）+ 灯泡（InstancedMesh）+ 身后的加法光晕面片 + 两端的小挂钩。 */
function addStringLights(
  parent: THREE.Object3D,
  materials: FestiveMaterials,
  bulbPositions: THREE.Vector3[],
): void {
  const samples = 48;
  const curve = new THREE.CatmullRomCurve3(
    Array.from({ length: samples }, (_, index) => {
      const x = STRAND_LEFT_X + (STRAND_RIGHT_X - STRAND_LEFT_X) * (index / (samples - 1));
      return new THREE.Vector3(x, strandY(x), STRAND_Z);
    }),
  );
  const cord = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, 0.0026, 4, false), materials.cord);
  cord.castShadow = false;
  cord.receiveShadow = false;
  parent.add(cord);

  // 灯泡共用一份球几何 + 一份自发光材质；用 InstancedMesh 把 14 颗球压成一次 draw call。
  const bulbs = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.014, 8, 6),
    materials.bulb,
    bulbPositions.length,
  );
  bulbs.name = 'festive-string-bulbs';
  const dummy = new THREE.Object3D();
  bulbPositions.forEach((position, index) => {
    dummy.position.copy(position);
    // 大小略微错开，像手工串上去的灯泡。
    dummy.scale.setScalar(0.86 + ((index * 7) % 5) * 0.07);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    bulbs.setMatrixAt(index, dummy.matrix);
  });
  bulbs.instanceMatrix.needsUpdate = true;
  bulbs.castShadow = false;
  bulbs.receiveShadow = false;
  parent.add(bulbs);

  // 光晕面片：平贴在布幔前，加法混合，只提亮灯泡周围，不挡其他物体。
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(GLOW_W, GLOW_H), materials.glow);
  glow.name = 'festive-string-glow';
  glow.position.set(0, GLOW_CENTER_Y, GLOW_Z);
  glow.castShadow = false;
  glow.receiveShadow = false;
  parent.add(glow);

  // 两端各一个小挂钩，灯线不至于凭空悬在布幔前面。
  const hookGeo = new THREE.CylinderGeometry(0.0045, 0.0045, 0.14, 6);
  for (const x of [STRAND_LEFT_X, STRAND_RIGHT_X]) {
    const hook = addMesh(parent, hookGeo, materials.brass, x, STRAND_END_Y + 0.012, (STRAND_Z + WALL_Z) / 2, false, false);
    hook.rotation.x = Math.PI / 2;
  }
}

/** 礼物盒：盒体（缎带十字烘焙在纹理里）+ 两个压扁的蝴蝶结环 + 一个结。 */
function addGiftBox(
  parent: THREE.Object3D,
  materials: FestiveMaterials,
  parts: FestiveParts,
  paper: THREE.Material,
  x: number,
  z: number,
  size: number,
  rotationY: number,
): void {
  const gift = new THREE.Group();
  gift.name = 'festive-gift';
  gift.position.set(x, TABLE_TOP, z);
  gift.rotation.y = rotationY;
  parent.add(gift);

  const body = new THREE.Mesh(parts.giftBox, paper);
  body.name = 'festive-gift-body';
  body.scale.setScalar(size);
  body.position.y = size / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  gift.add(body);

  // 蝴蝶结：两个竖立的压扁环 + 中间一个结，尺寸随礼盒缩放，全部共用同一份几何。
  const loopScale = size * 0.32;
  for (const side of [-1, 1] as const) {
    const loop = new THREE.Mesh(parts.bowLoop, materials.ribbon);
    loop.scale.set(loopScale, loopScale * 0.62, loopScale * 0.55);
    loop.position.set(side * size * 0.11, size + loopScale * 0.52, 0);
    loop.rotation.set(0, 0, side * 0.55);
    loop.castShadow = true;
    gift.add(loop);
  }
  const knot = new THREE.Mesh(parts.bowKnot, materials.ribbon);
  knot.scale.setScalar(size * 0.11);
  knot.position.set(0, size + size * 0.03, 0);
  knot.castShadow = true;
  gift.add(knot);
}

/**
 * 蜡烛 = 程序化烛台（兜底）+ 程序化火焰（正式与兜底共用）。
 *
 * - `festive-candle-<index>` 组里放黄铜托盘和蜡柱：GLB 蜡烛就位后整组隐藏（hide 列表按这个 name）；
 * - 火焰挂在组外、单独一个网格：Lux3D 蜡烛只生成了烛芯没有火焰，留着它才有「节日灯火」；
 *   位置按总高推算（GLB 归一化后总高 = height，烛芯顶≈模型顶），两种状态下火焰都在同一处。
 */
function addCandle(
  parent: THREE.Object3D,
  materials: FestiveMaterials,
  index: number,
  x: number,
  z: number,
  height: number,
): void {
  const body = new THREE.Group();
  body.name = `festive-candle-${index}`;
  body.position.set(x, TABLE_TOP, z);
  parent.add(body);

  // 黄铜小托盘：脚径按 GLB 实测比例（0.12m 高时约 0.077m）。
  const dishRadius = height * 0.32;
  const dish = addMesh(
    body,
    new THREE.CylinderGeometry(dishRadius, dishRadius * 1.04, height * 0.075, 18),
    materials.brass,
    0,
    height * 0.0375,
    0,
  );
  dish.receiveShadow = true;

  // 蜡柱：GLB 的蜡面约在总高的 93%，上面那段留作烛芯与火焰。
  const waxBottom = height * 0.075;
  const waxHeight = height * 0.86;
  const wax = addMesh(
    body,
    new THREE.CylinderGeometry(height * 0.18, height * 0.19, waxHeight, 18),
    materials.wax,
    0,
    waxBottom + waxHeight / 2,
    0,
  );
  wax.name = `festive-candle-wax-${index}`;
  wax.receiveShadow = true;

  // 火焰：压扁的小球 + Basic 自发光材质。亮度够但不产生真实光照，避免蜡烛把花打偏色。
  const flameHalfWidth = height * 0.045;
  const flameHalfHeight = height * 0.09;
  const flame = addMesh(
    parent,
    new THREE.SphereGeometry(1, 6, 5),
    materials.flame,
    x,
    TABLE_TOP + height * 0.97 + flameHalfHeight,
    z,
    false,
    false,
  );
  flame.name = `festive-candle-flame-${index}`;
  flame.scale.set(flameHalfWidth, flameHalfHeight, flameHalfWidth);
}

// ---------- 几何小工具 ----------

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

/**
 * 布幔背墙：一整片平面 + 低频褶皱（沿法线方向推 z），顶部略收、底部略散，
 * 靠主光在褶皱上的明暗变化把墙面从「一块纯色板」变成「挂起来的布」。
 */
function createDrapeWallGeometry(width: number, height: number, folds: number): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(width, height, 128, 10);
  const position = geometry.getAttribute('position');
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const y = position.getY(index);
    const u = x / width;
    // 一宽一窄两组褶：宽的做布幔起伏，窄的做织物细节，振幅都很小，不让墙面抢花。
    const fold = Math.sin(u * Math.PI * 2 * folds) * 0.042 + Math.sin(u * Math.PI * 2 * folds * 2.3 + 1.1) * 0.012;
    // 挂起来的布顶部收、底部散。
    const taper = 0.7 + 0.3 * clamp01(y / height + 0.5);
    position.setZ(index, fold * taper);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * 桌旗：先平铺在台面前沿，越过台沿后向下弯折垂落。
 * 局部坐标里 y=0 是平铺高度、+z 朝相机；返回的几何直接交给 RUNNER_Z / RUNNER_TOP 摆放。
 */
function createRunnerGeometry(width: number, depth: number, edgeOffset: number): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(width, depth, 40, 10);
  // 转成水平面（法线朝上）后局部 z 就是台面前后方向。
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.getAttribute('position');
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const z = position.getZ(index);
    if (z <= edgeOffset) {
      // 平铺段必须严格做平：哪怕 1 毫米的起伏也会让它一部分陷进台面板里，
      // 台面上就会露出断断续续的布片（上一版踩过这个坑）。
      position.setY(index, 0);
    } else {
      // 垂落段：越过台沿后往下走，同时略微往里收，不向前突出太多；这里才做布褶起伏。
      const drop = z - edgeOffset;
      position.setY(index, -drop * 1.05 + Math.sin(x * 6.5) * 0.0022);
      position.setZ(index, edgeOffset + drop * 0.28);
    }
  }
  geometry.computeVertexNormals();
  return geometry;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// ---------- 程序化纹理 ----------

/** 深胡桃木纹：横向年轮线 + 两个木节，材质颜色负责压暗，纹理只提供木纹层次。 */
function createWoodTexture(repeatX: number, repeatY: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#e8d4b8';
    context.fillRect(0, 0, size, size);
    for (let index = 0; index < 26; index += 1) {
      const y = (index / 26) * size + Math.sin(index * 1.7) * 3;
      context.strokeStyle = index % 3 === 0 ? 'rgba(150, 112, 76, 0.22)' : 'rgba(172, 136, 100, 0.13)';
      context.lineWidth = index % 3 === 0 ? 1.6 : 0.9;
      context.beginPath();
      for (let x = 0; x <= size; x += 8) {
        const wave = Math.sin(x * 0.03 + index * 0.9) * 2.2 + Math.sin(x * 0.011 + index) * 1.6;
        if (x === 0) context.moveTo(x, y + wave);
        else context.lineTo(x, y + wave);
      }
      context.stroke();
    }
    for (const [cx, cy] of [
      [size * 0.3, size * 0.64],
      [size * 0.72, size * 0.31],
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

/**
 * 酒红布幔：上暗下亮的渐变 + 花束正后方一团很淡的暖色光晕 + 织物竖纹 + 左右压暗。
 * 中间那团暖光很关键：暗背景里白 / 粉花头本来就亮，但茎叶和包装会被吞掉，
 * 把主体身后提亮一点，轮廓就出来了，同时不让背景亮到抢注意力。
 */
function createDrapeTexture(): THREE.CanvasTexture {
  const width = 1024;
  const height = 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context) {
    // 底色：酒红 / 深棕红，顶部最暗，往中部稍微提一点，底部压深接台面。
    const base = context.createLinearGradient(0, 0, 0, height);
    base.addColorStop(0, '#1b100e');
    base.addColorStop(0.3, '#31201c');
    base.addColorStop(0.62, '#3c231e');
    base.addColorStop(1, '#1e1210');
    context.fillStyle = base;
    context.fillRect(0, 0, width, height);

    // 花束正后方的暖色光晕（画布 v 约 0.37，对应墙高 1.2 米左右，正好是花头高度）。
    // 只提一点点：光晕太强会让整面墙变成橘色，花反而失去明暗对比。
    const wash = context.createRadialGradient(width * 0.5, height * 0.63, 0, width * 0.5, height * 0.63, width * 0.26);
    wash.addColorStop(0, 'rgba(198, 130, 84, 0.24)');
    wash.addColorStop(0.55, 'rgba(178, 110, 72, 0.1)');
    wash.addColorStop(1, 'rgba(0, 0, 0, 0)');
    context.fillStyle = wash;
    context.fillRect(0, 0, width, height);

    // 织物竖纹：密集的细线，近看不是一块纯色。
    for (let index = 0; index < 260; index += 1) {
      const x = Math.random() * width;
      context.strokeStyle = Math.random() > 0.5 ? 'rgba(255, 214, 178, 0.05)' : 'rgba(0, 0, 0, 0.12)';
      context.lineWidth = 1 + Math.random() * 2;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x + (Math.random() - 0.5) * 18, height);
      context.stroke();
    }

    // 左右压暗，把注意力收到画面中间。
    const edge = context.createLinearGradient(0, 0, width, 0);
    edge.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
    edge.addColorStop(0.22, 'rgba(0, 0, 0, 0)');
    edge.addColorStop(0.78, 'rgba(0, 0, 0, 0)');
    edge.addColorStop(1, 'rgba(0, 0, 0, 0.62)');
    context.fillStyle = edge;
    context.fillRect(0, 0, width, height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** 串灯光晕：在每颗灯泡的位置画一团暖色径向光斑，加法混合后就是廉价 bloom。 */
function createGlowTexture(bulbs: THREE.Vector3[]): THREE.CanvasTexture {
  const width = 1024;
  const height = 192;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context) {
    context.clearRect(0, 0, width, height);
    const bottom = GLOW_CENTER_Y - GLOW_H / 2;
    for (const bulb of bulbs) {
      const u = (bulb.x + GLOW_W / 2) / GLOW_W;
      const v = (bulb.y - bottom) / GLOW_H;
      // CanvasTexture 默认 flipY：画布 y 向下，纹理 v 向上。
      const cx = u * width;
      const cy = (1 - v) * height;
      const radius = height * 0.42;
      const halo = context.createRadialGradient(cx, cy, 0, cx, cy, radius);
      halo.addColorStop(0, 'rgba(255, 226, 176, 0.62)');
      halo.addColorStop(0.35, 'rgba(255, 178, 108, 0.24)');
      halo.addColorStop(1, 'rgba(255, 150, 80, 0)');
      context.fillStyle = halo;
      context.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 2;
  return texture;
}

/**
 * 礼物盒纸面：底色 + 细微斑纹 + 一条横向一条纵向的缎带。
 * 立方体六个面的 UV 都是 0..1，所以十字缎带在每个面上都会出现，读起来就是绕了两圈的包装带。
 */
function createGiftTexture(paperColor: string, ribbonColor: string): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = paperColor;
    context.fillRect(0, 0, size, size);
    // 纸面斑纹：避免礼盒变成一块塑料色块。
    for (let index = 0; index < 380; index += 1) {
      context.fillStyle = Math.random() > 0.5 ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.07)';
      context.fillRect(Math.random() * size, Math.random() * size, 1.4, 1.4);
    }
    const band = size * 0.16;
    context.fillStyle = ribbonColor;
    context.fillRect(size * 0.5 - band / 2, 0, band, size);
    context.fillRect(0, size * 0.5 - band / 2, size, band);
    // 缎带的高光与暗边，让十字有一点厚度。
    context.fillStyle = 'rgba(255, 255, 255, 0.24)';
    context.fillRect(size * 0.5 - band * 0.3, 0, band * 0.2, size);
    context.fillRect(0, size * 0.5 - band * 0.3, size, band * 0.2);
    context.fillStyle = 'rgba(0, 0, 0, 0.2)';
    context.fillRect(size * 0.5 + band * 0.34, 0, band * 0.14, size);
    context.fillRect(0, size * 0.5 + band * 0.34, size, band * 0.14);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
