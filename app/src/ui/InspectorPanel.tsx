import { useEffect, useRef } from 'react';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';
import type { StemPose } from '../data/types';
import { OrganizePanel } from './OrganizePanel';
import { nudgeSelected } from './workflow';

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  testId: string;
  onValue: (value: number) => void;
}

/**
 * 滑杆：按下时开一个可撤销事务，松开才写进撤销栈，
 * 这样连续拖动只算一次操作。
 */
function SliderRow({ label, value, min, max, step, display, testId, onValue }: SliderProps): React.JSX.Element {
  const active = useRef(false);

  const begin = (): void => {
    if (active.current) return;
    active.current = true;
    store.beginTransaction();
  };
  const end = (): void => {
    if (!active.current) return;
    active.current = false;
    store.endTransaction();
  };

  useEffect(() => {
    const finish = (): void => end();
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    // end 只依赖 ref 和全局 store，挂载一次即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <label className="slider-row">
      <span className="slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        data-testid={testId}
        onPointerDown={begin}
        onChange={(event) => onValue(Number(event.target.value))}
        onKeyDown={begin}
        onKeyUp={end}
        onBlur={end}
      />
      <span className="slider-value">{display}</span>
    </label>
  );
}

const formatSignedCm = (meters: number): string => {
  const cm = Math.round(meters * 100);
  return `${cm > 0 ? '+' : ''}${cm} cm`;
};

interface Props {
  onFocusSelected: () => void;
}

export function InspectorPanel({ onFocusSelected }: Props): React.JSX.Element {
  // 离开面板时结束「在花枝上修剪」模式，避免下一次选中还停在修剪态。
  useEffect(()=>()=>store.setTrimMode(false),[]);
  const stem = useAppState(
    (state) => state.doc.stems.find((item) => item.id === state.selectedId) ?? null,
  );
  const stems = useAppState((state) => state.doc.stems);
  const catalog = useAppState((state) => state.catalog);

  if (!stem) {
    return (
      <section className="panel inspector" aria-label="花枝调整" data-testid="inspector">
        <div className="panel-head">
          <h2>这枝花</h2>
        </div>
        <p className="panel-empty">点工作台里的花，或在左边花枝列表里点一下，就能调整它。</p>
        <div className="tips">
          <p>拖动空白处转视角，滚轮缩放。</p>
          <p>拖动花枝换方向；选中后花头旁边会出现小工具条。</p>
          <p>先点花材架，再点工作台，可以继续加花。</p>
          <p>Esc 取消 · Ctrl+Z 撤销 · 最多 20 枝</p>
        </div>
      <details className="shortcut-help"><summary>快捷键</summary>Ctrl + 滚轮：缩放选中花枝<br/>Shift：精细缩放<br/>Ctrl + D：复制 · Delete：删除<br/>1–4：切换视角 · F：对准选中<br/>Home：复位视角 · Ctrl + Z：撤销</details>
    </section>
    );
  }

  const entry = catalog.entriesById[stem.assetId];
  const index = stems.findIndex((item) => item.id === stem.id) + 1;
  const displayName = entry?.displayName ?? stem.assetId;
  const updatePose = (key: keyof StemPose) => (value: number) => {
    store.updateStemPoseTransient(stem.id, { [key]: value });
  };

  return (
    <section className="panel inspector" aria-label="花枝调整" data-testid="inspector">
      <div className="panel-head">
        <h2>这枝花</h2>
        <span className="panel-meta">第 {index} 枝</span>
      </div>

      <div className="inspector-title">
        {entry ? <span className="swatch" style={{ background: entry.color }} /> : null}
        <strong>{displayName}</strong>
      </div>
      <p className="inspector-sub">
        {entry
          ? `${entry.familyName} · ${entry.variantName}`
          : '这件花材不在当前清单里，先用占位花显示'}
      </p>

      <div className="nudge-block">
        {/* V16 §3：统一的整理入口（翻瓣 / 去刺 / 修枝修叶 / 一键整理这枝）。 */}
        <OrganizePanel dense />
        <div className="nudge-head">
          <span>快捷微调</span>
          <span className="nudge-hint">一次一点，可撤销</span>
        </div>
        <div className="nudge-grid">
          <button type="button" className="btn btn-nudge" data-testid="nudge-height-up" onClick={() => nudgeSelected({ height: 0.01 })} title="高低 +1cm">
            高 +1
          </button>
          <button type="button" className="btn btn-nudge" data-testid="nudge-height-down" onClick={() => nudgeSelected({ height: -0.01 })} title="高低 −1cm">
            高 −1
          </button>
          <button type="button" className="btn btn-nudge" data-testid="nudge-tilt-up" onClick={() => nudgeSelected({ tilt: 2 })} title="倾斜 +2°">
            倾 +2°
          </button>
          <button type="button" className="btn btn-nudge" data-testid="nudge-tilt-down" onClick={() => nudgeSelected({ tilt: -2 })} title="倾斜 −2°">
            倾 −2°
          </button>
          <button type="button" className="btn btn-nudge" data-testid="nudge-direction-left" onClick={() => nudgeSelected({ direction: -10 })} title="朝左换向 10°">
            左 10°
          </button>
          <button type="button" className="btn btn-nudge" data-testid="nudge-direction-right" onClick={() => nudgeSelected({ direction: 10 })} title="朝右换向 10°">
            右 10°
          </button>
        </div>
      </div>

      <SliderRow
        label="高低"
        value={stem.pose.height}
        min={-0.05}
        max={0.2}
        step={0.005}
        display={formatSignedCm(stem.pose.height)}
        testId="slider-height"
        onValue={updatePose('height')}
      />
      <SliderRow
        label="倾斜"
        value={stem.pose.tilt}
        min={0}
        max={55}
        step={1}
        display={`${Math.round(stem.pose.tilt)}°`}
        testId="slider-tilt"
        onValue={updatePose('tilt')}
      />
      <SliderRow
        label="方向"
        value={stem.pose.direction}
        min={0}
        max={360}
        step={1}
        display={`${Math.round(stem.pose.direction)}°`}
        testId="slider-direction"
        onValue={updatePose('direction')}
      />
      <SliderRow
        label="自转"
        value={stem.pose.spin}
        min={0}
        max={360}
        step={1}
        display={`${Math.round(stem.pose.spin)}°`}
        testId="slider-spin"
        onValue={updatePose('spin')}
      />
      <SliderRow
        label="大小"
        value={stem.scale}
        min={0.85}
        max={1.15}
        step={0.01}
        display={`${Math.round(stem.scale * 100)}%`}
        testId="slider-scale"
        onValue={(value) => store.updateStemScaleTransient(stem.id, value)}
      />

      <div className="inspector-actions">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="duplicate-stem"
          onClick={() => store.duplicateStem(stem.id)}
        >
          复制一枝
        </button>
        <button
          type="button"
          className="btn btn-danger"
          data-testid="delete-stem"
          onClick={() => store.deleteStem(stem.id)}
        >
          删除这枝
        </button>
      </div>
      <button
        type="button"
        className="btn btn-small focus-button"
        data-testid="focus-selected"
        onClick={onFocusSelected}
        title="把镜头稍微推近这枝花"
      >
        对准这枝看看
      </button>
    <details className="shortcut-help"><summary>快捷键</summary>Ctrl + 滚轮：缩放选中花枝<br/>Shift：精细缩放<br/>Ctrl + D：复制 · Delete：删除<br/>1–4：切换视角 · F：对准选中<br/>Home：复位视角 · Ctrl + Z：撤销</details>
    </section>
  );
}
