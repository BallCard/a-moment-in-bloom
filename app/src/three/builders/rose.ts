/** 玫瑰占位花：四层花瓣由外向内收拢，配花萼和两片叶子。 */

import * as THREE from 'three';
import { darken, desaturate, hexToRgb, lighten, mixRgb, type RGB } from '../../data/color';
import { createSphere, createTube, mergeParts, placePetal } from './geometryUtils';
import type { BuiltFlower } from './tulip';

const GREEN = hexToRgb('#5f7c4b');
const LEAF_DARK = hexToRgb('#47643a');
const LEAF_LIGHT = hexToRgb('#7a9457');

export function buildRose(flowerColor: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const petalTip = desaturate(flowerColor, 0.02);
  const petalBase = lighten(flowerColor, 0.2);
  const petalInner = darken(flowerColor, 0.12);

  // 花茎。
  parts.push(
    createTube(
      [
        [-0.004, -0.24, 0],
        [0.003, -0.12, 0.004],
        [0, 0, 0],
        [0.002, 0.16, 0],
        [0, 0.288, 0],
      ],
      0.0038,
      GREEN,
      20,
      5,
    ),
  );

  // 茎上的两片叶子。
  placePetal(
    parts,
    {
      length: 0.068,
      width: 0.016,
      bend: 0.028,
      cup: 0.65,
      tipCurl: 0.014,
      tipShape: 0.62,
      segmentsU: 3,
      segmentsV: 7,
      baseColor: LEAF_DARK,
      tipColor: LEAF_LIGHT,
    },
    { y: 0.02, azimuth: 1.3, lean: 0.95, roll: 0.14 },
  );
  placePetal(
    parts,
    {
      length: 0.056,
      width: 0.013,
      bend: 0.022,
      cup: 0.6,
      tipCurl: 0.01,
      tipShape: 0.62,
      segmentsU: 3,
      segmentsV: 7,
      baseColor: darken(LEAF_DARK, 0.08),
      tipColor: mixRgb(LEAF_LIGHT, LEAF_DARK, 0.24),
    },
    { y: 0.1, azimuth: 4.35, lean: 1.05, roll: -0.16 },
  );

  // 花萼：五片向下翻的绿色小瓣。
  for (let i = 0; i < 5; i += 1) {
    placePetal(
      parts,
      {
        length: 0.05,
        width: 0.014,
        bend: -0.006,
        tipShape: 0.32,
        segmentsU: 2,
        segmentsV: 5,
        baseColor: darken(GREEN, 0.12),
        tipColor: mixRgb(GREEN, LEAF_LIGHT, 0.3),
      },
      { y: 0.284, azimuth: (i / 5) * Math.PI * 2 + 0.4, lean: 1.92, roll: 0.1 },
    );
  }
  parts.push(createSphere(0.018, darken(GREEN, 0.08), [0, 0.286, 0], [1, 0.85, 1]));

  // 四层花瓣：外层半张、内层收紧，形成玫瑰的螺旋花心。
  const layers = [
    { count: 6, length: 0.09, width: 0.052, lean: 1.18, baseY: 0.29, tipShape: 0.56, offset: 0, bend: 0.024 },
    { count: 5, length: 0.078, width: 0.044, lean: 0.82, baseY: 0.296, tipShape: 0.56, offset: (Math.PI * 2) / 10, bend: 0.02 },
    { count: 5, length: 0.062, width: 0.034, lean: 0.48, baseY: 0.302, tipShape: 0.54, offset: (Math.PI * 2) / 5, bend: 0.016 },
    { count: 4, length: 0.044, width: 0.024, lean: 0.16, baseY: 0.308, tipShape: 0.52, offset: 0.35, bend: 0.012 },
  ];

  layers.forEach((layer, index) => {
    const layerTip =
      index === 0 ? lighten(petalTip, 0.08) : index === 3 ? darken(petalTip, 0.14) : petalTip;
    const layerBase = mixRgb(petalBase, layerTip, index * 0.1);
    for (let i = 0; i < layer.count; i += 1) {
      placePetal(
        parts,
        {
          length: layer.length,
          width: layer.width,
          bend: layer.bend,
          cup: 0.62,
          tipCurl: 0.012,
          tipShape: layer.tipShape,
          segmentsU: 7,
          segmentsV: 11,
          baseColor: layerBase,
          tipColor: layerTip,
          edgeColor: lighten(layerTip, 0.08),
          twist: 0.0015,
        },
        { y: layer.baseY, azimuth: layer.offset + (i / layer.count) * Math.PI * 2, lean: layer.lean },
      );
    }
  });

  parts.push(createSphere(0.017, darken(petalInner, 0.2), [0, 0.315, 0], [1, 0.95, 1]));

  return {
    geometry: mergeParts(parts),
    headHeight: 0.36,
    roughness: 0.66,
  };
}
