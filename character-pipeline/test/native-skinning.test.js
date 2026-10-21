'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSpec}=require('../lib/spec');
const {inspectNativeSkinning:inspect}=require('../lib/native-skinning');
function fixture(){
 const s=createSpec({id:'skin',description:'numeric',template:'custom'});
 s.animations=[{id:'move',duration:1,loop:false,tracks:[],events:[]}];
 s.parts=[{id:'body',role:'body',bone:'root',pivot:[0,0],layer:0,image:{path:'numeric.png',width:8,height:8,pivot:[0,0],pixelsPerUnit:1,prepared:true,alphaBounds:[0,0,8,8],cropTranslation:[0,0]},mesh:{vertices:[[0,0],[4,0],[0,4]],uv:[[0,0],[4,0],[0,4]],triangles:[[0,1,2]],weights:Array.from({length:3},()=>[{bone:'root',weight:1}])}}];
 const p={version:1,clips:[{id:'move',duration:1,times:[0,1]}]};
 const e={version:1,bones:[{id:'root',path:'Skeleton/root',index:0}],meshes:[{part:'body',path:'Meshes/body',positions:[[0,0],[4,0],[0,4]],triangles:[[0,1,2]],influences:Array.from({length:3},()=>[{bone:'root',weight:1}])}],samples:[0,1].map(time=>({clip:'move',time,matrices:{root:[1,0,0,1,0,0]}}))};
 return {s,p,e};
}
const invalid=fn=>assert.throws(fn,{code:'INVALID_NATIVE_SKINNING'});
test('identity and translation projection binds hashes and preserves input',()=>{
 const {s,p,e}=fixture();e.samples[1].matrices.root=[1,0,0,1,5,-8];s.animations[0].tracks=[{bone:"root",property:"position",keys:[{time:0,value:[0,0]},{time:1,value:[5,-8]}]}];const before=structuredClone([s,p,e]);const r=inspect(s,p,e);
 assert.equal(r.status,'passed');assert.equal(r.checkedTriangleSamples,2);assert.equal(r.checkedVertexSamples,6);assert.equal(r.visualQuality,'unverified');for(const k of ['specHash','planHash','evidenceHash'])assert.match(r[k],/^[a-f0-9]{64}$/);assert.deepEqual([s,p,e],before);
});
test('mixed weighted rotation, nested mirrored rest and native index order',()=>{
 const {s,p,e}=fixture();s.bones[0].rest={position:[10,20],rotation:Math.PI/2,scale:[-2,3]};s.bones.push({id:'child',parent:'root',length:1,rest:{position:[4,5],rotation:0,scale:[1,1]}});s.parts[0].bone='child';s.parts[0].image.pivot=[2,2];s.parts[0].image.pixelsPerUnit=2;
 // Child origin [-5,12], local vertices [-1,-1],[1,-1],[-1,1]; world [-2,14],[-2,10],[-8,14].
 e.meshes[0].positions=[[-2,14],[-2,10],[-8,14]];s.parts[0].mesh.weights=Array.from({length:3},()=>[{bone:'root',weight:.5},{bone:'child',weight:.5}]);e.meshes[0].influences=Array.from({length:3},()=>[{bone:'child',weight:.5},{bone:'root',weight:.5}]);e.bones=[{id:'child',path:'Skeleton/root/child',index:1},{id:'root',path:'Skeleton/root',index:0}];s.animations[0].tracks=[{bone:'child',property:'rotation',keys:[{time:0,value:Math.PI/2},{time:1,value:Math.PI/2}]}];for(const x of e.samples)x.matrices.child=[0,-2/3,1.5,0,-23,26/3];
 assert.equal(inspect(s,p,e).status,'passed');
});
test('native reflected and collapsed matrices fail with measured triangle diagnostics',()=>{
 for(const [a,code]of [[-1,'NATIVE_TRIANGLE_INVERSION'],[0,'NATIVE_TRIANGLE_COLLAPSE']]){const {s,p,e}=fixture();e.samples[1].matrices.root=[a,0,0,1,0,0];assert.throws(()=>inspect(s,p,e),x=>x.code==='VISUAL_VALIDATION_FAILED'&&x.diagnostics[0].code===code&&x.diagnostics[0].restSignedArea===8&&x.diagnostics[0].projectedSignedArea===8*a&&x.report.triangleFailureCount===1&&x.diagnostics[0].triangleIndex===0);}
});
test('strict identities, maps, topology, rest registration and sparse weights',()=>{
 const changes=[e=>e.version=2,e=>e.extra=1,e=>e.bones[0].path='Skeleton/forged',e=>e.bones[0].index=1,e=>e.meshes[0].path='Meshes/forged',e=>e.meshes[0].triangles[0]=[0,2,1],e=>e.meshes[0].triangles.push([2,1,0]),e=>e.meshes[0].positions[0][0]=.1,e=>e.meshes[0].influences[0][0].weight=.8,e=>e.meshes[0].influences[0].push({bone:'root',weight:.2}),e=>e.samples.reverse(),e=>delete e.samples[0].matrices.root,e=>e.samples[0].matrices.extra=[1,0,0,1,0,0],e=>e.samples[0].matrices.root[0]=Infinity,e=>e.samples[0].matrices.root.push(1),e=>e.samples[0].extra=1,e=>e.meshes=[],e=>e.bones=[]];
 for(const change of changes){const {s,p,e}=fixture();change(e);invalid(()=>inspect(s,p,e));}
 const {s,p,e}=fixture();e.meshes[0].positions[1][0]+=1e-6;assert.equal(inspect(s,p,e).status,'passed');s.parts[0].mesh.weights[0].push({bone:'root',weight:0});invalid(()=>inspect(s,p,e));
});
test('zero influences removed, positive weights normalized and implicit/undersampled omissions',()=>{
 const {s,p,e}=fixture();s.bones.push({id:'unused',parent:null,length:1,rest:{position:[0,0],rotation:0,scale:[1,1]}});e.bones.push({id:'unused',path:'Skeleton/unused',index:1});for(const x of e.samples)x.matrices.unused=[1,0,0,1,0,0];for(const ws of s.parts[0].mesh.weights)ws.push({bone:'unused',weight:0});for(const ws of e.meshes[0].influences)ws[0].weight=.999999;
 s.parts.push({...structuredClone(s.parts[0]),id:'implicit',mesh:undefined});delete s.parts[1].mesh;p.clips[0].undersampled=true;
 const r=inspect(s,p,e);assert.equal(r.status,'partial');assert.ok(r.omissions.some(o=>o.reason==='implicit-mesh'&&o.partId==='implicit'));assert.ok(r.omissions.some(o=>o.reason==='undersampled-timeline'));
 s.animations=[];e.samples=[];assert.equal(inspect(s,null,e).status,'unverified');invalid(()=>inspect(s,p,e));
});
test('hostile descriptors, prototypes, cycles, sparse arrays, input bytes and depth are rejected before getters',()=>{
 const {s,p,e}=fixture();let read=false;const accessor={get x(){read=true;return 1;}};invalid(()=>inspect(accessor,p,e));assert.equal(read,false);
 const cyclic={};cyclic.self=cyclic;const hidden={};Object.defineProperty(hidden,'x',{value:1});let deep={};for(let i=0;i<26;i++)deep={deep};
 for(const bad of [cyclic,hidden,deep,new Date(),Object.create({}),[,,],{x:Symbol()},Object.fromEntries(Array.from({length:1100},(_,i)=>[i,'x'.repeat(16384)]))])invalid(()=>inspect(bad,p,e));
 const wrong=structuredClone(e);Object.defineProperty(wrong.samples[0].matrices,'root',{get(){read=true;return [];},enumerable:true});invalid(()=>inspect(s,p,wrong));assert.equal(read,false);
});
test('comparison budgets omit whole parts per time and failure examples preserve total',()=>{
 const {s,p,e}=fixture();const base=s.parts[0],native=e.meshes[0];s.parts=[];e.meshes=[];
 for(let i=0;i<128;i++){s.parts.push({...structuredClone(base),id:'part'+i});e.meshes.push({...structuredClone(native),part:'part'+i,path:'Meshes/part'+i});}
 p.clips[0].times=Array.from({length:64},(_,i)=>i/63);e.samples=p.clips[0].times.map(time=>({clip:'move',time,matrices:{root:[-1,0,0,1,0,0]}}));
 assert.throws(()=>inspect(s,p,e),x=>x.report.checkedVertexSamples===8190&&x.report.checkedTriangleSamples===2730&&x.report.triangleFailureCount===2730&&x.report.registrationFailureCount===2730&&x.report.failureCount===5460&&x.report.failures.length===128&&x.report.failuresTruncated&&x.report.omissionCount===(8192-2730)*4&&x.report.omissionsTruncated===true&&x.report.omissions.length===128&&Buffer.byteLength(JSON.stringify(x.report))<2*1024*1024);
});
test('independent mixed-weight projection measures normalized weighted matrix area',()=>{
 const {s,p,e}=fixture();s.bones.push({id:'other',parent:null,length:1,rest:{position:[0,0],rotation:0,scale:[1,1]}});e.bones.push({id:'other',path:'Skeleton/other',index:1});
 s.parts[0].mesh.weights=Array.from({length:3},()=>[{bone:'root',weight:.5},{bone:'other',weight:.5}]);e.meshes[0].influences=Array.from({length:3},()=>[{bone:'root',weight:.4999995},{bone:'other',weight:.4999995}]);
 for(const x of e.samples)x.matrices.other=[-3,0,0,1,0,0];
 // Weighted x scale .5*1+.5*(-3)=-1; y scale1, triangle area8 ->-8.
 assert.throws(()=>inspect(s,p,e),x=>x.report.triangleFailureCount===2&&x.diagnostics.filter(d=>d.code==='NATIVE_TRIANGLE_INVERSION').length===2&&x.diagnostics.filter(d=>d.code==='NATIVE_TRIANGLE_INVERSION').every(d=>d.projectedSignedArea===-8));
 for(const x of e.samples)x.matrices.other=[-1,0,0,-1,0,0];
 assert.throws(()=>inspect(s,p,e),x=>x.report.triangleFailureCount===2&&x.diagnostics.filter(d=>d.code==='NATIVE_TRIANGLE_COLLAPSE').length===2&&x.diagnostics.filter(d=>d.code==='NATIVE_TRIANGLE_COLLAPSE').every(d=>d.projectedSignedArea===0));
});
test('plan metadata, static degeneracy, duplicate triangles and dimensional limits reject',()=>{
 const mutations=[p=>p.version=2,p=>p.clips[0].duration=2,p=>p.clips[0].times=[0,0,1],p=>p.clips[0].undersampled='yes',p=>p.clips[0].omittedKeyTimes=[0]];
 for(const mutate of mutations){const {s,p,e}=fixture();mutate(p);invalid(()=>inspect(s,p,e));}
 {const {s,p,e}=fixture();p.clips[0].omittedEventTimes=[.5];assert.equal(inspect(s,p,e).status,'partial');}
 {const {s,p,e}=fixture();s.parts[0].mesh.triangles.push([2,1,0]);e.meshes[0].triangles.push([2,1,0]);invalid(()=>inspect(s,p,e));}
 {const {s,p,e}=fixture();delete s.parts[0].image.pixelsPerUnit;invalid(()=>inspect(s,p,e));}
 {const {s,p,e}=fixture();e.meshes[0].positions[2]=[0,0];invalid(()=>inspect(s,p,e));}
 {const {s,p,e}=fixture();e.samples[1].matrices.root=[1e6+1,0,0,1,0,0];invalid(()=>inspect(s,p,e));}
 {const {s,p,e}=fixture();s.bones=Array.from({length:129},(_,i)=>({id:'bone'+i,parent:null,length:1,rest:{position:[0,0],rotation:0,scale:[1,1]}}));s.anatomy.roles={};s.parts=[];invalid(()=>inspect(s,p,e));}
});

test('unauthored translation and rotation fail vertex registration while triangle areas survive',()=>{
 for(const matrix of [[1,0,0,1,8,0],[0,1,-1,0,0,0]]){const {s,p,e}=fixture();e.samples[1].matrices.root=matrix;assert.throws(()=>inspect(s,p,e),x=>x.code==='VISUAL_VALIDATION_FAILED'&&x.report.triangleFailureCount===0&&x.report.registrationFailureCount>0&&x.diagnostics.some(d=>d.code==='NATIVE_VERTEX_REGISTRATION_ERROR'));}
});
test('moving vertex tolerance uses public two pixel boundary',()=>{
 for(const [delta,passes]of [[2,true],[2.001,false]]){const {s,p,e}=fixture();e.samples[1].matrices.root[4]=delta;if(passes){const r=inspect(s,p,e);assert.equal(r.checkedRegistrationVertexSamples,6);assert.equal(r.maxVertexErrorPx,2);assert.equal(r.tolerancePx,2);}else assert.throws(()=>inspect(s,p,e),x=>x.report.registrationFailureCount===3&&x.report.triangleFailureCount===0);}
});

test('authored outgoing easing, last-key hold and exact loop endpoints are independent',()=>{
 for(const [easing,f]of [['linear',.25],['in',.0625],['out',.4375],['inOut',.125],['step',0]]){const {s,p,e}=fixture();s.animations[0].loop=true;s.animations[0].tracks=[{bone:'root',property:'position',keys:[{time:0,value:[0,0],easing},{time:.5,value:[16,0]}]}];p.clips[0].times=[0,.125,.5,1];e.samples=p.clips[0].times.map((time,i)=>({clip:'move',time,matrices:{root:[1,0,0,1,[0,16*f,16,16][i],0]}}));const r=inspect(s,p,e);assert.equal(r.checkedRegistrationVertexSamples,12);assert.equal(r.maxVertexErrorPx,0);}
});
test('absolute rotation limits clamp and untracked bones retain rest',()=>{
 const {s,p,e}=fixture();s.bones[0].limits=[0,Math.PI/2];s.animations[0].tracks=[{bone:'root',property:'rotation',keys:[{time:0,value:Math.PI},{time:1,value:Math.PI}]}];for(const x of e.samples)x.matrices.root=[0,1,-1,0,0,0];const r=inspect(s,p,e);assert.ok(r.maxVertexErrorPx<1e-12);
});
test('unknown influence ancestors omit only positive influenced registrations and preserve triangle verdicts',()=>{
 const {s,p,e}=fixture();s.bones.push({id:'child',parent:'root',length:1,rest:{position:[0,0],rotation:0,scale:[1,1]}},{id:'other',parent:null,length:1,rest:{position:[0,0],rotation:0,scale:[1,1]}});e.bones.push({id:'child',path:'Skeleton/root/child',index:1},{id:'other',path:'Skeleton/other',index:2});s.animations[0].tracks=[{bone:'root',property:'position',keys:[{time:.5,value:[0,0]},{time:1,value:[0,0]}]}];s.parts[0].mesh.weights=[[{bone:'child',weight:1}],[{bone:'other',weight:1},{bone:'root',weight:0}],[{bone:'other',weight:1}]];e.meshes[0].influences=[[{bone:'child',weight:1}],[{bone:'other',weight:1}],[{bone:'other',weight:1}]];for(const x of e.samples){x.matrices.child=[1,0,0,1,0,0];x.matrices.other=[1,0,0,1,0,0];}let r=inspect(s,p,e);assert.equal(r.status,'partial');assert.equal(r.omissionCount,1);assert.equal(r.checkedRegistrationVertexSamples,5);assert.equal(r.checkedTriangleSamples,2);assert.equal(r.omissions[0].vertexIndex,0);
 e.samples[0].matrices.other=[-1,0,0,1,0,0];assert.throws(()=>inspect(s,p,e),x=>x.report.triangleFailureCount===1&&x.report.omissionCount===1&&x.diagnostics.some(d=>d.code==='NATIVE_TRIANGLE_INVERSION'));
});
test('nonfinite inverse rest rejects even when no timeline needs comparison',()=>{
 const {s,e}=fixture();s.animations=[];e.samples=[];s.parts=[];e.meshes=[];s.bones[0].rest.scale=[1e-200,1e-200];invalid(()=>inspect(s,null,e));
});
