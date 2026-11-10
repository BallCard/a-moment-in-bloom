import { PRESENTATION_LABELS } from '../data/presentation';
import { useAppState } from '../state/useStore';
import { DecorPanel } from './DecorPanel';
import { InspectorPanel } from './InspectorPanel';
import { OrganizePanel } from './OrganizePanel';
import { PACKAGE_STEP_INFO, useStage, type RightTab } from './workflow';
import './package-panel.css';

interface Props {
  tab: RightTab;
  onTabChange: (tab: RightTab) => void;
  onClose: () => void;
  onFocusSelected: () => void;
}

/**
 * 右栏只在需要时出现：选中花枝（调整）或进入包装（装饰 / 导入导出）。
 * 摆花且未选中时收起，把画面留给花束；可以手动关掉，再用右侧窄条打开。
 *
 * V13：顶部标题下保留一行阶段说明——包装阶段显示「第几步 / 在做什么」，
 * 花器分支显示花器的四件事，花枝调整显示当前在调哪一枝。
 */
export function RightPanel({ tab, onTabChange, onClose, onFocusSelected }: Props): React.JSX.Element {
  const stage = useStage();
  const kind = useAppState((state) => state.doc.presentation.kind);
  const step = useAppState((state) => state.doc.wrapping.step);
  const stemCount = useAppState((state) => state.doc.stems.length);
  const selected = useAppState((state) => state.selectedId !== null);
  const effectiveTab = stage === 'wrap' ? 'decor' : 'inspect';
  void tab; void onTabChange;
  const stepInfo = PACKAGE_STEP_INFO.find((item) => item.id === step) ?? PACKAGE_STEP_INFO[0];
  const subtitle =
    effectiveTab === 'decor'
      ? kind === 'paper'
        ? `第 ${stepInfo.index}/4 步 · ${stepInfo.label} —— ${stepInfo.hint}`
        : `花器插花 · ${PRESENTATION_LABELS[kind]} · 调插深、加装饰、写卡片`
      : selected
        ? '正在调选中的这一枝'
        : stemCount > 0
          ? '整束整理在这里；点一枝可以单独整理'
          : '还没有花，先在左边挑花材';
  return (
    <div className="right-stack">
      <div className="panel-tabs card right-panel-head" role="tablist" aria-label="右侧面板">
        <div className="right-panel-heading">
          <strong className="panel-tab">{effectiveTab === 'decor' ? '包装与花器' : '修剪与微调'}</strong>
          <span className="right-panel-sub" data-testid="right-panel-stage">
            {subtitle}
          </span>
        </div>
        <button
          type="button"
          className="panel-close"
          data-testid="right-panel-close"
          onClick={onClose}
          title="收起右侧面板"
          aria-label="收起右侧面板"
        >
          ×
        </button>
      </div>
      {effectiveTab === 'inspect' ? (
        selected ? (
          <InspectorPanel onFocusSelected={onFocusSelected} />
        ) : (
          /* V16 §3：没有选中单枝时，整理入口显示整束整理与容器花泥。 */
          <OrganizePanel />
        )
      ) : (
        <DecorPanel />
      )}
    </div>
  );
}
