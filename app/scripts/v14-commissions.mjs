/**
 * v14 委托玩法扩充验证：c4 向日葵花篮 / c5 乔迁陶罐 / c6 纪念日礼盒。
 *
 * 覆盖：
 * 1) COMMISSIONS 共 6 封，order 4/5/6，nextId 串成 c1→…→c6→null；
 * 2) 解锁链：c4 初始锁定，交付 c1–c3 后可接；c5 需要 c4，c6 需要 c5；
 * 3) commissionWishes() 自动带出 family / assetId / presentation / ribbon 心愿，
 *    返回字段仍是 families / assetIds / kinds / paperId / ribbonColorId / presentationKind；
 * 4) evaluateCommission 对三个新委托的满足 / 部分满足 / 不满足判定与 metCount；
 * 5) presentation 检查只认对应器型（花篮 / 陶罐 / 礼盒），礼盒缎带颜色可判定；
 * 6) 真实 UI：来信可翻到第 6 封、锁态正确、心愿标签可读、c4 解锁后能接单，
 *    在包装阶段选藤编花篮后交付，判定 4/4 完成并把 c5 解锁；
 * 7) 全程无脚本错误，截图存 .verify/v14-commissions/。
 *
 * 运行：先起 5173 dev server，再 `node scripts/v14-commissions.mjs`。
 * 环境变量：SMOKE_URL、v14_COMMISSIONS_OUT、HEADED。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { newStudioAwarePage } from './studio-page.mjs';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.v14_COMMISSIONS_OUT ?? '.verify/v14-commissions';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: process.env.HEADED !== '1',
  args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await newStudioAwarePage(context);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text());
});

const checks = [];
let count = 0;
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`);
  count += 1;
  console.log('ok', name);
}

const state = () => page.evaluate(() => window.__bouquetDebug.getState());
const exec = (fn) => page.evaluate(fn);
const wait = (ms) => page.waitForTimeout(ms);
const cardId = () => page.getByTestId('commission-card').getAttribute('data-commission-id');
const ORDER = ['c1-birthday', 'c2-new-home', 'c3-anniversary', 'c4-sunflower-basket', 'c5-new-home-pot', 'c6-anniversary-box'];

async function openPicker() {
  await page.getByTestId('mode-commission').click();
  await page.waitForSelector('[data-testid=commission-card]');
  await wait(200);
}

async function showIndex(target) {
  for (let guard = 0; guard < 12; guard += 1) {
    const id = await cardId();
    const current = ORDER.indexOf(id);
    if (current === target) return id;
    await page.getByRole('button', { name: current < target ? '下一张心愿单' : '上一张心愿单' }).click();
    await wait(160);
  }
  throw Error(`翻不到第 ${target + 1} 封`);
}

async function wishChips(index) {
  await showIndex(index);
  const id = await cardId();
  const details = page.locator(`[data-commission-id="${id}"] details`);
  if (!(await details.evaluate((node) => node.open))) await page.locator(`[data-commission-id="${id}"] summary`).click();
  await wait(120);
  return {
    id,
    chips: await page.locator(`[data-commission-id="${id}"] [data-testid=commission-wish-chip]`).allTextContents(),
    note: await page.locator(`[data-commission-id="${id}"] [data-testid=commission-wish-note]`).textContent(),
  };
}

try {
  // ---------- 数据层 ----------
  await page.goto(URL);
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, { timeout: 60000 });

  const data = await exec(async () => {
    // 生产构建没有 /src/*.ts 可动态 import：走 App 暴露的只读委托调试入口，
    // 逻辑仍是同一份 evaluateCommission / commissionWishes，不在脚本里复写判定。
    const debug = window.__bouquetDebug;
    const COMMISSIONS = debug.commissions.list();
    const commissionWishes = (id) => debug.commissions.wishes(id);
    const getCommission = (id) => COMMISSIONS.find((def) => def.id === id) ?? null;
    const evaluateCommission = (doc, def) => debug.commissions.evaluate(def.id, doc);
    const isCommissionUnlocked = (def, completed) => debug.commissions.unlocked(def.id, completed);
    const catalog = window.__bouquetDebug.getState().catalog;
    const stems = (ids) => ids.map((assetId, i) => ({ assetId, id: `s${i}` }));
    const doc = (kind, ids, extra = {}) => ({
      stems: stems(ids),
      presentation: { kind },
      wrapping: { enabled: false, paperId: 'kraft', step: 'paper', openScale: 1 },
      ribbon: { colorId: 'rose' },
      card: { to: '', message: '', from: '' },
      ...extra,
    });
    const run = (commissionId, value) => {
      const progress = evaluateCommission(value, getCommission(commissionId), catalog);
      return {
        metCount: progress.metCount,
        total: progress.total,
        complete: progress.complete,
        met: Object.fromEntries(progress.checks.map((item) => [item.id, item.met])),
      };
    };
    const THREE_DONE = ['c1-birthday', 'c2-new-home', 'c3-anniversary'];
    const c4Stems = ['sunflower-1', 'sunflower-2', 'spray-chrysanthemum-1', 'statice-1', 'eucalyptus-green'];
    const c5Stems = ['rose-pink', 'ruscus-1', 'salal-1', 'boston-fern-1', 'eucalyptus-green'];
    const c6Stems = ['rose-pink', 'rose-ivory', 'tulip-pink', 'tulip-cream'];
    const cardMessage = { card: { to: '阿棠', message: '第八年，还是你', from: '顾' } };
    return {
      commissions: COMMISSIONS.map((def) => ({
        id: def.id,
        order: def.order,
        nextId: def.nextId,
        checks: def.checks.length,
        labels: def.checks.map((item) => item.label),
        brief: def.brief,
        customer: def.customer,
        occasion: def.occasion,
        completeResponse: def.responseComplete,
        partialResponse: def.responsePartial,
      })),
      c4ok: run('c4-sunflower-basket', doc('basket', c4Stems)),
      c4paper: run('c4-sunflower-basket', doc('paper', c4Stems)),
      c4missing: run('c4-sunflower-basket', doc('basket', ['sunflower-1', 'daisy-cream'])),
      c5ok: run('c5-new-home-pot', doc('pot', c5Stems)),
      c5vase: run('c5-new-home-pot', doc('vase', c5Stems)),
      c5missing: run('c5-new-home-pot', doc('pot', ['rose-pink', 'ruscus-1', 'salal-1'])),
      c6ok: run('c6-anniversary-box', doc('box', c6Stems, {
        ...cardMessage,
        // V16 §5：礼盒的吊牌是它实际支持的装饰；委托不再要求不可编辑的丝带换色。
        ornaments: [{ id: 'o1', kind: 'tag', colorId: 'ivory', position: [0, 0.9, 0.1], rotation: 0, scale: 1, intensity: 1, variant: 0 }],
      })),
      c6notag: run('c6-anniversary-box', doc('box', c6Stems, { ...cardMessage })),
      c6paper: run('c6-anniversary-box', doc('paper', c6Stems, {
        ...cardMessage,
        ornaments: [{ id: 'o1', kind: 'tag', colorId: 'ivory', position: [0, 0.9, 0.1], rotation: 0, scale: 1, intensity: 1, variant: 0 }],
      })),
      c6paperTagless: run('c6-anniversary-box', doc('paper', c6Stems, { ...cardMessage })),
      c6empty: run('c6-anniversary-box', doc('box', [])),
      wishes: {
        c4: commissionWishes('c4-sunflower-basket'),
        c5: commissionWishes('c5-new-home-pot'),
        c6: commissionWishes('c6-anniversary-box'),
      },
      unlocks: {
        c4none: isCommissionUnlocked(getCommission('c4-sunflower-basket'), []),
        c4done: isCommissionUnlocked(getCommission('c4-sunflower-basket'), THREE_DONE),
        c5noC4: isCommissionUnlocked(getCommission('c5-new-home-pot'), THREE_DONE),
        c5withC4: isCommissionUnlocked(getCommission('c5-new-home-pot'), [...THREE_DONE, 'c4-sunflower-basket']),
        c6noC5: isCommissionUnlocked(getCommission('c6-anniversary-box'), [...THREE_DONE, 'c4-sunflower-basket']),
        c6withC5: isCommissionUnlocked(getCommission('c6-anniversary-box'), [...THREE_DONE, 'c4-sunflower-basket', 'c5-new-home-pot']),
      },
    };
  });

  check('六封委托按 c1–c6 顺序', data.commissions.length === 6 && data.commissions.every((def, i) => def.order === i + 1), data.commissions.map((def) => `${def.order}:${def.id}`));
  check('nextId 串成完整解锁链', data.commissions.slice(0, 5).every((def, i) => def.nextId === data.commissions[i + 1].id) && data.commissions[5].nextId === null, data.commissions.map((def) => `${def.id}->${def.nextId}`));
  check('新委托都有来信正文与两种回应', data.commissions.slice(3).every((def) => def.brief.length >= 30 && def.completeResponse.length > 0 && def.partialResponse.length > 0 && def.customer && def.occasion), data.commissions.slice(3).map((def) => def.brief));
  check('每封 4–5 条检查、标签不超过 20 字', data.commissions.every((def) => def.checks >= 4 && def.checks <= 5 && def.labels.every((label) => Array.from(label).length <= 20)), data.commissions.map((def) => `${def.id}:${def.checks}/${def.labels.map((l) => Array.from(l).length).join(',')}`));
  check('c4 初始锁定，c1–c3 交付后解锁', data.unlocks.c4none === false && data.unlocks.c4done === true, data.unlocks);
  check('c5 需要 c4、c6 需要 c5', data.unlocks.c5noC4 === false && data.unlocks.c5withC4 === true && data.unlocks.c6noC5 === false && data.unlocks.c6withC5 === true, data.unlocks);

  check('c4 心愿：向日葵同科 + 配花整类', data.wishes.c4.families.includes('sunflower') && data.wishes.c4.kinds.includes('filler') && data.wishes.c4.presentationKind === 'basket', data.wishes.c4);
  check('c5 心愿：鲁斯卡斯 + 主花/绿叶', data.wishes.c5.families.includes('ruscus') && data.wishes.c5.kinds.includes('main') && data.wishes.c5.kinds.includes('greenery') && data.wishes.c5.presentationKind === 'pot', data.wishes.c5);
  check('c6 心愿：玫瑰/郁金香 + 礼盒 + 吊牌', data.wishes.c6.families.includes('rose') && data.wishes.c6.families.includes('tulip') && data.wishes.c6.presentationKind === 'box' && data.wishes.c6.ornamentKind === 'tag' && !data.wishes.c6.ribbonColorId, data.wishes.c6);

  check('c4 花篮满足判定 4/4', data.c4ok.complete && data.c4ok.metCount === 4, data.c4ok);
  check('c4 纸包不算花篮（3/4）', !data.c4paper.complete && data.c4paper.metCount === 3 && data.c4paper.met['c4-basket'] === false, data.c4paper);
  check('c4 花材不足只达成器型（1/4）', data.c4missing.metCount === 1 && data.c4missing.met['c4-basket'] === true, data.c4missing);

  check('c5 陶罐满足判定 5/5', data.c5ok.complete && data.c5ok.metCount === 5, data.c5ok);
  check('c5 花瓶不算陶罐（4/5）', !data.c5vase.complete && data.c5vase.metCount === 4 && data.c5vase.met['c5-pot'] === false, data.c5vase);
  check('c5 绿叶/枝数不足只达成 3/5', data.c5missing.metCount === 3 && data.c5missing.met['c5-green'] === false && data.c5missing.met['c5-total'] === false, data.c5missing);

  check('c6 礼盒满足判定 5/5', data.c6ok.complete && data.c6ok.metCount === 5, data.c6ok);
  check('c6 没挂吊牌（4/5）', !data.c6notag.complete && data.c6notag.metCount === 4 && data.c6notag.met['c6-tag'] === false, data.c6notag);
  check('c6 纸包不算礼盒但吊牌仍算数（4/5）', data.c6paper.metCount === 4 && data.c6paper.met['c6-box'] === false && data.c6paper.met['c6-tag'] === true, data.c6paper);
  check('c6 纸包未挂吊牌（3/5）', data.c6paperTagless.metCount === 3 && data.c6paperTagless.met['c6-tag'] === false, data.c6paperTagless);
  check('c6 空作品只有器型成立（1/5）', data.c6empty.metCount === 1 && data.c6empty.met['c6-box'] === true && data.c6empty.met['c6-tag'] === false, data.c6empty);

  // ---------- UI：翻阅 / 锁态 / 心愿标签 ----------
  await openPicker();
  await page.screenshot({ path: `${OUT}/01-picker-first.png` });
  const paged = [await cardId()];
  for (let i = 0; i < 5; i += 1) {
    await page.getByRole('button', { name: '下一张心愿单' }).click();
    await wait(140);
    paged.push(await cardId());
  }
  check('来信可翻到第 6 封', JSON.stringify(paged) === JSON.stringify(ORDER), paged);
  check('翻页计数显示 6 / 6', (await page.locator('.commission-pager span').textContent()).trim() === `6 / ${ORDER.length}`);
  await page.getByTestId('commission-picker').focus();
  await page.keyboard.press('ArrowLeft');
  await wait(140);
  check('方向键可回上一封', (await cardId()) === 'c5-new-home-pot', await cardId());
  await page.keyboard.press('ArrowRight');
  await wait(140);

  await showIndex(3);
  check('c4 初始锁态与按钮文案', (await page.getByTestId('commission-start-c4-sunflower-basket').isDisabled()) && (await page.locator('[data-commission-id="c4-sunflower-basket"]').getAttribute('class')).includes('is-locked') && (await page.getByTestId('commission-start-c4-sunflower-basket').textContent()).includes('尚未解锁'));
  const c4wish = await wishChips(3);
  check('c4 心愿标签带出花材与器型', c4wish.chips.some((text) => text.includes('向日葵')) && c4wish.chips.some((text) => text.includes('藤编花篮')) && c4wish.chips.some((text) => text.includes('配花')), c4wish.chips);
  check('c4 有花材架提示', (c4wish.note ?? '').includes('花材架'), c4wish.note);
  await page.screenshot({ path: `${OUT}/02-picker-c4-wishes.png` });

  const c5wish = await wishChips(4);
  check('c5 心愿标签带出陶罐与绿叶', c5wish.chips.some((text) => text.includes('宽口陶罐')) && c5wish.chips.some((text) => text.includes('鲁斯卡斯')) && c5wish.chips.some((text) => text.includes('绿叶')), c5wish.chips);
  check('c5 锁态：需先完成 c4', (await page.getByTestId('commission-start-c5-new-home-pot').isDisabled()), c5wish.chips);
  await page.screenshot({ path: `${OUT}/03-picker-c5-wishes.png` });

  const c6wish = await wishChips(5);
  check('c6 心愿标签带出礼盒、玫瑰、郁金香与吊牌', c6wish.chips.some((text) => text.includes('花礼盒')) && c6wish.chips.some((text) => text.includes('玫瑰')) && c6wish.chips.some((text) => text.includes('吊牌')) && c6wish.chips.some((text) => text.includes('郁金香')), c6wish.chips);
  const clipping = await page.evaluate(() => {
    const picker = document.querySelector('.commission-picker');
    const card = document.querySelector('[data-commission-id="c6-anniversary-box"]');
    const button = card.querySelector('.commission-foot .btn-primary');
    return {
      modalBottom: Math.round(picker.getBoundingClientRect().bottom),
      buttonBottom: Math.round(button.getBoundingClientRect().bottom),
      scrollable: picker.scrollHeight > picker.clientHeight,
    };
  });
  check('心愿展开后接单按钮不被裁切（弹窗可滚动）', clipping.buttonBottom <= clipping.modalBottom + 1 && clipping.scrollable, clipping);
  await page.screenshot({ path: `${OUT}/04-picker-c6-wishes.png` });
  await page.getByTestId('commission-close').click();
  await wait(200);

  // ---------- UI：交付 c1–c3 后 c4 解锁并接单 ----------
  await exec(() => {
    localStorage.setItem('bouquet-workbench.settings.v1', JSON.stringify({
      completedCommissions: ['c1-birthday', 'c2-new-home', 'c3-anniversary'],
      mode: 'free',
      commission: null,
    }));
  });
  await page.reload();
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, { timeout: 60000 });
  check('重载后读取已完成三封', JSON.stringify((await state()).completedCommissions) === JSON.stringify(['c1-birthday', 'c2-new-home', 'c3-anniversary']));

  await openPicker();
  await showIndex(3);
  check('交付 c1–c3 后 c4 可接', !(await page.getByTestId('commission-start-c4-sunflower-basket').isDisabled()) && (await page.getByTestId('commission-start-c4-sunflower-basket').textContent()).includes('接下'));
  await page.screenshot({ path: `${OUT}/05-picker-c4-unlocked.png` });
  await page.getByTestId('commission-start-c4-sunflower-basket').click();
  await page.waitForFunction(() => window.__bouquetDebug.getState().commissionId === 'c4-sunflower-basket', null, { timeout: 20000 });
  check('接单后进入 c4 委托', (await state()).mode === 'commission' && (await page.getByTestId('commission-picker').count()) === 0);
  const shelf = await page.evaluate(() => ({
    line: document.querySelector('[data-testid=shelf-wish-line]')?.textContent ?? '',
    wished: document.querySelectorAll('.shelf-card[data-wish="1"]').length,
  }));
  check('花材架按 c4 心愿标出花材', shelf.line.includes('向日葵') && shelf.wished >= 2, shelf);

  // 摆 5 枝：2 向日葵 + 2 配花 + 1 绿叶，并在包装阶段换成藤编花篮。
  await exec(() => {
    const s = window.__bouquetDebug.store;
    for (const assetId of ['sunflower-1', 'sunflower-2', 'spray-chrysanthemum-1', 'statice-1', 'eucalyptus-green']) {
      s.setPlacement(assetId);
      s.placeStem({ height: 0.02, tilt: 12, direction: Math.random() * 360 });
    }
    s.setPlacement(null);
    s.select(null);
  });
  await page.waitForFunction(() => window.__bouquetDebug.getState().doc.stems.length === 5);
  await page.waitForFunction(() => [...window.__bouquetDebug.scene.views.values()].every((view) => view.object), null, { timeout: 90000 });
  check('接单工作台可摆满 5 枝', (await state()).doc.stems.length === 5);

  await page.getByTestId('stage-wrap').click();
  await wait(300);
  await page.getByTestId('presentation-basket').click();
  await page.getByTestId('confirm-presentation').click();
  await wait(900);
  check('包装阶段选中藤编花篮', (await state()).doc.presentation.kind === 'basket');
  const actual = await exec(async () => {
    const debug = window.__bouquetDebug;
    const d = debug.getState();
    const progress = debug.commissions.evaluate(d.commissionId, d.doc);
    return { metCount: progress.metCount, total: progress.total, complete: progress.complete, met: Object.fromEntries(progress.checks.map((item) => [item.id, item.met])) };
  });
  check('真实作品在花篮阶段已达成 4/4', actual.complete && actual.metCount === 4, actual);
  await page.screenshot({ path: `${OUT}/06-c4-basket.png` });

  await page.getByTestId('stage-finish').click();
  await wait(2200);
  const delivered = await exec(async () => {
    const d = window.__bouquetDebug;
    return d.store.deliverCommission(await d.captureThumbnail());
  });
  check('c4 交付判定完成', delivered && delivered.complete && delivered.metCount === 4 && delivered.total === 4, delivered);
  check('交付后 c4 记为已完成', (await state()).completedCommissions.includes('c4-sunflower-basket'));
  await page.screenshot({ path: `${OUT}/07-c4-delivered.png` });

  await openPicker();
  await showIndex(4);
  check('c4 交付后 c5 解锁', !(await page.getByTestId('commission-start-c5-new-home-pot').isDisabled()));
  await page.screenshot({ path: `${OUT}/08-c5-unlocked.png` });
  await showIndex(5);
  check('c6 仍需先完成 c5', await page.getByTestId('commission-start-c6-anniversary-box').isDisabled());
  await page.getByTestId('commission-close').click();

  check('无页面与 WebGL 脚本错误', errors.length === 0, errors);
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ date: new Date().toISOString(), url: URL, passed: count, checks, errors }, null, 2));
  console.log(`PASSED ${count}`);
} catch (error) {
  writeFileSync(`${OUT}/failure.json`, JSON.stringify({ date: new Date().toISOString(), passed: count, checks, error: String(error), errors }, null, 2));
  throw error;
} finally {
  await browser.close();
}
