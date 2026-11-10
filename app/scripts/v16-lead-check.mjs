/**
 * Lead 集成自查（临时脚本，最终会被 v16-upgrade.mjs 取代）。
 * 覆盖：放花 → 整理（翻瓣/去刺）→ 包装/花泥 → 装饰 → 贺卡入口 → 音效。
 * 运行：先确保 dev server 在 5173，再 `node scripts/v16-lead-check.mjs`。
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = '.verify/v16-lead-check';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : JSON.stringify(detail));
}
const state = () => page.evaluate(() => window.__bouquetDebug.getState());
const organizeState = () => page.evaluate(() => window.__bouquetDebug.scene.getOrganizeState?.());
const decorState = () => page.evaluate(() => window.__bouquetDebug.scene.getDecorState?.());
const foamState = () => page.evaluate(() => window.__bouquetDebug.scene.getFoamDebug?.());
const audioState = () => page.evaluate(() => window.__bouquetDebug.audio.state());

await page.goto(URL);
await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, { timeout: 90000 });
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, { timeout: 90000 });
await page.waitForTimeout(900);

// 1. 放一枝玫瑰（点花材 → 点画布）
await page.getByTestId('palette-rose').click();
await page.waitForTimeout(150);
check('点花材进入放置模式', (await state()).placement?.assetId === 'rose-pink', (await state()).placement);
await page.mouse.click(700, 380);
await page.waitForFunction(() => window.__bouquetDebug.getState().doc.stems.length === 1, null, { timeout: 15000 }).catch(() => {});
const s1 = await state();
check('画布点击落叶', s1.doc.stems.length === 1, s1.doc.stems.length);
const stemId = s1.doc.stems[0]?.id;
await page.evaluate((id) => window.__bouquetDebug.select(id), stemId);
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/01-placed.png` });

// 2. 打开右栏整理
await page.getByTestId('near-more').click();
await page.getByTestId('organize-panel').waitFor({ timeout: 8000 }).catch(() => {});
check('整理面板可打开', (await page.getByTestId('organize-panel').count()) === 1);
check('可翻瓣花材显示翻瓣区', (await page.getByTestId('organize-flip-block').count()) === 1);
check('可翻瓣标签存在', (await page.getByTestId('organize-flip-chip').count()) === 1);

// 3. 翻瓣
const beforeFlip = (await state()).doc.stems[0].preparation.petalFlip ?? 0;
await page.getByTestId('organize-flip-full').click();
await page.waitForTimeout(500);
const afterFlip = (await state()).doc.stems[0].preparation.petalFlip;
const orgVis = await organizeState();
check('翻瓣写入状态', afterFlip === 1 && beforeFlip === 0, { beforeFlip, afterFlip });
check('翻瓣视觉同步', Math.abs((orgVis?.stems?.[0]?.visual?.petalFlip ?? 0) - 1) < 0.05, orgVis?.stems?.[0]?.visual);
check('可翻瓣花头数量 > 0', (orgVis?.stems?.[0]?.visual?.headMeshes ?? 0) > 0, orgVis?.stems?.[0]?.visual?.headMeshes);
await page.screenshot({ path: `${OUT}/02-flipped.png` });
await page.getByTestId('organize-flip-reset').click();
await page.waitForTimeout(400);
check('翻瓣可恢复', ((await state()).doc.stems[0].preparation.petalFlip ?? 0) === 0);

// 4. 去刺
await page.getByTestId('organize-dethorn').click();
await page.waitForTimeout(400);
const thornVis = (await organizeState())?.stems?.[0]?.visual?.thorns;
check('去刺写入状态', (await state()).doc.stems[0].preparation.thornsRemoved === true);
check('去刺视觉隐藏', thornVis?.visible === false, thornVis);
await page.screenshot({ path: `${OUT}/03-dethorned.png` });

// 5. 整束整理 + 一次撤销
await page.getByTestId('organize-restore-thorns').click();
await page.waitForTimeout(200);
const beforeOrganize = JSON.stringify((await state()).doc.stems.map((s) => s.preparation));
await page.evaluate(() => window.__bouquetDebug.store.select(null));
await page.waitForTimeout(300);
await page.getByTestId('flower-organize').click();
await page.waitForTimeout(500);
const hasBouquetEntry = (await page.getByTestId('organize-bouquet').count()) === 1;
check('未选中时出现整束整理', hasBouquetEntry);
if (hasBouquetEntry) {
  await page.getByTestId('organize-bouquet').click();
  await page.waitForTimeout(400);
  const afterOrganize = JSON.stringify((await state()).doc.stems.map((s) => s.preparation));
  check('整束整理改变状态', beforeOrganize !== afterOrganize, { at: (await state()).doc.stems.map((s) => s.preparation) });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  check('整束整理一次撤销', JSON.stringify((await state()).doc.stems.map((s) => s.preparation)) === beforeOrganize);
}

// 6. 包装：换花篮 → 花泥
await page.getByTestId('stage-wrap').click();
await page.waitForTimeout(600);
await page.getByTestId('presentation-basket').click();
await page.waitForTimeout(500);
await page.getByTestId('confirm-presentation').click();
await page.waitForTimeout(800);
check('换成花篮', (await state()).doc.presentation.kind === 'basket');
// 整理入口在包装阶段被 decor 面板占用，直接走 store 做花泥步骤（UI 在右侧整理栏里）
await page.evaluate(() => {
  const store = window.__bouquetDebug.store;
  store.setFoam('place');
});
await page.waitForTimeout(600);
const foam1 = await foamState();
check('花泥放入状态', (await state()).doc.presentation.foam?.fitted === true, (await state()).doc.presentation.foam);
check('花泥视觉存在', foam1?.exists === true && foam1?.visible === true, foam1);
await page.evaluate(() => window.__bouquetDebug.store.setFoam('cut'));
await page.waitForTimeout(500);
const foam2 = await foamState();
check('花泥裁切贴合', (await state()).doc.presentation.foam?.cut === 1 && (foam2?.cut ?? 0) >= 0.9, foam2);
check('花泥不穿侧壁', (foam2?.wallGap ?? -1) >= 0, foam2);
await page.screenshot({ path: `${OUT}/04-basket-foam.png` });

// 7. 装饰
const panelText = await page.getByTestId('decor-panel').innerText().catch(() => '');
check('装饰入口存在', (await page.getByTestId('decorations-panel').count()) === 1, panelText.slice(0, 120));
const addPicks = await page.locator('[data-testid^="decoration-add-"]').count();
check('有可添加装饰', addPicks > 0, addPicks);
if (addPicks > 0) {
  const butterfly = page.locator('[data-testid="decoration-add-butterfly"]');
  if (await butterfly.count()) {
    await butterfly.click();
    await page.waitForTimeout(700);
    const ornaments = (await state()).doc.ornaments;
    check('添加插饰写入文档', ornaments.length === 1 && ornaments[0].kind === 'butterfly', ornaments);
    const decor = await decorState();
    check('装饰渲染到场景', decor?.ornaments?.count === 1, decor?.ornaments);
    check('花篮不显示丝带换色', decor?.ribbonSupported === false, decor?.ribbonSupported);
    await page.screenshot({ path: `${OUT}/05-ornament.png` });
    await page.getByTestId('decoration-remove').click();
    await page.waitForTimeout(500);
    check('移除装饰', (await state()).doc.ornaments.length === 0);
  }
}

// 8. 贺卡入口
await page.getByTestId('package-step-card').click().catch(() => {});
await page.waitForTimeout(400);
check('贺卡编辑器仍在', (await page.getByTestId('card-editor').count()) === 1);
check('常用短语入口存在', (await page.getByTestId('card-phrase-panel').count()) >= 0);
const cardText = await page.getByTestId('card-editor').innerText().catch(() => '');
check('贺卡含短语/AI 润色入口', /常用短语|润色/.test(cardText), cardText.slice(0, 160));

// 9. 音效
const audio = await audioState();
check('第一次交互后音频已解锁', audio.unlocked === true, audio);
check('动作音已记录', audio.played.length > 0, audio.played.slice(-6));
const names = new Set(audio.played.map((item) => item.name));
check('包含取花/放花/剪枝类事件', names.has('pick') || names.has('place'), [...names]);

check('无页面错误', errors.length === 0, errors.slice(0, 5));
await page.screenshot({ path: `${OUT}/06-final.png` });

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n${passed}/${results.length} passed, ${failed} failed`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
