import { useEffect, useMemo, useRef, useState } from 'react';
import { photoSnapshotSignature } from '../data/album';
import { PHOTO_SCENES, PRESENTATION_LABELS } from '../data/presentation';
import type { PhotoReview } from '../data/types';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';

/** 服务端 /api/review 的响应形状（model/visionModel/createdAt 由服务端给出）。 */
interface ReviewResponse {
  score: number;
  summary: string;
  strengths: string[];
  suggestions: string[];
  model?: string;
  visionModel?: string;
  createdAt?: string;
}

const formatReviewedAt = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN');
};

/**
 * AI 点评（V6 P0-B）。
 *
 * 点评存进 store.currentReview，并带着「输入签名」：只有签名与当前画面一致时，
 * 界面才把这条点评显示成当前照片的点评；转镜头、换花、改纸、切场景、改画幅都会
 * 立刻隐藏旧分数，但已存进相册照片的点评不受影响。
 *
 * 请求进行中画面变了（签名变化）就取消等待并丢弃迟到结果，不会把旧图结果贴到新图；
 * 失败只显示错误，不阻断拍照、保存与交付。
 */
export function AiReview({ onCapture }: { onCapture: () => Promise<string> }): React.JSX.Element {
  const doc = useAppState((s) => s.doc);
  const cameraDirection = useAppState((s) => s.cameraDirection);
  const review = useAppState((s) => s.currentReview);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const signature = useMemo(
    () => photoSnapshotSignature(doc, cameraDirection),
    [doc, cameraDirection],
  );
  const signatureRef = useRef(signature);
  signatureRef.current = signature;
  const current = review && review.snapshot === signature ? review : null;
  const stale = review && !current ? review : null;

  // 画面签名变化：作废进行中的请求、丢弃迟到结果、隐藏旧分数（已存的相册点评不动）。
  useEffect(() => {
    generation.current += 1;
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
    setError('');
    return () => {
      generation.current += 1;
      controller.current?.abort();
      controller.current = null;
    };
  }, [signature]);

  const run = async (): Promise<void> => {
    if (busy) return;
    // 点评对应「点击这一刻」的画面：正在欣赏环绕时先停住镜头，等机位回报稳定后再取签名。
    if (store.getState().showcase) {
      store.stopShowcase();
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 260);
      });
    }
    const snapshot = signatureRef.current;
    setBusy(true);
    setError('');
    const version = generation.current;
    const abort = new AbortController();
    controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), 140000);
    try {
      const image = await onCapture();
      if (version !== generation.current || signatureRef.current !== snapshot) return;
      const context = JSON.stringify({
        flowers: doc.stems.map((stem) => ({
          name: store.getState().catalog.entriesById[stem.assetId]?.displayName,
          scale: stem.scale,
          pose: stem.pose,
        })),
        presentation: PRESENTATION_LABELS[doc.presentation.kind],
        scene: PHOTO_SCENES.find((item) => item.id === doc.photo.scene)?.label ?? doc.photo.scene,
        cameraDirection: store.getState().cameraDirection,
      });
      const response = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image, context }),
        signal: abort.signal,
      });
      const data = (await response.json().catch(() => ({ error: '评分服务尚未启动。' }))) as
        | (Partial<ReviewResponse> & { error?: string });
      if (!response.ok) throw Error(data.error ?? '评分暂时不可用。');
      if (
        !Number.isInteger(data.score) ||
        !Array.isArray(data.strengths) ||
        !Array.isArray(data.suggestions)
      ) {
        throw Error('评分格式不正确，请稍后重试。');
      }
      // 迟到结果：请求期间画面已经变了，直接丢弃，不贴到当前画面上。
      if (version !== generation.current || signatureRef.current !== snapshot) return;
      const result: PhotoReview = {
        score: data.score as number,
        summary: typeof data.summary === 'string' ? data.summary : '',
        strengths: data.strengths.filter((item): item is string => typeof item === 'string'),
        suggestions: data.suggestions.filter((item): item is string => typeof item === 'string'),
        ...(typeof data.model === 'string' && data.model ? { model: data.model } : null),
        ...(typeof data.visionModel === 'string' && data.visionModel
          ? { visionModel: data.visionModel }
          : null),
        createdAt:
          typeof data.createdAt === 'string' && data.createdAt
            ? data.createdAt
            : new Date().toISOString(),
        snapshot,
      };
      store.setCurrentReview(result);
    } catch (cause) {
      if (version !== generation.current) return;
      const aborted = cause instanceof Error && cause.name === 'AbortError';
      setError(aborted ? '评分超时，请稍后重试。' : cause instanceof Error ? cause.message : '评分暂时不可用。');
    } finally {
      clearTimeout(timeout);
      if (controller.current === abort) controller.current = null;
      if (version === generation.current) setBusy(false);
    }
  };

  return (
    <div className="ai-review" data-testid="ai-review">
      <button className="btn" disabled={busy} onClick={() => void run()}>
        {busy ? '正在观察与评审…' : current ? '再看一次点评' : '请 AI 看看这束花'}
      </button>
      <p className="decor-note">
        点击后将成品照与花材资料发送至魔搭：视觉模型观察，DeepSeek 1017 点评。审美评分仅供参考，不影响心愿达成。
      </p>
      {error ? (
        <p role="alert" data-testid="ai-review-error">
          {error}
        </p>
      ) : null}
      {current ? (
        <div aria-live="polite" data-testid="ai-review-result" data-state="current">
          <strong className="ai-score" data-testid="ai-review-score">
            {current.score}
            <small> / 100</small>
          </strong>
          {current.summary ? <p>{current.summary}</p> : null}
          {current.strengths.map((item, index) => (
            <p key={`s${index}`}>✦ {item}</p>
          ))}
          {current.suggestions.map((item, index) => (
            <p key={`a${index}`}>建议：{item}</p>
          ))}
          <p className="review-meta" data-testid="ai-review-meta">
            {current.model ? `点评 ${current.model}` : '点评模型未知'}
            {current.visionModel ? ` · 视觉 ${current.visionModel}` : ''} ·{' '}
            {formatReviewedAt(current.createdAt)}
          </p>
          <p className="decor-note">
            这条点评属于当前画面：拍照存相册、交付或接单归档时会一起存到这张照片上。
          </p>
        </div>
      ) : null}
      {stale && !busy ? (
        <p className="review-stale" data-testid="ai-review-stale">
          画面已经变了，之前那张照片的点评不再代表现在这一帧（它的点评仍随原照片留在相册里）。
        </p>
      ) : null}
      {!current && !stale ? (
        <p className="decor-note">转镜头或改动作品后，旧点评会自动隐藏；重新点一次即可为现在的画面试评。</p>
      ) : null}
    </div>
  );
}
