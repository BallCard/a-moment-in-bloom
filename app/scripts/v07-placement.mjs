/**
 * V7 §3 统一有效落位求解：单元检查 + 性能实测（场景集成部分等 Lead 接线后补）。
 *
 * 用法（5190 已在跑，别再起一个）：
 *   node scripts/v07-placement.mjs            # headless
 *   $env:HEADED='1'; node scripts/v07-placement.mjs
 *
 * 页面里 import /src/three/placement.ts（纯 TS）+ /src/three/envelope.ts，
 * 用确定的合成几何做断言；真实数字写进 .verify/v07-placement/results.json。
 */

import {chromium} from 'playwright-core';
import {mkdirSync,writeFileSync} from 'node:fs';

const BASE=process.env.PLACEMENT_URL??'http://127.0.0.1:5190/';
const OUT='.verify/v07-placement';
mkdirSync(OUT,{recursive:true});

let passed=0;const checks=[];const errors=[];
function check(name,ok,detail){
  checks.push({name,ok,detail:detail??null});
  if(!ok)throw Error(`${name}: ${JSON.stringify(detail)}`);
  passed++;console.log('ok',name);
}

const browser=await chromium.launch({
  channel:'chrome',
  headless:process.env.HEADED!=='1',
  args:['--enable-unsafe-swiftshader','--disable-gpu-vsync'],
});
const context=await browser.newContext({viewport:{width:1440,height:900}});
const page=await context.newPage();
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});

try{
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(1200);

  const exec=(fn,arg)=>page.evaluate(fn,arg);

  const unit=await page.evaluate(async()=>{
    const mod=await import('/src/three/placement.ts');
    const envelope=await import('/src/three/envelope.ts');

    // —— 合成几何：花头绕握点旋转，杠杆 36cm，握点 y=0.9 ——
    const DEG=Math.PI/180;
    const LEVER=0.36;
    const GRIP=0.9;
    const R=0.1;
    const centerOf=(p)=>{
      const t=p.tilt*DEG,d=p.direction*DEG,lever=LEVER+p.height;
      return [lever*Math.sin(t)*Math.sin(d),GRIP+lever*Math.cos(t),lever*Math.sin(t)*Math.cos(d)];
    };
    const ball=(center,radius=R)=>({center,radii:[radius,radius,radius]});
    const volumeAt=(p)=>({center:centerOf(p),radii:[R,R,R]});
    const build=(p)=>[volumeAt(p)];
    const poseAt=(direction,tilt,height=0)=>({direction,tilt,height});
    const occ=(stemId,kind,center,radius=R)=>({stemId,kind,volumes:[ball(center,radius)]});
    const dist3=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
    // 结果的可观测快照（只返回数字/布尔/枚举，便于 Node 侧断言）
    const snapshot=(result,others)=>{
      const center=centerOf(result.pose);
      return {
        reason:result.reason,
        clamped:result.clamped,
        valid:result.overlap.valid,
        core:result.overlap.core,
        rim:result.overlap.rim,
        sampleIndex:result.sampleIndex,
        probes:result.probes,
        slidFrom:result.slidFrom?{...result.slidFrom}:null,
        pose:{...result.pose},
        poseDistance:mod.poseDistance(result.pose,others?.to??result.pose),
        center,
        centerDistances:others?.centers?others.centers.map(c=>dist3(center,c)):[],
      };
    };

    const out={};

    // ---------- 1. 两朵同类花请求同位：必须停在边界，不能落进去 ----------
    {
      const from=poseAt(0,30);
      const to=poseAt(180,30);
      const other=occ('other','main',centerOf(to));
      const fromOverlap=mod.evaluate(build(from),[other]);
      const result=mod.resolvePlacement({from,to,build,occupants:[other],kind:'main'});
      out.sameSpot={
        fromValid:fromOverlap.valid,
        fromOverlap,
        result:snapshot(result,{to,centers:[centerOf(to)]}),
        allowedCore:envelope.limitsFor('main').core,
        allowedRim:envelope.limitsFor('main').rim,
      };
    }

    // ---------- 2. 三朵夹挤：左右 + 中间一朵，目标被三朵围住 ----------
    {
      const from=poseAt(0,20);
      const to=poseAt(180,20);
      const occupants=[
        occ('left','main',centerOf(poseAt(150,32))),
        occ('right','main',centerOf(poseAt(210,32))),
        occ('mid','main',centerOf(poseAt(180,20))),
      ];
      const centers=occupants.map(o=>o.volumes[0].center);
      const fromOverlap=mod.evaluate(build(from),occupants);
      const result=mod.resolvePlacement({from,to,build,occupants,kind:'main'});
      const delta=mod.overlapDelta(result.overlap,fromOverlap);
      out.squeeze={
        fromValid:fromOverlap.valid,
        fromOverlap,
        result:snapshot(result,{to,centers}),
        delta,
      };
    }

    // ---------- 3. 单头 vs 同枝多球 ----------
    {
      const own=mod.evaluate([ball([0.15,1.2,0])],[
        {stemId:'multi',kind:'filler',volumes:[ball([0.15,1.2,0],0.06),ball([0.15,1.26,0],0.06)]},
      ],{kind:'filler',ownStemId:'multi'});
      const other=mod.evaluate([ball([0.15,1.2,0])],[
        {stemId:'multi',kind:'filler',volumes:[ball([0.15,1.2,0],0.06),ball([0.15,1.26,0],0.06)]},
      ],{kind:'filler'});
      // 多头花自己的多个球：任意一枚被挡即整枝无效（不是只看一个球）
      const multiCandidate=mod.evaluate(
        [ball([0.15,1.2,0],0.06),ball([0.15,1.26,0],0.06)],
        [occ('single','main',[0.15,1.26,0],0.06)],
        {kind:'main'},
      );
      // 同枝两球之间不互算：两条同 stemId 的多头花各一个球贴着，仍应有效
      const twoMulti=mod.evaluate(
        [{center:[0.15,1.2,0],radii:[0.06,0.06,0.06]},{center:[0.15,1.26,0],radii:[0.06,0.06,0.06]}],
        [{stemId:'a',kind:'main',volumes:[ball([0.4,1.2,0],0.06)]}],
        {kind:'main'},
      );
      out.multiHead={
        sameStemSkipped:own,
        crossStem:other,
        multiCandidateBlocked:multiCandidate,
        ownVolumesDoNotSelfCollide:twoMulti,
      };
    }

    // ---------- 4. 完全同心：新枝点到别人花心，不能返回无效位 ----------
    {
      const at=poseAt(0,25);
      const big=occ('big','main',centerOf(at),0.2);
      const result=mod.resolvePlacement({from:null,to:at,build,occupants:[big],kind:'main'});
      out.concentric={
        result:snapshot(result,{to:at,centers:[centerOf(at)]}),
        targetInvalid:!mod.evaluate(build(at),[big]).valid,
      };
    }

    // ---------- 5. 快速横穿：from 在左、to 在右，必须停在中间有效位 ----------
    {
      const from=poseAt(0,30);
      const to=poseAt(180,30);
      const blocker=occ('blocker','main',centerOf(poseAt(90,30)),0.12);
      const fromOverlap=mod.evaluate(build(from),[blocker]);
      const result=mod.resolvePlacement({from,to,build,occupants:[blocker],kind:'main'});
      const snap=snapshot(result,{to,centers:[centerOf(poseAt(90,30))]});
      out.crossing={
        fromValid:fromOverlap.valid,
        result:snap,
        blockedCenterZ:centerOf(poseAt(90,30))[2],
        requiredClearance:0.1+0.12-envelope.limitsFor('main').rim,
        startZ:centerOf(from)[2],
        endZ:centerOf(to)[2],
        crossedToFarSide:snap.center[2]<0,
      };
    }

    // ---------- 6. 向中心拖：中心有花，不能塌进去 ----------
    {
      const from=poseAt(0,45);
      const to=poseAt(0,4);
      const centerFlower=occ('center','main',centerOf(to));
      const result=mod.resolvePlacement({from,to,build,occupants:[centerFlower],kind:'main'});
      out.inward={
        result:snapshot(result,{to,centers:[centerOf(to)]}),
        startTilt:from.tilt,
      };
    }

    // ---------- 7. 向外拖：本来就在外侧、往外没有阻挡 → 原样落位 ----------
    {
      const from=poseAt(0,45);
      const to=poseAt(0,55);
      const nearFlower=occ('center','main',centerOf(poseAt(0,6)));
      const fromOverlap=mod.evaluate(build(from),[nearFlower]);
      const result=mod.resolvePlacement({from,to,build,occupants:[nearFlower],kind:'main'});
      out.outward={fromValid:fromOverlap.valid,result:snapshot(result,{to,centers:[]})};
    }

    // ---------- 8. from 已重叠：允许「不变差」的移动，不能被锁死 ----------
    {
      const from=poseAt(0,20);
      const stuck=occ('stuck','main',centerOf(from),0.14);
      const fromOverlap=mod.evaluate(build(from),[stuck]);
      const to=poseAt(200,35);
      const result=mod.resolvePlacement({
        from,to,build,occupants:[stuck],kind:'main',
      });
      out.alreadyOverlapping={
        fromValid:fromOverlap.valid,
        fromOverlap,
        result:snapshot(result,{to,centers:[centerOf(from)]}),
        delta:mod.overlapDelta(result.overlap,fromOverlap),
      };
      // 周围全被一个大包络占满：没有有效位，但也不许变得更差
      const big=occ('big','main',centerOf(from),0.45);
      const blockedResult=mod.resolvePlacement({from,to,build,occupants:[big],kind:'main'});
      const blockedFrom=mod.evaluate(build(from),[big]);
      out.noSpace={
        fromOverlap:blockedFrom,
        result:snapshot(blockedResult,{to,centers:[centerOf(from)]}),
        delta:mod.overlapDelta(blockedResult.overlap,blockedFrom),
      };
    }

    // ---------- 9. 无空间时返回合法且不更差（from 有效，目标被塞满） ----------
    {
      const from=poseAt(0,45);
      const to=poseAt(120,10);
      const occupants=[
        occ('a','main',centerOf(poseAt(120,8)),0.14),
        occ('b','main',centerOf(poseAt(105,14)),0.13),
        occ('c','main',centerOf(poseAt(135,14)),0.13),
        occ('d','main',centerOf(poseAt(120,20)),0.13),
      ];
      const fromOverlap=mod.evaluate(build(from),occupants);
      const result=mod.resolvePlacement({from,to,build,occupants,kind:'main'});
      out.packed={
        fromValid:fromOverlap.valid,
        fromOverlap,
        result:snapshot(result,{to,centers:occupants.map(o=>o.volumes[0].center)}),
        delta:mod.overlapDelta(result.overlap,fromOverlap),
      };
    }

    // ---------- 10. limits 生效：主花 vs 绿叶按更严格的一方，额外上限能收紧 ----------
    {
      const target=[0,1.2383,0];
      const fixedCandidate=[ball([0.18,1.2383,0],0.1)];
      const greenery=occ('g','greenery',target,0.1);
      const asMain=mod.evaluate(fixedCandidate,[greenery],{kind:'main'});
      const asGreenery=mod.evaluate(fixedCandidate,[greenery],{kind:'greenery'});
      const tightened=mod.evaluate(fixedCandidate,[greenery],{kind:'greenery',core:0.001,rim:0.001});
      out.limits={
        rimOverlap:0.2-dist3([0.18,1.2383,0],target),
        mainVsGreenery:asMain,
        greeneryVsGreenery:asGreenery,
        tightened,
        mainLimits:envelope.limitsFor('main'),
        greeneryLimits:envelope.limitsFor('greenery'),
      };
      out.overlapDelta={
        worse:mod.overlapDelta({core:0.01,rim:0.01},{core:0.005,rim:0.005}),
        better:mod.overlapDelta({core:0.005,rim:0.005},{core:0.01,rim:0.01}),
        tiny:mod.overlapDelta({core:0.006+5e-5,rim:0.02},{core:0.006,rim:0.02}),
      };
    }

    // ---------- 11. 扫掠步数 / 滑动候选数（报告用真实数字） ----------
    {
      const from=poseAt(0,30);
      out.shape={
        sweepSteps:mod.PLACEMENT_SWEEP_STEPS,
        slideCandidates:mod.surfaceSlideCandidates(from,poseAt(180,30)).length,
        directionSlides:[...mod.SLIDE_DIRECTION_DEG],
        heightSlides:[...mod.SLIDE_HEIGHT_M],
        tiltSlides:[...mod.SLIDE_TILT_DEG],
        radialTilt:[...mod.RADIAL_OUTWARD_TILT_DEG],
        radialHeight:[...mod.RADIAL_OUTWARD_HEIGHT_M],
      };
    }

    // ---------- 12. 性能：20 枝场景一次 resolve ----------
    {
      const occupants=[];
      const kinds=['main','filler','greenery'];
      for(let i=0;i<20;i++){
        const dir=(i*18+7)%360;
        const tilt=12+(i%5)*7;
        const height=((i%7)-3)*0.02;
        occupants.push({
          stemId:`s${i}`,
          kind:kinds[i%3],
          volumes:[{center:centerOf(poseAt(dir,tilt,height)),radii:[0.11,0.065,0.11]}],
        });
      }
      const kindsFor=()=>'main';
      // 找一个有效外层起始位（真实拖动一定从有效位开始）
      let from20=null;
      for(let dir=0;dir<360&&!from20;dir+=5){
        for(let tilt=48;tilt<=55;tilt+=1){
          for(let h=0;h<=0.2+1e-9;h+=0.05){
            const candidate=poseAt(dir,tilt,h);
            if(mod.evaluate(build(candidate),occupants,{kind:kindsFor()}).valid){from20=candidate;break;}
          }
          if(from20)break;
        }
      }
      const time=(fn,iterations=200)=>{
        const started=performance.now();
        let worst=0;
        for(let i=0;i<iterations;i++){
          const t0=performance.now();
          fn(i);
          const cost=performance.now()-t0;
          if(cost>worst)worst=cost;
        }
        return {iterations,totalMs:performance.now()-started,avgMs:(performance.now()-started)/iterations,maxMs:worst};
      };
      const perf={};
      perf.free=time(()=>mod.resolvePlacement({
        from:from20,to:poseAt((from20.direction+12)%360,from20.tilt,from20.height),
        build,occupants,kind:'main',
      }));
      perf.blocked=time(()=>mod.resolvePlacement({
        from:from20,to:poseAt(90,8),build,occupants,kind:'main',
      }));
      perf.noFrom=time(()=>mod.resolvePlacement({
        from:null,to:poseAt(90,8),build,occupants,kind:'main',
      }));
      out.perf={fromValid:from20!==null,from:from20,...perf};
    }

    // ---------- 13. 多头候选整枝一起求解：只有一枚球会撞上邻花也算整枝被挡 ----------
    {
      const multiBuild=(p)=>{
        const c=centerOf(p);
        return [ball(c,0.06),ball([c[0],c[1]+0.12,c[2]],0.06)];
      };
      const target=poseAt(90,20);
      const targetCenter=centerOf(target);
      const blocker=occ('blocker','filler',[targetCenter[0],targetCenter[1]+0.12,targetCenter[2]],0.06);
      const from=poseAt(0,20);
      const fromOverlap=mod.evaluate(multiBuild(from),[blocker],{kind:'filler'});
      const result=mod.resolvePlacement({from,to:target,build:multiBuild,occupants:[blocker],kind:'filler'});
      out.multiResolve={
        fromValid:fromOverlap.valid,
        targetInvalid:!mod.evaluate(multiBuild(target),[blocker],{kind:'filler'}).valid,
        result:snapshot(result,{to:target,centers:[]}),
      };
    }

    // ---------- 14. lockHeight：拖动只有两个自由度时高度不漂移 ----------
    {
      const from=poseAt(0,30,0.02);
      const to=poseAt(180,30,0.02);
      const blocker=occ('blocker','main',centerOf(poseAt(90,30,0.02)),0.12);
      const locked=mod.resolvePlacement({from,to,build,occupants:[blocker],kind:'main',lockHeight:true});
      const unlocked=mod.resolvePlacement({from,to,build,occupants:[blocker],kind:'main'});
      out.lockHeight={
        locked:snapshot(locked,{to,centers:[centerOf(poseAt(90,30,0.02))]}),
        targetHeight:to.height,
        unlockedHeight:unlocked.pose.height,
        lockedCandidates:mod.surfaceSlideCandidates(from,to,{lockHeight:true}).length,
        defaultCandidates:mod.surfaceSlideCandidates(from,to).length,
      };
    }

    // ---------- 15. 确定性 + 纯函数：同一输入两次结果一致，且不改传入对象 ----------
    {
      const from=poseAt(0,30);
      const to=poseAt(180,30);
      const occupant=occ('other','main',centerOf(to));
      const occupants=[occupant];
      const before=JSON.stringify({from,to,occupants});
      const a=mod.resolvePlacement({from,to,build,occupants,kind:'main'});
      const b=mod.resolvePlacement({from,to,build,occupants,kind:'main'});
      out.determinism={
        identical:JSON.stringify(a)===JSON.stringify(b),
        inputUnchanged:JSON.stringify({from,to,occupants})===before,
        a:{reason:a.reason,pose:a.pose,sampleIndex:a.sampleIndex,probes:a.probes},
      };
    }

    // ---------- 14. 非法/越界输入被夹到可编辑范围，不抛错 ----------
    {
      const result=mod.resolvePlacement({
        from:{direction:720,tilt:-30,height:1.5},
        to:{direction:-90,tilt:999,height:-9},
        build,occupants:[],kind:'main',
      });
      const clean={direction:result.pose.direction,tilt:result.pose.tilt,height:result.pose.height};
      out.bounds={
        pose:clean,
        reason:result.reason,
        inRange:
          clean.direction>=0&&clean.direction<360&&
          clean.tilt>=0&&clean.tilt<=55&&
          clean.height>=-0.05&&clean.height<=0.2,
        sanitized:mod.sanitizePose({direction:360,tilt:60,height:0.5}),
      };
    }

    return out;
  });

  const u=unit;

  // ---------- 断言 ----------
  check('两朵同类花：from 位置本身有效（基线）',u.sameSpot.fromValid===true,u.sameSpot.fromOverlap);
  check('两朵同类花：请求同位被挡，不原样落位',
    u.sameSpot.result.valid===true&&u.sameSpot.result.clamped===true&&u.sameSpot.result.reason!=='free',
    u.sameSpot.result);
  check('两朵同类花：停在允许的间隙外（中心距 ≥ reach − rim）',
    u.sameSpot.result.centerDistances[0]>=0.1+0.1-u.sameSpot.allowedRim-1e-6,
    {centerDistance:u.sameSpot.result.centerDistances[0],required:0.2-u.sameSpot.allowedRim});
  check('两朵同类花：核心穿透不超过 limits.core',
    u.sameSpot.result.core<=u.sameSpot.allowedCore+1e-9,{core:u.sameSpot.result.core,limit:u.sameSpot.allowedCore});
  check('两朵同类花：被挡住后仍在路径中途（sampleIndex 1..23）',
    u.sameSpot.result.sampleIndex>=1&&u.sameSpot.result.sampleIndex<=23,{sampleIndex:u.sameSpot.result.sampleIndex});

  check('三朵夹挤：from 位置本身有效',u.squeeze.fromValid===true,u.squeeze.fromOverlap);
  check('三朵夹挤：请求位被挡，结果仍有效',u.squeeze.result.valid===true&&u.squeeze.result.clamped===true,u.squeeze.result);
  check('三朵夹挤：core 不超 limits.core',u.squeeze.result.core<=envelopeLimit('main').core+1e-9,{core:u.squeeze.result.core});
  check('三朵夹挤：外缘交叠不超过 limits.rim（花瓣允许小范围接触）',
    u.squeeze.result.rim<=envelopeLimit('main').rim+1e-9,{rim:u.squeeze.result.rim,limit:envelopeLimit('main').rim});
  check('三朵夹挤：没落到中间那朵花心里',
    u.squeeze.result.centerDistances[2]>=0.2-0.018-1e-6,{distance:u.squeeze.result.centerDistances[2]});

  check('同枝多球：ownStemId 跳过自己的包络',u.multiHead.sameStemSkipped.valid===true,u.multiHead.sameStemSkipped);
  check('同枝多球：跨枝同一个位置被判定重叠',u.multiHead.crossStem.valid===false,u.multiHead.crossStem);
  check('同枝多球：多头候选任意一枚碰上都无效',u.multiHead.multiCandidateBlocked.valid===false,u.multiHead.multiCandidateBlocked);
  check('同枝多球：自己的两枚球之间不互算',u.multiHead.ownVolumesDoNotSelfCollide.valid===true,u.multiHead.ownVolumesDoNotSelfCollide);

  check('完全同心：目标位姿确实无效',u.concentric.targetInvalid===true,u.concentric.result);
  check('完全同心：新枝（from=null）不会返回无效位',
    u.concentric.result.valid===true,u.concentric.result);
  check('完全同心：结果离开了别人花心（位姿原样返回不算）',
    u.concentric.result.poseDistance>0&&u.concentric.result.clamped===true,u.concentric.result);

  check('快速横穿：from 位置本身有效',u.crossing.fromValid===true,u.crossing.result);
  check('快速横穿：没有从一朵花穿到另一边（结果留在起始一侧）',
    u.crossing.crossedToFarSide===false,{center:u.crossing.result.center,startZ:u.crossing.startZ,endZ:u.crossing.endZ});
  check('快速横穿：停在中间有效位，核心/外缘都在允许范围内',
    u.crossing.result.valid===true&&u.crossing.result.core<=0.006+1e-9,u.crossing.result);
  check('快速横穿：与阻挡花头保持 clearance（≥ reach − rim）',
    u.crossing.result.centerDistances[0]>=u.crossing.requiredClearance-1e-6,
    {distance:u.crossing.result.centerDistances[0],required:u.crossing.requiredClearance});
  check('快速横穿：没有走到目标位（位姿距离 > 50）',
    u.crossing.result.poseDistance>50,{poseDistance:u.crossing.result.poseDistance,result:u.crossing.result});

  check('向中心拖：结果有效且没有塌进中心',u.inward.result.valid===true&&u.inward.result.pose.tilt>4+1e-6,u.inward.result);
  check('向中心拖：与中心花保持 clearance',
    u.inward.result.centerDistances[0]>=0.2-0.018-1e-6,{distance:u.inward.result.centerDistances[0]});

  check('向外拖：目标本身有效 → 原样落位（reason free、clamped false）',
    u.outward.result.reason==='free'&&u.outward.result.clamped===false&&u.outward.fromValid===true,u.outward.result);

  check('from 已重叠：原姿态确实无效',u.alreadyOverlapping.fromValid===false,u.alreadyOverlapping.fromOverlap);
  check('from 已重叠：结果不比原来差（不变差）',u.alreadyOverlapping.delta.worse===false,u.alreadyOverlapping.delta);
  check('from 已重叠：能沿路径找到有效位（不被锁死）',u.alreadyOverlapping.result.valid===true,u.alreadyOverlapping.result);

  check('无空间：结果不比原来差',u.noSpace.delta.worse===false,u.noSpace.delta);
  check('无空间：不返回已知更差的位置（core/rim 都不增大）',
    u.noSpace.result.core<=u.noSpace.fromOverlap.core+1e-4&&u.noSpace.result.rim<=u.noSpace.fromOverlap.rim+1e-4,
    {result:u.noSpace.result,from:u.noSpace.fromOverlap});

  check('目标被塞满：结果仍有效（停在边界）',u.packed.result.valid===true,u.packed.result);
  check('目标被塞满：core/rim 都在允许范围内',
    u.packed.result.core<=envelopeLimit('main').core+1e-9&&u.packed.result.rim<=envelopeLimit('main').rim+1e-9,
    {core:u.packed.result.core,rim:u.packed.result.rim});

  check('limits：rim 交叠 2cm 时主花判定无效（主花 rim 1.8cm）',
    u.limits.mainVsGreenery.valid===false&&Math.abs(u.limits.rimOverlap-0.02)<1e-3,u.limits);
  check('limits：同样 2cm 交叠绿叶对绿叶有效（绿叶 rim 4.5cm）',
    u.limits.greeneryVsGreenery.valid===true,u.limits.greeneryVsGreenery);
  check('limits：额外上限收紧后同样位置判无效',u.limits.tightened.valid===false,u.limits.tightened);
  check('overlapDelta：变差/变好/容差内都判对',
    u.overlapDelta.worse.worse===true&&u.overlapDelta.better.worse===false&&u.overlapDelta.tiny.worse===false,
    u.overlapDelta);

  check('形状：24 步扫掠',u.shape.sweepSteps===24,u.shape.sweepSteps);
  check('形状：滑动候选含方向/高度/tilt/径向往外（≥ 189 个）',u.shape.slideCandidates>=189,{count:u.shape.slideCandidates});

  check('性能：20 枝场景一次 resolve 平均 < 5ms（free 路径）',
    u.perf.free.avgMs<5,{avg:u.perf.free.avgMs,max:u.perf.free.maxMs});
  check('性能：20 枝场景一次 resolve 平均 < 5ms（被挡路径）',
    u.perf.blocked.avgMs<5,{avg:u.perf.blocked.avgMs,max:u.perf.blocked.maxMs});
  check('性能：20 枝场景一次 resolve 平均 < 5ms（新枝无 from）',
    u.perf.noFrom.avgMs<5,{avg:u.perf.noFrom.avgMs,max:u.perf.noFrom.maxMs});

  check('多头候选：只有一枚球会撞上也判整枝被挡（不只看最大那枚）',
    u.multiResolve.fromValid===true&&u.multiResolve.targetInvalid===true&&
    u.multiResolve.result.valid===true&&u.multiResolve.result.clamped===true,
    u.multiResolve);

  check('lockHeight：开启后结果高度严格等于目标高度（拖动不漂移）',
    u.lockHeight.locked.valid===true&&u.lockHeight.locked.pose.height===u.lockHeight.targetHeight,
    {target:u.lockHeight.targetHeight,result:u.lockHeight.locked.pose.height,valid:u.lockHeight.locked.valid});
  check('lockHeight：候选只做方向/tilt，数量少于默认（无高度偏移）',
    u.lockHeight.lockedCandidates<u.lockHeight.defaultCandidates,
    {locked:u.lockHeight.lockedCandidates,default:u.lockHeight.defaultCandidates});
  check('lockHeight：默认（不锁）仍允许高度偏移（精调/新增需要）',
    u.lockHeight.defaultCandidates>u.lockHeight.lockedCandidates,u.lockHeight);

  check('确定性：同一输入两次求解结果完全一致（无随机）',u.determinism.identical===true,u.determinism.a);
  check('纯函数：不改传入的 from/to/occupants',u.determinism.inputUnchanged===true,u.determinism);

  check('越界输入：结果姿态被夹到可编辑范围（direction 0-360 / tilt 0-55 / height -5-20cm）',
    u.bounds.inRange===true,u.bounds);
  check('sanitizePose：越界值夹紧',u.bounds.sanitized.direction===0&&u.bounds.sanitized.tilt===55&&Math.abs(u.bounds.sanitized.height-0.2)<1e-9,u.bounds.sanitized);

  check('页面无 JS 错误（单元阶段）',errors.length===0,errors);
  await page.screenshot({path:`${OUT}/unit.png`});

  // ==================== 场景集成：真实玩法路径 ====================
  // 断言口径：最终**文档姿态**的椭球包络 core 重叠必须为 0（花瓣外缘 rim 允许小交叠，
  // 那是 limits.rim 的设计空间）。旧 6/12/20 样束 fixture 单列压力用例，允许 core>0。
  const wait=ms=>page.waitForTimeout(ms);
  const CORE_EPS=0.006;
  const docState=()=>exec(()=>window.__bouquetDebug.getState());
  const measure=(target=page)=>target.evaluate(async()=>{
    const env=await import('/src/three/envelope.ts');
    const state=window.__bouquetDebug.scene.getEnvelopeState();
    const perStem={};
    for(const stem of state.stems)perStem[stem.stemId]={core:0,rim:0};
    let worstPair=null;
    for(let i=0;i<state.stems.length;i+=1){
      for(let j=i+1;j<state.stems.length;j+=1){
        const a=state.stems[i],b=state.stems[j];
        const limits={core:Math.min(env.limitsFor(a.kind).core,env.limitsFor(b.kind).core),rim:Math.min(env.limitsFor(a.kind).rim,env.limitsFor(b.kind).rim)};
        for(const va of a.volumes){
          for(const vb of b.volumes){
            const overlap=env.overlapBetween(va,vb);
            perStem[a.stemId].core=Math.max(perStem[a.stemId].core,overlap.core);
            perStem[b.stemId].core=Math.max(perStem[b.stemId].core,overlap.core);
            perStem[a.stemId].rim=Math.max(perStem[a.stemId].rim,overlap.rim);
            perStem[b.stemId].rim=Math.max(perStem[b.stemId].rim,overlap.rim);
            if(!worstPair||overlap.core>worstPair.core){
              worstPair={a:a.stemId,b:b.stemId,aKind:a.kind,bKind:b.kind,core:overlap.core,rim:overlap.rim,limits};
            }
          }
        }
      }
    }
    return {
      sizeCandidate:state.sizeCandidate,
      assetsVersion:state.assetsVersion,
      stemCount:state.stems.length,
      worst:state.worst,
      perStem,
      worstPair,
      stems:state.stems.map(stem=>({stemId:stem.stemId,assetId:stem.assetId,kind:stem.kind,scale:stem.scale,pose:stem.pose,contact:stem.contact})),
    };
  });

  const gameplaySteps=[];
  function recordStep(label,m){
    gameplaySteps.push({label,stemCount:m.stemCount,core:m.worst.core,rim:m.worst.rim,valid:m.worst.valid,overlappingPairs:m.worst.overlappingPairs,worstPair:m.worstPair});
    const coreOffenders=Object.entries(m.perStem).filter(([,value])=>value.core>1e-6).map(([id,value])=>({id,core:value.core}));
    check(`${label}：文档姿态 core 重叠 = 0`,m.worst.core<=1e-9&&coreOffenders.length===0,
      {core:m.worst.core,offenders:coreOffenders,valid:m.worst.valid,worstPair:m.worstPair});
    check(`${label}：包络判定在允许范围（valid）`,m.worst.valid===true,
      {core:m.worst.core,rim:m.worst.rim,worstPair:m.worstPair});
  }

  await page.waitForFunction(()=>Boolean(window.__bouquetDebug),null,{timeout:15000});
  await page.waitForFunction(()=>window.__bouquetDebug.getState().catalogStatus==='manifest',null,{timeout:20000});
  await wait(1000);
  const catalog=await exec(()=>{
    const state=window.__bouquetDebug.getState();
    return state.catalog.entries.map(entry=>({assetId:entry.assetId,kind:entry.kind,family:entry.family??''}));
  });
  const mainEntry=catalog.find(entry=>entry.kind==='main')??catalog[0];
  check('集成：真实清单已加载（manifest）',Boolean(mainEntry),{count:catalog.length,sample:catalog.slice(0,6)});

  await exec(()=>{
    const d=window.__bouquetDebug;
    d.store.clearStems();
    d.store.setStage('arrange');
  });
  await wait(700);
  check('集成：空工作台 0 枝（干净起点）',(await docState()).doc.stems.length===0,{count:(await docState()).doc.stems.length});

  const canvasBox=await page.evaluate(()=>{
    const canvas=document.querySelector('canvas');
    const rect=canvas.getBoundingClientRect();
    return {x:rect.x,y:rect.y,w:rect.width,h:rect.height};
  });
  const addAt=async(nx,ny)=>{
    // V14 花材架：颜色点只在花材被选中后展开，先点花材卡再点对应色点。
    await page.click(`[data-testid="palette-${mainEntry.family}"]`);
    await wait(180);
    const dot=page.locator(`[data-testid="palette-${mainEntry.assetId}"]`);
    if(await dot.count())await dot.click();
    await wait(180);
    const x=canvasBox.x+canvasBox.w*nx;
    const y=canvasBox.y+canvasBox.h*ny;
    await page.mouse.move(x,y);
    await wait(520);
    await page.mouse.click(x,y);
    await wait(700);
    return (await docState()).doc.stems.length;
  };

  // ---------- 1. 添加 ----------
  const addCounts=[];
  for(const [nx,ny] of [[0.50,0.46],[0.44,0.50],[0.56,0.50],[0.50,0.55]]){
    const count=await addAt(nx,ny);
    addCounts.push(count);
    await recordStep(`添加第 ${count} 枝`,await measure());
  }
  check('添加：4 次点击各放下一枝（1→4）',addCounts.join(',')==='1,2,3,4',{addCounts});

  // ---------- 2. 复制 ----------
  const duplicate=await exec(()=>{
    const d=window.__bouquetDebug;
    const source=d.getState().doc.stems[0];
    const id=d.store.duplicateStem(source.id);
    return {sourceId:source.id,id};
  });
  await wait(750);
  const afterDuplicate=await docState();
  check('复制：新增一枝且总数 5',duplicate.id!==null&&afterDuplicate.doc.stems.length===5,
    {duplicate,count:afterDuplicate.doc.stems.length});
  await recordStep('复制',await measure());

  const dragStem=async(stemId,dx,dy,{steps=10}={})=>{
    const point=await exec(({id})=>window.__bouquetDebug.getStemScreenPoint(id),{id:stemId});
    if(!point||!point.visible)throw Error(`花枝 ${stemId} 不在屏幕上`);
    await page.mouse.move(point.x,point.y);
    await wait(150);
    await page.mouse.down();
    await page.mouse.move(point.x+dx,point.y+dy,{steps});
    await page.mouse.up();
    await wait(750);
    return point;
  };

  /**
   * 挑一枚在屏幕上离别的花头最远、且**锚点射线检测确实命中自己**的花枝。
   *
   * V9 换成真实 GLB 后花瓣比 `headRadius` 铺得更宽：纯按「锚点间距最大」挑，
   * pointerdown 可能落到邻居的花瓣上而选中邻居（这不是约束/拖动逻辑的问题，
   * 而是测试挑点不够稳）。这里用场景自己的 pickStem 复核像素归属，再决定拖谁；
   * 断言阈值（间距 > 40px、选中的是目标枝）都不放松。
   */
  const pickIsolatedStem=()=>exec(()=>{
    const d=window.__bouquetDebug;
    const pick=(x,y)=>typeof d.scene.pickStem==='function'?d.scene.pickStem(x,y):null;
    const points=d.getState().doc.stems.map(stem=>{
      const point=d.getStemScreenPoint(stem.id);
      return {id:stem.id,x:point?.x??0,y:point?.y??0,visible:Boolean(point?.visible)};
    }).filter(point=>point.visible);
    const scored=points.map(point=>{
      let gap=Number.POSITIVE_INFINITY;
      for(const other of points){
        if(other.id===point.id)continue;
        gap=Math.min(gap,Math.hypot(other.x-point.x,other.y-point.y));
      }
      const hit=pick(point.x,point.y);
      return {...point,gap,hit,hitSelf:hit===point.id};
    }).sort((a,b)=>b.gap-a.gap);
    return scored.find(item=>item.hitSelf)??scored[0]??null;
  });

  // ---------- 3. 拖动（普通 + 快速横穿） ----------
  const dragPick=await pickIsolatedStem();
  check('拖动：找到一枚可抓取的花枝（屏幕分离度够）',Boolean(dragPick)&&dragPick.gap>40,{dragPick});
  const beforeDragPose=(await docState()).doc.stems.find(stem=>stem.id===dragPick.id).pose;
  await dragStem(dragPick.id,150,-18,{steps:12});
  const afterDragDoc=await docState();
  const dragged=afterDragDoc.doc.stems.find(stem=>stem.id===dragPick.id);
  check('拖动：pointerdown 抓到的是目标花枝（selectedId 一致）',afterDragDoc.selectedId===dragPick.id,
    {selectedId:afterDragDoc.selectedId,target:dragPick.id});
  check('拖动：姿态确实变了（指针拖动生效）',
    Boolean(dragged)&&(Math.abs(dragged.pose.tilt-beforeDragPose.tilt)>0.5||Math.abs(dragged.pose.direction-beforeDragPose.direction)>0.5),
    {before:beforeDragPose,after:dragged?.pose??null});
  await recordStep('拖动（普通）',await measure());
  // 观察项（不是断言）：指针拖动只有 tilt/direction 两个自由度，滑动候选里的 ±1/2/3cm
  // 高度偏移会随每次 pointermove 累积，表现为拖动中花枝慢慢「长高」。
  // 已在 placement.ts 提供 lockHeight（默认关闭，不影响现有接线），
  // 接线侧在 updateDrag 传 lockHeight: true（或把 result.pose.height 还原）即可消除。
  const dragHeightDrift={
    before:+(beforeDragPose.height.toFixed(4)),
    after:+((dragged?.pose.height??NaN).toFixed(4)),
    delta:+(((dragged?.pose.height??NaN)-beforeDragPose.height).toFixed(4)),
  };
  console.log('drag height drift',dragHeightDrift);

  const crossPick=await pickIsolatedStem();
  const crossBefore=(await measure()).stems.find(stem=>stem.stemId===crossPick.id);
  await dragStem(crossPick.id,-280,12,{steps:4});
  const crossAfterDoc=await docState();
  const crossed=await measure();
  const crossAfter=crossed.stems.find(stem=>stem.stemId===crossPick.id);
  check('拖动（快速横穿）：pointerdown 抓到的是目标花枝',crossAfterDoc.selectedId===crossPick.id,
    {selectedId:crossAfterDoc.selectedId,target:crossPick.id});
  check('拖动（快速横穿）：拖动生效（姿态变化）',
    Boolean(crossAfter)&&(Math.abs(crossAfter.pose.direction-crossBefore.pose.direction)>0.5||Math.abs(crossAfter.pose.tilt-crossBefore.pose.tilt)>0.5),
    {before:crossBefore.pose,after:crossAfter?.pose??null});
  gameplaySteps.push({label:'拖动（快速横穿）',stemCount:crossed.stemCount,core:crossed.worst.core,rim:crossed.worst.rim,valid:crossed.worst.valid,overlappingPairs:crossed.worst.overlappingPairs,worstPair:crossed.worstPair});
  const crossOffenders=Object.entries(crossed.perStem).filter(([,value])=>value.core>1e-6).map(([id,value])=>({id,core:value.core}));
  check('拖动（快速横穿）：文档姿态 core 重叠 = 0',crossed.worst.core<=1e-9&&crossOffenders.length===0,
    {core:crossed.worst.core,offenders:crossOffenders,worstPair:crossed.worstPair});
  check('拖动（快速横穿）：包络判定在允许范围（valid）',crossed.worst.valid===true,{core:crossed.worst.core,rim:crossed.worst.rim});

  // ---------- 4. 精调 ----------
  const nudgeTarget=(await docState()).doc.stems[3];
  await exec(({id})=>window.__bouquetDebug.store.select(id),{id:nudgeTarget.id});
  await wait(150);
  const nudgeBefore=(await docState()).doc.stems.find(stem=>stem.id===nudgeTarget.id).pose;
  for(let i=0;i<5;i+=1){
    await exec(()=>window.__bouquetDebug.store.nudgeSelected({direction:18,tilt:2}));
    await wait(180);
  }
  const nudgeAfter=(await docState()).doc.stems.find(stem=>stem.id===nudgeTarget.id).pose;
  check('精调：微调确实改到姿态（或按约束停在原地）',
    Math.abs(nudgeAfter.direction-nudgeBefore.direction)>0.5||Math.abs(nudgeAfter.tilt-nudgeBefore.tilt)>0.5,
    {before:nudgeBefore,after:nudgeAfter});
  await recordStep('精调 5 次',await measure());

  // ---------- 5. 缩放 ----------
  const scaleTarget=(await docState()).doc.stems[4];
  const scaleBefore=scaleTarget.scale;
  await exec(({id})=>window.__bouquetDebug.store.updateStemScaleTransient(id,1.15),{id:scaleTarget.id});
  await wait(600);
  const scaleAfter=(await docState()).doc.stems.find(stem=>stem.id===scaleTarget.id).scale;
  check('缩放：放大被约束在合法范围（≤ 1.15 且 ≥ 原值）',
    scaleAfter<=1.15+1e-9&&scaleAfter>=scaleBefore-1e-9&&Number.isFinite(scaleAfter),
    {before:scaleBefore,after:scaleAfter});
  await recordStep('缩放（放大到 1.15）',await measure());

  // ---------- 6. 撤销 / 重做 ----------
  const historyBefore=await docState();
  await exec(()=>window.__bouquetDebug.store.undo());
  await wait(600);
  const undoDoc=await docState();
  check('撤销：文档确实回退（历史生效）',undoDoc.pastCount<historyBefore.pastCount||undoDoc.doc.updatedAt!==historyBefore.doc.updatedAt,
    {pastBefore:historyBefore.pastCount,pastAfter:undoDoc.pastCount});
  await recordStep('撤销',await measure());

  await exec(()=>window.__bouquetDebug.store.redo());
  await wait(600);
  const redoDoc=await docState();
  check('重做：文档回到撤销前',redoDoc.doc.stems.length===historyBefore.doc.stems.length,
    {redoStems:redoDoc.doc.stems.length,beforeStems:historyBefore.doc.stems.length});
  await recordStep('重做',await measure());

  // ---------- 7. 保存 / 恢复（相册往返，尺寸语义不变） ----------
  const saved=await page.evaluate(async()=>{
    const d=window.__bouquetDebug;
    const thumbnail=await d.captureThumbnail();
    const entry=d.store.saveToAlbum(thumbnail,'v07-placement');
    return entry
      ? {id:entry.id,count:entry.doc.stems.length,stems:entry.doc.stems.map(stem=>({id:stem.id,pose:stem.pose,scale:stem.scale,assetId:stem.assetId}))}
      : null;
  });
  check('保存：作品写入相册且记录花枝',saved!==null&&typeof saved.id==='string'&&saved.stems.length===historyBefore.doc.stems.length,
    saved?{id:saved.id,count:saved.stems.length}:null);
  await exec(()=>window.__bouquetDebug.store.clearStems());
  await wait(600);
  check('保存恢复：清空后确实是 0 枝（避免假恢复）',(await docState()).doc.stems.length===0,{count:(await docState()).doc.stems.length});
  await exec(({id})=>window.__bouquetDebug.store.openAlbumEntry(id),{id:saved.id});
  await wait(1400);
  const restored=await measure();
  await recordStep('保存恢复',restored);
  check('保存恢复：花枝数量与保存时一致',restored.stemCount===saved.stems.length,
    {restored:restored.stemCount,saved:saved.stems.length});
  const restoredMap=new Map(restored.stems.map(stem=>[stem.stemId,stem]));
  const poseMismatch=saved.stems.filter(stem=>{
    const now=restoredMap.get(stem.id);
    return !now||Math.abs(now.pose.tilt-stem.pose.tilt)>1e-6||Math.abs(now.pose.direction-stem.pose.direction)>1e-6||
      Math.abs(now.pose.height-stem.pose.height)>1e-6||Math.abs(now.scale-stem.scale)>1e-6;
  }).map(stem=>stem.id);
  check('保存恢复：逐枝姿态/缩放与保存时一致（尺寸语义不变）',poseMismatch.length===0,{mismatch:poseMismatch});
  await page.screenshot({path:`${OUT}/integration-final.png`});

  // ---------- 8. 压力用例：旧 6 / 12 / 20 枝样束（fixture 自带重叠，不算玩法失败） ----------
  const stress=[];
  for(const sampleSize of [6,12,20]){
    const stressPage=await context.newPage();
    const stressErrors=[];
    stressPage.on('pageerror',error=>stressErrors.push(error.message));
    await stressPage.goto(`${BASE}?sample=${sampleSize}&size=b`,{waitUntil:'domcontentloaded'});
    await stressPage.waitForFunction(()=>window.__bouquetDebug?.getState().catalogStatus==='manifest',null,{timeout:20000});
    await stressPage.waitForFunction((count)=>window.__bouquetDebug.getState().doc.stems.length===count,sampleSize,{timeout:20000});
    await stressPage.waitForTimeout(1800);
    const state=await measure(stressPage);
    stress.push({size:sampleSize,stemCount:state.stemCount,core:state.worst.core,rim:state.worst.rim,valid:state.worst.valid,overlappingPairs:state.worst.overlappingPairs,worstPair:state.worstPair,pageErrors:stressErrors});
    await stressPage.screenshot({path:`${OUT}/stress-sample-${sampleSize}.png`});
    await stressPage.close();
  }
  for(const item of stress){
    check(`压力用例：旧 ${item.size} 枝样束可测量（${item.stemCount} 枝）`,
      item.stemCount===item.size&&Number.isFinite(item.core)&&item.pageErrors.length===0,
      {size:item.size,stemCount:item.stemCount,core:item.core,pagesErrors:item.pageErrors});
  }
  console.log('stress cores',stress.map(item=>({size:item.size,core:item.core,rim:item.rim,valid:item.valid,pairs:item.overlappingPairs})));

  check('场景集成：全程无页面 JS 错误',errors.length===0,errors);

  writeFileSync(`${OUT}/results.json`,JSON.stringify({
    date:new Date().toISOString(),
    passed,
    checks,
    unit,
    integration:{
      status:'done',
      coreEpsilon:CORE_EPS,
      gameplaySteps,
      stress,
      dragHeightDrift,
      note:'core = 核心椭球穿透深度（米），rim = 完整椭球穿透深度；包络重叠≠花瓣网格穿模。旧 6/12/20 样束 fixture 单独列为压力用例，允许 core>0。',
      knownIssues:[
        '指针拖动时滑动候选会带 ±1/2/3cm 高度偏移，连续 pointermove 会累积成高度漂移（观察值见 dragHeightDrift）；placement.ts 已有 lockHeight 开关，需接线侧在 updateDrag 传入。',
      ],
    },
    errors,
  },null,2));
  console.log(`PASSED ${passed}`);
}catch(error){
  writeFileSync(`${OUT}/failure.json`,JSON.stringify({date:new Date().toISOString(),passed,checks,error:String(error),errors},null,2));
  throw error;
}finally{
  await browser.close();
}

/** 主花宽容度（与 envelope.ts 同步的验收口径，避免脚本里出现魔法数）。 */
function envelopeLimit(kind){
  return kind==='greenery'?{core:0.012,rim:0.045}:kind==='filler'?{core:0.006,rim:0.028}:{core:0.006,rim:0.018};
}
