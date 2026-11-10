/**
 * GLB 配色变体：不改模型几何，只重映射贴图里的花/叶色相。
 *
 * 三份真实花材的贴图把花色烤进了 baseColorTexture，没法直接换色。
 * 这里在加载时把贴图画进 canvas，按像素 HSV 把「花瓣」或「叶片」重新着色，
 * 茎与其余部分保持原样；每个变体生成独立贴图并缓存，实例之间共享。
 *
 * V0.7.5：着色范围可配置。`petals` / `foliage` 沿用默认色相窗口（花瓣
 * 295°→45°、叶片 55°→200°），`all` 表示所有有彩像素；也接受
 * `{ mode, hue: [a, b] }` 指定**环绕色相窗口**（如 [300, 60] 表示
 * 300°→360° 与 0°→60° 两段）。27 种新花材的贴图色域各不相同，靠这个
 * 窗口比固定「粉/绿」两档更稳。
 *
 * 这是配色变体，不是新的花材模型：造型仍来自同一份 GLB。
 */

import * as THREE from 'three';
import type { RecolorMode, RecolorSpec } from '../../data/types';

export type { RecolorMode } from '../../data/types';

/** 各模式的默认色相窗口；`null` 表示不筛色相（只要 s ≥ 0.04）。 */
export const DEFAULT_RECOLOR_HUE: Record<RecolorMode, [number, number] | null> = {
  petals: [295, 45],
  foliage: [55, 200],
  all: null,
};

interface Hsl {
  h: number;
  s: number;
  l: number;
}

interface RecolorRule {
  mode: RecolorMode;
  hue: [number, number] | null;
}

const textureCache = new Map<string, THREE.Texture>();

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function hexToHsl(hex: string): Hsl {
  const clean = hex.replace('#', '');
  const value = Number.parseInt(clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean, 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return rgbToHsl(r, g, b);
}

/** 把调用方给的着色规则清洗成可用形式；坏字段退回默认窗口。 */
function ruleOf(spec: RecolorSpec): RecolorRule {
  if (typeof spec === 'string') {
    return { mode: spec in DEFAULT_RECOLOR_HUE ? spec : 'petals', hue: DEFAULT_RECOLOR_HUE[spec] ?? null };
  }
  const mode: RecolorMode = spec.mode in DEFAULT_RECOLOR_HUE ? spec.mode : 'petals';
  const raw = Array.isArray(spec.hue) ? spec.hue : null;
  const usable =
    raw !== null &&
    raw.length >= 2 &&
    raw.slice(0, 2).every((n) => typeof n === 'number' && Number.isFinite(n));
  return { mode, hue: usable ? [raw[0], raw[1]] : DEFAULT_RECOLOR_HUE[mode] };
}

/** 环绕色相窗口：start > end 表示跨过 0°，例如 [300, 60]。 */
function hueInWindow(h: number, window: [number, number]): boolean {
  const start = ((window[0] % 360) + 360) % 360;
  const end = ((window[1] % 360) + 360) % 360;
  if (start === end) return true;
  return start < end ? h >= start && h <= end : h >= start || h <= end;
}

/** 花纹判定：先按饱和度排除近灰像素，再按模式/色相窗口筛。 */
function matchesRule(hsl: Hsl, rule: RecolorRule): boolean {
  if (hsl.s < 0.04) return false;
  if (rule.hue === null) return true;
  return hueInWindow(hsl.h, rule.hue);
}

function recolorPixels(data: Uint8ClampedArray, rule: RecolorRule, targetHex: string): void {
  const target = hexToHsl(targetHex);
  const sourceHsl: Hsl[] = [];
  // 先统计当前花色/叶色的明度中位数，确保换色后还能保留原有明暗层次。
  const samples: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 24) continue;
    const hsl = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    sourceHsl.push(hsl);
    if (matchesRule(hsl, rule)) samples.push(hsl.l);
  }
  if (samples.length === 0) return;
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 24) continue;
    const hsl = sourceHsl[i / 4];
    if (!matchesRule(hsl, rule)) continue;
    const relLight = hsl.l - median;
    const l = THREE.MathUtils.clamp(target.l + relLight * 0.92, 0.06, 0.97);
    const s = THREE.MathUtils.clamp(target.s * (0.55 + 0.55 * Math.min(2, hsl.s / 0.35)), 0.02, 0.95);
    const [r, g, b] = hslToRgb(target.h, s, l);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}

function recoloredTexture(source: THREE.Texture, rule: RecolorRule, targetHex: string): THREE.Texture | null {
  const hueKey = rule.hue ? rule.hue.join(',') : 'default';
  const key = `${source.uuid}:${rule.mode}:${hueKey}:${targetHex}`;
  const cached = textureCache.get(key);
  if (cached) return cached;

  const image = source.image as (CanvasImageSource & { width?: number; height?: number }) | undefined;
  const width = image?.width ?? 0;
  const height = image?.height ?? 0;
  if (!image || !width || !height) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(image, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  recolorPixels(imageData.data, rule, targetHex);
  context.putImageData(imageData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = source.colorSpace;
  texture.wrapS = source.wrapS;
  texture.wrapT = source.wrapT;
  texture.repeat.copy(source.repeat);
  texture.offset.copy(source.offset);
  texture.center.copy(source.center);
  texture.rotation = source.rotation;
  texture.flipY = source.flipY;
  texture.minFilter = source.minFilter;
  texture.magFilter = source.magFilter;
  texture.anisotropy = source.anisotropy;
  texture.generateMipmaps = source.generateMipmaps;
  texture.needsUpdate = true;
  textureCache.set(key, texture);
  return texture;
}

/**
 * 遍历 GLB 里的网格，给 baseColor 贴图做一次配色映射。
 * `spec` 兼容旧的字符串调用（`'petals'` / `'foliage'`），也接受带色相窗口的对象。
 */
export function applyColorVariant(root: THREE.Object3D, spec: RecolorSpec, targetHex: string): void {
  const rule = ruleOf(spec);
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const apply = (material: THREE.Material): THREE.Material => {
      const standard = material as THREE.MeshStandardMaterial;
      if (!standard.map) return material;
      const nextMap = recoloredTexture(standard.map, rule, targetHex);
      if (!nextMap) return material;
      const clone = material.clone();
      (clone as THREE.MeshStandardMaterial).map = nextMap;
      clone.needsUpdate = true;
      return clone;
    };
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map(apply);
    } else if (mesh.material) {
      mesh.material = apply(mesh.material);
    }
  });
}
