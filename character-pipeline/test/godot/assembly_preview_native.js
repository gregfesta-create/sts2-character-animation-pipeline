'use strict';
// Explicit opt-in numeric native proof, never creative artwork or game launch.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture,png}=require('./component_engine_native');
const {inventory}=require('./component_compile_native');
const {compileGodot}=require('../../backends/godot');
const {createAssemblyPreview}=require('../../lib/assembly-preview');
const {hashValue}=require('../../lib/assets');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(){
 const i=process.argv.indexOf('--evidence'),out=path.resolve(i<0?path.join(__dirname,'../../evidence/assembly-preview-native'):process.argv[i+1]);await fs.mkdir(out,{recursive:true});const source=path.join(out,'source');await fs.mkdir(source);const config=JSON.parse(await fs.readFile(path.join(__dirname,'../../config/local.tools.json')));
 const specs={},componentProjects={},componentRegistry=[];
 for(const [id,color]of [['body',[80,80,80]],['red',[230,30,30]],['blue',[30,30,230]]]){
  const image=path.join(source,id+'.png');await fs.writeFile(image,png(color));const spec=fixture(id,image);spec.export.playback=id==='red'?'player':'tree';spec.parts[0].image={path:image,prepared:true,width:16,height:16,alphaBounds:[0,0,16,16],cropTranslation:[0,0],pivot:[8,8],pixelsPerUnit:1};spec.animations.push({id:'activate',duration:.4,loop:false,events:[{id:'zeroCue',name:'zeroMarker',time:0}],tracks:[{bone:'root',property:'rotation',keys:[{time:0,value:0},{time:.4,value:.6}]}]});specs[id]=spec;
  if(id!=='body'){const stage=path.join(out,'compiled',id),compiled=await compileGodot(spec,{config,stagingDir:stage});componentProjects[id]={project:compiled.project,scene:compiled.scene,spec,checkpoint:{root:stage,artifacts:await inventory(stage)}};componentRegistry.push({id,types:[id]});}
 }
 const spec=specs.body,inheritance={position:true,rotation:true,scale:true},frame={position:[0,0],rotation:0,scale:[1,1]},styleHash=hashValue(spec.style);
 spec.sockets=[{id:'sharedSocket',bone:'root',types:['red','blue'],capacity:2,inheritance,layer:1,envelope:[64,64],transform:{...frame,position:[16,0]}}];spec.components=[{id:'first',socket:'sharedSocket',type:'red',spec:'red.json'}];
 spec.assembly={version:1,styleHash,eventNames:['zeroMarker'],descriptors:['red','blue'].map(type=>({version:1,type,spec:type+'.json',mount:{...frame,position:[32,32]},dimensions:[64,64],styleHash,eventNames:['zeroMarker'],layer:1,inheritance,transitions:Object.fromEntries(['install','replace','remove'].map(kind=>[kind,{duration:.3,phases:[{id:'begin',time:0},{id:'moving',time:.1,...(kind==='remove'?{}:{clip:'activate'})}]}]))}))};
 const rootStage=path.join(out,'compiled','body'),compiled=await compileGodot(spec,{config,stagingDir:rootStage,componentProjects,componentRegistry,componentDescriptors:spec.assembly.descriptors,assemblyContract:{styleHash,eventNames:['zeroMarker']}});
 const original=await fs.readFile(compiled.scene),before=await inventory(compiled.project);await fs.rename(source,path.join(out,'source-denied'));const report=await createAssemblyPreview(spec,{compiledSpecHash:hashValue(spec),sourceRoot:rootStage,project:compiled.project,scene:compiled.scene,stagingDir:path.join(out,'preview'),config});
 assert.equal(report.status,'completed');assert.equal(report.visualQuality,'unverified');assert(report.native.startedUnbound&&report.native.allOwnersSilent&&report.native.finalEmpty&&report.native.skeletonPreserved);assert.equal(report.native.unexpectedMarkerCount,0);assert(report.native.ownersAdvanced>=3);assert.deepEqual(await fs.readFile(compiled.scene),original);assert.deepEqual(await inventory(compiled.project),before);
 for(const op of ['install','replace','remove'])assert(report.native.phaseObservations.some(o=>o.operation===op));
 assert(new Set(report.frames.map(f=>f.sha256)).size>=3,'Actual numeric animation pixels must vary');assert(report.frames[0].components.length===0&&report.frames.at(-1).components.length===0);
 for(const artifact of [report.contactSheet.path,report.motionPreview.path])assert((await fs.stat(path.join(out,'preview',artifact))).size>0);
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify({passed:true,originalSceneHash:digest(original),sourceUnavailable:true,resourcesUnchanged:true,report},null,2));console.log(JSON.stringify({passed:true,frames:report.frames.length,distinctFrames:new Set(report.frames.map(f=>f.sha256)).size,owners:report.native.ownersAdvanced,phases:report.native.phaseObservationCount,motionPreview:report.motionPreview.path,contactSheet:report.contactSheet.path}));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={main};
