'use strict';
const schema=require('../schema/effect-plan.schema.json');
const {isDeepStrictEqual}=require('node:util');
const unsafe=new Set(['__proto__','prototype','constructor','script','command','executable','shell','expression']);
function validateEffectPlan(plan,{inventory,bindings=[],effects=[],sockets=[]}={}){
 const errors=[];const fail=(path,message)=>errors.push({path,code:'INVALID_EFFECT_PLAN',message});
 let encoded;
 try{encoded=JSON.stringify(plan);}catch{fail('/', 'Artifact must be finite acyclic JSON');return {valid:false,errors};}
 if(!encoded||Buffer.byteLength(encoded)>2097152){fail('/','Artifact exceeds 2 MiB or is not JSON');return {valid:false,errors};}
 function check(value,rule,path){
  if(rule.$ref)rule=schema.$defs[rule.$ref.split('/').pop()];
  const type=Array.isArray(value)?'array':value===null?'null':typeof value;
  if(rule.type&&type!==rule.type&&!(rule.type==='integer'&&Number.isInteger(value))){fail(path,'Expected '+rule.type);return;}
  if(rule.enum&&!rule.enum.includes(value))fail(path,'Unsupported value');
  if(type==='number'&&(!Number.isFinite(value)||(rule.minimum!==undefined&&value<rule.minimum)||(rule.maximum!==undefined&&value>rule.maximum)))fail(path,'Number outside permitted range');
  if(type==='string'&&(!value.length||(rule.maxLength&&Buffer.byteLength(value)>rule.maxLength)||(rule.pattern&&!new RegExp(rule.pattern).test(value))))fail(path,'Invalid string');
  if(type==='array'){if(value.length>(rule.maxItems??2000)||value.length<(rule.minItems??0))fail(path,'Invalid item count');value.forEach((v,i)=>check(v,rule.items||{},`${path}/${i}`));}
  if(type==='object'){
   if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)fail(path,'Only plain JSON objects permitted');
   for(const field of rule.required||[])if(!Object.hasOwn(value,field))fail(path+'/'+field,'Missing field');
   for(const [key,v]of Object.entries(value)){if(unsafe.has(key)||!rule.properties?.[key])fail(path+'/'+key,'Unknown or unsafe field');else check(v,rule.properties[key],path+'/'+key);}
  }
 }
 check(plan,schema,'');
 if(errors.length)return {valid:false,errors};
 if(!inventory||inventory.complete===false||plan.characterId!==inventory.characterId||plan.mechanicsFingerprint!==inventory.fingerprint||plan.inspectionVersion!==String(inventory.version))fail('/','Missing, incomplete or stale mechanics inventory');
 const unique=(items,key,path)=>{const map=new Map();for(const item of items){const id=item[key];if(map.has(id))fail(path,'Duplicate '+id);map.set(id,item);}return map;};
 const evidence=unique(plan.evidence,'id','/evidence');const mechanics=unique(inventory?.mechanics||[],'key','/inventory/mechanics');
 const suppliedEvidence=new Map((inventory?.evidence||[]).map(e=>[e.id,e]));
 for(const e of evidence.values())if(e.lineEnd<e.lineStart||!isDeepStrictEqual(e,suppliedEvidence.get(e.id)))fail('/evidence/'+e.id,'Evidence must match inspected hashed source record and valid line range');
 const bindingMap=new Map(bindings.map(b=>[b.id,b]));const effectMap=new Map(effects.map(e=>[e.id,e]));const socketIds=new Set(sockets.map(s=>typeof s==='string'?s:s.id));
 const seen=new Set(),usedBindings=new Map(),channels=new Set();let rules=0;
 unique(plan.decisions,'id','/decisions');
 for(const d of plan.decisions){
  const path='/decisions/'+d.id;const mechanic=mechanics.get(d.mechanicKey);
  if(!mechanic||seen.has(d.mechanicKey))fail(path,'Unknown or duplicate mechanic');seen.add(d.mechanicKey);
  if(!d.evidenceIds.length||new Set(d.evidenceIds).size!==d.evidenceIds.length||d.evidenceIds.some(id=>!evidence.has(id))||!d.evidenceIds.some(id=>mechanic?.evidenceIds.includes(id)))fail(path,'Missing inventory-backed evidence');
  if(d.bindingId){const b=bindingMap.get(d.bindingId);if(!b||b.mechanicKey!==d.mechanicKey||b.adapterContractVersion!==plan.adapterContractVersion)fail(path,'Unverified binding or contract');if(usedBindings.has(d.bindingId)&&usedBindings.get(d.bindingId)!==d.mechanicKey)fail(path,'Binding aliases distinct mechanics');usedBindings.set(d.bindingId,d.mechanicKey);}
  if(d.outcome!=='effect'){if(d.rule)fail(path,'Inactive decisions cannot activate rules');continue;}
  rules++;if(!d.bindingId||!d.rule){fail(path,'Effects require binding and rule');continue;}
  const r=d.rule;channels.add(r.channel);
  if(!socketIds.has(r.socketId))fail(path,'Unknown socket');
  if(r.condition.type==='amountAtLeast'&&!(r.condition.threshold>0))fail(path,'Positive threshold required');
  if(r.condition.type==='present'&&r.condition.threshold!==undefined)fail(path,'Present has no threshold');
  if(new Set(r.effectIds).size!==r.effectIds.length)fail(path,'Duplicate effects');
  for(const id of r.effectIds){const effect=effectMap.get(id);if(!effect||effect.implemented!==true||!['tint','overlay','trail','projectileVariant'].includes(effect.capability)){fail(path,'Unavailable effect capability '+id);continue;}
   if(!Array.isArray(effect.resources)||!effect.resources.length||effect.resources.some(a=>!a||!/^[a-f0-9]{64}$/.test(a.sha256)||!a.importSettings||typeof a.importSettings!=='object'||!a.styleProvenance||!a.approvalProvenance))fail(path,'Effect lacks resource hash, import, style or approval provenance');
  }
 }
 for(const key of mechanics.keys())if(!seen.has(key))fail('/decisions','Missing mechanic '+key);
 if(rules>64||channels.size>8)fail('/decisions','Effect rule or channel capacity exceeded');
 return {valid:errors.length===0,errors};
}
function assertEffectPlan(plan,options){const result=validateEffectPlan(plan,options);if(!result.valid)throw Object.assign(new Error('Invalid effect plan: '+result.errors.map(e=>e.message).join('; ')),{code:'INVALID_EFFECT_PLAN',errors:result.errors});const clone=JSON.parse(JSON.stringify(plan));function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}return freeze(clone);}
module.exports={validateEffectPlan,assertEffectPlan};
