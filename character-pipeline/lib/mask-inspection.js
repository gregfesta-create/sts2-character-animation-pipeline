'use strict';
// Measures the declared forbidden subset of native isolated alpha, never artistic quality.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {resolveContained,hashValue,hashFile}=require('./assets');
const {runTool:defaultRunTool}=require('./process');
const fail=(code,message)=>Object.assign(new Error(message),{code});
const abort=signal=>{if(signal?.aborted)throw fail('ABORTED','Mask inspection cancelled');};
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function plain(value){
 let count=0,bytes=0;const seen=new Set();
 function visit(v,depth){
  if(++count>500000||depth>24)throw fail('INVALID_INPUT','Mask evidence exceeds data budget');
  if(v===null||typeof v==='boolean')return;
  if(typeof v==='string'){bytes+=Buffer.byteLength(v);if(bytes>16*1024*1024)throw fail('INVALID_INPUT','Mask evidence exceeds byte budget');return;}
  if(typeof v==='number'&&Number.isFinite(v))return;
  if(typeof v!=='object'||seen.has(v)||(!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null))throw fail('INVALID_INPUT','Expected plain mask evidence');
  if(Array.isArray(v)&&(Object.getPrototypeOf(v)!==Array.prototype||v.length>500000||Object.getOwnPropertyNames(v).length!==v.length+1))throw fail('INVALID_INPUT','Invalid mask array');
  seen.add(v);for(const key of Reflect.ownKeys(v)){if(typeof key!=='string')throw fail('INVALID_INPUT','Unexpected mask property');bytes+=Buffer.byteLength(key)+4;if(bytes>16*1024*1024)throw fail('INVALID_INPUT','Mask evidence exceeds byte budget');const descriptor=Object.getOwnPropertyDescriptor(v,key);if(!Object.hasOwn(descriptor,'value')||(!descriptor.enumerable&&key!=='length'))throw fail('INVALID_INPUT','Mask accessors forbidden');if(key!=='length'||!Array.isArray(v))visit(descriptor.value,depth+1);}seen.delete(v);
 }visit(value,0);
}
function checkPlan(plan){
 plain(plan);
 if(!plan||plan.version!==1||plan.scope!=='rendered-parent-part-alpha'||!sha(plan.planHash)||!sha(plan.specHash)||!sha(plan.motionPlanHash)||!sha(plan.renderLayoutHash)||!Array.isArray(plan.captures)||plan.captures.length>64||!Array.isArray(plan.comparisons)||plan.comparisons.length>256)throw fail('INVALID_INPUT','Invalid bound mask plan');
 const {planHash,...body}=plan;
 if(Buffer.byteLength(JSON.stringify(plan))>2097152||hashValue(body)!==planHash||hashValue(plan.renderLayout)!==plan.renderLayoutHash)throw fail('INVALID_INPUT','Mask plan binding mismatch');
 const dimensions=plan.renderLayout?.pixels;
 if(!Array.isArray(dimensions)||dimensions.length!==2||!dimensions.every(n=>integer(n,1,512))||!integer(plan.totalPossibleComparisons,0,520192)||!integer(plan.omissionCount,0,520192)||!Array.isArray(plan.omissions)||plan.omissions.length>128||plan.omissions.length!==Math.min(plan.omissionCount,128)||plan.omissionsTruncated!==(plan.omissionCount>128)||plan.totalPossibleComparisons!==plan.comparisons.length+plan.omissionCount)throw fail('INVALID_INPUT','Invalid mask coverage');
 const policy=plan.policy;if(!policy||!['allowedPairCount','forbiddenPairCount','unknownPairCount'].every(k=>integer(policy[k],0,8128)))throw fail('INVALID_INPUT','Invalid overlap policy');
 const pixels=dimensions[0]*dimensions[1];if(pixels*plan.captures.length>16777216||pixels*plan.comparisons.length>67108864)throw fail('QUOTA_EXCEEDED','Mask pixel budget exceeded');
 const used=new Set();
 for(let i=0;i<plan.captures.length;i++){const c=plan.captures[i];if(!exact(c,['id','partId','clipId','time','frameIndex','filename'])||c.id!==i||c.filename!=='part-mask-'+i+'.png'||typeof c.partId!=='string'||!c.partId||typeof c.clipId!=='string'||!c.clipId||typeof c.time!=='number'||!Number.isFinite(c.time)||c.time<0||!integer(c.frameIndex,0,63))throw fail('INVALID_INPUT','Invalid mask capture selection');}
 for(let i=0;i<plan.comparisons.length;i++){const c=plan.comparisons[i],a=plan.captures[c.captureA],b=plan.captures[c.captureB];if(!exact(c,['id','partA','partB','clipId','time','frameIndex','captureA','captureB'])||c.id!==i||!a||!b||a.id===b.id||a.partId!==c.partA||b.partId!==c.partB||[a,b].some(p=>p.clipId!==c.clipId||p.time!==c.time||p.frameIndex!==c.frameIndex))throw fail('INVALID_INPUT','Incomplete mask comparison mapping');used.add(a.id);used.add(b.id);}
 if(used.size!==plan.captures.length)throw fail('INVALID_INPUT','Unused mask capture');
 return dimensions;
}
async function readCapture(root,relative,maxBytes){
 const file=await resolveContained(root,relative),handle=await fs.open(file,'r');
 try{
  const before=await handle.stat({bigint:true});if(!before.isFile()||before.size<=0n||before.size>BigInt(maxBytes))throw fail('QUOTA_EXCEEDED','Mask exceeds byte budget');
  const bytes=Buffer.alloc(Number(before.size));let offset=0;while(offset<bytes.length){const result=await handle.read(bytes,offset,bytes.length-offset,offset);if(!result.bytesRead)throw fail('CORRUPT_ARTIFACT','Truncated mask');offset+=result.bytesRead;}
  const after=await handle.stat({bigint:true}),current=await fs.lstat(await resolveContained(root,relative),{bigint:true});
  if([after,current].some(s=>['size','dev','ino','mtimeNs','ctimeNs'].some(k=>s[k]!==before[k])))throw fail('CORRUPT_ARTIFACT','Mask changed during capture');return bytes;
 }finally{await handle.close();}
}
async function inspectPartMasks(plan,captures,{sourceRoot,stagingDir,config,signal,runTool=defaultRunTool}={}){
 abort(signal);const [width,height]=checkPlan(plan);plain(captures);
 if(!Array.isArray(captures)||captures.length!==plan.captures.length)throw fail('INVALID_INPUT','Mask receipt count mismatch');
 const base={version:1,metricVersion:'native-alpha-overlap-v1',scope:plan.scope,visualQuality:'unverified',planHash:plan.planHash,specHash:plan.specHash,motionPlanHash:plan.motionPlanHash,renderLayoutHash:plan.renderLayoutHash,renderLayout:plan.renderLayout,policy:plan.policy,totalPossibleComparisons:plan.totalPossibleComparisons,selectedComparisonCount:plan.comparisons.length,checkedComparisonCount:0,omissionCount:plan.omissionCount,omissions:plan.omissions,omissionsTruncated:plan.omissionsTruncated,captures:[],comparisons:[],failureCount:0,failures:[],failuresTruncated:false,status:plan.totalPossibleComparisons?'partial':'unverified'};
 if(!captures.length)return base;
 if(!path.isAbsolute(sourceRoot||'')||!path.isAbsolute(stagingDir||''))throw fail('INVALID_INPUT','Expected absolute owned mask roots');
 if(!config?.tools?.python?.executable)throw fail('CAPABILITY_MISSING','Mask inspection requires configured Python with Pillow');
 const folder=await resolveContained(stagingDir,'mask-inspection-'+crypto.randomUUID(),{mustExist:false});await fs.mkdir(folder);const sources=path.join(folder,'sources');await fs.mkdir(sources);
 const immutable=[];let totalBytes=0;
 for(let i=0;i<captures.length;i++){
  abort(signal);const c=captures[i],p=plan.captures[i];
  if(!exact(c,['id','partId','clipId','time','frameIndex','path','width','height','sha256'])||['id','partId','clipId','time','frameIndex'].some(k=>c[k]!==p[k])||c.width!==width||c.height!==height||!sha(c.sha256)||typeof c.path!=='string'||c.path.length>512||path.basename(c.path)!==p.filename)throw fail('INVALID_INPUT','Mask receipt differs from plan');
  const bytes=await readCapture(sourceRoot,c.path,Math.min(16777216,67108864-totalBytes));totalBytes+=bytes.length;
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==c.sha256)throw fail('CORRUPT_ARTIFACT','Mask source hash mismatch');
  await fs.writeFile(path.join(sources,p.filename),bytes,{flag:'wx'});immutable.push({id:c.id,path:p.filename,sha256:c.sha256,width,height});
 }
 const request={version:1,sourceRoot:sources,planHash:plan.planHash,renderLayoutHash:plan.renderLayoutHash,captures:immutable,comparisons:plan.comparisons.map(({id,captureA,captureB})=>({id,captureA,captureB}))};
 const requestFile=path.join(folder,'request.json');await fs.writeFile(requestFile,JSON.stringify(request));abort(signal);
 const result=await runTool({python:config.tools.python},'python',[path.resolve(__dirname,'../workers/masks.py'),requestFile],{signal,timeoutMs:120000,maxOutputBytes:1048576});abort(signal);
 if(result.error||result.exitCode!==0||typeof result.stdout!=='string'||Buffer.byteLength(result.stdout)>1048576)throw fail('MASK_INSPECTION_FAILED','Alpha mask worker failed');
 let report;try{report=JSON.parse(result.stdout);}catch{throw fail('INVALID_WORKER_OUTPUT','Invalid alpha mask JSON');}
 const invalid=()=>{throw fail('INVALID_WORKER_OUTPUT','Alpha mask receipt differs from captured evidence');};
 if(!exact(report,['version','metricVersion','planHash','renderLayoutHash','captures','comparisons','decodedPixels','comparisonPixels'])||report.version!==1||report.metricVersion!==base.metricVersion||report.planHash!==plan.planHash||report.renderLayoutHash!==plan.renderLayoutHash||report.decodedPixels!==width*height*captures.length||report.comparisonPixels!==width*height*plan.comparisons.length||!Array.isArray(report.captures)||report.captures.length!==captures.length||!Array.isArray(report.comparisons)||report.comparisons.length!==plan.comparisons.length)invalid();
 for(let i=0;i<immutable.length;i++){const r=report.captures[i],c=immutable[i];if(!exact(r,['id','sourcePath','sha256','width','height'])||r.id!==c.id||r.sourcePath!==c.path||r.sha256!==c.sha256||r.width!==width||r.height!==height||await hashFile(await resolveContained(sources,c.path))!==c.sha256)invalid();}
 const measured=[],failures=[];let failureCount=0;
 for(let i=0;i<plan.comparisons.length;i++){const r=report.comparisons[i],c=plan.comparisons[i];if(!exact(r,['id','previewOverlapPixels'])||r.id!==c.id||!integer(r.previewOverlapPixels,0,width*height))invalid();const observation={...c,previewOverlapPixels:r.previewOverlapPixels};measured.push(observation);if(r.previewOverlapPixels){failureCount++;if(failures.length<128)failures.push({code:'FORBIDDEN_ALPHA_OVERLAP',...observation});}}
 const evidence={...base,captures:captures.map(c=>({...c})),comparisons:measured,checkedComparisonCount:measured.length,decodedPixels:report.decodedPixels,comparisonPixels:report.comparisonPixels,failureCount,failures,failuresTruncated:failureCount>128,status:failureCount?'failed':plan.omissionCount?'partial':'measured'};
 if(failureCount)throw Object.assign(fail('VISUAL_VALIDATION_FAILED','Rendered alpha intersects an explicitly forbidden part pair'),{report:evidence,diagnostics:failures});return evidence;
}
module.exports={inspectPartMasks};
