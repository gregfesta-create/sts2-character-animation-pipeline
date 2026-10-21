'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {openJob,inspectJob}=require('../lib/jobs'),{exportCharacter}=require('../lib/delivery');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function audioFixture(t,{component=false,unused=false}={}){
 const f=await fixture(t),bytes=Buffer.from('RSRC fixture'),audio=[{id:'shot',format:'wav',duration:.1,resource:'res://sound.res'}];
 const graph={parentId:'synthetic',nodes:[{id:'synthetic',dependencies:component?[{specId:'arm'}]:[]},{id:'arm',dependencies:[]}]};
 const job=await openJob(f.jobRoot,{settings:{componentGraph:component?graph:null}});
 const write=async(dir,child)=>{await fs.mkdir(path.join(dir,'godot'),{recursive:true});await fs.writeFile(path.join(dir,'rig.json'),JSON.stringify({project:'godot',scene:'godot/character.tscn',validation:{valid:true,audio:child?audio:component?[]:audio}}));await fs.writeFile(path.join(dir,'godot/sound.res'),bytes);await fs.writeFile(path.join(dir,'godot/character.tscn'),'[gd_scene format=3]\n'+(!unused?'[ext_resource type="AudioStream" path="res://sound.res" id="1"]\n':'')+'[node name="Character" type="Node2D"]\n'+(!unused?'metadata/audio = ExtResource("1")':''));};
 await job.run([...(component?[{id:'component-'+require('../lib/assets').hashValue('arm').slice(0,16)+'-rig',fingerprint:'audio-child',run:async({stagingDir})=>write(stagingDir,true)}]:[]),{id:'rig',fingerprint:'audio-root',run:async({stagingDir})=>{await write(stagingDir,false);if(component){await fs.mkdir(path.join(stagingDir,'godot/components/arm'),{recursive:true});await fs.writeFile(path.join(stagingDir,'godot/components/arm/sound.res'),bytes);await fs.writeFile(path.join(stagingDir,'godot/character.tscn'),'[gd_scene format=3]\n[ext_resource type="AudioStream" path="res://components/arm/sound.res" id="1"]\n[node name="Character" type="Node2D"]\nmetadata/audio = ExtResource("1")');}}}]);await job.close();
 let inspections=0,exports=0;
 const inspector=async options=>{inspections++;return require('../lib/native-audio-resources').inspectNativeAudioResources(options,{runLockedTool:async()=>({exitCode:0,stdout:'AUDIO_RESOURCES '+JSON.stringify({version:1,resources:options.files.map(f=>({path:f.path,hash:f.hash,size:f.size,class:'AudioStreamWAV',format:'wav',duration:.1,sampleRate:8000,channels:1,frames:800,granuleFrames:null,dependencies:[],script:false}))}),stderr:''})});};
 const exporter=async({plan,stagingParent},trusted)=>{exports++;require('../lib/export').validatePackPlan(plan,{},trusted);assert.equal(plan.files.filter(f=>f.category==='audio').length,unused?0:1);const pack=path.join(stagingParent,'audio-'+exports+'.pck'),b=Buffer.from('GDPC compact audio');await fs.writeFile(pack,b);return {pack,bytes:b.length,hash:hash(b),rootScene:'res://'+plan.rootScene,sizeReport:{archiveBytes:b.length}};};
 return {...f,trusted:{resumeCharacter:f.resumeCharacter,inspectNativeAudioResources:inspector,exportGodotPack:exporter},inspections:()=>inspections,exports:()=>exports};
}
test('delivery inspects only reached root or component audio and cache reuse needs no native authority',async t=>{
 for(const component of [false,true]){const f=await audioFixture(t,{component}),options={config:f.config,namespace:'mods/audio'};const first=await exportCharacter(f.jobRoot,options,f.trusted);assert.equal(first.status,'exported');assert.equal(f.inspections(),1);await exportCharacter(f.jobRoot,options,f.trusted);assert.equal(f.inspections(),1);assert.equal(f.exports(),1);await fs.appendFile(first.pack,'corruption');await exportCharacter(f.jobRoot,options,f.trusted);assert.equal(f.inspections(),2);assert.equal(f.exports(),2);}
 const unused=await audioFixture(t,{unused:true});await exportCharacter(unused.jobRoot,{config:unused.config,namespace:'mods/audio'},unused.trusted);assert.equal(unused.inspections(),0);
});
test('delivery audio inspection failure or cancellation never publishes export',async t=>{
 for(const cancel of [false,true]){const f=await audioFixture(t),controller=new AbortController();await assert.rejects(()=>exportCharacter(f.jobRoot,{config:f.config,namespace:'mods/audio',signal:controller.signal},{...f.trusted,inspectNativeAudioResources:async()=>{if(cancel){controller.abort();return {authority:{}};}throw Error('inspection failed');}}));assert.equal(f.exports(),0);assert.equal((await inspectJob(f.jobRoot)).stages.export,undefined);}
});
test('delivery rejects a relocated binary that differs from its component compiler receipt',async t=>{
 const f=await audioFixture(t,{component:true}),job=await openJob(f.jobRoot),id='component-'+require('../lib/assets').hashValue('arm').slice(0,16)+'-rig';
 await job.run([{id,fingerprint:'different-compiler-bytes',run:async({stagingDir})=>{await fs.mkdir(path.join(stagingDir,'godot'));await fs.writeFile(path.join(stagingDir,'rig.json'),JSON.stringify({project:'godot',scene:'godot/character.tscn',validation:{valid:true,audio:[{id:'shot',format:'wav',duration:.1,resource:'res://sound.res'}]}}));await fs.writeFile(path.join(stagingDir,'godot/sound.res'),'RSRC different compiled bytes');}}]);await job.close();
 await assert.rejects(()=>exportCharacter(f.jobRoot,{config:f.config,namespace:'mods/audio'},f.trusted),{code:'INVALID_AUDIO_RESOURCE'});assert.equal(f.inspections(),0);assert.equal(f.exports(),0);
});
test('delivery rejects reached binary audio without compiler declaration before inspection',async t=>{
 const f=await fixture(t),job=await openJob(f.jobRoot);await job.run([{id:'rig',fingerprint:'undeclared-audio',run:async({stagingDir})=>{await fs.mkdir(path.join(stagingDir,'godot'));await fs.writeFile(path.join(stagingDir,'rig.json'),JSON.stringify({project:'godot',scene:'godot/character.tscn',validation:{valid:true}}));await fs.writeFile(path.join(stagingDir,'godot/sound.res'),'RSRC fixture');await fs.writeFile(path.join(stagingDir,'godot/character.tscn'),'[gd_scene format=3]\n[ext_resource type="AudioStream" path="res://sound.res" id="1"]\n[node name="Character" type="Node2D"]\nmetadata/audio = ExtResource("1")');}}]);await job.close();let inspected=0;
 await assert.rejects(()=>exportCharacter(f.jobRoot,{config:f.config,namespace:'mods/hero'},{resumeCharacter:f.resumeCharacter,exportGodotPack:f.exportGodotPack,inspectNativeAudioResources:async()=>{inspected++;}}),{code:'INVALID_AUDIO_RESOURCE'});assert.equal(inspected,0);assert.equal(f.calls(),0);
});
async function fixture(t,validation={valid:true},playback='tree',features={},effectScript){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'delivery-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const jobRoot=path.join(root,'job');
 const config={outputRoot:root,sourceRoots:[root],tools:{megadot:{executable:process.execPath}},limits:{maxStorageBytes:256*1024*1024,maxStageBytes:64*1024*1024}};
 const job=await openJob(jobRoot,{spec:{id:'synthetic',export:{playback},...features}});await job.run([{id:'rig',fingerprint:'fixture',run:async({stagingDir})=>{
  await fs.mkdir(path.join(stagingDir,'godot'));await fs.writeFile(path.join(stagingDir,'rig.json'),JSON.stringify({project:'godot',scene:'godot/character.tscn',validation,frames:[]}));
  if(effectScript){await fs.mkdir(path.dirname(path.join(stagingDir,'godot',effectScript)),{recursive:true});await fs.writeFile(path.join(stagingDir,'godot',effectScript),'extends Node\n');}
  await fs.writeFile(path.join(stagingDir,'godot/character.tscn'),'[gd_scene format=3]\n'+(effectScript?'[ext_resource type="Script" path="res://'+effectScript+'" id="1"]\n':'')+'[node name="Character" type="Node2D"]'+(effectScript?'\nscript = ExtResource("1")':''));await fs.writeFile(path.join(stagingDir,'godot/spec.json'),'development');
 }}]);await job.close();let calls=0;
 const resumeCharacter=async()=>({status:'completed',valid:true,manifest:await inspectJob(jobRoot)});
 const exportGodotPack=async({plan,stagingParent})=>{calls++;assert.equal(plan.files.length,effectScript?2:1);const directory=await fs.mkdtemp(path.join(stagingParent,'pack-')),pack=path.join(directory,'character.pck'),bytes=Buffer.from('GDPC synthetic native callback');await fs.writeFile(pack,bytes);return {pack,hash:hash(bytes),bytes:bytes.length,rootScene:'res://'+plan.rootScene,sizeReport:{archiveBytes:bytes.length},gameAcceptance:false};};
 return {jobRoot,config,resumeCharacter,exportGodotPack,calls:()=>calls};
}
test('delivery exports only verified runtime closure, caches and fingerprints namespace',async t=>{
 const f=await fixture(t),trusted={resumeCharacter:f.resumeCharacter,exportGodotPack:f.exportGodotPack};
 const result=await exportCharacter(f.jobRoot,{config:f.config,namespace:'mods/hero'},trusted);assert.equal(result.gameAcceptance,false);assert.equal(result.rootScene,'res://mods/hero/character.tscn');assert.equal(f.calls(),1);
 const manifest=await inspectJob(f.jobRoot);assert.deepEqual(manifest.stages.export.artifacts.map(a=>path.basename(a.path)).sort(),['character.pck','delivery.json']);
 await exportCharacter(f.jobRoot,{config:f.config,namespace:'mods/hero'},trusted);assert.equal(f.calls(),1);
 await exportCharacter(f.jobRoot,{config:f.config,namespace:'mods/other'},trusted);assert.equal(f.calls(),2);
});

test('optional presentation integration publishes owned source outside PCK and fingerprints request',async t=>{
 const f=await fixture(t),trusted={resumeCharacter:f.resumeCharacter,exportGodotPack:f.exportGodotPack},integration={namespace:'Example.Character',className:'CharacterPresentation',bounds:{x:-16,y:-32,width:32,height:32}},options={config:f.config,namespace:'mods/hero',integration};
 const first=await exportCharacter(f.jobRoot,options,trusted);assert.equal(first.integration.status,'source-emitted');assert.equal(first.integration.requiresGameplayIntegration,true);assert.equal(first.integration.gameAcceptance,false);assert.equal(first.sizeReport.archiveBytes,first.bytes);
 const files=first.integration.files;assert.equal(files.length,2);let bytes=0;for(const file of files){assert.ok(path.isAbsolute(file.path));const source=await fs.readFile(file.path);assert.equal(hash(source),file.hash);assert.equal(source.length,file.bytes);bytes+=source.length;}assert.equal(first.integration.bytes,bytes);
 assert.match(await fs.readFile(files.find(f=>f.path.endsWith('CharacterPresentation.cs')).path,'utf8'),/res:\/\/mods\/hero\/character.tscn/);
 const persisted=JSON.parse(await fs.readFile(path.join(path.dirname(first.pack),'delivery.json'),'utf8'));assert.ok(persisted.integration.files.every(file=>file.path.startsWith('integration/')&&!path.isAbsolute(file.path)));
 await exportCharacter(f.jobRoot,options,trusted);assert.equal(f.calls(),1);
 integration.origin={x:120,y:290};const shifted=await exportCharacter(f.jobRoot,options,trusted);assert.equal(f.calls(),2);assert.match(await fs.readFile(shifted.integration.files[0].path,'utf8'),/root.Position -= new Vector2\(120f,290f\)/);
 const plain=await exportCharacter(f.jobRoot,{config:f.config,namespace:'mods/hero'},trusted);assert.equal(plain.integration,undefined);assert.equal(f.calls(),3);
});

test('presentation kit automatically includes only adapters needed by captured root features',async t=>{
 const integration={namespace:'Example',className:'Presentation',bounds:{x:0,y:0,width:32,height:32}};
 for(const [features,expected,effectScript] of [
  [{},['AttackPresentationBinding.cs','CombatPresentationCaller.cs'],'effect_scene_controller.gd'],
  [{},[],'components/arm/effect_scene_controller.gd'],
  [{projectiles:[{id:'unused'}],animations:[{events:[{type:'sound'}]}]},[]],
  [{animations:[{events:[{type:'projectile',payload:{projectile:'arrow'}}]}]},['AttackPresentationBinding.cs','CombatPresentationCaller.cs']],
  [{components:[{id:'arm'}]},['AssemblyStateBinding.cs','CreatureAssemblyBinding.cs','CreatureAssemblyHooks.cs']],
  [{animations:[{events:[{type:'projectile'}]}],components:[{id:'arm'}]},['AttackPresentationBinding.cs','CombatPresentationCaller.cs','AssemblyStateBinding.cs','CreatureAssemblyBinding.cs','CreatureAssemblyHooks.cs']]
 ]){
  const f=await fixture(t,{valid:true},'tree',features,effectScript),options={config:f.config,namespace:'mods/hero',integration},trusted={resumeCharacter:f.resumeCharacter,exportGodotPack:f.exportGodotPack};
  const result=await exportCharacter(f.jobRoot,options,trusted),files=result.integration.files;
  assert.deepEqual(files.map(file=>path.basename(file.path)).sort(),['Presentation.cs','PipelineVisuals.cs',...expected].sort());
  let bytes=0;
  for(const file of files){const actual=await fs.readFile(file.path);assert.equal(file.hash,hash(actual));assert.equal(file.bytes,actual.length);bytes+=actual.length;if(path.basename(file.path)!=='Presentation.cs')assert.deepEqual(actual,await fs.readFile(path.join(__dirname,'../adapters/sts2',path.basename(file.path))));}
  assert.equal(result.integration.bytes,bytes);
  const generated=await fs.readFile(files.find(file=>path.basename(file.path)==='Presentation.cs').path,'utf8');
  assert.equal(generated.includes('AttachCombatReady'),expected.includes('CombatPresentationCaller.cs'));
  if(expected.includes('CombatPresentationCaller.cs')){const caller=files.find(file=>path.basename(file.path)==='CombatPresentationCaller.cs');await fs.appendFile(caller.path,'tampered caller');const repaired=await exportCharacter(f.jobRoot,options,trusted);assert.equal(f.calls(),2);assert.equal(hash(await fs.readFile(repaired.integration.files.find(file=>path.basename(file.path)==='CombatPresentationCaller.cs').path)),caller.hash);}
  const priorCalls=f.calls();
  const current=await exportCharacter(f.jobRoot,options,trusted);assert.equal(f.calls(),priorCalls);
  if(expected.length){const adapter=current.integration.files.find(file=>path.basename(file.path)===expected[0]);await fs.appendFile(adapter.path,'changed');const repaired=await exportCharacter(f.jobRoot,options,trusted);assert.equal(f.calls(),priorCalls+1);const restored=repaired.integration.files.find(file=>path.basename(file.path)===expected[0]);assert.equal(hash(await fs.readFile(restored.path)),adapter.hash);}
 }
});

test('integration rejects invalid requests before native export and repairs changed source captures',async t=>{
 const f=await fixture(t),trusted={resumeCharacter:f.resumeCharacter,exportGodotPack:f.exportGodotPack},integration={namespace:'Example',className:'Presentation',bounds:{x:0,y:0,width:32,height:32}},options={config:f.config,namespace:'mods/hero',integration};
 for(const request of [null,[],{...integration,extra:true},{...integration,className:'Create'},{...integration,bounds:{x:0,y:0,width:0,height:1}},{...integration,origin:{x:0,y:Infinity}}])await assert.rejects(()=>exportCharacter(f.jobRoot,{...options,integration:request},trusted));assert.equal(f.calls(),0);
 const first=await exportCharacter(f.jobRoot,options,trusted);await fs.appendFile(first.integration.files[0].path,'\nchanged');const second=await exportCharacter(f.jobRoot,options,trusted);assert.equal(f.calls(),2);assert.equal(hash(await fs.readFile(second.integration.files[0].path)),second.integration.files[0].hash);
});

test('integration captures request before resume and accounts source bytes separately in stage quotas',async t=>{
 const f=await fixture(t),integration={namespace:'Example',className:'Presentation',bounds:{x:0,y:0,width:32,height:32},origin:{x:5,y:10}},options={config:f.config,namespace:'mods/hero',integration};
 const result=await exportCharacter(f.jobRoot,options,{resumeCharacter:async()=>{integration.bounds.width=80;integration.origin.x=90;return f.resumeCharacter();},exportGodotPack:f.exportGodotPack});assert.match(await fs.readFile(result.integration.files.find(f=>f.path.endsWith('Presentation.cs')).path,'utf8'),/new Rect2\(-5f,-10f,32f,32f\)/);
 const limited=await fixture(t);limited.config.limits.maxStageBytes=65536+8192+1024*1024;const quotaOptions={config:limited.config,namespace:'mods/hero',maxPackBytes:65536+8192,integration};
 await assert.rejects(()=>exportCharacter(limited.jobRoot,quotaOptions,{resumeCharacter:limited.resumeCharacter,exportGodotPack:limited.exportGodotPack}),{code:'QUOTA_EXCEEDED'});assert.equal(limited.calls(),0);
});

test('presentation kit requires an existing tree playback checkpoint without changing player jobs',async t=>{
 const integration={namespace:'Example',className:'Presentation',bounds:{x:0,y:0,width:32,height:32}};
 for(const playback of ['player',null]){const f=await fixture(t,{valid:true},playback),trusted={resumeCharacter:f.resumeCharacter,exportGodotPack:f.exportGodotPack};await assert.rejects(()=>exportCharacter(f.jobRoot,{config:f.config,namespace:'mods/hero',integration},trusted),error=>error.code==='EXPORT_NOT_READY'&&/tree playback/.test(error.message));assert.equal(f.calls(),0);assert.equal((await inspectJob(f.jobRoot)).context.spec.export.playback,playback);await exportCharacter(f.jobRoot,{config:f.config,namespace:'mods/hero'},trusted);assert.equal(f.calls(),1);}
 const tree=await fixture(t,{valid:true},'tree');assert.equal((await exportCharacter(tree.jobRoot,{config:tree.config,namespace:'mods/hero',integration},{resumeCharacter:tree.resumeCharacter,exportGodotPack:tree.exportGodotPack})).integration.status,'source-emitted');assert.equal(tree.calls(),1);
});

test('presentation source filenames reject device names and fixed adapter collisions before native export',async t=>{
 const f=await fixture(t),trusted={resumeCharacter:f.resumeCharacter,exportGodotPack:f.exportGodotPack},integration={namespace:'Example',className:'Presentation',bounds:{x:0,y:0,width:32,height:32}};
 for(const className of ['pipelinevisuals','PIPELINEVISUALS','attackpresentationbinding','combatpresentationcaller','COMBATPRESENTATIONCALLER','ASSEMBLYSTATEBINDING','creatureassemblybinding','CreatureAssemblyHooks','CON','nul','COM1','lpt9'])await assert.rejects(()=>exportCharacter(f.jobRoot,{config:f.config,namespace:'mods/hero',integration:{...integration,className}},trusted),{code:'INVALID_INPUT'});assert.equal(f.calls(),0);
});
test('delivery admits bounded geometric rig evidence without putting it in the runtime pack',async t=>{
 const f=await fixture(t,{valid:true,nativeGeometry:{evidence:'x'.repeat(1024*1024)}});
 const result=await exportCharacter(f.jobRoot,{config:f.config,namespace:'mods/hero'},{resumeCharacter:f.resumeCharacter,exportGodotPack:f.exportGodotPack});assert.equal(result.gameAcceptance,false);assert.equal(f.calls(),1);
 const oversized=await fixture(t,{valid:true,nativeGeometry:{evidence:'x'.repeat(4*1024*1024)}});
 await assert.rejects(()=>exportCharacter(oversized.jobRoot,{config:oversized.config,namespace:'mods/hero'},{resumeCharacter:oversized.resumeCharacter,exportGodotPack:oversized.exportGodotPack}),{code:'CORRUPT_ARTIFACT'});assert.equal(oversized.calls(),0);
});
test('delivery refuses unapproved, invalid and changed resumed checkpoints before export',async t=>{
 const f=await fixture(t),options={config:f.config,namespace:'mods/hero'};
 for(const status of [{status:'awaiting_artwork_approval',valid:false},{status:'completed',valid:false}])await assert.rejects(exportCharacter(f.jobRoot,options,{resumeCharacter:async()=>status,exportGodotPack:f.exportGodotPack}));
 const old=await f.resumeCharacter();const job=await openJob(f.jobRoot,{settings:{changed:true}});await job.close();
 await assert.rejects(exportCharacter(f.jobRoot,options,{resumeCharacter:async()=>old,exportGodotPack:f.exportGodotPack}),{code:'CONCURRENT_MODIFICATION'});assert.equal(f.calls(),0);
});
test('delivery detects source corruption before native export',async t=>{
 const f=await fixture(t),trusted={resumeCharacter:f.resumeCharacter,exportGodotPack:f.exportGodotPack};
 const manifest=await inspectJob(f.jobRoot),scene=path.join(f.jobRoot,manifest.stages.rig.directory,'godot/character.tscn');await fs.writeFile(scene,'tampered');
 await assert.rejects(exportCharacter(f.jobRoot,{config:f.config,namespace:'mods/hero'},trusted),{code:'CORRUPT_ARTIFACT'});assert.equal(f.calls(),0);
});
test('delivery failure retains native artifacts in accounted provider storage without publishing export',async t=>{
 const f=await fixture(t);let retained;
 await assert.rejects(exportCharacter(f.jobRoot,{config:f.config,namespace:'mods/hero'},{resumeCharacter:f.resumeCharacter,exportGodotPack:async({stagingParent})=>{
  retained=path.join(stagingParent,'retained');await fs.mkdir(retained);await fs.writeFile(path.join(retained,'partial.pck'),'partial');throw Object.assign(Error('native failure'),{code:'NATIVE_FAILURE'});
 }}),{code:'NATIVE_FAILURE'});
 assert.equal(await fs.readFile(path.join(retained,'partial.pck'),'utf8'),'partial');assert.equal((await inspectJob(f.jobRoot)).stages.export,undefined);
 assert.ok(await require('../lib/assets').ownedStorage(f.jobRoot)>=7);
 const lease=await openJob(f.jobRoot);await lease.close();
});
test('delivery checks cancellation and storage reservations without publishing',async t=>{
 const f=await fixture(t),controller=new AbortController();controller.abort();
 await assert.rejects(exportCharacter(f.jobRoot,{config:f.config,namespace:'mods/hero',signal:controller.signal},{resumeCharacter:f.resumeCharacter,exportGodotPack:f.exportGodotPack}),{code:'ABORTED'});
 f.config.limits.maxStorageBytes=1;
 await assert.rejects(exportCharacter(f.jobRoot,{config:f.config,namespace:'mods/hero'},{resumeCharacter:f.resumeCharacter,exportGodotPack:f.exportGodotPack}),{code:'QUOTA_EXCEEDED'});assert.equal(f.calls(),0);
});
test('delivery verifies non-runtime checkpoint receipts and native returned pack hashes',async t=>{
 const f=await fixture(t),manifest=await inspectJob(f.jobRoot),development=path.join(f.jobRoot,manifest.stages.rig.directory,'godot/spec.json');
 await fs.writeFile(development,'corrupt');await assert.rejects(exportCharacter(f.jobRoot,{config:f.config,namespace:'mods/hero'},{resumeCharacter:f.resumeCharacter,exportGodotPack:f.exportGodotPack}),{code:'CORRUPT_ARTIFACT'});
 await fs.writeFile(development,'development');
 await assert.rejects(exportCharacter(f.jobRoot,{config:f.config,namespace:'mods/hero'},{resumeCharacter:f.resumeCharacter,exportGodotPack:async options=>({...await f.exportGodotPack(options),hash:'0'.repeat(64)})}),{code:'CORRUPT_ARTIFACT'});
});
test('delivery source checkpoint changes invalidate cache and native execution holds exclusive job lease',async t=>{
 const f=await fixture(t),trusted={resumeCharacter:f.resumeCharacter,exportGodotPack:async options=>{
  await assert.rejects(openJob(f.jobRoot),{code:'JOB_LOCKED'});return f.exportGodotPack(options);
 }};
 const first=await exportCharacter(f.jobRoot,{config:f.config,namespace:'mods/hero'},trusted);
 const before=await inspectJob(f.jobRoot),old=path.join(f.jobRoot,before.stages.rig.directory),job=await openJob(f.jobRoot);
 await job.run([{id:'rig',fingerprint:'revised rig',run:async({stagingDir})=>{await fs.cp(old,stagingDir,{recursive:true});await fs.appendFile(path.join(stagingDir,'godot/character.tscn'),'\n# revised rig');}}]);await job.close();
 const second=await exportCharacter(f.jobRoot,{config:f.config,namespace:'mods/hero'},trusted);assert.equal(f.calls(),2);assert.notEqual(first.sourceCheckpoint.resultHash,second.sourceCheckpoint.resultHash);
});
test('delivery preserves unresolved effect diagnostics and inactive status in published receipt',async t=>{
 const f=await fixture(t),options={config:f.config,namespace:'mods/hero'},trusted={resumeCharacter:f.resumeCharacter,exportGodotPack:f.exportGodotPack};
 const original=await exportCharacter(f.jobRoot,options,trusted);assert.equal(original.effects,null);assert.equal(original.effectsIntegrationComplete,null);
 const effects={status:'unresolved',activated:false,gameIntegrationComplete:false,diagnostics:[{code:'EFFECT_CAPABILITY_UNAVAILABLE',message:'Trusted effect catalog is unavailable'}]};
 const result=await exportCharacter(f.jobRoot,options,{...trusted,resumeCharacter:async()=>({...await f.resumeCharacter(),effects,effectsIntegrationComplete:false})});
 assert.deepEqual(result.effects,effects);assert.equal(result.effectsIntegrationComplete,false);assert.equal(result.gameAcceptance,false);assert.equal(f.calls(),2);
 const receipt=JSON.parse(await fs.readFile(path.join(path.dirname(result.pack),'delivery.json'),'utf8'));assert.deepEqual(receipt.effects,effects);assert.equal(receipt.effectsIntegrationComplete,false);
});
test('delivery preserves incomplete animation inventory through cache and identity changes',async t=>{
 const f=await fixture(t),summary={status:'unresolved',fingerprint:'a',diagnostics:[{code:'UNRESOLVED'}]},options={config:f.config,namespace:'mods/hero',animationInventory:{planPath:'plan',inventoryPath:'receipt'}};
 const trusted={exportGodotPack:f.exportGodotPack,resumeCharacter:async(root,received)=>{assert.deepEqual(received.animationInventory,options.animationInventory);return {...await f.resumeCharacter(),animationInventory:summary,animationInventoryComplete:false};}};
 const first=await exportCharacter(f.jobRoot,options,trusted);assert.equal(first.animationInventoryComplete,false);assert.deepEqual(first.animationInventory,summary);await exportCharacter(f.jobRoot,options,trusted);assert.equal(f.calls(),1);summary.fingerprint='b';const changed=await exportCharacter(f.jobRoot,options,trusted);assert.equal(f.calls(),2);assert.equal(changed.animationInventory.fingerprint,'b');
});
