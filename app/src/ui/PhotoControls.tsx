import { useCallback, useEffect, useRef, useState } from 'react';
import { AiReview } from './AiReview';
import { SavedWorkCard } from './FinishCard';
import { photoSnapshotSignature } from '../data/album';
import {
  DEFAULT_PHOTO,
  PHOTO_SCENES,
  type PhotoSceneId,
  type PhotoSettings,
} from '../data/presentation';
import type { AlbumEntry } from '../data/types';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';
import { applyPhotoFit, type PhotoFitResult } from '../three/photo-fit';
import { getScene } from './scene-bridge';
import './photo-stage.css';

interface Props {
  onCapture: () => Promise<string>;
  onSave: () => Promise<AlbumEntry | null>;
  onExport: () => Promise<{ blob: Blob; width: number; height: number }>;
}

/** 预览防抖：构图变化停下来再拍，避免拖滑杆时每帧编码。 */
const PREVIEW_DEBOUNCE_MS = 220;
/** 首帧尽快出图（不阻塞用户看构图）。 */
const PREVIEW_FIRST_MS = 80;
const SCENE_THUMB = (id: PhotoSceneId): string =>
  `${import.meta.env.BASE_URL}assets/scenes/${id}.jpg`;

const FRAME_LABEL: Record<PhotoSettings['frame'], string> = {
  none: '原图',
  paper: '纸边',
  postcard: '明信片',
};
const FORMAT_LABEL: Record<PhotoSettings['format'], string> = { square: '方形', portrait: '竖幅' };

/**
 * 拍照阶段右栏（V13）。
 *
 * V13 之前的实现每 1.6 秒无条件调用一次 `captureThumbnail()`（渲染 + JPEG 编码），
 * 画面不动也一直耗显卡和主线程。现在改成：
 * - 订阅真实「画面签名」（花枝 / 包装 / 丝带 / 卡片 / 照片设置 / 实际机位），只在变化后
 *   防抖拍摄一次；
 * - `document.hidden` 时完全暂停，重新可见再补一帧；
 * - 保存 / 导出时先等正在进行的预览拍完（`hold`），避免两路同时改渲染器尺寸；
 * - 首帧仍然尽快出图，保存与导出的行为不变。
 *
 * 布局：大预览是这一阶段的主视觉，8 个场景是缩略图卡片；一键适配读场景花头位置反算
 * zoom/offset（见 three/photo-fit.ts）。
 */
export function PhotoControls({ onCapture, onSave, onExport }: Props): React.JSX.Element {
  const photo = useAppState(s => s.doc.photo);
  const signature = useAppState(s => photoSnapshotSignature(s.doc, s.cameraDirection));
  const stemCount = useAppState(s => s.doc.stems.length);
  // 当前点评是否还属于这一帧：是的话，拍照入册/交付会把它一起存到新照片上。
  const reviewMatches = useAppState(
    s =>
      Boolean(
        s.currentReview &&
          s.currentReview.snapshot === photoSnapshotSignature(s.doc, s.cameraDirection),
      ),
  );
  const [group, setGroup] = useState('scene');
  const [preview, setPreview] = useState('');
  const [previewFailed, setPreviewFailed] = useState(false);
  const [working, setWorking] = useState(false);
  const [saved, setSaved] = useState<AlbumEntry | null>(null);
  const [fitResult, setFitResult] = useState<PhotoFitResult | null>(null);
  const [failedThumbs, setFailedThumbs] = useState<PhotoSceneId[]>([]);

  const timerRef = useRef(0);
  const captureLock = useRef(false);
  const capturePending = useRef(false);
  const holdRef = useRef(false);
  const aliveRef = useRef(true);
  const retriesRef = useRef(0);
  const captureRef = useRef<() => Promise<void>>(async () => undefined);

  const schedule = useCallback((delay: number): void => {
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      void captureRef.current();
    }, delay);
  }, []);

  const capturePreview = useCallback(async (): Promise<void> => {
    if (holdRef.current || document.hidden) return;
    if (captureLock.current) {
      // 上一张还在渲染：记一笔，拍完立刻补最新的。
      capturePending.current = true;
      return;
    }
    captureLock.current = true;
    try {
      const image = await onCapture();
      if (!aliveRef.current) return;
      retriesRef.current = 0;
      setPreview(image);
      setPreviewFailed(false);
    } catch {
      if (!aliveRef.current) return;
      setPreviewFailed(true);
      // 场景/花材还没就绪：短重试几次后交给下一次画面变化。
      if (retriesRef.current < 4) {
        retriesRef.current += 1;
        schedule(500);
      }
    } finally {
      captureLock.current = false;
      if (capturePending.current) {
        capturePending.current = false;
        if (!holdRef.current && !document.hidden) schedule(PREVIEW_DEBOUNCE_MS);
      }
    }
  }, [onCapture, schedule]);

  // 让定时器总能调用到最新一次渲染的 capture 闭包。
  useEffect(() => {
    captureRef.current = capturePreview;
  }, [capturePreview]);

  // 画面签名变化 → 防抖后重拍一帧；首帧用更短的延迟。
  const firstRef = useRef(true);
  useEffect(() => {
    if (holdRef.current) return undefined;
    const delay = firstRef.current ? PREVIEW_FIRST_MS : PREVIEW_DEBOUNCE_MS;
    firstRef.current = false;
    schedule(delay);
    return () => window.clearTimeout(timerRef.current);
  }, [signature, schedule]);

  // 页面隐藏时暂停；回来时补拍一帧，不需要用户再动画面。
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (document.hidden) {
        window.clearTimeout(timerRef.current);
        return;
      }
      schedule(140);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [schedule]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      window.clearTimeout(timerRef.current);
    };
  }, []);

  const change = (patch: Partial<PhotoSettings>): void => {
    store.updatePhoto(patch);
    store.endTransaction();
  };

  const waitForIdleCapture = async (): Promise<void> => {
    for (let tick = 0; tick < 120 && captureLock.current; tick += 1) {
      await new Promise<void>(resolve => window.setTimeout(resolve, 16));
    }
  };

  /** 保存 / 导出：先暂停预览、等正在进行的拍摄结束，再做事，结束后补拍。 */
  const run = async (task: () => Promise<unknown>): Promise<void> => {
    if (working) return;
    setWorking(true);
    holdRef.current = true;
    window.clearTimeout(timerRef.current);
    await waitForIdleCapture();
    try {
      await task();
    } catch {
      /* onCapture / onSave 自己会提示失败，这里只保证按钮恢复 */
    } finally {
      holdRef.current = false;
      setWorking(false);
      schedule(180);
    }
  };

  const save = async (): Promise<void> => {
    await run(async () => {
      const entry = await onSave();
      if (entry) setSaved(entry);
    });
  };

  const download = async (): Promise<void> => {
    await run(async () => {
      const { blob } = await onExport();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${photo.title || '花间一刻'}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      store.toast('照片已导出', 'success');
    });
  };

  const fit = (): void => {
    const result = applyPhotoFit(getScene());
    if (!result.ok) {
      store.toast(
        result.reason === 'empty' ? '先放几枝花，再来适配取景吧' : '取景还没准备好，请稍候再试',
        'warn',
      );
      return;
    }
    setFitResult(result);
    if (result.changed) store.toast(`花束已放回取景框，约占画面 ${result.fill}%`, 'info');
    else store.toast('现在的构图已经很合适了', 'info');
  };

  const sceneLabel = PHOTO_SCENES.find(item => item.id === photo.scene)?.label ?? '窗边';

  return (
    <section
      className="panel photo-tools photo-stage-panel"
      aria-label="拍照设置"
      data-testid="photo-tools"
    >
      <div className="photo-stage-head">
        <p className="finish-eyebrow">留住这一刻</p>
        <span className="photo-stage-mode" data-testid="photo-stage-mode">
          {FORMAT_LABEL[photo.format]} · {FRAME_LABEL[photo.frame]} · {sceneLabel}
        </span>
      </div>

      <figure className="photo-stage" data-testid="photo-stage" data-format={photo.format}>
        <div className="photo-stage-frame">
          {preview ? (
            <img
              className="photo-preview"
              src={preview}
              alt="照片预览，与相册和导出使用同一构图"
              data-testid="photo-preview"
            />
          ) : (
            <p className="photo-stage-placeholder" data-testid="photo-preview-placeholder">
              {previewFailed ? '取景暂时没准备好，改动一下构图会再试' : '正在准备取景…'}
            </p>
          )}
        </div>
        <figcaption className="photo-stage-caption">
          这就是最终导出的构图；拖动画面或微调后会自动更新。
        </figcaption>
      </figure>

      <div className="photo-fit-row">
        <button
          type="button"
          className="btn photo-fit"
          data-testid="photo-fit"
          disabled={stemCount === 0 || working}
          title={
            stemCount === 0
              ? '先放几枝花，再来适配取景'
              : '按当前花束自动调整距离与左右/上下，让花束落在取景框内'
          }
          onClick={fit}
        >
          一键适配花束取景
        </button>
        {fitResult?.ok ? (
          <p
            className="photo-fit-note"
            data-testid="photo-fit-note"
            data-zoom={fitResult.zoom}
            data-offset-x={fitResult.offsetX}
            data-offset-y={fitResult.offsetY}
            data-max-ndc={fitResult.maxNdc}
            data-fill={fitResult.fill}
          >
            花束约占画面 {fitResult.fill}%，四边留有呼吸感
          </p>
        ) : (
          <p className="decor-note photo-fit-hint">
            手调构图后可以再点一次，把花束放回取景框。
          </p>
        )}
      </div>

      <div className="presentation-tabs photo-stage-tabs">
        {(
          [
            ['scene', '场景'],
            ['frame', '边框'],
            ['composition', '构图'],
          ] as const
        ).map(([id, label]) => (
          <button
            className={`btn btn-small ${group === id ? 'is-on' : ''}`}
            key={id}
            onClick={() => setGroup(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {group === 'scene' ? (
        <div className="photo-scene-grid" data-testid="photo-scene-grid">
          {PHOTO_SCENES.map(({ id, label }) => (
            <button
              type="button"
              key={id}
              className={`photo-scene-card ${photo.scene === id ? 'is-on' : ''}`}
              data-testid={`photo-scene-${id}`}
              aria-pressed={photo.scene === id}
              onClick={() => change({ scene: id })}
            >
              <span className="photo-scene-thumb">
                {failedThumbs.includes(id) ? (
                  <span
                    className="photo-scene-fallback"
                    data-scene={id}
                    aria-hidden="true"
                  />
                ) : (
                  <img
                    src={SCENE_THUMB(id)}
                    alt=""
                    loading="lazy"
                    onError={() =>
                      setFailedThumbs(list => (list.includes(id) ? list : [...list, id]))
                    }
                  />
                )}
              </span>
              <span className="photo-scene-label">{label}</span>
            </button>
          ))}
        </div>
      ) : null}

      {group === 'frame' ? (
        <>
          <div className="presentation-tabs">
            {(
              [
                ['none', '原图'],
                ['paper', '纸边'],
                ['postcard', '明信片'],
              ] as const
            ).map(([id, label]) => (
              <button
                className={`btn ${photo.frame === id ? 'is-on' : ''}`}
                key={id}
                data-testid={`photo-frame-${id}`}
                onClick={() => change({ frame: id })}
              >
                {label}
              </button>
            ))}
          </div>
          {photo.frame === 'postcard' ? (
            <input
              className="input"
              aria-label="照片题名"
              maxLength={30}
              placeholder="写下照片题名"
              value={photo.title}
              onChange={e => change({ title: e.target.value })}
            />
          ) : null}
        </>
      ) : null}

      {group === 'composition' ? (
        <>
          <div className="presentation-tabs">
            {(
              [
                ['square', '方形'],
                ['portrait', '竖幅'],
              ] as const
            ).map(([id, label]) => (
              <button
                className={`btn ${photo.format === id ? 'is-on' : ''}`}
                key={id}
                onClick={() => change({ format: id })}
              >
                {label}
              </button>
            ))}
          </div>
          {(
            [
              ['zoom', '距离', 0.75, 1.3],
              ['offsetX', '左右', -0.2, 0.2],
              ['offsetY', '上下', -0.2, 0.2],
            ] as const
          ).map(([key, label, min, max]) => (
            <label className="slider-row" key={key}>
              <span className="slider-label">{label}</span>
              <input
                type="range"
                aria-label={`照片${label}`}
                min={min}
                max={max}
                step={0.01}
                value={photo[key]}
                onChange={e => store.updatePhoto({ [key]: Number(e.target.value) })}
                onPointerUp={() => store.endTransaction()}
                onKeyUp={() => store.endTransaction()}
              />
            </label>
          ))}
          <button
            className="btn btn-small"
            onClick={() => change({ zoom: DEFAULT_PHOTO.zoom, offsetX: 0, offsetY: 0 })}
          >
            复位构图
          </button>
        </>
      ) : null}

      <label className="decor-note">
        <input
          type="checkbox"
          checked={photo.autoTrim}
          onChange={e => change({ autoTrim: e.target.checked })}
        />{' '}
        自动整理下部茎叶
      </label>

      <button
        className="btn btn-primary"
        data-testid="album-save"
        disabled={working}
        onClick={() => void save()}
      >
        {working ? '正在拍摄…' : saved ? '再存一张到这个作品' : '拍照存相册'}
      </button>

      {saved ? (
        <SavedWorkCard
          entry={saved}
          onContinue={() => {
            setSaved(null);
            store.setStage('arrange');
          }}
          onOpenAlbum={() => store.openAlbum()}
        />
      ) : null}

      {reviewMatches ? (
        <p className="decor-note photo-review-note" data-testid="photo-review-note">
          当前画面的点评会随这张照片一起存进相册。
        </p>
      ) : null}

      <button
        className="btn"
        data-testid="photo-export"
        disabled={working}
        onClick={() => void download()}
      >
        导出 PNG
      </button>

      <AiReview onCapture={onCapture} />
      <p className="decor-note">
        拖动画面换角度，预览框内就是照片。每张照片保留拍摄时的作品版本。
      </p>
    </section>
  );
}
