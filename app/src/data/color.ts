/** 颜色工具：用 0..1 的 RGB 数组做线性混色，避免依赖 DOM。 */

export type RGB = [number, number, number];

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export function hexToRgb(hex: string): RGB {
  let h = (hex || '').replace('#', '').trim();
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    // 读不懂的颜色给一个柔和的粉，避免整个场景崩掉。
    return [0.82, 0.6, 0.66];
  }
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

export function rgbToHex([r, g, b]: RGB): string {
  const toHex = (v: number): string =>
    Math.round(clamp01(v) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  const k = clamp01(t);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

export function lighten(c: RGB, amount: number): RGB {
  return mixRgb(c, [1, 1, 1], amount);
}

export function darken(c: RGB, amount: number): RGB {
  return mixRgb(c, [0, 0, 0], amount);
}

/** 略微去饱和，让程序化花材更接近柔和的花艺照片。 */
export function desaturate(c: RGB, amount: number): RGB {
  const gray = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
  return mixRgb(c, [gray, gray, gray], amount);
}
