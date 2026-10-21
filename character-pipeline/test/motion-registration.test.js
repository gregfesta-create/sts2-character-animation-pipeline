'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSpec}=require('../lib/spec');
const {inspectMotionRegistration:inspect}=require('../lib/motion-registration');
function fixture(){const s=createSpec({id:'numeric',description:'numeric',template:'custom'});s.animations=[{id:'move',duration:1,loop:true,tracks:[],events:[]}];return s;}
const plan=s=>({version:1,clips:s.animations.map(c=>({id:c.id,duration:c.duration,times:[0,.25,.75,1]}))});
const samples=(s,origins)=>plan(s).clips.flatMap(c=>c.times.map((time,i)=>({clip:c.id,time,bones:Object.fromEntries(s.bones.map(b=>[b.id,[...(origins[b.id]?.[i]??[0,0]),0]]))})));
test('independent nested mirrored affine origin and tolerance boundary',()=>{
 const s=fixture();s.bones[0].rest={position:[10,20],rotation:Math.PI/2,scale:[-2,3]};s.bones.push({id:'child',parent:'root',length:1,rest:{position:[4,5],rotation:.7,scale:[2,-1]}});
 const native=samples(s,{root:Array(4).fill([10,20]),child:Array(4).fill([-5,12])});const before=structuredClone([s,native]);
 const r=inspect(s,plan(s),native);assert.equal(r.checkedCount,8);assert.equal(r.status,'passed');assert.deepEqual([s,native],before);
 native[0].bones.child[0]+=2;assert.equal(inspect(s,plan(s),native).maxOriginErrorPx,2);
 native[0].bones.child[0]+=.001;assert.throws(()=>inspect(s,plan(s),native),e=>e.code==='VISUAL_VALIDATION_FAILED'&&e.diagnostics[0].code==='BONE_REGISTRATION_ERROR'&&e.diagnostics[0].boneId==='child'&&e.report.failureCount===1);
});
test('five outgoing easings, exact loop endpoints, last holds and independent clips',()=>{
 const progress={linear:[0,.25,.75,1],in:[0,.0625,.5625,1],out:[0,.4375,.9375,1],inOut:[0,.125,.875,1],step:[0,0,0,1]};
 for(const [easing,p]of Object.entries(progress)){const s=fixture();s.animations[0].tracks=[{bone:'root',property:'position',keys:[{time:0,value:[4,-2],easing},{time:1,value:[12,6]}]}];assert.equal(inspect(s,plan(s),samples(s,{root:p.map(t=>[4+8*t,-2+8*t])})).status,'passed');}
 const s=fixture();s.animations[0].tracks=[{bone:'root',property:'position',keys:[{time:0,value:[3,4]},{time:.25,value:[8,9]}]}];s.animations.push({id:'other',duration:1,loop:false,tracks:[],events:[]});
 const n=samples(s,{root:[[3,4],[8,9],[8,9],[8,9]]});for(const x of n.filter(x=>x.clip==='other'))x.bones.root=[0,0,0];assert.equal(inspect(s,plan(s),n).checkedCount,8);
});
test('rotation clamp, own rest fallback, and prefirst omissions propagate through ancestors',()=>{
 const s=fixture();s.bones[0].limits=[0,Math.PI/2];s.bones.push({id:'child',parent:'root',length:1,rest:{position:[4,0],rotation:0,scale:[1,1]}});s.animations[0].tracks=[{bone:'root',property:'rotation',keys:[{time:0,value:3},{time:1,value:3}]}];assert.equal(inspect(s,plan(s),samples(s,{child:Array(4).fill([0,4])})).status,'passed');
 s.animations[0].tracks.push({bone:'root',property:'position',keys:[{time:.5,value:[0,0]},{time:1,value:[0,0]}]});const r=inspect(s,plan(s),samples(s,{child:Array(4).fill([0,4])}));assert.equal(r.status,'partial');assert.equal(r.omissionCount,4);assert.equal(r.checkedCount,4);assert.ok(r.omissions.some(x=>x.boneId==='child'&&x.time===.25));
});
test('strict malformed maps, ordering, bounded plain data and null plan semantics',()=>{
 const s=fixture(),p=plan(s),n=samples(s,{});const bad=[()=>inspect(s,null,n),()=>inspect(s,p,[]),()=>inspect(s,p,[...n].reverse()),()=>inspect(s,p,n.map(x=>({...x,bones:{}}))),()=>inspect(s,p,n.map(x=>({...x,bones:{root:[0,0,Infinity]}}))),()=>inspect(s,p,n.map(x=>({...x,bones:{root:[0,0,0],extra:[0,0,0]}})))];
 for(const fn of bad)assert.throws(fn,{code:'INVALID_NATIVE_MOTION'});
 let read=false;const hostile={get x(){read=true;return 1;}};assert.throws(()=>inspect(hostile,p,n),{code:'INVALID_NATIVE_MOTION'});assert.equal(read,false);
 const cyclic={};cyclic.self=cyclic;for(const x of [cyclic,new Date(),Array(2),{x:Symbol()},Object.assign(Object.create({}),{a:1}),{x:'x'.repeat(17000)}])assert.throws(()=>inspect(x,p,n),{code:'INVALID_NATIVE_MOTION'});
 s.animations=[];assert.equal(inspect(s,null,[]).status,'unverified');assert.throws(()=>inspect(s,p,[]),{code:'INVALID_NATIVE_MOTION'});
});
test('native limits and bounded failure examples preserve full failed count',()=>{
 const s=fixture();s.bones=Array.from({length:128},(_,i)=>({id:'bone'+i,parent:null,length:1,rest:{position:[0,0],rotation:0,scale:[1,1]}}));s.anatomy.roles={};
 const p={version:1,clips:[{id:'move',duration:1,times:Array.from({length:64},(_,i)=>i/63)}]},n=p.clips[0].times.map(time=>({clip:'move',time,bones:Object.fromEntries(s.bones.map(b=>[b.id,[3,0,0]]))}));
 assert.throws(()=>inspect(s,p,n),e=>e.report.failureCount===8192&&e.report.failures.length===128&&e.report.failuresTruncated&&e.report.checkedCount===8192&&Buffer.byteLength(JSON.stringify(e.report))<2*1024*1024);
 const tooMany=structuredClone(s);tooMany.bones.push({id:'overflow',parent:null,length:1,rest:{position:[0,0],rotation:0,scale:[1,1]}});assert.throws(()=>inspect(tooMany,p,n),{code:'INVALID_NATIVE_MOTION'});
 const excess=structuredClone(p);excess.clips[0].times.push(1);assert.throws(()=>inspect(s,excess,n),{code:'INVALID_NATIVE_MOTION'});
 const wrong=structuredClone(p);wrong.clips[0].duration=2;assert.throws(()=>inspect(s,wrong,n),{code:'INVALID_NATIVE_MOTION'});
});
test('input byte and depth bounds reject before specification evaluation',()=>{
 const huge=Object.fromEntries(Array.from({length:1100},(_,i)=>['key'+i,'x'.repeat(16384)]));assert.throws(()=>inspect(huge,null,[]),e=>e.code==='INVALID_NATIVE_MOTION'&&/byte budget/.test(e.message));
 let deep={};for(let i=0;i<26;i++)deep={deep};assert.throws(()=>inspect(deep,null,[]),e=>e.code==='INVALID_NATIVE_MOTION'&&/traversal/.test(e.message));
 const hidden={};Object.defineProperty(hidden,'x',{value:1});assert.throws(()=>inspect(hidden,null,[]),{code:'INVALID_NATIVE_MOTION'});
 const symbol={[Symbol()]:1};assert.throws(()=>inspect(symbol,null,[]),{code:'INVALID_NATIVE_MOTION'});
 const disguised=Array(1);disguised.x=1;assert.throws(()=>inspect(disguised,null,[]),{code:'INVALID_NATIVE_MOTION'});
});
test('animated rotation and scale compose into descendant origins without native-derived expectations',()=>{
 const s=fixture();s.bones.push({id:'child',parent:'root',length:1,rest:{position:[2,-3],rotation:0,scale:[1,1]}});
 s.animations[0].tracks=[{bone:'root',property:'rotation',keys:[{time:0,value:0},{time:1,value:Math.PI}]},{bone:'root',property:'scale',keys:[{time:0,value:[1,2]},{time:1,value:[-3,4]}]}];
 // At .25: local child [0,-7.5], rotate pi/4; at .75: [-4,-10.5], rotate 3pi/4.
 const q=Math.SQRT1_2,n=samples(s,{child:[[2,-6],[7.5*q,-7.5*q],[14.5*q,6.5*q],[6,12]]});
 assert.equal(inspect(s,plan(s),n).status,'passed');
 n[2].bones.child[1]+=3;assert.throws(()=>inspect(s,plan(s),n),e=>e.diagnostics[0].clipId==='move'&&e.diagnostics[0].time===.75&&e.diagnostics[0].boneId==='child');
});
