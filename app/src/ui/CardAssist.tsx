/**
 * 贺卡两个次级入口（V16 §7）：常用短语 + AI 润色。
 *
 * 约束（见 docs/flower-workflow-upgrade-plan.md §7）：
 * - 常用短语插入后可继续改；正文非空时先确认「替换 / 追加」，不悄悄覆盖；
 * - AI 只基于已有文字润色，一次点击生成建议，**采用后**才替换正文；
 * - 采用与插入都走 store 的 `applyCardMessage` / `setCardField`，一次点击一条撤销；
 * - 空正文先提示写一句或选短语，不发请求；
 * - 请求期间可以取消、可以继续编辑；迟到的结果不覆盖新正文，失败保留原文；
 * - 不编造关系与经历（服务端提示词同样约束），遵守 CARD_MESSAGE_MAX。
 */

import { useEffect, useRef, useState } from 'react';
import {
  CARD_PHRASE_GROUPS,
  appendPhrase,
  fitsWithCurrent,
  phraseReplacesMessage,
  type CardPhraseOccasion,
} from '../data/card-phrases';
import { clampText } from '../data/decor';
import { CARD_MESSAGE_MAX } from '../config';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';

/** /api/polish 的响应形状（model/createdAt 由服务端给出）。 */
interface PolishResponse {
  text?: unknown;
  model?: unknown;
  createdAt?: unknown;
  error?: unknown;
  code?: unknown;
}

type PolishState =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'ready'; text: string; model?: string }
  | { status: 'stale' }
  | { status: 'error'; message: string };

const POLISH_TIMEOUT_MS = 30000;

function polishErrorText(status: number, data: PolishResponse): string {
  const code = typeof data.code === 'string' ? data.code : '';
  if (code === 'not_configured') return '本地 AI 润色服务还没配置凭据，正文可以照常手写。';
  if (code === 'quota' || status === 429) return '魔搭额度或频率暂时受限，请稍后再试；正文保持原样。';
  if (code === 'busy') return '正在润色，请稍等一下再点；正文保持原样。';
  if (code === 'invalid_input') return '要润色的文字格式不正确（可能太长），正文保持原样。';
  if (typeof data.error === 'string' && data.error) return data.error;
  if (status === 503) return '本地 AI 润色服务未配置或暂不可用，正文保持原样。';
  if (status >= 500) return '润色服务暂时没有完成，正文保持原样。';
  return '润色没有成功，正文保持原样。';
}

function useCardMessage(): string {
  return useAppState((state) => state.doc.card.message);
}

/**
 * 常用短语：按场合分组，点一下插入正文。
 * 正文非空时先给出「替换 / 追加 / 取消」确认，绝不未经确认覆盖已有文字。
 */
function PhrasePanel(): React.JSX.Element {
  const message = useCardMessage();
  const [occasion, setOccasion] = useState<CardPhraseOccasion>('birthday');
  const [pending, setPending] = useState<string | null>(null);
  const group = CARD_PHRASE_GROUPS.find((item) => item.id === occasion) ?? CARD_PHRASE_GROUPS[0];

  const pick = (phrase: string): void => {
    if (phraseReplacesMessage(message)) {
      setPending(phrase);
      return;
    }
    store.setCardField('message', phrase);
    store.toast('短语已插入正文，可以直接改，也能一次撤销', 'success');
  };

  const replace = (): void => {
    if (!pending) return;
    store.setCardField('message', pending);
    store.toast('已用这条短语替换正文，原句可以撤销找回', 'info');
    setPending(null);
  };

  const append = (): void => {
    if (!pending) return;
    store.setCardField('message', appendPhrase(message, pending));
    store.toast('短语接在正文后面了，可以接着改', 'success');
    setPending(null);
  };

  return (
    <div className="card-assist-body" data-testid="card-phrase-panel">
      <div className="card-phrase-tabs" role="tablist" aria-label="短语场合">
        {CARD_PHRASE_GROUPS.map((item) => (
          <button
            type="button"
            role="tab"
            key={item.id}
            className={`card-phrase-tab ${item.id === group.id ? 'is-on' : ''}`}
            data-testid={`phrase-group-${item.id}`}
            aria-selected={item.id === group.id}
            onClick={() => setOccasion(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <p className="card-assist-hint" data-testid="phrase-hint">
        {group.hint}
      </p>
      <div className="card-phrase-list">
        {group.phrases.map((phrase, index) => (
          <button
            type="button"
            key={phrase}
            className="card-phrase-item"
            data-testid={`phrase-${group.id}-${index}`}
            onClick={() => pick(phrase)}
          >
            {phrase}
          </button>
        ))}
      </div>
      {pending ? (
        <div className="card-assist-confirm" role="status" data-testid="phrase-confirm">
          <p>正文里已经有字了。这条短语要怎么放？</p>
          <p className="card-assist-preview">{pending}</p>
          <div className="card-assist-actions">
            <button type="button" className="btn btn-small btn-primary" data-testid="phrase-replace" onClick={replace}>
              替换现有正文
            </button>
            <button
              type="button"
              className="btn btn-small"
              data-testid="phrase-append"
              disabled={!fitsWithCurrent(message, pending)}
              title={fitsWithCurrent(message, pending) ? '接在现有正文后面' : '加上去会超过字数上限，可以选替换'}
              onClick={append}
            >
              接在后面
            </button>
            <button type="button" className="btn btn-small" data-testid="phrase-cancel" onClick={() => setPending(null)}>
              取消
            </button>
          </div>
          {!fitsWithCurrent(message, pending) ? (
            <p className="card-assist-hint">正文加上这条会超过 {CARD_MESSAGE_MAX} 字，可以选「替换」。</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * AI 润色：基于已有正文一次生成建议，采用后才替换。
 * 迟到结果、取消、失败都不动正文。
 */
function PolishPanel(): React.JSX.Element {
  const card = useAppState((state) => state.doc.card);
  const [state, setState] = useState<PolishState>({ status: 'idle' });
  const [emptyHint, setEmptyHint] = useState(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const cancelled = useRef(false);
  const baseText = useRef('');

  useEffect(() => () => {
    generation.current += 1;
    cancelled.current = true;
    controller.current?.abort();
    controller.current = null;
  }, []);

  const run = async (): Promise<void> => {
    const text = card.message.trim();
    if (!text) {
      setEmptyHint(true);
      setState({ status: 'idle' });
      return;
    }
    setEmptyHint(false);
    generation.current += 1;
    const version = generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    cancelled.current = false;
    baseText.current = card.message;
    let timedOut = false;
    setState({ status: 'busy' });
    const timer = window.setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, POLISH_TIMEOUT_MS);
    try {
      const payload: Record<string, string> = { text };
      if (card.to.trim()) payload.to = card.to.trim();
      if (card.from.trim()) payload.from = card.from.trim();
      const response = await fetch('/api/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: abort.signal,
      });
      const data = (await response.json().catch(() => ({}))) as PolishResponse;
      if (version !== generation.current || cancelled.current) return;
      if (!response.ok) {
        setState({ status: 'error', message: polishErrorText(response.status, data) });
        return;
      }
      const suggestion = typeof data.text === 'string' ? data.text.trim() : '';
      if (!suggestion) {
        setState({ status: 'error', message: 'AI 没有给出润色结果，正文保持原样。' });
        return;
      }
      // 迟到结果：请求期间正文被改过，就不把这条建议贴到新文字上。
      if (store.getState().doc.card.message !== baseText.current) {
        setState({ status: 'stale' });
        return;
      }
      setState({
        status: 'ready',
        text: clampText(suggestion, CARD_MESSAGE_MAX),
        ...(typeof data.model === 'string' && data.model ? { model: data.model } : null),
      });
    } catch (error) {
      if (version !== generation.current) return;
      if (cancelled.current) return;
      const aborted = error instanceof Error && error.name === 'AbortError';
      setState({
        status: 'error',
        message: aborted
          ? timedOut
            ? '润色超时了，正文保持原样，可以再试一次。'
            : '润色请求已停止，正文保持原样。'
          : '连不上本地润色服务，正文保持原样（作品可以照常保存）。',
      });
    } finally {
      window.clearTimeout(timer);
      if (controller.current === abort) controller.current = null;
    }
  };

  const cancel = (): void => {
    generation.current += 1;
    cancelled.current = true;
    controller.current?.abort();
    controller.current = null;
    setState({ status: 'idle' });
  };

  const apply = (): void => {
    if (state.status !== 'ready') return;
    if (store.applyCardMessage(state.text)) {
      store.toast('已采用润色后的句子，原句可以撤销找回', 'success');
      setState({ status: 'idle' });
    } else {
      setState({ status: 'error', message: '这句和正文一样，没有需要替换的内容。' });
    }
  };

  const busy = state.status === 'busy';
  const editedDuring = busy && card.message !== baseText.current;

  return (
    <div className="card-assist-body" data-testid="card-polish-panel">
      <p className="card-assist-hint">
        只把这段文字发给本地服务端的魔搭模型（不发照片）：只润色、不新增事实、不编造关系。采用后才替换正文，原句可以撤销找回。
      </p>
      <div className="card-assist-actions">
        <button
          type="button"
          className="btn btn-small"
          data-testid="card-assist-polish-run"
          disabled={busy}
          onClick={() => void run()}
        >
          {busy ? '正在润色…' : state.status === 'ready' ? '换一条建议' : '润色这句话'}
        </button>
        {busy ? (
          <button type="button" className="btn btn-small btn-danger" data-testid="card-assist-cancel" onClick={cancel}>
            取消
          </button>
        ) : null}
      </div>
      {emptyHint ? (
        <p className="card-assist-hint is-warn" data-testid="card-assist-empty-hint">
          正文还是空的：先写一句，或从「常用短语」里挑一条，再来润色。
        </p>
      ) : null}
      {busy ? (
        <p className="card-assist-hint" data-testid="card-assist-busy">
          {editedDuring
            ? '正文改过了：这次结果到达后不会替换你现在的文字。'
            : '正在等建议。这期间可以继续改正文，也可以取消。'}
        </p>
      ) : null}
      {state.status === 'ready' ? (
        <div className="card-assist-suggestion" data-testid="card-assist-suggestion" aria-live="polite">
          <p className="card-assist-suggestion-label">建议（还没有替换正文）</p>
          <p className="card-assist-suggestion-text" data-testid="card-assist-suggestion-text">
            {state.text}
          </p>
          <div className="card-assist-actions">
            <button type="button" className="btn btn-small btn-primary" data-testid="card-assist-apply" onClick={apply}>
              采用这句
            </button>
            <button
              type="button"
              className="btn btn-small"
              data-testid="card-assist-discard"
              onClick={() => setState({ status: 'idle' })}
            >
              不用了
            </button>
          </div>
          {state.model ? (
            <p className="card-assist-meta" data-testid="card-assist-meta">
              润色模型 {state.model}
            </p>
          ) : null}
        </div>
      ) : null}
      {state.status === 'stale' ? (
        <p className="card-assist-hint is-warn" data-testid="card-assist-stale">
          正文在请求期间改过了，这次建议没有采用；现在的文字保持原样。
        </p>
      ) : null}
      {state.status === 'error' ? (
        <p className="card-assist-error" role="alert" data-testid="card-assist-error">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

/** 挂在贺卡编辑块里：两个次级入口，默认收起。 */
export function CardAssist(): React.JSX.Element {
  const [tab, setTab] = useState<'none' | 'phrase' | 'polish'>('none');
  return (
    <div className={`card-assist ${tab === 'none' ? 'is-collapsed' : ''}`} data-testid="card-assist">
      <div className="card-assist-entries">
        <button
          type="button"
          className={`card-assist-entry ${tab === 'phrase' ? 'is-on' : ''}`}
          data-testid="card-assist-phrases"
          aria-expanded={tab === 'phrase'}
          onClick={() => setTab(tab === 'phrase' ? 'none' : 'phrase')}
        >
          常用短语
        </button>
        <button
          type="button"
          className={`card-assist-entry ${tab === 'polish' ? 'is-on' : ''}`}
          data-testid="card-assist-polish"
          aria-expanded={tab === 'polish'}
          onClick={() => setTab(tab === 'polish' ? 'none' : 'polish')}
        >
          AI 润色
        </button>
      </div>
      {tab === 'phrase' ? <PhrasePanel /> : null}
      {tab === 'polish' ? <PolishPanel /> : null}
    </div>
  );
}
