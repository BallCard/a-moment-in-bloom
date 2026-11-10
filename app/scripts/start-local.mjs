import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import net from 'node:net';
import {resolve} from 'node:path';

// 花间一刻 · 本地合并启动：先探端口，再同时起 Vite 前端与评分服务；两个子进程一起退出。
// 子进程统一 stdio:'inherit'，输出直接继承终端（本环境不允许用管道捕获子进程输出）。
const appRoot=resolve(import.meta.dirname,'..');
const viteBin=resolve(appRoot,'node_modules/vite/bin/vite.js');
const serverScript=resolve(appRoot,'server/index.mjs');
const argValue=(name,fallback)=>{const flag=`--${name}`;const equal=process.argv.find(value=>value.startsWith(`${flag}=`));if(equal)return equal.slice(flag.length+1);const index=process.argv.indexOf(flag);return index>=0&&process.argv[index+1]?process.argv[index+1]:fallback;};
const webPort=Number(argValue('web-port',process.env.WEB_PORT??5173));
const apiPort=Number(argValue('api-port',process.env.PORT??8787));
const selfCheck=process.argv.includes('--check');
const stamp=()=>new Date().toLocaleTimeString('zh-CN',{hour12:false});
const log=message=>console.log(`[本地启动 ${stamp()}] ${message}`);

if(!Number.isInteger(webPort)||webPort<1||webPort>65535||!Number.isInteger(apiPort)||apiPort<1||apiPort>65535){console.error('端口必须是 1–65535 的整数：--web-port <端口>、--api-port <端口>。');process.exit(1);}
if(!existsSync(viteBin)||!existsSync(serverScript)){console.error(`缺少启动文件：${existsSync(viteBin)?serverScript:viteBin}。请先在 ${appRoot} 运行 npm install。`);process.exit(1);}

// 用实际监听测试判断端口是否空闲，不依赖平台命令输出。
const probePort=port=>new Promise(done=>{
  const tester=net.createServer();
  tester.once('error',error=>done({port,free:false,code:error.code}));
  tester.once('listening',()=>tester.close(()=>done({port,free:true})));
  tester.listen({port,host:'127.0.0.1',exclusive:true});
});

log(`检查端口：前端 ${webPort}、评分服务 ${apiPort}……`);
const [webProbe,apiProbe]=await Promise.all([probePort(webPort),probePort(apiPort)]);
if(!webProbe.free||!apiProbe.free){
  for(const {port,code,free,label} of [{port:webPort,code:webProbe.code,free:webProbe.free,label:'前端'},{port:apiPort,code:apiProbe.code,free:apiProbe.free,label:'评分服务'}]){
    if(!free)log(`端口 ${port} 已被占用（${code==='EADDRINUSE'?'已有进程在监听':'监听测试失败：'+code}），${label}无法启动。`);
  }
  log('常见原因：上一次 npm run dev / npm run server / npm run dev:all 没有退出，或别的程序占着这个端口。');
  for(const {port,free} of [{port:webPort,free:webProbe.free},{port:apiPort,free:apiProbe.free}])if(!free)log(`查看端口 ${port} 的占用进程：Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -ExpandProperty OwningProcess；确认后 Stop-Process -Id <PID>。`);
  if(!webProbe.free)log(`换端口：npm run dev:all -- --web-port ${webPort===5173?5190:webPort+1}（若这个端口也被占用，继续换一个）。`);
  if(!apiProbe.free)log(`换端口：npm run dev:all -- --api-port ${apiPort+1}（注意 vite.config.ts 的 /api 代理固定指向 8787，改评分端口后页面点评会失效，需同步改代理）。`);
  log('已中止，没有启动任何子进程。');
  process.exit(1);
}

const children=[],exited=new Set();
let stopping=false,stopCode=0;
const stop=(code,note)=>{
  if(stopping)return;
  stopping=true;stopCode=code;
  if(note)log(note);
  if(children.length)log('正在停止前端与评分服务……');
  for(const child of children){try{if(!exited.has(child))child.kill();}catch(error){log(`停止子进程失败：${error.message}`);}}
  const guard=setTimeout(()=>{log('子进程 5 秒内没有全部退出，强制结束本地启动。');process.exit(stopCode||1);},5000);
  guard.unref();
};
const maybeFinish=()=>{
  if(exited.size<children.length)return;
  log(`两个子进程都已停止，本地启动退出（退出码 ${stopCode}）。`);
  // 不用 process.exit：Windows 上在子进程句柄关闭过程中强制退出会触发 libuv 断言，这里让事件循环自然结束。
  process.exitCode=stopCode;
  const fallback=setTimeout(()=>process.exit(stopCode),3000);
  fallback.unref();
};
const onChildExit=(label,child,code,signal)=>{
  if(exited.has(child))return;
  exited.add(child);
  const reason=signal?`收到信号 ${signal}`:`退出码 ${code??'未知'}`;
  if(stopping)log(`${label}已退出（${reason}）。`);
  else stop(code===0?1:code??1,`${label}意外退出（${reason}），正在停止另一个进程。作品仍可保存，但请查看上方日志定位原因。`);
  maybeFinish();
};
const spawnChild=(label,args,env)=>{
  const child=spawn(process.execPath,args,{cwd:appRoot,stdio:'inherit',env:{...process.env,...env}});
  child.on('exit',(code,signal)=>onChildExit(label,child,code,signal));
  child.on('error',error=>{exited.add(child);stop(1,`${label}启动失败：${error.message}`);maybeFinish();});
  children.push(child);return child;
};
const handleSignal=name=>{log(`收到 ${name}，准备一起停止……`);stop(0);};
process.on('SIGINT',()=>handleSignal('SIGINT'));
process.on('SIGTERM',()=>handleSignal('SIGTERM'));
if(process.platform==='win32')process.on('SIGBREAK',()=>handleSignal('SIGBREAK'));

log('端口空闲，开始启动……');
console.log('──────────────────────────────────────────');
console.log(`  前端：      http://127.0.0.1:${webPort}/`);
console.log(`  评分服务：  http://127.0.0.1:${apiPort}/api/health（页面内点评经 Vite 代理 /api 转发）`);
console.log(`  按 Ctrl+C 同时停止两个进程。${selfCheck?'（--check：就绪后自动停止）':''}`);
console.log('──────────────────────────────────────────');
if(apiPort!==8787)log(`注意：vite.config.ts 的 /api 代理固定指向 8787，评分服务改用 ${apiPort} 后页面里的点评请求仍会打到 8787。`);
if(process.env.NODE_ENV==='production')log('注意：当前 NODE_ENV=production，评分服务会监听 0.0.0.0 且不读取本机密钥文件。');

spawnChild('评分服务',[serverScript],{PORT:String(apiPort)});
spawnChild('前端',[viteBin,'--port',String(webPort),'--strictPort']);

const waitFor=async(url,timeoutMs)=>{
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline&&!stopping){
    try{const response=await fetch(url,{signal:AbortSignal.timeout(1500)});if(response.ok)return response;}catch{}
    await new Promise(done=>setTimeout(done,250));
  }
  return null;
};
const healthResponse=await waitFor(`http://127.0.0.1:${apiPort}/api/health`,10000);
if(!healthResponse)stop(1,'评分服务 10 秒内没有响应健康检查，请查看上方评分服务日志。');
else{
  const health=await healthResponse.json().catch(()=>({}));
  log(`评分服务已就绪：服务${health.service==='up'?'在线':'状态未知'}，凭据${health.credentials==='configured'?'已配置':'未配置（点评会提示未配置，作品仍可保存）'}，模型未探测（健康检查不调用上游）。版本 ${health.version??'未知'}。`);
}
if(!stopping){
  const webResponse=await waitFor(`http://127.0.0.1:${webPort}/`,15000);
  if(!webResponse)stop(1,'前端 15 秒内没有就绪，请查看上方 Vite 日志（端口可能刚被占用）。');
  else{await webResponse.text().catch(()=>{});log(`前端已就绪：http://127.0.0.1:${webPort}/`);}
}
if(!stopping){
  if(selfCheck)stop(0,'自检模式：前端与评分服务都已就绪，正在一起停止（--check）。');
  else log('两个进程都已在运行；按 Ctrl+C 一起停止。');
}
