'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {runRepairs}=require('../lib/repair');
const hash='a'.repeat(64),nextHash='b'.repeat(64);
const candidate=value=>({value:{offset:value,unrelated:{keep:true}},dependencies:[{id:'rig',hash:value===0?hash:nextHash}]});
const diagnosis={id:'mount',code:'ALIGNMENT',asset:'arm',message:'Mount is offset',actionIds:['pivot']};
const failure={passed:false,diagnoses:[diagnosis]},success={passed:true,diagnoses:[]};
function setup(extra={}){const evidence=[],calls=[];return {evidence,calls,callbacks:{inspect:async c=>{calls.push('inspect');return c.value.offset===0?failure:success;},select:async()=>({diagnosisId:'mount',actionId:'pivot',parameters:{offset:1}}),apply:async()=>{calls.push('apply');return {candidate:candidate(1),invalidated:['rig']};},persist:async e=>{calls.push('persist:'+e.type);evidence.push(e);},...extra}};}
const options=()=>({candidate:candidate(0),permittedActions:['pivot']});
test('bounded repair re-inspects changed content and persists authorization evidence before apply',async()=>{
 const x=setup(),input=options(),original=structuredClone(input);const result=await runRepairs(input,x.callbacks);
 assert.equal(result.status,'passed');assert.equal(result.integrationPending,true);assert.equal(result.attempts,1);assert.deepEqual(input,original);assert.equal(result.candidate.value.offset,1);assert.deepEqual(result.candidate.value.unrelated,{keep:true});
 assert.ok(x.calls.indexOf('persist:action')<x.calls.indexOf('apply'));assert.equal(x.calls.filter(c=>c==='inspect').length,2);assert.equal(x.evidence.at(-1).type,'complete');assert.equal(x.evidence.at(-1).status,'passed');assert.deepEqual(result.history,x.evidence);
});
test('already valid and irreparable candidates never invoke corrections',async()=>{
 for(const [inspect,select,status]of [[async()=>success,async()=>null,'passed'],[async()=>failure,async()=>null,'irreparable']]){const x=setup({inspect,select,apply:async()=>assert.fail('must not apply')});const result=await runRepairs(options(),x.callbacks);assert.equal(result.status,status);assert.equal(result.attempts,0);}
});
test('unchanged content, unchanged dependency and false invalidation receipts fail closed',async()=>{
 for(const receipt of [{candidate:candidate(0),invalidated:['rig']},{candidate:{...candidate(1),dependencies:candidate(0).dependencies},invalidated:[]},{candidate:candidate(1),invalidated:[]},{candidate:candidate(1),invalidated:['rig','other']},{candidate:{...candidate(1),dependencies:[{id:'rig',hash:'invalid'}]},invalidated:['rig']}]){
  const x=setup({apply:async()=>receipt});await assert.rejects(runRepairs(options(),x.callbacks),{code:'INVALID_REPAIR'});assert.equal(x.evidence.at(-1).type,'error');assert.equal(x.evidence.at(-1).candidateHash,x.evidence[0].candidateHash);
 }
});
test('unpermitted action and malformed success cannot produce passed result',async()=>{
 for(const overrides of [{select:async()=>({diagnosisId:'mount',actionId:'unknown',parameters:{}})},{inspect:async()=>({passed:true,diagnoses:[diagnosis]})},{inspect:async()=>({passed:false,diagnoses:[]})}]){const x=setup({...overrides,apply:async()=>assert.fail('must not apply')});await assert.rejects(runRepairs(options(),x.callbacks),{code:'INVALID_REPAIR'});}
});
test('repeated diagnosis and action stops instead of retrying the same correction',async()=>{
 const x=setup({inspect:async()=>failure});const result=await runRepairs(options(),x.callbacks);assert.equal(result.status,'stalled');assert.equal(result.attempts,1);assert.equal(x.calls.filter(c=>c==='apply').length,1);
});
test('changing correction parameters is bounded by maxAttempts and cannot skip final inspection',async()=>{
 let selected=0,inspected=0;const x=setup({inspect:async()=>{inspected++;return failure;},select:async()=>({diagnosisId:'mount',actionId:'pivot',parameters:{offset:++selected}}),apply:async()=>({candidate:candidate(selected),invalidated:['rig']})});
 const result=await runRepairs({...options(),maxAttempts:1},x.callbacks);assert.equal(result.status,'exhausted');assert.equal(inspected,2);assert.equal(result.attempts,1);
});
test('repeated candidate content is a stalled cycle and does not replace accepted candidate',async()=>{
 let selected=0;const x=setup({inspect:async()=>failure,select:async()=>({diagnosisId:'mount',actionId:'pivot',parameters:{n:++selected}}),apply:async()=>({candidate:candidate(selected===1?1:0),invalidated:['rig']})});
 const result=await runRepairs(options(),x.callbacks);assert.equal(result.status,'stalled');assert.equal(result.attempts,2);assert.equal(result.candidate.value.offset,1);
});
test('cancellation and callback failures persist final state and do not continue',async()=>{
 const controller=new AbortController(),x=setup({select:async()=>{controller.abort();return null;}});await assert.rejects(runRepairs({...options(),signal:controller.signal},x.callbacks),{code:'CANCELLED'});assert.equal(x.evidence.at(-1).type,'cancelled');assert.ok(!x.calls.includes('apply'));
 const cause=new Error('operator failed'),y=setup({apply:async()=>{throw cause;}});await assert.rejects(runRepairs(options(),y.callbacks),error=>error===cause);assert.equal(y.evidence.at(-1).type,'error');assert.equal(y.evidence.at(-1).attempt,1);
});
test('persistence failure prevents application and retains the persistence failure',async()=>{
 let applied=false;const cause=new Error('disk full'),x=setup({persist:async e=>{if(e.type==='action')throw cause;},apply:async()=>{applied=true;}});await assert.rejects(runRepairs(options(),x.callbacks),error=>error===cause);assert.equal(applied,false);
});
test('callback inputs are deeply immutable isolated snapshots',async()=>{
 const x=setup({inspect:async c=>{assert.ok(Object.isFrozen(c.value.unrelated));assert.throws(()=>{c.value.offset=99;},TypeError);return success;}});const result=await runRepairs(options(),x.callbacks);assert.equal(result.candidate.value.offset,0);
});
test('invalid options, duplicate dependency IDs and non-data fail before callbacks',async()=>{
 for(const bad of [{...options(),maxAttempts:0},{...options(),maxAttempts:21},{...options(),candidate:{...candidate(0),dependencies:[...candidate(0).dependencies,...candidate(0).dependencies]}},{...options(),permittedActions:['pivot','pivot']},{...options(),candidate:{value:{get bad(){throw Error('getter ran');}},dependencies:[]}}]){const x=setup();await assert.rejects(runRepairs(bad,x.callbacks),{code:'INVALID_REPAIR'});assert.equal(x.calls.length,0);}
});
test('dependency additions and removals are exact receipts and invalidation order is immaterial',async()=>{
 const x=setup({apply:async()=>({candidate:{value:candidate(1).value,dependencies:[{id:'mesh',hash:nextHash}]},invalidated:['mesh','rig']})});const result=await runRepairs(options(),x.callbacks);assert.equal(result.status,'passed');assert.deepEqual(result.candidate.dependencies,[{id:'mesh',hash:nextHash}]);
});
test('cancellation during final durable callback cannot return success',async()=>{
 const controller=new AbortController(),evidence=[];const x=setup({inspect:async()=>success,persist:async e=>{evidence.push(e);if(e.type==='complete')controller.abort();}});await assert.rejects(runRepairs({...options(),signal:controller.signal},x.callbacks),{code:'CANCELLED'});assert.equal(evidence.at(-1).type,'cancelled');
});
test('bounded histories remain returnable at the maximum attempt count',async()=>{
 let n=0;const x=setup({inspect:async()=>failure,select:async()=>({diagnosisId:'mount',actionId:'pivot',parameters:{n:++n}}),apply:async()=>({candidate:{value:candidate(n).value,dependencies:[{id:'rig',hash:require('../lib/assets').hashValue(n)}]},invalidated:['rig']})});const result=await runRepairs({...options(),maxAttempts:20},x.callbacks);assert.equal(result.status,'exhausted');assert.equal(result.attempts,20);assert.equal(result.history.length,62);
});
test('null and undefined callback rejections retain their value and persist failure evidence',async()=>{
 for(const stage of ['inspect','select','apply'])for(const thrown of [null,undefined]){
  const x=setup({[stage]:async()=>{throw thrown;}});let rejected=false;
  try{await runRepairs(options(),x.callbacks);}catch(error){rejected=true;assert.equal(error,thrown);}
  assert.equal(rejected,true);assert.equal(x.evidence.at(-1).type,'error');assert.equal(x.evidence.at(-1).code,'REPAIR_CALLBACK_FAILED');
 }
});
test('failed failure-evidence persistence preserves both the primary and persistence rejection',async()=>{
 for(const primary of [new Error('operator failed'),null,undefined,Object.freeze(new Error('frozen operator'))]){
  const secondary=new Error('evidence disk full');let persisted=false;
  const x=setup({inspect:async()=>{throw primary;},persist:async()=>{persisted=true;throw secondary;}});
  await assert.rejects(runRepairs(options(),x.callbacks),error=>{
   assert.ok(error instanceof AggregateError);assert.equal(error.cause,primary);assert.deepEqual(error.errors,[primary,secondary]);return true;
  });assert.equal(persisted,true);
 }
});
