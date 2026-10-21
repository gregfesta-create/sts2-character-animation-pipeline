'use strict';
const {assertSpec,createSpec}=require('./spec');
const {bindRig}=require('./rig');
const {hashValue}=require('./assets');
const {createAssemblyPlanner}=require('./components');
function fail(message,code='INVALID_COMPONENT'){throw Object.assign(new Error(message),{code});}
// Snapshot ordinary, dense JSON data without invoking accessors or serialization hooks.
// Budgets apply before schema traversal, hashing or structured cloning.
function capture(input){
 let nodes=100000,bytes=0;const ancestors=new Set();
 function visit(value,depth){
  if(--nodes<0||depth>32)fail('Component authoring data exceeds traversal bounds.');
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number'){if(!Number.isFinite(value))fail('Component authoring numbers must be finite.');return value;}
  if(typeof value==='string'){bytes+=Buffer.byteLength(value);if(bytes>1024*1024)fail('Component authoring data exceeds 1 MiB.');return value;}
  if(!value||typeof value!=='object')fail('Component authoring accepts JSON data only.');
  const array=Array.isArray(value),proto=Object.getPrototypeOf(value);
  if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)fail('Component authoring requires ordinary JSON data.');
  if(ancestors.has(value))fail('Component authoring data must not contain cycles.');
  const keys=Reflect.ownKeys(value);if(keys.length>10001)fail('Component authoring collection exceeds bounds.');
  ancestors.add(value);const result=array?[]:{};
  for(const key of keys){
   if(array&&key==='length')continue;
   if(typeof key!=='string'||['__proto__','constructor','prototype'].includes(key))fail('Unsupported component authoring field.');
   const field=Object.getOwnPropertyDescriptor(value,key);
   if(!field.enumerable||!Object.hasOwn(field,'value')||array&&!/^(0|[1-9][0-9]*)$/.test(key))fail('Component authoring fields must be enumerable data.');
   bytes+=Buffer.byteLength(key);if(bytes>1024*1024)fail('Component authoring data exceeds 1 MiB.');
   result[key]=visit(field.value,depth+1);
  }
  ancestors.delete(value);
  if(array&&(result.length!==value.length||keys.length!==value.length+1))fail('Component authoring arrays must be dense.');
  return result;
 }
 return visit(input,0);
}
function createComponent(input){
 const request=capture(input);
 if(!request||Array.isArray(request)||typeof request!=='object'||Object.keys(request).some(key=>!['chassis','socketId','type','template','description','id','specPath'].includes(key)))fail('Unsupported component authoring request.');
 const {chassis,socketId,template,description,id,specPath}=request;
 if(typeof specPath!=='string'||specPath.length>4096||!/^([A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/.test(specPath)||specPath.split('/').some(segment=>/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)))fail('Choose an owned relative JSON definition path without reserved device names.');
 let source;
 try{source=assertSpec(chassis);}catch(error){fail('A valid chassis specification is required: '+error.message);}
 const socket=source.sockets.find(item=>item.id===socketId);
 if(!socket)fail('Selected chassis socket does not exist.');
 if(!source.assembly)fail('Author an explicit assembly descriptor before creating this component.','COMPONENT_CONTRACT_REQUIRED');
 const type=request.type===undefined?(socket.types.length===1?socket.types[0]:null):request.type;
 if(!type||!socket.types.includes(type))fail('Supply a type accepted by the selected socket; multiple accepted types require an explicit type.');
 const matching=source.assembly.descriptors.filter(item=>item.type===type);
 if(!matching.length)fail('Author a complete assembly descriptor for the selected component type.','COMPONENT_CONTRACT_REQUIRED');
 if(matching.length!==1)fail('Component type must have exactly one descriptor.');
 if(!Number.isInteger(socket.capacity)||socket.capacity<1||socket.capacity>64||Object.values(socket.inheritance).some(value=>value!==true))fail('Native component authoring requires socket capacity 1 to 64 and full transform inheritance.');
 const descriptor={...matching[0],spec:specPath};
 if(descriptor.dimensions.some(value=>!Number.isInteger(value)||value<1||value>16384))fail('Component dimensions must be integer pixel canvas sizes from 1 to 16384.');
 if(source.assembly.styleHash!==hashValue(source.style))fail('Chassis style does not match its canonical assembly style hash.');
 createAssemblyPlanner({sockets:[socket],descriptors:[descriptor],styleHash:source.assembly.styleHash,eventNames:source.assembly.eventNames});
 let specification;
 try{
  if(!['custom','humanoid','mechanical','quadruped_or_multilimb'].includes(template))fail('Choose a supported explicit component rig template.');
  specification=createSpec({id,description,template});
  specification.canvas={...specification.canvas,width:descriptor.dimensions[0],height:descriptor.dimensions[1]};
  const rig=bindRig(template,{canvas:specification.canvas,...(template==='custom'?{bones:specification.bones,roles:specification.anatomy.roles}:{})});
  specification.bones=rig.bones;specification.anatomy=rig.anatomy;
  specification.style=structuredClone(source.style);specification.export=structuredClone(source.export);
  specification=assertSpec(specification);
 }catch(error){fail('Cannot create component scaffold: '+error.message);}
 return {specification,descriptor:structuredClone(descriptor),socketContract:structuredClone(socket),sourceChassisHash:hashValue(source),remainingAuthoring:['references','artwork','parts','animations',...(descriptor.eventNames.length?['eventChoreography']:[])],readyToBuild:false,gameAcceptance:false};
}
module.exports={createComponent};
