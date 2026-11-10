/**
 * 拍照布景的近景道具（Lux3D 生成，V12）。
 *
 * 分工：程序化几何搭空间骨架（墙/台面/光源/远景色带），Lux3D 只负责近景里
 * 单独成件、需要「近看有质感」的道具（蜡烛、咖啡杯碟、台灯、干花小瓶）。
 * 任何一件加载失败都不影响布景：`scene-props.ts` 找不到模型就不挂载，
 * 场景里原有的程序化道具继续用。
 */

export type PropId = 'candle' | 'coffee-set' | 'table-lamp' | 'dried-bouquet';

export interface PropSpec {
  /** 静态资源路径（相对站点根）。 */
  url: string;
  /** 归一化后的整体高度（米），按包围盒等比缩放。 */
  displayHeight: number;
  /** 生成模型姿态修正（弧度）；Lux3D 产物可能需要绕 X/Y 扶正。 */
  rotation?: [number, number, number];
}

export const PROP_MODELS: Record<PropId, PropSpec> = {
  candle: { url: 'assets/props/candle.glb', displayHeight: 0.12 },
  // 杯碟原始姿态就直立（manifest 已按四视角目检订正为 rotation 0°/height 0.085m；
  // 之前「宽>高」的启发式误判过 lying-x，不要再加旋转）。
  'coffee-set': { url: 'assets/props/coffee-set.glb', displayHeight: 0.085 },
  'table-lamp': { url: 'assets/props/table-lamp.glb', displayHeight: 0.45 },
  'dried-bouquet': { url: 'assets/props/dried-bouquet.glb', displayHeight: 0.28 },
};

export const PROP_LABELS: Record<PropId, string> = {
  candle: '烛台蜡烛',
  'coffee-set': '咖啡杯碟',
  'table-lamp': '布罩台灯',
  'dried-bouquet': '干花小瓶',
};
