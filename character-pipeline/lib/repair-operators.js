'use strict';
// Pure authored-data correction only. A trusted host supplies diagnosis/source
// mapping; this module neither diagnoses rendered failures nor certifies a fix.
const {hashValue}=require('./assets');
const TOKEN=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/,HASH=/^[a-f0-9]{64}$/;
const fail=message=>{throw Object.assign(new Error(message),{code:'INVALID_REPAIR_OPERATOR'});};
function copy(input){
 let nodes=100000;
 function visit(value,depth){
  if(--nodes<0||depth>32)fail('Authored data exceeds traversal bounds');
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number'){if(!Number.isFinite(value))fail('Nonfinite authored data');return value;}
  if(typeof value==='string'){if(value.length>1048576)fail('Authored string exceeds bounds');return value;}
  if(!value||typeof value!=='object')fail('Plain authored data required');
  const array=Array.isArray(value),proto=Object.getPrototypeOf(value);
  if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)fail('Plain authored data required');
  const keys=Reflect.ownKeys(value),out=array?[]:{};
  if(keys.length>8193)fail('Authored collection exceeds bounds');
  for(const key of keys){
   if(array&&key==='length')continue;
   if(typeof key!=='string'||['__proto__','constructor','prototype'].includes(key))fail('Unsafe authored key');
   const d=Object.getOwnPropertyDescriptor(value,key);
   if(!d.enumerable||!Object.hasOwn(d,'value')||array&&!/^(0|[1-9][0-9]*)$/.test(key))fail('Enumerable data fields required');
   out[key]=visit(d.value,depth+1);
  }
  if(array&&(out.length!==value.length||keys.length!==value.length+1))fail('Dense authored arrays required');
  return out;
 }
 const result=visit(input,0);if(Buffer.byteLength(JSON.stringify(result))>1048576)fail('Authored data exceeds byte bound');return result;
}
function fields(value,names){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==names.length||names.some(k=>!Object.hasOwn(value,k)))fail('Unsupported operator fields');}
function token(value){if(typeof value!=='string'||!TOKEN.test(value))fail('Invalid stable ID');}
function indexById(collection,max){
 if(!Array.isArray(collection)||!collection.length||collection.length>max)fail('Invalid authored collection');
 const map=new Map();for(const item of collection){if(!item||typeof item!=='object')fail('Invalid authored item');token(item.id);if(map.has(item.id))fail('Ambiguous authored ID');map.set(item.id,item);}return map;
}
function verifiedDependency(candidate,id){
 token(id);if(!Array.isArray(candidate.dependencies)||candidate.dependencies.length>256)fail('Dependency receipts required');
 const deps=new Set();let changed;
 for(const dependency of candidate.dependencies){fields(dependency,['id','hash']);token(dependency.id);if(deps.has(dependency.id)||typeof dependency.hash!=='string'||!HASH.test(dependency.hash))fail('Invalid dependency receipt');deps.add(dependency.id);if(dependency.id===id)changed=dependency;}
 if(!changed||changed.hash!==hashValue(candidate.value))fail('Dependency must identify exact authored specification');
 return changed;
}
function closeLoopPose(candidate,diagnosis,p){
 fields(p,['clipId','dependencyId']);token(p.clipId);
 if(diagnosis.code!=='LOOP_SEAM'||diagnosis.asset!==p.clipId)fail('Explicit loop diagnosis target required');
 const spec=candidate.value,bones=indexById(spec.bones,256),clip=indexById(spec.animations,256).get(p.clipId);
 if(!clip||clip.loop!==true||!Number.isFinite(clip.duration)||clip.duration<1e-6||clip.duration>600||!Array.isArray(clip.tracks)||!clip.tracks.length||clip.tracks.length>768)fail('Complete bounded looping clip required');
 const owned=new Set();let differs=false;
 for(const track of clip.tracks){
  fields(track,['bone','property','keys']);token(track.bone);
  const target=track.bone+':'+track.property;
  if(!bones.has(track.bone)||!['position','rotation','scale'].includes(track.property)||owned.has(target)||!Array.isArray(track.keys)||track.keys.length<2||track.keys.length>600)fail('Invalid or ambiguous local track');
  owned.add(target);let previous=-1;
  for(const key of track.keys){
   fields(key,key&&Object.hasOwn(key,'easing')?['time','value','easing']:['time','value']);
   if(!Number.isFinite(key.time)||key.time<0||key.time<=previous||key.time>clip.duration||Object.hasOwn(key,'easing')&&!['linear','in','out','inOut','step'].includes(key.easing))fail('Invalid authored key');
   previous=key.time;
   const bounded=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e6;
   if(track.property==='rotation'?!bounded(key.value):!Array.isArray(key.value)||key.value.length!==2||!key.value.every(bounded)||track.property==='scale'&&key.value.some(v=>v<=0))fail('Invalid authored pose value');
  }
  if(track.keys[0].time!==0||track.keys.at(-1).time!==clip.duration)fail('Every track must have explicit start and end keys');
  if(JSON.stringify(track.keys[0].value)!==JSON.stringify(track.keys.at(-1).value))differs=true;
 }
 if(!differs)fail('Authored local pose is already closed');
 const changed=verifiedDependency(candidate,p.dependencyId);
 // Explicitly close the complete authored local pose. World-space seams and
 // runtime constraints still require a fresh native/rendered inspection.
 for(const track of clip.tracks)track.keys.at(-1).value=structuredClone(track.keys[0].value);
 changed.hash=hashValue(spec);return {candidate,invalidated:[p.dependencyId]};
}
function dampenClipPose(candidate,diagnosis,p){
 fields(p,['clipId','dependencyId','sourceSpecHash','factor']);token(p.clipId);
 if(diagnosis.code!=='AUTHORED_DEFORMATION'||diagnosis.asset!==p.clipId||p.factor!==.5||typeof p.sourceSpecHash!=='string'||!HASH.test(p.sourceSpecHash)||p.sourceSpecHash!==hashValue(candidate.value))fail('Explicit current authored deformation target required');
 const changed=verifiedDependency(candidate,p.dependencyId),spec=candidate.value,bones=indexById(spec.bones,256),clip=indexById(spec.animations,256).get(p.clipId);
 if(!clip||!Number.isFinite(clip.duration)||clip.duration<1e-6||clip.duration>600||!Array.isArray(clip.tracks)||!clip.tracks.length||clip.tracks.length>768)fail('Complete bounded authored clip required');
 const bounded=n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=1e6,pair=v=>Array.isArray(v)&&v.length===2&&v.every(bounded),owned=new Set();let differs=false;
 for(const track of clip.tracks){
  fields(track,['bone','property','keys']);token(track.bone);const bone=bones.get(track.bone),target=track.bone+':'+track.property;
  if(!bone||!['position','rotation','scale'].includes(track.property)||owned.has(target)||!Array.isArray(track.keys)||!track.keys.length||track.keys.length>600)fail('Invalid or ambiguous local track');
  owned.add(target);const rest=bone.rest,hasLimits=Object.hasOwn(bone,'limits');
  if(!rest||!pair(rest.position)||!bounded(rest.rotation)||!pair(rest.scale)||rest.scale.some(n=>n===0)||hasLimits&&(!pair(bone.limits)||bone.limits[0]>bone.limits[1]||rest.rotation<bone.limits[0]||rest.rotation>bone.limits[1]))fail('Valid bounded authored rest and limits required');
  let previous=-1;
  for(const key of track.keys){
   fields(key,key&&Object.hasOwn(key,'easing')?['time','value','easing']:['time','value']);
   if(!bounded(key.time)||key.time<0||key.time<=previous||key.time>clip.duration||Object.hasOwn(key,'easing')&&!['linear','in','out','inOut','step'].includes(key.easing))fail('Invalid authored key');previous=key.time;
   if(track.property==='rotation'?!bounded(key.value)||hasLimits&&(key.value<bone.limits[0]||key.value>bone.limits[1]):!pair(key.value)||track.property==='scale'&&key.value.some((v,i)=>v===0||Math.sign(v)!==Math.sign(rest.scale[i])))fail('Unsafe authored pose value');
   const baseline=rest[track.property];if(Array.isArray(baseline)?key.value.some((v,i)=>baseline[i]+(v-baseline[i])*.5!==v):baseline+(key.value-baseline)*.5!==key.value)differs=true;
  }
 }
 if(!differs)fail('Authored clip already matches rest');
 for(const track of clip.tracks){const rest=bones.get(track.bone).rest[track.property];for(const key of track.keys)key.value=Array.isArray(rest)?key.value.map((v,i)=>rest[i]+(v-rest[i])*.5):rest+(key.value-rest)*.5;}
 changed.hash=hashValue(spec);return {candidate,invalidated:[p.dependencyId]};
}
function applyRepairOperator(input){
 const request=copy(input);fields(request,['candidate','diagnosis','action']);
 const {candidate,diagnosis,action}=request;fields(candidate,['value','dependencies']);
 fields(diagnosis,['id','code','asset','message','actionIds']);fields(action,['diagnosisId','actionId','parameters']);
 for(const id of [diagnosis.id,diagnosis.asset,action.diagnosisId,action.actionId])token(id);
 if(action.diagnosisId!==diagnosis.id||!Array.isArray(diagnosis.actionIds)||diagnosis.actionIds.length>256||!diagnosis.actionIds.includes(action.actionId)||typeof diagnosis.message!=='string'||!diagnosis.message.length||diagnosis.message.length>1024)fail('Explicit diagnosis and authorization required');
 diagnosis.actionIds.forEach(token);if(new Set(diagnosis.actionIds).size!==diagnosis.actionIds.length)fail('Duplicate authorized actions');
 const spec=candidate.value;if(!spec||typeof spec!=='object'||Array.isArray(spec))fail('Authored specification required');
 if(action.actionId==='closeLoopPose')return closeLoopPose(candidate,diagnosis,action.parameters);
 if(action.actionId==='dampenClipPose')return dampenClipPose(candidate,diagnosis,action.parameters);
 if(diagnosis.code!=='WEIGHT_SUM'||action.actionId!=='normalizeMeshWeights')fail('Unsupported diagnosis or operator');
 const p=action.parameters;fields(p,['partId','vertexIndex','expectedSum','dependencyId']);token(p.partId);token(p.dependencyId);
 if(diagnosis.asset!==p.partId||!Number.isSafeInteger(p.vertexIndex)||p.vertexIndex<0||!Number.isFinite(p.expectedSum))fail('Diagnosis target mismatch');
 const bones=indexById(spec.bones,256),parts=indexById(spec.parts,1024),part=parts.get(p.partId),mesh=part?.mesh;
 if(!mesh||!Array.isArray(mesh.vertices)||!mesh.vertices.length||mesh.vertices.length>8192||!Array.isArray(mesh.weights)||mesh.weights.length!==mesh.vertices.length||p.vertexIndex>=mesh.weights.length)fail('Complete authored mesh required');
 const influences=mesh.weights[p.vertexIndex];
 if(!Array.isArray(influences)||!influences.length||influences.length>256)fail('Complete influences required');
 let sum=0;const seen=new Set();
 for(const influence of influences){
  fields(influence,['bone','weight']);token(influence.bone);
  if(!bones.has(influence.bone)||seen.has(influence.bone)||!Number.isFinite(influence.weight)||influence.weight<0)fail('Invalid bone influence');
  seen.add(influence.bone);sum+=influence.weight;
 }
 if(!Number.isFinite(sum)||sum<=0||sum!==p.expectedSum||Math.abs(sum-1)<=1e-5)fail('Stale, irreparable or already normalized diagnosis');
 const changed=verifiedDependency(candidate,p.dependencyId);
 for(const influence of influences)influence.weight/=sum;
 changed.hash=hashValue(spec);
 return {candidate,invalidated:[p.dependencyId]};
}
module.exports={applyRepairOperator};
