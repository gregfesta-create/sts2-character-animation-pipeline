'use strict';
// Inspection of captured renders, never an approval of artwork or visual quality.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {resolveContained,hashFile}=require('./assets');
const {runTool:defaultRunTool}=require('./process');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=(code,message)=>Object.assign(new Error(message),{code});
const abort=signal=>{if(signal?.aborted)throw fail('ABORTED','Pixel inspection cancelled');};
function validSheet(bytes,width,height){
 if(bytes.length<57||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')return false;
 const crc=data=>{let n=0xffffffff;for(const b of data){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;};
 let offset=8,started=false,closed=false;const chunks=[];
 while(offset<bytes.length){
  if(offset+12>bytes.length)return false;const length=bytes.readUInt32BE(offset),end=offset+length+12;if(end>bytes.length)return false;
  const type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,end-4);if(crc(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))return false;
  if(offset===8){if(type!=='IHDR'||length!==13||data.readUInt32BE(0)!==width||data.readUInt32BE(4)!==height||data[8]!==8||data[9]!==6||data[10]||data[11]||data[12])return false;}
  else if(type==='IDAT'){if(closed)return false;started=true;chunks.push(data);}
  else if(type==='IEND'){
   if(length||!started||end!==bytes.length)return false;
   try{const stride=width*4+1,raw=require('node:zlib').inflateSync(Buffer.concat(chunks),{maxOutputLength:stride*height});if(raw.length!==stride*height)return false;for(let row=0;row<height;row++)if(raw[row*stride]>4)return false;return true;}catch{return false;}
  }else{if(!/^[a-z][A-Za-z]{3}$/.test(type))return false;if(started)closed=true;}
  offset=end;
 }return false;
}
async function readCapture(root,relative,maxBytes){
 const file=await resolveContained(root,relative),handle=await fs.open(file,'r');
 try{
  const before=await handle.stat();if(!before.isFile()||before.size>maxBytes)throw fail('QUOTA_EXCEEDED','Rendered frame exceeds capture budget');
  const bytes=Buffer.alloc(before.size);let offset=0;
  while(offset<bytes.length){const result=await handle.read(bytes,offset,bytes.length-offset,offset);if(!result.bytesRead)throw fail('CORRUPT_ARTIFACT','Truncated rendered frame');offset+=result.bytesRead;}
  const after=await handle.stat(),current=await fs.lstat(await resolveContained(root,relative));
  if([after,current].some(s=>s.size!==before.size||s.dev!==before.dev||s.ino!==before.ino||s.mtimeMs!==before.mtimeMs||s.ctimeMs!==before.ctimeMs))throw fail('CORRUPT_ARTIFACT','Rendered frame changed during capture');
  return bytes;
 }finally{await handle.close();}
}
async function inspectRenderedFrames(frames,{sourceRoot,stagingDir,config,signal,runTool=defaultRunTool}={}){
 abort(signal);
 if(!config?.tools?.python?.executable)throw fail('CAPABILITY_MISSING','Pixel inspection requires configured Python with Pillow');
 if(!path.isAbsolute(sourceRoot||'')||!path.isAbsolute(stagingDir||'')||!Array.isArray(frames)||!frames.length||frames.length>64||new Set(frames).size!==frames.length)throw fail('INVALID_INPUT','Expected bounded distinct rendered frame paths');
 for(const file of frames)if(typeof file!=='string'||!file||file.length>512||path.isAbsolute(file)||file.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'))throw fail('UNSAFE_PATH','Rendered frames must be contained relative paths');
 const folder=await resolveContained(stagingDir,'pixel-inspection-'+crypto.randomUUID(),{mustExist:false});await fs.mkdir(folder);
 const sources=path.join(folder,'sources');await fs.mkdir(sources);
 const captures=[];let total=0;
 for(let index=0;index<frames.length;index++){
  abort(signal);const bytes=await readCapture(sourceRoot,frames[index],Math.min(16*1024*1024,64*1024*1024-total));total+=bytes.length;
  const id='frame'+index,name=id+'.png';await fs.writeFile(path.join(sources,name),bytes,{flag:'wx'});captures.push({id,path:name,hash:digest(bytes),source:frames[index]});
 }
 const request={version:1,sourceRoot:sources,frames:captures.map(({id,path})=>({id,path})),outputDirectory:path.join(folder,'output'),limits:{maxFrames:64,maxFileBytes:16*1024*1024,maxPixels:4*1024*1024,maxTotalPixels:16*1024*1024,maxOutputPixels:16*1024*1024,maxOutputBytes:32*1024*1024}};
 const requestFile=path.join(folder,'request.json');await fs.writeFile(requestFile,JSON.stringify(request));
 const result=await runTool({python:config.tools.python},'python',[path.resolve(__dirname,'../workers/visual.py'),requestFile],{signal,timeoutMs:120000,maxOutputBytes:1024*1024});abort(signal);
 if(result.error||result.exitCode!==0||typeof result.stdout!=='string'||Buffer.byteLength(result.stdout)>1024*1024)throw fail('VISUAL_INSPECTION_FAILED','Pixel inspection worker failed');
 let report;try{report=JSON.parse(result.stdout);}catch{throw fail('INVALID_WORKER_OUTPUT','Pixel inspection returned invalid JSON');}
 const invalid=()=>{throw fail('INVALID_WORKER_OUTPUT','Pixel inspection evidence differs from captured frames');};
 const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
 const finite=(n,min,max)=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max;
 if(report?.ok!==true||report.version!==1||report.metricVersion!=='visual-pixels-v1'||report.scope!=='supplied-frame-pixels'||report.visualQuality!=='unverified'||report.coverage?.frameCount!==captures.length||!Array.isArray(report.frames)||report.frames.length!==captures.length||!Array.isArray(report.differences)||report.differences.length!==captures.length-1||!Array.isArray(report.diagnostics))invalid();
 let pixels=0;const expectedDiagnostics=[];
 for(let i=0;i<captures.length;i++){
  const r=report.frames[i],c=captures[i];if(!exact(r,['id','sourcePath','sha256','width','height','visiblePixels','alphaBounds','edgeVisiblePixels','edgeTouchRisk','normalizedCentroid'])||r.id!==c.id||r.sourcePath!==c.path||r.sha256!==c.hash||![r.width,r.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=4096)||r.width*r.height>request.limits.maxPixels||i>0&&(r.width!==report.frames[0].width||r.height!==report.frames[0].height))invalid();
  if(!Number.isSafeInteger(r.visiblePixels)||r.visiblePixels<0||r.visiblePixels>r.width*r.height||!Number.isSafeInteger(r.edgeVisiblePixels)||r.edgeVisiblePixels<0||r.edgeVisiblePixels>Math.min(r.visiblePixels,r.width*r.height-Math.max(0,r.width-2)*Math.max(0,r.height-2))||r.edgeTouchRisk!==(r.edgeVisiblePixels>0))invalid();
  if(r.visiblePixels===0){if(r.alphaBounds!==null||r.normalizedCentroid!==null)invalid();expectedDiagnostics.push({code:'EMPTY_ALPHA',frameId:r.id});}
  else{
   const b=r.alphaBounds;if(!Array.isArray(b)||b.length!==4||!b.every(Number.isSafeInteger)||b[0]<0||b[1]<0||b[2]<=b[0]||b[3]<=b[1]||b[2]>r.width||b[3]>r.height||r.visiblePixels>(b[2]-b[0])*(b[3]-b[1])||!Array.isArray(r.normalizedCentroid)||r.normalizedCentroid.length!==2||!r.normalizedCentroid.every(n=>finite(n,0,1)))invalid();
   if(!finite(r.normalizedCentroid[0],(b[0]+0.5)/r.width,(b[2]-0.5)/r.width)||!finite(r.normalizedCentroid[1],(b[1]+0.5)/r.height,(b[3]-0.5)/r.height))invalid();
  }
  if(r.edgeTouchRisk)expectedDiagnostics.push({code:'EDGE_ALPHA_RISK',frameId:r.id,message:'Visible alpha touches the frame edge; clipping outside the frame is unknown.'});
  pixels+=r.width*r.height;if(pixels>request.limits.maxTotalPixels)invalid();
  if(await hashFile(path.join(sources,c.path))!==c.hash)invalid();
 }
 if(report.coverage.decodedPixels!==pixels)invalid();
 if(JSON.stringify(report.diagnostics)!==JSON.stringify(expectedDiagnostics))invalid();
 for(let i=0;i<report.differences.length;i++){
  const d=report.differences[i],a=report.frames[i],b=report.frames[i+1];
  if(!exact(d,['fromFrameId','toFrameId','normalizedCentroidDisplacement','normalizedPremultipliedRgbaDifference'])||d.fromFrameId!==a.id||d.toFrameId!==b.id||!finite(d.normalizedPremultipliedRgbaDifference,0,1))invalid();
  const displacement=a.normalizedCentroid&&b.normalizedCentroid?Math.hypot(a.normalizedCentroid[0]-b.normalizedCentroid[0],a.normalizedCentroid[1]-b.normalizedCentroid[1]):null;
  if(displacement===null?d.normalizedCentroidDisplacement!==null:!finite(d.normalizedCentroidDisplacement,0,Math.SQRT2)||Math.abs(displacement-d.normalizedCentroidDisplacement)>1e-12)invalid();
 }
 const sheet=report.contactSheet;
 if(!sheet||typeof sheet.path!=='string'||![sheet.width,sheet.height,sheet.columns,sheet.rows,sheet.bytes].every(n=>Number.isSafeInteger(n)&&n>0)||sheet.width*sheet.height>request.limits.maxOutputPixels||sheet.bytes>request.limits.maxOutputBytes||!Array.isArray(sheet.layout)||sheet.layout.length!==captures.length)invalid();
 const columns=Math.ceil(Math.sqrt(captures.length)),rows=Math.ceil(captures.length/columns);
 if(sheet.columns!==columns||sheet.rows!==rows||sheet.width!==report.frames[0].width*columns||sheet.height!==report.frames[0].height*rows)invalid();
 const sheetPath=await resolveContained(request.outputDirectory,path.relative(request.outputDirectory,path.resolve(sheet.path)));
 const bytes=await readCapture(request.outputDirectory,path.relative(request.outputDirectory,sheetPath),request.limits.maxOutputBytes);
 if(bytes.length!==sheet.bytes||digest(bytes)!==sheet.sha256||!validSheet(bytes,sheet.width,sheet.height))invalid();
 for(let i=0;i<sheet.layout.length;i++){
  const cell=sheet.layout[i],frame=report.frames[i];if(!exact(cell,['frameId','x','y','width','height'])||cell.frameId!==frame.id||cell.width!==frame.width||cell.height!==frame.height||cell.x!==(i%columns)*frame.width||cell.y!==Math.floor(i/columns)*frame.height)invalid();
 }
 return {...report,contactSheet:{...sheet,path:sheetPath},captures:captures.map(({path,...record})=>record)};
}
module.exports={inspectRenderedFrames,validateRgbaPng:validSheet};
