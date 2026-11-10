import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {homedir} from 'node:os';
import {serveStatic} from './static.mjs';
import {createReviewer} from './review.mjs';
import {createPolisher} from './polish.mjs';
let key=process.env.MODELSCOPE_API_KEY;
const keyFile=process.env.MODELSCOPE_API_KEY_FILE??resolve(homedir(),'.modelscope/api-key.txt');
if(!key&&process.env.NODE_ENV!=='production')try{key=(await readFile(keyFile,'utf8')).trim();}catch{}
const review=createReviewer({key});const polish=createPolisher({key});const root=resolve('dist');
let appVersion='0.0.0';try{appVersion=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version??appVersion;}catch{}
const host=process.env.NODE_ENV==='production'?'0.0.0.0':'127.0.0.1',port=Number(process.env.PORT??8787);
// 健康检查只报本地可见事实：服务在线、凭据是否配置、模型从未探测。不返回密钥，也不宣称上游模型可用。
const health={ok:true,service:'up',credentials:key?'configured':'missing',models:'not_probed',version:`${appVersion}${process.env.NODE_ENV==='production'?'':'-dev'}`};
const messages={not_configured:'尚未配置魔搭评分服务，作品可以照常保存。',busy:'正在评审，请稍后再试。',quota:'魔搭额度或频率暂时受限，请稍后再试。',invalid_input:'照片或作品资料格式不正确。'};
const polishMessages={not_configured:'尚未配置 AI 润色服务（服务端缺少凭据），正文可以照常手写。',busy:'正在润色，请稍后再试。',quota:'魔搭额度或频率暂时受限，请稍后再试；正文保持原样。',invalid_input:'要润色的文字格式不正确（可能太长）。',upstream:'润色服务暂时没有完成，正文保持原样。'};
const polishStatus={invalid_input:400,busy:429,quota:429,not_configured:503};
const allowedOrigins=['https://ballcard-bouquet-workbench.ms.show',...(process.env.NODE_ENV==='production'?[]:['http://127.0.0.1:5173','http://localhost:5173'])];
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.glb':'model/gltf-binary','.webp':'image/webp','.mp3':'audio/mpeg','.png':'image/png','.svg':'image/svg+xml'};
// /api/review 与 /api/polish 共用同一套来源校验：只允许同源或已知的嵌入/本地开发来源。
function fromTrustedOrigin(req){if(!req.headers.origin)return true;try{const origin=new URL(req.headers.origin);return origin.host===req.headers.host||allowedOrigins.includes(origin.origin);}catch{return false;}}
const server=http.createServer(async(req,res)=>{
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  if(req.url?.split('?')[0]==='/api/health'&&req.method==='GET')return send(200,health);
  if(req.url==='/api/review'&&req.method==='POST'){
    if(req.headers.origin&&!fromTrustedOrigin(req))return send(403,{error:'请求来源不受支持。'});
    let text='';try{for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>1300000)return send(413,{error:'照片过大。'});}let body;try{body=JSON.parse(text);}catch{return send(400,{error:'请求格式不正确。'});}return send(200,await review(body));}
    catch(error){const code=error.message;return send(code==='invalid_input'?400:code==='busy'||code==='quota'?429:503,{error:messages[code]??'评分暂时没有完成，请稍后重试。作品仍已保留。'});}
  }
  if(req.url==='/api/polish'&&req.method==='POST'){
    if(!fromTrustedOrigin(req))return send(403,{error:'请求来源不受支持。'});
    let text='';try{for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>16000)return send(413,{error:'要润色的文字过长。'});}let body;try{body=JSON.parse(text);}catch{return send(400,{error:'请求格式不正确。',code:'invalid_input'});}return send(200,await polish(body));}
    catch(error){const code=polishMessages[error.message]?error.message:'upstream';return send(polishStatus[code]??503,{error:polishMessages[code],code});}
  }
  if(req.url?.startsWith('/api/'))return send(404,{error:'接口不存在。'});
  if(req.method!=='GET'&&req.method!=='HEAD')return send(405,{error:'请求方法不受支持。'});
  try{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const path=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!path.startsWith(root+sep))return send(403,{error:'路径不可用。'});await serveStatic(req,res,path,pathname,mime);}catch{return send(404,{error:'文件不存在。'});}
});
server.requestTimeout=150000;
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`评分服务端口 ${port} 已被占用，请先停止占用进程再启动。`:`评分服务启动失败：${error.message}`);process.exit(1);});
server.listen(port,host,()=>console.log(`花艺评分服务已启动：http://${host==='0.0.0.0'?'127.0.0.1':host}:${port}/（健康检查 /api/health；凭据${key?'已配置':'未配置'}，模型未探测）。点评与润色凭据仅在服务端使用。`));
