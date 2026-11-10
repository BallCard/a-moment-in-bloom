/**
 * 花材审片工具：在真实 Chrome 里用统一灯光渲染一枝花的多角度与组合图。
 *
 * 为什么需要：GLB 结构检查（scripts/inspect_glb.py / bouquet_assets.py measure）不能证明
 * 模型视觉正确——花瓣背面、透明贴图、法线、颜色、是否有底面/背景球，只有真渲染能看出来。
 *
 * 用法（在项目根目录）：
 *   node scripts/review_flower.mjs --glb assets/local/processed/tulip-pink.glb --id tulip-pink
 * 输出：
 *   experiments/local/review/<id>/{front,quarter,side,back,top,head,bouquet}.png
 *   experiments/local/review/<id>/scene-report.json
 *
 * 依赖 app/node_modules 里的 playwright-core 与 three；three 通过临时静态服务 + importmap 提供给页面。
 * 相机只框住花本体（不含地面），因此不同资产之间角度与构图可比。
 */

import { chromium } from '../app/node_modules/playwright-core/index.mjs';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve('.');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const GLB = arg('glb');
const ID = arg('id', 'asset');
if (!GLB || !existsSync(GLB)) {
  console.error('用法：node scripts/review_flower.mjs --glb <glb 路径> [--id <资产id>]');
  process.exit(1);
}
const OUT = join('experiments', 'local', 'review', ID);
mkdirSync(OUT, { recursive: true });

const THREE_DIR = join(ROOT, 'app', 'node_modules', 'three');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.bin': 'application/octet-stream', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm' };

const modelName = GLB.replace(/\\/g, '/').split('/').pop();
const page_html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>花材审片 · ${ID}</title>
<style>
  html,body{margin:0;height:100%;background:#efe9e1;overflow:hidden}
  #status{position:fixed;left:12px;top:10px;font:12px/1.6 system-ui,sans-serif;color:#8a7d70;z-index:9}
  canvas{display:block}
</style>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
</head><body>
<div id="status">加载中…</div>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const params = new URLSearchParams(location.search);
const VIEW = params.get('view') || 'front';
const statusEl = document.getElementById('status');

const SIZE = 1000;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(SIZE, SIZE, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#efe9e1');
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 60);

// 统一灯光：主光 + 补光 + 轮廓光 + 半球光
const key = new THREE.DirectionalLight('#fff6ea', 2.6);
key.position.set(1.6, 2.6, 1.8);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.1; key.shadow.camera.far = 12;
key.shadow.camera.left = -1.2; key.shadow.camera.right = 1.2;
key.shadow.camera.top = 1.8; key.shadow.camera.bottom = -0.6;
key.shadow.bias = -0.0006;
scene.add(key);
const fill = new THREE.DirectionalLight('#e8f0ff', 0.85); fill.position.set(-2.2, 1.4, 1.2); scene.add(fill);
const rim = new THREE.DirectionalLight('#ffffff', 1.15); rim.position.set(-0.8, 2.0, -2.4); scene.add(rim);
scene.add(new THREE.HemisphereLight('#ffffff', '#d8cfc2', 0.8));

// 内容组：花本体都放这里，取景只框它
const content = new THREE.Group();
scene.add(content);
const ground = new THREE.Mesh(new THREE.CircleGeometry(4, 64), new THREE.ShadowMaterial({ opacity: 0.15 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const loader = new GLTFLoader();
loader.load('/model/${modelName}', (gltf) => {
  const model = gltf.scene;
  let tris = 0;
  const mats = [];
  const meshReport = [];
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    const g = o.geometry;
    const count = g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
    tris += count;
    meshReport.push({ name: o.name, tris: Math.round(count), vertexColors: Boolean(g.attributes.color), material: Array.isArray(o.material) ? o.material.length : 1 });
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) {
      mats.push({ name: m.name, type: m.type, metalness: m.metalness, roughness: m.roughness,
                  transparent: m.transparent, opacity: m.opacity, side: m.side, alphaTest: m.alphaTest,
                  hasMap: Boolean(m.map), hasNormalMap: Boolean(m.normalMap),
                  color: m.color ? '#' + m.color.getHexString() : null,
                  mapSize: m.map && m.map.image ? [m.map.image.width, m.map.image.height] : null });
    }
  });
  const rawBox = new THREE.Box3().setFromObject(model);
  const rawSize = rawBox.getSize(new THREE.Vector3());

  // 统一到"茎底在地面 y=0"
  model.position.y -= rawBox.min.y;
  content.add(model);

  if (VIEW === 'bouquet') {
    content.remove(model);
    const stems = 12;
    for (let i = 0; i < stems; i += 1) {
      const pivot = new THREE.Group();
      const clone = model.clone(true);
      clone.position.y = 0;
      pivot.add(clone);
      pivot.rotation.y = (i / stems) * Math.PI * 2 * 1.618;
      const tilt = [0.28, 0.52, 0.72, 0.9][i % 4];
      pivot.rotateOnAxis(new THREE.Vector3(1, 0, 0), tilt);
      pivot.scale.setScalar(0.94 + 0.12 * ((i * 37) % 5) / 5);
      content.add(pivot);
    }
  }

  // 取景：只框内容组
  const box = new THREE.Box3().setFromObject(content);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  if (VIEW === 'head') {
    // 花头特写：取顶部 22% 高度带
    const band = box.max.y - size.y * 0.22;
    center.set((box.min.x + box.max.x) / 2, (band + box.max.y) / 2, (box.min.z + box.max.z) / 2);
    size.set(size.x * 0.42, size.y * 0.28, size.z * 0.42);
  }
  const fitH = (size.y / 2) / Math.tan((camera.fov * Math.PI / 180) / 2);
  const fitW = (Math.max(size.x, size.z) / 2) / Math.tan((camera.fov * Math.PI / 180) / 2);
  const dist = Math.max(fitH, fitW) * (VIEW === 'head' ? 1.0 : 1.45);

  const angles = { front: 0, quarter: Math.PI * 0.25, side: Math.PI * 0.5, back: Math.PI, top: 0, head: Math.PI * 0.2, bouquet: Math.PI * 0.15 };
  const a = angles[VIEW] ?? 0;
  const elevation = VIEW === 'top' ? dist * 0.98 : VIEW === 'head' ? size.y * 0.5 : size.y * 0.22;
  camera.position.set(center.x + Math.sin(a) * dist, center.y + elevation, center.z + Math.cos(a) * dist);
  camera.lookAt(center);
  ground.position.y = box.min.y > 0 ? box.min.y : 0;

  window.__report = {
    view: VIEW,
    triangles: Math.round(tris),
    meshCount: meshReport.length,
    meshes: meshReport,
    rawBoxSize: rawSize.toArray().map((v) => Number(v.toFixed(4))),
    rawBoxMin: rawBox.min.toArray().map((v) => Number(v.toFixed(4))),
    rawBoxMax: rawBox.max.toArray().map((v) => Number(v.toFixed(4))),
    materials: mats,
    cameraDistance: Number(dist.toFixed(3)),
    contentBoxSize: size.toArray().map((v) => Number(v.toFixed(4))),
  };
  statusEl.textContent = 'ready';
  window.__ready = true;
}, undefined, (err) => {
  statusEl.textContent = '加载失败：' + err;
  window.__loadError = String(err);
});

renderer.setAnimationLoop(() => renderer.render(scene, camera));
</script></body></html>`;

const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const tryFile = (p) => {
    try {
      const buf = readFileSync(p);
      res.writeHead(200, { 'Content-Type': MIME[extname(p).toLowerCase()] ?? 'application/octet-stream' });
      res.end(buf);
      return true;
    } catch {
      return false;
    }
  };
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(page_html);
    return;
  }
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (url.startsWith('/three/') && tryFile(join(THREE_DIR, normalize(url.slice('/three/'.length))))) return;
  if (url.startsWith('/model/') && tryFile(join(ROOT, 'assets', 'local', 'processed', normalize(url.slice('/model/'.length))))) return;
  res.writeHead(404); res.end('not found');
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/`;

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1000, height: 1000 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));

const report = { id: ID, glb: GLB, views: [], consoleErrors: [] };
for (const view of ['front', 'quarter', 'side', 'back', 'top', 'head', 'bouquet']) {
  await page.goto(`${base}?view=${view}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true || Boolean(window.__loadError), null, { timeout: 180000 });
  const loadError = await page.evaluate(() => window.__loadError ?? null);
  if (loadError) { console.error('加载失败：', loadError); break; }
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, `${view}.png`) });
  const r = await page.evaluate(() => window.__report);
  report.views.push(r);
  console.log(`[review] ${view.padEnd(8)} -> ${join(OUT, `${view}.png`)}  三角面=${r.triangles}  mesh=${r.meshCount}`);
}
report.consoleErrors = errors;
report.triangles = report.views[0]?.triangles ?? null;
report.materials = report.views[0]?.materials ?? [];
report.rawBoxSize = report.views[0]?.rawBoxSize ?? null;
writeFileSync(join(OUT, 'scene-report.json'), JSON.stringify(report, null, 2), 'utf-8');
console.log(`[review] 报告：${join(OUT, 'scene-report.json')}  三角面=${report.triangles}`);
if (errors.length) console.log('[review] 控制台错误：', errors);

await browser.close();
server.close();
