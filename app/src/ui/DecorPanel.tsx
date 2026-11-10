import { useEffect, useRef, useState } from 'react';
import { CARD_FROM_MAX, CARD_MESSAGE_MAX, CARD_TO_MAX } from '../config';
import { supportsRibbon } from '../data/decor-capability';
import { RIBBON_COLOR_IDS, RIBBON_PRESETS } from '../data/decor';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';
import { CardAssist } from './CardAssist';
import { DecorationsPanel } from './DecorationsPanel';
import { PaperFoldControls, PaperPlacementControls, PresentationControls } from './PresentationControls';
import './package-panel.css';

/** 纸片包装的四个步骤；花器分支不显示这排步骤。步骤 id 保持 'ribbon' 兼容旧存档。 */
const PACKAGE_STEPS = [
  ['paper', '摆纸'],
  ['fold', '叠包'],
  ['ribbon', '装饰'],
  ['card', '卡片'],
] as const;

/** 写卡片：收件人 / 正文 / 署名，字数按 Unicode 字符算。 */
function CardBlock({
  messageRef,
  blockRef,
  focused,
  compact = false,
}: {
  messageRef: React.RefObject<HTMLTextAreaElement | null>;
  blockRef: React.RefObject<HTMLDivElement | null>;
  focused: boolean;
  compact?: boolean;
}): React.JSX.Element {
  const card = useAppState((state) => state.doc.card);
  const fields = [
    { key: 'to', label: '收件人', max: CARD_TO_MAX, rows: 1 },
    { key: 'message', label: '正文', max: CARD_MESSAGE_MAX, rows: 3 },
    { key: 'from', label: '署名', max: CARD_FROM_MAX, rows: 1 },
  ] as const;
  return (
    <div
      className={`package-block card-editor package-card ${focused ? 'is-focus' : ''} ${compact ? 'is-compact' : ''}`}
      data-testid="card-editor"
      ref={blockRef}
    >
      <div className="package-block-head">
        <span className="package-block-title">写一句祝福</span>
        <span className="package-block-hint">会印在贺卡上</span>
      </div>
      {focused && !compact ? (
        <p className="package-card-lead" data-testid="card-focus-note">
          最后一步只差这张小卡片：写下收件人、正文和署名。
        </p>
      ) : null}
      {fields.map((field) => (
        <label className="field-row field-column" key={field.key}>
          <span className="field-label">
            <span>{field.label}</span>
            <span className="package-card-count">
              {Array.from(card[field.key]).length}/{field.max}
            </span>
          </span>
          <textarea
            ref={field.key === 'message' ? messageRef : undefined}
            rows={field.rows}
            value={card[field.key]}
            maxLength={field.max}
            placeholder={field.key === 'message' ? '想对 TA 说的话…' : field.key === 'to' ? '写给谁' : '你的名字'}
            data-testid={`card-${field.key}`}
            onFocus={() => store.beginTransaction()}
            onBlur={() => store.endTransaction()}
            onChange={(event) => store.updateCardFieldTransient(field.key, event.target.value)}
          />
        </label>
      ))}
      <CardAssist />
    </div>
  );
}

/** 丝带挑色；只在该形态真的支持可编辑丝带时出现（见 data/decor-capability）。 */
function RibbonBlock({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const colorId = useAppState((state) => state.doc.ribbon.colorId);
  const pending = useAppState((state) => state.presentationPreview);
  return (
    <div className={`package-block package-ribbon ${compact ? 'is-compact' : ''}`} data-testid="ribbon-block">
      <div className="package-block-head">
        <span className="package-block-title">系一条丝带</span>
        <span className="package-block-hint">{RIBBON_PRESETS[colorId].label}</span>
      </div>
      <div className="paper-row package-paper-row" aria-label="丝带颜色">
        {RIBBON_COLOR_IDS.map((id) => (
          <button
            type="button"
            key={id}
            className={`paper-dot ${colorId === id ? 'is-on' : ''}`}
            style={{ background: RIBBON_PRESETS[id].color }}
            data-testid={`ribbon-${id}`}
            aria-label={`${RIBBON_PRESETS[id].label}丝带`}
            title={RIBBON_PRESETS[id].label}
            disabled={pending}
            onClick={() => store.setRibbonColor(id)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 花器分支：只留插花相关控件（插深 / 剪短、丝带、卡片），不出现纸片专属设置。
 * 插深与剪短分别作用在选中的那一枝上，一次点击一条撤销。
 */
function VesselBlock({ blockRef }: { blockRef: React.RefObject<HTMLDivElement | null> }): React.JSX.Element {
  const doc = useAppState((state) => state.doc);
  const entries = useAppState((state) => state.catalog.entriesById);
  const selectedId = useAppState((state) => state.selectedId);
  const pending = useAppState((state) => state.presentationPreview);
  const stem = doc.stems.find((item) => item.id === selectedId) ?? null;
  const entry = stem ? entries[stem.assetId] : undefined;
  const trimmable = Boolean(entry && ['rose', 'tulip'].includes(entry.family));
  // 器口约束会把插深压到下限：已经到底时明确禁用，而不是点一下没反应。
  const atFloor = Boolean(stem && stem.pose.height <= -0.0095);
  return (
    <div className="package-block package-vessel is-focus" data-testid="vessel-block" ref={blockRef}>
      <div className="package-block-head">
        <span className="package-block-title">插花调整</span>
        <span className="package-block-hint">插深 / 剪短</span>
      </div>
      <p className="decor-note" data-testid="vessel-note">
        花枝分散支撑在器口内。插深与剪短分别调整，容器里的花茎不必露出。
      </p>
      {stem ? (
        <div className="package-vessel-stem">
          <span className="package-vessel-name" data-testid="vessel-selected">
            {entry?.displayName ?? '选中的花枝'}
          </span>
          <div className="package-action-row">
            <button
              type="button"
              className="btn btn-small"
              data-testid="vessel-deepen"
              disabled={pending || atFloor}
              title={atFloor ? '这枝已经插到器底了' : '花头再往下 1 cm'}
              onClick={() => store.nudgeSelected({ height: -0.01 })}
            >
              再插深 1 cm
            </button>
            <button
              type="button"
              className="btn btn-small"
              data-testid="vessel-raise"
              disabled={pending}
              title="花头再往上 1 cm"
              onClick={() => store.nudgeSelected({ height: 0.01 })}
            >
              拔高 1 cm
            </button>
            <button
              type="button"
              className="btn btn-small"
              data-testid="vessel-trim"
              disabled={pending || !trimmable || stem.preparation.tailLength <= 0.1001}
              onClick={() => store.trimStem(stem.id)}
            >
              剪短 2 cm
            </button>
          </div>
          <p className="decor-note">
            握点下余茎 {Math.round(stem.preparation.tailLength * 100)} cm
            {trimmable ? ' · 剪短保留花头大小' : ' · 这枝暂不支持单枝修剪'}
          </p>
        </div>
      ) : (
        <p className="decor-note package-vessel-pick">点一下画面里的花枝，就能单独调它的插深或剪短。</p>
      )}
      {pending ? <p className="decor-note">预览期间先不调整，确认采用或取消后即可继续。</p> : null}
    </div>
  );
}

/**
 * 包装阶段右栏（V13 收敛，V16 扩为「装饰」）。
 *
 * 层级：
 * 1. 先选呈现形式（8 项小预览图）；
 * 2. 纸片包装按「摆纸 → 叠包 → 装饰 → 卡片」逐步出控件，不同步骤不互相摊开；
 *    「装饰」一步 = 能力表允许的丝带（纸包才有）+ 四组辅助装饰；
 * 3. 卡片步骤只突出祝福编辑（含常用短语 / AI 润色），其余折叠进「还想调一调」；
 * 4. 花器只出插深/剪短、装饰、卡片；不为没有挂点的形态画无效丝带控件。
 */
export function DecorPanel(): React.JSX.Element {
  const doc = useAppState((state) => state.doc);
  const paper = doc.presentation.kind === 'paper';
  const ribbon = supportsRibbon(doc.presentation.kind);
  const step = doc.wrapping.step;
  const pending = useAppState((state) => state.presentationPreview);
  const editorTarget = useAppState((state) => state.editorRequest?.target ?? null);
  const editorNonce = useAppState((state) => state.editorRequest?.nonce ?? 0);
  const messageRef = useRef<HTMLTextAreaElement | null>(null);
  const cardBlockRef = useRef<HTMLDivElement | null>(null);
  const vesselBlockRef = useRef<HTMLDivElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // 点 3D 贺卡时临时把祝福编辑提为主内容；用户换步骤后交还给步骤本身。
  const [cardForce, setCardForce] = useState(false);

  // 卡片是当前步骤或用户点了 3D 贺卡时，祝福编辑是主内容（不折进 details）。
  const cardMain = !paper || step === 'card' || (editorTarget === 'card' && cardForce);
  // 纸片/丝带折叠区：卡片为主时收纳其余控件；丝带步骤也把纸片细节收在这里。
  const moreVisible = paper && (cardMain || step === 'ribbon');

  // 点 3D 贺卡进来时定位正文输入框；只是展开，不改包装进度。
  useEffect(() => {
    if (editorTarget !== 'card') return;
    cardBlockRef.current?.scrollIntoView({ block: 'nearest' });
    messageRef.current?.focus();
  }, [editorTarget, editorNonce]);

  // 换步骤时把「还想调一调」收回去、把 3D 贺卡带来的临时聚焦交还步骤：
  // 每一步只看这一步该看的东西。
  useEffect(() => {
    setMoreOpen(false);
    setCardForce(false);
  }, [step]);

  // 点 3D 贺卡 → 祝福编辑提为主内容；点纸片/花器 → 不再霸占主内容。
  useEffect(() => {
    if (editorTarget === 'card') setCardForce(true);
    else if (editorTarget) setCardForce(false);
  }, [editorTarget, editorNonce]);

  // 点 3D 纸片进来时（target 为 wrapping），若它被折进「还想调一调」，自动展开那一块。
  useEffect(() => {
    if (editorTarget === 'wrapping' && moreVisible) setMoreOpen(true);
  }, [editorTarget, editorNonce, moreVisible]);

  useEffect(() => {
    if (editorTarget === 'vessel') vesselBlockRef.current?.scrollIntoView({ block: 'nearest' });
  }, [editorTarget, editorNonce]);

  const moreBody = (
    <div className="package-more-body">
      <PaperPlacementControls />
      <PaperFoldControls />
      {step === 'ribbon' && !cardMain ? null : ribbon ? <RibbonBlock compact /> : null}
      {cardMain ? null : <CardBlock messageRef={messageRef} blockRef={cardBlockRef} focused={false} compact />}
      <p className="decor-note">纸片、丝带和装饰都还在，随时改；改完再确认也能一次撤销。</p>
    </div>
  );

  return (
    <section className="panel decor-panel package-panel" data-testid="decor-panel" aria-label="包装与花器">
      <PresentationControls />
      <fieldset className="package-fields" disabled={pending}>
        {paper ? (
          <nav className="package-steps" aria-label="包装步骤">
            {PACKAGE_STEPS.map(([id, label], index) => (
              <button
                type="button"
                key={id}
                className={`package-step-chip ${step === id ? 'is-on' : ''}`}
                data-testid={`package-step-${id}`}
                aria-current={step === id ? 'step' : undefined}
                onClick={() => {
                  store.setPackageStep(id);
                  if (id === 'card') store.requestEditor('card');
                }}
              >
                <span className="package-step-index">{index + 1}</span>
                <span className="package-step-label">{label}</span>
              </button>
            ))}
          </nav>
        ) : (
          <p className="package-flow" data-testid="vessel-flow">
            花器插花：调插深 / 剪短 → 加装饰 → 写卡片
          </p>
        )}
        <div className="package-body">
          {!paper ? (
            <>
              <VesselBlock blockRef={vesselBlockRef} />
              {/* 能力表声明没有可编辑丝带的形态不画这套控件，避免「有按钮没效果」。 */}
              {ribbon ? <RibbonBlock /> : null}
              <DecorationsPanel />
              <CardBlock messageRef={messageRef} blockRef={cardBlockRef} focused={false} />
            </>
          ) : cardMain ? (
            <CardBlock messageRef={messageRef} blockRef={cardBlockRef} focused={step === 'card' || editorTarget === 'card'} />
          ) : step === 'paper' ? (
            <PaperPlacementControls />
          ) : step === 'fold' ? (
            <PaperFoldControls />
          ) : (
            <div className="package-decor-step" data-testid="package-decor-step">
              {ribbon ? <RibbonBlock /> : null}
              <DecorationsPanel />
            </div>
          )}
          {moreVisible ? (
            <details
              className="package-more"
              data-testid="package-more"
              open={moreOpen}
              onToggle={(event) => setMoreOpen(event.currentTarget.open)}
            >
              <summary data-testid="package-more-toggle">还想调一调</summary>
              {moreBody}
            </details>
          ) : null}
        </div>
      </fieldset>
    </section>
  );
}
