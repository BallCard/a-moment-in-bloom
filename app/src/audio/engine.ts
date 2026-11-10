/**
 * 音频引擎（V16 §6）——动作音效为 WebAudio 程序化合成；背景音乐为本地静态音频。
 *
 * 动作音效：**程序化合成**，不依赖任何外部音频文件或在线服务。
 * 用 WebAudio 现场合成轻柔的近距离听感（木质轻响、纸声、剪刀声、轻金属提示），
 * 因此不产生费用、不引入来源不明的素材，也不需要网络。来源方式如实记录为
 * 「WebAudio 程序化合成（振荡器 + 带通白噪声 + 增益包络）」，不是真人录音，
 * 也不是任何模型生成。之后若拿到授权的真实录音，只需在 `render()` 里换成采样播放，
 * 调用方（store/scene/UI）不用改。
 *
 * 背景音乐（V16 音乐轮）：`app/public/assets/audio/ambient-calm-*.mp3`，由 ModelScope
 * API-Inference 的 ACE-Step 真实生成（模型 ACE-Step/acestep-v15-xl-sft，MIT），
 * 之后用 ffmpeg 裁剪尾部静音并做首尾交叉淡化，得到可循环的本地文件；
 * 生成记录、计费与许可见 `docs/v16-music-api-record.md`。BGM 用 HTMLAudioElement
 * 播放：loop、音量恒为 master × 0.35（低于动作音）、与静音联动、切后台暂停、
 * 回前台恢复、首次用户手势后才 play()。自动播放被拒时静默降级（只在 debug 里记一次，
 * 不 console 刷屏、不影响制作），并等下一次手势再试。
 *
 * 约束（与计划一致）：
 * - 模块加载时**不创建** AudioContext、也不创建 audio 元素；必须等首次用户手势
 *   （浏览器自动播放限制），由 `installUnlockOnFirstGesture()` 或 App 显式调用
 *   `unlockAudio()`；
 * - 静音 / 音量 / BGM 开关为本机设置，进 SETTINGS_KEY，不进作品文档；
 * - 失败不抛错：没有 AudioContext、创建失败、被浏览器拒绝时静默降级，不影响制作；
 * - 批量动作只播一次整体反馈（调用方控制），连续拖动由限频表挡住；
 * - 切后台（document.hidden）挂起音频上下文 / 暂停 BGM，返回时恢复；不排队、不补播；
 * - 静音/未解锁时也写入 debug 播放记录（audible:false），便于验证「有事件但不发声」。
 *
 * 对外的 API 保持稳定：
 * configureAudio / getAudioPrefs / unlockAudio / installUnlockOnFirstGesture /
 * playSfx / getAudioDebug / resetAudioDebug。
 */

export type SoundName =
  | 'pick'
  | 'place'
  | 'select'
  | 'remove'
  | 'snip'
  | 'trim-leaf'
  | 'dethorn'
  | 'flip'
  | 'foam-cut'
  | 'foam-place'
  | 'paper'
  | 'fold'
  | 'ribbon'
  | 'ornament'
  | 'camera'
  | 'save'
  | 'error';

export interface AudioPrefs {
  muted: boolean;
  volume: number;
  /** 背景音乐开关（与动作音效分开，本机设置）。 */
  bgm: boolean;
}

/** 背景音乐状态（自动化验证用，只读）。 */
export interface BgmDebugState {
  supported: boolean;
  /** 用户偏好里的 BGM 开关。 */
  enabled: boolean;
  /** 是否正在播放（play 事件后为 true）。 */
  playing: boolean;
  paused: boolean;
  /** 主静音联动后的元素静音状态。 */
  muted: boolean;
  /** 元素当前实际音量（master × BGM 比例；静音时为 0）。 */
  volume: number;
  currentTime: number;
  duration: number;
  loop: boolean;
  /** 本地曲目路径（相对站点 base）。 */
  track: string | null;
  /** 首次播放被自动播放策略拒绝。 */
  blocked: boolean;
  /** 最近一次错误（仅 debug，不写 console）。 */
  error: string | null;
  /** 切后台暂停 / 回前台恢复次数。 */
  hiddenPauses: number;
  visibleResumes: number;
}

export interface PlayedSound {
  name: SoundName;
  at: number;
  /** 是否真的发声：静音 / 音量为 0 / 未解锁 / 上下文挂起时为 false。 */
  audible: boolean;
}

/** 自动化验证用的累计计数；只增不减，resetAudioDebug 会清零。 */
export interface AudioStats {
  attempted: number;
  played: number;
  suppressed: number;
  throttled: number;
}

export interface AudioDebugState {
  supported: boolean;
  unlocked: boolean;
  muted: boolean;
  volume: number;
  contextState: string;
  played: PlayedSound[];
  stats: AudioStats;
  /** 背景音乐状态（未创建元素时 supported 为真、track 为 null）。 */
  bgm: BgmDebugState;
}

const MAX_DEBUG_LOG = 40;
/** 同名音默认最小间隔（毫秒）：连续拖动时不会叠成机关枪。 */
const DEFAULT_MIN_GAP_MS = 45;
/**
 * 个别音的限频更宽：拍照阶段每次预览刷新都会走 capture 回调，
 * 650ms 内只保留一次快门提示，避免「调一下场景就咔一声」。
 */
const MIN_GAP_OVERRIDES: Partial<Record<SoundName, number>> = { camera: 650 };

/** 背景音乐曲目（本地静态文件；来源见 docs/v16-music-api-record.md）。 */
export const BGM_TRACKS = ['ambient-calm-1.mp3', 'ambient-calm-2.mp3'] as const;
/** BGM 相对主音量的比例：恒低于动作音效，不抢注意力。 */
export const BGM_VOLUME_RATIO = 0.35;

const prefs: AudioPrefs = { muted: false, volume: 0.6, bgm: true };
let context: AudioContext | null = null;
let master: GainNode | null = null;
let unlocked = false;
/** 是否曾在用户手势里成功跑起来过：切后台恢复时用它判断，不受临时挂起影响。 */
let everUnlocked = false;
let played: PlayedSound[] = [];
let lastPlayedName: SoundName | null = null;
let lastPlayedSameAt = 0;
let noiseBuffer: AudioBuffer | null = null;
let detachUnlockGesture: (() => void) | null = null;
let stats: AudioStats = { attempted: 0, played: 0, suppressed: 0, throttled: 0 };

// ---------- 背景音乐状态 ----------
/** 是否已经收到过用户手势：BGM 只在手势后才 play()，避免自动播放被拒。 */
let gestureSeen = false;
let bgmEl: HTMLAudioElement | null = null;
let bgmTrack: string | null = null;
let bgmPlaying = false;
let bgmBlocked = false;
let bgmError: string | null = null;
let bgmAttempts = 0;
let bgmHiddenPauses = 0;
let bgmVisibleResumes = 0;
/** 因为切后台而暂停：回前台才恢复，用户自己关掉的 BGM 不自动打开。 */
let bgmPausedForHidden = false;
let detachBgmRetry: (() => void) | null = null;

function supported(): boolean {
  return typeof window !== 'undefined' && typeof window.AudioContext === 'function';
}

function bgmSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.Audio === 'function';
}

/** BGM 目标音量：主音量 × 0.35，静音时为 0。 */
function bgmTargetVolume(): number {
  if (prefs.muted || prefs.volume <= 0) return 0;
  return Math.min(1, Math.max(0, prefs.volume * BGM_VOLUME_RATIO));
}

/** 新建 audio 元素（只在首次手势后调用），挂到 body 里方便调试面板/自动化读取。 */
function ensureBgmElement(): HTMLAudioElement | null {
  if (bgmEl) return bgmEl;
  if (!bgmSupported()) return null;
  try {
    const el = new Audio();
    const index = Math.floor(Math.random() * BGM_TRACKS.length);
    const file = BGM_TRACKS[index] ?? BGM_TRACKS[0];
    // 与 public/ 下静态资源一致：BASE_URL 在构建后也是相对路径。
    el.src = `${import.meta.env.BASE_URL}assets/audio/${file}`;
    el.loop = true;
    el.preload = 'auto';
    el.volume = bgmTargetVolume();
    el.muted = prefs.muted;
    el.setAttribute('data-testid', 'bgm-audio');
    el.setAttribute('aria-hidden', 'true');
    el.style.display = 'none';
    el.addEventListener('play', () => {
      bgmPlaying = true;
    });
    el.addEventListener('pause', () => {
      bgmPlaying = false;
    });
    // 404 / 解码失败：静默降级，只在 debug 里留一条，不打断制作。
    el.addEventListener('error', () => {
      bgmError = `media-error:${el.error?.code ?? 'unknown'}`;
      bgmPlaying = false;
    });
    if (typeof document !== 'undefined' && document.body) document.body.appendChild(el);
    bgmEl = el;
    bgmTrack = `assets/audio/${file}`;
    return el;
  } catch {
    bgmError = 'create-failed';
    return null;
  }
}

function applyBgmElementState(): void {
  if (!bgmEl) return;
  try {
    bgmEl.volume = bgmTargetVolume();
    bgmEl.muted = prefs.muted;
  } catch {
    /* 元素异常时静默，不影响制作 */
  }
}

/**
 * 尝试播放 BGM。只在收到用户手势后、BGM 开关打开、页面可见时执行。
 * play() 可能被自动播放策略拒绝：捕获后静默，并挂在后两次手势上再试。
 */
function startBgm(): void {
  if (!prefs.bgm || !gestureSeen) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  if (bgmPlaying) return;
  const el = ensureBgmElement();
  if (!el) return;
  applyBgmElementState();
  bgmAttempts += 1;
  try {
    const attempt = el.play();
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch(() => {
        bgmBlocked = true;
        bgmError = 'autoplay-blocked';
        armBgmRetry();
      });
    }
  } catch {
    bgmBlocked = true;
    bgmError = 'play-threw';
    armBgmRetry();
  }
}

/** 首次播放被拒时，最多再挂两次手势重试；之后维持静音降级，不刷屏。 */
function armBgmRetry(): void {
  if (detachBgmRetry || !prefs.bgm || bgmPlaying || bgmAttempts >= 3) return;
  if (typeof window === 'undefined') return;
  const retry = (): void => {
    detachBgmRetry?.();
    startBgm();
  };
  const detach = (): void => {
    window.removeEventListener('pointerdown', retry, true);
    window.removeEventListener('keydown', retry, true);
    window.removeEventListener('touchstart', retry, true);
    if (detachBgmRetry === detach) detachBgmRetry = null;
  };
  for (const type of GESTURES) window.addEventListener(type, retry, { capture: true, passive: true });
  detachBgmRetry = detach;
}

function stopBgm(): void {
  detachBgmRetry?.();
  bgmPausedForHidden = false;
  if (!bgmEl) return;
  try {
    bgmEl.pause();
  } catch {
    /* ignore */
  }
}

/** 更新音频偏好（store 在启动和用户改音量/静音/BGM 开关时调用）。 */
export function configureAudio(next: Partial<AudioPrefs>): void {
  const bgmWasEnabled = prefs.bgm;
  if (typeof next.muted === 'boolean') prefs.muted = next.muted;
  if (typeof next.volume === 'number' && Number.isFinite(next.volume)) {
    prefs.volume = Math.min(1, Math.max(0, next.volume));
  }
  if (typeof next.bgm === 'boolean') prefs.bgm = next.bgm;
  if (master && context) {
    try {
      // 平滑过渡，避免拖动音量滑杆时出现「咔哒」的阶跃声。
      const target = prefs.muted ? 0 : prefs.volume;
      master.gain.cancelScheduledValues(context.currentTime);
      master.gain.setTargetAtTime(target, context.currentTime, 0.02);
    } catch {
      /* 上下文异常时保持静默，不影响制作 */
    }
  }
  applyBgmElementState();
  if (!prefs.bgm) stopBgm();
  else if (!bgmWasEnabled) startBgm();
}

export function getAudioPrefs(): AudioPrefs {
  return { ...prefs };
}

function ensureContext(): boolean {
  if (!supported()) return false;
  if (context) return true;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return false;
    context = new Ctor();
    master = context.createGain();
    master.gain.value = prefs.muted ? 0 : prefs.volume;
    master.connect(context.destination);
    // 状态变化（浏览器自动挂起、切后台挂起、恢复）同步给 debug。
    context.onstatechange = (): void => {
      unlocked = context?.state === 'running';
      if (unlocked) everUnlocked = true;
    };
    return true;
  } catch {
    context = null;
    master = null;
    unlocked = false;
    return false;
  }
}

/**
 * 页面首次用户交互时调用一次。浏览器要求手势内创建/恢复 AudioContext；
 * 失败只是没有声音，不影响任何操作。
 */
export async function unlockAudio(): Promise<boolean> {
  if (!ensureContext() || !context) {
    unlocked = false;
    return false;
  }
  try {
    if (context.state === 'suspended') await context.resume();
    unlocked = context.state === 'running';
    if (unlocked) everUnlocked = true;
  } catch {
    unlocked = false;
  }
  return unlocked;
}

const GESTURES = ['pointerdown', 'keydown', 'touchstart'] as const;

/**
 * 可选的一行接入：在第一次 pointerdown / keydown / touchstart 时解锁并自解除。
 * 供 App 在挂载时调用；返回解除函数（通常不用调，组件卸载时可调）。
 * 重复调用只会挂一套监听，不会叠加。
 */
export function installUnlockOnFirstGesture(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (detachUnlockGesture) return detachUnlockGesture;
  const onGesture = (): void => {
    detach();
    gestureSeen = true;
    // 同步调用 play()：保持还在用户手势的调用栈里，绕开自动播放限制。
    startBgm();
    void unlockAudio();
  };
  const detach = (): void => {
    for (const type of GESTURES) window.removeEventListener(type, onGesture, true);
    if (detachUnlockGesture === detach) detachUnlockGesture = null;
  };
  for (const type of GESTURES) {
    // capture + passive：不拦截事件、不影响任何交互，只在冒泡前抢先解锁。
    window.addEventListener(type, onGesture, { capture: true, passive: true });
  }
  detachUnlockGesture = detach;
  return detach;
}

function getNoise(): AudioBuffer | null {
  if (!context) return null;
  if (noiseBuffer) return noiseBuffer;
  try {
    const length = Math.floor(context.sampleRate * 0.4);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 0x2f6e2b1;
    for (let i = 0; i < length; i += 1) {
      // 固定种子的伪随机白噪声：每次听到的纸声一致，不会像随机爆音。
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 0xffffffff) * 2 - 1;
    }
    noiseBuffer = buffer;
    return buffer;
  } catch {
    return null;
  }
}

interface ToneOptions {
  freq: number;
  endFreq?: number;
  duration: number;
  gain: number;
  type?: OscillatorType;
  delay?: number;
}

function tone(options: ToneOptions): void {
  if (!context || !master) return;
  const now = context.currentTime + (options.delay ?? 0);
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = options.type ?? 'sine';
  osc.frequency.setValueAtTime(Math.max(20, options.freq), now);
  if (options.endFreq && options.endFreq > 0 && options.endFreq !== options.freq) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, options.endFreq), now + options.duration);
  }
  // 快速起音 + 指数衰减：近距离、轻、不刺耳；衰减到 0.0001 而不是 0，避免指数斜坡报错。
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, options.gain), now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);
  osc.connect(gain);
  gain.connect(master);
  osc.start(now);
  osc.stop(now + options.duration + 0.02);
  // 结束后断开引用，避免长时间游玩累积节点。
  osc.onended = (): void => {
    try {
      osc.disconnect();
      gain.disconnect();
    } catch {
      /* ignore */
    }
  };
}

interface NoiseOptions {
  duration: number;
  gain: number;
  /** 带通中心频率。 */
  freq: number;
  q?: number;
  delay?: number;
  /** 起音后的频率滑移（模拟纸张摩擦方向）。 */
  endFreq?: number;
}

function noise(options: NoiseOptions): void {
  if (!context || !master) return;
  const buffer = getNoise();
  if (!buffer) return;
  const now = context.currentTime + (options.delay ?? 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  const filter = context.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(options.freq, now);
  if (options.endFreq && options.endFreq > 0) {
    filter.frequency.exponentialRampToValueAtTime(Math.max(80, options.endFreq), now + options.duration);
  }
  filter.Q.value = options.q ?? 0.9;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, options.gain), now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);
  source.connect(filter);
  filter.connect(gain);
  gain.connect(master);
  source.start(now);
  source.stop(now + options.duration + 0.02);
  source.onended = (): void => {
    try {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    } catch {
      /* ignore */
    }
  };
}

/**
 * 每个动作的音色。统一原则：短（≤0.3s）、近（中高频为主）、轻（峰值增益 ≤0.14），
 * 不用尖锐的高频长音，也不做夸张的拟音；纸/叶/木靠带通噪声，器物与提示靠正弦。
 */
function render(name: SoundName, gainScale: number, rate: number): void {
  const g = (value: number): number => value * gainScale;
  const r = (value: number): number => value * rate;
  switch (name) {
    // 取花：很轻的一下木质摩擦
    case 'pick':
      noise({ duration: 0.1, gain: g(0.085), freq: r(2100), q: 1.1, endFreq: r(1500) });
      break;
    // 放花：一声低而软的「落定」
    case 'place':
      tone({ freq: r(420), endFreq: r(260), duration: 0.17, gain: g(0.11), type: 'sine' });
      noise({ duration: 0.07, gain: g(0.035), freq: r(1200) });
      break;
    // 选中：几乎听不见的轻点
    case 'select':
      tone({ freq: r(880), endFreq: r(980), duration: 0.07, gain: g(0.05), type: 'sine' });
      break;
    // 移除：短促下行，不带惩罚感
    case 'remove':
      tone({ freq: r(260), endFreq: r(150), duration: 0.18, gain: g(0.085), type: 'triangle' });
      break;
    // 剪枝：一声短促的「咔」
    case 'snip':
      noise({ duration: 0.075, gain: g(0.13), freq: r(3200), q: 0.7, endFreq: r(1800) });
      tone({ freq: r(1500), endFreq: r(700), duration: 0.06, gain: g(0.07), type: 'square' });
      break;
    // 修叶：比剪枝更细、更轻
    case 'trim-leaf':
      noise({ duration: 0.1, gain: g(0.075), freq: r(2600), q: 1.4, endFreq: r(900) });
      break;
    // 去刺：几粒小刺落下
    case 'dethorn':
      for (let i = 0; i < 3; i += 1) {
        tone({
          freq: r(1400 + i * 180),
          endFreq: r(900 + i * 90),
          duration: 0.05,
          gain: g(0.045),
          type: 'triangle',
          delay: i * 0.045,
        });
      }
      break;
    // 翻瓣：一声柔软的舒展
    case 'flip':
      noise({ duration: 0.22, gain: g(0.07), freq: r(1700), q: 1.2, endFreq: r(600) });
      tone({ freq: r(520), endFreq: r(320), duration: 0.28, gain: g(0.045), type: 'sine' });
      break;
    // 裁花泥：海绵摩擦，短而闷
    case 'foam-cut':
      noise({ duration: 0.26, gain: g(0.11), freq: r(900), q: 0.8, endFreq: r(420) });
      break;
    // 放花泥：一声闷闷的压实声
    case 'foam-place':
      tone({ freq: r(180), endFreq: r(120), duration: 0.22, gain: g(0.1), type: 'sine' });
      noise({ duration: 0.14, gain: g(0.045), freq: r(500) });
      break;
    // 纸声 / 收口 / 丝带
    case 'paper':
      noise({ duration: 0.3, gain: g(0.09), freq: r(2400), q: 0.8, endFreq: r(1200) });
      break;
    case 'fold':
      noise({ duration: 0.24, gain: g(0.1), freq: r(1800), q: 0.7, endFreq: r(800) });
      break;
    case 'ribbon':
      noise({ duration: 0.2, gain: g(0.08), freq: r(3000), q: 1.6, endFreq: r(1600) });
      break;
    // 装饰：一颗轻亮的小挂饰
    case 'ornament':
      tone({ freq: r(1200), endFreq: r(1600), duration: 0.12, gain: g(0.055), type: 'sine' });
      break;
    // 快门与保存：保守地用轻声提示，不做夸张快门拟音
    case 'camera':
      tone({ freq: r(700), endFreq: r(420), duration: 0.09, gain: g(0.06), type: 'sine' });
      break;
    case 'save':
      tone({ freq: r(660), duration: 0.09, gain: g(0.045) });
      tone({ freq: r(990), duration: 0.12, gain: g(0.045), delay: 0.08 });
      break;
    // 失败：只给一个不刺耳的低提示，绝不冒充成功音
    case 'error':
      tone({ freq: r(300), endFreq: r(220), duration: 0.16, gain: g(0.06), type: 'triangle' });
      break;
    default:
      break;
  }
}

/**
 * 播放一个动作音。没有解锁 / 静音 / 不支持时直接返回，不抛错、不排队。
 * @param options.gain 额外增益倍率（批量动作整体压低）
 * @param options.rate 音高倍率（调用方主动变调）
 * @param options.minGapMs 同名音的最小间隔（默认 45ms，连续拖动限频）
 */
export function playSfx(
  name: SoundName,
  options?: { gain?: number; rate?: number; minGapMs?: number },
): void {
  stats.attempted += 1;
  // 未解锁 / 静音 / 音量为 0：静默，但仍记录事件（audible:false），便于验证。
  if (!context || prefs.muted || prefs.volume <= 0) {
    record(name, false);
    stats.suppressed += 1;
    return;
  }
  if (context.state !== 'running') {
    // 切后台挂起或浏览器中断：不排队、不补播；回到前台由 visibilitychange 恢复。
    record(name, false);
    stats.suppressed += 1;
    return;
  }
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const gap = options?.minGapMs ?? MIN_GAP_OVERRIDES[name] ?? DEFAULT_MIN_GAP_MS;
  // 连续拖动 / 批量循环：同名音限频；被挡下的不写事件，避免刷爆调试日志。
  // 不同名音不做全局间隔限制：像「拍下照片 → 存进相册」这类成对反馈需要两声都在，
  // 单音幅度本来就低（峰值增益 ≤0.14），叠加也不会爆音。
  if (name === lastPlayedName && now - lastPlayedSameAt < gap) {
    stats.throttled += 1;
    return;
  }
  lastPlayedName = name;
  lastPlayedSameAt = now;
  try {
    // 少量固定变体（±5% 音高 / ±9% 音量），重复同一动作不机械。
    const variantRate = 1 + (((stats.played * 37) % 9) - 4) * 0.012;
    const variantGain = 1 + (((stats.played * 53) % 7) - 3) * 0.03;
    const gain = Math.min(2, Math.max(0.1, (options?.gain ?? 1) * variantGain));
    const rate = Math.min(1.4, Math.max(0.7, (options?.rate ?? 1) * variantRate));
    render(name, gain, rate);
    record(name, true);
    stats.played += 1;
  } catch {
    // 合成失败（节点被关、上下文异常）只当没声音，不影响任何操作。
    record(name, false);
    stats.suppressed += 1;
  }
}

function record(name: SoundName, audible: boolean): void {
  played.push({
    name,
    at: typeof performance !== 'undefined' ? Math.round(performance.now()) : Date.now(),
    audible,
  });
  if (played.length > MAX_DEBUG_LOG) played = played.slice(-MAX_DEBUG_LOG);
}

/** 自动化验证入口：只读音频状态与最近播放记录。 */
export function getAudioDebug(): AudioDebugState {
  return {
    supported: supported(),
    unlocked,
    muted: prefs.muted,
    volume: prefs.volume,
    contextState: context?.state ?? 'none',
    played: [...played],
    stats: { ...stats },
    bgm: {
      supported: bgmSupported(),
      enabled: prefs.bgm,
      playing: bgmPlaying,
      paused: bgmEl ? bgmEl.paused : true,
      muted: bgmEl ? bgmEl.muted : prefs.muted,
      volume: bgmEl ? Math.round(bgmEl.volume * 1000) / 1000 : 0,
      currentTime: bgmEl ? Math.round(bgmEl.currentTime * 100) / 100 : 0,
      duration:
        bgmEl && Number.isFinite(bgmEl.duration) && bgmEl.duration > 0
          ? Math.round(bgmEl.duration * 100) / 100
          : 0,
      loop: bgmEl ? bgmEl.loop : false,
      track: bgmTrack,
      blocked: bgmBlocked,
      error: bgmError,
      hiddenPauses: bgmHiddenPauses,
      visibleResumes: bgmVisibleResumes,
    },
  };
}

export function resetAudioDebug(): void {
  played = [];
  lastPlayedName = null;
  lastPlayedSameAt = 0;
  stats = { attempted: 0, played: 0, suppressed: 0, throttled: 0 };
}

/**
 * 切后台：挂起音频上下文、暂停背景音乐；返回时恢复。
 * 不排队、不补播——挂起期间 playSfx 只记录 suppressed 事件，BGM 从暂停处继续。
 */
function onVisibilityChange(): void {
  if (document.hidden) {
    if (bgmEl && bgmPlaying) {
      bgmPausedForHidden = true;
      bgmHiddenPauses += 1;
      try {
        bgmEl.pause();
      } catch {
        /* ignore */
      }
    }
    if (context && context.state === 'running') {
      try {
        void context.suspend().catch(() => {});
      } catch {
        /* ignore */
      }
    }
    return;
  }
  // 回到前台：只在已经解锁过的情况下恢复，避免绕过「手势后才允许播放」。
  if (context && everUnlocked && context.state === 'suspended') {
    try {
      void context.resume().catch(() => {});
    } catch {
      /* ignore */
    }
  }
  // BGM 只恢复「因切后台暂停」的那一次；被用户关掉或播放失败的不自动打开。
  if (bgmPausedForHidden) {
    bgmPausedForHidden = false;
    bgmVisibleResumes += 1;
    startBgm();
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', onVisibilityChange);
}
