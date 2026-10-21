'use strict';
// First-party capture boundary. Request JSON declares presentation, never code,
// artwork approval, native implementation identity, or working game power hooks.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {resolveContained,hashValue}=require('./assets');
const {openJob}=require('./jobs');
const {inspectArtworkReview}=require('./artwork-review');
const {inspectMechanics}=require('./mechanics');
const {assertEffectPlan}=require('./effect-plan');
const {normalizeEffectAnimation}=require('./effect-animation');
const HASH=/^[a-f0-9]{64}$/,TOKEN=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const fail=(code,message)=>Object.assign(new Error(message),{code});
const object=v=>v&&Object.getPrototypeOf(v)===Object.prototype;
function shape(v,keys){return object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));}
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function reject(message){throw fail('INVALID_EFFECT_REQUEST',message);}
function vector(v,n,min,max){return Array.isArray(v)&&v.length===n&&v.every(x=>Number.isFinite(x)&&x>=min&&x<=max);}
// Resume may relocate a byte-identical captured resource into its job sources.
// Its locator is not a capability; hash, approval, imports and presentation are.
function semanticEffect(effect){if(!effect||typeof effect!=='object')return null;return {...effect,resources:effect.resources?.map(({path:locator,...r})=>r)};}
function relative(v){return typeof v==='string'&&v.length<=4096&&!v.includes('\0')&&!path.isAbsolute(v)&&v.split(/[\\/]/).every(p=>p&&p!=='.'&&p!=='..');}
async function owned(root,rel){if(await fs.realpath(root)!==path.resolve(root)||(await fs.lstat(root)).isSymbolicLink())throw fail('UNSAFE_PATH','Linked input root is unsupported.');return resolveContained(root,rel);}
async function sourceFile(file,roots){
 if(typeof file!=='string'||!path.isAbsolute(file)||file.length>4096)throw fail('UNSAFE_PATH','Runtime binaries require absolute owned source paths.');
 for(const root of roots){const rel=path.relative(path.resolve(root),file);if(!relative(rel))continue;try{return {root:path.resolve(root),relative:rel,file:await owned(path.resolve(root),rel)};}catch(e){if(e.code!=='ENOENT')throw e;}}
 throw fail('UNSAFE_PATH','Runtime assembly is outside configured source roots.');
}
async function readVerified(location,maxBytes,{hash,pe=false,collect=false}={}){
 const {root,relative:rel,file}=location;
 const handle=await fs.open(file,'r');
 try{
  const before=await handle.stat();if(!before.isFile()||before.size<1||before.size>maxBytes)throw fail('QUOTA_EXCEEDED','Effect input byte limit or type is invalid.');
  async function verify(){
   if(await owned(root,rel)!==file)throw fail('SOURCE_CHANGED','Effect input locator changed during capture.');
   const current=await fs.lstat(file),after=await handle.stat();if(current.isSymbolicLink()||[current,after].some(s=>s.dev!==before.dev||s.ino!==before.ino||s.size!==before.size||s.mtimeMs!==before.mtimeMs||s.ctimeMs!==before.ctimeMs))throw fail('SOURCE_CHANGED','Effect input changed during capture.');
  }
  await verify();
  const digest=crypto.createHash('sha256');let total=0;const chunks=[];
  while(true){const b=Buffer.alloc(Math.min(65536,maxBytes-total+1)),r=await handle.read(b,0,b.length,null);if(!r.bytesRead)break;total+=r.bytesRead;if(total>maxBytes)throw fail('QUOTA_EXCEEDED','Effect input exceeds byte limit.');const bytes=b.subarray(0,r.bytesRead);digest.update(bytes);if(collect||pe&&total<=65536)chunks.push(bytes);}
  await verify();if(total!==before.size)throw fail('SOURCE_CHANGED','Effect input changed during capture.');
  const result=digest.digest('hex');if(hash&&result!==hash)throw fail('CORRUPT_ARTIFACT','Approved resource hash changed.');
  if(pe){const header=Buffer.concat(chunks);if(header.length<64||header.toString('ascii',0,2)!=='MZ')reject('Runtime input is not a PE binary.');const offset=header.readUInt32LE(60);if(offset<64||offset>header.length-4||!header.subarray(offset,offset+4).equals(Buffer.from([80,69,0,0])))reject('Runtime PE header is unsupported.');}
  return {hash:result,size:total,...(collect?{bytes:Buffer.concat(chunks)}:{})};
 }finally{await handle.close();}
}
async function captureEffectRequest(input,{config,spec,plan,inventory,heldJobRoot}={}){
 let request;try{const serialized=JSON.stringify(input);if(!serialized||Buffer.byteLength(serialized)>1024*1024)reject('Effect request exceeds 1 MiB.');request=JSON.parse(serialized);}catch(e){if(e.code)throw e;reject('Effect request must be bounded JSON.');}
 if(!shape(request,['version','runtime','resources','bindings','effects','targets'])||request.version!==1||!shape(request.runtime,['gameAssembly','baseLibAssembly']))reject('Unsupported effect request fields.');
 for(const key of ['resources','bindings','effects'])if(!Array.isArray(request[key])||!request[key].length||request[key].length>64)reject('Effect request list capacity exceeded.');
 if(!object(request.targets)||!Object.keys(request.targets).length||Object.keys(request.targets).length>64)reject('Explicit bounded targets are required.');
 if(!Array.isArray(config?.sourceRoots)||!config.sourceRoots.length||config.sourceRoots.length>32||!Array.isArray(config.mechanics?.sourceRoots)||!config.mechanics.sourceRoots.length||!path.isAbsolute(config.outputRoot||''))reject('Configured source, mechanic and output roots are required.');
 if(!spec||spec.id!==plan?.characterId||inventory?.characterId!==spec.id||plan.adapterContractVersion!=='1'||!Array.isArray(inventory.mechanics)||!Array.isArray(inventory.evidence))reject('Root character and adapter contract 1 are required.');
 const evidence=new Map(inventory.evidence.map(e=>[e.id,e]));
 const current=await inspectMechanics({characterId:spec.id,sourceRoots:config.mechanics.sourceRoots,mechanics:inventory.mechanics.map(m=>({key:m.key,modId:m.modId,modelSymbol:m.modelSymbol,evidence:m.evidenceIds.map(id=>{const e=evidence.get(id);if(!e)reject('Missing source evidence.');return {path:e.path,symbol:e.symbol,lineStart:e.lineStart,lineEnd:e.lineEnd};})}))});
 if(current.fingerprint!==inventory.fingerprint||plan.mechanicsFingerprint!==current.fingerprint)throw fail('STALE_EFFECT_PLAN','Live mechanic sources differ from inspected decisions.');
 const parts=new Set(spec.parts.map(p=>p.id)),sockets=new Set(spec.sockets.map(s=>s.id)),targetParts=new Set();
 for(const [id,target]of Object.entries(request.targets))if(!TOKEN.test(id)||!sockets.has(id)||!shape(target,['partId'])||!parts.has(target.partId)||targetParts.has(target.partId))reject('Targets must use unique existing parts and sockets.');else targetParts.add(target.partId);
 const bindingIds=new Set();for(const b of request.bindings){if(!shape(b,['id','mechanicKey'])||!TOKEN.test(b.id)||bindingIds.has(b.id)||!current.mechanics.some(m=>m.key===b.mechanicKey)||!plan.decisions.some(d=>d.outcome==='effect'&&d.bindingId===b.id&&d.mechanicKey===b.mechanicKey))reject('Binding is not backed by an inspected positive decision.');bindingIds.add(b.id);}
 const resources=new Map();for(const r of request.resources){if(!shape(r,['id','job','reviewId','sourceHash'])||!TOKEN.test(r.id)||resources.has(r.id)||!relative(r.job)||!HASH.test(r.reviewId)||!HASH.test(r.sourceHash))reject('Invalid approved original reference.');resources.set(r.id,r);}
 function overlay(p){
  if(!(shape(p,['offset','scale'])||shape(p,['offset','scale','animation']))||!vector(p.offset,2,-4096,4096)||Math.hypot(...p.offset)>4096||!vector(p.scale,2,Number.MIN_VALUE,16)||p.scale.some(x=>Math.fround(x)<=0))reject('Presentation parameters exceed native implementation bounds.');
  if(Object.hasOwn(p,'animation')){try{p.animation=normalizeEffectAnimation(p.animation);}catch{reject('Invalid overlay animation descriptor.');}}
 }
 const effects=new Map();for(const e of request.effects){
  if(!(shape(e,['id','capability','resourceId','presentation'])||shape(e,['id','capability','resourceId','presentation','impact']))||!TOKEN.test(e.id)||effects.has(e.id)||!resources.has(e.resourceId)||!['tint','overlay'].includes(e.capability))reject('Unsupported presentation entry.');
  if(e.capability==='tint'){if(!shape(e.presentation,['color'])||!vector(e.presentation.color,4,0,1))reject('Presentation parameters exceed native implementation bounds.');}else overlay(e.presentation);
  if(Object.hasOwn(e,'impact')){const i=e.impact;if(!shape(i,['resourceId','durationSeconds','presentation'])||!resources.has(i.resourceId)||!Number.isFinite(i.durationSeconds)||i.durationSeconds<=0||i.durationSeconds>10)reject('Invalid bounded impact descriptor.');overlay(i.presentation);}
  effects.set(e.id,e);
 }
 if(request.resources.some(r=>!request.effects.some(e=>e.resourceId===r.id||e.impact?.resourceId===r.id))||request.effects.some(e=>!plan.decisions.some(d=>d.outcome==='effect'&&d.rule.effectIds.includes(e.id))))reject('Unused resources or effects are unsupported.');
 const gameFile=await sourceFile(request.runtime.gameAssembly,config.sourceRoots),baseFile=await sourceFile(request.runtime.baseLibAssembly,config.sourceRoots);
 const game=await readVerified(gameFile,256*1024*1024,{pe:true}),base=await readVerified(baseFile,256*1024*1024,{pe:true});
 const leases=[],jobs=new Map(),verified=[];let closed=false;
 async function close(){if(closed)return;closed=true;const results=await Promise.allSettled(leases.map(j=>j.close()));const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;}
 const styleHash=hashValue(spec.style);
 async function verifyResource(record){
  const review=await inspectArtworkReview(record.jobRoot);if(review?.approved!==true||review.reviewId!==record.reviewId)throw fail('ARTWORK_APPROVAL_REQUIRED','Exact current original approval is required.');
  // Inspecting the public review verifies all originals/previews and its manifest;
  // the source content read here is solely the already-verified review's style.
  const reviewRelative='review/current.json',reviewPath=await owned(record.jobRoot,reviewRelative);const captured=await readVerified({root:record.jobRoot,relative:reviewRelative,file:reviewPath},8*1024*1024,{collect:true});const raw=JSON.parse(captured.bytes.toString('utf8'));
  if(raw.reviewId!==review.reviewId||hashValue({version:1,jobId:raw.jobId,content:raw.content,previews:raw.previews})!==review.reviewId||hashValue(raw.content?.style)!==styleHash||!review.originals.some(r=>r.hash===record.sourceHash&&r.path===record.path&&r.size===record.size))throw fail('ARTWORK_APPROVAL_REQUIRED','Approved original/style differs from the effect resource.');
  await readVerified({root:record.jobRoot,relative:path.relative(record.jobRoot,record.path),file:record.path},16*1024*1024,{hash:record.sourceHash});return true;
 }
 try{
  let total=0;const counted=new Set();
  for(const r of request.resources){
   const jobRoot=await owned(path.resolve(config.outputRoot),r.job);if(!jobs.has(jobRoot)){if(heldJobRoot===undefined||path.resolve(heldJobRoot)!==jobRoot)leases.push(await openJob(jobRoot));jobs.set(jobRoot,true);}
   const review=await inspectArtworkReview(jobRoot),source=review?.originals?.find(s=>s.hash===r.sourceHash);if(!source)throw fail('ARTWORK_APPROVAL_REQUIRED','Referenced approved original is unavailable.');
   const record={...r,jobRoot,path:source.path,size:source.size};await verifyResource(record);if(!counted.has(r.sourceHash)){total+=source.size;counted.add(r.sourceHash);}if(total>32*1024*1024)throw fail('QUOTA_EXCEEDED','Approved effect resources exceed 32 MiB.');verified.push(record);
  }
  const nativeEffects=request.effects.map(e=>{
   const r=verified.find(r=>r.id===e.resourceId),impactResource=e.impact?verified.find(r=>r.id===e.impact.resourceId):null;
   const proofs=[r,...(impactResource?[impactResource]:[])].map(r=>({path:r.path,sha256:r.sourceHash,styleHash,approvalId:r.reviewId,importSettings:{}}));
   const resources=[...new Map(proofs.map(r=>[hashValue((({path:locator,...proof})=>proof)(r)),r])).values()];
   return {id:e.id,capability:e.capability,presentation:e.capability==='tint'?e.presentation:{...e.presentation,resourceHash:r.sourceHash},...(e.impact?{impact:{durationSeconds:e.impact.durationSeconds,presentation:{...e.impact.presentation,resourceHash:impactResource.sourceHash}}}:{}),resources};
  });
  const bindings=request.bindings.map(b=>({...b,adapterContractVersion:'1'}));
  assertEffectPlan(plan,{inventory:current,bindings,sockets:[...sockets],effects:nativeEffects.map(e=>({...e,implemented:true,resources:e.resources.map(r=>({...r,styleProvenance:styleHash,approvalProvenance:r.approvalId}))}))});
  for(const d of plan.decisions)if(d.outcome==='effect'&&!Object.hasOwn(request.targets,d.rule.socketId))reject('Every effect requires an explicit existing part target.');
  const implementation=request.effects.some(e=>e.impact)?'first-party-tint-overlay-impact-3':'first-party-tint-overlay-2';
  const catalog=freeze(nativeEffects),capabilities=freeze({version:implementation,adapterContractVersion:'1',gameFingerprint:game.hash,baseLibFingerprint:base.hash,bindings,sockets:[...sockets],effects:catalog,supportsEffect:effect=>!closed&&catalog.some(e=>hashValue(semanticEffect(e))===hashValue(semanticEffect(effect)))});
  const requestIdentity=freeze({version:1,request,game:{path:gameFile.file,...game},baseLib:{path:baseFile.file,...base},resources:verified.map(({id,jobRoot,reviewId,sourceHash,size})=>({id,jobRoot,reviewId,sourceHash,size})),implementation});
  async function approval(proof){if(closed||!shape(proof,['resourceHash','styleHash','approvalId','importSettings'])||!object(proof.importSettings)||Object.keys(proof.importSettings).length||proof.styleHash!==styleHash)return false;const record=verified.find(r=>r.sourceHash===proof.resourceHash&&r.reviewId===proof.approvalId);if(!record)return false;try{return await verifyResource(record);}catch{return false;}}
  return Object.freeze({capabilities,approval,targets:freeze(structuredClone(request.targets)),requestIdentity,close,gameAcceptance:false,gameIntegrationComplete:false,requiresGameplayIntegration:true});
 }catch(e){await close();throw e;}
}
module.exports={captureEffectRequest};
