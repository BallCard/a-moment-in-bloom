import type { AssetKind } from '../data/types';

interface Props {
  family: string;
  kind: AssetKind;
  color: string;
}

/** 花材架上的小图标：按花材家族画一个简单轮廓。 */
export function AssetGlyph({ family, kind, color }: Props): React.JSX.Element {
  if (family.includes('rose')) {
    return (
      <svg viewBox="0 0 32 32" role="img" aria-hidden="true">
        <g>
          <circle cx="16" cy="17" r="9" fill={color} />
          <circle cx="16" cy="17" r="6" fill="#fff6ec" fillOpacity="0.42" />
          <circle cx="16" cy="17" r="3" fill={color} />
          <path d="M16 26c-1.6 3-1.2 4 0 5" stroke="#7c9169" strokeWidth="1.6" fill="none" />
        </g>
      </svg>
    );
  }
  if (kind === 'greenery' || family.includes('euca')) {
    return (
      <svg viewBox="0 0 32 32" role="img" aria-hidden="true">
        <path d="M16 28V10" stroke="#8d8768" strokeWidth="1.6" fill="none" />
        <ellipse cx="11" cy="12" rx="5" ry="3.2" fill={color} transform="rotate(-24 11 12)" />
        <ellipse cx="21.5" cy="10" rx="5" ry="3.2" fill={color} transform="rotate(20 21.5 10)" />
        <ellipse cx="11.5" cy="19" rx="5" ry="3.2" fill={color} transform="rotate(-14 11.5 19)" />
        <ellipse cx="21" cy="18" rx="4.4" ry="2.9" fill={color} transform="rotate(26 21 18)" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 32 32" role="img" aria-hidden="true">
      <path
        d="M16 6c3 0 5 2.6 5 5.2 0 5-2.4 9.8-5 11.8-2.6-2-5-6.8-5-11.8C11 8.6 13 6 16 6Z"
        fill={color}
      />
      <path d="M12 7c2.4 3.2 3.4 7.4 4 9.6M20 7c-2.4 3.2-3.4 7.4-4 9.6" stroke="#fff6ec" strokeOpacity="0.5" strokeWidth="1.2" fill="none" />
      <path d="M16 23v7" stroke="#7c9169" strokeWidth="1.6" fill="none" />
      <path d="M16 25c-3-2.4-5.4-2.4-7.4-1.4M16 27.5c3-2.4 5.4-2.4 7.4-1.4" stroke="#7c9169" strokeWidth="1.4" fill="none" />
    </svg>
  );
}
