'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSpec}=require('../lib/spec');
const {planRenderViewport}=require('../lib/render-layout');
const {hashValue}=require('../lib/assets');
const {planPartMasks:plan}=require('../lib/overlap-planning');
function fixture(count=3,clips=1,times=[0,.5,1]){
 const s=createSpec({id:'numeric',description:'numeric',template:'custom'});
 s.parts=Array.from({length:count},(_,i)=>({id:'part'+i,role:'body',bone:'root',pivot:[0,0],layer:i,image:{path:'numeric.png'},overlaps:[]}));
 s.animations=Array.from({length:clips},(_,i)=>({id:'clip'+i,duration:1,loop:false,tracks:[],events:[]}));
 const m=clips?{version:1,clips:s.animations.map(c=>({id:c.id,duration:1,times}))}:null;
 return {s,m,l:planRenderViewport(s.canvas,Math.max(1,Math.min(64,clips*times.length)))};
}
test('explicit policy distinguishes unknown, empty, asymmetric permission and self duplicates',()=>{
 const {s,m,l}=fixture(4);delete s.parts[3].overlaps;s.parts[0].overlaps=['part0','part1','part1'];
 const before=structuredClone([s,m,l]),r=plan(s,m,l);
 assert.equal(r.policy.allowedPairCount,1);assert.equal(r.policy.forbiddenPairCount,2);assert.equal(r.policy.unknownPairCount,3);
 assert.deepEqual(r.policy.forbiddenPairs,[{partA:'part0',partB:'part2'},{partA:'part1',partB:'part2'}]);
 assert.equal(r.comparisons.length,6);assert.equal(r.captures.length,9);assert.deepEqual([s,m,l],before);
 const {planHash,...body}=r;assert.equal(planHash,hashValue(body));assert.equal(r.specHash,hashValue(s));assert.equal(r.motionPlanHash,hashValue(m));assert.equal(r.renderLayoutHash,hashValue(l));
});
test('endpoint priority round robins clips while preserving original global frame indexes',()=>{
 const {s,m,l}=fixture(2,2,[0,.25,.75,1]),r=plan(s,m,l);
 assert.deepEqual(r.comparisons.map(x=>[x.clipId,x.time,x.frameIndex]),[['clip0',0,0],['clip1',0,4],['clip0',1,3],['clip1',1,7],['clip0',.25,1],['clip1',.25,5],['clip0',.75,2],['clip1',.75,6]]);
 r.captures.forEach((c,i)=>{assert.equal(c.id,i);assert.equal(c.filename,'part-mask-'+i+'.png');});
 assert.equal(r.status,'planned');assert.equal(r.omissionCount,0);
});
test('complete-pair budgets deduplicate captures and retain exact bounded omissions',()=>{
 const {s,m,l}=fixture(128,1,[0,1]),r=plan(s,m,l);
 assert.equal(r.captures.length,64);assert.equal(r.comparisons.length,256);assert.equal(r.totalPossibleComparisons,16256);
 assert.equal(r.omissionCount,16000);assert.equal(r.omissions.length,128);assert.equal(r.omissionsTruncated,true);assert.equal(r.policy.forbiddenPairs.length,128);assert.equal(r.policy.forbiddenPairsTruncated,true);
 assert.equal(new Set(r.comparisons.flatMap(x=>[x.captureA,x.captureB])).size,r.captures.length);assert.equal(r.status,'partial');
 assert.ok(r.comparisons.some(x=>x.partA==='part1'&&x.partB==='part2'),'continue past an unfittable pair to reuse already selected masks');
 assert.ok(r.captures.length*l.pixels[0]*l.pixels[1]<=16*1024*1024);assert.ok(r.comparisons.length*l.pixels[0]*l.pixels[1]<=64*1024*1024);
});
test('clip, aggregate pose and descriptor traversal limits reject excess inputs',()=>{
 const f=fixture();
 for(const x of [fixture(2,32,[0,.5,1]),fixture(2,33,[0,1])])assert.throws(()=>plan(x.s,x.m,x.l),{code:'INVALID_OVERLAP_PLAN'});
 const overflow=fixture();overflow.m.clips[0].times=Array.from({length:65},(_,i)=>i/64);assert.throws(()=>plan(overflow.s,overflow.m,overflow.l),{code:'INVALID_OVERLAP_PLAN'});
 const empty=fixture(2,0);assert.throws(()=>plan(empty.s,{version:1,clips:[]},empty.l),{code:'INVALID_OVERLAP_PLAN'});
 const many=Array.from({length:6},()=>Array(90000).fill(false));assert.throws(()=>plan(many,f.m,f.l),e=>e.code==='INVALID_OVERLAP_PLAN'&&/traversal/.test(e.message));
});
test('no clips, no parts and no forbidden policy require no masks and remain unverified',()=>{
 for(const f of [fixture(0),fixture(2,0),fixture(1)]){const r=plan(f.s,f.m,f.l);assert.equal(r.status,'unverified');assert.deepEqual(r.captures,[]);}
 const f=fixture(2);delete f.s.parts[0].overlaps;const r=plan(f.s,f.m,f.l);assert.equal(r.policy.unknownPairCount,1);assert.equal(r.totalPossibleComparisons,0);
});
test('rejects hostile plain data before access and malformed motion/layout/spec limits',()=>{
 const f=fixture();let read=false;const x={get parts(){read=true;return [];}};assert.throws(()=>plan(x,f.m,f.l),{code:'INVALID_OVERLAP_PLAN'});assert.equal(read,false);
 const cycle={};cycle.x=cycle;
 for(const bad of [cycle,new Date(),Array(2),{x:Symbol()},Object.assign(Object.create({}),{x:1})])assert.throws(()=>plan(bad,f.m,f.l),{code:'INVALID_OVERLAP_PLAN'});
 for(const mutate of [x=>x.s.parts.push(...Array.from({length:126},(_,i)=>({...x.s.parts[0],id:'extra'+i}))),x=>x.m.clips[0].times.reverse(),x=>x.m.clips[0].duration=2,x=>x.l={...x.l,pixels:[513,1]},x=>x.l={...x.l,frameCount:1},x=>x.s.parts[0].overlaps=['absent'],x=>x.m=null]){const x=structuredClone(f);mutate(x);assert.throws(()=>plan(x.s,x.m,x.l),{code:'INVALID_OVERLAP_PLAN'});}
});
test('depth, byte, hidden, symbol and custom array properties are bounded before serialization',()=>{
 const f=fixture();let deep={};for(let i=0;i<26;i++)deep={deep};
 const hidden={};Object.defineProperty(hidden,'x',{value:1});const a=[];a.extra=1;
 const huge=Object.fromEntries(Array.from({length:1100},(_,i)=>['k'+i,'x'.repeat(16384)]));
 for(const bad of [deep,hidden,a,{[Symbol()]:1},huge,{x:NaN}])assert.throws(()=>plan(bad,f.m,f.l),{code:'INVALID_OVERLAP_PLAN'});
});

