/**
 * 花束场景管理器（单例，由 App 挂载）。
 *
 * 职责：Three.js 场景/相机/灯光/工作台/花枝、OrbitControls、射线拾取、
 * 花枝拖动、放置预览与建议位吸附、选中锚点回报、分步包装动画、阶段机位。
 * 交互状态仍由 store 持有：scene 读取状态并在必要时回报意图，避免两套状态打架。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  ALBUM_THUMBNAIL_SIZE,
  CLICK_SLOP_PX,
  EXPORT_PNG_SIZE,
  GRIP_Y,
  MAX_HEAD_RADIUS,
  MAX_SUGGESTIONS,
  MAX_TILT,
  PACKAGE_STEP_MS,
  PAPER_OPEN_SCALE_MAX,
  PAPER_OPEN_SCALE_MIN,
  SNAP_ENTER_PX,
  SNAP_EXIT_PX,
  TABLE_TOP_Y,
  WRAP_MAX_RADIUS,
  WRAP_MIN_RADIUS,
  WRAP_RADIUS_MARGIN,
  WRAP_RADIUS_TIGHTEN,
  WHEEL_VIEW_COOLDOWN_MS,
  WHEEL_VIEW_RESET_MS,
  WHEEL_VIEW_STEP,
} from '../config';
import { clampPose, clampScale, normalizeAngle, poseToQuaternion, radToDeg } from '../data/pose';
import { supportsRibbon } from '../data/decor-capability';
import type { VesselKind } from '../data/presentation';
import type {
  AssetEntry,
  AssetKind,
  CardState,
  MotionPreference,
  PackageStep,
  PaperId,
  RibbonColorId,
  RuntimeCatalog,
  SelectionAnchor,
  SnapHint,
  StemInstance,
  StemPose,
  SuggestionCandidate,
  ViewPreset,
  WorkflowStage,
  Vec3,
} from '../data/types';
import type { Store } from '../state/store';
import type { PlacedHead } from '../placement/suggest';
import { suggestPlacements } from '../placement/suggest';
import { SnapController, type SnapAnchor } from '../placement/snap';
import { AssetLoader, type LoadedAsset } from './assets/AssetLoader';
import { applyFinishTrim } from './assets/finishTrim';
import {
  applyLowerStemTrim,
  applyPetalFlip,
  applyThorns,
  disposeOrganizeVisual,
  getOrganizeVisualDebug,
} from './assets/organize-visuals';
import { applyPreparation, isolateMaterials, setFocus, disposeInstanceMaterials } from './assets/preparation';
import { disposeFoam, getFoamDebug, syncFoam } from './decor/foam';
import { createVessel, disposeVessel } from './decor/vessel';
import {
  createOrnaments,
  disposeOrnaments,
  getOrnamentDebug,
  syncOrnaments,
} from './decor/ornaments';
import { getVesselModel, loadVesselModel, releaseVesselModel, disposeVesselModels } from './decor/vessel-load';
import { detachSceneProps, disposeSceneProps, activateSceneProps } from './decor/scene-props';
import { createWindowSet, createGallerySet, framePhoto } from './decor/photo';
import { createFloristSet } from './decor/scene-florist';
import { createGardenSet } from './decor/scene-garden';
import { createFestiveSet } from './decor/scene-festive';
import { createLivingSet } from './decor/scene-living';
import { createCafeSet } from './decor/scene-cafe';
import { STAGE_CAMERAS, StageCamera } from './camera/StageCamera';
import { createCardObject, disposeCard, drawCardTexture, setCardAppear, type CardObject } from './decor/card';
import { createRibbonObject, disposeRibbon, fitRibbonToWaist, ribbonWaist, setRibbonAppear, type RibbonObject } from './decor/ribbon';
import {
  createPaperObject,
  disposePaper,
  rebuildPaper,
  type PaperObject,
} from './decor/wrapping';
import { SuggestionLayer } from './suggestions/SuggestionLayer';
import {
  CONTACT_DEFLECT_MAX,
  CONTACT_PUSH_MAX,
  CONTACT_SEPARATION_MAX,
  CONTACT_SPRING_IN,
  CONTACT_SPRING_OUT,
  CONTACT_SQUASH_MAX,
  clampOffset,
  criticallyDampedStep,
  solveContacts,
  type ContactResult,
  type ContactStem,
} from './contact';
import {
  allowed,
  headVolume,
  limitsFor,
  overlapBetween,
  partVolume,
  stricterLimits,
  transformVolume,
  type EnvelopeOccupant,
  type EnvelopeVolume,
  type Quat,
} from './envelope';
import {
  evaluate as evaluatePlacement,
  resolvePlacement,
  type PlacementPose,
  type PlacementResult,
} from './placement';
import type { PoseConstraintInput, PoseConstraintResult } from '../state/store';

const DEFAULT_HEAD_HEIGHT = 0.36;

/** THREE 四元数 → envelope 模块的纯数组四元数。 */
function quatTuple(q: THREE.Quaternion): Quat {
  return [q.x, q.y, q.z, q.w];
}

/** stem.pose → 落位求解器的位姿（spin 不影响花头占位）。 */
function toPlacementPose(pose: StemPose): PlacementPose {
  return { tilt: pose.tilt, direction: pose.direction, height: pose.height };
}
/** 建议位与包装都按握点附近的同一束心计算；落位时 store 只加很小的随机抖动。 */
const DEFAULT_HEAD_RADIUS: Record<string, number> = {
  main: 0.095,
  filler: 0.075,
  greenery: 0.1,
};

interface StemView {
  stemId: string;
  root: THREE.Group;
  object: THREE.Object3D | null;
  loaded: LoadedAsset | null;
  loadKey: string;
  /** 姿态算出的基础变换；接触形变每帧在它之上叠加，不改写文档。 */
  basePosition: THREE.Vector3;
  baseQuaternion: THREE.Quaternion;
}

/**
 * 单枝接触形变的弹簧状态（V0.7.1）。
 *
 * 求解器给的是「目标」，真正的值由临界阻尼弹簧收敛过来：目标突变、两对接触
 * 抢主导、store 同步刷新姿态时，画面上都是连续的形变，不会一帧弹回去。
 */
interface ContactMotion {
  squash: number;
  squashVelocity: number;
  /** 花头收拢方向（世界坐标，平滑跟踪接触法线）。 */
  axis: THREE.Vector3;
  axisVelocity: THREE.Vector3;
  /** 枝条弯曲向量（世界坐标，旋转轴 × 弧度）。 */
  bend: THREE.Vector3;
  bendVelocity: THREE.Vector3;
  /** 位置让步（世界坐标）。 */
  push: THREE.Vector3;
  pushVelocity: THREE.Vector3;
  /** 位置分离（世界坐标，把重叠的花头真正推开）。 */
  separation: THREE.Vector3;
  separationVelocity: THREE.Vector3;
}

function createContactMotion(): ContactMotion {
  return {
    squash: 0,
    squashVelocity: 0,
    axis: new THREE.Vector3(0, 1, 0),
    axisVelocity: new THREE.Vector3(),
    bend: new THREE.Vector3(),
    bendVelocity: new THREE.Vector3(),
    push: new THREE.Vector3(),
    pushVelocity: new THREE.Vector3(),
    separation: new THREE.Vector3(),
    separationVelocity: new THREE.Vector3(),
  };
}

/** 对向量的三个分量分别做一次临界阻尼积分。 */
function stepSpringVector(
  value: THREE.Vector3,
  velocity: THREE.Vector3,
  target: THREE.Vector3,
  omega: number,
  dt: number,
): void {
  const [x, vx] = criticallyDampedStep(value.x, velocity.x, target.x, omega, dt);
  const [y, vy] = criticallyDampedStep(value.y, velocity.y, target.y, omega, dt);
  const [z, vz] = criticallyDampedStep(value.z, velocity.z, target.z, omega, dt);
  value.set(x, y, z);
  velocity.set(vx, vy, vz);
}

function clampVectorLength(value: THREE.Vector3, max: number): void {
  const length = value.length();
  if (length > max && length > 1e-9) value.multiplyScalar(max / length);
}

interface DragState {
  stemId: string;
  startX: number;
  startY: number;
  moved: boolean;
  planePoint: THREE.Vector3;
  grabOffset: THREE.Vector3;
  leverLength: number;
  limitNoticeShown: boolean;
  /** 本次拖动上一个有效位姿：V0.7.3 于此向目标扫掠，快速横穿不会穿过别的花头。 */
  lastPose: PlacementPose;
}

interface PlacementPreview {
  tilt: number;
  direction: number;
  height: number;
  atLimit: boolean;
}

interface PackagePieces {
  fold: number;
  ribbon: number;
  card: number;
}

interface SceneStats {
  fps: number;
  calls: number;
  triangles: number;
  stems: number;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerpAngleDeg(from: number, to: number, amount: number): number {
  const diff = ((to - from + 540) % 360) - 180;
  return normalizeAngle(from + diff * amount);
}

/** 射线命中的对象是否真的显示着（自身与所有祖先都 visible）。 */
function isShown(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export class BouquetScene {
  private readonly container: HTMLElement;
  private readonly store: Store;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly stageCamera: StageCamera;
  private readonly suggestionLayer: SuggestionLayer;
  private readonly snap = new SnapController(SNAP_ENTER_PX, SNAP_EXIT_PX);
  private readonly startedAt = performance.now();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly assetLoader: AssetLoader;
  private readonly unsubscribe: () => void;
  private readonly resizeObserver: ResizeObserver;
  private readonly views = new Map<string, StemView>();
  private readonly systemReduceMotion: boolean;

  private readonly markerSelected: THREE.Mesh;
  private readonly markerHover: THREE.Mesh;
  private readonly markerGrip: THREE.Mesh;
  private readonly markerGhost: THREE.Mesh;
  private readonly boundaryRing: THREE.LineLoop;
  private readonly tableGroup = new THREE.Group();
  /** 导出构图只包含台面（不含细长石座），否则 2048 成品图会被底座拉远。 */
  private readonly tableExportObjects: THREE.Object3D[] = [];

  private ghostRoot: THREE.Object3D | null = null;
  private ghostMaterials: THREE.Material[] = [];
  private ghostKey: string | null = null;
  private ghostPose: StemPose | null = null;
  private ghostTargetPose: StemPose | null = null;
  private ghostSnapEasing = false;
  private ghostHeadHeight = DEFAULT_HEAD_HEIGHT;
  private ghostSpin = 18;
  private placementAssetId: string | null = null;
  private pointerInCanvas = false;

  private paper: PaperObject | null = null;
  private vessel: THREE.Group | null = null;
  private vesselKind = '';
  /** Lux3D 花器模型（缓存持有，挂载在当前容器组下）。 */
  private vesselModel: THREE.Group | null = null;
  private vesselLoadToken = 0;
  private sheetsSignature = '';
  private capturing = false;
  private gallerySet: THREE.Group | null = null;
  private windowSet: THREE.Group | null = null;
  private floristSet: THREE.Group | null = null;
  private gardenSet: THREE.Group | null = null;
  private festiveSet: THREE.Group | null = null;
  private livingSet: THREE.Group | null = null;
  private cafeSet: THREE.Group | null = null;
  private ribbon: RibbonObject | null = null;
  private card: CardObject | null = null;
  /** V16 §5：辅助装饰层（场景根节点，位置用花束坐标）。 */
  private ornaments: THREE.Group | null = null;
  private paperRadius = 0;
  private paperId: PaperId | null = null;
  private ribbonColorId: RibbonColorId | null = null;
  private cardKey = '';
  private wrappingReady = false;
  private packageStep: PackageStep = 'paper';
  private pieceFold = 0;
  private pieceRibbon = 0;
  private pieceCard = 0;
  private packageAnim: { start: number; from: PackagePieces; to: PackagePieces } | null = null;
  private packageOpenScale = 1;
  private appliedPaperFold = -1;
  private appliedPaperOpenScale = -1;
  private environmentTexture: THREE.Texture | null = null;

  private stage: WorkflowStage = 'arrange';
  private lastStage: WorkflowStage | null = null;
  private lastPhotoRestoreToken = 0;
  private lastShowcase: boolean | null = null;
  private suggestions: SuggestionCandidate[] = [];
  private suggestionsSignature = '';
  private pendingTemplate: THREE.Object3D | null = null;
  private pendingTemplateKey = '';
  private pendingLoaded: LoadedAsset | null = null;
  private pendingHeadRadius = DEFAULT_HEAD_RADIUS.main ?? 0.095;
  private lastAssistKey = '';
  private lastPinId: string | null = null;
  private lastViewPreset: ViewPreset | null = null;
  private snapHintReported = false;
  private lastSnapHintAt = 0;
  private anchorReport: { x: number; y: number; stemId: string; time: number } | null = null;
  /** 已回报给 store 的实际机位方向（单位向量，2 位小数）与上次回报时间。 */
  private reportedCameraDirection: [number, number, number] | null = null;
  private lastCameraDirectionAt = 0;
  /** 上次回报时的精确方向：用来判断「镜头几乎没动」，避免阻尼余摆反复触发展示失效。 */
  private lastExactCameraDirection: [number, number, number] | null = null;
  private readonly cameraDirectionScratch = new THREE.Vector3();

  private drag: DragState | null = null;
  private pointerMode: 'orbit' | 'placement' | null = null;
  private pointerStart: { x: number; y: number } | null = null;
  private pressOrigin: { x: number; y: number; onCanvas: boolean } | null = null;
  private lastPointer: { x: number; y: number } | null = null;
  private lastFrameTime = performance.now();
  private disposed = false;
  private raf = 0;

  private frames = 0;
  lastExportDebug: Record<string, unknown> | null = null;
  private statsTime = performance.now();
  private stats: SceneStats = { fps: 0, calls: 0, triangles: 0, stems: 0 };
  private readonly backgroundTexture: THREE.CanvasTexture;

  constructor(container: HTMLElement, store: Store) {
    this.container = container;
    this.store = store;
    this.systemReduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      // 导出 PNG 需要读取 WebGL 画布，保留绘制缓冲最稳妥。
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = true;
    // Three 0.187 已移除 PCFSoftShadowMap，用 PCF + shadow.radius 得到软边，避免控制台告警。
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // 花束在两次编辑之间是静止的：阴影不必每帧重算（Intel 核显实测可省一半三角形）。
    // 文档/包装变化时由 syncStems/syncDecor/包装动画显式置 needsUpdate。
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'bouquet-canvas';
    this.canvas.setAttribute('aria-label', '花束工作台 3D 画面');
    container.appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(38, width / Math.max(1, height), 0.08, 60);
    this.camera.position.copy(STAGE_CAMERAS.arrange.position);

    const background = createBackgroundTexture();
    this.backgroundTexture = background;
    this.scene.background = background;
    this.setupEnvironment();

    this.assetLoader = new AssetLoader(
      import.meta.env.BASE_URL,
      (message, kind) => {
        store.toast(message, kind);
      },
      {
        onStart: () => store.beginAssetLoad('正在准备花材…'),
        onProgress: (_assetId, progress) => store.assetLoadProgress(progress),
        onEnd: () => store.endAssetLoad(),
        onFailure: (assetId, message) => store.reportAssetFailure(assetId, message),
      },
    );

    this.setupLights();
    this.setupFloor();
    this.setupTable();
    this.boundaryRing = this.setupBoundaryRing();
    const markers = this.setupMarkers();
    this.markerSelected = markers.selected;
    this.markerHover = markers.hover;
    this.markerGrip = markers.grip;
    this.markerGhost = markers.ghost;

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.copy(STAGE_CAMERAS.arrange.target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.85;
    this.controls.maxDistance = 3.4;
    this.controls.minPolarAngle = 0.32;
    this.controls.maxPolarAngle = 1.46;
    this.controls.rotateSpeed = 0.85;
    this.controls.zoomSpeed = 0.8;
    this.controls.update();

    this.stageCamera = new StageCamera(this.camera, this.controls, () => this.isReduceMotion());
    this.suggestionLayer = new SuggestionLayer(this.scene);

    // 在容器捕获阶段先拿到 pointerdown：命中花枝时抢先关掉 OrbitControls，
    // 否则同一元素上的指针监听顺序会让相机也跟着转。
    this.container.addEventListener('pointerdown', this.handlePointerDown, { capture: true });
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.addEventListener('wheel', this.handleScaleWheel, {capture:true,passive:false});
    this.container.addEventListener('wheel', this.handleViewWheel, {capture:true,passive:false});
    window.addEventListener('pointerdown', this.handleWindowPointerDown, { capture: true });
    window.addEventListener('pointermove', this.handlePointerMove, { passive: true });
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('pointercancel', this.handlePointerCancel);
    window.addEventListener('blur', this.handleWindowBlur);
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    this.unsubscribe = store.subscribe(this.handleStoreChange);
    // V0.7.3：新增 / 复制 / 精调 / 缩放也走场景的同一套有效落位约束。
    store.setPoseConstraint(this.constrainStemIntent);
    this.handleStoreChange();
    this.animate();
  }

  // ---------- 构建场景 ----------

  /**
   * 真实 glTF 是 PBR 材质，只有直射光会显得暗、艳、缺高光。
   * 用 RoomEnvironment 烘一张 PMREM 环境贴图做 IBL，保留暖色背景与阴影。
   */
  private setupEnvironment(): void {
    const generator = new THREE.PMREMGenerator(this.renderer);
    generator.compileEquirectangularShader();
    const environmentScene = new RoomEnvironment();
    const target = generator.fromScene(environmentScene, 0.04);
    this.environmentTexture = target.texture;
    this.scene.environment = target.texture;
    this.scene.environmentIntensity = 0.82;
    environmentScene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material?.dispose();
      }
    });
    generator.dispose();
  }

  /** 柔和侧光：主光在右前（工作室窗户方向），背光勾轮廓，环境光不过亮。 */
  private setupLights(): void {
    const hemisphere = new THREE.HemisphereLight(0xfff4e7, 0xc9b49b, 0.3);
    this.scene.add(hemisphere);

    const ambient = new THREE.AmbientLight(0xfff1e2, 0.1);
    this.scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xfff1de, 1.52);
    keyLight.position.set(2.05, 3.1, 2.25);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1536, 1536);
    keyLight.shadow.camera.left = -1.25;
    keyLight.shadow.camera.right = 1.25;
    keyLight.shadow.camera.top = 1.5;
    keyLight.shadow.camera.bottom = -1.2;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 9;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    keyLight.shadow.radius = 4;
    keyLight.target.position.set(0, 1.0, 0);
    this.scene.add(keyLight);
    this.scene.add(keyLight.target);

    // 左侧补一点暖光，让暗面有细节但不抢主光。
    const fillLight = new THREE.DirectionalLight(0xffe4cd, 0.26);
    fillLight.position.set(-2.6, 1.9, -1.1);
    this.scene.add(fillLight);

    // 后方轮廓光：把花和纸从背景里勾出来，避免看起来发闷。
    const rimLight = new THREE.DirectionalLight(0xfff6ea, 0.34);
    rimLight.position.set(-0.3, 2.5, -2.7);
    this.scene.add(rimLight);
  }

  private setupFloor(): void {
    const geometry = new THREE.PlaneGeometry(60, 60);
    const material = new THREE.MeshStandardMaterial({
      map: createStudioFloorTexture(),
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
    });
    const floor = new THREE.Mesh(geometry, material);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // 远处一圈深植物绿的暗角，把视线收在花束上。
    const backdrop = new THREE.Mesh(
      new THREE.CylinderGeometry(4.6, 4.6, 2.4, 48, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xdcc6ab,
        transparent: true,
        opacity: 0.1,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    backdrop.position.y = 1.5;
    this.scene.add(backdrop);
  }

  private setupTable(): void {
    this.tableGroup.name = 'table';
    const wood = createWoodTexture();
    const sideMaterial = new THREE.MeshStandardMaterial({
      color: 0xc6a682,
      roughness: 0.82,
      metalness: 0,
      map: wood,
    });
    const topMaterial = new THREE.MeshStandardMaterial({
      color: 0xdcc0a0,
      roughness: 0.7,
      metalness: 0,
      map: wood,
    });
    const topGeometry = new THREE.CylinderGeometry(0.56, 0.56, 0.055, 48);
    const top = new THREE.Mesh(topGeometry, [sideMaterial, topMaterial, sideMaterial]);
    top.position.y = TABLE_TOP_Y - 0.0275;
    top.castShadow = true;
    top.receiveShadow = true;
    this.tableGroup.add(top);

    // 石质基座：低饱和暖灰，比木头更沉，衬得纸和花更轻。
    const pedestalGeometry = new THREE.CylinderGeometry(0.1, 0.17, TABLE_TOP_Y - 0.055, 28);
    const pedestalMaterial = new THREE.MeshStandardMaterial({
      color: 0xc2b6a6,
      roughness: 0.92,
      metalness: 0.04,
    });
    const pedestal = new THREE.Mesh(pedestalGeometry, pedestalMaterial);
    pedestal.position.y = (TABLE_TOP_Y - 0.055) / 2;
    pedestal.castShadow = true;
    pedestal.receiveShadow = true;
    this.tableGroup.add(pedestal);

    const baseGeometry = new THREE.CylinderGeometry(0.3, 0.34, 0.035, 40);
    const baseMaterial = new THREE.MeshStandardMaterial({
      color: 0xd3c3b0,
      roughness: 0.94,
    });
    const base = new THREE.Mesh(baseGeometry, baseMaterial);
    base.position.y = 0.0175;
    base.castShadow = true;
    base.receiveShadow = true;
    this.tableGroup.add(base);

    // 台面上的一块深植物绿绒垫：给暖纸色一个安静的对照色。
    const matGeometry = new THREE.CircleGeometry(0.36, 64);
    const matMaterial = new THREE.MeshStandardMaterial({
      map: createFeltTexture(),
      transparent: true,
      roughness: 0.98,
      metalness: 0,
      depthWrite: false,
    });
    const mat = new THREE.Mesh(matGeometry, matMaterial);
    mat.rotation.x = -Math.PI / 2;
    mat.position.y = TABLE_TOP_Y + 0.0012;
    mat.receiveShadow = true;
    this.tableGroup.add(mat);
    this.tableExportObjects.push(mat);

    // 花束在台面上的柔和接触阴影（不依赖实时阴影，近看更干净）。
    const shadowTexture = createContactShadowTexture();
    const shadowGeometry = new THREE.PlaneGeometry(0.82, 0.82);
    const shadowMaterial = new THREE.MeshBasicMaterial({
      map: shadowTexture,
      transparent: true,
      depthWrite: false,
      opacity: 0.42,
    });
    const contactShadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.position.y = TABLE_TOP_Y + 0.0026;
    contactShadow.renderOrder = 2;
    this.tableGroup.add(contactShadow);
    this.tableExportObjects.push(contactShadow);

    this.scene.add(this.tableGroup);
  }

  private setupBoundaryRing(): THREE.LineLoop {
    const segments = 96;
    const points: number[] = [];
    for (let i = 0; i < segments; i += 1) {
      const angle = (i / segments) * Math.PI * 2;
      points.push(Math.sin(angle) * MAX_HEAD_RADIUS, 0, Math.cos(angle) * MAX_HEAD_RADIUS);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const material = new THREE.LineBasicMaterial({
      color: 0x7d9a74,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    const ring = new THREE.LineLoop(geometry, material);
    ring.position.y = TABLE_TOP_Y + 0.004;
    ring.visible = false;
    this.scene.add(ring);
    return ring;
  }

  private setupMarkers(): {
    selected: THREE.Mesh;
    hover: THREE.Mesh;
    grip: THREE.Mesh;
    ghost: THREE.Mesh;
  } {
    const selectedMaterial = new THREE.MeshBasicMaterial({
      color: 0xd97e92,
      transparent: true,
      opacity: 0.82,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const selected = new THREE.Mesh(new THREE.RingGeometry(0.074, 0.085, 40), selectedMaterial);
    selected.renderOrder = 20;
    selected.visible = false;
    selected.frustumCulled = false;
    this.scene.add(selected);

    const hoverMaterial = new THREE.MeshBasicMaterial({
      color: 0xf3c46a,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const hover = new THREE.Mesh(new THREE.RingGeometry(0.058, 0.07, 36), hoverMaterial);
    hover.renderOrder = 19;
    hover.visible = false;
    hover.frustumCulled = false;
    this.scene.add(hover);

    const gripMaterial = new THREE.MeshBasicMaterial({
      color: 0xe77f9c,
      transparent: true,
      opacity: 0.75,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const grip = new THREE.Mesh(new THREE.RingGeometry(0.026, 0.036, 28), gripMaterial);
    grip.rotation.x = -Math.PI / 2;
    grip.renderOrder = 18;
    grip.visible = false;
    grip.frustumCulled = false;
    this.scene.add(grip);

    const ghostMaterial = new THREE.MeshBasicMaterial({
      color: 0x8fae86,
      transparent: true,
      opacity: 0.72,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ghost = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.062, 32), ghostMaterial);
    ghost.renderOrder = 17;
    ghost.visible = false;
    ghost.frustumCulled = false;
    this.scene.add(ghost);

    return { selected, hover, grip, ghost };
  }

  // ---------- 阶段、相机与欣赏 ----------

  private syncStage(): void {
    const state = this.store.getState();
    const stage = state.stage ?? 'arrange';
    this.stage = stage;
    if (this.lastStage !== stage) {
      this.lastStage = stage;
      this.stageCamera.setStage(stage);
      this.updateCameraFit();
      if (stage === 'finish') {
        this.clearGhost();
        this.ghostPose = null;
        this.ghostTargetPose = null;
        this.boundaryRing.visible = false;
        this.markerGhost.visible = false;
        this.snap.reset();
      }
      this.renderSuggestions();
      // 换阶段会把自由镜头拉回该阶段默认构图；预设状态同步回斜 45°，避免界面显示「自由」。
      if(stage==='finish'&&state.doc.photo.direction){
        this.lastViewPreset='free';
        this.stageCamera.restoreDirection(state.doc.photo.direction);
        this.store.setViewPreset('free');
      }else if (state.viewPreset === 'free') this.store.setViewPreset('quarter');
    }
    if(this.lastPhotoRestoreToken!==state.photoRestoreToken){
      this.lastPhotoRestoreToken=state.photoRestoreToken;
      if(stage==='finish'&&state.doc.photo.direction){
        this.lastViewPreset='free';
        this.stageCamera.restoreDirection(state.doc.photo.direction);
        this.store.setViewPreset('free');
      }
    }
    const showcase = Boolean(state.showcase);
    if (this.lastShowcase !== showcase) {
      this.lastShowcase = showcase;
      if (showcase) this.stageCamera.startShowcase();
      else this.stageCamera.stopShowcase();
    }
  }

  // ---------- 包装、丝带与卡片 ----------

  /** 文档/包装变化时把阴影标脏（shadowMap.autoUpdate 已关闭）。 */
  private markShadowsDirty(): void {
    this.renderer.shadowMap.needsUpdate = true;
  }

  private syncDecor(): void {
    this.markShadowsDirty();
    const state = this.store.getState();
    const doc = state.doc;
    if(!this.gallerySet){this.gallerySet=createGallerySet();this.scene.add(this.gallerySet);}
    if(!this.windowSet){this.windowSet=createWindowSet();this.scene.add(this.windowSet);}
    if(!this.floristSet){this.floristSet=createFloristSet();this.scene.add(this.floristSet);}
    if(!this.gardenSet){this.gardenSet=createGardenSet();this.scene.add(this.gardenSet);}
    if(!this.festiveSet){this.festiveSet=createFestiveSet();this.scene.add(this.festiveSet);}
    if(!this.livingSet){this.livingSet=createLivingSet();this.scene.add(this.livingSet);}
    if(!this.cafeSet){this.cafeSet=createCafeSet();this.scene.add(this.cafeSet);}
    this.syncPhotoSet();
    const kind = doc.presentation.kind;
    // V16 §5：花礼盒自带的缎带是模型的一部分，不再是可编辑丝带——
    // 换丝带颜色不再重建礼盒，也不叠加新的蝴蝶结（避免出现无效换色控件）。
    const vesselKey = kind;
    if (vesselKey !== this.vesselKind) {
      this.releaseVesselModel();
      if (this.vessel) { this.scene.remove(this.vessel); disposeFoam(this.vessel); disposeVessel(this.vessel); this.vessel=null; }
      if (kind !== 'paper') {
        this.vessel=createVessel(kind, doc.ribbon.colorId);
        this.scene.add(this.vessel);
        this.attachVesselModel(kind);
      }
      this.vesselKind=vesselKey;
    }
    if(this.vessel)this.vessel.visible=doc.stems.length>0;
    // V16 §3：花泥挂在容器组下，只对适用容器显示；不适用形态由模块自己隐藏。
    if (this.vessel) syncFoam(this.vessel, kind, doc.presentation.foam ?? { fitted: false, cut: 0 });
    const signature=JSON.stringify(doc.presentation.sheets);
    if(signature!==this.sheetsSignature){this.sheetsSignature=signature;this.appliedPaperFold=-1;}
    const wrappingEnabled = kind === 'paper' && doc.wrapping.enabled && doc.stems.length > 0;
    const radius = this.computeEnvelopeRadius(doc.stems);
    const step = doc.wrapping.step ?? 'paper';
    const openScale = clamp(
      Number.isFinite(doc.wrapping.openScale) ? doc.wrapping.openScale : 1,
      PAPER_OPEN_SCALE_MIN,
      PAPER_OPEN_SCALE_MAX,
    );

    this.wrappingReady = wrappingEnabled;
    this.packageOpenScale = openScale;

    if (wrappingEnabled) {
      if (!this.paper) {
        this.paper = createPaperObject(doc.wrapping.paperId, radius, openScale);
        this.scene.add(this.paper.group);
        this.paperId = doc.wrapping.paperId;
        this.paperRadius = radius;
        this.appliedPaperFold = -1;
        this.appliedPaperOpenScale = -1;
      } else if (
        this.paperId !== doc.wrapping.paperId ||
        Math.abs(this.paperRadius - radius) > 0.006
      ) {
        this.paperId = doc.wrapping.paperId;
        this.paperRadius = radius;
        this.appliedPaperFold = -1;
      }
      this.paper.group.visible = true;

      // 丝带系在「收口后的纸腰」上：高度和半径都按纸片实际几何取（V16.1）。
      // 之前固定 radius .063 + Y GRIP_Y，V15.1 压低纸口后丝带环会浮在纸面之上。
      // ribbonWaist 里用的是 wrapping.ts 束腰行（局部 0.2 m）与同一套收口公式。
      const waist = ribbonWaist(doc.presentation.sheets, this.pieceFold);
      const ribbonRadius = waist.radius;
      if (
        !this.ribbon ||
        this.ribbonColorId !== doc.ribbon.colorId ||
        Math.abs(this.ribbon.radius - ribbonRadius) > 0.02
      ) {
        if (this.ribbon) {
          this.scene.remove(this.ribbon.group);
          disposeRibbon(this.ribbon);
        }
        this.ribbon = createRibbonObject(ribbonRadius, doc.ribbon.colorId);
        this.ribbonColorId = doc.ribbon.colorId;
        this.scene.add(this.ribbon.group);
      }
      fitRibbonToWaist(this.ribbon, waist);
      this.ribbon.group.visible = true;
    } else {
      this.snap.reset();
      if (this.paper) this.paper.group.visible = false;
      if (this.ribbon) this.ribbon.group.visible = false;
      this.packageAnim = null;
      this.pieceFold = 0;
      this.pieceRibbon = 0;
      this.pieceCard = 0;
      this.packageStep = 'paper';
    }

    this.syncCard(doc.card, radius, wrappingEnabled);
    this.setPackageTargets(wrappingEnabled ? step : 'paper');
    if (!wrappingEnabled) this.applyPackagePieces();

    // V16 §5：辅助装饰属于作品。按当前轮廓半径与呈现形态同步；能力表不允许的
    // 装饰不渲染（换容器后不会遗留悬空装饰）。
    if (!this.ornaments) {
      this.ornaments = createOrnaments();
      this.scene.add(this.ornaments);
    }
    this.ornaments.visible = doc.stems.length > 0;
    syncOrnaments(this.ornaments, doc.ornaments, {
      radius: Math.max(radius, 0.12),
      kind,
    });
  }

  /**
   * 花器外观用 Lux3D 生成的 GLB（见 data/presentation.ts 的 VESSEL_MODELS）：
   * 程序化容器先立即出现，模型加载完成后替换外观；加载失败就一直保留程序化版本。
   */
  private attachVesselModel(kind: VesselKind): void {
    const token = ++this.vesselLoadToken;
    const cached = getVesselModel(kind);
    if (cached) {
      this.mountVesselModel(kind, cached);
      return;
    }
    void loadVesselModel(kind).then((model) => {
      if (!model || this.disposed || token !== this.vesselLoadToken) return;
      if (this.store.getState().doc.presentation.kind !== kind) return;
      this.mountVesselModel(kind, model);
    });
  }

  private mountVesselModel(kind: VesselKind, model: THREE.Group): void {
    if (!this.vessel || this.store.getState().doc.presentation.kind !== kind) return;
    // 程序化子件隐藏但保留：模型被摘下（切形态）后仍然可用。花泥不是程序化子件，跳过。
    for (const child of this.vessel.children) {
      if (child.name === 'organize-foam') continue;
      child.visible = false;
    }
    this.vesselModel = model;
    model.visible = true;
    if (model.parent !== this.vessel) this.vessel.add(model);
    // GLB 挂载后重新同步花泥（它会按实际口沿内壁重算尺寸）。
    syncFoam(this.vessel, kind, this.store.getState().doc.presentation.foam ?? { fitted: false, cut: 0 });
    this.markShadowsDirty();
  }

  private releaseVesselModel(): void {
    this.vesselLoadToken++;
    releaseVesselModel(this.vesselModel);
    this.vesselModel = null;
  }

  private computeEnvelopeRadius(stems: StemInstance[]): number {
    if (stems.length === 0) return WRAP_MIN_RADIUS;
    let outer = 0;
    for (const stem of stems) {
      const loaded = this.views.get(stem.id)?.loaded;
      const headHeight = loaded?.headHeight ?? DEFAULT_HEAD_HEIGHT;
      const headRadius = loaded?.headRadius ?? 0.085;
      const head = this.getHeadWorld(stem, headHeight);
      const horizontal = Math.hypot(head.x, head.z);
      outer = Math.max(outer, horizontal + headRadius * stem.scale);
    }
    const relaxed = (outer + WRAP_RADIUS_MARGIN) * WRAP_RADIUS_TIGHTEN;
    return clamp(relaxed, WRAP_MIN_RADIUS, WRAP_MAX_RADIUS);
  }

  /** 按 doc.wrapping.step 设定目标；连续变化用 PACKAGE_STEP_MS 补间，可被下一次状态打断。 */
  private setPackageTargets(step: PackageStep): void {
    const targets: PackagePieces =
      step === 'paper'
        ? { fold: 0, ribbon: 0, card: 0 }
        : step === 'fold'
          ? { fold: 1, ribbon: 0, card: 0 }
          : step === 'ribbon'
            ? { fold: 1, ribbon: 1, card: 0 }
            : { fold: 1, ribbon: 1, card: 1 };
    const changed =
      Math.abs(targets.fold - this.pieceFold) > 0.001 ||
      Math.abs(targets.ribbon - this.pieceRibbon) > 0.001 ||
      Math.abs(targets.card - this.pieceCard) > 0.001;
    this.packageStep = step;
    if(this.packageAnim && Object.keys(targets).every(key=>targets[key as keyof PackagePieces]===this.packageAnim!.to[key as keyof PackagePieces])){
      this.applyPackagePieces();return;
    }
    if (!changed) {
      this.applyPackagePieces();
      return;
    }
    if (this.isReduceMotion()) {
      this.pieceFold = targets.fold;
      this.pieceRibbon = targets.ribbon;
      this.pieceCard = targets.card;
      this.packageAnim = null;
      this.applyPackagePieces();
      return;
    }
    this.packageAnim = {
      start: performance.now(),
      from: { fold: this.pieceFold, ribbon: this.pieceRibbon, card: this.pieceCard },
      to: targets,
    };
    this.applyPackagePieces();
  }

  private updatePackageAnimation(now: number): void {
    const anim = this.packageAnim;
    if (!anim) return;
    this.markShadowsDirty();
    const raw = clamp((now - anim.start) / PACKAGE_STEP_MS, 0, 1);
    const eased = easeInOutCubic(raw);
    this.pieceFold = THREE.MathUtils.lerp(anim.from.fold, anim.to.fold, eased);
    this.pieceRibbon = THREE.MathUtils.lerp(anim.from.ribbon, anim.to.ribbon, eased);
    this.pieceCard = THREE.MathUtils.lerp(anim.from.card, anim.to.card, eased);
    if (raw >= 1) {
      this.pieceFold = anim.to.fold;
      this.pieceRibbon = anim.to.ribbon;
      this.pieceCard = anim.to.card;
      this.packageAnim = null;
    }
    this.applyPackagePieces();
  }

  /** 把当前动画值写进纸张几何 / 丝带 / 卡片。可被随时重复调用，幂等。 */
  private applyPackagePieces(): void {
    if (!this.wrappingReady) {
      if (this.paper) this.paper.group.visible = false;
      if (this.ribbon) this.ribbon.group.visible = false;
      if (this.card) setCardAppear(this.card, this.vessel?.visible && Boolean(this.store.getState().doc.card.message || this.store.getState().doc.card.to) ? 1 : 0);
      return;
    }

    if (this.paper) {
      this.paper.group.visible = true;
      const foldChanged = Math.abs(this.appliedPaperFold - this.pieceFold) > 0.012;
      const scaleChanged = Math.abs(this.appliedPaperOpenScale - this.packageOpenScale) > 0.004;
      if (foldChanged || scaleChanged || this.appliedPaperFold < 0) {
        if (!this.paper.paperId || this.paperRadius > 0) {
          rebuildPaper(
            this.paper,
            this.paperId ?? 'ivory',
            this.paperRadius || WRAP_MIN_RADIUS,
            this.pieceFold,
            this.packageOpenScale,
            this.store.getState().doc.presentation.sheets,
          );
        }
        this.appliedPaperFold = this.pieceFold;
        this.appliedPaperOpenScale = this.packageOpenScale;
      }
    }

    // 丝带环跟着纸腰走：合拢动画每帧都会改纸片几何，这里把 Y/半径同步过去。
    if (this.ribbon && this.wrappingReady) {
      fitRibbonToWaist(
        this.ribbon,
        ribbonWaist(this.store.getState().doc.presentation.sheets, this.pieceFold),
      );
    }
    if (this.ribbon) setRibbonAppear(this.ribbon, this.pieceRibbon);

    if (this.card) {
      const hasText = Boolean(
        this.store.getState().doc.card.to.trim() ||
          this.store.getState().doc.card.message.trim() ||
          this.store.getState().doc.card.from.trim(),
      );
      if (!hasText) {
        this.card.group.visible = false;
      } else {
        const progress = this.pieceCard > 0.002 ? this.pieceCard : 0;
        setCardAppear(this.card, progress);
      }
    }
  }

  private syncCard(card: CardState, radius: number, wrappingEnabled: boolean): void {
    const hasText = Boolean(card.to.trim() || card.message.trim() || card.from.trim());
    const key = `${hasText ? 1 : 0}|${card.to}|${card.message}|${card.from}`;
    if (!this.card) {
      this.card = createCardObject(card);
      this.card.group.visible = false;
      this.scene.add(this.card.group);
      this.cardKey = key;
    } else if (key !== this.cardKey) {
      drawCardTexture(this.card.texture, card);
      this.cardKey = key;
    }
    // 没写字的时候不摆空卡片，避免抢花束的画面；一输入就出现在桌上。
    if (!hasText) {
      this.card.group.visible = false;
      return;
    }
    const spread = Math.max(0.22, radius);
    // 卡片立在包装外侧的左前方，避开右侧蝴蝶结，也让导出构图更完整。
    const cardAzimuth = -0.36;
    const cardDistance = spread + 0.07;
    this.card.group.position.set(
      Math.sin(cardAzimuth) * cardDistance,
      TABLE_TOP_Y + 0.004,
      Math.cos(cardAzimuth) * cardDistance,
    );
    this.card.group.rotation.set(-0.27, 0.52, 0);
    // 没包装时卡片也留在桌面上（保留旧行为）；包装过程中等 card 步骤再出现。
    const progress = wrappingEnabled ? (this.pieceCard > 0.002 ? this.pieceCard : 0) : 1;
    this.card.group.visible = progress > 0.002;
    if (this.card.group.visible) setCardAppear(this.card, progress);
  }

  // ---------- store 同步 ----------

  private handleStoreChange = (): void => {
    const state = this.store.getState();
    // V0.7 §7：固定视角模式下画布滚轮切换视角，不再缩放；自由模式下滚轮照旧缩放。
    this.controls.enableZoom = !state.viewLocked;
    this.syncStage();
    this.syncViewPreset();
    this.syncStems(state.doc.stems, state.catalog);
    this.syncMarkers();
    this.syncPlacement();
    this.syncAssist();
    this.syncSuggestions();
    this.syncDecor();
    this.syncPinnedSuggestion();
  };

  /** store 里的预设视角变化时套用（UI 按钮 / 快捷键 / 复位都走这里）。 */
  private syncViewPreset(): void {
    const preset = this.store.getState().viewPreset ?? 'quarter';
    if (preset === this.lastViewPreset) return;
    this.lastViewPreset = preset;
    this.stageCamera.setPreset(preset);
  }

  private syncStems(stems: StemInstance[], catalog: RuntimeCatalog): void {
    this.markShadowsDirty();
    const seen = new Set<string>();
    for (const stem of stems) {
      seen.add(stem.id);
      let view = this.views.get(stem.id);
      if (!view) {
        const root = new THREE.Group();
        root.name = `stem:${stem.id}`;
        root.userData.stemId = stem.id;
        this.scene.add(root);
        view = {
          stemId: stem.id,
          root,
          object: null,
          loaded: null,
          loadKey: '',
          basePosition: new THREE.Vector3(0, GRIP_Y, 0),
          baseQuaternion: new THREE.Quaternion(),
        };
        this.views.set(stem.id, view);
      }
      const entry: AssetEntry | undefined = catalog.entriesById[stem.assetId];
      const loadKey = `${catalog.mode}:${catalog.assetsVersion}:${stem.assetId}:${entry?.glb ?? 'proc'}`;
      if (view.loadKey !== loadKey) {
        this.requestAsset(view, stem.assetId, entry, catalog, loadKey);
      }
      this.applyStemTransform(view, stem);
    }
    for (const [id, view] of [...this.views.entries()]) {
      if (!seen.has(id)) {
        this.scene.remove(view.root);
        if(view.object){disposeOrganizeVisual(view.object);disposeInstanceMaterials(view.object);}
        this.views.delete(id);
        // 删枝时形变状态一起清掉，拍照/成品阶段冻结时也不会留残影。
        this.contacts.delete(id);
        this.contactMotion.delete(id);
      }
    }
  }

  private requestAsset(
    view: StemView,
    assetId: string,
    entry: AssetEntry | undefined,
    catalog: RuntimeCatalog,
    loadKey: string,
  ): void {
    view.loadKey = loadKey;
    view.loaded = null;
    if (view.object) {
      view.root.remove(view.object);
      disposeInstanceMaterials(view.object);
      view.object = null;
    }
    const stemId = view.stemId;
    void this.assetLoader.load(entry, assetId, catalog).then((loaded) => {
      const current = this.views.get(stemId);
      if (!current || current.loadKey !== loadKey || this.disposed) return;
      current.loaded = loaded;
      const object = loaded.template.clone(true);
      isolateMaterials(object);
      object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.castShadow = true;
          mesh.receiveShadow = false;
          mesh.frustumCulled = true;
        }
      });
      current.root.add(object);
      current.object = object;
      const stem = this.store.getState().doc.stems.find(s=>s.id===stemId);
      if(stem)this.applyStemTransform(current,stem);
      this.syncMarkers();
      this.syncDecor();
      this.syncSuggestions(true);
      this.updateCameraFit();
    });
  }

  private applyStemTransform(view: StemView, stem: StemInstance): void {
    const quaternion = poseToQuaternion(stem.pose);
    const heightOffset = new THREE.Vector3(0, stem.pose.height, 0).applyQuaternion(quaternion);
    view.root.position.set(
      stem.position[0] + heightOffset.x,
      stem.position[1] + heightOffset.y,
      stem.position[2] + heightOffset.z,
    );
    view.root.quaternion.copy(quaternion);
    view.root.scale.setScalar(stem.scale);
    // 记下基础姿态：接触形变每帧都以它为基准叠加，不会累积进文档。
    view.basePosition.copy(view.root.position);
    view.baseQuaternion.copy(view.root.quaternion);
    if(view.object)applyPreparation(view.object,stem.preparation);
    // V16 §3：整理视觉（翻瓣 / 去刺 / 普通花材的下部茎）。幂等，数值没变时只做一次比较；
    // 都在 applyPreparation 之后调用，避免被 prepared-tail 状态覆盖。
    if (view.object) {
      const entry = this.store.getState().catalog.entriesById[stem.assetId];
      const family = entry?.family ?? '';
      const kind = this.store.getState().doc.presentation.kind;
      applyPetalFlip(view.object, stem.preparation.petalFlip ?? 0);
      applyThorns(view.object, family, stem.preparation.thornsRemoved === true);
      applyLowerStemTrim(view.object, kind, stem.preparation.tailLength, family);
    }
    // V0.7.1：基础姿态一刷新就立刻把当前接触形变叠回去。
    // store 的同步（选中锚点、建议位、悬停…）每帧都可能走到这里；如果留到下一帧
    // 再叠，画面上会看到一帧「弹回原位」的抽搐——这就是验收反馈里花在抖的原因。
    this.applyContactToView(view, this.contacts.get(stem.id) ?? null);
  }

  // ---------- V0.7 §4：轻量柔性接触 ----------

  /** 当前平滑后的接触形变；只存在于场景里，不写进 doc，也不进撤销栈。 */
  private readonly contacts = new Map<string, ContactResult>();
  /** 每枝的弹簧状态，保证形变有惯性和阻尼，不是直接跟目标值。 */
  private readonly contactMotion = new Map<string, ContactMotion>();

  /**
   * 每帧算一次接触目标并积分成实际形变。
   *
   * 响应权重：正在拖/选中的花枝承担位置让步与完整偏转，周围花枝只做小幅收拢——
   * 这样挤进去时是「这一枝让」，整束不会漂走。形成形态会保持，拉开或删枝后
   * 目标归零，再由弹簧平滑恢复（挤入比恢复更硬，"被压弯后自己弹回"）。
   */
  private updateContacts(dt: number): void {
    if (this.views.size === 0) return;
    const state = this.store.getState();
    // 拍照/成品阶段冻结同一套形变，保证照片与点评快照看到的是同一状态。
    if (state.stage === 'finish' || state.showcase || this.capturing) return;
    // 删掉的花枝要把它的接触形变一起清掉，否则只会留一份不会衰减的残影。
    for (const stemId of [...this.contacts.keys()]) {
      if (!this.views.has(stemId)) {
        this.contacts.delete(stemId);
        this.contactMotion.delete(stemId);
      }
    }
    const active = this.drag?.stemId ?? state.selectedId ?? null;
    // V0.7.3：接触输入改成「每枝的椭球包络」。核心/外缘宽容度由 envelope 决定；
    // 场景只负责把基础姿态的包络变换到世界，不读本帧形变（否则会自己推自己）。
    const solved = solveContacts(this.collectContactStems(), active);
    for (const [stemId, view] of this.views) {
      const target = solved.get(stemId);
      const motion = this.contactMotion.get(stemId) ?? createContactMotion();
      const targetSquash = target?.squash ?? 0;
      const targetBend = target
        ? new THREE.Vector3(target.bendAxis[0], target.bendAxis[1], target.bendAxis[2]).multiplyScalar(
            target.deflect,
          )
        : new THREE.Vector3();
      const targetPush = target
        ? new THREE.Vector3(...clampOffset(target.offset))
        : new THREE.Vector3();
      const targetSeparation = target
        ? new THREE.Vector3(
            target.separation[0],
            target.separation[1],
            target.separation[2],
          )
        : new THREE.Vector3();
      const targetAxis = target
        ? new THREE.Vector3(target.axis[0], target.axis[1], target.axis[2])
        : motion.axis.clone();

      const squashOmega =
        targetSquash > Math.abs(motion.squash) + 1e-6 ? CONTACT_SPRING_IN : CONTACT_SPRING_OUT;
      const [squash, squashVelocity] = criticallyDampedStep(
        motion.squash,
        motion.squashVelocity,
        targetSquash,
        squashOmega,
        dt,
      );
      motion.squash = clamp(squash, 0, CONTACT_SQUASH_MAX);
      motion.squashVelocity = squashVelocity;

      const bendOmega = targetBend.length() > motion.bend.length() + 1e-6 ? CONTACT_SPRING_IN : CONTACT_SPRING_OUT;
      stepSpringVector(motion.bend, motion.bendVelocity, targetBend, bendOmega, dt);
      clampVectorLength(motion.bend, CONTACT_DEFLECT_MAX);

      const pushOmega = targetPush.length() > motion.push.length() + 1e-6 ? CONTACT_SPRING_IN : CONTACT_SPRING_OUT;
      stepSpringVector(motion.push, motion.pushVelocity, targetPush, pushOmega, dt);
      clampVectorLength(motion.push, CONTACT_PUSH_MAX);

      // 位置分离：把重叠的花头推开；挤入偏硬、恢复偏软。
      const separationOmega =
        targetSeparation.length() > motion.separation.length() + 1e-6
          ? CONTACT_SPRING_IN
          : CONTACT_SPRING_OUT;
      stepSpringVector(motion.separation, motion.separationVelocity, targetSeparation, separationOmega, dt);
      clampVectorLength(motion.separation, CONTACT_SEPARATION_MAX);

      // 收拢方向只做轻平滑：换主导接触对时花头收拢方向不硬切。
      stepSpringVector(motion.axis, motion.axisVelocity, targetAxis, CONTACT_SPRING_OUT, dt);
      if (motion.axis.lengthSq() < 1e-8) motion.axis.set(0, 1, 0);
      else motion.axis.normalize();

      const bendLength = motion.bend.length();
      const settled =
        motion.squash < 1e-4 &&
        bendLength < 1e-4 &&
        motion.push.length() < 1e-4 &&
        motion.separation.length() < 1e-4 &&
        Math.abs(motion.squashVelocity) < 1e-3 &&
        motion.bendVelocity.length() < 1e-3 &&
        motion.pushVelocity.length() < 1e-3 &&
        motion.separationVelocity.length() < 1e-3;
      if (settled) {
        this.contacts.delete(stemId);
        this.contactMotion.delete(stemId);
        this.applyContactToView(view, null);
        continue;
      }
      const bendAxis: Vec3 =
        bendLength > 1e-6
          ? [motion.bend.x / bendLength, motion.bend.y / bendLength, motion.bend.z / bendLength]
          : [0, 0, -1];
      const next: ContactResult = {
        squash: motion.squash,
        axis: [motion.axis.x, motion.axis.y, motion.axis.z],
        deflect: bendLength,
        bendAxis,
        offset: [motion.push.x, motion.push.y, motion.push.z],
        separation: [motion.separation.x, motion.separation.y, motion.separation.z],
      };
      this.contactMotion.set(stemId, motion);
      this.contacts.set(stemId, next);
      this.applyContactToView(view, next);
    }
  }

  /** 把接触形变叠加到基础变换上：位置让步 + 枝条偏转 + 花头沿接触方向收拢。 */
  private applyContactToView(view: StemView, contact: ContactResult | null): void {
    if (!contact) {
      view.root.position.copy(view.basePosition);
      view.root.quaternion.copy(view.baseQuaternion);
      if (view.object) {
        view.object.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (mesh.isMesh && mesh.name === 'original-flower-head') {
            mesh.matrix.identity();
            mesh.matrixWorldNeedsUpdate = true;
          }
        });
      }
      return;
    }
    view.root.position
      .copy(view.basePosition)
      .add(new THREE.Vector3(...contact.offset))
      .add(new THREE.Vector3(...contact.separation));
    const quaternion = view.baseQuaternion.clone();
    if (contact.deflect > 1e-5) {
      const axis = new THREE.Vector3(...contact.bendAxis);
      if (axis.lengthSq() > 1e-8) {
        const bend = new THREE.Quaternion().setFromAxisAngle(axis.normalize(), contact.deflect);
        // 世界坐标下的附加旋转要左乘到基础姿态上。
        quaternion.premultiply(bend);
      }
    }
    view.root.quaternion.copy(quaternion);
    if (!view.object) return;
    const localAxis = new THREE.Vector3(...contact.axis)
      .applyQuaternion(view.root.quaternion.clone().invert())
      .normalize();
    const c = contact.squash;
    view.object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || mesh.name !== 'original-flower-head') return;
      // I − c nnᵀ：仅沿接触法线压缩，绕可见花头自己的中心，而不是绕握点缩放。
      // 后者会在竖向受压时让花头整块下移近 4cm，制造「碰不到」和断茎。
      const pivot = mesh.geometry.boundingBox?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3(0, view.loaded?.headHeight ?? 0, 0);
      const { x, y, z } = localAxis;
      const shift = c * localAxis.dot(pivot);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.set(
        1 - c*x*x, -c*x*y, -c*x*z, shift*x,
        -c*y*x, 1 - c*y*y, -c*y*z, shift*y,
        -c*z*x, -c*z*y, 1 - c*z*z, shift*z,
        0, 0, 0, 1,
      );
      mesh.matrixWorldNeedsUpdate = true;
    });
  }

  /**
   * 花头中心的世界坐标。
   *
   * V0.7.3 统一口径：
   * - 花头中心用 `loaded.headHeight`（按可见顶点实测的椭球中心，不是清单意图值）；
   * - 带接触时直接读 root 的当前变换，因此**偏转（bend）也包含在内**——
   *   旧实现只补平移，花头被压弯时选中环/相机对焦会落在错误位置；
   * - 不带接触时用基础姿态（求解器与建议位需要「未叠加形变」的位置，
   *   否则会把本帧的分离量当成下一帧的输入，形成自激抖动）。
   */
  private getHeadWorld(
    stem: StemInstance,
    headHeight?: number,
    withContact = true,
  ): THREE.Vector3 {
    const view = this.views.get(stem.id);
    const height = headHeight ?? view?.loaded?.headHeight ?? DEFAULT_HEAD_HEIGHT;
    const metrics = view?.loaded?.headMetrics;
    const local = new THREE.Vector3(metrics?.centerX ?? 0, height, metrics?.centerZ ?? 0).multiplyScalar(stem.scale);
    if (view) {
      const quaternion = withContact ? view.root.quaternion : view.baseQuaternion;
      const base = withContact ? view.root.position : view.basePosition;
      return local.applyQuaternion(quaternion).add(base);
    }
    const quaternion = poseToQuaternion(stem.pose);
    const offset = new THREE.Vector3(0, stem.pose.height, 0).applyQuaternion(quaternion);
    return local
      .applyQuaternion(quaternion)
      .add(new THREE.Vector3(stem.position[0] + offset.x, stem.position[1] + offset.y, stem.position[2] + offset.z));
  }

  /**
   * 按当前花束实际外廓把镜头拉开：13–20 枝时默认机位会把最上面的花顶出画面。
   * 只算一次目标距离/视点高度，过渡仍由 StageCamera 统一做 320ms 缓动。
   */
  private updateCameraFit(): void {
    const stems = this.store.getState().doc.stems;
    const stage = this.stage;
    if (stems.length === 0) {
      this.stageCamera.applyFit(1, null);
      return;
    }
    let top = TABLE_TOP_Y + 0.4;
    let outer = 0;
    for (const stem of stems) {
      const loaded = this.views.get(stem.id)?.loaded;
      const headHeight = loaded?.headHeight ?? DEFAULT_HEAD_HEIGHT;
      const headRadius = loaded?.headRadius ?? 0.085;
      const head = this.getHeadWorld(stem, headHeight);
      top = Math.max(top, head.y + headRadius * 0.5);
      outer = Math.max(outer, Math.hypot(head.x, head.z) + headRadius * stem.scale);
    }
    const basePose = STAGE_CAMERAS[stage];
    const baseTargetY = basePose.target.y;
    const targetY = Math.max(baseTargetY, Math.min((GRIP_Y + top) / 2, 1.34));
    const vHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const hHalf = vHalf * Math.max(0.2, this.camera.aspect);
    // 竖向要容下“最上面的花头 + 一点呼吸”，横向要容下花束与纸口外沿。
    const distanceV = (top + 0.14 - targetY) / Math.max(0.2, vHalf);
    const distanceH = (outer + 0.16) / Math.max(0.2, hHalf);
    const baseDistance = basePose.position.distanceTo(basePose.target);
    const scale = clamp(Math.max(distanceV, distanceH) / baseDistance, 1, 2.1);
    this.stageCamera.applyFit(scale, targetY);
  }

  private syncMarkers(): void {
    const state = this.store.getState();
    const finish = state.stage !== 'arrange';
    for(const [id,view] of this.views)if(view.object){
      setFocus(view.object,!this.capturing && !finish && state.selectedId && !state.placement && id!==state.selectedId ? .12 : 1);
      const trimming=!this.capturing&&!finish&&state.trimMode&&id===state.selectedId;
      const cut=view.object.getObjectByName('prepared-cut-line');if(cut)cut.visible=trimming&&!!state.doc.stems.find(stem=>stem.id===id&&stem.preparation.tailLength>.1001);
      view.object.traverse(object=>{const mesh=object as THREE.Mesh;if(!mesh.isMesh||!mesh.name.startsWith('prepared-leaf-'))return;for(const m of Array.isArray(mesh.material)?mesh.material:[mesh.material])if(m instanceof THREE.MeshStandardMaterial){m.emissive.set(trimming?'#b98d35':'#000000');m.emissiveIntensity=trimming?.45:0;}});
    }
    if (finish) {
      this.markerSelected.visible = false;
      this.markerHover.visible = false;
      this.markerGrip.visible = false;
      this.boundaryRing.visible = false;
      return;
    }
    const selected = state.doc.stems.find((stem) => stem.id === state.selectedId) ?? null;
    const hovered = state.doc.stems.find((stem) => stem.id === state.hoveredId) ?? null;

    if (selected) {
      const height = this.views.get(selected.id)?.loaded?.headHeight ?? DEFAULT_HEAD_HEIGHT;
      this.markerSelected.position.copy(this.getHeadWorld(selected, height));
      this.markerSelected.visible = false;
      this.markerGrip.position.set(selected.position[0], selected.position[1] + 0.002, selected.position[2]);
      this.markerGrip.visible = false;
    } else {
      this.markerSelected.visible = false;
      this.markerGrip.visible = false;
    }

    if (hovered && hovered.id !== selected?.id) {
      const height = this.views.get(hovered.id)?.loaded?.headHeight ?? DEFAULT_HEAD_HEIGHT;
      this.markerHover.position.copy(this.getHeadWorld(hovered, height));
      this.markerHover.visible = false;
    } else {
      this.markerHover.visible = false;
    }
  }

  // ---------- 放置预览与建议位 ----------

  private syncPlacement(): void {
    const state = this.store.getState();
    const assetId = state.placement?.assetId ?? null;
    if (assetId === this.placementAssetId) return;
    this.placementAssetId = assetId;
    this.snap.reset();
    this.ghostPose = null;
    this.ghostTargetPose = null;
    this.ghostSnapEasing = false;
    this.pointerInCanvas = false;
    this.suggestionsSignature = '';

    if (!assetId) {
      this.ghostKey = null;
      this.pendingTemplate = null;
      this.pendingTemplateKey = '';
      this.pendingLoaded = null;
      this.clearGhost();
      this.markerGhost.visible = false;
      this.boundaryRing.visible = false;
      this.canvas.style.cursor = 'default';
      this.setSuggestions([], true);
      this.renderSuggestions();
      return;
    }

    this.boundaryRing.visible = this.stage !== 'finish';
    this.canvas.style.cursor = 'crosshair';
    const catalog = state.catalog;
    const entry = catalog.entriesById[assetId];
    if (!entry) return;
    this.ghostHeadHeight = entry.transform?.headOffsetY ?? DEFAULT_HEAD_HEIGHT;
    this.pendingHeadRadius =
      DEFAULT_HEAD_RADIUS[entry.kind] ?? DEFAULT_HEAD_RADIUS.main ?? 0.095;
    const key = `${catalog.mode}:${catalog.assetsVersion}:${assetId}`;
    this.ghostKey = key;
    void this.assetLoader.load(entry, assetId, catalog).then((loaded) => {
      if (this.disposed || this.ghostKey !== key) return;
      if (this.store.getState().placement?.assetId !== assetId) return;
      this.ghostHeadHeight = loaded.headHeight;
      this.pendingHeadRadius = loaded.headRadius;
      this.pendingTemplate = loaded.template;
      this.pendingTemplateKey = key;
      this.pendingLoaded = loaded;
      this.replaceGhost(loaded);
      // 真实花头半径到达后候选位置会变，强制重算一次并写回 store。
      this.syncSuggestions(true);
      this.renderSuggestions();
    });
  }

  private replaceGhost(loaded: LoadedAsset): void {
    this.clearGhost();
    const root = loaded.template.clone(true);
    const materials: THREE.Material[] = [];
    const cloneMaterial = (source: THREE.Material): THREE.Material => {
      const cloned = source.clone();
      cloned.transparent = true;
      cloned.opacity = 0.4;
      cloned.depthWrite = false;
      cloned.side = THREE.DoubleSide;
      materials.push(cloned);
      return cloned;
    };
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const source = mesh.material as THREE.Material | THREE.Material[];
      mesh.material = Array.isArray(source) ? source.map(cloneMaterial) : cloneMaterial(source);
      mesh.renderOrder = 5;
    });
    this.ghostMaterials = materials;
    this.ghostRoot = root;
    this.scene.add(root);
    if (this.ghostPose) this.applyGhostPose();
  }

  private clearGhost(): void {
    if (this.ghostRoot) {
      this.scene.remove(this.ghostRoot);
      this.ghostRoot = null;
    }
    for (const material of this.ghostMaterials) material.dispose();
    this.ghostMaterials = [];
    this.markerGhost.visible = false;
  }

  private applyGhostPose(): void {
    if (!this.ghostRoot || !this.ghostPose) return;
    this.ghostRoot.position.set(0, GRIP_Y, 0);
    this.ghostRoot.quaternion.copy(poseToQuaternion(this.ghostPose));
    this.ghostRoot.scale.setScalar(1);
  }

  private getGhostHead(pose: StemPose): THREE.Vector3 {
    const quaternion = poseToQuaternion(pose);
    const local = new THREE.Vector3(0, pose.height + this.ghostHeadHeight, 0).applyQuaternion(quaternion);
    return new THREE.Vector3(0, GRIP_Y, 0).add(local);
  }

  private updateGhostTargetFromPointer(clientX: number, clientY: number): void {
    const preview = this.getPlacementPreview(clientX, clientY);
    if (!preview) return;
    this.ghostTargetPose = {
      height: preview.height,
      tilt: preview.tilt,
      direction: preview.direction,
      spin: this.ghostSpin,
    };
    this.ghostSnapEasing = false;
  }

  private getPlacementPreview(clientX: number, clientY: number): PlacementPreview | null {
    const state = this.store.getState();
    const assetId = state.placement?.assetId;
    if (!assetId) return null;
    const entry = state.catalog.entriesById[assetId];
    const headHeight = this.ghostHeadHeight || entry?.transform?.headOffsetY || DEFAULT_HEAD_HEIGHT;
    // 用一张正对镜头、穿过“竖直花头”的平面接收鼠标：
    // 这样不管相机转到哪个角度，点花束中心就是直立，往外拖就是外倾。
    const anchor = new THREE.Vector3(0, GRIP_Y + headHeight, 0);
    const plane = this.viewPlaneThrough(anchor);
    const hit = this.rayFromClient(clientX, clientY).intersectPlane(plane, new THREE.Vector3());
    if (!hit) return null;
    const distance = Math.hypot(hit.x, hit.z);
    const direction = normalizeAngle(radToDeg(Math.atan2(hit.x, hit.z)));
    const clamped = Math.min(distance, MAX_HEAD_RADIUS);
    // 新手默认层次：离中心越远越外倾。内圈接近直立，外圈明显向外打开，
    // 并把外圈略微抬高，避免两枝大花在同一高度互相遮住。
    const outerFactor = clamped / MAX_HEAD_RADIUS;
    const tilt = Math.min(MAX_TILT, 9 + Math.pow(outerFactor, 1.3) * 46);
    const height = Math.min(0.065, outerFactor * 0.045);
    return { tilt, direction, height, atLimit: distance > MAX_HEAD_RADIUS };
  }

  // ---------- 建议位：计算与呈现分离 ----------

  private syncAssist(): void {
    const state = this.store.getState();
    const key = `${state.assist?.snapping ?? true}|${state.assist?.suggestions ?? true}`;
    if (key === this.lastAssistKey) return;
    this.lastAssistKey = key;
    this.suggestionsSignature = '';
    if (!(state.assist?.suggestions ?? true)) {
      this.snap.reset();
      this.setSuggestions([], true);
      if (state.activeSuggestionId) this.store.setActiveSuggestion(null);
    }
    this.applySnapping();
  }

  /**
   * 只在「放置模式 / 花枝 / 辅助开关」变化时重算候选。
   * 指针事件里只比较屏幕距离，不重跑这个函数。
   */
  private syncSuggestions(force = false): void {
    const state = this.store.getState();
    const placementActive = Boolean(state.placement);
    const suggestionsOn = state.assist?.suggestions ?? true;
    const shouldShow =
      placementActive && suggestionsOn && state.doc.stems.length > 0 && this.stage !== 'finish';

    if (!shouldShow) {
      if (this.suggestions.length > 0) {
        this.setSuggestions([], true);
      }
      this.suggestionsSignature = '';
      this.renderSuggestions();
      return;
    }

    const signature = this.buildSuggestSignature();
    if (!force && signature === this.suggestionsSignature) {
      this.renderSuggestions();
      return;
    }
    this.suggestionsSignature = signature;
    const pending = this.collectPendingStem();
    const placed = this.collectPlacedHeads();
    if (!pending || placed.length === 0) {
      this.setSuggestions([], true);
      this.renderSuggestions();
      return;
    }
    const next = suggestPlacements({ placed, pending, limit: MAX_SUGGESTIONS });
    this.setSuggestions(next, true);
    this.reconcileSnapWithSuggestions();
    this.renderSuggestions();
  }

  private buildSuggestSignature(): string {
    const state = this.store.getState();
    const parts: string[] = [
      `p:${state.placement?.assetId ?? ''}`,
      `a:${this.lastAssistKey}`,
      `s:${this.stage}`,
    ];
    for (const stem of state.doc.stems) {
      const loaded = this.views.get(stem.id)?.loaded;
      const head = this.getHeadWorld(stem, loaded?.headHeight ?? DEFAULT_HEAD_HEIGHT);
      parts.push(
        `${stem.id}:${head.x.toFixed(3)},${head.y.toFixed(3)},${head.z.toFixed(3)}:${stem.scale.toFixed(2)}:${stem.assetId}`,
      );
    }
    return parts.join('|');
  }

  private collectPlacedHeads(): PlacedHead[] {
    const state = this.store.getState();
    const heads: PlacedHead[] = [];
    for (const stem of state.doc.stems) {
      const view = this.views.get(stem.id);
      const loaded = view?.loaded ?? null;
      const head = this.getHeadWorld(stem, loaded?.headHeight ?? DEFAULT_HEAD_HEIGHT, false);
      const entry = state.catalog.entriesById[stem.assetId];
      const fallback = DEFAULT_HEAD_RADIUS[entry?.kind ?? 'main'] ?? DEFAULT_HEAD_RADIUS.main ?? 0.095;
      if(loaded?.headParts?.length && view){
        // 多头花逐个检测：每个花头用自己的注册半径。
        // 位置用「基础姿态」算，不能读 matrixWorld——那里已经叠了本帧的接触让步，
        // 否则会自己推自己，形变会抖。
        for(const part of loaded.headParts){
          const point=new THREE.Vector3(...part.offset)
            .multiplyScalar(stem.scale)
            .applyQuaternion(view.baseQuaternion)
            .add(view.basePosition);
          heads.push({id:stem.id,kind:entry?.kind??'filler',head:[point.x,point.y,point.z],radius:part.radius*stem.scale});
        }
        continue;
      }
      heads.push({
        id: stem.id,
        kind: entry?.kind ?? 'main',
        head: [head.x, head.y, head.z],
        radius: (loaded?.headRadius ?? fallback) * stem.scale,
      });
    }
    return heads;
  }

  private collectPendingStem(): { assetId: string; kind: PlacedHead['kind']; lever: number; radius: number } | null {
    const state = this.store.getState();
    const assetId = state.placement?.assetId;
    if (!assetId) return null;
    const entry = state.catalog.entriesById[assetId];
    const loadedRadius = this.pendingHeadRadius;
    return {
      assetId,
      kind: entry?.kind ?? 'main',
      lever: this.ghostHeadHeight,
      radius: loadedRadius,
    };
  }

  // ---------- V0.7.3：花枝包络与有效落位 ----------

  /** 花材模板的局部包络：分离花头用实测椭球，多头花逐个头，其余用占用半径兜底。 */
  private localVolumes(loaded: LoadedAsset | null): EnvelopeVolume[] {
    if (!loaded) return [];
    if (loaded.headParts && loaded.headParts.length > 0) {
      return loaded.headParts.map((part) => partVolume(part.offset, part.radius));
    }
    if (loaded.headMetrics) return [headVolume(loaded.headMetrics)];
    if (loaded.headRadius > 0) {
      // 没有分离花头也没有顶部实测（尤加利这类 GLB 叶枝）：用占用半径当包络。
      return [
        {
          center: [0, loaded.headHeight, 0],
          radii: [loaded.headRadius, loaded.headRadius * 0.72, loaded.headRadius],
          coreScale: 0.72,
          part: 'foliage',
        },
      ];
    }
    return [];
  }

  private kindOf(assetId: string): AssetKind {
    return this.store.getState().catalog.entriesById[assetId]?.kind ?? 'main';
  }

  /** 已加载的同种花材模板：放置预览、复制、精调都需要它来算包络。 */
  private findLoadedAsset(assetId: string): LoadedAsset | null {
    if (this.pendingLoaded?.assetId === assetId) return this.pendingLoaded;
    for (const view of this.views.values()) {
      if (view.loaded?.assetId === assetId) return view.loaded;
    }
    return null;
  }

  /** 基础姿态下的握点位置（含 pose.height 造成的位移）。 */
  private basePositionOf(stem: StemInstance): Vec3 {
    const offset = new THREE.Vector3(0, stem.pose.height, 0).applyQuaternion(
      poseToQuaternion(stem.pose),
    );
    return [stem.position[0] + offset.x, stem.position[1] + offset.y, stem.position[2] + offset.z];
  }

  /** 把局部包络按某个姿态变换到世界坐标（`position` 是握点，height 造成的位移在这里补）。 */
  private volumesAtPose(
    local: EnvelopeVolume[],
    position: Vec3,
    pose: StemPose,
    scale: number,
  ): EnvelopeVolume[] {
    const quaternion = poseToQuaternion(pose);
    const offset = new THREE.Vector3(0, pose.height, 0).applyQuaternion(quaternion);
    const base: Vec3 = [position[0] + offset.x, position[1] + offset.y, position[2] + offset.z];
    const rotation = quatTuple(quaternion);
    return local.map((volume) => transformVolume(volume, base, rotation, scale));
  }

  /**
   * 场景里所有占位者（**基础姿态**）。
   * 不能读本帧接触形变：那是求解结果，拿来当输入会自己推自己、逐帧抖。
   */
  private collectOccupants(excludeStemId: string | null = null): EnvelopeOccupant[] {
    const state = this.store.getState();
    const occupants: EnvelopeOccupant[] = [];
    for (const stem of state.doc.stems) {
      if (excludeStemId !== null && stem.id === excludeStemId) continue;
      const view = this.views.get(stem.id);
      const local = this.localVolumes(view?.loaded ?? null);
      if (local.length === 0) continue;
      const position: Vec3 = view
        ? [view.basePosition.x, view.basePosition.y, view.basePosition.z]
        : this.basePositionOf(stem);
      const rotation = view
        ? quatTuple(view.baseQuaternion)
        : quatTuple(poseToQuaternion(stem.pose));
      occupants.push({
        stemId: stem.id,
        kind: this.kindOf(stem.assetId),
        volumes: local.map((volume) => transformVolume(volume, position, rotation, stem.scale)),
      });
    }
    return occupants;
  }

  /** 接触求解输入：每枝一组世界包络（同一枝的多个头由求解器当同一刚体处理）。 */
  private collectContactStems(): ContactStem[] {
    return this.collectOccupants(null).flatMap((occupant) =>
      occupant.stemId === null
        ? []
        : [{ stemId: occupant.stemId, kind: occupant.kind, volumes: occupant.volumes }],
    );
  }

  /**
   * 走一次统一落位求解：新增 / 拖动 / 复制 / 精调 / 缩放共用。
   * 花枝自己的包络不参与碰撞（ownStemId），旧作品已有重叠时允许「不变差」。
   */
  private resolvePlacementFor(input: {
    local: EnvelopeVolume[];
    kind: AssetKind;
    position: Vec3;
    pose: StemPose;
    scale: number;
    from: PlacementPose | null;
    to: PlacementPose;
    ownStemId: string | null;
    /** 拖动只有 tilt/direction 两个自由度：禁止滑动候选改动 height，避免握点漂移。 */
    lockHeight?: boolean;
  }): PlacementResult {
    const spin = input.pose.spin;
    return resolvePlacement({
      from: input.from,
      to: input.to,
      build: (pose) => this.volumesAtPose(input.local, input.position, { ...pose, spin }, input.scale),
      occupants: this.collectOccupants(input.ownStemId),
      kind: input.kind,
      ownStemId: input.ownStemId,
      lockHeight: input.lockHeight === true,
    });
  }

  /**
   * 有界兜底：目标位完全被堵死（新枝、或旋转只在原位打转）时，
   * 在 tilt × direction 上扫一圈，取离目标最近的合法位。只在一次操作里跑一次。
   */
  private scanFreePose(input: {
    local: EnvelopeVolume[];
    kind: AssetKind;
    position: Vec3;
    scale: number;
    spin: number;
    ownStemId: string | null;
    desired: PlacementPose;
  }): PlacementPose | null {
    const occupants = this.collectOccupants(input.ownStemId);
    let best: PlacementPose | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let tilt = 8; tilt <= MAX_TILT; tilt += 4) {
      for (let direction = 0; direction < 360; direction += 10) {
        const pose: PlacementPose = { tilt, direction, height: input.desired.height };
        const evaluation = evaluatePlacement(
          this.volumesAtPose(input.local, input.position, { ...pose, spin: input.spin }, input.scale),
          occupants,
          { kind: input.kind, ownStemId: input.ownStemId },
        );
        if (!evaluation.valid) continue;
        const delta = Math.abs(((direction - input.desired.direction + 540) % 360) - 180);
        const distance = Math.abs(tilt - input.desired.tilt) + delta;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = pose;
        }
      }
    }
    return best;
  }

  /**
   * store 的统一落位约束实现（新增 / 复制 / 精调 / 缩放）。
   * 场景还没加载到该花材时返回 null：store 保持原请求，不阻塞操作。
   */
  private constrainStemIntent = (input: PoseConstraintInput): PoseConstraintResult | null => {
    const current = input.stemId
      ? (this.store.getState().doc.stems.find((stem) => stem.id === input.stemId) ?? null)
      : null;
    const loaded = current
      ? (this.views.get(current.id)?.loaded ?? null)
      : this.findLoadedAsset(input.assetId);
    if (!loaded) return null;
    const local = this.localVolumes(loaded);
    if (local.length === 0) return null;
    const kind = this.kindOf(input.assetId);

    // 缩放：保持姿态，找「最大可放大」的比例；压到邻花就停在最近合法值。
    if (current && Math.abs(input.scale - current.scale) > 1e-6) {
      // 缩小一定允许：花头只会往握点收，不会把别枝顶穿；这也保证密集作品里
      // 至少能把花枝调小（放大才需要找空位）。
      if (input.scale < current.scale) {
        return { pose: current.pose, scale: clampScale(input.scale), clamped: false };
      }
      const occupants = this.collectOccupants(current.id);
      let scale = clampScale(input.scale);
      const floor = clampScale(current.scale);
      for (; scale > floor - 1e-6; scale -= 0.02) {
        const evaluation = evaluatePlacement(
          this.volumesAtPose(local, input.position, current.pose, scale),
          occupants,
          { kind, ownStemId: current.id },
        );
        if (evaluation.valid) {
          const next = clampScale(scale);
          return {
            pose: current.pose,
            scale: next,
            clamped: next < clampScale(input.scale) - 1e-6,
          };
        }
      }
      return { pose: current.pose, scale: current.scale, clamped: true };
    }

    const to = toPlacementPose(input.pose);
    const from = current ? toPlacementPose(current.pose) : null;
    const result = this.resolvePlacementFor({
      local,
      kind,
      position: input.position,
      pose: input.pose,
      scale: input.scale,
      from,
      to,
      ownStemId: current?.id ?? null,
    });
    let pose: PlacementPose = result.pose;
    let clamped = result.clamped;
    if (result.reason === 'no-space') {
      const fallback = this.scanFreePose({
        local,
        kind,
        position: input.position,
        scale: input.scale,
        spin: input.pose.spin,
        ownStemId: current?.id ?? null,
        desired: to,
      });
      if (fallback) {
        pose = fallback;
        clamped = true;
      } else if (from) {
        // 旧作品本来就有重叠：允许保持原姿态，不把它挪到更差的位置。
        pose = from;
        clamped = true;
      }
    }
    return {
      pose: clampPose({ ...input.pose, tilt: pose.tilt, direction: pose.direction, height: pose.height }),
      scale: input.scale,
      clamped,
    };
  };

  /** 候选写回 store（内容相同不重复发），并清理失效的 pin / active。 */
  private setSuggestions(next: SuggestionCandidate[], notifyStore: boolean): void {
    const changed =
      next.length !== this.suggestions.length ||
      next.some((candidate, index) => {
        const existing = this.suggestions[index];
        return (
          !existing ||
          existing.id !== candidate.id ||
          existing.reason !== candidate.reason ||
          existing.kind !== candidate.kind
        );
      });
    this.suggestions = next;
    // store 里可能被 setPlacement 清空过，而场景内部仍是同一批候选：
    // 这时必须重新写回，否则 UI 上没有建议卡（真实浏览器实测到的问题）。
    const storeList = this.store.getState().suggestions;
    const storeOutOfSync =
      storeList.length !== next.length ||
      storeList.some((candidate, index) => candidate.id !== next[index]?.id);
    if (!changed && !storeOutOfSync) return;
    if (notifyStore) this.store.setSuggestions(next);
    const state = this.store.getState();
    const activeId = state.activeSuggestionId;
    if (activeId && !next.some((candidate) => candidate.id === activeId)) {
      this.store.setActiveSuggestion(null);
    }
    const pinnedId = state.pinnedSuggestionId;
    if (pinnedId && !next.some((candidate) => candidate.id === pinnedId)) {
      this.store.pinSuggestion(null);
    }
  }

  private renderSuggestions(): void {
    const state = this.store.getState();
    const visible =
      this.suggestions.length > 0 && this.stage !== 'finish' && Boolean(state.placement);
    this.suggestionLayer.setVisible(visible);
    this.suggestionLayer.sync(this.suggestions, this.pendingTemplate, this.pendingTemplateKey);
    this.suggestionLayer.setActive(state.activeSuggestionId ?? null);
  }

  private reconcileSnapWithSuggestions(): void {
    const state = this.store.getState();
    const activeId = state.activeSuggestionId;
    if (activeId && !this.suggestions.some((candidate) => candidate.id === activeId)) {
      this.snap.reset();
      this.store.setActiveSuggestion(null);
    }
    this.applySnapping();
  }

  /** UI 点了建议卡 → 立即吸到该候选（不指针在不在画布都生效）。 */
  private syncPinnedSuggestion(): void {
    const state = this.store.getState();
    const pin = state.pinnedSuggestionId ?? null;
    if (pin === this.lastPinId) return;
    this.lastPinId = pin;
    this.applySnapping();
  }

  /**
   * 吸附判定：只用候选花头的屏幕投影 + 指针位置做距离比较（≤3 个点），
   * 不跑几何计算，所以连续拖动也不会卡。
   */
  private applySnapping(): void {
    const state = this.store.getState();
    if (!state.placement || this.stage === 'finish') {
      this.snap.reset();
      return;
    }
    const anchors: SnapAnchor[] = [];
    for (const candidate of this.suggestions) {
      const point = this.projectToScreen(
        new THREE.Vector3(candidate.head[0], candidate.head[1], candidate.head[2]),
      );
      if (point.visible) anchors.push({ id: candidate.id, x: point.x, y: point.y });
    }
    const result = this.snap.update({
      anchors,
      pointer: this.lastPointer,
      pointerActive: this.pointerInCanvas,
      pinnedId: state.pinnedSuggestionId,
      snapping: state.assist?.snapping ?? true,
    });

    if (result.pinCleared) this.store.pinSuggestion(null);
    if (result.activeId !== (state.activeSuggestionId ?? null)) {
      this.store.setActiveSuggestion(result.activeId);
    }
    this.suggestionLayer.setActive(result.activeId);
    this.updateSnapHint(performance.now(), true);

    const candidate = result.activeId
      ? (this.suggestions.find((item) => item.id === result.activeId) ?? null)
      : null;
    this.ghostSnapEasing = Boolean(candidate) && !this.isReduceMotion();
    if (candidate) {
      // 吸附/钉住时，ghost 直接以候选姿态为目标，~80ms 缓动过去。
      this.ghostTargetPose = {
        height: candidate.pose.height,
        tilt: candidate.pose.tilt,
        direction: candidate.pose.direction,
        spin: this.ghostSpin,
      };
    } else if (this.lastPointer && this.pointerInCanvas) {
      this.updateGhostTargetFromPointer(this.lastPointer.x, this.lastPointer.y);
    }
  }

  /** 落位使用当前吸附/钉住的候选姿态，否则用指针预览。 */
  private placeFromPointer(clientX: number, clientY: number): boolean {
    const state = this.store.getState();
    const activeId = state.activeSuggestionId ?? null;
    const candidate = activeId
      ? (this.suggestions.find((item) => item.id === activeId) ?? null)
      : null;
    const pose: StemPose | null = candidate
      ? {
          height: candidate.pose.height,
          tilt: candidate.pose.tilt,
          direction: candidate.pose.direction,
          spin: Math.random() * 360,
        }
      : (() => {
          const preview = this.getPlacementPreview(clientX, clientY);
          if (!preview) return null;
          return {
            height: preview.height,
            tilt: preview.tilt,
            direction: normalizeAngle(preview.direction + (Math.random() - 0.5) * 10),
            spin: Math.random() * 360,
          };
        })();
    if (!pose) return false;
    const placed = this.store.placeStem(pose);
    if (placed) {
      this.snap.reset();
      this.ghostPose = null;
      this.ghostTargetPose = null;
      this.ghostSnapEasing = false;
      this.suggestionLayer.setActive(null);
    }
    return placed;
  }

  // ---------- 指针交互 ----------

  /** 记录按下位置：从花材架拖进画布时，pointerdown 不会经过 canvas。 */
  private handleWindowPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.pressOrigin = {
      x: event.clientX,
      y: event.clientY,
      onCanvas: event.target === this.canvas,
    };
  };

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.disposed) return;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.pointerStart = { x: event.clientX, y: event.clientY };
    this.pointerInCanvas = true;
    const state = this.store.getState();
    if(state.stage!=='arrange'){this.pointerMode='orbit';return;}
    if(state.trimMode&&state.selectedId){
      event.stopPropagation();event.preventDefault();this.rayFromClient(event.clientX,event.clientY);
      const root=this.views.get(state.selectedId)?.object;
      if(root){const hit=this.raycaster.intersectObject(root,true).find(item=>item.object.visible && (item.object.name.startsWith('prepared-leaf-')||item.object.name==='prepared-cut-line'));
        if(hit)this.store.trimStem(state.selectedId,hit.object.name.startsWith('prepared-leaf-')?Number(hit.object.name.slice(-1)):undefined);
      }
      this.pointerMode=null;return;
    }

    if (state.placement) {
      this.pointerMode = 'placement';
      return;
    }

    const stemId = this.pickStem(event.clientX, event.clientY);
    if (!stemId) {
      this.pointerMode = 'orbit';
      return;
    }

    // 命中花枝：接管指针，避免相机跟着一起旋转。
    event.stopPropagation();
    event.preventDefault();
    this.pointerMode = null;
    this.controls.enabled = false;
    this.store.select(stemId);
    this.store.beginTransaction();

    const stem = this.store.getState().doc.stems.find((item) => item.id === stemId);
    if (!stem) {
      this.controls.enabled = true;
      return;
    }
    const headHeight = this.views.get(stemId)?.loaded?.headHeight ?? DEFAULT_HEAD_HEIGHT;
    const head = this.getHeadWorld(stem, headHeight);
    const plane = this.viewPlaneThrough(head);
    const hit = this.rayFromClient(event.clientX, event.clientY).intersectPlane(
      plane,
      new THREE.Vector3(),
    );
    const grabOffset = hit
      ? new THREE.Vector3(hit.x - head.x, 0, hit.z - head.z)
      : new THREE.Vector3();
    if (grabOffset.length() > 0.2) grabOffset.setLength(0.2);

    this.drag = {
      stemId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      planePoint: head,
      grabOffset,
      leverLength: headHeight + stem.pose.height,
      limitNoticeShown: false,
      lastPose: toPlacementPose(stem.pose),
    };
    this.canvas.style.cursor = 'grabbing';
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (this.disposed) return;
    if (this.drag) {
      this.updateDrag(event);
      return;
    }
    this.lastPointer = { x: event.clientX, y: event.clientY };
    const overCanvas = event.target === this.canvas;
    this.pointerInCanvas = overCanvas;

    // 手动拖动画面转镜头 → 进入自由视角，之后的阶段切换不再把镜头拉回预设。
    if (
      overCanvas &&
      event.buttons !== 0 &&
      this.pointerMode === 'orbit' &&
      this.pointerStart &&
      Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) >
        CLICK_SLOP_PX &&
      this.store.getState().viewPreset !== 'free'
    ) {
      this.stageCamera.markFree();
      this.store.setViewPreset('free');
      this.store.notifyViewDrag();
    }

    if (this.store.getState().placement) {
      if (overCanvas) this.applySnapping();
      else {
        this.snap.reset();
        this.ghostSnapEasing = false;
        this.suggestionLayer.setActive(null);
      }
      return;
    }

    if (!overCanvas || event.buttons !== 0) {
      if (!overCanvas && this.store.getState().hoveredId) this.store.setHovered(null);
      return;
    }
    const stemId = this.store.getState().stage==='arrange'?this.pickStem(event.clientX, event.clientY):null;
    this.store.setHovered(stemId);
    this.canvas.style.cursor = stemId ? 'grab' : 'default';
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (this.disposed) return;
    if (this.drag) {
      this.drag = null;
      this.store.endTransaction();
      this.controls.enabled = true;
      this.canvas.style.cursor = 'default';
      return;
    }

    const state = this.store.getState();
    const origin = this.pressOrigin;
    const mode = this.pointerMode;
    const start = this.pointerStart;
    this.pressOrigin = null;
    this.pointerMode = null;
    this.pointerStart = null;
    const onCanvas = event.target === this.canvas;

    if (state.placement) {
      if (!onCanvas) {
        // 松手在画布外：清 ghost，不落位；放置模式保留，可以再点一次。
        if (this.ghostRoot) this.ghostRoot.visible = false;
        return;
      }
      const moved = start
        ? Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP_PX
        : origin
          ? Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > CLICK_SLOP_PX
          : false;
      const fromShelf = origin ? !origin.onCanvas : false;
      // 点击取花→点击画布：原地松手也落位；从花材架拖进来：拖到画布上松手就落位。
      if (fromShelf || !moved) {
        this.placeFromPointer(event.clientX, event.clientY);
      }
      return;
    }

    if (!mode || !start) return;
    if (!onCanvas) return;
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP_PX;
    if (moved) return;
    if (mode === 'orbit') {
      // V0.7 §6：空白处点击先看有没有点到贺卡 / 包装纸 / 花器，再退回「取消选中」。
      // 摆花阶段不做这件事：那时纸片与贺卡本来就不该抢花枝的操作。
      if (this.tryOpenEditorAt(event.clientX, event.clientY)) return;
      this.store.select(null);
    }
  };

  /**
   * 点击 3D 装饰物直达编辑（V0.7 §6）。
   * 返回 true 表示这次点击已经被编辑入口消费，不再当作「点空白」。
   */
  private tryOpenEditorAt(clientX: number, clientY: number): boolean {
    const state = this.store.getState();
    if (state.stage === 'arrange' || state.albumOpen) return false;
    this.rayFromClient(clientX, clientY);

    if (this.card?.group.visible) {
      const hit = this.raycaster
        .intersectObject(this.card.group, true)
        .find((item) => isShown(item.object));
      if (hit) {
        this.store.requestEditor('card');
        return true;
      }
    }

    if (state.doc.presentation.kind === 'paper') {
      if (this.paper?.group.visible) {
        const hit = this.raycaster
          .intersectObject(this.paper.group, true)
          .find((item) => isShown(item.object));
        if (hit) {
          this.store.requestEditor('wrapping', { sheetId: this.pickSheetAt(hit.point) });
          return true;
        }
      }
    } else if (this.vessel?.visible) {
      const hit = this.raycaster
        .intersectObject(this.vessel, true)
        .find((item) => isShown(item.object));
      if (hit) {
        this.store.requestEditor('vessel');
        return true;
      }
    }
    return false;
  }

  /**
   * 点到纸片时按命中点的水平角度挑最近的一张，让 3D 点纸片与面板里的纸片选择联动。
   * 只有一张纸时直接返回它。
   */
  private pickSheetAt(point: THREE.Vector3): string | undefined {
    const sheets = this.store.getState().doc.presentation.sheets;
    if (sheets.length === 0) return undefined;
    if (sheets.length === 1) return sheets[0]?.id;
    const angle = radToDeg(Math.atan2(point.x, point.z));
    let best = sheets[0]!;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const sheet of sheets) {
      const delta = Math.abs(((angle - sheet.rotation + 540) % 360) - 180);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = sheet;
      }
    }
    return best.id;
  }

  private handlePointerCancel = (): void => {
    if (this.disposed) return;
    this.pressOrigin = null;
    this.pointerMode = null;
    this.pointerStart = null;
    if (this.drag) {
      this.drag = null;
      this.store.endTransaction();
      this.controls.enabled = true;
      this.canvas.style.cursor = 'default';
    }
    if (this.ghostRoot) this.ghostRoot.visible = false;
  };

  private handlePointerLeave = (): void => {
    this.pointerInCanvas = false;
    if (this.drag) return;
    this.store.setHovered(null);
    if (this.store.getState().placement) {
      this.snap.reset();
      this.suggestionLayer.setActive(null);
      this.ghostSnapEasing = false;
    }
  };

  private handleWindowBlur = (): void => {
    if (this.drag) {
      this.drag = null;
      this.store.endTransaction();
    }
    this.controls.enabled = true;
    this.pointerInCanvas = false;
    if (this.ghostRoot) this.ghostRoot.visible = false;
    if (this.store.getState().placement) {
      this.snap.reset();
      this.suggestionLayer.setActive(null);
      this.ghostSnapEasing = false;
    }
  };

  private updateDrag(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    if (!drag.moved) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < 3) return;
      drag.moved = true;
    }
    const stem = this.store.getState().doc.stems.find((item) => item.id === drag.stemId);
    if (!stem) return;

    const plane = this.viewPlaneThrough(drag.planePoint);
    const hit = this.rayFromClient(event.clientX, event.clientY).intersectPlane(
      plane,
      new THREE.Vector3(),
    );
    if (!hit) return;
    hit.sub(drag.grabOffset);

    const dx = hit.x - stem.position[0];
    const dz = hit.z - stem.position[2];
    let distance = Math.hypot(dx, dz);
    let limited = false;
    if (distance > MAX_HEAD_RADIUS) {
      distance = MAX_HEAD_RADIUS;
      limited = true;
    }
    distance = Math.max(distance, 0.02);
    const lever = Math.max(0.12, drag.leverLength * stem.scale);
    const direction = normalizeAngle(radToDeg(Math.atan2(dx, dz)));
    const tilt = Math.min(MAX_TILT, radToDeg(Math.asin(Math.min(1, distance / lever))));

    // V0.7.3：候选姿态交给统一落位求解器（扫掠 + 表面滑动 + 最近有效位）。
    // 挡住时停在「上一个有效姿态」，而不是把整枝花按进另一朵花里。
    const view = this.views.get(stem.id);
    const local = this.localVolumes(view?.loaded ?? null);
    if (local.length > 0) {
      const result = this.resolvePlacementFor({
        local,
        kind: this.kindOf(stem.assetId),
        position: [stem.position[0], stem.position[1], stem.position[2]],
        pose: stem.pose,
        scale: stem.scale,
        from: drag.lastPose,
        to: { tilt, direction, height: stem.pose.height },
        ownStemId: stem.id,
        // 拖动不改变高度：否则滑动候选的高度偏移会在每次 pointermove 累积成握点漂移。
        lockHeight: true,
      });
      drag.lastPose = result.pose;
      const changed =
        Math.abs(result.pose.tilt - stem.pose.tilt) > 1e-4 ||
        Math.abs(result.pose.direction - stem.pose.direction) > 1e-4 ||
        Math.abs(result.pose.height - stem.pose.height) > 1e-4;
      if (changed) {
        this.store.updateStemPoseTransient(stem.id, {
          tilt: result.pose.tilt,
          direction: result.pose.direction,
          height: result.pose.height,
        });
      }
      if (result.clamped && !drag.limitNoticeShown) {
        drag.limitNoticeShown = true;
        this.store.toast('顶住了，旁边的花让不开，停在最近能放下的位置', 'info');
      }
    } else {
      this.store.updateStemPoseTransient(stem.id, { tilt, direction });
    }
    if (limited && !drag.limitNoticeShown) {
      drag.limitNoticeShown = true;
      this.store.toast('已经到花束最外圈了，再往外就散架啦', 'info');
    }
  }

  // ---------- 射线 ----------

  private viewPlaneThrough(point: THREE.Vector3): THREE.Plane {
    const normal = new THREE.Vector3();
    this.camera.getWorldDirection(normal);
    return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point);
  }

  private rayFromClient(clientX: number, clientY: number): THREE.Ray {
    const rect = this.canvas.getBoundingClientRect();
    this.pointerNdc.set(
      ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    return this.raycaster.ray;
  }

  private pickStem(clientX: number, clientY: number): string | null {
    const roots = [...this.views.values()].map((view) => view.root);
    if (roots.length === 0) return null;
    this.rayFromClient(clientX, clientY);
    const hits = this.raycaster.intersectObjects(roots, true);
    for (const hit of hits) {
      let object: THREE.Object3D | null = hit.object;
      while (object) {
        const stemId = object.userData.stemId;
        if (typeof stemId === 'string') return stemId;
        object = object.parent;
      }
    }

    // 花瓣/花头之间有缝，射线可能从空隙穿过去；靠近花头时按屏幕距离兜底，
    // 免得“明明点到了花却选不中”。
    const state = this.store.getState();
    let bestId: string | null = null;
    let bestDistance = 30;
    for (const [stemId, view] of this.views) {
      const stem = state.doc.stems.find((item) => item.id === stemId);
      if (!stem) continue;
      const headHeight = view.loaded?.headHeight ?? DEFAULT_HEAD_HEIGHT;
      const screen = this.projectToScreen(this.getHeadWorld(stem, headHeight));
      if (!screen.visible) continue;
      const distance = Math.hypot(screen.x - clientX, screen.y - clientY);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestId = stemId;
      }
    }
    return bestId;
  }

  private projectToScreen(world: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const projected = world.clone().project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: rect.left + ((projected.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - projected.y) / 2) * rect.height,
      visible: projected.z >= -1 && projected.z <= 1,
    };
  }

  // ---------- 渲染循环与生命周期 ----------

  private isReduceMotion(): boolean {
    const motion: MotionPreference = this.store.getState().motion ?? 'auto';
    return this.systemReduceMotion || motion === 'reduced';
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.animate);
    const now = performance.now();
    const elapsed = (now - this.startedAt) / 1000;
    const dt = clamp((now - this.lastFrameTime) / 1000, 0.001, 0.05);
    this.lastFrameTime = now;

    this.stageCamera.update(now, dt);
    this.controls.enabled = this.drag === null && !this.stageCamera.isTransitioning;
    this.reportCameraDirection(now);
    this.updatePackageAnimation(now);
    this.updateGhostAnimation(dt);
    this.updateContacts(dt);
    this.updateSelectionAnchor(now);
    this.updateSnapHint(now);
    this.suggestionLayer.update(elapsed);

    if (this.markerSelected.visible) {
      const pulse = 1 + Math.sin(elapsed * 3.2) * 0.05;
      this.markerSelected.scale.setScalar(pulse);
      this.markerSelected.quaternion.copy(this.camera.quaternion);
    }
    if (this.markerHover.visible) {
      const pulse = 1 + Math.sin(elapsed * 4.6) * 0.06;
      this.markerHover.scale.setScalar(pulse);
      this.markerHover.quaternion.copy(this.camera.quaternion);
    }
    if (this.markerGhost.visible) {
      this.markerGhost.quaternion.copy(this.camera.quaternion);
    }

    this.renderer.render(this.scene, this.camera);

    this.frames += 1;
    const statsNow = performance.now();
    if (statsNow - this.statsTime >= 500) {
      this.stats = {
        fps: Math.round((this.frames * 1000) / (statsNow - this.statsTime)),
        calls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        stems: this.store.getState().doc.stems.length,
      };
      this.frames = 0;
      this.statsTime = statsNow;
    }
  };

  /** ghost 跟手或缓动到候选姿态；指针不在画布时隐藏。 */
  private updateGhostAnimation(dt: number): void {
    if (!this.ghostRoot || !this.ghostTargetPose || !this.store.getState().placement) {
      this.markerGhost.visible = false;
      if (this.ghostRoot) this.ghostRoot.visible = false;
      return;
    }
    const target = this.ghostTargetPose;
    if (!this.ghostPose) this.ghostPose = { ...target };
    if (this.ghostSnapEasing) {
      const k = 1 - Math.exp(-dt / 0.08);
      this.ghostPose = {
        height: THREE.MathUtils.lerp(this.ghostPose.height, target.height, k),
        tilt: THREE.MathUtils.lerp(this.ghostPose.tilt, target.tilt, k),
        direction: lerpAngleDeg(this.ghostPose.direction, target.direction, k),
        spin: target.spin,
      };
    } else {
      this.ghostPose = { ...target };
    }
    this.ghostRoot.visible = this.pointerInCanvas;
    this.applyGhostPose();
    const head = this.getGhostHead(this.ghostPose);
    this.markerGhost.position.copy(head);
    this.markerGhost.visible = this.pointerInCanvas;
  }

  /**
   * 选中锚点：相机/选中变化时报屏幕坐标给 UI，节流避免拖慢渲染。
   * 无选中或离开画面回报 null。
   */
  private updateSelectionAnchor(now: number): void {
    const state = this.store.getState();
    const selectedId = state.selectedId;
    const report = this.anchorReport;
    if (!selectedId || state.stage === 'finish') {
      if (report) {
        this.anchorReport = null;
        this.store.setSelectionAnchor(null);
      }
      return;
    }
    const point = this.getStemScreenPoint(selectedId);
    if (!point || !point.visible) {
      if (report) {
        this.anchorReport = null;
        this.store.setSelectionAnchor(null);
      }
      return;
    }
    if (report && report.stemId === selectedId) {
      const moved = Math.hypot(point.x - report.x, point.y - report.y);
      const elapsed = now - report.time;
      if (moved < 0.6) {
        report.time = now;
        return;
      }
      if (moved <= 2) {
        if (elapsed < 100) return;
      } else if (elapsed < 50) {
        return;
      }
    }
    this.anchorReport = { x: point.x, y: point.y, stemId: selectedId, time: now };
    const anchor: SelectionAnchor = { x: point.x, y: point.y, visible: true };
    this.store.setSelectionAnchor(anchor);
  }

  /**
   * 吸附提示锚点：指针进入建议位后，把「就是这里」的屏幕坐标节流回报给 UI，
   * 相机转动或窗口变化时跟着更新；脱离 / 取消 / 落位后清空。
   */
  private updateSnapHint(now: number, force = false): void {
    const state = this.store.getState();
    const activeId = state.activeSuggestionId ?? null;
    const candidate = activeId
      ? (this.suggestions.find((item) => item.id === activeId) ?? null)
      : null;
    const pinned = Boolean(candidate && state.pinnedSuggestionId === candidate.id);
    if (!candidate || !state.placement || state.stage === 'finish' || (!this.pointerInCanvas && !pinned)) {
      if (this.snapHintReported) {
        this.snapHintReported = false;
        this.store.setSnapHint(null);
      }
      return;
    }
    if (!force && now - this.lastSnapHintAt < 80) return;
    this.lastSnapHintAt = now;
    const point = this.projectToScreen(
      new THREE.Vector3(candidate.head[0], candidate.head[1], candidate.head[2]),
    );
    if (!point.visible) {
      if (this.snapHintReported) {
        this.snapHintReported = false;
        this.store.setSnapHint(null);
      }
      return;
    }
    this.snapHintReported = true;
    const hint: SnapHint = {
      suggestionId: candidate.id,
      x: point.x,
      y: point.y,
      reason: candidate.reason,
      kind: candidate.kind,
      pinned,
    };
    this.store.setSnapHint(hint);
  }

  /**
   * 实际机位回报（V6 P0-B）：点评只有在实际相机方向不变时才算「对应当前画面」。
   *
   * 拖动、预设视角、聚焦、切阶段、恢复照片方向都由相机状态自然覆盖：约 150ms 节流回报，
   * 机位变化小于约 0.0001° 时不再回报（阻尼余摆的尾巴不会让签名一直抖）。
   * 只写 store 的会话状态：不进 doc、不进撤销栈、不触发保存。
   */
  private reportCameraDirection(now: number, force = false): void {
    const direction = this.cameraDirectionScratch.copy(this.camera.position).sub(this.controls.target);
    if (direction.lengthSq() < 1e-8) return;
    direction.normalize();
    const exact = this.lastExactCameraDirection;
    if (exact) {
      const dot = exact[0] * direction.x + exact[1] * direction.y + exact[2] * direction.z;
      // 1 - cosθ < 5e-13 约等于 0.0001°，视为同一机位。
      if (1 - dot < 5e-13) return;
    }
    if (!force && now - this.lastCameraDirectionAt < 150) return;
    this.lastCameraDirectionAt = now;
    this.lastExactCameraDirection = [direction.x, direction.y, direction.z];
    // 取整到 2 位小数（约 0.6°）：肉眼无感的小幅抖动不会让点评失效。
    const rounded: [number, number, number] = [
      Math.round(direction.x * 100) / 100,
      Math.round(direction.y * 100) / 100,
      Math.round(direction.z * 100) / 100,
    ];
    const reported = this.reportedCameraDirection;
    this.reportedCameraDirection = rounded;
    if (reported && reported[0] === rounded[0] && reported[1] === rounded[1] && reported[2] === rounded[2]) {
      return;
    }
    this.store.setCameraDirection(rounded);
  }

  private handleResize = (): void => {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(width, height);
    this.updateCameraFit();
  };

  // ---------- 对外接口 ----------

  /** 平滑到该阶段预设机位；store.stage 变化时场景自己也会调。 */
  setStageCamera(stage: WorkflowStage): void {
    this.stageCamera.setStage(stage);
  }

  /** 预设视角：写 store，由 handleStoreChange 统一套用，UI 状态不会分叉。 */
  setViewPreset(preset: ViewPreset): void {
    this.store.setViewPreset(preset);
  }

  /** 选中花枝短距离推进。 */
  private scaleWheelTimer: ReturnType<typeof setTimeout> | undefined;
  private handleScaleWheel = (event: WheelEvent):void => {
    if(!event.ctrlKey&&!event.metaKey)return;
    const state=this.store.getState();
    if(state.stage!=='arrange'||state.albumOpen||!state.selectedId)return;
    const stem=state.doc.stems.find(s=>s.id===state.selectedId);if(!stem)return;
    event.preventDefault();event.stopImmediatePropagation();
    this.store.updateStemScaleTransient(stem.id,stem.scale-Math.sign(event.deltaY)*(event.shiftKey?.005:.02));
    clearTimeout(this.scaleWheelTimer);this.scaleWheelTimer=setTimeout(()=>this.store.endTransaction(),200);
  };

  /**
   * V0.7 §7：固定视角模式下，画布内普通滚轮按 正面 → 斜 45° → 侧面 → 俯视 循环。
   * - 挂在容器捕获阶段：比 OrbitControls 的 canvas 监听更早，能真正吃掉这次缩放；
   * - `Ctrl/⌘ + 滚轮` 直接放行给花枝缩放，优先级更高；
   * - 累计阈值 + 节流，触控板一次轻扫不会连跳好几档。
   */
  private wheelViewAccum = 0;
  private wheelViewLastAt = 0;
  private wheelViewLastCycleAt = 0;
  private handleViewWheel = (event: WheelEvent): void => {
    if (event.ctrlKey || event.metaKey) return;
    const state = this.store.getState();
    if (!state.viewLocked || state.albumOpen) return;
    // 允许面板/菜单里的滚动正常冒泡（它们不在 canvas 容器内，这里只是兜底判断）。
    if (event.target instanceof Node && !this.container.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (now - this.wheelViewLastAt > WHEEL_VIEW_RESET_MS) this.wheelViewAccum = 0;
    this.wheelViewLastAt = now;
    this.wheelViewAccum += event.deltaY;
    if (Math.abs(this.wheelViewAccum) < WHEEL_VIEW_STEP) return;
    if (now - this.wheelViewLastCycleAt < WHEEL_VIEW_COOLDOWN_MS) return;
    const step: 1 | -1 = this.wheelViewAccum > 0 ? 1 : -1;
    this.wheelViewAccum = 0;
    this.wheelViewLastCycleAt = now;
    this.store.cycleFixedView(step);
  };
  /**
   * V0.7 §4 / V0.7.2 验证入口：当前接触形变的只读快照（不参与渲染）。
   * squash 是花头收拢比例，deflect 是枝条偏转弧度，offset 是位置让步（米），
   * separation 是位置分离量（米，把重叠花头推开的部分）。
   */
  getContactState(): {
    stemId: string;
    squash: number;
    deflect: number;
    offset: Vec3;
    separation: Vec3;
  }[] {
    return [...this.contacts.entries()].map(([stemId, value]) => ({
      stemId,
      squash: Number(value.squash.toFixed(4)),
      deflect: Number(value.deflect.toFixed(4)),
      offset: value.offset.map((n) => Number(n.toFixed(4))) as Vec3,
      separation: value.separation.map((n) => Number(n.toFixed(4))) as Vec3,
    }));
  }

  /**
   * V0.7 §6 验证入口：装饰物（贺卡 / 包装纸 / 花器）在屏幕上的可点位置。
   * 只在验证与调试时使用，不参与正常渲染逻辑。
   */
  getDecorScreenPoint(kind: 'card' | 'paper' | 'vessel'): { x: number; y: number } | null {
    const group =
      kind === 'card' ? this.card?.group ?? null : kind === 'paper' ? this.paper?.group ?? null : this.vessel ?? null;
    if (!group || !isShown(group)) return null;
    group.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) return null;
    const center = box.getCenter(new THREE.Vector3()).project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: rect.x + ((center.x + 1) / 2) * rect.width,
      y: rect.y + ((1 - center.y) / 2) * rect.height,
    };
  }

  focusSelected(): void {    const state = this.store.getState();
    const selected = state.doc.stems.find((stem) => stem.id === state.selectedId) ?? null;
    if (!selected) {
      this.stageCamera.focusOn(null);
      return;
    }
    const headHeight = this.views.get(selected.id)?.loaded?.headHeight ?? DEFAULT_HEAD_HEIGHT;
    this.stageCamera.focusOn(this.getHeadWorld(selected, headHeight));
  }

  resetView(): void {
    this.stageCamera.resetHome();
    this.store.setViewPreset('quarter');
  }

  startShowcase(): void {
    this.stageCamera.startShowcase();
  }

  stopShowcase(): void {
    this.stageCamera.stopShowcase();
  }

  /** 花材加载失败后重试：清空模板缓存，再按当前清单重新请求。 */
  refreshAssets(): void {
    for (const view of this.views.values()) {
      if (view.object) {
        view.root.remove(view.object);
        view.object = null;
      }
      view.loaded = null;
      view.loadKey = '';
    }
    this.clearGhost();
    this.pendingTemplate = null;
    this.pendingTemplateKey = '';
    this.assetLoader.clearCache();
    this.handleStoreChange();
  }

  /**
   * 导出当前照片设置的 PNG：隐藏编辑提示，按当前包装步骤终态拍摄后恢复工作台。
   */
  async exportPng(requestedSize = EXPORT_PNG_SIZE): Promise<{blob:Blob;width:number;height:number}> {
    const canvas=this.renderPhoto(Math.max(1600,Math.round(requestedSize)));
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(result=>result?resolve(result):reject(new Error('照片生成失败')),'image/png'));
    return {blob,width:canvas.width,height:canvas.height};
  }
  async captureThumbnail(requestedSize=ALBUM_THUMBNAIL_SIZE):Promise<string> {
    return this.renderPhoto(Math.max(240,Math.round(requestedSize))).toDataURL('image/jpeg',.88);
  }
  rememberPhotoView():void {
    // 先把实际机位同步给 store，再写进文档：保存/点评用同一个相机状态判定签名，
    // 避免「刚转过镜头就保存」时点评被贴到另一个机位的照片上。
    this.reportCameraDirection(performance.now(), true);
    const direction=this.camera.position.clone().sub(this.controls.target).normalize().toArray() as [number,number,number];
    this.store.updatePhoto({direction});this.store.endTransaction();
  }
  private syncPhotoSet():void {
    // 拍照阶段才换布景；工作台阶段始终是素色台面。
    const state=this.store.getState(),finished=this.capturing||state.stage==='finish';
    const sceneId=finished?state.doc.photo.scene:'studio';
    if(this.windowSet)this.windowSet.visible=sceneId==='window';
    if(this.floristSet)this.floristSet.visible=sceneId==='florist';
    if(this.gardenSet)this.gardenSet.visible=sceneId==='garden';
    if(this.festiveSet)this.festiveSet.visible=sceneId==='festive';
    if(this.livingSet)this.livingSet.visible=sceneId==='living';
    if(this.cafeSet)this.cafeSet.visible=sceneId==='cafe';
    // 近景道具按需加载：布景第一次真正显示时才下载对应 GLB，避免首屏把 4 件道具全拉下来。
    for(const set of [this.floristSet,this.gardenSet,this.festiveSet,this.livingSet,this.cafeSet]){
      if(set?.visible)activateSceneProps(set);
    }
    const gallery=sceneId==='gallery';if(this.gallerySet)this.gallerySet.visible=gallery;
    this.tableGroup.visible=sceneId==='studio';
    // 背景色跟布景走：展台深绿、花店暖米、庭院淡天空、节日暖深棕、家居暖米白、咖啡馆浅米。
    const backgrounds:Record<string,string>={gallery:'#30443d',florist:'#ece0cf',garden:'#e7eee8',festive:'#3b2a26',living:'#e9dfd0',cafe:'#ece4d8'};
    const background=backgrounds[sceneId];
    this.scene.background=background?new THREE.Color(background):this.backgroundTexture;
    for(const stem of state.doc.stems){const view=this.views.get(stem.id);if(view?.object){applyPreparation(view.object,stem.preparation);view.root.updateMatrixWorld(true);applyFinishTrim(view.object,finished&&state.doc.photo.autoTrim&&state.doc.wrapping.enabled,state.doc.presentation.kind,view.loaded?.headHeight??.35);}}

  }
  private renderPhoto(size:number):HTMLCanvasElement {
    const photo=this.store.getState().doc.photo;
    const height=photo.format==='portrait'?Math.round(size*1.25):size;
    const previous={size:this.renderer.getSize(new THREE.Vector2()),ratio:this.renderer.getPixelRatio(),aspect:this.camera.aspect,position:this.camera.position.clone(),target:this.controls.target.clone(),enabled:this.controls.enabled,boundary:this.boundaryRing.visible};
    const pieces={fold:this.pieceFold,ribbon:this.pieceRibbon,card:this.pieceCard};
    try {
      if(this.packageAnim){this.pieceFold=this.packageAnim.to.fold;this.pieceRibbon=this.packageAnim.to.ribbon;this.pieceCard=this.packageAnim.to.card;this.applyPackagePieces();}
      this.capturing=true;this.syncPhotoSet();this.syncMarkers();
      for(const view of this.views.values())if(view.object)setFocus(view.object,1);
      for(const marker of [this.markerSelected,this.markerHover,this.markerGrip,this.markerGhost,this.boundaryRing])marker.visible=false;
      this.suggestionLayer.setVisible(false);if(this.ghostRoot)this.ghostRoot.visible=false;
      this.controls.enabled=false;this.camera.aspect=size/height;this.camera.updateProjectionMatrix();
      this.frameExportCamera();this.renderer.setPixelRatio(1);this.renderer.setSize(size,height,false);
      this.markShadowsDirty();this.renderer.render(this.scene,this.camera);
      return framePhoto(this.canvas,photo);
    } finally {
      this.pieceFold=pieces.fold;this.pieceRibbon=pieces.ribbon;this.pieceCard=pieces.card;this.applyPackagePieces();
      this.capturing=false;this.syncPhotoSet();this.renderer.setPixelRatio(previous.ratio);this.renderer.setSize(previous.size.x,previous.size.y);
      this.camera.aspect=previous.aspect;this.camera.position.copy(previous.position);this.controls.target.copy(previous.target);this.camera.updateProjectionMatrix();this.controls.enabled=previous.enabled;this.controls.update();
      this.boundaryRing.visible=previous.boundary;if(this.ghostRoot)this.ghostRoot.visible=this.pointerInCanvas;
      this.syncMarkers();this.renderSuggestions();this.markShadowsDirty();this.renderer.render(this.scene,this.camera);
    }
  }

  /**
   * 按「花束 + 包装 + 丝带 + 卡片 + 台面圆盘」的世界包围盒自动取景。
   * 目标：水平居中，四边约 10% 留白；台面完整入画，细长石座不进画面。
   */
  private frameExportCamera(): void {
    this.scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3();
    for (const view of this.views.values()) {
      if (view.root.visible) bounds.expandByObject(view.root);
    }
    if(this.vessel?.visible)bounds.expandByObject(this.vessel);
    if (this.paper?.group.visible) bounds.expandByObject(this.paper.group);
    if (this.ribbon?.group.visible) bounds.expandByObject(this.ribbon.group);
    if (this.card?.group.visible) bounds.expandByObject(this.card.group);

    if (bounds.isEmpty()) bounds.setFromObject(this.tableGroup);

    const target = bounds.getCenter(new THREE.Vector3());
    const direction = new THREE.Vector3()
      .subVectors(this.camera.position, this.controls.target)
      .normalize();
    const corners: THREE.Vector3[] = [];
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          corners.push(new THREE.Vector3(x, y, z));
        }
      }
    }

    // 二分查找相机距离，使包围盒八个角都落在 NDC ±0.84 内（约 8% 留白）。
    let low = 0.5;
    let high = 10;
    const limit = 0.84;
    for (let step = 0; step < 30; step += 1) {
      const distance = (low + high) / 2;
      this.camera.position.copy(target).addScaledVector(direction, distance);
      this.camera.lookAt(target);
      this.camera.updateMatrixWorld(true);
      let maxAbs = 0;
      for (const corner of corners) {
        const projected = corner.clone().project(this.camera);
        maxAbs = Math.max(maxAbs, Math.abs(projected.x), Math.abs(projected.y));
      }
      if (maxAbs > limit) low = distance;
      else high = distance;
    }
    const photo=this.store.getState().doc.photo;
    this.camera.position.copy(target).addScaledVector(direction,high/photo.zoom);
    const right=new THREE.Vector3().crossVectors(direction,new THREE.Vector3(0,1,0)).normalize();
    target.addScaledVector(right,photo.offsetX).add(new THREE.Vector3(0,photo.offsetY,0));
    this.camera.position.addScaledVector(right,photo.offsetX).add(new THREE.Vector3(0,photo.offsetY,0));
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld(true);
    this.lastExportDebug = {
      bounds: [bounds.min.toArray(), bounds.max.toArray()],
      target: target.toArray(),
      camera: this.camera.position.toArray(),
      distance: high,
      ndc: corners.map((corner) => {
        const projected = corner.clone().project(this.camera);
        return [+projected.x.toFixed(2), +projected.y.toFixed(2)];
      }),
    };
  }

  /** 自动化验证用：读取包装/丝带/卡片的当前渲染状态。 */
  getDecorState(): {
    wrapping: {
      enabled: boolean;
      paperId: PaperId;
      step: PackageStep;
      openScale: number;
      radius: number;
      visible: boolean;
      fold: number;
    };
    ribbon: { visible: boolean; colorId: RibbonColorId; appear: number };
    card: { visible: boolean; to: string; message: string; from: string; appear: number };
    /** V16 §5：装饰层的真实渲染状态（能力表过滤掉的会出现在 skipped）。 */
    ornaments: ReturnType<typeof getOrnamentDebug>;
    /** V16 §5：当前形态是否显示可编辑丝带。 */
    ribbonSupported: boolean;
    animating: boolean;
    reduceMotion: boolean;
  } {
    const doc = this.store.getState().doc;
    return {
      wrapping: {
        enabled: doc.wrapping.enabled,
        paperId: doc.wrapping.paperId,
        step: doc.wrapping.step ?? 'paper',
        openScale: doc.wrapping.openScale ?? 1,
        radius: this.paperRadius,
        visible: this.paper?.group.visible ?? false,
        fold: this.pieceFold,
      },
      ribbon: {
        visible: this.ribbon?.group.visible ?? false,
        colorId: doc.ribbon.colorId,
        appear: this.pieceRibbon,
      },
      card: {
        visible: this.card?.group.visible ?? false,
        to: doc.card.to,
        message: doc.card.message,
        from: doc.card.from,
        appear: this.pieceCard,
      },
      ornaments: this.ornaments
        ? getOrnamentDebug(this.ornaments)
        : { count: 0, visible: false, kinds: [], skipped: [], items: [] },
      ribbonSupported: supportsRibbon(doc.presentation.kind),
      animating: this.packageAnim !== null,
      reduceMotion: this.isReduceMotion(),
    };
  }

  /** 自动化验证用：建议位、吸附、锚点、阶段、包装动画的当前值。 */
  getSceneState(): Record<string, unknown> {
    const state = this.store.getState();
    return {
      stage: this.stage,
      sizeCandidate: state.sizeCandidate,
      assetsVersion: state.catalog.assetsVersion,
      showcase: this.stageCamera.isShowcase,
      transitioning: this.stageCamera.isTransitioning,
      reduceMotion: this.isReduceMotion(),
      camera: {
        position: this.camera.position.toArray().map((value) => +value.toFixed(3)),
        target: this.controls.target.toArray().map((value) => +value.toFixed(3)),
      },
      placement: {
        assetId: this.placementAssetId,
        ghostVisible: this.ghostRoot?.visible ?? false,
        ghostPose: this.ghostPose,
        ghostHead: this.ghostPose ? this.getGhostHead(this.ghostPose).toArray() : null,
        pointerInCanvas: this.pointerInCanvas,
      },
      suggestions: this.suggestions.map((candidate) => ({
        id: candidate.id,
        kind: candidate.kind,
        reason: candidate.reason,
        head: candidate.head,
        pose: candidate.pose,
        screen: this.projectToScreen(
          new THREE.Vector3(candidate.head[0], candidate.head[1], candidate.head[2]),
        ),
      })),
      activeSuggestionId: state.activeSuggestionId ?? null,
      pinnedSuggestionId: state.pinnedSuggestionId ?? null,
      snapActiveId: this.snap.getActiveId(),
      viewPreset: state.viewPreset ?? this.stageCamera.getPreset(),
      snapHint: state.snapHint
        ? {
            suggestionId: state.snapHint.suggestionId,
            x: +state.snapHint.x.toFixed(1),
            y: +state.snapHint.y.toFixed(1),
            pinned: state.snapHint.pinned,
          }
        : null,
      selectionAnchor: this.anchorReport
        ? { x: +this.anchorReport.x.toFixed(1), y: +this.anchorReport.y.toFixed(1), stemId: this.anchorReport.stemId }
        : null,
      package: {
        step: this.packageStep,
        fold: +this.pieceFold.toFixed(3),
        ribbon: +this.pieceRibbon.toFixed(3),
        card: +this.pieceCard.toFixed(3),
        openScale: +this.packageOpenScale.toFixed(3),
        animating: this.packageAnim !== null,
        paperRadius: +this.paperRadius.toFixed(3),
      },
      stats: this.stats,
    };
  }

  getStats(): SceneStats {
    return this.stats;
  }

  /**
   * V16 §3 验证入口：每枝的整理视觉状态（翻瓣是否真的形变、去刺刺是否隐藏、
   * 下部茎裁剪结果）+ 当前容器的花泥状态。只读，不触发任何修改。
   */
  getOrganizeState(): Record<string, unknown> {
    const state = this.store.getState();
    return {
      presentation: state.doc.presentation.kind,
      foam: getFoamDebug(),
      stems: state.doc.stems.map((stem) => {
        const view = this.views.get(stem.id);
        return {
          stemId: stem.id,
          assetId: stem.assetId,
          family: state.catalog.entriesById[stem.assetId]?.family ?? '',
          preparation: { ...stem.preparation },
          visual: view?.object ? getOrganizeVisualDebug(view.object) : null,
        };
      }),
    };
  }

  /** V16 §3：花泥调试信息（验证脚本用）。 */
  getFoamDebug(): ReturnType<typeof getFoamDebug> {
    return getFoamDebug();
  }

  /**
   * V0.7.3 验证入口：每枝基础姿态的世界包络 + 整束最坏重叠（与求解器同口径）。
   *
   * 注意：这里报的是**椭球包络重叠**（core = 核心椭球、rim = 完整椭球），
   * 不等于花瓣网格的穿透深度；真实渲染仍可能看到花瓣边缘交错。
   * contact 字段是当前弹簧叠加的形变量，只用于观察是否还有残余挤压。
   */
  getEnvelopeState(): {
    sizeCandidate: string;
    assetsVersion: string;
    stems: {
      stemId: string;
      assetId: string;
      kind: AssetKind;
      headHeight: number;
      headRadius: number;
      scale: number;
      pose: StemPose;
      position: Vec3;
      basePosition: Vec3;
      volumes: EnvelopeVolume[];
      contact: { squash: number; deflect: number; offset: Vec3; separation: Vec3 } | null;
    }[];
    worst: { core: number; rim: number; valid: boolean; overlappingPairs: number; checkedPairs: number };
  } {
    const state = this.store.getState();
    const occupants = this.collectOccupants(null);
    const stems = state.doc.stems.flatMap((stem) => {
      const view = this.views.get(stem.id);
      const occupant = occupants.find((item) => item.stemId === stem.id);
      if (!occupant) return [];
      const contact = this.contacts.get(stem.id) ?? null;
      return [
        {
          stemId: stem.id,
          assetId: stem.assetId,
          kind: occupant.kind,
          headHeight: view?.loaded?.headHeight ?? DEFAULT_HEAD_HEIGHT,
          headRadius: view?.loaded?.headRadius ?? 0.095,
          scale: stem.scale,
          pose: stem.pose,
          position: stem.position,
          basePosition: view
            ? ([view.basePosition.x, view.basePosition.y, view.basePosition.z] as Vec3)
            : this.basePositionOf(stem),
          volumes: occupant.volumes.map((volume) => ({
            ...volume,
            center: volume.center.map((value) => +value.toFixed(4)) as Vec3,
            radii: volume.radii.map((value) => +value.toFixed(4)) as Vec3,
          })),
          contact: contact
            ? {
                squash: +contact.squash.toFixed(4),
                deflect: +contact.deflect.toFixed(4),
                offset: contact.offset,
                separation: contact.separation,
              }
            : null,
        },
      ];
    });

    let core = 0;
    let rim = 0;
    let valid = true;
    let overlappingPairs = 0;
    let checkedPairs = 0;
    for (let i = 0; i < occupants.length; i += 1) {
      for (let j = i + 1; j < occupants.length; j += 1) {
        const a = occupants[i]!;
        const b = occupants[j]!;
        const limits = stricterLimits(limitsFor(a.kind), limitsFor(b.kind));
        checkedPairs += 1;
        let pairOverlap = false;
        for (const volumeA of a.volumes) {
          for (const volumeB of b.volumes) {
            const overlap = overlapBetween(volumeA, volumeB);
            if (overlap.core > 1e-6 || overlap.rim > 1e-6) pairOverlap = true;
            core = Math.max(core, overlap.core);
            rim = Math.max(rim, overlap.rim);
            if (!allowed(overlap, limits)) valid = false;
          }
        }
        if (pairOverlap) overlappingPairs += 1;
      }
    }

    return {
      sizeCandidate: state.sizeCandidate,
      assetsVersion: state.catalog.assetsVersion,
      stems,
      worst: {
        core: +core.toFixed(4),
        rim: +rim.toFixed(4),
        valid,
        overlappingPairs,
        checkedPairs,
      },
    };
  }

  getStemScreenPoint(stemId: string): { x: number; y: number; visible: boolean } | null {
    const stem = this.store.getState().doc.stems.find((item) => item.id === stemId);
    if (!stem) return null;
    const headHeight = this.views.get(stemId)?.loaded?.headHeight ?? DEFAULT_HEAD_HEIGHT;
    return this.projectToScreen(this.getHeadWorld(stem, headHeight));
  }

  /** 建议位花头的屏幕坐标（CSS 像素，含 canvas 偏移），供 UI 把建议卡贴到花头附近。 */
  getSuggestionScreenPoints(): Array<{ id: string; x: number; y: number; visible: boolean }> {
    return this.suggestions.map((candidate) => {
      const point = this.projectToScreen(
        new THREE.Vector3(candidate.head[0], candidate.head[1], candidate.head[2]),
      );
      return { id: candidate.id, x: point.x, y: point.y, visible: point.visible };
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unsubscribe();
    this.resizeObserver.disconnect();
    this.container.removeEventListener('pointerdown', this.handlePointerDown, { capture: true });
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.removeEventListener('wheel', this.handleScaleWheel, true);clearTimeout(this.scaleWheelTimer);this.store.endTransaction();
    this.container.removeEventListener('wheel', this.handleViewWheel, { capture: true } as EventListenerOptions);
    window.removeEventListener('pointerdown', this.handleWindowPointerDown, { capture: true });
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('pointercancel', this.handlePointerCancel);
    window.removeEventListener('blur', this.handleWindowBlur);
    this.controls.dispose();
    this.store.setPoseConstraint(null);

    for (const view of this.views.values()) {if(view.object){disposeOrganizeVisual(view.object);disposeInstanceMaterials(view.object);}this.scene.remove(view.root); }
    this.views.clear();
    this.clearGhost();
    this.suggestionLayer.dispose();
    this.assetLoader.dispose();

    if (this.paper) disposePaper(this.paper);
    this.releaseVesselModel();
    if (this.vessel) { disposeFoam(this.vessel); disposeVessel(this.vessel); }
    disposeVesselModels();
    if (this.windowSet) disposeVessel(this.windowSet);
    if (this.gallerySet) disposeVessel(this.gallerySet);
    for (const set of [this.floristSet, this.gardenSet, this.festiveSet, this.livingSet, this.cafeSet]) {
      if (!set) continue;
      // 先阻止异步到达的近景道具再挂进来，再释放布景几何/材质。
      detachSceneProps(set);
      disposeVessel(set);
    }
    disposeSceneProps();

    if (this.ribbon) disposeRibbon(this.ribbon);
    if (this.card) disposeCard(this.card);
    if (this.ornaments) {
      disposeOrnaments(this.ornaments);
      this.scene.remove(this.ornaments);
      this.ornaments = null;
    }
    this.environmentTexture?.dispose();

    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = (mesh as THREE.Mesh).material as
        | THREE.Material
        | THREE.Material[]
        | undefined;
      if (Array.isArray(material)) {
        for (const item of material) item.dispose();
      } else if (material) {
        material.dispose();
      }
    });
    this.backgroundTexture.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

// ---------- 贴图工具 ----------

function createBackgroundTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 512;
  const context = canvas.getContext('2d');
  if (!context) {
    return new THREE.CanvasTexture(canvas);
  }
  // 暖纸色背景：上浅下深，像一面被侧光照过的纸墙；顶部留白，底部压暗收边。
  const gradient = context.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, '#fdf7ed');
  gradient.addColorStop(0.42, '#f7ebdc');
  gradient.addColorStop(0.74, '#efdcc7');
  gradient.addColorStop(1, '#e2c8ad');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 512);

  // 左上角一抹暖光，避免背景太平。
  const glow = context.createRadialGradient(0, 20, 4, 0, 20, 420);
  glow.addColorStop(0, 'rgba(255, 249, 238, 0.9)');
  glow.addColorStop(1, 'rgba(255, 246, 231, 0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, 64, 512);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** 无限背景的柔光地面：中心暖、往外淡到背景色，避免看到生硬的地平线。 */
function createStudioFloorTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#e9d6c0';
    context.fillRect(0, 0, size, size);
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      size * 0.04,
      size / 2,
      size / 2,
      size * 0.52,
    );
    gradient.addColorStop(0, '#fdf3e5');
    gradient.addColorStop(0.42, '#f4e5d2');
    gradient.addColorStop(0.78, '#ead7c1');
    gradient.addColorStop(1, '#e2ccb4');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    // 极轻的颗粒，让地面不是一块纯色塑料。
    context.globalAlpha = 0.05;
    for (let i = 0; i < 2400; i += 1) {
      const shade = Math.random() > 0.5 ? 120 : 255;
      context.fillStyle = `rgb(${shade}, ${shade - 8}, ${shade - 20})`;
      context.fillRect(Math.random() * size, Math.random() * size, 1.5, 1.5);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** 低饱和木纹：横向的柔和年轮线，避免台面变成一块塑料板。 */
function createWoodTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#e2c8a9';
    context.fillRect(0, 0, size, size);
    for (let i = 0; i < 26; i += 1) {
      const y = (i / 26) * size + Math.sin(i * 1.7) * 3;
      context.strokeStyle = i % 3 === 0 ? 'rgba(150, 112, 76, 0.2)' : 'rgba(172, 136, 100, 0.12)';
      context.lineWidth = i % 3 === 0 ? 1.6 : 0.9;
      context.beginPath();
      for (let x = 0; x <= size; x += 8) {
        const wave = Math.sin(x * 0.03 + i * 0.9) * 2.2 + Math.sin(x * 0.011 + i) * 1.6;
        if (x === 0) context.moveTo(x, y + wave);
        else context.lineTo(x, y + wave);
      }
      context.stroke();
    }
    // 两个淡淡的木节。
    for (const [cx, cy] of [
      [size * 0.28, size * 0.62],
      [size * 0.74, size * 0.3],
    ] as const) {
      context.strokeStyle = 'rgba(146, 108, 72, 0.16)';
      context.lineWidth = 1.2;
      for (let ring = 0; ring < 3; ring += 1) {
        context.beginPath();
        context.ellipse(cx, cy, 8 + ring * 5, 3 + ring * 2.2, 0.4, 0, Math.PI * 2);
        context.stroke();
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1.4, 1.4);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createFeltTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    // 软边绒垫：中间是深植物绿，边缘渐隐进木台，避免看起来像桌上一个绿洞。
    const gradient = context.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(60, 74, 56, 0.96)');
    gradient.addColorStop(0.62, 'rgba(53, 67, 50, 0.94)');
    gradient.addColorStop(0.9, 'rgba(48, 61, 45, 0.72)');
    gradient.addColorStop(1, 'rgba(46, 58, 43, 0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    // 绒面纤维：细密的短绒 + 一点明暗起伏。
    for (let i = 0; i < 4200; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random()) * size * 0.47;
      const x = size / 2 + Math.cos(angle) * radius;
      const y = size / 2 + Math.sin(angle) * radius;
      const light = Math.random() > 0.5;
      context.fillStyle = light ? 'rgba(126, 143, 114, 0.1)' : 'rgba(32, 42, 30, 0.12)';
      context.fillRect(x, y, 1.4, 1.6);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createContactShadowTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      4,
      size / 2,
      size / 2,
      size / 2,
    );
    gradient.addColorStop(0, 'rgba(58, 42, 30, 0.5)');
    gradient.addColorStop(0.45, 'rgba(58, 42, 30, 0.2)');
    gradient.addColorStop(1, 'rgba(58, 42, 30, 0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
