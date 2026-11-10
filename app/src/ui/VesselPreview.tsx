/**
 * 包装 / 花器形态的小预览图。
 *
 * 优先用真实渲染截图：`app/public/assets/vessels/previews/<kind>.jpg`，
 * 由 `scripts/v13-package.mjs --previews` 在真实工作台里逐个形态截图生成
 * （同一株样束、同一个机位，只换呈现形式）。
 * 截图缺失时退回按器型特征手绘的 SVG 剪影——颜色取 VESSELS / PAPER_PRESETS，
 * 轮廓按细口 / 宽口 / 编织 / 礼盒 / 提手 / 木条区分，离线也能辨认。
 */
import { PAPER_PRESETS } from '../data/decor';
import { PRESENTATION_LABELS, VESSELS, type PresentationKind } from '../data/presentation';
import './package-panel.css';

export const PREVIEW_DIR = 'assets/vessels/previews';

/** 真实渲染截图路径；缺失时组件会退回 VesselGlyph。 */
export function vesselPreviewSrc(kind: PresentationKind): string {
  return `${PREVIEW_DIR}/${kind}.jpg`;
}

export function vesselPreviewAlt(kind: PresentationKind): string {
  return `${PRESENTATION_LABELS[kind]}预览`;
}

interface GlyphProps {
  kind: PresentationKind;
  className?: string;
}

/**
 * 器型剪影（16 个绘制单位对应约 1/4 面板宽，视口 0 0 64 64）。
 * 只用于预览兜底，不进 3D 场景。
 */
export function VesselGlyph({ kind, className }: GlyphProps): React.JSX.Element {
  const vessel = kind === 'paper' ? null : VESSELS[kind];
  const body = vessel ? vessel.color : PAPER_PRESETS.kraft.outer;
  const ink = 'rgba(58, 44, 32, 0.55)';
  const soft = 'rgba(255, 253, 246, 0.55)';
  const shapes = (): React.JSX.Element => {
    switch (kind) {
      case 'paper':
        return (
          <>
            <path d="M17 19 L47 16 L51 51 L14 54 Z" fill={body} />
            <path d="M24 20 L22 54 L14 54 L17 19 Z" fill="rgba(122, 92, 62, 0.22)" />
            <path d="M32 18 L34 53" stroke={ink} strokeWidth="0.8" fill="none" />
            <path d="M42 17.4 L44 52.4" stroke="rgba(255,253,246,0.5)" strokeWidth="0.8" fill="none" />
            <path d="M20 26 L48 23.4" stroke="rgba(90, 66, 44, 0.2)" strokeWidth="0.8" fill="none" />
            <ellipse cx="32" cy="57.4" rx="17" ry="2.2" fill="rgba(70, 52, 36, 0.14)" />
          </>
        );
      case 'vase':
        return (
          <>
            <path d="M26 18 H40 L38.4 29 L46 41 Q47 51 32 52 Q17 51 18 41 L25.6 29 Z" fill={body} />
            <ellipse cx="33" cy="18.4" rx="7" ry="2" fill={soft} stroke={ink} strokeWidth="0.7" />
            <path d="M25 36 Q32 40 41 36" stroke="rgba(70, 54, 38, 0.18)" strokeWidth="0.9" fill="none" />
            <ellipse cx="32" cy="54.6" rx="13" ry="2.2" fill="rgba(70, 52, 36, 0.14)" />
          </>
        );
      case 'pot':
        return (
          <>
            <path d="M19 24 H45 L42 49 Q41.6 54 32 54 Q22.4 54 22 49 Z" fill={body} />
            <rect x="16.6" y="20.4" width="30.8" height="5.6" rx="1.6" fill={body} stroke={ink} strokeWidth="0.8" />
            <path d="M22 30 Q32 33.4 42 30" stroke="rgba(72, 52, 34, 0.22)" strokeWidth="0.9" fill="none" />
            <path d="M25 30 L27.4 49" stroke="rgba(255,253,246,0.28)" strokeWidth="0.9" fill="none" />
            <ellipse cx="32" cy="56" rx="15" ry="2.2" fill="rgba(70, 52, 36, 0.14)" />
          </>
        );
      case 'basket':
        return (
          <>
            <path d="M17 30 H47 L43 52 Q42.6 55 38 55 H26 Q21.4 55 21 52 Z" fill={body} />
            <path d="M20 30 Q32 13 44 30" stroke={ink} strokeWidth="1.6" fill="none" />
            <path d="M19.6 36 H44.4 M20.6 42 H43.4 M21.6 48 H42.4" stroke="rgba(70, 50, 30, 0.3)" strokeWidth="0.9" fill="none" />
            <path d="M27 30 L25.4 54 M37 30 L38.6 54" stroke="rgba(70, 50, 30, 0.22)" strokeWidth="0.9" fill="none" />
            <rect x="16.4" y="28" width="31.2" height="2.8" rx="1.4" fill="rgba(255,253,246,0.38)" />
          </>
        );
      case 'box':
        return (
          <>
            <rect x="18" y="27" width="28" height="26" rx="1.6" fill={body} />
            <rect x="15.6" y="21.6" width="32.8" height="7.2" rx="1.6" fill={body} stroke={ink} strokeWidth="0.8" />
            <rect x="29.4" y="21.6" width="5.2" height="31.4" fill="rgba(255, 253, 246, 0.4)" />
            <path d="M32 21 Q22 13 24.4 20.6 Q27 23.4 32 21.4 Q37 23.4 39.6 20.6 Q42 13 32 21 Z" fill="rgba(255,253,246,0.72)" stroke={ink} strokeWidth="0.6" />
            <ellipse cx="32" cy="56" rx="15" ry="2.2" fill="rgba(70, 52, 36, 0.14)" />
          </>
        );
      case 'bucket':
        return (
          <>
            <path d="M24 22 H40 L37 50 Q36.6 55 32 55 Q27.4 55 27 50 Z" fill={body} />
            <ellipse cx="32" cy="22" rx="8" ry="2.2" fill={soft} stroke={ink} strokeWidth="0.7" />
            <path d="M25 22 Q32 10 39 22" stroke={ink} strokeWidth="1.4" fill="none" />
            <path d="M26.6 30 H37.4 M27.4 40 H36.6" stroke="rgba(255,253,246,0.34)" strokeWidth="1" fill="none" />
            <ellipse cx="32" cy="56.4" rx="11" ry="2" fill="rgba(70, 52, 36, 0.14)" />
          </>
        );
      case 'bag':
        return (
          <>
            <path d="M20 23 H44 L46.4 50 Q46.6 55 41 55 H23 Q17.4 55 17.6 50 Z" fill={body} />
            <rect x="19" y="20.6" width="26" height="4.4" rx="1.6" fill="rgba(255,253,246,0.4)" stroke={ink} strokeWidth="0.7" />
            <path d="M26 21 Q26 13.4 32 13.4 Q38 13.4 38 21" stroke={ink} strokeWidth="1.3" fill="none" />
            <path d="M23 32 H41 M23 40 H41" stroke="rgba(70, 50, 30, 0.18)" strokeWidth="0.9" fill="none" />
            <ellipse cx="32" cy="56.6" rx="15" ry="2" fill="rgba(70, 52, 36, 0.14)" />
          </>
        );
      case 'crate':
        return (
          <>
            <rect x="15.6" y="26.4" width="32.8" height="27" rx="1.4" fill={body} />
            <path d="M15.6 34 H48.4 M15.6 42 H48.4" stroke="rgba(70, 50, 30, 0.34)" strokeWidth="1.2" fill="none" />
            <path d="M16 26.4 L48 53.4 M48 26.4 L16 53.4" stroke="rgba(70, 50, 30, 0.16)" strokeWidth="1" fill="none" />
            <rect x="14.4" y="23.4" width="35.2" height="4.2" rx="1.4" fill="rgba(255,253,246,0.34)" stroke={ink} strokeWidth="0.7" />
            <ellipse cx="32" cy="56.4" rx="16" ry="2.2" fill="rgba(70, 52, 36, 0.14)" />
          </>
        );
      default:
        return <></>;
    }
  };
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      role="img"
      aria-label={vesselPreviewAlt(kind)}
      focusable="false"
    >
      {shapes()}
    </svg>
  );
}
