'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {compileWithRepairs}=require('../lib/compile-repair');
const {hashValue}=require('../lib/assets');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64');
const spec=()=>({bones:[{id:'root'}],parts:[],animations:[{id:'idle',duration:1,loop:true,tracks:[{bone:'root',property:'position',keys:[{time:0,value:[0,0]},{time:1,value:[2,0]}]}],events:[]}]});
const seam=()=>Object.assign(new Error('Native seam'),{code:'VISUAL_VALIDATION_FAILED',diagnostics:[{code:'LOOP_SEAM',id:'loop0',clipId:'idle',jointId:'joint0',measured:2,limit:1}]});
async function setup(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'compile-repair-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function built(options){const frame=path.join(options.stagingDir,'frame.png');await fs.mkdir(options.stagingDir,{recursive:true});await fs.writeFile(frame,png);return {project:options.stagingDir,frames:[frame],validation:{valid:true,frames:['frame.png'],geometry:{status:'passed'}}};}
test('compiles first, closes explicit loop pose, persists before fresh compile and preserves inputs/options',async t=>{
 const stagingDir=await setup(t),original=spec(),before=structuredClone(original),calls=[],events=[],effectBuild={opaque:'same object'};
 const result=await compileWithRepairs(original,{stagingDir,render:true,effectBuild,compile:async(s,o)=>{calls.push({s:structuredClone(s),o});if(calls.length===1)throw seam();assert.ok(events.some(e=>e.type==='action'));return built(o);},persist:async e=>events.push(e)});
 assert.equal(calls.length,2);assert.deepEqual(original,before);assert.equal(calls[0].o.effectBuild,effectBuild);assert.equal(calls[1].o.effectBuild,effectBuild);assert.equal(path.basename(calls[0].o.stagingDir),'attempt0');assert.equal(path.basename(calls[1].o.stagingDir),'attempt1');assert.deepEqual(calls[1].s.animations[0].tracks[0].keys[1].value,[0,0]);assert.equal(result.repair.status,'passed');assert.equal(result.repair.attempts,1);assert.equal(result.repair.repairedSpecHash,hashValue(calls[1].s));assert.ok(result.built.validation.valid);
 assert.deepEqual(JSON.parse(await fs.readFile(result.repair.historyPath,'utf8')),events);
 assert.equal(hashValue(JSON.parse(await fs.readFile(result.repair.specPath,'utf8'))),result.repair.repairedSpecHash);
 assert.deepEqual(events.filter(e=>e.type==='compile-attempt').map(e=>e.attempt),[0,1]);
});
test('headless compiles once at original path and successful large rendered specs bypass repair limits',async t=>{
 const stagingDir=await setup(t);let calls=0;const s=spec();s.large='x'.repeat(300000);
 const headless=await compileWithRepairs(s,{stagingDir,render:false,compile:async(value,o)=>{calls++;assert.equal(o.stagingDir,stagingDir);return {headless:true};}});assert.equal(headless.built.headless,true);
 const render=await compileWithRepairs(s,{stagingDir,render:true,compile:async(value,o)=>{calls++;return built(o);}});assert.equal(render.repair.attempts,0);assert.equal(calls,2);assert.equal(render.repair.specPath,undefined);
});
test('nonvisual errors preserve identity; unsupported visual failures never trigger another compile',async t=>{
 const stagingDir=await setup(t);for(const error of [Object.assign(new Error('tool'),{code:'GODOT_FAILED'}),Object.assign(new Error('pixels'),{code:'VISUAL_VALIDATION_FAILED',diagnostics:[{code:'ATTACHMENT_ERROR'}]}),Object.assign(seam(),{diagnostics:[{code:'LOOP_SEAM',clipId:'idle',jointId:'root',measured:NaN}]})]){let calls=0;await assert.rejects(compileWithRepairs(spec(),{stagingDir,render:true,compile:async()=>{calls++;throw error;}}),e=>error.code==='VISUAL_VALIDATION_FAILED'?e.cause===error&&e.repair.status==='irreparable':e===error);assert.equal(calls,1);}
});
test('repairs distinct diagnosed clips up to the hard attempt bound and records exhaustion',async t=>{
 const stagingDir=await setup(t),s=spec();s.animations=Array.from({length:4},(_,i)=>({...structuredClone(s.animations[0]),id:'loop'+i}));let calls=0;
 await assert.rejects(compileWithRepairs(s,{stagingDir,render:true,compile:async value=>{calls++;throw Object.assign(seam(),{diagnostics:value.animations.filter(c=>c.tracks[0].keys[1].value[0]!==0).map(c=>({code:'LOOP_SEAM',clipId:c.id,jointId:'joint0',measured:2,limit:1}))});}}),e=>e.code==='VISUAL_VALIDATION_FAILED'&&e.repair.status==='exhausted'&&e.repair.attempts===3);assert.equal(calls,4);
});
test('large failing authored candidates explicitly report repair capability limits after only one compile',async t=>{
 const stagingDir=await setup(t),s=spec();s.large='x'.repeat(300000);let calls=0;
 let rejected;await assert.rejects(compileWithRepairs(s,{stagingDir,render:true,compile:async()=>{calls++;throw seam();}}),e=>{rejected=e;return e.code==='CAPABILITY_MISSING';});assert.equal(calls,1);
 const history=JSON.parse(await fs.readFile(rejected.repair.historyPath,'utf8'));assert.equal(history.at(-1).status,'unsupported');
});
test('tool failure on corrected compile preserves identity and existing frames outside attempt cannot pass',async t=>{
 const stagingDir=await setup(t),toolError=Object.assign(new Error('second native failure'),{code:'GODOT_FAILED'});let calls=0;
 await assert.rejects(compileWithRepairs(spec(),{stagingDir,render:true,compile:async()=>{if(++calls===1)throw seam();throw toolError;}}),e=>e===toolError);assert.equal(calls,2);
 const old=await built({stagingDir});await assert.rejects(compileWithRepairs(spec(),{stagingDir,render:true,compile:async()=>old}),{code:'VISUAL_VALIDATION_FAILED'});
});
test('repeated seam after local closure stops without identical compile or false success',async t=>{
 const stagingDir=await setup(t);let calls=0;await assert.rejects(compileWithRepairs(spec(),{stagingDir,render:true,compile:async()=>{calls++;throw seam();}}),e=>e.code==='VISUAL_VALIDATION_FAILED'&&e.repair.status==='irreparable');assert.equal(calls,2);
});
test('receipt persistence failure stops before any repair compile and missing frames cannot pass',async t=>{
 const stagingDir=await setup(t),failure=new Error('disk full');let calls=0;
 await assert.rejects(compileWithRepairs(spec(),{stagingDir,render:true,compile:async()=>{calls++;throw seam();},persist:async e=>{if(e.type==='action')throw failure;}}),e=>e===failure);assert.equal(calls,1);
 await assert.rejects(compileWithRepairs(spec(),{stagingDir,render:true,compile:async()=>({frames:[],validation:{valid:true,geometry:{status:'passed'}}})}),{code:'VISUAL_VALIDATION_FAILED'});
});
test('abort during initial compile, headless compile or durable completion never returns success',async t=>{
 const stagingDir=await setup(t);
 for(const render of [false,true]){const controller=new AbortController();await assert.rejects(compileWithRepairs(spec(),{stagingDir,render,signal:controller.signal,compile:async(s,o)=>{const value=render?await built(o):{};controller.abort();return value;}}),{code:'CANCELLED'});}
 for(const at of ['complete','repaired-spec']){
  const controller=new AbortController();let calls=0;await assert.rejects(compileWithRepairs(spec(),{stagingDir,render:true,signal:controller.signal,compile:async(s,o)=>{if(at==='repaired-spec'&&++calls===1)throw seam();return built(o);},persist:async e=>{if(e.type===at)controller.abort();}}),{code:'CANCELLED'});
 }
 const controller=new AbortController();let calls=0;await assert.rejects(compileWithRepairs(spec(),{stagingDir,render:true,signal:controller.signal,compile:async(s,o)=>{if(++calls===1)throw seam();const value=await built(o);controller.abort();return value;}}),{code:'CANCELLED'});assert.equal(calls,2);
});
test('fresh frame verification rejects PNG signature stubs, truncation and bad CRC',async t=>{
 const stagingDir=await setup(t),stub=Buffer.alloc(24);png.subarray(0,8).copy(stub);const crc=Buffer.from(png);crc[crc.length-1]^=1;
 for(const bytes of [stub,png.subarray(0,png.length-1),crc])await assert.rejects(compileWithRepairs(spec(),{stagingDir,render:true,compile:async(s,o)=>{const value=await built(o);await fs.writeFile(value.frames[0],bytes);return value;}}),{code:'VISUAL_VALIDATION_FAILED'});
});
function deform(amount=-8){
 const {createSpec}=require('../lib/spec');const s=createSpec({id:'numeric',description:'numeric deformation',template:'custom'});
 s.bones.push({id:'child',parent:'root',rest:{position:[0,0],rotation:0,scale:[1,1]},length:1});
 s.parts=[{id:'shape',role:'body',bone:'root',pivot:[0,0],layer:0,image:{path:'pixels.png',prepared:true,width:8,height:8,alphaBounds:[0,0,8,8],cropTranslation:[0,0],pivot:[0,0],pixelsPerUnit:1},mesh:{vertices:[[0,0],[4,0],[0,3]],uv:[[0,0],[4,0],[0,3]],triangles:[[0,1,2]],weights:[[{bone:'root',weight:1}],[{bone:'child',weight:1}],[{bone:'root',weight:1}]]}}];
 s.animations=[{id:'move',duration:1,loop:false,tracks:[{bone:'child',property:'position',keys:[{time:0,value:[0,0]},{time:1,value:[amount,0]}]}],events:[]}];return s;
}
const authored=()=>Object.assign(new Error('authored'),{code:'AUTHORED_GEOMETRY_FAILED',diagnostics:[{code:'FAKE'}]});
test('trusted authored inversion is halved through collapse before one native compile with distinct source hashes',async t=>{
 const stagingDir=await setup(t),s=deform(),before=structuredClone(s),candidates=[],events=[];let native=0;
 const {inspectAuthoredGeometry}=require('../lib/authored-geometry');
 const r=await compileWithRepairs(s,{stagingDir,render:true,persist:async e=>events.push(e),compile:async(value,o)=>{candidates.push(structuredClone(value));inspectAuthoredGeometry(value);native++;return built(o);}});
 assert.equal(native,1);assert.deepEqual(candidates.map(c=>c.animations[0].tracks[0].keys[1].value[0]),[-8,-4,-2]);assert.equal(r.repair.attempts,2);assert.equal(r.repair.scope,'authored-local-animation');assert.deepEqual(s,before);
 const actions=events.filter(e=>e.type==='action');assert.equal(new Set(actions.map(e=>e.action.parameters.sourceSpecHash)).size,2);assert.equal(r.repair.repairedSpecHash,hashValue(candidates.at(-1)));assert.ok(events.filter(e=>e.type==='compile-attempt').every(e=>e.scope==='candidate-callback-preflight'));assert.equal(hashValue(JSON.parse(await fs.readFile(r.repair.specPath,'utf8'))),r.repair.repairedSpecHash);
});
test('forged authored failure on valid geometry and native-only failures authorize no damping',async t=>{
 const stagingDir=await setup(t);for(const error of [authored(),Object.assign(new Error('native'),{code:'VISUAL_VALIDATION_FAILED',diagnostics:[{code:'BONE_REGISTRATION_ERROR'}]})]){let n=0;await assert.rejects(compileWithRepairs(deform(-2),{stagingDir,render:true,compile:async()=>{n++;throw error;}}),e=>e.code===error.code&&e.repair.status==='irreparable');assert.equal(n,1);}
});
test('authored exhaustion and unsupported operator retain authored code and final candidate hash',async t=>{
 const stagingDir=await setup(t),{inspectAuthoredGeometry}=require('../lib/authored-geometry');
 for(const s of [deform(-128),(()=>{const x=deform();x.animations[0].tracks.push({bone:'root',property:'scale',keys:[{time:0,value:[1,1]},{time:1,value:[-1,1]}]});return x;})()]){
 let last;await assert.rejects(compileWithRepairs(s,{stagingDir,render:true,compile:async value=>{last=value;inspectAuthoredGeometry(value);throw Error('must not reach native');}}),e=>e.code==='AUTHORED_GEOMETRY_FAILED'&&e.repair.attempts<=3&&e.repair.repairedSpecHash===hashValue(last));
 }
});
test('multiple authored clips select authored order and share three actions with loop closure',async t=>{
 const stagingDir=await setup(t),{inspectAuthoredGeometry}=require('../lib/authored-geometry');
 const s=deform(-4);s.animations.push({...structuredClone(s.animations[0]),id:'second'});let calls=0;
 const r=await compileWithRepairs(s,{stagingDir,render:true,compile:async(value,o)=>{calls++;inspectAuthoredGeometry(value);return built(o);}});
 assert.equal(calls,3);assert.deepEqual(r.repair.history.filter(e=>e.type==='action').map(e=>e.diagnosis.asset),['move','second']);
 const mixed=deform();mixed.animations.push({...spec().animations[0]});let native=0;
 const out=await compileWithRepairs(mixed,{stagingDir,render:true,compile:async(value,o)=>{inspectAuthoredGeometry(value);native++;if(value.animations[1].tracks[0].keys[1].value[0])throw seam();return built(o);}});
 assert.equal(out.repair.attempts,3);assert.equal(native,2);assert.deepEqual(out.repair.history.filter(e=>e.type==='action').map(e=>e.action.actionId),['dampenClipPose','dampenClipPose','closeLoopPose']);
});
test('frozen incoming authored errors, invalid rest baselines and bounded-out candidates remain unsupported',async t=>{
 const stagingDir=await setup(t);const invalid=deform();invalid.parts[0].mesh.vertices[2]=[0,0];
 for(const s of [invalid,(()=>{const value=deform();value.large='x'.repeat(300000);return value;})()]){
 let n=0;await assert.rejects(compileWithRepairs(s,{stagingDir,render:true,compile:async()=>{n++;throw Object.freeze(authored());}}),e=>e.code==='AUTHORED_GEOMETRY_FAILED'&&['irreparable','unsupported'].includes(e.repair.status)&&e.repair.attempts===0);assert.equal(n,1);
 }
});
test('cancellation and persistence failures during authored corrections cannot return success',async t=>{
 const stagingDir=await setup(t),{inspectAuthoredGeometry}=require('../lib/authored-geometry');
 for(const mode of ['cancel','persist']){const controller=new AbortController(),disk=new Error('persist failed');let n=0;
 await assert.rejects(compileWithRepairs(deform(),{stagingDir,render:true,signal:controller.signal,compile:async value=>{n++;inspectAuthoredGeometry(value);},persist:async e=>{if(e.type==='action'){if(mode==='cancel')controller.abort();else throw disk;}}}),e=>mode==='cancel'?e.code==='CANCELLED':e===disk);assert.equal(n,1);
 }
});
