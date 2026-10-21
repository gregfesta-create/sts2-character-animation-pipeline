'use strict';
// Opt-in numeric fixture only; its approval cannot authorize user artwork.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {createSpec}=require('../../lib/spec');
const {hashValue,hashFile,resolveContained}=require('../../lib/assets');
const {buildCharacter,resumeCharacter}=require('../../lib/engine');
const {approveArtwork}=require('../../lib/artwork-review');
const {compileGodot}=require('../../backends/godot');
const {png}=require('./component_engine_native');
function fixture(image){
 const spec=createSpec({id:'amplitudeFixture',description:'numeric authored deformation correction fixture',template:'custom'});
 spec.canvas.width=64;spec.canvas.height=64;spec.bones[0].rest.position=[32,32];
 spec.bones.push({id:'moving',parent:'root',rest:{position:[0,0],rotation:0,scale:[1,1]},length:1});
 spec.parts=[{id:'panel',role:'panel',bone:'root',pivot:[0,0],layer:0,image:{path:image},mesh:{vertices:[[0,0],[4,0],[0,4]],uv:[[0,0],[4,0],[0,4]],triangles:[[0,1,2]],weights:[[{bone:'root',weight:1}],[{bone:'moving',weight:1}],[{bone:'root',weight:1}]]}}];
 spec.animations=[{id:'attack',duration:.125,loop:false,events:[],tracks:[{bone:'moving',property:'position',keys:[{time:0,value:[0,0]},{time:.125,value:[-8,0]}]}]}];return spec;
}
async function main(){
 const root=path.resolve(__dirname,'../..'),arg=process.argv.indexOf('--evidence'),relative=arg<0?'evidence/authored-amplitude-native':process.argv[arg+1];
 if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Evidence must remain inside the pipeline workspace.');
 const evidence=await resolveContained(root,relative,{mustExist:false});await fs.mkdir(evidence,{recursive:true});
 const source=path.join(evidence,'source');await fs.mkdir(source); // Fresh fixture bytes and approval required.
 const image=path.join(source,'panel.png');await fs.writeFile(image,png([40,160,210]));
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json'),'utf8'));config.sourceRoots=[source];config.outputRoot=evidence;
 for(const tool of Object.values(config.tools))tool.cwd=path.dirname(tool.executable);
 const spec=fixture(image),original=structuredClone(spec),originalHash=hashValue(spec),imageHash=await hashFile(image);let nativeCalls=0;
 const options={config,jobRoot:path.join(evidence,'job'),render:true,compileGodot:async(candidate,settings)=>{
  nativeCalls++;assert.equal(nativeCalls,1);assert.deepEqual(candidate.animations[0].tracks[0].keys.at(-1).value,[-2,0]);
  return compileGodot(candidate,settings);
 }};
 const pending=await buildCharacter(spec,options);assert.equal(pending.status,'awaiting_artwork_approval');assert.equal(nativeCalls,0);assert.equal(Object.keys(pending.manifest.stages).length,0);
 await fs.writeFile(path.join(evidence,'pending.json'),JSON.stringify(pending,null,2));
 // Approval is exclusively for the exact synthetic PNG created above.
 await approveArtwork(options.jobRoot,{config,reviewId:pending.reviewId});
 const built=await resumeCharacter(options.jobRoot,options);assert.equal(built.valid,true);assert.equal(built.rendered,true);assert.equal(nativeCalls,1);assert.deepEqual(spec,original);assert.equal(hashValue(spec),originalHash);assert.equal(await hashFile(image),imageHash);
 assert.equal(built.repair.attempts,2);assert.equal(built.repair.scope,'authored-local-animation');assert.equal(built.repair.status,'passed');
 const actions=built.repair.history.filter(event=>event.type==='action');assert.equal(actions.length,2);assert.ok(actions.every(event=>event.action.actionId==='dampenClipPose'));assert.notEqual(actions[0].action.parameters.sourceSpecHash,actions[1].action.parameters.sourceSpecHash);assert.notEqual(actions[0].actionHash,actions[1].actionHash);
 const repaired=JSON.parse(await fs.readFile(built.repair.specPath,'utf8'));assert.equal(hashValue(repaired),built.repair.repairedSpecHash);assert.equal(built.authoredGeometry.specHash,built.repair.repairedSpecHash);assert.notEqual(built.repair.originalSpecHash,built.repair.repairedSpecHash);
 assert.deepEqual(repaired.animations[0].tracks[0].keys.at(-1).value,[-2,0]);assert.ok(built.frames.length>0);assert.equal(built.validation.motionRegistration.status,'passed');assert.equal(built.validation.nativeSkinning.status,'passed');
 await fs.rename(source,path.join(evidence,'source-denied'));const resumed=await resumeCharacter(options.jobRoot,options);assert.equal(nativeCalls,1);assert.equal(resumed.valid,true);assert.deepEqual(resumed.repair,built.repair);
 for(const [id,stage] of Object.entries(built.manifest.stages)){assert.equal(resumed.manifest.stages[id].directory,stage.directory);assert.equal(resumed.manifest.stages[id].attempts.length,stage.attempts.length);}
 const frames=await Promise.all(built.frames.map(async file=>({path:file,sha256:await hashFile(file)})));
 const nativeLog={path:path.join(built.project,'native.log'),sha256:await hashFile(path.join(built.project,'native.log'))};
 const report={valid:true,syntheticOnly:true,originalHash,imageHash,reviewId:pending.reviewId,approvalBeforePreparation:true,nativeCalls,sourceFreeCacheReuse:true,frames,nativeLog,sceneHash:await hashFile(built.scene),repair:built.repair,authoredGeometry:built.authoredGeometry,validation:built.validation,project:built.project,manifest:path.join(options.jobRoot,'manifest.json')};
 await fs.writeFile(path.join(evidence,'native-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
if(process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={fixture};
