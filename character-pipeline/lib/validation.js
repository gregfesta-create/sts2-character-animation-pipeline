'use strict';
// Deterministic geometric telemetry only. Passing these sampled checks does not
// certify rendered pixels, style, completeness of motion sampling, or visual quality.
const VERSION='telemetry-v1';
const LIMITS=Object.freeze({attachmentRestPx:1,attachmentMovingPx:2,weightSumError:1e-5,loopDisplacementPx:1});
const CAPS=Object.freeze({attachments:4096,weights:65536,triangles:16384,inversionExceptions:16384,loopEndpoints:4096,frameJumpThresholds:256,frameJumps:16384});
const fail=path=>{throw Object.assign(new Error('Invalid bounded telemetry at '+path),{code:'INVALID_TELEMETRY',path});};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,fields,p)=>{if(!object(x)||Object.keys(x).length!==fields.length||fields.some(k=>!Object.hasOwn(x,k)))fail(p);};
const token=(x,p)=>{if(typeof x!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(x))fail(p);};
const number=(x,min,max,p)=>{if(!Number.isFinite(x)||x<min||x>max)fail(p);};
const point=(x,p)=>{if(!Array.isArray(x)||x.length!==2)fail(p);for(let i=0;i<2;i++)number(x[i],-1e6,1e6,p+'/'+i);};
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
function validateTelemetry(input){
 exact(input,['version','thresholdVersion',...Object.keys(CAPS)],'/');
 if(input.version!==1||input.thresholdVersion!==VERSION)fail('/version');
 for(const [key,cap]of Object.entries(CAPS))if(!Array.isArray(input[key])||input[key].length>cap)fail('/'+key);
 const failures=[],appliedExceptions=[],coverage={};
 const thresholdReport={...LIMITS,frameJumps:[]};
 function collection(key,fields,idKey,check){
  const ids=new Set();coverage[key]=input[key].length;
  for(let index=0;index<input[key].length;index++){
   const record=input[key][index];
   const p='/'+key+'/'+index;exact(record,fields,p);token(record[idKey],p+'/'+idKey);
   if(ids.has(record[idKey]))fail(p+'/'+idKey);ids.add(record[idKey]);check(record,p);
  }return ids;
 }
 const add=(code,id,measured,limit,extra={})=>failures.push({code,id,measured,limit,...extra});
 collection('attachments',['id','phase','expected','actual'],'id',(r,p)=>{
  if(!['rest','moving'].includes(r.phase))fail(p+'/phase');point(r.expected,p+'/expected');point(r.actual,p+'/actual');
  const measured=distance(r.expected,r.actual),limit=r.phase==='rest'?LIMITS.attachmentRestPx:LIMITS.attachmentMovingPx;
  if(measured>limit)add('ATTACHMENT_ERROR',r.id,measured,limit,{phase:r.phase});
 });
 collection('weights',['id','sum'],'id',(r,p)=>{
  number(r.sum,0,1e6,p+'/sum');const measured=Math.abs(r.sum-1);
  if(r.sum<1-LIMITS.weightSumError||r.sum>1+LIMITS.weightSumError)add('WEIGHT_SUM',r.id,measured,LIMITS.weightSumError,{sum:r.sum});
 });
 // Validate all triangle baselines before resolving the explicit exception list.
 const triangles=collection('triangles',['id','restSignedArea','signedArea'],'id',(r,p)=>{
  number(r.restSignedArea,-1e12,1e12,p+'/restSignedArea');number(r.signedArea,-1e12,1e12,p+'/signedArea');if(r.restSignedArea===0)fail(p+'/restSignedArea');
 });
 const exceptions=new Map();
 collection('inversionExceptions',['triangleId','reason'],'triangleId',(r,p)=>{
  if(!triangles.has(r.triangleId)||typeof r.reason!=='string'||r.reason.length>512||!r.reason.trim()||/[\x00-\x1f]/.test(r.reason))fail(p);
  exceptions.set(r.triangleId,r.reason);
 });
 for(const r of input.triangles){
  if(r.signedArea===0)add('TRIANGLE_COLLAPSE',r.id,0,'nonzero signed area');
  else if(Math.sign(r.signedArea)!==Math.sign(r.restSignedArea)){
   if(exceptions.has(r.id))appliedExceptions.push({triangleId:r.id,reason:exceptions.get(r.id)});
   else add('TRIANGLE_INVERSION',r.id,r.signedArea,Math.sign(r.restSignedArea)>0?'positive signed area':'negative signed area',{restSignedArea:r.restSignedArea});
  }
 }
 const endpoints=new Set();
 collection('loopEndpoints',['id','clipId','jointId','start','end'],'id',(r,p)=>{
  token(r.clipId,p+'/clipId');token(r.jointId,p+'/jointId');const key=r.clipId+'/'+r.jointId;if(endpoints.has(key))fail(p);endpoints.add(key);
  point(r.start,p+'/start');point(r.end,p+'/end');const measured=distance(r.start,r.end);
  if(measured>LIMITS.loopDisplacementPx)add('LOOP_SEAM',r.id,measured,LIMITS.loopDisplacementPx,{clipId:r.clipId,jointId:r.jointId});
 });
 const jumpThresholds=new Map();
 collection('frameJumpThresholds',['clipId','normalizationPx','maxNormalizedJump'],'clipId',(r,p)=>{
  number(r.normalizationPx,1e-6,1e6,p+'/normalizationPx');number(r.maxNormalizedJump,0,1e6,p+'/maxNormalizedJump');jumpThresholds.set(r.clipId,r);thresholdReport.frameJumps.push({...r});
 });
 collection('frameJumps',['id','clipId','fromFrame','toFrame','from','to'],'id',(r,p)=>{
  token(r.clipId,p+'/clipId');const threshold=jumpThresholds.get(r.clipId);if(!threshold)fail(p+'/clipId');
  if(!Number.isSafeInteger(r.fromFrame)||r.fromFrame<0||!Number.isSafeInteger(r.toFrame)||r.toFrame<=r.fromFrame||r.toFrame>1e9)fail(p+'/frames');
  point(r.from,p+'/from');point(r.to,p+'/to');const displacementPx=distance(r.from,r.to),measured=displacementPx/threshold.normalizationPx;
  if(measured>threshold.maxNormalizedJump)add('FRAME_JUMP',r.id,measured,threshold.maxNormalizedJump,{clipId:r.clipId,fromFrame:r.fromFrame,toFrame:r.toFrame,displacementPx,normalizationPx:threshold.normalizationPx});
 });
 coverage.totalSamples=coverage.attachments+coverage.weights+coverage.triangles+coverage.loopEndpoints+coverage.frameJumps;
 return {version:1,thresholdVersion:VERSION,status:failures.length?'failed':coverage.totalSamples?'passed':'unverified',scope:'telemetry-only',visualQuality:'unverified',coverage,thresholds:thresholdReport,failures,appliedExceptions};
}
module.exports={validateTelemetry};
