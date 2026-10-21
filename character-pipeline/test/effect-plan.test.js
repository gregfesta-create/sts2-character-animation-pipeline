'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validateEffectPlan,assertEffectPlan}=require('../lib/effect-plan');
const hash='a'.repeat(64);
function fixture(){
 const evidence={id:'ev',path:'Power.cs',hash,symbol:'Power',lineStart:1,lineEnd:2,excerpt:'amount'};
 const inventory={characterId:'hero',fingerprint:hash,version:1,evidence:[evidence],mechanics:[{key:'mod.Power',evidenceIds:['ev']}]};
 const plan={version:1,characterId:'hero',mechanicsFingerprint:hash,inspectionVersion:'1',adapterContractVersion:'1',evidence:[evidence],decisions:[{id:'power',mechanicKey:'mod.Power',outcome:'effect',reason:'Visible poison tip',evidenceIds:['ev'],bindingId:'poison',rule:{effectIds:['green'],condition:{type:'amountAtLeast',threshold:1},scope:'attackSnapshot',socketId:'arrow',channel:'tip',priority:1}}]};
 return {plan,options:{inventory:structuredClone(inventory),bindings:[{id:'poison',mechanicKey:'mod.Power',adapterContractVersion:'1'}],effects:[{id:'green',capability:'tint',implemented:true,resources:[{sha256:hash,importSettings:{},styleProvenance:'style',approvalProvenance:'approved'}]}],sockets:['arrow']}};
}
test('validated effect plans are isolated immutable values; none and unresolved need no binding',()=>{
 const {plan,options}=fixture();const copy=assertEffectPlan(plan,options);assert.ok(Object.isFrozen(copy.decisions[0].rule));assert.notEqual(copy,plan);
 for(const outcome of ['none','unresolved']){const p=structuredClone(plan);Object.assign(p.decisions[0],{outcome});delete p.decisions[0].bindingId;delete p.decisions[0].rule;assert.equal(validateEffectPlan(p,options).valid,true);}
});
test('rejects stale, incomplete, untrusted and executable plans',()=>{
 const mutations=[p=>p.mechanicsFingerprint='b'.repeat(64),p=>p.decisions=[],p=>p.decisions.push(p.decisions[0]),p=>p.evidence[0].excerpt='invented',p=>p.decisions[0].bindingId='missing',p=>p.decisions[0].rule.effectIds=['missing'],p=>p.decisions[0].rule.socketId='missing',p=>p.decisions[0].rule.condition.threshold=0,p=>p.decisions[0].rule.priority=Infinity,p=>p.decisions[0].script='run',p=>p.decisions[0].outcome='unresolved'];
 for(const mutate of mutations){const {plan,options}=fixture();mutate(plan);assert.equal(validateEffectPlan(plan,options).valid,false,mutate.toString());assert.throws(()=>assertEffectPlan(plan,options),{code:'INVALID_EFFECT_PLAN'});}
});
test('rejects bounded-input violations and unsafe object graphs',()=>{
 for(const value of [null,[],{version:1},JSON.parse('{"__proto__":{}}')])assert.equal(validateEffectPlan(value).valid,false);
 const {plan,options}=fixture();plan.decisions[0].reason='x'.repeat(16385);assert.equal(validateEffectPlan(plan,options).valid,false);
 plan.self=plan;assert.equal(validateEffectPlan(plan,options).valid,false);
});
module.exports={fixture};
test('strict rule contracts reject unsupported predicates, capacities and missing provenance',()=>{
 const mutations=[
  (p,o)=>{p.decisions[0].rule.condition={type:'present'};},
  (p,o)=>{p.decisions[0].rule.condition={type:'present',threshold:1};},
  (p,o)=>{delete p.decisions[0].rule;},
  (p,o)=>{delete p.decisions[0].bindingId;},
  (p,o)=>{p.decisions[0].evidenceIds=['unknown'];},
  (p,o)=>{p.decisions[0].mechanicKey='unknown';},
  (p,o)=>{o.bindings[0].adapterContractVersion='2';},
  (p,o)=>{o.effects[0].implemented=false;},
  (p,o)=>{o.effects[0].resources=[];},
  (p,o)=>{delete o.effects[0].resources[0].styleProvenance;},
  (p,o)=>{p.decisions[0].rule.effectIds=['green','green'];},
  (p,o)=>{p.evidence[0].lineEnd=0;},
  (p,o)=>{p.evidence.push(structuredClone(p.evidence[0]));},
  (p,o)=>{p.decisions[0].rule.extra={shell:'bad'};},
  (p,o)=>{p.decisions[0].reason=3;},
  (p,o)=>{p.decisions[0].reason='';},
  (p,o)=>{p.decisions[0].rule.effectIds=[];},
  (p,o)=>{p.decisions[0].rule.priority=1001;},
  (p,o)=>{p.decisions=Array(1001).fill(p.decisions[0]);},
  (p,o)=>{p.evidence=Array(2001).fill(p.evidence[0]);},
  (p,o)=>{p.decisions[0].reason='x'.repeat(2097153);},
 ];
 mutations.forEach((mutate,index)=>{const {plan,options}=fixture();mutate(plan,options);assert.equal(validateEffectPlan(plan,options).valid,index===0,mutate.toString());});
 const {plan,options}=fixture();assert.equal(validateEffectPlan(plan).valid,false);
 options.sockets=[{id:'arrow'}];assert.equal(validateEffectPlan(plan,options).valid,true);
});

