/**
 * AI 贺卡润色（V16 §7）—— 服务端实现。
 *
 * 与 review.mjs 同一套约定：
 * - 凭据只在服务端（index.mjs 读取环境变量或 ~/.modelscope/api-key.txt 后传进来）；
 * - 只发送文字（to / from / message），**不发图片**；
 * - 模型复用 DeepSeek 1017，普通 chat completions，非流式；
 * - 错误映射 busy / quota / not_configured / invalid_input，由 index.mjs 转成 HTTP 状态；
 * - 提示词要求：只润色、不新增事实、不编造关系、≤ 字数上限、返回纯文本。
 *
 * 验收脚本用 createPolisher({ key, fetchImpl }) 注入 mock fetch，不会真实消耗额度。
 */

import { createHash } from 'node:crypto';

export const POLISH_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
/** 与前端 CARD_MESSAGE_MAX 一致：贺卡正文上限。 */
export const POLISH_MAX_CHARS = 120;
/** 允许提交的原文长度上限（正文上限的 2 倍，留出「压缩改写」的空间）。 */
export const POLISH_MAX_INPUT_CHARS = 240;
const MAX_FIELD_CHARS = 40;
const DAILY_LIMIT = 120;
const COOLDOWN_MS = 1200;

const SYSTEM_PROMPT = [
  '你是贺卡文字的润色编辑。只做润色，不改主意。',
  '规则：',
  '1. 保留原意、语气与第一人称视角，让它更自然、温暖、顺口一点；可以精简啰嗦的地方。',
  '2. 绝不新增原文没有的事实、人物关系、称呼、经历、时间地点、礼物、承诺或祝福以外的信息。',
  '3. 收件人/署名只用来判断语气，不要据此虚构关系或身份。',
  '4. 不解释、不加前后缀、不用 Markdown、不换行，只返回润色后的纯文本。',
  '5. 不超过 120 个字符；宁可短，不要凑字数。',
].join('\n');

function charCount(value) {
  return Array.from(value).length;
}

function trimToLimit(value, limit) {
  const chars = Array.from(value);
  return chars.length > limit ? chars.slice(0, limit).join('') : value;
}

/** 请求体校验：只接受文字，字段长度与总长都有限制。 */
export function validatePolishInput(body) {
  if (!body || typeof body.text !== 'string') throw Error('invalid_input');
  const text = body.text.trim();
  if (!text || charCount(text) > POLISH_MAX_INPUT_CHARS) throw Error('invalid_input');
  const to = typeof body.to === 'string' ? body.to.trim() : '';
  const from = typeof body.from === 'string' ? body.from.trim() : '';
  if (charCount(to) > MAX_FIELD_CHARS || charCount(from) > MAX_FIELD_CHARS) throw Error('invalid_input');
  return { text, to, from };
}

/** 模型输出清洗：去代码围栏、引号、多余空行；不解释也不保留前后缀。 */
export function cleanPolishText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
    .replace(/^["“”'「『]+/, '')
    .replace(/["“”'」』]+$/, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** 模型输出校验：非空纯文本，超出字数就截到上限（不编造内容，只截断）。 */
export function validatePolishOutput(raw) {
  const text = cleanPolishText(raw);
  if (!text) throw Error('invalid_result');
  return trimToLimit(text, POLISH_MAX_CHARS);
}

export function createPolisher({ key, fetchImpl = fetch }) {
  const cache = new Map();
  let active = false;
  let last = 0;
  let day = '';
  let daily = 0;

  const completion = async (messages, max_tokens) => {
    const response = await fetchImpl('https://api-inference.modelscope.cn/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify({ model: POLISH_MODEL, messages, max_tokens, stream: false, enable_thinking: false }),
    });
    if (!response.ok) throw Error(response.status === 429 ? 'quota' : 'upstream');
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw Error('empty_result');
    return text;
  };

  return async (raw) => {
    const body = validatePolishInput(raw);
    if (!key) throw Error('not_configured');
    const hash = createHash('sha256')
      .update(JSON.stringify({ text: body.text, to: body.to, from: body.from }))
      .digest('hex');
    if (cache.has(hash)) return { ...cache.get(hash), cached: true };
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      daily = 0;
    }
    if (daily >= DAILY_LIMIT) throw Error('quota');
    // 润色是用户主动点的一次操作：只挡并发连点，不做点评那种长冷却。
    if (active || Date.now() - last < COOLDOWN_MS) throw Error('busy');
    active = true;
    last = Date.now();
    daily += 1;
    try {
      const result = await completion(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ to: body.to, from: body.from, text: body.text }) },
        ],
        500,
      );
      const polished = {
        text: validatePolishOutput(result),
        model: POLISH_MODEL,
        createdAt: new Date().toISOString(),
      };
      if (cache.size >= 40) cache.delete(cache.keys().next().value);
      cache.set(hash, polished);
      return polished;
    } finally {
      active = false;
    }
  };
}
