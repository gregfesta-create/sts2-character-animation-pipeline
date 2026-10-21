'use strict';
// This maps declarations captured by the caller from verified compiler receipts.
// It supplies no native resource authority and never discovers adjacent metadata.
const crypto=require('node:crypto');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=()=>{throw Object.assign(new Error('Invalid verified compiler audio eligibility'),{code:'INVALID_AUDIO_RESOURCE'});};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const token=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
const safe=v=>typeof v==='string'&&v.length<=512&&/^[A-Za-z0-9_./-]+$/.test(v)&&v.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!/[. ]$/.test(p)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p));
function collectAudioEligibility({metadata,files}={}){
 if(!Array.isArray(metadata)||metadata.length>256||!Array.isArray(files)||files.length>1000)fail();
 const declarations=new Map(),prefixes=new Set();let count=0,total=0;
 for(const m of metadata){
  if(!exact(m,['id','prefix','validation'])||!token(m.id)&&m.id!=='root'||typeof m.prefix!=='string'||m.prefix!==''&&(!safe(m.prefix)||!/^components\/[A-Za-z][A-Za-z0-9_-]{0,63}(?:\/components\/[A-Za-z][A-Za-z0-9_-]{0,63}){0,3}$/.test(m.prefix))||prefixes.has(m.prefix.toLowerCase())||!object(m.validation)||m.validation.valid!==true)fail();
  prefixes.add(m.prefix.toLowerCase());const audio=m.validation.audio??[];if(!Array.isArray(audio)||audio.length>1000)fail();const ids=new Set();
  for(const a of audio){
   if(++count>4000||!exact(a,['id','format','duration','resource'])||!token(a.id)||ids.has(a.id)||!['wav','ogg-vorbis'].includes(a.format)||!Number.isFinite(a.duration)||a.duration<=0||a.duration>30||typeof a.resource!=='string'||!a.resource.startsWith('res://')||!safe(a.resource.slice(6))||!a.resource.endsWith('.res'))fail();
   ids.add(a.id);const p=(m.prefix?m.prefix+'/':'')+a.resource.slice(6);if(!safe(p))fail();const previous=declarations.get(p.toLowerCase());
   if(previous&&(previous.resource!=='res://'+p||previous.format!==a.format||previous.duration!==a.duration))fail();
   if(!previous)declarations.set(p.toLowerCase(),Object.freeze({id:'audio_'+digest(m.prefix+'\0'+a.id).slice(0,48),format:a.format,duration:a.duration,resource:'res://'+p}));
  }
 }
 const selected=[],captures=[],seen=new Set();
 for(const f of files){
  if(!exact(f,['path','size','hash','base64'])||!safe(f.path)||!f.path.endsWith('.res')||seen.has(f.path.toLowerCase())||!Number.isSafeInteger(f.size)||f.size<4||f.size>17*1024*1024||typeof f.hash!=='string'||!/^[a-f0-9]{64}$/.test(f.hash)||typeof f.base64!=='string'||f.base64.length!==Math.ceil(f.size/3)*4)fail();
  total+=f.size;if(total>256*1024*1024)fail();const b=Buffer.from(f.base64,'base64'),a=declarations.get(f.path.toLowerCase());if(!a||a.resource!=='res://'+f.path||b.length!==f.size||b.toString('base64')!==f.base64||digest(b)!==f.hash||b.subarray(0,4).toString()!=='RSRC')fail();
  seen.add(f.path.toLowerCase());selected.push(a);captures.push(Object.freeze({...f}));
 }
 return Object.freeze({version:1,audio:Object.freeze(selected),files:Object.freeze(captures)});
}
module.exports={collectAudioEligibility};
