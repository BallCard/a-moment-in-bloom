/** Regression for the user's "invisible wall": real pointer drag, soft contact, release.
 * Start Vite on 5190, then node scripts/v07-touch.mjs. Uses an isolated browser profile.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
const out = '.verify/v07-touch';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [], cases = [], errors = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`);
  console.log('ok', name);
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.TOUCH_URL ?? 'http://127.0.0.1:5190/?size=b');
  await page.waitForFunction(() => window.__bouquetDebug?.getState().catalogStatus === 'manifest');
  const unit = await page.evaluate(async () => {
    const e = await import('/src/three/envelope.ts'), c = await import('/src/three/contact.ts');
    const a = { center: [0, 0, 0], radii: [.1, .02, .06] };
    const disjoint = { ...a, center: [.12, .035, 0] };
    // Two identical axis-aligned ellipsoids intersect iff Σ (d_i / 2r_i)^2 <= 1.
    const tangent = { ...a, center: [.12, .032, 0] };
    const overlapping = { ...a, center: [.12, .030, 0] };
    const q = [0, 0, Math.sin(.37), Math.cos(.37)];
    const rotated = v => e.transformVolume(v, [.3, .7, -.2], q);
    const ball = x => ({ center: [x, 0, 0], radii: [.1, .1, .1] });
    const soft = [.001, .01, .017].map(depth => {
      const stems = [{ stemId: 'a', kind: 'main', volumes: [ball(0)] }, { stemId: 'b', kind: 'main', volumes: [ball(.2-depth)] }];
      const response = c.solveContacts(stems, 'a').get('a');
      return { depth, valid: e.allowed(e.overlapBetween(stems[0].volumes[0], stems[1].volumes[0]), e.limitsFor('main')), response, residual: c.residualOverlap(stems) };
    });
    return {
      disjoint: e.overlapBetween(a, disjoint), tangent: e.overlapBetween(a, tangent),
      overlapping: e.overlapBetween(a, overlapping), reverse: e.overlapBetween(overlapping, a),
      rotated: e.overlapBetween(rotated(a), rotated(overlapping)),
      sphere: e.overlapBetween(ball(0), { center: [.14, 0, 0], radii: [.06, .06, .06] }), soft,
    };
  });
  check('斜向已分离的扁花头不能产生空气阻挡', unit.disjoint.rim === 0 && unit.disjoint.core === 0, unit.disjoint);
  check('解析相切的椭球重叠接近零', unit.tangent.rim < 1e-7, unit.tangent);
  check('斜向实际相交仍能检测', unit.overlapping.rim > .001, unit.overlapping);
  check('交换花枝与共同旋转不改变结果', Math.abs(unit.overlapping.rim-unit.reverse.rim)<1e-7 && Math.abs(unit.rotated.rim-unit.overlapping.rim)<1e-7, unit);
  check('大小不同的球保持解析穿深 2cm', Math.abs(unit.sphere.rim-.02)<1e-9, unit.sphere);
  check('合法接触区内必须已经产生渐增压缩', unit.soft.every((v,i) => v.valid && v.response?.squash>0 && (!i || v.response.squash>unit.soft[i-1].response.squash)), unit.soft);
  check('合法接触只收拢花头，不把整枝推开', unit.soft.every(v=>v.response.deflect===0 && Math.hypot(...v.response.offset,...v.response.separation)===0 && v.residual.rim===0), unit.soft);

  for (const [name, first, second] of [['rose','rose-pink','rose-ivory'], ['tulip','tulip-pink','tulip-cream'], ['mixed','rose-pink','tulip-cream']]) {
    await page.evaluate(async ({ first, second }) => {
      const d=window.__bouquetDebug, {createStem}=await import('/src/data/document.ts');
      d.store.setStage('arrange');
      d.store.replaceDocument({...d.getState().doc, sizeCandidate:'b', stems:[
        createStem({assetId:first,position:[0,.9,0],scale:1,pose:{height:0,tilt:0,direction:0,spin:0}}),
        createStem({assetId:second,position:[0,.9,0],scale:1,pose:{height:0,tilt:45,direction:90,spin:0}}),
      ]});
      d.store.setViewPreset('front');
    }, { first, second });
    await page.waitForFunction(()=>window.__bouquetDebug.scene.views.size===2 && [...window.__bouquetDebug.scene.views.values()].every(v=>v.object));
    await page.waitForTimeout(800);
    const points=await page.evaluate(()=>{const d=window.__bouquetDebug;return d.getState().doc.stems.map(s=>({id:s.id,...d.getStemScreenPoint(s.id)}));});
    const history=await page.evaluate(()=>window.__bouquetDebug.getState().pastCount);
    await page.mouse.move(points[1].x,points[1].y);
    await page.mouse.down();
    const grabbed=await page.evaluate(()=>window.__bouquetDebug.scene.drag?.stemId);
    check(`${name}：真实鼠标抓到主动枝`, grabbed===points[1].id, {grabbed,points});
    const frames=[];
    for(let i=1;i<=28;i++) {
      const t=i/28;
      await page.mouse.move(points[1].x+(points[0].x-points[1].x)*t, points[1].y+(points[0].y-points[1].y)*t);
      await page.waitForTimeout(22);
      frames.push(await page.evaluate(()=>({envelope:window.__bouquetDebug.scene.getEnvelopeState().worst,contacts:window.__bouquetDebug.scene.getContactState()})));
    }
    await page.mouse.up();
    await page.waitForTimeout(850);
    const settled=await page.evaluate(()=>{
      const d=window.__bouquetDebug;
      const pivots=[], renderedCompression=[];
      for(const v of d.scene.views.values()) {
        const mesh=v.object.getObjectByName('original-flower-head');
        const center=mesh.geometry.boundingBox.getCenter(v.root.position.clone());
        pivots.push(center.clone().applyMatrix4(mesh.matrix).distanceTo(center));
        renderedCompression.push(1-mesh.matrix.determinant());
      }
      return {envelope:d.scene.getEnvelopeState().worst, contacts:d.scene.getContactState(), pivots, renderedCompression, history:d.getState().pastCount, poses:d.getState().doc.stems.map(s=>s.pose)};
    });
    check(`${name}：整个拖动路径仍处于有效占用范围`,frames.every(f=>f.envelope.valid) && settled.envelope.valid,{last:settled.envelope});
    check(`${name}：能接触并收拢至少 2%，不在空气中停下`, settled.contacts.some(v=>v.squash>.02),settled);
    check(`${name}：受压花头中心不漂移`,settled.pivots.every(v=>v<1e-8),settled.pivots);
    check(`${name}：实际上屏网格已压缩，不只是求解器数值变化`,settled.renderedCompression.every(v=>v>.02 && v<=.12001),settled.renderedCompression);
    check(`${name}：没有整枝分离制造缝隙`,settled.contacts.every(v=>Math.hypot(...v.offset,...v.separation)<.0001 && v.deflect<.0001),settled.contacts);
    check(`${name}：一次拖动只增加一次撤销`,settled.history-history===1,{history,after:settled.history});
    await page.screenshot({path:`${out}/${name}-pressed.png`});
    // 前视图会遮挡后枝，额外看侧面，不能只用接触数值宣称观感通过。
    await page.evaluate(()=>{const d=window.__bouquetDebug;d.store.select(null);d.store.setViewPreset('side');});
    await page.waitForTimeout(500);
    await page.screenshot({path:`${out}/${name}-side.png`});
    await page.evaluate(()=>window.__bouquetDebug.store.setViewPreset('front'));
    await page.waitForTimeout(500);
    // 拖回原处，确认可脱离且回复原形。
    const end=await page.evaluate(id=>window.__bouquetDebug.getStemScreenPoint(id),points[1].id);
    await page.mouse.move(end.x,end.y);await page.mouse.down();
    await page.mouse.move(points[1].x,points[1].y,{steps:25});await page.mouse.up();
    await page.waitForTimeout(1600);
    const released=await page.evaluate(()=>window.__bouquetDebug.scene.getContactState());
    check(`${name}：拉开恢复原形`,released.every(v=>v.squash<.001),released);
    cases.push({name,frames,settled,released});
    await page.screenshot({path:`${out}/${name}-released.png`});
  }
  check('无页面错误',errors.length===0,errors);
} finally {
  writeFileSync(`${out}/results.json`,JSON.stringify({checks,cases,errors},null,2));
  await browser.close();
}
console.log(`${checks.length}/${checks.length} passed`);
