/** 郁金香占位花：收拢的杯形花头、细长花茎和两片弯叶。 */

import * as THREE from 'three';
import { darken, desaturate, hexToRgb, lighten, mixRgb, type RGB } from '../../data/color';
import { createSphere, createTube, mergeParts, placePetal } from './geometryUtils';

const GREEN = hexToRgb('#68804f');
const LEAF_DARK = hexToRgb('#4c663a');
const LEAF_LIGHT = hexToRgb('#7d9459');

export interface BuiltFlower {
  geometry: THREE.BufferGeometry;
  headHeight: number;
  roughness: number;
}

export function buildTulip(flowerColor: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const petalTip = darken(desaturate(flowerColor, 0.01), 0.02);
  const petalBase = lighten(flowerColor, 0.14);
  const petalEdge = lighten(flowerColor, 0.18);
  const petalInner = darken(flowerColor, 0.1);

  // 花茎：从握点下方一直伸到花托。
  parts.push(
    createTube(
      [
        [0, -0.24, 0],
        [0.004, -0.12, 0.002],
        [0, 0, 0],
        [-0.003, 0.15, 0.002],
        [0, 0.29, 0],
      ],
      0.0034,
      GREEN,
      20,
      5,
    ),
  );

  // 两片细长叶子，从茎的中下部向外弯。
  placePetal(
    parts,
    {
      length: 0.095,
      width: 0.014,
      bend: 0.042,
      cup: 0.6,
      tipCurl: 0.02,
      tipShape: 0.55,
      segmentsU: 3,
      segmentsV: 9,
      baseColor: darken(LEAF_DARK, 0.05),
      tipColor: LEAF_LIGHT,
    },
    { y: -0.086, azimuth: 0.6, lean: 0.78, roll: 0.16 },
  );
  placePetal(
    parts,
    {
      length: 0.08,
      width: 0.012,
      bend: 0.032,
      cup: 0.55,
      tipCurl: 0.018,
      tipShape: 0.55,
      segmentsU: 3,
      segmentsV: 8,
      baseColor: darken(LEAF_DARK, 0.1),
      tipColor: mixRgb(LEAF_LIGHT, LEAF_DARK, 0.3),
    },
    { y: -0.024, azimuth: 3.6, lean: 0.95, roll: -0.14 },
  );

  // 外层三片 + 内层三片：大杯形，花心收口。
  for (let i = 0; i < 3; i += 1) {
    placePetal(
      parts,
      {
        length: 0.1,
        width: 0.036,
        bend: 0.014,
        cup: 0.85,
        tipCurl: 0.012,
        tipShape: 0.48,
        segmentsU: 7,
        segmentsV: 12,
        baseColor: petalBase,
        tipColor: petalTip,
        edgeColor: petalEdge,
        twist: 0.0015,
      },
      { y: 0.286, azimuth: (i / 3) * Math.PI * 2, lean: 0.24 },
    );
  }
  for (let i = 0; i < 3; i += 1) {
    placePetal(
      parts,
      {
        length: 0.094,
        width: 0.033,
        bend: 0.008,
        cup: 0.95,
        tipCurl: 0.006,
        tipShape: 0.46,
        segmentsU: 6,
        segmentsV: 10,
        baseColor: mixRgb(petalBase, petalInner, 0.35),
        tipColor: mixRgb(petalTip, petalInner, 0.22),
        edgeColor: lighten(petalEdge, 0.05),
      },
      { y: 0.295, azimuth: ((i + 0.5) / 3) * Math.PI * 2, lean: 0.1 },
    );
  }

  // 花心里的一小段花蕊，挡住花瓣根部的空隙。
  parts.push(createSphere(0.012, darken(petalInner, 0.25), [0, 0.302, 0], [1, 1.35, 1]));

  return {
    geometry: mergeParts(parts),
    headHeight: 0.392,
    roughness: 0.68,
  };
}
