'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {hashValue,atomicWrite,resolveContained}=require('./assets');
const {runRepairs}=require('./repair');
const {applyRepairOperator}=require('./repair-operators');
const {inspectAuthoredGeometry}=require('./authored-geometry');
const {validateRgbaPng}=require('./visual-inspection');
const TOKEN=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const failure=message=>Object.assign(new Error(message),{code:'VISUAL_VALIDATION_FAILED'});
function immutable(value){if(value&&typeof value==='object'){Object.values(value).forEach(immutable);Object.freeze(value);}return value;}
function trustedError(error,value){
 if(error?.code!=='AUTHORED_GEOMETRY_FAILED')return error;
 try{inspectAuthoredGeometry(value);}catch(checked){if(checked?.code==='AUTHORED_GEOMETRY_FAILED')return checked;}
 return error;
}
function diagnoses(error,spec){
 if(error?.code==='AUTHORED_GEOMETRY_FAILED'){
  let checked;try{inspectAuthoredGeometry(spec);return null;}catch(cause){if(cause?.code!=='AUTHORED_GEOMETRY_FAILED')return null;checked=cause;}
  // Only the independently recomputed receipt can authorize authored correction.

  const raw=checked.diagnostics;
  if(!Array.isArray(raw)||!raw.length||raw.some(d=>!['TRIANGLE_INVERSION','TRIANGLE_COLLAPSE'].includes(d.code)||typeof d.clipId!=='string'||!spec.animations.some(c=>c.id===d.clipId)||!spec.parts.some(p=>p.id===d.partId&&p.mesh&&Number.isInteger(d.triangle)&&d.triangle>=0&&d.triangle<p.mesh.triangles.length)||!Number.isFinite(d.restSignedArea)||d.restSignedArea===0||!Number.isFinite(d.signedArea)||d.signedArea!==0&&Math.sign(d.signedArea)===Math.sign(d.restSignedArea)))return null;
  return spec.animations.filter(c=>raw.some(d=>d.clipId===c.id)).map((c,i)=>({id:'deformationRepair'+i,code:'AUTHORED_DEFORMATION',asset:c.id,message:'Independently measured authored sampled triangle collapse or inversion',actionIds:['dampenClipPose']}));
 }
 const raw=error?.diagnostics;if(!Array.isArray(raw)||!raw.length||raw.length>100)return null;
 const clips=new Map(),boneCount=(spec.bones||[]).length;
 for(const item of raw){
  // jointN is the collector's local identifier, never an authored bone ID.
  // Whole-clip closure requires no guessed mapping to an individual bone.
  if(!item||item.code!=='LOOP_SEAM'||typeof item.clipId!=='string'||!TOKEN.test(item.clipId)||typeof item.jointId!=='string'||!/^joint(0|[1-9][0-9]*)$/.test(item.jointId)||Number(item.jointId.slice(5))>=boneCount||!Number.isFinite(item.measured)||item.measured<=0||!Number.isFinite(item.limit)||item.limit<0||item.measured<=item.limit)return null;
  const matches=(spec.animations||[]).filter(c=>c.id===item.clipId);if(matches.length!==1||matches[0].loop!==true)return null;
  clips.set(item.clipId,true);
 }
 return [...clips.keys()].map((clip,index)=>({id:'loopRepair'+index,code:'LOOP_SEAM',asset:clip,message:'Native sampled loop displacement exceeds its declared limit',actionIds:['closeLoopPose']}));
}
async function verifyRendered(built,root){
 if(built?.validation?.valid!==true||!['passed','unverified'].includes(built.validation.geometry?.status)||built.validation.geometry?.report&&built.validation.geometry.report.status!==built.validation.geometry.status||!Array.isArray(built.frames)||!built.frames.length||built.frames.length>64||!Array.isArray(built.validation.frames)||built.validation.frames.length!==built.frames.length)throw failure('Repair compile did not return valid geometry and fresh rendered frames');
 let encodedBytes=0,pixels=0;const seen=new Set();for(const [index,file]of built.frames.entries()){
  if(typeof file!=='string'||path.basename(file)!==built.validation.frames[index])throw failure('Repair compile returned an invalid frame path');
  const relative=path.relative(root,path.resolve(file));let resolved;
  try{resolved=await resolveContained(root,relative);if(seen.has(resolved))throw failure('Duplicate fresh frame');
   const handle=await fs.open(resolved,'r');try{
    const stat=await handle.stat();if(!stat.isFile()||stat.size<33||stat.size>16*1024*1024||encodedBytes+stat.size>64*1024*1024)throw failure('Invalid fresh frame size');
    const bytes=Buffer.alloc(stat.size);let offset=0;
    while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)throw failure('Truncated fresh frame');offset+=read.bytesRead;}
    const after=await handle.stat(),current=await fs.lstat(await resolveContained(root,relative));
    if([after,current].some(s=>s.size!==stat.size||s.dev!==stat.dev||s.ino!==stat.ino||s.mtimeMs!==stat.mtimeMs||s.ctimeMs!==stat.ctimeMs))throw failure('Fresh frame changed while being verified');
    const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
    if(width<1||height<1||width>4096||height>4096||pixels+width*height>16*1024*1024||!validateRgbaPng(bytes,width,height))throw failure('Rendered frame is not a complete bounded RGBA PNG');
    encodedBytes+=bytes.length;pixels+=width*height;
   }finally{await handle.close();}
  }catch(cause){throw Object.assign(failure('Rendered frame is missing, invalid or outside its owned attempt'),{cause});}
  seen.add(resolved);
 }
}
async function compileWithRepairs(spec,options={}){
 const {compile=require('../backends/godot').compileGodot,persist,maxAttempts=3,...compileOptions}=options;
 if(typeof compile!=='function'||persist!==undefined&&typeof persist!=='function'||!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>3||typeof compileOptions.stagingDir!=='string')throw Object.assign(new Error('Invalid compile repair configuration'),{code:'INVALID_REPAIR'});
 const checkCancelled=()=>{if(compileOptions.signal?.aborted)throw Object.assign(new Error('Repair compile cancelled'),{code:'CANCELLED'});};
 checkCancelled();const original=immutable(structuredClone(spec)),originalSpecHash=hashValue(original);
 if(!compileOptions.render){const built=await compile(original,compileOptions);checkCancelled();return {built,repair:{status:'not-requested',attempts:0,originalSpecHash,repairedSpecHash:originalSpecHash,history:[]}};}
 await fs.mkdir(compileOptions.stagingDir,{recursive:true});
 const root=await fs.mkdtemp(path.join(await fs.realpath(compileOptions.stagingDir),'compile-repair-')),historyPath=path.join(root,'history.json'),history=[];
 async function record(event){
  history.push(immutable(structuredClone(event)));await atomicWrite(historyPath,JSON.stringify(history,null,2));
  // Cancellation/error evidence must still be acknowledged after abort; throwing
  // a second cancellation here would hide the original in a persistence error.
  const terminalFailure=event.type==='cancelled'||event.type==='error';
  if(!terminalFailure)checkCancelled();if(persist)await persist(history.at(-1));if(!terminalFailure)checkCancelled();
 }
 let built,lastError,compileCount=0,currentValue=original,usedDamping=false,corrections=0;
 async function attempt(value){
  checkCancelled();currentValue=value;
  const number=compileCount,stagingDir=await resolveContained(root,'attempt'+number,{mustExist:false});await fs.mkdir(stagingDir);
  await record({version:1,type:'compile-attempt',scope:'candidate-callback-preflight',attempt:number,candidateHash:hashValue(value),directory:'attempt'+number});compileCount++;
  const result=await compile(immutable(structuredClone(value)),{...compileOptions,stagingDir});checkCancelled();await verifyRendered(result,stagingDir);checkCancelled();built=result;return result;
 }
 try{await attempt(original);}catch(error){if(!['VISUAL_VALIDATION_FAILED','AUTHORED_GEOMETRY_FAILED'].includes(error?.code))throw error;lastError=trustedError(error,currentValue);}
 const receipt=(status,attempts,value=currentValue)=>({version:1,status,attempts,originalSpecHash,repairedSpecHash:hashValue(value),historyPath,history:structuredClone(history),scope:usedDamping?'authored-local-animation':'authored-local-loop-pose',visualQuality:'unverified'});
 function rejectVisual(repair){const error=Object.assign(new Error(lastError?.message||'Native visual validation failed'),{code:lastError?.code==='AUTHORED_GEOMETRY_FAILED'?'AUTHORED_GEOMETRY_FAILED':'VISUAL_VALIDATION_FAILED',cause:lastError,diagnostics:lastError?.diagnostics,repair});throw error;}
 if(built){await record({version:1,type:'complete',status:'passed',attempt:0,candidateHash:originalSpecHash});checkCancelled();return {built,repair:receipt('passed',0)};}
 if(!diagnoses(lastError,original)){await record({version:1,type:'complete',status:'irreparable',attempt:0,candidateHash:originalSpecHash});rejectVisual(receipt('irreparable',0));}
 // The first compile always runs before bounded repair serialization. Thus an
 // already valid large specification is never rejected by repair-only limits.
 let first=true,result;
 try{
  result=await runRepairs({candidate:{value:original,dependencies:[{id:'authoredSpec',hash:originalSpecHash}]},maxAttempts,permittedActions:['closeLoopPose','dampenClipPose'],signal:compileOptions.signal},{
   inspect:async candidate=>{
    if(first)first=false;else{try{await attempt(candidate.value);lastError=null;}catch(error){if(!['VISUAL_VALIDATION_FAILED','AUTHORED_GEOMETRY_FAILED'].includes(error?.code))throw error;lastError=trustedError(error,currentValue);}}
    if(!lastError)return {passed:true,diagnoses:[]};
    return {passed:false,diagnoses:diagnoses(lastError,candidate.value)||[{id:'unsupportedVisual',code:'UNSUPPORTED_VISUAL',asset:'presentation',message:'Native failure has no safe authored loop correction',actionIds:[]}]};
   },
   select:async input=>{
    const diagnosis=input.diagnoses.find(d=>{
     if(d.actionIds.includes('dampenClipPose'))return true;
     if(!d.actionIds.includes('closeLoopPose'))return false;
     const clip=input.candidate.value.animations.find(c=>c.id===d.asset);
     return Array.isArray(clip.tracks)&&clip.tracks.length&&!clip.tracks.every(t=>Array.isArray(t.keys)&&t.keys.length&&JSON.stringify(t.keys[0].value)===JSON.stringify(t.keys.at(-1).value));
    });if(!diagnosis)return null;
    const clip=input.candidate.value.animations.find(c=>c.id===diagnosis.asset);
    if(diagnosis.actionIds.includes('dampenClipPose'))return {diagnosisId:diagnosis.id,actionId:'dampenClipPose',parameters:{clipId:clip.id,dependencyId:'authoredSpec',sourceSpecHash:hashValue(input.candidate.value),factor:0.5}};
    return {diagnosisId:diagnosis.id,actionId:'closeLoopPose',parameters:{clipId:clip.id,dependencyId:'authoredSpec'}};
   },
   apply:input=>{corrections++;usedDamping ||= input.action.actionId==='dampenClipPose';try{return applyRepairOperator(input);}catch(error){if(error?.code==='INVALID_REPAIR_OPERATOR')throw Object.assign(failure('Authored diagnosis cannot be safely repaired from supported pose data'),{cause:error});throw error;}},persist:record
  });
 }catch(error){
  if(error?.code==='INVALID_REPAIR'&&/bounds|exceeds|collection/.test(error.message)){
   await record({version:1,type:'complete',status:'unsupported',attempt:corrections,candidateHash:hashValue(currentValue)});
   if(lastError?.code==='AUTHORED_GEOMETRY_FAILED')rejectVisual(receipt('unsupported',corrections));
   throw Object.assign(new Error('This visual repair exceeds bounded authored-data capability'),{code:'CAPABILITY_MISSING',cause:error,repair:receipt('unsupported',compileCount-1)});
  }
  if(error?.code==='VISUAL_VALIDATION_FAILED')rejectVisual(receipt('irreparable',corrections));
  throw error;
 }
 if(result.status!=='passed')rejectVisual(receipt(result.status,result.attempts,result.candidate.value));
 const specPath=await resolveContained(root,'repaired-spec.json',{mustExist:false}),repairedSpecHash=hashValue(result.candidate.value);
 await atomicWrite(specPath,JSON.stringify(result.candidate.value,null,2));
 checkCancelled();
 if(hashValue(JSON.parse(await fs.readFile(specPath,'utf8')))!==repairedSpecHash)throw Object.assign(new Error('Persisted repaired specification differs from compiled candidate'),{code:'SOURCE_CHANGED'});
 await record({version:1,type:'repaired-spec',attempt:result.attempts,hash:repairedSpecHash,path:'repaired-spec.json'});
 checkCancelled();
 return {built,repair:{...receipt(result.status,result.attempts,result.candidate.value),specPath}};
}
module.exports={compileWithRepairs};


