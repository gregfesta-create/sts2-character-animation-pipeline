'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createSpec,validateSpec}=require('../lib/spec');
const {hashValue}=require('../lib/assets');
const {createComponent}=require('../lib/component-authoring');
function request(){
 const chassis=createSpec({id:'chassis',description:'Numeric contract fixture'});
 chassis.style={palette:['green'],outline:{width:2,color:'black'}};
 const inheritance={position:true,rotation:true,scale:true};
 chassis.sockets=[{id:'armSocket',bone:'root',transform:{position:[400,300],rotation:0,scale:[1,1]},types:['arm'],capacity:1,inheritance,layer:3,envelope:[512,512]}];
 chassis.assembly={version:1,styleHash:hashValue(chassis.style),eventNames:['fire'],descriptors:[{version:1,type:'arm',spec:'old/arm.json',mount:{position:[20,30],rotation:0,scale:[1,1]},dimensions:[256,128],styleHash:hashValue(chassis.style),eventNames:['fire'],layer:3,inheritance}]};
 return {chassis,socketId:'armSocket',template:'mechanical',description:'Authored component scaffold',id:'newArm',specPath:'components/newArm.json'};
}
test('authors an editable empty scaffold with exact child contract and canonical source identity',()=>{
 const r=request(),before=structuredClone(r),out=createComponent(r);
 assert.equal(validateSpec(out.specification).valid,true);assert.deepEqual(r,before);
 assert.deepEqual(out.descriptor,{...r.chassis.assembly.descriptors[0],spec:r.specPath});
 assert.deepEqual(out.socketContract,r.chassis.sockets[0]);assert.deepEqual(out.specification.canvas,{...r.chassis.canvas,width:256,height:128});
 assert.deepEqual(out.specification.style,r.chassis.style);assert.equal(out.sourceChassisHash,hashValue(r.chassis));
 assert.deepEqual(out.specification.parts,[]);assert.deepEqual(out.specification.animations,[]);assert.deepEqual(out.specification.references,[]);
 assert.equal(out.readyToBuild,false);assert.equal(out.gameAcceptance,false);assert.ok(out.remainingAuthoring.includes('eventChoreography'));
 assert.deepEqual(out.descriptor.mount.position,[20,30]);assert.notDeepEqual(out.descriptor.mount.position,out.socketContract.transform.position);
 out.specification.style.palette[0]='blue';assert.equal(r.chassis.style.palette[0],'green');
 const reversed=Object.fromEntries(Object.entries(before.chassis).reverse());assert.equal(createComponent({...before,chassis:reversed}).sourceChassisHash,out.sourceChassisHash);
});
test('supports all templates with uniform canvas scaling and preserves export modes',()=>{
 const {bindRig}=require('../lib/rig');
 for(const template of ['custom','humanoid','mechanical','quadruped_or_multilimb']){
  const r=request();r.template=template;r.chassis.export={target:'sts2',playback:'tree'};
  const out=createComponent(r),base=createSpec({id:r.id,description:r.description,template});
  const rig=bindRig(template,{canvas:out.specification.canvas,...(template==='custom'?{bones:base.bones,roles:base.anatomy.roles}:{})});
  assert.deepEqual(out.specification.bones,rig.bones);assert.deepEqual(out.specification.export,r.chassis.export);
 }
});
test('requires selected type and complete contracts without inventing geometry',()=>{
 for(const mutate of [r=>delete r.chassis.assembly,r=>r.chassis.assembly.descriptors=[]]){
  const r=request();mutate(r);assert.throws(()=>createComponent(r),{code:'COMPONENT_CONTRACT_REQUIRED'});
 }
 const r=request();r.chassis.sockets[0].types.push('claw');assert.throws(()=>createComponent(r),{code:'INVALID_COMPONENT'});
 assert.equal(createComponent({...r,type:'arm'}).descriptor.type,'arm');
 assert.throws(()=>createComponent({...r,type:'wrong'}),{code:'INVALID_COMPONENT'});
});
test('rejects invalid geometry, style, events, capacity, inheritance and output paths',()=>{
 for(const mutate of [r=>r.socketId='absent',r=>r.template='unknown',r=>r.id='bad id',r=>r.description='',r=>r.specPath='../escape.json',r=>r.specPath='C:/x.json',r=>r.specPath='CON.json',r=>r.specPath='a/NUL.json',r=>r.chassis.sockets[0].capacity=0,r=>r.chassis.sockets[0].capacity=65,r=>r.chassis.sockets[0].capacity=1.5,r=>r.chassis.sockets[0].capacity='2',r=>r.chassis.sockets[0].inheritance.rotation=false,r=>r.chassis.assembly.styleHash='a'.repeat(64),r=>r.chassis.assembly.descriptors[0].styleHash='b'.repeat(64),r=>r.chassis.assembly.descriptors[0].eventNames=['unknown'],r=>r.chassis.assembly.descriptors[0].dimensions=[1.5,2],r=>r.chassis.assembly.descriptors[0].dimensions=[16385,2],r=>r.chassis.sockets[0].envelope=[1,1],r=>r.chassis.assembly.descriptors[0].mount.position=[999,0]]){
  const r=request();mutate(r);assert.throws(()=>createComponent(r),{code:'INVALID_COMPONENT'});
 }
});
test('captures bounded data before schema, hashing or cloning and never invokes accessors',()=>{
 let invoked=0;const r=request();Object.defineProperty(r.chassis.style,'danger',{enumerable:true,get(){invoked++;throw Error('getter');}});
 assert.throws(()=>createComponent(r),{code:'INVALID_COMPONENT'});assert.equal(invoked,0);
 for(const mutate of [r=>r.chassis.style.self=r.chassis.style,r=>r.chassis.style.number=Infinity,r=>r.chassis.style.large='x'.repeat(1024*1024+1),r=>r.chassis.style.date=new Date(),r=>r.chassis.references=new Array(3),r=>r.extra='authority']){
  const value=request();mutate(value);assert.throws(()=>createComponent(value),{code:'INVALID_COMPONENT'});
 }
 const sparse=request();sparse.chassis.style.items=new Array(100001);assert.throws(()=>createComponent(sparse),{code:'INVALID_COMPONENT'});
});

test('authors capacity two and capacity sixty-four contracts without installing or mutating sources',()=>{
 for(const capacity of [2,64]){
  const r=request();r.chassis.sockets[0].capacity=capacity;
  const before=structuredClone(r),out=createComponent(r);
  assert.deepEqual(r,before);assert.equal(out.socketContract.capacity,capacity);
  assert.deepEqual(out.descriptor.mount,before.chassis.assembly.descriptors[0].mount);
  assert.deepEqual(out.specification.components,[]);assert.deepEqual(out.specification.parts,[]);
 }
});
