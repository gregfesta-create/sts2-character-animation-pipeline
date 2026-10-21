'use strict';
// Native sampled origins only: this does not measure rendered skin deformation.
const {assertSpec}=require('./spec');
const {hashValue}=require('./assets');
const {validateTelemetry}=require('./validation');
const invalid=message=>{throw Object.assign(new Error(message),{code:'INVALID_NATIVE_MOTION'});};
const INPUT_BYTES=16*1024*1024,OUTPUT_BYTES=2*1024*1024,EXAMPLES=128;
function plain(value,state={nodes:0,bytes:0,seen:new Set()},depth=0){
 const charge=n=>{state.bytes+=n;if(state.bytes>INPUT_BYTES)invalid('Native motion input exceeds byte budget');};
 if(++state.nodes>500000||depth>24)invalid('Native motion input exceeds traversal budget');
 if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&value.length<=16384){charge(Buffer.byteLength(JSON.stringify(value)));return;}
 if(typeof value!=='object'||state.seen.has(value)||!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid('Expected finite plain motion data');
 if(Array.isArray(value)){
  if(Object.getPrototypeOf(value)!==Array.prototype||value.length>100000||Object.getOwnPropertyNames(value).length!==value.length+1)invalid('Invalid motion array');
  for(let i=0;i<value.length;i++)if(!Object.hasOwn(value,String(i)))invalid('Sparse motion arrays are unsupported');
 }
 state.seen.add(value);charge(2);let count=0;
 for(const key of Reflect.ownKeys(value)){
  if(Array.isArray(value)&&key==='length')continue;
  const d=Object.getOwnPropertyDescriptor(value,key);
  if(typeof key!=='string'||key.length>16384||!d.enumerable||!Object.hasOwn(d,'value'))invalid('Motion accessors or hidden properties are unsupported');
  charge((count++?1:0)+(Array.isArray(value)?0:Buffer.byteLength(JSON.stringify(key))+1));plain(d.value,state,depth+1);
 }
 if(Array.isArray(value)&&count!==value.length)invalid('Sparse motion arrays are unsupported');
 state.seen.delete(value);
}
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function exact(x,keys){if(!object(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))invalid('Native motion record has invalid keys');}
function valueAt(track,time){
 const keys=track.keys;if(time<keys[0].time)return null;
 const exactKey=keys.find(k=>k.time===time);if(exactKey)return exactKey.value;
 if(time>keys.at(-1).time)return keys.at(-1).value;
 const index=keys.findIndex(k=>k.time>time),a=keys[index-1],b=keys[index],t=(time-a.time)/(b.time-a.time),e=a.easing??'linear';
 const f=e==='in'?t*t:e==='out'?1-(1-t)*(1-t):e==='inOut'?(t<.5?2*t*t:1-2*(1-t)*(1-t)):e==='step'?0:t;
 const lerp=(x,y)=>x+(y-x)*f;return Array.isArray(a.value)?a.value.map((x,i)=>lerp(x,b.value[i])):lerp(a.value,b.value);
}
function inspectMotionRegistration(input,plan,samples){
 const state={nodes:0,bytes:0,seen:new Set()};plain(input,state);plain(plan,state);plain(samples,state);
 let spec;try{spec=assertSpec(input);}catch{invalid('Invalid authored motion specification');}
 if(spec.bones.length>128||spec.animations.length>32||!Array.isArray(samples)||samples.length>64||samples.length*spec.bones.length>8192)invalid('Native motion exceeds supported observation limits');
 if(plan===null){if(spec.animations.length||samples.length)invalid('A null motion plan requires no clips or samples');}
 else{
  if(!object(plan)||plan.version!==1||!Array.isArray(plan.clips)||plan.clips.length!==spec.animations.length||!plan.clips.length)invalid('Motion plan does not match authored clips');
  let total=0;
  for(let i=0;i<plan.clips.length;i++){
   const p=plan.clips[i],c=spec.animations[i];
   if(!object(p)||p.id!==c.id||p.duration!==c.duration||!Array.isArray(p.times)||p.times.length<2||p.times.length>64||p.times[0]!==0||p.times.at(-1)!==c.duration)invalid('Motion plan clip metadata differs');
   let previous=-1;for(const t of p.times){if(typeof t!=='number'||t<0||t>c.duration||t<=previous)invalid('Invalid ordered motion times');previous=t;}total+=p.times.length;
  }
  if(total!==samples.length||total>64)invalid('Native motion sample count differs');
 }
 const expectedSamples=plan?.clips.flatMap(c=>c.times.map(time=>({clip:c.id,time})))??[],boneIds=spec.bones.map(b=>b.id);
 for(let i=0;i<samples.length;i++){
  const sample=samples[i];exact(sample,['clip','time','bones']);if(sample.clip!==expectedSamples[i].clip||sample.time!==expectedSamples[i].time||!object(sample.bones)||Object.keys(sample.bones).length!==boneIds.length)invalid('Native sample identity or bone map differs');
  for(const id of boneIds){const v=sample.bones[id];if(!Object.hasOwn(sample.bones,id)||!Array.isArray(v)||v.length!==3||v.some(x=>typeof x!=='number'||Math.abs(x)>1e6))invalid('Native bone observation must contain three bounded numbers');}
 }
 const empty={version:1,thresholdVersion:'telemetry-v1',attachments:[],weights:[],triangles:[],inversionExceptions:[],loopEndpoints:[],frameJumpThresholds:[],frameJumps:[]};
 const tolerancePx=validateTelemetry(empty).thresholds.attachmentMovingPx;
 const report={version:1,scope:'native-sampled-bone-origins',status:'unverified',specHash:hashValue(spec),planHash:hashValue(plan),tolerancePx,observationCount:samples.length*boneIds.length,checkedCount:0,maxOriginErrorPx:0,omissions:[],omissionCount:0,omissionsTruncated:false,failures:[],failureCount:0,failuresTruncated:false,visualQuality:'unverified',outsideScope:['rendered-skin-deformation','angular-correctness','continuous-motion','loop-seams','animation-blends','assembled-components','runtime-constraints']};
 const bones=new Map(spec.bones.map(b=>[b.id,b])),clips=new Map(spec.animations.map(c=>[c.id,c]));
 for(const sample of samples){
  const clip=clips.get(sample.clip),poses=new Map(spec.bones.map(b=>[b.id,{...b.rest}])),omitted=new Set(),frames=new Map();
  for(const track of clip.tracks){const value=valueAt(track,sample.time);if(value===null)omitted.add(track.bone);else poses.get(track.bone)[track.property]=value;}
  function visit(id){
   if(frames.has(id))return frames.get(id);const b=bones.get(id),parent=b.parent===null?null:visit(b.parent);
   if(omitted.has(id)||b.parent!==null&&parent===null){omitted.add(id);frames.set(id,null);return null;}
   const p=poses.get(id),r=b.limits?Math.max(b.limits[0],Math.min(b.limits[1],p.rotation)):p.rotation,c=Math.cos(r),s=Math.sin(r),local=[c*p.scale[0],s*p.scale[0],-s*p.scale[1],c*p.scale[1],...p.position];
   const a=parent,m=a?[a[0]*local[0]+a[2]*local[1],a[1]*local[0]+a[3]*local[1],a[0]*local[2]+a[2]*local[3],a[1]*local[2]+a[3]*local[3],a[0]*local[4]+a[2]*local[5]+a[4],a[1]*local[4]+a[3]*local[5]+a[5]]:local;
   if(!m.every(Number.isFinite))invalid('Expected native bone frame is nonfinite');frames.set(id,m);return m;
  }
  for(const id of boneIds){const frame=visit(id),identity={clipId:sample.clip,time:sample.time,boneId:id};
   if(frame===null){report.omissionCount++;report.omissions.push({...identity,reason:'before-first-key-or-ancestor'});continue;}
   const expected=frame.slice(4),actual=sample.bones[id].slice(0,2),measured=Math.hypot(expected[0]-actual[0],expected[1]-actual[1]);if(!Number.isFinite(measured))invalid('Native origin error is nonfinite');report.checkedCount++;report.maxOriginErrorPx=Math.max(report.maxOriginErrorPx,measured);
   if(measured>tolerancePx){report.failureCount++;if(report.failures.length<EXAMPLES)report.failures.push({code:'BONE_REGISTRATION_ERROR',...identity,expected,actual,measured,limit:tolerancePx});}
  }
 }
 report.failuresTruncated=report.failureCount>report.failures.length;
 report.status=report.failureCount?'failed':report.omissionCount?'partial':report.checkedCount?'passed':'unverified';
 if(Buffer.byteLength(JSON.stringify(report))>OUTPUT_BYTES)invalid('Native motion report exceeds output byte budget');
 if(report.failureCount)throw Object.assign(new Error('Native sampled bone origins differ from authored motion'),{code:'VISUAL_VALIDATION_FAILED',diagnostics:report.failures,report});
 return report;
}
module.exports={inspectMotionRegistration};
