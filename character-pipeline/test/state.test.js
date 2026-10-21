'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createStateReconciler}=require('../lib/state');
const config=()=>({instanceId:'robot',sockets:[{id:'arm',capacity:2,types:['weapon']}]});
const component=(id='left')=>({id,socket:'arm',type:'weapon',revision:1,damageState:'intact',upgrade:0,visualMode:'idle'});
const snapshot=(sequence=0,components=[])=>({version:1,instanceId:'robot',sequence,revision:1,lifecycle:'alive',visualMode:'idle',components});
const event=(sequence,type,payload)=>({version:1,instanceId:'robot',sequence,revision:sequence+1,type,payload});
test('complete authoritative snapshots and absolute events reconcile idempotently',()=>{
 const r=createStateReconciler(config());
 assert.equal(r.snapshot(snapshot()).status,'applied');
 assert.equal(r.event(event(1,'upsert',component())).status,'applied');
 assert.equal(r.event(event(1,'remove',{id:'left'})).status,'ignored');
 assert.equal(r.getState().components.length,1);
 assert.equal(r.event(event(2,'upsert',{...component(),revision:2,damageState:'damaged',upgrade:3})).state.components[0].upgrade,3);
 assert.equal(r.event(event(3,'remove',{id:'left'})).state.components.length,0);
});
test('gap suppresses speculation until sufficiently current full snapshot',()=>{
 const r=createStateReconciler(config());r.snapshot(snapshot());
 assert.equal(r.event(event(3,'upsert',component())).requestSnapshot,true);
 assert.equal(r.event(event(1,'upsert',component())).status,'blocked');
 assert.equal(r.snapshot(snapshot(2)).status,'blocked');
 assert.equal(r.snapshot({...snapshot(3,[component()]),revision:4}).status,'applied');
 assert.equal(r.snapshot({...snapshot(3),revision:4}).status,'ignored');
 assert.equal(r.getState().components.length,1);
});
test('lifecycle remains authoritative through death revive removal and teardown',()=>{
 const r=createStateReconciler(config());r.snapshot(snapshot(0,[component()]));
 assert.equal(r.event(event(1,'lifecycle',{lifecycle:'dead'})).state.components.length,1);
 assert.equal(r.event(event(2,'lifecycle',{lifecycle:'alive'})).state.lifecycle,'alive');
 assert.equal(r.event(event(3,'lifecycle',{lifecycle:'removed'})).state.components.length,0);
 assert.equal(r.event(event(4,'upsert',component())).status,'removed');
 assert.equal(r.snapshot(snapshot(5)).status,'removed');
 r.teardown();assert.equal(r.getState().components.length,0);
 assert.equal(r.snapshot(snapshot(8)).status,'disposed');
});
test('copies inputs and outputs and isolates instances',()=>{
 const r=createStateReconciler(config()),other=createStateReconciler(config()),s=snapshot(0,[component()]);
 r.snapshot(s);s.components[0].upgrade=9;
 const read=r.getState();read.components[0].upgrade=10;
 assert.equal(r.getState().components[0].upgrade,0);assert.equal(other.getState().components.length,0);
});
test('strict bounded protocol rejects invalid input atomically',()=>{
 const r=createStateReconciler(config());r.snapshot(snapshot());
 for(const bad of [{...snapshot(1),version:2},{...snapshot(1),instanceId:'other'},{...snapshot(1),extra:true},{...snapshot(1),sequence:NaN},snapshot(1,[component(),component()]),snapshot(1,[{...component(),socket:'missing'}]),snapshot(1,[{...component(),charges:4}]),snapshot(1,[component('a'),component('b'),component('c')])]) assert.throws(()=>r.snapshot(bad),{code:'INVALID_STATE'});
 for(const bad of [event(1,'damage',{amount:1}),event(1,'remove',{id:'missing'}),event(1,'upsert',{...component(),type:'unknown'}),event(1,'upsert',{...component(),id:'x'.repeat(65)})]) assert.throws(()=>r.event(bad),{code:'INVALID_STATE'});
 assert.equal(r.getState().sequence,0);
 assert.throws(()=>createStateReconciler({...config(),extra:1}),{code:'INVALID_STATE'});
 assert.throws(()=>createStateReconciler({instanceId:'robot',sockets:[...config().sockets,...config().sockets]}),{code:'INVALID_STATE'});
});


test('stale snapshots and revisions cannot roll back accepted or gapped state',()=>{
 const r=createStateReconciler(config());r.snapshot({...snapshot(4,[component()]),revision:5});
 assert.equal(r.snapshot(snapshot(3)).status,'ignored');
 assert.equal(r.snapshot({...snapshot(5),revision:4}).status,'ignored');
 assert.equal(r.event({...event(5,'visualMode',{visualMode:'hit'}),revision:4}).status,'ignored');
 assert.equal(r.event(event(5,'visualMode',{visualMode:'hit'})).state.visualMode,'hit');
 assert.equal(r.event(event(7,'remove',{id:'left'})).requestSnapshot,true);
 assert.equal(r.snapshot({...snapshot(7),revision:7}).status,'blocked');
 assert.equal(r.snapshot({...snapshot(7),revision:8}).status,'applied');
});
test('no baseline, disposal, malformed envelopes and component rollback are explicit',()=>{
 const r=createStateReconciler(config());
 assert.equal(r.event(event(1,'upsert',component())).requestSnapshot,true);
 assert.equal(r.snapshot(snapshot()).status,'blocked');
 r.snapshot({...snapshot(1,[{...component(),revision:3}]),revision:2});
 assert.throws(()=>r.event(event(2,'upsert',component())),{code:'INVALID_STATE'});
 for(const bad of [{...snapshot(2),components:[{...component(),upgrade:-1}]},{...snapshot(2),lifecycle:'unknown'},{...snapshot(2),lifecycle:'removed',components:[component()]}])assert.throws(()=>r.snapshot(bad),{code:'INVALID_STATE'});
 const accessor=snapshot(2);Object.defineProperty(accessor,'revision',{get(){throw Error('must not run');},enumerable:true});
 assert.throws(()=>r.snapshot(accessor),{code:'INVALID_STATE'});
 r.teardown();assert.equal(r.event(event(3,'visualMode',{visualMode:'hit'})).status,'disposed');
});
test('arrays reject extra properties, accessor indices, and sparse holes without invoking getters',()=>{
 const extra=[];extra.extra={unrecognized:'accepted'};
 const r=createStateReconciler(config());
 assert.throws(()=>r.snapshot({...snapshot(),components:extra}),{code:'INVALID_STATE'});
 const sparse=new Array(1);
 assert.throws(()=>r.snapshot({...snapshot(),components:sparse}),{code:'INVALID_STATE'});
 const accessor=[component()];Object.defineProperty(accessor,'0',{get(){throw Error('getter invoked');},enumerable:true});
 assert.throws(()=>r.snapshot({...snapshot(),components:accessor}),{code:'INVALID_STATE'});
 const sockets=config().sockets;sockets.extra=true;
 assert.throws(()=>createStateReconciler({instanceId:'robot',sockets}),{code:'INVALID_STATE'});
 const types=['weapon'];types.extra=true;
 assert.throws(()=>createStateReconciler({instanceId:'robot',sockets:[{id:'arm',capacity:2,types}]}),{code:'INVALID_STATE'});
});
test('rejects custom array prototypes without invoking inherited iterators',()=>{
 const sockets=[];Object.setPrototypeOf(sockets,{[Symbol.iterator](){throw Error('iterator invoked');}});
 assert.throws(()=>createStateReconciler({instanceId:'robot',sockets}),{code:'INVALID_STATE'});
});
test('snapshots cannot roll back or conflict with retained component revisions',()=>{
 const r=createStateReconciler(config());r.snapshot({...snapshot(0,[{...component(),revision:3}]),revision:4});
 assert.throws(()=>r.snapshot({...snapshot(1,[component()]),revision:5}),{code:'INVALID_STATE'});
 assert.throws(()=>r.snapshot({...snapshot(1,[{...component(),revision:3,upgrade:2}]),revision:5}),{code:'INVALID_STATE'});
 assert.equal(r.getState().sequence,0);
 assert.equal(r.snapshot({...snapshot(1,[{...component(),revision:4,upgrade:2}]),revision:5}).status,'applied');
 assert.throws(()=>r.event({...event(2,'upsert',{...component(),revision:4,upgrade:3}),revision:6}),{code:'INVALID_STATE'});
});

test('global revisions identify immutable whole state while transport sequence may advance',()=>{
 const r=createStateReconciler(config());r.snapshot({...snapshot(0),revision:5});
 assert.throws(()=>r.snapshot({...snapshot(1),revision:5,lifecycle:'dead'}),{code:'INVALID_STATE'});
 assert.throws(()=>r.event({...event(1,'lifecycle',{lifecycle:'dead'}),revision:5}),{code:'INVALID_STATE'});
 assert.equal(r.getState().sequence,0);
 assert.equal(r.snapshot({...snapshot(1),revision:5}).status,'applied');
 assert.equal(r.event({...event(2,'lifecycle',{lifecycle:'alive'}),revision:5}).status,'applied');
 assert.equal(r.getState().sequence,2);
 assert.throws(()=>r.snapshot({...snapshot(3,[component()]),revision:5}),{code:'INVALID_STATE'});
 assert.throws(()=>r.event({...event(3,'upsert',component()),revision:5}),{code:'INVALID_STATE'});
 assert.equal(r.getState().sequence,2);
});
test('same global revision treats occupancy ordering as no-op and rejects component edits',()=>{
 const r=createStateReconciler(config());r.snapshot({...snapshot(0,[component('a'),component('b')]),revision:5});
 assert.equal(r.snapshot({...snapshot(1,[component('b'),component('a')]),revision:5}).status,'applied');
 assert.throws(()=>r.snapshot({...snapshot(2,[component('b'),{...component('a'),revision:2,upgrade:1}]),revision:5}),{code:'INVALID_STATE'});
 assert.throws(()=>r.event({...event(2,'upsert',{...component('a'),revision:2,upgrade:1}),revision:5}),{code:'INVALID_STATE'});
 assert.equal(r.getState().components.find(value=>value.id==='a').upgrade,0);
});
test('nonenumerable protocol fields and array indices cannot disappear during cloning',()=>{
 const r=createStateReconciler(config());
 const s=snapshot();Object.defineProperty(s,'revision',{value:1,enumerable:false});
 assert.throws(()=>r.snapshot(s),{code:'INVALID_STATE'});
 const c=component();Object.defineProperty(c,'upgrade',{value:0,enumerable:false});
 assert.throws(()=>r.snapshot(snapshot(0,[c])),{code:'INVALID_STATE'});
 const components=[component()];Object.defineProperty(components,'0',{value:component(),enumerable:false});
 assert.throws(()=>r.snapshot(snapshot(0,components)),{code:'INVALID_STATE'});
 const cfg=config();Object.defineProperty(cfg,'instanceId',{value:'robot',enumerable:false});
 assert.throws(()=>createStateReconciler(cfg),{code:'INVALID_STATE'});
 assert.equal(r.getState().revision,null);
});
