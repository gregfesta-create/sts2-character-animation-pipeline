'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {hashValue}=require('../lib/assets');
const {applyRepairOperator}=require('../lib/repair-operators');
const {runRepairs}=require('../lib/repair');
function request(weights=[{bone:'root',weight:2},{bone:'arm',weight:6}]){
 const value={bones:[{id:'root'},{id:'arm'}],parts:[{id:'body',image:{path:'original.png'},mesh:{vertices:[[0,0]],weights:[weights]}}],animations:[{id:'idle',loop:true}]};
 return {candidate:{value,dependencies:[{id:'authoredSpec',hash:hashValue(value)},{id:'art',hash:'a'.repeat(64)}]},diagnosis:{id:'weight0',code:'WEIGHT_SUM',asset:'body',message:'Measured authored weight sum',actionIds:['normalizeMeshWeights']},action:{diagnosisId:'weight0',actionId:'normalizeMeshWeights',parameters:{partId:'body',vertexIndex:0,expectedSum:weights.reduce((n,w)=>n+w.weight,0),dependencyId:'authoredSpec'}}};
}
test('normalizes one explicitly diagnosed vertex and exactly invalidates verified authored dependency',()=>{
 const input=request(),before=structuredClone(input),result=applyRepairOperator(input);
 assert.deepEqual(input,before);assert.deepEqual(result.candidate.value.parts[0].mesh.weights[0],[{bone:'root',weight:.25},{bone:'arm',weight:.75}]);
 assert.deepEqual(result.candidate.value.parts[0].image,before.candidate.value.parts[0].image);assert.deepEqual(result.candidate.value.animations,before.candidate.value.animations);
 assert.deepEqual(result.invalidated,['authoredSpec']);assert.equal(result.candidate.dependencies[0].hash,hashValue(result.candidate.value));assert.deepEqual(result.candidate.dependencies[1],input.candidate.dependencies[1]);
});
test('refuses missing, zero, negative, nonfinite, unknown and duplicate influences without guessing',()=>{
 for(const weights of [[],[{bone:'root',weight:0}],[{bone:'root',weight:-1}],[{bone:'missing',weight:2}],[{bone:'root',weight:1},{bone:'root',weight:2}]])assert.throws(()=>applyRepairOperator(request(weights)),{code:'INVALID_REPAIR_OPERATOR'});
 const nonfinite=request();nonfinite.candidate.value.parts[0].mesh.weights[0][0].weight=Infinity;assert.throws(()=>applyRepairOperator(nonfinite),{code:'INVALID_REPAIR_OPERATOR'});
 const input=request();delete input.candidate.value.parts[0].mesh.weights;assert.throws(()=>applyRepairOperator(input),{code:'INVALID_REPAIR_OPERATOR'});
});
test('rejects stale diagnosis, unapproved action, unknown targets, no-op and false dependency receipts',()=>{
 const mutations=[r=>r.diagnosis.code='LOOP_SEAM',r=>r.diagnosis.asset='other',r=>r.action.diagnosisId='other',r=>r.diagnosis.actionIds=[],r=>r.action.actionId='closeLoop',r=>r.action.parameters.expectedSum=7,r=>r.action.parameters.partId='other',r=>r.action.parameters.vertexIndex=1,r=>r.action.parameters.dependencyId='art',r=>r.candidate.dependencies[0].hash='b'.repeat(64),r=>r.action.parameters.extra=true];
 for(const mutate of mutations){const input=request();mutate(input);assert.throws(()=>applyRepairOperator(input),{code:'INVALID_REPAIR_OPERATOR'});}
 assert.throws(()=>applyRepairOperator(request([{bone:'root',weight:1}])),{code:'INVALID_REPAIR_OPERATOR'});
});
test('bounds plain data and refuses accessor execution, oversized or ambiguous targets',()=>{
 let called=false;const input=request();Object.defineProperty(input.candidate.value,'evil',{enumerable:true,get(){called=true;return 1;}});assert.throws(()=>applyRepairOperator(input),{code:'INVALID_REPAIR_OPERATOR'});assert.equal(called,false);
 for(const mutate of [r=>r.candidate.value.bones.push({id:'root'}),r=>r.candidate.value.parts.push(structuredClone(r.candidate.value.parts[0])),r=>r.candidate.value.parts[0].mesh.weights[0].push({bone:'arm',weight:0}),r=>r.action.parameters.vertexIndex=-1,r=>r.candidate.value.padding='x'.repeat(1048577)]){const r=request();mutate(r);assert.throws(()=>applyRepairOperator(r),{code:'INVALID_REPAIR_OPERATOR'});}
});
test('operator plugs into bounded orchestration and requires fresh inspection before success',async()=>{
 const input=request();let inspections=0;
 const result=await runRepairs({candidate:input.candidate,permittedActions:['normalizeMeshWeights']},{inspect:async c=>{inspections++;const sum=c.value.parts[0].mesh.weights[0].reduce((a,b)=>a+b.weight,0);return {passed:sum===1,diagnoses:sum===1?[]:[input.diagnosis]};},select:async()=>input.action,apply:applyRepairOperator,persist:async()=>{}});
 assert.equal(result.status,'passed');assert.equal(inspections,2);assert.equal(result.integrationPending,true);
});
function loopRequest(){
 const r=request();r.candidate.value.animations=[{id:'idle',duration:2,loop:true,tracks:[
  {bone:'root',property:'position',keys:[{time:0,value:[1,2]},{time:1,value:[3,4],easing:'inOut'},{time:2,value:[5,6]}]},
  {bone:'arm',property:'rotation',keys:[{time:0,value:.2},{time:1,value:.6},{time:2,value:.7,easing:'out'}]},
  {bone:'arm',property:'scale',keys:[{time:0,value:[1,1]},{time:2,value:[2,2]}]}
 ],events:[{id:'cue',time:.5,type:'marker',payload:{name:'unchanged'}}]},{id:'attack',loop:false,tracks:[]}];
 r.candidate.dependencies[0].hash=hashValue(r.candidate.value);
 r.diagnosis={id:'seam0',code:'LOOP_SEAM',asset:'idle',message:'Trusted loop seam diagnosis',actionIds:['closeLoopPose']};
 r.action={diagnosisId:'seam0',actionId:'closeLoopPose',parameters:{clipId:'idle',dependencyId:'authoredSpec'}};return r;
}
test('closeLoopPose explicitly closes every authored local track and preserves interiors, events, art and weights',()=>{
 const input=loopRequest(),before=structuredClone(input),result=applyRepairOperator(input),clip=result.candidate.value.animations[0];
 assert.deepEqual(input,before);for(const [i,track]of clip.tracks.entries()){
  assert.deepEqual(track.keys.at(-1).value,track.keys[0].value);assert.deepEqual(track.keys.slice(0,-1),before.candidate.value.animations[0].tracks[i].keys.slice(0,-1));
  assert.equal(track.keys.at(-1).time,2);assert.equal(track.keys.at(-1).easing,before.candidate.value.animations[0].tracks[i].keys.at(-1).easing);
 }
 assert.deepEqual(clip.events,before.candidate.value.animations[0].events);assert.deepEqual(result.candidate.value.animations[1],before.candidate.value.animations[1]);assert.deepEqual(result.candidate.value.parts,before.candidate.value.parts);
 assert.deepEqual(result.invalidated,['authoredSpec']);assert.equal(result.candidate.dependencies[0].hash,hashValue(result.candidate.value));
});
test('closeLoopPose refuses incomplete, ambiguous, unsupported or invalid authored local tracks',()=>{
 const mutations=[r=>r.candidate.value.animations[0].loop=false,r=>r.candidate.value.animations[0].tracks=[],r=>r.candidate.value.animations.push(structuredClone(r.candidate.value.animations[0])),r=>r.candidate.value.animations[0].tracks.push(structuredClone(r.candidate.value.animations[0].tracks[0])),r=>r.candidate.value.animations[0].tracks[0].keys[0].time=.1,r=>r.candidate.value.animations[0].tracks[0].keys.at(-1).time=1.9,r=>r.candidate.value.animations[0].tracks[0].keys[1].time=0,r=>r.candidate.value.animations[0].tracks[0].property='visible',r=>r.candidate.value.animations[0].tracks[0].bone='missing',r=>r.candidate.value.animations[0].tracks[0].keys[1].value=1,r=>r.candidate.value.animations[0].tracks[1].keys[1].value=[1,2],r=>r.candidate.value.animations[0].tracks[2].keys[0].value=[0,1],r=>r.candidate.value.animations[0].duration=601,r=>r.candidate.value.animations[0].tracks[0].keys[0].easing='unsupported'];
 for(const mutate of mutations){const input=loopRequest();mutate(input);input.candidate.dependencies[0].hash=hashValue(input.candidate.value);assert.throws(()=>applyRepairOperator(input),{code:'INVALID_REPAIR_OPERATOR'});}
});
test('closeLoopPose rejects unapproved, mismatched, stale and no-op requests',()=>{
 const mutations=[r=>r.diagnosis.code='WEIGHT_SUM',r=>r.diagnosis.asset='attack',r=>r.diagnosis.actionIds=[],r=>r.action.parameters.clipId='missing',r=>r.action.parameters.extra=true,r=>r.candidate.dependencies[0].hash='b'.repeat(64)];
 for(const mutate of mutations){const r=loopRequest();mutate(r);assert.throws(()=>applyRepairOperator(r),{code:'INVALID_REPAIR_OPERATOR'});}
 const r=loopRequest();for(const t of r.candidate.value.animations[0].tracks)t.keys.at(-1).value=structuredClone(t.keys[0].value);r.candidate.dependencies[0].hash=hashValue(r.candidate.value);assert.throws(()=>applyRepairOperator(r),{code:'INVALID_REPAIR_OPERATOR'});
});
test('closeLoopPose validates malformed and out-of-bounds keys before editing any track',()=>{
 for(const badKey of [null,{time:1,value:NaN},{time:1,value:[1e6+1,2]},{time:1,value:[1,2],unexpected:true}]){
  const r=loopRequest();r.candidate.value.animations[0].tracks[0].keys[1]=badKey;
  if(badKey?.value!==undefined&&!(typeof badKey.value==='number'&&!Number.isFinite(badKey.value)))r.candidate.dependencies[0].hash=hashValue(r.candidate.value);
  assert.throws(()=>applyRepairOperator(r),{code:'INVALID_REPAIR_OPERATOR'});
 }
});
test('closeLoopPose returns a bounded repair candidate for fresh authored endpoint inspection',async()=>{
 const r=loopRequest();let inspected=0;
 const result=await runRepairs({candidate:r.candidate,permittedActions:['closeLoopPose']},{inspect:async c=>{inspected++;const closed=c.value.animations[0].tracks.every(t=>JSON.stringify(t.keys[0].value)===JSON.stringify(t.keys.at(-1).value));return {passed:closed,diagnoses:closed?[]:[r.diagnosis]};},select:async()=>r.action,apply:applyRepairOperator,persist:async()=>{}});
 assert.equal(result.status,'passed');assert.equal(result.integrationPending,true);assert.equal(inspected,2);
});
function dampingRequest(){
 const r=loopRequest();r.candidate.value.bones=[{id:'root',rest:{position:[2,-2],rotation:.2,scale:[1,2]}},{id:'arm',rest:{position:[0,0],rotation:.4,scale:[-1,1]},limits:[0,1]}];
 r.candidate.value.animations[0].tracks[2].keys=[{time:0,value:[-1,1]},{time:2,value:[-3,3],easing:'step'}];
 r.candidate.dependencies[0].hash=hashValue(r.candidate.value);
 r.diagnosis={id:'deformation0',code:'AUTHORED_DEFORMATION',asset:'idle',message:'Verified authored triangle inversion',actionIds:['dampenClipPose']};
 r.action={diagnosisId:'deformation0',actionId:'dampenClipPose',parameters:{clipId:'idle',dependencyId:'authoredSpec',sourceSpecHash:hashValue(r.candidate.value),factor:.5}};return r;
}
function rehashDamping(r){r.candidate.dependencies[0].hash=hashValue(r.candidate.value);r.action.parameters.sourceSpecHash=hashValue(r.candidate.value);return r;}
test('dampenClipPose halves every deviation from rest preserving timing, easing, events and other authored assets immutably',()=>{
 const r=dampingRequest(),before=structuredClone(r),out=applyRepairOperator(r),clip=out.candidate.value.animations[0];
 assert.deepEqual(r,before);assert.deepEqual(clip.tracks[0].keys.map(k=>k.value),[[1.5,0],[2.5,1],[3.5,2]]);assert.deepEqual(clip.tracks[1].keys.map(k=>k.value),[.30000000000000004,.5,.55]);assert.deepEqual(clip.tracks[2].keys.map(k=>k.value),[[-1,1],[-2,2]]);
 const unchanged=structuredClone(clip);unchanged.tracks.forEach((t,i)=>t.keys.forEach((k,j)=>k.value=before.candidate.value.animations[0].tracks[i].keys[j].value));assert.deepEqual(unchanged,before.candidate.value.animations[0]);
 assert.deepEqual(out.candidate.value.parts,before.candidate.value.parts);assert.deepEqual(out.candidate.value.bones,before.candidate.value.bones);assert.deepEqual(out.candidate.value.animations[1],before.candidate.value.animations[1]);assert.deepEqual(out.invalidated,['authoredSpec']);assert.equal(out.candidate.dependencies[0].hash,hashValue(out.candidate.value));assert.deepEqual(out.candidate.dependencies[1],before.candidate.dependencies[1]);
});
test('dampenClipPose requires exact fresh source hashes and supports successive distinct candidates',()=>{
 const r=dampingRequest(),first=applyRepairOperator(r),second={...r,candidate:first.candidate,action:structuredClone(r.action)};second.action.parameters.sourceSpecHash=hashValue(first.candidate.value);const out=applyRepairOperator(second);assert.deepEqual(out.candidate.value.animations[0].tracks[2].keys[1].value,[-1.5,1.5]);assert.notEqual(hashValue(out.candidate.value),hashValue(first.candidate.value));
 for(const mutate of [x=>x.action.parameters.sourceSpecHash='b'.repeat(64),x=>x.candidate.dependencies[0].hash='b'.repeat(64),x=>delete x.action.parameters.sourceSpecHash,x=>x.action.parameters.factor=.25,x=>x.diagnosis.code='LOOP_SEAM',x=>x.diagnosis.asset='other',x=>x.diagnosis.actionIds=[],x=>x.action.parameters.dependencyId='art',x=>x.action.parameters.extra=1]){const q=dampingRequest();mutate(q);assert.throws(()=>applyRepairOperator(q),{code:'INVALID_REPAIR_OPERATOR'});}
});
test('dampenClipPose rejects malformed tracks, rest, crossing scales, limits and unchanged poses before mutation',()=>{
 const mutations=[r=>r.candidate.value.animations[0].duration=0,r=>r.candidate.value.animations[0].tracks=[],r=>r.candidate.value.animations[0].tracks.push(structuredClone(r.candidate.value.animations[0].tracks[0])),r=>r.candidate.value.animations[0].tracks[0].bone='missing',r=>r.candidate.value.animations[0].tracks[0].property='visible',r=>r.candidate.value.animations[0].tracks[0].keys[0].time=-1,r=>r.candidate.value.animations[0].tracks[0].keys[1].time=0,r=>r.candidate.value.animations[0].tracks[0].keys[1].easing='bad',r=>r.candidate.value.animations[0].tracks[0].keys[1].value=[1e6+1,0],r=>delete r.candidate.value.bones[0].rest,r=>r.candidate.value.bones[0].rest.scale=[0,1],r=>r.candidate.value.animations[0].tracks[2].keys[1].value=[1,1],r=>r.candidate.value.animations[0].tracks[2].keys[1].value=[0,1],r=>r.candidate.value.bones[1].limits=[.5,1],r=>r.candidate.value.animations[0].tracks[1].keys[1].value=1.1,r=>r.candidate.value.bones[1].limits=[1,0],r=>r.candidate.value.animations[0].tracks[0].keys=[{time:1,value:[1,2],extra:1}]];
 for(const mutate of mutations){const r=dampingRequest();mutate(r);rehashDamping(r);const before=structuredClone(r);assert.throws(()=>applyRepairOperator(r),{code:'INVALID_REPAIR_OPERATOR'});assert.deepEqual(r,before);}
 const r=dampingRequest();for(const t of r.candidate.value.animations[0].tracks){const b=r.candidate.value.bones.find(b=>b.id===t.bone);t.keys.forEach(k=>k.value=structuredClone(b.rest[t.property]));}rehashDamping(r);assert.throws(()=>applyRepairOperator(r),{code:'INVALID_REPAIR_OPERATOR'});
});

test('dampenClipPose rejects explicitly present falsy limits instead of treating them as absent',()=>{
 for(const limits of [false,0,null,'']){
  const r=dampingRequest();r.candidate.value.bones[1].limits=limits;rehashDamping(r);const before=structuredClone(r);
  assert.throws(()=>applyRepairOperator(r),{code:'INVALID_REPAIR_OPERATOR'},JSON.stringify(limits));assert.deepEqual(r,before);
 }
 const absent=dampingRequest();delete absent.candidate.value.bones[1].limits;rehashDamping(absent);assert.doesNotThrow(()=>applyRepairOperator(absent));
});
