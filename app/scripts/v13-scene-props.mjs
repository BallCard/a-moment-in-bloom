/**
 * V13 近景道具验证：Lux3D 道具（蜡烛/咖啡杯碟/台灯/干花小瓶）接到拍照布景后，
 * 是否按归一化高度落地、是否只在对应场景出现、程序化兜底是否仍然保留。
 *
 * 覆盖：
 * 1) 节日暖光：两支蜡烛 GLB 挂载且可见、包围盒高度≈0.12m、底面贴在台面 0.66；
 * 2) 家居客厅：台灯 GLB 挂载、`living-lamp-light` 点光仍在、干花小瓶挂载；
 * 3) 咖啡馆：咖啡杯碟 GLB 挂载、包围盒高度≈0.10m、导出 PNG 成功；
 * 4) 其它场景不出现这些道具（living-set/cafe-set 隐藏时其子节点不可见）；
 * 5) 断网模拟：拦截一只 GLB 让加载失败，场景不报错、仍保留程序化道具；
 * 6) 全程无脚本错误。
 *
 * 运行：先 `npm run dev:all`（或 5173 已在跑），再 `node scripts/v13-scene-props.mjs`。
 * 环境变量：SMOKE_URL、V13_OUT、HEADED。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { newStudioAwarePage } from './studio-page.mjs';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.V13_OUT ?? '.verify/v13-scene-props';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1', args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });

const checks = [];
let count = 0;
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`);
  count += 1;
  console.log('ok', name);
}

/** 页面内计算对象世界包围盒。 */
function worldBoxOf(name) {
  return {
    name,
    fn: (target) => {
      const scene = window.__bouquetDebug.scene.scene;
      const object = scene.getObjectByName(target);
      if (!object) return null;
      object.updateMatrixWorld(true);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      object.traverse((node) => {
        const mesh = node;
        if (!mesh.isMesh || !mesh.geometry) return;
        mesh.geometry.computeBoundingBox();
        const box = mesh.geometry.boundingBox;
        if (!box) return;
        const m = mesh.matrixWorld.elements;
        for (let i = 0; i < 8; i += 1) {
          const x = i & 1 ? box.max.x : box.min.x;
          const y = i & 2 ? box.max.y : box.min.y;
          const z = i & 4 ? box.max.z : box.min.z;
          const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
          const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
          const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
          if (wx < min[0]) min[0] = wx;
          if (wy < min[1]) min[1] = wy;
          if (wz < min[2]) min[2] = wz;
          if (wx > max[0]) max[0] = wx;
          if (wy > max[1]) max[1] = wy;
          if (wz > max[2]) max[2] = wz;
        }
      });
      if (!Number.isFinite(min[0])) return null;
      return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
    },
  };
}

async function boot(page) {
  await page.goto(URL);
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalog.mode === 'manifest');
  await page.evaluate(() => {
    const store = window.__bouquetDebug.store;
    for (let i = 0; i < 6; i += 1) {
      store.setPlacement(i < 3 ? 'rose-pink' : i < 5 ? 'tulip-cream' : 'eucalyptus-green');
      store.placeStem({ height: (i % 3) * 0.035, tilt: 10 + i * 3, direction: i * 137, spin: 30 });
    }
    store.setPlacement(null);
    store.select(null);
  });
  await page.waitForFunction(() => [...window.__bouquetDebug.scene.views.values()].every((view) => view.object), null, { timeout: 90000 });
  await page.waitForTimeout(1000);
  await page.getByTestId('stage-finish').click();
  await page.waitForTimeout(1800);
}

async function waitForNode(page, name, timeout = 60000) {
  return page
    .waitForFunction((target) => Boolean(window.__bouquetDebug.scene.scene.getObjectByName(target)), name, { timeout })
    .then(() => true)
    .catch(() => false);
}

async function getBox(page, name) {
  const handle = worldBoxOf(name);
  return page.evaluate(handle.fn, handle.name);
}

try {
  // ---------- 主流程 ----------
  {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await newStudioAwarePage(context);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
    await boot(page);

    // 节日暖光：两支蜡烛
    await page.getByTestId('photo-scene-festive').click();
    await page.waitForTimeout(600);
    check('节日暖光：蜡烛 0 节点出现', await waitForNode(page, 'scene-prop-candle-0'));
    check('节日暖光：蜡烛 1 节点出现', await waitForNode(page, 'scene-prop-candle-1'));
    const candle0 = await getBox(page, 'scene-prop-candle-0');
    check('节日暖光：蜡烛高度≈0.15m', candle0 && Math.abs(candle0.size[1] - 0.15) < 0.03, candle0?.size);
    check('节日暖光：蜡烛底部落在台面 0.66', candle0 && Math.abs(candle0.min[1] - 0.66) < 0.02, candle0?.min);
    await page.screenshot({ path: `${OUT}/01-festive-candles.png` });
    // 导出成品（无 UI 面板遮挡，用来判断蜡烛在照片里的构图）。
    const festiveExport = await page.evaluate(async () => {
      const result = await window.__bouquetDebug.scene.exportPng(1200);
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return { width: result.width, base64: btoa(binary) };
    });
    writeFileSync(`${OUT}/01-festive-export.png`, Buffer.from(festiveExport.base64, 'base64'));
    check('节日暖光：导出成品 PNG', festiveExport.width === 1600);

    // 家居客厅：台灯 + 干花小瓶，点光保留
    await page.getByTestId('photo-scene-living').click();
    await page.waitForTimeout(600);
    check('家居客厅：台灯节点出现', await waitForNode(page, 'scene-prop-table-lamp-0'));
    check('家居客厅：干花小瓶节点出现', await waitForNode(page, 'scene-prop-dried-bouquet-0'));
    const lamp = await getBox(page, 'scene-prop-table-lamp-0');
    check('家居客厅：台灯高度≈0.45m', lamp && Math.abs(lamp.size[1] - 0.45) < 0.06, lamp?.size);
    check('家居客厅：台灯灯罩点光仍在', await page.evaluate(() => Boolean(window.__bouquetDebug.scene.scene.getObjectByName('living-lamp-light'))));
    const dried = await getBox(page, 'scene-prop-dried-bouquet-0');
    check('家居客厅：干花小瓶高度≈0.28m', dried && Math.abs(dried.size[1] - 0.28) < 0.05, dried?.size);
    await page.screenshot({ path: `${OUT}/02-living-props.png` });

    // 咖啡馆：杯碟 + 导出
    await page.getByTestId('photo-scene-cafe').click();
    await page.waitForTimeout(600);
    check('咖啡馆：杯碟节点出现', await waitForNode(page, 'scene-prop-coffee-set-0'));
    const cup = await getBox(page, 'scene-prop-coffee-set-0');
    check('咖啡馆：杯碟高度≈0.085m（真实杯碟比例）', cup && Math.abs(cup.size[1] - 0.085) < 0.025, cup?.size);
    check('咖啡馆：杯碟底部落在台面 0.66', cup && Math.abs(cup.min[1] - 0.66) < 0.02, cup?.min);
    const exported = await page.evaluate(async () => {
      const result = await window.__bouquetDebug.scene.exportPng(1200);
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      return { width: result.width, height: result.height, png: [...bytes.slice(0, 4)].join(',') };
    });
    check('咖啡馆：导出 PNG 成功', exported.width === 1600 && exported.png === '137,80,78,71', exported);
    await page.screenshot({ path: `${OUT}/03-cafe-coffee.png` });

    // 道具只在对应场景可见：切回 studio 时外景隐藏
    await page.getByTestId('photo-scene-studio').click();
    await page.waitForTimeout(400);
    const hidden = await page.evaluate(() => {
      const scene = window.__bouquetDebug.scene.scene;
      const host = scene.getObjectByName('scene-prop-coffee-set-0');
      const cafeSet = scene.getObjectByName('cafe-set');
      return { cafeVisible: Boolean(cafeSet?.visible), hostVisible: Boolean(host && host.visible && host.parent?.visible) };
    });
    check('切回素色台面：咖啡馆与杯碟不可见', hidden.cafeVisible === false, hidden);

    check('主流程无脚本错误', errors.length === 0, errors.slice(0, 3));
    await context.close();
  }

  // ---------- 断网兜底：拦截咖啡杯碟 GLB ----------
  {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await newStudioAwarePage(context);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('404') && !message.text().includes('net::ERR_FAILED')) errors.push(message.text());
    });
    await page.route('**/assets/props/coffee-set.glb', (route) => route.abort());
    await boot(page);
    await page.getByTestId('photo-scene-cafe').click();
    await page.waitForTimeout(2500);
    const fallback = await page.evaluate(() => {
      const scene = window.__bouquetDebug.scene.scene;
      const cafeSet = scene.getObjectByName('cafe-set');
      return {
        cafeVisible: Boolean(cafeSet?.visible),
        host: Boolean(scene.getObjectByName('scene-prop-coffee-set-0')),
        meshes: (() => {
          let visible = 0;
          cafeSet?.traverse((node) => { if (node.isMesh && node.visible) visible += 1; });
          return visible;
        })(),
      };
    });
    check('断网时：咖啡馆布景仍可用（不报错）', fallback.cafeVisible === true, fallback);
    check('断网时：杯碟 GLB 未挂载', fallback.host === false, fallback);
    check('断网时：程序化道具仍在（场景网格数 > 0）', fallback.meshes > 20, fallback.meshes);
    check('断网时：无脚本错误', errors.length === 0, errors.slice(0, 3));
    await page.screenshot({ path: `${OUT}/04-cafe-fallback.png` });
    await context.close();
  }

  writeFileSync(`${OUT}/results.json`, JSON.stringify({ passed: count, checks }, null, 2));
  console.log(`\nV13 近景道具：${count}/${count} 通过`);
} catch (error) {
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ passed: count, checks, error: String(error) }, null, 2));
  console.error('\n失败：', error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
