/**
 * 整理面板（V16 §3）：一个入口，按当前对象显示适用操作。
 *
 * - 选中单枝：翻瓣 / 去刺 / 修枝 / 修叶（只显示这枝花实际支持的项）；
 * - 未选中：整束枝叶整理（说明影响范围、一次撤销、可恢复整理前）；
 * - 适用容器：花泥（裁切 / 放入 / 适配枝脚 / 取出）；透明花瓶不塞花泥。
 *
 * 手动操作与「一键完成」写的是同一种可保存状态（stem.preparation），
 * 所以撤销、复制、保存、照片输出都一致。
 */

import {
  FLIP_FAMILIES,
  flowerOrganizeCapability,
  organizeScope,
} from '../data/organize';
import { supportsFoam } from '../data/decor-capability';
import type { PresentationKind } from '../data/presentation';
import { VESSELS } from '../data/presentation';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';
import './organize.css';

const VESSEL_TAIL = (kind: PresentationKind): number =>
  kind === 'paper' ? 0.16 : VESSELS[kind]?.tailLength ?? 0.16;

const KIND_LABEL: Record<PresentationKind, string> = {
  paper: '纸片包装',
  vase: '细口花瓶',
  pot: '宽口陶罐',
  basket: '藤编花篮',
  box: '花礼盒',
  bucket: '抱抱桶',
  bag: '手提花袋',
  crate: '木条花箱',
};

/** 翻瓣三档：手动逐档推进，一键直接到 1。 */
const FLIP_STEPS = [0, 1 / 3, 2 / 3, 1];

function nextFlipStep(current: number): number {
  const normalized = Math.min(1, Math.max(0, current));
  const found = FLIP_STEPS.findIndex((step) => step > normalized + 1e-4);
  return found === -1 ? 1 : FLIP_STEPS[found];
}

/**
 * 整理面板。`dense`：嵌在 InspectorPanel 里时不再画外层分区标题。
 */
export function OrganizePanel({ dense = false }: { dense?: boolean }): React.JSX.Element {
  const doc = useAppState((state) => state.doc);
  const catalog = useAppState((state) => state.catalog);
  const selectedId = useAppState((state) => state.selectedId);
  const trimMode = useAppState((state) => state.trimMode);
  const kind = doc.presentation.kind;
  const foam = doc.presentation.foam ?? { fitted: false, cut: 0 };
  const stem = doc.stems.find((item) => item.id === selectedId) ?? null;
  const entry = stem ? catalog.entriesById[stem.assetId] : undefined;
  const family = entry?.family ?? '';
  const capability = flowerOrganizeCapability(family);
  const prep = stem?.preparation;
  const scope = organizeScope(doc.stems.length > 0);
  const vesselTail = VESSEL_TAIL(kind);
  const foamCapable = supportsFoam(kind);
  // 面向用户的一句话摘要：只说「这枝现在能做什么」，不出现模型/资产这类开发词。
  const canDo: string[] = [];
  if (capability.flip) canDo.push('翻开外层花瓣');
  if (capability.thorns) canDo.push('去掉小刺');
  if (capability.trimTail) canDo.push('剪短花茎');
  if (capability.trimLeaves) canDo.push('剪掉叶子');

  return (
    <section
      className={dense ? 'organize-panel organize-panel-dense' : 'panel organize-panel'}
      data-testid="organize-panel"
      aria-label="整理"
    >
      <div className="panel-head">
        <h2>{dense ? '整理这枝' : '整理'}</h2>
        <span className="panel-meta">
          {stem ? (entry?.displayName ?? '选中的花枝') : `${doc.stems.length} 枝`}
        </span>
      </div>

      {stem && entry ? (
        <>
          <p className="organize-lead" data-testid="organize-stem-summary">
            {canDo.length > 0 ? `可以${canDo.join('、')}；想省事就点下面的一键整理。` : '这枝保持原样就很好看，暂时不用整理。'}
          </p>

          {/* ---------- 翻瓣（独立于整束整理） ---------- */}
          {capability.flip ? (
            <div className="organize-block" data-testid="organize-flip-block">
              <div className="organize-block-head">
                <b>翻瓣</b>
                <span className="organize-chip" data-testid="organize-flip-chip">
                  可翻瓣
                </span>
                <span className="organize-value">
                  {Math.round((prep?.petalFlip ?? 0) * 100)}%
                </span>
              </div>
              <p className="organize-note">把外层花瓣轻轻翻开，花头会显得更饱满。这是你自己的风格选择，整理整束时不会动它。</p>
              <div className="organize-actions">
                <button
                  type="button"
                  className="btn btn-small"
                  data-testid="organize-flip-step"
                  disabled={(prep?.petalFlip ?? 0) >= 0.999}
                  onClick={() => stem && store.setPetalFlip(stem.id, nextFlipStep(prep?.petalFlip ?? 0))}
                >
                  再翻开一点
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  data-testid="organize-flip-full"
                  disabled={(prep?.petalFlip ?? 0) >= 0.999}
                  onClick={() => stem && store.setPetalFlip(stem.id, 1)}
                >
                  一键翻开
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  data-testid="organize-flip-reset"
                  disabled={(prep?.petalFlip ?? 0) <= 0.001}
                  onClick={() => stem && store.setPetalFlip(stem.id, 0)}
                >
                  变回原样
                </button>
              </div>
            </div>
          ) : null}

          {/* ---------- 去刺 ---------- */}
          {capability.thorns ? (
            <div className="organize-block" data-testid="organize-thorn-block">
              <div className="organize-block-head">
                <b>去刺</b>
                <span className="organize-value">{prep?.thornsRemoved ? '已去刺' : '还有刺'}</span>
              </div>
              <p className="organize-note">玫瑰茎上会有小刺，去掉拿花更顺手；想留着刺也可以恢复回来。</p>
              <div className="organize-actions">
                <button
                  type="button"
                  className="btn btn-small"
                  data-testid="organize-dethorn"
                  disabled={prep?.thornsRemoved === true}
                  onClick={() => stem && store.setThornsRemoved(stem.id, true)}
                >
                  去掉刺
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  data-testid="organize-restore-thorns"
                  disabled={prep?.thornsRemoved !== true}
                  onClick={() => stem && store.setThornsRemoved(stem.id, false)}
                >
                  把刺放回来
                </button>
              </div>
            </div>
          ) : null}

          {/* ---------- 修枝 / 修叶 ---------- */}
          <div className="organize-block" data-testid="organize-trim-block">
            <div className="organize-block-head">
              <b>修枝修叶</b>
              <span className="organize-value">花茎留 {Math.round((prep?.tailLength ?? 0.22) * 100)} cm</span>
            </div>
            {capability.trimTail ? (
              <>
                <div className="organize-actions">
                  <button
                    type="button"
                    className="btn btn-small"
                    data-testid="trim-stem"
                    disabled={(prep?.tailLength ?? 0.22) <= 0.1001}
                    onClick={() => stem && store.trimStem(stem.id)}
                  >
                    剪短 2 cm
                  </button>
                  <button
                    type="button"
                    className={`btn btn-small ${trimMode ? 'is-on' : ''}`}
                    data-testid="trim-mode"
                    onClick={() => store.setTrimMode(!trimMode)}
                  >
                    {trimMode ? '结束修剪' : '在花枝上修剪'}
                  </button>
                </div>
                {trimMode ? (
                  <p className="organize-note" data-testid="trim-mode-note">
                    点击发亮的叶片把它剪掉；点花茎底部的金线剪短 2 cm，都可以撤销。
                  </p>
                ) : null}
                <div className="organize-leaf-row">
                  {[0, 1, 2].map((i) => (
                    <button
                      key={i}
                      type="button"
                      className="btn btn-small"
                      data-testid={`trim-leaf-${i}`}
                      disabled={prep?.removedLeaves.includes(i) === true}
                      onClick={() => stem && store.trimStem(stem.id, i)}
                    >
                      {['下叶', '中叶', '上叶'][i]}
                      {prep?.removedLeaves.includes(i) ? '已剪' : '剪掉'}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="organize-note" data-testid="trim-unavailable">
                这枝更适合保持原本的长短，剪短只在玫瑰、郁金香上看得见效果；叶子和刺照常能整理。
              </p>
            )}
          </div>

          <button
            type="button"
            className="btn organize-primary"
            data-testid="organize-stem"
            onClick={() => stem && store.organizeStem(stem.id)}
          >
            一键整理这枝
          </button>
          <p className="organize-note">
            一键会把花茎、下部叶和玫瑰刺都弄好，花瓣的样子和花头位置保持不变；做错了可以撤销。
          </p>
        </>
      ) : (
        <>
          {/* ---------- 整束整理 ---------- */}
          <p className="organize-lead" data-testid="organize-bouquet-lead">
            这里一次整理整束：把花茎收齐、去掉挤在容器里的下部叶，玫瑰也会顺带去掉刺。
            你特意留在外面的叶子和翻开的花瓣都不会动。
          </p>
          <div className="organize-actions">
            <button
              type="button"
              className="btn organize-primary"
              data-testid="organize-bouquet"
              disabled={doc.stems.length === 0}
              onClick={() => store.organizeBouquet()}
            >
              一键整理整束
            </button>
            <button
              type="button"
              className="btn btn-small"
              data-testid="organize-restore"
              onClick={() => store.restoreOrganize()}
            >
              回到整理前
            </button>
          </div>
          <p className="organize-note" data-testid="organize-scope">
            会处理：{scope.tail ? '花茎长度' : '暂无花枝'}
            {scope.leaves ? ' · 下部叶子' : ''}
            {scope.thorns ? ' · 玫瑰刺' : ''}
            ；不会动：外露的叶子和花头位置{scope.flip ? '' : '（不含翻瓣）'}。
          </p>
        </>
      )}

      {/* ---------- 花泥（容器准备） ---------- */}
      {foamCapable ? (
        <div className="organize-block organize-foam" data-testid="organize-foam">
          <div className="organize-block-head">
            <b>花泥</b>
            <span className="organize-chip">{KIND_LABEL[kind]}</span>
            <span className="organize-value">
              {foam.fitted ? (foam.cut >= 0.999 ? '已裁好贴合' : '已放入 · 还没裁') : '还没放'}
            </span>
          </div>
          <p className="organize-note">
            花泥藏在容器里，让花插得更稳；透明花瓶能看见枝条，就不放花泥。先放进去，再按容器口裁齐，最后把花茎调到合适高度。
          </p>
          <div className="organize-actions">
            <button
              type="button"
              className="btn btn-small"
              data-testid="organize-foam-place"
              disabled={foam.fitted}
              onClick={() => store.setFoam('place')}
            >
              放入花泥
            </button>
            <button
              type="button"
              className="btn btn-small"
              data-testid="organize-foam-cut"
              disabled={!foam.fitted || foam.cut >= 0.999}
              onClick={() => store.setFoam('cut')}
            >
              按容器口裁齐
            </button>
            <button
              type="button"
              className="btn btn-small"
              data-testid="organize-foam-fit"
              disabled={!foam.fitted}
              onClick={() => store.setFoam('fit')}
            >
              花茎插到合适高度
            </button>
            <button
              type="button"
              className="btn btn-small"
              data-testid="organize-foam-remove"
              disabled={!foam.fitted}
              onClick={() => store.setFoam('remove')}
            >
              取出
            </button>
          </div>
          <p className="organize-note">这个容器里花茎留 {Math.round(vesselTail * 100)} cm 左右更好看。</p>
        </div>
      ) : null}
    </section>
  );
}

/** 供花材架/工具条判断是否显示「可翻瓣」标签。 */
export function isFlipFamily(family: string): boolean {
  return FLIP_FAMILIES.includes(family);
}
