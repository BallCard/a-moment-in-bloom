import { useState } from 'react';
import { MAX_STEMS } from '../config';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';
import { PalettePanel } from './PalettePanel';
import { StemList } from './StemList';
import type { WorkflowStage } from './workflow';
import './flower-shelf.css';

interface Props {
  stage: WorkflowStage;
}

type FlowerTab = 'palette' | 'stems';

/**
 * 「花材与花枝」合并面板。
 *
 * 花材架与花枝列表不再同时堆叠，而是用两个清楚的标签切换：
 * 「挑选花材」只看到花材架，「已有花枝」只看到花枝列表。
 * 整块还能收成窄把手，把画面让给花束本身。
 */
export function FlowerPanel({ stage }: Props): React.JSX.Element {
  const stemCount = useAppState((state) => state.doc.stems.length);
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<FlowerTab>('palette');

  if (collapsed) {
    return (
      <div className="flower-handle" data-testid="flower-panel-handle">
        <button
          type="button"
          className="flower-handle-btn"
          data-testid="flower-panel-expand"
          onClick={() => setCollapsed(false)}
          title="展开花材与花枝"
        >
          <span className="flower-handle-mark" aria-hidden="true">
            ✿
          </span>
          <span className="flower-handle-text">花材与花枝</span>
          <span className="panel-meta">{stemCount}</span>
        </button>
      </div>
    );
  }

  const activeTab: FlowerTab = stage === 'arrange' ? tab : 'stems';

  return (
    <section className="panel flower-panel" aria-label="花材与花枝" data-testid="flower-panel">
      <div className="panel-head">
        <h2>花材与花枝</h2>
        <span className="panel-meta">
          {stemCount}/{MAX_STEMS} 枝
        </span>
        {/* V16 §3：没有选中单枝时，也从这里进整束整理。 */}
        <button
          type="button"
          className="panel-meta-btn"
          data-testid="flower-organize"
          title="整束整理：处理枝脚、下部叶与可去的刺"
          onClick={() => store.requestEditor('organize')}
        >
          整理
        </button>
        <button
          type="button"
          className="panel-collapse"
          data-testid="flower-panel-collapse"
          onClick={() => setCollapsed(true)}
          title="收起面板，给花束让出画面"
        >
          收起
        </button>
      </div>

      <div className="flower-tabs" role="tablist" aria-label="花材与花枝视图">
        <button
          type="button"
          role="tab"
          className={`flower-tab ${activeTab === 'palette' ? 'is-on' : ''}`}
          data-testid="flower-tab-palette"
          aria-selected={activeTab === 'palette'}
          onClick={() => setTab('palette')}
        >
          挑选花材
        </button>
        <button
          type="button"
          role="tab"
          className={`flower-tab ${activeTab === 'stems' ? 'is-on' : ''}`}
          data-testid="flower-tab-stems"
          aria-selected={activeTab === 'stems'}
          onClick={() => setTab('stems')}
        >
          已有花枝
          <span className="flower-tab-count">{stemCount}</span>
        </button>
      </div>

      <div className="flower-body">
        {activeTab === 'palette' ? (
          <div className="flower-palette">
            <PalettePanel embedded />
          </div>
        ) : (
          <StemList embedded />
        )}
      </div>
    </section>
  );
}
