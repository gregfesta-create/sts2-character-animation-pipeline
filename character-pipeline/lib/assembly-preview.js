'use strict';
// Transient development-only assembly capture. All inputs are immutable runtime
// closure captures; original artwork and saved scene state are never consulted.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {resolveContained,hashValue,ownedStorage}=require('./assets');
const {planGodotResources,inspectGodotResourceReachability}=require('../adapters/godot');
const {runTool:defaultRunTool}=require('./process');
const {inspectRenderedFrames}=require('./visual-inspection');
const {createMotionPreview}=require('./motion-preview');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=(code,message)=>Object.assign(new Error(message),{code});
const abort=s=>{if(s?.aborted)throw fail('ABORTED','Assembly preview cancelled');};
async function readOwned(root,relative,limit,signal){
 abort(signal);if((await fs.lstat(root)).isSymbolicLink()||await fs.realpath(root)!==path.resolve(root))throw fail('UNSAFE_PATH','Linked resource roots are forbidden');
 const file=await resolveContained(root,relative),handle=await fs.open(file,'r');
 try{const before=await handle.stat({bigint:true});if(!before.isFile()||before.size>BigInt(limit))throw fail('QUOTA_EXCEEDED','Assembly resource budget exceeded');const bytes=Buffer.alloc(Number(before.size));let offset=0;
 while(offset<bytes.length){abort(signal);const r=await handle.read(bytes,offset,bytes.length-offset,offset);if(!r.bytesRead)throw fail('CORRUPT_ARTIFACT','Truncated assembly resource');offset+=r.bytesRead;}
 const after=await handle.stat({bigint:true}),current=await fs.lstat(await resolveContained(root,relative),{bigint:true});if([after,current].some(s=>['dev','ino','size','mtimeNs','ctimeNs'].some(k=>s[k]!==before[k])))throw fail('CORRUPT_ARTIFACT','Assembly resource changed during capture');return bytes;
 }finally{await handle.close();}
}
async function captureRuntimeResources(project,scene,signal,options={}){
 abort(signal);const pending=[scene],seen=new Set(),files=[];let total=0;
 while(pending.length){abort(signal);const relative=pending.pop();if(seen.has(relative))continue;seen.add(relative);if(seen.size>1000)throw fail('QUOTA_EXCEEDED','Assembly runtime file budget exceeded');
 const bytes=await readOwned(project,relative,67108864-total,signal);total+=bytes.length;files.push({path:relative,hash:digest(bytes),base64:bytes.toString('base64')});
 if(/\.(tscn|tres|gd)$/.test(relative)){let source;try{source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw fail('INVALID_GODOT_RUNTIME','Invalid runtime text');}for(const m of source.matchAll(/["']res:\/\/([^"'\r\n]+)["']/g))pending.push(m[1]);}
 }
 const input={namespace:'assembly_runtime',rootScene:scene,files,maxBytes:67108864};
 const reached=inspectGodotResourceReachability(input),eligibility=require('./audio-eligibility').collectAudioEligibility({metadata:options.audioMetadata??[],files:reached.binaryResources});
 let inspected=null;
 if(eligibility.files.length){
  for(const field of ['runtimeReceipts','audioReceipts']){
   const receipts=options[field];if(!Array.isArray(receipts)||receipts.length>10000)throw fail('CORRUPT_ARTIFACT','Missing bounded compiler audio receipts');
   for(const f of eligibility.files){const matching=receipts.filter(r=>r?.path===f.path);if(!matching.length||matching.some(r=>r.hash!==f.hash||r.size!==f.size))throw fail('CORRUPT_ARTIFACT','Captured audio differs from its compiler checkpoint');}
  }
  abort(signal);
  // Each inspector batch retains resource copies, bounded request manifests,
  // and helper diagnostics. Reserve these before allocating, not after launch.
  const retainedBound=eligibility.files.reduce((n,f)=>n+f.size*3,0)+Math.ceil(eligibility.files.length/4)*2*1024*1024;
  const stageLimit=options.config?.limits?.maxStageBytes??256*1024*1024,storageLimit=options.config?.limits?.maxStorageBytes??4*1024**3;
  if(options.stagingDir){const used=await ownedStorage(options.stagingDir);if(used+retainedBound+total>stageLimit||await ownedStorage(options.storageRoot||options.stagingDir)+retainedBound+total>storageLimit)throw fail('QUOTA_EXCEEDED','Retained native audio inspection cannot fit job storage');}
  const inspect=options.inspectNativeAudioResources||require('./native-audio-resources').inspectNativeAudioResources;
  inspected=await inspect({files:eligibility.files,audio:eligibility.audio,namespaces:['assembly_runtime'],stagingParent:options.stagingDir,tool:options.tool,signal});abort(signal);
 }
 const closure=planGodotResources(input,inspected?{audioAuthority:inspected.authority}:{});return {...closure,audioInspection:inspected?{version:inspected.version,resources:inspected.resources,retainedDirectories:inspected.retainedDirectories}:null,inventoryHash:hashValue(closure.files.map(({path,sourcePath,sourceHash,hash,size})=>({path,sourcePath,sourceHash,hash,size})))};
}
function validateAssemblyReceipt(r,p,inventoryHash){
 const invalid=()=>{throw fail('INVALID_NATIVE_ASSEMBLY_PREVIEW','Native assembly evidence differs from the bounded plan');};
 const timeEqual=(a,b)=>typeof a==='number'&&typeof b==='number'&&Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-9;
 const integer=(n,a,b)=>Number.isSafeInteger(n)&&n>=a&&n<=b,finite=n=>typeof n==='number'&&Number.isFinite(n),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 if(!r||r.version!==1||r.planHash!==p.planHash||r.compiledSpecHash!==p.compiledSpecHash||r.inventoryHash!==inventoryHash||Object.hasOwn(r,'error')||r.unexpectedMarkerCount!==0||r.allOwnersSilent!==true||r.startedUnbound!==true||r.skeletonPreserved!==true||r.finalEmpty!==true||!integer(r.simulationSteps,0,8192)||!integer(r.ownersAdvanced,0,32768)||!Array.isArray(r.frames)||r.frames.length!==p.frames.length||!Array.isArray(r.applied)||r.applied.length!==p.steps.length||r.applied.some((s,i)=>!s||s.configurationId!==p.steps[i].configurationId||!timeEqual(s.time,p.steps[i].time))||!Array.isArray(r.phaseObservations)||r.phaseObservations.length>4096||!integer(r.phaseObservationCount,r.phaseObservations.length,1000000)||r.phaseObservations.length!==Math.min(r.phaseObservationCount,4096)||r.phaseObservationsTruncated!==(r.phaseObservationCount>4096))invalid();
 const boundaries=[...new Set([...p.frames.map(f=>f.time),...p.steps.map(s=>s.time)])].sort((a,b)=>a-b);const expectedSteps=boundaries.slice(1).reduce((n,t,i)=>n+Math.ceil((t-boundaries[i]-1e-8)*60),0);if(r.simulationSteps!==expectedSteps)invalid();
 for(let i=0;i<p.frames.length;i++){const f=r.frames[i],expected=p.frames[i],config=p.configurations.find(c=>c.id===expected.configurationId),ids=config.components.map(c=>c.id).sort(),states=(p.steps.findLast(s=>s.time<=expected.time).snapshot?.components||[]).map(({id,type,socket,revision})=>({id,type,socket,revision})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);if(!f||f.index!==expected.index||!timeEqual(f.time,expected.time)||f.path!==expected.filename||f.configurationId!==expected.configurationId||!same(f.components,ids)||!Array.isArray(f.componentStates)||f.componentStates.length!==states.length||f.componentStates.some((s,i)=>!s||Object.keys(s).sort().join(',')!=='id,revision,socket,type'||['id','type','socket','revision'].some(key=>s[key]!==states[i][key]))||f.width!==p.renderLayout.pixels[0]||f.height!==p.renderLayout.pixels[1]||!/^([a-f0-9]{64})$/.test(f.sha256)||f.skeletonPreserved!==true)invalid();}
 const expectedPhases=p.steps.flatMap((s,index)=>(s.operations||[]).flatMap(op=>(op.phases||[]).map(ph=>({componentId:op.id,operation:op.kind,phaseId:ph.id,time:s.time+ph.time,socket:(s.snapshot?.components.find(c=>c.id===op.id)||p.steps[index-1]?.snapshot?.components.find(c=>c.id===op.id))?.socket}))));
 if(r.phaseObservationCount!==expectedPhases.length)invalid();const matched=new Set();
 for(const o of r.phaseObservations){if(!o||!finite(o.time)||o.time<0||o.time>p.duration+1/60||!integer(o.generation,0,Number.MAX_SAFE_INTEGER)||typeof o.socket!=='string')invalid();const index=expectedPhases.findIndex((e,i)=>!matched.has(i)&&e.componentId===o.componentId&&e.operation===o.operation&&e.phaseId===o.phaseId&&e.socket===o.socket&&o.time>=e.time-1e-7&&o.time<=e.time+1/60+1e-7);if(index<0)invalid();matched.add(index);}
 return r;
}
async function createAssemblyPreview(spec,{compiledSpecHash,sourceRoot,project,scene,stagingDir,storageRoot,audioMetadata,audioReceipts,runtimeReceipts,config,signal,runTool=defaultRunTool}={}){
 abort(signal);const {planAssemblyPreview}=require('./assembly-preview-planning'),plan=planAssemblyPreview(spec,{compiledSpecHash});
 const base={version:1,scope:'development-assembly-preview',visualQuality:'unverified',specHash:plan.specHash,compiledSpecHash,planHash:plan.planHash,omissions:plan.omissions};
 if(plan.status==='not-applicable')return {...base,status:'not-applicable',frames:[],contactSheet:null,motionPreview:null,native:null};
 if(![sourceRoot,project,scene,stagingDir].every(p=>typeof p==='string'&&path.isAbsolute(p)))throw fail('INVALID_INPUT','Expected absolute cached assembly paths');
 if((await fs.lstat(sourceRoot)).isSymbolicLink()||await fs.realpath(sourceRoot)!==path.resolve(sourceRoot))throw fail('UNSAFE_PATH','Linked rig source root');
 const relativeProject=path.relative(sourceRoot,project);if(relativeProject)await resolveContained(sourceRoot,relativeProject);else if(await fs.realpath(sourceRoot)!==path.resolve(sourceRoot))throw fail('UNSAFE_PATH','Linked rig root');
 const relativeScene=path.relative(project,scene);await resolveContained(project,relativeScene);
 const tools=config?.tools||{},name=tools.megadot?'megadot':'godot';if(!tools[name]?.executable)throw fail('CAPABILITY_MISSING','Assembly preview requires configured native tool');
 if(!tools.python?.executable)throw fail('CAPABILITY_MISSING','Assembly preview requires configured Python');
 await fs.mkdir(stagingDir,{recursive:true});
 const captured=await captureRuntimeResources(project,relativeScene.split(path.sep).join('/'),signal,{audioMetadata,audioReceipts,runtimeReceipts,stagingDir,storageRoot,config,tool:tools[name]});
 const folder=await resolveContained(stagingDir,'assembly-preview-'+crypto.randomUUID(),{mustExist:false});await fs.mkdir(folder);const transient=path.join(folder,'project');await fs.mkdir(transient);
 for(const f of captured.files){abort(signal);const target=await resolveContained(transient,f.path,{mustExist:false});await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,Buffer.from(f.base64,'base64'),{flag:'wx'});}
 await fs.writeFile(path.join(transient,'project.godot'),'[application]\nconfig/name="Assembly Development Preview"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\ntextures/default_filters/use_nearest_mipmap_filter=false\n',{flag:'wx'});
 await fs.copyFile(path.resolve(__dirname,'../godot/preview_assembly.gd'),path.join(transient,'preview_assembly.gd'),fs.constants.COPYFILE_EXCL);
 const request={version:1,scene:captured.rootScene,inventoryHash:captured.inventoryHash,plan};await fs.writeFile(path.join(transient,'assembly-request.json'),JSON.stringify(request),{flag:'wx'});
 abort(signal);const result=await runTool({[name]:tools[name]},name,['--path',transient,'--rendering-method','gl_compatibility','--position','-10000,-10000','--script','res://preview_assembly.gd'],{signal,timeoutMs:120000,maxOutputBytes:2097152});abort(signal);
 await fs.writeFile(path.join(folder,'native-log.json'),JSON.stringify(result));if(result.error||result.exitCode!==0||/SCRIPT ERROR|ERROR:/.test((result.stdout||'')+(result.stderr||'')))throw fail(result.error?.code||'ASSEMBLY_PREVIEW_FAILED','Native assembly capture failed: '+(result.error?.message||result.stderr||result.stdout));
 let native;try{native=JSON.parse(await readOwned(transient,'assembly-receipt.json',2097152,signal));}catch(e){if(e.code==='ABORTED')throw e;throw fail('INVALID_NATIVE_ASSEMBLY_PREVIEW','Missing or malformed assembly receipt');}validateAssemblyReceipt(native,plan,captured.inventoryHash);
 for(const f of native.frames){const bytes=await readOwned(transient,f.path,Math.min(16777216,plan.renderLayout.maximumFrameEncodedBytes),signal);if(digest(bytes)!==f.sha256||bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.readUInt32BE(16)!==f.width||bytes.readUInt32BE(20)!==f.height)throw fail('INVALID_NATIVE_ASSEMBLY_PREVIEW','Assembly PNG differs from capture receipt');}
 // Recheck owned staged resources after the process before accepting any images.
 for(const f of captured.files)if(digest(await readOwned(transient,f.path,67108864,signal))!==f.hash)throw fail('CORRUPT_ARTIFACT','Transient runtime resource was modified');
 const inspection=await inspectRenderedFrames(native.frames.map(f=>f.path),{sourceRoot:transient,stagingDir:folder,config,signal,runTool});
 const motion=await createMotionPreview('assembly',native.frames.map((f,i)=>({path:f.path,time:plan.frames[i].time})),.25,{sourceRoot:transient,stagingDir:folder,config,signal,runTool});
 const relative=f=>path.relative(stagingDir,f).split(path.sep).join('/');
 if(captured.audioInspection){const directories=[];for(const directory of captured.audioInspection.retainedDirectories){const local=relative(directory);if(!local||local.split('/').some(p=>!p||p==='.'||p==='..')||!(await fs.stat(await resolveContained(stagingDir,local))).isDirectory())throw fail('INVALID_AUDIO_RESOURCE','Retained audio inspection directory escaped preview staging');directories.push(local);}captured.audioInspection.retainedDirectories=directories;}
 return {...base,status:'completed',inventoryHash:captured.inventoryHash,audioInspection:captured.audioInspection,frames:native.frames.map((f,i)=>({...f,time:plan.frames[i].time,nativeTime:f.time,path:relative(path.join(transient,f.path))})),contactSheet:{...inspection.contactSheet,path:relative(inspection.contactSheet.path)},motionPreview:{...motion,path:relative(motion.path)},native,simulation:plan.simulation};
}
module.exports={createAssemblyPreview,captureRuntimeResources,validateAssemblyReceipt};
