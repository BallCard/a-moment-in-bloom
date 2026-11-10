import { useCallback, useEffect, useRef, useState } from 'react';
import { getAudioDebug, installUnlockOnFirstGesture, playSfx, resetAudioDebug, unlockAudio } from './audio/engine';
import { fetchRuntimeCatalog } from './data/catalog';
import { COMMISSIONS, commissionWishes, evaluateCommission, getCommission, isCommissionUnlocked } from './data/commissions';
import { readLabParams } from './data/samples';
import type { BouquetDocument } from './data/types';
import { store, type AppState } from './state/store';
import { useAppState } from './state/useStore';
import { BouquetScene } from './three/BouquetScene';
import { AlbumPanel } from './ui/AlbumPanel';
import { AssetStatus } from './ui/AssetStatus';
import { CommissionPicker } from './ui/CommissionPicker';
import { DebugHud } from './ui/DebugHud';
import { EmptyGuide } from './ui/EmptyGuide';
import { PhotoControls } from './ui/PhotoControls';
import { FinishCard } from './ui/FinishCard';
import { FlowerPanel } from './ui/FlowerPanel';
import { MixHint } from './ui/MixHint';
import { NodeStatusBar } from './ui/NodeStatusBar';
import { usePanelResize } from './ui/panel-resize';
import { PlacementBanner } from './ui/PlacementBanner';
import { RightPanel } from './ui/RightPanel';
import { SelectionToolbar } from './ui/SelectionToolbar';
import { SnapHint } from './ui/SnapHint';
import { ShowcaseGallery } from './ui/ShowcaseGallery';
import { setScene } from './ui/scene-bridge';
import { SuggestionCards } from './ui/SuggestionCards';
import { ToastStack } from './ui/ToastStack';
import { TopBar } from './ui/TopBar';
import { ViewControls } from './ui/ViewControls';
import {
  defaultTabFor,
  isShowcaseActive,
  stopShowcase,
  useReducedMotion,
  useShowcase,
  useStage,
  type RightTab,
} from './ui/workflow';

interface BouquetDebugApi {
  getState: () => AppState;
  getStemScreenPoint: (stemId: string) => { x: number; y: number; visible: boolean } | null;
  getDecorState: () => ReturnType<BouquetScene['getDecorState']>;
  getSceneState: () => Record<string, unknown>;
  captureThumbnail: (size?: number) => Promise<string>;
  select: (stemId: string) => void;
  focusSelected: () => void;
  /**
   * 委托数据层的只读入口，给验收脚本用。
   * 生产包没有 /src/*.ts 可以动态 import，所以这里暴露纯函数而不是让脚本去取源码。
   */
  commissions: {
    list: () => typeof COMMISSIONS;
    wishes: (commissionId: string) => ReturnType<typeof commissionWishes>;
    evaluate: (commissionId: string, doc: unknown) => ReturnType<typeof evaluateCommission>;
    unlocked: (commissionId: string, completed: string[]) => boolean;
  };
  scene: BouquetScene;
  store: typeof store;
  /** V16：音效状态（自动化验证用，只读；reset 只清播放记录）。 */
  audio: {
    state: typeof getAudioDebug;
    reset: typeof resetAudioDebug;
    unlock: typeof unlockAudio;
  };
}

declare global {
  interface Window {
    __bouquetDebug?: BouquetDebugApi;
  }
}

export default function App({onOpenStart, onOpenGallery}: {onOpenStart: () => void; onOpenGallery: () => void}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<BouquetScene | null>(null);
  // V16 第二轮：左右侧栏可拉伸。宽度写 CSS 变量，本机持久化，窄屏自动退出。
  const { appRef, resizing: panelResizing, handles: panelHandles } = usePanelResize();
  const stage = useStage();
  const showcase = useShowcase();
  const reducedMotion = useReducedMotion();
  const placement = useAppState((state) => state.placement);
  const selectedId = useAppState((state) => state.selectedId);
  const emptyDocument = useAppState((state) => state.doc.stems.length === 0);
  const [rightTab, setRightTab] = useState<RightTab>(defaultTabFor('arrange'));
  const [rightClosed, setRightClosed] = useState(true);
  const [commissionPickerOpen, setCommissionPickerOpen] = useState(false);
  const [commissionBusyId, setCommissionBusyId] = useState<string | null>(null);

  /** 场景的新方法可能比 UI 晚落地，统一用可选调用，接口到了自然生效。 */
  const focusSelected = (): void => {
    const scene = sceneRef.current as unknown as { focusSelected?: () => void } | null;
    scene?.focusSelected?.();
  };

  const captureThumbnail = useCallback(async (): Promise<string> => {
    const scene = sceneRef.current as unknown as
      | { captureThumbnail?: (size?: number) => Promise<string> }
      | null;
    try {
      if (!scene?.captureThumbnail) throw new Error('取景尚未就绪');
      const image = await scene.captureThumbnail();
      if (!image.startsWith('data:image/')) throw new Error('空照片');
      // 只有真的拿到照片才播快门提示音；失败不播成功音。
      playSfx('camera');
      return image;
    } catch (error) {
      store.toast('照片没有拍好，请稍后重试；作品保留在工作台', 'warn');
      throw error;
    }
  }, []);

  const captureForArchive = useCallback(async ():Promise<string> => {
    sceneRef.current?.rememberPhotoView();
    return captureThumbnail();
  },[captureThumbnail]);

  const startCommission = async (commissionId: string): Promise<void> => {
    if (commissionBusyId) return;
    setCommissionBusyId(commissionId);
    try {
      const hasStems = store.getState().doc.stems.length > 0;
      const thumbnail = hasStems ? await captureForArchive() : null;
      if (store.startCommission(commissionId, thumbnail)) setCommissionPickerOpen(false);
    } catch { /* capture reports failure, leave work untouched */ } finally {
      setCommissionBusyId(null);
    }
  };

  useEffect(() => {
    const container = viewportRef.current;
    if (!container) return;
    const scene = new BouquetScene(container, store);
    sceneRef.current = scene;
    setScene(scene);
    // 调试/自动化验证入口：只读状态 + 花头屏幕坐标，不绕开正常交互。
    window.__bouquetDebug = {
      getState: () => store.getState(),
      getStemScreenPoint: (stemId) => scene.getStemScreenPoint(stemId),
      getDecorState: () => scene.getDecorState(),
      getSceneState: () => scene.getSceneState(),
      captureThumbnail: (size?: number) => scene.captureThumbnail(size),
      select: (stemId) => store.select(stemId),
      focusSelected: () => focusSelected(),
      commissions: {
        list: () => COMMISSIONS,
        wishes: (commissionId) => commissionWishes(commissionId),
        evaluate: (commissionId, doc) => {
          const def = getCommission(commissionId);
          if (!def) throw new Error(`没有这封委托：${commissionId}`);
          return evaluateCommission(doc as BouquetDocument, def, store.getState().catalog);
        },
        unlocked: (commissionId, completed) => {
          const def = getCommission(commissionId);
          return def ? isCommissionUnlocked(def, completed) : false;
        },
      },
      scene,
      store,
      audio: {
        state: getAudioDebug,
        reset: resetAudioDebug,
        unlock: unlockAudio,
      },
    };
    return () => {
      delete window.__bouquetDebug;
      setScene(null);
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  /**
   * V16 §6：浏览器要求用户手势后才能出声。第一次交互时解锁一次；
   * 解锁失败（不支持 / 被拒绝）只是没有声音，不影响任何操作。
   */
  useEffect(() => installUnlockOnFirstGesture(), []);

  useEffect(() => {
    let cancelled = false;
    store.beginAssetLoad();
    void fetchRuntimeCatalog()
      .then((catalog) => {
        if (cancelled) return;
        // V0.7 §3 比例校准入口：?head=0.8&size=b&sample=12&view=quarter
        // 只影响本次打开，不改清单文件，也不写入作品。
        // ?size= 是 V0.7.3 的尺寸候选（a/b/c）；?head= 是只改花头的临时覆盖。
        const lab = readLabParams(window.location.search);
        store.applyCatalog(catalog, {
          headScale: lab.headScale,
          sizeCandidate: lab.sizeCandidate,
        });
        if (lab.sample) store.loadSampleBouquet(lab.sample);
        if (lab.view) store.setViewPreset(lab.view);
      })
      .finally(() => {
        if (!cancelled) store.endAssetLoad();
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const retryToken = useAppState((state) => state.assetRetryToken);
  useEffect(() => {
    if (retryToken === 0) return undefined;
    let cancelled = false;
    store.beginAssetLoad();
    void fetchRuntimeCatalog()
      .then((catalog) => {
        if (cancelled) return;
        store.applyCatalog(catalog);
        sceneRef.current?.refreshAssets();
      })
      .finally(() => {
        if (!cancelled) store.endAssetLoad();
      });
    return () => {
      cancelled = true;
    };
  }, [retryToken]);

  // 换阶段时右栏自动切到最有用的标签；离开成品阶段时停掉环绕。
  useEffect(() => {
    setRightTab(defaultTabFor(stage));
  }, [stage]);

  // 阶段或选中变化时重新展开右栏；用户手动收起后保持收起，直到上下文再变。
  useEffect(() => {
    setRightClosed(stage !== 'wrap');
  }, [stage]);

  // V0.7 §6：点 3D 贺卡/包装纸/花器或界面入口 → 展开对应编辑区。
  // 这里只负责「把面板摆到位」，阶段切换与包装进度都不碰。
  const editorRequest = useAppState((state) => state.editorRequest);
  useEffect(() => {
    if (!editorRequest) return;
    // 整理请求落在「修剪与微调」标签；其余编辑目标仍去包装面板。
    setRightTab(editorRequest.target === 'organize' ? 'inspect' : 'decor');
    setRightClosed(false);
  }, [editorRequest]);

  useEffect(() => {
    if (stage !== 'finish' && showcase) stopShowcase();
  }, [stage, showcase]);

  // 摆花之外不保留放置状态，避免包装时画面上还挂着待放的花影。
  useEffect(() => {
    if (stage !== 'arrange' && placement) store.setPlacement(null);
  }, [stage, placement]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const isTextInput =
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true ||
        (target?.tagName === 'INPUT' &&
          ['text', 'search', 'number', 'email', 'url', 'tel', 'password'].includes(
            (target as HTMLInputElement).type,
          ));
      const withModifier = event.ctrlKey || event.metaKey;

      if (!isTextInput && !commissionPickerOpen && !store.getState().albumOpen && withModifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (!isTextInput && !commissionPickerOpen && !store.getState().albumOpen && withModifier && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        store.redo();
        return;
      }
      if (event.key === 'Escape') {
        if (store.getState().albumOpen) {
          store.closeAlbum();
          return;
        }
        if (commissionPickerOpen) {
          setCommissionPickerOpen(false);
          return;
        }
        if (isShowcaseActive()) {
          stopShowcase();
          return;
        }
        if (store.getState().placement) store.setPlacement(null);
        else store.select(null);
        return;
      }
      if (isTextInput || commissionPickerOpen || store.getState().albumOpen) return;
      if (withModifier && event.key.toLowerCase() === 'd') { event.preventDefault(); const id=store.getState().selectedId; if(id&&store.getState().stage==='arrange')store.duplicateStem(id); return; }
      if (!withModifier && event.key.toLowerCase()==='f') { event.preventDefault(); sceneRef.current?.focusSelected(); }
      if (!withModifier && event.key==='Home') { event.preventDefault(); sceneRef.current?.resetView(); }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !isTextInput) {
        if (store.getState().selectedId) {
          event.preventDefault();
          store.deleteSelected();
        }
      }
      // 数字键 1–4 切预设视角，输入框内与带修饰键时不触发。
      if (!isTextInput && !withModifier && !store.getState().albumOpen) {
        const presets = { '1': 'front', '2': 'quarter', '3': 'side', '4': 'top' } as const;
        const preset = presets[event.key as keyof typeof presets];
        if (preset) {
          event.preventDefault();
          store.setViewPreset(preset);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [commissionPickerOpen]);

  const rightNeeded =
    stage !== 'finish' &&
    (stage === 'wrap' || Boolean(selectedId) || editorRequest?.target === 'organize');
  const showRight = rightNeeded && !rightClosed;
  const restartView = (): void => sceneRef.current?.resetView();

  const deliverCommission = async (): Promise<void> => {
    const thumbnail = await captureForArchive();
    store.deliverCommission(thumbnail);
  };

  const saveToAlbum = async (): Promise<Awaited<ReturnType<typeof store.saveToAlbum>>> => {
    const thumbnail = await captureForArchive();
    return store.saveToAlbum(thumbnail);
  };

  const exportPng = async (): Promise<{ blob: Blob; width: number; height: number }> => {
    const scene = sceneRef.current;
    if (!scene) throw new Error('3D 场景还没准备好');
    return scene.exportPng();
  };

  return (
    <div
      className="app"
      ref={appRef}
      data-stage={stage}
      data-motion={reducedMotion ? 'reduced' : 'auto'}
      data-panel-resizing={panelResizing ? 'true' : undefined}
    >
      <div className="viewport" ref={viewportRef} data-testid="viewport" />
      <div className="ui-layer">
        <TopBar
          onOpenStart={onOpenStart}
          onOpenGallery={onOpenGallery}
          onResetView={restartView}
          onOpenCommissions={() => setCommissionPickerOpen(true)}
          onOpenAlbum={() => store.openAlbum()}
          onExportPng={exportPng}
          onImported={() => setRightTab('inspect')}
        />

        <NodeStatusBar stage={stage} onOpenCommissions={() => setCommissionPickerOpen(true)} />

        <div className="side side-left" data-stage={stage}>
          {stage === 'arrange' ? <FlowerPanel stage="arrange" /> : null}
          {stage === 'wrap' ? (
            <>
              <p className="wrap-intro">
                摆好花以后，为它挑一张纸或一只陶器。
                <span className="wrap-intro-tip">也可以直接点画面里的纸片、花器或贺卡来编辑。</span>
              </p>
            </>
          ) : null}
          {stage === 'finish' ? <FinishCard onDeliver={deliverCommission} onSaveAlbum={saveToAlbum} /> : null}
          {/* V16 第二轮：花材面板内边缘的拉伸把手；窄屏不渲染。 */}
          {stage === 'arrange' && panelHandles.left ? <div {...panelHandles.left} /> : null}
        </div>

        {stage === 'finish' ? <PhotoControls onCapture={captureThumbnail} onSave={saveToAlbum} onExport={exportPng} /> : null}
        {showRight ? (
          <div className="side side-right">
            {/* V16 第二轮：右栏内边缘的拉伸把手。 */}
            {panelHandles.right ? <div {...panelHandles.right} /> : null}
            <RightPanel
              tab={rightTab}
              onTabChange={setRightTab}
              onClose={() => setRightClosed(true)}
              onFocusSelected={focusSelected}
            />
          </div>
        ) : rightNeeded ? (
          <button
            type="button"
            className="right-reopen"
            data-testid="right-reopen"
            onClick={() => setRightClosed(false)}
            title="展开右侧面板"
          >
            面板
          </button>
        ) : null}

        {emptyDocument && stage === 'arrange' && !placement && !rightNeeded && !commissionPickerOpen ? <ShowcaseGallery /> : null}
        <EmptyGuide />
        <PlacementBanner />
        <MixHint />
        <SuggestionCards />
        <SnapHint />
        <SelectionToolbar onOpenInspector={() => {setRightTab('inspect');setRightClosed(false);}} />
        {placement ? null : <ViewControls onResetView={restartView} panelOpen={showRight} />}
        {/* V16 §2：帮助入口，可重看新手引导（引导组件监听这个事件）。 */}
        <button
          type="button"
          className="help-reopen"
          data-testid="help-reopen"
          title="重看新手引导与用法说明"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('bouquet:onboarding-replay'));
          }}
        >
          <span aria-hidden="true">?</span>
          <span className="help-reopen-text">帮助</span>
        </button>
        <AssetStatus />
        <ToastStack />
        <DebugHud sceneRef={sceneRef} />
        <AlbumPanel onCaptureThumbnail={captureForArchive} />
        <CommissionPicker
          open={commissionPickerOpen}
          busyId={commissionBusyId}
          onClose={() => setCommissionPickerOpen(false)}
          onStart={(commissionId) => void startCommission(commissionId)}
        />
      </div>
    </div>
  );
}
