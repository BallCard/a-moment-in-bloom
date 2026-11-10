/** Offline pipeline. Run from repo root after extracting result.zip to the review/raw directory. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {MeshoptSimplifier} from '../app/node_modules/meshoptimizer/index.js';
const dir='experiments/local/unified-model-review';
const study=process.argv.includes('--study');
const profiles=[['reference',1,1024],['balanced',.6,1024],['light',.35,1024],['detail',.6,2048],['detail-reference',1,2048]];
const input=readFileSync(`${dir}/raw/MODEL.glb`);
const jsonLength=input.readUInt32LE(12);
const source=JSON.parse(input.subarray(20,20+jsonLength));
const bin=input.subarray(28+jsonLength);
function readAccessor(id,Type){const a=source.accessors[id],v=source.bufferViews[a.bufferView];return new Type(bin.buffer,bin.byteOffset+(v.byteOffset??0)+(a.byteOffset??0),a.count*({SCALAR:1,VEC2:2,VEC3:3}[a.type]));}
const primitive=source.meshes[0].primitives[0];
const positions=readAccessor(primitive.attributes.POSITION,Float32Array),normals=readAccessor(primitive.attributes.NORMAL,Float32Array),uvs=readAccessor(primitive.attributes.TEXCOORD_0,Float32Array);
const originalIndices=readAccessor(primitive.indices,Uint32Array);
const attrs=new Float32Array(positions.length/3*5);
for(let i=0;i<positions.length/3;i++){attrs.set(normals.subarray(i*3,i*3+3),i*5);attrs.set(uvs.subarray(i*2,i*2+2),i*5+3);}
const compress=spawnSync('python',['-c',`from PIL import Image
from pathlib import Path
p=Path('${dir}')
im=Image.open(p/'raw/RawDiffuseFilter.png').convert('RGB')
im.resize((1024,1024),Image.Resampling.LANCZOS).save(p/'diffuse-1024.jpg',quality=90,subsampling=0)
im.save(p/'diffuse-2048.jpg',quality=96,subsampling=0)
`],{encoding:'utf8'});
if(compress.status!==0)throw Error(compress.stderr);
await MeshoptSimplifier.ready;
mkdirSync('app/public/showcase',{recursive:true});
const report=[];
for(const [label,ratio,textureSize] of profiles){
 const texture=readFileSync(`${dir}/diffuse-${textureSize}.jpg`);
 let indices,error=0;
 if(ratio===1)indices=originalIndices.slice();
 else [indices,error]=MeshoptSimplifier.simplifyWithAttributes(originalIndices,positions,3,attrs,5,[.25,.25,.25,1,1],null,Math.floor(originalIndices.length*ratio/3)*3,.003);
 const [remap,count]=MeshoptSimplifier.compactMesh(indices);
 const pieces=[],views=[],accessors=[];let offset=0;
 function append(bytes,target){const data=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);const id=views.length;views.push({buffer:0,byteOffset:offset,byteLength:data.length,...(target?{target}:{})});pieces.push(data);const pad=(4-data.length%4)%4;pieces.push(Buffer.alloc(pad));offset+=data.length+pad;return id;}
 const IndexType=count<=65535?Uint16Array:Uint32Array;
 const outIndices=IndexType.from(indices);const indexView=append(outIndices,34963);
 accessors.push({bufferView:indexView,componentType:count<=65535?5123:5125,count:indices.length,type:'SCALAR',min:[0],max:[count-1]});
 for(const [data,stride,type] of [[positions,3,'VEC3'],[normals,3,'VEC3'],[uvs,2,'VEC2']]){
   const compact=new Float32Array(count*stride);
   for(let old=0;old<remap.length;old++)if(remap[old]!==0xffffffff)compact.set(data.subarray(old*stride,old*stride+stride),remap[old]*stride);
   const min=Array(stride).fill(Infinity),max=Array(stride).fill(-Infinity);
   for(let i=0;i<count;i++)for(let c=0;c<stride;c++){min[c]=Math.min(min[c],compact[i*stride+c]);max[c]=Math.max(max[c],compact[i*stride+c]);}
   accessors.push({bufferView:append(compact,34962),componentType:5126,count,type,min,max});
 }
 const textureView=append(texture);
 const gltf={asset:{version:'2.0',generator:'A Moment in Bloom showcase pipeline'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0,name:'清晨来信 · Lux3D 整束'}],meshes:[{primitives:[{attributes:{POSITION:1,NORMAL:2,TEXCOORD_0:3},indices:0,material:0}]}],materials:[{name:'matte-bouquet',pbrMetallicRoughness:{baseColorFactor:[1,1,1,1],baseColorTexture:{index:0},metallicFactor:0,roughnessFactor:.85},doubleSided:false}],textures:[{source:0,sampler:0}],samplers:[{magFilter:9729,minFilter:9987,wrapS:10497,wrapT:10497}],images:[{mimeType:'image/jpeg',bufferView:textureView}],accessors,bufferViews:views,buffers:[{byteLength:offset}],extras:{source:'User-supplied Lux3D unified model; not individually editable',optimization:{ratio,error,textureSize}}};
 const str=Buffer.from(JSON.stringify(gltf)),json=Buffer.concat([str,Buffer.alloc((4-str.length%4)%4,32)]),binary=Buffer.concat(pieces);
 const header=Buffer.alloc(12);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+binary.length,8);
 const chunk=(len,type)=>{const b=Buffer.alloc(8);b.writeUInt32LE(len);b.write(type,4);return b;};
 const output=Buffer.concat([header,chunk(json.length,'JSON'),json,chunk(binary.length,'BIN\0'),binary]);
 const path=!study&&label==='detail'?'app/public/showcase/morning-letter.glb':`${dir}/${label}.glb`;writeFileSync(path,output);
 report.push({label,path,bytes:output.length,triangles:indices.length/3,vertices:count,error,textureSize,textureBytes:texture.length,sha256:createHash('sha256').update(output).digest('hex')});
}
writeFileSync(`${dir}/${study?'quality-study':'optimization'}.json`,JSON.stringify({sourceBytes:input.length,sourceTriangles:originalIndices.length/3,selected:study?null:'detail',candidates:report},null,2));console.log(JSON.stringify(report,null,2));
