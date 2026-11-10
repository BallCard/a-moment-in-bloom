/**
 * 辅助装饰的三维外观（V16 §5）——纯 three.js，不读取 store。
 *
 * 数据与规则在 `data/ornaments.ts`、`data/decor-capability.ts`；场景只负责
 * 「把文档里的装饰实例画出来」。做法：
 * - 每件装饰一个 Group，位置/旋转/大小直接取实例字段（position 是花束坐标，米）；
 * - 灯串与串饰的几何按当前作品轮廓半径生成，半径变了才重建；
 * - 换款式/颜色/绕行样式（结构键）重建；只改亮度/位置/旋转/大小则原地更新；
 * - 能力表不允许的装饰不渲染（换容器后不遗留悬空装饰）；
 * - 换装饰或删装饰时逐个 dispose 几何与材质，不泄漏。
 *
 * 灯饰亮度用 emissive + 半透明加法混合光晕，小光点不刺眼，也不依赖后处理 bloom。
 *
 * 场景接线（由 BouquetScene 调用）：
 * ```ts
 * this.ornaments = createOrnaments();
 * this.scene.add(this.ornaments);
 * syncOrnaments(this.ornaments, doc.ornaments, { radius, kind: doc.presentation.kind });
 * ```
 * dispose 场景时调 `disposeOrnaments(this.ornaments)`。
 */

import * as THREE from 'three';
import { filterOrnamentsFor } from '../../data/decor-capability';
import { ornamentColor, ornamentDef } from '../../data/ornaments';
import type { PresentationKind } from '../../data/presentation';
import type { OrnamentInstance, OrnamentKind, Vec3 } from '../../data/types';

/** 场景传给装饰模块的上下文。 */
export interface OrnamentContext {
  /** 当前作品轮廓半径（花束包络，米）。灯串/串饰按它绕行、垂挂。 */
  radius: number;
  /** 当前呈现形态，用来过滤能力表不允许的装饰。 */
  kind: PresentationKind;
}

/** 单件装饰的渲染状态（验证脚本读取）。 */
export interface OrnamentDebugItem {
  id: string;
  kind: OrnamentKind;
  exists: boolean;
  visible: boolean;
  position: [number, number, number];
  rotation: number;
  scale: number;
  colorId: string;
  variant: number;
  /** 灯饰的 emissive 强度；非灯饰为 null。 */
  emissive: number | null;
  /** 灯串光点数量；非灯饰为 0。 */
  bulbs: number;
}

/** 整个装饰层的渲染状态（验证脚本读取）。 */
export interface OrnamentDebug {
  count: number;
  visible: boolean;
  kinds: OrnamentKind[];
  /** 被能力表过滤、没有渲染的装饰 id（换容器后旧装饰会出现在这里）。 */
  skipped: string[];
  items: OrnamentDebugItem[];
}

interface OrnamentEntry {
  /** 结构键：款式/颜色/绕行样式/轮廓半径，变了就重建。 */
  key: string;
  root: THREE.Group;
  apply: (ornament: OrnamentInstance) => void;
  dispose: () => void;
  bulbs: number;
  emissive: (() => number) | null;
}

const WHITE = new THREE.Color('#fffaf0');
const MIN_RADIUS = 0.055;
const MAX_RADIUS = 0.21;

function clampRadius(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0.1;
  return Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, value));
}

function deg(value: number): number {
  return (value * Math.PI) / 180;
}

function colorOf(ornament: OrnamentInstance): THREE.Color {
  return new THREE.Color(ornamentColor(ornament.colorId).color);
}

function structuralKey(ornament: OrnamentInstance, ctx: OrnamentContext): string {
  const def = ornamentDef(ornament.kind);
  const radiusBucket = def.group === 'lights' || def.group === 'strands'
    ? (Math.round(clampRadius(ctx.radius) * 200) / 200).toFixed(3)
    : 'x';
  return `${ornament.kind}|${ornament.colorId}|${ornament.variant}|${radiusBucket}`;
}

function disposeTree(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((item) => materials.add(item));
    else if (material) materials.add(material);
  });
  materials.forEach((material) => material.dispose());
  root.clear();
}

function markMeshes(root: THREE.Object3D): void {
  // 装饰是小件：投影收益小、开销大，不参与阴影。
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
    }
  });
}

// ---------- 通用小几何 ----------

function starShape(outer: number, inner: number): THREE.Shape {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i += 1) {
    const angle = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const radius = i % 2 === 0 ? outer : inner;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

function heartShape(size: number): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(0, -size);
  shape.bezierCurveTo(size * 1.15, -size * 0.05, size * 0.82, size * 1.05, 0, size * 0.45);
  shape.bezierCurveTo(-size * 0.82, size * 1.05, -size * 1.15, -size * 0.05, 0, -size);
  return shape;
}

function roundedRectShape(width: number, height: number, radius: number): THREE.Shape {
  const w = width / 2;
  const h = height / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-w + radius, -h);
  shape.lineTo(w - radius, -h);
  shape.quadraticCurveTo(w, -h, w, -h + radius);
  shape.lineTo(w, h - radius);
  shape.quadraticCurveTo(w, h, w - radius, h);
  shape.lineTo(-w + radius, h);
  shape.quadraticCurveTo(-w, h, -w, h - radius);
  shape.lineTo(-w, -h + radius);
  shape.quadraticCurveTo(-w, -h, -w + radius, -h);
  return shape;
}

/** 沿曲线铺一串小球（珍珠）。 */
function beadInstances(
  curve: THREE.CatmullRomCurve3,
  count: number,
  radius: number,
  material: THREE.Material,
): { mesh: THREE.InstancedMesh; geometry: THREE.SphereGeometry } {
  const geometry = new THREE.SphereGeometry(radius, 10, 8);
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i += 1) {
    const t = (i + 0.5) / count;
    curve.getPointAt(Math.min(0.999, Math.max(0.001, t)), dummy.position);
    dummy.position.y -= radius * 0.2;
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return { mesh, geometry };
}

function makeFlatStripMaterial(color: THREE.Color): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.38,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
}

// ---------- 灯串 ----------

/** 灯串绕行路径：variant 0 绕一圈 / 1 斜挂 / 2 只绕一半。 */
function lightCurve(variant: number, radius: number): THREE.CatmullRomCurve3 {
  const r = clampRadius(radius) * 1.04;
  const half = variant === 2;
  const points: THREE.Vector3[] = [];
  const steps = 40;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    // 半圈样式从正前方绕到侧后方。
    const angle = half ? -Math.PI * 0.4 + Math.PI * 2 * 0.62 * t : Math.PI * 2 * t;
    const wobble = 1 + 0.05 * Math.sin(t * Math.PI * 5);
    const x = Math.cos(angle) * r * wobble;
    const z = Math.sin(angle) * r * wobble;
    const y = variant === 1 ? Math.sin(angle * 1.15) * r * 0.34 : Math.sin(t * Math.PI * 4) * 0.005;
    points.push(new THREE.Vector3(x, y, z));
  }
  return new THREE.CatmullRomCurve3(points, !half);
}

function createLights(
  ornament: OrnamentInstance,
  ctx: OrnamentContext,
): OrnamentEntry {
  const kind = ornament.kind;
  const stars = kind === 'star-lights';
  const color = colorOf(ornament);
  const root = new THREE.Group();
  root.name = `ornament-${kind}`;
  const curve = lightCurve(ornament.variant, ctx.radius);
  const wireMaterial = new THREE.MeshStandardMaterial({
    color: color.clone().multiplyScalar(0.5),
    roughness: 0.7,
    metalness: 0.1,
  });
  const wire = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 90, stars ? 0.0021 : 0.0018, 5, curve.closed),
    wireMaterial,
  );
  root.add(wire);

  const bulbs = stars ? 15 : 21;
  const coreGeometry = stars
    ? new THREE.OctahedronGeometry(0.0115, 0)
    : new THREE.SphereGeometry(0.0072, 10, 8);
  const coreMaterial = new THREE.MeshStandardMaterial({
    color: color.clone().lerp(WHITE, 0.5),
    emissive: color,
    emissiveIntensity: 0.9,
    roughness: 0.3,
    metalness: 0,
    toneMapped: false,
  });
  const haloGeometry = new THREE.SphereGeometry(stars ? 0.018 : 0.015, 12, 8);
  const haloMaterial = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.14,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const cores = new THREE.InstancedMesh(coreGeometry, coreMaterial, bulbs);
  const halos = new THREE.InstancedMesh(haloGeometry, haloMaterial, bulbs);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < bulbs; i += 1) {
    const t = (i + 0.5) / bulbs;
    curve.getPointAt(Math.min(0.999, Math.max(0.001, t)), dummy.position);
    dummy.rotation.set(i * 0.6, i * 1.1, i * 0.4);
    dummy.scale.setScalar(stars ? 0.9 + (i % 3) * 0.12 : 0.92 + (i % 4) * 0.05);
    dummy.updateMatrix();
    cores.setMatrixAt(i, dummy.matrix);
    halos.setMatrixAt(i, dummy.matrix);
  }
  cores.instanceMatrix.needsUpdate = true;
  halos.instanceMatrix.needsUpdate = true;
  root.add(cores, halos);
  markMeshes(root);

  return {
    key: structuralKey(ornament, ctx),
    root,
    bulbs,
    dispose: () => disposeTree(root),
    emissive: () => coreMaterial.emissiveIntensity,
    apply: (next) => {
      root.position.set(next.position[0], next.position[1], next.position[2]);
      root.rotation.set(0, deg(next.rotation), 0);
      root.scale.setScalar(next.scale);
      // 亮度：光点核心与光晕一起变，0 时几乎只剩暖点，不会刺眼。
      const intensity = Math.min(1, Math.max(0, next.intensity));
      coreMaterial.emissiveIntensity = 0.2 + intensity * 1.5;
      haloMaterial.opacity = 0.05 + intensity * 0.2;
    },
  };
}

// ---------- 串饰 ----------

/** 垂挂路径：variant 0 垂正面 / 1 垂侧面 / 2 绕口沿后垂下一小段。 */
function strandCurve(variant: number, radius: number): THREE.CatmullRomCurve3 {
  const r = clampRadius(radius);
  if (variant === 2) {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= 14; i += 1) {
      const t = i / 14;
      const angle = -Math.PI * 0.75 + Math.PI * 1.1 * t;
      const drop = t > 0.72 ? ((t - 0.72) / 0.28) ** 2 * 0.05 : 0;
      points.push(new THREE.Vector3(Math.cos(angle) * r * 1.02, -drop, Math.sin(angle) * r * 1.02));
    }
    return new THREE.CatmullRomCurve3(points, false);
  }
  const x = variant === 1 ? r * 0.94 : 0;
  const z = variant === 1 ? r * 0.2 : r * 0.62;
  const drift = variant === 1 ? r * 0.1 : 0.008;
  return new THREE.CatmullRomCurve3([
    new THREE.Vector3(x, 0, z),
    new THREE.Vector3(x + drift, -0.055, z + 0.012),
    new THREE.Vector3(x + drift * 0.4, -0.115, z + 0.02),
    new THREE.Vector3(x + drift * 1.2, -0.175, z + 0.012),
  ]);
}

function createStrand(ornament: OrnamentInstance, ctx: OrnamentContext): OrnamentEntry {
  const pearls = ornament.kind === 'pearl-strand';
  const color = colorOf(ornament);
  const root = new THREE.Group();
  root.name = `ornament-${ornament.kind}`;
  const curve = strandCurve(ornament.variant, ctx.radius);

  if (pearls) {
    const pearlMaterial = new THREE.MeshStandardMaterial({
      color: color.clone().lerp(WHITE, 0.25),
      roughness: 0.26,
      metalness: 0.22,
      emissive: color,
      emissiveIntensity: 0.12,
    });
    const { mesh } = beadInstances(curve, 17, 0.0074, pearlMaterial);
    root.add(mesh);
  } else {
    const threadMaterial = new THREE.MeshStandardMaterial({
      color: color.clone().multiplyScalar(0.85),
      roughness: 0.45,
      metalness: 0.18,
    });
    // 两条很细的丝线并在一起，末端各一颗小珠子。
    for (const offset of [-0.0022, 0.0022]) {
      const shifted = new THREE.CatmullRomCurve3(
        curve.points.map((point) => point.clone().setX(point.x + offset)),
        false,
      );
      root.add(new THREE.Mesh(new THREE.TubeGeometry(shifted, 40, 0.0009, 4, false), threadMaterial));
      const tail = curve.getPointAt(1).clone();
      tail.x += offset;
      const bead = new THREE.Mesh(new THREE.SphereGeometry(0.0048, 10, 8), threadMaterial);
      bead.position.copy(tail);
      root.add(bead);
    }
  }
  markMeshes(root);

  return {
    key: structuralKey(ornament, ctx),
    root,
    bulbs: 0,
    emissive: null,
    dispose: () => disposeTree(root),
    apply: (next) => {
      root.position.set(next.position[0], next.position[1], next.position[2]);
      root.rotation.set(0, deg(next.rotation), 0);
      root.scale.setScalar(next.scale);
    },
  };
}

// ---------- 插饰 ----------

function createButterfly(ornament: OrnamentInstance): OrnamentEntry {
  const color = colorOf(ornament);
  const root = new THREE.Group();
  root.name = 'ornament-butterfly';
  const wingMaterial = makeFlatStripMaterial(color);
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0);
  wingShape.bezierCurveTo(0.004, 0.018, 0.03, 0.03, 0.043, 0.011);
  wingShape.bezierCurveTo(0.05, -0.004, 0.03, -0.014, 0.01, -0.007);
  wingShape.bezierCurveTo(0.007, -0.009, 0.002, -0.004, 0, 0);
  const wingGeometry = new THREE.ShapeGeometry(wingShape, 18);
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(wingGeometry, wingMaterial);
    wing.scale.x = side;
    wing.rotation.x = -0.5;
    wing.position.set(side * 0.007, 0.004, 0);
    root.add(wing);
  }
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.55), roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.0032, 0.03, 4, 8), bodyMaterial);
  body.rotation.x = Math.PI / 2;
  body.position.set(0, 0.006, 0.002);
  root.add(body);
  for (const side of [-1, 1]) {
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.0007, 0.0007, 0.02, 4), bodyMaterial);
    antenna.position.set(side * 0.004, 0.026, 0.004);
    antenna.rotation.z = side * 0.4;
    root.add(antenna);
  }
  markMeshes(root);
  return {
    key: structuralKey(ornament, { radius: 0, kind: 'paper' }),
    root,
    bulbs: 0,
    emissive: null,
    dispose: () => disposeTree(root),
    apply: (next) => {
      root.position.set(next.position[0], next.position[1], next.position[2]);
      root.rotation.set(0, deg(next.rotation), 0);
      root.scale.setScalar(next.scale);
    },
  };
}

function createPick(ornament: OrnamentInstance): OrnamentEntry {
  const color = colorOf(ornament);
  const root = new THREE.Group();
  root.name = `ornament-${ornament.kind}`;
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.32,
    metalness: ornament.kind === 'star-pick' ? 0.45 : 0.12,
    side: THREE.DoubleSide,
  });
  const shape = ornament.kind === 'star-pick' ? starShape(0.021, 0.0092) : heartShape(0.017);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.004,
    bevelEnabled: false,
    curveSegments: 12,
  });
  geometry.center();
  const head = new THREE.Mesh(geometry, material);
  head.position.y = 0.012;
  root.add(head);
  // 插在花间的一小截柄。
  const stemMaterial = new THREE.MeshStandardMaterial({ color: '#7f8b74', roughness: 0.75 });
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.0012, 0.0012, 0.034, 4), stemMaterial);
  stem.position.y = -0.006;
  root.add(stem);
  markMeshes(root);
  return {
    key: structuralKey(ornament, { radius: 0, kind: 'paper' }),
    root,
    bulbs: 0,
    emissive: null,
    dispose: () => disposeTree(root),
    apply: (next) => {
      root.position.set(next.position[0], next.position[1], next.position[2]);
      root.rotation.set(0, deg(next.rotation), 0);
      root.scale.setScalar(next.scale);
    },
  };
}

// ---------- 系结与吊饰 ----------

function createBow(ornament: OrnamentInstance): OrnamentEntry {
  const color = colorOf(ornament);
  const root = new THREE.Group();
  root.name = 'ornament-bow';
  const material = makeFlatStripMaterial(color);
  for (const side of [-1, 1]) {
    const loop = new THREE.Mesh(
      new THREE.TorusGeometry(0.019, 0.0048, 8, 18, Math.PI * 1.55),
      material,
    );
    loop.rotation.set(Math.PI / 2, 0, side * 0.35);
    loop.position.set(side * 0.016, 0.004, 0.008);
    root.add(loop);
  }
  const knot = new THREE.Mesh(new THREE.SphereGeometry(0.0105, 12, 9), material);
  knot.scale.set(1.1, 0.9, 0.9);
  root.add(knot);
  for (const side of [-1, 1]) {
    const tail = new THREE.Mesh(
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([
          new THREE.Vector3(side * 0.004, -0.004, 0.004),
          new THREE.Vector3(side * 0.016, -0.042, 0.01),
          new THREE.Vector3(side * 0.026, -0.078, 0.004),
        ]),
        14,
        0.0035,
        4,
        false,
      ),
      material,
    );
    root.add(tail);
  }
  markMeshes(root);
  return {
    key: structuralKey(ornament, { radius: 0, kind: 'paper' }),
    root,
    bulbs: 0,
    emissive: null,
    dispose: () => disposeTree(root),
    apply: (next) => {
      root.position.set(next.position[0], next.position[1], next.position[2]);
      root.rotation.set(0, deg(next.rotation), 0);
      root.scale.setScalar(next.scale);
    },
  };
}

function createTag(ornament: OrnamentInstance): OrnamentEntry {
  const color = colorOf(ornament);
  const root = new THREE.Group();
  root.name = 'ornament-tag';
  const stringMaterial = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.8), roughness: 0.5 });
  // 从挂点垂下一小段线。
  const string = new THREE.Mesh(
    new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 0.008, 0),
        new THREE.Vector3(0.003, -0.008, 0.002),
        new THREE.Vector3(0.002, -0.024, 0),
      ]),
      12,
      0.0009,
      4,
      false,
    ),
    stringMaterial,
  );
  root.add(string);
  const paperMaterial = new THREE.MeshStandardMaterial({
    color: color.clone().lerp(WHITE, 0.55),
    roughness: 0.75,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const tag = new THREE.Mesh(new THREE.ShapeGeometry(roundedRectShape(0.03, 0.045, 0.005), 10), paperMaterial);
  tag.position.set(0.002, -0.052, 0);
  root.add(tag);
  const hole = new THREE.Mesh(new THREE.TorusGeometry(0.0032, 0.001, 6, 10), stringMaterial);
  hole.position.set(0.002, -0.03, 0.001);
  root.add(hole);
  // 空白吊牌上点一条很浅的横线，暗示是写字的地方。
  const lineMaterial = new THREE.MeshBasicMaterial({ color: '#b9a892', transparent: true, opacity: 0.55 });
  for (const offset of [0.004, -0.004]) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.016, 0.0012), lineMaterial);
    line.position.set(0.002, -0.052 + offset, 0.0022);
    root.add(line);
  }
  markMeshes(root);
  return {
    key: structuralKey(ornament, { radius: 0, kind: 'paper' }),
    root,
    bulbs: 0,
    emissive: null,
    dispose: () => disposeTree(root),
    apply: (next) => {
      root.position.set(next.position[0], next.position[1], next.position[2]);
      root.rotation.set(0, deg(next.rotation), 0);
      root.scale.setScalar(next.scale);
    },
  };
}

// ---------- 公共入口 ----------

interface EntryStore {
  entries: Map<string, OrnamentEntry>;
}

function entryStore(group: THREE.Group): EntryStore {
  const holder = group.userData as { ornamentStore?: EntryStore };
  if (!holder.ornamentStore) holder.ornamentStore = { entries: new Map() };
  return holder.ornamentStore;
}

function createEntry(ornament: OrnamentInstance, ctx: OrnamentContext): OrnamentEntry {
  const group = ornamentDef(ornament.kind).group;
  if (group === 'lights') return createLights(ornament, ctx);
  if (group === 'strands') return createStrand(ornament, ctx);
  if (ornament.kind === 'butterfly') return createButterfly(ornament);
  if (group === 'picks') return createPick(ornament);
  if (ornament.kind === 'bow') return createBow(ornament);
  return createTag(ornament);
}

/** 建一个空的装饰层；场景把它直接加在 scene 根节点（位置用花束坐标）。 */
export function createOrnaments(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'ornaments';
  entryStore(group);
  return group;
}

/**
 * 把文档里的装饰同步到场景。
 *
 * - 删除的装饰、能力表不允许的装饰立即移除并 dispose；
 * - 款式/颜色/绕行样式/轮廓半径变化时重建该件；
 * - 只改位置/旋转/大小/亮度时原地更新（不重建几何）。
 */
export function syncOrnaments(
  group: THREE.Group,
  ornaments: OrnamentInstance[],
  ctx: OrnamentContext,
): void {
  const store = entryStore(group);
  const source = ornaments ?? [];
  const allowed = filterOrnamentsFor(source, ctx.kind);
  const alive = new Set(allowed.map((item) => item.id));
  // 能力表过滤掉的装饰：不渲染，但记下来，验证脚本能看到「换容器后旧装饰没有悬空」。
  const skipped = source.filter((item) => !alive.has(item.id)).map((item) => item.id);
  (group.userData as { ornamentSkipped?: string[] }).ornamentSkipped = skipped;

  for (const [id, entry] of store.entries) {
    if (alive.has(id)) continue;
    group.remove(entry.root);
    entry.dispose();
    store.entries.delete(id);
  }

  for (const ornament of allowed) {
    const key = structuralKey(ornament, ctx);
    let entry = store.entries.get(ornament.id);
    if (entry && entry.key !== key) {
      group.remove(entry.root);
      entry.dispose();
      store.entries.delete(ornament.id);
      entry = undefined;
    }
    if (!entry) {
      entry = createEntry(ornament, ctx);
      entry.key = key;
      store.entries.set(ornament.id, entry);
      group.add(entry.root);
    }
    entry.apply(ornament);
    entry.root.visible = true;
    entry.root.userData.ornament = ornament;
    entry.root.userData.ornamentId = ornament.id;
    entry.root.userData.ornamentKind = ornament.kind;
    entry.root.userData.ornamentBulbs = entry.bulbs;
  }
}

/** 场景卸载时调；之后这个 group 可以整个丢弃。 */
export function disposeOrnaments(group: THREE.Group): void {
  const store = entryStore(group);
  for (const entry of store.entries.values()) {
    group.remove(entry.root);
    entry.dispose();
  }
  store.entries.clear();
  group.clear();
}

/** 验证脚本读取：每件装饰是否真的存在、位置、是否发光。 */
export function getOrnamentDebug(group: THREE.Group): OrnamentDebug {
  const store = entryStore(group);
  const items: OrnamentDebugItem[] = [];
  for (const [id, entry] of store.entries) {
    const ornament = entry.root.userData.ornament as OrnamentInstance | undefined;
    items.push({
      id,
      kind: (entry.root.userData.ornamentKind as OrnamentKind) ?? 'butterfly',
      exists: true,
      visible: entry.root.visible && group.visible,
      position: [entry.root.position.x, entry.root.position.y, entry.root.position.z],
      rotation: entry.root.rotation.y * (180 / Math.PI),
      scale: entry.root.scale.x,
      colorId: ornament?.colorId ?? '',
      variant: ornament?.variant ?? 0,
      emissive: entry.emissive ? entry.emissive() : null,
      bulbs: entry.bulbs,
    });
  }
  return {
    count: store.entries.size,
    visible: group.visible,
    kinds: items.map((item) => item.kind),
    skipped: (group.userData as { ornamentSkipped?: string[] }).ornamentSkipped ?? [],
    items,
  };
}

/**
 * 记录每件装饰的原始实例，供 debug 读取颜色/样式。
 * syncOrnaments 内部会写 userData.ornament，这里补一个导出给验证脚本按 id 找。
 */
export function ornamentInstanceOf(group: THREE.Group, id: string): OrnamentInstance | null {
  const entry = entryStore(group).entries.get(id);
  const ornament = entry?.root.userData.ornament as OrnamentInstance | undefined;
  return ornament ? { ...ornament, position: [...ornament.position] as Vec3 } : null;
}
