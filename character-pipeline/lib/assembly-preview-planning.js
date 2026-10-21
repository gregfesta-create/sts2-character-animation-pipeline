'use strict';
const {assertSpec}=require('./spec');
const {hashValue}=require('./assets');
const {createAssemblyPlanner}=require('./components');
const {planRenderViewport}=require('./render-layout');
const fail=message=>{throw Object.assign(new Error(message),{code:'INVALID_ASSEMBLY_PREVIEW_PLAN'});};
// Read property descriptors before touching input values or canonical hashing.
function plain(value,budget={values:0,bytes:0,seen:new Set()},depth=0){
 const charge=n=>{budget.bytes+=n;if(budget.bytes>16*1024*1024)fail('Assembly preview input exceeds byte limit');};
 if(++budget.values>500000||depth>24)fail('Assembly preview input exceeds traversal limit');
 if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||typeof value==='string'){
  if(typeof value==='string'&&value.length>16*1024*1024)fail('Oversized string');charge(Buffer.byteLength(JSON.stringify(value)));return;
 }
 if(!value||typeof value!=='object'||budget.seen.has(value))fail('Expected finite plain assembly preview data');
 const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
 if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)fail('Expected ordinary assembly preview data');
 if(array&&(value.length>500000||Reflect.ownKeys(value).length!==value.length+1))fail('Expected dense bounded array');
 budget.seen.add(value);charge(2);let count=0;
 for(const key of Reflect.ownKeys(value)){
  if(array&&key==='length')continue;
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(typeof key!=='string'||!descriptor.enumerable||!Object.hasOwn(descriptor,'value')||array&&key!==String(count))fail('Expected enumerable plain fields');
  charge((count++?1:0)+(array?0:Buffer.byteLength(JSON.stringify(key))+1));plain(descriptor.value,budget,depth+1);
 }
 if(array&&count!==value.length)fail('Expected dense bounded array');budget.seen.delete(value);
}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function planAssemblyPreview(input,options){
 const budget={values:0,bytes:0,seen:new Set()};plain(input,budget);plain(options,budget);
 if(!options||Array.isArray(options)||Object.keys(options).length!==1||typeof options.compiledSpecHash!=='string'||!/^[a-f0-9]{64}$/.test(options.compiledSpecHash))fail('Expected exact compiled candidate hash');
 let spec;try{spec=structuredClone(assertSpec(input));}catch{fail('Invalid authored assembly specification');}
 const omissions=Object.fromEntries(['instances','alternatives','times','nested'].map(k=>[k,{count:0,examples:[],truncated:false}]));
 const omit=(kind,example)=>{const entry=omissions[kind];entry.count++;if(entry.examples.length<128)entry.examples.push(example);else entry.truncated=true;};
 const result={version:1,scope:'assembly-motion-preview',specHash:hashValue(spec),compiledSpecHash:options.compiledSpecHash,instanceId:'assemblyPreview',status:'not-applicable',visualQuality:'unverified',reviewHoldSeconds:.25,configurations:[],steps:[],frames:[],duration:0,renderLayout:null,simulation:{maximumStep:1/60,maximumSteps:8192,phaseSchedulingGranularity:1/60,order:['assembly','local-animation-owners']},omissions};
 const finish=()=>{result.planHash=hashValue(result);if(Buffer.byteLength(JSON.stringify(result))>2*1024*1024)fail('Assembly preview output exceeds byte limit');return freeze(result);};
 if(!spec.assembly||!spec.assembly.descriptors.length||!spec.sockets.length)return finish();
 const descriptors=new Map(spec.assembly.descriptors.map(d=>[d.type,d])),sockets=spec.sockets.filter(s=>s.types.some(t=>descriptors.has(t)));
 let planner;try{planner=createAssemblyPlanner({sockets,descriptors:spec.assembly.descriptors,styleHash:spec.assembly.styleHash,eventNames:spec.assembly.eventNames});}catch{fail('Invalid assembly contracts');}
 const state=(components,revision=1)=>({version:1,instanceId:result.instanceId,sequence:revision,revision,lifecycle:'alive',visualMode:'idle',components:structuredClone(components)});
 const component=(id,socket,type)=>({id,socket,type,revision:1,damageState:'intact',upgrade:0,visualMode:'idle'});
 const valid=components=>{try{planner.bootstrap(state(components));return true;}catch{return false;}};
 const synthetic=!spec.components.length,baseline=[];let syntheticIndex=0;
 if(synthetic){
  for(const socket of sockets){
   for(const descriptor of spec.assembly.descriptors){
    if(!socket.types.includes(descriptor.type))continue;
    const c=component('previewComponent'+syntheticIndex,socket.id,descriptor.type);
    if(!valid([...baseline,c]))continue;
    syntheticIndex++;if(baseline.length<8)baseline.push(c);else omit('instances',{id:c.id,socket:c.socket,type:c.type,reason:'instance-limit'});
    break;
   }
  }
 }else for(const authored of spec.components){
  const c=component(authored.id,authored.socket,authored.type);
  if(baseline.length>=8){omit('instances',{id:c.id,reason:'instance-limit'});continue;}
  if(!valid([...baseline,c])){omit('instances',{id:c.id,reason:'unsupported-placement'});continue;}
  baseline.push(c);
 }
 if(!baseline.length)return finish();
 const empty={id:'empty',label:'Empty chassis',synthetic:false,components:[]},base={id:'baseline',label:synthetic?'Synthetic development placement':'Declared installed configuration',synthetic,components:baseline};
 result.configurations.push(empty,base);
 // Parent captures certify direct instances only. Independently compiled child
 // definitions can have their own previews, but no nested occupancy is inferred.
 for(const c of baseline)omit('nested',{id:c.id,type:c.type,reason:'child-definition-occupancy-not-observed'});
 let revision=1,cursor=0,previous=state([],revision),componentRevisions=new Map();
 const operationsFor=(before,after)=>{
  const old=new Map(before.map(c=>[c.id,c])),next=new Map(after.map(c=>[c.id,c])),operations=[];
  const operation=(c,kind)=>{const profile=descriptors.get(c.type).transitions?.[kind]||{duration:.2,phases:[]};operations.push({id:c.id,type:c.type,kind,duration:profile.duration,phases:structuredClone(profile.phases)});};
  for(const c of before)if(!next.has(c.id))operation(c,'remove');
  for(const c of after){const a=old.get(c.id);if(!a)operation(c,'install');else if(a.type!==c.type||a.socket!==c.socket)operation(c,'replace');}
  return operations;
 };
 const append=config=>{
  const next=structuredClone(config.components);
  for(const c of next){const prior=previous.components.find(x=>x.id===c.id);const changed=!prior||prior.type!==c.type||prior.socket!==c.socket;c.revision=changed?(componentRevisions.get(c.id)||0)+1:prior.revision;componentRevisions.set(c.id,c.revision);}
  const snapshot=state(next,result.steps.length?++revision:revision),operations=operationsFor(previous.components,next),duration=Math.max(0,...operations.map(o=>o.duration));
  if(result.steps.length)planner.plan(previous,snapshot);else planner.bootstrap(snapshot);
  const step={id:result.steps.length,time:cursor,endTime:cursor+duration,holdEndTime:cursor+duration+.25,configurationId:config.id,snapshot,operations,duration};
  result.steps.push(step);cursor=step.holdEndTime;previous=snapshot;
 };
 append(empty);append(base);
 let alternativeCount=0;
 for(let index=0;index<baseline.length;index++)for(const descriptor of spec.assembly.descriptors){
  const original=baseline[index];if(descriptor.type===original.type)continue;
  const components=structuredClone(baseline);components[index].type=descriptor.type;
  const label={id:original.id,type:descriptor.type};
  if(!valid(components)){omit('alternatives',{...label,reason:'unsupported-placement'});continue;}
  if(alternativeCount>=2){omit('alternatives',{...label,reason:'alternative-limit'});continue;}
  const outDuration=Math.max(0,...operationsFor(baseline,components).map(o=>o.duration)),returnDuration=Math.max(0,...operationsFor(components,baseline).map(o=>o.duration)),removeDuration=Math.max(0,...operationsFor(baseline,[]).map(o=>o.duration));
  if(cursor+outDuration+.25+returnDuration+.25+removeDuration+.25>60){omit('alternatives',{...label,reason:'timeline-limit'});continue;}
  const alternative={id:'alternative'+alternativeCount++,label:'Compatible alternative '+descriptor.type,synthetic:true,components};result.configurations.push(alternative);append(alternative);append(base);
 }
 append(empty);result.duration=cursor;
 if(result.duration>60)fail('Mandatory assembly timeline exceeds limit');
 // Unique candidate priorities: all boundaries, phase round robin, then regular
 // samples. Track omissions once per unique candidate, not once per source.
 const selected=new Set(),candidates=new Map();
 const candidate=(time,reason)=>{if(!candidates.has(time))candidates.set(time,reason);};
 candidate(0,'boundary');candidate(result.duration,'boundary');
 for(const step of result.steps){candidate(step.time,'boundary');candidate(step.endTime,'boundary');candidate(step.holdEndTime,'boundary');}
 const phaseTimes=result.steps.map(step=>[...new Set(step.operations.flatMap(o=>o.phases.map(p=>step.time+p.time)))].sort((a,b)=>a-b));
 for(let i=0;i<Math.max(0,...phaseTimes.map(times=>times.length));i++)for(const times of phaseTimes)if(i<times.length)candidate(times[i],'phase');
 for(let n=1;n/16<result.duration;n++)candidate(n/16,'regular');
 for(const [time,kind]of candidates){if(selected.size<64)selected.add(time);else omit('times',{time,kind,reason:'frame-limit'});}
 const times=[...selected].sort((a,b)=>a-b);result.renderLayout=planRenderViewport(spec.canvas,times.length);
 if(times.length*result.renderLayout.pixels[0]*result.renderLayout.pixels[1]>16*1024*1024)fail('Assembly preview decoded pixel limit exceeded');
 result.frames=times.map((time,index)=>({index,time,filename:'assembly-frame-'+index+'.png',configurationId:result.steps.findLast(s=>s.time<=time).configurationId}));
 result.status=Object.values(omissions).some(entry=>entry.count)?'partial':'planned';
 return finish();
}
module.exports={planAssemblyPreview};
