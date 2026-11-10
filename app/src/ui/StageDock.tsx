import { useState } from 'react';
import { useAppState } from '../state/useStore';
import { store } from '../state/store';
import { bouquetFileName, downloadBlob } from '../utils/download';
import {
  PACKAGE_STEP_INFO,
  goToStage,
  nextPackageStep,
  previousPackageStep,
  setPackageStep,
  startShowcase,
  stopShowcase,
  useShowcase,
  useStage,
  useWrapping,
} from './workflow';

interface Props {
  onExportPng: () => Promise<{ blob: Blob; width: number; height: number }>;
}

/**
 * 画面底部的阶段动作条：当前阶段只露出下一步该做的事，
 * 关键按钮都带文字，不靠图标猜。
 */
export function StageDock({ onExportPng }: Props): React.JSX.Element {
  const stage = useStage();
  const wrapping = useWrapping();
  const showcase = useShowcase();
  const stemCount = useAppState((state) => state.doc.stems.length);
  const [exporting, setExporting] = useState(false);

  const currentStep = PACKAGE_STEP_INFO.find((step) => step.id === wrapping.step) ?? PACKAGE_STEP_INFO[0];
  const next = nextPackageStep(wrapping.step);
  const prev = previousPackageStep(wrapping.step);

  const exportPng = async (): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    try {
      const result = await onExportPng();
      downloadBlob(result.blob, bouquetFileName('png'));
      store.toast(`PNG 已保存（${result.width}×${result.height}）`, 'success');
    } catch {
      store.toast('保存 PNG 失败了，再试一次吧', 'warn');
    } finally {
      setExporting(false);
    }
  };

  if (stage === 'arrange') {
    return (
      <div className="bottom-dock" data-testid="stage-dock">
        <div className="dock-copy">
          <b>{stemCount === 0 ? '先放几枝花' : '花摆得差不多了？'}</b>
          <span>{stemCount === 0 ? '从左边花材架拿一枝，拖到花束上' : '包纸、丝带和卡片都在包装这一步'}</span>
        </div>
        <button
          type="button"
          className="btn btn-primary dock-primary"
          data-testid="dock-to-wrap"
          onClick={() => goToStage('wrap')}
        >
          去包装 →
        </button>
      </div>
    );
  }

  if (stage === 'wrap') {
    return (
      <div className="bottom-dock" data-testid="stage-dock">
        <div className="dock-copy">
          <b>
            第 {currentStep.index}/{PACKAGE_STEP_INFO.length} 步 · {currentStep.label}
          </b>
          <span>{currentStep.hint}</span>
        </div>
        <button
          type="button"
          className="btn"
          data-testid="dock-step-prev"
          disabled={!prev}
          onClick={() => {
            if (prev) setPackageStep(prev);
          }}
        >
          上一步
        </button>
        <button
          type="button"
          className="btn btn-primary dock-primary"
          data-testid="dock-step-next"
          onClick={() => {
            if (next) setPackageStep(next);
            else goToStage('finish');
          }}
        >
          {next ? `下一步：${PACKAGE_STEP_INFO.find((step) => step.id === next)?.label ?? ''}` : '完成，看看成品 →'}
        </button>
      </div>
    );
  }

  return (
    <div className="bottom-dock dock-finish" data-testid="stage-dock">
      <div className="dock-copy">
        <b>{showcase ? '正在缓慢环绕' : '成品的尽头是再看一眼'}</b>
        <span>{showcase ? '拖动画面会停下来，也可以点停止' : '从这里看，花是最完整的'}</span>
      </div>
      <button
        type="button"
        className={`btn ${showcase ? 'is-on' : 'btn-primary'}`}
        data-testid="showcase-toggle"
        aria-pressed={showcase}
        onClick={() => {
          if (showcase) stopShowcase();
          else startShowcase();
        }}
      >
        {showcase ? '停止旋转' : '开始旋转欣赏'}
      </button>
      <button type="button" className="btn" data-testid="finish-back-arrange" onClick={() => goToStage('arrange')}>
        返回修改
      </button>
      <button type="button" className="btn" data-testid="finish-back-wrap" onClick={() => goToStage('wrap')}>
        回到包装
      </button>
      <button
        type="button"
        className="btn btn-primary dock-primary"
        data-testid="finish-export-png"
        disabled={exporting}
        onClick={() => void exportPng()}
      >
        {exporting ? '正在保存…' : '保存 PNG'}
      </button>
    </div>
  );
}
