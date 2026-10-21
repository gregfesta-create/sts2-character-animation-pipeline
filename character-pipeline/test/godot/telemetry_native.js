'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {runLockedTool}=require('../../lib/export');
const {validateTelemetry}=require('../../lib/validation');
async function main(){
 const root=path.resolve(__dirname,'../..'),i=process.argv.indexOf('--evidence'),out=path.resolve(i<0?path.join(root,'evidence/telemetry-native'):process.argv[i+1]);
 await fs.mkdir(out,{recursive:true});
 const files=[];
 for(const [name,source]of [['telemetry.gd',path.join(root,'godot/telemetry.gd')],['pose_controller.gd',path.join(root,'godot/pose_controller.gd')],['telemetry_runtime.gd',path.join(__dirname,'telemetry_runtime.gd')]]){
  const bytes=await fs.readFile(source);await fs.writeFile(path.join(out,name),bytes);files.push({path:path.join(out,name),size:bytes.length,hash:crypto.createHash('sha256').update(bytes).digest('hex')});
 }
 const bytes=Buffer.from('config_version=5\n');await fs.writeFile(path.join(out,'project.godot'),bytes);files.push({path:path.join(out,'project.godot'),size:bytes.length,hash:crypto.createHash('sha256').update(bytes).digest('hex')});
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json'))),tool=config.tools.megadot||config.tools.godot;
 const processResult=await runLockedTool({tool,args:['--headless','--path',out,'--script','res://telemetry_runtime.gd'],files});
 await fs.writeFile(path.join(out,'process.json'),JSON.stringify(processResult,null,2));
 if(processResult.error||processResult.exitCode||/SCRIPT ERROR|ERROR:/.test(processResult.stdout+processResult.stderr))throw new Error(JSON.stringify(processResult));
 const result=JSON.parse(await fs.readFile(path.join(out,'result.json')));
 assert.equal(result.good.ok,true);assert.equal(validateTelemetry(result.good.telemetry).status,'passed');
 assert.equal(result.compiledGood.ok,true);assert.equal(validateTelemetry(result.compiledGood.telemetry).status,'passed');
 assert.equal(result.distinctLoopId.ok,true);assert.deepEqual(result.distinctLoopId.sourceMap.loops,{loop0:'idle'});assert.ok(result.distinctLoopId.telemetry.loopEndpoints.every(e=>e.clipId==='loop0'));
 assert.equal(result.good.telemetry.weights.length,3);assert.equal(result.good.telemetry.loopEndpoints.length,2);
 assert.ok(validateTelemetry(result.seam.telemetry).failures.some(f=>f.code==='LOOP_SEAM'&&f.measured===2));
 assert.ok(validateTelemetry(result.weights.telemetry).failures.some(f=>f.code==='WEIGHT_SUM'));
 assert.equal(result.preserved,true);assert.equal(result.cueCount,0);assert.equal(result.invalidRejected,true);assert.equal(result.childCount,1);
 assert.equal(result.scaleRejected,true);assert.equal(result.oversizedPoseRejected,true);assert.equal(result.duplicateRejected,true);assert.equal(result.nonfiniteRejected,true);assert.equal(result.good.collectorCoverage.excludedTracks,1);
 assert.equal(result.restGood.ok,true);assert.equal(result.compiledRest.ok,true);
 for(const r of [result.restGood,result.compiledRest]){
  assert.equal(validateTelemetry(r.telemetry).status,'passed');assert.equal(r.collectorCoverage.restAnchors,1);
  assert.deepEqual(r.sourceMap.attachments,{attachment0:{meshId:'body',path:'Body',vertex:0}});
  assert.deepEqual(r.telemetry.attachments[0].expected,[-6,-4]);
  assert.ok(Math.abs(r.telemetry.attachments[0].actual[0]+6)<1e-4);assert.ok(Math.abs(r.telemetry.attachments[0].actual[1]+4)<1e-4);
  assert.ok(r.collectorCoverage.uncovered.includes('movingAttachments'));assert.ok(r.collectorCoverage.uncovered.includes('skinnedVertices'));
 }
 assert.equal(validateTelemetry(result.exactBoundary.telemetry).status,'passed');
 assert.deepEqual(result.exactBoundary.telemetry.attachments[0].actual,[1,0]);
 // Use a separate exact axis fixture for tolerance; native floating arithmetic
 // may put a rotated boundary within a few ulps of one pixel.
 assert.ok(Math.abs(result.restBoundary.telemetry.attachments[0].actual[0]+5)<1e-4);
 assert.ok(validateTelemetry(result.restBad.telemetry).failures.some(f=>f.code==='ATTACHMENT_ERROR'));
 assert.equal(result.good.collectorCoverage.restAnchors,0);assert.ok(result.good.collectorCoverage.uncovered.includes('attachments'));
 assert.equal(result.partialRest.ok,true);assert.equal(result.partialRest.collectorCoverage.restAnchors,1);assert.equal(result.partialRest.telemetry.weights.length,6);
 assert.ok(result.partialRest.collectorCoverage.uncovered.includes('attachments'));
 assert.equal(result.observedNonfiniteRejected,true);assert.equal(result.observedOversizedRejected,true);
 assert.equal(result.restGood.collectorCoverage.scope,'static-representative-vertex-registration');
 assert.equal(result.restPreserved,true);assert.equal(result.malformedAnchorsRejected,true);
 console.log(JSON.stringify({passed:true,weights:3,loopEndpoints:2,originalPreserved:true,cues:0}));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(e=>{console.error(e);process.exitCode=1;});
