'use strict';
// Opt-in numeric/silent PCM fixture. No creative sounds, artwork or game launch.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {fixture,png}=require('./component_engine_native');
const {buildCharacter,resumeCharacter}=require('../../lib/engine');
const {approveArtwork}=require('../../lib/artwork-review');
const {runAudioOperation}=require('../../lib/audio');
const {hashValue,hashFile,resolveContained}=require('../../lib/assets');
const {inspectGodotResourceReachability}=require('../../adapters/godot');
async function main(){
 const i=process.argv.indexOf('--evidence'),out=path.resolve(i<0?path.join(__dirname,'../../evidence/assembly-audio-native'):process.argv[i+1]);await fs.mkdir(out,{recursive:true});const source=path.join(out,'source');await fs.mkdir(source);
 const config=JSON.parse(await fs.readFile(path.join(__dirname,'../../config/local.tools.json')));config.sourceRoots=[source];config.outputRoot=out;for(const tool of Object.values(config.tools))tool.cwd=path.dirname(tool.executable);
 const wav=Buffer.alloc(44+48000*4);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(2,22);wav.writeUInt32LE(48000,24);wav.writeUInt32LE(192000,28);wav.writeUInt16LE(4,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
 const wavPath=path.join(source,'silence.wav');await fs.writeFile(wavPath,wav);const encoded=await runAudioOperation('encode-vorbis',wavPath,{config,stagingDir:source});
 const specs={};for(const [id,color]of [['body',[80,80,80]],['panel',[220,40,40]],['spare',[40,40,220]]]){
  const image=path.join(source,id+'.png');await fs.writeFile(image,png(color));const s=fixture(id,image);s.sounds=[{id:'sameCue',path:id==='body'?wavPath:encoded.path}];
  s.animations[0].events=[{id:'idleSound',type:'sound',time:0,payload:{sound:'sameCue'}}];
  s.animations.push({id:'activate',duration:.3,loop:false,events:[{id:'zeroSound',type:'sound',time:0,payload:{sound:'sameCue'}},{id:'midSound',type:'sound',time:.1,payload:{sound:'sameCue'}}],tracks:[{bone:'root',property:'rotation',keys:[{time:0,value:0},{time:.3,value:.3}]}]});specs[id]=s;
  if(id!=='body')await fs.writeFile(path.join(source,id+'.json'),JSON.stringify(s));
 }
 const spec=specs.body,frame={position:[0,0],rotation:0,scale:[1,1]},inheritance={position:true,rotation:true,scale:true},styleHash=hashValue(spec.style);
 spec.sockets=[{id:'mount',bone:'root',types:['panel','spare'],capacity:1,inheritance,layer:1,envelope:[64,64],transform:frame}];spec.components=[{id:'first',socket:'mount',type:'panel',spec:'panel.json'}];
 spec.assembly={version:1,styleHash,eventNames:['sound'],descriptors:['panel','spare'].map(type=>({version:1,type,spec:type+'.json',mount:{...frame,position:[32,32]},dimensions:[64,64],inheritance,layer:1,styleHash,eventNames:['sound'],transitions:Object.fromEntries(['install','replace','remove'].map(kind=>[kind,{duration:.3,phases:[{id:'begin',time:0},{id:'moving',time:.1,...(kind==='remove'?{}:{clip:'activate'})}]}]))}))};
 const jobRoot=path.join(out,'job'),pending=await buildCharacter(JSON.parse(JSON.stringify(spec)),{jobRoot,config});assert.equal(pending.status,'awaiting_artwork_approval');assert.equal(Object.keys(pending.manifest.stages).length,0);
 await approveArtwork(jobRoot,{config,reviewId:pending.reviewId});const built=await resumeCharacter(jobRoot,{config}),preview=built.assemblyPreview;assert.equal(preview.status,'completed');assert.equal(preview.native.allOwnersSilent,true);assert.equal(preview.native.unexpectedMarkerCount,0);assert(preview.native.ownersAdvanced>=3);assert(preview.native.skeletonPreserved&&preview.native.finalEmpty&&preview.native.startedUnbound);assert.deepEqual(new Set(preview.audioInspection.resources.map(r=>r.format)),new Set(['wav','ogg-vorbis']));assert.equal(preview.audioInspection.resources.length,3);
 const sceneBefore=await fs.readFile(built.scene),resourcesBefore=[];for(const file of preview.audioInspection.resources){const actual=path.join(built.project,file.path);resourcesBefore.push({path:file.path,hash:await hashFile(actual)});assert.equal(resourcesBefore.at(-1).hash,file.hash);}
 const pixelHashes=new Set(preview.frames.map(f=>f.sha256));assert(pixelHashes.size>=3);assert((await fs.stat(preview.motionPreview.path)).size>0);assert((await fs.stat(preview.contactSheet.path)).size>0);
 await fs.rename(source,path.join(out,'source-denied'));const resumed=await resumeCharacter(jobRoot,{config});assert.deepEqual(resumed.assemblyPreview,preview);assert.deepEqual(await fs.readFile(resumed.scene),sceneBefore);for(const f of resourcesBefore)assert.equal(await hashFile(path.join(resumed.project,f.path)),f.hash);for(const [id,stage]of Object.entries(built.manifest.stages)){assert.equal(resumed.manifest.stages[id].directory,stage.directory);assert.equal(resumed.manifest.stages[id].attempts.length,stage.attempts.length);}
 // Recapture exact compiler-checkpoint bytes and add real unreachable preview
 // artifacts to the candidate inventory. Reachability itself grants no authority.
 const rigCheckpoint=built.manifest.stages.rig,rigRoot=await resolveContained(jobRoot,rigCheckpoint.directory),projectPrefix=path.relative(rigRoot,built.project).replaceAll('\\','/')+'/',files=[];
 for(const receipt of rigCheckpoint.artifacts.filter(a=>a.path.startsWith(projectPrefix)&&/\.(tscn|tres|gd|res|png|wav|ogg)$/.test(a.path))){const file=await resolveContained(rigRoot,receipt.path),bytes=await fs.readFile(file);assert.equal(bytes.length,receipt.size);assert.equal(await hashFile(file),receipt.hash);files.push({path:receipt.path.slice(projectPrefix.length),hash:receipt.hash,base64:bytes.toString('base64')});}
 for(const [index,file]of [preview.frames[0].path,preview.motionPreview.path,preview.contactSheet.path].entries()){const bytes=await fs.readFile(file);files.push({path:'previews/actual-'+index+'.png',hash:await hashFile(file),base64:bytes.toString('base64')});}
 const reached=inspectGodotResourceReachability({rootScene:path.relative(built.project,built.scene).replaceAll('\\','/'),files});assert(reached.files.every(f=>!f.path.startsWith('previews/')&&!f.path.endsWith('.wav')&&!f.path.endsWith('.ogg')&&!f.path.includes('inspect_audio_resources')));assert.equal(reached.binaryResources.length,3);
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify({passed:true,sourceUnavailable:true,resourcesUnchanged:true,silentOwners:true,unexpectedMarkerCount:0,cachedWithoutInspection:true,distinctFrames:pixelHashes.size,audio:preview.audioInspection.resources,preview,runtimeAudioCount:3},null,2));console.log(JSON.stringify({passed:true,frames:preview.frames.length,distinctFrames:pixelHashes.size,audio:3,silentOwners:true,cachedWithoutInspection:true}));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(e=>{console.error(e,e.process);process.exitCode=1;});
module.exports={main};
