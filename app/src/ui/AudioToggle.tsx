import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';
import './audio-toggle.css';

function SpeakerIcon({ muted }: { muted: boolean }): React.JSX.Element {
  return (
    <svg
      className="audio-icon"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4.5 9.5h3.2L12.5 5.6v12.8L7.7 14.5H4.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      {muted ? (
        <path
          d="M16.2 9.2l4.6 5.6M20.8 9.2l-4.6 5.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      ) : (
        <>
          <path
            d="M15.4 9.3a3.8 3.8 0 0 1 0 5.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path
            d="M18.2 7a7.3 7.3 0 0 1 0 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            opacity="0.7"
          />
        </>
      )}
    </svg>
  );
}

interface Anchor {
  top: number;
  right: number;
}

/**
 * 顶栏统一音频入口（V16 §6 / 音乐轮）：喇叭按钮 + 展开的音量滑杆 / 静音开关 /
 * 背景音乐开关。读写 `state.audio`；静音、音量与 BGM 开关由 store 持久化到本机设置
 * （不进作品）。BGM 本身是本地生成的氛围音乐（见 docs/v16-music-api-record.md），
 * 音量恒为 master × 0.35，开关只控制是否播放。
 *
 * 浮层用 portal 挂到 body：顶栏卡片有 backdrop-filter（形成层叠上下文），
 * 直接放在按钮里会被右侧面板盖住；portal + fixed 定位能稳定浮在面板之上。
 */
export function AudioToggle(): React.JSX.Element {
  const audio = useAppState((state) => state.audio);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const muteRef = useRef<HTMLButtonElement>(null);
  const percent = Math.round(audio.volume * 100);

  const measure = (): void => {
    const rect = toggleRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ top: Math.round(rect.bottom + 8), right: Math.max(8, Math.round(window.innerWidth - rect.right)) });
  };

  const toggle = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    measure();
    setOpen(true);
  };

  // 点空白或按 Esc 收起浮层；点浮层内部（含滑杆拖动）不收起。
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    const onResize = (): void => measure();
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    // 键盘打开时把焦点交给第一个控件，Tab / 方向键即可操作。
    muteRef.current?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const setVolume = (raw: string): void => {
    const value = Math.min(1, Math.max(0, Number(raw) / 100 || 0));
    // 静音状态下主动调高音量 = 想重新听见，顺手解除静音（同一次 setAudio，只播一次反馈）。
    store.setAudio({ volume: value, muted: audio.muted && value > 0 ? false : audio.muted });
  };

  const panel = open && anchor
    ? createPortal(
        <div
          className="audio-popover"
          ref={popoverRef}
          role="dialog"
          aria-label="声音与背景音乐设置"
          data-testid="audio-panel"
          style={{ top: anchor.top, right: anchor.right }}
        >
          <div className="audio-row">
            <span className="audio-title">声音</span>
            <button
              type="button"
              ref={muteRef}
              role="switch"
              aria-checked={!audio.muted}
              className={`audio-switch ${audio.muted ? '' : 'is-on'}`}
              data-testid="audio-mute"
              onClick={() => store.setAudio({ muted: !audio.muted })}
              title={audio.muted ? '点一下恢复声音' : '点一下静音（音效与背景音乐一起）'}
            >
              {audio.muted ? '已静音' : '开启'}
            </button>
          </div>
          <div className="audio-row audio-bgm-row">
            <span className="audio-title">背景音乐</span>
            <button
              type="button"
              role="switch"
              aria-checked={audio.bgm}
              className={`audio-switch ${audio.bgm ? 'is-on' : ''}`}
              data-testid="audio-bgm"
              onClick={() => store.setAudio({ bgm: !audio.bgm })}
              title={audio.bgm ? '点一下关闭背景音乐（动作音效保留）' : '点一下打开背景音乐'}
            >
              {audio.bgm ? '开启' : '关闭'}
            </button>
          </div>
          <label className="audio-row audio-slider-row">
            <span className="audio-title">音量</span>
            <input
              type="range"
              className="audio-slider"
              min="0"
              max="100"
              step="5"
              value={percent}
              data-testid="audio-volume"
              aria-label="音量"
              aria-valuetext={`${percent}%`}
              disabled={audio.muted}
              onChange={(event) => setVolume(event.target.value)}
            />
            <span className="audio-percent">{audio.muted ? '静音' : `${percent}%`}</span>
          </label>
          <p className="audio-note">
            {audio.muted
              ? '静音中：动作照常进行，背景音乐与音效都先不出声。'
              : audio.bgm
                ? '轻柔的合成动作音 + 本地生成的氛围音乐；第一次点击页面后响起。'
                : '背景音乐已关闭，动作音效保留。'}
          </p>
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="audio-control" ref={wrapRef}>
      <button
        type="button"
        ref={toggleRef}
        className={`btn audio-toggle ${audio.muted ? 'is-muted' : ''} ${open ? 'is-on' : ''}`}
        data-testid="audio-toggle"
        aria-label={audio.muted ? '声音已静音，打开声音与背景音乐设置' : `声音开启，音量 ${percent}%，打开声音与背景音乐设置`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={audio.muted ? '声音已静音' : `声音开启 · 音量 ${percent}%`}
        onClick={toggle}
      >
        <SpeakerIcon muted={audio.muted} />
      </button>
      {panel}
    </div>
  );
}
