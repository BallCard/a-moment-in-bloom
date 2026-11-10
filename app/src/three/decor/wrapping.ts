/**
 * 独立开放纸片：折叠边界、尖角、收束腰部与分层。
 *
 * 分步包装用几何形变表达（见 docs/round-plan.md 3.2）：
 * - openScale 控制「摆纸」阶段的开口大小（0.85–1.12）；
 * - fold 0→1 表达「合拢收口」：纸口收紧、捏褶加深、纸边略微上提。
 * 两者都通过重建几何实现，顶点数很小（约 100），重建成本低于逐帧着色器切换。
 */

import * as THREE from 'three';
import {
  PAPER_OPEN_SCALE_MAX,
  PAPER_OPEN_SCALE_MIN,
  WRAP_BOTTOM_RADIUS,
  WRAP_BOTTOM_Y,
  WRAP_MAX_RADIUS,
  WRAP_MIN_RADIUS,
} from '../../config';
import { PAPER_PRESETS } from '../../data/decor';
import type { PaperSheet } from '../../data/presentation';
import type { PaperId } from '../../data/types';

export interface PaperObject {
  /** 底部原点组：包装纸从底部往上生长。 */
  group: THREE.Group;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  /** 当前几何对应的参数，用于判断是否需要重建。 */
  paperId: PaperId;
  topRadius: number;
  fold: number;
  openScale: number;
}


let grainTexture: THREE.CanvasTexture | null = null;

function paperGrain(): THREE.CanvasTexture {
  if (grainTexture) return grainTexture;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, size, size);
    // 细纸纹：短纤维 + 颗粒，作为材质贴图和轻微凹凸叠加。
    context.globalAlpha = 0.14;
    for (let i = 0; i < 520; i += 1) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const length = 2 + Math.random() * 8;
      context.strokeStyle = Math.random() > 0.5 ? '#8b7157' : '#fffdf8';
      context.lineWidth = 0.7;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + (Math.random() - 0.5) * 1.4, y + length);
      context.stroke();
    }
    context.globalAlpha = 0.09;
    for (let i = 0; i < 1000; i += 1) {
      const shade = Math.random() > 0.5 ? 96 : 248;
      context.fillStyle = `rgb(${shade}, ${shade - 6}, ${shade - 16})`;
      context.fillRect(Math.random() * size, Math.random() * size, 1, 1);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2.6, 2.6);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  grainTexture = texture;
  return texture;
}

function clampOpenScale(openScale: number): number {
  if (!Number.isFinite(openScale)) return 1;
  return THREE.MathUtils.clamp(openScale, PAPER_OPEN_SCALE_MIN, PAPER_OPEN_SCALE_MAX);
}

/** 纸口实际半径：花束外轮廓 × 摆纸开口大小，再按 fold 收拢。 */
export function paperMouthRadius(topRadius: number, fold: number, openScale: number): number {
  const spread = THREE.MathUtils.clamp(topRadius * clampOpenScale(openScale), WRAP_MIN_RADIUS, WRAP_MAX_RADIUS);
  // 合拢收口是“在花头下方把纸收成一握”，不是把纸口缩成花碗：
  // 收到纸束直径的一半左右，花茎从纸口探出，花头仍完整露在上面。
  const gathered = Math.max(WRAP_BOTTOM_RADIUS * 1.4, spread * 0.5);
  return THREE.MathUtils.lerp(spread, gathered, THREE.MathUtils.clamp(fold, 0, 1));
}

export function buildPaperGeometry(topRadius: number, paperId: PaperId, fold = 0, openScale = 1, sheet?: PaperSheet, layer = 0): THREE.BufferGeometry {
  const preset = PAPER_PRESETS[paperId];
  const positions: number[] = [], colors: number[] = [], uv: number[] = [], indices: number[] = [];
  const spread = Math.max(.18, Math.min(.34, topRadius * openScale)) * (sheet?.width ?? 1);
  // V15.1：纸口高度整体下压约 14%（原 [0,.12,.232,.34,.47]），让纸包前沿停在花材下缘，
  // 避免花头/配材从纸面穿出；与 config.ts 的 WRAP_RADIUS_TIGHTEN 0.72 配合。
  const rows = [0, .104, .2, .292, .404];
  const columns = 32;
  for (let row = 0; row < rows.length; row++) {
    const v = row / (rows.length - 1);
    for (let i = 0; i <= columns; i++) {
      const u = i / columns * 2 - 1;
      const sideFold = u < 0 ? (sheet?.leftFold ?? .75) : (sheet?.rightFold ?? .85);
      const progress = fold * sideFold;
      const gather = fold * (sheet?.gather ?? .8);
      const radius = row === 2 ? .045 + (1-gather)*.055 : row === 0 ? .025 : row === 1 ? .075 : spread * (row === 3 ? .62 : 1);
      const angle = Math.PI + u * (1.2 + progress * 1.65);
      const crease = Math.abs(Math.sin(u * Math.PI * 4)) * .008 * fold * (row===2? .3:1);
      const r = radius + layer * .004 + crease;
      const blend = fold * .88 + .12;
      const x = THREE.MathUtils.lerp(u * spread * 1.45, Math.sin(angle)*r, blend);
      const z = THREE.MathUtils.lerp(-spread * .65, Math.cos(angle)*r, blend);
      const edge = row === 4 ? -.155 * Math.abs(u) + .022*Math.sin(u*3) : row === 0 ? .08*Math.abs(u) : 0;
      positions.push(x, rows[row] + edge, z);
      const color = new THREE.Color(preset.outer).multiplyScalar(i%8===0 ? .92 : 1);
      colors.push(color.r,color.g,color.b);uv.push((u+1)/2,v);
    }
  }
  // Open rectangular sheet: never connect the two lateral edges.
  for(let row=0;row<rows.length-1;row++)for(let i=0;i<columns;i++){
    const a=row*(columns+1)+i,b=a+1,c=a+columns+1,d=c+1;
    indices.push(a,c,b,b,c,d);
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(indices);g.computeVertexNormals();g.computeBoundingSphere();return g;
}

export function createPaperObject(
  paperId: PaperId,
  topRadius: number,
  openScale = 1,
): PaperObject {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: paperGrain(),
    bumpMap: paperGrain(),
    bumpScale: 0.0035,
    roughness: 0.96,
    metalness: 0,
    envMapIntensity: 0.32,
    side: THREE.DoubleSide,
    flatShading: true,
  });
  material.onBeforeCompile=shader=>{shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\nif (!gl_FrontFacing) diffuseColor.rgb *= vec3(0.90, 0.92, 0.91);');};
  const mesh = new THREE.Mesh(buildPaperGeometry(topRadius, paperId, 0, openScale), material);
  mesh.name = 'wrapping-paper';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const group = new THREE.Group();
  group.name = 'wrapping';
  group.position.y = WRAP_BOTTOM_Y;
  group.add(mesh);
  return {
    group,
    mesh,
    material,
    paperId,
    topRadius,
    fold: 0,
    openScale: clampOpenScale(openScale),
  };
}

export function rebuildPaper(
  paper: PaperObject,
  paperId: PaperId,
  topRadius: number,
  fold = 0,
  openScale = 1,
  sheets?: PaperSheet[],
): void {
  for(const child of [...paper.group.children]) { const mesh=child as THREE.Mesh; if(mesh.isMesh)mesh.geometry.dispose(); paper.group.remove(child); }
  const layers = sheets?.length ? sheets : [undefined];
  layers.forEach((sheet,index)=>{
    const mesh = new THREE.Mesh(buildPaperGeometry(topRadius,sheet?.paperId ?? paperId,fold,openScale,sheet,index),paper.material);
    mesh.name=`paper-sheet-${sheet?.id ?? index}`;mesh.position.y=sheet?.height ?? 0;mesh.rotation.y=THREE.MathUtils.degToRad(sheet?.rotation ?? 0);mesh.castShadow=true;mesh.receiveShadow=true;paper.group.add(mesh);if(index===0)paper.mesh=mesh;
  });
  paper.paperId = paperId;
  paper.topRadius = topRadius;
  paper.fold = fold;
  paper.openScale = clampOpenScale(openScale);
}

export function disposePaper(paper: PaperObject): void {
  for(const child of paper.group.children) { const mesh=child as THREE.Mesh;if(mesh.isMesh)mesh.geometry.dispose(); }
  paper.material.dispose();
  if (grainTexture) {
    grainTexture.dispose();
    grainTexture = null;
  }
}
