'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validateAnimationInventory,assertAnimationInventory}=require('../lib/animation-inventory');
function fixture(){
 const hash='a'.repeat(64);
 const evidence=['b','c'].map((c,i)=>({id:c.repeat(64),path:'/Cards.cs',hash,symbol:'Card'+i,lineStart:i+1,lineEnd:i+1,excerpt:'Card'+i}));
 const inventory={version:1,characterId:'hero',fingerprint:hash,complete:true,sourceFiles:[{path:'/Cards.cs',hash}],diagnostics:[],evidence,mechanics:evidence.map((e,i)=>({key:'mod.Card'+i,modId:'mod',modelSymbol:e.symbol,evidenceIds:[e.id]}))};
 const artifact={version:1,characterId:'hero',mechanicsFingerprint:hash,inspectionVersion:'1',decisions:inventory.mechanics.map(m=>({mechanicKey:m.key,evidenceIds:m.evidenceIds.slice(),outcome:'animate',clipIds:['attack'],reason:'Shared attack motion'}))};
 return {artifact,options:{inventory,spec:{id:'hero',animations:[{id:'attack'}]}}};
}
test('shared clips validate without mutating input; assertion isolates and freezes',()=>{
 const {artifact,options}=fixture(),before=structuredClone({artifact,options});
 const result=validateAnimationInventory(artifact,options);
 assert.equal(result.valid,true);assert.equal(result.animationInventoryComplete,true);assert.deepEqual(result.referencedClipIds,['attack']);
 const copy=assertAnimationInventory(artifact,options);assert.ok(Object.isFrozen(copy.decisions[0].clipIds));assert.notEqual(copy,artifact);
 assert.deepEqual({artifact,options},before);
});
test('none completes and unresolved remains valid but incomplete',()=>{
 for(const outcome of ['none','unresolved']){const {artifact,options}=fixture();Object.assign(artifact.decisions[0],{outcome,clipIds:[]});const r=validateAnimationInventory(artifact,options);assert.equal(r.valid,true);assert.equal(r.complete,outcome==='none');assert.equal(r.diagnostics.length,outcome==='none'?0:1);}
});
test('rejects stale identity, incomplete inspection, uncovered mechanics and fabricated references',()=>{
 const mutations=[(a,o)=>a.characterId='other',(a,o)=>o.spec.id='other',(a)=>a.mechanicsFingerprint='d'.repeat(64),a=>a.inspectionVersion='2',(a,o)=>o.inventory.complete=false,(a,o)=>o.inventory.mechanics=[],a=>a.decisions.pop(),a=>a.decisions.push(a.decisions[0]),a=>a.decisions[0].mechanicKey='unknown',a=>a.decisions[0].evidenceIds=['d'.repeat(64)],a=>a.decisions[0].evidenceIds=[a.decisions[1].evidenceIds[0]],a=>a.decisions[0].clipIds=['missing'],a=>a.decisions[0].clipIds=['attack','attack'],a=>a.decisions[0].outcome='other',a=>a.decisions[0].clipIds=[],a=>a.decisions[0].outcome='none',(a,o)=>o.inventory.evidence.push(o.inventory.evidence[0]),(a,o)=>o.spec.animations.push({id:'attack'})];
 for(const mutate of mutations){const {artifact,options}=fixture();mutate(artifact,options);assert.equal(validateAnimationInventory(artifact,options).valid,false,mutate.toString());assert.throws(()=>assertAnimationInventory(artifact,options),{code:'INVALID_ANIMATION_INVENTORY'});}
});
test('rejects unsafe, oversized and nonplain JSON without invoking accessors',()=>{
 const values=[null,[],undefined,{version:1},JSON.parse('{"__proto__":{}}')];
 for(const value of values)assert.equal(validateAnimationInventory(value).valid,false);
 const changes=[a=>a.extra=true,a=>a.decisions[0].script='run',a=>a.decisions[0].reason=' ',a=>a.decisions[0].reason='é'.repeat(2049),a=>a.decisions=Array(1001).fill(a.decisions[0]),a=>a.decisions[0].clipIds=Array(65).fill('attack'),a=>a.decisions[0].reason='x'.repeat(2097153),a=>a.loop=a,a=>a.version=Infinity,a=>a.decisions[0].reason=()=>{},a=>a.decisions[0].reason=new String('x'),a=>Object.defineProperty(a,'surprise',{get(){throw Error('executed');},enumerable:true})];
 for(const mutate of changes){const {artifact,options}=fixture();mutate(artifact);assert.equal(validateAnimationInventory(artifact,options).valid,false,mutate.toString());}
 let nested={};for(let i=0;i<100;i++)nested={child:nested};assert.equal(validateAnimationInventory(nested).valid,false);
});
test('rejects malformed receipt and clip identity projections without invoking code',()=>{
 const changes=[(a,o)=>o.inventory.evidence[0].lineEnd=0,(a,o)=>o.inventory.mechanics[0].evidenceIds=['d'.repeat(64)],(a,o)=>o.inventory.mechanics[0].modelSymbol='Other',(a,o)=>o.inventory.mechanics.push(o.inventory.mechanics[0]),(a,o)=>o.inventory.fingerprint='bad',(a,o)=>o.spec.animations[0].id='bad id',(a,o)=>Object.defineProperty(o.spec,'id',{get(){throw Error('executed');}}),(a,o)=>Object.defineProperty(o.spec.animations,'0',{get(){throw Error('executed');}}),(a,o)=>Object.defineProperty(o.inventory,'version',{get(){throw Error('executed');}})];
 for(const mutate of changes){const {artifact,options}=fixture();mutate(artifact,options);assert.equal(validateAnimationInventory(artifact,options).valid,false,mutate.toString());}
});
test('malformed hash values return diagnostics without coercing JSON objects',()=>{
 for(const field of ['fingerprint','id','hash'])for(const value of [{toString:1},{toString:null},null,42,[]]){
  const {artifact,options}=fixture();if(field==='fingerprint')options.inventory.fingerprint=value;else options.inventory.evidence[0][field]=value;
  assert.equal(validateAnimationInventory(artifact,options).valid,false,field+JSON.stringify(value));
 }
});
test('accepts supported spec clip capacity and receipt unicode identifiers',()=>{
 const {artifact,options}=fixture();options.spec.animations=Array.from({length:10000},(_,i)=>({id:i?'clip'+i:'attack'}));
 const symbol='界'.repeat(2048),key='鍵'.repeat(2048);
 Object.assign(options.inventory.mechanics[0],{modelSymbol:symbol,key});
 Object.assign(options.inventory.evidence[0],{symbol,excerpt:symbol});artifact.decisions[0].mechanicKey=key;
 assert.equal(validateAnimationInventory(artifact,options).valid,true);
});
