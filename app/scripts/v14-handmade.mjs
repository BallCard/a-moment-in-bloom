/**
 * v14 工作台手作封面：把「旧木桌的午后」「给朋友的生日」两件作品真的在工作台里做出来，
 * 切到成品阶段、选好拍照场景，用场景自己的 captureThumbnail(900) 拍下来，
 * 解码写成 app/public/showcase/handmade-<id>.jpg。
 *
 * 不伪造 3D 模型、不借用第三方图：封面就是工作台渲染 + 照片合成的真实输出。
 *
 * 运行（5173 已在跑）：
 *   node scripts/v14-handmade.mjs
 * 环境变量：SMOKE_URL、v14_HANDMADE_OUT、HEADED。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.v14_HANDMADE_OUT ?? 'public/showcase';
const SHOTS = '.verify/v14-gallery';
mkdirSync(OUT, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

/** 每件手作作品的拍摄参数：场景、构图微调。 */
const WORKS = [
  { id: 'wood-table', label: '旧木桌的午后', scene: 'cafe', zoom: 1.16, offsetX: 0, offsetY: 0.015 },
  { id: 'birthday', label: '给朋友的生日', scene: 'festive', zoom: 1.1, offsetX: 0, offsetY: 0.01 },
];

const JPEG_WIDTH = 900;

/** 读 JPEG 的 SOF 段拿宽高，用来核对封面尺寸而不是只认文件存在。 */
function jpegSize(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

const checks = [];
let count = 0;
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`);
  count += 1;
  console.log('ok', name);
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: process.env.HEADED !== '1',
  args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});

try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  // 每次都从空工作台开始，避免上次的作品影响取景。
  await context.addInitScript(() => {
    try { localStorage.clear(); } catch { /* 隐私模式下忽略 */ }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text());
  });

  await page.goto(URL);
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalog.mode === 'manifest', null, { timeout: 60000 });

  for (const work of WORKS) {
    const loaded = await page.evaluate((id) => window.__bouquetDebug.store.loadPaletteBouquet(id), work.id);
    check(`${work.label}：工作台载入作品配色`, loaded === true, loaded);

    const stems = await page.evaluate(() => window.__bouquetDebug.getState().doc.stems.map((stem) => stem.assetId));
    check(`${work.label}：花枝数量 8–12 枝`, stems.length >= 8 && stems.length <= 12, stems.length);

    await page.evaluate(({ scene, zoom, offsetX, offsetY }) => {
      const store = window.__bouquetDebug.store;
      store.updatePhoto({ scene, frame: 'paper', format: 'portrait', zoom, offsetX, offsetY, autoTrim: true, title: '' });
      store.endTransaction();
      store.setStage('finish');
    }, work);

    // 等每一枝的真实 GLB 都挂上，否则会拍到半天缺花。
    await page.waitForFunction(() => {
      const debug = window.__bouquetDebug;
      const state = debug.getState();
      return state.stage === 'finish' && state.doc.stems.length > 0
        && state.doc.stems.every((stem) => Boolean(debug.scene.views.get(stem.id)?.object));
    }, null, { timeout: 120000 });
    // 阶段机位过渡 320ms + 包装收口动画 + 阴影刷新。
    await page.waitForTimeout(2200);

    const dataUrl = await page.evaluate(async () => window.__bouquetDebug.scene.captureThumbnail(900));
    check(`${work.label}：抓到真实照片`, typeof dataUrl === 'string' && dataUrl.startsWith('data:image/jpeg;base64,'), String(dataUrl).slice(0, 32));
    const buffer = Buffer.from(dataUrl.slice('data:image/jpeg;base64,'.length), 'base64');
    const size = jpegSize(buffer);
    check(`${work.label}：照片宽度 ${JPEG_WIDTH}px`, size?.width === JPEG_WIDTH, size);
    const file = `${OUT}/handmade-${work.id}.jpg`;
    writeFileSync(file, buffer);
    check(`${work.label}：封面写入 ${file}`, buffer.length > 30000, buffer.length);

    const sceneName = await page.evaluate(() => window.__bouquetDebug.getState().doc.photo.scene);
    check(`${work.label}：拍摄场景为 ${work.scene}`, sceneName === work.scene, sceneName);
    await page.screenshot({ path: `${SHOTS}/handmade-${work.id}.png` });
    console.log(`   → ${file} (${buffer.length} B, ${size?.width}x${size?.height})`);
  }

  check('全程无脚本错误', errors.length === 0, errors.slice(0, 3));
  writeFileSync(`${SHOTS}/handmade-results.json`, JSON.stringify({ passed: count, checks }, null, 2));
  console.log(`\nv14 工作台手作封面：${count}/${count} 通过`);
} catch (error) {
  writeFileSync(`${SHOTS}/handmade-results.json`, JSON.stringify({ passed: count, checks, error: String(error) }, null, 2));
  console.error('\n失败：', error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
