/** 程序化占位花构建入口：按 ProceduralKey + 主色生成合并几何和材质。 */

import * as THREE from 'three';
import { hexToRgb, type RGB } from '../../data/color';
import type { ProceduralKey } from '../../data/types';
import { buildEucalyptus } from './eucalyptus';
import { buildExtension } from './extensions';
import { buildRose } from './rose';
import { SPECIES_A } from './species-a';
import { SPECIES_B } from './species-b';
import { SPECIES_C } from './species-c';
import { buildTulip, type BuiltFlower } from './tulip';

export interface BuiltProcedural {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  headHeight: number;
}

function buildFlower(procedural: ProceduralKey, flowerColor: RGB): BuiltFlower {
  switch (procedural) {
    case 'spray': case 'daisy': return buildExtension(procedural,flowerColor);
    case 'rose':
      return buildRose(flowerColor);
    case 'eucalyptus':
      return buildEucalyptus(flowerColor);
    case 'tulip':
    default:
      // V0.7 §5：扩充花材先查新几何库，没有的再退回郁金香占位，保证永不空白。
      // V16 §2：SPECIES_C 是本轮新增的两个程序化占位花型（绣球/蝴蝶兰）。
      return SPECIES_A[procedural]?.(flowerColor) ?? SPECIES_B[procedural]?.(flowerColor) ?? SPECIES_C[procedural]?.(flowerColor) ?? buildTulip(flowerColor);
  }
}

export function buildProceduralAsset(procedural: ProceduralKey, colorHex: string): BuiltProcedural {
  const color = hexToRgb(colorHex);
  const built = buildFlower(procedural, color);
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    roughness: built.roughness,
    metalness: 0,
  });
  material.name = `proc-${procedural}`;
  return { geometry: built.geometry, material, headHeight: built.headHeight };
}
