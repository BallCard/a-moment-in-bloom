/**
 * V14.1 线上核验：公开魔搭入口是否已经带上向日葵换色修复。
 *
 * 覆盖：health 0.14.1、manifest assetsVersion、sunflower-1 换色窗口 69、
 * 明黄缩略图与本地重渲染版本字节一致（sha256）、花材架搜索向日葵截图、
 * 无应用脚本错误。
 *
 * 用法：node scripts/v14.1-online.mjs
 */
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { newStudioAwarePage } from './studio-page.mjs';

const URL = process.env.ONLINE_URL ?? 'https://www.modelscope.cn/studios/BallCard/bouquet-workbench?mode=full';
const OUT = '.verify/v14.1-online';
mkdirSync(OUT, { recursive: true });

const EXPECTED_VERSION = '0.14.1';
const EXPECTED_ASSETS_VERSION = '2026-11-09.lux3d-recolor-fix';
const localThumb = readFileSync('public/assets/thumbs/sunflower-1.png');
const localSha = createHash('sha256').update(localThumb).digest('hex');

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await newStudioAwarePage(context);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// 魔搭平台外壳对匿名访客会返回 users/login/info 401，属平台会话探测，不是应用错误。
const platformNoise = (text) => text.includes('404') || text.includes('401') || text.includes('login/info');
page.on('console', (m) => { if (m.type() === 'error' && !platformNoise(m.text())) errors.push(m.text()); });

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(ok ? 'ok  ' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail));
};

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, { timeout: 240000 });
  await page.waitForTimeout(1500);

  const health = await page.evaluate(async () => {
    try {
      const response = await fetch('api/health', { cache: 'no-store' });
      return { status: response.status, body: await response.json().catch(() => null) };
    } catch (error) { return { status: 0, error: String(error) }; }
  });
  check(`线上健康检查版本 ${EXPECTED_VERSION}`, health.status === 200 && health.body?.version === EXPECTED_VERSION, health);

  const manifest = await page.evaluate(async () => {
    const response = await fetch('assets/manifest.json', { cache: 'no-store' });
    return { status: response.status, body: await response.json().catch(() => null) };
  });
  check('线上清单版本已更新', manifest.body?.assetsVersion === EXPECTED_ASSETS_VERSION, manifest.body?.assetsVersion);
  const sun = manifest.body?.assets?.find((entry) => entry.id === 'sunflower-1');
  check('线上 sunflower-1 换色窗口已截断到 69', JSON.stringify(sun?.recolor) === JSON.stringify({ mode: 'petals', hue: [346, 69] }), sun?.recolor);

  const thumbSha = await page.evaluate(async () => {
    const response = await fetch('assets/thumbs/sunflower-1.png', { cache: 'no-store' });
    const buffer = new Uint8Array(await response.arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return { status: response.status, sha: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''), bytes: buffer.length };
  });
  check('线上明黄缩略图与本地新渲染一致', thumbSha.sha === localSha, { remote: thumbSha.sha.slice(0, 16), local: localSha.slice(0, 16), bytes: thumbSha.bytes });

  await page.evaluate(() => window.__bouquetDebug.store.clearStems());
  await page.getByTestId('shelf-search').fill('向日葵');
  await page.waitForTimeout(700);
  const shelf = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.shelf-card')];
    const img = cards[0]?.querySelector('.shelf-thumb img');
    return {
      cards: cards.length,
      name: cards[0]?.querySelector('.shelf-name')?.textContent?.trim(),
      thumbLoaded: Boolean(img && img.complete && img.naturalWidth > 0),
    };
  });
  check('线上花材架搜索向日葵正常', shelf.cards === 1 && shelf.thumbLoaded, shelf);
  await page.screenshot({ path: `${OUT}/01-online-sunflower-shelf.png` });

  check('线上无应用脚本错误', errors.length === 0, errors.slice(0, 3));

  writeFileSync(`${OUT}/results.json`, JSON.stringify({ at: new Date().toISOString(), url: URL, checks }, null, 2));
  const failed = checks.filter((item) => !item.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length) process.exitCode = 1;
} finally {
  await browser.close();
}
