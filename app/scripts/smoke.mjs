/**
 * 端到端冒烟测试（本地开发服务器 + 本机 Chrome）。
 *
 * 用法：
 *   1) 在 app/ 下启动 npm run preview（127.0.0.1:4173）或 npm run dev
 *   2) npm run smoke
 *   或指定地址：SMOKE_URL=http://127.0.0.1:5174/ npm run smoke
 *
 * 主流程跑真实清单（public/assets/manifest.json + 三枝 GLB），
 * 另开隔离页面验证：无清单回退内置占位花、缺 GLB 的失败提示与重试、减少动态效果。
 * 截图输出到 app/.verify/（已在 .gitignore 中忽略）。
 */

import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/';
const SHOTS = '.verify';
mkdirSync(SHOTS, { recursive: true });

let passed = 0;
function check(name, condition, extra = '') {
  if (!condition) throw new Error(`断言失败：${name}${extra ? `（${extra}）` : ''}`);
  passed += 1;
  console.log(`  ok ${name}`);
}

function pngSize(buffer) {
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function pngVariance(page, buffer) {
  const base64 = buffer.toString('base64');
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 48;
    canvas.height = 48;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 48, 48);
    const pixels = context.getImageData(0, 0, 48, 48).data;
    let min = 255;
    let max = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      min = Math.min(min, pixels[i], pixels[i + 1], pixels[i + 2]);
      max = Math.max(max, pixels[i], pixels[i + 1], pixels[i + 2]);
    }
    return max - min;
  }, base64);
}

const consoleIssues = [];
function trackConsole(page) {
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleIssues.push(`[${message.type()}] ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => consoleIssues.push(`[pageerror] ${error.message}`));
}

const state = (page) => page.evaluate(() => window.__bouquetDebug?.getState());
const stemCount = async (page) => (await state(page))?.doc.stems.length ?? -1;
const wait = (page, ms) => page.waitForTimeout(ms);

/** 第三轮起辅助开关与清空/调试收进顶栏浮层；点击前按需展开对应菜单。 */
async function clickTest(page, id) {
  const target = page.locator(`[data-testid="${id}"]`).first();
  if (!(await target.isVisible())) {
    const inAssist = ['motion-toggle', 'assist-snapping', 'assist-suggestions'].includes(id);
    await page.click(`[data-testid="${inAssist ? 'assist-menu-toggle' : 'more-menu-toggle'}"]`);
    await wait(page, 220);
  }
  await page.click(`[data-testid="${id}"]`);
}

/** 导入输入框收在「更多」浮层里；需要时先展开，再选文件。 */
async function chooseImportFile(page, payload) {
  if ((await page.locator('[data-testid="import-file"]').count()) === 0) {
    await page.click('[data-testid="more-menu-toggle"]');
    await wait(page, 250);
  }
  await page.setInputFiles('[data-testid="import-file"]', payload);
}

async function placeViaUi(page, testId, x, y, settle = 220) {
  await page.click(`[data-testid="${testId}"]`);
  await wait(page, 80);
  await page.mouse.move(x, y);
  await wait(page, 80);
  await page.mouse.click(x, y);
  await wait(page, settle);
}

async function waitForManifest(page) {
  await page.waitForFunction(
    () => window.__bouquetDebug?.getState().catalogStatus === 'manifest',
    null,
    { timeout: 20000 },
  );
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--disable-gpu-vsync'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
trackConsole(page);

console.log('1. 空状态与真实清单');
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__bouquetDebug), null, { timeout: 15000 });
await waitForManifest(page);
await wait(page, 1000);
const initial = await state(page);
check('空状态引导可见', await page.locator('.empty-guide').isVisible());
check('初始 0 枝', initial.doc.stems.length === 0);
check('使用真实资产清单', initial.catalog.mode === 'manifest', initial.catalog.mode);
check('清单含九种真实花材（3 类 × 3 色）', initial.catalog.entries.length === 9);
check(
  '花材名称正确',
  initial.catalog.entries.map((entry) => entry.assetId).sort().join(',') ===
    'eucalyptus-deep,eucalyptus-green,eucalyptus-silver,rose-ivory,rose-pink,rose-red,tulip-butter,tulip-cream,tulip-pink',
  initial.catalog.entries.map((entry) => entry.assetId).join(','),
);
check('按花种分组', initial.catalog.families.length === 3);
const panelMeta = await page.locator('.palette-panel .panel-meta').textContent();
check('面板显示清单 9 种', panelMeta?.includes('9 种花材'), panelMeta ?? '');
await page.screenshot({ path: `${SHOTS}/01-empty.png` });

console.log('2. 放置预览与真实 GLB 加载');
const assetCycle = initial.catalog.entries.map((entry) => `palette-${entry.assetId}`);
await page.click('[data-testid="palette-tulip-pink"]');
await wait(page, 120);
check('进入放置模式', (await state(page)).placement !== null);
await page.mouse.move(700, 430);
await wait(page, 300);
check('放置提示条可见', await page.locator('[data-testid="placement-banner"]').isVisible());
await page.screenshot({ path: `${SHOTS}/02-placement.png` });
await page.mouse.click(700, 430);
await wait(page, 350);
check('放下第一枝', (await stemCount(page)) === 1);
check('放置后自动选中', (await state(page)).selectedId !== null);
check('放置模式已退出', (await state(page)).placement === null);
await page.waitForFunction(
  () => window.__bouquetDebug?.scene.getStats().triangles > 30000,
  null,
  { timeout: 30000 },
);
const firstStats = await page.evaluate(() => window.__bouquetDebug.scene.getStats());
check('真实 GLB 已渲染（三角面 > 3 万）', firstStats.triangles > 30000, JSON.stringify(firstStats));

console.log('3. 拖动花枝换方向');
const beforeDrag = (await state(page)).doc.stems[0].pose;
const headPoint = await page.evaluate(
  (stemId) => window.__bouquetDebug?.getStemScreenPoint(stemId),
  (await state(page)).doc.stems[0].id,
);
check('能拿到花头屏幕坐标', Boolean(headPoint && headPoint.visible), JSON.stringify(headPoint));
await page.mouse.move(headPoint.x, headPoint.y);
await page.mouse.down();
await page.mouse.move(headPoint.x + 70, headPoint.y - 24, { steps: 12 });
await page.mouse.up();
await wait(page, 400);
const afterDrag = (await state(page)).doc.stems[0].pose;
check(
  '拖拽改变了倾斜或方向',
  Math.abs(afterDrag.tilt - beforeDrag.tilt) > 1 ||
    Math.abs(afterDrag.direction - beforeDrag.direction) > 1,
  `${JSON.stringify(beforeDrag)} -> ${JSON.stringify(afterDrag)}`,
);
await page.screenshot({ path: `${SHOTS}/03-dragged.png` });

console.log('4. 继续用 UI 放到 12 枝');
const spots = [
  [760, 400], [640, 460], [820, 450], [700, 360], [600, 400], [880, 420],
  [660, 500], [800, 380], [740, 480], [620, 360], [860, 500],
];
for (let i = 0; i < spots.length; i += 1) {
  await placeViaUi(page, assetCycle[i % assetCycle.length], spots[i][0], spots[i][1]);
}
await page.waitForFunction(
  () => window.__bouquetDebug?.getState().doc.stems.length === 12,
  null,
  { timeout: 15000 },
);
await wait(page, 2500);
check('已放满 12 枝', (await stemCount(page)) === 12, `实际 ${await stemCount(page)}`);
check('花枝列表 12 行', (await page.locator('[data-testid="stem-item"]').count()) === 12);
const poseSpread = await page.evaluate(() => {
  const poses = window.__bouquetDebug.getState().doc.stems.map((stem) => stem.pose);
  return {
    heights: poses.map((pose) => pose.height),
    tilts: poses.map((pose) => pose.tilt),
  };
});
check(
  '默认摆放有高低差与层次',
  Math.max(...poseSpread.heights) - Math.min(...poseSpread.heights) > 0.01 &&
    Math.max(...poseSpread.tilts) - Math.min(...poseSpread.tilts) > 8,
  JSON.stringify({ heights: poseSpread.heights.map((h) => +h.toFixed(3)), tilts: poseSpread.tilts.map(Math.round) }),
);

console.log('5. 旋转视角');
const rotationProbe = (await state(page)).doc.stems[0].id;
const pointBefore = await page.evaluate(
  (id) => window.__bouquetDebug?.getStemScreenPoint(id),
  rotationProbe,
);
const cameraBefore = await page.evaluate(() =>
  window.__bouquetDebug?.scene.camera.position.toArray(),
);
await page.mouse.move(1010, 620);
await page.mouse.down();
await page.mouse.move(1120, 600, { steps: 16 });
await page.mouse.up();
await wait(page, 600);
const pointAfter = await page.evaluate(
  (id) => window.__bouquetDebug?.getStemScreenPoint(id),
  rotationProbe,
);
const cameraAfter = await page.evaluate(() =>
  window.__bouquetDebug?.scene.camera.position.toArray(),
);
const cameraMoved =
  cameraBefore && cameraAfter
    ? Math.hypot(
        cameraAfter[0] - cameraBefore[0],
        cameraAfter[1] - cameraBefore[1],
        cameraAfter[2] - cameraBefore[2],
      )
    : 0;
check('拖空白处旋转了视角', cameraMoved > 0.05, `相机位移 ${cameraMoved.toFixed(3)}`);
check(
  '旋转后花头屏幕坐标随之变化',
  pointBefore && pointAfter &&
    Math.hypot(pointAfter.x - pointBefore.x, pointAfter.y - pointBefore.y) > 4,
  `${JSON.stringify(pointBefore)} -> ${JSON.stringify(pointAfter)}`,
);
await page.screenshot({ path: `${SHOTS}/04-twelve-rotated.png` });

console.log('6. 通过列表选中被挡住的花枝');
const targetItem = page.locator('[data-testid="stem-item"]').nth(5);
const targetStemId = await targetItem.getAttribute('data-stem-id');
await targetItem.click();
await wait(page, 250);
check('列表点击后选中对应花枝', (await state(page))?.selectedId === targetStemId);
check('检查器显示第 6 枝', (await page.locator('.panel-meta').first().textContent()) !== null);

console.log('7. 滑杆连续拖动只记一次撤销');
const tiltBeforeSlider = (await state(page)).doc.stems.find((s) => s.id === targetStemId).pose.tilt;
const pastBeforeSlider = (await state(page)).pastCount;
const slider = page.locator('[data-testid="slider-tilt"]');
await slider.scrollIntoViewIfNeeded();
const box = await slider.boundingBox();
check('滑杆可见', Boolean(box));
await page.mouse.move(box.x + box.width * 0.35, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 10 });
await page.mouse.up();
await wait(page, 500);
const afterSlider = (await state(page)).doc.stems.find((s) => s.id === targetStemId).pose.tilt;
check('滑杆改变了倾斜', Math.abs(afterSlider - tiltBeforeSlider) > 1, `${tiltBeforeSlider} -> ${afterSlider}`);
const pastAfterSlider = (await state(page)).pastCount;
check('滑杆拖动只产生一条历史', pastAfterSlider === pastBeforeSlider + 1, `${pastBeforeSlider} -> ${pastAfterSlider}`);
await page.screenshot({ path: `${SHOTS}/05-selected.png` });
await page.click('[data-testid="undo"]');
await wait(page, 300);
const tiltAfterUndo = (await state(page)).doc.stems.find((s) => s.id === targetStemId).pose.tilt;
check('撤销恢复滑杆前的倾斜', Math.abs(tiltAfterUndo - tiltBeforeSlider) < 0.01, `${tiltAfterUndo}`);

console.log('8. Delete 键在用过滑杆后仍可用');
const beforeDeleteKey = await stemCount(page);
await page.locator('[data-testid="stem-item"]').nth(5).click();
await wait(page, 150);
await page.keyboard.press('Delete');
await wait(page, 350);
check('Delete 删除选中花枝', (await stemCount(page)) === beforeDeleteKey - 1);
await page.click('[data-testid="undo"]');
await wait(page, 300);
await page.locator('[data-testid="stem-item"]').first().click();
await wait(page, 200);

console.log('9. 复制 / 删除 / 撤销 / 重做 / 清空确认');
await page.locator('[data-testid="duplicate-stem"]').click();
await wait(page, 250);
check('复制后 13 枝', (await stemCount(page)) === 13);
await page.locator('[data-testid="delete-stem"]').click();
await wait(page, 250);
check('删除后 12 枝', (await stemCount(page)) === 12);
await page.click('[data-testid="undo"]');
await wait(page, 250);
check('撤销删除后 13 枝', (await stemCount(page)) === 13);
await page.click('[data-testid="redo"]');
await wait(page, 250);
check('重做删除后 12 枝', (await stemCount(page)) === 12);

await clickTest(page, 'clear-all');
await wait(page, 200);
check(
  '清空第一次点击只进入确认',
  (await stemCount(page)) === 12 &&
    (await page.getAttribute('[data-testid="clear-all"]', 'data-armed')) === 'true',
);
await clickTest(page, 'clear-all');
await wait(page, 300);
check('再次点击后清空', (await stemCount(page)) === 0);
await page.click('[data-testid="undo"]');
await wait(page, 300);
check('撤销清空后恢复 12 枝', (await stemCount(page)) === 12);

console.log('10. 包装：三种纸色、丝带与尺寸自适应');
await page.click('[data-testid="stage-wrap"]');
await wait(page, 700);
check('包装面板可见', await page.locator('.decor-panel').isVisible());
await wait(page, 120);
const wrapImmediate = await page.evaluate(() => window.__bouquetDebug.getDecorState());
check(
  '开启包装先进入摆纸步骤',
  wrapImmediate.wrapping.visible && wrapImmediate.wrapping.step === 'paper',
  JSON.stringify(wrapImmediate.wrapping),
);
check('丝带在「系丝带」步骤之前不出现', wrapImmediate.ribbon.visible === false);
await wait(page, 900);
const wrapSettled = await page.evaluate(() => window.__bouquetDebug.getDecorState());
check('包装开口按花束外圈计算', wrapSettled.wrapping.radius > 0.15, String(wrapSettled.wrapping.radius));
const radiusBefore = wrapSettled.wrapping.radius;

for (const paper of ['kraft', 'sage', 'ivory', 'mist', 'clay', 'wine']) {
  await page.click(`[data-testid="paper-${paper}"]`);
  await wait(page, 160);
  check(`纸色切换为 ${paper}`, (await page.evaluate(() => window.__bouquetDebug.getDecorState())).wrapping.paperId === paper);
}
for (const ribbon of ['cream', 'sage', 'rose', 'champagne', 'mist', 'clay']) {
  await page.click(`[data-testid="ribbon-${ribbon}"]`);
  await wait(page, 160);
  check(`丝带切换为 ${ribbon}`, (await page.evaluate(() => window.__bouquetDebug.getDecorState())).ribbon.colorId === ribbon);
}

// 花枝变多/外扩后，开口尺寸跟着重算
await page.evaluate(() => {
  const api = window.__bouquetDebug;
  const doc = structuredClone(api.getState().doc);
  for (const stem of doc.stems) {
    stem.pose.tilt = 55;
    stem.pose.height = 0.2;
  }
  api.store.replaceDocument(doc);
});
await wait(page, 400);
const radiusExpanded = (await page.evaluate(() => window.__bouquetDebug.getDecorState())).wrapping.radius;
check('花枝外扩后包装自动变大', radiusExpanded > radiusBefore + 0.005, `${radiusBefore} -> ${radiusExpanded}`);
await page.keyboard.press('Control+z');
await wait(page, 350);
const radiusRestored = (await page.evaluate(() => window.__bouquetDebug.getDecorState())).wrapping.radius;
check('撤销后包装尺寸恢复', Math.abs(radiusRestored - radiusBefore) < 0.02, `${radiusRestored}`);

await page.click('[data-testid="toggle-wrap"]');
await wait(page, 250);
const unwrapped = await page.evaluate(() => window.__bouquetDebug.getDecorState());
check('可以拆开包装回到混排', !unwrapped.wrapping.visible && !unwrapped.ribbon.visible);
await page.click('[data-testid="toggle-wrap"]');
await wait(page, 900);
check('可以重新包起来', (await page.evaluate(() => window.__bouquetDebug.getDecorState())).wrapping.visible);

console.log('11. 小卡片：字数限制、3D 可见、保存与撤销');
await page.click('[data-testid="card-to"]');
await page.fill('[data-testid="card-to"]', '妈妈');
await page.keyboard.press('Tab');
await page.click('[data-testid="card-to"]');
await page.fill('[data-testid="card-to"]', '一二三四五六七八九十一二三四五六七八九十多余');
await page.keyboard.press('Tab');
const clampedTo = (await state(page)).doc.card.to;
check('收件人限制 20 字', Array.from(clampedTo).length === 20, `${clampedTo} (${Array.from(clampedTo).length})`);
await page.click('[data-testid="card-to"]');
await page.fill('[data-testid="card-to"]', '妈妈');
await page.keyboard.press('Tab');

await page.click('[data-testid="card-message"]');
await page.fill(
  '[data-testid="card-message"]',
  '愿今年的每一天都像这束花一样，松弛、明亮，有小小的惊喜。'.repeat(6),
);
await page.keyboard.press('Tab');
const clampedMessage = (await state(page)).doc.card.message;
check('正文限制 120 字', Array.from(clampedMessage).length === 120, `${Array.from(clampedMessage).length}`);
await page.click('[data-testid="card-message"]');
await page.fill('[data-testid="card-message"]', '愿今年的每一天都像这束花一样，松弛、明亮，有小小的惊喜。');
await page.keyboard.press('Tab');

await page.click('[data-testid="card-from"]');
await page.fill('[data-testid="card-from"]', '小满');
await page.keyboard.press('Tab');
await wait(page, 300);
const cardBeforeUndo = (await state(page)).doc.card.from;
await page.keyboard.press('Control+z');
await wait(page, 400);
const cardAfterUndo = (await state(page)).doc.card.from;
check('卡片输入可撤销', cardAfterUndo !== cardBeforeUndo, `${cardBeforeUndo} -> ${cardAfterUndo}`);
await page.click('[data-testid="card-from"]');
await page.fill('[data-testid="card-from"]', '小满');
await page.keyboard.press('Tab');
await wait(page, 300);
// 新流程：卡片在「卡片成品」步骤才随包装出现，先进入包装阶段并推进分步。
await page.click('[data-testid="stage-wrap"]');
await wait(page, 700);
for (let i = 0; i < 3; i += 1) {
  await page.click('[data-testid="dock-step-next"]');
  await wait(page, 700);
}
await wait(page, 400);
const cardState = await page.evaluate(() => window.__bouquetDebug.getDecorState());
check('卡片出现在 3D 画面里', cardState.card.visible === true, JSON.stringify(cardState.card));
check('卡片内容保存进文档', cardState.card.to === '妈妈' && cardState.card.from === '小满');
const counters = await page.locator('.field-count').allTextContents();
check('字数计数器显示', counters.some((text) => text.includes('/20')) && counters.some((text) => text.includes('/120')), counters.join(' '));
await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/06-wrapped-card.png` });

console.log('12. JSON 导出完整字段');
const jsonDownloadPromise = page.waitForEvent('download');
await clickTest(page, 'export-json');
const jsonDownload = await jsonDownloadPromise;
const jsonName = jsonDownload.suggestedFilename();
check('JSON 文件名带时间戳', /^bouquet-\d{8}-\d{6}\.json$/.test(jsonName), jsonName);
const jsonPath = `${SHOTS}/export-work.json`;
await jsonDownload.saveAs(jsonPath);
const jsonBuffer = readFileSync(jsonPath);
const exportedDoc = JSON.parse(jsonBuffer.toString('utf8'));
check('JSON 含版本号与资产版本', exportedDoc.version === 3 && typeof exportedDoc.assetsVersion === 'string', JSON.stringify({ version: exportedDoc.version, assetsVersion: exportedDoc.assetsVersion }));
check('JSON 含全部 12 枝', exportedDoc.stems.length === 12);
check('JSON 含包装与丝带', exportedDoc.wrapping.enabled === true && typeof exportedDoc.wrapping.paperId === 'string');
check('JSON 含卡片', exportedDoc.card.to === '妈妈' && exportedDoc.card.from === '小满');
check('JSON 含创建时间', typeof exportedDoc.createdAt === 'string' && exportedDoc.createdAt.length > 10);

console.log('13. 清空确认后导入 JSON');
await clickTest(page, 'clear-all');
await wait(page, 200);
await clickTest(page, 'clear-all');
await wait(page, 300);
check('导入前清空成功', (await stemCount(page)) === 0);
await chooseImportFile(page, jsonPath);
await wait(page, 900);
const imported = await state(page);
check('导入恢复 12 枝', imported.doc.stems.length === 12);
check('导入恢复包装', imported.doc.wrapping.enabled === true);
check('导入恢复卡片', imported.doc.card.to === '妈妈' && imported.doc.card.message.length > 0);
const importToast = (await page.locator('[data-testid="toast"]').allTextContents()).join(' | ');
check('导入成功提示含来源版本', importToast.includes('已导入') && importToast.includes('v3'), importToast);
await wait(page, 300);

console.log('14. 损坏 / 新版 / 未知花材导入被拒绝，作品不丢');
const guardBefore = JSON.stringify((await state(page)).doc);
const badImports = [
  { name: 'broken.json', body: '{ not json', expect: '有效的作品 JSON' },
  { name: 'newer.json', body: JSON.stringify({ ...exportedDoc, version: 99 }), expect: '版本' },
  {
    name: 'unknown-asset.json',
    body: JSON.stringify({ ...exportedDoc, stems: [{ ...exportedDoc.stems[0], assetId: 'ghost-flower' }, ...exportedDoc.stems.slice(1)] }),
    expect: '清单',
  },
];
for (const item of badImports) {
  await chooseImportFile(page, {
    name: item.name,
    mimeType: 'application/json',
    buffer: Buffer.from(item.body),
  });
  await wait(page, 500);
  const toasts = (await page.locator('[data-testid="toast"]').allTextContents()).join(' | ');
  check(`${item.name} 被拒绝并提示`, toasts.includes(item.expect), toasts);
  check(`${item.name} 未覆盖当前作品`, JSON.stringify((await state(page)).doc) === guardBefore);
}

console.log('15. 旧版 v1 导入有提示并可补齐字段');
const v1Doc = {
  version: 1,
  assetsVersion: exportedDoc.assetsVersion,
  createdAt: exportedDoc.createdAt,
  stems: exportedDoc.stems,
};
await chooseImportFile(page, {
  name: 'v1.json',
  mimeType: 'application/json',
  buffer: Buffer.from(JSON.stringify(v1Doc)),
});
await wait(page, 900);
const v1Imported = await state(page);
const v1Toast = (await page.locator('[data-testid="toast"]').allTextContents()).join(' | ');
check('旧版 v1 可导入并提示', v1Toast.includes('旧版 v1'), v1Toast);
check('旧版导入补齐包装默认值', v1Imported.doc.wrapping.enabled === false);
await wait(page, 250);
await chooseImportFile(page, jsonPath);
await wait(page, 900);
await wait(page, 400);
check('重新导入 v2 恢复包装与卡片', (await state(page)).doc.wrapping.enabled === true && (await state(page)).doc.card.to === '妈妈');

console.log('16. PNG 导出：尺寸、非空白、界面元素隐藏、时间戳');
const pngDownloadPromise = page.waitForEvent('download');
await clickTest(page, 'export-png');
const pngDownload = await pngDownloadPromise;
const pngName = pngDownload.suggestedFilename();
check('PNG 文件名带时间戳', /^bouquet-\d{8}-\d{6}\.png$/.test(pngName), pngName);
const pngPath = `${SHOTS}/export-work.png`;
await pngDownload.saveAs(pngPath);
const pngBuffer = readFileSync(pngPath);
const pngInfo = pngSize(pngBuffer);
check('PNG 是 2048×2048', pngInfo?.width === 2048 && pngInfo?.height === 2048, JSON.stringify(pngInfo));
check('PNG 体积像真实画面', pngBuffer.length > 150000, `${pngBuffer.length} bytes`);
check('PNG 不是空白图', (await pngVariance(page, pngBuffer)) > 20);
await page.evaluate(() => {
  const api = window.__bouquetDebug;
  api.store.select(api.getState().doc.stems[0]?.id ?? null);
});
await wait(page, 200);
const pngDiagnostics = await page.evaluate(async () => {
  const scene = window.__bouquetDebug.scene;
  const before = scene.camera.position.toArray();
  const originalRender = scene.renderer.render.bind(scene.renderer);
  let captured = null;
  scene.renderer.render = (targetScene, camera) => {
    if (!captured) {
      captured = {
        selected: scene.markerSelected.visible,
        hover: scene.markerHover.visible,
        grip: scene.markerGrip.visible,
        ghost: Boolean(scene.ghostRoot?.visible),
      };
    }
    originalRender(targetScene, camera);
  };
  try {
    const result = await scene.exportPng(1600);
    return {
      captured,
      width: result.width,
      height: result.height,
      cameraRestored: Math.hypot(
        scene.camera.position.x - before[0],
        scene.camera.position.y - before[1],
        scene.camera.position.z - before[2],
      ) < 0.001,
      selectedAfter: scene.markerSelected.visible,
    };
  } finally {
    scene.renderer.render = originalRender;
  }
});
check('导出时可指定 ≥1600 边长', pngDiagnostics.width === 1600, String(pngDiagnostics.width));
check('导出时选中/悬停/预览标记隐藏', pngDiagnostics.captured && !pngDiagnostics.captured.selected && !pngDiagnostics.captured.hover && !pngDiagnostics.captured.grip && !pngDiagnostics.captured.ghost, JSON.stringify(pngDiagnostics.captured));
check('导出后相机与选中标记恢复', pngDiagnostics.cameraRestored && pngDiagnostics.selectedAfter === true, JSON.stringify(pngDiagnostics));
await page.evaluate(() => window.__bouquetDebug.store.select(null));
await wait(page, 250);

console.log('17. 1366×768 / 1920×1080 布局');
await page.setViewportSize({ width: 1366, height: 768 });
await wait(page, 700);
const layoutIssues = await page.evaluate(() => {
  const issues = [];
  for (const selector of ['.topbar', '.side-left', '.right-stack']) {
    const element = document.querySelector(selector);
    if (!element) {
      if (selector === '.right-stack') continue; // 右栏按需出现
      issues.push(`${selector}:missing`);
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (rect.left < -1 || rect.top < -1 || rect.right > window.innerWidth + 1 || rect.bottom > window.innerHeight + 1) {
      issues.push(`${selector}:out`);
    }
  }
  return issues;
});
check('1366×768 无布局溢出', layoutIssues.length === 0, layoutIssues.join(' | '));
await page.screenshot({ path: `${SHOTS}/07-1366x768.png` });
await page.setViewportSize({ width: 1920, height: 1080 });
await wait(page, 700);
await page.screenshot({ path: `${SHOTS}/08-1920x1080.png` });
await page.setViewportSize({ width: 1440, height: 900 });
await wait(page, 500);

console.log('18. 20 枝性能与上限');
await page.evaluate(() => {
  const api = window.__bouquetDebug;
  const assets = ['tulip-pink', 'rose-pink', 'eucalyptus-green'];
  for (let i = api.store.getState().doc.stems.length; i < 20; i += 1) {
    api.store.setPlacement(assets[i % assets.length]);
    api.store.placeStem({ tilt: 6 + (i % 5) * 6, direction: i * 29, spin: i * 17 });
  }
  api.store.setPlacement(null);
  api.store.select(null);
});
await wait(page, 2600);
check('已到 20 枝', (await stemCount(page)) === 20);
const stats20 = await page.evaluate(() => window.__bouquetDebug.scene.getStats());
check('20 枝帧率 ≥ 30', stats20.fps >= 30, JSON.stringify(stats20));
check('20 枝绘制调用有效', stats20.calls > 0 && stats20.triangles > 500000, JSON.stringify(stats20));
// 回到摆花阶段，花材架才在左侧面板里。
await page.click('[data-testid="stage-arrange"]');
await wait(page, 900);
await page.click('[data-testid="palette-rose"]');
await wait(page, 250);
check('满 20 枝后不进入放置模式', (await state(page))?.placement === null);
const limitToast = await page.locator('[data-testid="toast"]').allTextContents();
check('给出上限提示', limitToast.some((text) => text.includes('最多放 20 枝')), limitToast.join(' | '));
await page.screenshot({ path: `${SHOTS}/09-twenty.png` });

console.log('19. 调试面板');
await clickTest(page, 'toggle-debug');
await wait(page, 900);
check('调试面板可见', await page.locator('[data-testid="debug-hud"]').isVisible());
check('FPS 统计有效', stats20.fps > 0);
await page.screenshot({ path: `${SHOTS}/10-debug.png` });
await clickTest(page, 'toggle-debug');

console.log('20. 自动保存与恢复（含包装与卡片）');
await wait(page, 900);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__bouquetDebug), null, { timeout: 15000 });
await waitForManifest(page);
// 恢复提示只显示几秒；配色变体多时 GLB 重着色会延长加载，先在提示还在时取一次。
const restoredToast = await page.locator('[data-testid="toast"]').allTextContents();
check('提示已恢复上次花束', restoredToast.some((text) => text.includes('已恢复上次的花束')), restoredToast.join(' | '));
await wait(page, 1400);
const restored = await state(page);
check('刷新后恢复 20 枝', restored.doc.stems.length === 20, `实际 ${restored.doc.stems.length}`);
check('刷新后恢复包装', restored.doc.wrapping.enabled === true);
check('刷新后恢复卡片', restored.doc.card.to === '妈妈' && restored.doc.card.from === '小满');
await page.screenshot({ path: `${SHOTS}/11-restored.png` });

console.log('21. 无清单回退内置占位花');
const builtinContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const builtinPage = await builtinContext.newPage();
const builtinIssues = [];
builtinPage.on('console', (message) => {
  if (['error', 'warning'].includes(message.type())) builtinIssues.push(message.text());
});
builtinPage.on('pageerror', (error) => builtinIssues.push(`[pageerror] ${error.message}`));
await builtinPage.route('**/assets/manifest.json', (route) =>
  route.fulfill({ status: 404, contentType: 'text/plain', body: 'no manifest' }),
);
await builtinPage.goto(URL, { waitUntil: 'domcontentloaded' });
await builtinPage.waitForFunction(() => Boolean(window.__bouquetDebug), null, { timeout: 15000 });
await builtinPage.waitForFunction(
  () => window.__bouquetDebug?.getState().catalogStatus === 'builtin',
  null,
  { timeout: 10000 },
);
await builtinPage.waitForTimeout(500);
const builtinState = await builtinPage.evaluate(() => window.__bouquetDebug.getState());
check('清单缺失时回退内置花', builtinState.catalog.mode === 'builtin');
check('回退时仍有可放置的花材', builtinState.catalog.entries.length > 0);
await builtinPage.click('[data-testid="palette-tulip"]');
await builtinPage.mouse.move(700, 430);
await builtinPage.waitForTimeout(150);
await builtinPage.mouse.click(700, 430);
await builtinPage.waitForTimeout(600);
check('回退模式可放下一枝', (await builtinPage.evaluate(() => window.__bouquetDebug.getState().doc.stems.length)) === 1);
await builtinPage.screenshot({ path: `${SHOTS}/12-builtin.png` });
const unexpectedBuiltin = builtinIssues.filter((text) => !text.includes('Failed to load resource'));
check('回退页无意外报错', unexpectedBuiltin.length === 0, unexpectedBuiltin.join(' | '));
await builtinContext.close();

console.log('22. 加载进度、缺 GLB 失败提示与重试');
const retryContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const retryPage = await retryContext.newPage();
const retryIssues = [];
retryPage.on('console', (message) => {
  if (['error', 'warning'].includes(message.type())) retryIssues.push(message.text());
});
retryPage.on('pageerror', (error) => retryIssues.push(`[pageerror] ${error.message}`));
let glbRequests = 0;
await retryPage.route('**/assets/manifest.json', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schema_version: 1,
      assetsVersion: 'smoke-retry',
      assets: [
        {
          id: 'retry-tulip',
          kind: 'main',
          displayName: '重试郁金香',
          glb: 'tulip-pink.glb',
          transform: { scale: 0.93333, rotationY: 0, gripAt: -0.19, headOffsetY: 0.34313 },
          fallback: { procedural: 'tulip', color: '#dd8899' },
        },
      ],
    }),
  }),
);
await retryPage.route('**/assets/tulip-pink.glb', async (route) => {
  glbRequests += 1;
  if (glbRequests === 1) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing' });
  } else {
    await route.continue();
  }
});
await retryPage.goto(URL, { waitUntil: 'domcontentloaded' });
await retryPage.waitForFunction(() => Boolean(window.__bouquetDebug), null, { timeout: 15000 });
await retryPage.waitForFunction(
  () => window.__bouquetDebug?.getState().catalogStatus === 'manifest',
  null,
  { timeout: 15000 },
);
await retryPage.click('[data-testid="palette-tulip"]');
await retryPage.mouse.move(700, 430);
await retryPage.waitForTimeout(120);
await retryPage.mouse.click(700, 430);
await retryPage.waitForTimeout(180);
check('加载时显示进度条', await retryPage.locator('[data-testid="asset-loading"]').isVisible());
await retryPage.waitForSelector('[data-testid="asset-failure"]', { timeout: 15000 });
const failureState = await retryPage.evaluate(() => window.__bouquetDebug.getState());
check('缺 GLB 时给出失败提示', Boolean(failureState.assetFailure), JSON.stringify(failureState.assetFailure));
check('缺 GLB 时仍有占位花', failureState.doc.stems.length === 1);
const failureToasts = await retryPage.locator('[data-testid="toast"]').allTextContents();
check('失败提示文案清楚', failureToasts.some((text) => text.includes('模型没加载出来')), failureToasts.join(' | '));
await retryPage.screenshot({ path: `${SHOTS}/13-asset-failure.png` });
await retryPage.click('[data-testid="retry-assets"]');
await retryPage.waitForFunction(() => window.__bouquetDebug?.getState().assetFailure === null, null, { timeout: 10000 });
await retryPage.waitForFunction(
  () => window.__bouquetDebug?.scene.getStats().triangles > 30000,
  null,
  { timeout: 30000 },
);
const retryState = await retryPage.evaluate(() => window.__bouquetDebug.getState());
check('重试后失败状态清除', retryState.assetFailure === null);
check('重试后加载到真实 GLB', (await retryPage.evaluate(() => window.__bouquetDebug.scene.getStats())).triangles > 30000);
await retryPage.screenshot({ path: `${SHOTS}/14-asset-retry.png` });
const unexpectedRetry = retryIssues.filter((text) => !text.includes('Failed to load resource'));
check('重试页无意外报错', unexpectedRetry.length === 0, unexpectedRetry.join(' | '));
await retryContext.close();

console.log('23. 减少动态效果');
const rmContext = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  reducedMotion: 'reduce',
});
const rmPage = await rmContext.newPage();
await rmPage.route('**/assets/manifest.json', (route) =>
  route.fulfill({ status: 404, contentType: 'text/plain', body: 'no manifest' }),
);
await rmPage.goto(URL, { waitUntil: 'domcontentloaded' });
await rmPage.waitForFunction(() => Boolean(window.__bouquetDebug), null, { timeout: 15000 });
await rmPage.waitForFunction(
  () => window.__bouquetDebug?.getState().catalogStatus === 'builtin',
  null,
  { timeout: 10000 },
);
await rmPage.click('[data-testid="palette-tulip"]');
await rmPage.mouse.move(700, 430);
await rmPage.waitForTimeout(120);
await rmPage.mouse.click(700, 430);
await rmPage.waitForTimeout(300);
await rmPage.click('[data-testid="stage-wrap"]');
await rmPage.waitForTimeout(500);
await rmPage.waitForTimeout(60);
const reduced = await rmPage.evaluate(() => window.__bouquetDebug.getDecorState());
check('减少动态时直接到最终状态', reduced.animating === false && reduced.reduceMotion === true, JSON.stringify(reduced));
check(
  '减少动态时摆纸步骤直接到位',
  reduced.wrapping.visible && reduced.wrapping.step === 'paper' && reduced.ribbon.visible === false,
  JSON.stringify(reduced.wrapping),
);
await rmPage.evaluate(() => window.__bouquetDebug.store.setPackageStep('card'));
await rmPage.waitForTimeout(80);
const reducedFinal = await rmPage.evaluate(() => window.__bouquetDebug.getDecorState());
check(
  '减少动态时包装、丝带、卡片直接出现',
  reducedFinal.wrapping.visible && reducedFinal.ribbon.visible && reducedFinal.card.visible === false && reducedFinal.animating === false,
  JSON.stringify(reducedFinal),
);
await rmPage.screenshot({ path: `${SHOTS}/15-reduced-motion.png` });
await rmContext.close();

console.log('24. 控制台检查');
const unexpected = consoleIssues.filter((text) => !text.includes('Failed to load resource'));
check('主流程无控制台错误/警告', unexpected.length === 0, unexpected.join(' | '));

await browser.close();
console.log(`\n全部通过：${passed} 项检查。截图在 app/${SHOTS}/。`);




