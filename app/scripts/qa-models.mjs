/**
 * 花材 QA / 静态缩略图落盘脚本（dev-only）。
 *
 * 依赖 dev server 提供 `app/qa/`（vite root 是 app/）：
 *   cd app; npm run dev -- --port 5190 --strictPort
 *   node scripts/qa-models.mjs --mode all --url http://127.0.0.1:5190/
 *
 * 模式：
 *   thumbs   为 manifest 的每一条配色渲染静态缩略图（160×190 透明 PNG）→ public/assets/thumbs/
 *   qa       每种花材 4 视角接触表 + 同花型配色变体对比 → .verify/lux3d-all/
 *   compare  raw vs processed 正视图并排（--pairs <json>）→ .verify/lux3d-all/
 *   all      thumbs + qa
 *
 * 渲染代码全部在 dev-only 页面 app/qa/qa.ts 里：缩略图直接 import 工作台自己的
 * `assetThumbnail`（同灯光/相机/尺寸/换色路径），4 视角与变体表复用同一套灯光和取景。
 * 本脚本只负责驱动浏览器、落盘与汇总证据 JSON（真机 chrome：channel:'chrome'）。
 */

import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const APP_DIR = process.cwd();
const MANIFEST_PATH = path.join(APP_DIR, 'public', 'assets', 'manifest.json');
const THUMBS_DIR = path.join(APP_DIR, 'public', 'assets', 'thumbs');
const VERIFY_DIR = path.join(APP_DIR, '.verify', 'lux3d-all');
const SUMMARY_PATH = path.join(VERIFY_DIR, 'summary.json');

function parseArgs(argv) {
  const args = { mode: 'all', url: 'http://127.0.0.1:5190/', pairs: null, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--mode') args.mode = argv[++i];
    else if (token === '--url') args.url = argv[++i];
    else if (token === '--pairs') args.pairs = argv[++i];
    else if (token === '--manifest') args.manifest = argv[++i];
    else if (token === '--families') args.families = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (token === '--force') args.force = true;
    else if (token === '--skip-existing') args.skipExisting = true;
    else throw new Error(`未知参数：${token}`);
  }
  if (!args.url.endsWith('/')) args.url += '/';
  return args;
}

const args = parseArgs(process.argv.slice(2));
// 默认读正式清单；QA 阶段可用 --manifest 指向 assets/local/processed/qa-manifest.json
const manifestPath = args.manifest ? path.resolve(APP_DIR, args.manifest) : path.join(APP_DIR, 'public', 'assets', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const allEntries = Array.isArray(manifest.assets) ? manifest.assets : [];
const entries = args.families
  ? allEntries.filter((entry) => args.families.includes(entry?.fallback?.procedural))
  : allEntries;
if (args.families) {
  // 只跑部分花型时把清单裁成这些条目，避免 QA 页渲染整批
  manifest.assets = entries;
}
const started = Date.now();
const report = {
  at: new Date().toISOString(),
  mode: args.mode,
  url: args.url,
  manifest: path.relative(APP_DIR, manifestPath).replaceAll('\\', '/'),
  assetsVersion: manifest.assetsVersion ?? null,
  familiesFilter: args.families ?? null,
  entries: entries.length,
  families: new Set(entries.map((e) => e?.fallback?.procedural ?? e?.id)).size,
  thumbs: { written: 0, skipped: 0, failed: [] },
  contactSheets: { written: 0, failed: [], rows: [] },
  variantSheets: { written: 0, failed: [], rows: [] },
  compare: { written: 0, failed: [], rows: [] },
  pageErrors: [],
};

function decodeDataUrl(dataUrl) {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl ?? '');
  if (!match) {
    // chrome 的 WebGL 上下文耗尽时 canvas 会返回 'data:,'（空内容）；调用方按失败记录。
    throw new Error(`不是 PNG dataURL（前缀 ${String(dataUrl ?? '').slice(0, 24)}…）`);
  }
  return Buffer.from(match[1], 'base64');
}

async function openPage(context) {
  const page = await context.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error?.message ?? error)));
  page.on('console', (message) => {
    if (message.type() === 'error') report.pageErrors.push(message.text());
  });
  await page.goto(`${args.url}qa/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__qa && window.__qa.ready), null, { timeout: 60000 });
  return page;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 渲染进程偶发 "Target crashed"（chrome 的 GPU 进程在连续建 WebGL 上下文时崩溃）。
 * 这里重建页面重试；所有落盘都是幂等覆盖，重跑整段安全。
 */
async function withPage(context, fn, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let page = null;
    try {
      page = await openPage(context);
      return await fn(page);
    } catch (error) {
      lastError = error;
      const message = String(error?.message ?? error);
      const retryable = /crash|closed|Target|context|超时/i.test(message);
      if (!retryable || attempt === attempts) throw error;
      console.warn(`[retry] 页面异常，重建重试 ${attempt}/${attempts - 1}：${message}`);
      await new Promise((resolve) => setTimeout(resolve, 900));
    } finally {
      if (page) {
        await Promise.race([page.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))]);
      }
    }
  }
  throw lastError;
}

async function runThumbs(context) {
  mkdirSync(THUMBS_DIR, { recursive: true });
  const ids = entries.map((entry) => entry?.id).filter((id) => typeof id === 'string');
  if (ids.length === 0) return;
  // assetThumbnail 每条配色新建一个 WebGLRenderer（工作台原逻辑），chrome 的上下文
  // 配额在连续调用时会耗尽、canvas 返回 'data:,'。每 6 条换一个页面（旧的随 page.close
  // 释放上下文），并对空 dataURL 记失败重试一次。
  const chunkSize = 6;
  for (let start = 0; start < ids.length; start += chunkSize) {
    let chunk = ids.slice(start, start + chunkSize);
    let pending = chunk;
    for (let attempt = 0; attempt < 2 && pending.length > 0; attempt += 1) {
      const rendered = await withPage(context, (page) =>
        page.evaluate(
          async ({ manifestJson, idList }) => window.__qa.renderAll(manifestJson, idList),
          { manifestJson: manifest, idList: pending },
        ),
      );
      const retry = [];
      for (const item of rendered) {
        let bytes = null;
        let error = item?.error;
        if (item?.dataUrl) {
          try {
            bytes = decodeDataUrl(item.dataUrl);
          } catch (decodeError) {
            error = String(decodeError?.message ?? decodeError);
          }
        }
        if (!bytes) {
          if (attempt === 0 && error && /dataURL/.test(error) && !args.force) {
            retry.push(item?.assetId);
            continue;
          }
          report.thumbs.failed.push({ assetId: item?.assetId ?? '?', error: error ?? '无 dataURL' });
          continue;
        }
        const file = path.join(THUMBS_DIR, `${item.assetId}.png`);
        if (args.skipExisting && !args.force && existsSync(file)) {
          report.thumbs.skipped += 1;
          continue;
        }
        writeFileSync(file, bytes);
        report.thumbs.written += 1;
      }
      pending = retry.filter((id) => typeof id === 'string');
      if (pending.length > 0) {
        console.warn(`[thumbs] ${pending.length} 条上下文耗尽，换页重试：${pending.join(', ')}`);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }
    console.log(`[thumbs] ${Math.min(start + chunkSize, ids.length)}/${ids.length}`);
  }
}

async function runSheets(context) {
  mkdirSync(VERIFY_DIR, { recursive: true });
  const families = [];
  for (const entry of entries) {
    const family = entry?.fallback?.procedural ?? entry?.id;
    if (typeof family === 'string' && !families.includes(family)) families.push(family);
  }
  // 分块渲染：一次性渲染 27 个花型时若某个 WebGL 上下文卡住，整段 promise 永不 resolve
  // （实测卡了 10 分钟）。每 4 个花型换一页 + 单块超时，失败只重跑这一块。
  const chunkSize = 4;
  for (let start = 0; start < families.length; start += chunkSize) {
    const chunk = families.slice(start, start + chunkSize);
    const { sheets, variants } = await withPage(context, (page) =>
      withTimeout(
        page.evaluate(
          async ({ manifestJson, familyList }) => ({
            sheets: await window.__qa.renderContactSheets(manifestJson, familyList),
            variants: await window.__qa.renderVariantSheets(manifestJson, familyList),
          }),
          { manifestJson: manifest, familyList: chunk },
        ),
        180000,
        `渲染 ${chunk.join('/')}`,
      ),
    );
    for (const sheet of sheets) {
      if (!sheet?.dataUrl) {
        report.contactSheets.failed.push({ family: sheet?.family ?? '?', error: sheet?.error ?? '无 dataURL' });
        continue;
      }
      writeFileSync(path.join(VERIFY_DIR, `${sheet.family}.png`), decodeDataUrl(sheet.dataUrl));
      report.contactSheets.written += 1;
      report.contactSheets.rows.push({
        family: sheet.family,
        file: `.verify/lux3d-all/${sheet.family}.png`,
        ...(sheet.meta ?? {}),
      });
    }
    for (const sheet of variants) {
      if (!sheet?.dataUrl) {
        report.variantSheets.failed.push({ family: sheet?.family ?? '?', error: sheet?.error ?? '无 dataURL' });
        continue;
      }
      writeFileSync(path.join(VERIFY_DIR, `${sheet.family}-variants.png`), decodeDataUrl(sheet.dataUrl));
      report.variantSheets.written += 1;
      report.variantSheets.rows.push({
        family: sheet.family,
        file: `.verify/lux3d-all/${sheet.family}-variants.png`,
      });
    }
    console.log(`[qa] 花型 ${Math.min(start + chunkSize, families.length)}/${families.length}`
      + `（4视角累计 ${report.contactSheets.written}，变体累计 ${report.variantSheets.written}）`);
  }
}

async function runCompare(context) {
  if (!args.pairs) throw new Error('--mode compare 需要 --pairs <json>');
  mkdirSync(VERIFY_DIR, { recursive: true });
  const pairs = JSON.parse(readFileSync(path.resolve(APP_DIR, args.pairs), 'utf8'));
  const rendered = await withPage(context, (page) =>
    page.evaluate(async (payload) => window.__qa.renderComparePairs(payload), pairs),
  );
  for (const sheet of rendered) {
    if (!sheet?.dataUrl) {
      report.compare.failed.push({ family: sheet?.family ?? '?', error: sheet?.error ?? '无 dataURL' });
      continue;
    }
    const file = `compression-${sheet.family}.png`;
    writeFileSync(path.join(VERIFY_DIR, file), decodeDataUrl(sheet.dataUrl));
    report.compare.written += 1;
    report.compare.rows.push({ family: sheet.family, file: `.verify/lux3d-all/${file}`, ok: sheet.ok === true });
  }
  console.log(`[compare] ${report.compare.written}/${rendered.length}`);
}

async function runAppCheck(context) {
  const page = await context.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error?.message ?? error)));
  page.on('console', (message) => {
    if (message.type() === 'error') report.pageErrors.push(message.text());
  });
  await page.goto(args.url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(
    () => Boolean(window.__bouquetDebug?.getState().catalog?.entries?.length),
    null,
    { timeout: 120000 },
  );
  await page.waitForTimeout(600);
  const state = await page.evaluate(() => {
    const catalog = window.__bouquetDebug.getState().catalog;
    const entries = catalog.entries.map((entry) => ({
      assetId: entry.assetId,
      glb: entry.glb ?? null,
      thumb: entry.thumb ?? null,
      kind: entry.kind,
      family: entry.family,
      recolor: entry.recolor ?? null,
      uniformScale: entry.size?.uniformScale ?? null,
      headRadius: entry.size?.headRadius ?? null,
      headWidth: entry.size?.headWidth ?? null,
      heads: entry.size?.heads ?? null,
    }));
    return {
      mode: catalog.mode,
      assetsVersion: catalog.assetsVersion,
      notice: catalog.notice ?? null,
      entries,
      familyCount: catalog.families.length,
    };
  });
  const expectedIds = manifest.assets.map((entry) => entry.id);
  const gotIds = state.entries.map((entry) => entry.assetId);
  const missing = expectedIds.filter((id) => !gotIds.includes(id));
  const extra = gotIds.filter((id) => !expectedIds.includes(id));
  const byKind = state.entries.reduce((acc, entry) => {
    acc[entry.kind] = (acc[entry.kind] ?? 0) + 1;
    return acc;
  }, {});
  const noGlb = state.entries.filter((entry) => !entry.glb);
  // 运行时目录会套用尺寸候选 b（例如 uniformScale 0.88、玫瑰/郁金香 headWidth 0.64），
  // 所以这里不比对 1，只校验「真实模型条目不该继承程序化多头登记、尺寸数值必须可解析」。
  const manifestById = Object.fromEntries(manifest.assets.map((entry) => [entry.id, entry]));
  const noHeads = state.entries.filter((entry) => entry.heads != null);
  const badSize = state.entries.filter((entry) => {
    const rawSize = manifestById[entry.assetId]?.size;
    if (!entry.glb || !rawSize) return false;
    const numbers = [entry.uniformScale, entry.headWidth, entry.headRadius];
    return numbers.some((value) => typeof value !== 'number' || !Number.isFinite(value));
  });
  const thumbUrls = state.entries
    .filter((entry) => entry.thumb)
    .map((entry) => ({ assetId: entry.assetId, url: new URL(`assets/${entry.thumb}`, args.url).href }));
  const glbUrls = [...new Set(state.entries.filter((entry) => entry.glb).map((entry) => entry.glb))]
    .map((glb) => ({ glb, url: new URL(`assets/${glb}`, args.url).href }));
  const fetchStatus = await page.evaluate(async ({ thumbs, glbs }) => {
    const badThumbs = [];
    const badGlbs = [];
    for (const item of thumbs) {
      try {
        const response = await fetch(item.url, { method: 'GET', cache: 'no-cache' });
        if (!response.ok) badThumbs.push({ assetId: item.assetId, status: response.status });
        else await response.arrayBuffer();
      } catch (error) {
        badThumbs.push({ assetId: item.assetId, error: String(error) });
      }
    }
    for (const item of glbs) {
      try {
        const response = await fetch(item.url, { method: 'HEAD', cache: 'no-cache' });
        if (!response.ok) badGlbs.push({ glb: item.glb, status: response.status });
      } catch (error) {
        badGlbs.push({ glb: item.glb, error: String(error) });
      }
    }
    return { badThumbs, badGlbs };
  }, { thumbs: thumbUrls, glbs: glbUrls });

  report.appCheck = {
    url: args.url,
    mode: state.mode,
    assetsVersion: state.assetsVersion,
    notice: state.notice,
    entries: state.entries.length,
    expectedEntries: expectedIds.length,
    familyCount: state.familyCount,
    byKind,
    idsMatch: missing.length === 0 && extra.length === 0,
    missing,
    extra,
    noGlbCount: noGlb.length,
    noHeadsCount: noHeads.length,
    badSizeCount: badSize.length,
    badSize: badSize.slice(0, 10),
    thumbsChecked: thumbUrls.length,
    glbsChecked: glbUrls.length,
    badThumbs: fetchStatus.badThumbs,
    badGlbs: fetchStatus.badGlbs,
    ok:
      state.mode === 'manifest'
      && missing.length === 0
      && extra.length === 0
      && noGlb.length === 0
      && noHeads.length === 0
      && badSize.length === 0
      && fetchStatus.badThumbs.length === 0
      && fetchStatus.badGlbs.length === 0,
  };
  console.log(JSON.stringify({
    mode: state.mode,
    assetsVersion: state.assetsVersion,
    notice: state.notice,
    entries: state.entries.length,
    byKind,
    idsMatch: report.appCheck.idsMatch,
    noGlb: noGlb.length,
    noHeads: noHeads.length,
    badSize: badSize.length,
    thumbsChecked: thumbUrls.length,
    badThumbs: fetchStatus.badThumbs.length,
    glbsChecked: glbUrls.length,
    badGlbs: fetchStatus.badGlbs.length,
    ok: report.appCheck.ok,
  }, null, 2));
  if (!report.appCheck.ok) process.exitCode = 1;
  await page.close();
}

const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
try {
  if (args.mode === 'thumbs' || args.mode === 'all') await runThumbs(context);
  if (args.mode === 'qa' || args.mode === 'all') await runSheets(context);
  if (args.mode === 'compare') await runCompare(context);
  if (args.mode === 'app-check') await runAppCheck(context);
} finally {
  await context.close();
  await browser.close();
}

report.durationSeconds = Math.round((Date.now() - started) / 1000);
report.totals = {
  thumbsWritten: report.thumbs.written,
  thumbsFailed: report.thumbs.failed.length,
  contactSheets: report.contactSheets.written,
  variantSheets: report.variantSheets.written,
  compareSheets: report.compare.written,
  pageErrors: report.pageErrors.length,
};
mkdirSync(VERIFY_DIR, { recursive: true });
writeFileSync(SUMMARY_PATH, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report.totals, null, 2));
console.log(`[qa-models] 证据 ${path.relative(APP_DIR, SUMMARY_PATH).replaceAll('\\', '/')}（${report.durationSeconds}s）`);

const failed = report.thumbs.failed.length + report.contactSheets.failed.length
  + report.variantSheets.failed.length + report.compare.failed.length;
if (failed > 0) {
  console.error('[qa-models] 有失败项，见 summary.json');
  process.exitCode = 1;
}
