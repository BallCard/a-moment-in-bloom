/**
 * Lux3D 近景道具的运行时加载、归一化与挂载（V12）。
 *
 * 与 `vessel-load.ts` 同一套约定：
 * 1) 按包围盒等比缩放到 `displayHeight`（整体高度，含底座/灯罩/花头）；
 * 2) 水平居中、底面落到 y=0，调用方给的是「道具底部」的位置；
 * 3) 同一道具只加载一次，多实例复制模板（共享几何/材质）；
 * 4) 加载失败返回 null——场景保留原程序化道具，不让布景缺件或报错。
 *
 * `mountSceneProps()` 在模型就位后隐藏对应的程序化节点（scene agent 传入的
 * 网格 name 列表），实现「GLB 外观 + 程序化兜底」的平滑替换。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PROP_MODELS, type PropId } from '../../data/props';

const loader = new GLTFLoader();
const templates = new Map<PropId, THREE.Group>();
const pending = new Map<PropId, Promise<THREE.Group | null>>();

export interface PropPlacement {
  id: PropId;
  /** 道具底部落点（场景组坐标，米）。 */
  position: [number, number, number];
  /** 额外旋转（弧度），在模型自带姿态修正之外再转。 */
  rotation?: [number, number, number];
  /** 覆盖默认 displayHeight（米），用于同一道具的多种尺寸。 */
  height?: number;
  /** GLB 就位后隐藏的程序化节点 name。 */
  hide?: string[];
}

/** 已经解析好的模板（同步取用，用于重复挂载）。 */
export function getPropModel(id: PropId): THREE.Group | null {
  return templates.get(id) ?? null;
}

export function loadPropModel(id: PropId): Promise<THREE.Group | null> {
  const spec = PROP_MODELS[id];
  if (!spec) return Promise.resolve(null);
  const cached = templates.get(id);
  if (cached) return Promise.resolve(cached);
  const running = pending.get(id);
  if (running) return running;

  const task = new Promise<THREE.Group | null>((resolve) => {
    loader.load(
      spec.url,
      (gltf) => {
        const root = gltf.scene;
        normalize(root, spec.displayHeight, spec.rotation, id);
        templates.set(id, root);
        pending.delete(id);
        resolve(root);
      },
      undefined,
      () => {
        // 失败不缓存：下次进入场景会再试一次，本次沿用程序化道具。
        pending.delete(id);
        resolve(null);
      },
    );
  });
  pending.set(id, task);
  return task;
}

/**
 * 把一组道具登记到场景组上（只登记，不立刻下载）。
 *
 * 道具 GLB 合计约 4.2MB，如果 8 个布景在启动时全部创建就全部下载，会拖慢首屏并和
 * 花材资源抢带宽。因此这里只把 placement 存进 `userData`，等布景第一次真正显示时
 * （`BouquetScene.syncPhotoSet()` 调 `activateSceneProps()`）再开始加载。
 *
 * 模型异步到达后原地替换程序化道具；失败时静默保留程序化版本，不会让布景缺件。
 */
export function mountSceneProps(group: THREE.Group, placements: PropPlacement[]): void {
  group.userData.scenePropsAborted = false;
  // 允许场景分多次登记（每次调用内部序号重新从 0 开始，节点名按「本次调用序号」生成）。
  const groups = (group.userData.scenePropGroups as PropPlacement[][] | undefined) ?? [];
  groups.push(placements);
  group.userData.scenePropGroups = groups;
  group.userData.scenePropsActivated = false;
  if (group.visible && group.parent) activateSceneProps(group);
}

/** 布景第一次可见时调用：开始加载并挂载道具（幂等）。 */
export function activateSceneProps(group: THREE.Group): void {
  if (group.userData.scenePropsActivated) return;
  const groups = group.userData.scenePropGroups as PropPlacement[][] | undefined;
  if (!groups?.length) return;
  group.userData.scenePropsActivated = true;

  for (const placements of groups) {
    for (const [index, placement] of placements.entries()) {
      const hostName = `scene-prop-${placement.id}-${index}`;
      const existing = group.getObjectByName(hostName);
      if (existing) group.remove(existing);

      void loadPropModel(placement.id).then((template) => {
        // 场景已销毁时放弃挂载，避免往已释放的组里加节点。
        if (!template || group.userData.scenePropsAborted) return;
        const holder = new THREE.Group();
        holder.name = hostName;
        holder.position.set(...placement.position);
        holder.rotation.set(...(placement.rotation ?? [0, 0, 0]));
        const clone = template.clone(true);
        const scale = placement.height ? placement.height / PROP_MODELS[placement.id].displayHeight : 1;
        if (scale !== 1) clone.scale.multiplyScalar(scale);
        // 覆盖高度后重新把底面压回 holder 原点、水平居中：模板的 root.position 是
        // 按 displayHeight 算的，直接改 root.scale 会连带放大那段偏移，导致模型陷进/浮出台面。
        clone.updateMatrixWorld(true);
        const fitted = new THREE.Box3().setFromObject(clone);
        const center = new THREE.Vector3();
        fitted.getCenter(center);
        clone.position.x -= center.x;
        clone.position.z -= center.z;
        clone.position.y -= fitted.min.y;
        holder.add(clone);
        group.add(holder);
        // GLB 就位后才隐藏程序化道具：加载失败时它还要用。
        for (const name of placement.hide ?? []) {
          const procedural = group.getObjectByName(name);
          if (procedural) procedural.visible = false;
        }
      });
    }
  }
}

/** 场景销毁前调用：阻止延迟到达的模型再往这个组里挂。 */
export function detachSceneProps(group: THREE.Group): void {
  group.userData.scenePropsAborted = true;
  for (const child of [...group.children]) {
    if (child.name.startsWith('scene-prop-')) group.remove(child);
  }
}

/** 场景销毁时清空模板缓存，避免复用已释放的几何/材质。 */
export function disposeSceneProps(): void {
  for (const template of templates.values()) {
    template.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) material.dispose();
    });
  }
  templates.clear();
  pending.clear();
}

function normalize(
  root: THREE.Group,
  displayHeight: number,
  rotation: [number, number, number] | undefined,
  id: PropId,
): void {
  // 先做姿态修正（Lux3D 产物可能是躺倒的），再按修正后的包围盒归一化：
  // 否则用躺倒模型的「厚度」当高度去缩放，扶正后会明显偏大。
  root.rotation.set(...(rotation ?? [0, 0, 0]));
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  bounds.getSize(size);
  const scale = displayHeight / Math.max(0.001, size.y);
  root.scale.setScalar(scale);
  root.updateMatrixWorld(true);

  // 缩放（以及姿态修正）后重新量一次：水平居中、底面压到 y=0。
  const fitted = new THREE.Box3().setFromObject(root);
  const center = new THREE.Vector3();
  fitted.getCenter(center);
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= fitted.min.y;

  root.name = `prop-model-${id}`;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const standard = material as THREE.MeshStandardMaterial;
      if (standard.isMeshStandardMaterial) standard.envMapIntensity = 0.85;
    }
  });
}
