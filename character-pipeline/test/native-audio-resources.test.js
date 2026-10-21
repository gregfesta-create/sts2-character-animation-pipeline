'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {prepareAudioInspection,validateAudioInspection}=require('../lib/native-audio-resources');
const bytes=Buffer.from('RSRC synthetic');
const file={path:'audio.res',size:bytes.length,hash:crypto.createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')};
const audio=[{id:'cue',format:'wav',duration:1,resource:'res://audio.res'}];
test('native inspection grants exact in-memory authority, never serialized receipts',async()=>{
 const {inspectNativeAudioResources,proveAudioResource}=require('../lib/native-audio-resources');
 const {planGodotResources}=require('../adapters/godot'),{validatePackPlan}=require('../lib/export');
 const r={path:file.path,hash:file.hash,size:file.size,class:'AudioStreamWAV',format:'wav',duration:1,sampleRate:48000,channels:2,frames:48000,granuleFrames:null,dependencies:[],script:false};
 const result=await inspectNativeAudioResources({files:[file],audio,namespaces:['mods/hero'],stagingParent:'C:/fixture',tool:{executable:process.execPath}},{stageRuntimeManifest:async()=>({directory:'C:/fixture/staged'}),runLockedTool:async()=>({exitCode:0,stdout:'AUDIO_RESOURCES '+JSON.stringify({version:1,resources:[r]}),stderr:''})});
 assert.equal(proveAudioResource(result.authority,file).category,'audio');
 assert.equal(proveAudioResource(result.authority,{...file,path:'mods/hero/audio.res'}).category,'audio');
 for(const change of [{path:'mods/other/audio.res'},{path:'prefix/mods/hero/audio.res'},{hash:'0'.repeat(64)},{size:1}])assert.equal(proveAudioResource(result.authority,{...file,...change}),null);
 assert.equal(proveAudioResource(JSON.parse(JSON.stringify(result)).authority,file),null);
 const scene=Buffer.from('[gd_scene format=3]\n[ext_resource type="AudioStream" path="res://audio.res" id="1"]\n[node name="Root" type="Node"]');
 const files=[{path:'character.tscn',hash:crypto.createHash('sha256').update(scene).digest('hex'),base64:scene.toString('base64')},file];
 const trusted={audioAuthority:result.authority},plan=planGodotResources({namespace:'mods/hero',files},trusted);
 assert.equal(plan.files.find(f=>f.path.endsWith('.res')).category,'audio');
 assert.equal(validatePackPlan(plan,{},trusted).files.find(f=>f.path.endsWith('.res')).category,'audio');
 assert.throws(()=>validatePackPlan(JSON.parse(JSON.stringify(plan))));
 assert.throws(()=>planGodotResources({namespace:'mods/other',files},trusted));
 assert.throws(()=>planGodotResources({namespace:'mods/hero',files},{audioAuthority:result.resources}));
});
test('requires exact compiler audio eligibility and immutable bounded captures',()=>{
 const request=prepareAudioInspection({files:[file],audio});assert.equal(request.files[0].hash,file.hash);
 for(const change of [{audio:[]},{audio:[{...audio[0],resource:'res://../audio.res'}]},{files:[{...file,hash:'0'.repeat(64)}]},{files:[{...file,size:1}]},{audio:[{...audio[0],format:'mp3'}]}])assert.throws(()=>prepareAudioInspection({files:[file],audio,...change}));
});
test('rejects forged, extra, nonleaf and inconsistent native responses',()=>{
 const request=prepareAudioInspection({files:[file],audio});
 const record={path:file.path,hash:file.hash,size:file.size,class:'AudioStreamWAV',format:'wav',duration:1,sampleRate:48000,channels:2,frames:48000,granuleFrames:null,dependencies:[],script:false};
 assert.equal(validateAudioInspection(request,{version:1,resources:[record]}).resources[0].frames,48000);
 for(const patch of [{hash:'0'.repeat(64)},{class:'Resource'},{dependencies:['res://other']},{script:true},{frames:1},{channels:3},{extra:true}])assert.throws(()=>validateAudioInspection(request,{version:1,resources:[{...record,...patch}]}));
 assert.throws(()=>validateAudioInspection(request,{version:1,resources:[record,record]}));
});
test('shared compiler sound aliases inspect one immutable resource',()=>{
 const request=prepareAudioInspection({files:[file],audio:[...audio,{...audio[0],id:'second'}]});assert.equal(request.expected.length,1);
 assert.throws(()=>prepareAudioInspection({files:[file],audio:[...audio,{...audio[0],id:'second',duration:2}]}));
});
test('enforces path, byte, receipt and decoded-audio quotas before authority could be created',()=>{
 for(const input of [null,{}, {files:[],audio}, {files:[file],audio,maxBytes:1}, {files:[file,file],audio}, {files:[{...file,path:'CON.res'}],audio}, {files:[{...file,base64:file.base64+'!'}],audio}, {files:[file],audio:[{...audio[0],duration:31}]}, {files:[file],audio:[{...audio[0],id:'bad id'}]}, {files:[file],audio:[{...audio[0],implemented:true}]}])assert.throws(()=>prepareAudioInspection(input));
 const request=prepareAudioInspection({files:[file],audio:[{...audio[0],format:'ogg-vorbis'}]});
 const r={path:file.path,hash:file.hash,size:file.size,class:'AudioStreamOggVorbis',format:'ogg-vorbis',duration:1,sampleRate:48000,channels:1,frames:null,granuleFrames:48000,dependencies:[],script:false};
 const response={version:1,resources:[r]},validated=validateAudioInspection(request,response);r.dependencies.push('changed');assert.deepEqual(validated.resources[0].dependencies,[]);
 for(const patch of [{sampleRate:7999},{sampleRate:96001},{duration:NaN},{duration:31},{granuleFrames:48001.5},{frames:48000},{granuleFrames:4800}])assert.throws(()=>validateAudioInspection(request,{version:1,resources:[{...validated.resources[0],...patch}]}));
 for(const response of [{version:2,resources:[]},{version:1,resources:[],implemented:true},{version:1,resources:[]}])assert.throws(()=>validateAudioInspection(request,response));
});

test('reachability preflight selects binary leaves without authorizing a runtime plan',()=>{
 const {inspectGodotResourceReachability,planGodotResources}=require('../adapters/godot');
 const source=Buffer.from('[gd_scene format=3]\n[ext_resource type="AudioStream" path="res://audio.res" id="1"]\n[node name="Root" type="Node"]');
 const scene={path:'character.tscn',hash:crypto.createHash('sha256').update(source).digest('hex'),base64:source.toString('base64')};
 const result=inspectGodotResourceReachability({files:[scene,file,{...file,path:'unused.res'}]});
 assert.equal(result.kind,'godot-resource-reachability');assert.deepEqual(result.binaryResources,[file]);assert.equal(result.files.length,2);assert.ok(Object.isFrozen(result.files));assert.equal(result.nativeExportStatus,undefined);
 assert.throws(()=>planGodotResources({namespace:'hero',files:result.files},{audioAuthority:result}));
 assert.throws(()=>inspectGodotResourceReachability({files:[scene,file],dynamicReferences:{'audio.res':['character.tscn']}}));
});
test('inspection cancellation avoids staging and propagates signal and retained helper directories',async()=>{
 const {inspectNativeAudioResources}=require('../lib/native-audio-resources');
 const controller=new AbortController();controller.abort();let staged=0;
 const options={files:[file],audio,stagingParent:require('node:path').resolve('.tmp/audio'),tool:{executable:process.execPath},signal:controller.signal};
 await assert.rejects(inspectNativeAudioResources(options,{stageRuntimeManifest:async()=>{staged++;}}),{code:'ABORTED'});assert.equal(staged,0);
 const live=new AbortController(),record={path:file.path,hash:file.hash,size:file.size,class:'AudioStreamWAV',format:'wav',duration:1,sampleRate:48000,channels:2,frames:48000,granuleFrames:null,dependencies:[],script:false};
 const result=await inspectNativeAudioResources({...options,signal:live.signal},{stageRuntimeManifest:async()=>({directory:'fixture-stage'}),runLockedTool:async input=>{assert.equal(input.signal,live.signal);assert.equal(input.requestRoot,options.stagingParent);return {exitCode:0,stdout:'AUDIO_RESOURCES '+JSON.stringify({version:1,resources:[record]}),stderr:'',retainedDirectories:['helper-stage']};}});
 assert.deepEqual(result.retainedDirectories,['fixture-stage','helper-stage']);
 await assert.rejects(inspectNativeAudioResources({...options,signal:live.signal},{stageRuntimeManifest:async()=>({directory:'fixture-stage'}),runLockedTool:async()=>{throw Object.assign(new Error('failure'),{retainedDirectories:['failed-helper']});}}),error=>error.retainedDirectories.includes('failed-helper'));
});

test('rejects unknown capture fields and malformed cancellation before native work',async()=>{
 const {inspectNativeAudioResources}=require('../lib/native-audio-resources');
 assert.throws(()=>prepareAudioInspection({files:[{...file,trusted:true}],audio}));
 await assert.rejects(inspectNativeAudioResources({files:[file],audio,signal:{aborted:false}}));
 const {runLockedTool,exportGodotPack}=require('../lib/export'),controller=new AbortController();controller.abort();
 await assert.rejects(runLockedTool({signal:controller.signal}),{code:'ABORTED'});
 await assert.rejects(exportGodotPack({signal:controller.signal}),{code:'ABORTED'});
});

test('cancellation during inspection waits for trusted cleanup and prevents authority publication',async()=>{
 const {inspectNativeAudioResources}=require('../lib/native-audio-resources'),controller=new AbortController();let cleaned=false;
 await assert.rejects(inspectNativeAudioResources({files:[file],audio,signal:controller.signal,stagingParent:require('node:path').resolve('.tmp/audio'),tool:{executable:process.execPath}},{stageRuntimeManifest:async()=>({directory:'capture-stage'}),runLockedTool:async()=>{controller.abort();await Promise.resolve();cleaned=true;return {retainedDirectories:['cleaned-helper'],exitCode:0,stdout:'',stderr:''};}}),error=>error.code==='ABORTED'&&cleaned&&error.retainedDirectories.includes('cleaned-helper'));
 await assert.rejects(inspectNativeAudioResources({files:[file],audio,stagingParent:require('node:path').resolve('.tmp/audio'),tool:{executable:process.execPath}},{stageRuntimeManifest:async()=>({directory:'capture-stage'}),runLockedTool:async()=>({retainedDirectories:['helper'],error:{code:'ABORTED'},exitCode:null,stdout:'',stderr:''})}),{code:'ABORTED'});
});
