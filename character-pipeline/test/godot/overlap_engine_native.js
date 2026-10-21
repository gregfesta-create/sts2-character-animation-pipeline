'use strict';
// Opt-in numerical bytes only. These approvals never authorize user artwork.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {png,fixture}=require('./part_masks_native');
const {buildCharacter,resumeCharacter}=require('../../lib/engine');
const {approveArtwork}=require('../../lib/artwork-review');
const {compileGodot}=require('../../backends/godot');
const {hashFile,hashValue,resolveContained}=require('../../lib/assets');
const {planGodotResources}=require('../../adapters/godot');
function anchoredStripe(){
 // A distant single pixel retains the 8x8 transparent texture bounds through
 // ordinary preparation. Offset four gives intersecting mesh rectangles while
 // the two visible stripes and anchor pixels remain disjoint.
 const original=png(),length=original.readUInt32BE(33),rows=zlib.inflateSync(original.subarray(41,41+length));rows[7*33+1+7*4+3]=255;
 const data=zlib.deflateSync(rows),body=Buffer.concat([Buffer.from('IDAT'),data]);let crc=0xffffffff;
 for(const byte of body){crc^=byte;for(let i=0;i<8;i++)crc=crc>>>1^(crc&1?0xedb88320:0);}
 const chunk=Buffer.alloc(body.length+8);chunk.writeUInt32BE(data.length);body.copy(chunk,4);chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4);
 return Buffer.concat([original.subarray(0,33),chunk,original.subarray(41+length+4)]);
}
async function inventory(root,prefix=''){
 const files=[];for(const item of await fs.readdir(path.join(root,prefix),{withFileTypes:true})){
  const name=prefix?prefix+'/'+item.name:item.name;if(item.isDirectory())files.push(...await inventory(root,name));
  else if(item.isFile()){const bytes=await fs.readFile(path.join(root,name));files.push({path:name,base64:bytes.toString('base64'),hash:await hashFile(path.join(root,name))});}
 }return files;
}
async function main(){
 const root=path.resolve(__dirname,'../..'),arg=process.argv.indexOf('--evidence'),relative=arg<0?'evidence/overlap-engine-native':process.argv[arg+1];
 if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Evidence must remain within the pipeline workspace');
 const evidence=await resolveContained(root,relative,{mustExist:false});await fs.mkdir(evidence,{recursive:true});const source=path.join(evidence,'source');await fs.mkdir(source);
 const image=path.join(source,'numeric.png');await fs.writeFile(image,anchoredStripe());const imageHash=await hashFile(image);
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json'),'utf8'));config.sourceRoots=[source];config.outputRoot=evidence;
 for(const tool of Object.values(config.tools))tool.cwd=path.dirname(tool.executable);
 const reports={},successful=[];let nativeCalls=0;
 for(const kind of ['disjoint','forbidden','permitted','unknown']){
  const spec=fixture(image,{offset:kind==='disjoint'?4:0,annotate:kind!=='unknown'});spec.id='overlap'+kind;
  for(const part of spec.parts)part.image={path:image};if(kind==='permitted')spec.parts[0].overlaps=['b'];
  const originalHash=hashValue(spec),jobRoot=path.join(evidence,kind),options={config,jobRoot,render:true,compileGodot:async(...args)=>{nativeCalls++;return compileGodot(...args);}};
  const before=nativeCalls,pending=await buildCharacter(spec,options);assert.equal(pending.status,'awaiting_artwork_approval');assert.equal(nativeCalls,before);
  assert.equal(Object.keys(pending.manifest.stages).length,0);await approveArtwork(jobRoot,{config,reviewId:pending.reviewId});
  let result,failure;try{result=await resumeCharacter(jobRoot,options);}catch(error){failure=error;}
  assert.equal(nativeCalls,before+1);assert.equal(hashValue(spec),originalHash);assert.equal(await hashFile(image),imageHash);
  if(kind==='forbidden'){
   assert(failure,'Actual forbidden rendered alpha must fail');
   assert.equal(failure.code,'VISUAL_VALIDATION_FAILED');assert(failure.diagnostics?.some(d=>d.code==='FORBIDDEN_ALPHA_OVERLAP'));
   reports[kind]={status:'failed',code:failure.code,diagnostics:failure.diagnostics,report:failure.report,reviewId:pending.reviewId};continue;
  }
  if(failure)throw failure;assert.equal(result.valid,true);const overlap=result.inspection.partMasks;
  assert.equal(overlap.visualQuality,'unverified');assert.equal(overlap.status,kind==='disjoint'?'measured':'unverified');
  if(kind==='disjoint')assert(overlap.checkedComparisonCount>0);else assert.equal(overlap.checkedComparisonCount,0);
  const rigStage=result.manifest.stages.rig,rigRoot=await resolveContained(jobRoot,rigStage.directory),rig=JSON.parse(await fs.readFile(path.join(rigRoot,'rig.json'),'utf8'));
  assert.equal(overlap.specHash,rig.maskPlan.specHash);assert.equal(overlap.planHash,rig.maskPlan.planHash);
  if(kind==='disjoint'){
   assert(rig.maskCaptures.length>0);const captures=await inventory(result.project);
   assert(captures.some(c=>/^part-mask-\d+\.png$/.test(c.path)),'Actual native project contains mask artifacts');
   const packPlan=planGodotResources({namespace:'mods/overlapFixture',rootScene:'character.tscn',files:captures});
   assert(packPlan.files.every(c=>!c.path.includes('part-mask-')&&!c.path.endsWith('inspection.json')));
   reports.runtimeExclusion={capturedMaskCount:rig.maskCaptures.length,runtimeFileCount:packPlan.files.length,masksExcluded:true};
  }
  reports[kind]={status:overlap.status,partMasks:overlap,reviewId:pending.reviewId,project:result.project,frameHashes:await Promise.all(result.frames.map(hashFile)),boneSamples:result.validation.samples};
  successful.push({jobRoot,options,result});
 }
 assert.deepEqual(reports.permitted.frameHashes,reports.unknown.frameHashes,'Mask policy does not alter main rendered frames');assert.deepEqual(reports.permitted.boneSamples,reports.unknown.boneSamples);
 await fs.rename(source,path.join(evidence,'source-denied'));const compiled=nativeCalls;
 for(const {jobRoot,options,result}of successful){const resumed=await resumeCharacter(jobRoot,options);assert.deepEqual(resumed.inspection.partMasks,result.inspection.partMasks);for(const [id,stage]of Object.entries(result.manifest.stages)){assert.equal(resumed.manifest.stages[id].directory,stage.directory);assert.equal(resumed.manifest.stages[id].attempts.length,stage.attempts.length);}}
 assert.equal(nativeCalls,compiled);const report={valid:true,syntheticOnly:true,approvalBeforePreparation:true,imageHash,nativeCalls,sourceFreeCacheReuse:true,reports};await fs.writeFile(path.join(evidence,'native-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
module.exports={anchoredStripe,main};
if(require.main===module&&process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
