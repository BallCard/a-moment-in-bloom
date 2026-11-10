/**
 * Lux3D 花器 GLB 的运行时加载与归一化。
 *
 * 生成模型不在离线阶段做几何变换，统一在这里按包围盒处理：
 * 1) 等比缩放到 `displayHeight`（整体高度，含提手/盒盖）；
 * 2) 水平居中、底面落到 y=0，调用方把它挂在台面高度的容器组里；
 * 3) 缓存已解析的场景（同一形态只加载一次），切换形态只换挂载，不重复请求。
 *
 * 任何失败都返回 null，由调用方保留程序化容器作为兜底——容器加载失败不能挡住玩法。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VESSEL_MODELS, type VesselKind } from '../../data/presentation';

const loader = new GLTFLoader();
const cache = new Map<VesselKind, THREE.Group>();
const pending = new Map<VesselKind, Promise<THREE.Group | null>>();

/** 已经加载好的模型（同步取用，用于切换形态时立即挂载）。 */
export function getVesselModel(kind: VesselKind): THREE.Group | null {
  return cache.get(kind) ?? null;
}

export function loadVesselModel(kind: VesselKind): Promise<THREE.Group | null> {
  const spec = VESSEL_MODELS[kind];
  if (!spec) return Promise.resolve(null);
  const cached = cache.get(kind);
  if (cached) return Promise.resolve(cached);
  const running = pending.get(kind);
  if (running) return running;

  const task = new Promise<THREE.Group | null>((resolve) => {
    loader.load(
      spec.url,
      (gltf) => {
        const root = gltf.scene;
        normalize(root, spec.displayHeight, kind);
        cache.set(kind, root);
        pending.delete(kind);
        resolve(root);
      },
      undefined,
      () => {
        // 加载失败：不缓存失败结果，下次切换会再试一次；本次回退程序化容器。
        pending.delete(kind);
        resolve(null);
      },
    );
  });
  pending.set(kind, task);
  return task;
}

/** 从场景里摘下（模型由缓存持有，不在这里释放几何/材质）。 */
export function releaseVesselModel(model: THREE.Group | null): void {
  if (model?.parent) model.parent.remove(model);
}

/** 场景销毁时清空缓存，避免下次挂载复用已释放的几何/材质。 */
export function disposeVesselModels(): void {
  for (const model of cache.values()) {
    model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) material.dispose();
    });
  }
  cache.clear();
  pending.clear();
}

function normalize(root: THREE.Group, displayHeight: number, kind: VesselKind): void {
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  bounds.getSize(size);
  const scale = displayHeight / Math.max(0.001, size.y);
  root.scale.setScalar(scale);
  root.updateMatrixWorld(true);

  // 缩放后重新量一次：把水平中心对齐原点，底面压到 y=0。
  const fitted = new THREE.Box3().setFromObject(root);
  const center = new THREE.Vector3();
  fitted.getCenter(center);
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= fitted.min.y;

  root.name = `vessel-model-${kind}`;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const standard = material as THREE.MeshStandardMaterial;
      // 生成模型的 PBR 偏亮，压一点环境反射，和花材/纸片的观感统一。
      if (standard.isMeshStandardMaterial) standard.envMapIntensity = 0.85;
    }
  });
}
