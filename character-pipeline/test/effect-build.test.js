'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {inspectMechanics}=require('../lib/mechanics');
const {hashValue}=require('../lib/assets');
const {captureEffectPlan}=require('../lib/effect-build');
async function fixture(t,outcome='effect'){
 const base=path.resolve(__dirname,'../../.tmp/effect-build');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'case-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const mechanics=path.join(root,'mechanics');await fs.mkdir(mechanics);const source=path.join(mechanics,'Power.cs');await fs.writeFile(source,'class PoisonPower { int Amount; }');
 const declaration={characterId:'hero',sourceRoots:[mechanics],mechanics:[{key:'mod.Poison',modId:'mod',modelSymbol:'PoisonPower',evidence:[{path:source,symbol:'PoisonPower',lineStart:1,lineEnd:1}]}]};
 const inventory=await inspectMechanics(declaration),styleHash=hashValue({palette:'green'}),resource=path.join(root,'overlay.png');await fs.writeFile(resource,'synthetic resource');
 const sha256=require('node:crypto').createHash('sha256').update('synthetic resource').digest('hex');
 const decision={id:'poison',mechanicKey:'mod.Poison',outcome,reason:'Synthetic visible poison',evidenceIds:inventory.mechanics[0].evidenceIds};
 if(outcome==='effect')Object.assign(decision,{bindingId:'power',rule:{effectIds:['green'],condition:{type:'present'},scope:'whileActive',socketId:'tip',channel:'tip',priority:1}});
 const plan={version:1,characterId:'hero',mechanicsFingerprint:inventory.fingerprint,inspectionVersion:'1',adapterContractVersion:'synthetic-v1',evidence:inventory.evidence,decisions:[decision]};
 const request={characterId:'hero',planPath:path.join(root,'plan.json'),inventoryPath:path.join(root,'inventory.json')};
 await fs.writeFile(request.planPath,JSON.stringify(plan));await fs.writeFile(request.inventoryPath,JSON.stringify(inventory));
 const calls=[];const options={config:{sourceRoots:[root],mechanics:{sourceRoots:[mechanics]}},styleHash,approval:async record=>{calls.push(record);return record.approvalId==='synthetic-approved';},capabilities:{version:'synthetic-catalog-v1',adapterContractVersion:'synthetic-v1',gameFingerprint:'synthetic-game',baseLibFingerprint:'synthetic-baselib',supportsEffect:effect=>effect.capability==='overlay',bindings:[{id:'power',mechanicKey:'mod.Poison',adapterContractVersion:'synthetic-v1'}],sockets:['tip'],effects:[{id:'green',capability:'overlay',resources:[{path:resource,sha256,importSettings:{filter:false},styleHash,approvalId:'synthetic-approved'}]}]}};
 return {root,mechanics,source,request,options,plan,inventory,resource,calls};
}
test('captures validated root effects and verified resources as immutable data',async t=>{
 const f=await fixture(t),result=await captureEffectPlan(f.request,f.options);
 assert.equal(result.status,'validated');assert.equal(result.plan.decisions[0].outcome,'effect');assert.equal(f.calls.length,1);assert.equal(result.resources.length,1);
 assert.equal(Buffer.from(result.resources[0].base64,'base64').toString(),'synthetic resource');assert.ok(Object.isFrozen(result.resources[0]));assert.ok(Object.isFrozen(result.plan));
 assert.equal((await captureEffectPlan(f.request,f.options)).fingerprint,result.fingerprint);
 f.options.capabilities.version='catalog-v2';assert.notEqual((await captureEffectPlan(f.request,f.options)).fingerprint,result.fingerprint);
});
test('missing live sources or trusted capabilities suppress activation with diagnostics',async t=>{
 const f=await fixture(t);let result=await captureEffectPlan(f.request,{...f.options,capabilities:undefined});assert.equal(result.status,'unresolved');assert.equal(result.plan,null);assert.ok(result.diagnostics.length);
 await fs.rename(f.mechanics,f.mechanics+'-denied');result=await captureEffectPlan(f.request,f.options);assert.equal(result.status,'unresolved');assert.equal(result.plan,null);
});
test('stale mechanics and altered resource content reject positive artifacts',async t=>{
 const f=await fixture(t);await fs.writeFile(f.source,'class PoisonPower { int Amount; int Changed; }');await assert.rejects(captureEffectPlan(f.request,f.options),{code:'STALE_EFFECT_PLAN'});
 await fs.writeFile(f.source,'class PoisonPower { int Amount; }');await fs.writeFile(f.resource,'modified bytes');await assert.rejects(captureEffectPlan(f.request,f.options),{code:'CORRUPT_ARTIFACT'});
});
test('capability and artwork claims require trusted implementation and approval verification',async t=>{
 const f=await fixture(t);f.options.capabilities.effects[0].implemented=true;f.options.capabilities.supportsEffect=()=>false;
 let result=await captureEffectPlan(f.request,f.options);assert.equal(result.status,'unresolved');assert.equal(result.plan,null);
 f.options.capabilities.supportsEffect=()=>true;f.options.approval=async()=>false;
 result=await captureEffectPlan(f.request,f.options);assert.equal(result.status,'unresolved');assert.equal(result.plan,null);
 f.options.capabilities.effects[0].capability='trail';result=await captureEffectPlan(f.request,f.options);assert.equal(result.status,'unresolved');
});
test('inactive complete decisions validate without a native catalog; malformed input still rejects',async t=>{
 const f=await fixture(t,'none');assert.equal((await captureEffectPlan(f.request,{...f.options,capabilities:undefined})).status,'validated');
 f.plan.decisions[0].command='run';await fs.writeFile(f.request.planPath,JSON.stringify(f.plan));await assert.rejects(captureEffectPlan(f.request,{...f.options,capabilities:undefined}),{code:'INVALID_EFFECT_PLAN'});
 await fs.writeFile(f.request.planPath,'x'.repeat(2*1024*1024+1));await assert.rejects(captureEffectPlan(f.request,f.options),{code:'QUOTA_EXCEEDED'});
});
test('root identity, containment, binding versions and cancellation fail explicitly',async t=>{
 const f=await fixture(t);await assert.rejects(captureEffectPlan({...f.request,characterId:'another'},f.options),{code:'INVALID_EFFECT_PLAN'});
 await assert.rejects(captureEffectPlan({...f.request,planPath:'../escape'},f.options),{code:'UNSAFE_PATH'});
 f.options.capabilities.bindings[0].adapterContractVersion='wrong';await assert.rejects(captureEffectPlan(f.request,f.options),{code:'INVALID_EFFECT_PLAN'});
 const signal=AbortSignal.abort();await assert.rejects(captureEffectPlan(f.request,{...f.options,signal}),{code:'ABORTED'});
});

test('missing sources cannot hide malformed decisions or stale supplied receipt identity',async t=>{
 const f=await fixture(t);await fs.rename(f.mechanics,f.mechanics+'-denied');delete f.plan.decisions[0].bindingId;
 await fs.writeFile(f.request.planPath,JSON.stringify(f.plan));await assert.rejects(captureEffectPlan(f.request,f.options),{code:'INVALID_EFFECT_PLAN'});
});
test('membership, import settings, approvals and native version fingerprints are enforced',async t=>{
 const f=await fixture(t),original=await captureEffectPlan(f.request,f.options);
 f.options.capabilities.effects[0].resources[0].importSettings.filter=true;
 assert.notEqual((await captureEffectPlan(f.request,f.options)).fingerprint,original.fingerprint);
 f.options.capabilities.gameFingerprint='another-game';assert.notEqual((await captureEffectPlan(f.request,f.options)).fingerprint,original.fingerprint);
 await fs.writeFile(path.join(f.mechanics,'NewPower.cs'),'class NewPower {}');await assert.rejects(captureEffectPlan(f.request,f.options),{code:'STALE_EFFECT_PLAN'});
});

test('capability-independent rule and channel bounds reject even without live roots',async t=>{
 for(const [count,channels]of [[65,1],[9,9]]){
  const f=await fixture(t);f.inventory.mechanics=Array.from({length:count},(_,i)=>({...f.inventory.mechanics[0],key:'mod.Power'+i}));
  f.plan.decisions=Array.from({length:count},(_,i)=>({...structuredClone(f.plan.decisions[0]),id:'rule'+i,mechanicKey:'mod.Power'+i,bindingId:'binding'+i,rule:{...structuredClone(f.plan.decisions[0].rule),channel:'channel'+i%channels}}));
  await fs.writeFile(f.request.inventoryPath,JSON.stringify(f.inventory));await fs.writeFile(f.request.planPath,JSON.stringify(f.plan));await fs.rename(f.mechanics,f.mechanics+'-denied');
  await assert.rejects(captureEffectPlan(f.request,{...f.options,capabilities:undefined}),{code:'INVALID_EFFECT_PLAN'});
 }
});
test('duplicate resource aliases retain one immutable payload record per hash',async t=>{
 const f=await fixture(t);const resource=f.options.capabilities.effects[0].resources[0];
 f.options.capabilities.effects[0].resources=Array.from({length:20},()=>({...resource}));
 const result=await captureEffectPlan(f.request,f.options);
 assert.equal(result.captures.filter(r=>r.kind==='resource').length,1);
 assert.equal(result.resources.length,1);
});

test('captured resource locator changes preserve semantic effect fingerprint and recheck approval',async t=>{
 const f=await fixture(t),first=await captureEffectPlan(f.request,f.options);const copy=path.join(f.root,'captured-resource');await fs.copyFile(f.resource,copy);f.options.capabilities.effects[0].resources[0].path=copy;
 const next=await captureEffectPlan(f.request,f.options);assert.equal(next.fingerprint,first.fingerprint);assert.equal(f.calls.length,2);
 f.options.approval=async()=>false;assert.equal((await captureEffectPlan(f.request,f.options)).status,'unresolved');
});
