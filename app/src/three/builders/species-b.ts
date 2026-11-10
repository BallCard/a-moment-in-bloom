/**
 * V0.7 §5 素材 B：九种程序化绿叶（叶枝，不是花）。
 *
 * 共同约定：主茎一律从 y≈-0.22 起；茎用固定草绿，叶片用传入主色派生，
 * 这样同一叶型能做配色变体。全部复用 geometryUtils 的叶片/管/合并工具，
 * 单枝控制在 4000 三角面以内，headHeight 落在 0.34–0.44。
 */

import * as THREE from 'three';
import { darken, desaturate, hexToRgb, mixRgb, type RGB } from '../../data/color';
import type { Vec3 } from '../../data/types';
import {
  createPetalGeometry,
  createTube,
  mergeParts,
  placePetal,
  toVec3,
  type PetalOptions,
  type PetalPlacement,
} from './geometryUtils';
import type { BuiltFlower } from './tulip';

/** 主茎草绿；木质枝用更深的 #4f6b3f。 */
const STEM = hexToRgb('#536d43');
const STEM_DARK = hexToRgb('#4f6b3f');

/** 叶片色阶：传入色做主调，混一点草绿压掉荧光，根部再压暗。 */
function leafTones(color: RGB): { base: RGB; tip: RGB } {
  const tip = mixRgb(desaturate(color, 0.06), hexToRgb('#7d9463'), 0.3);
  return { tip, base: darken(tip, 0.16) };
}

/** 把曲线上的点包成摆放参数：位置 + 方位角 + 倾斜角。 */
function at(point: THREE.Vector3, azimuth: number, lean: number, roll = 0): PetalPlacement {
  return { x: point.x, y: point.y, z: point.z, azimuth, lean, roll };
}

/** 同 placePetal，但摆放前允许改网格：用于需要改轮廓/顶点色的叶片。 */
function placeShaped(
  parts: THREE.BufferGeometry[],
  options: PetalOptions,
  placement: PetalPlacement,
  deform?: (geometry: THREE.BufferGeometry) => void,
): void {
  const geometry = createPetalGeometry(options);
  deform?.(geometry);
  const matrix = new THREE.Matrix4().makeTranslation(
    placement.x ?? 0,
    placement.y,
    placement.z ?? 0,
  );
  matrix.multiply(
    new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(placement.lean, placement.azimuth, placement.roll ?? 0, 'YXZ'),
    ),
  );
  if (placement.scale && placement.scale !== 1) {
    matrix.multiply(new THREE.Matrix4().makeScale(placement.scale, placement.scale, placement.scale));
  }
  geometry.applyMatrix4(matrix);
  parts.push(geometry);
}

/**
 * 叶片两侧按行交替内收，做出深锯齿。
 * createPetalGeometry 的顶点按「v 行外层、u 列内层」顺序写入，所以能按行列号定位边缘；
 * 改完轮廓要重算法线，否则锯齿边会发黑。
 */
function serrate(
  geometry: THREE.BufferGeometry,
  segmentsU: number,
  segmentsV: number,
  depth: number,
): void {
  const position = geometry.getAttribute('position');
  for (let j = 1; j < segmentsV; j += 1) {
    const squeeze = j % 2 === 0 ? 1 : 1 - depth;
    for (const i of [0, segmentsU]) {
      const index = j * (segmentsU + 1) + i;
      position.setX(index, position.getX(index) * squeeze);
    }
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
}

/** 沿叶片横向刷明暗条纹（蜘蛛抱蛋叶的纵向纹理）；factors 按列号，缺列按 1 处理。 */
function ribTint(geometry: THREE.BufferGeometry, segmentsU: number, factors: number[]): void {
  const color = geometry.getAttribute('color');
  const row = segmentsU + 1;
  for (let i = 0; i < color.count; i += 1) {
    const u = i % row;
    const k = u < factors.length ? factors[u] : 1;
    color.setXYZ(i, color.getX(i) * k, color.getY(i) * k, color.getZ(i) * k);
  }
  color.needsUpdate = true;
}

/** 鲁斯卡斯：微拱主茎 + 两小侧枝，卵状「假叶」沿茎互生，叶面略硬不卷。 */
function buildRuscus(color: RGB): BuiltFlower {
  const { base, tip } = leafTones(color);
  const parts: THREE.BufferGeometry[] = [];
  const stemPoints: Vec3[] = [
    [0, -0.22, 0],
    [0.007, -0.06, 0.004],
    [0, 0.09, 0],
    [-0.01, 0.24, -0.004],
    [-0.018, 0.35, 0.004],
  ];
  const stem = new THREE.CatmullRomCurve3(stemPoints.map((p) => new THREE.Vector3(...p)));
  parts.push(createTube(stemPoints, 0.0028, STEM_DARK, 18, 5));

  // 假叶：卵形、叶尖微尖、几乎不卷，沿茎按交错角互生。
  const cladode: PetalOptions = {
    length: 0.058,
    width: 0.017,
    bend: 0.014,
    cup: 0.22,
    tipCurl: 0.006,
    tipShape: 0.5,
    segmentsU: 3,
    segmentsV: 6,
    baseColor: base,
    tipColor: tip,
  };
  for (let i = 0; i < 7; i += 1) {
    placePetal(parts, { ...cladode, length: 0.058 - i * 0.002 }, at(
      stem.getPoint(0.22 + i * 0.115),
      i * 2.4,
      1.02 + (i % 3) * 0.12,
      ((i % 3) - 1) * 0.16,
    ));
  }

  // 两小侧枝：从主茎中段斜上分出，枝上再挂三片更小的假叶。
  for (let b = 0; b < 2; b += 1) {
    const start = stem.getPoint(0.42 + b * 0.22);
    const azimuth = 1.5 + b * 2.55;
    const end = start
      .clone()
      .add(new THREE.Vector3(Math.sin(azimuth) * 0.09, 0.08, Math.cos(azimuth) * 0.09));
    const mid = start.clone().lerp(end, 0.5).add(new THREE.Vector3(0, 0.008, 0));
    const branch = new THREE.CatmullRomCurve3([start, mid, end]);
    parts.push(createTube([toVec3(start), toVec3(mid), toVec3(end)], 0.0022, STEM_DARK, 8, 4));
    for (let i = 0; i < 3; i += 1) {
      placePetal(parts, { ...cladode, length: 0.052 }, at(
        branch.getPoint(0.3 + i * 0.3),
        azimuth + (i % 2 === 0 ? 1.1 : -1.1),
        1.0 + i * 0.08,
        (i % 2 === 0 ? 1 : -1) * 0.14,
      ));
    }
  }

  // 顶端两片收尖，让叶材有个柔软的梢。
  for (let i = 0; i < 2; i += 1) {
    placePetal(parts, { ...cladode, length: 0.046 }, at(stem.getPoint(1), 0.4 + i * 2.2, 0.6 + i * 0.35));
  }

  return { geometry: mergeParts(parts), headHeight: 0.39, roughness: 0.84 };
}

/** 沙柳叶：粗壮木质枝 + 六片大椭圆革质叶，每片带一截短柄。 */
function buildSalal(color: RGB): BuiltFlower {
  const { base, tip } = leafTones(color);
  const parts: THREE.BufferGeometry[] = [];
  const stemPoints: Vec3[] = [
    [0, -0.22, 0],
    [0.006, -0.07, 0.004],
    [0, 0.1, 0],
    [0.008, 0.31, 0.002],
  ];
  const stem = new THREE.CatmullRomCurve3(stemPoints.map((p) => new THREE.Vector3(...p)));
  parts.push(createTube(stemPoints, 0.0042, STEM_DARK, 16, 5)); // 木质主枝，比一般茎粗

  // 大叶：椭圆形、厚、边缘微微下扣，短柄把叶面推离枝条。
  const bigLeaf: PetalOptions = {
    length: 0.152,
    width: 0.058,
    bend: 0.02,
    cup: 0.28,
    tipCurl: 0.008,
    tipShape: 0.34,
    segmentsU: 3,
    segmentsV: 7,
    baseColor: base,
    tipColor: tip,
  };
  const spots = [
    { t: 0.34, length: 0.155, az: 0.6, lean: 0.72 },
    { t: 0.5, length: 0.152, az: 3.4, lean: 0.88 },
    { t: 0.64, length: 0.148, az: 4.9, lean: 0.98 },
    { t: 0.78, length: 0.14, az: 1.8, lean: 1.02 },
    { t: 0.9, length: 0.13, az: 5.6, lean: 0.9 },
    { t: 1, length: 0.12, az: 2.7, lean: 0.7 },
  ];
  for (const spot of spots) {
    const root = stem.getPoint(spot.t);
    const outward = new THREE.Vector3(Math.sin(spot.az), 0, Math.cos(spot.az));
    const bladeBase = root.clone().addScaledVector(outward, 0.016);
    parts.push(createTube([toVec3(root), toVec3(bladeBase)], 0.0024, STEM, 4, 3));
    placePetal(parts, { ...bigLeaf, length: spot.length }, at(bladeBase, spot.az, spot.lean));
  }

  return { geometry: mergeParts(parts), headHeight: 0.4, roughness: 0.8 };
}

/** 文竹：纤细主茎 + 四根细枝，叶片缩小成轻盈的羽状针叶。 */
function buildAsparagusFern(color: RGB): BuiltFlower {
  const { base, tip } = leafTones(color);
  const pale = mixRgb(tip, hexToRgb('#a8b98a'), 0.35); // 文竹偏浅黄绿，显得轻
  const parts: THREE.BufferGeometry[] = [];
  const stemPoints: Vec3[] = [
    [0, -0.22, 0],
    [0.008, -0.09, 0.004],
    [0, 0.07, 0],
    [-0.01, 0.22, -0.004],
    [-0.016, 0.35, 0.004],
  ];
  const stem = new THREE.CatmullRomCurve3(stemPoints.map((p) => new THREE.Vector3(...p)));
  parts.push(createTube(stemPoints, 0.0024, STEM, 16, 4));

  // 针叶：极细极短，尖端收得尖，串在茎和枝上像羽毛。
  const needle: PetalOptions = {
    length: 0.034,
    width: 0.0042,
    bend: 0.008,
    cup: 0.1,
    tipCurl: 0.004,
    tipShape: 0.82,
    segmentsU: 2,
    segmentsV: 4,
    baseColor: base,
    tipColor: pale,
  };
  for (let i = 0; i < 12; i += 1) {
    placePetal(parts, needle, at(
      stem.getPoint(0.3 + i * 0.062),
      i * 2.4,
      0.95 + (i % 3) * 0.16,
      ((i % 3) - 1) * 0.2,
    ));
  }

  // 四根细枝，枝上密排短针叶，形成羽状轮廓。
  for (let b = 0; b < 4; b += 1) {
    const start = stem.getPoint(0.5 + b * 0.12);
    const azimuth = 0.8 + b * 1.55;
    const end = start
      .clone()
      .add(new THREE.Vector3(Math.sin(azimuth) * 0.085, 0.1, Math.cos(azimuth) * 0.085));
    const mid = start.clone().lerp(end, 0.5).add(new THREE.Vector3(0, 0.01, 0));
    const branch = new THREE.CatmullRomCurve3([start, mid, end]);
    parts.push(createTube([toVec3(start), toVec3(mid), toVec3(end)], 0.0016, STEM, 8, 3));
    for (let i = 0; i < 7; i += 1) {
      placePetal(parts, { ...needle, length: 0.03 - i * 0.0008 }, at(
        branch.getPoint(0.25 + i * 0.1),
        azimuth + (i % 2 === 0 ? 1.0 : -1.0),
        1.0 + i * 0.04,
        (i % 2 === 0 ? 1 : -1) * 0.16,
      ));
    }
  }

  // 顶端三根针叶，收成一个很轻的梢。
  for (let i = 0; i < 3; i += 1) {
    placePetal(parts, { ...needle, length: 0.032 }, at(stem.getPoint(1), 0.5 + i * 2.1, 0.35 + i * 0.2));
  }

  return { geometry: mergeParts(parts), headHeight: 0.39, roughness: 0.86 };
}

/** 皮革蕨：长椭圆革质叶，边缘按行内收做深锯齿，一茎六片扇形排开。 */
function buildLeatherleaf(color: RGB): BuiltFlower {
  const { base, tip } = leafTones(color);
  const glossy = mixRgb(tip, hexToRgb('#93a877'), 0.25); // 革质叶带一点灰绿
  const parts: THREE.BufferGeometry[] = [];
  const stemPoints: Vec3[] = [
    [0, -0.22, 0],
    [0.006, -0.05, 0.004],
    [0, 0.12, 0],
    [-0.008, 0.32, 0.002],
  ];
  const stem = new THREE.CatmullRomCurve3(stemPoints.map((p) => new THREE.Vector3(...p)));
  parts.push(createTube(stemPoints, 0.0036, STEM, 14, 5));

  // 革质叶：纵深不大但叶面厚，边缘靠 serrate 做出连续锯齿。
  const blade: PetalOptions = {
    length: 0.128,
    width: 0.04,
    bend: 0.018,
    cup: 0.3,
    tipCurl: 0.006,
    tipShape: 0.4,
    segmentsU: 3,
    segmentsV: 12,
    baseColor: base,
    tipColor: glossy,
  };
  const spots = [
    { t: 0.3, length: 0.125, az: 0.5, lean: 0.6 },
    { t: 0.45, length: 0.13, az: 3.4, lean: 0.7 },
    { t: 0.58, length: 0.128, az: 1.9, lean: 0.75 },
    { t: 0.7, length: 0.12, az: 5.1, lean: 0.8 },
    { t: 0.82, length: 0.118, az: 2.6, lean: 0.72 },
    { t: 0.93, length: 0.12, az: 4.4, lean: 0.5 },
  ];
  for (const spot of spots) {
    const root = stem.getPoint(spot.t);
    const outward = new THREE.Vector3(Math.sin(spot.az), 0, Math.cos(spot.az));
    const bladeBase = root.clone().addScaledVector(outward, 0.018);
    parts.push(createTube([toVec3(root), toVec3(bladeBase)], 0.0024, STEM, 4, 3));
    placeShaped(
      parts,
      { ...blade, length: spot.length },
      at(bladeBase, spot.az, spot.lean),
      (geometry) => serrate(geometry, 3, 12, 0.34),
    );
  }

  return { geometry: mergeParts(parts), headHeight: 0.38, roughness: 0.82 };
}

/** 肾蕨：四根向上拱起的羽状复叶，小叶对生且向叶尖渐短。 */
function buildBostonFern(color: RGB): BuiltFlower {
  const { base, tip } = leafTones(color);
  const parts: THREE.BufferGeometry[] = [];
  const stemPoints: Vec3[] = [
    [0, -0.22, 0],
    [0.004, -0.1, 0.002],
    [0, 0.02, 0],
  ];
  const stem = new THREE.CatmullRomCurve3(stemPoints.map((p) => new THREE.Vector3(...p)));
  parts.push(createTube(stemPoints, 0.0028, STEM, 8, 4));

  const pinna: PetalOptions = {
    length: 0.036,
    width: 0.011,
    bend: 0.01,
    cup: 0.15,
    tipCurl: 0.004,
    tipShape: 0.42,
    segmentsU: 2,
    segmentsV: 4,
    baseColor: base,
    tipColor: tip,
  };

  // 复叶：叶轴先向上拱再向外探，小叶沿轴对生排满。
  for (let b = 0; b < 4; b += 1) {
    const azimuth = 0.6 + b * 1.55;
    const start = stem.getPoint(0.8 + b * 0.06);
    const outward = new THREE.Vector3(Math.sin(azimuth), 0, Math.cos(azimuth));
    const mid = start.clone().addScaledVector(outward, 0.05).add(new THREE.Vector3(0, 0.18, 0));
    const end = start.clone().addScaledVector(outward, 0.15).add(new THREE.Vector3(0, 0.36, 0));
    const rachis = new THREE.CatmullRomCurve3([start, mid, end]);
    parts.push(createTube([toVec3(start), toVec3(mid), toVec3(end)], 0.0016, STEM, 12, 4));

    for (let i = 0; i < 11; i += 1) {
      const point = rachis.getPoint(0.16 + i * 0.078);
      const length = 0.036 - i * 0.0022;
      for (const side of [-1, 1]) {
        placePetal(parts, { ...pinna, length }, at(
          point,
          azimuth + side * 1.4,
          1.1 + i * 0.02,
          side * 0.12,
        ));
      }
    }
  }

  return { geometry: mergeParts(parts), headHeight: 0.39, roughness: 0.86 };
}

/** 常春藤：短主茎 + 三条外拱的藤蔓，三裂心形叶沿藤交错垂挂。 */
function buildIvy(color: RGB): BuiltFlower {
  const { base, tip } = leafTones(color);
  const leafTip = mixRgb(tip, hexToRgb('#5d7a4c'), 0.25);
  const parts: THREE.BufferGeometry[] = [];
  const stemPoints: Vec3[] = [
    [0, -0.22, 0],
    [0.004, -0.13, 0],
    [0, -0.02, 0],
    [0, 0.26, 0],
  ];
  const stem = new THREE.CatmullRomCurve3(stemPoints.map((p) => new THREE.Vector3(...p)));
  parts.push(createTube(stemPoints, 0.0028, STEM, 12, 4));

  // 三裂叶：中裂片 + 两片侧裂片共用一个叶基，方位角错开成心形。
  const centerLobe: PetalOptions = {
    length: 0.05,
    width: 0.025,
    bend: 0.012,
    cup: 0.25,
    tipCurl: 0.006,
    tipShape: 0.46,
    segmentsU: 3,
    segmentsV: 6,
    baseColor: base,
    tipColor: leafTip,
  };
  const sideLobe: PetalOptions = {
    length: 0.036,
    width: 0.019,
    bend: 0.01,
    cup: 0.22,
    tipCurl: 0.004,
    tipShape: 0.52,
    segmentsU: 2,
    segmentsV: 5,
    baseColor: darken(base, 0.05),
    tipColor: leafTip,
  };

  // 三条藤：先向外拱起，再微微下垂，顶部的叶子撑起枝高。
  for (let b = 0; b < 3; b += 1) {
    const azimuth = 0.4 + b * 2.1;
    const outward = new THREE.Vector3(Math.sin(azimuth), 0, Math.cos(azimuth));
    const start = stem.getPoint(0.82 + b * 0.09);
    const p1 = start.clone().addScaledVector(outward, 0.06).add(new THREE.Vector3(0, 0.08, 0));
    const p2 = start.clone().addScaledVector(outward, 0.13).add(new THREE.Vector3(0, 0.04, 0));
    const p3 = start.clone().addScaledVector(outward, 0.19).add(new THREE.Vector3(0, -0.04, 0));
    const vine = new THREE.CatmullRomCurve3([start, p1, p2, p3]);
    parts.push(createTube([toVec3(start), toVec3(p1), toVec3(p2), toVec3(p3)], 0.0022, STEM_DARK, 12, 4));

    for (let i = 0; i < 4; i += 1) {
      const root = vine.getPoint(0.3 + i * 0.18);
      const facing = azimuth + (i % 2 === 0 ? 1.05 : -1.05);
      const outwardLeaf = new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing));
      const leafBase = root.clone().addScaledVector(outwardLeaf, 0.008);
      parts.push(createTube([toVec3(root), toVec3(leafBase)], 0.0018, STEM, 3, 3));
      placePetal(parts, centerLobe, at(leafBase, facing, 0.9 + (i % 2) * 0.12));
      placePetal(parts, sideLobe, at(leafBase, facing + 0.85, 1.0 + (i % 2) * 0.1, 0.12));
      placePetal(parts, sideLobe, at(leafBase, facing - 0.85, 1.0 + (i % 2) * 0.1, -0.12));
    }
  }

  // 主茎顶端两片叶，把藤蔓的高度收住。
  for (let i = 0; i < 2; i += 1) {
    const top = stem.getPoint(1);
    const facing = 0.8 + i * 2.0;
    placePetal(parts, centerLobe, at(top, facing, 0.6 + i * 0.12));
    placePetal(parts, sideLobe, at(top, facing + 0.8, 0.7 + i * 0.12, 0.12));
    placePetal(parts, sideLobe, at(top, facing - 0.8, 0.7 + i * 0.12, -0.12));
  }

  return { geometry: mergeParts(parts), headHeight: 0.37, roughness: 0.84 };
}

/** 八角金盘：粗茎上两片掌状大叶，每片八裂片围着同一点向外张开。 */
function buildFatsia(color: RGB): BuiltFlower {
  const { base, tip } = leafTones(color);
  const bladeTip = mixRgb(tip, hexToRgb('#6e8c55'), 0.2);
  const parts: THREE.BufferGeometry[] = [];
  const stemPoints: Vec3[] = [
    [0, -0.22, 0],
    [0.004, -0.1, 0],
    [0, 0.08, 0],
    [0, 0.29, 0],
  ];
  const stem = new THREE.CatmullRomCurve3(stemPoints.map((p) => new THREE.Vector3(...p)));
  parts.push(createTube(stemPoints, 0.0048, STEM, 14, 6)); // 八角金盘茎粗，撑得住大叶

  const lobe: PetalOptions = {
    length: 0.1,
    width: 0.042,
    bend: 0.02,
    cup: 0.18,
    tipCurl: 0.008,
    tipShape: 0.52,
    segmentsU: 3,
    segmentsV: 6,
    baseColor: base,
    tipColor: bladeTip,
  };

  // 两片掌状叶：叶片原点抬高，叶柄朝外，裂片以同一叶基为中心放射。
  const leaves = [
    { t: 0.72, az: 0.5, lean: 0.78 },
    { t: 1, az: 3.5, lean: 0.86 },
  ];
  for (const leaf of leaves) {
    const root = stem.getPoint(leaf.t);
    const outward = new THREE.Vector3(Math.sin(leaf.az), 0, Math.cos(leaf.az));
    const bladeBase = root.clone().addScaledVector(outward, 0.03).add(new THREE.Vector3(0, 0.05, 0));
    parts.push(createTube([toVec3(root), toVec3(bladeBase)], 0.003, STEM, 5, 4));

    for (let k = 0; k < 8; k += 1) {
      const azimuth = leaf.az - 1.85 + k * 0.53;
      const lean = leaf.lean + (Math.abs(k - 3.5) / 3.5) * 0.18; // 外围裂片略下垂，叶面呈浅碟形
      placePetal(parts, { ...lobe, length: 0.1 - Math.abs(k - 3.5) * 0.004 }, at(
        bladeBase,
        azimuth,
        lean,
        (k % 2 === 0 ? 1 : -1) * 0.1,
      ));
    }
  }

  return { geometry: mergeParts(parts), headHeight: 0.4, roughness: 0.78 };
}

/** 蜘蛛抱蛋叶：长带状单叶，中肋微凸、横向顶点色条纹做出纵向纹理。 */
function buildAspidistra(color: RGB): BuiltFlower {
  const { base, tip } = leafTones(color);
  const vein = mixRgb(tip, hexToRgb('#9fb47c'), 0.3);
  const parts: THREE.BufferGeometry[] = [];
  const stemPoints: Vec3[] = [
    [0, -0.22, 0],
    [0.004, -0.12, 0],
    [0, 0, 0],
  ];
  const stem = new THREE.CatmullRomCurve3(stemPoints.map((p) => new THREE.Vector3(...p)));
  parts.push(createTube(stemPoints, 0.0032, STEM, 8, 4));
  const basePoint = stem.getPoint(1);

  // 主叶：极长、几乎直立，叶面折出一道浅沟；顶点色按横向列号压暗边缘，形成纵向纹理。
  const strap: PetalOptions = {
    length: 0.38,
    width: 0.036,
    bend: 0.018,
    cup: 0.5,
    tipCurl: 0.006,
    tipShape: 0.36,
    segmentsU: 4,
    segmentsV: 14,
    baseColor: base,
    tipColor: vein,
  };
  placeShaped(parts, strap, at(basePoint, 0.35, 0.1), (geometry) =>
    ribTint(geometry, 4, [0.8, 0.92, 1, 0.92, 0.8]),
  );

  // 中肋：一根极细的浅色叶条贴在主叶前面，强化纵向的脊线。
  const rib: PetalOptions = {
    length: 0.35,
    width: 0.0034,
    bend: 0.016,
    cup: 0.05,
    tipShape: 0.9,
    segmentsU: 2,
    segmentsV: 8,
    baseColor: vein,
    tipColor: mixRgb(vein, [0.82, 0.88, 0.7], 0.3),
  };
  const front = new THREE.Vector3(
    Math.sin(0.35) * Math.cos(0.1),
    -Math.sin(0.1),
    Math.cos(0.35) * Math.cos(0.1),
  );
  placePetal(parts, rib, at(basePoint.clone().addScaledVector(front, 0.0025), 0.35, 0.09));

  // 两片更短更窄的侧叶，制造一丛叶的层次。
  const sides = [
    { length: 0.26, width: 0.03, az: 2.5, lean: 0.32, y: -0.02, segU: 3, segV: 10, tint: [0.84, 0.94, 1, 0.94] },
    { length: 0.2, width: 0.024, az: 4.5, lean: 0.45, y: -0.05, segU: 3, segV: 8, tint: [0.86, 1, 0.94, 0.86] },
  ];
  for (const side of sides) {
    const spot = new THREE.Vector3(0, side.y, 0);
    placeShaped(
      parts,
      {
        length: side.length,
        width: side.width,
        bend: 0.012,
        cup: 0.42,
        tipCurl: 0.004,
        tipShape: 0.4,
        segmentsU: side.segU,
        segmentsV: side.segV,
        baseColor: base,
        tipColor: mixRgb(vein, tip, 0.4),
      },
      at(spot, side.az, side.lean),
      (geometry) => ribTint(geometry, side.segU, side.tint),
    );
  }

  return { geometry: mergeParts(parts), headHeight: 0.38, roughness: 0.8 };
}

/** 熊草：一丛细长草叶从基部散开、向外弯，高矮与倾角交错。 */
function buildBearGrass(color: RGB): BuiltFlower {
  const { base, tip } = leafTones(color);
  const pale = mixRgb(tip, hexToRgb('#a9b88a'), 0.3);
  const parts: THREE.BufferGeometry[] = [];
  const stemPoints: Vec3[] = [
    [0, -0.22, 0],
    [0.003, -0.14, 0],
    [0, -0.06, 0],
    [0, 0.04, 0],
  ];
  parts.push(createTube(stemPoints, 0.0035, STEM, 8, 4));

  // 草叶：极窄极长的叶条，靠 bend 让叶身向外弯，形成丛生的弧形散开。
  const blade: PetalOptions = {
    length: 0.36,
    width: 0.0052,
    bend: 0.05,
    cup: 0.12,
    tipCurl: 0.01,
    tipShape: 0.86,
    segmentsU: 2,
    segmentsV: 7,
    baseColor: base,
    tipColor: pale,
  };
  for (let i = 0; i < 14; i += 1) {
    const ring = 0.008 * Math.cos(i * 1.7);
    const ringZ = 0.008 * Math.sin(i * 1.7);
    const root = new THREE.Vector3(ring, 0.01 + (i % 3) * 0.012, ringZ);
    const lean = 0.12 + (i % 5) * 0.1; // 从近乎直立到斜出，撑开一丛但不过度摊平
    placePetal(parts, {
      ...blade,
      length: 0.36 - (i % 4) * 0.035,
      bend: 0.035 + (i % 3) * 0.02,
    }, at(root, i * 2.39996, lean, ((i % 3) - 1) * 0.12));
  }

  return { geometry: mergeParts(parts), headHeight: 0.38, roughness: 0.88 };
}

/** 九种绿叶：键名与 data/types.ts 的 ProceduralKey 约定一致。 */
export const SPECIES_B: Record<string, (color: RGB) => BuiltFlower> = {
  ruscus: buildRuscus,
  salal: buildSalal,
  'asparagus-fern': buildAsparagusFern,
  leatherleaf: buildLeatherleaf,
  'boston-fern': buildBostonFern,
  ivy: buildIvy,
  fatsia: buildFatsia,
  aspidistra: buildAspidistra,
  'bear-grass': buildBearGrass,
};
