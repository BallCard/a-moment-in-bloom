/**
 * 统一「装饰」面板（V16 §5）。
 *
 * 读取 data/decor-capability 的能力表：只显示当前呈现形态真实支持的款式。
 * 交互照计划 §5：
 * - 先按四组（灯串 / 串饰 / 插饰 / 系结与吊饰）用缩略图选择款式，选中后才展开参数；
 * - 已添加的装饰列出来可以再选中编辑；
 * - 参数：位置 X/Y/Z 微调、旋转、大小、灯亮度、样式（variant）、颜色、移除；
 * - 换容器后能力表不支持的装饰不显示（store 切换时已经过滤，这里再兜一层）；
 * - 灯与饰件属于作品：写进 doc.ornaments，保存后随作品恢复。
 */

import { useEffect, useState } from 'react';
import { MAX_ORNAMENTS } from '../config';
import { decorCapability, ornamentKindsFor } from '../data/decor-capability';
import {
  ORNAMENT_COLORS,
  ORNAMENT_GROUP_HINT,
  ORNAMENT_GROUP_LABEL,
  ornamentColor,
  ornamentDef,
  type OrnamentGroup,
} from '../data/ornaments';
import type { OrnamentKind, Vec3 } from '../data/types';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';
import './decorations.css';

const GROUP_ORDER: OrnamentGroup[] = ['lights', 'strands', 'picks', 'ties'];

/** 一次点击的微调步长。 */
const POSITION_STEP = 0.02;
const ROTATION_STEP = 15;
const SCALE_STEP = 0.05;

/** 小图标：用最简单的 SVG 形状示意款式，不引入图片素材。 */
function DecorationGlyph({ kind }: { kind: OrnamentKind }): React.JSX.Element {
  const stroke = 'currentColor';
  switch (kind) {
    case 'light-string':
    case 'star-lights':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 8c4 6 14 6 18 0" fill="none" stroke={stroke} strokeWidth="1.1" strokeLinecap="round" />
          {[
            [5, 9.6],
            [8.4, 11.4],
            [12, 12.1],
            [15.6, 11.4],
            [19, 9.6],
          ].map(([x, y], index) =>
            kind === 'star-lights' ? (
              <path
                key={index}
                d={`M${x} ${y - 1.7}l.5 1.2 1.3.1-1 .8.3 1.3-1.1-.7-1.1.7.3-1.3-1-.8 1.3-.1z`}
                fill={stroke}
              />
            ) : (
              <circle key={index} cx={x} cy={y} r="1.1" fill={stroke} />
            ),
          )}
        </svg>
      );
    case 'pearl-strand':
    case 'silk-thread':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 3c1 6 0 12 2 18" fill="none" stroke={stroke} strokeWidth="0.9" strokeLinecap="round" />
          {[6, 9.5, 13, 16.5].map((y, index) => (
            <circle key={index} cx={index % 2 === 0 ? 8.6 : 10.4} cy={y} r={kind === 'pearl-strand' ? 1.2 : 0.7} fill={stroke} />
          ))}
        </svg>
      );
    case 'butterfly':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 12c-2-4-7-5-8-2s3 6 8 2z" fill={stroke} opacity="0.85" />
          <path d="M12 12c2-4 7-5 8-2s-3 6-8 2z" fill={stroke} opacity="0.85" />
          <path d="M12 12c-1.4 2-3 4.4-4.6 4.6M12 12c1.4 2 3 4.4 4.6 4.6" stroke={stroke} strokeWidth="1" fill="none" />
          <path d="M12 6.4v9.8" stroke={stroke} strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case 'star-pick':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3.5l2.3 5 5.4.5-4.1 3.6 1.2 5.3-4.8-2.9-4.8 2.9 1.2-5.3L4.3 9l5.4-.5z" fill={stroke} />
        </svg>
      );
    case 'heart-pick':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 20s-7-4.4-7-9.2C5 8 7 6.4 9.1 6.4c1.4 0 2.3.7 2.9 1.6.6-.9 1.5-1.6 2.9-1.6C17 6.4 19 8 19 10.8 19 15.6 12 20 12 20z" fill={stroke} />
        </svg>
      );
    case 'bow':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 12c-3-4-8-3-8 .6s5 4.2 8-.6z" fill={stroke} opacity="0.9" />
          <path d="M12 12c3-4 8-3 8 .6s-5 4.2-8-.6z" fill={stroke} opacity="0.9" />
          <circle cx="12" cy="12" r="1.7" fill={stroke} />
          <path d="M11.2 13.4c-1 2.2-2 3.6-3.4 5.1M12.8 13.4c1 2.2 2 3.6 3.4 5.1" stroke={stroke} strokeWidth="1.1" fill="none" strokeLinecap="round" />
        </svg>
      );
    case 'tag':
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2.5v3.2" stroke={stroke} strokeWidth="1" strokeLinecap="round" />
          <rect x="7.4" y="6.4" width="9.2" height="12.2" rx="1.6" fill="none" stroke={stroke} strokeWidth="1.2" />
          <path d="M9.6 10.4h4.8M9.6 13.2h4.8" stroke={stroke} strokeWidth="0.9" strokeLinecap="round" opacity="0.7" />
        </svg>
      );
  }
}

/**
 * 装饰面板：先按组挑款式（缩略图），再加进入参数编辑。
 * `compact` 给「还想调一调」这类窄位置用。
 */
export function DecorationsPanel({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const kind = useAppState((state) => state.doc.presentation.kind);
  const ornaments = useAppState((state) => state.doc.ornaments);
  const stemCount = useAppState((state) => state.doc.stems.length);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const allowed = ornamentKindsFor(kind);
  const capability = decorCapability(kind);
  const visible = ornaments.filter((item) => allowed.includes(item.kind));
  const selected = visible.find((item) => item.id === selectedId) ?? null;
  const full = visible.length >= MAX_ORNAMENTS;

  // 换容器后旧装饰可能已经不在允许列表里：选中项跟着失效，不留悬空编辑框。
  useEffect(() => {
    if (selectedId && !visible.some((item) => item.id === selectedId)) setSelectedId(null);
  }, [selectedId, visible]);

  const countOf = (target: OrnamentKind): number => visible.filter((item) => item.kind === target).length;

  const add = (target: OrnamentKind): void => {
    const id = store.addOrnament(target);
    if (id) setSelectedId(id);
  };

  const nudgePosition = (axis: 0 | 1 | 2, delta: number): void => {
    if (!selected) return;
    const next: Vec3 = [selected.position[0], selected.position[1], selected.position[2]];
    next[axis] = Math.round((next[axis] + delta) * 1000) / 1000;
    store.updateOrnament(selected.id, { position: next });
    store.endTransaction();
  };

  const nudgeRotation = (delta: number): void => {
    if (!selected) return;
    store.updateOrnament(selected.id, { rotation: selected.rotation + delta });
    store.endTransaction();
  };

  const nudgeScale = (delta: number): void => {
    if (!selected) return;
    store.updateOrnament(selected.id, { scale: Math.round((selected.scale + delta) * 100) / 100 });
    store.endTransaction();
  };

  const removeSelected = (): void => {
    if (!selected) return;
    store.removeOrnament(selected.id);
    setSelectedId(null);
  };

  const selectedDef = selected ? ornamentDef(selected.kind) : null;

  return (
    <section
      className={`package-block decorations-panel ${compact ? 'is-compact' : ''}`}
      data-testid="decorations-panel"
      aria-label="辅助装饰"
    >
      <div className="package-block-head">
        <span className="package-block-title">加一点装饰</span>
        <span className="package-block-hint" data-testid="decoration-count">
          已加 {visible.length} 件
        </span>
      </div>
      {capability.note ? (
        <p className="decor-note" data-testid="decoration-capability-note">
          {capability.note}
        </p>
      ) : null}

      {GROUP_ORDER.map((group) => {
        const kinds = allowed.filter((item) => ornamentDef(item).group === group);
        return (
          <div className="decoration-group" key={group} data-testid={`decoration-group-${group}`}>
            <div className="decoration-group-head">
              <span className="decoration-group-title">{ORNAMENT_GROUP_LABEL[group]}</span>
              <span className="decoration-group-hint">{ORNAMENT_GROUP_HINT[group]}</span>
            </div>
            {kinds.length === 0 ? (
              <p className="decor-note decoration-group-empty" data-testid={`decoration-group-empty-${group}`}>
                这一形态暂时没有合适的{ORNAMENT_GROUP_LABEL[group]}位置。
              </p>
            ) : (
              <div className="decoration-thumbs">
                {kinds.map((target) => {
                  const def = ornamentDef(target);
                  const maxed = countOf(target) >= def.max;
                  const disabled = stemCount === 0 || maxed || full;
                  return (
                    <button
                      type="button"
                      key={target}
                      className="decoration-thumb"
                      data-testid={`decoration-add-${target}`}
                      title={stemCount === 0 ? '先摆一点花，再添装饰' : maxed ? `「${def.label}」最多放 ${def.max} 个` : def.note}
                      disabled={disabled}
                      onClick={() => add(target)}
                    >
                      <span className="decoration-thumb-glyph">
                        <DecorationGlyph kind={target} />
                      </span>
                      <span className="decoration-thumb-label">{def.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <div className="decoration-list" data-testid="decoration-list" aria-label="已添加的装饰">
        {visible.length === 0 ? (
          <p className="decor-note" data-testid="decoration-empty">
            还没有装饰。挑一款试试；灯和饰件都属于这件作品，保存后会一起恢复。
          </p>
        ) : (
          visible.map((item, index) => {
            const def = ornamentDef(item.kind);
            return (
              <button
                type="button"
                key={item.id}
                className={`decoration-item ${item.id === selectedId ? 'is-on' : ''}`}
                data-testid={`decoration-item-${index}`}
                aria-pressed={item.id === selectedId}
                onClick={() => setSelectedId(item.id)}
              >
                <span className="decoration-item-dot" style={{ background: ornamentColor(item.colorId).color }} />
                <span className="decoration-item-label">{def.label}</span>
                <span className="decoration-item-sub">{def.variants[item.variant] ?? def.variants[0]}</span>
              </button>
            );
          })
        )}
      </div>

      {selected && selectedDef ? (
        <div className="decoration-editor" data-testid="decoration-editor">
          <div className="decoration-editor-head">
            <span className="decoration-editor-title">{selectedDef.label}</span>
            <button
              type="button"
              className="package-text-button"
              data-testid="decoration-remove"
              onClick={removeSelected}
            >
              移除这件
            </button>
          </div>
          <div className="decoration-params">
            {(['X', 'Y', 'Z'] as const).map((axis, index) => (
              <div className="decoration-param" key={axis}>
                <span className="decoration-param-label">位置 {axis}</span>
                <button
                  type="button"
                  className="decoration-step"
                  data-testid={`decoration-pos-${axis.toLowerCase()}-minus`}
                  aria-label={`位置 ${axis} 减少 2 厘米`}
                  onClick={() => nudgePosition(index as 0 | 1 | 2, -POSITION_STEP)}
                >
                  −
                </button>
                <span className="decoration-value" data-testid={`decoration-pos-${axis.toLowerCase()}-value`}>
                  {Math.round(selected.position[index] * 100)} cm
                </span>
                <button
                  type="button"
                  className="decoration-step"
                  data-testid={`decoration-pos-${axis.toLowerCase()}-plus`}
                  aria-label={`位置 ${axis} 增加 2 厘米`}
                  onClick={() => nudgePosition(index as 0 | 1 | 2, POSITION_STEP)}
                >
                  ＋
                </button>
              </div>
            ))}
            <div className="decoration-param">
              <span className="decoration-param-label">旋转</span>
              <button
                type="button"
                className="decoration-step"
                data-testid="decoration-rotate-minus"
                aria-label="向左转 15 度"
                onClick={() => nudgeRotation(-ROTATION_STEP)}
              >
                ↺
              </button>
              <span className="decoration-value" data-testid="decoration-rotate-value">
                {Math.round(selected.rotation)}°
              </span>
              <button
                type="button"
                className="decoration-step"
                data-testid="decoration-rotate-plus"
                aria-label="向右转 15 度"
                onClick={() => nudgeRotation(ROTATION_STEP)}
              >
                ↻
              </button>
            </div>
            <div className="decoration-param">
              <span className="decoration-param-label">大小</span>
              <button
                type="button"
                className="decoration-step"
                data-testid="decoration-scale-minus"
                aria-label="缩小"
                onClick={() => nudgeScale(-SCALE_STEP)}
              >
                −
              </button>
              <span className="decoration-value" data-testid="decoration-scale-value">
                {Math.round(selected.scale * 100)}%
              </span>
              <button
                type="button"
                className="decoration-step"
                data-testid="decoration-scale-plus"
                aria-label="放大"
                onClick={() => nudgeScale(SCALE_STEP)}
              >
                ＋
              </button>
            </div>
          </div>
          {selectedDef.dimmable ? (
            <label className="package-slider decoration-intensity">
              <span className="slider-label">亮度</span>
              <input
                type="range"
                aria-label="灯饰亮度"
                min={0}
                max={1}
                step={0.05}
                value={selected.intensity}
                data-testid="decoration-intensity"
                onChange={(event) => store.updateOrnament(selected.id, { intensity: Number(event.target.value) })}
                onPointerUp={() => store.endTransaction()}
                onKeyUp={() => store.endTransaction()}
                onBlur={() => store.endTransaction()}
              />
              <span className="decoration-value">{Math.round(selected.intensity * 100)}%</span>
            </label>
          ) : null}
          {selectedDef.variants.length > 1 ? (
            <div className="decoration-variants" role="group" aria-label="摆放样式">
              {selectedDef.variants.map((label, index) => (
                <button
                  type="button"
                  key={label}
                  className={`decoration-variant ${selected.variant === index ? 'is-on' : ''}`}
                  data-testid={`decoration-variant-${index}`}
                  onClick={() => {
                    store.updateOrnament(selected.id, { variant: index });
                    store.endTransaction();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : (
            <p className="decor-note">{selectedDef.variants[0]}</p>
          )}
          <div className="paper-row package-paper-row" aria-label="装饰颜色">
            {ORNAMENT_COLORS.map((color) => (
              <button
                type="button"
                key={color.id}
                className={`paper-dot ${selected.colorId === color.id ? 'is-on' : ''}`}
                style={{ background: color.color }}
                data-testid={`decoration-color-${color.id}`}
                aria-label={`${color.label}装饰`}
                title={color.label}
                onClick={() => {
                  store.updateOrnament(selected.id, { colorId: color.id });
                  store.endTransaction();
                }}
              />
            ))}
          </div>
          <p className="decor-note">
            位置以花束中心为原点（米），旋转是绕花束竖轴。每点一下都能撤销。
          </p>
        </div>
      ) : (
        <p className="decor-note" data-testid="decoration-hint">
          点上面任何一款加进来；加好后这里会出现位置、旋转、大小等微调。
        </p>
      )}
      {visible.length > 0 ? (
        <p className="decor-note" data-testid="decoration-saved-note">
          装饰写进作品，换拍照场景、保存后恢复都还在。
        </p>
      ) : null}
    </section>
  );
}
