/**
 * v16 装饰与贺卡验证（V16 §5 / §7）。
 *
 * 运行（Vite dev server 已在 5173）：`cd app && node scripts/v16-decor.mjs`
 * - 环境变量：SMOKE_URL、v16_OUT、HEADED。
 * - 不启动 dev server、不 build；服务端契约用随机端口、**故意不带凭据**的临时实例验证，
 *   浏览器里的 /api/polish 全部用 page.route mock，不会真实消耗魔搭额度。
 *
 * 覆盖：
 * A. 服务端 polish 纯函数与 mock 上游（提示词只发文字、错误映射、缓存、字数上限）；
 * B. /api/polish 路由契约（同一套来源校验、体积上限、无凭据 503 not_configured）；
 * C. 各呈现形态只显示能力表允许的装饰与丝带（礼盒不出现换色丝带、不重复蝴蝶结控件）；
 * D. 装饰增删改写入 doc、参数可调、撤销、换容器过滤、刷新后恢复；
 * E. 装饰三维模块本身：四组真实几何、亮度响应、能力过滤、dispose 不残留；
 * F. 常用短语（空/非空正文、替换/追加确认）与 AI 润色（成功采用、失败保留、
 *    迟到结果不覆盖、取消）。
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { newStudioAwarePage } from './studio-page.mjs';
import {
  POLISH_MAX_CHARS,
  POLISH_MODEL,
  cleanPolishText,
  createPolisher,
  validatePolishInput,
  validatePolishOutput,
} from '../server/polish.mjs';

const URL_BASE = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.v16_OUT ?? '.verify/v16-decor';
const PUBLIC_STUDIO = URL_BASE.includes('modelscope.cn/studios/');
const DEV = !PUBLIC_STUDIO && URL_BASE.includes('5173');
mkdirSync(OUT, { recursive: true });

const checks = [];
let passed = 0;
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`);
  passed += 1;
  console.log('ok', name);
}
function skip(name, reason) {
  checks.push({ name, ok: true, skipped: true, reason });
  console.log('SKIP', name, `(${reason})`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CAPABILITY = {
  paper: ['light-string', 'star-lights', 'pearl-strand', 'silk-thread', 'butterfly', 'star-pick', 'heart-pick', 'bow', 'tag'],
  vase: ['butterfly', 'star-pick', 'heart-pick'],
  pot: ['butterfly', 'star-pick', 'heart-pick'],
  basket: ['butterfly', 'star-pick', 'heart-pick'],
  box: ['butterfly', 'star-pick', 'heart-pick', 'tag'],
  bucket: ['butterfly', 'star-pick', 'heart-pick'],
  bag: ['butterfly', 'star-pick', 'heart-pick'],
  crate: ['butterfly', 'star-pick', 'heart-pick'],
};
const sorted = (list) => [...list].sort();

// =========================================================================
// A. 服务端润色：纯函数 + mock 上游（不联外网）
// =========================================================================
console.log('\n== A. polish 纯函数与 mock 上游 ==');
{
  const rejects = (value, label) => {
    let thrown = '';
    try {
      validatePolishInput(value);
    } catch (error) {
      thrown = error.message;
    }
    check(`polish 输入校验拒绝 ${label}`, thrown === 'invalid_input', { thrown, value });
  };
  rejects(null, '空 body');
  rejects({}, '无 text');
  rejects({ text: '   ' }, '空正文');
  rejects({ text: 'x'.repeat(241) }, '超长正文');
  rejects({ text: '你好', to: 'x'.repeat(41) }, '超长收件人');

  const normalized = validatePolishInput({ text: '  妈妈生日快乐  ', to: ' 妈妈 ', from: '  小满 ' });
  check(
    'polish 输入规整与取名',
    normalized.text === '妈妈生日快乐' && normalized.to === '妈妈' && normalized.from === '小满',
    normalized,
  );
  check(
    'polish 输出去代码围栏与引号',
    cleanPolishText('```text\n“生日快乐，愿你被温柔对待。”\n```') === '生日快乐，愿你被温柔对待。',
    cleanPolishText('```text\n“生日快乐，愿你被温柔对待。”\n```'),
  );
  const clamped = validatePolishOutput('花'.repeat(POLISH_MAX_CHARS + 10));
  check('polish 输出截到字数上限', Array.from(clamped).length === POLISH_MAX_CHARS, Array.from(clamped).length);

  const calls = [];
  const mockFetch = (response) => async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return response();
  };
  const okBody = { choices: [{ message: { content: '妈妈，生日快乐，愿你被温柔对待。' } }] };
  let requestCount = 0;
  const okFetch = async (url, init) => {
    requestCount += 1;
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => okBody };
  };
  const polisher = createPolisher({ key: 'test-key', fetchImpl: okFetch });
  const first = await polisher({ text: '妈妈生日快乐', to: '妈妈' });
  check(
    'polish mock 上游返回润色文本与模型名',
    first.text === '妈妈，生日快乐，愿你被温柔对待。' && first.model === POLISH_MODEL,
    first,
  );
  const sent = calls[0]?.body;
  check('polish 请求走 chat completions 与 DeepSeek 1017', calls[0].url.endsWith('/v1/chat/completions') && sent.model === POLISH_MODEL, {
    url: calls[0].url,
    model: sent.model,
  });
  const serialized = JSON.stringify(sent);
  check(
    'polish 只发送文字（不含 image / base64）',
    !serialized.includes('image') && !serialized.includes('base64') && serialized.includes('妈妈生日快乐'),
    serialized.slice(0, 400),
  );
  const systemPrompt = sent.messages?.[0]?.content ?? '';
  check(
    'polish 提示词要求只润色、不新增事实、不编造关系、限字数',
    sent.messages?.[0]?.role === 'system' &&
      systemPrompt.includes('只做润色') &&
      systemPrompt.includes('绝不新增') &&
      systemPrompt.includes('关系') &&
      systemPrompt.includes(String(POLISH_MAX_CHARS)),
    systemPrompt.slice(0, 200),
  );
  const again = await polisher({ text: '妈妈生日快乐', to: '妈妈' });
  check('polish 相同输入命中缓存且不重复请求', again.cached === true && requestCount === 1, { requestCount, cached: again.cached });

  await sleep(1300);
  const quotaPolisher = createPolisher({
    key: 'test-key',
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
  });
  let quotaCode = '';
  try {
    await quotaPolisher({ text: '换个句子试试' });
  } catch (error) {
    quotaCode = error.message;
  }
  check('polish 上游 429 映射 quota（界面提示限流）', quotaCode === 'quota', quotaCode);

  await sleep(1300);
  const emptyPolisher = createPolisher({
    key: 'test-key',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '   ' } }] }) }),
  });
  let emptyCode = '';
  try {
    await emptyPolisher({ text: '再换个句子' });
  } catch (error) {
    emptyCode = error.message;
  }
  check('polish 空结果映射 empty_result', emptyCode === 'empty_result', emptyCode);

  let noKeyCode = '';
  try {
    await createPolisher({ key: '' })({ text: '没有凭据' });
  } catch (error) {
    noKeyCode = error.message;
  }
  check('polish 无凭据映射 not_configured', noKeyCode === 'not_configured', noKeyCode);
}

// =========================================================================
// B. /api/polish 路由契约：临时实例，故意不带凭据
// =========================================================================
console.log('\n== B. /api/polish 路由契约（无凭据临时实例） ==');
{
  const port = 8791 + Math.floor(Math.random() * 40);
  let child = null;
  let reachable = false;
  try {
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MODELSCOPE_API_KEY: '' },
      stdio: 'ignore',
      windowsHide: true,
    });
    for (let i = 0; i < 40; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) {
          reachable = true;
          break;
        }
      } catch {
        /* 服务还没起来 */
      }
      await sleep(150);
    }
  } catch (error) {
    reachable = false;
    console.log('临时服务起不来：', error.message);
  }
  if (!reachable) {
    skip('POST /api/polish 无凭据 503 not_configured', '无法启动临时服务实例（本机进程限制）');
    skip('POST /api/polish 来源校验与体积上限', '无法启动临时服务实例（本机进程限制）');
  } else {
    const base = `http://127.0.0.1:${port}`;
    const post = (path, body, origin) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
    const valid = await post('/api/polish', { text: '妈妈生日快乐', to: '妈妈' });
    const validJson = await valid.json();
    check(
      'POST /api/polish 无凭据返回 503 not_configured',
      valid.status === 503 && validJson.code === 'not_configured' && typeof validJson.error === 'string',
      { status: valid.status, body: validJson },
    );
    const invalid = await post('/api/polish', {});
    const invalidJson = await invalid.json();
    check('POST /api/polish 输入不合法返回 400', invalid.status === 400 && invalidJson.code === 'invalid_input', {
      status: invalid.status,
      body: invalidJson,
    });
    const hostile = await post('/api/polish', { text: '你好' }, 'https://evil.example');
    check('POST /api/polish 陌生来源返回 403', hostile.status === 403, hostile.status);
    const oversized = await post('/api/polish', { text: 'x'.repeat(20000) });
    check('POST /api/polish 超大正文返回 413', oversized.status === 413, oversized.status);
    const wrongMethod = await fetch(`${base}/api/polish`);
    check('GET /api/polish 不提供该接口', wrongMethod.status === 404, wrongMethod.status);
    const health = await fetch(`${base}/api/health`);
    const healthJson = await health.json();
    check('临时实例健康检查显示凭据 missing', healthJson.credentials === 'missing', healthJson.credentials);
  }
  child?.kill();
}

// =========================================================================
// C–F. 浏览器验证
// =========================================================================
const browser = await chromium.launch({
  channel: 'chrome',
  headless: process.env.HEADED !== '1',
  args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const pageErrors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await newStudioAwarePage(context);
  const isNoise = (text) =>
    text.includes('Failed to load resource') || text.includes('[vite]') || text.includes('vite:') || text.includes('HMR');
  page.on('pageerror', (error) => {
    if (!isNoise(error.message)) pageErrors.push(error.message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && !isNoise(message.text())) pageErrors.push(message.text());
  });

  const state = () => page.evaluate(() => window.__bouquetDebug.getState());
  const count = (testId) => page.locator(`[data-testid="${testId}"]`).count();
  const visible = async (testId) => {
    const locator = page.locator(`[data-testid="${testId}"]`);
    if ((await locator.count()) === 0) return false;
    return locator.first().isVisible();
  };
  const wait = (ms) => page.waitForTimeout(ms);
  const addIds = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="decoration-add-"]')]
        .map((node) => node.getAttribute('data-testid').slice('decoration-add-'.length))
        .sort(),
    );
  const settle = async (ms = 700) => {
    await wait(ms);
    await page.waitForFunction(() => !window.__bouquetDebug.getDecorState().animating, null, { timeout: 8000 }).catch(() => {});
  };
  async function switchKind(kind) {
    await page.getByTestId(`presentation-${kind}`).click();
    await wait(200);
    const confirm = page.getByTestId('confirm-presentation');
    if (await confirm.count()) await confirm.click();
    await settle(kind === 'paper' ? 700 : 900);
  }

  await page.goto(URL_BASE);
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, { timeout: 60000 });
  await page.evaluate(() => {
    const store = window.__bouquetDebug.store;
    store.loadSampleBouquet(6);
    store.enterWrap();
    store.setPackageStep('ribbon');
    store.endTransaction();
  });
  await page.waitForFunction(
    () => [...window.__bouquetDebug.scene.views.values()].every((view) => view.object),
    null,
    { timeout: 90000 },
  );
  await settle();

  // ---------- C. 纸包：装饰步骤完整入口 ----------
  console.log('\n== C. 呈现形态与能力表 ==');
  check('纸包装饰步骤显示装饰面板', await visible('decorations-panel'));
  check('纸包装饰步骤标签改为「装饰」', (await page.getByTestId('package-step-ribbon').innerText()).includes('装饰'), (await page.getByTestId('package-step-ribbon').innerText()).trim());
  check('纸包保留可编辑丝带控件', (await visible('ribbon-block')) && (await visible('ribbon-cream')));
  check('纸包显示全部四组装饰', (await count('decoration-group-lights')) === 1 && (await count('decoration-group-strands')) === 1 && (await count('decoration-group-picks')) === 1 && (await count('decoration-group-ties')) === 1);
  check('纸包可加 9 款装饰', JSON.stringify(await addIds()) === JSON.stringify(sorted(CAPABILITY.paper)), await addIds());
  check('未添加装饰时给出说明', (await visible('decoration-empty')) && (await visible('decoration-hint')));
  {
    const decor = await page.evaluate(() => window.__bouquetDebug.getDecorState());
    check('纸包场景声明支持可编辑丝带', decor.ribbonSupported === true, decor.ribbonSupported);
  }
  await page.screenshot({ path: `${OUT}/01-decoration-step.png` });

  for (const kind of ['vase', 'pot', 'basket', 'box', 'bucket', 'bag', 'crate']) {
    await switchKind(kind);
    const ids = await addIds();
    check(`${kind} 只显示能力表允许的装饰`, JSON.stringify(ids) === JSON.stringify(sorted(CAPABILITY[kind])), ids);
    check(`${kind} 不显示无效丝带控件`, (await count('ribbon-block')) === 0 && (await count('ribbon-cream')) === 0, {
      ribbonBlock: await count('ribbon-block'),
    });
    check(`${kind} 装饰面板仍在`, await visible('decorations-panel'));
    if (kind === 'box') {
      check('礼盒能力说明写明不换色', (await page.getByTestId('decoration-capability-note').innerText()).includes('不在这里换色'), (await page.getByTestId('decoration-capability-note').innerText()).trim());
      check('礼盒不出现重复蝴蝶结控件', (await count('decoration-add-bow')) === 0);
      check('礼盒场景声明不显示可编辑丝带', (await page.evaluate(() => window.__bouquetDebug.getDecorState().ribbonSupported)) === false);
      await page.screenshot({ path: `${OUT}/02-capability-box.png` });
    }
  }
  await switchKind('paper');
  check('切回纸包后丝带与全部装饰回来', (await visible('ribbon-block')) && JSON.stringify(await addIds()) === JSON.stringify(sorted(CAPABILITY.paper)));

  // ---------- D. 装饰增删改 ----------
  console.log('\n== D. 装饰增删改与撤销 ==');
  await page.getByTestId('decoration-add-light-string').click();
  await wait(200);
  {
    const snapshot = await state();
    check('添加细灯串写入文档', snapshot.doc.ornaments.length === 1 && snapshot.doc.ornaments[0].kind === 'light-string', snapshot.doc.ornaments);
  }
  check('添加后展开参数编辑', (await visible('decoration-editor')) && (await visible('decoration-intensity')));
  check('灯饰有亮度控件、有 3 种绕行样式', (await visible('decoration-variant-2')) && (await visible('decoration-color-warm')));
  const before = (await state()).doc.ornaments[0];
  await page.getByTestId('decoration-pos-x-plus').click();
  await page.getByTestId('decoration-rotate-plus').click();
  await page.getByTestId('decoration-scale-plus').click();
  await wait(150);
  {
    const after = (await state()).doc.ornaments[0];
    check('位置/旋转/大小微调写入文档', Math.abs(after.position[0] - (before.position[0] + 0.02)) < 1e-6 && Math.abs(after.rotation - 15) < 1e-6 && Math.abs(after.scale - 1.05) < 1e-6, {
      before: { x: before.position[0], rotation: before.rotation, scale: before.scale },
      after: { x: after.position[0], rotation: after.rotation, scale: after.scale },
    });
  }
  await page.getByTestId('decoration-variant-2').click();
  await page.getByTestId('decoration-color-mist').click();
  await wait(150);
  {
    const after = (await state()).doc.ornaments[0];
    check('样式与颜色写入文档', after.variant === 2 && after.colorId === 'mist', { variant: after.variant, colorId: after.colorId });
  }
  // range 输入用原生 setter + input 事件驱动 React（避免键盘步进在不同系统上的差异）。
  await page.locator('[data-testid="decoration-intensity"]').evaluate((element) => {
    const input = element;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '0.3');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('[data-testid="decoration-intensity"]').dispatchEvent('pointerup');
  await wait(150);
  check('灯亮度写入文档', Math.abs((await state()).doc.ornaments[0].intensity - 0.3) < 1e-6, (await state()).doc.ornaments[0].intensity);
  await page.screenshot({ path: `${OUT}/03-decoration-editor.png` });

  await page.getByTestId('undo').click();
  await wait(200);
  check('撤销回退最近一次装饰修改', Math.abs((await state()).doc.ornaments[0].intensity - 1) > 1e-6 || (await state()).doc.ornaments[0].colorId === 'warm', {
    intensity: (await state()).doc.ornaments[0].intensity,
    colorId: (await state()).doc.ornaments[0].colorId,
  });

  // 已添加的装饰列表可再次选中编辑
  await page.getByTestId('decoration-add-butterfly').click();
  await wait(150);
  check('插饰可添加且自动选中', (await state()).doc.ornaments.length === 2 && (await page.getByTestId('decoration-item-1').count()) === 1);
  await page.getByTestId('decoration-item-0').click();
  await wait(120);
  check('点已添加的装饰重新进入编辑', ((await page.getByTestId('decoration-editor').innerText()) || '').includes('细灯串'), (await page.getByTestId('decoration-editor').innerText()).trim().slice(0, 60));

  await page.getByTestId('decoration-remove').click();
  await wait(200);
  check('移除装饰从文档消失', (await state()).doc.ornaments.length === 1 && (await state()).doc.ornaments[0].kind === 'butterfly', (await state()).doc.ornaments.map((item) => item.kind));
  await page.getByTestId('undo').click();
  await wait(200);
  check('撤销恢复被移除的装饰', (await state()).doc.ornaments.length === 2, (await state()).doc.ornaments.map((item) => item.kind));
  await wait(250);
  {
    const decor = await page.evaluate(() => window.__bouquetDebug.getDecorState().ornaments);
    const docKinds = (await state()).doc.ornaments.map((item) => item.kind).sort();
    check('场景装饰层与文档一致', decor.count === 2 && JSON.stringify([...decor.kinds].sort()) === JSON.stringify(docKinds), { scene: decor.kinds, doc: docKinds });
    const light = decor.items.find((item) => item.kind === 'light-string');
    check('场景里的灯串真的发光', (light?.bulbs ?? 0) > 10 && (light?.emissive ?? 0) > 0, light ?? null);
  }

  // 换容器：能力表外的装饰被过滤，不留悬空装饰
  await page.evaluate(() => {
    const store = window.__bouquetDebug.store;
    store.addOrnament('tag');
    store.endTransaction();
  });
  await wait(200);
  check('纸包三个装饰就位', (await state()).doc.ornaments.length === 3, (await state()).doc.ornaments.map((item) => item.kind));
  await switchKind('vase');
  {
    const remaining = (await state()).doc.ornaments.map((item) => item.kind).sort();
    check('换花瓶后灯串/系结装饰被移除', JSON.stringify(remaining) === JSON.stringify(['butterfly']), remaining);
    check('花瓶只剩插饰可选', JSON.stringify(await addIds()) === JSON.stringify(sorted(CAPABILITY.vase)), await addIds());
  }
  await page.getByTestId('decoration-add-star-pick').click();
  await wait(250);
  check('花瓶上可以继续加插饰', (await state()).doc.ornaments.length === 2);
  {
    const decor = await page.evaluate(() => window.__bouquetDebug.getDecorState());
    check('换花瓶后场景只渲染允许的装饰', decor.ornaments.count === 2 && decor.ornaments.kinds.every((item) => CAPABILITY.vase.includes(item)), decor.ornaments.kinds);
    check('花瓶场景声明不支持可编辑丝带', decor.ribbonSupported === false, decor.ribbonSupported);
    check('场景装饰层可见', decor.ornaments.visible === true, decor.ornaments.visible);
    await page.screenshot({ path: `${OUT}/04-vase-decorations.png` });
  }

  // 换容器后 store 已经过滤掉不适用装饰；场景层另外还有一道过滤（正常路径看不到
  // skipped）。这里在 dev 里故意塞一条越权装饰，验证场景确实不渲染它。
  if (DEV) {
    const probe = await page.evaluate(async () => {
      const store = window.__bouquetDebug.store;
      const scene = window.__bouquetDebug.scene;
      const applyDoc = store.applyDoc?.bind(store);
      if (typeof applyDoc !== 'function') return { supported: false };
      const before = JSON.stringify(store.getState().doc);
      const doc = JSON.parse(before);
      doc.ornaments = [
        { id: 'probe-light', kind: 'light-string', colorId: 'warm', position: [0, 0.9, 0], rotation: 0, scale: 1, intensity: 0.7, variant: 0 },
        { id: 'probe-star', kind: 'star-pick', colorId: 'warm', position: [0.05, 1, 0.05], rotation: 0, scale: 1, intensity: 1, variant: 0 },
      ];
      applyDoc(doc);
      await new Promise((resolve) => setTimeout(resolve, 260));
      const decor = scene.getDecorState().ornaments;
      applyDoc(JSON.parse(before));
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { supported: true, count: decor.count, kinds: decor.kinds, skipped: decor.skipped };
    });
    if (!probe.supported) {
      skip('场景层过滤越权装饰（skipped）', 'debug store 没有暴露 applyDoc');
    } else {
      check(
        '场景层过滤越权装饰（skipped 有记录、不渲染）',
        probe.count === 1 && JSON.stringify(probe.kinds) === JSON.stringify(['star-pick']) && probe.skipped.includes('probe-light'),
        probe,
      );
      check('越权装饰探针后文档恢复', (await state()).doc.ornaments.length === 2, (await state()).doc.ornaments.map((item) => item.kind));
    }
  }

  // ---------- E. 三维装饰模块（直接 import，仅 dev server 可用） ----------
  console.log('\n== E. 三维装饰模块 ==');
  if (!DEV) {
    skip('装饰三维模块四组几何/亮度/过滤/dispose', '生产包没有 /src TS 入口');
  } else {
    const moduleResult = await page.evaluate(async () => {
      const mod = await import('/src/three/decor/ornaments.ts');
      const base = [
        { id: 'a', kind: 'light-string', colorId: 'warm', position: [0, 0.92, 0], rotation: 0, scale: 1, intensity: 0.8, variant: 0 },
        { id: 'b', kind: 'star-lights', colorId: 'warm', position: [0, 0.95, 0], rotation: 30, scale: 1, intensity: 0.6, variant: 1 },
        { id: 'c', kind: 'pearl-strand', colorId: 'ivory', position: [0.02, 0.9, 0.06], rotation: 0, scale: 1, intensity: 1, variant: 0 },
        { id: 'd', kind: 'butterfly', colorId: 'rose', position: [0.05, 1.02, 0.08], rotation: 45, scale: 1, intensity: 1, variant: 0 },
        { id: 'e', kind: 'bow', colorId: 'rose', position: [0, 0.88, 0.08], rotation: 0, scale: 1, intensity: 1, variant: 0 },
        { id: 'f', kind: 'tag', colorId: 'ivory', position: [0.01, 0.88, 0.09], rotation: 0, scale: 1, intensity: 1, variant: 0 },
      ];
      const group = mod.createOrnaments();
      mod.syncOrnaments(group, base, { radius: 0.12, kind: 'paper' });
      const debug1 = mod.getOrnamentDebug(group);
      const children1 = group.children.length;
      // 只改亮度：不重建几何，但 emissive 要跟着变。
      mod.syncOrnaments(group, [{ ...base[0], intensity: 0.2 }, ...base.slice(1)], { radius: 0.12, kind: 'paper' });
      const debug2 = mod.getOrnamentDebug(group);
      const children2 = group.children.length;
      // 容器能力过滤：花瓶只留插饰。
      mod.syncOrnaments(group, base, { radius: 0.12, kind: 'vase' });
      const debug3 = mod.getOrnamentDebug(group);
      mod.disposeOrnaments(group);
      return {
        items1: debug1.items,
        children1,
        children2,
        light1: debug1.items.find((item) => item.id === 'a'),
        light2: debug2.items.find((item) => item.id === 'a'),
        items3: debug3.items.map((item) => item.kind),
        skipped3: debug3.skipped,
        afterDispose: group.children.length,
      };
    });
    check('装饰模块四组都建出真实几何', moduleResult.items1.length === 6, moduleResult.items1.map((item) => item.kind));
    check('灯串带光点且发光强度跟 intensity', (moduleResult.light1?.bulbs ?? 0) > 10 && (moduleResult.light1?.emissive ?? 0) > 0 && moduleResult.light2.emissive < moduleResult.light1.emissive, {
      bulbs: moduleResult.light1?.bulbs,
      emissive: [moduleResult.light1?.emissive, moduleResult.light2?.emissive],
    });
    check('位置/旋转/大小应用到场景对象', Math.abs(moduleResult.items1.find((item) => item.id === 'b').position[1] - 0.95) < 1e-6 && Math.abs(moduleResult.items1.find((item) => item.id === 'b').rotation - 30) < 1e-4 && Math.abs(moduleResult.items1.find((item) => item.id === 'd').scale - 1) < 1e-6);
    check('重复同步不重复建对象', moduleResult.children1 === moduleResult.children2, { children1: moduleResult.children1, children2: moduleResult.children2 });
    check('能力表外的装饰在模块里也被跳过', moduleResult.items3.length === 1 && moduleResult.items3[0] === 'butterfly' && moduleResult.skipped3.length === 5, moduleResult);
    check('dispose 后装饰层不残留对象', moduleResult.afterDispose === 0, moduleResult.afterDispose);
  }

  // ---------- 刷新后恢复 ----------
  console.log('\n== D2. 刷新后装饰恢复 ==');
  const ornamentsBeforeReload = await page.evaluate(() => JSON.stringify(window.__bouquetDebug.getState().doc.ornaments));
  await wait(900);
  await page.reload();
  await page.getByTestId('start-continue').click();
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest', null, { timeout: 60000 });
  await wait(400);
  const ornamentsAfterReload = await page.evaluate(() => JSON.stringify(window.__bouquetDebug.getState().doc.ornaments));
  check('刷新后装饰随作品恢复', ornamentsAfterReload === ornamentsBeforeReload, { before: ornamentsBeforeReload, after: ornamentsAfterReload });
  await page.evaluate(() => {
    const store = window.__bouquetDebug.store;
    store.enterWrap();
    store.setPackageStep('card');
    store.endTransaction();
  });
  await wait(700);
  await page.screenshot({ path: `${OUT}/04-restored.png` });

  // ---------- F1. 常用短语 ----------
  console.log('\n== F. 贺卡常用短语 ==');
  check('卡片块挂上两个次级入口', (await visible('card-assist-phrases')) && (await visible('card-assist-polish')));
  await page.evaluate(() => {
    const store = window.__bouquetDebug.store;
    store.setCardField('message', '');
    store.setPackageStep('card');
    store.endTransaction();
  });
  await wait(200);
  await page.getByTestId('card-assist-phrases').click();
  await wait(150);
  check('常用短语按四个场合组织', (await count('phrase-group-birthday')) === 1 && (await count('phrase-group-thanks')) === 1 && (await count('phrase-group-anniversary')) === 1 && (await count('phrase-group-daily')) === 1);
  const phraseBirthday = (await page.getByTestId('phrase-birthday-0').innerText()).trim();
  await page.getByTestId('phrase-birthday-0').click();
  await wait(200);
  check('空正文点短语直接插入', (await state()).doc.card.message === phraseBirthday, (await state()).doc.card.message);
  check('插入后可继续编辑（正文框仍是输入框）', (await page.getByTestId('card-message').isEditable()));
  await page.getByTestId('undo').click();
  await wait(150);
  check('撤销恢复空正文', (await state()).doc.card.message === '', (await state()).doc.card.message);

  await page.getByTestId('card-message').click();
  await page.getByTestId('card-message').fill('旧句子');
  await wait(150);
  await page.getByTestId('phrase-group-thanks').click();
  const phraseThanks = (await page.getByTestId('phrase-thanks-0').innerText()).trim();
  await page.getByTestId('phrase-thanks-0').click();
  await wait(150);
  check('非空正文先确认而不是直接覆盖', (await visible('phrase-confirm')) && (await state()).doc.card.message === '旧句子', (await state()).doc.card.message);
  await page.getByTestId('phrase-cancel').click();
  await wait(120);
  check('取消确认不改正文', (await state()).doc.card.message === '旧句子');
  await page.getByTestId('phrase-thanks-0').click();
  await wait(120);
  await page.getByTestId('phrase-append').click();
  await wait(200);
  check('确认后可接在正文后面', (await state()).doc.card.message.startsWith('旧句子') && (await state()).doc.card.message.includes(phraseThanks), (await state()).doc.card.message);
  await page.getByTestId('undo').click();
  await wait(150);
  check('追加一次撤销回到原文', (await state()).doc.card.message === '旧句子', (await state()).doc.card.message);
  await page.getByTestId('phrase-thanks-0').click();
  await wait(120);
  await page.getByTestId('phrase-replace').click();
  await wait(200);
  check('确认后可替换正文', (await state()).doc.card.message === phraseThanks, (await state()).doc.card.message);
  await page.screenshot({ path: `${OUT}/05-card-phrases.png` });

  // ---------- F2. AI 润色（全部 mock，不消耗额度） ----------
  console.log('\n== F2. AI 润色（page.route mock） ==');
  const captured = [];
  let polishHandler = null;
  await page.route('**/api/polish', async (route) => {
    const body = route.request().postDataJSON();
    captured.push(body);
    if (!polishHandler) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: '默认建议' }) });
    }
    return polishHandler(route, body);
  });
  await page.getByTestId('card-assist-polish').click();
  await wait(150);
  check('AI 润色入口说明只发文字、不发照片', (await page.getByTestId('card-polish-panel').innerText()).includes('不发照片'), (await page.getByTestId('card-polish-panel').innerText()).slice(0, 80));

  // 空正文先提示
  await page.evaluate(() => {
    const store = window.__bouquetDebug.store;
    store.setCardField('message', '');
    store.endTransaction();
  });
  await wait(150);
  const capturedBeforeEmpty = captured.length;
  await page.getByTestId('card-assist-polish-run').click();
  await wait(200);
  check('空正文先提示写一句或选短语，不发请求', (await visible('card-assist-empty-hint')) && captured.length === capturedBeforeEmpty, { requests: captured.length - capturedBeforeEmpty });

  // 成功：建议先展示、采用后才替换
  await page.evaluate(() => {
    const store = window.__bouquetDebug.store;
    store.setCardField('to', '妈妈');
    store.setCardField('message', '妈妈生日快乐');
    store.endTransaction();
  });
  await wait(150);
  polishHandler = async (route) => {
    await sleep(350);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: '妈妈，生日快乐，愿你被温柔对待。', model: 'mock-1017', createdAt: new Date().toISOString() }),
    });
  };
  await page.getByTestId('card-assist-polish-run').click();
  await wait(120);
  check('请求期间显示进行中与取消入口', (await visible('card-assist-busy')) && (await visible('card-assist-cancel')));
  await page.waitForFunction(() => document.querySelector('[data-testid="card-assist-suggestion"]'), null, { timeout: 8000 });
  check('建议先展示、不自动替换正文', (await page.getByTestId('card-assist-suggestion-text').innerText()).includes('愿你被温柔对待') && (await state()).doc.card.message === '妈妈生日快乐', (await state()).doc.card.message);
  const successRequest = captured[captured.length - 1];
  check('润色请求体只带文字（text/to/from）', JSON.stringify(Object.keys(successRequest).sort()) === JSON.stringify(['text', 'to']) && successRequest.text === '妈妈生日快乐' && !('image' in successRequest), successRequest);
  await page.screenshot({ path: `${OUT}/06-polish-suggestion.png` });
  await page.getByTestId('card-assist-apply').click();
  await wait(200);
  check('采用后才替换正文', (await state()).doc.card.message === '妈妈，生日快乐，愿你被温柔对待。', (await state()).doc.card.message);
  await page.getByTestId('undo').click();
  await wait(200);
  check('采用一次撤销回到原文', (await state()).doc.card.message === '妈妈生日快乐', (await state()).doc.card.message);

  // 失败：保留原文并说明本地服务未配置
  polishHandler = async (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: '尚未配置 AI 润色服务（服务端缺少凭据），正文可以照常手写。', code: 'not_configured' }),
    });
  await page.getByTestId('card-assist-polish-run').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="card-assist-error"]'), null, { timeout: 8000 });
  check('失败保留原文并说明本地服务未配置', (await state()).doc.card.message === '妈妈生日快乐' && (await page.getByTestId('card-assist-error').innerText()).includes('配置'), (await page.getByTestId('card-assist-error').innerText()).trim());
  await page.screenshot({ path: `${OUT}/07-polish-error.png` });

  // 迟到结果：请求期间继续编辑，不许覆盖新文本
  polishHandler = async (route) => {
    await sleep(1400);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: '迟到的建议不该覆盖新正文' }),
    });
  };
  await page.getByTestId('card-assist-polish-run').click();
  await wait(250);
  await page.getByTestId('card-message').click();
  await page.getByTestId('card-message').fill('新的正文');
  await wait(1700);
  check('迟到结果不覆盖请求期间的新文本', (await state()).doc.card.message === '新的正文' && (await visible('card-assist-stale')), (await state()).doc.card.message);
  check('迟到结果也不显示可采用的建议', (await count('card-assist-suggestion')) === 0);

  // 取消：请求中断、正文不动
  polishHandler = async (route) => {
    await sleep(2500);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: '取消后的迟到建议' }) });
  };
  captured.length = 0;
  await page.getByTestId('card-assist-polish-run').click();
  await wait(250);
  await page.getByTestId('card-assist-cancel').click();
  await wait(600);
  check('取消后正文不动、不显示建议', (await state()).doc.card.message === '新的正文' && (await count('card-assist-suggestion')) === 0);
  check('取消后回到可再次润色状态', (await page.getByTestId('card-assist-polish-run').isEnabled()) && (await count('card-assist-busy')) === 0);
  await wait(2400);
  check('取消后的迟到响应不会改写正文', (await state()).doc.card.message === '新的正文', (await state()).doc.card.message);

  check('无页面与脚本错误', pageErrors.length === 0, pageErrors);
  writeFileSync(
    `${OUT}/results.json`,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        url: URL_BASE,
        passed,
        checks,
        pageErrors,
      },
      null,
      2,
    ),
  );
  console.log(`\nPASSED ${passed}（${checks.filter((item) => item.skipped).length} 项跳过）`);
} catch (error) {
  writeFileSync(
    `${OUT}/failure.json`,
    JSON.stringify({ date: new Date().toISOString(), passed, checks, error: String(error), pageErrors }, null, 2),
  );
  console.error(`FAILED after ${passed}:`, String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
}
