'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {createSpec}=require('../../lib/spec');
const {compileGodot}=require('../../backends/godot');
const {runTool:defaultRunTool}=require('../../lib/process');
const crypto=require('node:crypto');
function png(){
 const chunk=(type,data)=>{const b=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of b){crc^=byte;for(let i=0;i<8;i++)crc=crc>>>1^(crc&1?0xedb88320:0);}const result=Buffer.alloc(b.length+8);result.writeUInt32BE(data.length);b.copy(result,4);result.writeUInt32BE((crc^0xffffffff)>>>0,result.length-4);return result;};
 const header=Buffer.alloc(13);header.writeUInt32BE(4);header.writeUInt32BE(4,4);header[8]=8;header[9]=6;const rows=Buffer.alloc(68);for(let y=0;y<4;y++)for(let x=0;x<4;x++){const n=y*17+1+x*4;rows[n]=200;rows[n+1]=80;rows[n+2]=40;rows[n+3]=255;}
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
async function main(){
 const root=path.resolve(__dirname,'../..'),i=process.argv.indexOf('--evidence'),out=path.resolve(i<0?path.join(root,'evidence/telemetry-compile-native'):process.argv[i+1]);await fs.mkdir(out,{recursive:true});
 const image=path.join(out,'fixture.png');await fs.writeFile(image,png());
 const spec=createSpec({id:'telemetryCompile',description:'Synthetic native geometry validation fixture'});
 spec.bones[0].rest.position=[64,64];spec.bones.push({id:'hand',parent:'root',rest:{position:[10,0],rotation:.37,scale:[-2,3]},length:10});
 spec.parts=[{id:'body',role:'root',bone:'hand',pivot:[0,0],layer:0,image:{path:image,prepared:true,width:4,height:4,alphaBounds:[0,0,4,4],cropTranslation:[0,0],pivot:[1,2],pixelsPerUnit:2},mesh:{vertices:[[0,0],[4,0],[4,4],[0,4]],uv:[[0,0],[4,0],[4,4],[0,4]],triangles:[[0,1,2],[0,2,3]],weights:Array.from({length:4},()=>[{bone:'root',weight:.5},{bone:'hand',weight:.5}])}}];
 spec.animations=[{id:'idle',duration:1,loop:true,events:[],tracks:[{bone:'root',property:'position',keys:[{time:0,value:[64,64],easing:'in'},{time:.5,value:[69,64],easing:'out'},{time:1,value:[64,64]}]}]}];
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json')));
 const nativeLogs=[];const runTool=async(...args)=>{const result=await defaultRunTool(...args);nativeLogs.push({name:args[1],args:args[2],exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr});await fs.writeFile(path.join(out,'native-logs.json'),JSON.stringify(nativeLogs,null,2));return result;};
 const good=await compileGodot(spec,{config,runTool,stagingDir:path.join(out,'valid'),render:true});
 assert.equal(good.validation.motionRegistration.status,'passed');
 let seededScriptHash,registrationFailure;
 const mutateNative=async(...args)=>{
  const script=path.join(out,'wrong-pose/godot/compile.gd');
  const source=await fs.readFile(script,'utf8'),needle='\t\t\tvar transforms = {}';
  assert.equal(source.split(needle).length,2);
  const seeded=source.replace(needle,'\t\t\treloaded.get_node(paths["root"]).position += Vector2(8, 0)\n'+needle);
  await fs.writeFile(script,seeded);seededScriptHash=crypto.createHash('sha256').update(seeded).digest('hex');
  return runTool(...args);
 };
 await assert.rejects(compileGodot(spec,{config,runTool:mutateNative,stagingDir:path.join(out,'wrong-pose'),render:true}),e=>{registrationFailure={code:e.code,diagnostics:e.diagnostics};return e.code==='VISUAL_VALIDATION_FAILED'&&e.diagnostics.some(d=>d.code==='BONE_REGISTRATION_ERROR');});
 await fs.writeFile(path.join(out,'motion-registration.json'),JSON.stringify({positive:good.validation.motionRegistration,seededScriptHash,failure:registrationFailure,sceneHash:crypto.createHash('sha256').update(await fs.readFile(path.join(out,'wrong-pose/godot/character.tscn'))).digest('hex')},null,2));
 assert.equal(good.validation.geometry.status,'passed');assert.equal(good.validation.geometry.report.coverage.weights,4);assert.equal(good.validation.geometry.report.coverage.loopEndpoints,2);assert.equal(good.validation.geometry.componentGeometry,'uncovered');assert.equal(good.validation.geometry.collectorCoverage.restAnchors,1);assert.equal(good.validation.geometry.collectorCoverage.scope,'static-representative-vertex-registration');assert.deepEqual(good.validation.geometry.sourceMap.attachments.attachment0,{meshId:'body',path:'Meshes/body',vertex:0});const anchor=good.validation.geometry.telemetry.attachments[0];const intended=[74+Math.cos(.37)+Math.sin(.37)*3,64+Math.sin(.37)-Math.cos(.37)*3];for(let k=0;k<2;k++)assert(Math.abs(anchor.expected[k]-intended[k])<1e-10);for(let k=0;k<2;k++)assert(Math.abs(anchor.actual[k]-anchor.expected[k])<1e-5);assert(good.validation.geometry.collectorCoverage.uncovered.includes('skinnedVertices'));assert.equal(good.frames.length,17);assert.equal(good.validation.samples.at(-1).time,1);assert(new Set(good.validation.samples.map(s=>s.bones.root[0])).size>2);assert.deepEqual(good.validation.samples.at(-1).bones.root.slice(0,2),[64,64]);assert.equal(good.validation.motionPlan.clips[0].undersampled,false);
 const bad=structuredClone(spec);bad.animations[0].tracks[0].keys[2].value=[66,64];let failure;
 await assert.rejects(compileGodot(bad,{config,runTool,stagingDir:path.join(out,'seam'),render:true}),e=>{failure={code:e.code,diagnostics:e.diagnostics};return e.code==='VISUAL_VALIDATION_FAILED'&&e.diagnostics.filter(d=>d.code==='LOOP_SEAM'&&d.measured===2).length===2;});
 const seamNative=JSON.parse(await fs.readFile(path.join(out,'seam/godot/validation.json')));assert.equal(seamNative.samples.at(-1).time,1);assert.deepEqual(seamNative.samples.at(-1).bones.root.slice(0,2),[66,64]);
 const many=structuredClone(spec);many.animations=Array.from({length:32},(_,i)=>({id:'clip'+i,duration:600,loop:false,events:[{id:'release',name:'release',time:.1}],tracks:[{bone:'root',property:'position',keys:[{time:0,value:[64,64]},{time:300,value:[69,64]},{time:600,value:[64,64]}]}]}));
 const bounded=await compileGodot(many,{config,runTool,stagingDir:path.join(out,'bounded'),render:true});assert.equal(bounded.frames.length,64);assert.equal(bounded.validation.renderLayout.frameCount,64);assert.equal(bounded.validation.motionPlan.maxFramesPerClip,64);assert.equal(bounded.validation.motionPlan.maxTotalFrames,64);for(const clip of bounded.validation.motionPlan.clips){assert.deepEqual(clip.times,[0,600]);assert.deepEqual(clip.omittedEventTimes,[.1]);assert.deepEqual(clip.omittedKeyTimes,[300]);assert.equal(clip.undersampled,true);}
 const headless=await compileGodot(spec,{config,runTool,stagingDir:path.join(out,'headless'),render:false});assert.equal(headless.validation.geometry.status,'not-requested');assert.equal(headless.validation.motionRegistration.status,'not-requested');
 const sceneHashes={};for(const name of ['valid','seam','bounded','headless'])sceneHashes[name]=crypto.createHash('sha256').update(await fs.readFile(path.join(out,name,'godot/character.tscn'))).digest('hex');
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify({passed:true,sceneHashes,good:good.validation.geometry,motion:good.validation.motionPlan,bounded:bounded.validation.motionPlan,exactLoopEndpoint:seamNative.samples.at(-1),failure,headless:headless.validation.geometry},null,2));console.log(JSON.stringify({passed:true,weights:4,loopEndpoints:2,seamsDetected:2,headless:'not-requested'}));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(e=>{console.error(e);process.exitCode=1;});


