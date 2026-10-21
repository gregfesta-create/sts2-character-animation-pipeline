'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {planGodotResources}=require('../adapters/godot');
const {emitSts2Integration}=require('../lib/sts2-integration');
const capture=(path,text)=>{const bytes=Buffer.from(text);return {path,size:bytes.length,hash:crypto.createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')};};
const plan=()=>planGodotResources({namespace:'mods/fixture',files:[capture('character.tscn','[gd_scene format=3]\n[node name="Body" type="Node2D"]\n')]});
const options=()=>({plan:plan(),namespace:'Example.Character',className:'CharacterPresentation',bounds:{x:-16,y:-32,width:32,height:32}});
test('emits immutable exact closure presentation factory with bounded hashes and safe literals',()=>{
 const input=options(),result=emitSts2Integration(input);assert.equal(result.rootScene,'res://mods/fixture/character.tscn');assert.equal(result.resources.length,1);assert.ok(Object.isFrozen(result.resources[0]));assert.ok(Object.isFrozen(result));assert.match(result.source,/SHA256/);assert.match(result.source,/CacheMode.IgnoreDeep/);assert.match(result.source,/PipelineVisuals.Create/);assert.match(result.source,/root.Free/);assert.match(result.source,/TryGetReceipt/);assert.equal(result.gameAcceptance,false);assert.equal(result.requiresGameplayIntegration,true);
 input.bounds.width=99;assert.equal(result.bounds.width,32);assert.equal(result.resources[0].hash,input.plan.files[0].hash);
});
test('rejects C# identifiers, unsafe bounds and untrusted altered resource plans',()=>{
 for(const field of ['namespace','className'])for(const value of ['class','x;evil()','a\nb','@valid','a.b.c.d.e.f.g.h.i','Godot','PipelineVisuals','Vector2'])assert.throws(()=>emitSts2Integration({...options(),[field]:value}));
 for(const bounds of [{x:NaN,y:0,width:1,height:1},{x:0,y:0,width:0,height:1},{x:0,y:0,width:1e-100,height:1},{x:1e9,y:0,width:1,height:1}])assert.throws(()=>emitSts2Integration({...options(),bounds}));
 const input=options();input.plan={...input.plan,files:input.plan.files.map(f=>({...f,hash:'0'.repeat(64)}))};assert.throws(()=>emitSts2Integration(input));
 const unreachable=options();unreachable.plan={...unreachable.plan,files:[...unreachable.plan.files,capture('mods/fixture/unreachable.gd','extends Node')]};assert.throws(()=>emitSts2Integration(unreachable));
 assert.throws(()=>emitSts2Integration({...options(),maxBytes:1}));
});

test('escapes non-ASCII resource names and rejects malformed roots or size receipts',()=>{
 const unicode=planGodotResources({namespace:'mods/café',files:[capture('character.tscn','[gd_scene format=3]\n[node name="Body" type="Node2D"]\n')]});
 const result=emitSts2Integration({...options(),plan:unicode});assert.match(result.source,/caf\\u00e9/);assert.ok(!result.source.includes('café'));
 const input=options();assert.throws(()=>emitSts2Integration({...input,plan:{...input.plan,rootScene:'character.tscn'}}));
 assert.throws(()=>emitSts2Integration({...input,plan:{...input.plan,files:input.plan.files.map(f=>({...f,size:f.size+1}))}}));
 for(const namespace of ['', 'A..B','A'.repeat(257)])assert.throws(()=>emitSts2Integration({...options(),namespace}));
 assert.throws(()=>emitSts2Integration({...options(),bounds:{...options().bounds,extra:0}}));
});

test('rejects enclosing class names that collide with generated members while allowing namespace segments',()=>{
 for(const className of ['Create','Resources'])assert.throws(()=>emitSts2Integration({...options(),className}),/class name|member/i);
 for(const namespace of ['Example.Create','Example.Resources'])assert.equal(emitSts2Integration({...options(),namespace}).namespace,namespace);
});

test('authored ground origin translates root and bounds while preserving immutable authored metadata',()=>{
 const input={...options(),origin:{x:120.25,y:290.5}},result=emitSts2Integration(input);
 assert.deepEqual(result.origin,{x:120.25,y:290.5});assert.deepEqual(result.bounds,input.bounds);
 assert.deepEqual(result.appliedBounds,{x:-136.25,y:-322.5,width:32,height:32});
 assert.match(result.source,/root.Position -= new Vector2\(120.25f,290.5f\)/);
 assert.match(result.source,/new Rect2\(-136.25f,-322.5f,32f,32f\)/);
 input.origin.x=8;assert.equal(result.origin.x,120.25);assert.ok(Object.isFrozen(result.origin));assert.ok(Object.isFrozen(result.appliedBounds));
 const plain=emitSts2Integration(options());assert.deepEqual(plain.origin,{x:0,y:0});assert.deepEqual(plain.appliedBounds,plain.bounds);
 assert.notEqual(result.source,plain.source);
});
test('origin accepts only exact bounded finite coordinates',()=>{
 for(const origin of [null,[],{}, {x:0}, {x:0,y:0,z:1},{x:NaN,y:0},{x:0,y:Infinity},{x:1000001,y:0},{x:'0',y:0}])assert.throws(()=>emitSts2Integration({...options(),origin}),{code:'INVALID_STS2_INTEGRATION'});
});

test('source kit admits exact native-proven compiled audio and rejects serialized authority or original containers',async()=>{
 const {inspectNativeAudioResources}=require('../lib/native-audio-resources');
 const file=capture('sound.res','RSRC numeric audio');
 const resource={path:file.path,hash:file.hash,size:file.size,class:'AudioStreamWAV',format:'wav',duration:1,sampleRate:48000,channels:1,frames:48000,granuleFrames:null,dependencies:[],script:false};
 const inspected=await inspectNativeAudioResources({files:[file],audio:[{id:'cue',format:'wav',duration:1,resource:'res://sound.res'}],namespaces:['mods/fixture'],stagingParent:require('node:path').resolve('.tmp/sourcekit-audio'),tool:{executable:process.execPath}},{stageRuntimeManifest:async()=>({directory:'fixture-stage'}),runLockedTool:async()=>({exitCode:0,stdout:'AUDIO_RESOURCES '+JSON.stringify({version:1,resources:[resource]}),stderr:''})});
 const files=[capture('character.tscn','[gd_scene format=3]\n[ext_resource type="AudioStream" path="res://sound.res" id="1"]\n[node name="Body" type="Node2D"]\n'),file];
 const trusted={audioAuthority:inspected.authority},audioPlan=planGodotResources({namespace:'mods/fixture',files},trusted);
 const result=emitSts2Integration({...options(),plan:audioPlan},trusted),binary=result.resources.find(r=>r.path.endsWith('/sound.res'));
 assert.deepEqual(binary,{path:'res://mods/fixture/sound.res',size:file.size,hash:file.hash});
 for(const value of [binary.path,binary.hash,String(binary.size)])assert.ok(result.source.includes(value));
 assert.equal(result.gameAcceptance,false);
 for(const proof of [undefined,{}, {audioAuthority:JSON.parse(JSON.stringify(inspected)).authority},{audioAuthority:{}}])assert.throws(()=>emitSts2Integration({...options(),plan:audioPlan},proof));
 const changed={...audioPlan,files:audioPlan.files.map(f=>f.path.endsWith('.res')?{...f,hash:'0'.repeat(64)}:f)};assert.throws(()=>emitSts2Integration({...options(),plan:changed},trusted));
 for(const extension of ['wav','ogg']){
  const raw=planGodotResources({namespace:'mods/fixture',files:[capture('character.tscn','[gd_scene format=3]\n[ext_resource type="AudioStream" path="res://sound.'+extension+'" id="1"]\n[node name="Body" type="Node2D"]\n'),capture('sound.'+extension,'raw original')]});
  assert.throws(()=>emitSts2Integration({...options(),plan:raw},trusted),{code:'INVALID_PACK_EXPORT'});
 }
});

test('combat-ready helper is an exact optional typed delegate surface',()=>{
 const enabled=emitSts2Integration({...options(),combatCaller:true});
 assert.match(enabled.source,/public static global::CharacterPipeline.Sts2.CombatPresentationCaller AttachCombatReady\(/);
 assert.match(enabled.source,/global::MegaCrit.Sts2.Core.Entities.Creatures.Creature owner/);
 assert.match(enabled.source,/global::System.Collections.Generic.IReadOnlyCollection<string> bindingIds/);
 assert.match(enabled.source,/global::System.Func<global::MegaCrit.Sts2.Core.Entities.Creatures.Creature,global::System.Collections.Generic.IReadOnlyDictionary<string,global::CharacterPipeline.Sts2.AttackBindingFact>> readFacts/);
 assert.match(enabled.source,/CombatPresentationCaller.AttachReady\(receipt,owner,generation,contractVersion,bindingIds,readFacts\)/);
 for(const combatCaller of [undefined,false])assert.doesNotMatch(emitSts2Integration({...options(),combatCaller}).source,/AttachCombatReady|CombatPresentationCaller/);
 for(const combatCaller of [null,0,1,'true',{},[]])assert.throws(()=>emitSts2Integration({...options(),combatCaller}),{code:'INVALID_STS2_INTEGRATION'});
 assert.throws(()=>emitSts2Integration({...options(),className:'AttachCombatReady',combatCaller:true}),/class name|member/i);
 const plain=emitSts2Integration(options());assert.equal(enabled.source.slice(0,enabled.source.indexOf('    // Attach only')),plain.source.slice(0,-2));
 for(const className of ['Creature','CombatPresentationCaller','AttackBindingFact','Func','IReadOnlyDictionary','IReadOnlyCollection'])assert.match(emitSts2Integration({...options(),className,combatCaller:true}).source,/global::CharacterPipeline.Sts2.CombatPresentationCaller.AttachReady/);
});

test('action-aware helper forwards separate declared action facts without changing the legacy helper',()=>{
 const enabled=emitSts2Integration({...options(),combatCaller:true});
 assert.match(enabled.source,/public static global::CharacterPipeline.Sts2.CombatPresentationCaller AttachCombatWithActionFactsReady\(/);
 assert.match(enabled.source,/global::System.Collections.Generic.IReadOnlyCollection<string> actionBindingIds/);
 assert.match(enabled.source,/global::System.Func<global::MegaCrit.Sts2.Core.Entities.Creatures.Creature,global::CharacterPipeline.Sts2.AttackPresentationRequest,global::System.Collections.Generic.IReadOnlyDictionary<string,global::CharacterPipeline.Sts2.AttackBindingFact>> readActionFacts/);
 assert.match(enabled.source,/CombatPresentationCaller.AttachReadyWithActionFacts\(receipt,owner,generation,contractVersion,bindingIds,readFacts,actionBindingIds,readActionFacts\)/);
 assert.match(enabled.source,/CombatPresentationCaller.AttachReady\(receipt,owner,generation,contractVersion,bindingIds,readFacts\)/);
 assert.doesNotMatch(emitSts2Integration(options()).source,/AttachCombatWithActionFactsReady/);
 assert.throws(()=>emitSts2Integration({...options(),className:'AttachCombatWithActionFactsReady',combatCaller:true}),/class name|member/i);
 for(const className of ['AttackPresentationRequest','Creature','Func'])assert.match(emitSts2Integration({...options(),className,combatCaller:true}).source,/global::CharacterPipeline.Sts2.AttackPresentationRequest/);
});
