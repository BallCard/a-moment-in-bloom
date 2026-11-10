import type { BouquetDocument, PaperId, StemInstance } from './types';
import { clampPose, poseToEuler } from './pose';
import { TABLE_TOP_Y } from '../config';
import { filterOrnamentsFor, supportsFoam } from './decor-capability';

/**
 * 呈现方式：纸包花束 + 容器插花。
 * V10 新增藤编花篮、花礼盒、抱抱桶、手提花袋、木条花箱；花篮/礼盒为程序化几何，
 * 其余容器如生成了 Lux3D GLB（见 VESSEL_MODELS）会在运行时替换外观，失败时回退程序化。
 */
export type PresentationKind = 'paper' | 'vase' | 'pot' | 'basket' | 'box' | 'bucket' | 'bag' | 'crate';
export type VesselKind = Exclude<PresentationKind, 'paper'>;

export const PRESENTATION_KINDS: PresentationKind[] = ['paper', 'vase', 'pot', 'basket', 'box', 'bucket', 'bag', 'crate'];

export const PRESENTATION_LABELS: Record<PresentationKind, string> = {
  paper: '纸片包装',
  vase: '细口花瓶',
  pot: '宽口陶罐',
  basket: '藤编花篮',
  box: '花礼盒',
  bucket: '抱抱桶',
  bag: '手提花袋',
  crate: '木条花箱',
};

export interface PaperSheet {
  id: string;
  paperId: PaperId;
  height: number;
  rotation: number;
  width: number;
  leftFold: number;
  rightFold: number;
  gather: number;
  fixed: boolean;
}
/**
 * 花泥状态（V16 §3）：只有适用容器「放入花泥」后才有意义。
 * - fitted：是否已放入；cut：裁切贴合度 0–1（1 = 已按内腔切好）；
 * - 花泥只遮挡内部，穿壁/穿底问题由枝脚适配、剪短与显示边界共同处理。
 */
export interface FoamState {
  fitted: boolean;
  cut: number;
}
export const DEFAULT_FOAM: FoamState = { fitted: false, cut: 0 };

export interface PresentationState {
  kind: PresentationKind;
  sheets: PaperSheet[];
  layouts?: Partial<Record<PresentationKind, { id: string; position: StemInstance['position']; pose: StemInstance['pose']; tailLength: number }[]>>;
  foam?: FoamState;
}

/**
 * 单枝处理状态（V16 扩展）：
 * - tailLength / removedLeaves：原有修剪（只对能分离花头与叶片的玫瑰/郁金香生效）；
 * - petalFlip：翻瓣程度 0–1（0 = 未翻；仅「可翻瓣」花材写这个值）；
 * - thornsRemoved：是否已去刺（仅「可去刺」花材）；
 * - autoTrim：该枝的修剪是否由一键整理产生，界面据此区分手动修剪与自动整理。
 */
export interface Preparation {
  tailLength: number;
  removedLeaves: number[];
  petalFlip?: number;
  thornsRemoved?: boolean;
  autoTrim?: boolean;
}

/** 拍照场景：工作台布景（studio）与外景；V10 增加花店/庭院，V11 增加节日/家居/咖啡馆。 */
export type PhotoSceneId = 'window' | 'studio' | 'gallery' | 'florist' | 'garden' | 'festive' | 'living' | 'cafe';

export const PHOTO_SCENES: { id: PhotoSceneId; label: string }[] = [
  { id: 'window', label: '窗边' },
  { id: 'studio', label: '素色台面' },
  { id: 'gallery', label: '墨绿展台' },
  { id: 'florist', label: '花店一角' },
  { id: 'garden', label: '庭院午后' },
  { id: 'festive', label: '节日暖光' },
  { id: 'living', label: '家居客厅' },
  { id: 'cafe', label: '咖啡馆' },
];

export interface PhotoSettings {
  scene: PhotoSceneId;
  autoTrim: boolean;
  frame: 'none' | 'paper' | 'postcard';
  format: 'square' | 'portrait';
  zoom: number;
  offsetX: number;
  offsetY: number;
  title: string;
  direction?: [number, number, number];
}
export const DEFAULT_PHOTO: PhotoSettings = { scene: 'window', autoTrim: true, frame: 'paper', format: 'square', zoom: 1, offsetX: 0, offsetY: 0, title: '' };
export const DEFAULT_PREPARATION: Preparation = { tailLength: 0.22, removedLeaves: [0] };

/**
 * 容器尺寸与插花约束。半径/高度单位都是米，与 Three.js 场景同尺度。
 * - spread：花枝支点散布半径（花泥表面的插花范围）；
 * - shallow：宽口浅器不按器壁算倾角——花泥/内衬挡住茎，靠 maxTilt 限制姿态；
 * - tailLength：成品自动整理时保留的茎长（花篮/花盒更深地藏在容器里）。
 */
export interface VesselSpec {
  label: string;
  height: number;
  mouth: number;
  base: number;
  color: string;
  spread: number;
  maxTilt: number;
  tailLength: number;
  shallow?: boolean;
}

export const VESSELS: Record<VesselKind, VesselSpec> = {
  vase: { label: '细口花瓶', height: 0.25, mouth: 0.063, base: 0.08, color: '#ded8c8', spread: 0.0265, maxTilt: 12, tailLength: 0.2 },
  pot: { label: '宽口陶罐', height: 0.18, mouth: 0.112, base: 0.115, color: '#b78064', spread: 0.047, maxTilt: 24, tailLength: 0.125 },
  basket: { label: '藤编花篮', height: 0.15, mouth: 0.2, base: 0.2, color: '#b08a5e', spread: 0.13, maxTilt: 32, tailLength: 0.1, shallow: true },
  box: { label: '花礼盒', height: 0.16, mouth: 0.17, base: 0.17, color: '#d8c4a8', spread: 0.115, maxTilt: 26, tailLength: 0.09, shallow: true },
  bucket: { label: '抱抱桶', height: 0.35, mouth: 0.075, base: 0.075, color: '#c19a72', spread: 0.05, maxTilt: 14, tailLength: 0.18, shallow: true },
  bag: { label: '手提花袋', height: 0.34, mouth: 0.1, base: 0.1, color: '#c3a577', spread: 0.07, maxTilt: 16, tailLength: 0.12, shallow: true },
  crate: { label: '木条花箱', height: 0.18, mouth: 0.17, base: 0.17, color: '#b78f63', spread: 0.12, maxTilt: 30, tailLength: 0.1, shallow: true },
};

/**
 * Lux3D 生成的花器 GLB（真实 PBR 模型，2026-11-07 生成，任务 4815066/84/99/119/140，共 100 积分）。
 * displayHeight 是加载后归一化的整体高度（含提手/盒盖），运行时按包围盒缩放、居中、落地；
 * 没有配置的形态（花瓶/陶罐）继续用程序化几何。加载失败自动回退程序化，不阻塞玩法。
 */
export interface VesselModelSpec {
  url: string;
  displayHeight: number;
  /** 模型正面不在 +z 时的额外绕 Y 旋转（度）。 */
  rotationY?: number;
}

export const VESSEL_MODELS: Partial<Record<VesselKind, VesselModelSpec>> = {
  basket: { url: 'assets/vessels/wicker-basket.glb', displayHeight: 0.3 },
  box: { url: 'assets/vessels/gift-box.glb', displayHeight: 0.235 },
  bucket: { url: 'assets/vessels/kraft-bucket.glb', displayHeight: 0.36 },
  bag: { url: 'assets/vessels/paper-bag.glb', displayHeight: 0.34 },
  crate: { url: 'assets/vessels/wood-crate.glb', displayHeight: 0.18 },
};

export function isPresentationKind(value: unknown): value is PresentationKind {
  return typeof value === 'string' && PRESENTATION_KINDS.includes(value as PresentationKind);
}

/** 旧存档只认识纸片/花瓶/陶罐；未知值一律回到纸片，不报错。 */
export function readPresentationKind(value: unknown): PresentationKind {
  return isPresentationKind(value) ? value : 'paper';
}

export function newSheet(paperId: PaperId = 'kraft', index = 0): PaperSheet {
  return { id: `sheet_${Date.now().toString(36)}_${index}`, paperId, height: index * -0.025, rotation: index * 65, width: 1, leftFold: 0.75, rightFold: 0.85, gather: 0.8, fixed: false };
}
const numeric = (value: unknown, fallback: number, min: number, max: number): number => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {};
export function readPreparation(raw: unknown): Preparation {
  const v = record(raw);
  return {
    tailLength: numeric(v.tailLength, 0.22, 0.1, 0.24),
    removedLeaves: Array.isArray(v.removedLeaves) ? [...new Set(v.removedLeaves.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < 3))] : [0],
    petalFlip: numeric(v.petalFlip, 0, 0, 1),
    thornsRemoved: v.thornsRemoved === true,
    autoTrim: v.autoTrim === true,
  };
}

export function readFoam(raw: unknown): FoamState {
  const v = record(raw);
  return {
    fitted: v.fitted === true,
    cut: numeric(v.cut, 0, 0, 1),
  };
}
export function readPresentation(raw: unknown, fallbackPaper: PaperId): PresentationState {
  const v = record(raw);
  const papers = ['ivory', 'kraft', 'sage', 'mist', 'clay', 'wine'];
  const used = new Set<string>();
  return {
    kind: readPresentationKind(v.kind),
    layouts: Object.fromEntries(PRESENTATION_KINDS.flatMap(kind => {
      const values=record(v.layouts)[kind];
      if(!Array.isArray(values))return [];
      return [[kind,values.slice(0,20).flatMap(raw=>{
        const item=record(raw), p=item.position;
        if(typeof item.id!=='string'||!Array.isArray(p)||p.length!==3||!p.every(n=>typeof n==='number'&&Number.isFinite(n)))return [];
        return [{id:item.id.slice(0,80),position:p.map(n=>Math.max(-3,Math.min(3,n))) as StemInstance['position'],pose:clampPose({...{height:0,tilt:0,direction:0,spin:0},...record(item.pose)}),tailLength:numeric(item.tailLength,.22,.1,.24)}];
      })]];
    })),
    sheets: (Array.isArray(v.sheets) && v.sheets.length ? v.sheets.slice(0, 3) : [newSheet(fallbackPaper)]).map((rawSheet, i) => {
      const s = record(rawSheet);
      let id = typeof s.id === 'string' ? s.id.slice(0, 80) : `sheet_restored_${i}`;
      if (used.has(id)) id += `_${i}`;
      used.add(id);
      return { id, paperId: papers.includes(String(s.paperId)) ? s.paperId as PaperId : fallbackPaper, height: numeric(s.height, 0, -0.1, 0.12), rotation: numeric(s.rotation, 0, -180, 180), width: numeric(s.width, 1, 0.7, 1.35), leftFold: numeric(s.leftFold, 0.75, 0, 1), rightFold: numeric(s.rightFold, 0.85, 0, 1), gather: numeric(s.gather, 0.8, 0, 1), fixed: s.fixed === true };
    }),
    foam: readFoam(v.foam),
  };
}
export function readPhoto(raw: unknown): PhotoSettings {
  const v = record(raw);
  const d=v.direction;
  const direction=Array.isArray(d)&&d.length===3&&d.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=1)&&Math.hypot(...d)>.1 ? d as [number,number,number] : undefined;
  return {...readPhotoFields(v),direction};
}
function readPhotoFields(v: Record<string,unknown>): PhotoSettings {
  const scene=PHOTO_SCENES.some(item=>item.id===v.scene) ? v.scene as PhotoSceneId : 'window';
  return { scene, autoTrim: v.autoTrim !== false, frame: v.frame === 'none' || v.frame === 'postcard' ? v.frame : 'paper', format: v.format === 'portrait' ? 'portrait' : 'square', zoom: numeric(v.zoom, 1, 0.75, 1.3), offsetX: numeric(v.offsetX, 0, -0.2, 0.2), offsetY: numeric(v.offsetY, 0, -0.2, 0.2), title: typeof v.title === 'string' ? Array.from(v.title).slice(0, 30).join('') : '' };
}
/** 花器中的支点散布在口沿内；下端也必须留在器壁内，故限制倾斜而非沿用手绑姿态。 */
export function adaptStems(stems: StemInstance[], kind: PresentationKind): StemInstance[] {
  return stems.map((stem, i) => {
    if (kind === 'paper') return { ...stem, position: [Math.sin(i * 2.4) * 0.012, 0.9, Math.cos(i * 2.4) * 0.012] };
    const vessel = VESSELS[kind];
    const radius = vessel.spread * Math.sqrt((i + 1) / Math.max(1, stems.length));
    const angle = i * 2.39996;
    return {
      ...stem,
      position: [Math.sin(angle) * radius, TABLE_TOP_Y + vessel.height - 0.018, Math.cos(angle) * radius],
      pose: { ...stem.pose, height: Math.min(stem.pose.height, 0.06), tilt: Math.min(stem.pose.tilt, vessel.maxTilt), direction: angle * 180 / Math.PI },
      preparation: { ...readPreparation(stem.preparation), tailLength: vessel.tailLength },
    };
  });
}
export function presentationOf(doc: BouquetDocument): PresentationState { return doc.presentation; }

export function constrainStem(stem:StemInstance,kind:PresentationKind):StemInstance {
  if(kind==='paper')return stem;
  const pose={...stem.pose};let position=stem.position;
  let preparation=stem.preparation;
  const vessel=VESSELS[kind];
  const radial=Math.hypot(position[0],position[2]);
  const limit=vessel.spread*1.15;
  const ratio=radial>limit?limit/radial:1;
  position=[position[0]*ratio,TABLE_TOP_Y+vessel.height-.018,position[2]*ratio];
  preparation={...preparation,tailLength:Math.min(preparation.tailLength,(vessel.height-.04)/stem.scale)};
  if(vessel.shallow){
    // 宽口浅器（花篮/花盒）：花泥遮住茎，不再按器壁算倾角，只夹到形态允许的最大外倾。
    pose.tilt=Math.min(pose.tilt,vessel.maxTilt);
  }else{
    const clearance=Math.min(vessel.mouth*.4,vessel.base*.72-Math.min(radial,limit));
    pose.tilt=Math.min(pose.tilt,Math.atan2(Math.max(.005,clearance),preparation.tailLength*stem.scale)*180/Math.PI);
  }
  pose.height=Math.max(-.01,Math.min(pose.height,.055));
  const cosine=Math.cos(pose.tilt*Math.PI/180);
  pose.height=Math.max(pose.height,(TABLE_TOP_Y+.012-position[1])/cosine+preparation.tailLength*stem.scale);
  return {...stem,position,pose,preparation,rotation:poseToEuler(pose)};
}

/** 每种呈现方式保留自己的支点与姿态；剪叶跨形式保留，插深单独恢复。 */
export function switchPresentation(source:BouquetDocument,kind:PresentationKind):Pick<BouquetDocument,'stems'|'presentation'|'wrapping'|'ornaments'> {
  if(source.presentation.kind===kind)return {stems:source.stems,presentation:source.presentation,wrapping:source.wrapping,ornaments:source.ornaments};
  const layouts={...source.presentation.layouts,[source.presentation.kind]:source.stems.map(stem=>({id:stem.id,position:stem.position,pose:stem.pose,tailLength:stem.preparation.tailLength}))};
  const stems=adaptStems(source.stems,kind).map(stem=>{
    const saved=layouts[kind]?.find(item=>item.id===stem.id);
    const next=saved?{...stem,position:saved.position,pose:saved.pose,preparation:{...stem.preparation,tailLength:saved.tailLength}}:stem;
    return constrainStem({...next,rotation:poseToEuler(next.pose)},kind);
  });
  // V16 §3/§5：换容器后花泥按新形态重算；不适用的装饰直接移除，不遗留悬空装饰。
  const foam = supportsFoam(kind)
    ? source.presentation.foam ?? DEFAULT_FOAM
    : DEFAULT_FOAM;
  return {
    stems,
    presentation:{...source.presentation,kind,layouts,foam},
    wrapping:{...source.wrapping,enabled:true},
    ornaments:filterOrnamentsFor(source.ornaments,kind),
  };
}
