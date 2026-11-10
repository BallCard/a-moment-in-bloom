/** 程序化花材的几何构造工具：花瓣曲面、茎管、球体、合并与顶点着色。 */

import * as THREE from 'three';
import { mixRgb, type RGB } from '../../data/color';
import type { Vec3 } from '../../data/types';

export const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export interface PetalOptions {
  length: number;
  /** 最大半宽（米）。 */
  width: number;
  /** 沿长度方向的弯曲量（米，正值向 +Z 卷）。 */
  bend?: number;
  /** 横向凹/凸，让花瓣有杯形截面。 */
  cup?: number;
  /** 尖端额外外翻。 */
  tipCurl?: number;
  /** 尖端收窄指数：0.25 圆钝，0.8 尖细。 */
  tipShape?: number;
  segmentsU?: number;
  segmentsV?: number;
  baseColor: RGB;
  tipColor: RGB;
  edgeColor?: RGB;
  /** 轻微不对称，让花瓣不呆板。 */
  twist?: number;
}

/**
 * 生成一张弯曲的花瓣片。
 * 局部坐标：花瓣由原点沿 +Y 生长，正面朝 +Z；调用方再按方位角/倾斜角摆放。
 */
export function createPetalGeometry(options: PetalOptions): THREE.BufferGeometry {
  const length = Math.max(0.005, options.length);
  const width = Math.max(0.002, options.width);
  const bend = options.bend ?? 0.01;
  const cup = options.cup ?? 0;
  const tipCurl = options.tipCurl ?? 0;
  const tipShape = Math.max(0.12, options.tipShape ?? 0.45);
  const segmentsU = Math.max(2, Math.round(options.segmentsU ?? 4));
  const segmentsV = Math.max(2, Math.round(options.segmentsV ?? 8));
  const twist = options.twist ?? 0;

  // 归一化宽度轮廓：v=0 收在花心，v=1 收在花瓣尖，tipShape 控制尖端的圆钝程度。
  const peakV = 0.5 / (0.5 + tipShape);
  const peak = Math.pow(peakV, 0.5) * Math.pow(1 - peakV, tipShape);

  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];

  for (let j = 0; j <= segmentsV; j += 1) {
    const v = j / segmentsV;
    const widthProfile = (Math.pow(v, 0.5) * Math.pow(1 - v, tipShape)) / peak;
    for (let i = 0; i <= segmentsU; i += 1) {
      const u = -1 + (2 * i) / segmentsU;
      const halfWidth = width * widthProfile;
      const x = u * halfWidth + twist * u * u * v * Math.sign(u || 1);
      const y = length * v;
      const z =
        bend * v * v -
        cup * width * (u * u - 0.35) * (1 - 0.3 * v) +
        tipCurl * Math.pow(v, 4) * Math.abs(u);
      positions.push(x, y, z);

      const gradient = smoothstep(0.04, 0.9, v);
      let color = mixRgb(options.baseColor, options.tipColor, gradient);
      if (options.edgeColor) {
        const edge = smoothstep(0.4, 1, Math.abs(u)) * smoothstep(0.12, 0.75, v);
        color = mixRgb(color, options.edgeColor, edge * 0.3);
      }
      colors.push(color[0], color[1], color[2]);
      uvs.push((u + 1) / 2, v);
    }
  }

  const indices: number[] = [];
  for (let j = 0; j < segmentsV; j += 1) {
    for (let i = 0; i < segmentsU; i += 1) {
      const a = j * (segmentsU + 1) + i;
      const b = a + 1;
      const c = a + segmentsU + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export interface PetalPlacement {
  /** 花瓣根部的高度（米）。 */
  y: number;
  /** 绕茎轴的方位角（弧度）。 */
  azimuth: number;
  /** 相对竖直方向的倾斜角（弧度）。 */
  lean: number;
  roll?: number;
  x?: number;
  z?: number;
  scale?: number;
}

/** 生成花瓣并摆放到花头上的指定位置。 */
export function placePetal(
  parts: THREE.BufferGeometry[],
  options: PetalOptions,
  placement: PetalPlacement,
): void {
  const geometry = createPetalGeometry(options);
  const matrix = new THREE.Matrix4().makeTranslation(
    placement.x ?? 0,
    placement.y,
    placement.z ?? 0,
  );
  const rotation = new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(placement.lean, placement.azimuth, placement.roll ?? 0, 'YXZ'),
  );
  matrix.multiply(rotation);
  if (placement.scale && placement.scale !== 1) {
    matrix.multiply(new THREE.Matrix4().makeScale(placement.scale, placement.scale, placement.scale));
  }
  geometry.applyMatrix4(matrix);
  parts.push(geometry);
}

/** 把整段几何刷成同一种顶点色。 */
export function applyColor(geometry: THREE.BufferGeometry, color: RGB): THREE.BufferGeometry {
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    colors[i * 3] = color[0];
    colors[i * 3 + 1] = color[1];
    colors[i * 3 + 2] = color[2];
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** 沿曲线生成一根细茎/枝条。 */
export function createTube(
  points: Vec3[],
  radius: number,
  color: RGB,
  tubularSegments = 14,
  radialSegments = 5,
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
  const geometry = new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false);
  return applyColor(geometry, color);
}

/** 小型球体，用作花心、花托。 */
export function createSphere(
  radius: number,
  color: RGB,
  position: Vec3,
  scale: Vec3 = [1, 1, 1],
  segments = 10,
): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(radius, segments, Math.max(6, segments - 2));
  geometry.scale(scale[0], scale[1], scale[2]);
  geometry.translate(position[0], position[1], position[2]);
  return applyColor(geometry, color);
}

/**
 * 合并多个几何体为一份，便于一枝花只占一次 draw call。
 * 合并前统一转成非索引几何，并保证 position/normal/color 三个属性齐全。
 */
export function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];

  for (const part of parts) {
    const geometry = part.index ? part.toNonIndexed() : part;
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const color = geometry.getAttribute('color');
    for (let i = 0; i < position.count; i += 1) {
      positions.push(position.getX(i), position.getY(i), position.getZ(i));
      normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
      if (color) {
        colors.push(color.getX(i), color.getY(i), color.getZ(i));
      } else {
        colors.push(1, 1, 1);
      }
    }
    if (geometry !== part) geometry.dispose();
    part.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

export function toVec3(vector: THREE.Vector3): Vec3 {
  return [vector.x, vector.y, vector.z];
}
