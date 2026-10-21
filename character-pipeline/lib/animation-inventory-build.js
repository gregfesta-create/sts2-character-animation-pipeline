'use strict';
// Read-only live-source boundary. Captures are immutable bytes; validation is not visual acceptance.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {constants}=require('node:fs');
const {resolveContained,hashValue,hashFile}=require('./assets');
const {inspectMechanics}=require('./mechanics');
const {validateAnimationInventory,assertAnimationInventory}=require('./animation-inventory');
const fail=(code,message)=>Object.assign(new Error(message),{code});
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function snapshot(value){
 let count=0,bytes=0;const seen=new Set();
 function copy(v,depth=0){
  if(++count>2000000||depth>64||(bytes+=typeof v==='string'?Buffer.byteLength(v):8)>64*1024*1024)throw fail('INVALID_INPUT','Capture input exceeds bounds.');
  if(v===null||['string','boolean'].includes(typeof v))return v;
  if(typeof v==='number'&&Number.isFinite(v))return v;
  if(typeof v!=='object'||seen.has(v)||Object.getOwnPropertySymbols(v).length||![Object.prototype,Array.prototype,null].includes(Object.getPrototypeOf(v)))throw fail('INVALID_INPUT','Capture inputs must be plain JSON.');
  seen.add(v);const output=Array.isArray(v)?[]:{};
  for(const [key,d]of Object.entries(Object.getOwnPropertyDescriptors(v))){if(Array.isArray(v)&&key==='length')continue;if(!d.enumerable||!Object.hasOwn(d,'value')||['__proto__','constructor','prototype'].includes(key)||Array.isArray(v)&&!/^\d+$/.test(key))throw fail('INVALID_INPUT','Unsafe capture input field.');output[key]=copy(d.value,depth+1);}
  if(Array.isArray(v)&&output.length!==v.length||Array.isArray(v)&&Object.keys(output).length!==v.length)throw fail('INVALID_INPUT','Sparse capture arrays are forbidden.');
  seen.delete(v);return output;
 }
 return copy(value);
}
async function captureAnimationInventory(request,{config,spec,signal}={}){
 const abort=()=>{if(signal?.aborted)throw fail('ABORTED','Animation inventory capture cancelled.');};abort();
 if(!request||Object.keys(request).some(k=>!['characterId','planPath','inventoryPath'].includes(k))||typeof request.characterId!=='string'||!request.characterId.length||!Array.isArray(config?.sourceRoots)||!config.sourceRoots.length||config.sourceRoots.length>32)throw fail('INVALID_INPUT','Root character and configured input roots are required.');
 request=snapshot(request);spec=snapshot(spec);config=snapshot({sourceRoots:config.sourceRoots,...(config.mechanics?.sourceRoots!==undefined?{mechanics:{sourceRoots:config.mechanics.sourceRoots}}:{})});
 const captures=[],physical=new Map();let total=0,readCount=0;
 async function resolve(input){
  if(typeof input!=='string'||!input||input.includes('\0')||!path.isAbsolute(input)&&input.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'))throw fail('UNSAFE_PATH','Invalid animation inventory input reference.');
  for(const root of config.sourceRoots){
   const absolute=path.resolve(root),relative=path.isAbsolute(input)?path.relative(absolute,input):input;
   if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))continue;
   try{
    if(await fs.realpath(absolute)!==absolute||(await fs.lstat(absolute)).isSymbolicLink())throw fail('UNSAFE_PATH','Animation inventory input root is linked.');
    return {root:absolute,relative,file:await resolveContained(absolute,relative)};
   }catch(e){if(e.code!=='ENOENT')throw e;}
  }
  throw fail('UNSAFE_PATH','Animation inventory input is missing or outside configured roots: '+input);
 }
 async function read(input,kind,limit){
  abort();if(++readCount>512)throw fail('QUOTA_EXCEEDED','Too many animation inventory capture references.');const owned=await resolve(input);if(!(await fs.lstat(owned.file)).isFile())throw fail('INVALID_INPUT','Animation inventory input must be a regular file.');const handle=await fs.open(owned.file,constants.O_RDONLY|(process.platform==='win32'?0:(constants.O_NOFOLLOW||0)));
  try{
   const before=await handle.stat();if(!before.isFile())throw fail('INVALID_INPUT','Animation inventory input must be a regular file.');
   if(before.size>limit)throw fail('QUOTA_EXCEEDED','Animation inventory input exceeds byte limit.');
   async function verify(){
    const current=await fs.lstat(await resolveContained(owned.root,owned.relative)),opened=await handle.stat();
    if(await fs.realpath(owned.root)!==owned.root||current.isSymbolicLink()||current.dev!==before.dev||current.ino!==before.ino||opened.size!==before.size||opened.mtimeMs!==before.mtimeMs||opened.ctimeMs!==before.ctimeMs)throw fail('SOURCE_CHANGED','Animation inventory input changed during capture.');
   }
   await verify();const chunks=[];let size=0;
   while(true){abort();const chunk=Buffer.alloc(Math.min(65536,limit-size+1)),{bytesRead}=await handle.read(chunk,0,chunk.length,null);if(!bytesRead)break;size+=bytesRead;if(size>limit)throw fail('QUOTA_EXCEEDED','Animation inventory input exceeds byte limit.');chunks.push(chunk.subarray(0,bytesRead));}
   await verify();if(size!==before.size)throw fail('SOURCE_CHANGED','Animation inventory input size changed during capture.');
   const bytes=Buffer.concat(chunks),hash=crypto.createHash('sha256').update(bytes).digest('hex');
   const previous=physical.get(hash);
   if(previous?.kind===kind)return previous;
   if(!previous)total+=size;if(total>64*1024*1024)throw fail('QUOTA_EXCEEDED','Combined animation inventory captures exceed limits.');
   const record={path:owned.file,kind,hash,size,base64:previous?.base64??bytes.toString('base64')};if(!previous)physical.set(hash,record);captures.push(record);return record;
  }finally{await handle.close();}
 }
 function json(record){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(record.base64,'base64')));}catch{throw fail('INVALID_ANIMATION_INVENTORY','Animation inventory artifacts must be strict UTF-8 JSON.');}}
 const planCapture=await read(request.planPath,'plan',2*1024*1024),inventoryCapture=await read(request.inventoryPath,'inventory',8*1024*1024);
 const plan=json(planCapture),inventory=json(inventoryCapture);
 if(plan?.characterId!==request.characterId)throw fail('INVALID_ANIMATION_INVENTORY','Wrong root character.');
 const accepted=assertAnimationInventory(plan,{inventory,spec});
 const validation=validateAnimationInventory(plan,{inventory,spec});
 const implementation=hashValue(await Promise.all(['lib/animation-inventory-build.js','lib/animation-inventory.js','lib/mechanics.js','lib/assets.js','schema/animation-inventory.schema.json'].map(async file=>({file,hash:await hashFile(path.resolve(__dirname,'..',file))}))));
 const diagnostics=[...validation.diagnostics];let current=null;
 function result(){abort();const complete=Boolean(current)&&validation.animationInventoryComplete&&!diagnostics.length;return freeze({status:complete?'validated':'unresolved',animationInventoryComplete:complete,plan:accepted,inventory:current,captures,referencedClipIds:validation.referencedClipIds,diagnostics,fingerprint:hashValue({version:1,implementation,spec,referencedClips:spec.animations.filter(clip=>validation.referencedClipIds.includes(clip.id)),inputs:captures.map(({kind,hash,size})=>({kind,hash,size})),mechanics:current?.fingerprint??null,diagnostics})});}
 const roots=config.mechanics?.sourceRoots;
 if(!Array.isArray(roots)||!roots.length){diagnostics.push({code:'MECHANICS_UNAVAILABLE',message:'Configured live mechanics.sourceRoots are required.'});return result();}
 for(const root of roots){abort();try{await fs.stat(root);}catch(e){if(!['ENOENT','EACCES','EPERM'].includes(e.code))throw e;diagnostics.push({code:'MECHANICS_UNAVAILABLE',path:root,message:'Live mechanics source root is unavailable.'});}}
 if(diagnostics.some(d=>d.code==='MECHANICS_UNAVAILABLE'))return result();
 const evidence=new Map(inventory.evidence.map(e=>[e.id,e]));
 const declarations=inventory.mechanics.map(m=>({key:m.key,modId:m.modId,modelSymbol:m.modelSymbol,evidence:m.evidenceIds.map(id=>{const e=evidence.get(id);return {path:e.path,symbol:e.symbol,lineStart:e.lineStart,lineEnd:e.lineEnd};})}));
 try{current=await inspectMechanics({characterId:request.characterId,sourceRoots:roots,mechanics:declarations});}catch(e){if(e.code==='INVALID_MECHANICS')throw fail('STALE_ANIMATION_INVENTORY','Current mechanics inspection cannot validate evidence: '+e.message);throw e;}
 abort();
 // Compare the complete receipt, including source files, excerpts and diagnostics. A copied
 // valid fingerprint must not authorize forged surrounding evidence or unrecognized fields.
 if(hashValue(current)!==hashValue(inventory)||plan.mechanicsFingerprint!==current.fingerprint)throw fail('STALE_ANIMATION_INVENTORY','Current mechanics receipt differs from supplied evidence.');
 assertAnimationInventory(plan,{inventory:current,spec});return result();
}
module.exports={captureAnimationInventory};





