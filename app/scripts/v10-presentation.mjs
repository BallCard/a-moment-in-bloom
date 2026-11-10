/**
 * V10 呈现形态与场景扩展验证：
 * - 包装与花器新增「藤编花篮 / 花礼盒」，切换仍走预览 → 采用，支点收在容器口内；
 * - 3D 容器可点回编辑，不改当前形态；
 * - 原来三种形式不回归（纸包/花瓶/陶罐）；
 * - 拍照场景新增「花店一角 / 庭院午后」，布景可见、背景色变化、导出与相册可用；
 * - 刷新后 new kind 能从存档恢复。
 *
 * 运行：先 `npm run dev:all`（或已有 5173），再 `node scripts/v10-presentation.mjs`。
 * 环境变量：SMOKE_URL、V10_OUT、HEADED。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { newStudioAwarePage } from './studio-page.mjs';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.V10_OUT ?? '.verify/v10-presentation';
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
const decorPoint = (kind) =>
  exec((k) => {
    const point = window.__bouquetDebug.scene.getDecorScreenPoint(k);
    return point ?? null;
  }, kind);

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

const sceneObject = (name) =>
  exec((objectName) => {
    const scene = window.__bouquetDebug.scene;
    const root = scene.scene ?? scene;
    const object = root.getObjectByName(objectName);
    if (!object) return null;
    return {
      visible: object.visible,
      inScene: Boolean(object.parent),
      children: object.children.length,
    };
  }, name);

try {
  await page.goto(URL);
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalog.mode === 'manifest');

  // 放 6 枝花，进入包装阶段
  await exec(() => {
    const store = window.__bouquetDebug.store;
    for (let i = 0; i < 6; i += 1) {
      store.setPlacement(i < 3 ? 'rose-pink' : i < 5 ? 'tulip-cream' : 'eucalyptus-green');
      store.placeStem({ height: (i % 3) * 0.035, tilt: 10 + i * 3, direction: i * 137, spin: 30 });
    }
    store.setPlacement(null);
    store.select(null);
  });
  await wait(1400);
  await page.waitForFunction(
    () => [...window.__bouquetDebug.scene.views.values()].every((view) => view.object),
    null,
    { timeout: 60000 },
  );
  await page.getByTestId('stage-wrap').click();
  await wait(500);

  // ---------- 1. 八种呈现形态入口 ----------
  for (const kind of ['paper', 'vase', 'pot', 'basket', 'box', 'bucket', 'bag', 'crate']) {
    check(`呈现入口 ${kind}`, await page.getByTestId(`presentation-${kind}`).isVisible());
  }
  check('旧形态文案仍在', (await page.getByTestId('presentation-vase').innerText()) === '细口花瓶');
  check('新增容器文案在', (await page.getByTestId('presentation-bucket').innerText()) === '抱抱桶');

  // ---------- 2. 花篮 ----------
  await page.getByTestId('presentation-basket').click();
  await wait(700);
  {
    const snapshot = await state();
    check('花篮切换先预览', snapshot.presentationPreview === true, snapshot.presentationPreview);
    check('预览期形态已是花篮', snapshot.doc.presentation.kind === 'basket', snapshot.doc.presentation.kind);
  }
  check('花篮 3D 模型已加入场景', (await sceneObject('flower-basket'))?.inScene === true);
  check('花篮模型可见', (await sceneObject('flower-basket'))?.visible === true);
  await page.screenshot({ path: `${OUT}/01-basket-preview.png` });
  await page.getByTestId('confirm-presentation').click();
  await wait(600);
  {
    const snapshot = await state();
    check('采用花篮', snapshot.doc.presentation.kind === 'basket' && snapshot.presentationPreview === false);
    check(
      '花篮支点收在篮口内',
      snapshot.doc.stems.every((stem) => Math.hypot(stem.position[0], stem.position[2]) <= 0.1501),
      snapshot.doc.stems.map((stem) => Number(Math.hypot(stem.position[0], stem.position[2]).toFixed(4))),
    );
    check(
      '花篮外倾角不超过 32°',
      snapshot.doc.stems.every((stem) => stem.pose.tilt <= 32.0001),
      snapshot.doc.stems.map((stem) => Number(stem.pose.tilt.toFixed(2))),
    );
    check(
      '花篮支点高度对齐篮口',
      snapshot.doc.stems.every((stem) => Math.abs(stem.position[1] - 0.792) < 1e-6),
      snapshot.doc.stems.map((stem) => stem.position[1]),
    );
    check(
      '花篮里花魂藏在篮内（茎长被剪短）',
      snapshot.doc.stems.every((stem) => stem.preparation.tailLength <= 0.1 + 1e-6),
      snapshot.doc.stems.map((stem) => stem.preparation.tailLength),
    );
  }
  await wait(500);
  await page.screenshot({ path: `${OUT}/02-basket.png` });

  // ---------- 3. 点 3D 花篮回编辑 ----------
  {
    const point = await decorPoint('vessel');
    check('3D 花篮有可点位置', Boolean(point), point);
    await page.mouse.click(point.x, point.y);
    await wait(600);
    check('点花篮展开包装与花器选择', await page.getByTestId('presentation-basket').isVisible());
    check('点花篮不改形态', (await state()).doc.presentation.kind === 'basket');
  }

  // ---------- 4. 花礼盒 ----------
  await page.getByTestId('presentation-box').click();
  await wait(700);
  {
    const snapshot = await state();
    check('礼盒切换先预览', snapshot.presentationPreview === true);
    check('预览期形态已是礼盒', snapshot.doc.presentation.kind === 'box');
  }
  check('礼盒 3D 模型已加入场景', (await sceneObject('gift-box'))?.inScene === true);
  check('礼盒模型可见', (await sceneObject('gift-box'))?.visible === true);
  check('换礼盒后花篮模型被移除', (await sceneObject('flower-basket')) === null);
  await page.screenshot({ path: `${OUT}/03-box-preview.png` });
  await page.getByTestId('confirm-presentation').click();
  await wait(600);
  {
    const snapshot = await state();
    check('采用礼盒', snapshot.doc.presentation.kind === 'box' && snapshot.presentationPreview === false);
    check(
      '礼盒支点收在盒口内',
      snapshot.doc.stems.every((stem) => Math.hypot(stem.position[0], stem.position[2]) <= 0.1323),
      snapshot.doc.stems.map((stem) => Number(Math.hypot(stem.position[0], stem.position[2]).toFixed(4))),
    );
    check(
      '礼盒外倾角不超过 26°',
      snapshot.doc.stems.every((stem) => stem.pose.tilt <= 26.0001),
      snapshot.doc.stems.map((stem) => Number(stem.pose.tilt.toFixed(2))),
    );
  }
  await wait(500);
  await page.screenshot({ path: `${OUT}/04-box.png` });

  // ---------- 4.5 抱抱桶 / 手提花袋 / 木条花箱（Lux3D GLB + 程序化兜底） ----------
  const vesselModels = {
    bucket: { model: 'vessel-model-bucket', maxTilt: 14, spread: 0.0575 },
    bag: { model: 'vessel-model-bag', maxTilt: 16, spread: 0.0805 },
    crate: { model: 'vessel-model-crate', maxTilt: 30, spread: 0.138 },
  };
  for (const [kind, spec] of Object.entries(vesselModels)) {
    await page.getByTestId(`presentation-${kind}`).click();
    await wait(300);
    check(`${kind} 切换先预览`, (await state()).presentationPreview === true);
    await page.getByTestId('confirm-presentation').click();
    await wait(500);
    {
      const snapshot = await state();
      check(`采用 ${kind}`, snapshot.doc.presentation.kind === kind);
      check(
        `${kind} 支点收在容器口内`,
        snapshot.doc.stems.every((stem) => Math.hypot(stem.position[0], stem.position[2]) <= spec.spread + 1e-6),
        snapshot.doc.stems.map((stem) => Number(Math.hypot(stem.position[0], stem.position[2]).toFixed(4))),
      );
      check(
        `${kind} 外倾角不超过 ${spec.maxTilt}°`,
        snapshot.doc.stems.every((stem) => stem.pose.tilt <= spec.maxTilt + 0.0001),
        snapshot.doc.stems.map((stem) => Number(stem.pose.tilt.toFixed(2))),
      );
    }
    const modelLoaded = await page
      .waitForFunction(
        (name) => {
          const scene = window.__bouquetDebug.scene.scene ?? window.__bouquetDebug.scene;
          const root = scene.getObjectByName(name);
          return Boolean(root && root.children.length > 0 && root.visible);
        },
        spec.model,
        { timeout: 25000 },
      )
      .then(() => true)
      .catch(() => false);
    check(`${kind} 加载 Lux3D GLB 模型`, modelLoaded, spec.model);
    await page.screenshot({ path: `${OUT}/05-${kind}.png` });
  }
  // Lux3D 花篮/礼盒也应该替换掉程序化外观
  await page.getByTestId('presentation-basket').click();
  await page.getByTestId('confirm-presentation').click();
  await wait(300);
  const basketModel = await page
    .waitForFunction(
      () => {
        const scene = window.__bouquetDebug.scene.scene ?? window.__bouquetDebug.scene;
        return Boolean(scene.getObjectByName('vessel-model-basket'));
      },
      null,
      { timeout: 25000 },
    )
    .then(() => true)
    .catch(() => false);
  check('花篮也使用 Lux3D GLB 外观', basketModel);

  // ---------- 5. 旧形态不回归 ----------
  await page.getByTestId('presentation-paper').click();
  await page.getByTestId('confirm-presentation').click();
  await wait(500);
  check('换回纸包仍是纸片包装', (await state()).doc.presentation.kind === 'paper');
  check('纸包时花篮礼盒都不在场景', (await sceneObject('flower-basket')) === null && (await sceneObject('gift-box')) === null);

  // 回到礼盒并刷新，验证存档恢复
  await page.getByTestId('presentation-box').click();
  await page.getByTestId('confirm-presentation').click();
  await wait(600);
  await page.reload();
  // V15 起有存档会先显示开屏选择；继续上次的花束再等清单。
  if (await page.getByTestId('start-continue').count()) await page.getByTestId('start-continue').click();
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalog.mode === 'manifest');
  await wait(1200);
  check('刷新后仍恢复花礼盒', (await state()).doc.presentation.kind === 'box', (await state()).doc.presentation.kind);
  check('刷新后礼盒 3D 模型重建', (await sceneObject('gift-box'))?.inScene === true);
  await page.getByTestId('stage-finish').click();
  await wait(1800);

  // ---------- 6. 拍照场景 ----------
  for (const scene of ['window', 'studio', 'gallery', 'florist', 'garden']) {
    check(`拍照场景入口 ${scene}`, await page.getByTestId(`photo-scene-${scene}`).isVisible());
  }
  const background = () =>
    exec(() => {
      const backgroundValue = window.__bouquetDebug.scene.scene.background;
      return backgroundValue?.isColor ? backgroundValue.getHexString() : null;
    });
  await page.getByTestId('photo-scene-florist').click();
  await wait(600);
  check('花店一角已选中', (await state()).doc.photo.scene === 'florist');
  check('花店一角布景可见', (await sceneObject('florist-set'))?.visible === true);
  check('庭院布景此时隐藏', (await sceneObject('garden-set'))?.visible === false);
  const floristBackground = await background();
  await page.screenshot({ path: `${OUT}/05-florist.png` });
  await page.getByTestId('photo-scene-garden').click();
  await wait(600);
  check('庭院午后已选中', (await state()).doc.photo.scene === 'garden');
  check('庭院午后布景可见', (await sceneObject('garden-set'))?.visible === true);
  check('花店布景此时隐藏', (await sceneObject('florist-set'))?.visible === false);
  const gardenBackground = await background();
  check('两个新场景背景色不同', floristBackground !== null && gardenBackground !== null && floristBackground !== gardenBackground, { floristBackground, gardenBackground });
  await page.screenshot({ path: `${OUT}/06-garden.png` });

  // 预览与导出在庭院场景下仍可用
  check('新场景有照片预览', Boolean(await page.getByTestId('photo-preview').getAttribute('src')));
  const exported = await exec(async () => {
    const result = await window.__bouquetDebug.scene.exportPng(1200);
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    return { width: result.width, height: result.height, png: [...bytes.slice(0, 4)].join(',') };
  });
  check('庭院场景导出 PNG', exported.width === 1600 && exported.png === '137,80,78,71', exported);

  // ---------- 7. 相册记录 label ----------
  await page.getByTestId('album-save').click();
  await wait(800);
  const albumLabel = await exec(() => {
    const snapshot = window.__bouquetDebug.getState();
    const photo = snapshot.album[0]?.photos[0];
    return photo ? { kind: photo.doc.presentation.kind, scene: photo.doc.photo.scene } : null;
  });
  check('照片记录形态与场景', albumLabel?.kind === 'box' && albumLabel?.scene === 'garden', albumLabel);
  await page.getByTestId('album-close').click().catch(() => {});
  await wait(400);

  check('无脚本错误', errors.length === 0, errors.slice(0, 3));
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ passed: count, checks, errors }, null, 2));
  console.log(`\nV10 呈现与场景：${count}/${count} 通过`);
} catch (error) {
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ passed: count, checks, error: String(error), errors }, null, 2));
  console.error('\n失败：', error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
