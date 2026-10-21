'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createSpec,validateSpec,assertSpec}=require('../lib/spec');

function fixture() {
  const spec=createSpec({id:'poseActor',description:'Synthetic alternate drawings'});
  spec.parts=['open','reach','tailOpen','tailReach'].map(id=>({id,role:'wing',bone:'root',pivot:[0,0],layer:0}));
  spec.poseGroups=[{id:'wing',parts:['open','reach'],defaultPart:'open'},{id:'tail',parts:['tailOpen','tailReach'],defaultPart:'tailOpen'}];
  spec.animations=[{id:'gust',duration:1,loop:false,tracks:[],events:[],poseTracks:[{group:'wing',keys:[{time:0,part:'open'},{time:0.5,part:'reach'},{time:1,part:'open'}]}]}];
  return spec;
}
function reject(change) {
  const spec=fixture(); change(spec);
  const result=validateSpec(spec);
  assert.equal(result.valid,false);
  assert.throws(()=>assertSpec(spec),{code:'INVALID_SPEC'});
}
test('optional pose groups accept legacy, multiple groups, absent tracks and nonloop endpoints',()=>{
  assert.equal(validateSpec(createSpec({id:'legacy',description:'Legacy'})).valid,true);
  const spec=fixture(); assert.equal(validateSpec(spec).valid,true);
  delete spec.animations[0].poseTracks; assert.equal(validateSpec(spec).valid,true);
  spec.poseGroups=[]; spec.animations[0].poseTracks=[]; assert.equal(validateSpec(spec).valid,true);
});
test('pose groups reject unknown, duplicate, shared and invalid default members',()=>{
  for(const change of [
    s=>s.poseGroups[0].parts[1]='missing',s=>s.poseGroups[0].parts[1]='open',
    s=>s.poseGroups[1].parts[0]='open',s=>s.poseGroups[0].defaultPart='tailOpen',
    s=>s.poseGroups[1].id='wing',s=>s.poseGroups[0].id='constructor',
    s=>s.poseGroups[0].unknown=true,s=>delete s.poseGroups[0].defaultPart,
    s=>s.poseGroups[0].parts=['open'],s=>s.poseGroups[0].parts=Array(65).fill('open'),
    s=>s.poseGroups=Array(65).fill(s.poseGroups[0])
  ]) reject(change);
});
test('unsafe pose group IDs fail independently of track references',()=>{
  for(const id of ['__proto__','prototype','constructor','command','script','executable','shell']) {
    for(const withTrack of [false,true]) {
      const spec=fixture(); spec.poseGroups[0].id=id;
      if(withTrack) spec.animations[0].poseTracks[0].group=id;
      else delete spec.animations[0].poseTracks;
      const result=validateSpec(spec);
      assert.equal(result.valid,false,`${id} withTrack=${withTrack}`);
      assert.ok(result.errors.some(error=>error.path==='/poseGroups/0/id' && ['UNSAFE','STRING'].includes(error.code)));
    }
  }
});
test('pose memberships accept 256 distinct members and reject the next complete group',()=>{
  const spec=fixture(); spec.parts=[]; spec.poseGroups=[]; spec.animations=[];
  for(let g=0;g<5;g++) {
    const ids=Array.from({length:64},(_,i)=>`part${g}_${i}`);
    spec.parts.push(...ids.map(id=>({id,role:'wing',bone:'root',pivot:[0,0],layer:0})));
    spec.poseGroups.push({id:`group${g}`,parts:ids,defaultPart:ids[0]});
    assert.equal(validateSpec(spec).valid,g<4);
    if(g===4) assert.ok(validateSpec(spec).errors.some(error=>error.path==='/poseGroups' && error.code==='LENGTH'));
  }
});
test('pose tracks require existing unique groups and valid member selections',()=>{
  for(const change of [
    s=>s.animations[0].poseTracks[0].group='missing',s=>delete s.poseGroups,
    s=>s.animations[0].poseTracks.push(structuredClone(s.animations[0].poseTracks[0])),
    s=>s.animations[0].poseTracks[0].keys[1].part='tailOpen',
    s=>s.animations[0].poseTracks[0].keys[1].part='missing',
    s=>s.animations[0].poseTracks[0].keys=[],
    s=>s.animations[0].poseTracks[0].keys=Array(129).fill({time:0,part:'open'}),
    s=>s.animations[0].poseTracks=Array(65).fill(s.animations[0].poseTracks[0]),
    s=>s.animations[0].poseTracks[0].unknown=true,
    s=>s.animations[0].poseTracks[0].keys[0].unknown=true,
    s=>delete s.animations[0].poseTracks[0].keys[0].part
  ]) reject(change);
});
test('pose times start at zero, strictly increase, stay finite and obey loop endpoints',()=>{
  for(const time of [-1,0.1,NaN,Infinity,'0']) reject(s=>s.animations[0].poseTracks[0].keys[0].time=time);
  for(const time of [0,1.1,NaN,Infinity]) reject(s=>s.animations[0].poseTracks[0].keys[1].time=time);
  reject(s=>s.animations[0].loop=true);
  const spec=fixture(); spec.animations[0].loop=true; spec.animations[0].poseTracks[0].keys.pop();
  assert.equal(validateSpec(spec).valid,true);
  spec.animations[0].poseTracks.push({group:'tail',keys:[{time:0,part:'tailReach'}]});
  assert.equal(validateSpec(spec).valid,true);
});
