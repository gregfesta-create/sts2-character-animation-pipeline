'use strict';

require('node:test')('component event capabilities use handler types rather than per-cue identities', () => {
 const {componentEventNames}=require('../lib/components');
 const assert=require('node:assert/strict');
 assert.deepEqual(componentEventNames({animations:[{events:[
  {id:'firstTwang',type:'sound',payload:{sound:'twang'}},
  {id:'secondTwang',type:'sound',payload:{sound:'twang'}},
  {id:'arrowRelease',type:'projectile',payload:{projectile:'arrow'}},
  {id:'clampCue',name:'clamp'}
 ]}]}),['clamp','projectile','sound']);
});
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createAssemblyPlanner}=require('../lib/components');
const frame=()=>({position:[0,0],rotation:0,scale:[1,1]});
const inheritance=()=>({position:true,rotation:true,scale:true});
const descriptor=(type='arm')=>({version:1,type,spec:'components/'+type+'.json',mount:frame(),dimensions:[20,40],styleHash:'a'.repeat(64),eventNames:['fire'],layer:1,inheritance:inheritance()});
const config=()=>({styleHash:'a'.repeat(64),eventNames:['fire'],sockets:[{id:'left',bone:'shoulder',transform:frame(),types:['arm','claw'],capacity:1,inheritance:inheritance(),layer:1,envelope:[40,80]}],descriptors:[descriptor(),descriptor('claw')]});
const component=(id='weapon',type='arm')=>({id,type,socket:'left',revision:1,damageState:'intact',upgrade:0,visualMode:'idle'});
const state=(components=[],revision=1,lifecycle='alive')=>({version:1,instanceId:'robot',sequence:revision,revision,lifecycle,visualMode:'idle',components});
test('immutable install/remove plans preserve chassis and isolate caller data',()=>{
 const c=config(),p=createAssemblyPlanner(c),next=state([component()],2);
 c.descriptors[0].spec='changed';
 const out=p.plan(state(),next);
 assert.equal(out.preserveChassis,true);assert.equal(out.instructions.find(x=>x.action==='mount').spec,'components/arm.json');
 assert.deepEqual(out.instructions.find(x=>x.action==='mount').frame,[1,0,0,1,0,0]);
 assert.ok(Object.isFrozen(out.instructions[0]));next.components[0].upgrade=4;
 assert.equal(out.instructions.find(x=>x.action==='mount').state.upgrade,0);
 assert.deepEqual(p.plan(state([component()]),state([],2)).instructions.map(x=>x.action),['cancel','transition','unmount']);
 assert.equal(p.plan(state(),state()).instructions.length,0);
});
test('replacement, upgrades, repair, damage, destruction and lifecycle are explicit',()=>{
 const p=createAssemblyPlanner(config()),a=component(),kind=(next)=>p.plan(state([a]),state([next],2)).instructions.filter(x=>x.action==='transition').map(x=>x.kind);
 assert.deepEqual(kind({...a,type:'claw',revision:2}),['replace','install']);
 assert.deepEqual(kind({...a,upgrade:1,revision:2}),['upgrade']);
 assert.deepEqual(kind({...a,damageState:'damaged',revision:2}),['damage']);
 assert.deepEqual(kind({...a,damageState:'destroyed',revision:2}),['destroy']);
 assert.deepEqual(p.plan(state([{...a,damageState:'damaged'}]),state([{...a,revision:2}],2)).instructions.filter(x=>x.action==='transition').map(x=>x.kind),['repair']);
 assert.equal(p.plan(state(),state([],2,'dead')).instructions.at(-1).kind,'death');
 assert.equal(p.plan(state([],1,'dead'),state([],2)).instructions.at(-1).kind,'revive');
});
test('mount inverse aligns pivot and rejects unsupported transforms/contracts',()=>{
 const c=config();c.sockets[0].transform.position=[100,50];c.descriptors[0].mount.position=[10,20];
 assert.deepEqual(createAssemblyPlanner(c).plan(state(),state([component()],2)).instructions.find(x=>x.action==='mount').frame,[1,0,0,1,90,30]);
 for(const mutate of [c=>c.sockets[0].transform.scale[0]=0,c=>c.descriptors[0].dimensions=[100,200],c=>c.descriptors[0].styleHash='b'.repeat(64),c=>c.descriptors[0].eventNames=['unknown'],c=>c.descriptors[0].layer=2,c=>c.descriptors[0].inheritance.rotation=false,c=>c.descriptors[0].spec='../escape',c=>c.descriptors[0].command='execute']) {
  const bad=config();mutate(bad);assert.throws(()=>createAssemblyPlanner(bad),{code:'INVALID_COMPONENT'});
 }
});
test('signed scales preserve mirrored socket and component mount alignment',()=>{
 const c=config();c.descriptors=[descriptor()];c.descriptors[0].mount.position=[10,20];c.descriptors[0].mount.scale=[-2,1];
 c.sockets[0].transform.position=[100,50];c.sockets[0].transform.scale=[-1,2];
 const mount=createAssemblyPlanner(c).plan(state(),state([component()],2)).instructions.find(x=>x.action==='mount');
 assert.deepEqual(mount.frame,[0.5,0,0,2,95,10]);
 assert.deepEqual([mount.frame[0]*10+mount.frame[2]*20+mount.frame[4],mount.frame[1]*10+mount.frame[3]*20+mount.frame[5]],[100,50]);
 c.descriptors[0].mount.rotation=Math.PI/2;c.descriptors[0].mount.scale=[-2,-1];c.sockets[0].envelope=[21,21];
 assert.doesNotThrow(()=>createAssemblyPlanner(c));
 c.descriptors[0].mount.scale[0]=0;assert.throws(()=>createAssemblyPlanner(c),{code:'INVALID_COMPONENT'});
});
test('reject unknown types, full sockets, stale/conflicting states and accessor data',()=>{
 const p=createAssemblyPlanner(config());
 for(const next of [state([component('a','wrong')]),state([component('a'),component('b')]),state([{...component(),socket:'missing'}]),state([component(),component()])])assert.throws(()=>p.plan(state(),next),{code:'INVALID_COMPONENT'});
 assert.throws(()=>p.plan(state([],2),state([],1)),{code:'INVALID_COMPONENT'});
 assert.throws(()=>p.plan(state([component()]),state([{...component(),upgrade:1}],2)),{code:'INVALID_COMPONENT'});
 const c=config();Object.defineProperty(c,'styleHash',{get(){throw Error('executed');},enumerable:true});
 assert.throws(()=>createAssemblyPlanner(c),{code:'INVALID_COMPONENT'});
});
test('rotated nonuniform mount envelopes are measured in socket coordinates',()=>{
 const c=config();c.descriptors=[descriptor()];c.descriptors[0].mount.rotation=Math.PI/2;c.descriptors[0].mount.scale=[2,1];
 c.sockets[0].envelope=[21,21];
 assert.doesNotThrow(()=>createAssemblyPlanner(c));
 c.sockets[0].envelope=[19,21];assert.throws(()=>createAssemblyPlanner(c),{code:'INVALID_COMPONENT'});
});
test('conflicting physical mounts, mixed instances, removed resurrection and malformed input fail closed',()=>{
 const c=config();c.sockets[0].capacity=2;const p=createAssemblyPlanner(c);
 assert.throws(()=>p.plan(state(),state([component('a'),component('b')],2)),{code:'INVALID_COMPONENT'});
 assert.throws(()=>p.plan(state(),{...state([],2),instanceId:'other'}),{code:'INVALID_COMPONENT'});
 assert.throws(()=>p.plan(state([],1,'removed'),state([],2)),{code:'INVALID_COMPONENT'});
 assert.throws(()=>p.plan(state(),{...state([],2),components:[{...component(),damageState:'unknown'}]}),{code:'INVALID_COMPONENT'});
 for(const bad of [null,[],{...config(),sockets:new Array(1)},{...config(),descriptors:[{...descriptor(),mount:{...frame(),rotation:Infinity}}]}])assert.throws(()=>createAssemblyPlanner(bad),{code:'INVALID_COMPONENT'});
 const removed=p.plan(state([component()]),state([],2,'removed'));
 assert.ok(removed.instructions.some(x=>x.action==='cancelAll'));
 const mode=p.plan(state(),{...state([],2),visualMode:'attack'});
 assert.deepEqual(mode.instructions.at(-1),{action:'visualMode',mode:'attack'});
});
test('socket type bound matches reconciler and lifecycle cancellation precedes new work',()=>{
 const c=config();c.sockets[0].types=['arm','claw',...Array.from({length:63},(_,i)=>'type'+i)];
 assert.throws(()=>createAssemblyPlanner(c),{code:'INVALID_COMPONENT'});
 const p=createAssemblyPlanner(config());
 const revived=p.plan(state([],1,'dead'),state([component()],2));
 assert.equal(revived.instructions[0].action,'cancelAll');
 assert.ok(revived.instructions.findIndex(x=>x.action==='mount')>revived.instructions.findIndex(x=>x.action==='cancelAll'));
 const died=p.plan(state([component()]),state([{...component(),revision:2,damageState:'destroyed'}],2,'dead'));
 assert.equal(died.instructions[0].action,'cancelAll');
 assert.ok(died.instructions.findIndex(x=>x.kind==='destroy')>died.instructions.findIndex(x=>x.action==='cancelAll'));
});


test('bootstrap accepts the first genuine revision and emits complete immutable initial presentation',()=>{
 const planner=createAssemblyPlanner(config()),snapshot={...state([component()],1),sequence:0};
 const result=planner.bootstrap(snapshot);
 assert.deepEqual(Object.keys(result).sort(),['instanceId','instructions','preserveChassis','version']);
 assert.deepEqual(result.instructions.map(i=>i.action),['mount','transition','lifecycle','visualMode']);
 assert.deepEqual(result.instructions.slice(0,2),planner.plan(state([],1),state([component()],2)).instructions);
 assert.deepEqual(result.instructions.slice(-2),[{action:'lifecycle',kind:'revive'},{action:'visualMode',mode:'idle'}]);
 assert.equal(snapshot.revision,1);assert.equal(snapshot.sequence,0);assert.ok(Object.isFrozen(result.instructions[0].state));snapshot.components[0].upgrade=8;assert.equal(result.instructions[0].state.upgrade,0);
});
test('bootstrap establishes death and terminal removal without a fabricated predecessor',()=>{
 const planner=createAssemblyPlanner(config());
 const dead={...state([{...component(),damageState:'destroyed'}],7,'dead'),sequence:11,visualMode:'guard'};
 const out=planner.bootstrap(dead);assert.equal(out.instructions[0].state.damageState,'destroyed');assert.deepEqual(out.instructions.slice(-2),[{action:'lifecycle',kind:'death'},{action:'visualMode',mode:'guard'}]);
 assert.deepEqual(planner.bootstrap({...state([],1,'removed'),sequence:0}).instructions,[{action:'lifecycle',kind:'removed'},{action:'visualMode',mode:'idle'}]);
 assert.deepEqual(planner.bootstrap({...state([],1),sequence:0}).instructions,[{action:'lifecycle',kind:'revive'},{action:'visualMode',mode:'idle'}]);
});
test('bootstrap rejects invalid authoritative snapshots and registry conflicts',()=>{
 const planner=createAssemblyPlanner(config());
 for(const bad of [null,{...state(),revision:0},{...state(),sequence:null},{...state(),extra:true},state([component()],1,'removed'),state([component(),component('other')]),state([{...component(),type:'unknown'}]),state([{...component(),damageState:'unknown'}])])assert.throws(()=>planner.bootstrap(bad),{code:'INVALID_COMPONENT'});
 assert.deepEqual(planner.plan(state(),state()).instructions,[]);
});

test('transition profiles validate exact bounded immutable choreography and exact safe child clips',()=>{
 const {validateTransitionProfiles,assertTransitionClipCompatibility}=require('../lib/components');
 const input={install:{duration:1,phases:[{id:'begin',time:0},{id:'lock',time:.5,clip:'lock'},{id:'reveal',time:.5}]},remove:{duration:0,phases:[]}};
 const result=validateTransitionProfiles(input);assert.deepEqual(result,input);assert.ok(Object.isFrozen(result.install.phases[0]));input.install.phases[0].id='changed';assert.equal(result.install.phases[0].id,'begin');
 assert.deepEqual(assertTransitionClipCompatibility(result,{animations:[{id:'lock',events:[{type:'sound'},{name:'marker'}]}]}),result);
 for(const bad of [null,[],{bogus:{duration:0,phases:[]}},{install:{duration:NaN,phases:[]}},{install:{duration:11,phases:[]}},{install:{duration:-1,phases:[]}},{install:{duration:1,phases:[],extra:1}},{install:{duration:1,phases:[{id:'a',time:2}]}},{install:{duration:1,phases:[{id:'a',time:.8},{id:'b',time:.2}]}},{install:{duration:1,phases:[{id:'a',time:0},{id:'a',time:1}]}},{install:{duration:1,phases:[{id:'a',time:0,clip:'../x'}]}},{install:{duration:1,phases:[{id:'a',time:0,extra:1}]}},{install:{duration:1,phases:Array.from({length:17},(_,i)=>({id:'p'+i,time:0}))}}])assert.throws(()=>validateTransitionProfiles(bad),{code:'INVALID_COMPONENT'});
 for(const child of [{animations:[]},{animations:[{id:'lock',events:[{type:'projectile'}]}]},{animations:[{id:'lock',events:[]},{id:'lock',events:[]}]}])assert.throws(()=>assertTransitionClipCompatibility(result,child),{code:'INVALID_COMPONENT'});
 const getter={};Object.defineProperty(getter,'install',{enumerable:true,get(){throw Error('getter executed');}});assert.throws(()=>validateTransitionProfiles(getter),{code:'INVALID_COMPONENT'});
 assert.deepEqual(validateTransitionProfiles({}),{});assert.deepEqual(assertTransitionClipCompatibility({}, {animations:[]}),{});
 const c=config();c.descriptors[0].transitions=result;assert.deepEqual(createAssemblyPlanner(c).bootstrap(state()).instructions,createAssemblyPlanner(config()).bootstrap(state()).instructions);
});

test('transition helpers bound every operation and reject malformed child data without evaluating accessors',()=>{
 const {validateTransitionProfiles,assertTransitionClipCompatibility}=require('../lib/components');
 const all=Object.fromEntries(['install','remove','replace','upgrade','repair','destroy','damage','visual'].map(k=>[k,{duration:0,phases:Array.from({length:16},(_,i)=>({id:'phase_'+i,time:0}))}]));
 assert.deepEqual(validateTransitionProfiles(all),all);
 const profile={visual:{duration:1,phases:[{id:'activate',time:0,clip:'activation'}]}};
 for(const child of [null,[],{animations:null},{animations:[null]},{animations:[{id:'activation',events:[null]}]}])assert.throws(()=>assertTransitionClipCompatibility(profile,child),{code:'INVALID_COMPONENT'});
 for(const phase of [null,[],{id:'phase',time:NaN},{id:'phase',time:true},{id:'phase',time:0,clip:''},{id:'phase',time:0,clip:null}])assert.throws(()=>validateTransitionProfiles({install:{duration:1,phases:[phase]}}),{code:'INVALID_COMPONENT'});
 const child={animations:[{id:'activation',events:Array.from({length:257},()=>({type:'sound'}))}]};assert.deepEqual(assertTransitionClipCompatibility(profile,child),profile);
 assert.deepEqual(assertTransitionClipCompatibility({visual:{duration:10,phases:[]}},child),{visual:{duration:10,phases:[]}});
});

test('null registry descriptors retain typed INVALID_COMPONENT rejection',()=>{
 const c=config();c.descriptors=[null];assert.throws(()=>createAssemblyPlanner(c),{code:'INVALID_COMPONENT'});
});
