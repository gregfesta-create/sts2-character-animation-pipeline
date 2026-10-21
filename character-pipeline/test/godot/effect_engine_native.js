'use strict';
// Opt-in only. Approves exact generated synthetic fixtures, never user artwork.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {hashFile,hashValue,resolveContained}=require('../../lib/assets');
const {inspectMechanics}=require('../../lib/mechanics');
const {buildCharacter,resumeCharacter}=require('../../lib/engine');
const {approveArtwork}=require('../../lib/artwork-review');
const {createSpec}=require('../../lib/spec');
function png(rgb){
 const chunk=(type,data)=>{const b=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of b){crc^=byte;for(let i=0;i<8;i++)crc=crc>>>1^(crc&1?0xedb88320:0);}const out=Buffer.alloc(b.length+8);out.writeUInt32BE(data.length);b.copy(out,4);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;};
 const header=Buffer.alloc(13);header.writeUInt32BE(16);header.writeUInt32BE(16,4);header[8]=8;header[9]=6;
 const rows=Buffer.alloc(16*65);for(let y=0;y<16;y++)for(let x=0;x<16;x++){const i=y*65+1+x*4;rows[i]=rgb[0];rows[i+1]=rgb[1];rows[i+2]=rgb[2];rows[i+3]=255;}
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',require('node:zlib').deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
function fixture(id,image){
 const s=createSpec({id,description:'synthetic native engine assembly fixture'});s.canvas.width=64;s.canvas.height=64;s.export.playback='tree';
 s.bones[0].rest.position=[32,32];
 s.parts=[{id:'panel',role:'panel',bone:'root',pivot:[8,8],layer:0,image:{path:image},mesh:{vertices:[[0,0],[16,0],[16,16],[0,16]],uv:[[0,0],[16,0],[16,16],[0,16]],triangles:[[0,1,2],[0,2,3]],weights:Array.from({length:4},()=>[{bone:'root',weight:1}])}}];
 s.animations=[{id:'idle',duration:1,loop:true,events:[],tracks:[{bone:'root',property:'rotation',keys:[{time:0,value:0},{time:0.5,value:0.2},{time:1,value:0}]}]}];return s;
}

async function main(){
 const root=path.resolve(__dirname,'../..'),arg=process.argv.indexOf('--evidence'),relative=arg<0?'evidence/e3-effect-engine-native':process.argv[arg+1];
 if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Evidence must remain inside the pipeline workspace.');
 const evidence=await resolveContained(root,relative,{mustExist:false});await fs.mkdir(evidence,{recursive:true});
 const source=path.join(evidence,'source'),mechanics=path.join(evidence,'mechanics');await fs.mkdir(source);await fs.mkdir(mechanics); // Fresh run only: never reuse approval.
 const image=path.join(source,'synthetic.png');await fs.writeFile(image,png([220,160,60]));const hash=await hashFile(image);
 const spec=fixture('nativeEffectBody',image);spec.sockets=[{id:'arrow',bone:'root',types:['projectile'],capacity:1,inheritance:{position:true,rotation:true,scale:true},transform:{position:[0,0],rotation:0,scale:[1,1]}}];
 const model=path.join(mechanics,'SyntheticPower.cs');await fs.writeFile(model,'class SyntheticPower { public int Amount = 1; }');
 const inventory=await inspectMechanics({characterId:spec.id,sourceRoots:[mechanics],mechanics:[{key:'synthetic.Power',modId:'synthetic',modelSymbol:'SyntheticPower',evidence:[{path:model,symbol:'SyntheticPower',lineStart:1,lineEnd:1}]}]});
 const plan={version:1,characterId:spec.id,mechanicsFingerprint:inventory.fingerprint,inspectionVersion:'1',adapterContractVersion:'synthetic-v1',evidence:inventory.evidence,decisions:[{id:'syntheticPoison',mechanicKey:'synthetic.Power',outcome:'effect',reason:'Synthetic engine integration only',evidenceIds:inventory.mechanics[0].evidenceIds,bindingId:'syntheticPower',rule:{effectIds:['green','dot'],condition:{type:'amountAtLeast',threshold:1},scope:'whileActive',socketId:'arrow',channel:'tip',priority:1}}]};
 const planPath=path.join(source,'effects.json'),inventoryPath=path.join(source,'inventory.json');await fs.writeFile(planPath,JSON.stringify(plan));await fs.writeFile(inventoryPath,JSON.stringify(inventory));
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json'),'utf8'));config.sourceRoots=[source];config.outputRoot=evidence;config.mechanics={sourceRoots:[mechanics]};for(const tool of Object.values(config.tools))tool.cwd=path.dirname(tool.executable);
 const styleHash=hashValue(spec.style),resource={path:image,sha256:hash,importSettings:{},styleHash,approvalId:'synthetic-original-review'};
 const effectCapabilities={version:'synthetic-catalog-v1',adapterContractVersion:'synthetic-v1',gameFingerprint:'synthetic-no-game',baseLibFingerprint:'synthetic-no-baselib',bindings:[{id:'syntheticPower',mechanicKey:'synthetic.Power',adapterContractVersion:'synthetic-v1'}],sockets:['arrow'],supportsEffect:e=>['tint','overlay'].includes(e.capability),effects:[{id:'green',capability:'tint',presentation:{color:[0,1,0,1]},resources:[resource]},{id:'dot',capability:'overlay',presentation:{resourceHash:hash,offset:[8,-4],scale:[0.5,0.5]},resources:[resource]}]};
 let syntheticApproval=false,approvalChecks=0;
 const effectApproval=async proof=>{approvalChecks++;return syntheticApproval&&proof.resourceHash===hash&&proof.styleHash===styleHash&&proof.approvalId===resource.approvalId&&Object.keys(proof.importSettings).length===0;};
 const jobRoot=path.join(evidence,'job'),options={config,jobRoot,effectCapabilities,effectApproval,effectTargets:{arrow:{partId:'panel'}},render:true};
 const pending=await buildCharacter(JSON.parse(JSON.stringify(spec)),{...options,effectPlan:{planPath,inventoryPath}});
 assert.equal(pending.status,'awaiting_artwork_approval');assert.equal(Object.keys(pending.manifest.stages).length,0);assert.equal(pending.effects.activated,false);
 assert.equal(pending.manifest.context.inputs[image].hash,hash); // Overlay is the exact displayed original too.
 await fs.writeFile(path.join(evidence,'pending.json'),JSON.stringify(pending,null,2));
 await approveArtwork(jobRoot,{config,reviewId:pending.reviewId});syntheticApproval=true;
 const built=await resumeCharacter(jobRoot,options);assert.equal(built.valid,true);assert.equal(built.effects.activated,true);assert.equal(built.effects.gameIntegrationComplete,false);assert.equal(built.effectsIntegrationComplete,false);
 assert.equal(built.validation.effects.configured,true);assert.equal(built.validation.effects.gameBindings,false);assert.deepEqual([...built.validation.effects.capabilities].sort(),['overlay','tint']);assert.deepEqual(built.validation.effects.resourceHashes,[hash]);assert.ok(built.frames.length);
 await fs.rm(planPath);await fs.rm(inventoryPath);await fs.rm(image);await fs.rename(source,path.join(evidence,'source-denied'));
 const resumed=await resumeCharacter(jobRoot,options);assert.equal(resumed.effects.activated,true);assert.equal(resumed.effects.fingerprint,built.effects.fingerprint);assert.equal(effectCapabilities.effects[0].resources[0].path,image);
 for(const [id,stage]of Object.entries(built.manifest.stages)){assert.equal(resumed.manifest.stages[id].directory,stage.directory);assert.equal(resumed.manifest.stages[id].attempts.length,stage.attempts.length);}
 const report={valid:true,syntheticOnly:true,reviewId:pending.reviewId,approvalBeforePreparation:true,approvalChecks,activated:true,gameIntegrationComplete:false,sourceFreeEffectResume:true,liveMechanicsRetained:model,unchangedStageAttempts:true,effectsFingerprint:built.effects.fingerprint,metadata:built.validation.effects,frames:built.frames,project:built.project,manifest:path.join(jobRoot,'manifest.json')};
 await fs.writeFile(path.join(evidence,'native-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
