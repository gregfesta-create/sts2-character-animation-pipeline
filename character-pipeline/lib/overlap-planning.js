'use strict';
const {assertSpec}=require('./spec');
const {hashValue}=require('./assets');
const {planRenderViewport}=require('./render-layout');
const invalid=message=>{throw Object.assign(new Error(message),{code:'INVALID_OVERLAP_PLAN'});};
const INPUT_BYTES=16*1024*1024,EXAMPLES=128;
// Inspect descriptors before reading or hashing potentially hostile inputs.
function plain(value,state={nodes:0,bytes:0,seen:new Set()},depth=0){
 const charge=n=>{state.bytes+=n;if(state.bytes>INPUT_BYTES)invalid('Overlap input exceeds byte budget');};
 if(++state.nodes>500000||depth>24)invalid('Overlap input exceeds traversal budget');
 if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&value.length<=16384){charge(Buffer.byteLength(JSON.stringify(value)));return;}
 if(typeof value!=='object'||state.seen.has(value)||!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid('Expected finite plain overlap data');
 if(Array.isArray(value)){
  if(Object.getPrototypeOf(value)!==Array.prototype||value.length>100000||Object.getOwnPropertyNames(value).length!==value.length+1)invalid('Invalid overlap array');
  for(let i=0;i<value.length;i++)if(!Object.hasOwn(value,String(i)))invalid('Sparse overlap arrays are unsupported');
 }
 state.seen.add(value);charge(2);let count=0;
 for(const key of Reflect.ownKeys(value)){
  if(Array.isArray(value)&&key==='length')continue;
  const d=Object.getOwnPropertyDescriptor(value,key);
  if(typeof key!=='string'||key.length>16384||!d.enumerable||!Object.hasOwn(d,'value'))invalid('Overlap accessors or hidden properties are unsupported');
  charge((count++?1:0)+(Array.isArray(value)?0:Buffer.byteLength(JSON.stringify(key))+1));plain(d.value,state,depth+1);
 }
 if(Array.isArray(value)&&count!==value.length)invalid('Sparse overlap arrays are unsupported');
 state.seen.delete(value);
}
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function planPartMasks(input,motionPlan,renderLayout){
 const state={nodes:0,bytes:0,seen:new Set()};plain(input,state);plain(motionPlan,state);plain(renderLayout,state);
 let spec;try{spec=assertSpec(input);}catch{invalid('Invalid authored overlap specification');}
 if(spec.parts.length>128||spec.animations.length>32)invalid('Overlap parts or clips exceed native limits');
 const poses=[],priority=[];
 if(motionPlan===null){if(spec.animations.length)invalid('Missing authored motion plan');}
 else{
  if(!object(motionPlan)||motionPlan.version!==1||!Array.isArray(motionPlan.clips)||!motionPlan.clips.length||motionPlan.clips.length!==spec.animations.length)invalid('Motion clips differ from authored specification');
  for(let i=0;i<motionPlan.clips.length;i++){
   const clip=motionPlan.clips[i],authored=spec.animations[i];
   if(!object(clip)||clip.id!==authored.id||clip.duration!==authored.duration||!Array.isArray(clip.times)||clip.times.length<2||clip.times.length>64||clip.times[0]!==0||clip.times.at(-1)!==clip.duration)invalid('Invalid overlap clip metadata');
   let previous=-1;const selected=[];
   for(const time of clip.times){if(typeof time!=='number'||time<=previous||time<0||time>clip.duration)invalid('Invalid ordered overlap sample times');previous=time;const pose={clipId:clip.id,time,frameIndex:poses.length};poses.push(pose);selected.push(pose);}
   priority.push([selected[0],selected.at(-1),...selected.slice(1,-1)]);
  }
 }
 if(poses.length>64)invalid('Overlap poses exceed native limit');
 let expectedLayout;try{expectedLayout=planRenderViewport(spec.canvas,Math.max(1,poses.length));}catch{invalid('Invalid overlap render layout');}
 if(hashValue(renderLayout)!==hashValue(expectedLayout))invalid('Overlap projection differs from normal rendered layout');
 const policy={allowedPairCount:0,forbiddenPairCount:0,unknownPairCount:0,allowedPairs:[],forbiddenPairs:[],unknownPairs:[],allowedPairsTruncated:false,forbiddenPairsTruncated:false,unknownPairsTruncated:false},forbidden=[];
 for(let a=0;a<spec.parts.length;a++)for(let b=a+1;b<spec.parts.length;b++){
  const x=spec.parts[a],y=spec.parts[b],pair={partA:x.id,partB:y.id};
  const kind=x.overlaps?.includes(y.id)||y.overlaps?.includes(x.id)?'allowed':Object.hasOwn(x,'overlaps')&&Object.hasOwn(y,'overlaps')?'forbidden':'unknown';
  policy[kind+'PairCount']++;if(policy[kind+'Pairs'].length<EXAMPLES)policy[kind+'Pairs'].push(pair);else policy[kind+'PairsTruncated']=true;
  if(kind==='forbidden')forbidden.push(pair);
 }
 const captures=[],comparisons=[],omissions=[],selected=new Map(),pixels=renderLayout.pixels[0]*renderLayout.pixels[1];let omissionCount=0;
 for(let round=0;round<64;round++)for(const list of priority){
  const pose=list[round];if(!pose)continue;
  for(const pair of forbidden){
   const keys=[pose.frameIndex+':'+pair.partA,pose.frameIndex+':'+pair.partB],needed=keys.filter(k=>!selected.has(k)).length;
   const reason=comparisons.length>=256?'comparison-count-limit':(comparisons.length+1)*pixels>64*1024*1024?'comparison-pixel-limit':captures.length+needed>64?'capture-count-limit':(captures.length+needed)*pixels>16*1024*1024?'capture-pixel-limit':null;
   if(reason){omissionCount++;if(omissions.length<EXAMPLES)omissions.push({...pair,...pose,reason});continue;}
   for(let i=0;i<2;i++)if(!selected.has(keys[i])){const id=captures.length;selected.set(keys[i],id);captures.push({id,partId:i===0?pair.partA:pair.partB,...pose,filename:'part-mask-'+id+'.png'});}
   comparisons.push({id:comparisons.length,...pair,...pose,captureA:selected.get(keys[0]),captureB:selected.get(keys[1])});
  }
 }
 const result={version:1,scope:'rendered-parent-part-alpha',specHash:hashValue(spec),motionPlanHash:hashValue(motionPlan),renderLayoutHash:hashValue(renderLayout),renderLayout:structuredClone(renderLayout),policy,poseCount:poses.length,totalPossibleComparisons:forbidden.length*poses.length,captures,comparisons,omissionCount,omissions,omissionsTruncated:omissionCount>omissions.length,status:comparisons.length?(omissionCount?'partial':'planned'):'unverified'};
 result.planHash=hashValue(result);
 if(Buffer.byteLength(JSON.stringify(result))>2*1024*1024)invalid('Overlap plan exceeds output byte budget');
 return result;
}
module.exports={planPartMasks};
