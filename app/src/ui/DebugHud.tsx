import { useEffect, useState, type RefObject } from 'react';
import type { BouquetScene } from '../three/BouquetScene';
import { useAppState } from '../state/useStore';

interface Props {
  sceneRef: RefObject<BouquetScene | null>;
}

interface Stats {
  fps: number;
  calls: number;
  triangles: number;
  stems: number;
}

const EMPTY_STATS: Stats = { fps: 0, calls: 0, triangles: 0, stems: 0 };

export function DebugHud({ sceneRef }: Props): React.JSX.Element | null {
  const visible = useAppState((state) => state.debugVisible);
  const stemCount = useAppState((state) => state.doc.stems.length);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);

  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => {
      const sceneStats = sceneRef.current?.getStats();
      if (sceneStats) setStats(sceneStats);
    }, 500);
    return () => clearInterval(timer);
  }, [visible, sceneRef]);

  if (!visible) return null;
  return (
    <div className="debug-hud" data-testid="debug-hud">
      <div className="debug-row">
        <span>FPS</span>
        <b>{stats.fps || '—'}</b>
      </div>
      <div className="debug-row">
        <span>枝数</span>
        <b>{stemCount}</b>
      </div>
      <div className="debug-row">
        <span>绘制</span>
        <b>{stats.calls}</b>
      </div>
      <div className="debug-row">
        <span>三角面</span>
        <b>{stats.triangles.toLocaleString('zh-CN')}</b>
      </div>
    </div>
  );
}
