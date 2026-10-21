'use strict';
/** Root-only effect artifact boundary. No writes, native tools, inference or artwork approval.
 * captureEffectPlan({characterId,planPath,inventoryPath}, {config,capabilities,styleHash,approval,signal})
 * config.sourceRoots owns JSON/resource inputs; config.mechanics.sourceRoots is the live inspection scope.
 * Application-owned capabilities: {version,adapterContractVersion,gameFingerprint,baseLibFingerprint,
 * bindings,sockets,effects,supportsEffect(effect)}. Effects carry resources with
 * {path,sha256,importSettings,styleHash,approvalId}. supportsEffect must return true for a supported
 * tint/overlay implementation. Artifact implemented/provenance strings never grant capabilities.
 * approval({resourceHash,styleHash,approvalId,importSettings}) must return true for an existing receipt.
 * Returns deeply frozen {status,plan,inventory,resources,captures,fingerprint,diagnostics}.
 * Captured bytes are immutable base64 strings, not mutable Buffers. Unresolved returns plan:null
 * and resources:[]; diagnostics preserve exact missing scope. The caller publishes these captures
 * atomically in its owned job DAG. Every call re-inspects live mechanics, including resume.
 * Validated means evidence/structure accepted, not live-game integration or semantic approval.
 * Catalog version/game/BaseLib identities must be supplied by trusted host probes, not artifact data.
 */
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {constants}=require('node:fs');
const {resolveContained,hashValue,hashFile}=require('./assets');
const {inspectMechanics}=require('./mechanics');
const {assertEffectPlan}=require('./effect-plan');
const schema=require('../schema/effect-plan.schema.json');
const HASH=/^[a-f0-9]{64}$/;
const fail=(code,message)=>Object.assign(new Error(message),{code});
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function structural(plan){
 let count=0;
 function check(value,rule,depth=0){
  if(++count>100000||depth>64)throw fail('INVALID_EFFECT_PLAN','Effect plan exceeds structural bounds.');
  if(rule.$ref)rule=schema.$defs[rule.$ref.split('/').pop()];
  const type=Array.isArray(value)?'array':value===null?'null':typeof value;
  if(rule.type&&type!==rule.type&&!(rule.type==='integer'&&Number.isInteger(value))||rule.enum&&!rule.enum.includes(value))throw fail('INVALID_EFFECT_PLAN','Unsupported effect-plan shape or value.');
  if(type==='number'&&(!Number.isFinite(value)||rule.minimum!==undefined&&value<rule.minimum||rule.maximum!==undefined&&value>rule.maximum))throw fail('INVALID_EFFECT_PLAN','Invalid effect-plan number.');
  if(type==='string'&&(!value.length||rule.maxLength&&Buffer.byteLength(value)>rule.maxLength||rule.pattern&&!new RegExp(rule.pattern).test(value)))throw fail('INVALID_EFFECT_PLAN','Invalid effect-plan string.');
  if(type==='array'){if(value.length>(rule.maxItems??2000)||value.length<(rule.minItems??0))throw fail('INVALID_EFFECT_PLAN','Invalid effect-plan item count.');for(const item of value)check(item,rule.items||{},depth+1);}
  if(type==='object'){
   if((rule.required||[]).some(k=>!Object.hasOwn(value,k)))throw fail('INVALID_EFFECT_PLAN','Missing effect-plan field.');
   for(const [key,item]of Object.entries(value)){if(!Object.hasOwn(rule.properties||{},key)||['__proto__','prototype','constructor','script','shell','command','executable','expression'].includes(key))throw fail('INVALID_EFFECT_PLAN','Unknown or executable effect-plan field.');check(item,rule.properties[key],depth+1);}
  }
 }
 check(plan,schema);
}
async function captureEffectPlan(request,{config,capabilities,styleHash,approval,signal}={}){
 const abort=()=>{if(signal?.aborted)throw fail('ABORTED','Effect capture cancelled.');};abort();
 if(!request||Object.keys(request).some(k=>!['characterId','planPath','inventoryPath'].includes(k))||typeof request.characterId!=='string'||!request.characterId.length||!Array.isArray(config?.sourceRoots)||!config.sourceRoots.length||config.sourceRoots.length>32)throw fail('INVALID_INPUT','Root character and configured input roots are required.');
 const captures=[],physical=new Map();let total=0,readCount=0;
 async function resolve(input){
  if(typeof input!=='string'||!input||input.includes('\0')||!path.isAbsolute(input)&&input.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'))throw fail('UNSAFE_PATH','Invalid effect input reference.');
  for(const root of config.sourceRoots){
   const absolute=path.resolve(root),relative=path.isAbsolute(input)?path.relative(absolute,input):input;
   if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))continue;
   try{
    if(await fs.realpath(absolute)!==absolute||(await fs.lstat(absolute)).isSymbolicLink())throw fail('UNSAFE_PATH','Effect input root is linked.');
    return {root:absolute,relative,file:await resolveContained(absolute,relative)};
   }catch(e){if(e.code!=='ENOENT')throw e;}
  }
  throw fail('UNSAFE_PATH','Effect input is missing or outside configured roots: '+input);
 }
 async function read(input,kind,limit){
  abort();if(++readCount>512)throw fail('QUOTA_EXCEEDED','Too many effect capture references.');const owned=await resolve(input),handle=await fs.open(owned.file,constants.O_RDONLY|(process.platform==='win32'?0:(constants.O_NOFOLLOW||0)));
  try{
   const before=await handle.stat();if(!before.isFile())throw fail('INVALID_INPUT','Effect input must be a regular file.');
   if(before.size>limit)throw fail('QUOTA_EXCEEDED','Effect input exceeds byte limit.');
   async function verify(){
    const current=await fs.lstat(await resolveContained(owned.root,owned.relative)),opened=await handle.stat();
    if(await fs.realpath(owned.root)!==owned.root||current.isSymbolicLink()||current.dev!==before.dev||current.ino!==before.ino||opened.size!==before.size||opened.mtimeMs!==before.mtimeMs||opened.ctimeMs!==before.ctimeMs)throw fail('SOURCE_CHANGED','Effect input changed during capture.');
   }
   await verify();const chunks=[];let size=0;
   while(true){abort();const chunk=Buffer.alloc(Math.min(65536,limit-size+1)),{bytesRead}=await handle.read(chunk,0,chunk.length,null);if(!bytesRead)break;size+=bytesRead;if(size>limit)throw fail('QUOTA_EXCEEDED','Effect input exceeds byte limit.');chunks.push(chunk.subarray(0,bytesRead));}
   await verify();if(size!==before.size)throw fail('SOURCE_CHANGED','Effect input size changed during capture.');
   const bytes=Buffer.concat(chunks),hash=crypto.createHash('sha256').update(bytes).digest('hex');
   const previous=physical.get(hash);
   if(previous?.kind===kind)return previous;
   if(!previous)total+=size;if(total>64*1024*1024)throw fail('QUOTA_EXCEEDED','Combined effect captures exceed limits.');
   const record={path:owned.file,kind,hash,size,base64:previous?.base64??bytes.toString('base64')};if(!previous)physical.set(hash,record);captures.push(record);return record;
  }finally{await handle.close();}
 }
 function json(record){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(record.base64,'base64')));}catch{throw fail('INVALID_EFFECT_PLAN','Effect artifacts must be strict UTF-8 JSON.');}}
 const planCapture=await read(request.planPath,'plan',2*1024*1024),inventoryCapture=await read(request.inventoryPath,'inventory',8*1024*1024),plan=json(planCapture),inventory=json(inventoryCapture);structural(plan);
 if(plan.characterId!==request.characterId||inventory?.characterId!==request.characterId||inventory.version!==1||inventory.complete!==true||!HASH.test(inventory.fingerprint)||!Array.isArray(inventory.mechanics)||inventory.mechanics.length>1000||!Array.isArray(inventory.evidence)||inventory.evidence.length>2000)throw fail('INVALID_EFFECT_PLAN','Invalid root mechanics inspection receipt.');
 if(inventory.mechanics.some(m=>!m||typeof m.key!=='string'||typeof m.modId!=='string'||typeof m.modelSymbol!=='string'||!Array.isArray(m.evidenceIds)||m.evidenceIds.length>2000)||inventory.evidence.some(e=>!e||typeof e.id!=='string'))throw fail('INVALID_EFFECT_PLAN','Malformed mechanics inventory entries.');
 // Audit inventory coverage/evidence even when native capabilities are unavailable. This projection
 // cannot activate a rule and deliberately grants no synthetic binding or effect capability.
 const audit=structuredClone(plan);for(const d of audit.decisions){if(d.outcome==='effect'){d.outcome='unresolved';delete d.rule;}delete d.bindingId;}
 assertEffectPlan(audit,{inventory});
 const positive=plan.decisions.filter(d=>d.outcome==='effect');
 if(positive.length>64||new Set(positive.map(d=>d.rule?.channel)).size>8)throw fail('INVALID_EFFECT_PLAN','Effect rule or channel capacity exceeded.');
 for(const d of positive){const r=d.rule;if(!d.bindingId||!r||r.condition.type==='present'&&r.condition.threshold!==undefined||r.condition.type==='amountAtLeast'&&!(r.condition.threshold>0)||new Set(r.effectIds).size!==r.effectIds.length)throw fail('INVALID_EFFECT_PLAN','Malformed enabled effect rule.');}
 const implementation=hashValue(await Promise.all(['lib/effect-build.js','lib/effect-plan.js','lib/mechanics.js','schema/effect-plan.schema.json'].map(async file=>({file,hash:await hashFile(path.resolve(__dirname,'..',file))}))));abort();
 const diagnostics=[];let current=null;
 function result(accepted,resources=[],catalogIdentity=null){abort();return freeze({status:accepted?'validated':'unresolved',plan:accepted||null,inventory:current,resources,captures,fingerprint:hashValue({version:1,implementation,inputs:captures.map(({kind,hash,size})=>({kind,hash,size})),mechanics:current?.fingerprint??null,styleHash:styleHash??null,catalog:catalogIdentity,diagnostics}),diagnostics});}
 const roots=config.mechanics?.sourceRoots;
 if(!Array.isArray(roots)||!roots.length){diagnostics.push({code:'MECHANICS_UNAVAILABLE',message:'Configured live mechanics.sourceRoots are required.'});return result(null);}
 for(const root of roots){abort();try{await fs.stat(root);}catch(e){if(!['ENOENT','EACCES','EPERM'].includes(e.code))throw e;diagnostics.push({code:'MECHANICS_UNAVAILABLE',path:root,message:'Live mechanics source root is unavailable.'});}}
 if(diagnostics.length)return result(null);
 const evidence=new Map(inventory.evidence.map(e=>[e.id,e]));
 const declarations=inventory.mechanics.map(m=>({key:m.key,modId:m.modId,modelSymbol:m.modelSymbol,evidence:(m.evidenceIds||[]).map(id=>{const e=evidence.get(id);if(!e)throw fail('INVALID_EFFECT_PLAN','Inspection evidence reference is missing.');return {path:e.path,symbol:e.symbol,lineStart:e.lineStart,lineEnd:e.lineEnd};})}));
 try{current=await inspectMechanics({characterId:request.characterId,sourceRoots:roots,mechanics:declarations});}catch(e){if(e.code==='INVALID_MECHANICS')throw fail('STALE_EFFECT_PLAN','Current mechanic inspection cannot validate supplied evidence: '+e.message);throw e;}abort();
 if(current.fingerprint!==inventory.fingerprint||plan.mechanicsFingerprint!==current.fingerprint)throw fail('STALE_EFFECT_PLAN','Current mechanics membership or content differs from supplied decisions.');
 if(!positive.length){const accepted=assertEffectPlan(plan,{inventory:current,bindings:capabilities?.bindings||[]});return result(accepted);}
 if(!capabilities||typeof capabilities.supportsEffect!=='function'||!['version','adapterContractVersion','gameFingerprint','baseLibFingerprint'].every(k=>typeof capabilities[k]==='string'&&capabilities[k].length)||!Array.isArray(capabilities.bindings)||!Array.isArray(capabilities.effects)||!Array.isArray(capabilities.sockets)){
  diagnostics.push({code:'CAPABILITY_MISSING',message:'A trusted versioned native binding/effect catalog is unavailable.'});return result(null);
 }
 if(capabilities.adapterContractVersion!==plan.adapterContractVersion)throw fail('INVALID_EFFECT_PLAN','Native adapter contract version differs from the plan.');
 const used=[...new Set(positive.flatMap(d=>d.rule.effectIds))],effects=[],resources=[];
 for(const id of used){
  abort();const effect=capabilities.effects.find(e=>e.id===id);
  if(!effect||!['tint','overlay'].includes(effect.capability)||await capabilities.supportsEffect(effect)!==true){diagnostics.push({code:'CAPABILITY_MISSING',effectId:id,message:'Requested effect implementation is unavailable.'});continue;}
  if(!Array.isArray(effect.resources)||!effect.resources.length)throw fail('INVALID_EFFECT_PLAN','Implemented effect requires explicit resource provenance.');
  const verified=[];
  for(const resource of effect.resources){
   if(!resource||!HASH.test(resource.sha256)||!resource.importSettings||typeof resource.importSettings!=='object'||Array.isArray(resource.importSettings)||resource.styleHash!==styleHash||!HASH.test(styleHash)||typeof resource.approvalId!=='string'||!resource.approvalId.length)throw fail('INVALID_EFFECT_PLAN','Effect resource style/import/approval identity is invalid.');
   const captured=await read(resource.path,'resource',16*1024*1024);if(captured.hash!==resource.sha256)throw fail('CORRUPT_ARTIFACT','Effect resource does not match catalog hash.');
   const proof={resourceHash:captured.hash,styleHash,approvalId:resource.approvalId,importSettings:structuredClone(resource.importSettings)};
   if(typeof approval!=='function'||await approval(proof)!==true){diagnostics.push({code:'ARTWORK_APPROVAL_REQUIRED',effectId:id,resourceHash:captured.hash,message:'Existing artwork approval could not be verified.'});continue;}
   const acceptedResource={...captured,sha256:captured.hash,importSettings:proof.importSettings,styleProvenance:styleHash,approvalProvenance:resource.approvalId};verified.push(acceptedResource);
   if(!resources.some(r=>r.hash===captured.hash&&hashValue(r.importSettings)===hashValue(proof.importSettings)))resources.push(acceptedResource);
  }
  effects.push({...JSON.parse(JSON.stringify(effect)),implemented:true,resources:verified});
 }
 if(diagnostics.length)return result(null);
 const accepted=assertEffectPlan(plan,{inventory:current,bindings:capabilities.bindings,effects,sockets:capabilities.sockets});
 return result(accepted,resources,{version:capabilities.version,adapterContractVersion:capabilities.adapterContractVersion,gameFingerprint:capabilities.gameFingerprint,baseLibFingerprint:capabilities.baseLibFingerprint,bindings:capabilities.bindings,sockets:capabilities.sockets,effects:effects.map(effect=>({...effect,resources:effect.resources.map(({path,base64,kind,...resource})=>resource)}))});
}
module.exports={captureEffectPlan};
