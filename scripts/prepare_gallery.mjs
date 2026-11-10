import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {MeshoptSimplifier} from '../app/node_modules/meshoptimizer/index.js';
const [inputPath,id,diffusePath]=process.argv.slice(2);
if(!inputPath||!/^[a-z-]+$/.test(id??''))throw Error('Usage: node scripts/prepare_gallery.mjs INPUT.glb ID');
const out=`assets/local/gallery-20261107/processed/${id}`;mkdirSync(out,{recursive:true});
const input=readFileSync(inputPath),n=input.readUInt32LE(12),source=JSON.parse(input.subarray(20,20+n)),bin=input.subarray(28+n);
if(source.meshes.length!==1||source.meshes[0].primitives.length!==1||source.nodes.filter(n=>n.mesh!==undefined).length!==1||source.nodes.some(n=>n.matrix||n.translation||n.rotation||n.scale))throw Error('Expected single untransformed mesh');
const primitive=source.meshes[0].primitives[0];
function read(id,Type){const a=source.accessors[id],v=source.bufferViews[a.bufferView];if(v.byteStride)throw Error('Interleaved input unsupported');return new Type(bin.buffer,bin.byteOffset+(v.byteOffset??0)+(a.byteOffset??0),a.count*({SCALAR:1,VEC2:2,VEC3:3}[a.type]));}
const p=read(primitive.attributes.POSITION,Float32Array),norm=read(primitive.attributes.NORMAL,Float32Array),uv=read(primitive.attributes.TEXCOORD_0,Float32Array),a=source.accessors[primitive.indices],idx=read(primitive.indices,a.componentType===5125?Uint32Array:Uint16Array);
for(let i=0;i<source.images.length;i++){const v=source.bufferViews[source.images[i].bufferView];writeFileSync(`${out}/texture-${i}.png`,bin.subarray(v.byteOffset??0,(v.byteOffset??0)+v.byteLength));}
if(diffusePath){writeFileSync(`${out}/texture-0.png`,readFileSync(diffusePath));source.materials=[{pbrMetallicRoughness:{baseColorFactor:[1,1,1,1],baseColorTexture:{index:0},metallicFactor:0,roughnessFactor:.85},doubleSided:false}];source.textures=[{source:0}];source.images=source.images.slice(0,1);}
const encode=spawnSync('python',['-c',`from PIL import Image\nfrom pathlib import Path\np=Path('${out}')\nfor f in p.glob('texture-*.png'):\n im=Image.open(f).convert('RGB'); im.thumbnail((2048,2048),Image.Resampling.LANCZOS); im.save(f.with_suffix('.jpg'),quality=96,subsampling=0)\n`],{encoding:'utf8'});if(encode.status)throw Error(encode.stderr);
await MeshoptSimplifier.ready;
const attrs=new Float32Array(p.length/3*5);for(let i=0;i<p.length/3;i++){attrs.set(norm.subarray(i*3,i*3+3),i*5);attrs.set(uv.subarray(i*2,i*2+2),i*5+3);}
const [indices,error]=MeshoptSimplifier.simplifyWithAttributes(idx,p,3,attrs,5,[.25,.25,.25,1,1],null,Math.floor(idx.length*.55/3)*3,.002);
const [remap,count]=MeshoptSimplifier.compactMesh(indices),pieces=[],views=[],accessors=[];let offset=0;
function append(bytes,target){const b=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength),id=views.length;views.push({buffer:0,byteOffset:offset,byteLength:b.length,...(target?{target}:{})});const pad=(4-b.length%4)%4;pieces.push(b,Buffer.alloc(pad));offset+=b.length+pad;return id;}
const Type=count<=65535?Uint16Array:Uint32Array;
accessors.push({bufferView:append(Type.from(indices),34963),componentType:count<=65535?5123:5125,count:indices.length,type:'SCALAR',min:[0],max:[count-1]});
for(const [data,stride,type]of[[p,3,'VEC3'],[norm,3,'VEC3'],[uv,2,'VEC2']]){const compact=new Float32Array(count*stride);for(let old=0;old<remap.length;old++)if(remap[old]!==0xffffffff)compact.set(data.subarray(old*stride,old*stride+stride),remap[old]*stride);const min=Array(stride).fill(Infinity),max=Array(stride).fill(-Infinity);for(let i=0;i<count;i++)for(let c=0;c<stride;c++){min[c]=Math.min(min[c],compact[i*stride+c]);max[c]=Math.max(max[c],compact[i*stride+c]);}accessors.push({bufferView:append(compact,34962),componentType:5126,count,type,min,max});}
const images=source.images.map((_,i)=>({mimeType:'image/jpeg',bufferView:append(readFileSync(`${out}/texture-${i}.jpg`))}));
const model={asset:{version:'2.0',generator:'A Moment in Bloom gallery pipeline'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0,name:id}],meshes:[{primitives:[{attributes:{POSITION:1,NORMAL:2,TEXCOORD_0:3},indices:0,material:0}]}],materials:source.materials,textures:source.textures,samplers:source.samplers,images,accessors,bufferViews:views,buffers:[{byteLength:offset}],extras:{source:'Lux3D unified exhibit; not individually editable',optimization:{ratio:.55,error,textureMax:2048}}};
const s=Buffer.from(JSON.stringify(model)),json=Buffer.concat([s,Buffer.alloc((4-s.length%4)%4,32)]),binary=Buffer.concat(pieces),header=Buffer.alloc(12);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+binary.length,8);
const chunk=(length,type)=>{const b=Buffer.alloc(8);b.writeUInt32LE(length);b.write(type,4);return b;};
const result=Buffer.concat([header,chunk(json.length,'JSON'),json,chunk(binary.length,'BIN\0'),binary]);
mkdirSync('app/public/showcase',{recursive:true});writeFileSync(`app/public/showcase/${id}.glb`,result);
const hash=b=>createHash('sha256').update(b).digest('hex');const report={id,source:inputPath,sourceBytes:input.length,sourceTriangles:idx.length/3,bytes:result.length,triangles:indices.length/3,vertices:count,error,sourceSHA256:hash(input),sha256:hash(result),materialsPreserved:!diffusePath,externalDiffuse:diffusePath??null};writeFileSync(`${out}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
