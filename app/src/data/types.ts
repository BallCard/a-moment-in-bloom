/** 数据层类型：花材目录、花枝实例、作品文档。 */
import type { Preparation, PresentationKind, PresentationState, PhotoSettings } from './presentation';

export type AssetKind = 'main' | 'filler' | 'greenery';

/**
 * 程序化占位花的构造器标识。真实 GLB 载入失败时也按它回退。
 *
 * V0.7.5：30 种花型（主花／配花／绿叶各 10 种）以**这一份清单为唯一来源**。
 * 顺序与 `data/builtin.ts` 的 `V07_SPECIES` 一致（V16 §2 追加的两种新花型按
 * 「末尾追加」约定放在最后，`V07_SPECIES` 里对应条目仍按主花分组）；manifest 的
 * `fallback.procedural` 与花科分组的 `family` 都取这里的值。
 * `catalog.ts` 的 `isProceduralKey` 直接查这张表，别再手写字符串副本。
 */
export const PROCEDURAL_KEYS = [
  // V5 及更早的五种花材
  'tulip',
  'rose',
  'eucalyptus',
  'spray',
  'daisy',
  // V0.7 §5 扩充：主花 7 + 配花 9 + 绿叶 9
  'peony',
  'herbaceous-peony',
  'carnation',
  'lily',
  'sunflower',
  'dahlia',
  'calla',
  'lisianthus',
  'alstroemeria',
  'spray-chrysanthemum',
  'babys-breath',
  'statice',
  'waxflower',
  'rice-flower',
  'veronica',
  'snapdragon',
  'ruscus',
  'salal',
  'asparagus-fern',
  'leatherleaf',
  'boston-fern',
  'ivy',
  'fatsia',
  'aspidistra',
  'bear-grass',
  // V16 §2 补充的两种花型（绣球、蝴蝶兰）：先以程序化占位上线，2026-11-10 已换成
  // Lux3D 真实模型；这里保留 key 作为「加载失败时可用程序化几何兜底」的声明。
  'hydrangea',
  'orchid',
] as const;

export type ProceduralKey = (typeof PROCEDURAL_KEYS)[number];

/** 配色变体的着色范围：花瓣 / 叶片 / 所有有彩像素。 */
export type RecolorMode = 'petals' | 'foliage' | 'all';

/**
 * 配色变体的着色规则。
 *
 * - 字符串 `'petals'` / `'foliage'` / `'all'`：用该模式的默认色相窗口
 *   （花瓣 295°→45°、叶片 55°→200°、all 不筛色相）；
 * - 对象 `{ mode, hue: [a, b] }`：自定义**环绕色相窗口**，例如 `[300, 60]`
 *   表示 300°→360° 与 0°→60° 两段都算。
 */
export type RecolorSpec = RecolorMode | { mode: RecolorMode; hue: [number, number] };

export type Vec3 = [number, number, number];

/**
 * 花枝姿态。scene 用它构造四元数；position/rotation 写入序列化数据。
 * - height：沿茎方向的位移（米），正值把花头往上提
 * - tilt：与竖直方向的夹角（度）
 * - direction：倾斜方向（度，0 = 朝 +Z 即默认镜头方向）
 * - spin：绕自身茎轴旋转（度），影响叶片朝向
 */
export interface StemPose {
  height: number;
  tilt: number;
  direction: number;
  spin: number;
}

/** 一枝花的实例。同类花枝共用几何/材质，但各自独立变换。 */
export interface StemInstance {
  id: string;
  assetId: string;
  /** 预留：同一资产的多色变体序号（当前按 assetId 区分颜色）。 */
  variant: number;
  /** 握点（花枝局部原点）在世界中的位置。 */
  position: Vec3;
  /** 由 pose 换算出的欧拉角（弧度，YXZ 顺序），供后续导出/导入使用。 */
  rotation: Vec3;
  scale: number;
  pose: StemPose;
  preparation: Preparation;
}

/** 包装纸颜色（阶段 D 的三种柔和纸色）。 */
export type PaperId = 'ivory' | 'kraft' | 'sage' | 'mist' | 'clay' | 'wine';

/** 丝带颜色。 */
export type RibbonColorId = 'rose' | 'cream' | 'sage' | 'champagne' | 'mist' | 'clay';

/** 工作流阶段：摆放 → 包装 → 成品欣赏。 */
export type WorkflowStage = 'arrange' | 'wrap' | 'finish';

/** 分步包装：摆纸 → 合拢收口 → 丝带 → 卡片/成品。 */
export type PackageStep = 'paper' | 'fold' | 'ribbon' | 'card';

/** 建议位的类型：补空隙 / 强化展示面 / 丰富层次。 */
export type SuggestionKind = 'gap' | 'showcase' | 'layer';

/** 动态效果偏好：跟随系统（auto）或强制减少（reduced）。 */
export type MotionPreference = 'auto' | 'reduced';

/**
 * 建议位：姿态 + 花头世界坐标 + 一句理由。由场景计算，store 只存放。
 * pose 只含可编辑的三个自由度（spin 不影响建议位落点）。
 */
export interface SuggestionCandidate {
  /** 稳定 id（同一花束坐标下不变）。 */
  id: string;
  pose: Pick<StemPose, 'height' | 'tilt' | 'direction'>;
  /** 花头世界坐标（花束坐标，不随相机变）。 */
  head: Vec3;
  /** 中文一句，≤ 18 字。 */
  reason: string;
  kind: SuggestionKind;
}

/** 可关闭的辅助：轻吸附与摆放建议。属于本机会话设置，不写入作品 JSON。 */
export interface AssistSettings {
  snapping: boolean;
  suggestions: boolean;
}

/**
 * 辅助装饰（V16 §5）。统一收纳在「装饰」入口，选中后才展开参数。
 * 灯串/串饰/插饰/系结与吊饰四组，具体款式少量精选（见 data/ornaments.ts）。
 */
export type OrnamentKind =
  | 'light-string'
  | 'star-lights'
  | 'pearl-strand'
  | 'silk-thread'
  | 'butterfly'
  | 'star-pick'
  | 'heart-pick'
  | 'bow'
  | 'tag';

/** 装饰实例：属于作品内容，写入文档、参与撤销、保存后恢复。 */
export interface OrnamentInstance {
  id: string;
  kind: OrnamentKind;
  /** 可选颜色预设 id（见 data/ornaments.ts 的 ORNAMENT_COLORS）。 */
  colorId: string;
  /** 相对花束支点的位置（米，工作台坐标）。 */
  position: Vec3;
  /** 绕 Y 轴旋转（度）。 */
  rotation: number;
  /** 整体大小倍率 0.7–1.3。 */
  scale: number;
  /** 灯饰亮度 0–1；非灯饰忽略。 */
  intensity: number;
  /** 绕行/摆放样式序号（0–2），不同款式含义见 data/ornaments.ts。 */
  variant: number;
}

/** 音频偏好：音量、静音与背景音乐开关。本机设置，不写作品。 */
export interface AudioSettings {
  muted: boolean;
  /** 0–1。 */
  volume: number;
  /** 背景音乐开关（默认开；与静音/音量分开控制）。 */
  bgm: boolean;
}

/** 选中花头在屏幕上的锚点（CSS 像素，相对画布左上角）。 */
export interface SelectionAnchor {
  x: number;
  y: number;
  visible: boolean;
}

export interface WrappingState {
  enabled: boolean;
  paperId: PaperId;
  /** paper 摆纸 → fold 合拢收口 → ribbon 丝带 → card 卡片/成品。 */
  step: PackageStep;
  /** 摆纸阶段的开口大小，0.85–1.12。 */
  openScale: number;
}

export interface RibbonState {
  colorId: RibbonColorId;
}

/** 卡片内容。文字只经由受控输入和 Canvas 绘制，绝不拼 HTML。 */
export interface CardState {
  to: string;
  message: string;
  from: string;
}

/** 作品文档：花枝 + 包装 + 丝带 + 卡片。 */
export interface BouquetDocument {
  version: number;
  assetsVersion: string;
  /**
   * V0.7.3：这份作品使用的花材尺寸候选（a=原尺寸 / b=缩小 20% / c=缩小 30%）。
   * 旧存档没有这个字段，读回时按 'a' 处理，保证相册里的旧成品不会突然变比例。
   * 新作品写入当时的默认候选。
   */
  sizeCandidate?: 'a' | 'b' | 'c';
  createdAt: string;
  updatedAt: string;
  stems: StemInstance[];
  wrapping: WrappingState;
  ribbon: RibbonState;
  card: CardState;
  presentation: PresentationState;
  photo: PhotoSettings;
  /**
   * V16 §5：辅助装饰。旧存档没有这个字段时读回空数组，
   * 不修改原作品、不擅自补装饰。
   */
  ornaments: OrnamentInstance[];
}

/** 从 manifest 读取的导入变换信息。单位为米/度，见 app/README.md。 */
export interface AssetTransform {
  scale: number;
  /** 绕 Y 轴旋转（度）。 */
  rotationY: number;
  /** 模型局部 Y 坐标中的握点位置（缩放后，米）。 */
  gripAt: number;
  /** 握点到花头的局部 Y 距离（缩放后，米）。 */
  headOffsetY: number;
}

/**
 * 花材尺寸配置（V0.7 §3）：把花头大小、枝长与叶片展开分开调。
 *
 * 约定：倍率都相对模型原始尺寸，1 = 原样。花头缩放绕 `transform.headOffsetY`
 * 这个锚点做，所以花头缩小后花头中心与枝长都不动，只改花头本身的大小。
 */
export interface AssetSizeConfig {
  /** 花头横向倍率（X/Z）。玫瑰、郁金香的 70% / 80% / 90% 对照就是改这个值。 */
  headWidth: number;
  /** 花头纵向倍率（Y）。缺省跟随 headWidth。 */
  headHeight?: number;
  /** 叶片展开幅度倍率，1 = 原样。 */
  leafSpread?: number;
  /**
   * 枝长倍率（V0.7.3，只对能分离花头的花材生效）：花头中心与可见花头底部
   * 一起按这个倍率往握点方向收，握点、尾茎与包装连接点不动。
   * 1 = 原样；0.85–1 是验收候选范围。程序化花材没有分离花头，用 uniformScale。
   */
  stemFactor?: number;
  /** 覆盖花头占用半径（米，缩放后）。缺省按花头包围盒实测。 */
  headRadius?: number;
  /**
   * 整体尺寸倍率（默认 1）。程序化花材按真实花材的体量做标定用：
   * 因为它们的茎和花头是同一份几何，只能整体缩放；玫瑰、郁金香这类
   * 能分出花头的花材用 headWidth/headHeight，不该动这个值。
   */
  uniformScale?: number;
  /** 多头花：逐个登记的花头局部偏移与半径；单头花不填。 */
  heads?: { offset: Vec3; radius: number }[];
}

/** 目录中的一种具体花材（一种花色即一条）。 */
export interface AssetEntry {
  assetId: string;
  /** 归组键，用于花材架把同种花的颜色放在一起。 */
  family: string;
  kind: AssetKind;
  /** 单枝显示名，例如「粉色郁金香」。 */
  displayName: string;
  /** 花材种类名，例如「郁金香」。 */
  familyName: string;
  /** 颜色名，例如「粉」。 */
  variantName: string;
  /** 调色板色值 / 程序化回退花的主色。 */
  color: string;
  /** 真实资产文件名（相对 public/assets/）。为空表示只有程序化占位花。 */
  glb?: string;
  /**
   * 静态缩略图（相对 `assets/`，如 `thumbs/peony-1.png`）。
   * 有它时花材架直接显示静态图，不再为每个配色下载 GLB；缺失或加载失败
   * 时回退到运行时渲染（见 `three/assets/thumbnails.ts`）。
   */
  thumb?: string;
  /** GLB 配色变体：花瓣 / 叶片 / 全部，或带自定义环绕色相窗口；缺省表示直接用原贴图。 */
  recolor?: RecolorSpec;
  transform?: AssetTransform;
  /** V0.7 尺寸配置；缺省按花型默认值补全。 */
  size?: AssetSizeConfig;
  /** 程序化占位花构造器。 */
  procedural: ProceduralKey;
  source: 'builtin' | 'manifest';
}

/** 花材架中的一组同种花。 */
export interface AssetFamily {
  family: string;
  displayName: string;
  kind: AssetKind;
  note: string;
  entries: AssetEntry[];
}

export interface RuntimeCatalog {
  mode: 'builtin' | 'manifest';
  assetsVersion: string;
  entries: AssetEntry[];
  entriesById: Record<string, AssetEntry>;
  families: AssetFamily[];
  /** 载入过程中的非阻塞提示。 */
  notice?: string;
}

export interface ToastItem {
  id: number;
  text: string;
  kind: 'info' | 'warn' | 'success';
}

// ---------- 第三轮：视角、双模式、委托与相册 ----------

/** 预设视角；free 表示用户手动转过镜头，不再套用预设。 */
export type ViewPreset = 'front' | 'quarter' | 'side' | 'top' | 'free';

/** 自由制作 / 委托模式。 */
export type GameMode = 'free' | 'commission';

export type CommissionCheckKind =
  | 'kindCount'
  | 'assetCount'
  | 'familyCount'
  | 'totalCount'
  | 'paper'
  | 'ribbon'
  | 'ornament'
  | 'presentation'
  | 'cardTo'
  | 'cardMessage';

/** 一条可明确判定的委托要求。 */
export interface CommissionCheck {
  id: string;
  /** 玩家看到的要求，≤ 20 字。 */
  label: string;
  kind: CommissionCheckKind;
  /** assetCount 用的花材 id。 */
  assetId?: string;
  /** kindCount 用的花材角色。 */
  assetKind?: AssetKind;
  assetIds?: string[];
  /** familyCount 用的花科（如 eucalyptus / tulip），同科不同配色都算。 */
  family?: string;
  /** 数量类至少多少 / cardTo、cardMessage 的最少字符。 */
  min?: number;
  paperId?: PaperId;
  ribbonColorId?: RibbonColorId;
  /** ornament 用的装饰款式（V16 §5：委托只要求当前形态真能加的装饰）。 */
  ornamentKind?: OrnamentKind;
  /** presentation 用的呈现形态（纸包 / 花瓶 / 花篮 / 礼盒…）。 */
  presentationKind?: PresentationKind;
}

/** 一个短委托。内容写死在前端，状态存本地。 */
export interface CommissionDef {
  id: string;
  order: number;
  title: string;
  customer: string;
  occasion: string;
  brief: string;
  /** 卡片强调色（CSS 颜色）。 */
  accent: string;
  checks: CommissionCheck[];
  responseComplete: string;
  responsePartial: string;
  nextId: string | null;
}

export interface CommissionCheckResult {
  id: string;
  label: string;
  met: boolean;
}

export interface CommissionProgress {
  commissionId: string;
  checks: CommissionCheckResult[];
  complete: boolean;
  metCount: number;
  total: number;
}

/** 相册条目里保存的委托结算记录（之后编辑副本不改变它）。 */
export interface CommissionRecord {
  commissionId: string;
  title: string;
  customer: string;
  complete: boolean;
  metCount: number;
  total: number;
  deliveredAt: string;
  response?: string;
}

export interface AlbumFlowerSummary {
  assetId: string;
  name: string;
  color: string;
  count: number;
}

/**
 * 一条 AI 点评（V6 P0-B）。
 *
 * 点评跟着「那张照片」走，不跟工作台走：snapshot 是点评时的画面签名
 * （花枝 + 包装/丝带/卡片 + presentation + 照片设置 + 实际机位），
 * 只有签名一致时界面才把这条点评当作「当前画面」的点评。
 */
export interface PhotoReview {
  score: number;
  summary: string;
  strengths: string[];
  suggestions: string[];
  /** 点评模型标识（服务端返回，如 DeepSeek 1017）。 */
  model?: string;
  /** 视觉观察模型标识（服务端返回）。 */
  visionModel?: string;
  /** 点评生成时间（ISO）。 */
  createdAt: string;
  /** 输入签名：见 data/album.ts 的 photoSnapshotSignature()。 */
  snapshot: string;
}

/** 本地相册条目：缩略图 + 可恢复作品 + 花材摘要（委托作品再附结算记录）。 */
export interface AlbumPhoto {
  id: string;
  createdAt: string;
  thumbnail: string;
  doc: BouquetDocument;
  /** 拍摄/点评时留下的点评；旧照片没有点评属于正常情况。 */
  review?: PhotoReview;
}
export interface AlbumEntry {
  photos: AlbumPhoto[];
  coverId: string;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  mode: GameMode;
  doc: BouquetDocument;
  /** data:image/jpeg;base64,...；读取失败时允许空串。 */
  thumbnail: string;
  flowers: AlbumFlowerSummary[];
  stemCount: number;
  commission?: CommissionRecord;
}

/** 指针进入建议位时的提示锚点，场景节流回报。 */
export interface SnapHint {
  suggestionId: string;
  /** CSS 像素，相对画布左上角。 */
  x: number;
  y: number;
  reason: string;
  kind: SuggestionKind;
  /** 是否由「钉住建议卡」触发。 */
  pinned: boolean;
}
