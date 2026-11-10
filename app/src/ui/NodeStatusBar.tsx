import { useEffect, useRef, useState } from 'react';
import { evaluateCommission, getCommission } from '../data/commissions';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';
import { CustomerPortrait } from './CustomerPortrait';
import {
  goToStage,
  STAGE_HINT,
  STAGE_LABEL,
  STAGE_ORDER,
  type WorkflowStage,
} from './workflow';
import './node-status-bar.css';

interface Props {
  stage: WorkflowStage;
  onOpenCommissions: () => void;
}

/**
 * 居中节点状态栏：把「三节点制作阶段」和「委托心愿」合并成一条状态栏。
 *
 * 上排是阶段节点（① 摆花 → ② 包装与花器 → ③ 拍照），下排是当前心愿：
 * 人物、来信标题、正在核对的一条要求与整体进度环；点「来信」展开完整来信。
 * 自由制作时只保留节点轨，状态栏收窄成一条小胶囊。
 */
export function NodeStatusBar({ stage, onOpenCommissions }: Props): React.JSX.Element {
  const mode = useAppState((state) => state.mode);
  const commissionId = useAppState((state) => state.commissionId);
  const deliveredAt = useAppState((state) => state.commissionDeliveredAt);
  const response = useAppState((state) => state.commissionResponse);
  const doc = useAppState((state) => state.doc);
  const catalog = useAppState((state) => state.catalog);
  const [expanded, setExpanded] = useState(false);
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLElement>(null);

  // 展开来信后：点状态栏以外或按 Esc 收起，避免浮层一直挡着画面。
  useEffect(() => {
    if (!expanded) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setExpanded(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [expanded]);

  const empty = doc.stems.length === 0;
  const def = getCommission(commissionId);
  const progress = mode === 'commission' && def ? evaluateCommission(doc, def, catalog) : null;
  const delivered = Boolean(deliveredAt);
  const current = progress ? cursor % progress.total : 0;
  const check = progress?.checks[current];
  const showWish = mode === 'commission' && def !== null && progress !== null;

  return (
    <section
      ref={rootRef}
      className="node-status-bar"
      data-mode={showWish ? 'commission' : 'free'}
      aria-label="制作进度与心愿"
      data-testid="node-status-bar"
    >
      <nav className="rail-nodes" aria-label="制作阶段" data-testid="stage-switch">
        {STAGE_ORDER.map((item, index) => {
          const active = item === stage;
          const done = index < STAGE_ORDER.indexOf(stage);
          const disabled = empty && item !== 'arrange';
          return (
            <div className="rail-node-wrap" key={item}>
              {index > 0 ? (
                <span
                  className="rail-node-line"
                  data-done={done || active ? 'true' : 'false'}
                  aria-hidden="true"
                />
              ) : null}
              <button
                type="button"
                className={`rail-node ${active ? 'is-on' : ''} ${done ? 'is-done' : ''}`}
                data-testid={`stage-${item}`}
                data-hint={STAGE_HINT[item]}
                disabled={disabled}
                aria-current={active ? 'step' : undefined}
                title={`${STAGE_LABEL[item]}：${STAGE_HINT[item]}`}
                onClick={() => {
                  if (!active) goToStage(item);
                }}
              >
                <span className="rail-node-num" aria-hidden="true">
                  {done ? '✓' : index + 1}
                </span>
                <span className="rail-node-name">{STAGE_LABEL[item]}</span>
              </button>
            </div>
          );
        })}
      </nav>

      {showWish ? (
        <div className="rail-wish" data-testid="commission-brief">
          <div className="rail-wish-line">
            <CustomerPortrait id={def.id} small />
            <button
              type="button"
              className="rail-wish-identity"
              aria-expanded={expanded}
              title={`${def.customer}的心愿：${def.title}`}
              onClick={() => setExpanded(!expanded)}
            >
              <span>{def.customer}的心愿</span>
              <strong>{def.title}</strong>
            </button>
            <div
              className="wish-ring"
              role="progressbar"
              aria-label="心愿完成进度"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.metCount}
            >
              <svg viewBox="0 0 40 40" aria-hidden="true">
                <circle cx="20" cy="20" r="17" />
                <circle
                  className="wish-ring-value"
                  cx="20"
                  cy="20"
                  r="17"
                  pathLength="100"
                  strokeDasharray={`${(progress.metCount / progress.total) * 100} 100`}
                />
              </svg>
              <span>
                {progress.metCount}/{progress.total}
              </span>
            </div>
            <button
              type="button"
              className="rail-expand"
              data-testid="commission-brief-toggle"
              aria-expanded={expanded}
              aria-label={expanded ? '收起完整来信' : '展开完整来信'}
              onClick={() => setExpanded(!expanded)}
            >
              来信
              <span aria-hidden="true">▾</span>
            </button>
          </div>

          <div className="rail-wish-line rail-wish-checkline">
            {delivered ? (
              <p className="rail-response" data-testid="commission-response" title={response ?? ''}>
                已交付 · 达成 {progress.metCount}/{progress.total} 条心愿
              </p>
            ) : (
              <>
                <button
                  type="button"
                  className="rail-arrow"
                  aria-label="上一条心愿"
                  onClick={() => setCursor((current + progress.total - 1) % progress.total)}
                >
                  ‹
                </button>
                <p
                  className="rail-check"
                  data-testid="commission-check"
                  data-met={String(Boolean(check?.met))}
                  title={`第 ${current + 1} 条要求，共 ${progress.total} 条`}
                >
                  <span className={check?.met ? 'is-met' : ''} aria-hidden="true">
                    {check?.met ? '✓' : '○'}
                  </span>
                  <span className="rail-check-text">{check?.label}</span>
                </p>
                <button
                  type="button"
                  className="rail-arrow"
                  aria-label="下一条心愿"
                  onClick={() => setCursor(current + 1)}
                >
                  ›
                </button>
              </>
            )}
          </div>

          {expanded ? (
            <div className="rail-letter" data-testid="commission-letter">
              <blockquote>{def.brief}</blockquote>
              {delivered && response ? (
                <p className="rail-letter-response" data-testid="commission-letter-response">
                  {response}
                </p>
              ) : null}
              <ul>
                {progress.checks.map((item) => (
                  <li key={item.id} data-met={String(item.met)}>
                    {item.met ? '✓' : '○'} {item.label}
                  </li>
                ))}
              </ul>
              <div className="rail-letter-actions">
                <button
                  type="button"
                  className="btn btn-small"
                  data-testid={delivered ? 'commission-next' : 'commission-switch'}
                  onClick={() => {
                    setExpanded(false);
                    onOpenCommissions();
                  }}
                >
                  看看其他心愿
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  data-testid="commission-leave"
                  onClick={() => {
                    setExpanded(false);
                    store.leaveCommission();
                  }}
                >
                  自由制作
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
