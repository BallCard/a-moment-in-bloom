/**
 * v14 场景缩略图生成（真实渲染，不使用占位图）。
 *
 * 拍照阶段的 8 个场景要做成卡片选择，缩略图直接来自游戏内的
 * `BouquetScene.captureThumbnail()`：同一束 6 枝样束、同一个 finish 机位、
 * 每个场景只改 photo.scene，等布景/近景道具就绪后拍 360×360 JPEG，
 * 写到 `app/public/assets/scenes/<id>.jpg`。组件按 `assets/scenes/<id>.jpg`
 * 引用；文件缺失时才回退到 CSS 渐变占位。
 *
 * 这是一个可复跑的验证资产：改了布景或取景参数后重新跑一遍即可。
 *
 * 运行：先保证 Vite dev server 在 http://127.0.0.1:5173，然后
 *   cd app && node scripts/v14-scene-thumbs.mjs
 * 环境变量：SMOKE_URL、HEADED（=1 显示浏览器）、v14_THUMB_SIZE。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { newStudioAwarePage } from './studio-page.mjs';

const SITE_URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const SIZE = Number(process.env.v14_THUMB_SIZE ?? 360);
const OUT_DIR = fileURLToPath(new URL('../public/assets/scenes/', import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

const SCENES = [
  'window',
  'studio',
  'gallery',
  'florist',
  'garden',
  'festive',
  'living',
  'cafe',
];

const browser = await chromium.launch({
  channel: 'chrome',
  headless: process.env.HEADED !== '1',
  args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await newStudioAwarePage(context);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text());
});

const wait = ms => page.waitForTimeout(ms);
const written = [];
try {
  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__bouquetDebug?.getState().catalog?.mode === 'manifest',
    null,
    { timeout: 90000 },
  );

  // 固定样束：6 枝（3 主花 / 2 配花 / 1 绿叶），包装参数由 loadSampleBouquet 固定。
  await page.evaluate(() => {
    const { store } = window.__bouquetDebug;
    store.loadSampleBouquet(6);
  });
  await page.waitForFunction(
    () =>
      [...window.__bouquetDebug.scene.views.values()].every(view => view.object && view.loaded),
    null,
    { timeout: 120000 },
  );

  // 进入拍照阶段并等机位过渡结束；固定默认斜 45° 机位，8 张缩略图才可横向比较。
  await page.evaluate(() => {
    const { store } = window.__bouquetDebug;
    store.setStage('finish');
    store.setViewPreset('quarter');
  });
  await page.waitForFunction(
    () => window.__bouquetDebug.getState().stage === 'finish',
    null,
    { timeout: 20000 },
  );
  await wait(2400);

  for (const id of SCENES) {
    await page.evaluate(sceneId => {
      const { store } = window.__bouquetDebug;
      store.updatePhoto({
        scene: sceneId,
        frame: 'none',
        format: 'square',
        zoom: 1,
        offsetX: 0,
        offsetY: 0,
      });
      store.endTransaction();
    }, id);
    // 布景第一次显示会懒加载近景 GLB，多等一会儿让道具落地。
    await wait(1800);
    const dataUrl = await page.evaluate(
      size => window.__bouquetDebug.scene.captureThumbnail(size),
      SIZE,
    );
    if (!dataUrl.startsWith('data:image/jpeg;base64,')) {
      throw Error(`${id}: 缩略图不是 JPEG dataURL`);
    }
    const buffer = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    if (buffer.length < 2500) throw Error(`${id}: 缩略图只有 ${buffer.length} 字节，可能是空图`);
    const file = `${OUT_DIR}${id}.jpg`;
    writeFileSync(file, buffer);
    written.push({ id, bytes: buffer.length, file });
    console.log(`ok ${id}.jpg ${(buffer.length / 1024).toFixed(1)} kB`);
  }

  if (errors.length > 0) throw Error(`页面脚本错误：${errors.slice(0, 3).join(' | ')}`);
  for (const item of written) {
    if (statSync(item.file).size !== item.bytes) throw Error(`${item.id}: 写入后大小不一致`);
  }
  writeFileSync(
    `${OUT_DIR}manifest.json`,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: 'v14-scene-thumbs.mjs',
        sample: 6,
        size: SIZE,
        scenes: written.map(({ id, bytes }) => ({ id, bytes })),
      },
      null,
      2,
    ),
  );
  console.log(`\n场景缩略图：${written.length}/${SCENES.length} 生成成功 → ${OUT_DIR}`);
} catch (error) {
  console.error('\n失败：', error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
