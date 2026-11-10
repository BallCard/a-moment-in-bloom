/**
 * 程序化藤编花篮：鼓腹篮身 + 横向编织圈 + 纵向经条 + 口沿 + 两侧短提手 + 脚圈。
 *
 * 尺寸对齐数据层 VESSELS.basket：底半径 0.20m、口沿半径 0.20m、篮体高 0.15m；
 * 篮身外壁略外鼓，叠上编织圈后外轮廓最宽约 0.215m。
 * 组原点在篮底中心、篮底 y=0；台面摆放由调用方负责（config.ts 的 TABLE_TOP_Y），
 * 本文件不写 position.y，避免与场景的台面高度重复叠加。
 *
 * 全部几何用 Three.js 基础体或自建 BufferGeometry，不加载外部贴图；
 * 编织件按子件合并成一份几何，一个篮子约 6 次 draw call、约 1.2 万三角面。
 */

import * as THREE from 'three';
import { applyColor, mergeParts } from '../builders/geometryUtils';
import type { RGB } from '../../data/color';

// ---------- 颜色 ----------

/** 篮身主色：藤条的暖棕，roughness ≥0.9 让它不反光。 */
const BODY_COLOR = '#b08a5e';
/** 横向编织圈深浅交替，远看才有经纬感。 */
const WEAVE_LIGHT_COLOR: RGB = linearRgb('#c19a6b');
const WEAVE_DARK_COLOR: RGB = linearRgb('#a97f52');
/** 纵向经条偏深，和编织圈拉开层次。 */
const WARP_COLOR: RGB = linearRgb('#8f6b45');
const RIM_COLOR: RGB = linearRgb('#a1794a');
const HANDLE_COLOR: RGB = linearRgb('#8f6b45');
const FOOT_COLOR: RGB = linearRgb('#8a6238');

// ---------- 尺寸（米） ----------

/** 篮底名义半径，与 VESSELS.basket.base 一致。 */
const BASE_RADIUS = 0.2;
/** 口沿半径，与 VESSELS.basket.mouth 一致。 */
const MOUTH_RADIUS = 0.2;
/** 外壁最宽处；编织圈在最宽处再凸出约 6mm，外轮廓合计约 0.215。 */
const BELLY_RADIUS = 0.209;
/** 篮体总高（口沿环顶面到脚圈底面），与 VESSELS.basket.height 一致。 */
const HEIGHT = 0.15;
/** 口沿环管半径：口沿环中心放在 HEIGHT - RIM_TUBE，顶面正好落在 0.15 上。 */
const RIM_TUBE = 0.0125;
/** 口沿处的高度（外壁上沿 / 口沿环中心）。 */
const MOUTH_Y = HEIGHT - RIM_TUBE;
/** 口沿内沿半径：与外壁顶面、口沿环内壁正好接齐。 */
const RIM_INNER_RADIUS = MOUTH_RADIUS - RIM_TUBE;
/** 篮底外表面高度：脚圈再往下垫 4mm，篮底 y=0 由脚圈底面决定。 */
const BOTTOM_Y = 0.004;
/** 内胆底面高度，篮底是一层有厚度的高编织底。 */
const INNER_FLOOR_Y = 0.018;

/** 脚圈：一圈较粗的环形底托，避免篮身悬空。 */
const FOOT_RADIUS = 0.15;
const FOOT_TUBE = 0.006;

/** 横向编织圈。 */
const WEAVE_RINGS = 10;
const WEAVE_TUBE = 0.0045;
const WEAVE_START_Y = 0.016;
const WEAVE_END_Y = 0.119;
/** 编织圈比外壁再凸出的量（半径方向）。 */
const WEAVE_PROUD = 0.0012;

/** 纵向经条：30 根均布在圆周上，贴着外壁轮廓。 */
const WARP_COUNT = 30;
const WARP_BOTTOM_Y = 0.012;
/** 上端钻进覆盖在口沿环下面，看不出断头。 */
const WARP_TOP_Y = 0.134;
const WARP_STATIONS = 6;
const WARP_RADIAL_HALF = 0.0034;
const WARP_TANGENT_HALF = 0.0034;
/** 经条比编织圈再高一点：竖条要连续可见，编织圈在交叉处被它压住。 */
const WARP_PROUD = 0.0034;

/** 两侧短提手：竖起来的半环，不会像高拱提手那样压住花束。 */
const HANDLE_RADIUS = 0.03;
const HANDLE_TUBE = 0.009;
const HANDLE_X = 0.198;
const HANDLE_SEGMENTS = 20;

/**
 * 外壁轮廓控制点 [半径, 高度]，从底缘扫到口沿。
 * 编织圈和经条都按这条轮廓分段线性插值，保证贴着壁面，不会浮在鼓腹外面。
 */
const OUTER_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [0.194, 0.01],
  [BASE_RADIUS, 0.03],
  [0.206, 0.055],
  [BELLY_RADIUS, 0.082],
  [0.207, 0.108],
  [0.203, 0.126],
  [MOUTH_RADIUS, MOUTH_Y],
];

/** 内壁轮廓：自上而下回到内胆底心，与口沿环内壁接齐。 */
const INNER_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [RIM_INNER_RADIUS, MOUTH_Y],
  [0.19, 0.128],
  [0.196, 0.108],
  [0.199, 0.082],
  [0.195, 0.055],
  [0.186, 0.032],
  [0.166, 0.02],
  [0.075, INNER_FLOOR_Y],
];

/** 经条截面的四角（径向偏移, 切向偏移），从外侧看是逆时针，法线朝外。 */
const WARP_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [WARP_RADIAL_HALF, WARP_TANGENT_HALF],
  [WARP_RADIAL_HALF, -WARP_TANGENT_HALF],
  [-WARP_RADIAL_HALF, -WARP_TANGENT_HALF],
  [-WARP_RADIAL_HALF, WARP_TANGENT_HALF],
];

/**
 * 建一个藤编花篮。返回的 group 原点在篮底中心，篮底贴 y=0，
 * 调用方把它放到台面上即可（group.position.y = TABLE_TOP_Y）。
 */
export function createBasket(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'flower-basket';

  // 篮身要双面：口沿往内翻的壳体会被俯视看到内侧。藤编都是哑光，roughness 压高。
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: BODY_COLOR,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  // 编织件共用一份顶点色材质：10 圈深浅交替、经条更深的颜色都写进顶点色。
  const wickerMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
    side: THREE.DoubleSide,
  });

  group.add(
    shadowMesh('basket-body', new THREE.LatheGeometry(shellPoints(), 64), bodyMaterial),
    shadowMesh('basket-weave', mergeParts(weaveParts()), wickerMaterial),
    shadowMesh('basket-warps', createWarpGeometry(), wickerMaterial),
    // 12 段的截面在正上方有顶点，口沿顶面正好落在 HEIGHT 上。
    shadowMesh(
      'basket-rim',
      horizontalTorus(MOUTH_RADIUS, RIM_TUBE, 12, 64, MOUTH_Y, RIM_COLOR),
      wickerMaterial,
    ),
    shadowMesh('basket-handles', mergeParts(handleParts()), wickerMaterial),
    // 8 段的截面在正下方有顶点，脚圈底面正好落在 y=0。
    shadowMesh(
      'basket-foot',
      horizontalTorus(FOOT_RADIUS, FOOT_TUBE, 8, 44, FOOT_TUBE, FOOT_COLOR),
      wickerMaterial,
    ),
  );

  return group;
}

/** 释放 createBasket 自建的几何与材质（每个篮子各自一套，不与他人共享）。 */
export function disposeBasket(group: THREE.Group): void {
  const materials = new Set<THREE.Material>();
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
    }
  });
  for (const material of materials) material.dispose();
}

/** 篮壳回转截面：底部外表面 → 外壁 → 口沿 → 内壁 → 内胆底心，一次 Lathe 成壳。 */
function shellPoints(): THREE.Vector2[] {
  return [
    new THREE.Vector2(0, BOTTOM_Y),
    new THREE.Vector2(0.09, BOTTOM_Y),
    ...OUTER_PROFILE.map(([radius, y]) => new THREE.Vector2(radius, y)),
    ...INNER_PROFILE.map(([radius, y]) => new THREE.Vector2(radius, y)),
    new THREE.Vector2(0, INNER_FLOOR_Y),
  ];
}

/** 外壁在某个高度上的半径（米），编织圈与经条按它贴壁。 */
function wallRadiusAt(y: number): number {
  const profile = OUTER_PROFILE;
  let index = 0;
  while (index < profile.length - 2 && y > profile[index + 1][1]) index += 1;
  const [r0, y0] = profile[index];
  const [r1, y1] = profile[index + 1];
  const t = THREE.MathUtils.clamp((y - y0) / (y1 - y0), 0, 1);
  return r0 + (r1 - r0) * t;
}

/** 横向编织圈：Torus 默认躺在 XY 平面，转成水平后按外壁半径逐圈收放。 */
function weaveParts(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  for (let index = 0; index < WEAVE_RINGS; index += 1) {
    const y = WEAVE_START_Y + ((WEAVE_END_Y - WEAVE_START_Y) * index) / (WEAVE_RINGS - 1);
    const color = index % 2 === 0 ? WEAVE_DARK_COLOR : WEAVE_LIGHT_COLOR;
    parts.push(horizontalTorus(wallRadiusAt(y) + WEAVE_PROUD, WEAVE_TUBE, 6, 48, y, color));
  }
  return parts;
}

/**
 * 纵向经条：沿外壁轮廓逐站扫掠的细长条，每根是一段带 4 个角的棱柱，
 * 分段跟随鼓腹，比直筒更贴壁；一根约 52 个三角面。
 */
function createWarpGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];

  for (let index = 0; index < WARP_COUNT; index += 1) {
    const azimuth = (index / WARP_COUNT) * Math.PI * 2 + 0.11;
    // 径向单位向量与它的水平切向，截面四角沿这两个方向展开。
    const outwardX = Math.cos(azimuth);
    const outwardZ = Math.sin(azimuth);
    const tangentX = -outwardZ;
    const tangentZ = outwardX;
    const start = positions.length / 3;

    for (let station = 0; station <= WARP_STATIONS; station += 1) {
      const y = WARP_BOTTOM_Y + ((WARP_TOP_Y - WARP_BOTTOM_Y) * station) / WARP_STATIONS;
      const radius = wallRadiusAt(y) + WARP_PROUD;
      for (const [radial, along] of WARP_CORNERS) {
        const r = radius + radial;
        positions.push(
          outwardX * r + tangentX * along,
          y,
          outwardZ * r + tangentZ * along,
        );
      }
    }

    for (let station = 0; station < WARP_STATIONS; station += 1) {
      for (let corner = 0; corner < 4; corner += 1) {
        const a = start + station * 4 + corner;
        const b = start + station * 4 + ((corner + 1) % 4);
        const c = start + (station + 1) * 4 + ((corner + 1) % 4);
        const d = start + (station + 1) * 4 + corner;
        indices.push(a, b, c, a, c, d);
      }
    }

    // 两端封口：上端藏在口沿环里，下端在篮底转折处，免得近看露出管口。
    const bottom = start;
    const top = start + WARP_STATIONS * 4;
    indices.push(bottom, bottom + 2, bottom + 1, bottom, bottom + 3, bottom + 2);
    indices.push(top, top + 1, top + 2, top, top + 2, top + 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return applyColor(geometry, WARP_COLOR);
}

/** 左右两侧各一个小半环提手，竖在口沿上，脚端埋进口沿环里。 */
function handleParts(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const geometry = new THREE.TorusGeometry(HANDLE_RADIUS, HANDLE_TUBE, 8, HANDLE_SEGMENTS, Math.PI);
    // Torus 的半圈默认躺在 XY 平面上方；绕 Y 转 90° 变成竖在 ZY 平面里的拱。
    geometry.rotateY(Math.PI / 2);
    geometry.translate(side * HANDLE_X, MOUTH_Y, 0);
    parts.push(applyColor(geometry, HANDLE_COLOR));
  }
  return parts;
}

/** 水平圆环（编织圈、口沿、脚圈共用）：先转到水平面再抬到指定高度。 */
function horizontalTorus(
  radius: number,
  tube: number,
  radialSegments: number,
  tubularSegments: number,
  y: number,
  color: RGB,
): THREE.BufferGeometry {
  const geometry = new THREE.TorusGeometry(radius, tube, radialSegments, tubularSegments);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, y, 0);
  return applyColor(geometry, color);
}

/** 统一挂阴影标记：篮子是实体道具，每个子件都投影也接收投影。 */
function shadowMesh(
  name: string,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * sRGB 十六进制转线性 RGB：顶点色按线性空间存，
 * 直接塞 sRGB 数值会让藤色发白，跟材质 color 的观感对不上。
 */
function linearRgb(hex: string): RGB {
  const color = new THREE.Color(hex);
  return [color.r, color.g, color.b];
}
