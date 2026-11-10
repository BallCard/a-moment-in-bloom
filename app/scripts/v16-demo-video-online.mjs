/**
 * Demo 视频托管页线上核验（匿名、真实 Chrome，走魔搭公开入口的真实评审路径）。
 * 1) 创空间页面 200，应用帧地址指向本空间 ms.show
 * 2) 应用帧内是视频播放页，video 元数据 1920x1080 / ~90s
 * 3) 真实播放 2.5 秒（currentTime 前进）
 * 4) 应用帧与 mp4 资源均无脚本错误、无 404
 * 5) 截图存档
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const out = '.verify/v16-demo-video';
mkdirSync(out, { recursive: true });
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(ok ? 'ok  ' : 'FAIL', name, JSON.stringify(detail ?? ''));
}

const APP_HOST = 'https://ballcard-bouquet-demo-video.ms.show/';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const badResponses = [];
let failed = true;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => {
    if (r.url().startsWith(APP_HOST) && r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
  });

  const resp = await page.goto('https://www.modelscope.cn/studios/BallCard/bouquet-demo-video?mode=full', {
    timeout: 180000,
    waitUntil: 'domcontentloaded',
  });
  check('studio wrapper page 200', resp && resp.status() === 200, { status: resp?.status() });

  let frame = null;
  for (let i = 0; i < 60; i++) {
    frame = page.frames().find((f) => f.url().startsWith(APP_HOST));
    if (frame) break;
    await page.waitForTimeout(1000);
  }
  check('app frame mounted', Boolean(frame), { frameUrl: frame?.url() });
  if (!frame) throw new Error('app frame not found');

  const title = await frame.title();
  check('app frame title is demo video page', title.includes('花间一刻') && title.includes('Demo'), { title });

  await frame.waitForSelector('video', { timeout: 60000 });
  const meta = await frame.evaluate(async () => {
    const v = document.querySelector('video');
    if (v.readyState < 1) {
      await new Promise((resolve, reject) => {
        v.addEventListener('loadedmetadata', resolve, { once: true });
        v.addEventListener('error', () => reject(new Error('video error code ' + (v.error && v.error.code))), { once: true });
        setTimeout(() => reject(new Error('metadata timeout')), 90000);
      });
    }
    return { readyState: v.readyState, duration: v.duration, width: v.videoWidth, height: v.videoHeight, poster: v.poster };
  });
  check(
    'video metadata 1920x1080 / ~90s / poster set',
    meta.width === 1920 && meta.height === 1080 && Math.abs(meta.duration - 90) < 1.5 && /poster\.jpg$/.test(meta.poster),
    meta,
  );

  const played = await frame.evaluate(async () => {
    const v = document.querySelector('video');
    v.muted = true;
    const before = v.currentTime;
    try {
      await v.play();
    } catch (e) {
      return { error: String(e) };
    }
    await new Promise((r) => setTimeout(r, 2500));
    const after = v.currentTime;
    v.pause();
    return { before, after, advanced: Number((after - before).toFixed(2)), buffered: v.buffered.length };
  });
  check('video truly plays (currentTime advances > 1s)', played.advanced > 1, played);

  // 片尾二维码画面所在位置可 seek（模拟拖动到结尾，验证 range 支持）
  const seek = await frame.evaluate(async () => {
    const v = document.querySelector('video');
    await new Promise((resolve) => {
      const done = () => resolve();
      v.addEventListener('seeked', done, { once: true });
      v.currentTime = 88.5;
      setTimeout(done, 15000);
    });
    return { currentTime: v.currentTime, readyState: v.readyState };
  });
  check('seek to 88.5s works (range requests ok)', Math.abs(seek.currentTime - 88.5) < 2, seek);
  await page.screenshot({ path: `${out}/studio-wrapper.png` });
  await frame.evaluate(() => {
    const v = document.querySelector('video');
    v.currentTime = 89.2;
    v.pause();
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/player-endcard.png` });

  check('no page errors', errors.length === 0, errors.slice(0, 5));
  check('no 4xx/5xx from app host', badResponses.length === 0, badResponses.slice(0, 5));
  await context.close();
  failed = checks.some((c) => !c.ok);
} catch (e) {
  check('unexpected failure', false, String(e));
} finally {
  writeFileSync(`${out}/results.json`, JSON.stringify({ checks, pageErrors: errors, badResponses }, null, 2));
  await browser.close();
}
console.log(failed ? `FAILED ${checks.filter((c) => !c.ok).length}/${checks.length}` : `PASS ${checks.length}/${checks.length}`);
process.exit(failed ? 1 : 0);
