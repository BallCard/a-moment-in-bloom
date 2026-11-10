/**
 * 轻量的「当前 3D 场景」桥。
 *
 * 拍照 / 包装等面板需要读镜头与花枝的世界坐标（例如一键适配取景），
 * 但它们不该为了一两个方法就把 BouquetScene 注入整棵 React 树。
 * App 在场景创建/销毁时登记，面板按需取用；没有场景时返回 null，
 * 调用方必须自己兜底（页面还没就绪、或作品展等非工作台页面）。
 */
import type { BouquetScene } from '../three/BouquetScene';

let current: BouquetScene | null = null;

export function setScene(scene: BouquetScene | null): void {
  current = scene;
}

export function getScene(): BouquetScene | null {
  return current;
}
