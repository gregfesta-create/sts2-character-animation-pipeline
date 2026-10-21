'use strict';
const {assertEffectPlan}=require('./effect-plan');
const {isDeepStrictEqual}=require('node:util');
const budgets=new WeakMap();
function invalid(message){throw Object.assign(new Error(message),{code:'INVALID_EFFECT_STATE'});}
function frozen(value){const clone=structuredClone(value);const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};return freeze(clone);}
/** Shared scene ownership. Lower limits are useful for constrained hosts; never above 256. */
function createSceneBudget(limit=256){if(!Number.isInteger(limit)||limit<1||limit>256)invalid('Invalid scene capacity');const state={limit,used:0,projectiles:0};const budget=Object.freeze({get used(){return state.used;},get projectiles(){return state.projectiles;}});budgets.set(budget,state);return budget;}
/**
 * Pure presentation kernel; the trusted adapter supplies owner-tagged observations and native-clock seconds.
 * releaseAt/impactAt are offsets from captured startedAt, never absolute clock readings.
 * observe(facts), selectWhileActive(), captureAttack(context), markReleased(action,generation),
 * retainProjectile(action,generation,projectile), releaseProjectile(...), completeAttack(...),
 * cancelAttack(...), advance(nativeSeconds), combatEnd(), dispose(), status().
 * Projectile retention returns the same frozen snapshot; no method performs gameplay operations.
 */
function createEffectRuntime(plan,options){
 const accepted=assertEffectPlan(plan,options);const instance=options.characterInstance;
 if(typeof instance!=='string'||!instance.length||instance.length>256)invalid('Character instance required');
 const budget=options.sceneBudget||createSceneBudget();const scene=budgets.get(budget);if(!scene)invalid('Untrusted scene budget');
 const rules=accepted.decisions.filter(d=>d.outcome==='effect');const effects=new Map((options.effects||[]).map(e=>[e.id,frozen(e)]));
 let observation=null,lastObservation=null,disputedSequence=-1,clock=0,disposed=false,projectiles=0;const pending=new Map(),history=new Map(),diagnostics=[];
 const diagnostic=message=>{if(diagnostics.includes(message))return;if(diagnostics.length===128)diagnostics.shift();diagnostics.push(message);};
 const active=()=>{if(disposed)invalid('Character presentation disposed');};
 const key=(id,generation)=>{if(typeof id!=='string'||!id.length||id.length>256||!(typeof generation==='string'&&generation.length&&generation.length<=256||Number.isSafeInteger(generation)&&generation>=0))invalid('Action identity and generation required');return JSON.stringify([id,generation]);};
 const get=(id,generation)=>{const entry=pending.get(key(id,generation));if(!entry)invalid('Unknown or retired action');return entry;};
 function retire(entry){if(!pending.delete(entry.key))return;scene.used--;scene.projectiles-=entry.projectiles.size;projectiles-=entry.projectiles.size;entry.projectiles.clear();}
 function choose(scope){
  const channels=new Map(),owners=new Map();if(!observation)return [];
  for(const decision of rules){const rule=decision.rule;if(rule.scope!==scope)continue;const fact=observation.bindings[decision.bindingId];if(!fact||!fact.present||rule.condition.type==='amountAtLeast'&&fact.amount<rule.condition.threshold)continue;
   if(!owners.has(rule.channel))owners.set(rule.channel,[]);owners.get(rule.channel).push(decision);
   const previous=channels.get(rule.channel);if(!previous||rule.priority>previous.rule.priority||rule.priority===previous.rule.priority&&decision.id<previous.id)channels.set(rule.channel,decision);
  }
  for(const [channel,competing]of owners)if(competing.length>1)diagnostic('Exclusive channel '+channel+' owners='+competing.map(d=>d.id+'('+d.mechanicKey+')').sort().join(',')+' winner='+channels.get(channel).id);
  return [...channels.values()].sort((a,b)=>a.rule.channel<b.rule.channel?-1:a.rule.channel>b.rule.channel?1:0).map(d=>({ruleId:d.id,...d.rule,effects:d.rule.effectIds.map(id=>effects.get(id))}));
 }
 function observe(facts){
  active();if(!facts||facts.characterInstance!==instance||!Number.isSafeInteger(facts.sequence)||facts.sequence<0||facts.adapterContractVersion!==accepted.adapterContractVersion||!facts.bindings||typeof facts.bindings!=='object'||Array.isArray(facts.bindings)){observation=null;diagnostic('Invalid observation envelope; effects suppressed');invalid('Invalid observation envelope');}
  if(lastObservation&&facts.sequence<lastObservation.sequence)invalid('Stale observation');
  const bindings={};for(const id of new Set(rules.map(d=>d.bindingId))){const fact=Object.hasOwn(facts.bindings,id)?facts.bindings[id]:null;if(!fact||typeof fact.present!=='boolean'||typeof fact.amount!=='number'||!Number.isFinite(fact.amount)){diagnostic('Missing or invalid authoritative observation: '+id);continue;}bindings[id]={present:fact.present,amount:fact.amount};}
  const next=frozen({characterInstance:instance,sequence:facts.sequence,adapterContractVersion:facts.adapterContractVersion,bindings});
  if(lastObservation&&next.sequence===lastObservation.sequence){if(!isDeepStrictEqual(next,lastObservation)){observation=null;disputedSequence=next.sequence;diagnostic('Conflicting observation sequence '+next.sequence+'; newer verified facts required');invalid('Conflicting observation sequence');}if(next.sequence<=disputedSequence)invalid('Disputed observation sequence requires newer facts');observation=lastObservation;return observation;}
  observation=next;lastObservation=next;return observation;
 }
 function captureAttack(context){
  active();if(!context||context.preConsumption!==true||context.characterInstance!==undefined&&context.characterInstance!==instance)invalid('Verified pre-consumption owner required');
  const id=key(context.actionInstance,context.generation);
  const validTarget=context.target===undefined||typeof context.target==='string'&&context.target.length>0&&context.target.length<=256||context.target&&typeof context.target==='object'&&!Array.isArray(context.target)&&Object.keys(context.target).every(k=>['position','valid'].includes(k))&&typeof context.target.valid==='boolean'&&Array.isArray(context.target.position)&&context.target.position.length===2&&context.target.position.every(Number.isFinite);
  if(!Number.isFinite(context.releaseAt)||!Number.isFinite(context.impactAt)||context.releaseAt<0||context.impactAt<=context.releaseAt||context.impactAt>10||!validTarget)invalid('Invalid authoritative action timing or target');
  const facts={characterInstance:instance,actionInstance:context.actionInstance,generation:context.generation,observationSequence:context.observationSequence,releaseAt:context.releaseAt,impactAt:context.impactAt,...(context.target===undefined?{}:{target:context.target})};
  if(history.has(id)){const entry=history.get(id);if(!isDeepStrictEqual(entry.facts,facts))invalid('Conflicting duplicate action capture');if(!pending.has(id))invalid('Action generation already retired');return entry.snapshot;}
  if(!observation||context.observationSequence!==observation.sequence)invalid('Verified current pre-consumption observation and bounded timing required');
  if(pending.size>=32||scene.used>=scene.limit||history.size>=1024)invalid('Presentation snapshot capacity exceeded');
  const snapshot=frozen({...facts,startedAt:clock,selectedEffects:choose('attackSnapshot')});const entry={key:id,facts:frozen(facts),snapshot,createdAt:clock,released:false,completed:false,projectiles:new Set()};pending.set(id,entry);history.set(id,entry);scene.used++;return snapshot;
 }
 function clear(){for(const entry of pending.values())retire(entry);history.clear();observation=null;lastObservation=null;disputedSequence=-1;}
 return Object.freeze({
  observe,captureAttack,
  selectWhileActive(){active();return frozen(choose('whileActive'));},
  markReleased(id,generation){active();const entry=get(id,generation);if(entry.completed)invalid('Completed action cannot release');entry.released=true;return entry.snapshot;},
  retainProjectile(id,generation,projectile){active();const entry=get(id,generation);if(typeof projectile!=='string'||!projectile.length||projectile.length>256||entry.completed||!entry.released)invalid('Invalid projectile ownership; action must be released');if(!entry.projectiles.has(projectile)){if(projectiles>=32||scene.projectiles>=256)invalid('Projectile capacity exceeded');entry.projectiles.add(projectile);projectiles++;scene.projectiles++;}return entry.snapshot;},
  releaseProjectile(id,generation,projectile){const entry=pending.get(key(id,generation));if(!entry)return false;if(entry.projectiles.delete(projectile)){projectiles--;scene.projectiles--;}if(entry.completed&&!entry.projectiles.size)retire(entry);return true;},
  completeAttack(id,generation){active();const entry=get(id,generation);entry.completed=true;if(!entry.released||!entry.projectiles.size)retire(entry);},
  cancelAttack(id,generation){active();const entry=get(id,generation);entry.completed=true;if(!entry.released||!entry.projectiles.size)retire(entry);},
  advance(time){active();if(!Number.isFinite(time)||time<clock)invalid('Native clock must be monotonic');clock=time;for(const entry of pending.values())if(clock-entry.createdAt>=10){diagnostic('Snapshot lifetime expired: '+entry.snapshot.actionInstance);retire(entry);}},
  combatEnd(){active();clear();},
  dispose(){clear();disposed=true;},
  status(){return frozen({characterInstance:instance,pending:pending.size,projectiles,clock,disposed,diagnostics});}
 });
}
module.exports={createSceneBudget,createEffectRuntime};
