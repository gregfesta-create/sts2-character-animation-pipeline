'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSpec}=require('../lib/spec');
const {inspectAuthoredGeometry}=require('../lib/authored-geometry');
function fixture(){
 const s=createSpec({id:'numeric',description:'numeric deformation',template:'custom'});
 s.parts=[{id:'shape',role:'body',bone:'root',pivot:[0,0],layer:0,image:{path:'pixels.png',prepared:true,width:8,height:8,alphaBounds:[0,0,8,8],cropTranslation:[0,0],pivot:[0,0],pixelsPerUnit:1},mesh:{vertices:[[0,0],[2,0],[0,3]],uv:[[0,0],[2,0],[0,3]],triangles:[[0,1,2]],weights:Array.from({length:3},()=>[{bone:'root',weight:1}])}}];
 s.animations=[{id:'move',duration:1,loop:false,tracks:[],events:[]}];return s;
}
function track(s,property,a,b,bone='root'){s.animations[0].tracks.push({bone,property,keys:[{time:0,value:a},{time:1,value:b}]});}
function close(a,b){assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);}
test('rest coordinates and full nested affine transforms preserve asymmetric topology and inputs',()=>{
 const s=fixture();s.bones[0].rest={position:[10,20],rotation:Math.PI/2,scale:[2,3]};
 s.bones.push({id:'child',parent:'root',rest:{position:[1,2],rotation:Math.PI/2,scale:[3,2]},length:1});
 s.parts[0].bone='child';s.parts[0].image.pivot=[2,4];s.parts[0].image.pixelsPerUnit=2;s.parts[0].mesh.weights.forEach(w=>w[0].bone='child');
 const before=structuredClone(s),r=inspectAuthoredGeometry(s),v=r.samples[0].parts[0].vertices;
 // child frame [-9,0,0,-4,4,22]; first local(-1,-2) -> (13,30).
 close(v[0][0],13);close(v[0][1],30);close(v[1][0],4);close(v[2][1],24);
 assert.deepEqual(s,before);assert.equal(r.visualQuality,'unverified');assert.equal(r.nativeGeometry,'uncovered');
});
test('two-bone inverse rest skinning matches independent blended coordinate',()=>{
 const s=fixture();s.bones.push({id:'child',parent:'root',rest:{position:[2,0],rotation:0,scale:[1,1]},length:1});
 s.parts[0].mesh.weights=s.parts[0].mesh.vertices.map(()=>[{bone:'root',weight:.25},{bone:'child',weight:.75}]);
 track(s,'position',[2,0],[6,0],'child');const r=inspectAuthoredGeometry(s),end=r.samples.find(x=>x.clipId==='move'&&x.time===1);
 assert.deepEqual(end.parts[0].vertices,[[3,0],[5,0],[3,3]]);assert.equal(r.status,'passed');
});
test('supported key inversion and interpolated collapse reject with exact mapping',()=>{
 const s=fixture();track(s,'scale',[1,1],[-1,1]);
 assert.throws(()=>inspectAuthoredGeometry(s),e=>e.code==='AUTHORED_GEOMETRY_FAILED'&&e.diagnostics.some(d=>d.code==='TRIANGLE_COLLAPSE'&&d.clipId==='move'&&d.time===.5&&d.partId==='shape'&&d.triangle===0));
 const k=fixture();track(k,'scale',[-1,1],[-1,1]);assert.throws(()=>inspectAuthoredGeometry(k),e=>e.diagnostics.some(d=>d.code==='TRIANGLE_INVERSION'&&d.time===0));
});
test('rigid rotation and translation preserve signed areas',()=>{
 const s=fixture();track(s,'rotation',0,Math.PI*2);track(s,'position',[0,0],[7,-9]);
 const r=inspectAuthoredGeometry(s);for(const x of r.samples)close(x.parts[0].areas[0],3);assert.equal(r.status,'passed');
});
test('eased interiors are measured while pre-first keys and loop endpoints remain omissions',()=>{
 const s=fixture();track(s,'position',[0,0],[2,0]);s.animations[0].tracks[0].keys[0]={time:.25,value:[0,0],easing:'in'};s.animations[0].loop=true;
 const r=inspectAuthoredGeometry(s);assert.equal(r.status,'partial');assert.ok(r.omissions.some(x=>x.reason==='before-first-key'));assert.ok(!r.omissions.some(x=>x.reason==='nonlinear-interpolation'));assert.ok(r.omissions.some(x=>x.reason==='loop-endpoint'));assert.ok(r.samples.some(x=>x.time===.25));assert.ok(r.samples.some(x=>x.time===.5));
});
test('all easing modes use outgoing transitions for scalar rotation and both vector components',()=>{
 const expected={linear:[.25,.75],in:[.0625,.5625],out:[.4375,.9375],inOut:[.125,.875],step:[0,0]};
 for(const [easing,progress]of Object.entries(expected)){
  const s=fixture();track(s,'position',[4,-2],[12,6]);track(s,'scale',[1,2],[3,4]);track(s,'rotation',.2,1.2);
  for(const t of s.animations[0].tracks){t.keys[0].easing=easing;t.keys[1].easing='step';}
  const before=structuredClone(s),r=inspectAuthoredGeometry(s);assert.equal(r.scope,'authored-eased-linear-skinning');assert.deepEqual(s,before);
  for(const [index,time]of [.25,.75].entries()){
   const f=progress[index],v=r.samples.find(x=>x.time===time).parts[0].vertices,angle=.2+f;
   close(v[0][0],4+8*f);close(v[0][1],-2+8*f);
   close(v[1][0]-v[0][0],2*(1+2*f)*Math.cos(angle));close(v[1][1]-v[0][1],2*(1+2*f)*Math.sin(angle));
   close(v[2][0]-v[0][0],-3*(2+2*f)*Math.sin(angle));close(v[2][1]-v[0][1],3*(2+2*f)*Math.cos(angle));
  }
 }
});
test('step holds open intervals and exact keys take their values with the next outgoing easing',()=>{
 const s=fixture();s.animations[0].tracks=[{bone:'root',property:'position',keys:[{time:0,value:[0,0],easing:'step'},{time:.5,value:[8,-4],easing:'in'},{time:1,value:[16,4],easing:'out'}]}];
 const r=inspectAuthoredGeometry(s),origin=time=>r.samples.find(x=>x.time===time).parts[0].vertices[0];
 assert.deepEqual(origin(0),[0,0]);assert.deepEqual(origin(.4375),[0,0]);assert.deepEqual(origin(.5),[8,-4]);assert.deepEqual(origin(.75),[10,-2]);assert.deepEqual(origin(1),[16,4]);
});
test('default expanded inOut clips now project their non-key interiors',()=>{
 const s=fixture();s.anatomy.roles.torso='root';s.bones.push({id:'arm',parent:'root',rest:{position:[0,0],rotation:0,scale:[1,1]},length:1});s.anatomy.roles.armLeft='arm';
 const expanded=require('../lib/animation').expandClips(s,['idle']),r=inspectAuthoredGeometry(expanded),sample=r.samples.find(x=>x.clipId==='idle'&&x.time===.125);
 assert.ok(sample);close(sample.parts[0].vertices[1][1],2*Math.sin(.035*.125));assert.ok(!r.omissions.some(x=>x.reason==='nonlinear-interpolation'));assert.equal(r.visualQuality,'unverified');assert.equal(r.nativeGeometry,'uncovered');
});
test('weighted mesh valid at both keys rejects an eased interior inversion',()=>{
 const s=fixture();s.bones.push({id:'child',parent:'root',rest:{position:[0,0],rotation:0,scale:[1,1]},length:1});
 s.parts[0].mesh.weights[2]=[{bone:'root',weight:.25},{bone:'child',weight:.75}];track(s,'rotation',0,2*Math.PI,'child');s.animations[0].tracks[0].keys[0].easing='in';
 assert.throws(()=>inspectAuthoredGeometry(s),e=>e.code==='AUTHORED_GEOMETRY_FAILED'&&e.authoredGeometry.samples.filter(x=>x.time===0||x.time===1).every(x=>x.parts[0].areas[0]>0)&&e.diagnostics.some(d=>d.code==='TRIANGLE_INVERSION'&&d.time===.75));
});
test('limited rotations outside runtime clamp are uncovered instead of false inversion',()=>{
 const s=fixture();s.bones[0].limits=[-.1,.1];track(s,'rotation',0,Math.PI);const r=inspectAuthoredGeometry(s);assert.ok(r.omissions.some(x=>x.reason==='runtime-joint-limit'));assert.equal(r.status,'partial');
});
test('empty meshes and no motion are explicitly unverified',()=>{
 const s=fixture();delete s.parts[0].mesh;assert.equal(inspectAuthoredGeometry(s).status,'unverified');const q=fixture();q.animations=[];assert.equal(inspectAuthoredGeometry(q).status,'unverified');
});
test('invalid, nonfinite, cyclic, accessors and oversized trees fail boundedly',()=>{
 for(const mutate of [s=>s.parts[0].mesh.vertices[0][0]=NaN,s=>s.parts[0].mesh.vertices[2]=[4,0],s=>s.self=s,s=>Object.defineProperty(s,'trap',{enumerable:true,get(){throw Error('getter executed');}}),s=>s.description='x'.repeat(20000)]){
  const s=fixture();mutate(s);assert.throws(()=>inspectAuthoredGeometry(s),e=>['INVALID_AUTHORED_GEOMETRY','INVALID_SPEC'].includes(e.code));
 }
});
test('bounded sampling reports omitted keys and output budgets',()=>{
 const s=fixture();s.animations[0].tracks=[{bone:'root',property:'position',keys:Array.from({length:100},(_,i)=>({time:i/99,value:[i,0]}))}];
 const r=inspectAuthoredGeometry(s);assert.ok(r.sampling.clips[0].omittedKeyTimes.length);assert.ok(r.samples.length<=129);assert.ok(Buffer.byteLength(JSON.stringify(r))<=2*1024*1024);
});
test('non-loop clips hold the last authored value and unsupported loop wrap remains uncovered',()=>{
 const s=fixture();s.animations[0].tracks=[{bone:'root',property:'position',keys:[{time:0,value:[4,5]},{time:.5,value:[7,8]}]}];
 const r=inspectAuthoredGeometry(s);assert.deepEqual(r.samples.at(-1).parts[0].vertices,[[7,8],[9,8],[7,11]]);
 s.animations[0].loop=true;assert.ok(inspectAuthoredGeometry(s).omissions.some(x=>x.reason==='loop-wrap'));
});
test('global projection budgets omit excess work without reporting full coverage',()=>{
 const s=fixture();s.animations=Array.from({length:32},(_,i)=>({...structuredClone(s.animations[0]),id:'clip'+i}));
 const r=inspectAuthoredGeometry(s);assert.equal(r.coverage.motionSamples,128);assert.ok(r.omissions.some(x=>x.reason==='motion-budget'));assert.equal(r.status,'partial');
 const q=fixture();q.parts[0].mesh.vertices=Array.from({length:1000},(_,i)=>[i%10,Math.floor(i/10)]);q.parts[0].mesh.vertices[2]=[0,3];q.parts[0].mesh.uv=structuredClone(q.parts[0].mesh.vertices);q.parts[0].mesh.weights=q.parts[0].mesh.vertices.map(()=>[{bone:'root',weight:1}]);
 const g=inspectAuthoredGeometry(q);assert.ok(g.coverage.vertexSamples<=8192);assert.ok(g.omissions.some(x=>x.reason==='geometry-budget'));assert.equal(g.status,'partial');
});
test('symbols, sparse arrays, prototypes and hidden fields never enter projection',()=>{
 for(const mutate of [s=>s[Symbol('hidden')]=1,s=>Object.defineProperty(s,'hidden',{value:1}),s=>Object.setPrototypeOf(s,{bad:true}),s=>{delete s.parts[0].mesh.vertices[1];}]){
  const s=fixture();mutate(s);assert.throws(()=>inspectAuthoredGeometry(s),{code:'INVALID_AUTHORED_GEOMETRY'});
 }
});
test('more than 32 native clips remain valid with explicit bounded clip omissions',()=>{
 const s=fixture();s.animations=Array.from({length:33},(_,i)=>({...structuredClone(s.animations[0]),id:'clip'+i}));
 const r=inspectAuthoredGeometry(s);assert.deepEqual(r.sampling.omittedClipIds,['clip32']);assert.ok(r.omissions.some(x=>x.clipId==='clip32'&&x.reason==='clip-budget'));assert.equal(r.status,'partial');
});
test('expanded JSON byte budget rejects repeated strings before whole-input serialization',()=>{
 const s=fixture();s.repeated=Array(1200).fill('x'.repeat(16384));
 const stringify=JSON.stringify;JSON.stringify=function(value,...args){if(value===s)throw Error('Whole oversized input reached serializer');return stringify(value,...args);};
 try{assert.throws(()=>inspectAuthoredGeometry(s),e=>e.code==='INVALID_AUTHORED_GEOMETRY'&&e.message.includes('16 MiB'));}finally{JSON.stringify=stringify;}
});
