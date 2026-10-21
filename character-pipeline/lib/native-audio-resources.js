'use strict';
// Input eligibility comes from the verified compiler checkpoint, never user flags.
// Returned JSON is evidence only; it does not authorize a runtime planner.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {stageRuntimeManifest,buildRuntimeManifest}=require('./runtime-manifest');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=()=>{throw Object.assign(new Error('Invalid compiler-owned audio inspection contract'),{code:'INVALID_AUDIO_RESOURCE'});};
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const keys=(x,list)=>object(x)&&Object.keys(x).length===list.length&&list.every(k=>Object.hasOwn(x,k));
const safe=x=>typeof x==='string'&&x.length<=512&&/^[A-Za-z0-9_./-]+\.res$/.test(x)&&x.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!/[. ]$/.test(p)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p));
const authorities=new WeakMap();
const cancelled=signal=>{if(signal!==undefined&&!(signal instanceof AbortSignal))fail();if(signal?.aborted)throw Object.assign(new Error('Audio inspection cancelled'),{code:'ABORTED'});};
function proveAudioResource(authority,record,targetPath=record?.path){
 const records=authority&&typeof authority==='object'?authorities.get(authority):null;
 const proof=records?.get(record?.path),target=records?.get(targetPath);
 if(!proof||!target||proof.sourcePath!==target.sourcePath||record.hash!==proof.hash||record.size!==proof.size)return null;
 return {...structuredClone(target),category:'audio'};
}
function prepareAudioInspection({files,audio,maxBytes=64*1024*1024}={}){
 if(!Array.isArray(files)||!files.length||files.length>1000||!Array.isArray(audio)||!audio.length||audio.length>1000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>256*1024*1024)fail();
 const inventory=new Map(),names=new Set();let total=0;
 for(const f of files){
  if(!keys(f,['path','size','hash','base64'])||!safe(f.path)||names.has(f.path.toLowerCase())||!Number.isSafeInteger(f.size)||f.size<4||f.size>17*1024*1024||! /^[a-f0-9]{64}$/.test(f.hash)||typeof f.base64!=='string'||f.base64.length>Math.ceil(f.size/3)*4)fail();
  const b=Buffer.from(f.base64,'base64');if(b.length!==f.size||b.toString('base64')!==f.base64||digest(b)!==f.hash||b.subarray(0,4).toString()!=='RSRC')fail();
  total+=b.length;if(total>maxBytes)fail();names.add(f.path.toLowerCase());inventory.set(f.path,{path:f.path,size:f.size,hash:f.hash,base64:f.base64});
 }
 const expected=[],ids=new Set(),seen=new Set();
 for(const a of audio){
  if(!keys(a,['id','format','duration','resource'])||typeof a.id!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(a.id)||ids.has(a.id)||!['wav','ogg-vorbis'].includes(a.format)||!Number.isFinite(a.duration)||a.duration<=0||a.duration>30||typeof a.resource!=='string'||!a.resource.startsWith('res://'))fail();
  const p=a.resource.slice(6);if(!inventory.has(p))fail();ids.add(a.id);
  if(seen.has(p)){const previous=expected.find(e=>e.path===p);if(previous.format!==a.format||previous.duration!==a.duration)fail();continue;}
  seen.add(p);expected.push({path:p,format:a.format,duration:a.duration});
 }
 if(seen.size!==inventory.size)fail();
 return {version:1,files:[...inventory.values()],expected};
}
function validateAudioInspection(request,response){
 if(!keys(response,['version','resources'])||response.version!==1||!Array.isArray(response.resources)||response.resources.length!==request.files.length)fail();
 const records=[],seen=new Set();
 for(const r of response.resources){
  if(!keys(r,['path','hash','size','class','format','duration','sampleRate','channels','frames','granuleFrames','dependencies','script']))fail();
  const f=request.files.find(f=>f.path===r.path),e=request.expected.find(e=>e.path===r.path);
  if(!f||!e||seen.has(r.path)||r.hash!==f.hash||r.size!==f.size||r.format!==e.format||r.class!==(r.format==='wav'?'AudioStreamWAV':'AudioStreamOggVorbis')||r.script!==false||!Array.isArray(r.dependencies)||r.dependencies.length||!Number.isInteger(r.sampleRate)||r.sampleRate<8000||r.sampleRate>96000||![1,2].includes(r.channels)||!Number.isFinite(r.duration)||r.duration<=0||r.duration>30||Math.abs(r.duration-e.duration)>Math.max(1/r.sampleRate,0.00001))fail();
  const n=r.format==='wav'?r.frames:r.granuleFrames;
  if(!Number.isSafeInteger(n)||n<=0||n*r.channels*2>16*1024*1024||Math.abs(n/r.sampleRate-r.duration)>Math.max(1/r.sampleRate,0.00001)||(r.format==='wav'?r.granuleFrames!==null:r.frames!==null))fail();
  seen.add(r.path);records.push(structuredClone(r));
 }
 return {version:1,resources:records};
}
async function inspectNativeAudioResources(options,trusted={}){
 cancelled(options?.signal);
 const request=prepareAudioInspection(options),{stagingParent,tool}=options;
 const namespaces=options.namespaces??[];
 if(!Array.isArray(namespaces)||namespaces.length>16||new Set(namespaces).size!==namespaces.length||namespaces.some(n=>typeof n!=='string'||!safe(n+'/leaf.res')))fail();
 for(const f of request.files)for(const n of namespaces)if(!safe(n+'/'+f.path))fail();
 if(typeof stagingParent!=='string'||!path.isAbsolute(stagingParent)||!tool||!path.isAbsolute(tool.executable))fail();
 const stage=trusted.stageRuntimeManifest||stageRuntimeManifest,runTool=trusted.runLockedTool||require('./export').runLockedTool;
 cancelled(options.signal);
 const script=await fs.readFile(path.join(__dirname,'../godot/inspect_audio_resources.gd'));
 const retainedDirectories=[],resources=[];
 try{
  // Bound each native deserialization batch independently of the request-file budget.
  for(let offset=0;offset<request.files.length;offset+=4){
   cancelled(options.signal);
   const files=request.files.slice(offset,offset+4),expected=files.map(f=>request.expected.find(e=>e.path===f.path));
   const controls=[['inspect_audio_resources.gd',script],['project.godot',Buffer.from('config_version=5\n')],['request.json',Buffer.from(JSON.stringify({version:1,files:files.map(({base64,...f})=>f),expected}))]].map(([p,b])=>({path:p,size:b.length,hash:digest(b),base64:b.toString('base64')}));
   const captures=[...files,...controls],manifest=buildRuntimeManifest({roots:captures.map(f=>f.path),resources:captures.map(f=>({id:f.path,path:f.path,category:f.path.endsWith('.res')?'audio':'metadata'}))});
   const staged=await stage({captures,stagingParent,manifest,maxBytes:files.reduce((n,f)=>n+f.size,0)+1024*1024});retainedDirectories.push(staged.directory);cancelled(options.signal);
   const run=await runTool({tool,args:['--headless','--path',staged.directory,'--script','res://inspect_audio_resources.gd'],files:captures.map(f=>({path:path.join(staged.directory,f.path),size:f.size,hash:f.hash})),requestRoot:stagingParent,signal:options.signal});
   retainedDirectories.push(...(run.retainedDirectories||[]));cancelled(options.signal);
   if(run.error?.code==='ABORTED')throw Object.assign(new Error('Audio inspection cancelled'),{code:'ABORTED',process:run});
   if(run.error||run.exitCode!==0||/SCRIPT ERROR|ERROR:/.test(run.stdout+run.stderr))throw Object.assign(new Error('Native audio inspection failed'),{process:run});
   const lines=run.stdout.split(/\r?\n/).filter(l=>l.startsWith('AUDIO_RESOURCES '));if(lines.length!==1||lines[0].length>256*1024)fail();
   resources.push(...validateAudioInspection({files,expected},JSON.parse(lines[0].slice(16))).resources);
  }
  const result=validateAudioInspection(request,{version:1,resources}),records=new Map();
  for(const r of result.resources)for(const p of [r.path,...namespaces.map(n=>n+'/'+r.path)]){
   if(records.has(p))fail();records.set(p,{...structuredClone(r),path:p,sourcePath:r.path});
  }
  const authority=Object.freeze(Object.create(null));authorities.set(authority,records);
  return {...result,retainedDirectories,authority};
 }catch(error){for(const directory of [...(error.retainedDirectories||[]),...(error.stagingDirectory?[error.stagingDirectory]:[])])if(!retainedDirectories.includes(directory))retainedDirectories.push(directory);error.retainedDirectories=retainedDirectories;error.cleanupStatus='retained-unpublished';throw error;}
}
module.exports={prepareAudioInspection,validateAudioInspection,inspectNativeAudioResources,proveAudioResource};
