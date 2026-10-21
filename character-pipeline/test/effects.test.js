'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createEffectRuntime,createSceneBudget}=require('../lib/effects');
const hash='a'.repeat(64);
function setup(extra={}){
 const evidence={id:'ev',path:'Power.cs',hash,symbol:'Power',lineStart:1,lineEnd:2,excerpt:'amount'};
 const plan={version:1,characterId:'hero',mechanicsFingerprint:hash,inspectionVersion:'1',adapterContractVersion:'1',evidence:[evidence],decisions:[{id:'poison',mechanicKey:'mod.Power',outcome:'effect',reason:'Poison tip',evidenceIds:['ev'],bindingId:'power',rule:{effectIds:['green'],condition:{type:'amountAtLeast',threshold:1},scope:'attackSnapshot',socketId:'arrow',channel:'tip',priority:1}}]};
 const options={inventory:{version:1,characterId:'hero',fingerprint:hash,evidence:[evidence],mechanics:[{key:'mod.Power',evidenceIds:['ev']}]},bindings:[{id:'power',mechanicKey:'mod.Power',adapterContractVersion:'1'}],effects:[{id:'green',capability:'tint',implemented:true,resources:[{sha256:hash,importSettings:{},styleProvenance:'style',approvalProvenance:'approved'}]}],sockets:['arrow'],characterInstance:'hero-1',...extra};
 return {plan,options,runtime:createEffectRuntime(plan,options)};
}
const fact=(sequence,amount)=>({characterInstance:'hero-1',sequence,adapterContractVersion:'1',bindings:{power:{present:amount>0,amount}}});
const action=(id,sequence=1)=>({actionInstance:id,generation:1,preConsumption:true,observationSequence:sequence,target:'enemy',releaseAt:1,impactAt:2});
test('last-charge attack keeps immutable presentation across multi-arrow ownership and subsequent attacks refresh',()=>{
 const {runtime}=setup();const observation=fact(1,1);runtime.observe(observation);const snapshot=runtime.captureAttack(action('one'));assert.equal(snapshot.selectedEffects.length,1);assert.ok(Object.isFrozen(snapshot.selectedEffects));assert.equal(runtime.captureAttack(action('one')),snapshot);
 assert.throws(()=>runtime.retainProjectile('one',1,'early'),{code:'INVALID_EFFECT_STATE'});runtime.markReleased('one',1);const one=runtime.retainProjectile('one',1,'arrow-1');const two=runtime.retainProjectile('one',1,'arrow-2');runtime.observe(fact(2,0));assert.equal(snapshot.selectedEffects.length,1);assert.equal(runtime.captureAttack(action('two',2)).selectedEffects.length,0);assert.equal(observation.bindings.power.amount,1);
 runtime.markReleased('one',1);runtime.completeAttack('one',1);runtime.releaseProjectile('one',1,'arrow-1');assert.equal(runtime.status().pending,2);runtime.releaseProjectile('one',1,'arrow-2');assert.equal(runtime.status().pending,1);assert.equal(one,two);runtime.dispose();assert.equal(runtime.status().pending,0);assert.equal(snapshot.selectedEffects.length,1);
});
test('rejects uncertain capture, duplicate conflicts and stale observations while missing facts suppress effects',()=>{
 const {runtime}=setup();assert.throws(()=>runtime.captureAttack(action('one')),{code:'INVALID_EFFECT_STATE'});runtime.observe(fact(1,1));runtime.observe(fact(1,1));assert.throws(()=>runtime.observe(fact(1,0)),{code:'INVALID_EFFECT_STATE'});assert.throws(()=>runtime.observe(fact(0,1)),{code:'INVALID_EFFECT_STATE'});
 assert.throws(()=>runtime.captureAttack({...action('one'),preConsumption:false}),{code:'INVALID_EFFECT_STATE'});runtime.observe(fact(2,1));runtime.captureAttack(action('one',2));assert.throws(()=>runtime.captureAttack({...action('one',2),target:'other'}),{code:'INVALID_EFFECT_STATE'});
 runtime.observe({characterInstance:'hero-1',sequence:3,adapterContractVersion:'1',bindings:{}});assert.equal(runtime.captureAttack(action('two',3)).selectedEffects.length,0);assert.ok(runtime.status().diagnostics.length);
});
test('bounded ownership expires on native clock, cancels before release and shares scene capacity',()=>{
 const sceneBudget=createSceneBudget(1);const {runtime}=setup({sceneBudget});runtime.observe(fact(1,1));runtime.captureAttack(action('one'));assert.throws(()=>runtime.captureAttack(action('two')),{code:'INVALID_EFFECT_STATE'});runtime.cancelAttack('one',1);assert.throws(()=>runtime.retainProjectile('one',1,'p'),{code:'INVALID_EFFECT_STATE'});runtime.captureAttack(action('two'));runtime.advance(10);assert.equal(runtime.status().pending,0);assert.equal(sceneBudget.used,0);assert.throws(()=>runtime.advance(9),{code:'INVALID_EFFECT_STATE'});
});
module.exports={setup,fact,action};
test('relative timing supports attacks after clock advancement, owner isolation and no-effect catalogs',()=>{
 const {runtime,plan,options}=setup();runtime.advance(5);runtime.observe({...fact(1,1),characterInstance:'hero-1'});
 const context={...action('late'),releaseAt:.3,impactAt:.6};const snapshot=runtime.captureAttack(context);runtime.advance(5.2);assert.equal(runtime.captureAttack(context),snapshot);
 assert.throws(()=>runtime.captureAttack({...action('zero'),releaseAt:.3,impactAt:.3}),{code:'INVALID_EFFECT_STATE'});
 assert.throws(()=>runtime.observe({...fact(2,1),characterInstance:'other-archer'}),{code:'INVALID_EFFECT_STATE'});assert.equal(runtime.selectWhileActive().length,0);
 plan.decisions[0].outcome='none';delete plan.decisions[0].rule;delete plan.decisions[0].bindingId;delete options.effects;
 assert.equal(createEffectRuntime(plan,options).selectWhileActive().length,0);
});
test('exclusive channels select stable priority winners and invalid contract suppresses active visuals',()=>{
 const {plan,options}=setup();plan.decisions[0].rule.scope='whileActive';
 for(const [id,priority]of [['z',5],['a',5]]){const d=structuredClone(plan.decisions[0]);d.id=id;d.mechanicKey='mod.'+id;d.bindingId=id;d.rule.priority=priority;if(id==='a')d.rule.condition={type:'present'};plan.decisions.push(d);options.inventory.mechanics.push({key:d.mechanicKey,evidenceIds:['ev']});options.bindings.push({id,mechanicKey:d.mechanicKey,adapterContractVersion:'1'});}
 const runtime=createEffectRuntime(plan,options);runtime.observe({characterInstance:'hero-1',sequence:1,adapterContractVersion:'1',bindings:{power:{present:true,amount:1},a:{present:true,amount:-1},z:{present:true,amount:1}}});assert.equal(runtime.selectWhileActive()[0].ruleId,'a');
 assert.throws(()=>runtime.observe({...fact(2,1),adapterContractVersion:'bad'}),{code:'INVALID_EFFECT_STATE'});assert.equal(runtime.selectWhileActive().length,0);runtime.combatEnd();assert.equal(runtime.status().pending,0);runtime.dispose();assert.throws(()=>runtime.observe(fact(3,1)),{code:'INVALID_EFFECT_STATE'});
});
test('conflicting observation quarantines its sequence until newer facts without changing existing snapshots',()=>{
 const {runtime}=setup();runtime.observe(fact(1,1));const snapshot=runtime.captureAttack(action('kept'));
 assert.throws(()=>runtime.observe(fact(1,0)),{code:'INVALID_EFFECT_STATE'});
 assert.throws(()=>runtime.captureAttack(action('blocked')),{code:'INVALID_EFFECT_STATE'});
 assert.throws(()=>runtime.observe(fact(1,1)),{code:'INVALID_EFFECT_STATE'});
 assert.equal(snapshot.selectedEffects.length,1);assert.ok(runtime.status().diagnostics.some(d=>d.includes('Conflicting observation')));
 runtime.observe(fact(2,0));assert.equal(runtime.captureAttack(action('new',2)).selectedEffects.length,0);
});
test('exclusive-channel conflict diagnostic names all owners and stable winner without repeated selection spam',()=>{
 const {plan,options}=setup();plan.decisions[0].rule.scope='whileActive';
 const d=structuredClone(plan.decisions[0]);d.id='alternate';d.mechanicKey='mod.Other';d.bindingId='other';plan.decisions.push(d);options.inventory.mechanics.push({key:d.mechanicKey,evidenceIds:['ev']});options.bindings.push({id:'other',mechanicKey:d.mechanicKey,adapterContractVersion:'1'});
 const runtime=createEffectRuntime(plan,options);runtime.observe({...fact(1,1),bindings:{power:{present:true,amount:1},other:{present:true,amount:1}}});
 runtime.selectWhileActive();const diagnostic=runtime.status().diagnostics.find(d=>d.includes('tip')&&d.includes('poison')&&d.includes('alternate')&&d.includes('mod.Power')&&d.includes('mod.Other')&&d.includes('winner=alternate'));assert.ok(diagnostic);
 runtime.selectWhileActive();assert.equal(runtime.status().diagnostics.filter(d=>d===diagnostic).length,1);
});
