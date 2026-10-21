'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createSpec}=require('../lib/spec');
const {hashValue}=require('../lib/assets');
const {planAssemblyPreview}=require('../lib/assembly-preview-planning');
const frame=(x=0)=>({position:[x,0],rotation:0,scale:[1,1]});
function fixture(count=1,types=3){
 const spec=createSpec({id:'preview',description:'Numeric assembly planning fixture'}),inheritance={position:true,rotation:true,scale:true};
 const descriptors=Array.from({length:types},(_,i)=>({version:1,type:'type'+i,spec:'components/type'+i+'.json',mount:frame(i),dimensions:[16,16],styleHash:hashValue(spec.style),eventNames:[],layer:1,inheritance}));
 spec.sockets=Array.from({length:count},(_,i)=>({id:'socket'+i,bone:spec.bones[0].id,transform:frame(i*32),types:descriptors.map(d=>d.type),capacity:1,inheritance,layer:1,envelope:[64,64]}));
 spec.assembly={version:1,styleHash:hashValue(spec.style),eventNames:[],descriptors};
 spec.components=Array.from({length:count},(_,i)=>({id:'part'+i,socket:'socket'+i,type:'type0',spec:'components/type0.json'}));
 return spec;
}
const options={compiledSpecHash:'a'.repeat(64)};
test('absent or incomplete assembly returns explicit immutable not-applicable evidence',()=>{
 const s=createSpec({id:'empty',description:'Empty'}),p=planAssemblyPreview(s,options);
 assert.equal(p.status,'not-applicable');assert.deepEqual(p.frames,[]);assert.deepEqual(p.steps,[]);assert.equal(p.compiledSpecHash,options.compiledSpecHash);assert.equal(p.specHash,hashValue(s));
 const incomplete=fixture();incomplete.sockets=[];incomplete.components=[];incomplete.assembly.descriptors=[];
 assert.equal(planAssemblyPreview(incomplete,options).status,'not-applicable');assert.ok(Object.isFrozen(p));
});
test('plans empty baseline alternate returns removal with fresh component revisions and exact hashes',()=>{
 const s=fixture(),before=structuredClone(s),p=planAssemblyPreview(s,options);
 assert.equal(p.status,'partial');assert.deepEqual(p.steps.map(x=>x.configurationId),['empty','baseline','alternative0','baseline','alternative1','baseline','empty']);
 assert.deepEqual(p.steps.map(x=>x.snapshot.components[0]?.revision),[undefined,1,2,3,4,5,undefined]);
 assert.deepEqual(p.steps.map(x=>x.snapshot.revision),[1,2,3,4,5,6,7]);
 assert.equal(p.steps[2].operations[0].kind,'replace');assert.equal(p.steps.at(-1).operations[0].kind,'remove');
 for(const step of p.steps){assert.equal(step.endTime,step.time+step.duration);assert.equal(step.holdEndTime,step.endTime+.25);}
 assert.equal(p.frames[0].time,0);assert.equal(p.frames.at(-1).time,p.duration);assert.equal(p.renderLayout.frameCount,p.frames.length);
 assert.equal(p.simulation.maximumStep,1/60);assert.deepEqual(s,before);assert.ok(Object.isFrozen(p.steps[1].snapshot.components));
 const {planHash,...rest}=p;assert.equal(planHash,hashValue(rest));
});
test('uses authored transition profiles and explicit review hold; replacement uses incoming replace profile',()=>{
 const s=fixture();s.assembly.descriptors[0].transitions={install:{duration:1,phases:[{id:'mount',time:.3}]},remove:{duration:2,phases:[]},replace:{duration:.8,phases:[]}};
 s.assembly.descriptors[1].transitions={replace:{duration:3,phases:[{id:'ready',time:2}]}};
 const p=planAssemblyPreview(s,options);assert.equal(p.steps[1].duration,1);assert.equal(p.steps[2].duration,3);assert.equal(p.steps.at(-1).duration,2);
 assert.ok(p.frames.some(f=>f.time===p.steps[1].time+.3));assert.equal(p.reviewHoldSeconds,.25);
});
test('synthetic placements respect authored order, mirror inheritance, capacities and conflicting frames',()=>{
 const s=fixture(2);s.components=[];s.sockets[0].transform.scale=[-2,3];s.sockets[0].capacity=2;
 const p=planAssemblyPreview(s,options);assert.equal(p.configurations[1].synthetic,true);assert.equal(p.configurations[1].components.length,2);
 assert.equal(p.configurations[1].components[0].type,'type0');assert.deepEqual(s.sockets[0].transform.scale,[-2,3]);
});
test('bounds installed instances, optional excursions, frame counts and reports exact omissions',()=>{
 const s=fixture(10,5),p=planAssemblyPreview(s,options);assert.equal(p.configurations[1].components.length,8);
 assert.equal(p.omissions.instances.count,2);assert.deepEqual(p.omissions.instances.examples.map(x=>x.id),['part8','part9']);
 assert.equal(p.configurations.filter(c=>c.id.startsWith('alternative')).length,2);assert.ok(p.omissions.alternatives.count>0);
 assert.ok(p.frames.length<=64);assert.ok(p.frames.length*p.renderLayout.pixels[0]*p.renderLayout.pixels[1]<=16*1024*1024);
 for(const step of p.steps)assert.ok(p.frames.some(f=>f.time===step.time)&&p.frames.some(f=>f.time===step.endTime));
});
test('reserves baseline removal and omits optional excursions beyond sixty seconds',()=>{
 const s=fixture(1,5);for(const d of s.assembly.descriptors)d.transitions={install:{duration:10,phases:[]},remove:{duration:10,phases:[]},replace:{duration:10,phases:[]}};
 const p=planAssemblyPreview(s,options);assert.ok(p.duration<=60);assert.equal(p.steps.at(-1).configurationId,'empty');assert.equal(p.configurations.filter(c=>c.id.startsWith('alternative')).length,1);assert.ok(p.omissions.alternatives.examples.some(x=>x.reason==='timeline-limit'));
});
test('plain hostile data, invalid hashes and excessive inputs fail before accessor execution',()=>{
 let called=false;const hostile={get assembly(){called=true;throw Error('must not run');}};
 assert.throws(()=>planAssemblyPreview(hostile,options),{code:'INVALID_ASSEMBLY_PREVIEW_PLAN'});assert.equal(called,false);
 assert.throws(()=>planAssemblyPreview(fixture(),{compiledSpecHash:'bad'}),{code:'INVALID_ASSEMBLY_PREVIEW_PLAN'});
 const circular=fixture();circular.cycle=circular;assert.throws(()=>planAssemblyPreview(circular,options),{code:'INVALID_ASSEMBLY_PREVIEW_PLAN'});
 const sparse=fixture();sparse.components=new Array(2);assert.throws(()=>planAssemblyPreview(sparse,options),{code:'INVALID_ASSEMBLY_PREVIEW_PLAN'});
 const deep=fixture();deep.extra={};let n=deep.extra;for(let i=0;i<25;i++)n=n.child={};assert.throws(()=>planAssemblyPreview(deep,options),{code:'INVALID_ASSEMBLY_PREVIEW_PLAN'});
});
test('every distinct phase candidate beyond sixteen is selected or explicitly omitted',()=>{
 const s=fixture(8,8);
 for(let i=0;i<8;i++){
  s.components[i].type='type'+i;s.components[i].spec='components/type'+i+'.json';s.sockets[i].types=['type'+i];
  s.assembly.descriptors[i].transitions={install:{duration:1,phases:Array.from({length:16},(_,j)=>({id:'phase'+j,time:(j*8+i+1)/200}))}};
 }
 const p=planAssemblyPreview(s,options),step=p.steps[1],selected=new Set(p.frames.map(f=>f.time)),omitted=new Set(p.omissions.times.examples.map(f=>f.time));
 for(const op of step.operations)for(const phase of op.phases)assert.ok(selected.has(step.time+phase.time)||omitted.has(step.time+phase.time));
 assert.equal(p.frames.length,64);assert.ok(p.omissions.times.count>0);assert.ok(p.omissions.alternatives.examples.every(x=>x.reason==='unsupported-placement'));
});
test('conflicting declared mounts are omitted and no valid declared placement never falls back to synthetic',()=>{
 const s=fixture(2,1);s.sockets[0].capacity=2;s.components[1].socket='socket0';
 let p=planAssemblyPreview(s,options);assert.equal(p.configurations[1].components.length,1);assert.deepEqual(p.omissions.instances.examples,[{id:'part1',reason:'unsupported-placement'}]);
 s.components[0].socket='missing';s.components.splice(1);assert.throws(()=>planAssemblyPreview(s,options),{code:'INVALID_ASSEMBLY_PREVIEW_PLAN'});
});
test('caps omission examples and derives distinct omitted synthetic identities',()=>{
 const s=fixture(140,1);s.components=[];const p=planAssemblyPreview(s,options);
 assert.equal(p.omissions.instances.count,132);assert.equal(p.omissions.instances.examples.length,128);assert.equal(p.omissions.instances.truncated,true);
 assert.equal(new Set(p.omissions.instances.examples.map(x=>x.id)).size,128);
});
test('rejects malformed data shapes, invalid profiles and bounded traversal/bytes without input mutation',()=>{
 const bad=[undefined,NaN,new Date(),new Map(),Object.assign([],{extra:1}),{[Symbol('hidden')]:1},Object.defineProperty({},'hidden',{value:1}),{extra:'x'.repeat(16*1024*1024+1)}];
 for(const value of bad)assert.throws(()=>planAssemblyPreview(value,options),{code:'INVALID_ASSEMBLY_PREVIEW_PLAN'});
 const s=fixture();s.assembly.descriptors[0].transitions={install:{duration:11,phases:[]}};assert.throws(()=>planAssemblyPreview(s,options),{code:'INVALID_ASSEMBLY_PREVIEW_PLAN'});
 assert.throws(()=>planAssemblyPreview(fixture(),{...options,extra:1}),{code:'INVALID_ASSEMBLY_PREVIEW_PLAN'});
 const many={values:Array.from({length:500001},()=>null)};assert.throws(()=>planAssemblyPreview(many,options),{code:'INVALID_ASSEMBLY_PREVIEW_PLAN'});
 const cycle=[];cycle.push(cycle);assert.throws(()=>planAssemblyPreview(cycle,options),{code:'INVALID_ASSEMBLY_PREVIEW_PLAN'});
 const large={values:['x'.repeat(9*1024*1024),'y'.repeat(9*1024*1024)]};assert.throws(()=>planAssemblyPreview(large,options),{code:'INVALID_ASSEMBLY_PREVIEW_PLAN'});
});
