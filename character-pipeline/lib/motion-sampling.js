'use strict';
const schema=require('../schema/character.schema.json');
const fail=()=>{throw Object.assign(new Error('Invalid bounded motion sampling input'),{code:'INVALID_MOTION_SAMPLING'});};
// Reject accessors, cycles, prototypes and oversized trees before reading values.
function plain(value,state={nodes:0,seen:new Set()},depth=0){
 if(++state.nodes>200000||depth>16)fail();
 if(value===null||typeof value==='boolean'||typeof value==='string'&&value.length<=4096||typeof value==='number'&&Number.isFinite(value))return;
 if(typeof value!=='object'||state.seen.has(value))fail();
 if(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)fail();
 if(Array.isArray(value)){
  if(Object.getPrototypeOf(value)!==Array.prototype||value.length>200000)fail();
  const names=Object.getOwnPropertyNames(value);
  if(names.length!==value.length+1)fail();
  for(let i=0;i<value.length;i++)if(!Object.hasOwn(value,String(i)))fail();
 }
 state.seen.add(value);
 if(Reflect.ownKeys(value).some(k=>typeof k!=='string'))fail();
 for(const [key,d]of Object.entries(Object.getOwnPropertyDescriptors(value))){if(Array.isArray(value)&&key==='length')continue;if(!d.enumerable||!Object.hasOwn(d,'value'))fail();plain(d.value,state,depth+1);}
 state.seen.delete(value);
}
function conforms(value,rule){
 if(rule.$ref)rule=schema.$defs[rule.$ref.split('/').at(-1)];
 if(rule.anyOf)return rule.anyOf.some(r=>conforms(value,r));
 if(rule.enum&&!rule.enum.includes(value))return false;
 const type=Array.isArray(value)?'array':value===null?'null':typeof value;
 if(rule.type&&rule.type!==type&&!(rule.type==='integer'&&Number.isInteger(value)))return false;
 if(type==='number'&&(!Number.isFinite(value)||rule.minimum!==undefined&&value<rule.minimum||rule.maximum!==undefined&&value>rule.maximum))return false;
 if(type==='string'&&(rule.pattern&&!new RegExp(rule.pattern).test(value)||rule.minLength!==undefined&&value.length<rule.minLength||rule.maxLength!==undefined&&value.length>rule.maxLength))return false;
 if(type==='array'&&(rule.minItems!==undefined&&value.length<rule.minItems||rule.maxItems!==undefined&&value.length>rule.maxItems||!value.every(v=>conforms(v,rule.items||{}))))return false;
 if(type==='object'){
  if((rule.required||[]).some(k=>!Object.hasOwn(value,k)))return false;
  for(const k of Object.keys(value)){const r=rule.properties?.[k];if(!r&&rule.additionalProperties===false)return false;if(r&&!conforms(value[k],r))return false;}
 }
 return true;
}
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const ordered=values=>[...new Set(values)].sort((a,b)=>a-b);
function planMotionSampling(clips,options={}){
 plain(clips);plain(options);
 if(!Array.isArray(clips)||clips.length<1||clips.length>32||!options||Array.isArray(options)||typeof options!=='object'||Object.keys(options).some(k=>!['framesPerSecond','maxFramesPerClip','maxTotalFrames'].includes(k)))fail();
 const framesPerSecond=options.framesPerSecond??16,maxFramesPerClip=options.maxFramesPerClip??64;
 if(!Number.isFinite(framesPerSecond)||framesPerSecond<1||framesPerSecond>120||!Number.isInteger(maxFramesPerClip)||maxFramesPerClip<2||maxFramesPerClip>64)fail();
 const shared=Object.hasOwn(options,'maxTotalFrames'),maxTotalFrames=options.maxTotalFrames;
 if(shared&&(!Number.isInteger(maxTotalFrames)||maxTotalFrames<2*clips.length||maxTotalFrames>2048))fail();
 const ids=new Set();
 const planned=clips.map(clip=>{
  if(!conforms(clip,schema.$defs.animation)||ids.has(clip.id))fail();ids.add(clip.id);
  const keyTimes=[],eventTimes=[],eventIds=new Set(),tracks=new Set();
  for(const track of clip.tracks){const binding=track.bone+':'+track.property;if(tracks.has(binding))fail();tracks.add(binding);let previous=-1;for(const key of track.keys){if(key.time<=previous||key.time>clip.duration||(track.property==='rotation'?typeof key.value!=='number':!Array.isArray(key.value)))fail();previous=key.time;keyTimes.push(key.time);}}
  const poseGroups=new Set();
  for(const track of clip.poseTracks||[]){
   if(poseGroups.has(track.group)||track.keys[0].time!==0)fail();poseGroups.add(track.group);
   let previous=-1;
   for(const key of track.keys){if(key.time<=previous||key.time>clip.duration||clip.loop&&key.time===clip.duration)fail();previous=key.time;keyTimes.push(key.time);}
  }
  let previous=-1;for(const event of clip.events){if(event.time<previous||event.time>clip.duration||eventIds.has(event.id))fail();previous=event.time;eventIds.add(event.id);eventTimes.push(event.time);}
  const keys=ordered(keyTimes),events=ordered(eventTimes),selected=new Set([0,clip.duration]);
  const intervals=Math.ceil(clip.duration*framesPerSecond),regular=Array.from({length:intervals+1},(_,i)=>i===intervals?clip.duration:clip.duration*i/intervals);
  return {clip,keys,events,selected,intervals,regular};
 });
 // Allocate an entire priority before selecting its spread: one-at-a-time
 // selection would repeatedly favor the middle of the remaining candidates.
 let remainingBudget=shared?maxTotalFrames-2*clips.length:Infinity;
 for(const priority of ['events','keys','regular']){
  const candidates=planned.map(p=>p[priority].filter(t=>!p.selected.has(t)));
  const quotas=planned.map(()=>0);
  let allocated;
  do{
   allocated=false;
   for(let i=0;i<planned.length&&remainingBudget>0;i++){
    if(quotas[i]<candidates[i].length&&planned[i].selected.size+quotas[i]<maxFramesPerClip){quotas[i]++;remainingBudget--;allocated=true;}
   }
  }while(allocated&&remainingBudget>0);
  for(let i=0;i<planned.length;i++){
   const values=candidates[i],slots=quotas[i];
   for(let j=0;j<slots;j++)planned[i].selected.add(values[Math.floor((j+.5)*values.length/slots)]);
  }
 }
 const results=planned.map(({clip,keys,events,selected,intervals})=>{
  const times=ordered([...selected]),maximumGapSeconds=times.slice(1).reduce((max,t,i)=>Math.max(max,t-times[i]),0);
  return {id:clip.id,duration:clip.duration,times,omittedEventTimes:events.filter(t=>!selected.has(t)),omittedKeyTimes:keys.filter(t=>!selected.has(t)),requestedCadenceFrames:intervals+1,maximumGapSeconds,undersampled:maximumGapSeconds>1/framesPerSecond+Number.EPSILON*Math.max(1,clip.duration)*4};
 });
 return freeze({version:1,framesPerSecond,maxFramesPerClip,dispatchRuntimeCues:false,...(shared?{maxTotalFrames}:{}),clips:results});
}
// Godot's JSON parser may round decimal doubles. Only compiler-owned plan
// leaves and derived registration/layout use this bounded bit transport;
// authored specification data is intact.
function planNumberBits(plans){
 plain(plans);
 if(!plans||Array.isArray(plans)||typeof plans!=='object'||Object.keys(plans).some(key=>!['motionPlan','maskPlan','nativeRestAnchors','renderLayout'].includes(key)))fail();
 const entries=[];
 function visit(value,path){
  if(typeof value==='number'&&(!Number.isInteger(value)||Object.is(value,-0))){
   if(entries.length>=8192||path.length>16)fail();
   const bytes=Buffer.alloc(8);bytes.writeDoubleLE(value);entries.push({path,hex:bytes.toString('hex')});
  }else if(value&&typeof value==='object'){
   for(const key of Object.keys(value))visit(value[key],[...path,Array.isArray(value)?Number(key):key]);
  }
 }
 for(const key of Object.keys(plans))visit(plans[key],[key]);
 return entries;
}
module.exports={planMotionSampling,planNumberBits};


