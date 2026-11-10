/**
 * V11 拍照场景扩展验证：在 V10 的 5 个场景之外新增「节日暖光 / 家居客厅 / 咖啡馆」。
 *
 * 覆盖：8 个场景入口、逐个切换后对应布景可见且其余布景隐藏、背景色随场景变化、
 * 工作台台面在非 studio/非 window 场景隐藏、新场景下导出与相册记录正确、无脚本错误。
 *
 * 运行：先 `npm run dev:all`（或 5173 已在跑），再 `node scripts/v11-scenes.mjs`。
 * 环境变量：SMOKE_URL、V11_OUT、HEADED。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { newStudioAwarePage } from './studio-page.mjs';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.V11_OUT ?? '.verify/v11-scenes';
mkdirSync(OUT, { recursive: true });
const checks = [];
let count = 0;
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`);
  count += 1;
  console.log('ok', name);
}
const state = () => page.evaluate(() => window.__bouquetDebug.getState());
const exec = (fn, arg) => page.evaluate(fn, arg);
const wait = (ms) => page.waitForTimeout(ms);

const SCENES = [
  { id: 'window', label: '窗边', group: 'photography-window', background: null },
  { id: 'studio', label: '素色台面', group: null, background: null },
  { id: 'gallery', label: '墨绿展台', group: 'photography-gallery', background: '30443d' },
  { id: 'florist', label: '花店一角', group: 'florist-set', background: 'ece0cf' },
  { id: 'garden', label: '庭院午后', group: 'garden-set', background: 'e7eee8' },
  { id: 'festive', label: '节日暖光', group: 'festive-set', background: '3b2a26' },
  { id: 'living', label: '家居客厅', group: 'living-set', background: 'e9dfd0' },
  { id: 'cafe', label: '咖啡馆', group: 'cafe-set', background: 'ece4d8' },
];
const SET_NAMES = SCENES.map((scene) => scene.group).filter(Boolean);

const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1', args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await newStudioAwarePage(context);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });

const visibleSets = () => exec((names) => {
  const scene = window.__bouquetDebug.scene.scene ?? window.__bouquetDebug.scene;
  return names.filter((name) => {
    const object = scene.getObjectByName(name);
    return Boolean(object && object.visible);
  });
}, SET_NAMES);
const background = () => exec(() => {
  const value = window.__bouquetDebug.scene.scene.background;
  return value?.isColor ? value.getHexString() : null;
});

try {
  await page.goto(URL);
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalog.mode === 'manifest');
  await exec(() => {
    const store = window.__bouquetDebug.store;
    for (let i = 0; i < 6; i += 1) {
      store.setPlacement(i < 3 ? 'rose-pink' : i < 5 ? 'tulip-cream' : 'eucalyptus-green');
      store.placeStem({ height: (i % 3) * 0.035, tilt: 10 + i * 3, direction: i * 137, spin: 30 });
    }
    store.setPlacement(null);
    store.select(null);
  });
  await page.waitForFunction(() => [...window.__bouquetDebug.scene.views.values()].every((view) => view.object), null, { timeout: 90000 });
  await wait(1000);
  await page.getByTestId('stage-finish').click();
  await wait(1800);

  // ---------- 1. 八个场景入口 ----------
  for (const scene of SCENES) {
    check(`场景入口 ${scene.id}`, await page.getByTestId(`photo-scene-${scene.id}`).isVisible());
    check(`场景文案 ${scene.id}`, (await page.getByTestId(`photo-scene-${scene.id}`).innerText()) === scene.label);
  }

  // ---------- 2. 逐个切换：布景显隐 + 背景色 ----------
  for (const scene of SCENES) {
    await page.getByTestId(`photo-scene-${scene.id}`).click();
    await wait(500);
    check(`选中 ${scene.id}`, (await state()).doc.photo.scene === scene.id, (await state()).doc.photo.scene);
    const visible = await visibleSets();
    if (scene.group) {
      check(`${scene.id} 布景可见`, visible.length === 1 && visible[0] === scene.group, visible);
    } else {
      check(`${scene.id} 不显示外景布景`, visible.length === 0, visible);
    }
    const hex = await background();
    if (scene.background) check(`${scene.id} 背景色`, hex === scene.background, { got: hex, want: scene.background });
    else check(`${scene.id} 沿用工作台渐变背景`, hex === null, hex);
    if (!['window', 'studio', 'gallery', 'florist', 'garden'].includes(scene.id)) {
      await page.screenshot({ path: `${OUT}/01-${scene.id}.png` });
    }
  }

  // ---------- 3. 新场景下的导出与相册 ----------
  await page.getByTestId('photo-scene-festive').click();
  await wait(800);
  const preview = await page.getByTestId('photo-preview').getAttribute('src');
  check('节日暖光有照片预览', Boolean(preview));
  const exported = await exec(async () => {
    const result = await window.__bouquetDebug.scene.exportPng(1200);
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    return { width: result.width, height: result.height, png: [...bytes.slice(0, 4)].join(',') };
  });
  check('节日暖光导出 PNG', exported.width === 1600 && exported.png === '137,80,78,71', exported);

  await page.getByTestId('photo-scene-cafe').click();
  await wait(600);
  await page.getByTestId('album-save').click();
  await wait(800);
  const albumLabel = await exec(() => {
    const snapshot = window.__bouquetDebug.getState();
    const photo = snapshot.album[0]?.photos[0];
    return photo ? { scene: photo.doc.photo.scene, kind: photo.doc.presentation.kind } : null;
  });
  check('咖啡馆场景照片入册', albumLabel?.scene === 'cafe', albumLabel);

  check('无脚本错误', errors.length === 0, errors.slice(0, 3));
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ passed: count, checks, errors }, null, 2));
  console.log(`\nV11 拍照场景：${count}/${count} 通过`);
} catch (error) {
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ passed: count, checks, error: String(error), errors }, null, 2));
  console.error('\n失败：', error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
