/**
 * V16 音乐轮：API 生成的背景音乐（BGM）接入验证（真实浏览器，连已运行的 Vite dev server）。
 *
 * 覆盖：
 * 1) 页面加载后、首次用户手势前：不创建 background <audio> 元素、不发任何音频请求；
 * 2) 第一次真实用户手势（pointerdown）后 BGM 自动播放：HTMLAudioElement 存在、
 *    src 为同源本地 /assets/audio/、loop=true、音量 = master × 0.35、currentTime 前进；
 * 3) 顶栏音频面板：BGM 开关可暂停/恢复（暂停后 paused=true 且 currentTime 不前进）；
 * 4) 静音联动：静音后 BGM 元素 muted=true、音量 0、不报错；取消静音后恢复；
 * 5) 音量联动：主音量 0.5 时 BGM 元素音量 = 0.175（0.5 × 0.35），与动作音效分开；
 * 6) 切后台（visibilitychange + hidden）暂停 BGM，回前台自动恢复且不回到开头；
 * 7) 刷新后偏好保留：bgm=false 不自动播放；重新打开后自动播放；音量同样保留；
 * 8) 全程只请求本地 /assets/audio/ 下的音频，无外部音频请求、无页面脚本错误。
 *
 * 运行：先保证 dev server 在 http://127.0.0.1:5173，然后
 *   cd app && node scripts/v16-music.mjs
 * 环境变量：SMOKE_URL、V16_OUT、HEADED。
 *
 * 说明：自动检查只能验证播放/暂停/音量/请求与持久化，不能替真人判断音乐是否好听；
 * 生成来源、费用与许可见 docs/v16-music-api-record.md，生成脚本 scripts/make_music_api.py。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const SITE_URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.V16_OUT ?? '.verify/v16-music';
const SETTINGS_KEY = 'bouquet-workbench.settings.v1';
const BGM_RATIO = 0.35;
const AUDIO_PATH = /^\/assets\/audio\/ambient-calm-[12]\.mp3$/;
mkdirSync(OUT, { recursive: true });

const checks = [];
let failed = 0;
let skipped = 0;

function must(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), kind: 'must', detail });
  if (!ok) {
    failed += 1;
    console.error('FAIL', name, detail === undefined ? '' : JSON.stringify(detail));
  } else {
    console.log('ok  ', name, detail === undefined ? '' : JSON.stringify(detail));
  }
}

function info(name, detail) {
  checks.push({ name, ok: true, kind: 'info', detail });
  console.log('info', name, detail === undefined ? '' : JSON.stringify(detail));
}

function skip(name, detail) {
  skipped += 1;
  checks.push({ name, ok: false, kind: 'skip', detail });
  console.log('skip', name, detail === undefined ? '' : JSON.stringify(detail));
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: process.env.HEADED !== '1',
  args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const pageErrors = [];
const consoleErrors = [];
const audioRequests = [];
const origins = new Set();
let context = null;
let page = null;
let wiring = 'unknown';

function attachPage() {
  page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.includes('404')) return;
    consoleErrors.push(text);
  });
  page.on('request', (request) => {
    const url = request.url();
    try {
      origins.add(new URL(url).origin);
    } catch {
      /* ignore */
    }
    if (/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)(\?|$)/i.test(url)) audioRequests.push(url);
  });
}

async function freshSession() {
  if (context) await context.close().catch(() => {});
  pageErrors.length = 0;
  consoleErrors.length = 0;
  audioRequests.length = 0;
  origins.clear();
  checks.length = 0;
  failed = 0;
  skipped = 0;
  context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  page = await context.newPage();
  attachPage();
}
await freshSession();

const wait = (ms) => page.waitForTimeout(ms);
const audioState = () =>
  page.evaluate(async () => {
    const api = window.__bouquetDebug?.audio;
    if (api?.state) return api.state();
    const mod = await import('/src/audio/engine.ts');
    return mod.getAudioDebug();
  });
const bgmState = async () => (await audioState()).bgm;
const storeState = () => page.evaluate(() => window.__bouquetDebug.getState());
const settings = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), SETTINGS_KEY);
const domAudio = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid=bgm-audio]');
    if (!el) return null;
    let url = null;
    try {
      url = new URL(el.currentSrc || el.src, location.href);
    } catch {
      /* ignore */
    }
    return {
      tag: el.tagName,
      src: el.getAttribute('src'),
      currentSrc: el.currentSrc,
      path: url ? url.pathname : null,
      origin: url ? url.origin : null,
      sameOrigin: url ? url.origin === location.origin : false,
      loop: el.loop,
      muted: el.muted,
      paused: el.paused,
      volume: Math.round(el.volume * 1000) / 1000,
      currentTime: Math.round(el.currentTime * 100) / 100,
      duration: Number.isFinite(el.duration) ? Math.round(el.duration * 100) / 100 : 0,
      readyState: el.readyState,
      error: el.error ? { code: el.error.code, message: el.error.message } : null,
    };
  });

async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
}

async function waitForBgm(predicate, timeout = 8000) {
  const start = Date.now();
  let last = await bgmState();
  while (Date.now() - start < timeout) {
    if (predicate(last)) return last;
    await page.waitForTimeout(120);
    last = await bgmState();
  }
  return last;
}

/** 进入工作台：首次打开（没有存档）直接进；刷新后有存档会先到开屏。 */
async function enterWorkbench() {
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid=start-continue], [data-testid=audio-toggle], [data-testid=start-blank]')),
    null,
    { timeout: 60000 },
  );
  const continued = await page.getByTestId('start-continue').count();
  if (continued) {
    await page.getByTestId('start-continue').click();
  }
  await page.waitForSelector('[data-testid=audio-toggle]', { timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__bouquetDebug), null, { timeout: 60000 });
  return continued > 0 ? 'start-continue' : 'direct';
}

async function openAudioPanel() {
  if (await page.getByTestId('audio-panel').count() === 0) {
    await page.getByTestId('audio-toggle').click();
    await page.waitForSelector('[data-testid=audio-panel]', { timeout: 5000 });
  }
}

async function closeAudioPanel() {
  if (await page.getByTestId('audio-panel').count() > 0) {
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid=audio-panel]', { state: 'detached' }).catch(() => {});
  }
}

async function setVisibility(hidden) {
  await page.evaluate((value) => {
    if (value) {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    } else {
      delete document.hidden;
      delete document.visibilityState;
    }
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

const isNavigationLost = (error) =>
  /Execution context was destroyed|Target page, context or browser has been closed|ERR_ABORTED|not attached|navigat/i.test(
    String(error?.message ?? error),
  );

for (let attempt = 1; attempt <= 3; attempt += 1) {
  if (attempt > 1) {
    console.warn(`attempt ${attempt}: 上一次运行被页面刷新打断，换新会话重试`);
    await freshSession();
  }
  try {
    // ---------- 0. 首次手势前：不创建 audio 元素、不发音频请求 ----------
    await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=audio-toggle]', { timeout: 60000 });
    await page.waitForFunction(() => Boolean(window.__bouquetDebug), null, { timeout: 60000 });
    wiring = await page.evaluate(() => (window.__bouquetDebug?.audio?.state ? 'app' : 'module-fallback'));
    info('debug wiring', wiring);
    const initial = await bgmState();
    must(
      '首次手势前不创建 BGM 元素',
      (await domAudio()) === null && initial.playing === false && initial.track === null,
      { dom: await domAudio(), bgm: initial },
    );
    must('首次手势前无音频网络请求', audioRequests.length === 0, [...audioRequests]);
    await shot('00-initial');

    // ---------- 1. 第一次真实手势后开始播放 ----------
    await page.mouse.click(1180, 690); // 画布空白：只作为首个用户手势
    const started = await waitForBgm((bgm) => bgm.playing === true, 8000);
    // play() 之后元数据可能还没到（headless 下 readyState 偶发为 0），等 duration 可读再断言。
    await page
      .waitForFunction(
        () => {
          const el = document.querySelector('[data-testid=bgm-audio]');
          return Boolean(el) && Number.isFinite(el.duration) && el.duration > 0;
        },
        null,
        { timeout: 8000 },
      )
      .catch(() => {});
    const audio1 = await domAudio();
    must(
      '首次手势后 BGM 开始播放',
      started.playing === true && started.paused === false && started.enabled === true,
      started,
    );
    must(
      'BGM 元素 src 为同源本地 /assets/audio/',
      Boolean(audio1) && audio1.tag === 'AUDIO' && audio1.sameOrigin === true && AUDIO_PATH.test(audio1.path ?? ''),
      audio1,
    );
    must('BGM 元素 loop=true', audio1?.loop === true, audio1?.loop);
    const stateAfterStart = await audioState();
    must(
      'BGM 音量恒为主音量 × 0.35（低于动作音）',
      Math.abs((audio1?.volume ?? -1) - stateAfterStart.volume * BGM_RATIO) <= 0.011,
      { bgmVolume: audio1?.volume, master: stateAfterStart.volume, ratio: BGM_RATIO },
    );
    must(
      '曲目为生成的循环音频（40–45s）',
      (audio1?.duration ?? 0) >= 39 && (audio1?.duration ?? 0) <= 46,
      audio1?.duration,
    );
    const timeBefore = audio1?.currentTime ?? 0;
    await wait(1200);
    const timeAfter = (await domAudio())?.currentTime ?? 0;
    must('BGM 时间在前进', timeAfter > timeBefore, { before: timeBefore, after: timeAfter });
    wait(400);
    await shot('01-bgm-playing');

    // ---------- 2. BGM 开关：暂停 / 恢复 ----------
    await openAudioPanel();
    must('音频面板出现 BGM 开关', (await page.getByTestId('audio-bgm').count()) === 1, true);
    await page.getByTestId('audio-bgm').click();
    const paused = await waitForBgm((bgm) => bgm.playing === false, 4000);
    const pausedEl = await domAudio();
    must(
      '关闭 BGM 后暂停',
      paused.playing === false && pausedEl?.paused === true,
      { bgm: paused, el: pausedEl },
    );
    const frozenAt = pausedEl?.currentTime ?? 0;
    await wait(700);
    const stillFrozen = (await domAudio())?.currentTime ?? 0;
    must('暂停后时间不再前进', Math.abs(stillFrozen - frozenAt) < 0.2, { before: frozenAt, after: stillFrozen });
    await shot('02-bgm-paused');

    await page.getByTestId('audio-bgm').click();
    const resumed = await waitForBgm((bgm) => bgm.playing === true, 5000);
    must('重新打开 BGM 后继续播放', resumed.playing === true, resumed);
    const resumedEl = await domAudio();
    must('恢复后从暂停处继续（不是重头）', (resumedEl?.currentTime ?? 0) >= frozenAt, {
      frozenAt,
      now: resumedEl?.currentTime,
    });
    await shot('03-bgm-resumed');

    // ---------- 3. 静音联动 ----------
    await page.getByTestId('audio-mute').click();
    const muted = await waitForBgm((bgm) => bgm.muted === true, 4000);
    const mutedEl = await domAudio();
    must(
      '静音后 BGM 元素静音且音量为 0',
      muted.muted === true && mutedEl?.muted === true && (mutedEl?.volume ?? -1) === 0,
      { bgm: muted, el: mutedEl },
    );
    await wait(600);
    must('静音不报错、仍在播放（可恢复）', mutedEl?.error == null && (await domAudio())?.paused === false, {
      error: mutedEl?.error,
      paused: (await domAudio())?.paused,
    });
    await shot('04-muted');
    await page.getByTestId('audio-mute').click();
    await wait(300);
    const unmutedEl = await domAudio();
    const st = await audioState();
    must(
      '取消静音后 BGM 恢复可听音量',
      unmutedEl?.muted === false &&
        Math.abs((unmutedEl?.volume ?? -1) - st.volume * BGM_RATIO) <= 0.011,
      { el: unmutedEl, master: st.volume },
    );

    // ---------- 4. 音量联动（主音量 50% → BGM 17.5%） ----------
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid=audio-volume]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '50');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await wait(400);
    const volState = await audioState();
    const volEl = await domAudio();
    must('主音量改为 50% 并持久化', Math.abs(volState.volume - 0.5) < 0.01, volState.volume);
    must(
      'BGM 音量随主音量联动为 0.175（0.5 × 0.35）',
      Math.abs((volEl?.volume ?? -1) - 0.175) <= 0.011,
      { bgmVolume: volEl?.volume, expected: 0.5 * BGM_RATIO },
    );
    await shot('05-volume-linked');

    // ---------- 5. 切后台暂停 / 回前台恢复 ----------
    await setVisibility(true);
    const hidden = await waitForBgm((bgm) => bgm.playing === false && bgm.hiddenPauses >= 1, 4000);
    const hiddenEl = await domAudio();
    must(
      '切后台（hidden）暂停 BGM',
      hidden.playing === false && hiddenEl?.paused === true && hidden.hiddenPauses >= 1,
      { bgm: hidden, el: hiddenEl },
    );
    const hiddenAt = hiddenEl?.currentTime ?? 0;
    await wait(600);
    must('后台期间不补播', (await domAudio())?.paused === true, (await domAudio())?.paused);
    await shot('06-hidden-paused');
    await setVisibility(false);
    const visible = await waitForBgm((bgm) => bgm.playing === true && bgm.visibleResumes >= 1, 5000);
    const visibleEl = await domAudio();
    must(
      '回前台后自动恢复 BGM',
      visible.playing === true && visibleEl?.paused === false && visible.visibleResumes >= 1,
      { bgm: visible, el: visibleEl },
    );
    must('恢复后从暂停处继续', (visibleEl?.currentTime ?? 0) >= hiddenAt, { hiddenAt, now: visibleEl?.currentTime });
    await shot('07-visible-resumed');

    // ---------- 6. 刷新后偏好保留（先种一枝花，让刷新走开屏） ----------
    await closeAudioPanel();
    const beforeReload = await storeState();
    if (beforeReload.doc.stems.length === 0) {
      await page.evaluate(() => window.__bouquetDebug.store.placeStem({ height: 0.02, tilt: 16, direction: 20, spin: 30 }));
      await wait(400);
    }
    await page.getByTestId('audio-toggle').click();
    await page.getByTestId('audio-bgm').click(); // 关掉 BGM，验证偏好持久化
    await wait(300);
    const stored = await settings();
    must(
      'BGM 开关写入本机设置（bgm=false）',
      stored?.audio?.bgm === false && Math.abs((stored?.audio?.volume ?? -1) - 0.5) < 0.02,
      stored?.audio,
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    const enterPath = await enterWorkbench();
    info('刷新后入口', enterPath);
    const reloadStored = await settings();
    const bgmBeforeGesture = await bgmState();
    must(
      '刷新后 BGM 偏好仍为关闭',
      reloadStored?.audio?.bgm === false && bgmBeforeGesture.enabled === false,
      { stored: reloadStored?.audio, bgm: bgmBeforeGesture },
    );
    must('关闭偏好下不创建 BGM 元素', (await domAudio()) === null, await domAudio());
    // 开屏「继续」那一下可能发生在 App 挂载前；再点一次画布确保手势监听已就位。
    await page.mouse.click(1180, 690);
    await wait(1000);
    must(
      '刷新后关闭状态不会被自动打开',
      (await bgmState()).playing === false && (await domAudio()) === null,
      await bgmState(),
    );
    await shot('08-after-reload-bgm-off');

    await openAudioPanel();
    must(
      '刷新后 BGM 开关显示关闭',
      (await page.getByTestId('audio-bgm').getAttribute('aria-checked')) === 'false',
      await page.getByTestId('audio-bgm').getAttribute('aria-checked'),
    );
    await page.getByTestId('audio-bgm').click();
    const reopened = await waitForBgm((bgm) => bgm.playing === true, 5000);
    must('重新打开后 BGM 播放', reopened.playing === true, reopened);
    const reopenedEl = await domAudio();
    must(
      '刷新后音量 50% 仍保留（BGM 0.175）',
      Math.abs((reopenedEl?.volume ?? -1) - 0.175) <= 0.011,
      { el: reopenedEl },
    );
    await shot('09-after-reload-bgm-on');

    // ---------- 7. 无外部音频请求、无页面错误 ----------
    const localAudio = [];
    const foreignAudio = [];
    for (const url of audioRequests) {
      try {
        const parsed = new URL(url);
        if (parsed.origin === new URL(SITE_URL).origin && AUDIO_PATH.test(parsed.pathname)) localAudio.push(url);
        else foreignAudio.push(url);
      } catch {
        foreignAudio.push(url);
      }
    }
    must('所有音频请求都是本地 /assets/audio/', foreignAudio.length === 0, foreignAudio.slice(0, 5));
    must('确实请求到生成的 BGM 文件', localAudio.length > 0, localAudio.slice(0, 5));
    must('无页面脚本错误', pageErrors.length === 0, pageErrors.slice(0, 5));
    must('无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 10));
    info('访问过的资源来源', [...origins]);

    break; // 本次尝试全部通过；不再跑重试会话
  } catch (error) {
    if (isNavigationLost(error) && attempt < 3) {
      console.warn(
        `attempt ${attempt} 被页面刷新打断，换新会话重试：`,
        String(error?.message ?? error).slice(0, 160),
      );
      continue;
    }
    failed += 1;
    checks.push({ name: '脚本执行中断', ok: false, kind: 'must', detail: String(error?.stack ?? error) });
    console.error('ABORT', error);
    try {
      await shot('99-abort');
    } catch {
      /* ignore */
    }
    break;
  }
}

const summary = {
  url: SITE_URL,
  at: new Date().toISOString(),
  wiring,
  passed: checks.filter((item) => item.ok && item.kind !== 'info').length,
  failed,
  skipped,
  pageErrors,
  consoleErrors: consoleErrors.slice(0, 10),
  audioRequests,
  origins: [...origins],
  checks,
};
writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
const lines = [
  '# V16 音乐轮 · API 背景音乐接入验证',
  '',
  `- 时间：${summary.at}`,
  `- 地址：${SITE_URL}`,
  `- debug 接线：${wiring}`,
  `- 通过：${summary.passed} / 失败：${failed} / 跳过：${skipped}`,
  '',
  '| 结果 | 检查项 | 细节 |',
  '| --- | --- | --- |',
  ...checks.map((item) => {
    const result = item.kind === 'info' ? 'info' : item.ok ? 'PASS' : item.kind === 'skip' ? 'SKIP' : 'FAIL';
    const detail = item.detail === undefined ? '' : JSON.stringify(item.detail).replaceAll('|', '\\|').slice(0, 600);
    return `| ${result} | ${item.name} | ${detail} |`;
  }),
  '',
  '说明：BGM 为 ModelScope API-Inference（ACE-Step）真实生成、ffmpeg 处理成本地循环文件；',
  '自动检查覆盖播放/暂停/音量/静音/切后台/持久化/本地请求，不替代真人听感验收。',
];
writeFileSync(`${OUT}/summary.md`, `${lines.join('\n')}\n`);
console.log(`\nsummary: ${OUT}/summary.md  passed=${summary.passed} failed=${failed} skipped=${skipped}`);
await browser.close();
process.exit(failed > 0 ? 1 : 0);
