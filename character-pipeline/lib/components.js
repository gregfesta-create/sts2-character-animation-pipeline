'use strict';
const {createStateReconciler}=require('./state');
const ID=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
function fail(message){throw Object.assign(new Error(message),{code:'INVALID_COMPONENT'});}
// Accept data only, with a finite traversal budget; never evaluate accessor fields.
function copy(input){
 let budget=100000;
 function visit(value,depth){
  if(--budget<0||depth>16)fail('Component data exceeds bounds');
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='string'){if(value.length>4096)fail('String exceeds bounds');return value;}
  if(typeof value==='number'){if(!Number.isFinite(value))fail('Expected finite number');return value;}
  if(!value||typeof value!=='object')fail('Expected data only');
  const array=Array.isArray(value),proto=Object.getPrototypeOf(value);
  if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)fail('Expected ordinary data');
  const keys=Reflect.ownKeys(value),out=array?[]:{};
  if(keys.length>10001)fail('Object exceeds bounds');
  for(const key of keys){
   if(array&&key==='length')continue;
   if(typeof key!=='string'||['__proto__','constructor','prototype'].includes(key))fail('Unsupported data field');
   const d=Object.getOwnPropertyDescriptor(value,key);
   if(!d.enumerable||!Object.hasOwn(d,'value'))fail('Expected enumerable data fields');
   if(array&&!/^(0|[1-9][0-9]*)$/.test(key))fail('Unexpected array field');
   out[key]=visit(d.value,depth+1);
  }
  if(array&&(out.length!==value.length||keys.length!==value.length+1))fail('Expected dense bounded array');
  return out;
 }
 return visit(input,0);
}
function fields(value,keys){if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))fail('Missing or unsupported contract field');}
function id(value){if(typeof value!=='string'||!ID.test(value))fail('Invalid bounded ID');}
function list(value,max=256){if(!Array.isArray(value)||value.length>max)fail('Expected bounded array');}
function names(value){list(value);value.forEach(id);if(new Set(value).size!==value.length)fail('Duplicate IDs');}
function pair(value,positive=false){if(!Array.isArray(value)||value.length!==2||value.some(n=>!Number.isFinite(n)||Math.abs(n)>1000000||(positive&&n<=0)))fail('Invalid dimensions or vector');}
function integer(value,min,max){if(!Number.isSafeInteger(value)||value<min||value>max)fail('Integer outside bounds');}
function inheritance(value){fields(value,['position','rotation','scale']);if(Object.values(value).some(v=>typeof v!=='boolean'))fail('Invalid inheritance');}
function transform(value){fields(value,['position','rotation','scale']);pair(value.position);pair(value.scale);if(value.scale.some(n=>n===0))fail('Singular mount scale');if(!Number.isFinite(value.rotation)||Math.abs(value.rotation)>1000000)fail('Invalid rotation');}
function hash(value){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('Expected canonical style hash');}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
const TRANSITION_OPERATIONS=['install','remove','replace','upgrade','repair','destroy','damage','visual'];
function validateTransitionProfiles(input){
 const profiles=copy(input);
 if(!profiles||Array.isArray(profiles)||typeof profiles!=='object'||Object.keys(profiles).some(k=>!TRANSITION_OPERATIONS.includes(k)))fail('Invalid transition operations');
 for(const profile of Object.values(profiles)){
  fields(profile,['duration','phases']);
  if(!Number.isFinite(profile.duration)||profile.duration<0||profile.duration>10)fail('Invalid transition duration');
  list(profile.phases,16);const seen=new Set();let last=0;
  for(const phase of profile.phases){
   fields(phase,Object.hasOwn(phase||{},'clip')?['id','time','clip']:['id','time']);id(phase.id);
   if(seen.has(phase.id)||!Number.isFinite(phase.time)||phase.time<last||phase.time>profile.duration)fail('Invalid transition phase order or identity');
   if(Object.hasOwn(phase,'clip'))id(phase.clip);
   seen.add(phase.id);last=phase.time;
  }
 }
 return freeze(profiles);
}
function assertTransitionClipCompatibility(input,childSpec){
 const profiles=validateTransitionProfiles(input),child=copy(childSpec);
 if(!child||Array.isArray(child)||typeof child!=='object')fail('Expected child definition');list(child.animations,10000);
 const clips=new Map();for(const clip of child.animations){
  if(!clip||Array.isArray(clip)||typeof clip!=='object')fail('Expected child clip');
  id(clip.id);if(clips.has(clip.id))fail('Duplicate child clip');list(clip.events,10000);
  if(clip.events.some(event=>!event||Array.isArray(event)||typeof event!=='object'))fail('Expected child cue');
  clips.set(clip.id,clip);
 }
 for(const profile of Object.values(profiles))for(const phase of profile.phases)if(Object.hasOwn(phase,'clip')){
  const clip=clips.get(phase.clip);if(!clip||clip.events.some(event=>event.type==='projectile'))fail('Transition clip missing or requires authoritative action');
 }
 return profiles;
}
function matrix(t){const c=Math.cos(t.rotation),s=Math.sin(t.rotation);return [c*t.scale[0],s*t.scale[0],-s*t.scale[1],c*t.scale[1],...t.position];}
function attachment(socket,mount){
 const [a,b,c,d,x,y]=matrix(mount),det=a*d-b*c;
 const inv=[d/det,-b/det,-c/det,a/det,(c*y-d*x)/det,(b*x-a*y)/det];
 const m=matrix(socket),n=inv;
 const result=[m[0]*n[0]+m[2]*n[1],m[1]*n[0]+m[3]*n[1],m[0]*n[2]+m[2]*n[3],m[1]*n[2]+m[3]*n[3],m[0]*n[4]+m[2]*n[5]+m[4],m[1]*n[4]+m[3]*n[5]+m[5]];
 if(result.some(v=>!Number.isFinite(v)||Math.abs(v)>1000000))fail('Unbounded mount frame');
 return result.map(v=>Object.is(v,-0)?0:v);
}
/** Registry entries are versioned descriptors keyed by authoritative state component.type.
 * Paths are inert owned relative spec references. This planner never loads scenes or runs gameplay.
 * A native consumer must perform transitions before unmount, cancel in-flight work on cancel,
 * and keep the existing chassis/controller instance for every instruction.
 */
function createAssemblyPlanner(input){
 const config=copy(input);fields(config,['sockets','descriptors','styleHash','eventNames']);
 hash(config.styleHash);names(config.eventNames);list(config.sockets);list(config.descriptors);
 const sockets=new Map(),descriptors=new Map();
 for(const socket of config.sockets){
  fields(socket,['id','bone','transform','types','capacity','inheritance','layer','envelope']);id(socket.id);id(socket.bone);transform(socket.transform);names(socket.types);
  if(!socket.types.length||socket.types.length>64||sockets.has(socket.id))fail('Invalid type count or duplicate socket');
  integer(socket.capacity,1,64);integer(socket.layer,-4096,4096);inheritance(socket.inheritance);pair(socket.envelope,true);sockets.set(socket.id,socket);
 }
 for(const d of config.descriptors){
  if(!d||Array.isArray(d)||typeof d!=='object')fail('Expected descriptor object');
  fields(d,['version','type','spec','mount','dimensions','styleHash','eventNames','layer','inheritance',...(Object.hasOwn(d,'transitions')?['transitions']:[])]);
  if(Object.hasOwn(d,'transitions'))validateTransitionProfiles(d.transitions);
  if(d.version!==1)fail('Unsupported descriptor version');id(d.type);
  if(descriptors.has(d.type))fail('Duplicate descriptor type');
  if(typeof d.spec!=='string'||!/^([A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/.test(d.spec))fail('Expected owned relative JSON spec');
  transform(d.mount);pair(d.dimensions,true);hash(d.styleHash);names(d.eventNames);integer(d.layer,-4096,4096);inheritance(d.inheritance);
  if(d.styleHash!==config.styleHash||d.eventNames.some(n=>!config.eventNames.includes(n)))fail('Incompatible style or event contract');
  if(d.mount.position.some((v,i)=>v<0||v>d.dimensions[i]))fail('Mount pivot outside component dimensions');
  let compatible=false;
  for(const s of sockets.values())if(s.types.includes(d.type)){
   if(d.layer!==s.layer||Object.keys(d.inheritance).some(k=>d.inheritance[k]!==s.inheritance[k]))fail('Incompatible layer or inheritance');
   // Envelope is measured in socket-local pixels after inverse mount scaling.
   const c=Math.abs(Math.cos(d.mount.rotation)),sn=Math.abs(Math.sin(d.mount.rotation));
   const [w,h]=d.dimensions;
   if((c*w+sn*h)/Math.abs(d.mount.scale[0])>s.envelope[0]+1e-9||(sn*w+c*h)/Math.abs(d.mount.scale[1])>s.envelope[1]+1e-9)fail('Component exceeds socket dimensions');
   attachment(s.transform,d.mount);compatible=true;
  }
  if(!compatible)fail('Descriptor has no compatible socket');descriptors.set(d.type,d);
 }
 function validate(state){
  try{
   const r=createStateReconciler({instanceId:state.instanceId,sockets:config.sockets.map(({id,types,capacity})=>({id,types,capacity}))});r.snapshot(state);
  }catch(error){fail('Invalid authoritative state: '+error.message);}
  for(const c of state.components)if(!descriptors.has(c.type)||!['intact','damaged','destroyed'].includes(c.damageState))fail('Unregistered type or unsupported damage state');
  const mounts=new Set();
  for(const c of state.components){const key=c.socket+':'+attachment(sockets.get(c.socket).transform,descriptors.get(c.type).mount).join(',');if(mounts.has(key))fail('Conflicting component mounts');mounts.add(key);}
 }
 return Object.freeze({
 // Bootstrap has no predecessor state or counters. Establish the supplied
 // authoritative lifecycle/mode explicitly, including empty or removed states.
 bootstrap(snapshot){
  const state=copy(snapshot);validate(state);const instructions=[];
  for(const component of state.components){
   const d=descriptors.get(component.type),s=sockets.get(component.socket);
   instructions.push({action:'mount',id:component.id,socket:component.socket,type:component.type,spec:d.spec,frame:attachment(s.transform,d.mount),layer:s.layer,inheritance:s.inheritance,state:component});
   instructions.push({action:'transition',id:component.id,kind:'install',state:component});
  }
  instructions.push({action:'lifecycle',kind:state.lifecycle==='dead'?'death':state.lifecycle==='alive'?'revive':'removed'});
  instructions.push({action:'visualMode',mode:state.visualMode});
  return freeze({version:1,instanceId:state.instanceId,preserveChassis:true,instructions});
 },plan(previous,next){
  const before=copy(previous),after=copy(next);validate(before);validate(after);
  if(before.instanceId!==after.instanceId||after.revision<before.revision||after.sequence<before.sequence||before.lifecycle==='removed'&&after.lifecycle!=='removed')fail('Invalid authoritative progression');
  const instructions=[],old=new Map(before.components.map(c=>[c.id,c])),current=new Map(after.components.map(c=>[c.id,c]));
  const changed=(a,b)=>Object.keys(a).some(k=>a[k]!==b[k]);
  const equivalent=before.lifecycle===after.lifecycle&&before.visualMode===after.visualMode&&old.size===current.size&&after.components.every(c=>old.has(c.id)&&!changed(old.get(c.id),c));
  if(after.revision===before.revision&&!equivalent)fail('Conflicting authoritative revision');
  if(before.lifecycle!==after.lifecycle)instructions.push({action:'cancelAll'});
  const transition=(id,kind,state)=>instructions.push({action:'transition',id,kind,...(state?{state}: {})});
  for(const a of before.components){
   const b=current.get(a.id),replace=b&&(a.type!==b.type||a.socket!==b.socket);
   if(b&&(b.revision<a.revision||b.revision===a.revision&&changed(a,b)))fail('Conflicting component revision');
   if(!b||replace){instructions.push({action:'cancel',id:a.id});transition(a.id,replace?'replace':a.damageState==='destroyed'?'destroy':'remove');instructions.push({action:'unmount',id:a.id});}
  }
  for(const b of after.components){
   const a=old.get(b.id),fresh=!a||a.type!==b.type||a.socket!==b.socket;
   if(fresh){const d=descriptors.get(b.type),s=sockets.get(b.socket);instructions.push({action:'mount',id:b.id,socket:b.socket,type:b.type,spec:d.spec,frame:attachment(s.transform,d.mount),layer:s.layer,inheritance:s.inheritance,state:b});transition(b.id,'install',b);}
   else if(changed(a,b)){
    instructions.push({action:'cancel',id:b.id});
    if(a.upgrade!==b.upgrade)transition(b.id,'upgrade',b);
    if(a.damageState!==b.damageState)transition(b.id,b.damageState==='destroyed'?'destroy':b.damageState==='intact'?'repair':'damage',b);
    if(a.visualMode!==b.visualMode||a.revision!==b.revision)instructions.push({action:'update',id:b.id,state:b});
   }
  }
  if(before.lifecycle!==after.lifecycle)instructions.push({action:'lifecycle',kind:after.lifecycle==='dead'?'death':after.lifecycle==='alive'?'revive':'removed'});
  if(before.visualMode!==after.visualMode)instructions.push({action:'visualMode',mode:after.visualMode});
  return freeze({version:1,instanceId:after.instanceId,preserveChassis:true,instructions});
 }});
}
// Event IDs identify individual cues; typed handlers and marker names define
// the component's compatibility capabilities across engine and compiler.
function componentEventNames(spec){
 return [...new Set(spec.animations.flatMap(clip=>clip.events.map(event=>event.type||event.name)))].sort();
}
module.exports={createAssemblyPlanner,componentEventNames,validateTransitionProfiles,assertTransitionClipCompatibility};
