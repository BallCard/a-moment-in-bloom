/**
 * 阶段机位、预设视角与欣赏环绕。
 *
 * 全部相机运动集中在这里，方便保证：
 * - 阶段切换过渡 250–350ms，操作跟手优先，编辑态不自动漂移；
 * - 预设视角只替换方位角/俯仰角，保留当前阶段的取景距离和视点高度；
 * - 用户手动转镜头后进入「自由视角」，不再被预设拉走；
 * - 欣赏模式是"缓慢环绕"，随时可以停，停在当前角度。
 */

import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ViewPreset, WorkflowStage } from '../../data/types';

export interface CameraPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

/** 阶段预设机位：摆放看整束，包装看腰线，成品带上包装与卡片的完整构图。 */
export const STAGE_CAMERAS: Record<WorkflowStage, CameraPose> = {
  arrange: {
    position: new THREE.Vector3(0.97, 1.4, 1.26),
    target: new THREE.Vector3(0, 1.09, 0),
  },
  wrap: {
    position: new THREE.Vector3(0.82, 1.16, 1.08),
    target: new THREE.Vector3(0, 1.0, 0),
  },
  finish: {
    position: new THREE.Vector3(1.02, 1.34, 1.52),
    target: new THREE.Vector3(0, 0.99, 0),
  },
};

/** 预设视角的方位角（0 = 正对花束正面）与俯仰角（度）。quarter 用阶段默认朝向。 */
const PRESET_ANGLES: Record<Exclude<ViewPreset, 'free' | 'quarter'>, { azimuth: number; elevation: number }> = {
  front: { azimuth: 0, elevation: 10 },
  side: { azimuth: 90, elevation: 8 },
  top: { azimuth: 35, elevation: 52 },
};

/** 过渡时长（毫秒）。契约要求 250–350ms。 */
const TRANSITION_MS = 320;

/** 欣赏模式的环绕角速度（弧度/秒），慢到能看清花，又不至于像静止。 */
const SHOWCASE_SPEED = 0.11;

interface Tween {
  fromPosition: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toPosition: THREE.Vector3;
  toTarget: THREE.Vector3;
  start: number;
  duration: number;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class StageCamera {
  private stage: WorkflowStage = 'arrange';
  private preset: ViewPreset = 'quarter';
  private tween: Tween | null = null;
  private showcasing = false;
  /** 花束变大时的镜头拉远系数（1 = 默认机位）。 */
  private fit = 1;
  /** 花束变大时抬高的视点高度；null = 用阶段默认。 */
  private fitTargetY: number | null = null;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly controls: OrbitControls,
    private readonly isReduceMotion: () => boolean,
  ) {}

  getStage(): WorkflowStage {
    return this.stage;
  }

  getPreset(): ViewPreset {
    return this.preset;
  }

  get isTransitioning(): boolean {
    return this.tween !== null;
  }

  get isShowcase(): boolean {
    return this.showcasing;
  }

  get homePose(): CameraPose {
    return this.stagePose('arrange');
  }

  setStage(stage: WorkflowStage): void {
    this.stage = stage;
    this.moveTo(this.poseForPreset(this.preset), TRANSITION_MS);
  }

  /** 套用预设视角；free 只记录状态，不动相机。 */
  setPreset(preset: ViewPreset): void {
    this.preset = preset;
    if (preset === 'free') return;
    this.moveTo(this.poseForPreset(preset), TRANSITION_MS);
  }

  /** 用户开始手动转镜头：取消进行中的过渡并进入自由视角。 */
  markFree(): void {
    this.preset = 'free';
    this.tween = null;
  }
  restoreDirection(direction:[number,number,number]):void {
    const pose=this.stagePose(this.stage);
    const offset=new THREE.Vector3(...direction).normalize();
    this.preset='free';this.tween=null;
    this.controls.target.copy(pose.target);
    this.camera.position.copy(pose.target).addScaledVector(offset,pose.position.distanceTo(pose.target));
    this.camera.lookAt(pose.target);this.controls.update();
  }

  /** 复位视角：回到当前阶段的默认机位（斜 45°）。 */
  resetHome(): void {
    this.preset = 'quarter';
    this.moveTo(this.stagePose(this.stage), TRANSITION_MS);
  }

  /**
   * 花束外廓变化时调整机位：只在明显变化时过渡，避免加一枝就抖一下。
   * scale = 需要的镜头距离 / 阶段默认距离；targetY = 新的视点高度。
   */
  applyFit(scale: number, targetY: number | null): void {
    const nextScale = THREE.MathUtils.clamp(scale, 1, 2.1);
    const nextTargetY = targetY === null ? null : THREE.MathUtils.clamp(targetY, 0.9, 1.34);
    const scaleChanged = Math.abs(nextScale - this.fit) > 0.02;
    const targetChanged =
      nextTargetY !== null &&
      (this.fitTargetY === null || Math.abs(nextTargetY - this.fitTargetY) > 0.02);
    if (!scaleChanged && !targetChanged) return;
    this.fit = nextScale;
    this.fitTargetY = nextTargetY;
    if (!this.showcasing) this.moveTo(this.poseForPreset(this.preset), TRANSITION_MS);
  }

  /** 选中花枝后短距离推进（不清空选中，只把镜头拉近一点）。 */
  focusOn(head: THREE.Vector3 | null): void {
    const home = this.stagePose(this.stage);
    const target = head
      ? new THREE.Vector3(head.x, head.y - 0.04, head.z)
      : home.target.clone();
    const direction = this.camera.position.clone().sub(target);
    if (direction.lengthSq() < 1e-6) direction.set(1, 0.6, 1.2);
    direction.normalize();
    const current = this.camera.position.distanceTo(target);
    const distance = THREE.MathUtils.clamp(current * 0.82, 0.95, 1.75);
    this.moveTo(
      { position: target.clone().addScaledVector(direction, distance), target },
      TRANSITION_MS,
    );
  }

  startShowcase(): void {
    this.showcasing = true;
    this.tween = null;
  }

  stopShowcase(): void {
    this.showcasing = false;
  }

  /**
   * 每帧调用。负责：推进过渡 / 环绕，并统一调用 controls.update()，
   * 避免场景里重复 update 让阻尼翻倍。
   * 返回本帧相机是否移动（选中锚点节流会用到）。
   */
  update(now: number, deltaSeconds: number): boolean {
    if (this.tween) {
      const tween = this.tween;
      const raw = THREE.MathUtils.clamp((now - tween.start) / tween.duration, 0, 1);
      const eased = easeInOutCubic(raw);
      this.camera.position.lerpVectors(tween.fromPosition, tween.toPosition, eased);
      this.controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
      this.camera.lookAt(this.controls.target);
      if (raw >= 1) {
        this.tween = null;
        this.controls.update();
      }
      return true;
    }

    if (this.showcasing) {
      const offset = this.camera.position.clone().sub(this.controls.target);
      const angle = SHOWCASE_SPEED * deltaSeconds;
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
      this.camera.position.copy(this.controls.target).add(offset);
      this.camera.lookAt(this.controls.target);
      this.controls.update();
      return true;
    }

    this.controls.update();
    return false;
  }

  /** 阶段默认机位（含大花束 fit）。 */
  private stagePose(stage: WorkflowStage): CameraPose {
    const base = STAGE_CAMERAS[stage];
    if (this.fit <= 1.001 && this.fitTargetY === null) {
      return { position: base.position.clone(), target: base.target.clone() };
    }
    const target = base.target.clone();
    if (this.fitTargetY !== null) target.y = this.fitTargetY;
    const position = target.clone().addScaledVector(
      base.position.clone().sub(base.target),
      this.fit,
    );
    return { position, target };
  }

  private poseForPreset(preset: ViewPreset): CameraPose {
    const base = this.stagePose(this.stage);
    if (preset === 'free' || preset === 'quarter') return base;
    const angles = PRESET_ANGLES[preset];
    const distance = base.position.distanceTo(base.target);
    const azimuth = THREE.MathUtils.degToRad(angles.azimuth);
    const elevation = THREE.MathUtils.degToRad(angles.elevation);
    const direction = new THREE.Vector3(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(azimuth) * Math.cos(elevation),
    );
    return {
      position: base.target.clone().addScaledVector(direction, distance),
      target: base.target.clone(),
    };
  }

  private moveTo(pose: CameraPose, duration: number): void {
    if (this.isReduceMotion() || duration <= 0) {
      this.camera.position.copy(pose.position);
      this.controls.target.copy(pose.target);
      this.camera.lookAt(pose.target);
      this.controls.update();
      this.tween = null;
      return;
    }
    this.tween = {
      fromPosition: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPosition: pose.position.clone(),
      toTarget: pose.target.clone(),
      start: performance.now(),
      duration,
    };
  }
}
