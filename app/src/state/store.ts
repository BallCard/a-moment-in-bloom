/** 应用状态：作品文档、选择/悬停、放置模式、阶段与辅助、建议位、撤销重做与自动保存。 */

import {
  ALBUM_LIMIT,
  CARD_FROM_MAX,
  CARD_MESSAGE_MAX,
  CARD_TO_MAX,
  GRIP_Y,
  HISTORY_LIMIT,
  MAX_ORNAMENTS,
  MAX_STEMS,
  MAX_TILT,
  SCHEMA_VERSION,
  VIEW_PRESETS,
} from '../config';
import { configureAudio, playSfx } from '../audio/engine';
import { buildBuiltinCatalog } from '../data/builtin';
import {
  ALBUM_PHOTOS_PER_ENTRY,
  clampAlbumName,
  copyReview,
  createAlbumEntry,
  formatAlbumBytes,
  loadAlbum,
  photoSnapshotSignature,
  prependAlbumEntry,
  writeAlbumFile,
} from '../data/album';
import {
  parseAlbumBackup as parseAlbumBackupFile,
  planAlbumRestore,
  serializeAlbumBackup,
  type AlbumBackupPayload,
  type AlbumRestoreMode,
  type AlbumRestoreParse,
  type AlbumRestorePreview,
} from '../data/album-backup';
import { evaluateCommission, getCommission } from '../data/commissions';
import { filterOrnamentsFor, supportsFoam } from '../data/decor-capability';
import { clampOpenScale, clampText, isPackageStep, isPaperId, isRibbonColorId } from '../data/decor';
import { createEmptyDocument, createStem, makeStemId } from '../data/document';
import {
  flowerOrganizeCapability,
  isOrganized,
  organizeTarget,
} from '../data/organize';
import { newOrnament, ornamentDef } from '../data/ornaments';
import { buildPaletteDocument } from '../data/palette-start';
import { switchPresentation, constrainStem, newSheet, readPresentation, readPreparation, readPhoto, VESSELS, type PaperSheet, type Preparation, type PresentationKind, type PhotoSettings } from '../data/presentation';
import { clampPose, clampScale, normalizeAngle, poseToEuler } from '../data/pose';
import { SAMPLE_RIBBON, SAMPLE_WRAPPING, buildSampleStems, type SampleSize } from '../data/samples';
import { findShowcase } from '../data/showcase';
import { isMotionPreference, isViewPreset } from '../data/settings';
import {
  DEFAULT_SIZE_CANDIDATE,
  applyHeadScaleOverride,
  applySizeCandidate,
  isSizeCandidateId,
  type SizeCandidateId,
} from '../data/size';
import { sameSuggestions, sanitizeSuggestionList } from '../data/suggestions';
import type {
  AlbumEntry,
  AssistSettings,
  AudioSettings,
  BouquetDocument,
  CardState,
  CommissionRecord,
  GameMode,
  MotionPreference,
  OrnamentInstance,
  OrnamentKind,
  PackageStep,
  PaperId,
  PhotoReview,
  RibbonColorId,
  RuntimeCatalog,
  SelectionAnchor,
  SnapHint,
  StemPose,
  SuggestionCandidate,
  ToastItem,
  Vec3,
  ViewPreset,
  WorkflowStage,
} from '../data/types';
import {
  loadStoredDocument,
  loadStoredSettings,
  saveStoredDocument,
  saveStoredSettings,
} from './persistence';

export interface PlacementState {
  assetId: string;
}

export type CatalogStatus = 'builtin' | 'manifest';

export interface LoadingState {
  active: boolean;
  label: string;
  progress: number | null;
}

export interface AssetFailure {
  assetId: string;
  message: string;
}

/** 相册满额拦截的触发路径：普通保存 / 交付 / 接单前归档。 */
export type AlbumBlockIntent = 'save' | 'deliver' | 'archive';

/** 相册满额拦截弹层：数量到上限时拒绝新增，由玩家选择管理/备份/取消。 */
export interface AlbumBlocker {
  reason: 'limit';
  intent: AlbumBlockIntent;
  albumCount: number;
  albumLimit: number;
  /** 被拒绝保存的作品名（保存路径才有）。 */
  entryName?: string;
  /** 当前相册序列化字节数，给玩家一个容量参考。 */
  bytes: number;
}

/** 备份恢复结果：失败带原因，成功带新增/重复计数。 */
export interface AlbumRestoreResult {
  ok: boolean;
  reason?: 'over-limit' | 'quota' | 'unavailable';
  message?: string;
  addedEntries?: number;
  addedPhotos?: number;
  replacedEntries?: number;
  duplicateEntries?: number;
  skippedPhotos?: number;
  albumCount?: number;
}

export interface AppState {
  doc: BouquetDocument;
  catalog: RuntimeCatalog;
  catalogStatus: CatalogStatus;
  /** 当前生效的花材尺寸候选（a=原尺寸 / b=缩小 20% / c=缩小 30%）。 */
  sizeCandidate: SizeCandidateId;
  selectedId: string | null;
  trimMode: boolean;
  presentationPreview: boolean;
  hoveredId: string | null;
  placement: PlacementState | null;
  pastCount: number;
  futureCount: number;
  savedAt: number | null;
  toasts: ToastItem[];
  debugVisible: boolean;
  loading: LoadingState;
  assetFailure: AssetFailure | null;
  /** 递增后由 App 触发场景重新加载花材模板。 */
  assetRetryToken: number;
  /** 当前工作流阶段：摆放 → 包装 → 成品欣赏。 */
  stage: WorkflowStage;
  /** 可关闭的辅助（本机设置，写 SETTINGS_KEY）。 */
  assist: AssistSettings;
  /** 动态效果偏好（本机设置，写 SETTINGS_KEY）。 */
  motion: MotionPreference;
  /** 音频偏好（本机设置，写 SETTINGS_KEY；不进作品文档）。 */
  audio: AudioSettings;
  /** 场景算出的建议位（≤ MAX_SUGGESTIONS 个），store 只存放。 */
  suggestions: SuggestionCandidate[];
  /** 指针当前吸附/靠近的候选；场景 → store。 */
  activeSuggestionId: string | null;
  /** UI 点建议卡钉住的候选；UI → store，场景读取。 */
  pinnedSuggestionId: string | null;
  /** 选中花头的屏幕锚点；场景节流回报。 */
  selectionAnchor: SelectionAnchor | null;
  /** 欣赏模式（缓慢环绕）。 */
  showcase: boolean;
  /** 自由制作 / 委托模式。 */
  mode: GameMode;
  /** 当前正在做的委托 id；自由模式为 null。 */
  commissionId: string | null;
  /** 当前委托最近一次交付时间（ISO）；未交付为 null。 */
  commissionDeliveredAt: string | null;
  /** 交付后的顾客回应文案。 */
  commissionResponse: string | null;
  /** 预设视角（free = 用户手动转过镜头）。 */
  viewPreset: ViewPreset;
  /**
   * V0.7 §7 固定视角模式：眼睛亮起 = 固定，画布滚轮按顺序循环预设；
   * false = 自由模式，滚轮归相机缩放。
   */
  viewLocked: boolean;
  /** 上次的固定视角；再次开启眼睛时回到它（首次默认斜 45°）。 */
  lastFixedPreset: Exclude<ViewPreset, 'free'>;
  /**
   * V0.9.1：拖动画面自动切到自由视角时递增。
   * 只用来让「视角」首次提示知道这次是她自己拖出来的，不进文档、不进撤销栈。
   */
  viewDragTick: number;
  /**
   * V0.7 §6 统一编辑入口：点 3D 贺卡 / 包装纸 / 花器，或点界面入口时写一条请求，
   * 由 App 负责切阶段与展开面板。只描述「要编辑什么」，不改包装进度与内容。
   */
  editorRequest: EditorRequest | null;
  /** 当前选中的纸片；3D 点纸片与面板里选纸片共用这一份，避免两套状态。 */
  selectedSheetId: string | null;
  /** 指针进入建议位时的提示锚点；场景节流回报。 */
  snapHint: SnapHint | null;
  /** 本地相册（按保存时间倒序）。 */
  album: AlbumEntry[];
  /** 相册满额拦截弹层；null 表示没有待处理的拦截。 */
  albumBlocker: AlbumBlocker | null;
  /** 相册覆盖层是否打开。 */
  albumOpen: boolean;
  photoRestoreToken: number;
  /** 已交付完成过的委托 id（本机设置，决定后续委托解锁）。 */
  completedCommissions: string[];
  /**
   * 场景节流回报的实际机位方向（单位向量，保留 2 位小数 ≈ 0.6°）。
   * 只用于「点评是否还对应当前画面」的判定，不写进 doc、不进撤销栈、不触发保存。
   */
  cameraDirection: Vec3 | null;
  /**
   * 最近一次 AI 点评（含输入签名 snapshot）。
   * 界面只在 snapshot === 当前照片快照签名时把它显示为「当前画面的点评」；
   * 签名变化不会删除它，已存进相册照片的点评也不受影响。
   */
  currentReview: PhotoReview | null;
}

/** V0.7 §6：统一编辑目标。 */
export interface EditorRequest {
  target: 'card' | 'wrapping' | 'vessel' | 'organize';
  /** 点具体纸片时带上它的 id，面板同步选中。 */
  sheetId?: string;
  /** 递增令牌：同样的目标再点一次也要让界面重新展开一次。 */
  nonce: number;
}

export interface PlaceStemInput {
  tilt: number;
  direction: number;
  height?: number;
  spin?: number;
  scale?: number;
}

/**
 * V0.7.3：统一的落位约束入口。场景在挂载时注册实现（它才知道花材包络与
 * 其它花枝的实际占用），store 在新增 / 复制 / 精调 / 缩放时统一调用，
 * 保证所有修改入口共用同一套「有效位」判定，而不是只有拖动才防穿模。
 */
export interface PoseConstraintInput {
  assetId: string;
  /** 正在编辑的花枝 id；新增/复制这种「新枝」为 null。 */
  stemId: string | null;
  position: Vec3;
  pose: StemPose;
  scale: number;
}

export interface PoseConstraintResult {
  pose: StemPose;
  scale: number;
  /** 是否被约束修正过（用于提示「顶住了 / 只能到这里」）。 */
  clamped: boolean;
}

export type PoseConstraint = (input: PoseConstraintInput) => PoseConstraintResult | null;

/** 相机方向保留 2 位小数（约 0.6°），与 data/album.ts 的签名取整一致。 */
function roundCameraComponent(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** 相册/接单归档用的短时间标签。 */
function formatStamp(date = new Date()): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

export class Store {
  private listeners = new Set<() => void>();
  private state: AppState;
  private past: BouquetDocument[] = [];
  private future: BouquetDocument[] = [];
  private transaction: BouquetDocument | null = null;
  private transactionDirty = false;
  private presentationSource: BouquetDocument | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private nextToastId = 1;
  private saveFailedNotified = false;
  private loadingCount = 0;
  /** V0.7.3：尺寸候选是套在基础清单上的派生视图，切作品/比例时重算。 */
  private baseCatalog: RuntimeCatalog;
  private sizeCandidateOverride: SizeCandidateId | null = null;
  /** 比例校准用的临时花头倍率（地址栏 ?head=），不写作品。 */
  private headScaleOverride: number | null = null;
  /** 场景注册的统一落位约束；没有注册时退化为不约束。 */
  private poseConstraint: PoseConstraint | null = null;
  private lastConstraintToastAt = 0;
  /**
   * V16 §3：一键整理前的单枝处理状态快照。撤销仍然可用；
   * 这份快照额外支持「恢复自动整理前」而不影响手动修剪的历史。
   */
  private organizeSnapshots = new Map<string, Preparation>();

  constructor() {
    const loaded = loadStoredDocument();
    const settings = loadStoredSettings();
    this.baseCatalog = buildBuiltinCatalog();
    const initial =
      loaded.doc ??
      createEmptyDocument(this.baseCatalog.assetsVersion, DEFAULT_SIZE_CANDIDATE);
    // 旧存档没有 sizeCandidate → 按候选 a（原尺寸）读回，比例不会被悄悄改掉；
    // 新建的空白作品带默认候选 b。
    const candidate: SizeCandidateId = isSizeCandidateId(initial.sizeCandidate)
      ? initial.sizeCandidate
      : 'a';
    const catalog = this.deriveCatalogFor(this.baseCatalog, candidate, null);
    const doc = { ...initial, stems: initial.stems.map(stem => constrainStem(stem, initial.presentation.kind)) };
    // 只恢复仍然存在的委托；存档里是旧 id 就干净地回到自由模式。
    const restoredCommission =
      settings.commission && getCommission(settings.commission.id) ? settings.commission : null;
    this.state = {
      doc,
      catalog,
      catalogStatus: 'builtin',
      sizeCandidate: candidate,
      selectedId: null,
      trimMode: false,
      presentationPreview: false,
      hoveredId: null,
      placement: null,
      pastCount: 0,
      futureCount: 0,
      savedAt: null,
      toasts: [],
      debugVisible: false,
      loading: { active: false, label: '正在准备花材…', progress: null },
      assetFailure: null,
      assetRetryToken: 0,
      stage: 'arrange',
      assist: settings.assist,
      motion: settings.motion,
      audio: settings.audio,
      suggestions: [],
      activeSuggestionId: null,
      pinnedSuggestionId: null,
      selectionAnchor: null,
      showcase: false,
      mode: restoredCommission ? 'commission' : 'free',
      commissionId: restoredCommission?.id ?? null,
      commissionDeliveredAt: restoredCommission?.deliveredAt ?? null,
      commissionResponse: restoredCommission?.response ?? null,
      viewPreset: settings.viewPreset,
      // 刷新后沿用上次的固定/自由状态：上次停在固定机位就仍然固定。
      viewLocked: settings.viewPreset !== 'free',
      lastFixedPreset: settings.viewPreset === 'free' ? 'quarter' : settings.viewPreset,
      viewDragTick: 0,
      editorRequest: null,
      selectedSheetId: null,
      snapHint: null,
      album: loadAlbum(catalog.assetsVersion),
      albumBlocker: null,
      albumOpen: false,
      photoRestoreToken: 0,
      completedCommissions: settings.completedCommissions,
      cameraDirection: null,
      currentReview: null,
    };

    // 音效偏好一启动就同步给音频引擎；真正的 AudioContext 等第一次用户交互再创建。
    configureAudio(this.state.audio);

    if (loaded.doc && loaded.doc.stems.length > 0) {
      this.pushToast(`已恢复上次的花束，共 ${loaded.doc.stems.length} 枝`, 'success');
    }
    for (const issue of loaded.issues) this.pushToast(issue, 'warn');

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.flushOnUnload);
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): AppState => this.state;

  // ---------- 提示 ----------

  private pushToast(text: string, kind: ToastItem['kind']): void {
    const id = this.nextToastId;
    this.nextToastId += 1;
    const toasts = [...this.state.toasts, { id, text, kind }].slice(-3);
    this.state = { ...this.state, toasts };
    const timer = setTimeout(
      () => this.dismissToast(id),
      kind === 'warn' ? 4200 : 3000,
    );
    this.toastTimers.set(id, timer);
  }

  toast = (text: string, kind: ToastItem['kind'] = 'info'): void => {
    this.pushToast(text, kind);
    this.emit();
  };

  dismissToast = (id: number): void => {
    const timer = this.toastTimers.get(id);
    if (timer) clearTimeout(timer);
    this.toastTimers.delete(id);
    this.setState({ toasts: this.state.toasts.filter((toast) => toast.id !== id) });
  };

  // ---------- 资产目录 ----------

  /**
   * 套用基础清单。V0.7.3 起清单只是「基础尺寸」，实际渲染的目录还要按
   * 当前作品记录的尺寸候选（以及地址栏 ?head=/?size= 校准参数）派生一次。
   */
  applyCatalog = (
    catalog: RuntimeCatalog,
    options?: { headScale?: number | null; sizeCandidate?: SizeCandidateId | null },
  ): void => {
    if (options && Object.prototype.hasOwnProperty.call(options, 'headScale')) {
      this.headScaleOverride = options.headScale ?? null;
    }
    if (options && Object.prototype.hasOwnProperty.call(options, 'sizeCandidate')) {
      this.sizeCandidateOverride = options.sizeCandidate ?? null;
    }
    this.baseCatalog = catalog;
    const derived = this.deriveCatalog();
    let placement = this.state.placement;
    if (placement && !derived.entriesById[placement.assetId]) placement = null;
    const dropPlacement = placement === null && this.state.placement !== null;
    this.state = {
      ...this.state,
      catalog: derived,
      catalogStatus: derived.mode,
      sizeCandidate: this.candidateForDoc(),
      placement,
      ...(dropPlacement ? this.placementExtrasCleared() : null),
    };
    if (catalog.notice) this.pushToast(catalog.notice, 'warn');
    this.emit();
  };

  /** 当前作品（或校准参数）使用的尺寸候选。旧作品没有记录时按原尺寸 a 读回。 */
  private candidateForDoc(): SizeCandidateId {
    if (this.sizeCandidateOverride) return this.sizeCandidateOverride;
    return isSizeCandidateId(this.state.doc.sizeCandidate) ? this.state.doc.sizeCandidate : 'a';
  }

  /** 基础清单 + 尺寸候选 + 校准花头倍率 → 实际目录。 */
  private deriveCatalogFor(
    base: RuntimeCatalog,
    candidate: SizeCandidateId,
    headScale: number | null,
  ): RuntimeCatalog {
    let catalog = applySizeCandidate(base, candidate);
    if (headScale !== null) catalog = applyHeadScaleOverride(catalog, headScale);
    return catalog;
  }

  private deriveCatalog(): RuntimeCatalog {
    return this.deriveCatalogFor(this.baseCatalog, this.candidateForDoc(), this.headScaleOverride);
  }

  /** 打开/导入作品后按它记录的尺寸候选重建目录（旧作品 = 原尺寸，不会被悄悄改比例）。 */
  private refreshCatalogForDocument(): void {
    const next = this.deriveCatalog();
    const sizeCandidate = this.candidateForDoc();
    if (next.assetsVersion === this.state.catalog.assetsVersion) {
      if (this.state.sizeCandidate !== sizeCandidate) this.setState({ sizeCandidate });
      return;
    }
    this.setState({ catalog: next, catalogStatus: next.mode, sizeCandidate });
  }

  // ---------- V0.7.3：统一落位约束 ----------

  /** 场景挂载时注册实现；卸载时传 null。 */
  setPoseConstraint = (fn: PoseConstraint | null): void => {
    this.poseConstraint = fn;
  };

  private constrainPose(input: PoseConstraintInput): PoseConstraintResult | null {
    return this.poseConstraint ? this.poseConstraint(input) : null;
  }

  /** 「这里放不下 / 只能到这里」提示做 1.2s 节流，避免滚轮缩放连发。 */
  private notifyConstraint(where: 'place' | 'nudge' | 'scale'): void {
    const now = Date.now();
    if (now - this.lastConstraintToastAt < 1200) return;
    this.lastConstraintToastAt = now;
    this.toast(
      where === 'place'
        ? '这里放不下，已经挪到最近的空位'
        : where === 'scale'
          ? '再大就压到旁边的花了'
          : '这里的空间只够挪到这里',
      'info',
    );
  }

  // ---------- 选择与放置模式 ----------

  select = (id: string | null): void => {
    if (this.state.selectedId === id) return;
    // 换选中（或取消选中）时旧锚点立即作废，由场景在下一帧回报新的花头屏幕位置。
    this.setState({ selectedId: id, selectionAnchor: null });
    if (id) playSfx('select');
  };

  setHovered = (id: string | null): void => {
    if (this.state.hoveredId === id) return;
    this.setState({ hoveredId: id });
  };

  setPlacement = (assetId: string | null): void => {
    if (assetId === null) {
      if (!this.state.placement) return;
      this.setState(this.placementExtrasCleared());
      return;
    }
    if (!this.state.catalog.entriesById[assetId]) {
      this.toast('找不到这种花材，换一种试试', 'warn');
      return;
    }
    if (this.state.doc.stems.length >= MAX_STEMS) {
      this.toast(`最多放 ${MAX_STEMS} 枝，先删一枝再选吧`, 'warn');
      return;
    }
    // 花材架按下（pointerdown）和点击（click）会各调一次；同一种花材重复进入放置模式
    // 不应清空已经算好的建议位，否则场景会因签名未变而不再重算（真实浏览器实测到的问题）。
    if (this.state.placement?.assetId === assetId) return;
    playSfx('pick');
    this.setState({
      placement: { assetId },
      selectedId: null,
      hoveredId: null,
      selectionAnchor: null,
      // 换了待放的花材，上一批建议位（含钉住/吸附）立刻作废，等场景重算。
      suggestions: [],
      activeSuggestionId: null,
      pinnedSuggestionId: null,
      snapHint: null,
    });
  };

  /** 确认放下一枝（由 3D 场景在点击工作区时调用）。 */
  placeStem = (input: PlaceStemInput): boolean => {
    const placement = this.state.placement;
    if (!placement) return false;
    if (this.state.doc.stems.length >= MAX_STEMS) {
      this.toast(`最多放 ${MAX_STEMS} 枝，先删一枝再选吧`, 'warn');
      this.setState(this.placementExtrasCleared());
      return false;
    }
    if (!this.state.catalog.entriesById[placement.assetId]) {
      this.toast('这种花材刚被移出清单，换一种试试', 'warn');
      this.setState(this.placementExtrasCleared());
      return false;
    }
    this.endTransaction();
    const spread = 0.016;
    const position: Vec3 = [
      (Math.random() - 0.5) * spread,
      GRIP_Y,
      (Math.random() - 0.5) * spread,
    ];
    const requestedPose: StemPose = {
      // 默认高低做一点点随机，整束看起来不会像排成一排的标尺。
      height: input.height ?? Math.random() * 0.06,
      tilt: input.tilt,
      direction: input.direction,
      spin: input.spin ?? Math.random() * 360,
    };
    const requestedScale = input.scale ?? 0.98 + Math.random() * 0.06;
    const constrained = this.constrainPose({
      assetId: placement.assetId,
      stemId: null,
      position,
      pose: requestedPose,
      scale: requestedScale,
    });
    const stem = createStem({
      assetId: placement.assetId,
      position,
      pose: constrained?.pose ?? requestedPose,
      scale: constrained?.scale ?? requestedScale,
    });
    if (constrained?.clamped) this.notifyConstraint('place');
    this.recordHistory();
    this.applyDoc(this.touchDoc({ stems: [...this.state.doc.stems, stem] }));
    this.setState({ ...this.placementExtrasCleared(), selectedId: stem.id });
    playSfx('place');
    return true;
  };

  // ---------- 花枝编辑 ----------

  beginTransaction = (): void => {
    if (this.transaction) return;
    this.transaction = this.state.doc;
    this.transactionDirty = false;
  };

  endTransaction = (): void => {
    if(this.presentationSource){this.presentationSource=null;this.setState({presentationPreview:false});}
    if (!this.transaction) return;
    if (this.transactionDirty) {
      this.past.push(this.transaction);
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
      this.future = [];
      this.transaction = null;
      this.transactionDirty = false;
      // 事务期间只更新了文档，这里要把撤销/重做的可用状态同步给界面。
      this.setState({ pastCount: this.past.length, futureCount: this.future.length });
    } else {
      this.transaction = null;
    }
  };

  cancelTransaction = (): void => {
    if(this.presentationSource){this.presentationSource=null;this.setState({presentationPreview:false});}
    if (!this.transaction) return;
    const snapshot = this.transaction;
    this.transaction = null;
    this.transactionDirty = false;
    if (snapshot !== this.state.doc) this.applyDoc(snapshot);
  };

  updateStemPoseTransient = (id: string, partial: Partial<StemPose>): void => {
    let changed = false;
    const stems = this.state.doc.stems.map((stem) => {
      if (stem.id !== id) return stem;
      const pose = clampPose({ ...stem.pose, ...partial });
      if (
        pose.height === stem.pose.height &&
        pose.tilt === stem.pose.tilt &&
        pose.direction === stem.pose.direction &&
        pose.spin === stem.pose.spin
      ) {
        return stem;
      }
      changed = true;
      return { ...stem, pose, rotation: poseToEuler(pose) };
    });
    if (!changed) return;
    this.beginTransaction();
    this.transactionDirty = true;
    this.applyDoc({
      ...this.state.doc,
      stems,
      updatedAt: new Date().toISOString(),
    });
  };

  updateStemScaleTransient = (id: string, scale: number): void => {
    const source = this.state.doc.stems.find((stem) => stem.id === id);
    if (!source) return;
    const requested = clampScale(scale);
    if (requested === source.scale) return;
    // V0.7.3：缩放也走统一落位约束——放大到压住邻花时停在最近的可放大小。
    const constrained = this.constrainPose({
      assetId: source.assetId,
      stemId: id,
      position: source.position,
      pose: source.pose,
      scale: requested,
    });
    const nextScale = clampScale(constrained?.scale ?? requested);
    if (constrained?.clamped) this.notifyConstraint('scale');
    if (nextScale === source.scale) return;
    this.beginTransaction();
    this.transactionDirty = true;
    this.applyDoc({
      ...this.state.doc,
      stems: this.state.doc.stems.map((stem) =>
        stem.id === id ? { ...stem, scale: nextScale } : stem,
      ),
      updatedAt: new Date().toISOString(),
    });
  };

  /**
   * 就近精调的单击微调：增量语义（height 米、tilt/direction/spin 度），
   * 每次调用先把进行中的事务收口，再记一条撤销记录，保证「点一下 = 撤一次」。
   */
  nudgeSelected = (partial: Partial<StemPose>): void => {
    const id = this.state.selectedId;
    if (!id) return;
    const source = this.state.doc.stems.find((stem) => stem.id === id);
    if (!source) return;
    this.endTransaction();
    const requestedPose = clampPose({
      height: source.pose.height + (partial.height ?? 0),
      tilt: source.pose.tilt + (partial.tilt ?? 0),
      direction: source.pose.direction + (partial.direction ?? 0),
      spin: source.pose.spin + (partial.spin ?? 0),
    });
    const constrained = this.constrainPose({
      assetId: source.assetId,
      stemId: id,
      position: source.position,
      pose: requestedPose,
      scale: source.scale,
    });
    const pose = constrained?.pose ?? requestedPose;
    if (constrained?.clamped) this.notifyConstraint('nudge');
    if (
      pose.height === source.pose.height &&
      pose.tilt === source.pose.tilt &&
      pose.direction === source.pose.direction &&
      pose.spin === source.pose.spin
    ) {
      return;
    }
    const stems = this.state.doc.stems.map((stem) =>
      stem.id === id ? { ...stem, pose, rotation: poseToEuler(pose) } : stem,
    );
    this.recordHistory();
    this.applyDoc(this.touchDoc({ stems }));
  };

  duplicateStem = (id: string): string | null => {
    const source = this.state.doc.stems.find((stem) => stem.id === id);
    if (!source) return null;
    if (this.state.doc.stems.length >= MAX_STEMS) {
      this.toast(`最多放 ${MAX_STEMS} 枝，先删一枝再复制吧`, 'warn');
      return null;
    }
    if (!this.state.catalog.entriesById[source.assetId]) {
      this.toast('这枝花的资产不在当前清单里，不能复制', 'warn');
      return null;
    }
    this.endTransaction();
    const requestedPose = clampPose({
      height: source.pose.height,
      tilt: Math.min(MAX_TILT, source.pose.tilt + 3),
      direction: normalizeAngle(source.pose.direction + 16 + Math.random() * 18),
      spin: normalizeAngle(source.pose.spin + 20),
    });
    const position: Vec3 = [
      source.position[0] + (Math.random() - 0.5) * 0.03,
      source.position[1],
      source.position[2] + (Math.random() - 0.5) * 0.03,
    ];
    const constrained = this.constrainPose({
      assetId: source.assetId,
      stemId: null,
      position,
      pose: requestedPose,
      scale: source.scale,
    });
    const clone = createStem({
      assetId: source.assetId,
      position,
      pose: constrained?.pose ?? requestedPose,
      scale: constrained?.scale ?? source.scale,
    });
    if (constrained?.clamped) this.notifyConstraint('place');
    clone.preparation = readPreparation(source.preparation);
    this.recordHistory();
    this.applyDoc(this.touchDoc({ stems: [...this.state.doc.stems, clone] }));
    this.setState({ selectedId: clone.id });
    playSfx('place');
    return clone.id;
  };

  setTrimMode = (value:boolean):void => {this.setState({trimMode:value});};

  /**
   * 单枝修剪（V16 扩展）：剪短只对能分离花头/茎尾的花材开放（不把拍照裁剪
   * 直接当作制作状态），剪叶同样只对能分离叶片的款式开放。
   * 手动修剪会把 autoTrim 置回 false，界面据此区分「自己剪的」与「一键整理的」。
   */
  trimStem = (id: string, leaf?: number): void => {
    const source = this.state.doc.stems.find(stem => stem.id === id);
    if (!source) return;
    const family = this.state.catalog.entriesById[source.assetId]?.family ?? '';
    const capability = flowerOrganizeCapability(family);
    if (leaf !== undefined && !capability.trimLeaves) return;
    if (leaf === undefined && !capability.trimTail) return;
    const prep = readPreparation(source.preparation);
    if (leaf === undefined && prep.tailLength <= 0.1001) return;
    if (leaf !== undefined && prep.removedLeaves.includes(leaf)) return;
    const preparation = leaf === undefined
      ? { ...prep, tailLength: Math.max(0.1, prep.tailLength - 0.02), autoTrim: false }
      : { ...prep, removedLeaves: [...new Set([...prep.removedLeaves, leaf])], autoTrim: false };
    this.endTransaction(); this.recordHistory();
    this.applyDoc(this.touchDoc({ stems: this.state.doc.stems.map(stem => stem.id === id ? { ...stem, preparation } : stem) }));
    playSfx(leaf === undefined ? 'snip' : 'trim-leaf');
  };

  // ---------- V16 §3：整理（翻瓣 / 去刺 / 花泥 / 一键整束） ----------

  /** 翻瓣程度：0 = 原样，1 = 完全翻开。只对「可翻瓣」花材生效。 */
  setPetalFlip = (id: string, amount: number): void => {
    const source = this.state.doc.stems.find((stem) => stem.id === id);
    if (!source) return;
    const family = this.state.catalog.entriesById[source.assetId]?.family ?? '';
    if (!flowerOrganizeCapability(family).flip) {
      this.toast('这枝花的结构还翻不了瓣，换一枝试试', 'info');
      return;
    }
    const next = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : 0));
    const prep = readPreparation(source.preparation);
    if (Math.abs((prep.petalFlip ?? 0) - next) < 1e-4) return;
    this.endTransaction(); this.recordHistory();
    this.applyDoc(this.touchDoc({
      stems: this.state.doc.stems.map((stem) =>
        stem.id === id ? { ...stem, preparation: { ...prep, petalFlip: next } } : stem,
      ),
    }));
    playSfx('flip');
  };

  /** 去刺：只对适用花材开放；前后有可见变化（场景按此值隐藏刺）。 */
  setThornsRemoved = (id: string, removed: boolean): void => {
    const source = this.state.doc.stems.find((stem) => stem.id === id);
    if (!source) return;
    const family = this.state.catalog.entriesById[source.assetId]?.family ?? '';
    if (!flowerOrganizeCapability(family).thorns) {
      this.toast('这枝花没有需要去掉的刺', 'info');
      return;
    }
    const prep = readPreparation(source.preparation);
    if ((prep.thornsRemoved === true) === removed) return;
    this.endTransaction(); this.recordHistory();
    this.applyDoc(this.touchDoc({
      stems: this.state.doc.stems.map((stem) =>
        stem.id === id ? { ...stem, preparation: { ...prep, thornsRemoved: removed } } : stem,
      ),
    }));
    if (removed) playSfx('dethorn');
  };

  /** 一键整理对单枝的目标状态（不包含翻瓣）。 */
  private organizeTargetFor(stem: BouquetDocument['stems'][number], kind: PresentationKind) {
    const family = this.state.catalog.entriesById[stem.assetId]?.family ?? '';
    const capability = flowerOrganizeCapability(family);
    return {
      capability,
      target: organizeTarget(kind, VESSELS[kind as Exclude<PresentationKind, 'paper'>]?.tailLength ?? 0.16, capability),
    };
  }

  /** 单枝一键整理：自己处理和一键完成得到同一种可保存状态。 */
  organizeStem = (id: string): boolean => {
    const kind = this.state.doc.presentation.kind;
    const stem = this.state.doc.stems.find((item) => item.id === id);
    if (!stem) return false;
    const { target } = this.organizeTargetFor(stem, kind);
    const prep = readPreparation(stem.preparation);
    if (isOrganized(prep, target)) {
      this.toast('这枝已经整理过了', 'info');
      return false;
    }
    if (!this.organizeSnapshots.has(id)) this.organizeSnapshots.set(id, { ...prep });
    const next: Preparation = {
      ...prep,
      tailLength: target.tailLength,
      removedLeaves:
        target.removeLowLeaf && !prep.removedLeaves.includes(0)
          ? [...prep.removedLeaves, 0]
          : prep.removedLeaves,
      thornsRemoved: target.removeThorns ? true : prep.thornsRemoved,
      autoTrim: true,
    };
    this.endTransaction(); this.recordHistory();
    this.applyDoc(this.touchDoc({
      stems: this.state.doc.stems.map((item) => (item.id === id ? { ...item, preparation: next } : item)),
    }));
    playSfx('snip');
    return true;
  };

  /**
   * 整束整理：一次撤销。只处理影响容器适配的枝脚、内部叶片与可去的刺，
   * 保留有意安排的外露叶片、花头位置与翻瓣选择。
   */
  organizeBouquet = (): number => {
    const stems = this.state.doc.stems;
    if (stems.length === 0) {
      this.toast('还没有花可以整理', 'info');
      return 0;
    }
    const kind = this.state.doc.presentation.kind;
    let changed = 0;
    const next = stems.map((stem) => {
      const { target } = this.organizeTargetFor(stem, kind);
      const prep = readPreparation(stem.preparation);
      if (!this.organizeSnapshots.has(stem.id)) this.organizeSnapshots.set(stem.id, { ...prep });
      const preparation: Preparation = {
        ...prep,
        tailLength: target.tailLength,
        removedLeaves:
          target.removeLowLeaf && !prep.removedLeaves.includes(0)
            ? [...prep.removedLeaves, 0]
            : prep.removedLeaves,
        thornsRemoved: target.removeThorns ? true : prep.thornsRemoved,
        autoTrim: true,
      };
      if (
        Math.abs(preparation.tailLength - prep.tailLength) > 1e-4 ||
        preparation.removedLeaves.length !== prep.removedLeaves.length ||
        preparation.thornsRemoved !== prep.thornsRemoved ||
        preparation.autoTrim !== prep.autoTrim
      ) {
        changed += 1;
      }
      return { ...stem, preparation };
    });
    if (changed === 0) {
      this.toast('这束花已经整理好了', 'info');
      return 0;
    }
    this.endTransaction(); this.recordHistory();
    this.applyDoc(this.touchDoc({ stems: next }));
    this.toast(`整理了 ${changed} 枝，可一次撤销`, 'success');
    playSfx('snip', { gain: 1.1 });
    return changed;
  };

  /** 恢复「一键整理前」：只回退自动整理产生的状态，手动修剪历史仍可撤销。 */
  restoreOrganize = (): boolean => {
    if (this.organizeSnapshots.size === 0) {
      this.toast('还没有可恢复的整理', 'info');
      return false;
    }
    const snapshots = this.organizeSnapshots;
    this.organizeSnapshots = new Map();
    this.endTransaction(); this.recordHistory();
    this.applyDoc(this.touchDoc({
      stems: this.state.doc.stems.map((stem) => {
        const saved = snapshots.get(stem.id);
        return saved ? { ...stem, preparation: { ...saved } } : stem;
      }),
    }));
    this.toast('已恢复整理前状态', 'info');
    playSfx('place');
    return true;
  };

  // ---------- V16 §3：花泥 ----------

  /** 花泥：放入 / 裁切 / 取出 / 适配枝脚。只对适用容器显示与生效。 */
  setFoam = (action: 'place' | 'cut' | 'remove' | 'fit'): boolean => {
    const kind = this.state.doc.presentation.kind;
    if (!supportsFoam(kind)) {
      this.toast('这一形态不需要花泥', 'info');
      return false;
    }
    if (this.state.doc.stems.length === 0) {
      this.toast('先放一点花，再准备花泥', 'info');
      return false;
    }
    const current = this.state.doc.presentation.foam ?? { fitted: false, cut: 0 };
    if (action === 'place') {
      if (current.fitted) return false;
      this.endTransaction(); this.recordHistory();
      this.applyDoc(this.touchDoc({
        presentation: { ...this.state.doc.presentation, foam: { fitted: true, cut: 0 } },
        stems: this.state.doc.stems.map((stem) => {
          const preparation = readPreparation(stem.preparation);
          return { ...stem, preparation: { ...preparation, tailLength: Math.min(preparation.tailLength, 0.14) } };
        }),
      }));
      this.toast('花泥放进去了，可以按内腔裁一裁', 'success');
      playSfx('foam-place');
      return true;
    }
    if (action === 'cut') {
      if (!current.fitted || current.cut >= 0.999) return false;
      this.endTransaction(); this.recordHistory();
      this.applyDoc(this.touchDoc({
        presentation: { ...this.state.doc.presentation, foam: { fitted: true, cut: 1 } },
      }));
      this.toast('花泥按内腔裁好了', 'success');
      playSfx('foam-cut');
      return true;
    }
    if (action === 'remove') {
      if (!current.fitted) return false;
      this.endTransaction(); this.recordHistory();
      this.applyDoc(this.touchDoc({
        presentation: { ...this.state.doc.presentation, foam: { fitted: false, cut: 0 } },
      }));
      this.toast('花泥取出来了', 'info');
      playSfx('remove');
      return true;
    }
    // fit：把花枝插深适配到花泥表面（只改容器适配状态，不翻瓣、不动花头位置）。
    if (!current.fitted) return false;
    const targetTail = VESSELS[kind as Exclude<PresentationKind, 'paper'>]?.tailLength ?? 0.12;
    let changed = false;
    const stems = this.state.doc.stems.map((stem) => {
      const preparation = readPreparation(stem.preparation);
      if (Math.abs(preparation.tailLength - targetTail) < 1e-4) return stem;
      changed = true;
      return { ...stem, preparation: { ...preparation, tailLength: targetTail, autoTrim: true } };
    });
    if (!changed) return false;
    this.endTransaction(); this.recordHistory();
    this.applyDoc(this.touchDoc({ stems }));
    this.toast('枝脚已适配花泥，可撤销', 'success');
    playSfx('snip');
    return true;
  };

  // ---------- V16 §5：辅助装饰 ----------

  /** 添加一件装饰；位置先给一个可用的初始点，选中后可微调。 */
  addOrnament = (kind: OrnamentKind): string | null => {
    if (this.state.doc.stems.length === 0) {
      this.toast('先摆一点花，再添装饰', 'info');
      return null;
    }
    const allowed = filterOrnamentsFor([{ kind }], this.state.doc.presentation.kind);
    if (allowed.length === 0) {
      this.toast('这一形态没有合适的挂点，换一种包装试试', 'info');
      return null;
    }
    const def = ornamentDef(kind);
    const existing = this.state.doc.ornaments.filter((item) => item.kind === kind).length;
    if (existing >= def.max) {
      this.toast(`「${def.label}」最多放 ${def.max} 个`, 'info');
      return null;
    }
    if (this.state.doc.ornaments.length >= MAX_ORNAMENTS) {
      this.toast(`装饰最多 ${MAX_ORNAMENTS} 件，先移除一件吧`, 'info');
      return null;
    }
    const group = def.group;
    // 初始位置：插饰贴近花头之间，串饰/灯串绕作品轮廓，系结挂在收口处。
    // 用户选中后可以在装饰面板里继续微调 X/Y/Z、旋转、大小与亮度。
    const base: Vec3 = group === 'picks'
      ? [0.045, GRIP_Y + 0.2, 0.07]
      : group === 'ties'
        ? [0, GRIP_Y - 0.04, 0.1]
        : [0, GRIP_Y + 0.16, 0];
    const ornament = newOrnament(kind, base);
    this.endTransaction(); this.recordHistory();
    this.applyDoc(this.touchDoc({ ornaments: [...this.state.doc.ornaments, ornament] }));
    playSfx('ornament');
    return ornament.id;
  };

  /** 拖参数时用（一次拖动 = 一条撤销记录）。 */
  updateOrnament = (id: string, patch: Partial<OrnamentInstance>): void => {
    const source = this.state.doc.ornaments.find((item) => item.id === id);
    if (!source) return;
    const next: OrnamentInstance = {
      ...source,
      ...patch,
      position: patch.position
        ? [
            Math.min(0.8, Math.max(-0.8, patch.position[0])),
            Math.min(1.5, Math.max(0.2, patch.position[1])),
            Math.min(0.8, Math.max(-0.8, patch.position[2])),
          ]
        : source.position,
      rotation:
        typeof patch.rotation === 'number' && Number.isFinite(patch.rotation)
          ? ((patch.rotation % 360) + 360) % 360
          : source.rotation,
      scale:
        typeof patch.scale === 'number' && Number.isFinite(patch.scale)
          ? Math.min(1.3, Math.max(0.7, patch.scale))
          : source.scale,
      intensity:
        typeof patch.intensity === 'number' && Number.isFinite(patch.intensity)
          ? Math.min(1, Math.max(0, patch.intensity))
          : source.intensity,
    };
    this.beginTransaction();
    this.transactionDirty = true;
    this.applyDoc(this.touchDoc({
      ornaments: this.state.doc.ornaments.map((item) => (item.id === id ? next : item)),
    }));
  };

  removeOrnament = (id: string): void => {
    const next = this.state.doc.ornaments.filter((item) => item.id !== id);
    if (next.length === this.state.doc.ornaments.length) return;
    this.endTransaction(); this.recordHistory();
    this.applyDoc(this.touchDoc({ ornaments: next }));
    playSfx('remove');
  };

  // ---------- V16 §7：贺卡短语与 AI 润色 ----------

  /** 写入卡片字段（常用短语插入用；一次点击 = 一条撤销记录）。 */
  setCardField = (field: keyof CardState, value: string): void => {
    const max = field === 'message' ? CARD_MESSAGE_MAX : field === 'to' ? CARD_TO_MAX : CARD_FROM_MAX;
    const text = clampText(value, max);
    if (this.state.doc.card[field] === text) return;
    this.endTransaction(); this.recordHistory();
    this.applyDoc(this.touchDoc({ card: { ...this.state.doc.card, [field]: text } }));
  };

  /** AI 润色采用后才替换正文；保留原文可撤销，遵守字数上限。 */
  applyCardMessage = (message: string): boolean => {
    const text = clampText(message.trim(), CARD_MESSAGE_MAX);
    if (!text || text === this.state.doc.card.message) return false;
    this.endTransaction(); this.recordHistory();
    this.applyDoc(this.touchDoc({ card: { ...this.state.doc.card, message: text } }));
    playSfx('save');
    return true;
  };

  // ---------- V16 §6：音频偏好 ----------

  setAudio = (partial: Partial<AudioSettings>): void => {
    const next: AudioSettings = {
      muted: typeof partial.muted === 'boolean' ? partial.muted : this.state.audio.muted,
      volume:
        typeof partial.volume === 'number' && Number.isFinite(partial.volume)
          ? Math.min(1, Math.max(0, partial.volume))
          : this.state.audio.volume,
      bgm: typeof partial.bgm === 'boolean' ? partial.bgm : this.state.audio.bgm,
    };
    if (
      next.muted === this.state.audio.muted &&
      next.volume === this.state.audio.volume &&
      next.bgm === this.state.audio.bgm
    ) {
      return;
    }
    this.setState({ audio: next });
    configureAudio(next);
    this.persistSettings();
    if (!next.muted && partial.muted === false) playSfx('select');
    // BGM 开关本身也给一声轻反馈：开/关都听得见操作生效。
    if (typeof partial.bgm === 'boolean') playSfx('select');
  };


  setPresentation = (kind: PresentationKind): void => {
    if (kind === this.state.doc.presentation.kind) return;
    this.endTransaction(); this.recordHistory();
    this.applyDoc(this.touchDoc(switchPresentation(this.state.doc,kind)));
  };
  previewPresentation = (kind: PresentationKind): void => {
    if(!this.presentationSource){this.endTransaction();this.beginTransaction();this.presentationSource=this.state.doc;}
    this.transactionDirty=true;
    const next=switchPresentation(this.presentationSource,kind);
    this.setState({presentationPreview:true});
    this.applyDoc(this.touchDoc(next));
  };

  updateSheet = (id: string, patch: Partial<PaperSheet>): void => {
    const presentation = readPresentation({ ...this.state.doc.presentation, sheets: this.state.doc.presentation.sheets.map(sheet => sheet.id === id ? { ...sheet, ...patch } : sheet) }, this.state.doc.wrapping.paperId);
    this.beginTransaction(); this.transactionDirty = true;
    this.applyDoc(this.touchDoc({ presentation, wrapping: { ...this.state.doc.wrapping, paperId: presentation.sheets[0].paperId } }));
  };
  addSheet = (): void => {
    const p = this.state.doc.presentation;if(p.sheets.length >= 3) return;
    this.endTransaction();this.recordHistory();
    this.applyDoc(this.touchDoc({ presentation: { ...p, sheets: [...p.sheets,newSheet(p.sheets.length === 1 ? 'kraft' : 'sage',p.sheets.length)] } }));
    playSfx('paper');
  };
  removeSheet = (id: string): void => {
    const p=this.state.doc.presentation;if(p.sheets.length <= 1)return;
    this.endTransaction();this.recordHistory();
    const sheets=p.sheets.filter(s=>s.id!==id);
    this.applyDoc(this.touchDoc({ presentation:{...p,sheets}, wrapping:{...this.state.doc.wrapping,paperId:sheets[0].paperId} }));
    playSfx('paper');
  };
  reorderSheet = (id: string): void => {
    const p=this.state.doc.presentation;const sheet=p.sheets.find(s=>s.id===id);if(!sheet || p.sheets.length<2)return;
    this.endTransaction();this.recordHistory();const sheets=[...p.sheets.filter(s=>s.id!==id),sheet];
    this.applyDoc(this.touchDoc({presentation:{...p,sheets},wrapping:{...this.state.doc.wrapping,paperId:sheets[0].paperId}}));
  };
  updatePhoto = (patch: Partial<PhotoSettings>): void => {
    this.beginTransaction();this.transactionDirty=true;
    this.applyDoc(this.touchDoc({photo:readPhoto({...this.state.doc.photo,...patch})}));
  };

  /**
   * 场景节流回报的实际机位方向（V6 P0-B）。
   * 只保存给「点评是否还对应当前画面」用：不进 doc、不进撤销栈、不触发保存。
   */
  setCameraDirection = (direction: Vec3 | null): void => {
    if (!direction) {
      if (this.state.cameraDirection === null) return;
      this.setState({ cameraDirection: null });
      return;
    }
    if (!Array.isArray(direction) || direction.length !== 3) return;
    if (!direction.every((value) => Number.isFinite(value))) return;
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    if (length < 1e-6) return;
    const next: Vec3 = [
      roundCameraComponent(direction[0] / length),
      roundCameraComponent(direction[1] / length),
      roundCameraComponent(direction[2] / length),
    ];
    const current = this.state.cameraDirection;
    if (current && current[0] === next[0] && current[1] === next[1] && current[2] === next[2]) {
      return;
    }
    this.setState({ cameraDirection: next });
  };

  /** 当前画面（文档 + 实际机位）的快照签名；点评与照片写入都用它比对。 */
  photoSnapshot = (): string => photoSnapshotSignature(this.state.doc, this.state.cameraDirection);

  /** 记录一条点评结果；签名由点评方给出，这里只存放，不写文档、不落盘。 */
  setCurrentReview = (review: PhotoReview | null): void => {
    if (review === null) {
      if (this.state.currentReview === null) return;
      this.setState({ currentReview: null });
      return;
    }
    this.setState({ currentReview: copyReview(review) });
  };

  /** 只有签名与保存那一刻画面一致的点评才附到新照片上（避免串用别的机位的结果）。 */
  private matchingReview(): PhotoReview | null {
    const review = this.state.currentReview;
    if (!review) return null;
    return review.snapshot === this.photoSnapshot() ? review : null;
  }

  deleteStem = (id: string): void => {
    const stems = this.state.doc.stems.filter((stem) => stem.id !== id);
    if (stems.length === this.state.doc.stems.length) return;
    this.endTransaction();
    this.recordHistory();
    this.applyDoc(this.touchDoc({ stems }));
    this.toast('删掉一枝，可以撤销', 'info');
    playSfx('remove');
  };

  deleteSelected = (): void => {
    if (this.state.selectedId) this.deleteStem(this.state.selectedId);
  };

  clearStems = (): void => {
    if (this.state.doc.stems.length === 0) return;
    this.endTransaction();
    this.recordHistory();
    this.applyDoc(this.touchDoc({ stems: [] }));
    this.setState(this.placementExtrasCleared({ selectedId: null }));
    this.toast('已清空，按撤销可以恢复', 'info');
    playSfx('remove');
  };

  /**
   * V0.7 §3：载入固定的 6 / 12 / 20 枝验收样束。
   * 这是比例校准入口（地址栏 `?sample=12`，或调试 API），会重置撤销栈并固定
   * 包装参数，保证同一倍率下的对照只差花头大小。
   */
  loadSampleBouquet = (size: SampleSize): boolean => {
    const stems = buildSampleStems(this.state.catalog, size);
    if (stems.length === 0) return false;
    this.endTransaction();
    this.past.length = 0;
    this.future.length = 0;
    this.applyDoc({
      ...createEmptyDocument(this.state.catalog.assetsVersion, this.candidateForDoc()),
      stems,
      wrapping: { ...SAMPLE_WRAPPING },
      ribbon: { ...SAMPLE_RIBBON },
    });
    this.setStage('arrange');
    this.setState(this.placementExtrasCleared({ selectedId: null }));
    this.toast(`载入 ${size} 枝样束（花头 ${this.state.doc.stems.length} 枝）`, 'info');
    return true;
  };

  /**
   * 作品展 →「用这个配色开始创作」：用作品配色生成一束起点花束，直接可编辑。
   *
   * 会替换当前作品并清空撤销栈（和新开一束同理），因此不保留旧作品的撤销入口；
   * 旧作品如果还要，应该在进入作品展前存进相册。
   */
  loadPaletteBouquet = (paletteId: string): boolean => {
    const doc = buildPaletteDocument(
      paletteId,
      this.state.catalog.assetsVersion,
      this.candidateForDoc(),
    );
    const item = findShowcase(paletteId);
    if (!doc || !item) {
      this.toast('这件作品的配色还没准备好，先自己挑几枝吧', 'warn');
      return false;
    }
    this.endTransaction();
    this.past.length = 0;
    this.future.length = 0;
    this.applyDoc(doc);
    this.refreshCatalogForDocument();
    // 作品展的起点是自由创作，不挂着委托目标；正在做的委托上下文一并结束。
    const leavingCommission = this.state.mode !== 'free' || this.state.commissionId !== null;
    this.setState({
      mode: 'free',
      commissionId: null,
      commissionDeliveredAt: null,
      commissionResponse: null,
    });
    if (leavingCommission) this.persistSettings();
    this.setStage('arrange');
    this.setState(
      this.placementExtrasCleared({ selectedId: null, hoveredId: null, currentReview: null, showcase: false }),
    );
    this.toast(`已按「${item.title}」的配色摆好 ${doc.stems.length} 枝，接着调整就好`, 'success');
    return true;
  };

  // ---------- 包装、丝带与卡片 ----------

  setWrappingEnabled = (enabled: boolean): boolean => {
    if (enabled && this.state.doc.stems.length === 0) {
      this.toast('先放几枝花，再包起来吧', 'warn');
      return false;
    }
    const wrapping = this.state.doc.wrapping;
    if (enabled === wrapping.enabled) return true;
    this.endTransaction();
    this.recordHistory();
    // 拆开包装视为重新来过：停回摆纸、开口恢复默认，再包时从第一步开始。
    this.applyDoc(
      this.touchDoc({
        wrapping: enabled
          ? { ...wrapping, enabled: true }
          : { ...wrapping, enabled: false, step: 'paper', openScale: 1 },
      }),
    );
    return true;
  };

  /** 进入包装阶段：无花枝时拒绝（只 toast、不切阶段）；有花枝且未包装时从摆纸开始。 */
  enterWrap = (): boolean => {
    if (this.state.doc.stems.length === 0) {
      this.toast('先放几枝花，再包起来吧', 'warn');
      return false;
    }
    const wrapping = this.state.doc.wrapping;
    if (!wrapping.enabled) {
      this.endTransaction();
      this.recordHistory();
      this.applyDoc(this.touchDoc({ wrapping: { ...wrapping, enabled: true, step: 'paper' } }));
    }
    this.setStage('wrap');
    return true;
  };

  /** 进入分步包装的最后一步（摆纸）等；允许前进/后退，未启用时先自动启用。 */
  setPackageStep = (step: PackageStep): boolean => {
    if (!isPackageStep(step)) return false;
    if (this.state.doc.stems.length === 0) {
      this.toast('先放几枝花，再包起来吧', 'warn');
      return false;
    }
    const wrapping = this.state.doc.wrapping;
    if (wrapping.enabled && wrapping.step === step) {
      this.setStage('wrap');
      return true;
    }
    this.endTransaction();
    this.recordHistory();
    // 自动启用 + 目标步骤合成一条历史：点「合拢收口」不会被拆成两步撤销。
    this.applyDoc(
      this.touchDoc({ wrapping: { ...wrapping, enabled: true, step } }),
    );
    this.setStage('wrap');
    playSfx(step === 'paper' ? 'paper' : step === 'ribbon' ? 'ribbon' : 'fold');
    return true;
  };

  /** 摆纸阶段的开口大小；连续调节由 transaction 合并成一条撤销。 */
  setPaperOpenScale = (scale: number): void => {
    if (!Number.isFinite(scale)) return;
    const openScale = clampOpenScale(scale);
    if (openScale === this.state.doc.wrapping.openScale) return;
    this.beginTransaction();
    this.transactionDirty = true;
    this.applyDoc(this.touchDoc({ wrapping: { ...this.state.doc.wrapping, openScale } }));
  };

  setPaperId = (paperId: PaperId): void => {
    if (!isPaperId(paperId) || paperId === this.state.doc.wrapping.paperId) return;
    this.endTransaction();
    this.recordHistory();
    this.applyDoc(this.touchDoc({ wrapping: { ...this.state.doc.wrapping, paperId }, presentation: { ...this.state.doc.presentation, sheets: this.state.doc.presentation.sheets.map((sheet,i) => i === 0 ? { ...sheet, paperId } : sheet) } }));
    playSfx('paper');
  };

  setRibbonColor = (colorId: RibbonColorId): void => {
    if (!isRibbonColorId(colorId) || colorId === this.state.doc.ribbon.colorId) return;
    this.endTransaction();
    this.recordHistory();
    this.applyDoc(this.touchDoc({ ribbon: { colorId } }));
    playSfx('ribbon');
  };

  /** 卡片输入：连续输入合并为一次撤销，由输入框 focus/blur 控制事务。 */
  updateCardFieldTransient = (field: keyof CardState, rawValue: string): void => {
    const limits: Record<keyof CardState, number> = {
      to: CARD_TO_MAX,
      message: CARD_MESSAGE_MAX,
      from: CARD_FROM_MAX,
    };
    const value = clampText(rawValue, limits[field]);
    if (value === this.state.doc.card[field]) return;
    this.beginTransaction();
    this.transactionDirty = true;
    this.applyDoc(
      this.touchDoc({ card: { ...this.state.doc.card, [field]: value } }),
    );
  };

  /** 一次性应用通过校验的导入作品；应用前先记一条历史，可撤销。 */
  replaceDocument = (doc: BouquetDocument): void => {
    this.endTransaction();
    this.recordHistory();
    this.applyDoc({
      ...doc,
      version: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
    });
    // 换了一件作品：之前那条点评不再属于「当前作品」，清掉引用；
    // 已存进相册照片的点评不受影响（由 openAlbumEntry 再取回）。
    this.setState(this.placementExtrasCleared({ selectedId: null, hoveredId: null, currentReview: null }));
    // V0.7.3：作品记录的尺寸候选可能和当前不同（例如打开旧相册作品），
    // 重新派生目录让 AssetLoader 按旧比例重新加载，成品不会突然变大变小。
    this.refreshCatalogForDocument();
  };

  getDocumentForExport = (): BouquetDocument => this.buildSaveDoc();

  // ---------- 工作流阶段 ----------

  setStage = (stage: WorkflowStage): void => {
    if (stage !== 'arrange' && stage !== 'wrap' && stage !== 'finish') return;
    if(stage!=='arrange'&&!this.state.doc.stems.length)return;
    if(this.presentationSource)this.cancelTransaction();
    // 离开成品欣赏时停住环绕，回到可编辑状态。
    const stopShowcase = stage !== 'finish' && this.state.showcase;
    // 包装/成品阶段不保留待放花的 ghost 与建议状态。
    const dropPlacement = stage !== 'arrange' && this.state.placement !== null;
    if (stage === this.state.stage && !stopShowcase && !dropPlacement) return;
    this.setState({
      stage,
      ...(stopShowcase ? { showcase: false } : null),
      ...(dropPlacement ? this.placementExtrasCleared() : null),
    });
  };

  startShowcase = (): void => {
    if (this.state.showcase) return;
    this.setState({ showcase: true });
  };

  stopShowcase = (): void => {
    if (!this.state.showcase) return;
    this.setState({ showcase: false });
  };

  // ---------- 视角与吸附提示（第三轮） ----------

  setViewPreset = (preset: ViewPreset): void => {
    if (!isViewPreset(preset)) return;
    if (preset === 'free') {
      if (this.state.viewPreset === 'free' && !this.state.viewLocked) return;
      this.setState({ viewPreset: 'free', viewLocked: false });
      this.persistSettings();
      return;
    }
    if (preset === this.state.viewPreset && this.state.viewLocked) return;
    this.setState({ viewPreset: preset, viewLocked: true, lastFixedPreset: preset });
    this.persistSettings();
  };

  /** V0.7 §7：眼睛开关。开启回到上次固定视角，关闭保留当前角度进入自由模式。 */
  setViewLocked = (locked: boolean): void => {
    if (locked === this.state.viewLocked) return;
    if (locked) {
      this.setState({ viewPreset: this.state.lastFixedPreset, viewLocked: true });
    } else {
      this.setState({ viewPreset: 'free', viewLocked: false });
    }
    this.persistSettings();
  };

  /**
   * V0.9.1：拖动画面自动进入自由视角时通知界面。
   * 相机状态本身仍由 setViewPreset('free') 负责，这里只递增计数，
   * 让右下角视角控件能区分「自己点的眼睛」和「拖动转出来的自由视角」。
   */
  notifyViewDrag = (): void => {
    this.setState({ viewDragTick: this.state.viewDragTick + 1 });
  };

  /** V0.7 §7：固定模式下画布滚轮按 正面 → 斜 45° → 侧面 → 俯视 的顺序循环。 */
  cycleFixedView = (step: 1 | -1): void => {
    const order = VIEW_PRESETS;
    const current = this.state.viewLocked
      ? (this.state.viewPreset === 'free' ? this.state.lastFixedPreset : this.state.viewPreset)
      : this.state.lastFixedPreset;
    const index = Math.max(0, order.indexOf(current));
    const next = order[(index + (step > 0 ? 1 : order.length - 1)) % order.length];
    this.setViewPreset(next);
  };

  // ---------- V0.7 §6：统一的包装／贺卡编辑目标 ----------

  /**
   * 请求打开某个编辑目标（点 3D 贺卡 / 包装纸 / 花器，或点界面入口）。
   *
   * 只做三件事：必要时切到包装阶段、写一条带 nonce 的请求、同步选中的纸片。
   * 不动 `wrapping.enabled` / `wrapping.step`，也不添加或替换任何对象——
   * 打开选择区不会把已经做好的包装重新展开一遍。
   */
  requestEditor = (target: EditorRequest['target'], options?: { sheetId?: string }): void => {
    const nonce = (this.state.editorRequest?.nonce ?? 0) + 1;
    const patch: Partial<AppState> = {
      editorRequest: { target, sheetId: options?.sheetId, nonce },
      selectedSheetId: options?.sheetId ?? this.state.selectedSheetId,
    };
    if (this.state.stage === 'finish') {
      this.setStage('wrap');
    }
    this.setState(patch);
  };

  /** 面板里点纸片与 3D 点纸片共用同一个选中状态。 */
  selectSheet = (sheetId: string | null): void => {
    if (this.state.selectedSheetId === sheetId) return;
    this.setState({ selectedSheetId: sheetId });
  };

  /** 场景回报「指针进入建议位」；坐标节流由场景负责，这里只去抖。 */
  setSnapHint = (hint: SnapHint | null): void => {
    if (hint === null || !this.state.placement) {
      if (this.state.snapHint === null) return;
      this.setState({ snapHint: null });
      return;
    }
    const current = this.state.snapHint;
    if (
      current &&
      current.suggestionId === hint.suggestionId &&
      current.pinned === hint.pinned &&
      current.reason === hint.reason &&
      Math.abs(current.x - hint.x) < 0.5 &&
      Math.abs(current.y - hint.y) < 0.5
    ) {
      return;
    }
    const x = Number.isFinite(hint.x) ? hint.x : 0;
    const y = Number.isFinite(hint.y) ? hint.y : 0;
    this.setState({ snapHint: { ...hint, x, y } });
  };

  // ---------- 双模式、委托与相册（P1） ----------

  setMode = (mode: GameMode): void => {
    if (mode === 'free') {
      this.leaveCommission();
      return;
    }
    if (this.state.mode === mode) return;
    this.setState({ mode });
  };

  /**
   * 接单：先把手上的花束自动存进相册（避免清空丢作品），再把工作台清成空文档。
   * 清空走 replaceDocument，因此可以撤销回接单前的作品。
   */
  startCommission = (commissionId: string, archiveThumbnail: string | null): boolean => {
    const def = getCommission(commissionId);
    if (!def) {
      this.toast('找不到这张委托，换一张试试', 'warn');
      return false;
    }
    if (this.state.doc.stems.length > 0) {
      if(!archiveThumbnail?.startsWith('data:image/')){
        this.toast('接单前照片未生成，手上的作品已保留','warn');
        return false;
      }
      // 数量满额时先明确拒绝：不归档、不接单、不清台，避免旧作品被静默挤掉。
      if (this.state.album.length >= ALBUM_LIMIT) {
        this.blockAlbum('archive');
        this.toast(`相册已有 ${this.state.album.length} 件，接单前这束没有归档，所以没有接单，工作台也没清空`, 'warn');
        return false;
      }
      const archived = createAlbumEntry({
        name: `接单前作品 · ${formatStamp()}`,
        mode: this.state.mode,
        doc: this.state.doc,
        thumbnail: archiveThumbnail ?? '',
        catalog: this.state.catalog,
        review: this.matchingReview() ?? undefined,
      });
      // 归档写不进去就不清空：宁可接单失败，也不能让用户手上的作品凭空消失。
      const archiveWrite = this.commitAlbumChecked(prependAlbumEntry(this.state.album, archived));
      if (!archiveWrite.ok) {
        this.toast(
          archiveWrite.reason === 'quota'
            ? '相册容量不够，接单前这束还没归档，先没清空工作台'
            : archiveWrite.reason === 'limit'
              ? '相册已满，接单前这束还没归档，先没清空工作台'
              : '相册写入失败，接单前这束还没归档，先没清空工作台',
          'warn',
        );
        return false;
      }
    }
    this.replaceDocument(
      createEmptyDocument(this.state.catalog.assetsVersion, this.candidateForDoc()),
    );
    this.setState({
      mode: 'commission',
      commissionId,
      commissionDeliveredAt: null,
      commissionResponse: null,
      stage: 'arrange',
      showcase: false,
      albumOpen: false,
      snapHint: null,
    });
    this.persistSettings();
    this.toast(`接下了「${def.title}」，先看看顾客的心愿`, 'success');
    return true;
  };

  /** 交付：按明确条件结算，生成相册快照（之后编辑副本不改变原记录）。 */
  deliverCommission = (thumbnail: string): CommissionRecord | null => {
    if(!thumbnail.startsWith('data:image/')){this.toast('照片为空，未交付','warn');return null;}
    const def = getCommission(this.state.commissionId);
    if (!def) {
      this.toast('现在没有正在进行的委托', 'warn');
      return null;
    }
    const progress = evaluateCommission(this.state.doc, def, this.state.catalog);
    const deliveredAt = new Date().toISOString();
    const missing = progress.checks.filter(check=>!check.met).map(check=>check.label);
    const response=progress.complete?def.responseComplete:`${def.responsePartial}（还差：${missing.join("、")}）`;
    const record: CommissionRecord = {
      commissionId: def.id,
      title: def.title,
      customer: def.customer,
      complete: progress.complete,
      metCount: progress.metCount,
      total: progress.total,
      deliveredAt,
      response,
    };
    const entry = createAlbumEntry({
      name: `${def.title} · ${progress.complete ? '完成' : '部分完成'}`,
      mode: 'commission',
      doc: this.state.doc,
      thumbnail,
      catalog: this.state.catalog,
      commission: record,
      review: this.matchingReview() ?? undefined,
    });
    const completed = this.state.completedCommissions.includes(def.id)
      ? this.state.completedCommissions
      : [...this.state.completedCommissions, def.id];
    // 数量满额时明确拒绝交付：不写记录、不标记已交付、不清台。
    if (this.state.album.length >= ALBUM_LIMIT) {
      this.blockAlbum('deliver', entry.name);
      this.toast(`相册已有 ${this.state.album.length} 件，这次交付没有保存；工作台和委托进度都保留着，清出空间后再交付`, 'warn');
      return null;
    }
    // 快照写不进去就不算交付：避免界面说成功、相册里却没有这一单。
    const deliverWrite = this.commitAlbumChecked(prependAlbumEntry(this.state.album, entry));
    if (!deliverWrite.ok) {
      this.toast(
        deliverWrite.reason === 'quota'
          ? '相册容量不够，这次交付没有保存；工作台和委托进度保留着，清出空间后再试'
          : deliverWrite.reason === 'limit'
            ? '相册已满，这次交付没有保存；工作台和委托进度保留着'
            : '相册写入失败，这次交付没有保存；工作台和委托进度保留着',
        'warn',
      );
      return null;
    }

    this.setState({
      completedCommissions: completed,
      commissionDeliveredAt: deliveredAt,
      commissionResponse: response,
      stage: 'finish',
      showcase: false,
      snapHint: null,
      placement: null,
      suggestions: [],
      activeSuggestionId: null,
      pinnedSuggestionId: null,
    });
    this.persistSettings();
    this.toast(
      progress.complete
        ? `交付完成，${def.customer} 很喜欢`
        : `先交给 ${def.customer} 了，还有 ${progress.total - progress.metCount} 条心愿没满足`,
      progress.complete ? 'success' : 'info',
    );
    playSfx('save');
    return record;
  };

  /** 回到自由模式：当前作品保留，不清空。 */
  leaveCommission = (): void => {
    if (this.state.mode === 'free' && this.state.commissionId === null) return;
    this.setState({
      mode: 'free',
      commissionId: null,
      commissionDeliveredAt: null,
      commissionResponse: null,
      snapHint: null,
    });
    this.persistSettings();
    this.toast('回到自由制作，手上的花束保留着', 'info');
  };

  // ---------- 相册 ----------

  openAlbum = (): void => {
    if (this.state.albumOpen) return;
    this.setState({ albumOpen: true });
  };

  closeAlbum = (): void => {
    if (!this.state.albumOpen) return;
    this.setState({ albumOpen: false });
  };

  /** 把当前作品存进相册（不改变作品本身）。数量满额与容量不足都不会静默丢旧作品。 */
  saveToAlbum = (thumbnail: string, name?: string): AlbumEntry | null => {
    if (this.state.doc.stems.length === 0) {
      this.toast('先放几枝花，再存进相册吧', 'warn');
      return null;
    }
    if (!thumbnail.startsWith('data:image/')) {this.toast('照片为空，未保存相册','warn');return null;}
    const existing=this.state.album.find(item=>item.doc.createdAt===this.state.doc.createdAt);
    if(existing && existing.photos.length>=ALBUM_PHOTOS_PER_ENTRY){this.toast('这件作品已留了 6 张照片，可以复制作品后继续拍','warn');return null;}
    const entry = createAlbumEntry({
      name: name?.trim() ? name : this.state.doc.photo.title || `作品 · ${formatStamp()}`,
      mode: this.state.mode,
      doc: this.state.doc,
      thumbnail,
      catalog: this.state.catalog,
      // 点评跟着照片走：只有签名与这一刻画面一致时才随照片存下来。
      review: this.matchingReview() ?? undefined,
    });
    if(existing){
      const updated={...existing,photos:[...existing.photos,...entry.photos],updatedAt:entry.updatedAt};
      const write = this.commitAlbumChecked(this.state.album.map(item=>item.id===existing.id?updated:item));
      if(!write.ok){this.albumWriteFailureToast('这张照片', write.reason);return null;}
      this.toast('已给这件作品添一张照片','success');return updated;
    }
    // 数量满额：拒绝新增并明确说明，绝不挤掉已有作品。
    if (this.state.album.length >= ALBUM_LIMIT) {
      this.blockAlbum('save', entry.name);
      this.toast(`相册已有 ${this.state.album.length}/${ALBUM_LIMIT} 件作品，这一件没有保存；旧作品都还在，清理一件后再存`, 'warn');
      return null;
    }
    const write = this.commitAlbumChecked(prependAlbumEntry(this.state.album, entry));
    if (!write.ok) {
      this.albumWriteFailureToast('这件作品', write.reason);
      return null;
    }
    this.toast(`已存进相册「${entry.name}」`, 'success');
    playSfx('save');
    return entry;
  };

  /** 从相册恢复作品继续编辑；委托作品恢复委托上下文。 */
  openAlbumEntry = (id: string, photoId?: string): boolean => {
    const entry = this.state.album.find((item) => item.id === id);
    if (!entry) {
      this.toast('这条相册记录不见了', 'warn');
      return false;
    }
    const chosenPhoto = entry.photos.find((item) => item.id === photoId);
    const restored = JSON.parse(JSON.stringify(chosenPhoto?.doc ?? entry.doc)) as BouquetDocument;
    this.replaceDocument(restored);
    if (entry.mode === 'commission' && entry.commission) {
      const def = getCommission(entry.commission.commissionId);
      this.setState({
        mode: 'commission',
        commissionId: entry.commission.commissionId,
        commissionDeliveredAt: entry.commission.deliveredAt,
        commissionResponse: entry.commission.response || (entry.commission.complete
          ? (def?.responseComplete ?? '这是一束已经交付的委托作品。')
          : (def?.responsePartial ?? '这是一束已经交付的委托作品。')),
      });
    } else {
      this.setState({
        mode: 'free',
        commissionId: null,
        commissionDeliveredAt: null,
        commissionResponse: null,
      });
    }
    this.setState({
      stage: 'finish',
      showcase: false,
      albumOpen: false,
      photoRestoreToken: this.state.photoRestoreToken + 1,
      selectedId: null,
      hoveredId: null,
      snapHint: null,
      // 这张照片自己的点评：相机恢复后签名一致才显示，旧照片没有点评则为 null。
      currentReview: chosenPhoto?.review ? copyReview(chosenPhoto.review) : null,
    });
    this.persistSettings();
    this.toast(`已打开「${entry.name}」，可以接着改`, 'success');
    return true;
  };

  /** 复制相册作品为新的自由作品（花枝重新编号，原记录不变）。 */
  copyAlbumEntryToFree = (id: string, photoId?: string): boolean => {
    const entry = this.state.album.find((item) => item.id === id);
    if (!entry) {
      this.toast('这条相册记录不见了', 'warn');
      return false;
    }
    const source=entry.photos.find(photo=>photo.id===photoId)?.doc??entry.doc;
    const now = new Date().toISOString();
    const copyDoc: BouquetDocument = {
      ...(JSON.parse(JSON.stringify(source)) as BouquetDocument),
      createdAt: now,
      updatedAt: now,
      presentation:{...source.presentation,layouts:undefined},
      stems: source.stems.map((stem) => ({ ...stem, id: makeStemId() })),
    };
    this.replaceDocument(copyDoc);
    this.setState({
      mode: 'free',
      commissionId: null,
      commissionDeliveredAt: null,
      commissionResponse: null,
      stage: 'arrange',
      showcase: false,
      albumOpen: false,
      selectedId: null,
      hoveredId: null,
      snapHint: null,
      // 复制出来的是新作品，不继承原照片的点评（花枝 id、时间都已不同）。
      currentReview: null,
    });
    this.persistSettings();
    this.toast('已复制成一件新的自由作品', 'success');
    return true;
  };

  setAlbumCover = (id:string,photoId:string):void=>{
    const entry=this.state.album.find(item=>item.id===id);const photo=entry?.photos.find(item=>item.id===photoId);if(!entry||!photo)return;
    if(!this.commitAlbum(this.state.album.map(item=>item.id===id?{...item,coverId:photo.id,thumbnail:photo.thumbnail,doc:photo.doc}:item)))this.toast('封面未保存，原记录保留','warn');
  };
  deleteAlbumEntry = (id: string): void => {
    if (!this.state.album.some((item) => item.id === id)) return;
    if (!this.commitAlbum(this.state.album.filter((item) => item.id !== id))) {
      this.toast('删除没写进本机存储，相册还是原样', 'warn');
      return;
    }
    this.toast('已从相册删除，当前作品不受影响', 'info');
  };

  renameAlbumEntry = (id: string, name: string): void => {
    const next = clampAlbumName(name);
    const entry = this.state.album.find((item) => item.id === id);
    if (!entry || entry.name === next) return;
    if (
      !this.commitAlbum(
        this.state.album.map((item) => (item.id === id ? { ...item, name: next } : item)),
      )
    ) {
      this.toast('改名没写进本机存储，名字保持原样', 'warn');
    }
  };

  /** 写相册并落盘；返回是否真的存下来了，调用方据此决定要不要报成功。 */
  private commitAlbum(next: AlbumEntry[]): boolean {
    return this.commitAlbumChecked(next).ok;
  }

  /**
   * 统一的相册写入检查（V6 P0-A）：普通保存、交付、接单归档、删除/改名/封面都走这里。
   * - 数量检查：不允许写入超过上限的新记录（不截断、不静默淘汰旧作品）。
   * - 容量检查：真实 localStorage 写入；配额/存储不可用时如实返回失败。
   */
  private commitAlbumChecked(
    next: AlbumEntry[],
  ): { ok: true } | { ok: false; reason: 'limit' | 'quota' | 'unavailable' } {
    const cap = Math.max(ALBUM_LIMIT, this.state.album.length);
    if (next.length > cap) return { ok: false, reason: 'limit' };
    const write = writeAlbumFile(next);
    if (!write.ok) {
      return { ok: false, reason: write.failure === 'quota' ? 'quota' : 'unavailable' };
    }
    this.setState({ album: next, albumBlocker: null });
    return { ok: true };
  }

  private albumWriteFailureToast(subject: string, reason: 'limit' | 'quota' | 'unavailable'): void {
    const message =
      reason === 'quota'
        ? `相册容量不够，${subject}没有保存；原照片和工作台都保留着，清理相册或先下载备份后再试`
        : reason === 'limit'
          ? `相册已满，${subject}没有保存；旧作品都还在`
          : `浏览器存储不可用，${subject}没有保存；工作台保留着，换个浏览器再试`;
    this.toast(message, 'warn');
  }

  /** 记录一次满额拦截：由弹层给出「打开相册管理 / 下载备份 / 取消」。 */
  private blockAlbum(intent: AlbumBlockIntent, entryName?: string): void {
    this.setState({
      albumBlocker: {
        reason: 'limit',
        intent,
        albumCount: this.state.album.length,
        albumLimit: ALBUM_LIMIT,
        ...(entryName ? { entryName } : null),
        bytes: serializeAlbumBackup(this.state.album).bytes,
      },
    });
  }

  dismissAlbumBlocker = (): void => {
    if (!this.state.albumBlocker) return;
    this.setState({ albumBlocker: null });
  };

  /** 满额弹层 → 打开相册管理。 */
  manageAlbumFromBlocker = (): void => {
    if (!this.state.albumBlocker && this.state.albumOpen) return;
    this.setState({ albumOpen: true, albumBlocker: null });
  };

  // ---------- 相册备份与恢复（V6 P0-A） ----------

  /** 生成完整相册备份（照片/制作版本/封面/委托记录与回应，不含凭据）。 */
  createAlbumBackup = (): AlbumBackupPayload => serializeAlbumBackup(this.state.album);

  /** 校验备份文件，返回可展示的新增/重复/超额数量；不写入。 */
  parseAlbumBackup = (text: string): AlbumRestoreParse =>
    parseAlbumBackupFile(text, this.state.album, this.state.catalog.assetsVersion);

  /** 按玩家选择的冲突方式恢复；数量/容量不足时停止写入并保留原相册。 */
  restoreAlbumBackup = (
    preview: AlbumRestorePreview,
    mode: AlbumRestoreMode,
  ): AlbumRestoreResult => {
    const plan = planAlbumRestore(this.state.album, preview, mode);
    if (!plan.ok) {
      const message = `恢复后会超过 ${ALBUM_LIMIT} 件上限（多出 ${plan.excess} 件），没有写入，原相册保持原样。先删掉几件旧作品再恢复。`;
      this.toast(message, 'warn');
      return { ok: false, reason: 'over-limit', message, albumCount: this.state.album.length };
    }
    const write = writeAlbumFile(plan.next);
    if (!write.ok) {
      const quota = write.failure === 'quota';
      const message = quota
        ? `相册容量不足以写入这份备份（需要 ${formatAlbumBytes(write.bytes)}），没有写入，原相册保持原样`
        : '浏览器存储不可用，备份没有写入，原相册保持原样';
      this.toast(message, 'warn');
      return {
        ok: false,
        reason: quota ? 'quota' : 'unavailable',
        message,
        albumCount: this.state.album.length,
      };
    }
    this.setState({ album: plan.next, albumBlocker: null });
    const parts = [`新增 ${plan.addedEntries} 件作品、${plan.addedPhotos} 张照片`];
    if (mode === 'replace') parts.push(`替换同名记录 ${plan.replacedEntries} 件`);
    else if (plan.duplicateEntries > 0) parts.push(`跳过重复 ${plan.duplicateEntries} 件`);
    if (plan.skippedPhotos > 0) parts.push(`另有 ${plan.skippedPhotos} 张因每件 6 照上限未加入`);
    this.toast(`已从备份恢复：${parts.join('，')}`, 'success');
    return {
      ok: true,
      addedEntries: plan.addedEntries,
      addedPhotos: plan.addedPhotos,
      replacedEntries: plan.replacedEntries,
      duplicateEntries: plan.duplicateEntries,
      skippedPhotos: plan.skippedPhotos,
      albumCount: plan.next.length,
    };
  };

  // ---------- 辅助开关与动态偏好（本机设置） ----------

  setAssist = (partial: Partial<AssistSettings>): void => {
    const next: AssistSettings = {
      snapping:
        typeof partial.snapping === 'boolean' ? partial.snapping : this.state.assist.snapping,
      suggestions:
        typeof partial.suggestions === 'boolean'
          ? partial.suggestions
          : this.state.assist.suggestions,
    };
    if (
      next.snapping === this.state.assist.snapping &&
      next.suggestions === this.state.assist.suggestions
    ) {
      return;
    }
    this.setState({
      assist: next,
      // 关掉建议时立刻清掉当前列表；场景随后会按新设置重算并回报。
      ...(next.suggestions
        ? null
        : { suggestions: [], activeSuggestionId: null, pinnedSuggestionId: null }),
      // 关掉吸附时不再有「当前吸在哪个候选上」，钉住的建议保留（它不依赖吸附开关）。
      ...(next.snapping ? null : { activeSuggestionId: null }),
    });
    this.persistSettings();
  };

  setMotion = (motion: MotionPreference): void => {
    if (!isMotionPreference(motion) || motion === this.state.motion) return;
    this.setState({ motion });
    this.persistSettings();
  };

  // ---------- 摆放建议位（场景计算，store 只存放） ----------

  setSuggestions = (list: SuggestionCandidate[]): void => {
    // 不在放置模式时不允许残留建议位；放置结束时 store 会主动清空。
    const next = this.state.placement ? sanitizeSuggestionList(list) : [];
    if (sameSuggestions(next, this.state.suggestions)) return;
    const keepActive =
      this.state.activeSuggestionId !== null &&
      next.some((item) => item.id === this.state.activeSuggestionId);
    const keepPinned =
      this.state.pinnedSuggestionId !== null &&
      next.some((item) => item.id === this.state.pinnedSuggestionId);
    this.setState({
      suggestions: next,
      activeSuggestionId: keepActive ? this.state.activeSuggestionId : null,
      pinnedSuggestionId: keepPinned ? this.state.pinnedSuggestionId : null,
      ...(keepActive ? null : { snapHint: null }),
    });
  };

  setActiveSuggestion = (id: string | null): void => {
    const next = this.state.placement ? id : null;
    if (next === this.state.activeSuggestionId) return;
    this.setState({
      activeSuggestionId: next,
      ...(next === null ? { snapHint: null } : null),
    });
  };

  pinSuggestion = (id: string | null): void => {
    const next = id && this.state.placement ? id : null;
    if (next === this.state.pinnedSuggestionId) return;
    this.setState({ pinnedSuggestionId: next });
  };

  /** 选中花头的屏幕锚点；场景已节流，这里只做去抖与形状兜底。 */
  setSelectionAnchor = (anchor: SelectionAnchor | null): void => {
    if (anchor === null || !this.state.selectedId) {
      if (this.state.selectionAnchor === null) return;
      this.setState({ selectionAnchor: null });
      return;
    }
    const x = Number.isFinite(anchor.x) ? anchor.x : 0;
    const y = Number.isFinite(anchor.y) ? anchor.y : 0;
    const visible = anchor.visible === true;
    const current = this.state.selectionAnchor;
    if (
      current &&
      current.visible === visible &&
      Math.abs(current.x - x) < 0.5 &&
      Math.abs(current.y - y) < 0.5
    ) {
      return;
    }
    this.setState({ selectionAnchor: { x, y, visible } });
  };

  // ---------- 撤销 / 重做 ----------

  undo = (): void => {
    if(this.presentationSource){this.cancelTransaction();return;}
    this.endTransaction();
    if (this.past.length === 0) {
      this.toast('已经没有可撤销的操作了', 'info');
      return;
    }
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(this.state.doc);
    this.applyDoc(previous);
  };

  redo = (): void => {
    this.endTransaction();
    if (this.future.length === 0) {
      this.toast('没有可重做的操作了', 'info');
      return;
    }
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.state.doc);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.applyDoc(next);
  };

  // ---------- 调试 ----------

  setDebugVisible = (visible: boolean): void => {
    if (this.state.debugVisible === visible) return;
    this.setState({ debugVisible: visible });
  };

  // ---------- 花材加载状态 ----------

  beginAssetLoad = (label = '正在准备花材…'): void => {
    this.loadingCount += 1;
    if (this.loadingCount === 1) {
      this.setState({ loading: { active: true, label, progress: null } });
    }
  };

  assetLoadProgress = (progress: number | null): void => {
    if (!this.state.loading.active) return;
    const next = progress === null ? null : Math.max(0, Math.min(1, progress));
    if (this.state.loading.progress === next) return;
    this.setState({ loading: { ...this.state.loading, progress: next } });
  };

  endAssetLoad = (): void => {
    this.loadingCount = Math.max(0, this.loadingCount - 1);
    if (this.loadingCount === 0 && this.state.loading.active) {
      this.setState({ loading: { ...this.state.loading, active: false, progress: null } });
    }
  };

  reportAssetFailure = (assetId: string, message: string): void => {
    this.setState({ assetFailure: { assetId, message } });
  };

  retryAssets = (): void => {
    this.setState({
      assetFailure: null,
      assetRetryToken: this.state.assetRetryToken + 1,
    });
    this.toast('正在重新加载花材…', 'info');
  };

  // ---------- 内部 ----------

  /** 放置结束（落位、取消、换选中花材、清空、导入）时要一起清掉的临时状态。 */
  private placementExtrasCleared(extra: Partial<AppState> = {}): Partial<AppState> {
    return {
      placement: null,
      suggestions: [],
      activeSuggestionId: null,
      pinnedSuggestionId: null,
      selectionAnchor: null,
      snapHint: null,
      ...extra,
    };
  }

  private persistSettings(): void {
    saveStoredSettings({
      assist: this.state.assist,
      motion: this.state.motion,
      audio: this.state.audio,
      viewPreset: this.state.viewPreset,
      completedCommissions: this.state.completedCommissions,
      mode: this.state.mode,
      commission: this.state.commissionId
        ? {
            id: this.state.commissionId,
            deliveredAt: this.state.commissionDeliveredAt,
            response: this.state.commissionResponse,
          }
        : null,
    });
  }

  private recordHistory(): void {
    this.past.push(this.state.doc);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
  }

  private touchDoc(patch: Partial<BouquetDocument>): BouquetDocument {
    return {
      ...this.state.doc,
      ...patch,
      version: SCHEMA_VERSION,
      assetsVersion: this.state.catalog.assetsVersion,
      sizeCandidate: this.state.doc.sizeCandidate ?? 'a',
      updatedAt: new Date().toISOString(),
    };
  }

  private applyDoc(nextDoc: BouquetDocument): void {
    nextDoc = { ...nextDoc, stems: nextDoc.stems.map(stem => constrainStem(stem, nextDoc.presentation.kind)) };
    const selectedId =
      this.state.selectedId && nextDoc.stems.some((stem) => stem.id === this.state.selectedId)
        ? this.state.selectedId
        : null;
    const hoveredId =
      this.state.hoveredId && nextDoc.stems.some((stem) => stem.id === this.state.hoveredId)
        ? this.state.hoveredId
        : null;
    this.state = {
      ...this.state,
      doc: nextDoc,
      selectedId,
      hoveredId,
      // 选中丢失/换人时屏幕锚点立刻作废，避免 UI 工具条停在一个不属于当前花头的旧位置。
      ...(selectedId !== this.state.selectedId ? { selectionAnchor: null } : null),
      pastCount: this.past.length,
      futureCount: this.future.length,
    };
    this.scheduleSave();
    this.emit();
  }

  private buildSaveDoc(): BouquetDocument {
    return {
      ...this.state.doc,
      version: SCHEMA_VERSION,
      assetsVersion: this.state.catalog.assetsVersion,
      sizeCandidate: this.state.doc.sizeCandidate ?? 'a',
      updatedAt: new Date().toISOString(),
    };
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const ok = saveStoredDocument(this.buildSaveDoc());
      if (ok) {
        this.setState({ savedAt: Date.now() });
      } else if (!this.saveFailedNotified) {
        this.saveFailedNotified = true;
        this.pushToast('自动保存失败，可能是浏览器存储空间不够', 'warn');
        this.emit();
      }
    }, 450);
  }

  private flushOnUnload = (): void => {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      saveStoredDocument(this.buildSaveDoc());
    }
  };

  private setState(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const store = new Store();
