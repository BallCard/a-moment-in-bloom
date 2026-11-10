/**
 * V16 §2 素材 C：绣球与蝴蝶兰两种程序化几何（加载失败兜底）。
 *
 * 说明（必须如实标注）：
 * - 2026-11-10 起这两种花材已有 Lux3D 真实模型（manifest 指向 lux-hydrangea.glb /
 *   lux-orchid.glb）；这里的几何只在真实 GLB 加载失败时兜底，正常路径不会用到。
 * - 与 species-a / species-b 同一套约定：主茎从 y≈-0.22 起、顶点色一次写死、
 *   返回与 rose / tulip 同形状的 `BuiltFlower`；单枝压在 4000 三角面以内。
 * - 花材架缩略图走真实 GLB 渲染；兜底几何不冒充真实模型。
 */

import * as THREE from 'three';
import { darken, desaturate, hexToRgb, lighten, mixRgb, type RGB } from '../../data/color';
import type { Vec3 } from '../../data/types';
import {
  createPetalGeometry,
  createSphere,
  createTube,
  mergeParts,
  placePetal,
  type PetalOptions,
} from './geometryUtils';
import type { BuiltFlower } from './tulip';

const TAU = Math.PI * 2;
/** 统一种茎草绿（与 species-a 一致）。 */
const GREEN = hexToRgb('#536d43');
const STEM_DARK = hexToRgb('#4f6b3f');
const LEAF_DARK = hexToRgb('#4a6138');
const LEAF_LIGHT = hexToRgb('#7d9459');

/** 主茎：握点下方 0.22 米伸到花托，带一点手作弧线。 */
function stem(parts: THREE.BufferGeometry[], top: Vec3, radius = 0.004): void {
  parts.push(
    createTube(
      [
        [-0.003, -0.22, 0],
        [0.003, -0.1, 0.002],
        [0, 0, 0],
        [(top[0] ?? 0) * 0.45, top[1] * 0.5, top[2] * 0.5],
        top,
      ],
      radius,
      GREEN,
      16,
      5,
    ),
  );
}

/** 一片叶/花被片：位置与朝向交给 placePetal。 */
function leaf(
  parts: THREE.BufferGeometry[],
  placement: { y: number; x?: number; z?: number; azimuth: number; lean: number; roll?: number },
  length: number,
  width: number,
  baseColor: RGB = LEAF_DARK,
  tipColor: RGB = LEAF_LIGHT,
  cup = 0.5,
): void {
  placePetal(
    parts,
    {
      length,
      width,
      bend: length * 0.34,
      cup,
      tipCurl: length * 0.1,
      tipShape: 0.62,
      segmentsU: 3,
      segmentsV: 6,
      baseColor,
      tipColor,
    },
    placement,
  );
}

/**
 * 绣球：圆顶状花球由几十朵四瓣小花拼出来。
 *
 * 每朵小花在局部 XY 平面里由 4 片圆钝小花被片组成，再整体转到花球表面
 * 的法线方向——所以是「一圈小花开在球面上」，不是把大花瓣铺满。
 * 花球中心放一颗深色芯，挡住小花之间的缝。
 */
function buildHydrangea(color: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const petalBase = lighten(color, 0.16);
  const petalTip = mixRgb(color, [1, 1, 1], 0.06);
  const petalEdge = lighten(color, 0.26);
  const core = darken(desaturate(color, 0.22), 0.3);

  stem(parts, [0.004, 0.3, 0.002], 0.0052);
  leaf(parts, { y: -0.04, x: 0.004, azimuth: 1.15, lean: 1.12, roll: 0.14 }, 0.085, 0.032, LEAF_DARK, LEAF_LIGHT, 0.6);
  leaf(parts, { y: 0.02, x: -0.004, azimuth: 4.2, lean: 1.2, roll: -0.16 }, 0.072, 0.026, LEAF_DARK, LEAF_LIGHT, 0.6);

  // 花球：球心略低于茎顶，半径按「花头直径 ≈ 0.15m」定，放大后接近真实绣球体量。
  const centerY = 0.318;
  const radius = 0.074;
  const floretPetal: PetalOptions = {
    length: 0.019,
    width: 0.014,
    bend: 0.003,
    cup: 0.3,
    tipCurl: 0.002,
    tipShape: 0.66,
    segmentsU: 2,
    segmentsV: 3,
    baseColor: petalBase,
    tipColor: petalTip,
    edgeColor: petalEdge,
  };

  // 花球中心：一颗低模深色球，藏住花与花之间的空隙。
  parts.push(createSphere(radius * 0.82, core, [0, centerY, 0], [1, 0.95, 1], 10));

  const florets = 54;
  const normal = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const bloom = new THREE.Matrix4();
  const spin = new THREE.Matrix4();
  const forward = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i < florets; i += 1) {
    // 球面均匀取点（黄金角螺旋）；只取上半球到赤道下方一点，下半被花球自己挡住。
    const y = 1 - 1.55 * ((i + 0.5) / florets);
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = i * 2.39996;
    normal.set(Math.cos(angle) * ring, y, Math.sin(angle) * ring).normalize();
    const point = new THREE.Vector3(
      normal.x * radius,
      centerY + normal.y * radius,
      normal.z * radius,
    );
    quaternion.setFromUnitVectors(forward, normal);
    bloom.makeRotationFromQuaternion(quaternion);
    bloom.setPosition(point);
    // 每朵小花大小略有差异，避免球面像规则网格。
    const scale = 0.86 + ((i * 37) % 9) * 0.035;
    for (let p = 0; p < 4; p += 1) {
      const petal = createPetalGeometry(floretPetal);
      spin.makeRotationZ((p / 4) * TAU + (i % 5) * 0.09);
      petal.applyMatrix4(spin);
      petal.applyMatrix4(new THREE.Matrix4().makeScale(scale, scale, scale));
      petal.applyMatrix4(bloom);
      parts.push(petal);
    }
    // 花心：多数是能育花的小点；用同一颗芯色，省掉每朵一个球。
    if (i % 3 === 0) {
      parts.push(createSphere(0.0032, core, [point.x, point.y, point.z], [1, 1, 1], 5));
    }
  }

  return { geometry: mergeParts(parts), headHeight: 0.38, roughness: 0.82 };
}

/**
 * 蝴蝶兰：一根微拱的花茎上依次开三朵平展的花，顶端留一个花苞。
 *
 * 单朵在局部先按「朝 +Y 开口」搭（3 枚萼片 + 2 枚宽侧瓣 + 唇瓣 + 蕊柱），
 * 再整体转 90° 让花朝 +Z（正对镜头）；三朵沿茎的高低与朝向略作变化。
 */
function buildOrchid(color: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const petalBase = lighten(color, 0.18);
  const petalTip = desaturate(color, 0.04);
  const lipColor = mixRgb(darken(desaturate(color, 0.06), 0.2), hexToRgb('#e0b366'), 0.26);
  const throat = mixRgb(lipColor, hexToRgb('#f4e6b4'), 0.45);

  // 花茎：略带弧度，花从下半段一路开到顶端。
  const stemPoints: Vec3[] = [
    [-0.003, -0.22, 0],
    [0.003, -0.1, 0],
    [0, 0.02, 0],
    [0.008, 0.14, 0.004],
    [0.018, 0.25, 0.008],
    [0.026, 0.35, 0.012],
  ];
  parts.push(createTube(stemPoints, 0.0042, STEM_DARK, 20, 5));

  // 基部两片厚实的宽带叶，这是蝴蝶兰最认得出来的部分。
  leaf(parts, { y: -0.03, x: 0.004, azimuth: 1.05, lean: 1.28, roll: 0.12 }, 0.125, 0.046, darken(LEAF_DARK, 0.04), mixRgb(LEAF_DARK, LEAF_LIGHT, 0.45), 0.42);
  leaf(parts, { y: 0.03, x: -0.004, azimuth: 4.35, lean: 1.32, roll: -0.12 }, 0.108, 0.04, darken(LEAF_DARK, 0.04), mixRgb(LEAF_DARK, LEAF_LIGHT, 0.45), 0.42);

  /** 一朵花：局部坐标朝 +Y，返回合并好的一份几何（未变换）。 */
  const bloomGeometry = (): THREE.BufferGeometry => {
    const petals: THREE.BufferGeometry[] = [];
    const outward = (length: number, width: number, cup: number): PetalOptions => ({
      length,
      width,
      bend: length * 0.08,
      cup,
      tipCurl: 0.0015,
      tipShape: 0.5,
      segmentsU: 4,
      segmentsV: 6,
      baseColor: petalBase,
      tipColor: petalTip,
      edgeColor: lighten(petalTip, 0.12),
    });

    // 2 枚宽侧瓣：向两侧摊平，瓣缘带一点波纹。
    placePetal(petals, outward(0.036, 0.027, 0.2), { y: 0, azimuth: Math.PI / 2, lean: 1.32 });
    placePetal(petals, outward(0.036, 0.027, 0.2), { y: 0, azimuth: -Math.PI / 2, lean: 1.32 });
    // 背萼（上方一片）与 2 枚侧下萼。
    placePetal(petals, outward(0.03, 0.015, 0.3), { y: 0, azimuth: 0, lean: 0.34 });
    placePetal(petals, outward(0.028, 0.016, 0.3), { y: 0, azimuth: Math.PI - 0.42, lean: 1.0 });
    placePetal(petals, outward(0.028, 0.016, 0.3), { y: 0, azimuth: Math.PI + 0.42, lean: 1.0 });
    // 唇瓣：短而卷，颜色更深一点，是蝴蝶兰的辨认点。
    placePetal(
      petals,
      {
        length: 0.019,
        width: 0.014,
        bend: 0.006,
        cup: 0.9,
        tipCurl: 0.004,
        tipShape: 0.42,
        segmentsU: 4,
        segmentsV: 5,
        baseColor: darken(lipColor, 0.12),
        tipColor: lipColor,
        edgeColor: throat,
      },
      { y: 0.001, azimuth: Math.PI, lean: 1.34 },
    );
    // 蕊柱：花心一颗米黄小柱。
    petals.push(createSphere(0.0062, throat, [0, 0.006, 0.002], [1.3, 1, 1], 6));
    return mergeParts(petals);
  };

  // 三朵盛开 + 顶端一个花苞，由下往上依次变小、朝向略偏。
  const blooms: { at: Vec3; scale: number; yaw: number; pitch: number }[] = [
    { at: [0.008, 0.15, 0.012], scale: 1, yaw: -0.18, pitch: 0.12 },
    { at: [0.016, 0.235, 0.008], scale: 0.96, yaw: 0.05, pitch: 0.04 },
    { at: [0.022, 0.31, 0.004], scale: 0.88, yaw: -0.06, pitch: -0.02 },
  ];
  for (const bloom of blooms) {
    const geometry = bloomGeometry();
    const matrix = new THREE.Matrix4().makeTranslation(bloom.at[0], bloom.at[1], bloom.at[2]);
    matrix.multiply(new THREE.Matrix4().makeRotationY(bloom.yaw));
    matrix.multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2 + bloom.pitch));
    matrix.multiply(new THREE.Matrix4().makeScale(bloom.scale, bloom.scale, bloom.scale));
    geometry.applyMatrix4(matrix);
    parts.push(geometry);
    // 花与主茎之间的一小段花梗。
    placePetal(
      parts,
      {
        length: 0.012,
        width: 0.0022,
        bend: 0.004,
        tipShape: 0.5,
        segmentsU: 2,
        segmentsV: 2,
        baseColor: LEAF_DARK,
        tipColor: LEAF_DARK,
      },
      { y: bloom.at[1] - 0.03, x: 0, azimuth: Math.PI / 2, lean: 1.1 },
    );
  }

  // 顶端花苞：闭合的小纺锤。
  parts.push(
    createSphere(0.012, mixRgb(petalBase, LEAF_LIGHT, 0.2), [0.027, 0.372, 0.012], [0.72, 1.5, 0.72], 7),
  );

  return { geometry: mergeParts(parts), headHeight: 0.4, roughness: 0.76 };
}

/**
 * 两种新增花型：键名与 data/types.ts 的 ProceduralKey 一致。
 *
 * 接入方式（builders/index.ts，由主线统一接线）：
 * `SPECIES_A[key] ?? SPECIES_B[key] ?? SPECIES_C[key] ?? buildTulip(...)`，
 * 这样新键不会掉回郁金香兜底。
 */
export const SPECIES_C: Record<string, (color: RGB) => BuiltFlower> = {
  hydrangea: buildHydrangea,
  orchid: buildOrchid,
};
