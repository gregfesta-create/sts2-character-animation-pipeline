'use strict';
// Pure declaration validation. Live source authenticity belongs to the capture boundary.
const schema=require('../schema/animation-inventory.schema.json');
const HASH=/^[a-f0-9]{64}$/;
const hash=value=>typeof value==='string'&&HASH.test(value);
const unsafe=new Set(['__proto__','prototype','constructor','script','command','executable','shell','expression']);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const text=(value,max=2048)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\x00-\x1f]/.test(value);
function validateAnimationInventory(artifact,{inventory,spec}={}){
 const errors=[],diagnostics=[];
 const fail=(path,message)=>errors.push({path,code:'INVALID_ANIMATION_INVENTORY',message});
 const result=()=>({valid:errors.length===0,errors,complete:errors.length===0&&!diagnostics.length,animationInventoryComplete:errors.length===0&&!diagnostics.length,diagnostics,referencedClipIds:errors.length?[]:[...referenced].sort()});
 const referenced=new Set();
 // Inspect descriptors before serialization: JSON.stringify can execute toJSON/getters,
 // erase undefined/function values and normalize nonfinite numbers.
 function bounded(value,limit,label){
  let count=0,bytes=0;const ancestors=new Set();
  function visit(v,depth){
   if(++count>100000||depth>32)throw Error('Structural bounds exceeded');
   bytes+=typeof v==='string'?Buffer.byteLength(v):4;if(bytes>limit)throw Error('Byte limit exceeded');
   if(v===null||typeof v==='string'||typeof v==='boolean')return;
   if(typeof v==='number'){if(!Number.isFinite(v))throw Error('Nonfinite value');return;}
   if(typeof v!=='object'||(!Array.isArray(v)&&!plain(v))||Array.isArray(v)&&Object.getPrototypeOf(v)!==Array.prototype||ancestors.has(v))throw Error('Only acyclic plain JSON permitted');
   ancestors.add(v);
   const descriptors=Object.getOwnPropertyDescriptors(v);
   if(Object.getOwnPropertySymbols(v).length)throw Error('Symbol fields forbidden');
   for(const [key,d]of Object.entries(descriptors)){
    if(Array.isArray(v)&&key==='length')continue;
    if(!d.enumerable||!Object.hasOwn(d,'value')||unsafe.has(key)||Array.isArray(v)&&!/^\d+$/.test(key))throw Error('Unknown or executable field');
    visit(d.value,depth+1);
   }
   if(Array.isArray(v)&&Object.keys(descriptors).length!==v.length+1)throw Error('Sparse arrays forbidden');
   ancestors.delete(v);
  }
  try{visit(value,0);const encoded=JSON.stringify(value);if(!encoded||Buffer.byteLength(encoded)>limit)throw Error('Byte limit exceeded');return true;}
  catch(error){fail(label,error.message);return false;}
 }
 function check(v,rule,path){
  const type=Array.isArray(v)?'array':v===null?'null':typeof v;
  if(rule.type!==type&&!(rule.type==='integer'&&Number.isSafeInteger(v))){fail(path,'Expected '+rule.type);return;}
  if(Object.hasOwn(rule,'const')&&v!==rule.const||rule.enum&&!rule.enum.includes(v))fail(path,'Unsupported value');
  if(type==='string'&&(!v.trim()||v.length>(rule.maxLength??2048)||path.endsWith('/reason')&&Buffer.byteLength(v)>4096||rule.pattern&&!new RegExp(rule.pattern).test(v)))fail(path,'Invalid string');
  if(type==='array'){
   if(v.length<(rule.minItems??0)||v.length>(rule.maxItems??2000))fail(path,'Invalid item count');
   if(rule.uniqueItems&&new Set(v).size!==v.length)fail(path,'Duplicate references');
   v.forEach((item,i)=>check(item,rule.items,`${path}/${i}`));
  }
  if(type==='object'){
   for(const key of rule.required||[])if(!Object.hasOwn(v,key))fail(path+'/'+key,'Missing field');
   for(const [key,item]of Object.entries(v)){if(!Object.hasOwn(rule.properties,key))fail(path+'/'+key,'Unknown field');else check(item,rule.properties[key],path+'/'+key);}
  }
 }
 if(!bounded(artifact,2*1024*1024,'/'))return result();
 check(artifact,schema,'');if(errors.length)return result();
 if(!bounded(inventory,8*1024*1024,'/inventory'))return result();
 if(!plain(inventory)||inventory.version!==1||inventory.complete!==true||!text(inventory.characterId)||!hash(inventory.fingerprint)||!Array.isArray(inventory.mechanics)||!inventory.mechanics.length||inventory.mechanics.length>1000||!Array.isArray(inventory.evidence)||!inventory.evidence.length||inventory.evidence.length>2000){fail('/inventory','Nonempty completed mechanics inspection required');return result();}
 // Read only the clip identity projection, permitting ordinary specs to contain large meshes.
 const idDescriptor=plain(spec)&&Object.getOwnPropertyDescriptor(spec,'id');
 const clipsDescriptor=plain(spec)&&Object.getOwnPropertyDescriptor(spec,'animations');
 if(!idDescriptor||!Object.hasOwn(idDescriptor,'value')||!clipsDescriptor||!Object.hasOwn(clipsDescriptor,'value')||!Array.isArray(clipsDescriptor.value)||clipsDescriptor.value.length>10000){fail('/spec','Character spec and bounded animations required');return result();}
 if(artifact.characterId!==inventory.characterId||artifact.characterId!==idDescriptor.value||artifact.mechanicsFingerprint!==inventory.fingerprint||artifact.inspectionVersion!==String(inventory.version))fail('/','Stale or wrong-character inspection');
 const clips=new Set(),clipArray=clipsDescriptor.value;
 if(Object.getPrototypeOf(clipArray)!==Array.prototype||Object.getOwnPropertySymbols(clipArray).length){fail('/spec/animations','Plain clip array required');return result();}
 for(let index=0;index<clipArray.length;index++){
  const item=Object.getOwnPropertyDescriptor(clipArray,String(index)),clip=item&&Object.hasOwn(item,'value')?item.value:null;
  const descriptor=plain(clip)&&Object.getOwnPropertyDescriptor(clip,'id');const id=descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:null;
  if(!text(id,64)||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)||clips.has(id))fail('/spec/animations','Invalid or duplicate clip identity');else clips.add(id);
 }
 const evidence=new Map();
 for(const e of inventory.evidence){
  if(!plain(e)||!hash(e.id)||!hash(e.hash)||!text(e.path,4096)||!text(e.symbol,2048)||typeof e.excerpt!=='string'||!e.excerpt.includes(e.symbol)||Buffer.byteLength(e.excerpt)>16384||!Number.isSafeInteger(e.lineStart)||e.lineStart<1||!Number.isSafeInteger(e.lineEnd)||e.lineEnd<e.lineStart||evidence.has(e.id)){fail('/inventory/evidence','Malformed or duplicate inspected evidence');continue;}
  evidence.set(e.id,e);
 }
 const mechanics=new Map(),identities=new Set();
 for(const m of inventory.mechanics){
  if(!plain(m)||!text(m.key)||!text(m.modId)||!text(m.modelSymbol)||!Array.isArray(m.evidenceIds)||!m.evidenceIds.length||m.evidenceIds.length>2000||new Set(m.evidenceIds).size!==m.evidenceIds.length||m.evidenceIds.some(id=>!evidence.has(id))||!m.evidenceIds.some(id=>evidence.get(id)?.symbol===m.modelSymbol)||mechanics.has(m.key)||identities.has(JSON.stringify([m.modId,m.modelSymbol]))){fail('/inventory/mechanics','Malformed, duplicate or unproven mechanic');continue;}
  mechanics.set(m.key,m);identities.add(JSON.stringify([m.modId,m.modelSymbol]));
 }
 if(errors.length)return result();
 const seen=new Set();
 for(const [index,d]of artifact.decisions.entries()){
  const path='/decisions/'+index,m=mechanics.get(d.mechanicKey);
  if(!m||seen.has(d.mechanicKey))fail(path,'Unknown or duplicate mechanic');seen.add(d.mechanicKey);
  if(d.evidenceIds.some(id=>!evidence.has(id))||!d.evidenceIds.some(id=>m?.evidenceIds.includes(id)))fail(path+'/evidenceIds','Current evidence belonging to this mechanic required');
  if(d.outcome==='animate'){
   if(!d.clipIds.length)fail(path+'/clipIds','Animated mechanic requires clips');
   for(const id of d.clipIds){if(!clips.has(id))fail(path+'/clipIds','Unknown clip '+id);referenced.add(id);}
  }else if(d.clipIds.length)fail(path+'/clipIds','Inactive decisions cannot reference clips');
  if(d.outcome==='unresolved')diagnostics.push({code:'ANIMATION_INVENTORY_UNRESOLVED',mechanicKey:d.mechanicKey,message:d.reason});
 }
 for(const key of mechanics.keys())if(!seen.has(key))fail('/decisions','Missing mechanic '+key);
 return result();
}
function assertAnimationInventory(artifact,options){
 const result=validateAnimationInventory(artifact,options);
 if(!result.valid)throw Object.assign(new Error('Invalid animation inventory: '+result.errors.map(e=>e.message).join('; ')),{code:'INVALID_ANIMATION_INVENTORY',errors:result.errors});
 const copy=JSON.parse(JSON.stringify(artifact));
 function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
 return freeze(copy);
}
module.exports={validateAnimationInventory,assertAnimationInventory};
