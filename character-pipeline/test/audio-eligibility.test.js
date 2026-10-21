'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {collectAudioEligibility}=require('../lib/audio-eligibility');
const bytes=Buffer.from('RSRC fixture'),file=p=>({path:p,size:bytes.length,hash:crypto.createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')});
const metadata=(prefix='',audio=[{id:'shot',format:'wav',duration:.1,resource:'res://sound.res'}])=>({id:prefix.split('/').at(-1)||'root',prefix,validation:{valid:true,audio}});
test('verified eligibility relocates recursive definitions and repeated sound IDs exactly',()=>{
 const result=collectAudioEligibility({metadata:[metadata(),metadata('components/arm'),metadata('components/arm/components/hand')],files:['sound.res','components/arm/sound.res','components/arm/components/hand/sound.res'].map(file)});
 assert.equal(result.audio.length,3);assert.equal(new Set(result.audio.map(a=>a.id)).size,3);assert.deepEqual(result.audio.map(a=>a.resource),['res://sound.res','res://components/arm/sound.res','res://components/arm/components/hand/sound.res']);assert.ok(Object.isFrozen(result.audio[0]));
});
test('eligibility selects reached resources only and allows empty audio without authority',()=>{
 assert.deepEqual(collectAudioEligibility({metadata:[metadata()],files:[]}),{version:1,audio:[],files:[]});
 assert.equal(collectAudioEligibility({metadata:[{id:'root',prefix:'',validation:{valid:true}}],files:[]}).audio.length,0);
});
test('eligibility rejects undeclared resources, malformed declarations and conflicting provenance',()=>{
 for(const input of [
 {metadata:[],files:[file('sound.res')]},
 {metadata:[metadata(),metadata()],files:[]},
 {metadata:[metadata('../bad')],files:[]},
 {metadata:[{...metadata(),validation:{valid:false,audio:[]}}],files:[]},
 {metadata:[metadata('',[{id:'shot',format:'wav',duration:0,resource:'res://sound.res'}])],files:[]},
 {metadata:[metadata('',[{id:'shot',format:'wav',duration:.1,resource:'res://sound.res',trust:true}])],files:[]},
 {metadata:[metadata()],files:[{...file('sound.res'),hash:'0'.repeat(64)}]},
 {metadata:[metadata()],files:[file('sound.res'),file('sound.res')]},
 {metadata:[metadata('',[{id:'shot',format:'wav',duration:.1,resource:'res://sound.res'},{id:'other',format:'ogg-vorbis',duration:.1,resource:'res://sound.res'}])],files:[]}
 ])assert.throws(()=>collectAudioEligibility(input),{code:'INVALID_AUDIO_RESOURCE'});
});

