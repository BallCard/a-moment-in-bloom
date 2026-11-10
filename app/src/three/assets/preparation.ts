import * as THREE from 'three';
import type { Preparation } from '../../data/presentation';

/** Preserve the textured flower head; replace fused stems with independent editable parts. */
export function prepareFlower(template: THREE.Group, headHeight: number, family: string): void {
  if (family !== 'rose' && family !== 'tulip') return;
  template.userData.preparedFamily = family;
  template.updateMatrixWorld(true);
  const cut = headHeight - (family === 'rose' ? 0.09 : 0.10);
  const heads: THREE.Mesh[] = [];
  template.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    const p = geometry.getAttribute('position');
    const source = geometry.index;
    const kept: number[] = [];
    for (let i = 0; i < (source?.count ?? p.count); i += 3) {
      const a = source ? source.getX(i) : i;
      const b = source ? source.getX(i + 1) : i + 1;
      const c = source ? source.getX(i + 2) : i + 2;
      if (Math.max(p.getY(a), p.getY(b), p.getY(c)) >= cut) kept.push(a,b,c);
    }
    geometry.setIndex(kept);
    geometry.computeBoundingSphere();
    const head = new THREE.Mesh(geometry, mesh.material);
    head.name = 'original-flower-head';
    head.castShadow = true;
    heads.push(head);
  });
  template.traverse(object => { const mesh = object as THREE.Mesh; if (mesh.isMesh) mesh.geometry.dispose(); });
  template.clear();
  template.add(...heads);
  const green = new THREE.MeshStandardMaterial({ color: family === 'rose' ? '#567348' : '#719052', roughness: 0.82, side: THREE.DoubleSide });
  const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.0032, 0.0042, cut + 0.01, 8), green);
  upper.position.y = (cut + 0.01) / 2;
  upper.name = 'prepared-upper-stem';
  upper.userData.fullHeight = cut + 0.01;
  template.add(upper);
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.0042,0.0032,1,8),green);
  tail.name = 'prepared-tail';
  tail.scale.y = 0.22;
  tail.position.y = -0.11;
  template.add(tail);
  const cutLine=new THREE.Mesh(new THREE.TorusGeometry(.012,.002,6,24),new THREE.MeshBasicMaterial({color:'#c59439',depthTest:false}));
  cutLine.rotation.x=Math.PI/2;cutLine.name='prepared-cut-line';cutLine.visible=false;cutLine.renderOrder=10;template.add(cutLine);
  // V16.2（task-10 收敛版）：叶子不是核心，只求自然、不抢花头。
  // - 单片叶 / 宽鞘叶，纯程序化几何，不用贴图（不做高对比叶脉、锯齿、复叶、亮色描边）。
  // - 颜色与茎同色系、比茎略浅一点点，低饱和；DoubleSide + 高粗糙度，不反光。
  // - 叶根仍然是一段短叶柄 + 一圈略大于茎的叶鞘：上一版近看「叶根像被咬掉一口」的
  //   缺口就是叶基窄条没和茎相交导致的，叶鞘把这处补齐，同时不显眼。
  const tulip = family === 'tulip';
  // 比上一版更短更窄一点，近看只是花茎上的一片叶子，不跟花头抢视线。
  const leafLen = tulip ? 0.105 : 0.08;
  const leafWidth = tulip ? 0.017 : 0.017;
  const leafHeights = tulip ? [-0.06, 0.0, 0.062] : [-0.055, 0.008, 0.072];
  const leafMaterial = new THREE.MeshStandardMaterial({
    color: tulip ? '#6a8450' : '#5f7b4c',
    roughness: 0.94,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  for (let i = 0; i < 3; i += 1) {
    const group = new THREE.Group();
    group.name = `prepared-leaf-group-${i}`;
    group.position.y = leafHeights[i];
    group.rotation.order = 'YXZ';
    group.rotation.y = i * 2.4;
    // 顺着茎往下垂一点，看起来是「长在茎上」的叶子；郁金香再侧向转一点，
    // 让宽鞘叶像真的叶片一样立着垂下来，而不是横着伸出的一条平台。
    group.rotation.x = tulip ? 0.4 : 0.5;
    group.rotation.z = tulip ? -0.75 : -0.2;
    const blade = new THREE.Mesh(leafGeometry(leafLen, leafWidth, tulip ? 'sheath' : 'leaflet'), leafMaterial);
    // 外部（点选修剪、修剪高亮）仍按 `prepared-leaf-${i}` 这个网格名找叶片。
    blade.name = `prepared-leaf-${i}`;
    blade.position.z = 0.0015;
    blade.castShadow = true;
    blade.receiveShadow = true;
    group.add(blade);
    // 叶柄：从茎心伸出的短柄，靠近茎的一段略微膨大。
    const petiole = new THREE.Mesh(
      new THREE.CylinderGeometry(tulip ? 0.0016 : 0.0014, tulip ? 0.0022 : 0.002, tulip ? 0.012 : 0.012, 6),
      green,
    );
    petiole.name = `petiole-leaf-${i}`;
    petiole.rotation.x = Math.PI / 2;
    petiole.position.set(0, 0.0012, tulip ? 0.006 : 0.006);
    petiole.castShadow = true;
    group.add(petiole);
    // 叶鞘：一圈略大于茎的短套管包住茎，叶根不再是悬空窄条；
    // 反向旋转抵消叶片下垂，保持和茎同轴、不显眼。
    const collar = new THREE.Mesh(
      new THREE.CylinderGeometry(tulip ? 0.0049 : 0.0047, tulip ? 0.0052 : 0.005, tulip ? 0.012 : 0.01, 8, 1, true),
      green,
    );
    collar.name = `leaf-collar-${i}`;
    // 反向抵消整片的旋转，让叶鞘始终和茎同轴（否则叶片一歪，包茎的圈也会跟着歪）。
    collar.quaternion.copy(group.quaternion).invert();
    collar.position.y = 0;
    collar.castShadow = true;
    group.add(collar);
    group.visible = i !== 0;
    template.add(group);
  }
  template.traverse(object => { const mesh = object as THREE.Mesh; if(mesh.isMesh) mesh.castShadow = true; });
}

/**
 * 叶片几何（局部：叶基在原点，向 +z 伸展，叶尖向下弯）。
 *
 * - 'leaflet'（玫瑰）：单片小叶，中段最宽、叶基收成一点，配短叶柄。
 * - 'sheath'（郁金香）：基部就宽、贴着茎包住一小段，向前伸后再收尖。
 * 中脉轻轻隆起、两侧略微下折，正面/侧面都能看出一点弧度；没有贴图、没有锯齿。
 */
function leafGeometry(length: number, width: number, shape: 'leaflet' | 'sheath'): THREE.BufferGeometry {
  const p: number[] = [];
  const indices: number[] = [];
  const rows = shape === 'sheath' ? 20 : 16;
  const cols = shape === 'sheath' ? 5 : 4;
  for (let i = 0; i <= rows; i += 1) {
    const t = i / rows;
    const halfWidth =
      shape === 'sheath'
        ? width * (0.9 * Math.pow(1 - t, 0.55) + 0.14 * Math.sin(Math.PI * t))
        : width * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.85);
    // 叶基往茎里退一点，和圆柱茎真实相交，叶鞘再盖住接缝。
    const basePull = shape === 'sheath' ? -0.004 * Math.pow(1 - t, 3) : -0.0015 * Math.pow(1 - t, 2);
    const droop = -length * 0.3 * t * t;
    const ridge = (shape === 'sheath' ? 0.0038 : 0.0038) * Math.sin(Math.PI * t);
    const curl = shape === 'sheath' ? 0.0055 * Math.sin(Math.PI * t) : 0;
    for (let j = 0; j <= cols; j += 1) {
      const side = (j / cols) * 2 - 1;
      const x = side * halfWidth;
      const edgeFold = Math.pow(Math.abs(side), 1.6) * halfWidth * (shape === 'sheath' ? 0.34 : 0.22);
      const y = droop + ridge * (1 - Math.abs(side)) - edgeFold + curl * (side * side - 0.5);
      p.push(x, y, basePull + length * t);
    }
  }
  const stride = cols + 1;
  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < cols; j += 1) {
      const a = i * stride + j;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/** 花头实测尺寸（米，模板局部坐标）。 */
export interface HeadMetrics {
  width: number;
  depth: number;
  height: number;
  bottom: number;
  top: number;
  centerY: number;
  centerX?: number;
  centerZ?: number;
}

/**
 * 只统计**实际被索引引用**的顶点得到的包围盒（V0.7.3）。
 *
 * `prepareFlower` 只重写三角形索引，原始顶点数组整份保留；直接
 * `computeBoundingBox()` 会把已被裁掉的茎/叶顶点一起算进去——玫瑰花头会被
 * 量成 36cm 高（实际可见 13cm），底部量到 5.6cm（实际 28.5cm），
 * 进而带偏接触半径、上半段茎长度与花头中心。这里严格按索引遍历。
 */
export function measureVisibleBounds(geometry: THREE.BufferGeometry): THREE.Box3 | null {
  const position = geometry.getAttribute('position');
  if (!position) return null;
  const index = geometry.index;
  const count = index?.count ?? position.count;
  if (count <= 0) return null;
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  for (let i = 0; i < count; i += 1) {
    const vertex = index ? index.getX(i) : i;
    if (vertex < 0 || vertex >= position.count) continue;
    point.fromBufferAttribute(position, vertex);
    box.expandByPoint(point);
  }
  return box.isEmpty() ? null : box;
}

/**
 * 按尺寸配置缩放花头（V0.7 §3 / V0.7.3 §1）。
 *
 * 关键点：绕 `pivotY`（transform.headOffsetY）缩放，所以花头缩放不改变
 * 花头相对自身几何的形状；`stemFactor` 再把整个花头往握点方向平移
 * `pivotY × (1 - stemFactor)`，实现「枝长缩短但握点、尾茎、包装连接不动」。
 * 上半段茎会延长/缩短到新的花头底部，避免露出空隙或插进花头。
 *
 * 返回的是**实测**花头尺寸：只统计实际渲染的索引顶点，且已在局部坐标里
 * 完成缩放与平移。花头中心 centerY 就是「花头相对握点的高度」，接触、
 * 选中环、相机对焦、建议位都应使用它，而不是清单里的意图值。
 */
export function applyHeadSize(
  template: THREE.Group,
  headWidth: number,
  headHeight: number,
  pivotY: number,
  leafSpread = 1,
  stemFactor = 1,
): HeadMetrics | null {
  const heads: THREE.Mesh[] = [];
  template.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.name === 'original-flower-head') heads.push(mesh);
  });
  if (heads.length === 0) return null;

  const stemShift = clamp01(stemFactor) === 1 ? 0 : pivotY * (1 - clamp01(stemFactor));
  if (
    Math.abs(headWidth - 1) > 1e-4 ||
    Math.abs(headHeight - 1) > 1e-4 ||
    Math.abs(stemShift) > 1e-6
  ) {
    const matrix = new THREE.Matrix4()
      .makeTranslation(0, -stemShift, 0)
      .multiply(new THREE.Matrix4().makeTranslation(0, pivotY, 0))
      .multiply(new THREE.Matrix4().makeScale(headWidth, headHeight, headWidth))
      .multiply(new THREE.Matrix4().makeTranslation(0, -pivotY, 0));
    for (const head of heads) {
      head.geometry.applyMatrix4(matrix);
      head.geometry.computeBoundingBox();
      head.geometry.computeBoundingSphere();
    }
  }

  const box = new THREE.Box3();
  for (const head of heads) {
    const bounds = measureVisibleBounds(head.geometry);
    if (bounds) box.union(bounds);
    // 包围球/盒只用于兜底剔除，按可见顶点重算，别让裁掉的顶点撑大。
    if (bounds) {
      head.geometry.boundingBox = bounds.clone();
      head.geometry.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
    }
  }
  if (box.isEmpty()) return null;
  const metrics: HeadMetrics = {
    width: box.max.x - box.min.x,
    depth: box.max.z - box.min.z,
    height: box.max.y - box.min.y,
    bottom: box.min.y,
    top: box.max.y,
    centerY: (box.min.y + box.max.y) / 2,
    centerX: (box.min.x + box.max.x) / 2,
    centerZ: (box.min.z + box.max.z) / 2,
  };

  const upper = template.getObjectByName('prepared-upper-stem') as THREE.Mesh | null;
  if (upper) {
    const full =
      typeof upper.userData.fullHeight === 'number' ? (upper.userData.fullHeight as number) : 0.3;
    const target = Math.min(full, Math.max(0.02, metrics.bottom));
    upper.scale.y = target / full;
    upper.position.y = target / 2;
  }

  // V16.1：叶片改挂在「握点 → 实际花头底部」之间。
  // 只按 prepareFlower 里的固定高度放叶会在换色/尺寸缩放后穿进花头——花头底部
  // 经 applyHeadSize 压到约 bottom 后，最高的叶子必须留在它下方，否则就是
  // 用户看到的「花瓣上冒出一片叶」。这里按实测 bottom 重排三片叶子的高度，
  // 并让叶长/叶宽按可用茎长收一档，叶尖同样够不到花头。
  const spread = Math.abs(leafSpread - 1) > 1e-4 ? leafSpread : 1;
  const stemRoom = Math.max(0.035, metrics.bottom);
  const fit = Math.min(1.1, Math.max(0.72, stemRoom / 0.26));
  // 郁金香的花头大、花瓣往下包到茎上，叶子再靠近花头就会被花头遮住中段，
  // 只在两侧露出两片叶尖，看起来像「花瓣上挂着叶子」。把郁金香的叶子整体再往下压。
  const preparedFamily = template.userData.preparedFamily as string | undefined;
  const fractions = preparedFamily === 'tulip' ? [0.12, 0.34, 0.56] : [0.18, 0.44, 0.7];
  const leafHeights = [stemRoom * fractions[0], stemRoom * fractions[1], stemRoom * fractions[2]];
  for (let i = 0; i < 3; i += 1) {
    const leaf =
      template.getObjectByName(`prepared-leaf-group-${i}`) ??
      template.getObjectByName(`prepared-leaf-${i}`);
    if (!leaf) continue;
    leaf.position.y = leafHeights[i];
    leaf.scale.set(spread * fit, 1, spread * fit);
  }
  return metrics;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0.5, value)) : 1;
}

export function applyPreparation(root: THREE.Object3D, preparation: Preparation): void {
  const tail=root.getObjectByName('prepared-tail');
  if(!tail)return;
  tail.scale.y=preparation.tailLength;
  tail.position.y=-preparation.tailLength/2;
  const cutLine=root.getObjectByName('prepared-cut-line');if(cutLine)cutLine.position.y=-preparation.tailLength+.02;
  for(let i=0;i<3;i++){
    const leaf=root.getObjectByName(`prepared-leaf-group-${i}`)??root.getObjectByName(`prepared-leaf-${i}`);
    if(leaf)leaf.visible=!preparation.removedLeaves.includes(i);
  }
}

/** Per-instance uniforms: dimming never writes into source textures or document colours. */
export function isolateMaterials(root: THREE.Object3D): void {
  root.traverse(object=>{
    const mesh=object as THREE.Mesh;if(!mesh.isMesh)return;
    const clone=(source:THREE.Material):THREE.Material=>{
      const m=source.clone();const focus={value:1};m.userData.focus=focus;
      m.onBeforeCompile=shader=>{
        shader.uniforms.flowerFocus=focus;
        shader.fragmentShader='uniform float flowerFocus;\n'+shader.fragmentShader;
        shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`float lum = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
outgoingLight = mix(vec3(lum) * 0.70, outgoingLight, flowerFocus);
#include <opaque_fragment>`);
      };
      m.customProgramCacheKey=()=> 'flower-focus-v1';return m;
    };
    mesh.material=Array.isArray(mesh.material)?mesh.material.map(clone):clone(mesh.material);
  });
}
export function setFocus(root: THREE.Object3D, amount:number):void {
  root.traverse(object=>{const mesh=object as THREE.Mesh;if(!mesh.isMesh)return;for(const m of Array.isArray(mesh.material)?mesh.material:[mesh.material])if(m.userData.focus)m.userData.focus.value=amount;});
}
export function disposeInstanceMaterials(root:THREE.Object3D):void {
  root.traverse(object=>{const mesh=object as THREE.Mesh;if(mesh.isMesh&&mesh.userData.trimGeometry)mesh.userData.trimGeometry.dispose();if(mesh.isMesh)for(const m of Array.isArray(mesh.material)?mesh.material:[mesh.material])m.dispose();});
}
