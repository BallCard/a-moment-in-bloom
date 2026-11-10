/** 尤加利占位叶材：一根微弯主茎、三条侧枝和一圈细碎圆叶。 */

import * as THREE from 'three';
import { darken, desaturate, hexToRgb, mixRgb, type RGB } from '../../data/color';
import type { Vec3 } from '../../data/types';
import { createTube, mergeParts, placePetal, toVec3 } from './geometryUtils';
import type { BuiltFlower } from './tulip';

const STEM = hexToRgb('#8d8768');

export function buildEucalyptus(leafColor: RGB): BuiltFlower {
  const parts: THREE.BufferGeometry[] = [];
  const leafTip = mixRgb(desaturate(leafColor, 0.05), hexToRgb('#6f8a5d'), 0.42);
  const leafBase = darken(mixRgb(leafTip, [0.38, 0.46, 0.34], 0.45), 0.04);

  const stemPoints: Vec3[] = [
    [0, -0.24, 0],
    [0.008, -0.1, 0.004],
    [0, 0.04, 0],
    [-0.01, 0.2, -0.005],
    [0.006, 0.34, 0],
    [0.02, 0.44, 0.012],
  ];
  const stemCurve = new THREE.CatmullRomCurve3(
    stemPoints.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
  );
  parts.push(createTube(stemPoints, 0.0028, STEM, 22, 5));

  const leafOptions = {
    length: 0.052,
    width: 0.014,
    bend: 0.02,
    cup: 0.7,
    tipCurl: 0.007,
    tipShape: 0.5,
    segmentsU: 3,
    segmentsV: 7,
    baseColor: leafBase,
    tipColor: leafTip,
  };

  // 主茎上的叶子，按黄金角错开，形成细长的叶串。
  const mainLeafCount = 6;
  for (let i = 0; i < mainLeafCount; i += 1) {
    const t = 0.5 + (i / (mainLeafCount - 1)) * 0.46;
    const point = stemCurve.getPoint(t);
    const azimuth = i * 2.39996;
    const lean = 1.05 + (i % 3) * 0.11;
    placePetal(parts, leafOptions, {
      x: point.x,
      y: point.y,
      z: point.z,
      azimuth,
      lean,
      roll: ((i % 3) - 1) * 0.18,
    });
  }

  // 三条侧枝，枝上再长小叶子。
  for (let b = 0; b < 3; b += 1) {
    const start = stemCurve.getPoint(0.5 + b * 0.13);
    const azimuth = 1.1 + b * 2.15;
    const direction = new THREE.Vector3(Math.sin(azimuth), 0, Math.cos(azimuth));
    const end = start
      .clone()
      .addScaledVector(direction, 0.12)
      .add(new THREE.Vector3(0, 0.085, 0));
    const mid = start.clone().lerp(end, 0.55).add(new THREE.Vector3(0, 0.005, 0));
    const branchCurve = new THREE.CatmullRomCurve3([start, mid, end]);
    parts.push(
      createTube([toVec3(start), toVec3(mid), toVec3(end)], 0.0022, STEM, 8, 4),
    );
    for (let i = 0; i < 3; i += 1) {
      const point = branchCurve.getPoint(0.26 + i * 0.3);
      const leafAzimuth = azimuth + (i % 2 === 0 ? 1.15 : -1.15);
      placePetal(
        parts,
        { ...leafOptions, length: 0.042, width: 0.012 },
        {
          x: point.x,
          y: point.y,
          z: point.z,
          azimuth: leafAzimuth,
          lean: 1.0 + i * 0.1,
          roll: ((i % 2) - 0.5) * 0.2,
        },
      );
    }
  }

  // 顶端一小簇，让叶材有个柔软收尖。
  const top = stemCurve.getPoint(1);
  for (let i = 0; i < 2; i += 1) {
    placePetal(
      parts,
      { ...leafOptions, length: 0.044, width: 0.013 },
      {
        x: top.x,
        y: top.y,
        z: top.z,
        azimuth: i * 2.1 + 0.4,
        lean: 0.75 + i * 0.16,
      },
    );
  }

  return {
    geometry: mergeParts(parts),
    headHeight: 0.44,
    roughness: 0.8,
  };
}
