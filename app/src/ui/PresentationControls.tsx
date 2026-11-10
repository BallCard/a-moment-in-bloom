import { useEffect } from 'react';
import { PRESENTATION_KINDS, PRESENTATION_LABELS, type PaperSheet } from '../data/presentation';
import { PAPER_IDS, PAPER_PRESETS } from '../data/decor';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';
import { VesselGlyph, vesselPreviewAlt, vesselPreviewSrc } from './VesselPreview';
import './package-panel.css';

/**
 * 包装 / 花器面板的第一层与纸片细节控件（V13 收敛）。
 *
 * 层级：先选呈现形式（`PresentationControls`）→ 再按包装步骤出对应控件
 * （`PaperPlacementControls` / `PaperFoldControls`）→ 卡片步骤只留祝福编辑，
 * 其余折叠进「还想调一调」（`DecorPanel` 负责）。
 */

type PaperSliderKey = 'width' | 'rotation' | 'height' | 'leftFold' | 'rightFold' | 'gather';

interface SliderSpec {
  key: PaperSliderKey;
  label: string;
  min: number;
  max: number;
  step: number;
}

/** 摆纸：纸口大小、转向、上下位置。 */
const POSE_SLIDERS: SliderSpec[] = [
  { key: 'width', label: '纸片大小', min: 0.7, max: 1.35, step: 0.01 },
  { key: 'rotation', label: '转向', min: -180, max: 180, step: 1 },
  { key: 'height', label: '上下位置', min: -0.1, max: 0.12, step: 0.005 },
];

/** 叠包：左右叠进来多少、握点收束程度。 */
const FOLD_SLIDERS: SliderSpec[] = [
  { key: 'leftFold', label: '左侧叠包', min: 0, max: 1, step: 0.02 },
  { key: 'rightFold', label: '右侧叠包', min: 0, max: 1, step: 0.02 },
  { key: 'gather', label: '握点收束', min: 0, max: 1, step: 0.02 },
];

/** 面板里选纸片与 3D 点纸片共用 store.selectedSheetId；没选时退回第一张。 */
function useActiveSheet(): PaperSheet {
  return useAppState(
    (state) => state.doc.presentation.sheets.find((sheet) => sheet.id === state.selectedSheetId) ?? state.doc.presentation.sheets[0],
  );
}

function formatValue(key: PaperSliderKey, value: number): string {
  if (key === 'rotation') return `${Math.round(value)}°`;
  if (key === 'height') return `${Math.round(value * 100)} cm`;
  return `${Math.round(value * 100)}%`;
}

/**
 * 第一层：呈现形式。8 项各带一张小预览图，点击先进入预览态（可取消），
 * 确认「采用这个形式」才写进作品，撤销依然是一条记录。
 */
export function PresentationControls(): React.JSX.Element {
  const kind = useAppState((state) => state.doc.presentation.kind);
  const pending = useAppState((state) => state.presentationPreview);
  // 面板被收起（卸载）时，未确认的换装预览要还原，避免作品停在预览态。
  useEffect(() => () => { if (store.getState().presentationPreview) store.cancelTransaction(); }, []);
  return (
    <section className="package-choice" aria-label="呈现形式" data-testid="presentation-controls">
      <div className="package-choice-head">
        <span className="package-choice-title">先选呈现形式</span>
        <span className="package-choice-hint" data-testid="presentation-choice-hint">
          {pending ? '这是预览，确认后才算改好' : '点一项先看效果'}
        </span>
      </div>
      <div className="package-choice-grid" role="group" aria-label="纸片包装与七种花器" data-testid="presentation-grid">
        {PRESENTATION_KINDS.map((item) => (
          <button
            type="button"
            key={item}
            className={`package-choice-item ${kind === item ? 'is-on' : ''}`}
            data-testid={`presentation-${item}`}
            aria-pressed={kind === item}
            title={`切换到${PRESENTATION_LABELS[item]}`}
            onClick={() => store.previewPresentation(item)}
          >
            <span className="package-choice-thumb">
              <VesselGlyph kind={item} className="package-choice-glyph" />
              <img
                className="package-choice-img"
                data-testid={`presentation-thumb-${item}`}
                src={vesselPreviewSrc(item)}
                alt={vesselPreviewAlt(item)}
                loading="lazy"
                draggable={false}
                onError={(event) => { event.currentTarget.hidden = true; }}
              />
            </span>
            <span className="package-choice-label">{PRESENTATION_LABELS[item]}</span>
          </button>
        ))}
      </div>
      {pending ? (
        <div className="presentation-confirm package-confirm" role="status" data-testid="presentation-confirm">
          <p>这是换装预览。确认后可一次撤销恢复原来的姿态。</p>
          <div className="package-confirm-actions">
            <button className="btn btn-primary" data-testid="confirm-presentation" onClick={() => store.endTransaction()}>
              采用这个形式
            </button>
            <button className="btn" data-testid="cancel-presentation" onClick={() => store.cancelTransaction()}>
              取消
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** 纸片列表 + 加一张 + 纸色。摆纸、叠包、折叠区都用它。 */
function PaperSheetStrip({ withColor = true }: { withColor?: boolean }): React.JSX.Element {
  const sheets = useAppState((state) => state.doc.presentation.sheets);
  const sheet = useActiveSheet();
  const pending = useAppState((state) => state.presentationPreview);
  const patch = (partial: Partial<PaperSheet>): void => store.updateSheet(sheet.id, partial);
  return (
    <>
      <div className="sheet-list package-sheet-list" data-testid="sheet-list" aria-label="纸片列表">
        {sheets.map((item, index) => (
          <button
            type="button"
            className={`package-sheet-chip ${item.id === sheet.id ? 'is-on' : ''}`}
            key={item.id}
            data-testid={`sheet-${index}`}
            onClick={() => store.selectSheet(item.id)}
          >
            <span className="package-sheet-dot" style={{ background: PAPER_PRESETS[item.paperId].outer }} />
            纸片 {index + 1}
          </button>
        ))}
        <button
          type="button"
          className="package-sheet-chip is-add"
          data-testid="add-sheet"
          disabled={pending || sheets.length >= 3}
          onClick={() => store.addSheet()}
        >
          ＋叠一张
        </button>
      </div>
      {withColor ? (
        <div className="paper-row package-paper-row" aria-label="纸色">
          {PAPER_IDS.map((id) => (
            <button
              type="button"
              key={id}
              className={`paper-dot ${sheet.paperId === id ? 'is-on' : ''}`}
              style={{ background: PAPER_PRESETS[id].outer }}
              aria-label={`${PAPER_PRESETS[id].label}纸片`}
              title={PAPER_PRESETS[id].label}
              data-testid={`sheet-color-${id}`}
              disabled={pending}
              onClick={() => { patch({ paperId: id }); store.endTransaction(); }}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

function PaperSlider({ spec }: { spec: SliderSpec }): React.JSX.Element {
  const sheet = useActiveSheet();
  const locked = sheet.fixed && ['width', 'rotation', 'height'].includes(spec.key);
  return (
    <label className="slider-row package-slider">
      <span className="slider-label">{spec.label}</span>
      <input
        type="range"
        aria-label={spec.label}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={sheet[spec.key]}
        disabled={locked}
        onChange={(event) => store.updateSheet(sheet.id, { [spec.key]: Number(event.target.value) })}
        onPointerUp={() => store.endTransaction()}
        onKeyUp={() => store.endTransaction()}
        onBlur={() => store.endTransaction()}
      />
      <span className="slider-value">{formatValue(spec.key, sheet[spec.key])}</span>
    </label>
  );
}

/** 摆纸步骤的主控件：挑纸色、选纸片、大小/转向/位置、固定与层级。 */
export function PaperPlacementControls(): React.JSX.Element {
  const sheet = useActiveSheet();
  const sheets = useAppState((state) => state.doc.presentation.sheets);
  const pending = useAppState((state) => state.presentationPreview);
  const enabled = useAppState((state) => state.doc.wrapping.enabled);
  return (
    <div className="package-block" data-testid="paper-controls" data-paper-branch="place">
      <div className="package-block-head">
        <span className="package-block-title">挑纸与摆纸</span>
        <span className="package-block-hint">先挑纸色，再调纸口</span>
      </div>
      <PaperSheetStrip />
      <div className="package-slider-stack">
        {POSE_SLIDERS.map((spec) => <PaperSlider key={spec.key} spec={spec} />)}
      </div>
      <div className="package-action-row">
        <button
          type="button"
          className="btn btn-small"
          data-testid="paper-fixed"
          disabled={pending}
          onClick={() => { store.updateSheet(sheet.id, { fixed: !sheet.fixed }); store.endTransaction(); }}
        >
          {sheet.fixed ? '解除固定' : '固定位置'}
        </button>
        <button
          type="button"
          className="btn btn-small"
          data-testid="paper-reorder"
          disabled={pending || sheets.length < 2}
          onClick={() => store.reorderSheet(sheet.id)}
        >
          移到外层
        </button>
        <button
          type="button"
          className="btn btn-small btn-danger"
          data-testid="paper-remove"
          disabled={pending || sheets.length < 2}
          onClick={() => store.removeSheet(sheet.id)}
        >
          移除纸片
        </button>
      </div>
      <button
        type="button"
        className="package-text-button"
        data-testid="toggle-wrap"
        disabled={pending}
        onClick={() => store.setWrappingEnabled(!enabled)}
      >
        {enabled ? '暂时隐藏纸片' : '显示纸片'}
      </button>
      <p className="decor-note">先摆纸，再进入「叠包」查看左右折叠。每张纸的位置和颜色都会保留。</p>
    </div>
  );
}

/** 叠包步骤的主控件：左右叠包与握点收束。 */
export function PaperFoldControls(): React.JSX.Element {
  const sheets = useAppState((state) => state.doc.presentation.sheets);
  const selectedSheetId = useAppState((state) => state.selectedSheetId);
  const index = Math.max(0, sheets.findIndex((item) => item.id === selectedSheetId));
  const cycle = (): void => {
    if (sheets.length < 2) return;
    const next = sheets[(index + 1) % sheets.length];
    store.selectSheet(next.id);
  };
  return (
    <div className="package-block" data-testid="paper-fold-controls" data-paper-branch="fold">
      <div className="package-block-head">
        <span className="package-block-title">合拢收口</span>
        <button type="button" className="package-text-button" data-testid="sheet-next" disabled={sheets.length < 2} onClick={cycle}>
          正在调 纸片 {index + 1} · 换一张
        </button>
      </div>
      <div className="package-slider-stack">
        {FOLD_SLIDERS.map((spec) => <PaperSlider key={spec.key} spec={spec} />)}
      </div>
      <p className="decor-note">纸张往内收，包住花茎。左右可以不一样多，收得太紧会露住花茎。</p>
    </div>
  );
}
