'use strict';
// Explicit opt-in synthetic integration: never approves user artwork or launches creative services.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {createSpec}=require('../../lib/spec');
const {hashValue,hashFile,resolveContained}=require('../../lib/assets');
const {planGodotResources}=require('../../adapters/godot');
const {buildCharacter,resumeCharacter,rebuildCharacter}=require('../../lib/engine');
const {approveArtwork}=require('../../lib/artwork-review');
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
async function runtimeInventory(root,prefix=''){
 const files=[];
 for(const entry of await fs.readdir(path.join(root,prefix),{withFileTypes:true})){
  if(entry.name==='.godot')continue;
  const name=prefix?prefix+'/'+entry.name:entry.name;
  assert.equal(entry.isSymbolicLink(),false,'Native fixture inventory must contain owned files');
  if(entry.isDirectory())files.push(...await runtimeInventory(root,name));
  else if(entry.isFile()){const file=await resolveContained(root,name),bytes=await fs.readFile(file);files.push({path:name,base64:bytes.toString('base64'),hash:await hashFile(file)});}
 }
 return files;
}
async function productionSnapshot(root){
 const rows=[];
 for(const folder of ['lib','adapters','backends','godot','schema','providers','workers','library','tools']){
  const walk=async(rel)=>{for(const e of await fs.readdir(path.join(root,rel),{withFileTypes:true})){assert(!e.isSymbolicLink());if(e.name==='__pycache__')continue;const p=rel+'/'+e.name;if(e.isDirectory())await walk(p);else if(e.isFile())rows.push({path:p,hash:await hashFile(path.join(root,p))});}};
  try{await walk(folder);}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 for(const relative of ['cli.js','config/tools.example.json'])rows.push({path:relative,hash:await hashFile(path.join(root,relative))});
 return rows.sort((a,b)=>a.path.localeCompare(b.path));
}
async function main(){
 const root=path.resolve(__dirname,'../..'),arg=process.argv.indexOf('--evidence'),relative=arg<0?'evidence/frozen-reuse-native':process.argv[arg+1];
 if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Evidence must remain inside the pipeline workspace.');
 const evidence=await resolveContained(root,relative,{mustExist:false});await fs.mkdir(evidence); const frozen=await productionSnapshot(root);await fs.writeFile(path.join(evidence,'production-before.json'),JSON.stringify(frozen,null,2));
 const source=path.join(evidence,'source');await fs.mkdir(source); // Fresh directory required; do not reuse prior approvals.
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json'),'utf8'));
 config.sourceRoots=[source];config.outputRoot=evidence;
 for(const tool of Object.values(config.tools))tool.cwd=path.dirname(tool.executable);
 const specs={};for(const [id,color]of [['body',[80,80,80]],['shared',[220,60,30]],['alternative',[30,80,220]],['third',[60,150,100]],['fourth',[140,160,40]]]){
  await fs.writeFile(path.join(source,id+'.png'),png(color));specs[id]=fixture(id,id+'.png');
  if(id!=='body'){
   specs[id].animations.push({id:id+'Activate',duration:1,loop:false,events:[],tracks:[{bone:'root',property:'rotation',keys:[{time:0,value:0},{time:1,value:.15}]}]});
   await fs.writeFile(path.join(source,id+'.json'),JSON.stringify(specs[id]));
  }
 }
 const spec=specs.body;spec.parts[0].image.path=path.join(source,'body.png');
 // Clearly numeric geometry, not a character-art demonstration.
 spec.description='SYNTHETIC asymmetric seven-joint chassis; no artistic quality claim';
 for(const [id,parent,position,length] of [['upper','root',[-13,-8],11],['tip','upper',[-7,-3],7],['lower','root',[18,11],19],['toe','lower',[12,2],5],['sensor','root',[3,-21],6],['rear','root',[-20,9],13]]){
  spec.bones.push({id,parent,rest:{position,rotation:0,scale:[1,1]},length});
  spec.anatomy.roles[id]=id;
  const part=structuredClone(spec.parts[0]);part.id=id+'Panel';part.role=id;part.bone=id;part.layer=spec.parts.length;part.mesh.weights=Array.from({length:4},()=>[{bone:id,weight:1}]);spec.parts.push(part);
 }
 spec.animations[0].tracks.push({bone:'upper',property:'rotation',keys:[{time:0,value:0},{time:.5,value:.4},{time:1,value:0}]});
 const identity={position:[0,0],rotation:0,scale:[1,1]},inheritance={position:true,rotation:true,scale:true},styleHash=hashValue(spec.style);
 spec.sockets=['left','right'].map((id,i)=>({id,bone:'root',types:['sharedType','alternativeType'],capacity:1,inheritance,layer:1,envelope:[64,64],transform:{...identity,position:[i?14:-14,0]}}));
 spec.components=['left','right'].map((socket,i)=>({id:'installed'+i,socket,type:'sharedType',spec:path.join(source,'shared.json')}));
 spec.assembly={version:1,styleHash,eventNames:[],descriptors:['shared','alternative','third','fourth'].map(id=>({version:1,type:id+'Type',spec:id+'.json',mount:{...identity,position:[32,32]},dimensions:[64,64],styleHash,eventNames:[],layer:1,inheritance}))};
 // Preserve the original shared-definition deduplication checks and add two
 // distinct component definitions sharing one logical socket.
 spec.sockets.push({id:'sharedSocket',bone:'root',types:['sharedType','alternativeType'],capacity:2,inheritance,layer:1,envelope:[64,64],transform:{...identity,position:[0,-14]}});
 spec.assembly.descriptors[1].mount.position=[40,32];
 for(const [index,descriptor]of spec.assembly.descriptors.entries())descriptor.transitions={install:{duration:index?.3:.2,phases:[{id:'begin',time:0},{id:'activate',time:.1,clip:descriptor.type.replace(/Type$/,'')+'Activate'}]},replace:{duration:.2,phases:[{id:'replace-start',time:0}]},remove:{duration:.2,phases:[{id:'remove-start',time:0}]}};
 spec.components.push({id:'installed2',socket:'sharedSocket',type:'sharedType',spec:path.join(source,'shared.json')},{id:'installed3',socket:'sharedSocket',type:'alternativeType',spec:path.join(source,'alternative.json')});
 spec.sockets.push({id:'thirdMount',bone:'sensor',types:['thirdType'],capacity:1,inheritance,layer:1,envelope:[64,64],transform:{...identity,position:[-3,8]}});
 spec.components.push({id:'installed5',socket:'thirdMount',type:'thirdType',spec:path.join(source,'third.json')});
 spec.sockets.push({id:'fourthMount',bone:'toe',types:['fourthType'],capacity:1,inheritance,layer:1,envelope:[64,64],transform:{...identity,position:[9,4]}});
 spec.components.push({id:'installed4',socket:'fourthMount',type:'fourthType',spec:path.join(source,'fourth.json')});
 const jobRoot=path.join(evidence,'job'),options={config,jobRoot,render:true};
 await fs.writeFile(path.join(source,'body.json'),JSON.stringify(spec,null,2));
 const pending=await buildCharacter(JSON.parse(JSON.stringify(spec)),options);
 assert.equal(pending.status,'awaiting_artwork_approval');assert.equal(Object.keys(pending.manifest.stages).length,0);
 assert.equal(pending.manifest.context.settings.componentArtwork.length,4);
 await fs.writeFile(path.join(evidence,'pending.json'),JSON.stringify(pending,null,2));
 // Exact synthetic fixture receipt only. This models explicit approval in an automated native test.
 await approveArtwork(jobRoot,{config,reviewId:pending.reviewId});
 let built=await resumeCharacter(jobRoot,{config});assert.equal(built.valid,true);assert.equal(built.rendered,true);
 const preview=built.assemblyPreview;assert.equal(preview.status,'completed');assert.equal(preview.visualQuality,'unverified');assert.equal(preview.specHash,hashValue(spec));assert.equal(preview.compiledSpecHash,built.authoredGeometry.specHash);
 assert.equal(preview.native.startedUnbound,true);assert.equal(preview.native.skeletonPreserved,true);assert.equal(preview.native.finalEmpty,true);
 for(const operation of ['install','replace','remove'])assert.ok(preview.native.phaseObservations.some(event=>event.operation===operation),operation+' preview phase observation missing');
 assert.ok(preview.frames.length>2);for(const artifact of [...preview.frames,preview.contactSheet,preview.motionPreview]){assert.ok((await fs.stat(artifact.path)).isFile());assert.ok(path.relative(built.project,artifact.path).split(path.sep).includes('..'),'development preview must remain outside runtime project');}
 const savedScene=await fs.readFile(built.scene);
 const runtimeCaptures=await runtimeInventory(built.project),previewFiles=[...preview.frames.map(frame=>frame.path),preview.contactSheet.path,preview.motionPreview.path,await resolveContained(jobRoot,built.manifest.stages['assembly-preview'].directory+'/assembly-preview.json')];
 const injectedPreviewPaths=[];
 for(const [index,file]of previewFiles.entries()){const name='previews/assembly-'+index+path.extname(file),bytes=await fs.readFile(file);runtimeCaptures.push({path:name,base64:bytes.toString('base64'),hash:await hashFile(file)});injectedPreviewPaths.push(name);}
 const runtimePlan=planGodotResources({namespace:'mods/componentPreviewFixture',rootScene:'character.tscn',files:runtimeCaptures});
 assert.ok(runtimePlan.files.length>0);assert.ok(runtimePlan.files.every(file=>!injectedPreviewPaths.includes(file.sourcePath)&&!file.sourcePath.startsWith('previews/')),'Actual preview frame, APNG, contact sheet and report bytes must remain unreachable from runtime scene closure');
 const childStages=Object.entries(built.manifest.stages).filter(([id])=>id.startsWith('component-')&&id.endsWith('-rig'));
 assert.equal(childStages.length,4);for(const [,stage]of childStages)assert.equal(stage.attempts.length,1);
 const beforeBuild=built;
 const revised=structuredClone(spec);revised.revision++;
 const child=structuredClone(specs.fourth);child.revision++;child.animations[0].tracks[0].keys[1].value=.65;
 const childPath=path.join(source,'fourth-v2.json');await fs.writeFile(childPath,JSON.stringify(child));
 revised.components.find(c=>c.id==='installed4').spec=childPath;
 revised.assembly.descriptors.find(d=>d.type==='fourthType').spec='fourth-v2.json';
 let rebuilt=await rebuildCharacter(JSON.parse(JSON.stringify(spec)),JSON.parse(JSON.stringify(revised)),options);
 if(rebuilt.status==='awaiting_artwork_approval'){await approveArtwork(jobRoot,{config,reviewId:rebuilt.reviewId});rebuilt=await resumeCharacter(jobRoot,{config});}
 assert.equal(rebuilt.valid,true);
 const cacheComparisons=Object.entries(beforeBuild.manifest.stages).map(([id,stage])=>({id,before:stage.directory,after:rebuilt.manifest.stages[id]?.directory,unchanged:stage.directory===rebuilt.manifest.stages[id]?.directory}));
 const childCache=cacheComparisons.filter(x=>x.id.startsWith('component-')&&x.id.endsWith('-rig'));
 assert.equal(childCache.filter(x=>x.unchanged).length,3,'All three unrelated child rigs must remain cached');
 assert.equal(childCache.filter(x=>!x.unchanged&&x.after).length,1,'Exactly the edited definition must recompile');
 assert(cacheComparisons.filter(x=>x.id.startsWith('art-')||x.id.includes('-art-')).every(x=>x.unchanged),'Original pixel preparation must remain cached');
 assert(cacheComparisons.some(x=>x.id==='rig'&&!x.unchanged),'Ancestor rig must rebuild');
 assert(cacheComparisons.some(x=>x.id.startsWith('component-')&&x.id.endsWith('-rig')&&!x.unchanged),'Changed child rig must rebuild');
 const originalByteHashes=await Promise.all(['body','shared','alternative','third','fourth'].map(async id=>({path:id+'.png',hash:await hashFile(path.join(source,id+'.png'))})));
 for(const entry of originalByteHashes)assert.equal(entry.hash,require('node:crypto').createHash('sha256').update(png({body:[80,80,80],shared:[220,60,30],alternative:[30,80,220],third:[60,150,100],fourth:[140,160,40]}[entry.path.slice(0,-4)] )).digest('hex'));
 built=rebuilt;
 const rebuiltPreview=built.assemblyPreview,rebuiltScene=await fs.readFile(built.scene);
 await fs.rename(source,path.join(evidence,'source-denied'));
 const resumed=await resumeCharacter(jobRoot,{config});assert.equal(resumed.valid,true);
 assert.deepEqual(resumed.assemblyPreview,rebuiltPreview);assert.deepEqual(await fs.readFile(resumed.scene),rebuiltScene);assert.deepEqual(resumed.manifest.context.artworkReview,built.manifest.context.artworkReview);
 for(const [id,stage]of Object.entries(built.manifest.stages)){assert.equal(resumed.manifest.stages[id].directory,stage.directory);assert.equal(resumed.manifest.stages[id].attempts.length,stage.attempts.length);}
 const relocated=path.join(evidence,'relocated');await fs.cp(built.project,relocated,{recursive:true});
 await fs.writeFile(path.join(relocated,'engine_probe.gd'),`extends SceneTree
func _initialize(): call_deferred("run")
func run():
 var scene=load("res://character.tscn")
 var body=scene.instantiate()
 root.add_child(body)
 await process_frame
 var assembly=body.get_node("AssemblyController")
 for attempt in range(8):
  if assembly.ready_for_state: break
  await process_frame
 var production_unbound=assembly.ready_for_state and not assembly.ready_for_batches and assembly.records.is_empty()
 assembly.set_process(false)
 var phase_events=[]
 assembly.transition_phase.connect(func(component_id,logical_socket,operation,phase_id,generation): phase_events.append({"id":component_id,"socket":logical_socket,"operation":operation,"phase":phase_id,"generation":generation}))
 var chassis_skeleton_id=body.get_node("Skeleton").get_instance_id()
 var snapshot=JSON.parse_string(${JSON.stringify(JSON.stringify({version:1,instanceId:'engine-fixture',revision:1,sequence:0,lifecycle:'alive',visualMode:'idle',components:spec.components.map(c=>({id:c.id,socket:c.socket,type:c.type,revision:1,damageState:'intact',upgrade:0,visualMode:'idle'}))}))})
 var bound=assembly.bind_authoritative("engine-fixture")
 var initial=assembly.receive_snapshot(snapshot) if bound else {}
 assembly.advance(0.3)
 var a=assembly.component_at("installed0")
 var b=assembly.component_at("installed1")
 var checks={"assembly_ready":assembly.ready_for_batches,"two_distinct_mounts":a!=null and b!=null and a!=b,"independent_skeletons":a!=null and b!=null and a.get_node("Skeleton")!=b.get_node("Skeleton"),"alternative_available":assembly.descriptors.has("alternativeType")}
 checks.production_unbound=production_unbound
 checks.authoritative_initialization=bound and initial.get("status")=="applied"
 checks.saved_profiles=assembly.descriptors.sharedType.get("transitions",{}).get("install",{}).get("duration")==0.2 and assembly.descriptors.alternativeType.get("transitions",{}).get("install",{}).get("duration")==0.3
 checks.logical_phase_identity=phase_events.size()==12
 for event in phase_events:
  checks.logical_phase_identity=checks.logical_phase_identity and event.id in ["installed0","installed1","installed2","installed3","installed4","installed5"] and event.socket in ["left","right","sharedSocket","fourthMount","thirdMount"] and event.operation=="install" and event.phase in ["begin","activate"] and event.generation>0
 checks.chassis_skeleton_retained=body.get_node("Skeleton").get_instance_id()==chassis_skeleton_id
 checks.independent_activation=a!=null and b!=null and a.current=="sharedActivate" and b.current=="sharedActivate" and a.get_node("AnimationTree")!=b.get_node("AnimationTree") and body.current=="idle"
 var fourth=assembly.component_at("installed4")
 checks.fourth_component=fourth!=null and fourth.get_node("Skeleton")!=a.get_node("Skeleton") and fourth.current=="fourthActivate"
 checks.asymmetric_anatomy=body.get_node("Skeleton").get_bone_count()==7
 if fourth!=null:
  var edited_clip=fourth.get_node("AnimationPlayer").get_animation("idle")
  checks.revised_clip_data=false
  if edited_clip!=null:
   for track in range(edited_clip.get_track_count()):
    if str(edited_clip.track_get_path(track))=="Skeleton/root:rotation" and edited_clip.track_get_key_count(track)>1:
     checks.revised_clip_data=is_equal_approx(edited_clip.track_get_key_value(track,1),.65)
 if a!=null and b!=null:
  var mount_a=a.get_parent().transform
  var mount_b=b.get_parent().transform
  a.play_animation("idle")
  a.get_node("AnimationTree").advance(.2)
  checks.stable_mount_frames=a.get_parent().transform==mount_a and b.get_parent().transform==mount_b
 var shared=assembly.component_at("installed2")
 var alternative=assembly.component_at("installed3")
 checks.same_socket_distinct_instances=shared!=null and alternative!=null and shared!=alternative and shared.get_parent()!=alternative.get_parent()
 checks.same_socket_independent_skeletons=shared!=null and alternative!=null and shared.get_node("Skeleton")!=alternative.get_node("Skeleton")
 checks.distinct_same_socket_activation=shared!=null and alternative!=null and shared.current=="sharedActivate" and alternative.current=="alternativeActivate"
 if shared!=null and alternative!=null:
  checks.distinct_descriptor_frames=shared.get_parent().transform!=alternative.get_parent().transform
  var previous=assembly.get_state()
  var next=previous.duplicate(true)
  next.revision+=1
  next.sequence+=1
  next.components[2].revision+=1
  next.components[2].damageState="damaged"
  var changed=assembly.receive_snapshot(next)
  checks.authoritative_sibling_update=changed.get("status")=="applied" and assembly.component_at("installed3")==alternative and assembly.component_at("installed2")==shared
 var file=FileAccess.open("res://engine-validation.json",FileAccess.WRITE)
 file.store_string(JSON.stringify(checks))
 for passed in checks.values():
  if not passed: quit(1);return
 quit(0)
`);
 const native=await require('../../lib/process').runTool({native:config.tools.megadot||config.tools.godot},'native',['--headless','--path',relocated,'--script','res://engine_probe.gd'],{timeoutMs:30000});
 await fs.writeFile(path.join(evidence,'process.json'),JSON.stringify(native,null,2));
 assert.equal(native.error,null);assert.equal(native.exitCode,0);assert.equal(/SCRIPT ERROR|ERROR:/.test(native.stdout+native.stderr),false);
 const nativeChecks=JSON.parse(await fs.readFile(path.join(relocated,'engine-validation.json'),'utf8'));assert.ok(Object.values(nativeChecks).every(Boolean));
 const finalCaptures=await runtimeInventory(built.project);
 const finalPlan=planGodotResources({namespace:'mods/frozenReuseFixture',rootScene:'character.tscn',files:finalCaptures});
 const stagingParent=path.join(evidence,'pack-stages');await fs.mkdir(stagingParent);
 const exported=await require('../../lib/export').exportGodotPack({plan:finalPlan,stagingParent,tool:config.tools.megadot});
 assert.equal(exported.nativeExportStatus,'pack-created');assert(exported.bytes>12);assert(finalPlan.files.every(f=>!f.sourcePath.startsWith('previews/')));
 const packProbe=path.join(evidence,'pack-probe');await fs.mkdir(packProbe);
 await fs.writeFile(path.join(packProbe,'project.godot'),'config_version=5\n');
 await fs.writeFile(path.join(packProbe,'pack_probe.gd'),`extends SceneTree
func _initialize(): call_deferred("run")
func run():
 if not ProjectSettings.load_resource_pack(${JSON.stringify(exported.pack.replaceAll('\\','/'))}): quit(1);return
 var packed=load(${JSON.stringify(exported.rootScene)})
 if packed==null: quit(2);return
 var body=packed.instantiate()
 root.add_child(body)
 await process_frame
 var checks={"pack_loaded":true,"asymmetric_skeleton":body.get_node("Skeleton").get_bone_count()==7,"assembly_exists":body.has_node("AssemblyController")}
 var file=FileAccess.open("res://pack-validation.json",FileAccess.WRITE)
 file.store_string(JSON.stringify(checks))
 for passed in checks.values():
  if not passed: quit(3);return
 quit(0)
`);
 const packProcess=await require('../../lib/process').runTool({native:config.tools.megadot},'native',['--headless','--path',packProbe,'--script','res://pack_probe.gd'],{timeoutMs:30000});
 await fs.writeFile(path.join(evidence,'pack-process.json'),JSON.stringify(packProcess,null,2));
 assert.equal(packProcess.error,null);assert.equal(packProcess.exitCode,0);assert(!/SCRIPT ERROR|ERROR:/.test(packProcess.stdout+packProcess.stderr));
 const packChecks=JSON.parse(await fs.readFile(path.join(packProbe,'pack-validation.json'),'utf8'));assert(Object.values(packChecks).every(Boolean));
 const after=await productionSnapshot(root);assert.deepEqual(after,frozen,'Production source must remain frozen throughout data-only reuse');
 await fs.writeFile(path.join(evidence,'production-after.json'),JSON.stringify(after,null,2));
 const report={valid:true,definition:{template:spec.anatomy.template,bones:spec.bones,components:revised.components,originalSpecHash:hashValue(spec),revisedSpecHash:hashValue(revised)},productionFrozen:true,productionFileCount:frozen.length,productionSnapshotHash:hashValue(frozen),cacheComparisons,originalByteHashes,exported,packChecks,artisticQuality:'unverified',gameAcceptance:false,nativeChecks,runtimeExclusion:{capturedPreviewFiles:injectedPreviewPaths.length,runtimeFileCount:runtimePlan.files.length,previewsExcluded:true},process:path.join(evidence,'process.json'),relocatedProject:relocated,syntheticOnly:true,reviewId:pending.reviewId,approvalBeforePreparation:true,twoMountsOneSharedCompilation:true,selectableAlternativeCompiled:true,sourceFreeCacheReuse:true,childStages:childStages.map(([id,s])=>({id,directory:s.directory,attempts:s.attempts.length})),project:built.project,scene:built.scene,frames:built.frames,validation:built.validation,manifest:path.join(jobRoot,'manifest.json')};
 await fs.writeFile(path.join(evidence,'native-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({valid:report.valid,syntheticOnly:true,productionFrozen:report.productionFrozen,productionSnapshotHash:report.productionSnapshotHash,nativeChecks:report.nativeChecks,packChecks:report.packChecks,result:path.join(evidence,'native-result.json')},null,2));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={main,productionSnapshot};
