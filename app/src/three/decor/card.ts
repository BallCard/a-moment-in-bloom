/**
 * 程序化卡片：文字用 Canvas 绘制成纹理，再贴到 3D 卡片正面。
 * 卡片内容只作为纯文本进入 canvas.fillText，不经过任何 HTML 拼接。
 */

import * as THREE from 'three';
import type { CardState } from '../../data/types';

// V13 观感校准：原来卡片在 1366 桌面里几乎和花束一样高，抢掉了主体。
// 收小约 13%，让卡片退成「陪着花的一张便笺」，花束仍是第一眼。
const CARD_WIDTH = 0.19;
const CARD_HEIGHT = 0.267;
const CARD_DEPTH = 0.007;
const CANVAS_WIDTH = 512;
const CANVAS_HEIGHT = 720;

export interface CardObject {
  group: THREE.Group;
  mesh: THREE.Mesh;
  texture: THREE.CanvasTexture;
  materials: THREE.Material[];
}

export function createCardObject(card: CardState): CardObject {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  drawCardTexture(texture, card);

  // 卡片正面用 Basic 材质并关闭 tone mapping：像一张不透明白卡，
  // 不参与 PBR 曝光，文字在 2048 导出和手机上都能读清。
  const front = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
  const edge = new THREE.MeshStandardMaterial({
    color: 0xc4a98a,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.3,
  });
  const back = new THREE.MeshStandardMaterial({
    color: 0xf3e4d0,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.35,
  });
  const materials = [edge, edge, edge, edge, front, back];
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(CARD_WIDTH, CARD_HEIGHT, CARD_DEPTH),
    materials,
  );
  mesh.name = 'card';
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.position.y = CARD_HEIGHT / 2;

  const group = new THREE.Group();
  group.name = 'card-group';
  group.add(mesh);
  return { group, mesh, texture, materials };
}

export function drawCardTexture(texture: THREE.CanvasTexture, card: CardState): void {
  const canvas = texture.image as HTMLCanvasElement | undefined;
  const context = canvas?.getContext('2d');
  if (!context || !canvas) return;
  const width = CANVAS_WIDTH;
  const height = CANVAS_HEIGHT;

  context.clearRect(0, 0, width, height);

  // 画布必须铺满：卡片正面的透明区域在无 alpha 的 Basic 材质上会变黑。
  context.fillStyle = '#fbf4e8';
  context.fillRect(0, 0, width, height);

  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, '#fffaf1');
  background.addColorStop(0.55, '#fbf4e8');
  background.addColorStop(1, '#f4e8d7');
  context.fillStyle = background;
  roundedRect(context, 8, 8, width - 16, height - 16, 20);
  context.fill();

  context.strokeStyle = 'rgba(150, 112, 78, 0.34)';
  context.lineWidth = 1.4;
  roundedRect(context, 20, 20, width - 40, height - 40, 14);
  context.stroke();

  // 右上角的简笔小花，和整体暖色花束呼应。
  drawCornerFlower(context, width - 76, 88);

  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';

  context.fillStyle = '#8a6b50';
  context.font = '22px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.fillText('致', 54, 96);

  const toText = card.to.trim();
  context.fillStyle = toText ? '#3f2c1d' : '#8a7561';
  const toFont = fitFont(context, toText || '亲爱的你', 396, 42, 26, '600');
  context.font = `${toFont}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  context.fillText(toText || '亲爱的你', 54, 150);

  context.strokeStyle = 'rgba(150, 112, 78, 0.3)';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(54, 184);
  context.lineTo(width - 54, 184);
  context.stroke();

  const message = card.message.trim();
  // 正文字号按成品卡片实际显示尺寸调大：卡片在 3D 里只有约 20 cm 高，
  // 25px 纹理字在玩家视角下几乎读不清（桌面 1366/1920 实测）。
  context.font = '32px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.fillStyle = message ? '#443224' : '#8a7561';
  const lines = wrapText(
    context,
    message || '写一句想说的话，\n让这束花替你带到。',
    380,
  );
  const maxLines = 6;
  const lineHeight = 47;
  let y = 236;
  for (let i = 0; i < Math.min(lines.length, maxLines); i += 1) {
    let line = lines[i];
    if (i === maxLines - 1 && lines.length > maxLines) line = `${line.slice(0, -1)}…`;
    context.fillText(line, 54, y);
    y += lineHeight;
  }

  const fromText = card.from.trim();
  context.textAlign = 'right';
  context.fillStyle = fromText ? '#5b4633' : '#8a7561';
  context.font = '30px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.fillText(`—— ${fromText || '你的名字'}`, width - 54, 640);

  context.textAlign = 'left';
  context.fillStyle = 'rgba(150, 112, 78, 0.48)';
  context.font = '14px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.fillText('花束工作台', 54, 690);

  texture.needsUpdate = true;
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function drawCornerFlower(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
): void {
  context.save();
  context.translate(x, y);
  context.fillStyle = 'rgba(217, 141, 160, 0.46)';
  for (let i = 0; i < 5; i += 1) {
    const angle = (i / 5) * Math.PI * 2 - Math.PI / 2;
    context.beginPath();
    context.ellipse(
      Math.cos(angle) * 13,
      Math.sin(angle) * 13,
      9,
      6,
      angle,
      0,
      Math.PI * 2,
    );
    context.fill();
  }
  context.fillStyle = 'rgba(226, 189, 127, 0.75)';
  context.beginPath();
  context.arc(0, 0, 5, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = 'rgba(139, 163, 123, 0.6)';
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(0, 20);
  context.quadraticCurveTo(4, 32, -3, 44);
  context.stroke();
  context.restore();
}

function fitFont(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  startSize: number,
  minSize: number,
  weight: string,
): number {
  let size = startSize;
  while (size > minSize) {
    context.font = `${weight} ${size}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    if (context.measureText(text).width <= maxWidth) return size;
    size -= 1;
  }
  return minSize;
}

function wrapText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  const paragraphs = text.split('\n');
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const char of Array.from(paragraph)) {
      const next = line + char;
      if (line && context.measureText(next).width > maxWidth) {
        lines.push(line);
        line = char;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

export function disposeCard(card: CardObject): void {
  card.mesh.geometry.dispose();
  for (const material of card.materials) material.dispose();
  card.texture.dispose();
}

/**
 * 卡片「放上桌」进度：0 = 没出现，1 = 摆好。
 * 只动缩放/透明度，位置由场景负责，所以随时可被新状态打断、不影响撤销。
 */
export function setCardAppear(card: CardObject, progress: number): void {
  const t = Math.max(0, Math.min(1, progress));
  card.group.visible = t > 0.002;
  if (!card.group.visible) return;
  const eased = 1 - Math.pow(1 - t, 3);
  card.mesh.scale.setScalar(0.84 + 0.16 * eased);
  card.mesh.position.y = CARD_HEIGHT / 2 - (1 - eased) * 0.028;
  const opacity = Math.min(1, t * 1.4);
  for (const material of card.materials) {
    material.opacity = opacity;
    material.transparent = t < 0.995;
    material.depthWrite = t > 0.995;
  }
}
