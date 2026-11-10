import { PACKAGE_STEP_INFO, goToStage, packageStepIndex, setPackageStep, useWrapping } from './workflow';
import { useAppState } from '../state/useStore';

/**
 * 包装阶段左栏：整束包装走到哪一步一目了然，随时能点回去改。
 * 具体纸色、丝带、卡片在右栏「包装与成品」里操作。
 */
export function PackageRail(): React.JSX.Element {
  const wrapping = useWrapping();
  const stemCount = useAppState((state) => state.doc.stems.length);
  const currentIndex = packageStepIndex(wrapping.step);

  return (
    <section className="panel wrap-rail" aria-label="包装进度" data-testid="wrap-rail">
      <div className="panel-head">
        <h2>包装进度</h2>
        <span className="panel-meta">{stemCount} 枝</span>
      </div>

      <ol className="rail-steps">
        {PACKAGE_STEP_INFO.map((step) => {
          const state = !wrapping.enabled
            ? 'is-idle'
            : step.index === currentIndex
              ? 'is-current'
              : step.index < currentIndex
                ? 'is-done'
                : 'is-ahead';
          return (
            <li key={step.id}>
              <button
                type="button"
                className={`rail-step ${state}`}
                data-testid={`rail-step-${step.id}`}
                aria-current={state === 'is-current' ? 'step' : undefined}
                onClick={() => setPackageStep(step.id)}
              >
                <span className="rail-num" aria-hidden="true">
                  {state === 'is-done' ? '✓' : step.index}
                </span>
                <span className="rail-text">
                  <b>{step.label}</b>
                  <em>{step.hint}</em>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <p className="rail-note">
        {wrapping.enabled
          ? '纸口、丝带随时能回头改；花枝变了，包装会重新贴合。'
          : '点任意一步都会开始包装，也可以点下面回到摆花。'}
      </p>
      <button
        type="button"
        className="btn btn-small rail-back"
        data-testid="rail-back-arrange"
        onClick={() => goToStage('arrange')}
      >
        回到摆花改花枝
      </button>
    </section>
  );
}
