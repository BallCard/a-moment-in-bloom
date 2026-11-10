/** 全局常量：握点、工作台、交互边界与存储键。 */

/** 握点在世界坐标中的高度（米）。花枝围绕它插放。 */
export const GRIP_Y = 0.9;

/** 工作台台面高度（米）。 */
export const TABLE_TOP_Y = 0.66;

/** 花头相对握点的最大水平半径（米），放置和拖动都受它限制。 */
export const MAX_HEAD_RADIUS = 0.38;

/** 花枝最大倾斜角（度）。 */
export const MAX_TILT = 55;

/** 花枝最低倾斜角（度）。 */
export const MIN_TILT = 0;

/** 沿茎方向的高度调整范围（米）。 */
export const HEIGHT_MIN = -0.05;
export const HEIGHT_MAX = 0.2;

/** 单枝缩放范围。 */
export const SCALE_MIN = 0.85;
export const SCALE_MAX = 1.15;

/** 花束枝数上限。 */
export const MAX_STEMS = 20;

/** 撤销栈上限。 */
export const HISTORY_LIMIT = 60;

/** localStorage 键与序列化版本。 */
export const STORAGE_KEY = 'bouquet-workbench.v1';
/** 本机设置（辅助开关、动态偏好）的存储键，与作品 JSON 分开。 */
export const SETTINGS_KEY = 'bouquet-workbench.settings.v1';
/** 文档结构版本：v1 只有花枝，v2 增加包装、丝带、卡片，v3 增加分步包装字段。 */
export const SCHEMA_VERSION = 4;

/** 没有 manifest 时使用的内置程序化花材版本。 */
export const BUILTIN_ASSETS_VERSION = 'builtin-proc-1';

/** 本地相册的存储键与上限。 */
export const ALBUM_KEY = 'bouquet-workbench.album.v1';
export const ALBUM_LIMIT = 12;
/** 相册缩略图边长（像素，JPEG）。 */
export const ALBUM_THUMBNAIL_SIZE = 480;

/** 四个预设视角；另有 free 表示用户手动转过镜头。 */
export const VIEW_PRESETS = ['front', 'quarter', 'side', 'top'] as const;

/**
 * V0.7 §7 固定视角下滚轮切换视角的阈值（累计 deltaY）与节流（毫秒）。
 * 触控板一次滑动会产生几十次小数 deltaY，不加累计与节流会连跳好几档。
 */
export const WHEEL_VIEW_STEP = 90;
export const WHEEL_VIEW_COOLDOWN_MS = 320;
/** 两段滚动之间超过这么久就重新累计，避免慢慢滚也一直累加。 */
export const WHEEL_VIEW_RESET_MS = 260;

/** 拖动判定阈值（像素）：小于它算点击，大于它算拖动。 */
export const CLICK_SLOP_PX = 5;

// ---------- 摆放建议与吸附 ----------

/** 指针屏幕位置进入候选锚点的吸附距离（像素）。 */
export const SNAP_ENTER_PX = 24;

/** 拉开脱离吸附的距离（像素）。必须明显大于进入距离，形成滞回。 */
export const SNAP_EXIT_PX = 52;

/** 一次最多给出的建议位数量。 */
export const MAX_SUGGESTIONS = 3;

// ---------- 阶段与动效 ----------

/** 单步包装动画时长（毫秒）：摆纸 / 合拢收口 / 丝带 / 卡片。 */
export const PACKAGE_STEP_MS = 520;

/** 摆纸阶段开口缩放的调节范围。 */
export const PAPER_OPEN_SCALE_MIN = 0.85;
export const PAPER_OPEN_SCALE_MAX = 1.12;

// ---------- 包装与丝带 ----------

/** 包装纸下沿高度（略高于台面，避免穿模）。 */
export const WRAP_BOTTOM_Y = TABLE_TOP_Y + 0.008;

/** 包装纸上沿高度（握点上方，花头之下）。压低到花茎中段，避免像“花插在纸碗里”。 */
export const WRAP_TOP_Y = GRIP_Y + 0.15;

/** 包装纸底部半径（束口附近，米）。 */
export const WRAP_BOTTOM_RADIUS = 0.075;

/** 包装纸开口相对花束外包络的余量（米）。 */
export const WRAP_RADIUS_MARGIN = 0.05;

/**
 * 开口收紧比例：花头要明显探出纸口（真实手绑花束的纸口比花束外圈窄）。
 * 0.66 是当前花材（玫瑰/郁金香头径偏大）下的实测值，见 experiments/local/validation-round2.md。
 * V15.1：0.66 → 0.72，配合 wrapping.ts 压低纸口高度，减少花材从纸面穿出的观感（纸包前沿不再切进花头区）。
 */
export const WRAP_RADIUS_TIGHTEN = 0.72;

/** 包装纸开口半径的上下限（米）。 */
export const WRAP_MIN_RADIUS = 0.15;
export const WRAP_MAX_RADIUS = 0.4;

/** 纸张展开 / 丝带绕圈的动画时长（毫秒）。 */
export const PAPER_UNFOLD_MS = 620;
export const RIBBON_WRAP_MS = 560;

// ---------- 卡片 ----------

/** 卡片三个字段的字符上限（中文按 1 个字符计）。 */
export const CARD_TO_MAX = 20;
export const CARD_MESSAGE_MAX = 120;
export const CARD_FROM_MAX = 20;

/** 导出的正方形 PNG 边长（像素）。 */
export const EXPORT_PNG_SIZE = 2048;

// ---------- V16：整理、装饰与音效 ----------

/** 一件作品里辅助装饰的数量上限（防止误点堆满画面）。 */
export const MAX_ORNAMENTS = 12;

/** 知识浮窗：悬停预览延迟（毫秒）与固定所需的持续悬停时长（毫秒）。 */
export const KNOWLEDGE_PREVIEW_DELAY_MS = 300;
export const KNOWLEDGE_PIN_DELAY_MS = 2000;

/** 默认音量（0–1）。 */
export const DEFAULT_AUDIO_VOLUME = 0.6;
