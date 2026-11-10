/**
 * V0.7 §5 素材 A：主花 7 种 + 配花 9 种的程序化几何。
 *
 * 全部复用 geometryUtils 的花瓣 / 茎管 / 球体 / 合并工具，返回与 rose、tulip
 * 同形状的 BuiltFlower：顶点色在这里一次写死，上层统一建 vertexColors 材质。
 * 段数按花型分档，单枝都压在 4000 三角面以内：大花瓣 4×8，普通瓣 3×8，
 * 碎瓣 2×4 / 2×6，花点用 5–6 段的低模球。
 */

import * as THREE from 'three';
import { darken, desaturate, hexToRgb, lighten, mixRgb, type RGB } from '../../data/color';
import type { Vec3 } from '../../data/types';
import {
  createSphere,
  createTube,
  mergeParts,
  placePetal,
  type PetalOptions,
  type PetalPlacement,
} from './geometryUtils';
import type { BuiltFlower } from './tulip';

const TAU = Math.PI * 2;
/** 任务约定的统一茎色。 */
const GREEN = hexToRgb('#536d43');
const LEAF_DARK = hexToRgb('#4a6138');
const LEAF_LIGHT = hexToRgb('#7d9459');
const PISTIL = hexToRgb('#d9c169');
const ANTHER = hexToRgb('#c58b42');

/** 主茎：从握点下方 0.22 米伸到花托，带一点手作的弯。 */
function stem(parts: THREE.BufferGeometry[], topY: number, radius = 0.0036): void {
  parts.push(
    createTube(
      [
        [-0.003, -0.22, 0],
        [0.003, -0.1, 0.003],
        [0, 0, 0],
        [-0.002, topY * 0.55, 0],
        [0.002, topY, 0],
      ],
      radius,
      GREEN,
      16,
      5,
    ),
  );
}

/** 细侧枝：从主茎某点抽到小花头，中间抬一点弧。 */
function branch(
  parts: THREE.BufferGeometry[],
  from: Vec3,
  to: Vec3,
  radius = 0.0018,
  lift = 0.01,
): void {
  const mid: Vec3 = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2 + lift, (from[2] + to[2]) / 2];
  parts.push(createTube([from, mid, to], radius, GREEN, 8, 3));
}

/** 叶片：细长弯曲的绿色花瓣，位置交给 placePetal。 */
function leaf(
  parts: THREE.BufferGeometry[],
  placement: PetalPlacement,
  length = 0.07,
  width = 0.016,
): void {
  placePetal(
    parts,
    {
      length,
      width,
      bend: length * 0.42,
      cup: 0.66,
      tipCurl: length * 0.16,
      tipShape: 0.6,
      segmentsU: 3,
      segmentsV: 7,
      baseColor: darken(LEAF_DARK, 0.08),
      tipColor: LEAF_LIGHT,
    },
    placement,
  );
}

/** 配花碎瓣：2–3 毫米级的极小花瓣，段数压到最低。 */
function tinyPetal(
  length: number,
  width: number,
  baseColor: RGB,
  tipColor: RGB,
  cup = 0.5,
): PetalOptions {
  return {
    length,
    width,
    bend: length * 0.3,
    cup,
    tipCurl: length * 0.1,
    tipShape: 0.5,
    segmentsU: 2,
    segmentsV: 4,
    baseColor,
    tipColor,
  };
}

/** 一颗小花点：满天星、小米花这类碎花的单元。 */
function dot(
  parts: THREE.BufferGeometry[],
  radius: number,
  color: RGB,
  position: Vec3,
  scale: Vec3 = [1, 1, 1],
  segments = 5,
): void {
  parts.push(createSphere(radius, color, position, scale, segments));
}

// ---------- 主花 7 种 ----------

/** 牡丹：五层宽瓣叠成饱满花球，花心深藏在里层；外瓣半张、瓣尖微波。 */
function buildPeony(color: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const tip = desaturate(color, 0.02);
  const base = lighten(color, 0.22);
  const inner = darken(color, 0.16);

  stem(parts, 0.3, 0.004);
  leaf(parts, { y: 0.02, azimuth: 1.1, lean: 1.02, roll: 0.12 }, 0.082, 0.02);
  leaf(parts, { y: 0.1, azimuth: 3.9, lean: 1.12, roll: -0.14 }, 0.07, 0.017);
  leaf(parts, { y: 0.17, azimuth: 5.4, lean: 0.95, roll: 0.1 }, 0.058, 0.014);

  // 五层：外层半张、越往里越收；内层花瓣留得够长，正面看是鼓起来的球而不是平盘。
  const layers = [
    { count: 9, length: 0.095, width: 0.058, lean: 1.05, y: 0.296, tipShape: 0.34, twist: 0.004 },
    { count: 8, length: 0.085, width: 0.054, lean: 0.8, y: 0.3, tipShape: 0.34, twist: 0.0035 },
    { count: 7, length: 0.074, width: 0.046, lean: 0.58, y: 0.304, tipShape: 0.32, twist: 0.003 },
    { count: 6, length: 0.062, width: 0.036, lean: 0.35, y: 0.308, tipShape: 0.3, twist: 0.0025 },
    { count: 5, length: 0.05, width: 0.028, lean: 0.14, y: 0.312, tipShape: 0.28, twist: 0.002 },
  ];
  layers.forEach((layer, index) => {
    const layerBase = mixRgb(base, tip, 0.12 + index * 0.08);
    const layerTip = index >= 3 ? mixRgb(tip, inner, 0.35) : tip;
    for (let i = 0; i < layer.count; i += 1) {
      placePetal(
        parts,
        {
          length: layer.length,
          width: layer.width,
          bend: 0.016 + index * 0.002,
          cup: 0.72,
          tipCurl: 0.014,
          tipShape: layer.tipShape,
          segmentsU: 4,
          segmentsV: 8,
          baseColor: layerBase,
          tipColor: layerTip,
          edgeColor: lighten(layerTip, 0.1),
          twist: layer.twist,
        },
        { y: layer.y, azimuth: (i / layer.count) * TAU + index * 0.4, lean: layer.lean },
      );
    }
  });

  // 花心只露一点：一个深色子房和一圈短花蕊。
  parts.push(createSphere(0.015, darken(inner, 0.24), [0, 0.336, 0], [1, 0.9, 1], 8));
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * TAU;
    parts.push(
      createSphere(0.003, PISTIL, [Math.cos(a) * 0.014, 0.34, Math.sin(a) * 0.014], [1, 1.6, 1], 5),
    );
  }

  return { geometry: mergeParts(parts), headHeight: 0.38, roughness: 0.85 };
}

/** 芍药：浅杯半开，两三层宽瓣外张，中央一圈金黄雄蕊完全露出来。 */
function buildHerbaceousPeony(color: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const tip = lighten(desaturate(color, 0.03), 0.1);
  const base = lighten(color, 0.3);
  const throat = darken(mixRgb(color, [0.86, 0.7, 0.4], 0.35), 0.06);

  stem(parts, 0.296, 0.0038);
  leaf(parts, { y: 0.0, azimuth: 1.2, lean: 1.0, roll: 0.1 }, 0.08, 0.019);
  leaf(parts, { y: 0.08, azimuth: 4.0, lean: 1.1, roll: -0.12 }, 0.068, 0.016);
  leaf(parts, { y: 0.16, azimuth: 5.5, lean: 0.92, roll: 0.1 }, 0.056, 0.013);

  // 外 6 / 中 5 / 内 3：杯口明显比牡丹开，瓣尖也更尖一点。
  for (let i = 0; i < 6; i += 1) {
    placePetal(
      parts,
      {
        length: 0.078,
        width: 0.05,
        bend: 0.012,
        cup: 0.9,
        tipCurl: 0.012,
        tipShape: 0.3,
        segmentsU: 4,
        segmentsV: 8,
        baseColor: mixRgb(base, throat, 0.3),
        tipColor: tip,
        edgeColor: lighten(tip, 0.1),
        twist: 0.003,
      },
      { y: 0.296, azimuth: (i / 6) * TAU, lean: 1.1 },
    );
  }
  for (let i = 0; i < 5; i += 1) {
    placePetal(
      parts,
      {
        length: 0.065,
        width: 0.042,
        bend: 0.012,
        cup: 0.85,
        tipCurl: 0.01,
        tipShape: 0.3,
        segmentsU: 4,
        segmentsV: 8,
        baseColor: mixRgb(base, throat, 0.45),
        tipColor: tip,
      },
      { y: 0.3, azimuth: (i / 5) * TAU + 0.6, lean: 0.8 },
    );
  }
  for (let i = 0; i < 3; i += 1) {
    placePetal(
      parts,
      {
        length: 0.05,
        width: 0.03,
        bend: 0.008,
        cup: 0.8,
        tipCurl: 0.008,
        tipShape: 0.28,
        segmentsU: 3,
        segmentsV: 7,
        baseColor: mixRgb(throat, tip, 0.35),
        tipColor: mixRgb(tip, throat, 0.3),
      },
      { y: 0.304, azimuth: (i / 3) * TAU + 0.3, lean: 0.45 },
    );
  }

  // 露出的雄蕊环 + 中央子房，这是芍药和牡丹最容易分辨的地方。
  for (let i = 0; i < 12; i += 1) {
    const a = (i / 12) * TAU;
    parts.push(
      createSphere(
        0.0032,
        mixRgb(PISTIL, ANTHER, 0.5),
        [Math.cos(a) * 0.016, 0.335, Math.sin(a) * 0.016],
        [1, 1.7, 1],
        5,
      ),
    );
  }
  parts.push(createSphere(0.012, mixRgb(PISTIL, GREEN, 0.4), [0, 0.33, 0], [1, 0.85, 1], 7));

  return { geometry: mergeParts(parts), headHeight: 0.37, roughness: 0.85 };
}

/** 康乃馨：绿色花萼托着一圈窄瓣圆顶；外层每个方位摆两片错开的窄瓣，瓣尖缺口近似锯齿边。 */
function buildCarnation(color: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const tip = lighten(desaturate(color, 0.04), 0.12);
  const base = lighten(color, 0.28);
  const deep = darken(color, 0.18);

  stem(parts, 0.288, 0.0032);
  // 花萼：一段绿筒加五片贴着花头的小萼片。
  parts.push(createTube([[0, 0.232, 0], [0, 0.258, 0], [0, 0.286, 0]], 0.0078, GREEN, 8, 6));
  for (let i = 0; i < 5; i += 1) {
    placePetal(
      parts,
      {
        length: 0.028,
        width: 0.01,
        bend: -0.004,
        tipShape: 0.4,
        segmentsU: 2,
        segmentsV: 5,
        baseColor: darken(GREEN, 0.1),
        tipColor: mixRgb(GREEN, LEAF_LIGHT, 0.35),
      },
      { y: 0.284, azimuth: (i / 5) * TAU + 0.3, lean: 0.6, roll: 0.1 },
    );
  }
  // 锯齿边：外层每组两片窄瓣，方位差 0.11 弧度、长度也错开，瓣尖之间留出缺口。
  const rim = 14;
  const rimVariants = [
    { offset: -0.055, lean: 1.05, length: 0.028 },
    { offset: 0.055, lean: 0.95, length: 0.032 },
  ];
  for (let i = 0; i < rim; i += 1) {
    const a = (i / rim) * TAU;
    for (const variant of rimVariants) {
      placePetal(
        parts,
        {
          length: variant.length,
          width: 0.0085,
          bend: 0.008,
          cup: 0.3,
          tipCurl: 0.006,
          tipShape: 0.22,
          segmentsU: 2,
          segmentsV: 6,
          baseColor: base,
          tipColor: tip,
          edgeColor: lighten(tip, 0.2),
        },
        { y: 0.29, azimuth: a + variant.offset, lean: variant.lean },
      );
    }
  }
  // 中层十片、内层七片：把花心堆成圆顶。
  for (let i = 0; i < 10; i += 1) {
    placePetal(
      parts,
      {
        length: 0.03,
        width: 0.013,
        bend: 0.008,
        cup: 0.5,
        tipCurl: 0.006,
        tipShape: 0.3,
        segmentsU: 2,
        segmentsV: 6,
        baseColor: mixRgb(base, deep, 0.2),
        tipColor: tip,
      },
      { y: 0.294, azimuth: (i / 10) * TAU + 0.18, lean: 0.72 },
    );
  }
  for (let i = 0; i < 7; i += 1) {
    placePetal(
      parts,
      {
        length: 0.024,
        width: 0.011,
        bend: 0.006,
        cup: 0.55,
        tipCurl: 0.004,
        tipShape: 0.3,
        segmentsU: 2,
        segmentsV: 5,
        baseColor: mixRgb(base, deep, 0.35),
        tipColor: lighten(tip, 0.06),
      },
      { y: 0.298, azimuth: (i / 7) * TAU + 0.5, lean: 0.3 },
    );
  }
  parts.push(createSphere(0.008, darken(deep, 0.1), [0, 0.312, 0], [1, 0.9, 1], 6));
  leaf(parts, { y: 0.0, azimuth: 1.2, lean: 1.0, roll: 0.1 }, 0.05, 0.0075);
  leaf(parts, { y: 0.09, azimuth: 4.2, lean: 1.1, roll: -0.12 }, 0.042, 0.0065);

  return { geometry: mergeParts(parts), headHeight: 0.36, roughness: 0.86 };
}

/** 百合：六片狭长花被向外翻卷下垂成星形，中央六枚顶花药的雄蕊和一根雌蕊。 */
function buildLily(color: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const tip = lighten(desaturate(color, 0.02), 0.1);
  const base = mixRgb(color, [0.94, 0.9, 0.74], 0.35);
  const throat = darken(color, 0.22);

  stem(parts, 0.31, 0.0036);
  leaf(parts, { y: -0.02, azimuth: 1.3, lean: 1.02, roll: 0.1 }, 0.1, 0.014);
  leaf(parts, { y: 0.06, azimuth: 4.1, lean: 1.08, roll: -0.12 }, 0.085, 0.012);
  leaf(parts, { y: 0.14, azimuth: 5.6, lean: 0.95, roll: 0.1 }, 0.07, 0.01);

  // 三外三内错开 60 度；lean 接近水平 + 正 bend 让瓣尖向外向下翻卷。
  for (let layer = 0; layer < 2; layer += 1) {
    const outer = layer === 0;
    for (let i = 0; i < 3; i += 1) {
      const a = (i / 3) * TAU + (outer ? 0 : Math.PI / 3);
      placePetal(
        parts,
        {
          length: outer ? 0.115 : 0.105,
          width: outer ? 0.026 : 0.023,
          bend: outer ? 0.022 : 0.018,
          cup: 0.42,
          tipCurl: outer ? 0.012 : 0.01,
          tipShape: 0.7,
          segmentsU: 3,
          segmentsV: 10,
          baseColor: mixRgb(throat, base, outer ? 0.35 : 0.5),
          tipColor: outer ? tip : lighten(tip, 0.06),
          edgeColor: lighten(tip, 0.1),
        },
        { y: outer ? 0.305 : 0.307, azimuth: a, lean: outer ? 1.52 : 1.34 },
      );
    }
  }

  // 六枚雄蕊：细丝从花喉伸出，末端顶着长条形花药。
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * TAU + 0.3;
    const r = 0.048;
    parts.push(
      createTube(
        [
          [0, 0.312, 0],
          [Math.cos(a) * r * 0.5, 0.334, Math.sin(a) * r * 0.5],
          [Math.cos(a) * r, 0.348, Math.sin(a) * r],
        ],
        0.0011,
        mixRgb(GREEN, PISTIL, 0.45),
        6,
        3,
      ),
    );
    dot(parts, 0.0038, ANTHER, [Math.cos(a) * r, 0.351, Math.sin(a) * r], [1, 1.9, 1], 5);
  }
  // 一根略高的雌蕊。
  parts.push(
    createTube([[0, 0.312, 0], [0.004, 0.335, 0], [0.002, 0.352, 0]], 0.0012, mixRgb(PISTIL, GREEN, 0.35), 6, 3),
  );
  dot(parts, 0.004, mixRgb(PISTIL, GREEN, 0.3), [0.002, 0.355, 0], [1, 1.5, 1], 5);

  return { geometry: mergeParts(parts), headHeight: 0.4, roughness: 0.8 };
}

/** 向日葵：扁平深色花盘 + 两圈放射状舌状瓣，盘面点满种子，后面一圈绿苞片。 */
function buildSunflower(color: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const rayBase = darken(color, 0.1);
  const rayTip = lighten(color, 0.2);
  const disc = mixRgb(hexToRgb('#5a3c22'), darken(color, 0.2), 0.25);
  const seedColor = mixRgb(disc, [0.26, 0.22, 0.11], 0.5);

  stem(parts, 0.336, 0.0046);
  leaf(parts, { y: 0.02, azimuth: 1.2, lean: 1.0, roll: 0.1 }, 0.11, 0.046);
  leaf(parts, { y: 0.12, azimuth: 4.2, lean: 1.12, roll: -0.12 }, 0.095, 0.04);

  // 花盘后面一圈向下翻的绿苞片。
  for (let i = 0; i < 12; i += 1) {
    placePetal(
      parts,
      {
        length: 0.028,
        width: 0.012,
        bend: -0.004,
        cup: 0.5,
        tipShape: 0.45,
        segmentsU: 2,
        segmentsV: 5,
        baseColor: darken(GREEN, 0.08),
        tipColor: mixRgb(GREEN, LEAF_LIGHT, 0.4),
      },
      { y: 0.344, azimuth: (i / 12) * TAU + 0.2, lean: 1.85 },
    );
  }

  // 花盘：扁球做主盘，再加一层更小更扁的种子环。
  parts.push(createSphere(0.032, disc, [0, 0.352, 0], [1, 0.34, 1], 10));
  parts.push(createSphere(0.024, mixRgb(disc, seedColor, 0.5), [0, 0.358, 0], [1, 0.22, 1], 8));

  // 两圈舌状瓣，外圈稍长更外翻、瓣尖略向上兜，正面看能看到一圈花瓣边。
  for (let i = 0; i < 14; i += 1) {
    placePetal(
      parts,
      {
        length: 0.058,
        width: 0.011,
        bend: -0.014,
        cup: 0.18,
        tipCurl: 0,
        tipShape: 0.5,
        segmentsU: 3,
        segmentsV: 8,
        baseColor: rayBase,
        tipColor: rayTip,
      },
      { y: 0.348, azimuth: (i / 14) * TAU, lean: 1.5 },
    );
  }
  for (let i = 0; i < 12; i += 1) {
    placePetal(
      parts,
      {
        length: 0.046,
        width: 0.01,
        bend: -0.012,
        cup: 0.2,
        tipCurl: 0,
        tipShape: 0.5,
        segmentsU: 3,
        segmentsV: 8,
        baseColor: mixRgb(rayBase, rayTip, 0.4),
        tipColor: lighten(rayTip, 0.06),
      },
      { y: 0.352, azimuth: (i / 12) * TAU + 0.26, lean: 1.62 },
    );
  }

  // 盘面上的种子点，按两圈螺旋排开。
  for (let i = 0; i < 14; i += 1) {
    const a = i * 2.39996;
    const r = 0.022 * Math.sqrt((i + 0.5) / 14);
    dot(parts, 0.0026, seedColor, [Math.cos(a) * r, 0.362, Math.sin(a) * r], [1, 0.6, 1], 5);
  }

  return { geometry: mergeParts(parts), headHeight: 0.4, roughness: 0.86 };
}

/** 大丽花：六层尖瓣像莲座一样层层收拢，瓣数逐层递减、每层旋转错开。 */
function buildDahlia(color: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const deep = darken(color, 0.12);
  const tip = lighten(color, 0.18);

  stem(parts, 0.3, 0.0036);
  leaf(parts, { y: 0.02, azimuth: 1.1, lean: 1.0, roll: 0.1 }, 0.075, 0.03);
  leaf(parts, { y: 0.1, azimuth: 4.1, lean: 1.08, roll: -0.12 }, 0.06, 0.024);

  // 花萼：向后翻的绿瓣，托在莲座底下。
  for (let i = 0; i < 7; i += 1) {
    placePetal(
      parts,
      {
        length: 0.03,
        width: 0.012,
        bend: -0.004,
        tipShape: 0.45,
        segmentsU: 2,
        segmentsV: 4,
        baseColor: darken(GREEN, 0.08),
        tipColor: mixRgb(GREEN, LEAF_LIGHT, 0.35),
      },
      { y: 0.298, azimuth: (i / 7) * TAU + 0.3, lean: 1.75 },
    );
  }

  // 六层尖瓣：外层长而外张，内层短而直立，tipShape 大 → 瓣尖尖。
  const layers = [
    { count: 10, length: 0.07, width: 0.019, lean: 1.18 },
    { count: 9, length: 0.062, width: 0.017, lean: 1.0 },
    { count: 8, length: 0.054, width: 0.015, lean: 0.82 },
    { count: 7, length: 0.046, width: 0.013, lean: 0.62 },
    { count: 6, length: 0.042, width: 0.011, lean: 0.4 },
    { count: 5, length: 0.034, width: 0.009, lean: 0.18 },
  ];
  layers.forEach((layer, index) => {
    for (let i = 0; i < layer.count; i += 1) {
      placePetal(
        parts,
        {
          length: layer.length,
          width: layer.width,
          bend: 0.008,
          cup: 0.9,
          tipCurl: 0.006,
          tipShape: 0.78,
          segmentsU: 2,
          segmentsV: 8,
          baseColor: mixRgb(deep, tip, index * 0.12),
          tipColor: index >= 3 ? mixRgb(tip, deep, 0.15) : tip,
          edgeColor: lighten(tip, 0.08),
        },
        { y: 0.304 + index * 0.004, azimuth: (i / layer.count) * TAU + index * 0.35, lean: layer.lean },
      );
    }
  });
  parts.push(createSphere(0.01, mixRgb(ANTHER, PISTIL, 0.55), [0, 0.352, 0], [1, 0.8, 1], 6));

  return { geometry: mergeParts(parts), headHeight: 0.37, roughness: 0.84 };
}

/** 马蹄莲：一片高杯白色佛焰苞卷成漏斗，中央一根黄色肉穗，配两片箭形大叶。 */
function buildCalla(color: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const spatheBase = lighten(color, 0.24);
  const spatheTip = lighten(desaturate(color, 0.05), 0.1);
  const spadix = lighten(hexToRgb('#e8d48a'), 0.08);

  stem(parts, 0.3, 0.004);
  leaf(parts, { y: 0.0, azimuth: 1.2, lean: 0.85, roll: 0.1 }, 0.1, 0.034);
  leaf(parts, { y: 0.08, azimuth: 4.2, lean: 0.95, roll: -0.12 }, 0.08, 0.028);

  // 佛焰苞：一片高杯瓣卷成漏斗，再叠一片略小的错开一点做卷口；整体前倾一点，正面能看到喇叭口。
  placePetal(
    parts,
    {
      length: 0.118,
      width: 0.05,
      bend: 0.026,
      cup: 1.7,
      tipCurl: 0.03,
      tipShape: 0.36,
      segmentsU: 8,
      segmentsV: 14,
      baseColor: spatheBase,
      tipColor: spatheTip,
      edgeColor: lighten(spatheTip, 0.12),
    },
    { y: 0.295, azimuth: 0, lean: 0.3 },
  );
  placePetal(
    parts,
    {
      length: 0.1,
      width: 0.044,
      bend: 0.022,
      cup: 1.5,
      tipCurl: 0.026,
      tipShape: 0.34,
      segmentsU: 6,
      segmentsV: 10,
      baseColor: darken(spatheBase, 0.06),
      tipColor: spatheTip,
    },
    { y: 0.298, azimuth: 0.55, lean: 0.36, z: 0.004 },
  );

  // 肉穗花序：从花喉里探出的黄棒，顺着喇叭口向前上方挑出来。
  parts.push(
    createTube([[0, 0.3, 0.03], [0.003, 0.335, 0.055], [0.002, 0.362, 0.078]], 0.0042, spadix, 10, 6),
  );
  dot(parts, 0.0045, spadix, [0.002, 0.365, 0.08], [1, 1.3, 1], 6);

  return { geometry: mergeParts(parts), headHeight: 0.41, roughness: 0.78 };
}

// ---------- 配花 9 种 ----------

/** 洋桔梗：绿色花萼上杯状叠瓣，外五片半开、内五片收拢，中心一小团浅色。 */
function buildLisianthus(color: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const base = lighten(color, 0.26);
  const tip = lighten(desaturate(color, 0.03), 0.15);
  const throat = darken(mixRgb(color, [0.9, 0.85, 0.7], 0.3), 0.06);

  stem(parts, 0.292, 0.0032);
  leaf(parts, { y: -0.03, azimuth: 1.2, lean: 1.05, roll: 0.1 }, 0.05, 0.012);
  leaf(parts, { y: 0.04, azimuth: 4.2, lean: 1.1, roll: -0.12 }, 0.045, 0.01);
  leaf(parts, { y: 0.12, azimuth: 5.6, lean: 0.95, roll: 0.1 }, 0.04, 0.009);

  // 花萼五片，贴着花托向上。
  for (let i = 0; i < 5; i += 1) {
    placePetal(
      parts,
      {
        length: 0.026,
        width: 0.009,
        bend: -0.002,
        tipShape: 0.4,
        segmentsU: 2,
        segmentsV: 5,
        baseColor: darken(GREEN, 0.1),
        tipColor: mixRgb(GREEN, LEAF_LIGHT, 0.3),
      },
      { y: 0.286, azimuth: (i / 5) * TAU + 0.3, lean: 1.5, roll: 0.1 },
    );
  }
  // 杯状叠瓣：外五片中五片，再加三片小内瓣把花心收住。
  for (let i = 0; i < 5; i += 1) {
    placePetal(
      parts,
      {
        length: 0.052,
        width: 0.03,
        bend: 0.008,
        cup: 0.95,
        tipCurl: 0.008,
        tipShape: 0.3,
        segmentsU: 3,
        segmentsV: 8,
        baseColor: mixRgb(base, throat, 0.3),
        tipColor: tip,
        edgeColor: lighten(tip, 0.12),
      },
      { y: 0.29, azimuth: (i / 5) * TAU, lean: 0.85 },
    );
  }
  for (let i = 0; i < 5; i += 1) {
    placePetal(
      parts,
      {
        length: 0.045,
        width: 0.026,
        bend: 0.006,
        cup: 0.9,
        tipCurl: 0.006,
        tipShape: 0.3,
        segmentsU: 3,
        segmentsV: 8,
        baseColor: mixRgb(base, throat, 0.45),
        tipColor: tip,
      },
      { y: 0.294, azimuth: (i / 5) * TAU + 0.6, lean: 0.55 },
    );
  }
  for (let i = 0; i < 3; i += 1) {
    placePetal(
      parts,
      {
        length: 0.032,
        width: 0.02,
        bend: 0.004,
        cup: 0.85,
        tipCurl: 0.004,
        tipShape: 0.3,
        segmentsU: 2,
        segmentsV: 6,
        baseColor: mixRgb(throat, tip, 0.4),
        tipColor: mixRgb(tip, throat, 0.3),
      },
      { y: 0.298, azimuth: (i / 3) * TAU + 0.3, lean: 0.25 },
    );
  }
  dot(parts, 0.009, mixRgb(PISTIL, tip, 0.35), [0, 0.318, 0], [1, 0.8, 1], 6);

  return { geometry: mergeParts(parts), headHeight: 0.36, roughness: 0.82 };
}

/** 六出花：一根微弯主茎分两枝，三朵漏斗形小花成簇，内瓣带深色斑纹。 */
function buildAlstroemeria(color: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const pale = mixRgb(lighten(color, 0.3), [0.98, 0.94, 0.86], 0.25);
  const streak = mixRgb(color, [0.34, 0.21, 0.1], 0.55);
  const base = mixRgb(color, pale, 0.3);

  stem(parts, 0.262, 0.0032);
  leaf(parts, { y: 0.06, azimuth: 1.1, lean: 1.05, roll: 0.12 }, 0.05, 0.0075);
  leaf(parts, { y: 0.13, azimuth: 4.1, lean: 1.12, roll: -0.14 }, 0.04, 0.0065);
  leaf(parts, { y: 0.19, azimuth: 5.6, lean: 0.98, roll: 0.1 }, 0.032, 0.0055);

  const florets: Vec3[] = [
    [0.058, 0.318, 0.014],
    [-0.052, 0.302, -0.012],
    [0.008, 0.352, 0.006],
  ];
  const origins: Vec3[] = [[0, 0.24, 0], [0, 0.225, 0], [0, 0.262, 0]];
  florets.forEach((center, index) => {
    if (index < 2) branch(parts, origins[index], center, 0.0016, 0.014);
    // 六片漏斗瓣：外三片浅、内三片带深色斑。
    for (let layer = 0; layer < 2; layer += 1) {
      for (let i = 0; i < 3; i += 1) {
        const a = (i / 3) * TAU + index * 0.8 + layer * (Math.PI / 3);
        placePetal(
          parts,
          {
            length: layer === 0 ? 0.034 : 0.028,
            width: layer === 0 ? 0.018 : 0.015,
            bend: 0.004,
            cup: 1.15,
            tipCurl: 0.004,
            tipShape: 0.45,
            segmentsU: 2,
            segmentsV: 6,
            baseColor: layer === 0 ? base : darken(color, 0.18),
            tipColor: layer === 0 ? pale : streak,
          },
          { x: center[0], y: center[1], z: center[2], azimuth: a, lean: layer === 0 ? 0.85 : 0.55 },
        );
      }
    }
    dot(parts, 0.005, mixRgb(PISTIL, pale, 0.4), [center[0], center[1] + 0.004, center[2]], [1, 0.9, 1], 5);
  });

  return { geometry: mergeParts(parts), headHeight: 0.39, roughness: 0.8 };
}

/** 多头小菊：三根分枝各顶一个小头，平展舌状瓣配浅色小花心。 */
function buildSprayChrysanthemum(color: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const petal = lighten(color, 0.16);
  const petalTip = lighten(desaturate(color, 0.03), 0.1);
  const center = mixRgb(PISTIL, GREEN, 0.45);

  stem(parts, 0.25, 0.0032);
  leaf(parts, { y: 0.0, azimuth: 1.1, lean: 1.05, roll: 0.1 }, 0.045, 0.01);
  leaf(parts, { y: 0.09, azimuth: 4.1, lean: 1.12, roll: -0.12 }, 0.04, 0.009);

  const heads: Vec3[] = [
    [0.055, 0.33, 0.012],
    [-0.058, 0.312, -0.01],
    [0.004, 0.382, 0.016],
  ];
  const origins: Vec3[] = [[0, 0.22, 0], [0, 0.21, 0], [0, 0.24, 0]];
  heads.forEach((head, index) => {
    branch(parts, origins[index], head, 0.0017, 0.012);
    // 平展的一圈舌状瓣 + 半张的内圈。
    for (let i = 0; i < 12; i += 1) {
      placePetal(
        parts,
        tinyPetal(0.026, 0.0055, petal, petalTip, 0.2),
        { x: head[0], y: head[1], z: head[2], azimuth: (i / 12) * TAU + index * 0.3, lean: 1.48 },
      );
    }
    for (let i = 0; i < 8; i += 1) {
      placePetal(
        parts,
        tinyPetal(0.019, 0.0045, mixRgb(petal, petalTip, 0.5), petalTip, 0.3),
        { x: head[0], y: head[1] + 0.002, z: head[2], azimuth: (i / 8) * TAU + 0.2, lean: 0.85 },
      );
    }
    dot(parts, 0.0085, center, [head[0], head[1] + 0.004, head[2]], [1, 0.75, 1], 6);
  });

  return { geometry: mergeParts(parts), headHeight: 0.39, roughness: 0.82 };
}

/** 满天星：五根细枝散成一团，枝头各自挂一串 4 毫米的白色小花点。 */
function buildBabysBreath(color: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const pale = mixRgb(lighten(color, 0.5), [0.99, 0.98, 0.96], 0.35);
  const paleWarm = mixRgb(lighten(color, 0.35), ANTHER, 0.12);
  const calyxGreen = mixRgb(GREEN, LEAF_LIGHT, 0.3);

  stem(parts, 0.25, 0.003);
  // 配花的花头整体比主花小一号，横向收在 14 厘米内。
  const tips: Vec3[] = [
    [0.062, 0.325, 0.024],
    [-0.058, 0.345, -0.02],
    [0.016, 0.398, 0.036],
    [-0.028, 0.31, 0.048],
    [0.04, 0.29, -0.044],
  ];
  tips.forEach((tip, b) => {
    branch(parts, [0, 0.2 + b * 0.008, 0], tip, 0.0016, 0.018);
    // 枝头八个花点，半径和高度错开，堆出蓬松的云。
    for (let d = 0; d < 8; d += 1) {
      const a = d * 2.4 + b * 0.9;
      const r = 0.006 + (d % 3) * 0.005;
      const size = 0.0036 + (d % 4) * 0.0004;
      dot(
        parts,
        size,
        d % 2 === 0 ? pale : paleWarm,
        [tip[0] + Math.cos(a) * r, tip[1] + ((d % 3) - 0.5) * 0.009, tip[2] + Math.sin(a) * r],
        [1, 0.9, 1],
        5,
      );
    }
    dot(parts, 0.0048, calyxGreen, [tip[0], tip[1] - 0.004, tip[2]], [1, 1, 1], 5);
  });

  return { geometry: mergeParts(parts), headHeight: 0.4, roughness: 0.8 };
}

/** 补血草：五根细枝摊成平顶伞房，枝梢是纸质感的米粒小花。 */
function buildStatice(color: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const papery = mixRgb(lighten(color, 0.3), [0.94, 0.9, 0.96], 0.25);
  const paperyTip = lighten(desaturate(color, 0.08), 0.35);
  const paperyCalyx = mixRgb(GREEN, LEAF_LIGHT, 0.4);

  stem(parts, 0.25, 0.003);
  const tips: Vec3[] = [
    [0.068, 0.332, 0.016],
    [-0.064, 0.318, -0.014],
    [0.023, 0.346, 0.061],
    [-0.031, 0.324, 0.056],
    [0.048, 0.31, -0.048],
  ];
  tips.forEach((tip, b) => {
    branch(parts, [0, 0.21 + b * 0.007, 0], tip, 0.0017, 0.022);
    // 每个枝梢三朵纸质小花，四片米粒小瓣外张。
    for (let f = 0; f < 3; f += 1) {
      const a = (f / 3) * TAU + b * 1.1;
      const fx = tip[0] + Math.cos(a) * 0.009;
      const fz = tip[2] + Math.sin(a) * 0.009;
      const fy = tip[1] + (f === 0 ? 0.005 : 0) - (f === 2 ? 0.003 : 0);
      for (let p = 0; p < 4; p += 1) {
        placePetal(parts, tinyPetal(0.013, 0.0055, papery, paperyTip, 0.45), {
          x: fx,
          y: fy,
          z: fz,
          azimuth: (p / 4) * TAU + f * 0.5,
          lean: 1.05,
        });
      }
      dot(parts, 0.0034, paperyCalyx, [fx, fy - 0.002, fz], [1, 0.8, 1], 5);
    }
  });
  leaf(parts, { y: 0.05, azimuth: 1.4, lean: 1.15, roll: 0.1 }, 0.03, 0.005);

  return { geometry: mergeParts(parts), headHeight: 0.36, roughness: 0.86 };
}

/** 澳洲蜡花：三根短枝顶着七朵五瓣星形小花，旁边排几粒蜡质圆形花苞。 */
function buildWaxflower(color: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const waxy = mixRgb(lighten(color, 0.24), [0.96, 0.92, 0.9], 0.2);
  const waxyTip = lighten(color, 0.32);
  const bud = mixRgb(color, [0.6, 0.68, 0.5], 0.32);

  stem(parts, 0.25, 0.003);
  leaf(parts, { y: -0.01, azimuth: 1.2, lean: 1.1, roll: 0.1 }, 0.03, 0.005);
  leaf(parts, { y: 0.07, azimuth: 4.2, lean: 1.15, roll: -0.12 }, 0.026, 0.0045);

  const tips: Vec3[] = [
    [0.045, 0.3, 0.012],
    [-0.04, 0.325, -0.01],
    [0.008, 0.355, 0.02],
  ];
  tips.forEach((tip, b) => {
    branch(parts, [0, 0.21 + b * 0.012, 0], tip, 0.0016, 0.01);
    for (let f = 0; f < 2; f += 1) {
      const a = f * Math.PI + b * 1.7;
      const fx = tip[0] + Math.cos(a) * 0.01;
      const fz = tip[2] + Math.sin(a) * 0.01;
      const fy = tip[1] + 0.004 + f * 0.006;
      // 五片窄瓣平展成星形。
      for (let p = 0; p < 5; p += 1) {
        placePetal(parts, tinyPetal(0.012, 0.0038, waxy, waxyTip, 0.15), {
          x: fx,
          y: fy,
          z: fz,
          azimuth: (p / 5) * TAU + f * 0.6,
          lean: 1.5,
        });
      }
      dot(parts, 0.0028, mixRgb(waxyTip, ANTHER, 0.25), [fx, fy + 0.002, fz], [1, 0.9, 1], 5);
    }
  });
  // 顶部一朵 + 周围几粒未开的蜡质苞。
  for (let p = 0; p < 5; p += 1) {
    placePetal(parts, tinyPetal(0.011, 0.0036, waxy, waxyTip, 0.15), {
      x: 0.008,
      y: 0.362,
      z: 0.02,
      azimuth: (p / 5) * TAU + 0.3,
      lean: 1.45,
    });
  }
  dot(parts, 0.0026, waxyTip, [0.008, 0.366, 0.02], [1, 0.9, 1], 5);
  const buds: Vec3[] = [
    [0.026, 0.29, -0.016],
    [-0.02, 0.312, 0.028],
    [0.03, 0.34, 0.006],
    [-0.034, 0.288, 0.02],
  ];
  for (const position of buds) dot(parts, 0.0042, bud, position, [1, 1.1, 1], 5);

  return { geometry: mergeParts(parts), headHeight: 0.36, roughness: 0.8 };
}

/** 小米花：四根细枝挂满成串的小圆球，像小米粒一样蓬松。 */
function buildRiceFlower(color: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const ballLight = mixRgb(lighten(color, 0.34), [0.99, 0.98, 0.94], 0.3);
  const ballDark = mixRgb(lighten(color, 0.12), [0.88, 0.86, 0.8], 0.2);
  const calyxGreen = mixRgb(GREEN, LEAF_LIGHT, 0.35);

  stem(parts, 0.26, 0.003);
  const tips: Vec3[] = [
    [0.05, 0.33, 0.02],
    [-0.055, 0.35, -0.015],
    [0.015, 0.39, 0.03],
    [-0.02, 0.3, 0.045],
  ];
  tips.forEach((tip, b) => {
    branch(parts, [0, 0.21 + b * 0.01, 0], tip, 0.0016, 0.015);
    // 每枝四粒圆球，上下错开，形成一小串。
    for (let d = 0; d < 4; d += 1) {
      const a = d * 2.1 + b * 1.3;
      const r = 0.005 + (d % 2) * 0.006;
      dot(
        parts,
        0.0058,
        d % 2 === 0 ? ballLight : ballDark,
        [tip[0] + Math.cos(a) * r, tip[1] + 0.004 + (d % 3) * 0.005, tip[2] + Math.sin(a) * r],
        [1, 1.15, 1],
        6,
      );
    }
    dot(parts, 0.004, calyxGreen, [tip[0], tip[1] - 0.003, tip[2]], [1, 1, 1], 5);
  });
  dot(parts, 0.0055, ballLight, [0.005, 0.405, 0.01], [1, 1.2, 1], 6);

  return { geometry: mergeParts(parts), headHeight: 0.39, roughness: 0.84 };
}

/** 婆婆纳：细长花穗直立收尖，穗轴上四朵一轮的碎花层层向上，另抽一根侧穗。 */
function buildVeronica(color: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const pale = lighten(desaturate(color, 0.05), 0.3);
  const deep = darken(mixRgb(color, hexToRgb('#6b5a8a'), 0.2), 0.08);

  stem(parts, 0.29, 0.003);
  // 穗轴：主茎顶端继续抽出细长花穗。
  parts.push(createTube([[0, 0.28, 0], [0.004, 0.34, 0.002], [0.002, 0.4, 0]], 0.0026, GREEN, 10, 4));

  // 六层轮生碎花，每层四朵，越往上越小。
  for (let level = 0; level < 6; level += 1) {
    const y = 0.3 + level * 0.017;
    const size = 1 - level * 0.1;
    for (let i = 0; i < 4; i += 1) {
      const a = level * 0.9 + (i / 4) * TAU;
      const px = 0.002 + Math.cos(a) * 0.008;
      const pz = Math.sin(a) * 0.008;
      for (let p = 0; p < 4; p += 1) {
        placePetal(parts, tinyPetal(0.008 * size, 0.0028 * size, deep, pale, 0.35), {
          x: px,
          y,
          z: pz,
          azimuth: (p / 4) * TAU + a,
          lean: 0.95,
        });
      }
    }
  }

  // 一根侧穗，让轮廓不至于只有一根孤线。
  branch(parts, [0, 0.26, 0], [0.042, 0.335, 0.012], 0.0018, 0.012);
  for (let level = 0; level < 2; level += 1) {
    const y = 0.315 + level * 0.014;
    for (let i = 0; i < 3; i += 1) {
      const a = (i / 3) * TAU + level;
      for (let p = 0; p < 4; p += 1) {
        placePetal(parts, tinyPetal(0.007, 0.0026, deep, pale, 0.35), {
          x: 0.042 + Math.cos(a) * 0.007,
          y,
          z: 0.012 + Math.sin(a) * 0.007,
          azimuth: (p / 4) * TAU + a,
          lean: 0.95,
        });
      }
    }
  }

  // 穗顶几粒未开的小苞。
  dot(parts, 0.0028, pale, [0.002, 0.404, 0], [1, 1.4, 1]);
  dot(parts, 0.0026, mixRgb(pale, GREEN, 0.3), [0.036, 0.352, 0.01], [1, 1.4, 1]);
  dot(parts, 0.0024, mixRgb(pale, GREEN, 0.3), [0.047, 0.34, 0.014], [1, 1.4, 1]);

  leaf(parts, { y: -0.02, azimuth: 1.0, lean: 1.1, roll: 0.1 }, 0.045, 0.007);
  leaf(parts, { y: 0.07, azimuth: 4.1, lean: 1.15, roll: -0.12 }, 0.038, 0.006);

  return { geometry: mergeParts(parts), headHeight: 0.42, roughness: 0.82 };
}

/** 金鱼草：直立总状花序，八朵上下唇互生小花沿轴往上变小，顶端留一个绿苞。 */
function buildSnapdragon(color: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const base = darken(desaturate(color, 0.02), 0.06);
  const tip = lighten(color, 0.18);
  const lip = mixRgb(color, [0.95, 0.88, 0.7], 0.28);
  const throat = mixRgb(color, [0.98, 0.9, 0.6], 0.45);

  stem(parts, 0.29, 0.0032);
  // 顶端继续抽花序轴。
  parts.push(createTube([[0, 0.28, 0], [0.003, 0.35, 0.002], [0.001, 0.41, 0]], 0.0026, GREEN, 10, 4));

  // 八朵互生的小花：上唇两片合拢成盔，下唇两片外翻，中间一点花喉。
  for (let i = 0; i < 8; i += 1) {
    const a = i * 2.1;
    const y = 0.3 + i * 0.0145;
    const size = 1 - i * 0.07;
    const px = 0.002 + Math.cos(a) * 0.012;
    const pz = Math.sin(a) * 0.012;
    for (let p = 0; p < 2; p += 1) {
      placePetal(
        parts,
        {
          length: 0.028 * size,
          width: 0.016 * size,
          bend: 0.008,
          cup: 1.15,
          tipCurl: 0.004,
          tipShape: 0.35,
          segmentsU: 2,
          segmentsV: 6,
          baseColor: base,
          tipColor: tip,
          edgeColor: lighten(tip, 0.12),
        },
        { x: px, y, z: pz, azimuth: a + 0.32 - p * 0.64, lean: 0.5 },
      );
    }
    for (let p = 0; p < 2; p += 1) {
      placePetal(
        parts,
        {
          length: 0.02 * size,
          width: 0.012 * size,
          bend: 0.008,
          cup: 0.85,
          tipCurl: 0.008,
          tipShape: 0.45,
          segmentsU: 2,
          segmentsV: 6,
          baseColor: mixRgb(base, lip, 0.4),
          tipColor: lip,
        },
        { x: px, y: y - 0.007, z: pz, azimuth: a + 0.36 - p * 0.72, lean: 1.15 },
      );
    }
    dot(parts, 0.0042 * size, throat, [px, y + 0.004, pz], [1, 1, 1], 5);
  }

  // 顶端小花苞。
  for (let p = 0; p < 2; p += 1) {
    placePetal(parts, tinyPetal(0.014, 0.008, mixRgb(GREEN, tip, 0.4), tip, 1.1), {
      y: 0.408,
      azimuth: p * Math.PI,
      lean: 0.3,
    });
  }
  dot(parts, 0.0035, mixRgb(GREEN, tip, 0.4), [0, 0.412, 0], [1, 1.2, 1], 5);

  leaf(parts, { y: -0.02, azimuth: 1.1, lean: 1.05, roll: 0.1 }, 0.05, 0.012);
  leaf(parts, { y: 0.06, azimuth: 4.1, lean: 1.1, roll: -0.12 }, 0.045, 0.01);
  leaf(parts, { y: 0.14, azimuth: 5.6, lean: 0.95, roll: 0.1 }, 0.04, 0.009);

  return { geometry: mergeParts(parts), headHeight: 0.43, roughness: 0.84 };
}

/** 素材 A 的 16 种花材：键名与 catalog 的 procedural 键一一对应。 */
export const SPECIES_A: Record<string, (color: RGB) => BuiltFlower> = {
  peony: buildPeony,
  'herbaceous-peony': buildHerbaceousPeony,
  carnation: buildCarnation,
  lily: buildLily,
  sunflower: buildSunflower,
  dahlia: buildDahlia,
  calla: buildCalla,
  lisianthus: buildLisianthus,
  alstroemeria: buildAlstroemeria,
  'spray-chrysanthemum': buildSprayChrysanthemum,
  'babys-breath': buildBabysBreath,
  statice: buildStatice,
  waxflower: buildWaxflower,
  'rice-flower': buildRiceFlower,
  veronica: buildVeronica,
  snapdragon: buildSnapdragon,
};
