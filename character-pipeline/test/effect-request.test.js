'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {openJob}=require('../lib/jobs');
const {createSpec}=require('../lib/spec');
const {publishSource,hashValue}=require('../lib/assets');
const {createArtworkReview,approveArtwork}=require('../lib/artwork-review');
const {inspectMechanics}=require('../lib/mechanics');
const {captureEffectRequest}=require('../lib/effect-request');
async function fixture(t){
 const base=path.resolve(__dirname,'../../.tmp/effect-request');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'case-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const mechanics=path.join(root,'mechanics');await fs.mkdir(mechanics);const source=path.join(mechanics,'Power.cs');await fs.writeFile(source,'class ExamplePower { int Amount; }');
 const inventory=await inspectMechanics({characterId:'hero',sourceRoots:[mechanics],mechanics:[{key:'mod.Example',modId:'mod',modelSymbol:'ExamplePower',evidence:[{path:source,symbol:'ExamplePower',lineStart:1,lineEnd:1}]}]});
 // Synthetic approved artwork; no image tool or creative asset is invoked.
 const spec=createSpec({id:'hero',description:'synthetic effect request',template:'custom'});spec.parts=[{id:'body',role:'body',bone:'root',layer:0,pivot:[0,0],image:{path:'art.png'}}];spec.sockets=[{id:'tip',bone:'root',position:[0,0]}];
 await fs.writeFile(path.join(root,'art.png'),'synthetic approved bytes');const jobRoot=path.join(root,'approved');const stored=await publishSource(root,'art.png',jobRoot);const inputs={'art.png':{relative:'sources/'+stored.hash,hash:stored.hash,size:stored.size}};
 const job=await openJob(jobRoot,{spec,inputs});const jobId=job.manifest.jobId;await job.close();const config={outputRoot:root,sourceRoots:[root],mechanics:{sourceRoots:[mechanics]},tools:{python:{executable:process.execPath}}};
 const review=await createArtworkReview({jobRoot,jobId,spec,inputs,config,runTool:async(_,__,args)=>{const r=JSON.parse(await fs.readFile(args[1],'utf8'));await fs.mkdir(r.outputDirectory,{recursive:true});const output=path.join(r.outputDirectory,'original.png');await fs.writeFile(output,'synthetic preview');return {exitCode:0,stdout:JSON.stringify({ok:true,image:{path:output,width:1,height:1}})};}});await approveArtwork(jobRoot,{config,reviewId:review.reviewId});
 const bytes=Buffer.alloc(128);bytes.write('MZ');bytes.writeUInt32LE(64,60);bytes.write('PE\0\0',64,'binary');for(const name of ['game.dll','base.dll'])await fs.writeFile(path.join(root,name),bytes);
 const plan={version:1,characterId:'hero',mechanicsFingerprint:inventory.fingerprint,inspectionVersion:'1',adapterContractVersion:'1',evidence:inventory.evidence,decisions:[{id:'visible',mechanicKey:'mod.Example',outcome:'effect',reason:'Synthetic test',evidenceIds:inventory.mechanics[0].evidenceIds,bindingId:'power',rule:{effectIds:['green'],condition:{type:'present'},scope:'whileActive',socketId:'tip',channel:'tip',priority:1}}]};
 const request={version:1,runtime:{gameAssembly:path.join(root,'game.dll'),baseLibAssembly:path.join(root,'base.dll')},resources:[{id:'original',job:'approved',reviewId:review.reviewId,sourceHash:stored.hash}],bindings:[{id:'power',mechanicKey:'mod.Example'}],effects:[{id:'green',capability:'tint',resourceId:'original',presentation:{color:[0,1,0,1]}}],targets:{tip:{partId:'body'}}};
 return {root,source,jobRoot,spec,config,inventory,plan,request,stored,options:{config,spec,inventory,plan}};
}
test('captures first-party identity and approves only exact verified resource proofs until close',async t=>{
 const f=await fixture(t),r=await captureEffectRequest(f.request,f.options);t.after(()=>r.close());assert.equal(r.gameAcceptance,false);assert.equal(r.requiresGameplayIntegration,true);assert.equal(r.capabilities.adapterContractVersion,'1');assert.match(r.capabilities.gameFingerprint,/^[a-f0-9]{64}$/);assert.ok(Object.isFrozen(r.requestIdentity));
 const resource=r.capabilities.effects[0].resources[0],proof={resourceHash:resource.sha256,styleHash:hashValue(f.spec.style),approvalId:resource.approvalId,importSettings:{}};
 assert.equal(await r.approval(proof),true);assert.equal(await r.approval({...proof,importSettings:{filter:true}}),false);assert.equal(await r.approval({...proof,approvalId:'invented'}),false);assert.equal(r.capabilities.supportsEffect({...r.capabilities.effects[0],presentation:{color:[1,0,0,1]}}),false);
 const remapped=structuredClone(r.capabilities.effects[0]);remapped.resources[0].path=path.join(f.root,'sources',resource.sha256);assert.equal(r.capabilities.supportsEffect(remapped),true);
 await assert.rejects(openJob(f.jobRoot),{code:'JOB_LOCKED'});await r.close();await r.close();assert.equal(await r.approval(proof),false);const j=await openJob(f.jobRoot);await j.close();
});
test('overlay resources feed the existing positive capture boundary without caller callbacks',async t=>{
 const f=await fixture(t);f.request.effects[0]={id:'green',capability:'overlay',resourceId:'original',presentation:{offset:[2,3],scale:[1,1]}};
 const r=await captureEffectRequest(f.request,f.options);t.after(()=>r.close());const planPath=path.join(f.root,'plan.json'),inventoryPath=path.join(f.root,'inventory.json');await fs.writeFile(planPath,JSON.stringify(f.plan));await fs.writeFile(inventoryPath,JSON.stringify(f.inventory));
 const result=await require('../lib/effect-build').captureEffectPlan({characterId:f.spec.id,planPath,inventoryPath},{config:f.config,styleHash:hashValue(f.spec.style),capabilities:r.capabilities,approval:r.approval});assert.equal(result.status,'validated');assert.equal(result.resources[0].hash,f.stored.hash);assert.equal(r.capabilities.effects[0].presentation.resourceHash,f.stored.hash);await r.close();
});
test('rejects JSON self-certification, unsupported bindings and unsafe paths before native work',async t=>{
 const f=await fixture(t);for(const mutate of [r=>r.implemented=true,r=>r.effects[0].implemented=true,r=>r.bindings[0].mechanicKey='invented',r=>r.resources[0].job='../escape',r=>r.runtime.gameAssembly=process.execPath,r=>r.effects[0].presentation.color=[2,0,0,1],r=>r.targets.tip.partId='missing']){const request=structuredClone(f.request);mutate(request);await assert.rejects(captureEffectRequest(request,f.options));}
 const j=await openJob(f.jobRoot);await j.close();
});
test('rejects stale approval, style, source bytes and mechanics and releases leases after errors',async t=>{
 const f=await fixture(t);const stale=structuredClone(f.request);stale.resources[0].reviewId='0'.repeat(64);await assert.rejects(captureEffectRequest(stale,f.options));
 const changed=structuredClone(f.spec);changed.style={...changed.style,extra:'changed'};await assert.rejects(captureEffectRequest(f.request,{...f.options,spec:changed}));
 const r=await captureEffectRequest(f.request,f.options);const resource=r.capabilities.effects[0].resources[0];await fs.writeFile(path.join(f.jobRoot,'review/approval.json'),JSON.stringify({version:1,reviewId:'0'.repeat(64),decision:'approved'}));assert.equal(await r.approval({resourceHash:resource.sha256,styleHash:hashValue(f.spec.style),approvalId:resource.approvalId,importSettings:{}}),false);await r.close();
 await fs.writeFile(path.join(f.jobRoot,'sources',f.stored.hash),'changed bytes');await assert.rejects(captureEffectRequest(f.request,f.options));const j=await openJob(f.jobRoot);await j.close();
 await fs.writeFile(f.source,'class ExamplePower { int Changed; }');await assert.rejects(captureEffectRequest(f.request,f.options),{code:'STALE_EFFECT_PLAN'});
});
test('runtime fingerprints derive from current bytes and own held resource job is not reopened',async t=>{
 const f=await fixture(t),held=await openJob(f.jobRoot);const r=await captureEffectRequest(f.request,{...f.options,heldJobRoot:f.jobRoot});const first=r.capabilities.gameFingerprint;await r.close();await assert.rejects(openJob(f.jobRoot),{code:'JOB_LOCKED'});await held.close();
 const bytes=await fs.readFile(f.request.runtime.gameAssembly);bytes[100]=1;await fs.writeFile(f.request.runtime.gameAssembly,bytes);const next=await captureEffectRequest(f.request,f.options);assert.notEqual(next.capabilities.gameFingerprint,first);await next.close();
});
test('rejects ancestor junction replacement between resolution and runtime/resource open',async t=>{
 for(const phase of ['runtime-open','resource-open']){
  const f=await fixture(t);let file;
  if(phase==='runtime-open'){const bin=path.join(f.root,'bin');await fs.mkdir(bin);file=path.join(bin,'game.dll');await fs.copyFile(f.request.runtime.gameAssembly,file);f.request.runtime.gameAssembly=file;}
  else file=path.join(f.jobRoot,'sources',f.stored.hash);
  const directory=path.dirname(file),saved=directory+'-saved',originalOpen=fs.open;let switched=false,moved=false;
  async function replaceAncestor(){if(switched)return;await fs.rename(directory,saved);moved=true;await fs.symlink(saved,directory,process.platform==='win32'?'junction':'dir');switched=true;}
  fs.open=async function(target,...args){
   if(path.resolve(String(target))!==file)return originalOpen.call(this,target,...args);
   await replaceAncestor();
   const handle=await originalOpen.call(this,target,...args);
   return handle;
  };
  try{await assert.rejects(async()=>{const result=await captureEffectRequest(f.request,f.options);await result.close();},{code:'UNSAFE_PATH'});assert.equal(switched,true);}
  finally{fs.open=originalOpen;if(switched)await fs.unlink(directory);if(moved)await fs.rename(saved,directory);}
  const job=await openJob(f.jobRoot);await job.close();
 }
});

test('animated overlay retains approved atlas provenance and binds exact descriptor identity',async t=>{
 const f=await fixture(t),animation={columns:2,rows:1,frameCount:2,durations:[0.1,0.2],loop:true};f.request.effects[0]={id:'green',capability:'overlay',resourceId:'original',presentation:{offset:[2,3],scale:[1,1],animation}};
 const r=await captureEffectRequest(f.request,f.options);t.after(()=>r.close());const effect=r.capabilities.effects[0];assert.deepEqual(effect.presentation.animation,animation);assert.ok(Object.isFrozen(effect.presentation.animation.durations));assert.equal(effect.resources.length,1);assert.equal(effect.resources[0].sha256,f.stored.hash);assert.equal(effect.presentation.resourceHash,f.stored.hash);assert.equal(r.requestIdentity.implementation,'first-party-tint-overlay-2');assert.equal(r.capabilities.version,'first-party-tint-overlay-2');assert.equal(r.capabilities.supportsEffect(structuredClone(effect)),true);
 for(const update of [{loop:false},{durations:[0.2,0.1]},{columns:1,rows:2}]){const changed=structuredClone(effect);Object.assign(changed.presentation.animation,update);assert.equal(r.capabilities.supportsEffect(changed),false);}
 const changed=structuredClone(f.request);changed.effects[0].presentation.animation.loop=false;await r.close();const next=await captureEffectRequest(changed,f.options);t.after(()=>next.close());assert.notEqual(hashValue(next.requestIdentity),hashValue(r.requestIdentity));await next.close();
});
test('invalid animation rejects before resource capture and tint cannot carry animation',async t=>{
 const f=await fixture(t);f.request.resources[0].reviewId='0'.repeat(64);const animation={columns:2,rows:1,frameCount:2,durations:[0.1,0.2],loop:true};
 for(const update of [{frameCount:3},{durations:[0,0.2]},{extra:1}]){const request=structuredClone(f.request);request.effects[0]={id:'green',capability:'overlay',resourceId:'original',presentation:{offset:[0,0],scale:[1,1],animation:{...animation,...update}}};await assert.rejects(captureEffectRequest(request,f.options),{code:'INVALID_EFFECT_REQUEST'});}
 f.request.effects[0].presentation.animation=animation;await assert.rejects(captureEffectRequest(f.request,f.options),{code:'INVALID_EFFECT_REQUEST'});const job=await openJob(f.jobRoot);await job.close();
});

async function addImpactOriginal(f,{jobName='impact-approved',bytes='independent approved impact bytes',style=f.spec.style}={}){
 const spec=structuredClone(f.spec);spec.style=style;const sourceName=jobName+'.png';await fs.writeFile(path.join(f.root,sourceName),bytes);
 const jobRoot=path.join(f.root,jobName),stored=await publishSource(f.root,sourceName,jobRoot),inputs={'art.png':{relative:'sources/'+stored.hash,hash:stored.hash,size:stored.size}};
 const job=await openJob(jobRoot,{spec,inputs}),jobId=job.manifest.jobId;await job.close();
 const review=await createArtworkReview({jobRoot,jobId,spec,inputs,config:f.config,runTool:async(_,__,args)=>{const r=JSON.parse(await fs.readFile(args[1],'utf8'));await fs.mkdir(r.outputDirectory,{recursive:true});const output=path.join(r.outputDirectory,'original.png');await fs.writeFile(output,'synthetic impact preview');return {exitCode:0,stdout:JSON.stringify({ok:true,image:{path:output,width:2,height:2}})};}});
 await approveArtwork(jobRoot,{config:f.config,reviewId:review.reviewId});const resource={id:jobName,job:jobName,reviewId:review.reviewId,sourceHash:stored.hash};f.request.resources.push(resource);return {resource,stored,jobRoot};
}
function impact(resourceId,animation){return {resourceId,durationSeconds:1.2,presentation:{offset:[12,-8],scale:[0.5,2],...(animation?{animation}:{})}};}
test('approved independent impact overlay works with tint projectile and captured provenance',async t=>{
 const f=await fixture(t),other=await addImpactOriginal(f);f.request.effects[0].impact=impact(other.resource.id);
 const r=await captureEffectRequest(f.request,f.options);t.after(()=>r.close());const e=r.capabilities.effects[0];
 assert.deepEqual(e.presentation,{color:[0,1,0,1]});assert.deepEqual(e.impact,{durationSeconds:1.2,presentation:{offset:[12,-8],scale:[0.5,2],resourceHash:other.stored.hash}});
 assert.equal(e.resources.length,2);const p=e.resources[1];assert.equal(p.sha256,other.stored.hash);assert.equal(p.approvalId,other.resource.reviewId);assert.equal(p.styleHash,hashValue(f.spec.style));assert.deepEqual(p.importSettings,{});
 assert.equal(await r.approval({resourceHash:p.sha256,styleHash:p.styleHash,approvalId:p.approvalId,importSettings:{}}),true);
 assert.equal(r.capabilities.version,'first-party-tint-overlay-impact-3');assert.equal(r.requestIdentity.implementation,r.capabilities.version);assert.ok(Object.isFrozen(e.impact.presentation.scale));
 const moved=structuredClone(e);moved.resources.forEach(x=>x.path=path.join(f.root,'relocated',x.sha256));assert.equal(r.capabilities.supportsEffect(moved),true);moved.impact.durationSeconds=1.3;assert.equal(r.capabilities.supportsEffect(moved),false);
 const planPath=path.join(f.root,'impact-plan.json'),inventoryPath=path.join(f.root,'impact-inventory.json');await fs.writeFile(planPath,JSON.stringify(f.plan));await fs.writeFile(inventoryPath,JSON.stringify(f.inventory));
 const captured=await require('../lib/effect-build').captureEffectPlan({characterId:f.spec.id,planPath,inventoryPath},{config:f.config,styleHash:hashValue(f.spec.style),capabilities:r.capabilities,approval:r.approval});assert.equal(captured.status,'validated');assert.equal(captured.resources.length,2);await r.close();
});
test('impact atlas is normalized independently and repeated approved resource is deduplicated',async t=>{
 const f=await fixture(t),animation={columns:2,rows:2,frameCount:4,durations:[0.1,0.2,0.3,0.4],loop:false};f.request.effects[0].impact=impact('original',animation);
 const r=await captureEffectRequest(f.request,f.options);t.after(()=>r.close());const e=r.capabilities.effects[0];assert.equal(e.resources.length,1);assert.deepEqual(e.impact.presentation.animation,animation);assert.ok(Object.isFrozen(e.impact.presentation.animation.durations));
 const changed=structuredClone(e);changed.impact.presentation.animation.loop=true;assert.equal(r.capabilities.supportsEffect(changed),false);await r.close();
});
test('same bytes with separate exact approvals retain both provenance records',async t=>{
 const f=await fixture(t),other=await addImpactOriginal(f,{bytes:'synthetic approved bytes'});f.request.effects[0].impact=impact(other.resource.id);
 const r=await captureEffectRequest(f.request,f.options);t.after(()=>r.close());const resources=r.capabilities.effects[0].resources;assert.equal(resources.length,2);assert.equal(resources[0].sha256,resources[1].sha256);assert.notEqual(resources[0].approvalId,resources[1].approvalId);await r.close();
});
test('invalid impact shapes, duration, bounds, resource and atlas reject before approval lookup',async t=>{
 const f=await fixture(t);f.request.resources[0].reviewId='0'.repeat(64);
 const mutations=[i=>i.durationSeconds=0,i=>i.durationSeconds=-1,i=>i.durationSeconds=10.01,i=>i.durationSeconds=Infinity,i=>i.durationSeconds='1',i=>i.extra=true,i=>i.capability='overlay',i=>i.resourceId='missing',i=>delete i.resourceId,i=>i.presentation={color:[1,0,0,1]},i=>i.presentation.capability='overlay',i=>i.presentation.scale=[0,1],i=>i.presentation.scale=[1e-100,1],i=>i.presentation.scale=[17,1],i=>i.presentation.offset=[4096,4096],i=>i.presentation.offset=[NaN,0],i=>i.presentation.animation={columns:2,rows:1,frameCount:3,durations:[0.1,0.1,0.1],loop:true},i=>i.presentation.animation={columns:2,rows:1,frameCount:2,durations:[0.001,0.1],loop:true},i=>i.presentation.animation={columns:2,rows:1,frameCount:2,durations:[6,6],loop:true}];
 for(const mutate of mutations){const request=structuredClone(f.request);request.effects[0].impact=impact('original');mutate(request.effects[0].impact);await assert.rejects(captureEffectRequest(request,f.options),{code:'INVALID_EFFECT_REQUEST'});}
});
test('impact-only resources require exact current approval, bytes and matching style',async t=>{
 const f=await fixture(t),other=await addImpactOriginal(f);f.request.effects[0].impact=impact(other.resource.id);
 for(const update of [{reviewId:'0'.repeat(64)},{sourceHash:'0'.repeat(64)}]){const request=structuredClone(f.request);Object.assign(request.resources[1],update);await assert.rejects(captureEffectRequest(request,f.options),{code:'ARTWORK_APPROVAL_REQUIRED'});}
 const styled=await addImpactOriginal(f,{jobName:'different-style',style:{...f.spec.style,extra:'different'}});f.request.resources=f.request.resources.filter(x=>x.id!==other.resource.id);f.request.effects[0].impact=impact(styled.resource.id);await assert.rejects(captureEffectRequest(f.request,f.options),{code:'ARTWORK_APPROVAL_REQUIRED'});
 f.request.resources=f.request.resources.filter(x=>x.id!==styled.resource.id);f.request.resources.push(other.resource);f.request.effects[0].impact=impact(other.resource.id);await fs.writeFile(path.join(other.jobRoot,'sources',other.stored.hash),'tampered impact bytes');await assert.rejects(captureEffectRequest(f.request,f.options));
 const job=await openJob(f.jobRoot);await job.close();
});

test('overlay projectile and impact have separate transforms and atlas identities',async t=>{
 const f=await fixture(t);f.request.effects[0]={id:'green',capability:'overlay',resourceId:'original',presentation:{offset:[1,2],scale:[1,1]},impact:impact('original',{columns:2,rows:1,frameCount:2,durations:[0.1,0.2],loop:true})};f.request.effects[0].impact.durationSeconds=10;
 const r=await captureEffectRequest(f.request,f.options);t.after(()=>r.close());const e=r.capabilities.effects[0];assert.deepEqual(e.presentation.offset,[1,2]);assert.equal(e.presentation.animation,undefined);assert.deepEqual(e.impact.presentation.offset,[12,-8]);assert.equal(e.impact.durationSeconds,10);assert.equal(e.resources.length,1);await r.close();
});
