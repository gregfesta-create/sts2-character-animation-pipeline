'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {runAudioOperation,readBounded} = require('../lib/audio');
const {createAssemblyPlanner,componentEventNames,assertTransitionClipCompatibility}=require('../lib/components');
const {hashValue}=require('../lib/assets');
const {validateTelemetry}=require('../lib/validation');
const {planRenderViewport}=require('../lib/render-layout');
const {planMotionSampling,planNumberBits}=require('../lib/motion-sampling');
const {normalizeEffectAnimation}=require('../lib/effect-animation');
const {inspectMotionRegistration}=require('../lib/motion-registration');
const {inspectNativeSkinning}=require('../lib/native-skinning');
const {planPartMasks}=require('../lib/overlap-planning');
const {
  runTool: defaultRunTool
} = require('../lib/process');
const {
  assertSpec
} = require('../lib/spec');
const ASSEMBLY_BOOT=`extends "res://assembly_controller.gd"
@export var socket_definitions: Dictionary = {}
@export var scene_definitions: Dictionary = {}
@export var planner_registry: Dictionary = {}
signal assembly_ready
signal snapshot_required(owner, minimum_sequence, minimum_revision)
signal rebuild_required(owner)
var ready_for_batches=false
var ready_for_state=false
var preview_only=false
var _transport
var _authority_disposed=false
func _ready():
 call_deferred("_start_assembly")
func _start_assembly():
 if _authority_disposed or ready_for_state: return
 var mounts={}
 for id in socket_definitions:
  var d=socket_definitions[id].duplicate(true)
  d.node=get_parent().get_node(d.path)
  d.erase("path")
  mounts[id]=d
 _transport=load("res://assembly_transport.gd").new()
 if not _transport.configure_trusted(self,planner_registry,mounts,scene_definitions):
  push_error("Compiled assembly initialization failed: "+_transport.last_error)
  return
 _transport.snapshot_required.connect(func(owner,seq,rev): snapshot_required.emit(owner,seq,rev))
 _transport.rebuild_required.connect(func(owner): rebuild_required.emit(owner))
 ready_for_state=true
 assembly_ready.emit()
func bind_authoritative(owner):
 if _authority_disposed or not ready_for_state or preview_only: return false
 var bound=_transport.bind_authoritative(owner)
 if bound: ready_for_batches=true
 return bound
func receive_snapshot(message):
 return _transport.receive_snapshot(message) if ready_for_state else {"error":"UNBOUND_TRANSPORT","state":{}}
func rebuild_from_snapshot(message):
 return _transport.rebuild_from_snapshot(message) if ready_for_state else {"error":"UNBOUND_TRANSPORT","state":{}}
func receive_event(message):
 return _transport.receive_event(message) if ready_for_state else {"error":"UNBOUND_TRANSPORT","state":{}}
func get_state():
 return _transport.get_state() if ready_for_state else {}
func dispose_authoritative():
 _authority_disposed=true
 ready_for_batches=false
 return _transport.dispose() if _transport!=null else {"error":"UNBOUND_TRANSPORT","state":{}}
# Explicit host-only preview on a transient instance after the production scene
# has been saved. It is never serialized, rebound or repacked as game state.
func start_preview(snapshot):
 if _authority_disposed or not ready_for_state or ready_for_batches or preview_only or not snapshot is Dictionary: return false
 preview_only=true
 var owner="preview-"+str(get_instance_id())
 if not _transport.bind_authoritative(owner): return false
 ready_for_batches=true
 var state=snapshot.duplicate(true)
 state.instanceId=owner
 var result=_transport.receive_snapshot(state)
 if result.get("status")!="applied": return false
 advance(0.2)
 return true
func _exit_tree():
 dispose_authoritative()
 super._exit_tree()
`;
const {assertEffectPlan}=require('../lib/effect-plan');
const EFFECT_BOOT=`extends "res://effect_scene_controller.gd"
@export var compiled_plan: Dictionary = {}
@export var compiled_catalog: Array = []
@export var compiled_targets: Dictionary = {}
var ready_for_effects=false
func _ready():
 call_deferred("_start_effects")
func _start_effects():
 if _disposed or ready_for_effects or not is_inside_tree() or is_queued_for_deletion() or get_parent().is_queued_for_deletion(): return
 var targets={}
 for id in compiled_targets: targets[id]=get_parent().get_node(compiled_targets[id])
 if not configure_trusted(compiled_plan,compiled_catalog,"visual-"+str(get_parent().get_instance_id()),targets):
  push_error("Compiled effect initialization failed")
  return
 ready_for_effects=true
`;
function validEffectPng(bytes){
 if(bytes.length<57||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return false;
 const crc=buffer=>{let value=0xffffffff;for(const byte of buffer){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;};
 let offset=8,width,height,ended=false,idat=false,closed=false;const compressed=[];
 while(offset<bytes.length){
  if(offset+12>bytes.length)return false;
  const length=bytes.readUInt32BE(offset),end=offset+12+length;
  if(end>bytes.length)return false;
  const type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,offset+8+length);
  if(crc(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))return false;
  if(offset===8){
   if(type!=='IHDR'||length!==13)return false;
   width=data.readUInt32BE(0);height=data.readUInt32BE(4);
   // Explicit initial subset: lossless non-interlaced RGBA8, no import transforms.
   if(!width||!height||width>4096||height>4096||data[8]!==8||data[9]!==6||data[10]||data[11]||data[12])return false;
  }else if(type==='IDAT'){if(closed)return false;idat=true;compressed.push(data);}
  else if(type==='IEND'){if(length||!idat||end!==bytes.length)return false;ended=true;break;}
  else {if(type==='IHDR'||!/^[a-z][A-Za-z]{3}$/.test(type))return false;if(idat)closed=true;}
  offset=end;
 }
 if(!ended)return false;
 try{const stride=width*4+1,raw=require('node:zlib').inflateSync(Buffer.concat(compressed),{maxOutputLength:stride*height});if(raw.length!==stride*height)return false;for(let row=0;row<height;row++)if(raw[row*stride]>4)return false;}catch{return false;}
 return true;
}
function prepareEffects(spec,build){
 const fail=message=>{throw new Error('Invalid effect build: '+message);};
 const object=v=>v&&Object.getPrototypeOf(v)===Object.prototype;
 const keys=(v,allowed)=>object(v)&&Object.keys(v).every(k=>allowed.includes(k));
 const token=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
 const vector=(v,n,min,max)=>Array.isArray(v)&&v.length===n&&v.every(x=>Number.isFinite(x)&&x>=min&&x<=max);
 if(!keys(build,['plan','inventory','bindings','resources','catalog','targets','styleHash'])||build.styleHash!==hashValue(spec.style)||!Array.isArray(build.resources)||build.resources.length>64||!Array.isArray(build.catalog)||build.catalog.length>64||!object(build.targets)||!Object.keys(build.targets).length||Object.keys(build.targets).length>64)fail('shape or stale style');
 if(build.plan?.characterId!==spec.id||build.inventory?.complete!==true)fail('root identity or incomplete inventory');
 const resources=new Map();let total=0;
 for(const r of build.resources){
  if(!keys(r,['hash','base64','size','importSettings','styleProvenance','approvalProvenance','path','kind','sha256'])||!/^[a-f0-9]{64}$/.test(r.hash)||resources.has(r.hash)||typeof r.base64!=='string'||r.base64.length>24*1024*1024||!Number.isSafeInteger(r.size)||r.size<1||r.size>16*1024*1024||!object(r.importSettings)||Object.keys(r.importSettings).length!==0||r.sha256!==undefined&&r.sha256!==r.hash||r.styleProvenance!==build.styleHash||typeof r.approvalProvenance!=='string'||!r.approvalProvenance.length||r.approvalProvenance.length>4096)fail('resource capture');
  const bytes=Buffer.from(r.base64,'base64');total+=bytes.length;
  if(bytes.toString('base64')!==r.base64||bytes.length!==r.size||total>32*1024*1024||crypto.createHash('sha256').update(bytes).digest('hex')!==r.hash)fail('resource hash or size');
  resources.set(r.hash,{...r,bytes});
 }
 const parts=new Set(spec.parts.map(p=>p.id)),sockets=new Set((spec.sockets||[]).map(s=>s.id)),targets=new Set();
 for(const [socket,target]of Object.entries(build.targets)){
  if(!token(socket)||!sockets.has(socket)||!keys(target,['partId'])||!parts.has(target.partId)||targets.has(target.partId))fail('explicit unique part target');
  targets.add(target.partId);
 }
 const ids=new Set(),catalog=[];
 function overlay(p,hashes,label){
  if(!keys(p,['resourceHash','offset','scale','animation'])||!hashes.includes(p.resourceHash)||!vector(p.offset,2,-4096,4096)||Math.hypot(...p.offset)>4096||!vector(p.scale,2,Number.MIN_VALUE,16)||p.scale.some(value=>!Number.isFinite(Math.fround(value))||Math.fround(value)<=0))fail(label+' parameters');
  const bytes=resources.get(p.resourceHash).bytes;
  if(!validEffectPng(bytes))fail(label+' PNG dimensions or RGBA8 encoding');
  if(Object.hasOwn(p,'animation'))try{normalizeEffectAnimation(p.animation,{width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)});}catch{fail(label+' animation descriptor or atlas dimensions');}
 }
 for(const entry of build.catalog){
  if(!keys(entry,['id','capability','resourceHashes','presentation','impact'])||!token(entry.id)||ids.has(entry.id)||!['tint','overlay'].includes(entry.capability)||!Array.isArray(entry.resourceHashes)||!entry.resourceHashes.length||entry.resourceHashes.length>8||new Set(entry.resourceHashes).size!==entry.resourceHashes.length||entry.resourceHashes.some(h=>!resources.has(h)))fail('catalog capability or capture');
  ids.add(entry.id);const p=entry.presentation;
  if(entry.capability==='tint'){
   if(!keys(p,['color'])||!vector(p.color,4,0,1))fail('tint RGBA');
  }else overlay(p,entry.resourceHashes,'overlay');
  if(Object.hasOwn(entry,'impact')){
   const impact=entry.impact;
   if(!keys(impact,['durationSeconds','presentation'])||!Number.isFinite(impact.durationSeconds)||impact.durationSeconds<=0||impact.durationSeconds>10)fail('impact duration or shape');
   overlay(impact.presentation,entry.resourceHashes,'impact overlay');
  }
  catalog.push({...entry,implemented:true,resources:entry.resourceHashes.map(h=>{const r=resources.get(h);return {sha256:h,importSettings:r.importSettings,styleProvenance:r.styleProvenance,approvalProvenance:r.approvalProvenance};})});
 }
 let plan;try{plan=assertEffectPlan(build.plan,{inventory:build.inventory,bindings:build.bindings,effects:catalog,sockets:[...sockets]});}catch(e){fail(e.message);}
 for(const d of plan.decisions)if(d.outcome==='effect'&&(!Object.hasOwn(build.targets,d.rule.socketId)||d.rule.effectIds.length>8))fail('rule target or selection capacity');
 // Check the worst-case union on each socket before native mutation.
 for(const socket of Object.keys(build.targets))for(const scope of ['whileActive','attackSnapshot'])if(new Set(plan.decisions.filter(d=>d.outcome==='effect'&&d.rule.socketId===socket&&d.rule.scope===scope).flatMap(d=>d.rule.effectIds)).size>8)fail('per-target effect capacity');
 return {plan,catalog:structuredClone(build.catalog),targets:structuredClone(build.targets),resources};
}

async function prepareComponent(entry,namespace){
 if(!/^components\/[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(namespace))throw new Error('Invalid owned component namespace');
 const root=await fs.realpath(entry.project),stage=await fs.realpath(entry.checkpoint.root);
 const artifacts=new Map(entry.checkpoint.artifacts.map(a=>[path.resolve(stage,a.path),a]));
 const pending=[path.relative(root,entry.scene).replaceAll('\\','/')],files=new Map();let total=0;
 while(pending.length){
  const relative=pending.pop();
  if(files.has(relative))continue;
  if(!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:tscn|tres|res|gd|png|wav|ogg)$/.test(relative)||relative.split('/').includes('..')) throw new Error('Unsafe component runtime resource');
  const absolute=path.resolve(root,relative),real=await fs.realpath(absolute);
  if(real!==absolute||!real.startsWith(root+path.sep))throw new Error('Component resource escapes owned project');
  const artifact=artifacts.get(absolute),bytes=await fs.readFile(absolute);
  total+=bytes.length;if(total>256*1024*1024||files.size>=10000)throw new Error('Component runtime resource budget exceeded');
  if(!artifact||artifact.size!==bytes.length||artifact.hash!==crypto.createHash('sha256').update(bytes).digest('hex'))throw new Error('Component resource failed verified artifact hash');
  let output=bytes;
  if(/\.(tscn|tres|gd)$/.test(relative)){
   const source=bytes.toString('utf8');
   if(/(?:["']\s*[A-Za-z]:[\\/]|file:\/\/|user:\/\/)/.test(source))throw new Error('External component resource path');
   const references=[...source.matchAll(/res:\/\/([A-Za-z0-9_./-]+)/g)].map(m=>m[1]);
   pending.push(...references);
   output=Buffer.from(source.replaceAll('res://',`res://${namespace}/`));
  }
  files.set(relative,output);
 }
 return {namespace,files,scene:`${namespace}/${path.relative(root,entry.scene).replaceAll('\\','/')}`};
}
function validateGodotSpec(spec, {components=false}={}) {
  if (spec.animations?.length > 64) throw new Error('Native animation budget exceeded (64 clips including non-rendered builds)');
  for (const field of ['components']) {
    if (spec[field]?.length && !components) throw new Error(`A verified component registry is required for ${field}`);
  }
  if (spec.export?.target === 'sts2' && spec.export.playback !== 'tree') throw new Error('STS2 graphics require explicit tree playback');
  for (const part of spec.parts) {
    if(!Number.isInteger(part.layer)||part.layer < -4096||part.layer > 4096)throw new Error('Native part layer must be an integer in -4096..4096');
    if (!part.image?.prepared) throw new Error('Every image must be prepared');
    if(part.image.width>4096||part.image.height>4096)throw new Error('Native lossless texture dimensions exceed 4096 pixels');
    const m = part.mesh;
    if (m) {
      if (m.weights.some(w => w.length > 4)) throw new Error('Godot supports at most four bone influences');
      if (m.uv.some(([x, y]) => x < 0 || y < 0 || x > part.image.width || y > part.image.height)) throw new Error('UV outside texture pixels');
    }
  }
  assertSpec(spec);
  for (const socket of spec.sockets || []) if(Object.values(socket.inheritance).some(value=>!value)) throw new Error('Partial socket inheritance requires W5 assembly');
  for (const clip of spec.animations) {
    if (clip.events.some(e => e.payload?.type && e.payload.type !== 'marker')) throw new Error('Typed sound/projectile events require their runtime provider');
    for (const track of clip.tracks) for (const key of track.keys) {

      const bone = spec.bones.find(b => b.id === track.bone);
      if (track.property === 'rotation' && bone.limits && (key.value < bone.limits[0] || key.value > bone.limits[1])) throw new Error('Animation exceeds joint limits');
    }
  }
  return spec;
}
function geometryBounds(spec){
 const loops=spec.animations.filter(c=>c.loop),vertices=spec.parts.reduce((n,p)=>n+(p.mesh?.vertices.length??4),0);
 let elements=0,keys=0;
 for(const p of spec.parts)elements+=(p.mesh?.vertices.length??4)*(p.mesh?new Set(p.mesh.weights.flat().filter(w=>w.weight>0).map(w=>w.bone)).size:1);
 for(const c of loops)keys+=spec.bones.length*3+c.tracks.reduce((n,t)=>n+t.keys.length-1,0);
 if(spec.bones.length>128||spec.parts.length>128||loops.length>32||spec.bones.length*loops.length>4096||vertices>8192||elements>262144||keys>65536||loops.some(c=>c.duration>60))throw Object.assign(new Error('Rendered native geometry inspection exceeds its supported bone/mesh/loop/weight/key budget'),{code:'CAPABILITY_MISSING'});
 const matrices=new Map(),bones=new Map(spec.bones.map(b=>[b.id,b]));
 const matrix=id=>{
  if(matrices.has(id))return matrices.get(id);
  const bone=bones.get(id),r=bone.rest,c=Math.cos(r.rotation),sn=Math.sin(r.rotation);
  const m=[c*r.scale[0],sn*r.scale[0],-sn*r.scale[1],c*r.scale[1],...r.position];
  let result=m;
  if(bone.parent!==null){const p=matrix(bone.parent);result=[p[0]*m[0]+p[2]*m[1],p[1]*m[0]+p[3]*m[1],p[0]*m[2]+p[2]*m[3],p[1]*m[2]+p[3]*m[3],p[0]*m[4]+p[2]*m[5]+p[4],p[1]*m[4]+p[3]*m[5]+p[5]];}
  matrices.set(id,result);return result;
 };
 const restAnchors=spec.parts.map(part=>{
  const m=matrix(part.bone),v=part.mesh?.vertices[0]??[0,0],im=part.image,x=(v[0]-im.pivot[0])/im.pixelsPerUnit,y=(v[1]-im.pivot[1])/im.pixelsPerUnit;
  const anchor=[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
  if(anchor.some(n=>!Number.isFinite(n)||Math.abs(n)>1e6))throw Object.assign(new Error('Rendered native rest registration exceeds canonical coordinate bounds'),{code:'CAPABILITY_MISSING'});
  return {id:part.id,path:'Meshes/'+part.id,restAnchor:anchor};
 });
 return {vertices,loopJointPairs:spec.bones.length*loops.length,restAnchors};
}
function geometryReport(raw,expected){
 const reject=(message,diagnostics)=>{throw Object.assign(new Error(message),{code:'VISUAL_VALIDATION_FAILED',diagnostics});};
 if(!raw||raw.requested!==true||raw.result?.ok!==true||Buffer.byteLength(JSON.stringify(raw))>2097152)reject('Native geometry evidence is missing, unsupported or oversized',raw?.result?.error??null);
 const result=raw.result;let report;
 try{report=validateTelemetry(result.telemetry);}catch(cause){reject('Native geometry telemetry is malformed',[{code:cause.code,path:cause.path}]);}
 const coverage=result.collectorCoverage;
 const uncovered=['attachments','movingAttachments','skinnedVertices','triangles','strain','frameJumps','runtimeConstraints','actionGeometry','mixerBlends','assemblyTransitions'];
 if(coverage?.weightVertices!==expected.vertices||coverage?.loopJointPairs!==expected.loopJointPairs||report.coverage.weights!==expected.vertices||report.coverage.loopEndpoints!==expected.loopJointPairs||!Array.isArray(coverage.uncovered)||uncovered.some(k=>!coverage.uncovered.includes(k))||!result.sourceMap||typeof result.sourceMap!=='object')reject('Native geometry evidence coverage does not match the compiled parent');
 const anchors=result.telemetry.attachments,map=result.sourceMap.attachments;
 if(coverage.restAnchors!==expected.restAnchors.length||coverage.scope!=='static-representative-vertex-registration'||!map||typeof map!=='object'||Array.isArray(map)||Object.keys(map).length!==expected.restAnchors.length||anchors.length!==expected.restAnchors.length)reject('Native rest registration evidence count or scope is invalid');
 for(let i=0;i<expected.restAnchors.length;i++){
  const e=expected.restAnchors[i],id='attachment'+i,a=anchors[i],entry=map[id];
  if(!a||a.id!==id||a.phase!=='rest'||!Array.isArray(a.expected)||a.expected.length!==2||a.expected.some((v,k)=>v!==e.restAnchor[k])||!Array.isArray(a.actual)||a.actual.length!==2||a.actual.some(v=>!Number.isFinite(v)||Math.abs(v)>1e6)||!entry||Object.keys(entry).sort().join(',')!=='meshId,path,vertex'||entry.meshId!==e.id||entry.path!==e.path||entry.vertex!==0)reject('Native rest registration evidence does not match the compiled parent');
 }
 if(report.status==='failed')reject('Native geometry inspection found sampled defects',report.failures);
 return {status:report.status,scope:'parent-authored-pose',componentGeometry:'uncovered',...result,report};
}
function layerOrderReport(spec,raw){
 const invalid=message=>{throw Object.assign(new Error('Native layer evidence is malformed: '+message),{code:'VISUAL_VALIDATION_FAILED',diagnostics:[{code:'INVALID_NATIVE_LAYER_EVIDENCE',message}]});};
 const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
 const exact=(v,fields)=>object(v)&&Object.keys(v).sort().join(',')===[...fields].sort().join(',');
 const flags=['zIndex','zAsRelative','showBehindParent','topLevel','ySortEnabled'];
 const validFlags=v=>Number.isSafeInteger(v.zIndex)&&flags.slice(1).every(k=>typeof v[k]==='boolean');
 if(!exact(raw,['version','root','container','parts'])||raw.version!==1||!exact(raw.root,flags)||!exact(raw.container,flags)||!validFlags(raw.root)||!validFlags(raw.container)||!Array.isArray(raw.parts)||raw.parts.length>128)invalid('shape, types or byte budget');
 const seen=new Set();
 for(const part of raw.parts){
  if(!exact(part,[...flags,'id','path','index'])||!validFlags(part)||typeof part.id!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(part.id)||seen.has(part.id)||part.path!=='Meshes/'+part.id||!Number.isSafeInteger(part.index)||part.index<0||part.index>127)invalid('part identity, path, index or fields');
  seen.add(part.id);
 }
 // Shape/type checks above bound depth before serializing native JSON.
 if(Buffer.byteLength(JSON.stringify(raw))>65536)invalid('byte budget');
 // All receipt records are validated before any measured comparison.
 const report={version:1,status:spec.parts.length?'passed':'unverified',scope:'static-parent-authored-draw-order',specHash:hashValue(spec),partCount:spec.parts.length,checkedPairs:0,visualQuality:'unverified',outsideScope:['alpha-occlusion','semantic-overlap','outline-appearance','visual-states','action-hiding','projectiles','effects','components','runtime-ordering','artistic-quality'],failures:[],failureCount:0,failuresTruncated:false};
 const fail=(code,identity,field,expected,actual)=>{report.failureCount++;if(report.failures.length<128)report.failures.push({code,...identity,field,expected,actual});};
 const defaults={zIndex:0,zAsRelative:true,showBehindParent:false,topLevel:false,ySortEnabled:false};
 for(const node of ['root','container'])for(const key of flags)if(raw[node][key]!==defaults[key])fail('NATIVE_LAYER_MISMATCH',{node},key,defaults[key],raw[node][key]);
 if(raw.parts.length!==spec.parts.length)fail('NATIVE_PART_ORDER',{node:'container'},'partCount',spec.parts.length,raw.parts.length);
 for(let i=0;i<spec.parts.length;i++){
  const expected=spec.parts[i],part=raw.parts[i];
  if(i>0&&spec.parts[i-1].layer===expected.layer)report.checkedPairs++;
  if(!part)continue;
  const identity={partId:expected.id,index:i};
  for(const [field,value]of Object.entries({id:expected.id,path:'Meshes/'+expected.id,index:i}))if(part[field]!==value)fail('NATIVE_PART_ORDER',identity,field,value,part[field]);
  for(const key of flags){const value=key==='zIndex'?expected.layer:defaults[key];if(part[key]!==value)fail('NATIVE_LAYER_MISMATCH',identity,key,value,part[key]);}
 }
 report.failuresTruncated=report.failureCount>report.failures.length;
 if(report.failureCount){report.status='failed';throw Object.assign(new Error('Native authored layer or sibling order differs'),{code:'VISUAL_VALIDATION_FAILED',diagnostics:report.failures,report});}
 return report;
}
async function bindMaskCaptures(plan,raw,project){
 const bad=message=>{throw Object.assign(new Error('Native mask evidence is malformed: '+message),{code:'VISUAL_VALIDATION_FAILED',diagnostics:[{code:'INVALID_NATIVE_MASK_EVIDENCE',message}]});};
 if(raw===undefined&&plan.captures.length===0)return [];
 if(!Array.isArray(raw)||raw.length!==plan.captures.length||raw.length>64)bad('capture count');
 const keys=['id','partId','clipId','time','frameIndex','path','width','height','sha256'].sort().join(',');
 const result=[];
 for(let i=0;i<raw.length;i++){
  const item=raw[i],expected=plan.captures[i];
  if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join(',')!==keys)bad('capture shape');
  for(const key of ['id','partId','clipId','time','frameIndex'])if(item[key]!==expected[key])bad('capture identity or order');
  if(item.path!==expected.filename||item.width!==plan.renderLayout.pixels[0]||item.height!==plan.renderLayout.pixels[1]||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256))bad('capture path, dimensions or hash');
  const file=path.join(project,expected.filename);let info,bytes;
  try{info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>4*1024*1024)bad('capture file type or size');bytes=await fs.readFile(file);}catch(error){if(error.code==='VISUAL_VALIDATION_FAILED')throw error;bad('capture file missing');}
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==item.sha256)bad('capture file hash');
  if(bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(16)!==item.width||bytes.readUInt32BE(20)!==item.height)bad('capture PNG dimensions');
  result.push({...item,path:file});
 }
 return result;
}
async function compileGodot(spec, {
  config,
  stagingDir,
  runTool = defaultRunTool,
  signal,
  render = false
  ,componentProjects = {}, componentRegistry = [], componentDescriptors = [], assemblyContract, effectBuild
} = {}) {
  validateGodotSpec(spec,{components:!!componentDescriptors.length});
  const geometry=render?geometryBounds(spec):null;
  const effects=effectBuild===undefined?null:prepareEffects(spec,effectBuild);
  let assembly;
  if(componentDescriptors.length){
    if(!assemblyContract) throw new Error('Missing assembly contract');
    if(hashValue(spec.style)!==assemblyContract.styleHash)throw new Error('Assembly style differs from parent style');
    for(const c of spec.components)if(c.transform&&(c.transform.rotation!==0||c.transform.position.some(n=>n!==0)||c.transform.scale.some(n=>n!==1)))throw new Error('Unsupported component instance transform; use explicit descriptor mount');
    const sockets=spec.sockets.filter(s=>s.types.some(type=>componentDescriptors.some(d=>d.type===type)));
    for(const socket of sockets) if(!Number.isInteger(socket.capacity)||socket.capacity<1||socket.capacity>64) throw new Error('Unsupported component socket capacity');
    if(sockets.reduce((total,socket)=>total+socket.capacity,0)>64)throw new Error('Native component socket budget exceeded (64 total selected assembly slots)');
    const registry={sockets,descriptors:componentDescriptors,...assemblyContract};
    const planner=createAssemblyPlanner(registry);
    const previewSnapshot={version:1,instanceId:spec.id,revision:1,sequence:0,lifecycle:'alive',visualMode:'idle',components:spec.components.map(c=>({id:c.id,socket:c.socket,type:c.type,revision:1,damageState:'intact',upgrade:0,visualMode:'idle'}))};
    planner.bootstrap(previewSnapshot);
    assembly={registry,descriptors:componentDescriptors,sockets:sockets.map(s=>s.id),previewSnapshot,scenes:{}};
    for(const d of componentDescriptors){
      const definition=componentRegistry.find(n=>n.types?.includes(d.type))||componentRegistry.find(n=>n.id===d.type);
      const entry=componentProjects[definition?.id||d.type];
      if(!entry?.checkpoint?.root||!Array.isArray(entry.checkpoint.artifacts)) throw new Error('Missing verified component registry project');
      if(hashValue(entry.spec.style)!==d.styleHash||d.dimensions[0]!==entry.spec.canvas.width||d.dimensions[1]!==entry.spec.canvas.height)throw new Error('Component dimensions or style differ from descriptor');
      const events=componentEventNames(entry.spec);
      if(JSON.stringify(events)!==JSON.stringify([...d.eventNames].sort()))throw new Error('Component events differ from descriptor');
      if(Object.hasOwn(d,'transitions'))assertTransitionClipCompatibility(d.transitions,entry.spec);
    }
    // Validate every child before staging even the first verified project.
    for(const d of componentDescriptors){
      const definition=componentRegistry.find(n=>n.types?.includes(d.type))||componentRegistry.find(n=>n.id===d.type);
      const entry=componentProjects[definition?.id||d.type];
      assembly.scenes[d.type]=await prepareComponent(entry,`components/${definition?.id||d.type}`);
    }
  }
  if (render && spec.animations.length > 32) throw new Error('Render sample budget exceeded (32 clips)');
  const project = path.resolve(stagingDir, 'godot');
  await fs.mkdir(project, {
    recursive: true
  });
  const copy = structuredClone(spec);
  const motionPlan=render&&spec.animations.length?planMotionSampling(spec.animations,{framesPerSecond:16,maxFramesPerClip:64,maxTotalFrames:64}):null;
  const renderLayout=render?planRenderViewport(spec.canvas,Math.max(1,motionPlan?.clips.reduce((count,clip)=>count+clip.times.length,0)??0)):null;
  const maskPlan=render?planPartMasks(spec,motionPlan,renderLayout):null;
  if(render){copy.maskPlan=maskPlan;copy.motionPlan=motionPlan;copy.nativeRestAnchors=geometry.restAnchors;}
  if(renderLayout)copy.renderLayout=renderLayout;
  if(render)copy.planNumberBits=planNumberBits({motionPlan,maskPlan,nativeRestAnchors:copy.nativeRestAnchors,renderLayout});
  if(assembly){
    const scenes={};
    for(const [type,prepared] of Object.entries(assembly.scenes)){
      scenes[type]=prepared.scene;
      for(const [relative,bytes]of prepared.files){const target=path.join(project,prepared.namespace,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);}
    }
    copy.components=copy.components.map(c=>({...c,spec:componentDescriptors.find(d=>d.type===c.type).spec}));
    copy.assembly={registry:assembly.registry,descriptors:assembly.descriptors,sockets:assembly.sockets,previewSnapshot:assembly.previewSnapshot,scenes};
    for(const name of ['assembly_controller.gd','component_controller.gd','assembly_planner.gd','state_reconciler.gd','assembly_transport.gd']) await fs.copyFile(path.join(__dirname,'../godot',name),path.join(project,name));
    await fs.writeFile(path.join(project,'assembly_boot.gd'),ASSEMBLY_BOOT);
  }
  if(effects){
    // Keep source evidence in the development spec audit, never in a shipped
    // PackedScene. Only validated playback fields cross the runtime boundary.
    const runtimePlan={adapterContractVersion:effects.plan.adapterContractVersion,decisions:effects.plan.decisions.filter(d=>d.outcome==='effect').map(({id,mechanicKey,outcome,bindingId,rule})=>({id,mechanicKey,outcome,bindingId,rule:structuredClone(rule)}))};
    copy.effectBuild={plan:effects.plan,runtimePlan,catalog:effects.catalog,targets:effects.targets};
    for(const hash of new Set(effects.catalog.flatMap(e=>[...(e.capability==='overlay'?[e.presentation.resourceHash]:[]),...(e.impact?[e.impact.presentation.resourceHash]:[])]))) await fs.writeFile(path.join(project,'effect-'+hash+'.png'),effects.resources.get(hash).bytes);
    for(const name of ['effect_scene_controller.gd','effect_rule_controller.gd','effect_controller.gd','impact_controller.gd']) await fs.copyFile(path.join(__dirname,'../godot',name),path.join(project,name));
    await fs.writeFile(path.join(project,'effect_boot.gd'),EFFECT_BOOT);
  }
  const usedSounds = new Set(spec.animations.flatMap(clip => clip.events.filter(event => event.type === 'sound').map(event => event.payload.sound)));
  const usedProjectiles = new Set(spec.animations.flatMap(clip => clip.events.filter(event => event.type === 'projectile').map(event => event.payload.projectile)));
  if (copy.projectiles) copy.projectiles = copy.projectiles.filter(definition => usedProjectiles.has(definition.id));
  for (const definition of copy.projectiles || []) if (definition.impactSound) usedSounds.add(definition.impactSound);
  if (copy.sounds) copy.sounds = copy.sounds.filter(sound => usedSounds.has(sound.id));
  const audioMetadata = {};
  const checkedSounds = new Map();
  for (const sound of copy.sounds || []) {
    let metadata = checkedSounds.get(sound.path);
    if (!metadata) {
      metadata = await runAudioOperation('inspect',sound.path,{config,stagingDir,runTool,signal});
      checkedSounds.set(sound.path,metadata);
    }
    const bytes = await readBounded(sound.path);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== metadata.sourceHash) throw new Error('Audio changed after decoder validation');
    const dest = 'audio-' + metadata.sourceHash + (metadata.format === 'wav' ? '.wav' : '.ogg');
    await fs.writeFile(path.join(project,dest),bytes);
    sound.path = dest;
    audioMetadata[sound.id] = metadata;
  }
  if (copy.sounds?.length) copy.audioMetadata = audioMetadata;
  copy.parts=copy.parts.map(part=>({...part,image:{...part.image}}));
  for (const part of copy.parts) {
    const dest = `texture-${part.id}.png`;
    await fs.copyFile(part.image.path, path.join(project, dest));
    part.image.path = dest;
  }
  await fs.writeFile(path.join(project, 'spec.json'), JSON.stringify(copy));
  await fs.copyFile(path.join(__dirname, '../godot/compile.gd'), path.join(project, 'compile.gd'));
  if(render)await fs.copyFile(path.join(__dirname,'../godot/telemetry.gd'),path.join(project,'telemetry.gd'));
  await fs.copyFile(path.join(__dirname, '../godot/texture_storage.gd'), path.join(project, 'texture_storage.gd'));
  await fs.copyFile(path.join(__dirname, '../godot/limited_bone.gd'), path.join(project, 'limited_bone.gd'));
  await fs.copyFile(path.join(__dirname, '../godot/animation_controller.gd'), path.join(project, 'animation_controller.gd'));
  await fs.copyFile(path.join(__dirname, '../godot/audio_controller.gd'), path.join(project, 'audio_controller.gd'));
  await fs.copyFile(path.join(__dirname, '../godot/visual_state_controller.gd'), path.join(project, 'visual_state_controller.gd'));
  await fs.copyFile(path.join(__dirname, '../godot/action_controller.gd'), path.join(project, 'action_controller.gd'));
  await fs.copyFile(path.join(__dirname, '../godot/pose_controller.gd'), path.join(project, 'pose_controller.gd'));
  await fs.writeFile(path.join(project, 'project.godot'), 'config_version=5\n[application]\nconfig/name="Character pipeline"\nrun/main_scene="res://character.tscn"\n[display]\nwindow/size/viewport_width=PREVIEW_WIDTH\nwindow/size/viewport_height=PREVIEW_HEIGHT\n[rendering]\nrenderer/rendering_method="gl_compatibility"\nenvironment/defaults/default_clear_color=Color(0,0,0,0)\n'.replace('PREVIEW_WIDTH',renderLayout?.pixels[0]??512).replace('PREVIEW_HEIGHT',renderLayout?.pixels[1]??512));
  const registry = config.tools || config;
  const name = registry.megadot ? 'megadot' : 'godot';
  const tool = registry[name];
  if (!tool) throw new Error('Godot executable is not configured');
  if (runTool === defaultRunTool && /mono|megadot/i.test(tool.executable)) {
    try {
      await fs.access(path.join(path.dirname(tool.executable), 'GodotSharp/Api/Debug/GodotSharp.dll'));
    } catch (cause) {
      throw Object.assign(new Error('Godot .NET runtime is inaccessible. Run the native harness with access to the installed GodotSharp runtime; use the tool directory as cwd.'), {
        code: 'CAPABILITY_MISSING',
        cause
      });
    }
  }
  const owned = {
    [name]: {
      ...tool,
      cwd: path.dirname(tool.executable)
    }
  };
  const log = path.join(project, 'native.log');
  await fs.rm(path.join(project, 'validation.json'), {
    force: true
  });
  const args = [...(render ? ['--rendering-method', 'gl_compatibility', '--position', '-10000,-10000'] : ['--headless']), '--path', project, '--log-file', log, '--script', 'res://compile.gd', ...(render ? ['--', 'render'] : [])];
  const result = await runTool(owned, name, args, {
    signal,
    timeoutMs: 60000
  });
  await fs.writeFile(path.join(project, 'process.json'), JSON.stringify(result, null, 2));
  if (result.exitCode !== 0 || result.error || /SCRIPT ERROR|Parse Error|ERROR:/.test(result.stdout + result.stderr)) throw Object.assign(new Error('Godot compilation failed: ' + result.stdout + result.stderr), {
    code: 'GODOT_FAILED'
  });
  const validation = JSON.parse(await fs.readFile(path.join(project, 'validation.json'), 'utf8'));
  if(render){
    const expectedProjection={pixels:[...renderLayout.pixels],transform:[Math.fround(renderLayout.scale),0,0,Math.fround(renderLayout.scale),0,0]};
    if(hashValue(validation.renderLayout??null)!==hashValue(renderLayout)||hashValue(validation.renderProjection??null)!==hashValue(expectedProjection))throw Object.assign(new Error('Native render projection differs from planned canonical canvas'),{code:'VISUAL_VALIDATION_FAILED'});
    const expectedSamples=motionPlan?.clips.flatMap(clip=>clip.times.map(time=>({clip:clip.id,time})))??[];
    const actualSamples=Array.isArray(validation.samples)?validation.samples.map(sample=>({clip:sample?.clip,time:sample?.time})):null;
    const expectedFrames=expectedSamples.map((sample,index)=>'frame-'+sample.clip+'-'+index+'.png');
    if(hashValue(validation.motionPlan??null)!==hashValue(motionPlan)||hashValue(actualSamples)!==hashValue(expectedSamples)||hashValue(validation.frames??null)!==hashValue(expectedFrames))throw Object.assign(new Error('Native motion sampling differs from planned timeline or frame order'),{code:'VISUAL_VALIDATION_FAILED'});
  }
  const maskCaptures=render?await bindMaskCaptures(maskPlan,validation.maskCaptures,project):[];
  validation.partMasks=render?{status:maskPlan.status,planHash:maskPlan.planHash,captureCount:maskCaptures.length}:{status:'not-requested'};
  try {
    validation.motionRegistration=render?inspectMotionRegistration(spec,motionPlan,validation.samples):{status:'not-requested',scope:'sampled-bone-origins'};
  } catch(error) {
    if(error.code==='INVALID_NATIVE_MOTION')throw Object.assign(new Error('Native motion evidence is malformed: '+error.message),{code:'VISUAL_VALIDATION_FAILED',diagnostics:[{code:'INVALID_NATIVE_MOTION',message:error.message}]});
    throw error;
  }
  validation.geometry=render?geometryReport(validation.geometry,geometry):{status:'not-requested',scope:'parent-authored-pose',componentGeometry:'uncovered'};
  try {
    validation.nativeSkinning=render?inspectNativeSkinning(spec,motionPlan,validation.skinning):{status:'not-requested',scope:'native-matrix-projected-triangles'};
  } catch(error) {
    if(error.code==='INVALID_NATIVE_SKINNING')throw Object.assign(new Error('Native skinning evidence is malformed: '+error.message),{code:'VISUAL_VALIDATION_FAILED',diagnostics:[{code:'INVALID_NATIVE_SKINNING',message:error.message}]});
    throw error;
  }
  validation.nativeLayerOrder=render?layerOrderReport(spec,validation.layerOrder):{status:'not-requested',scope:'static-parent-authored-draw-order'};
  if (!validation.valid) throw new Error('Godot native validation failed');
  if(effects){
    const expectedCapabilities=[...new Set(effects.catalog.map(e=>e.capability))].sort(),expectedHashes=[...new Set(effects.catalog.flatMap(e=>e.resourceHashes))].sort();
    if(validation.effects?.configured!==true||validation.effects.gameBindings!==false||typeof validation.effects.owner!=='string'||!validation.effects.owner.startsWith('visual-')||JSON.stringify([...(validation.effects.capabilities||[])].sort())!==JSON.stringify(expectedCapabilities)||JSON.stringify([...(validation.effects.resourceHashes||[])].sort())!==JSON.stringify(expectedHashes))throw new Error('Godot effect validation metadata differs from compiled contract');
    const impactIds=effects.catalog.filter(effect=>effect.impact).map(effect=>effect.id).sort();
    if(impactIds.length&&(validation.effects.impactConfigured!==true||!Array.isArray(validation.effects.impactEffectIds)||JSON.stringify([...validation.effects.impactEffectIds].sort())!==JSON.stringify(impactIds)))throw new Error('Godot impact validation metadata differs from compiled contract');
  }
  const relative = {
    project: 'godot',
    scene: 'godot/character.tscn',
    frames: validation.frames.map(f => 'godot/' + f),
    log: 'godot/native.log'
  };
  await fs.writeFile(path.join(project, 'artifacts.json'), JSON.stringify(relative, null, 2));
  return {
    project,
    scene: path.join(project, 'character.tscn'),
    validation,
    maskPlan,
    maskCaptures,
    frames: validation.frames.map(f => path.join(project, f)),
    log,
    relative
  };
}
module.exports = {
  compileGodot,
  validateGodotSpec
};








