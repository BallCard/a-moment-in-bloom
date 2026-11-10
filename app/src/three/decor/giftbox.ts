/**
 * 程序化方形花礼盒：开口纸盒 + 斜靠盒盖 + 腰线缎带与蝴蝶结 + 深色内衬 + 小吊牌。
 *
 * 尺度与数据层 `VESSELS.box` 对齐：外廓 0.34×0.34m、高 0.16m、壁厚 0.012m。
 * 组原点在盒底中心、盒底 y=0，由调用方负责把整个组抬到台面（`TABLE_TOP_Y` = 0.66）。
 * 盒口敞开供花束从盒口探出：盒盖靠后侧向后倒，缎带结挂在正面偏下，都不跟花朵抢位置。
 * 全部几何在本文件内程序化生成，不加载外部贴图/模型。
 */

import * as THREE from 'three';

/** 外廓边长（数据层 mouth/base 是 0.17 半宽，即 0.34 外廓）。 */
const OUTER = 0.34;
const HALF = OUTER / 2;
/** 盒身高度，与 `VESSELS.box.height` 一致。 */
const HEIGHT = 0.16;
/** 纸板壁厚 / 底板厚。 */
const WALL = 0.012;
/** 盒口细边条：高度与占宽。 */
const RIM_H = 0.006;
const RIM_W = 0.014;
/** 盒盖：0.36×0.02×0.36 的板，与竖直方向成 17° 向后倒在盒子后侧。 */
const LID_SIZE = 0.36;
const LID_THICK = 0.02;
const LID_TILT_DEG = 17;
/** 盒盖中心：抬高到让下缘离台面约 2mm，再往后放，和盒身/盒口边条留 8mm 间隙。 */
const LID_Y = 0.177;
const LID_Z = -0.241;
/** 缎带：宽 0.035m 的扁带绕盒身腰线一圈，结打在正面偏下。 */
const RIBBON_W = 0.035;
const RIBBON_T = 0.0028;
const BELT_Y = 0.062;
const DEFAULT_RIBBON_COLOR = '#d98da0';
/** 内衬（花泥/内衬纸）：厚 16mm，远低于盒口，给花茎留空间。 */
const LINER_H = 0.016;
/** 吊牌：小薄片 + 细线，挂在正面右侧、缎带结旁边。 */
const TAG_W = 0.046;
const TAG_H = 0.062;
const TAG_T = 0.0018;
const TAG_X = 0.105;

type Size = readonly [number, number, number];
type Position = readonly [number, number, number];

interface GiftBoxMaterials {
  outer: THREE.MeshStandardMaterial;
  inner: THREE.MeshStandardMaterial;
  edge: THREE.MeshStandardMaterial;
  rim: THREE.MeshStandardMaterial;
  liner: THREE.MeshStandardMaterial;
  lidFace: THREE.MeshStandardMaterial;
  lidBack: THREE.MeshStandardMaterial;
  ribbon: THREE.MeshStandardMaterial;
  tag: THREE.MeshStandardMaterial;
  tagHole: THREE.MeshStandardMaterial;
  string: THREE.MeshStandardMaterial;
}

/** 纸板/内衬类共用同一套参数，只有颜色和粗糙度不同。 */
function paperMaterial(color: string, roughness: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
}

function createMaterials(ribbonColor: string): GiftBoxMaterials {
  const ribbon = new THREE.Color(ribbonColor);
  return {
    outer: paperMaterial('#d8c4a8', 0.9),
    inner: paperMaterial('#8a6a4e', 0.95),
    edge: paperMaterial('#c9b092', 0.92),
    rim: paperMaterial('#cbb395', 0.88),
    liner: paperMaterial('#3f4b3a', 0.95),
    // 盒盖竖起来后朝向镜头的是「盒盖内侧」，用更浅的纸色；背面是普通纸板。
    lidFace: paperMaterial('#ece0cc', 0.9),
    lidBack: paperMaterial('#cfb997', 0.9),
    ribbon: new THREE.MeshStandardMaterial({
      color: ribbon,
      roughness: 0.42,
      metalness: 0.04,
      side: THREE.DoubleSide,
    }),
    tag: paperMaterial('#f6edda', 0.85),
    tagHole: paperMaterial('#7a5f45', 1),
    // 细线跟着缎带色走，深一点，像同色棉线。
    string: new THREE.MeshStandardMaterial({
      color: ribbon.clone().multiplyScalar(0.8),
      roughness: 0.65,
      metalness: 0,
    }),
  };
}

/** 统一建盒体：负责投影开关和加进父组，几何全部由调用方自己 dispose。 */
function addBox(
  parent: THREE.Group,
  size: Size,
  position: Position,
  material: THREE.Material | THREE.Material[],
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size[0], size[1], size[2]),
    material,
  );
  mesh.position.set(position[0], position[1], position[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/** 两点之间拉一根细圆柱，当吊牌线用。 */
function addThinLine(
  parent: THREE.Group,
  from: THREE.Vector3,
  to: THREE.Vector3,
  material: THREE.Material,
): THREE.Mesh {
  const direction = new THREE.Vector3().subVectors(to, from);
  const length = Math.max(0.001, direction.length());
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0012, 0.0012, length, 6, 1),
    material,
  );
  mesh.position.copy(from).addScaledVector(direction, 0.5);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.normalize(),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/** 四面墙 + 底板组成真实开口盒：内壁深色、外壁奶油纸板、盒口加细边条、盒底加深色内衬。 */
function buildBody(m: GiftBoxMaterials): THREE.Group {
  const body = new THREE.Group();
  body.name = 'gift-box-body';

  const wallY = HEIGHT / 2;
  const wallZ = HALF - WALL / 2;
  const sideDepth = OUTER - WALL * 2;

  // 底板：顶面用深色内壁色，从盒口看进去是纸盒内部，底面朝台面。
  addBox(body, [OUTER, WALL, OUTER], [0, WALL / 2, 0], [
    m.edge,
    m.edge,
    m.inner,
    m.edge,
    m.edge,
    m.edge,
  ]);

  // 四面墙：正/背面占满外廓宽度，左右墙让出壁厚，转角不重叠也不共面。
  // 材质顺序为 BoxGeometry 的 [+x, -x, +y, -y, +z, -z]，把朝外的面给纸板色、朝内的面给深色。
  addBox(body, [OUTER, HEIGHT, WALL], [0, wallY, wallZ], [
    m.edge,
    m.edge,
    m.edge,
    m.edge,
    m.outer,
    m.inner,
  ]);
  addBox(body, [OUTER, HEIGHT, WALL], [0, wallY, -wallZ], [
    m.edge,
    m.edge,
    m.edge,
    m.edge,
    m.inner,
    m.outer,
  ]);
  addBox(body, [WALL, HEIGHT, sideDepth], [-wallZ, wallY, 0], [
    m.inner,
    m.outer,
    m.edge,
    m.edge,
    m.edge,
    m.edge,
  ]);
  addBox(body, [WALL, HEIGHT, sideDepth], [wallZ, wallY, 0], [
    m.outer,
    m.inner,
    m.edge,
    m.edge,
    m.edge,
    m.edge,
  ]);

  // 盒口细边条：向外挑一点、向内压住壁厚；左右两条略矮 0.6mm，四角顶面不共面、不闪。
  const rimLength = OUTER + 0.012;
  const rimZ = HALF - 0.001;
  const sideRimH = RIM_H - 0.0006;
  addBox(body, [rimLength, RIM_H, RIM_W], [0, HEIGHT + RIM_H / 2, rimZ], m.rim);
  addBox(body, [rimLength, RIM_H, RIM_W], [0, HEIGHT + RIM_H / 2, -rimZ], m.rim);
  addBox(body, [RIM_W, sideRimH, rimLength], [rimZ, HEIGHT + sideRimH / 2, 0], m.rim);
  addBox(body, [RIM_W, sideRimH, rimLength], [-rimZ, HEIGHT + sideRimH / 2, 0], m.rim);

  // 盒内深色内衬：四周留 2mm 缝，比壁厚高 16mm。
  const linerSize = (HALF - WALL) * 2 - 0.004;
  addBox(body, [linerSize, LINER_H, linerSize], [0, WALL + LINER_H / 2, 0], m.liner);

  return body;
}

/** 盒盖：一整块板竖起来、上缘朝后倒，靠住盒子后侧；盖面上压一条同色缎带带。 */
function buildLid(m: GiftBoxMaterials): THREE.Group {
  const lid = new THREE.Group();
  lid.name = 'gift-box-lid';
  lid.position.set(0, LID_Y, LID_Z);
  // 绕 X 轴转到接近竖直（90° - 17°），局部 -z 边朝上朝后，正好倒在盒子后方。
  lid.rotation.x = THREE.MathUtils.degToRad(90 - LID_TILT_DEG);

  // 板：局部 +y 面朝向镜头，是盒盖内侧的浅色纸；-y 面是纸板外侧。
  addBox(lid, [LID_SIZE, LID_THICK, LID_SIZE], [0, 0, 0], [
    m.edge,
    m.edge,
    m.lidFace,
    m.lidBack,
    m.edge,
    m.edge,
  ]);
  // 盖面缎带带：和盒身腰线同宽同色，顺着盖面中线铺一条（两端各留 4mm）。
  addBox(
    lid,
    [RIBBON_W, RIBBON_T, LID_SIZE - 0.008],
    [0, LID_THICK / 2 + RIBBON_T / 2, 0],
    m.ribbon,
  );

  return lid;
}

/** 腰线缎带：正面、背面、两侧各一条扁带围成一圈，正面中下部打蝴蝶结。 */
function buildRibbon(m: GiftBoxMaterials): THREE.Group {
  const ribbon = new THREE.Group();
  ribbon.name = 'gift-box-ribbon';

  const beltLength = OUTER + 0.006;
  // 离纸面 0.6mm，避免缎带与盒身外壁共面闪烁。
  const face = HALF + 0.0006 + RIBBON_T / 2;
  addBox(ribbon, [beltLength, RIBBON_W, RIBBON_T], [0, BELT_Y, face], m.ribbon);
  addBox(ribbon, [beltLength, RIBBON_W, RIBBON_T], [0, BELT_Y, -face], m.ribbon);
  // 侧面两条矮 1.6mm，四角上下沿都不和正面/背面那条共面。
  const sideH = RIBBON_W - 0.0016;
  addBox(ribbon, [RIBBON_T, sideH, beltLength], [face, BELT_Y, 0], m.ribbon);
  addBox(ribbon, [RIBBON_T, sideH, beltLength], [-face, BELT_Y, 0], m.ribbon);

  // 蝴蝶结：两个压扁的椭圆环 + 中心结 + 两条短带尾，落在正面腰线中下部。
  const bowZ = face + RIBBON_T / 2 + 0.001;
  for (const side of [-1, 1]) {
    const loop = new THREE.Mesh(
      new THREE.TorusGeometry(0.021, 0.0055, 8, 18),
      m.ribbon,
    );
    loop.position.set(side * 0.019, BELT_Y + 0.006, bowZ);
    loop.rotation.z = side * 0.5;
    loop.scale.set(1, 0.72, 0.5);
    loop.castShadow = true;
    loop.receiveShadow = true;
    ribbon.add(loop);
  }
  const knot = new THREE.Mesh(new THREE.SphereGeometry(0.0125, 12, 8), m.ribbon);
  knot.position.set(0, BELT_Y, bowZ + 0.002);
  knot.scale.set(1.2, 0.92, 0.62);
  knot.castShadow = true;
  knot.receiveShadow = true;
  ribbon.add(knot);
  // 带尾：短一点，避免垂到台面以下；略向外撇。
  for (const side of [-1, 1]) {
    const tail = addBox(
      ribbon,
      [0.015, 0.055, RIBBON_T],
      [side * 0.013, BELT_Y - 0.031, bowZ + 0.001],
      m.ribbon,
    );
    tail.rotation.z = side * 0.28;
  }

  return ribbon;
}

/** 吊牌：正面右侧半露的小纸片，细线从头部的吊孔吊到盒口细边条上。 */
function buildTag(m: GiftBoxMaterials): THREE.Group {
  const root = new THREE.Group();
  root.name = 'gift-box-tag';

  const tag = new THREE.Group();
  tag.name = 'gift-box-tag-plate';
  // 牌子略离开盒面，像挂在缎带边上的硬纸吊牌。
  tag.position.set(TAG_X, 0.105, HALF + 0.008);
  tag.rotation.set(0, 0.12, 0.06);
  root.add(tag);

  addBox(tag, [TAG_W, TAG_H, TAG_T], [0, 0, 0], m.tag);
  // 吊孔：贴在牌子正面上沿的小圆片。
  const holeY = TAG_H / 2 - 0.008;
  const hole = new THREE.Mesh(new THREE.CircleGeometry(0.0024, 10), m.tagHole);
  hole.name = 'gift-box-tag-hole';
  hole.position.set(0, holeY, TAG_T / 2 + 0.0002);
  tag.add(hole);

  // 吊孔世界坐标跟着牌子的位置/角度走；根组此时还没有父级，局部坐标即世界坐标。
  const holePoint = tag.localToWorld(
    new THREE.Vector3(0, holeY, TAG_T / 2 + 0.0002),
  );
  const rimPoint = new THREE.Vector3(TAG_X, HEIGHT + RIM_H - 0.0015, HALF + 0.0062);
  addThinLine(root, rimPoint, holePoint, m.string);

  return root;
}

/**
 * 建一只方形花礼盒。
 * @param ribbonColor 缎带颜色，缺省为品牌粉 `#d98da0`；用户改色时集成方会整只重建。
 */
export function createGiftBox(ribbonColor: string = DEFAULT_RIBBON_COLOR): THREE.Group {
  const materials = createMaterials(ribbonColor);
  const group = new THREE.Group();
  group.name = 'gift-box';
  group.add(buildBody(materials));
  group.add(buildLid(materials));
  group.add(buildRibbon(materials));
  group.add(buildTag(materials));
  return group;
}

/** 释放本函数建出来的全部 geometry/material（材质按引用去重，避免重复 dispose）。 */
export function disposeGiftBox(group: THREE.Group): void {
  const materials = new Set<THREE.Material>();
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) materials.add(material);
  });
  for (const material of materials) material.dispose();
}
