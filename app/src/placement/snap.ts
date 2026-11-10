/**
 * 吸附滞回（纯逻辑，不依赖 Three.js / store）。
 *
 * 规则（docs/round-plan.md 3.2）：
 * - 指针到候选锚点的屏幕距离 < enterPx 才吸附；
 * - 已经吸附后，必须拉开到 > exitPx 才脱离（exitPx 明显大于 enterPx，避免边界抖动和候选互抢）；
 * - assist.snapping=false 且没有 pin 时完全不吸附；
 * - pinnedSuggestionId 非空时直接锁到该候选，直到再点一次卡片取消或落位；
 * - 指针离开画布时不吸附（pin 保留，等用户回到画布）。
 *
 * 场景只需要在指针事件里调 update()，返回 activeId 是否变化，再决定要不要回报 store。
 */

import { SNAP_ENTER_PX, SNAP_EXIT_PX } from '../config';

export interface SnapAnchor {
  id: string;
  /** 候选花头投影到画布的 CSS 像素坐标。 */
  x: number;
  y: number;
}

export interface SnapInput {
  anchors: SnapAnchor[];
  pointer: { x: number; y: number } | null;
  /** 指针当前是否在画布内。 */
  pointerActive: boolean;
  pinnedId: string | null;
  snapping: boolean;
}

export interface SnapResult {
  activeId: string | null;
  /** activeId 相对上一次是否变化。 */
  changed: boolean;
  /** 本次从自由进入吸附。 */
  entered: boolean;
  /** 本次从吸附脱离（含 pin 被拉开）。 */
  released: boolean;
  /** 需要调用方清掉 store 里的 pin。 */
  pinCleared: boolean;
  /** 最近候选的屏幕距离（调试用）。 */
  nearestDistance: number | null;
}

function distanceTo(anchor: SnapAnchor, pointer: { x: number; y: number }): number {
  return Math.hypot(anchor.x - pointer.x, anchor.y - pointer.y);
}

function nearestAnchor(
  anchors: SnapAnchor[],
  pointer: { x: number; y: number },
): { anchor: SnapAnchor; distance: number } | null {
  let best: { anchor: SnapAnchor; distance: number } | null = null;
  for (const anchor of anchors) {
    const distance = distanceTo(anchor, pointer);
    if (!best || distance < best.distance) best = { anchor, distance };
  }
  return best;
}

export class SnapController {
  private activeId: string | null = null;

  constructor(
    private readonly enterPx: number = SNAP_ENTER_PX,
    private readonly exitPx: number = SNAP_EXIT_PX,
  ) {
    if (this.exitPx <= this.enterPx) {
      throw new Error('SNAP_EXIT_PX 必须大于 SNAP_ENTER_PX');
    }
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  /** 放置结束 / 取消时清空吸附状态；返回 activeId 是否因此变化。 */
  reset(): boolean {
    const changed = this.activeId !== null;
    this.activeId = null;
    return changed;
  }

  update(input: SnapInput): SnapResult {
    const previous = this.activeId;
    const pinnedAnchor = input.pinnedId
      ? (input.anchors.find((anchor) => anchor.id === input.pinnedId) ?? null)
      : null;

    // pin 指向的候选不存在了：让调用方清 pin。
    if (input.pinnedId && !pinnedAnchor) {
      this.activeId = null;
      return {
        activeId: null,
        changed: previous !== null,
        entered: false,
        released: previous !== null,
        pinCleared: true,
        nearestDistance: null,
      };
    }

    // 1) 有 pin：锁定到 pin 的候选，直到用户再点一次卡片取消或落位。
    // 指针离开画布再回到别处也不丢 pin —— 界面上明写着「已钉住」，行为要可预期。
    if (pinnedAnchor) {
      const entered = this.activeId !== pinnedAnchor.id;
      this.activeId = pinnedAnchor.id;
      return {
        activeId: pinnedAnchor.id,
        changed: entered,
        entered,
        released: false,
        pinCleared: false,
        nearestDistance: input.pointer ? distanceTo(pinnedAnchor, input.pointer) : null,
      };
    }

    // 2) 没有 pin：关闭吸附或指针不在画布时保持自由。
    if (!input.snapping || !input.pointer || !input.pointerActive || input.anchors.length === 0) {
      const released = previous !== null;
      this.activeId = null;
      return {
        activeId: null,
        changed: released,
        entered: false,
        released,
        pinCleared: false,
        nearestDistance: null,
      };
    }

    const nearest = nearestAnchor(input.anchors, input.pointer);

    // 3) 已吸附：只有拉开超过 exitPx 才脱离（滞回）。
    if (previous) {
      const anchor = input.anchors.find((item) => item.id === previous);
      const distance = anchor ? distanceTo(anchor, input.pointer) : Number.POSITIVE_INFINITY;
      if (distance > this.exitPx) {
        this.activeId = null;
        return {
          activeId: null,
          changed: true,
          entered: false,
          released: true,
          pinCleared: false,
          nearestDistance: nearest?.distance ?? null,
        };
      }
      return {
        activeId: previous,
        changed: false,
        entered: false,
        released: false,
        pinCleared: false,
        nearestDistance: distance,
      };
    }

    // 4) 未吸附：进入距离内才吸附。
    if (nearest && nearest.distance < this.enterPx) {
      this.activeId = nearest.anchor.id;
      return {
        activeId: nearest.anchor.id,
        changed: true,
        entered: true,
        released: false,
        pinCleared: false,
        nearestDistance: nearest.distance,
      };
    }

    return {
      activeId: null,
      changed: false,
      entered: false,
      released: false,
      pinCleared: false,
      nearestDistance: nearest?.distance ?? null,
    };
  }
}
