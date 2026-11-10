/**
 * 花间作品展：只收录本地真实可用的作品。
 *
 * - `lux3d`：Lux3D 整束生成的一体模型（可旋转欣赏，不支持逐枝编辑）；
 * - `handmade`：在工作台里逐枝搭配、真实拍摄的成品封面（没有一体模型）。
 *
 * 每件作品都带一份 `palette`：作品展里的「用这个配色开始创作」用它生成一束
 * 起点作品（花材 id 全部来自真实 manifest，8–12 枝），先把人请进工作台。
 */

import type { PaperId, RibbonColorId } from './types';
import type { PhotoSceneId, PresentationKind } from './presentation';

export type ShowcaseSource = 'lux3d' | 'handmade';

export interface ShowcasePalette {
  /** 真实 manifest 花材 id，按「主花 → 配花 → 绿叶」排列，8–12 枝。 */
  assetIds: string[];
  paperId: PaperId;
  ribbonColorId: RibbonColorId;
  presentationKind: PresentationKind;
  photoScene: PhotoSceneId;
}

/** Only accepted, locally available models belong in the public gallery. */
export interface ShowcaseItem {
  id: string;
  number: string;
  title: string;
  english: string;
  description: string;
  flowers: string;
  /** 作品来源：一体模型 / 工作台手作。 */
  source: ShowcaseSource;
  /** 一体模型的 GLB 路径；手作作品没有模型，只有封面。 */
  model?: string;
  cover: string;
  background: string;
  accent: string;
  palette: ShowcasePalette;
}

export const SHOWCASE_ITEMS: readonly ShowcaseItem[] = [
  {
    id: 'morning', number: '01', title: '清晨来信',
    english: 'A letter in soft pink.',
    description: '把清晨的温柔，收进一束花里。',
    flowers: '粉玫瑰 · 尤加利 · 象牙白包装',
    source: 'lux3d',
    model: 'showcase/morning-letter.glb',
    cover: 'showcase/morning-letter.webp',
    background: '#f6f0e6', accent: '#a96f78',
    palette: {
      assetIds: [
        'rose-pink', 'rose-pink', 'rose-ivory', 'tulip-pink', 'spray-rose-pink',
        'babys-breath-1', 'babys-breath-1', 'eucalyptus-green', 'eucalyptus-silver', 'ruscus-1',
      ],
      paperId: 'ivory', ribbonColorId: 'rose', presentationKind: 'paper', photoScene: 'window',
    },
  },
  {
    id: 'daylight', number: '02', title: '窗边白昼',
    english: 'A little light by the window.',
    description: '让日常的光，停在花开的地方。',
    flowers: '奶油郁金香 · 尤加利 · 素白细口瓶',
    source: 'lux3d',
    model: 'showcase/daylight-vase.glb', cover: 'showcase/daylight-vase.webp',
    background: '#eef0e7', accent: '#78856b',
    palette: {
      assetIds: [
        'tulip-cream', 'tulip-cream', 'tulip-butter', 'eucalyptus-green', 'veronica-1',
        'babys-breath-1', 'ruscus-1', 'salal-1', 'eucalyptus-silver',
      ],
      paperId: 'sage', ribbonColorId: 'sage', presentationKind: 'vase', photoScene: 'window',
    },
  },
  {
    id: 'evening', number: '03', title: '玫瑰晚信',
    english: 'Some words bloom after dusk.',
    description: '把没说出口的话，交给晚开的玫瑰。',
    flowers: '酒红玫瑰 · 白玫瑰 · 浅色纸包',
    source: 'lux3d',
    model: 'showcase/evening-letter.glb', cover: 'showcase/evening-letter.webp',
    background: '#f3e9e3', accent: '#945b65',
    palette: {
      assetIds: [
        'rose-red', 'rose-red', 'rose-ivory', 'spray-rose-pink', 'statice-2',
        'eucalyptus-deep', 'ruscus-1', 'leatherleaf-1', 'eucalyptus-green', 'babys-breath-2',
      ],
      paperId: 'wine', ribbonColorId: 'champagne', presentationKind: 'paper', photoScene: 'gallery',
    },
  },
  {
    id: 'sunshine', number: '04', title: '向阳小札',
    english: 'A pocketful of sunshine.',
    description: '把明亮的好心情，轻轻递给你。',
    flowers: '向日葵 · 白小菊 · 奶油色包装',
    source: 'lux3d',
    model: 'showcase/sunshine-note.glb', cover: 'showcase/sunshine-note.webp',
    background: '#f5efda', accent: '#b28c37',
    palette: {
      assetIds: [
        'sunflower-1', 'sunflower-2', 'daisy-gold', 'daisy-cream', 'veronica-2',
        'babys-breath-1', 'eucalyptus-green', 'ruscus-1', 'asparagus-fern-1', 'waxflower-1',
      ],
      paperId: 'kraft', ribbonColorId: 'cream', presentationKind: 'paper', photoScene: 'garden',
    },
  },
  {
    id: 'wood-table', number: '05', title: '旧木桌的午后',
    english: 'An afternoon on an old wooden table.',
    description: '为家里那张旧木桌，留一束慢慢开的花。',
    flowers: '牡丹 · 康乃馨 · 灰绿尤加利 · 豆沙陶罐',
    source: 'handmade',
    cover: 'showcase/handmade-wood-table.jpg',
    background: '#efe6da', accent: '#9a7266',
    palette: {
      assetIds: [
        'peony-1', 'peony-2', 'herbaceous-peony-1', 'carnation-1', 'lisianthus-2',
        'alstroemeria-2', 'eucalyptus-silver', 'salal-1', 'bear-grass-1',
      ],
      paperId: 'clay', ribbonColorId: 'clay', presentationKind: 'pot', photoScene: 'cafe',
    },
  },
  {
    id: 'birthday', number: '06', title: '给朋友的生日',
    english: 'A birthday for a friend.',
    description: '挑她喜欢的那几种颜色，装进一只抱抱桶。',
    flowers: '康乃馨 · 小菊 · 满天星 · 牛皮抱抱桶',
    source: 'handmade',
    cover: 'showcase/handmade-birthday.jpg',
    background: '#f7edd9', accent: '#b07a55',
    palette: {
      assetIds: [
        'carnation-1', 'carnation-1', 'carnation-2', 'daisy-gold', 'spray-chrysanthemum-1',
        'waxflower-1', 'babys-breath-2', 'eucalyptus-green', 'ruscus-1',
      ],
      paperId: 'kraft', ribbonColorId: 'champagne', presentationKind: 'bucket', photoScene: 'festive',
    },
  },
];

export const SHOWCASE_LUX3D_ITEMS = SHOWCASE_ITEMS.filter((item) => item.source === 'lux3d');
export const SHOWCASE_HANDMADE_ITEMS = SHOWCASE_ITEMS.filter((item) => item.source === 'handmade');

export function findShowcase(id: string | null): ShowcaseItem | undefined {
  return SHOWCASE_ITEMS.find(item => item.id === id);
}

export function showcaseAsset(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`;
}
