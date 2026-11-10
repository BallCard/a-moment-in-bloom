import * as THREE from 'three';
import { HEIGHT_MAX, HEIGHT_MIN, MAX_TILT, MIN_TILT, SCALE_MAX, SCALE_MIN } from '../config';
import type { StemInstance, StemPose, Vec3 } from './types';

const UP = new THREE.Vector3(0, 1, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

export const degToRad = (deg: number): number => (deg * Math.PI) / 180;
export const radToDeg = (rad: number): number => (rad * 180) / Math.PI;

export function normalizeAngle(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampPose(pose: StemPose): StemPose {
  return {
    height: clamp(Number.isFinite(pose.height) ? pose.height : 0, HEIGHT_MIN, HEIGHT_MAX),
    tilt: clamp(Number.isFinite(pose.tilt) ? pose.tilt : 0, MIN_TILT, MAX_TILT),
    direction: normalizeAngle(Number.isFinite(pose.direction) ? pose.direction : 0),
    spin: normalizeAngle(Number.isFinite(pose.spin) ? pose.spin : 0),
  };
}

export function clampScale(scale: number): number {
  return clamp(Number.isFinite(scale) ? scale : 1, SCALE_MIN, SCALE_MAX);
}

export function defaultPose(): StemPose {
  return { height: 0, tilt: 0, direction: 0, spin: 0 };
}

/**
 * 姿态 → 四元数。
 * 先绕自身茎轴转到 spin，再让茎朝 direction 方向倾斜 tilt 度。
 * direction=0 时向 +Z（默认镜头一侧）倾斜。
 */
export function poseToQuaternion(pose: StemPose): THREE.Quaternion {
  const tilt = degToRad(pose.tilt);
  const direction = degToRad(pose.direction);
  const spin = degToRad(pose.spin);
  // 把 +Y 往 (sin(direction), 0, cos(direction)) 方向压，旋转轴取该方向左侧的水平轴。
  const tiltAxis = new THREE.Vector3(Math.cos(direction), 0, -Math.sin(direction));
  const tiltQuat = new THREE.Quaternion().setFromAxisAngle(tiltAxis, tilt);
  const spinQuat = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, spin);
  return tiltQuat.multiply(spinQuat).normalize();
}

/** 姿态 → 欧拉角（弧度，YXZ 顺序），写进序列化数据。 */
export function poseToEuler(pose: StemPose): Vec3 {
  const euler = new THREE.Euler().setFromQuaternion(poseToQuaternion(pose), 'YXZ');
  return [euler.x, euler.y, euler.z];
}

/** 花头中心在世界坐标中的位置。 */
export function headWorldPosition(
  stem: Pick<StemInstance, 'position' | 'pose'>,
  headHeight: number,
): THREE.Vector3 {
  const quaternion = poseToQuaternion(stem.pose);
  const offset = new THREE.Vector3(0, headHeight + stem.pose.height, 0).applyQuaternion(quaternion);
  return new THREE.Vector3(stem.position[0], stem.position[1], stem.position[2]).add(offset);
}

/** 茎根（握点处）在世界坐标中的位置。 */
export function stemBaseWorld(stem: Pick<StemInstance, 'position'>): THREE.Vector3 {
  return new THREE.Vector3(stem.position[0], stem.position[1], stem.position[2]);
}

/** 从欧拉角反推可编辑姿态，用于兼容只有 rotation 的旧存档。 */
export function derivePoseFromRotation(rotation: Vec3): StemPose {
  const euler = new THREE.Euler(rotation[0], rotation[1], rotation[2], 'YXZ');
  euler.order = 'YXZ';
  const quaternion = new THREE.Quaternion().setFromEuler(euler);
  const up = UP.clone().applyQuaternion(quaternion);
  const tilt = radToDeg(Math.acos(clamp(up.y, -1, 1)));
  const direction = normalizeAngle(radToDeg(Math.atan2(up.x, up.z)));
  return clampPose({ height: 0, tilt, direction, spin: 0 });
}
