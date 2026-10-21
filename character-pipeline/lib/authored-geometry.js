'use strict';
// Authored-data projection only: never native/rendered skinning evidence.
const {assertSpec}=require('./spec');
const {hashValue}=require('./assets');
const {planMotionSampling}=require('./motion-sampling');
const CAPS=Object.freeze({motionSamples:128,vertexSamples:8192,triangleSamples:16384,receiptBytes:2*1024*1024});
const invalid=message=>{throw Object.assign(new Error(message),{code:'INVALID_AUTHORED_GEOMETRY'});};
function plain(value,state={nodes:0,bytes:0,seen:new Set()},depth=0){
 const charge=bytes=>{state.bytes+=bytes;if(state.bytes>16*1024*1024)invalid('Authored input exceeds 16 MiB');};
 if(++state.nodes>500000||depth>24)invalid('Authored input exceeds bounded JSON structure');
 if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&value.length<=16384){charge(Buffer.byteLength(JSON.stringify(value)));return;}
 if(typeof value!=='object'||state.seen.has(value)||!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid('Expected bounded finite plain authored data');
 if(Array.isArray(value)){
  if(Object.getPrototypeOf(value)!==Array.prototype||value.length>100000||Object.getOwnPropertyNames(value).length!==value.length+1)invalid('Invalid authored array');
  for(let i=0;i<value.length;i++)if(!Object.hasOwn(value,String(i)))invalid('Sparse authored arrays are unsupported');
 }
 state.seen.add(value);
 charge(2);let entries=0;
 for(const key of Reflect.ownKeys(value)){
  if(Array.isArray(value)&&key==='length')continue;
  const d=Object.getOwnPropertyDescriptor(value,key);
  if(typeof key!=='string'||!d.enumerable||!Object.hasOwn(d,'value'))invalid('Authored accessors and hidden properties are unsupported');
  if(key.length>16384)invalid('Authored key exceeds bounded string length');
  charge((entries++?1:0)+(Array.isArray(value)?0:Buffer.byteLength(JSON.stringify(key))+1));
  plain(d.value,state,depth+1);
 }
 state.seen.delete(value);
}
const multiply=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
const point=(m,p)=>[m[0]*p[0]+m[2]*p[1]+m[4],m[1]*p[0]+m[3]*p[1]+m[5]];
function inverse(m){const d=m[0]*m[3]-m[1]*m[2];if(!Number.isFinite(d)||d===0)invalid('Degenerate rest frame');return [m[3]/d,-m[1]/d,-m[2]/d,m[0]/d,(m[2]*m[5]-m[3]*m[4])/d,(m[1]*m[4]-m[0]*m[5])/d];}
function frames(bones,poses){
 const map=new Map(bones.map(b=>[b.id,b])),out=new Map();
 function visit(id){if(out.has(id))return out.get(id);const b=map.get(id),r=poses.get(id),c=Math.cos(r.rotation),s=Math.sin(r.rotation),local=[c*r.scale[0],s*r.scale[0],-s*r.scale[1],c*r.scale[1],...r.position],m=b.parent===null?local:multiply(visit(b.parent),local);if(!m.every(Number.isFinite))invalid('Nonfinite authored transform');out.set(id,m);return m;}
 bones.forEach(b=>visit(b.id));return out;
}
function valueAt(track,time,loop){
 const keys=track.keys,exact=keys.find(k=>k.time===time);if(exact)return {value:exact.value};
 if(time<keys[0].time)return {reason:'before-first-key'};
 if(time>keys.at(-1).time)return loop?{reason:'loop-wrap'}:{value:keys.at(-1).value};
 const next=keys.findIndex(k=>k.time>time),a=keys[next-1],b=keys[next];
 const t=(time-a.time)/(b.time-a.time);
 // Godot 4.5 applies the outgoing key transition (1, 2, .5, -2, 0).
 const easing=a.easing??'linear',f=easing==='in'?t*t:easing==='out'?1-(1-t)*(1-t):easing==='inOut'?(t<.5?2*t*t:1-2*(1-t)*(1-t)):easing==='step'?0:t;
 const lerp=(x,y)=>x+(y-x)*f;
 return {value:Array.isArray(a.value)?a.value.map((x,i)=>lerp(x,b.value[i])):lerp(a.value,b.value)};
}
const signedArea=(v,t)=>{const [a,b,c]=t.map(i=>v[i]);return ((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;};
function inspectAuthoredGeometry(input){
 plain(input);
 const spec=assertSpec(input),restPoses=new Map(spec.bones.map(b=>[b.id,b.rest])),rest=frames(spec.bones,restPoses),inverseRest=new Map([...rest].map(([id,m])=>[id,inverse(m)]));
 // Native non-rendered builds support 64 clips. The authored planner has its
 // own smaller budget; omit excess clips explicitly rather than narrowing it.
 const clips=spec.animations.slice(0,32),omittedClipIds=spec.animations.slice(32).map(c=>c.id);
 const sampling={...(clips.length?planMotionSampling(clips,{maxFramesPerClip:32}):{version:1,clips:[]}),omittedClipIds};
 const receipt={version:1,specHash:hashValue(spec),scope:'authored-eased-linear-skinning',status:'unverified',visualQuality:'unverified',nativeGeometry:'uncovered',outsideScope:['rendered-pixels','native-float-precision','loop-seams','animation-blends','runtime-actions','assembled-components','runtime-constraints'],limits:CAPS,sampling,samples:[],omissions:[],coverage:{motionSamples:0,vertexSamples:0,triangleSamples:0},failures:[]};
 const meshes=spec.parts.filter(p=>p.mesh),world=new Map();
 for(const clipId of omittedClipIds)receipt.omissions.push({clipId,reason:'clip-budget'});
 for(const p of spec.parts){
  if(!p.mesh){receipt.omissions.push({partId:p.id,reason:'no-explicit-mesh'});continue;}
  const im=p.image;if(im.prepared!==true||!im.pivot||!Number.isFinite(im.pixelsPerUnit)||im.pixelsPerUnit<=0)invalid('Explicit meshes require prepared image geometry');
  const vertices=p.mesh.vertices.map(v=>point(rest.get(p.bone),[(v[0]-im.pivot[0])/im.pixelsPerUnit,(v[1]-im.pivot[1])/im.pixelsPerUnit]));
  if(vertices.some(v=>!v.every(Number.isFinite)))invalid('Nonfinite rest mesh coordinate');
  const areas=p.mesh.triangles.map(t=>signedArea(vertices,t));if(areas.some(a=>!Number.isFinite(a)||a===0))invalid('Degenerate transformed rest triangle');
  world.set(p.id,{vertices,areas});
 }
 function sample(clip,time,poseFrames){
  const record={clipId:clip?.id??null,time,parts:[]};
  for(const p of meshes){
   if(receipt.coverage.vertexSamples+p.mesh.vertices.length>CAPS.vertexSamples||receipt.coverage.triangleSamples+p.mesh.triangles.length>CAPS.triangleSamples){receipt.omissions.push({clipId:record.clipId,time,partId:p.id,reason:'geometry-budget'});continue;}
   const baseline=world.get(p.id),vertices=clip?baseline.vertices.map((v,i)=>{
    const sum=[0,0];for(const w of p.mesh.weights[i]){const q=point(multiply(poseFrames.get(w.bone),inverseRest.get(w.bone)),v);sum[0]+=q[0]*w.weight;sum[1]+=q[1]*w.weight;}return sum;
   }):baseline.vertices.map(v=>[...v]);
   if(vertices.some(v=>!v.every(Number.isFinite)))invalid('Nonfinite projected coordinate');
   const areas=p.mesh.triangles.map((t,index)=>{
    const area=signedArea(vertices,t);if(!Number.isFinite(area))invalid('Nonfinite projected triangle');
    if(area===0||Math.sign(area)!==Math.sign(baseline.areas[index]))receipt.failures.push({code:area===0?'TRIANGLE_COLLAPSE':'TRIANGLE_INVERSION',clipId:record.clipId,time,partId:p.id,triangle:index,restSignedArea:baseline.areas[index],signedArea:area});
    return area;
   });
   record.parts.push({partId:p.id,vertices,areas});receipt.coverage.vertexSamples+=vertices.length;receipt.coverage.triangleSamples+=areas.length;
  }
  receipt.samples.push(record);if(clip&&record.parts.length)receipt.coverage.motionSamples++;
 }
 sample(null,null,rest);
 let attempted=0;
 for(const clip of clips){
  const planned=sampling.clips.find(c=>c.id===clip.id);
  for(const time of planned.times){
   if(attempted++>=CAPS.motionSamples){receipt.omissions.push({clipId:clip.id,time,reason:'motion-budget'});continue;}
   // Godot wraps exact loop endpoints. Do not substitute authored endpoint values.
   if(clip.loop&&(time===0||time===clip.duration)){receipt.omissions.push({clipId:clip.id,time,reason:'loop-endpoint'});continue;}
   const poses=new Map(spec.bones.map(b=>[b.id,{...b.rest}]));let reason;
   for(const track of clip.tracks){const value=valueAt(track,time,clip.loop);if(value.reason){reason=value.reason;break;}poses.get(track.bone)[track.property]=value.value;}
   if(!reason&&spec.bones.some(b=>b.limits&&(poses.get(b.id).rotation<b.limits[0]||poses.get(b.id).rotation>b.limits[1])))reason='runtime-joint-limit';
   if(reason){receipt.omissions.push({clipId:clip.id,time,reason});continue;}
   sample(clip,time,frames(spec.bones,poses));
  }
 }
 receipt.status=receipt.coverage.motionSamples?(receipt.omissions.length||sampling.clips.some(c=>c.undersampled||c.omittedKeyTimes.length||c.omittedEventTimes.length)?'partial':'passed'):'unverified';
 if(Buffer.byteLength(JSON.stringify(receipt))>CAPS.receiptBytes)invalid('Authored geometry receipt exceeds 2 MiB');
 if(receipt.failures.length)throw Object.assign(new Error('Supported sampled authored deformation collapses or inverts geometry'),{code:'AUTHORED_GEOMETRY_FAILED',diagnostics:receipt.failures,authoredGeometry:receipt});
 return receipt;
}
module.exports={inspectAuthoredGeometry};
