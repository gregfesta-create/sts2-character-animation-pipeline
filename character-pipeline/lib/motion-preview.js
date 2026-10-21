'use strict';
// Development captures only. The trusted Python verifier reconstructs the APNG
// from immutable copies and decodes every frame; metadata alone is insufficient.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {resolveContained}=require('./assets');
const {runTool:defaultRunTool}=require('./process');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=(code,message)=>Object.assign(new Error(message),{code});
const abort=signal=>{if(signal?.aborted)throw fail('ABORTED','Motion preview cancelled');};
async function capture(root,relative,limit){
 const file=await resolveContained(root,relative),handle=await fs.open(file,'r');
 try{
  const before=await handle.stat();if(!before.isFile()||before.size>limit)throw fail('QUOTA_EXCEEDED','Motion input exceeds byte budget');
  const bytes=Buffer.alloc(before.size);let offset=0;
  while(offset<bytes.length){const r=await handle.read(bytes,offset,bytes.length-offset,offset);if(!r.bytesRead)throw fail('CORRUPT_ARTIFACT','Truncated motion input');offset+=r.bytesRead;}
  const after=await handle.stat(),current=await fs.lstat(await resolveContained(root,relative));
  if([after,current].some(s=>s.dev!==before.dev||s.ino!==before.ino||s.size!==before.size||s.mtimeMs!==before.mtimeMs||s.ctimeMs!==before.ctimeMs))throw fail('CORRUPT_ARTIFACT','Motion input changed during capture');
  return bytes;
 }finally{await handle.close();}
}
async function createMotionPreview(clipId,frames,finalHoldSeconds,{sourceRoot,stagingDir,config,signal,runTool=defaultRunTool}={}){
 abort(signal);
 if(!config?.tools?.python?.executable)throw fail('CAPABILITY_MISSING','Motion preview requires configured Python with Pillow');
 const finite=(n,min,max)=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max;
 if(typeof clipId!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(clipId)||!path.isAbsolute(sourceRoot||'')||!path.isAbsolute(stagingDir||'')||!Array.isArray(frames)||!frames.length||frames.length>64||!finite(finalHoldSeconds,Number.MIN_VALUE,600))throw fail('INVALID_INPUT','Invalid motion preview request');
 const paths=new Set();for(let i=0;i<frames.length;i++){
  const f=frames[i];if(!f||Object.keys(f).sort().join(',')!=='path,time'||typeof f.path!=='string'||!f.path||f.path.length>512||f.path.includes('\\')||f.path.includes(':')||path.isAbsolute(f.path)||f.path.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p))||paths.has(f.path)||!finite(f.time,0,600)||i>0&&f.time<=frames[i-1].time)throw fail('INVALID_INPUT','Expected distinct contained frames with increasing canonical times');paths.add(f.path);
 }
 const folder=await resolveContained(stagingDir,'motion-preview-'+crypto.randomUUID(),{mustExist:false});await fs.mkdir(folder);
 const sources=path.join(folder,'sources');await fs.mkdir(sources);
 const captures=[];let total=0;
 for(let i=0;i<frames.length;i++){
  abort(signal);const bytes=await capture(sourceRoot,frames[i].path,Math.min(16777216,67108864-total));total+=bytes.length;
  const name='frame'+i+'.png';await fs.writeFile(path.join(sources,name),bytes,{flag:'wx'});
  captures.push({path:name,time:frames[i].time,sha256:hash(bytes),source:frames[i].path});
 }
 const request={version:1,operation:'encode',timingMode:'bounded-rational',clipId,sourceRoot:sources,frames:captures.map(({path,time})=>({path,time})),finalHoldSeconds,outputDirectory:path.join(folder,'output')};
 async function invoke(operation){
  abort(signal);const requestFile=path.join(folder,operation+'.json');await fs.writeFile(requestFile,JSON.stringify({...request,operation}),{flag:'wx'});
  const result=await runTool({python:config.tools.python},'python',[path.resolve(__dirname,'../workers/motion.py'),requestFile],{signal,timeoutMs:120000,maxOutputBytes:1048576});abort(signal);
  if(result.error||result.exitCode!==0||typeof result.stdout!=='string'||Buffer.byteLength(result.stdout)>1048576)throw fail('MOTION_PREVIEW_FAILED','Motion encoding or independent verification failed');
  try{return JSON.parse(result.stdout);}catch{throw fail('INVALID_WORKER_OUTPUT','Invalid motion evidence');}
 }
 const report=await invoke('encode'),invalid=()=>{throw fail('INVALID_WORKER_OUTPUT','Motion evidence differs from immutable captured timeline');};
 if(report?.ok!==true||report.version!==1||report.clipId!==clipId||report.scope!=='development-motion-preview'||report.visualQuality!=='unverified'||report.path!=='motion.png'||report.encodedFrames!==captures.length||report.timingMode!=='bounded-rational'||report.maxDurationErrorSeconds!==.000001||report.finalHoldPolicy!=='explicit-seconds'||!Number.isSafeInteger(report.width)||report.width<1||!Number.isSafeInteger(report.height)||report.height<1||report.width*report.height*captures.length>16777216||!Number.isSafeInteger(report.bytes)||report.bytes<1||report.bytes>33554432||!Array.isArray(report.frames)||report.frames.length!==captures.length||!Array.isArray(report.timing)||report.timing.length!==captures.length||!Array.isArray(report.durationsSeconds)||report.durationsSeconds.length!==captures.length)invalid();
 let errorTotal=0;
 for(let i=0;i<captures.length;i++){
  const c=captures[i],f=report.frames[i],t=report.timing[i],requested=i+1<captures.length?captures[i+1].time-c.time:finalHoldSeconds;
  if(f.path!==c.path||f.time!==c.time||f.sha256!==c.sha256||!t||!Number.isSafeInteger(t.numerator)||t.numerator<1||t.numerator>65535||!Number.isSafeInteger(t.denominator)||t.denominator<1||t.denominator>65535||!finite(t.requestedDurationSeconds,Number.MIN_VALUE,600)||Math.abs(t.requestedDurationSeconds-requested)>1e-12||t.representedDurationSeconds!==t.numerator/t.denominator||report.durationsSeconds[i]!==t.representedDurationSeconds||!finite(t.errorSeconds,-.000001,.000001)||Math.abs(t.representedDurationSeconds-t.requestedDurationSeconds-t.errorSeconds)>1e-12)invalid();errorTotal+=t.errorSeconds;
 }
 if(!finite(report.cumulativePlaybackErrorSeconds,-.000064,.000064)||Math.abs(report.cumulativePlaybackErrorSeconds-errorTotal)>1e-12)invalid();
 // Second fresh process receives only host-owned input/output paths, not paths
 // returned by the encoder. It reconstructs exact bytes and checks decoded pixels.
 const verified=await invoke('verify');if(JSON.stringify(verified)!==JSON.stringify(report))invalid();
 for(const c of captures)if(hash(await capture(sources,c.path,16777216))!==c.sha256)invalid();
 const bytes=await capture(request.outputDirectory,'motion.png',33554432);if(bytes.length!==report.bytes||hash(bytes)!==report.sha256)invalid();
 return {...report,path:path.join(request.outputDirectory,'motion.png'),captures:captures.map(({path,...c})=>c)};
}
module.exports={createMotionPreview};
