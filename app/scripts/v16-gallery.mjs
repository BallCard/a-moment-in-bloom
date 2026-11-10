/**
 * v16 开屏作品展：右侧无边框展示 + 滚轮切换。
 *
 * 覆盖：
 * 1) 1366×768 开屏 / 打开作品展的版面截图；
 * 2) 右侧展示区没有边框、卡片底、阴影、圆角，也没有内部滚动条；
 * 3) 作品图足够大且贴着右边缘、上下出血；左对齐文字完整（序号/标题/说明/入口）；
 * 4) 鼠标在右侧展示区滚轮按顺序切换 6 件作品（序号与图片都变），到第 6 件后回到第 1 件；
 * 5) 鼠标在左侧按钮区滚动不会切换作品；
 * 6) 左右按钮与圆点可以切换；
 * 7) 391px 窄屏：左右按钮可见可用、无横向溢出、展示区不超出首屏；
 * 8) 刷新后行为一致；开屏「继续上次的花束 / 从空白开始 / 返回作品展 / 找回新建前的花束」
 *    与 start-continue / start-blank / start-gallery / start-restore 等 testid 行为不回归；
 * 9) 选择前不请求 GLB、不建 3D 画布；页面无脚本错误。
 *
 * 运行（5173 已在跑）：node scripts/v16-gallery.mjs
 * 环境变量：SMOKE_URL、v16_OUT、HEADED。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.v16_OUT ?? '.verify/v16-gallery';
mkdirSync(OUT, { recursive: true });

/** 与 data/showcase.ts 一致：顺序、标题、封面、来源。 */
const WORKS = [
  { id: 'morning', number: '01', title: '清晨来信', cover: 'morning-letter.webp', source: 'lux3d' },
  { id: 'daylight', number: '02', title: '窗边白昼', cover: 'daylight-vase.webp', source: 'lux3d' },
  { id: 'evening', number: '03', title: '玫瑰晚信', cover: 'evening-letter.webp', source: 'lux3d' },
  { id: 'sunshine', number: '04', title: '向阳小札', cover: 'sunshine-note.webp', source: 'lux3d' },
  { id: 'wood-table', number: '05', title: '旧木桌的午后', cover: 'handmade-wood-table.jpg', source: 'handmade' },
  { id: 'birthday', number: '06', title: '给朋友的生日', cover: 'handmade-birthday.jpg', source: 'handmade' },
];
const TOTAL = WORKS.length;

const checks = [];
let count = 0;
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`);
  count += 1;
  console.log('ok', count, name);
}
const wait = (page, ms) => page.waitForTimeout(ms);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: process.env.HEADED !== '1',
  args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});

/** 读取展示区的当前状态：当前作品、序号文案、当前图片地址。 */
async function stageState(page) {
  return page.evaluate(() => {
    const stage = document.querySelector('[data-testid=showcase-gallery]');
    const active = stage?.querySelector('.stage-frame.is-active');
    const img = active?.querySelector('img');
    return {
      visible: Boolean(stage),
      activeId: stage?.getAttribute('data-active-id') ?? null,
      indexText: (document.querySelector('[data-testid=gallery-index]')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      captionTitle: (document.querySelector('.stage-title')?.textContent ?? '').trim(),
      activeFrames: stage?.querySelectorAll('.stage-frame.is-active').length ?? 0,
      activeSource: active?.getAttribute('data-source') ?? null,
      imgSrc: img?.getAttribute('src') ?? null,
      imgLoaded: Boolean(img?.complete && img?.naturalWidth > 0),
      paletteHref: document.querySelector('[data-testid^=gallery-palette-]')?.getAttribute('href') ?? null,
      dotsOn: stage?.querySelectorAll('.stage-dot.is-on').length ?? 0,
      dots: stage?.querySelectorAll('.stage-dot').length ?? 0,
      frames: stage?.querySelectorAll('.stage-frame').length ?? 0,
    };
  });
}

async function openGalleryFromStartScreen(page) {
  await page.getByTestId('start-continue').waitFor({ timeout: 60000 });
  await page.getByTestId('start-gallery').click();
  await page.getByTestId('showcase-gallery').waitFor({ state: 'visible' });
  // 等当前作品的封面图真正解码完成，截图和尺寸断言才有意义。
  await page.waitForFunction(() => {
    const img = document.querySelector('.stage-frame.is-active img');
    return Boolean(img && img.complete && img.naturalWidth > 0);
  }, null, { timeout: 30000 });
  await page.waitForTimeout(900);
}

/** 滚轮在某个位置上滚一格，返回切换后的状态。 */
async function wheelAt(page, x, y, delta = 320) {
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(620);
  return stageState(page);
}

/**
 * 用作品展的配色入口造一份 10 枝存档，供开屏使用。
 * dev server 首次加载会重排依赖，偶发页面自刷新，这里重试几次。
 */
async function seedSavedBouquet(context, base) {
  const seed = await context.newPage();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await seed.goto(`${base}?palette=morning`);
      await seed.waitForFunction(() => window.__bouquetDebug?.getState().doc.stems.length === 10, null, { timeout: 45000 });
      await seed.waitForTimeout(1100);
      const saved = await seed.evaluate(() => {
        try { return JSON.parse(localStorage.getItem('bouquet-workbench.v1')).stems.length; } catch { return 0; }
      });
      if (saved === 10) {
        await seed.close();
        return;
      }
    } catch (error) {
      if (attempt === 3) throw error;
    }
    await seed.waitForTimeout(1200);
  }
  await seed.close();
}

try {
  // ====================== 一、新访客：工作台右栏作品展不回归 ======================
  {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(URL);
    await page.waitForFunction(() => window.__bouquetDebug, null, { timeout: 60000 });
    check('新访客进入工作台后右栏作品展仍在', await page.getByTestId('showcase-gallery').isVisible());
    check('工作台右栏仍是 6 件作品列表', await page.locator('.gallery-item').count() === 6, await page.locator('.gallery-item').count());
    check('新访客页面里没有开屏展示区', await page.locator('.showcase-gallery.is-stage').count() === 0);
    check('新访客无脚本错误', errors.length === 0, errors.slice(0, 3));
    await context.close();
  }

  // ====================== 二、有存档：开屏 → 作品展 → 滚轮切换 ======================
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  // 先用作品展的配色入口造一份 10 枝的存档，再换一张干净页面回到开屏。
  await seedSavedBouquet(context, URL);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // dev server 热更新偶尔重复挂载 root 的提示，不属于页面错误。
    if (message.text().includes('createRoot() on a container')) return;
    consoleErrors.push(message.text());
  });
  const glbRequests = [];
  page.on('request', (request) => { if (request.url().includes('.glb')) glbRequests.push(request.url()); });

  await page.goto(URL);
  await page.getByTestId('start-continue').waitFor({ timeout: 60000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/01-start-1366.png` });

  check('开屏保留「继续上次的花束」', (await page.getByTestId('start-continue').innerText()).includes('继续上次的花束'));
  check('开屏保留「从空白开始」', await page.getByTestId('start-blank').isVisible());
  check('开屏保留「看作品展」', (await page.getByTestId('start-gallery').innerText()).includes('看作品展'));
  check('打开作品展前不请求 GLB', glbRequests.length === 0, glbRequests.slice(0, 3));
  check('打开作品展前没有 3D 画布', await page.locator('canvas').count() === 0);

  await openGalleryFromStartScreen(page);
  check('打开作品展不改动本机存档', JSON.parse(await page.evaluate(() => localStorage.getItem('bouquet-workbench.v1'))).stems.length === 10);
  let state = await stageState(page);
  check('作品展展示区已出现', state.visible);
  check('默认从第 1 件作品开始', state.activeId === 'morning', state.activeId);
  check('序号指示为 01 / 06', state.indexText.replace(/\s/g, '') === '01/06', state.indexText);
  check('6 件作品都已在展示区里', state.frames === TOTAL, state.frames);
  check('同时只有 1 件作品在显示', state.activeFrames === 1, state.activeFrames);
  check('当前封面图已加载', state.imgLoaded && state.imgSrc.includes(WORKS[0].cover), state.imgSrc);
  check('圆点指示共 6 个、当前 1 个', state.dots === TOTAL && state.dotsOn === 1, { dots: state.dots, on: state.dotsOn });
  check('左对齐文字为当前作品', state.captionTitle === WORKS[0].title, state.captionTitle);
  check('保留「用这个配色开始创作」入口', (state.paletteHref ?? '').includes(`palette=${WORKS[0].id}`), state.paletteHref);
  check('打开作品展后仍不请求 GLB', glbRequests.length === 0, glbRequests.slice(0, 3));
  check('打开作品展后仍无 3D 画布', await page.locator('canvas').count() === 0);

  // ---------- 无边框 / 无卡片底 / 无滚动条 ----------
  const style = await page.evaluate(() => {
    const read = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const s = getComputedStyle(el);
      return {
        border: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth],
        shadow: s.boxShadow,
        background: s.backgroundColor,
        image: s.backgroundImage,
        radius: s.borderTopLeftRadius,
        overflowY: s.overflowY,
        scrollable: el.scrollHeight - el.clientHeight,
        box: el.getBoundingClientRect().toJSON(),
      };
    };
    return { stage: read('.showcase-gallery.is-stage'), wrapper: read('.start-gallery'), collection: document.querySelectorAll('.showcase-gallery.is-stage .gallery-collection').length };
  });
  const noBorder = (b) => b && b.border.every((width) => Number.parseFloat(width) === 0);
  const transparent = (value) => value === 'rgba(0, 0, 0, 0)' || value === 'transparent';
  check('展示区没有边框', noBorder(style.stage), style.stage?.border);
  check('展示区没有阴影', style.stage?.shadow === 'none', style.stage?.shadow);
  check('展示区没有卡片底色', transparent(style.stage?.background) && style.stage?.image === 'none', { bg: style.stage?.background, image: style.stage?.image });
  check('展示区没有圆角', Number.parseFloat(style.stage?.radius ?? '1') === 0, style.stage?.radius);
  check('展示区没有内部滚动条', style.stage?.overflowY !== 'auto' && style.stage?.overflowY !== 'scroll' && style.stage?.scrollable <= 1, { overflowY: style.stage?.overflowY, scrollable: style.stage?.scrollable });
  check('不再渲染卡片列表容器', style.collection === 0, style.collection);
  check('外层也不再是卡片容器', noBorder(style.wrapper) && (transparent(style.wrapper?.background) || style.wrapper?.image === 'none'), { border: style.wrapper?.border, bg: style.wrapper?.background });

  // ---------- 版面：右侧出血、图够大 ----------
  const layout = await page.evaluate(() => {
    const stage = document.querySelector('.showcase-gallery.is-stage').getBoundingClientRect();
    const img = document.querySelector('.stage-frame.is-active img').getBoundingClientRect();
    const caption = document.querySelector('.stage-caption').getBoundingClientRect();
    const title = document.querySelector('.stage-title').getBoundingClientRect();
    const arrows = document.querySelector('.stage-arrows').getBoundingClientRect();
    return { stage: stage.toJSON(), img: img.toJSON(), caption: caption.toJSON(), title: title.toJSON(), arrows: arrows.toJSON(), vw: innerWidth, vh: innerHeight };
  });
  check('展示区贴着右边缘', Math.abs(layout.stage.x + layout.stage.width - layout.vw) <= 1, { right: layout.stage.x + layout.stage.width, vw: layout.vw });
  check('展示区上下出血到屏幕边缘', layout.stage.y <= 1 && Math.abs(layout.stage.y + layout.stage.height - layout.vh) <= 1, layout.stage);
  check('展示区占右半屏', layout.stage.width >= layout.vw * 0.45 && layout.stage.width <= layout.vw * 0.55, layout.stage.width);
  check('作品图足够大（≥600×700）', layout.img.width >= 600 && layout.img.height >= 700, layout.img);
  check('作品图铺满展示区', Math.abs(layout.img.width - layout.stage.width) <= 1 && layout.img.height >= layout.stage.height, { img: layout.img, stage: layout.stage });
  check('文字左对齐且不与按钮重叠', layout.title.x < layout.stage.x + layout.stage.width * 0.55 && layout.caption.y + layout.caption.height < layout.stage.y + layout.stage.height + 1 && layout.caption.x + layout.caption.width < layout.arrows.x, { caption: layout.caption, arrows: layout.arrows });
  check('右侧有滚轮提示文案', await page.locator('.stage-hint').isVisible());

  await page.screenshot({ path: `${OUT}/02-gallery-1366.png` });

  // ---------- 滚轮：右侧切换 ----------
  const cx = layout.stage.x + layout.stage.width / 2;
  const cy = layout.stage.y + layout.stage.height / 2;
  const wheeled = await wheelAt(page, cx, cy);
  check('右侧滚轮切到第 2 件', wheeled.activeId === WORKS[1].id, wheeled.activeId);
  check('右侧滚轮后序号变 02 / 06', wheeled.indexText.replace(/\s/g, '') === '02/06', wheeled.indexText);
  check('右侧滚轮后图片换成第 2 件封面', wheeled.imgSrc.includes(WORKS[1].cover) && wheeled.imgLoaded, wheeled.imgSrc);
  check('右侧滚轮后文字换成第 2 件', wheeled.captionTitle === WORKS[1].title, wheeled.captionTitle);
  check('右侧滚轮后仍是单件显示', wheeled.activeFrames === 1, wheeled.activeFrames);
  await page.screenshot({ path: `${OUT}/03-gallery-wheel.png` });

  // ---------- 滚轮：左侧按钮区不抢 ----------
  const before = wheeled.activeId;
  const left = await page.evaluate(() => {
    const choices = document.querySelector('.start-choices').getBoundingClientRect();
    return { x: choices.x + choices.width / 2, y: choices.y + choices.height / 2 };
  });
  const afterLeftWheel = await wheelAt(page, left.x, left.y, 320);
  check('左侧按钮区滚轮不切换作品', afterLeftWheel.activeId === before, { before, after: afterLeftWheel.activeId });
  const afterLeftUp = await wheelAt(page, left.x, left.y, -320);
  check('左侧按钮区再次滚动仍不切换', afterLeftUp.activeId === before, afterLeftUp.activeId);

  // ---------- 6 件循环 ----------
  const seen = [];
  for (let step = 0; step < TOTAL; step += 1) {
    const next = await wheelAt(page, cx, cy);
    seen.push(next.activeId);
    if (next.activeId === 'wood-table') {
      check('切到手作作品时标注「工作台手作」', await page.getByTestId('gallery-handmade-tag').isVisible());
      check('手作作品也有配色入口', (next.paletteHref ?? '').includes('palette=wood-table'), next.paletteHref);
      await page.screenshot({ path: `${OUT}/04-gallery-handmade.png` });
    }
  }
  const expected = [WORKS[2].id, WORKS[3].id, WORKS[4].id, WORKS[5].id, WORKS[0].id, WORKS[1].id];
  check('滚轮按顺序走过 6 件并回到开头', JSON.stringify(seen) === JSON.stringify(expected), seen);
  const wrapped = await stageState(page);
  check('第 6 件之后回到第 1 件', wrapped.activeId === WORKS[1].id, wrapped.activeId);

  // ---------- 左右按钮与圆点 ----------
  await page.getByTestId('gallery-next').click();
  await page.waitForTimeout(620);
  check('右箭头切到下一件', (await stageState(page)).activeId === WORKS[2].id, (await stageState(page)).activeId);
  await page.getByTestId('gallery-prev').click();
  await page.waitForTimeout(620);
  check('左箭头切回上一件', (await stageState(page)).activeId === WORKS[1].id, (await stageState(page)).activeId);
  await page.getByTestId('gallery-dot-06').click();
  await page.waitForTimeout(620);
  check('点圆点直达第 6 件', (await stageState(page)).activeId === WORKS[5].id, (await stageState(page)).activeId);
  await page.getByTestId('gallery-next').focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(620);
  check('方向键也能切换作品', (await stageState(page)).activeId === WORKS[0].id, (await stageState(page)).activeId);
  await page.screenshot({ path: `${OUT}/05-gallery-controls.png` });

  // ---------- 刷新后行为一致 ----------
  await page.reload();
  await page.getByTestId('start-continue').waitFor({ timeout: 60000 });
  check('刷新后作品展回到收起状态', await page.locator('.showcase-gallery.is-stage').count() === 0);
  await openGalleryFromStartScreen(page);
  check('刷新后再打开仍从第 1 件开始', (await stageState(page)).activeId === WORKS[0].id, (await stageState(page)).activeId);
  await page.screenshot({ path: `${OUT}/06-gallery-reload.png` });

  // ====================== 三、既有开屏行为不回归 ======================
  await page.getByTestId('start-continue').click();
  await page.waitForFunction(() => window.__bouquetDebug, null, { timeout: 60000 });
  check('从开屏继续上次的花束仍是 10 枝', await page.evaluate(() => window.__bouquetDebug.getState().doc.stems.length === 10));
  await page.screenshot({ path: `${OUT}/07-continue-workbench.png` });

  await page.getByTestId('new-bouquet').click();
  await page.getByTestId('start-blank').click();
  await page.waitForFunction(() => window.__bouquetDebug?.getState().doc.stems.length === 0, null, { timeout: 60000 });
  check('从空白开始仍会先备份旧作品', await page.evaluate(() => JSON.parse(localStorage.getItem('bouquet-workbench.before-new.v1')).doc.stems.length === 10));
  await page.getByTestId('gallery-open').click();
  await page.getByTestId('showcase-gallery').waitFor({ state: 'visible' });
  check('工作台「作品展」入口仍直接打开展示区', (await stageState(page)).visible);
  await page.getByTestId('start-restore').click();
  await page.getByTestId('start-continue').waitFor({ timeout: 60000 });
  check('「找回新建前的花束」仍能恢复 10 枝', JSON.parse(await page.evaluate(() => localStorage.getItem('bouquet-workbench.v1'))).stems.length === 10);

  // 存储写不进时不能替换当前花束（原有保护）。
  await page.evaluate(() => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key, value) {
      if (key.includes('before-new')) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, key, value);
    };
  });
  await page.getByTestId('start-blank').click();
  check('备份失败时仍会提示并保住原花束', await page.getByRole('alert').isVisible() && await page.getByTestId('start-continue').isVisible());

  check('滚动切换全程没有脚本错误', errors.length === 0, errors.slice(0, 3));
  check('滚动切换全程没有控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3));
  await context.close();

  // ====================== 四、391px 窄屏兜底 ======================
  {
    const mobile = await browser.newContext({ viewport: { width: 391, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
    await seedSavedBouquet(mobile, URL);
    const small = await mobile.newPage();
    const smallErrors = [];
    small.on('pageerror', (error) => smallErrors.push(error.message));
    await small.goto(URL);
    await small.getByTestId('start-continue').waitFor({ timeout: 60000 });
    await small.waitForTimeout(400);
    check('窄屏开屏无横向溢出', await small.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, await small.evaluate(() => document.documentElement.scrollWidth - innerWidth));
    await small.screenshot({ path: `${OUT}/08-start-391.png` });

    await small.getByTestId('start-gallery').click();
    await small.getByTestId('showcase-gallery').waitFor({ state: 'visible' });
    await small.waitForFunction(() => {
      const img = document.querySelector('.stage-frame.is-active img');
      return Boolean(img && img.complete && img.naturalWidth > 0);
    }, null, { timeout: 30000 });
    await wait(small, 900);
    check('窄屏作品展无横向溢出', await small.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, await small.evaluate(() => document.documentElement.scrollWidth - innerWidth));

    const smallLayout = await small.evaluate(() => {
      const stage = document.querySelector('.showcase-gallery.is-stage').getBoundingClientRect();
      const prev = document.querySelector('[data-testid=gallery-prev]').getBoundingClientRect();
      const next = document.querySelector('[data-testid=gallery-next]').getBoundingClientRect();
      return { stage: stage.toJSON(), prev: prev.toJSON(), next: next.toJSON(), vw: innerWidth, vh: innerHeight };
    });
    const inside = (box) => box.x >= 0 && box.x + box.width <= smallLayout.vw + 1 && box.y >= 0 && box.y + box.height <= smallLayout.vh + 1;
    check('窄屏展示区在首屏内完整可见', inside(smallLayout.stage), { stage: smallLayout.stage, vh: smallLayout.vh });
    check('窄屏左右按钮可见且在首屏内', await small.getByTestId('gallery-prev').isVisible() && await small.getByTestId('gallery-next').isVisible() && inside(smallLayout.prev) && inside(smallLayout.next), { prev: smallLayout.prev, next: smallLayout.next });
    check('窄屏展示区仍是 6 件', (await stageState(small)).frames === TOTAL);
    await small.screenshot({ path: `${OUT}/09-gallery-391.png` });

    const smallStart = (await stageState(small)).activeId;
    await small.getByTestId('gallery-next').click();
    await small.waitForTimeout(620);
    const smallNext = await stageState(small);
    check('窄屏「下一件」按钮能切换', smallNext.activeId !== smallStart, { from: smallStart, to: smallNext.activeId });
    await small.getByTestId('gallery-prev').click();
    await small.waitForTimeout(620);
    check('窄屏「上一件」按钮能切回', (await stageState(small)).activeId === smallStart, (await stageState(small)).activeId);
    check('窄屏无脚本错误', smallErrors.length === 0, smallErrors.slice(0, 3));
    await small.screenshot({ path: `${OUT}/10-gallery-391-after.png` });
    await mobile.close();
  }

  writeFileSync(`${OUT}/results.json`, JSON.stringify({ passed: count, total: count, checks }, null, 2));
  console.log(`\nv16 开屏作品展无边框展示与滚轮切换：${count}/${count} 通过`);
} catch (error) {
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ passed: count, checks, error: String(error) }, null, 2));
  console.error('\n失败：', error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
