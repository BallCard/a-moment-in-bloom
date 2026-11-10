/**
 * 建议位的 3D 呈现：每个候选 = 一枝半透明花影 + 柔和的植物绿标记。
 *
 * 只负责"把 store 已经算好的候选画出来"，不做任何几何计算，
 * 因此拖动/转视角时不需要重建，也就不会拖慢跟手渲染。
 * 候选坐标固定在花束坐标里，这里只按候选数据摆位置。
 */

import * as THREE from 'three';
import { GRIP_Y } from '../../config';
import type { SuggestionCandidate } from '../../data/types';
import { poseToQuaternion } from '../../data/pose';

const SILHOUETTE_OPACITY = 0.16;
const SILHOUETTE_OPACITY_ACTIVE = 0.4;
const MARKER_COLOR = 0x7d9a74;
const MARKER_COLOR_ACTIVE = 0xd8b271;

interface SuggestionItem {
  id: string;
  root: THREE.Group;
  materials: THREE.Material[];
  glow: THREE.Sprite;
  glowMaterial: THREE.SpriteMaterial;
  ring: THREE.Mesh;
  ringMaterial: THREE.MeshBasicMaterial;
  head: THREE.Vector3;
}

let glowTexture: THREE.CanvasTexture | null = null;

function sharedGlowTexture(): THREE.CanvasTexture {
  if (glowTexture) return glowTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      2,
      size / 2,
      size / 2,
      size / 2,
    );
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    gradient.addColorStop(0.35, 'rgba(214, 232, 205, 0.55)');
    gradient.addColorStop(0.72, 'rgba(168, 197, 157, 0.18)');
    gradient.addColorStop(1, 'rgba(168, 197, 157, 0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  glowTexture = texture;
  return texture;
}

export class SuggestionLayer {
  private readonly group = new THREE.Group();
  private items: SuggestionItem[] = [];
  private signature = '';
  private activeId: string | null = null;
  private visible = true;

  constructor(scene: THREE.Scene) {
    this.group.name = 'suggestions';
    this.group.renderOrder = 12;
    scene.add(this.group);
  }

  /**
   * 用候选列表刷新花影与标记。数据不变时直接返回，避免每帧重建。
   * template 是待放花材的模板（与 ghost 共用），拿不到时只画标记。
   */
  sync(candidates: SuggestionCandidate[], template: THREE.Object3D | null, templateKey: string): void {
    const signature = [
      templateKey,
      ...candidates.map(
        (candidate) =>
          `${candidate.id}@${candidate.head.join(',')}|${candidate.pose.height},${candidate.pose.tilt},${candidate.pose.direction}`,
      ),
    ].join('~');
    if (signature === this.signature) {
      this.applyVisibility();
      return;
    }
    this.signature = signature;
    this.clearItems();

    for (const candidate of candidates) {
      const item = this.createItem(candidate, template);
      this.items.push(item);
      this.group.add(item.root);
    }
    this.applyVisibility();
    this.applyActiveState();
  }

  setActive(id: string | null): void {
    if (this.activeId === id) return;
    this.activeId = id;
    this.applyActiveState();
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.applyVisibility();
  }

  /** 每帧调用：让当前吸附候选的标记有轻微呼吸感，提示"就是这里"。 */
  update(elapsedSeconds: number): void {
    const active = this.items.find((item) => item.id === this.activeId);
    if (!active) return;
    const pulse = 1.14 + Math.sin(elapsedSeconds * 3.8) * 0.1;
    active.ring.scale.setScalar(pulse);
    active.glow.scale.setScalar(0.42 * pulse);
  }

  dispose(): void {
    this.clearItems();
    this.group.removeFromParent();
    if (glowTexture) {
      glowTexture.dispose();
      glowTexture = null;
    }
  }

  private createItem(candidate: SuggestionCandidate, template: THREE.Object3D | null): SuggestionItem {
    const root = new THREE.Group();
    root.name = `suggestion:${candidate.id}`;
    // 候选姿态以握点为根，跟实际落位时的花枝根一致。
    root.position.set(0, GRIP_Y, 0);
    const head = new THREE.Vector3(candidate.head[0], candidate.head[1], candidate.head[2]);

    const materials: THREE.Material[] = [];
    if (template) {
      const silhouette = template.clone(true);
      silhouette.quaternion.copy(poseToQuaternion({ ...candidate.pose, spin: 0 }));
      silhouette.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        const source = mesh.material as THREE.Material | THREE.Material[];
        const cloneMaterial = (material: THREE.Material): THREE.Material => {
          const cloned = material.clone();
          cloned.transparent = true;
          cloned.opacity = SILHOUETTE_OPACITY;
          cloned.depthWrite = false;
          if ('color' in cloned && cloned.color instanceof THREE.Color) {
            // 往植物绿偏一点，读起来像"位置提示"而不是又一枝花。
            cloned.color.lerp(new THREE.Color(MARKER_COLOR), 0.42);
          }
          materials.push(cloned);
          return cloned;
        };
        mesh.material = Array.isArray(source) ? source.map(cloneMaterial) : cloneMaterial(source);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.renderOrder = 11;
      });
      root.add(silhouette);
    }

    // 花头高度由场景按实际花材换算过，这里直接用候选 head。
    const glowMaterial = new THREE.SpriteMaterial({
      map: sharedGlowTexture(),
      color: MARKER_COLOR_ACTIVE,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
    });
    const glow = new THREE.Sprite(glowMaterial);
    glow.position.copy(head);
    glow.scale.setScalar(0.34);
    glow.renderOrder = 30;
    root.add(glow);

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: MARKER_COLOR,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.0032, 6, 32), ringMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(head.x, head.y - 0.02, head.z);
    ring.renderOrder = 31;
    root.add(ring);

    return {
      id: candidate.id,
      root,
      materials,
      glow,
      glowMaterial,
      ring,
      ringMaterial,
      head,
    };
  }

  private applyActiveState(): void {
    for (const item of this.items) {
      const active = item.id === this.activeId;
      for (const material of item.materials) {
        material.opacity = active ? SILHOUETTE_OPACITY_ACTIVE : SILHOUETTE_OPACITY;
      }
      item.glowMaterial.color.setHex(active ? MARKER_COLOR_ACTIVE : MARKER_COLOR);
      item.glowMaterial.opacity = active ? 0.72 : 0.26;
      item.ringMaterial.color.setHex(active ? MARKER_COLOR_ACTIVE : MARKER_COLOR);
      item.ringMaterial.opacity = active ? 1 : 0.4;
      if (!active) item.ring.scale.setScalar(1);
    }
  }

  private applyVisibility(): void {
    this.group.visible = this.visible && this.items.length > 0;
  }

  private clearItems(): void {
    for (const item of this.items) {
      item.root.removeFromParent();
      for (const material of item.materials) material.dispose();
      item.glowMaterial.dispose();
      item.ringMaterial.dispose();
      item.ring.geometry.dispose();
    }
    this.items = [];
  }
}
