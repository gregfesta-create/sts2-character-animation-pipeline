'use strict';
// Export consumes a validated preexisting rig checkpoint. It is deliberately
// not a synthetic runnable DAG dependency: its exact resultHash fingerprints
// this stage after resume, exclusive lease acquisition and receipt validation.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {openJob,inspectJob}=require('./jobs');
const {hashValue,hashFile,resolveContained,ownedStorage}=require('./assets');
const {planGodotResources,inspectGodotResourceReachability}=require('../adapters/godot');
const {collectAudioEligibility}=require('./audio-eligibility');
const {buildRuntimeManifest,stageRuntimeManifest}=require('./runtime-manifest');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=(code,message)=>Object.assign(new Error(message),{code});
const abort=signal=>{if(signal?.aborted)throw fail('ABORTED','Export cancelled before publication');};
async function capture(root,receipt,maxBytes){
 if(!receipt||!Number.isSafeInteger(receipt.size)||receipt.size<0||receipt.size>maxBytes||!/^[a-f0-9]{64}$/.test(receipt.hash))throw fail('CORRUPT_ARTIFACT','Invalid or oversized checkpoint receipt');
 const file=await resolveContained(root,receipt.path),handle=await fs.open(file,'r');
 try{
  const stat=await handle.stat({bigint:true});
  async function verify(){const current=await fs.lstat(await resolveContained(root,receipt.path),{bigint:true}),opened=await handle.stat({bigint:true});if(!current.isFile()||current.isSymbolicLink()||[current,opened].some(s=>s.dev!==stat.dev||s.ino!==stat.ino||s.size!==BigInt(receipt.size)||s.mtimeNs!==stat.mtimeNs||s.ctimeNs!==stat.ctimeNs))throw fail('CORRUPT_ARTIFACT','Checkpoint identity changed during capture');}
  await verify();const bytes=Buffer.alloc(receipt.size);let position=0;
  while(position<bytes.length){const read=await handle.read(bytes,position,Math.min(65536,bytes.length-position),position);if(!read.bytesRead)throw fail('CORRUPT_ARTIFACT','Checkpoint truncated');position+=read.bytesRead;}
  await verify();if(digest(bytes)!==receipt.hash)throw fail('CORRUPT_ARTIFACT','Checkpoint hash differs from receipt');return bytes;
 }finally{await handle.close();}
}
const attackAdapters=['AttackPresentationBinding.cs','CombatPresentationCaller.cs'];
const assemblyAdapters=['AssemblyStateBinding.cs','CreatureAssemblyBinding.cs','CreatureAssemblyHooks.cs'];
const presentationAdapters=['PipelineVisuals.cs',...attackAdapters,...assemblyAdapters];
const record=(file,bytes)=>({path:file,size:bytes.length,hash:digest(bytes),base64:bytes.toString('base64')});
async function exportCharacter(jobRoot,options={},trusted={}){
 const {config,namespace,signal}=options;abort(signal);
 let integrationRequest;
 if(options.integration!==undefined){
  const value=options.integration;
  if(!value||typeof value!=='object'||Array.isArray(value)||!['bounds,className,namespace','bounds,className,namespace,origin'].includes(Object.keys(value).sort().join(','))||typeof value.namespace!=='string'||typeof value.className!=='string')throw fail('INVALID_INPUT','Integration request requires namespace, className and bounds, with optional origin');
  integrationRequest=structuredClone(value);
 }
 if(!config?.outputRoot||!Array.isArray(config.sourceRoots)||typeof namespace!=='string'||!namespace)throw fail('INVALID_INPUT','Configured roots and explicit namespace are required');
 const relative=path.relative(path.resolve(config.outputRoot),path.resolve(jobRoot));if(!relative)throw fail('UNSAFE_PATH','Export requires a dedicated contained job');
 const root=await resolveContained(config.outputRoot,relative);
 const resume=trusted.resumeCharacter||require('./engine').resumeCharacter,nativeExport=trusted.exportGodotPack||require('./export').exportGodotPack;
 const resumeOptions={config,signal};for(const key of ['effectPlan','effectCapabilities','effectApproval','effectTargets','animationInventory'])if(options[key]!==undefined)resumeOptions[key]=options[key];
 const resumed=await resume(root,resumeOptions);abort(signal);
 if(resumed.status!=='completed'||resumed.valid!==true||!resumed.manifest?.stages?.rig)throw fail('EXPORT_NOT_READY','Export requires approved artwork and a valid completed rig');
 const maxStageBytes=config.limits?.maxStageBytes??256*1024*1024,maxStorageBytes=config.limits?.maxStorageBytes??4*1024**3;
 const maxBytes=options.maxBytes??64*1024*1024,maxPackBytes=options.maxPackBytes??Math.min(128*1024*1024,maxStageBytes-1024*1024);
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>256*1024*1024||!Number.isSafeInteger(maxPackBytes)||maxPackBytes<1||maxPackBytes>512*1024*1024)throw fail('INVALID_INPUT','Invalid export byte limits');
 const job=await openJob(root,{maxStageBytes,maxStorageBytes});
 try{
  if(hashValue(job.manifest)!==hashValue(resumed.manifest))throw fail('CONCURRENT_MODIFICATION','Requested job changed after resume');
  const checkpoint=job.manifest.stages.rig,rigRoot=await resolveContained(root,checkpoint.directory),metadataReceipt=checkpoint.artifacts.find(a=>a.path==='rig.json');
  const metadata=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await capture(rigRoot,metadataReceipt,Math.min(maxStageBytes,4*1024*1024))));
  if(metadata.validation?.valid!==true||typeof metadata.project!=='string'||typeof metadata.scene!=='string'||!metadata.scene.startsWith(metadata.project+'/'))throw fail('EXPORT_NOT_READY','Rig metadata is invalid');
  const project=await resolveContained(rigRoot,metadata.project),scene=await resolveContained(rigRoot,metadata.scene);
  if(resumed.project&&path.resolve(resumed.project)!==project||resumed.scene&&path.resolve(resumed.scene)!==scene)throw fail('CONCURRENT_MODIFICATION','Resume result does not match requested rig');
  const prefix=metadata.project+'/',files=[];let capturedBytes=0,verifiedBytes=metadataReceipt.size;
  for(const receipt of checkpoint.artifacts){
   if(receipt.path==='rig.json')continue;
   abort(signal);const bytes=await capture(rigRoot,receipt,maxStageBytes-verifiedBytes);verifiedBytes+=bytes.length;
   if(!receipt.path.startsWith(prefix)||!/\.(tscn|tres|gd|res|png|wav|ogg)$/.test(receipt.path))continue;
   capturedBytes+=bytes.length;if(capturedBytes>maxBytes)throw fail('QUOTA_EXCEEDED','Runtime capture budget exceeded');files.push(record(receipt.path.slice(prefix.length),bytes));
  }
  const preflight=inspectGodotResourceReachability({rootScene:metadata.scene.slice(prefix.length),files,maxBytes});
  const audioMetadata=[{id:job.manifest.context.spec?.id||'root',prefix:'',validation:metadata.validation}],relocatedReceipts=new Map();
  const graph=job.manifest.context.settings?.componentGraph;
  if(graph){
   if(!Array.isArray(graph.nodes)||graph.nodes.length>16||typeof graph.parentId!=='string')throw fail('INVALID_AUDIO_RESOURCE','Invalid compiled component graph');
   const nodes=new Map(graph.nodes.map(n=>[n.id,n]));if(nodes.size!==graph.nodes.length||!nodes.has(graph.parentId))throw fail('INVALID_AUDIO_RESOURCE','Conflicting component definitions');
   const captured=new Map();
   async function visit(id,relocation,ancestors){
    abort(signal);if(ancestors.has(id)||ancestors.size>4||audioMetadata.length>256)throw fail('INVALID_AUDIO_RESOURCE','Invalid recursive component provenance');
    const node=nodes.get(id);if(!node||!Array.isArray(node.dependencies))throw fail('INVALID_AUDIO_RESOURCE','Missing compiled component definition');
    if(relocation){
     let item=captured.get(id);
     if(!item){
      const cp=job.manifest.stages['component-'+hashValue(id).slice(0,16)+'-rig'];if(!cp||!Array.isArray(cp.artifacts))throw fail('INVALID_AUDIO_RESOURCE','Missing component rig checkpoint');
      const dir=await resolveContained(root,cp.directory),receipts=new Map();let consumed=0,rec;
      for(const a of cp.artifacts){abort(signal);const b=await capture(dir,a,maxStageBytes-consumed);consumed+=b.length;receipts.set(a.path,a);if(a.path==='rig.json')rec=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}
      if(!rec||rec.validation?.valid!==true||typeof rec.project!=='string'||typeof rec.scene!=='string'||!rec.scene.startsWith(rec.project+'/'))throw fail('INVALID_AUDIO_RESOURCE','Invalid component compiler result');
      item={record:rec,receipts};captured.set(id,item);
     }
     audioMetadata.push({id,prefix:relocation,validation:item.record.validation});
     for(const a of item.record.validation.audio??[]){const local=a.resource?.startsWith('res://')?a.resource.slice(6):'';const r=item.receipts.get(item.record.project+'/'+local);if(!r)throw fail('INVALID_AUDIO_RESOURCE','Missing compiler audio artifact');relocatedReceipts.set(relocation+'/'+local,r);}
    }
    const children=new Set();for(const dep of node.dependencies){if(typeof dep.specId!=='string')throw fail('INVALID_AUDIO_RESOURCE','Invalid component edge');if(children.has(dep.specId))continue;children.add(dep.specId);await visit(dep.specId,(relocation?relocation+'/':'')+'components/'+dep.specId,new Set([...ancestors,id]));}
   }
   await visit(graph.parentId,'',new Set());
  }
  const eligibility=collectAudioEligibility({metadata:audioMetadata,files:preflight.binaryResources});
  for(const f of eligibility.files)if(f.path.startsWith('components/')){const r=relocatedReceipts.get(f.path);if(!r||r.hash!==f.hash||r.size!==f.size)throw fail('INVALID_AUDIO_RESOURCE','Relocated audio differs from compiler checkpoint');}
  const planInput={namespace,rootScene:metadata.scene.slice(prefix.length),files,maxBytes};
  // A preflight inventory permits cache lookup, never binary authorization.
  let plan=eligibility.files.length?null:planGodotResources(planInput);
  let integration,sourceCaptures=[];
  const buildIntegration=async(audioAuthority)=>{
  if(integrationRequest!==undefined){
   if(job.manifest.context.spec?.export?.playback!=='tree')throw fail('EXPORT_NOT_READY','Presentation integration requires an existing tree playback rig; rebuild explicitly with tree playback');
   const spec=job.manifest.context.spec,combatCaller=Boolean(spec.animations?.some(clip=>clip.events?.some(event=>event.type==='projectile'))||preflight.files.some(file=>file.path==='effect_scene_controller.gd'));
   const emitted=require('./sts2-integration').emitSts2Integration({...integrationRequest,plan,maxBytes,combatCaller},{audioAuthority});
   if(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(emitted.className)||presentationAdapters.some(file=>file.toLowerCase()===emitted.className.toLowerCase()+'.cs'))throw fail('INVALID_INPUT','Integration class requires a portable filename distinct from fixed presentation adapters');
   const selected=['PipelineVisuals.cs'];
   if(combatCaller)selected.push(...attackAdapters);
   if(spec.components?.length)selected.push(...assemblyAdapters);
   sourceCaptures=[record('integration/'+emitted.className+'.cs',Buffer.from(emitted.source))];
   for(const file of selected){
    const adapterPath=path.join(__dirname,'../adapters/sts2',file),handle=await fs.open(adapterPath,'r');
    try{const stat=await handle.stat();if(!stat.isFile()||stat.size>65536)throw fail('QUOTA_EXCEEDED','Presentation adapter source exceeds bounded kit limit');const adapter=Buffer.alloc(stat.size);let offset=0;while(offset<adapter.length){const read=await handle.read(adapter,offset,adapter.length-offset,offset);if(!read.bytesRead)throw fail('CORRUPT_ARTIFACT','Presentation adapter source truncated');offset+=read.bytesRead;}const after=await handle.stat();if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw fail('CORRUPT_ARTIFACT','Presentation adapter source changed during capture');sourceCaptures.push(record('integration/'+file,adapter));}finally{await handle.close();}
   }
   integration={status:'source-emitted',requiresGameplayIntegration:true,gameAcceptance:false,bytes:sourceCaptures.reduce((n,f)=>n+f.size,0),files:sourceCaptures.map(f=>({path:f.path,hash:f.hash,bytes:f.size}))};
  }
  };
  const effects=structuredClone(resumed.effects??null),effectsIntegrationComplete=resumed.effectsIntegrationComplete??null;
  const animationInventory=structuredClone(resumed.animationInventory??null),animationInventoryComplete=resumed.animationInventoryComplete??null;
  const tool=config.tools?.megadot||config.tools?.godot;if(!tool?.executable||!path.isAbsolute(tool.executable))throw fail('INVALID_INPUT','Native export tool is not configured');
  if((await fs.stat(tool.executable)).size>256*1024*1024)throw fail('INVALID_INPUT','Native executable exceeds fingerprint limit');
  const code={};for(const file of ['lib/delivery.js','lib/export.js','lib/windows-tool-lock.ps1','godot/export_pack.gd','adapters/godot.js','lib/runtime-manifest.js','lib/package-size.js','lib/process.js','lib/audio-eligibility.js','lib/native-audio-resources.js','godot/inspect_audio_resources.gd'])code[file]=await hashFile(path.join(__dirname,'..',file));
  if(integrationRequest!==undefined){code['lib/sts2-integration.js']=await hashFile(path.join(__dirname,'sts2-integration.js'));for(const file of presentationAdapters)code['adapters/sts2/'+file]=await hashFile(path.join(__dirname,'../adapters/sts2',file));}
  const fingerprint={version:1,sourceCheckpoint:{jobId:job.manifest.jobId,contextHash:job.manifest.contextHash,stageId:'rig',resultHash:checkpoint.resultHash},namespace,tool:{configuration:tool,hash:await hashFile(tool.executable)},code,inventory:files.map(({base64,...f})=>f),eligibility:hashValue(eligibility),rootScene:preflight.rootScene,effects:hashValue({effects,effectsIntegrationComplete}),maxBytes,maxPackBytes};
  fingerprint.animationInventory=hashValue({animationInventory,animationInventoryComplete});
  if(integrationRequest!==undefined)fingerprint.integration={request:integrationRequest};
  const stage={id:'export',deps:[],contextKeys:[],fingerprint,run:async({stagingDir})=>{
   abort(signal);
   const provider=await resolveContained(root,'provider',{mustExist:false});await fs.mkdir(provider,{recursive:true});
   const stagingParent=await resolveContained(root,'provider/exports',{mustExist:false});await fs.mkdir(stagingParent,{recursive:true});
   let audioAuthority;
   if((await ownedStorage(root))+eligibility.files.reduce((n,f)=>n+f.size,0)+(Math.ceil(eligibility.files.length/4)+2)*1024*1024>maxStorageBytes)throw fail('QUOTA_EXCEEDED','Audio inspection staging cannot fit remaining storage');
   if(eligibility.files.length){const inspect=trusted.inspectNativeAudioResources||require('./native-audio-resources').inspectNativeAudioResources;const inspected=await inspect({files:eligibility.files,audio:eligibility.audio,stagingParent,tool,namespaces:[namespace],signal,maxBytes});audioAuthority=inspected.authority;abort(signal);}
   plan=planGodotResources(planInput,{audioAuthority});
   await buildIntegration(audioAuthority);const integrationBytes=integration?.bytes??0;
   const upperBound=65536+plan.files.reduce((n,f)=>n+Math.ceil(f.size/4096)*4096+Math.ceil((Buffer.byteLength('res://'+f.path)+256)/4096)*4096,0);
   if(upperBound>maxPackBytes||upperBound+1024*1024+integrationBytes>maxStageBytes)throw fail('QUOTA_EXCEEDED','Conservative export output bound exceeds stage or pack quota');
   if((await ownedStorage(root))+plan.files.reduce((n,f)=>n+f.size,0)+upperBound*2+2*1024*1024+integrationBytes>maxStorageBytes)throw fail('QUOTA_EXCEEDED','Retained staging and published pack cannot fit remaining job storage');
   const exported=await nativeExport({plan,stagingParent,tool,maxBytes,maxPackBytes,signal},{audioAuthority});abort(signal);
   const packRelative=path.relative(stagingParent,exported.pack).split(path.sep).join('/');
   const pack=await capture(stagingParent,{path:packRelative,size:exported.bytes,hash:exported.hash},maxPackBytes);
   if(pack.subarray(0,4).toString()!=='GDPC'||exported.rootScene!=='res://'+plan.rootScene)throw fail('CORRUPT_ARTIFACT','Native export did not match requested root scene or PCK format');
   if(hashValue(await inspectJob(root))!==hashValue(job.manifest))throw fail('CONCURRENT_MODIFICATION','Manifest changed during native export');
   const receipt={version:1,nativeExportStatus:'pack-created',gameAcceptance:false,pack:'character.pck',hash:exported.hash,bytes:pack.length,rootScene:exported.rootScene,sourceCheckpoint:fingerprint.sourceCheckpoint,namespace,sizeReport:exported.sizeReport,effects,effectsIntegrationComplete};
   if(animationInventory!==null){receipt.animationInventory=animationInventory;receipt.animationInventoryComplete=animationInventoryComplete===true;}
   if(integration)receipt.integration=integration;
   const receiptBytes=Buffer.from(JSON.stringify(receipt));if(receiptBytes.length>1024*1024)throw fail('QUOTA_EXCEEDED','Delivery metadata exceeds bounded publication limit');
   const captures=[record('character.pck',pack),record('delivery.json',receiptBytes)];
   const publication=await stageRuntimeManifest({captures,stagingParent:stagingDir,maxBytes:maxStageBytes,manifest:buildRuntimeManifest({roots:captures.map(c=>c.path),resources:captures.map(c=>({id:c.path,path:c.path,category:'metadata'}))})});
   // Source kit is a development deliverable, outside the runtime PCK and its allowlist.
   if(sourceCaptures.length){await fs.mkdir(await resolveContained(publication.directory,'integration',{mustExist:false}));for(const source of sourceCaptures)await fs.writeFile(await resolveContained(publication.directory,source.path,{mustExist:false}),Buffer.from(source.base64,'base64'),{flag:'wx'});}
   abort(signal);
  }};
  const manifest=await job.run([stage]),published=manifest.stages.export,receiptArtifact=published.artifacts.find(a=>a.path.endsWith('/delivery.json'));
  const publishedRoot=await resolveContained(root,published.directory),receipt=JSON.parse((await capture(publishedRoot,receiptArtifact,1024*1024)).toString('utf8'));
  const pack=await resolveContained(publishedRoot,path.posix.join(path.posix.dirname(receiptArtifact.path),receipt.pack));
  if(receipt.integration)for(const file of receipt.integration.files){file.path=await resolveContained(publishedRoot,path.posix.join(path.posix.dirname(receiptArtifact.path),file.path));}
  return {status:'exported',complete:true,...receipt,pack,jobRoot:root,manifest};
 }finally{await job.close();}
}
module.exports={exportCharacter};
