'use strict';
// Native PCK creation only. This is not game deployment or game acceptance.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {validateGodotResourceClosure}=require('../adapters/godot');
const {stageRuntimeManifest,buildRuntimeManifest}=require('./runtime-manifest');
const {runTool}=require('./process');
const {prepareNativeTool}=require('./native-launch');
const {reportPackageSize}=require('./package-size');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=message=>Object.assign(new Error(message),{code:'INVALID_PACK_EXPORT'});
const cancelled=signal=>{if(signal!==undefined&&!(signal instanceof AbortSignal))throw fail('Invalid cancellation signal');if(signal?.aborted)throw Object.assign(new Error('Pack operation cancelled'),{code:'ABORTED'});};
const align=n=>Math.ceil(n/4096)*4096;
// PCKPacker's unencrypted format uses a small fixed header, resource-name table
// and aligned payloads. Reserve 64 KiB header and whole 4 KiB blocks per table
// entry/payload, exceeding the native 32-byte alignment and fixed entry fields.
const packBound=files=>65536+files.reduce((n,f)=>n+align(f.size)+align(Buffer.byteLength('res://'+f.path)+256),0);
function lockedRequest({tool,args,files,timeoutMs=30000}){
 const absolute=value=>typeof value==='string'&&value.length<=32767&&!value.includes('\0')&&path.isAbsolute(value);
 if(process.platform!=='win32'||!tool||!absolute(tool.executable)||!absolute(tool.cwd||path.dirname(tool.executable))||!Array.isArray(args)||args.length>1024||args.some(a=>typeof a!=='string'||a.length>32767||a.includes('\0'))||!Array.isArray(files)||files.length>10003||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw fail('Invalid trusted locked tool request');
 for(const f of files)if(!f||!absolute(f.path)||!Number.isSafeInteger(f.size)||f.size<0||typeof f.hash!=='string'||!/^[a-f0-9]{64}$/.test(f.hash))throw fail('Invalid locked input receipt');
 let charge=256+Buffer.byteLength(JSON.stringify(tool.executable))+Buffer.byteLength(JSON.stringify(tool.cwd||path.dirname(tool.executable)));
 for(const value of [...args,...files]){charge+=Buffer.byteLength(JSON.stringify(typeof value==='string'?value:{path:value.path,size:value.size,hash:value.hash}))+1;if(charge>16*1024*1024)throw fail('Locked request exceeds 16 MiB budget');}
 const bytes=Buffer.from(JSON.stringify({executable:tool.executable,cwd:tool.cwd||path.dirname(tool.executable),args,files:files.map(({path,size,hash})=>({path,size,hash})),timeoutMs}));
 if(bytes.length>16*1024*1024)throw fail('Locked request exceeds 16 MiB budget');
 return {bytes,timeoutMs};
}
async function lockedInvocation(receipt){
 const helper=await fs.readFile(path.join(__dirname,'windows-tool-lock.ps1'),'utf8');
 const data=Buffer.from(JSON.stringify(receipt)).toString('base64');
 const command=Buffer.from(helper+"\nexit (Invoke-LockedToolFile '"+data+"')",'utf16le').toString('base64');
 if(command.length>30000)throw fail('Locked launch exceeds Windows encoded command budget');
 return command;
}
async function runLockedTool(options){
 cancelled(options.signal);
 const tool=await prepareNativeTool(options.tool);
 cancelled(options.signal);
 const {bytes,timeoutMs}=lockedRequest({...options,tool});let staged,receipt;
 try{
  staged=await stage([capture('locked-request.json',bytes)],options.requestRoot||require('node:os').tmpdir(),16*1024*1024);
  receipt={path:path.join(staged.directory,'locked-request.json'),size:bytes.length,hash:digest(bytes)};
  cancelled(options.signal);
  const command=await lockedInvocation(receipt);
  cancelled(options.signal);
  // Never hard-kill the lock owner on cancellation: its bounded native timeout
  // must run PowerShell's finally block and reap its child before locks release.
  // Cancellation waits <=30s for that deadline (<=40s wrapper fallback).
  const result=await runTool({lock:{executable:'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',...(tool.dotnetRoot===undefined?{}:{dotnetRoot:tool.dotnetRoot})}},'lock',['-NoProfile','-NonInteractive','-EncodedCommand',command],{timeoutMs:timeoutMs+10000,maxOutputBytes:2*1024*1024});
  cancelled(options.signal);
  return {...result,requestReceipt:receipt,retainedDirectories:[staged.directory]};
 }catch(error){error.requestReceipt=receipt;error.retainedDirectories=[...(staged?[staged.directory]:[]),...(error.stagingDirectory?[error.stagingDirectory]:[])];throw error;}
}
function validatePackPlan(plan,{maxBytes=64*1024*1024}={},trusted={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>256*1024*1024||!plan||plan.version!==1||!Array.isArray(plan.files)||typeof plan.rootScene!=='string'||!plan.rootScene.includes('/')||!plan.rootScene.endsWith('.tscn'))throw fail('Invalid bounded namespaced pack plan');
 const checked=validateGodotResourceClosure({rootScene:plan.rootScene,files:plan.files,maxBytes},trusted);
 if(checked.files.length!==plan.files.length)throw fail('Pack inventory contains unreachable resources');
 const namespace=plan.rootScene.slice(0,plan.rootScene.lastIndexOf('/')+1);
 const files=plan.files.map(item=>{
  if(!item.path.startsWith(namespace))throw fail('Pack resource escapes root namespace');
  const bytes=Buffer.from(item.base64,'base64');
  if(item.size!==bytes.length)throw fail('Capture size mismatch');
  if(/\.(wav|ogg)$/.test(item.path)||/\.(tscn|tres)$/.test(item.path)&&/\[ext_resource(?=[^\]\r\n]*\btype="(?:Texture2D|AudioStream[^"]*)")(?=[^\]\r\n]*\bpath="[^"]*\.(?:png|wav|ogg)")[^\]\r\n]*\]/.test(bytes.toString('utf8')))throw fail('Imported media dependencies require native import closure support');
  const category=checked.files.find(f=>f.path===item.path)?.category;
  return {path:item.path,size:item.size,hash:item.hash,base64:item.base64,...(category==='audio'?{category}:{})};
 });
 return {rootScene:plan.rootScene,files};
}
const category=file=>file.endsWith('.gd')?'scripts':file.endsWith('.png')?'textures':/\.(tscn|tres)$/.test(file)?'scenes':'metadata';
const capture=(file,bytes)=>({path:file,size:bytes.length,hash:digest(bytes),base64:bytes.toString('base64')});
async function stage(captures,stagingParent,maxBytes){
 const manifest=buildRuntimeManifest({roots:captures.map(c=>c.path),resources:captures.map(c=>({id:c.path,path:c.path,category:c.category==='audio'?'audio':category(c.path)}))});
 return stageRuntimeManifest({captures,stagingParent,manifest,maxBytes});
}
async function exportGodotPack({plan,stagingParent,tool,maxBytes=64*1024*1024,maxPackBytes=128*1024*1024,signal}={},trusted={}){
 cancelled(signal);
 const checked=validatePackPlan(plan,{maxBytes},trusted);
 if(!tool||typeof tool.executable!=='string'||!path.isAbsolute(tool.executable)||!Number.isSafeInteger(maxPackBytes)||maxPackBytes<1||maxPackBytes>512*1024*1024)throw fail('Expected trusted native tool and bounded pack budget');
 const maximumPackBytes=packBound(checked.files);
 if(maximumPackBytes>maxPackBytes)throw fail('Conservative PCK upper bound exceeds configured pack budget');
 const predicted=path.join(path.resolve(stagingParent),'runtime-XXXXXX');
 const makeRequest=(runtime,pack)=>({rootScene:checked.rootScene,source:runtime.replaceAll('\\','/'),output:pack.replaceAll('\\','/'),files:checked.files.map(({path,size,hash})=>({path,size,hash})),maxPackBytes,maximumPackBytes});
 const script=await fs.readFile(path.join(__dirname,'../godot/export_pack.gd'));
 const controls=request=>[capture('export_pack.gd',script),capture('request.json',Buffer.from(JSON.stringify(request))),capture('project.godot',Buffer.from('config_version=5\n'))];
 const nativeArgs=control=>['--headless','--path',control,'--script','res://export_pack.gd'];
 const lockedFiles=(directory,files)=>files.map(f=>({path:path.join(directory,f.path),size:f.size,hash:f.hash}));
 lockedRequest({tool,args:nativeArgs(predicted),files:[...lockedFiles(predicted,checked.files),...lockedFiles(predicted,controls(makeRequest(predicted,path.join(predicted,'character.pck'))))]});
 const retained=[];let handle;
 try{
  cancelled(signal);
  const runtime=await stage(checked.files,stagingParent,maxBytes);retained.push(runtime.directory);cancelled(signal);
  const output=await stage([capture('character.pck',Buffer.alloc(0))],stagingParent,1);retained.push(output.directory);cancelled(signal);
  const pack=path.join(output.directory,'character.pck');handle=await fs.open(pack,'r+');const identity=await handle.stat();
  const controlCaptures=controls(makeRequest(runtime.directory,pack));
  const control=await stage(controlCaptures,stagingParent,1024*1024);retained.push(control.directory);cancelled(signal);
  const result=await runLockedTool({tool,args:nativeArgs(control.directory),files:[...lockedFiles(runtime.directory,checked.files),...lockedFiles(control.directory,controlCaptures)],requestRoot:stagingParent,signal});retained.push(...result.retainedDirectories);
  cancelled(signal);
  if(result.error?.code==='ABORTED')throw Object.assign(fail('Pack operation cancelled'),{code:'ABORTED',process:result});
  if(result.error||result.exitCode!==0||/SCRIPT ERROR|ERROR:/.test(result.stdout+result.stderr))throw Object.assign(fail('Native pack creation failed'),{process:result});
  const current=await fs.lstat(pack),opened=await handle.stat();
  if(current.isSymbolicLink()||!current.isFile()||[current,opened].some(s=>s.dev!==identity.dev||s.ino!==identity.ino)||opened.size>maxPackBytes||opened.size<12)throw fail('Pack output identity or byte budget changed');
  const bytes=Buffer.alloc(opened.size);let offset=0;
  while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)throw fail('Pack truncated during readback');offset+=read.bytesRead;}
  const after=await handle.stat();if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs||bytes.subarray(0,4).toString()!=='GDPC')throw fail('Pack changed or invalid header');
  const sizeReport=await reportPackageSize({staged:runtime,ownedRoot:stagingParent,archivePath:path.relative(stagingParent,pack).split(path.sep).join('/'),maxBytes:Math.max(maxBytes,maxPackBytes)});
  return {version:1,nativeExportStatus:'pack-created',gameAcceptance:false,pack,rootScene:'res://'+checked.rootScene,hash:digest(bytes),bytes:bytes.length,runtimeBytes:runtime.totalBytes,files:runtime.files,sizeReport,retainedDirectories:retained,process:result};
 }catch(error){for(const directory of [...(error.retainedDirectories||[]),...(error.stagingDirectory?[error.stagingDirectory]:[])])if(!retained.includes(directory))retained.push(directory);error.cleanupStatus='retained-unpublished';error.retainedDirectories=retained;error.stagingLimits={maxBytes,maxPackBytes};throw error;}
 finally{if(handle)await handle.close();}
}
module.exports={validatePackPlan,exportGodotPack,runLockedTool};
