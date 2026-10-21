'use strict';
// Observed RenderingServer projection compared with authored LBS; not GPU vertex readback.
const {assertSpec}=require('./spec');
const {hashValue}=require('./assets');
const {validateTelemetry}=require('./validation');
const invalid=message=>{throw Object.assign(new Error(message),{code:'INVALID_NATIVE_SKINNING'});};
const INPUT_BYTES=16*1024*1024,OUTPUT_BYTES=2*1024*1024,EXAMPLES=128,TOLERANCE=1e-5;
function plain(value,state,depth=0){
 const charge=n=>{state.bytes+=n;if(state.bytes>INPUT_BYTES)invalid('Native skinning input exceeds byte budget');};
 if(++state.nodes>500000||depth>24)invalid('Native skinning input exceeds traversal budget');
 if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&value.length<=16384){charge(Buffer.byteLength(JSON.stringify(value)));return;}
 if(typeof value!=='object'||state.seen.has(value)||!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid('Expected finite plain skinning data');
 if(Array.isArray(value)){
  if(Object.getPrototypeOf(value)!==Array.prototype||value.length>100000||Object.getOwnPropertyNames(value).length!==value.length+1)invalid('Invalid skinning array');
  for(let i=0;i<value.length;i++)if(!Object.hasOwn(value,String(i)))invalid('Sparse skinning arrays are unsupported');
 }
 state.seen.add(value);charge(2);let count=0;
 for(const key of Reflect.ownKeys(value)){
  if(Array.isArray(value)&&key==='length')continue;
  const d=Object.getOwnPropertyDescriptor(value,key);
  if(typeof key!=='string'||key.length>16384||!d.enumerable||!Object.hasOwn(d,'value'))invalid('Skinning accessors or hidden properties are unsupported');
  charge((count++?1:0)+(Array.isArray(value)?0:Buffer.byteLength(JSON.stringify(key))+1));plain(d.value,state,depth+1);
 }
 if(Array.isArray(value)&&count!==value.length)invalid('Sparse skinning arrays are unsupported');state.seen.delete(value);
}
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function exact(x,keys){if(!object(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))invalid('Native skinning record has invalid keys');}
const bounded=x=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<=1e6;
const near=(a,b)=>Math.abs(a-b)<=TOLERANCE+TOLERANCE*Math.max(Math.abs(a),Math.abs(b));
const area=(a,b,c)=>((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;
function valueAt(track,time){
 const keys=track.keys;if(time<keys[0].time)return null;
 const exactKey=keys.find(k=>k.time===time);if(exactKey)return exactKey.value;
 if(time>keys.at(-1).time)return keys.at(-1).value;
 const index=keys.findIndex(k=>k.time>time),a=keys[index-1],b=keys[index],t=(time-a.time)/(b.time-a.time),e=a.easing??'linear';
 const f=e==='in'?t*t:e==='out'?1-(1-t)*(1-t):e==='inOut'?(t<.5?2*t*t:1-2*(1-t)*(1-t)):e==='step'?0:t;
 const lerp=(x,y)=>x+(y-x)*f;return Array.isArray(a.value)?a.value.map((x,i)=>lerp(x,b.value[i])):lerp(a.value,b.value);
}
const multiply=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
const transform=(m,v)=>[m[0]*v[0]+m[2]*v[1]+m[4],m[1]*v[0]+m[3]*v[1]+m[5]];
function inverse(m){const d=m[0]*m[3]-m[1]*m[2];if(!Number.isFinite(d)||d===0)invalid('Singular expected rest transform');const r=[m[3]/d,-m[1]/d,-m[2]/d,m[0]/d,0,0];r[4]=-r[0]*m[4]-r[2]*m[5];r[5]=-r[1]*m[4]-r[3]*m[5];if(!r.every(Number.isFinite))invalid('Nonfinite expected inverse rest transform');return r;}
function inspectNativeSkinning(input,plan,evidence){
 const state={nodes:0,bytes:0,seen:new Set()};plain(input,state);plain(plan,state);plain(evidence,state);
 let spec;try{spec=assertSpec(input);}catch{invalid('Invalid compiled skinning specification');}
 if(spec.bones.length>128||spec.parts.length>128||spec.animations.length>32)invalid('Native skinning exceeds bone/mesh/clip limits');
 exact(evidence,['version','bones','meshes','samples']);
 if(evidence.version!==1||!Array.isArray(evidence.bones)||!Array.isArray(evidence.meshes)||!Array.isArray(evidence.samples)||evidence.bones.length!==spec.bones.length||evidence.meshes.length>128||evidence.samples.length>64||evidence.samples.length*spec.bones.length>8192)invalid('Native skinning evidence exceeds limits or identities');
 const timeline=[],timelineOmissions=[];
 if(plan===null){if(spec.animations.length||evidence.samples.length)invalid('Null skinning plan requires no authored clips or samples');}
 else{
  if(!object(plan)||plan.version!==1||!Array.isArray(plan.clips)||plan.clips.length!==spec.animations.length||!plan.clips.length)invalid('Skinning plan differs from authored clips');
  for(let i=0;i<plan.clips.length;i++){
   const p=plan.clips[i],c=spec.animations[i];
   if(!object(p)||p.id!==c.id||p.duration!==c.duration||!Array.isArray(p.times)||p.times.length<2||p.times.length>64||p.times[0]!==0||p.times.at(-1)!==c.duration)invalid('Skinning clip plan metadata differs');
   let previous=-1;for(const time of p.times){if(!bounded(time)||time<0||time>c.duration||time<=previous)invalid('Invalid ordered skinning times');previous=time;timeline.push({clip:c.id,time});}
   let omitted=false;
   for(const key of ['omittedKeyTimes','omittedEventTimes'])if(Object.hasOwn(p,key)){
    if(!Array.isArray(p[key])||p[key].length>65536||p[key].some((t,j)=>!bounded(t)||t<0||t>c.duration||p.times.includes(t)||j>0&&t<=p[key][j-1]))invalid('Invalid omitted skinning times');omitted ||= p[key].length>0;
   }
   if(Object.hasOwn(p,'undersampled')&&typeof p.undersampled!=='boolean')invalid('Invalid skinning undersampling flag');
   if(p.undersampled||omitted)timelineOmissions.push({clipId:c.id,reason:'undersampled-timeline'});
  }
  if(timeline.length>64||timeline.length!==evidence.samples.length)invalid('Skinning sample count differs');
 }
 const bones=new Map(spec.bones.map(b=>[b.id,b])),paths=new Map(),frames=new Map();
 function visit(id){
  if(frames.has(id))return frames.get(id);const bone=bones.get(id),parent=bone.parent===null?null:visit(bone.parent),r=bone.rest,c=Math.cos(r.rotation),s=Math.sin(r.rotation),local=[c*r.scale[0],s*r.scale[0],-s*r.scale[1],c*r.scale[1],...r.position];
  const a=parent,m=a?[a[0]*local[0]+a[2]*local[1],a[1]*local[0]+a[3]*local[1],a[0]*local[2]+a[2]*local[3],a[1]*local[2]+a[3]*local[3],a[0]*local[4]+a[2]*local[5]+a[4],a[1]*local[4]+a[3]*local[5]+a[5]]:local;
  if(!m.every(Number.isFinite))invalid('Nonfinite expected rest transform');frames.set(id,m);paths.set(id,bone.parent===null?'Skeleton/'+id:paths.get(bone.parent)+'/'+id);return m;
 }
 for(const id of bones.keys())visit(id);
 const inverses=new Map([...frames].map(([id,m])=>[id,inverse(m)])),authoredPositions=new Map();
 const seenBones=new Set(),indices=new Set();
 for(const bone of evidence.bones){exact(bone,['id','path','index']);if(!bones.has(bone.id)||seenBones.has(bone.id)||bone.path!==paths.get(bone.id)||!Number.isInteger(bone.index)||bone.index<0||bone.index>=bones.size||indices.has(bone.index))invalid('Native bone mapping differs');seenBones.add(bone.id);indices.add(bone.index);}
 const explicit=spec.parts.filter(p=>p.mesh),parts=new Map(explicit.map(p=>[p.id,p])),meshIds=new Set(),restAreas=new Map(),omissions=spec.parts.filter(p=>!p.mesh).map(p=>({partId:p.id,reason:'implicit-mesh'}));
 if(evidence.meshes.length!==explicit.length)invalid('Native explicit mesh identities differ');
 let vertices=0,triangles=0;
 for(const mesh of evidence.meshes){
  exact(mesh,['part','path','positions','triangles','influences']);const part=parts.get(mesh.part);
  if(!part||meshIds.has(mesh.part)||mesh.path!=='Meshes/'+mesh.part)invalid('Native mesh mapping differs');meshIds.add(mesh.part);
  const authored=part.mesh,im=part.image;
  if(!im||!Array.isArray(im.pivot)||im.pivot.length!==2||!im.pivot.every(bounded)||!bounded(im.pixelsPerUnit)||im.pixelsPerUnit<=0)invalid('Prepared mesh registration metadata is required');
  if(!Array.isArray(mesh.positions)||!Array.isArray(mesh.triangles)||!Array.isArray(mesh.influences)||mesh.positions.length!==authored.vertices.length||mesh.influences.length!==authored.weights.length||mesh.triangles.length!==authored.triangles.length)invalid('Native mesh lengths differ');
  vertices+=mesh.positions.length;triangles+=mesh.triangles.length;if(vertices>8192||triangles>16384)invalid('Native static geometry exceeds limits');
  const m=frames.get(part.bone);authoredPositions.set(part.id,[]);
  for(let i=0;i<mesh.positions.length;i++){
   const v=mesh.positions[i],av=authored.vertices[i],x=(av[0]-im.pivot[0])/im.pixelsPerUnit,y=(av[1]-im.pivot[1])/im.pixelsPerUnit,expected=[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
   authoredPositions.get(part.id).push(expected);
   if(!Array.isArray(v)||v.length!==2||!v.every(bounded)||!expected.every(bounded)||v.some((n,k)=>!near(n,expected[k])))invalid('Native rest vertices differ from prepared mesh');
   const influences=mesh.influences[i],expectedWeights=new Map(authored.weights[i].filter(w=>w.weight>0).map(w=>[w.bone,w.weight]));
   if(!Array.isArray(influences)||influences.length<1||influences.length>4||influences.length!==expectedWeights.size)invalid('Native positive influence count differs');
   const seen=new Set();let sum=0;
   for(const w of influences){exact(w,['bone','weight']);if(!expectedWeights.has(w.bone)||seen.has(w.bone)||!bounded(w.weight)||w.weight<=0||!near(w.weight,expectedWeights.get(w.bone)))invalid('Native sparse weights differ');seen.add(w.bone);sum+=w.weight;}
   if(Math.abs(sum-1)>TOLERANCE)invalid('Native positive weights are not normalized');
  }
  const seenTriangles=new Set(),areas=[];
  for(let i=0;i<mesh.triangles.length;i++){
   const t=mesh.triangles[i],expected=authored.triangles[i];
   if(!Array.isArray(t)||t.length!==3||t.some((n,k)=>!Number.isInteger(n)||n<0||n>=mesh.positions.length||n!==expected[k])||new Set(t).size!==3)invalid('Native triangle topology differs');
   const key=[...t].sort((a,b)=>a-b).join(',');if(seenTriangles.has(key))invalid('Repeated native triangle');seenTriangles.add(key);
   const signed=area(...t.map(i=>mesh.positions[i]));if(!Number.isFinite(signed)||signed===0)invalid('Degenerate native rest triangle');areas.push(signed);
  }
  restAreas.set(mesh.part,areas);
 }
 for(let i=0;i<evidence.samples.length;i++){
  const sample=evidence.samples[i];exact(sample,['clip','time','matrices']);
  if(sample.clip!==timeline[i].clip||sample.time!==timeline[i].time||!object(sample.matrices)||Object.keys(sample.matrices).length!==bones.size)invalid('Native matrix sample identity differs');
  for(const id of bones.keys()){const m=sample.matrices[id];if(!Object.hasOwn(sample.matrices,id)||!Array.isArray(m)||m.length!==6||!m.every(bounded))invalid('Native matrix requires six bounded coefficients');}
 }
 const tolerancePx=validateTelemetry({version:1,thresholdVersion:'telemetry-v1',attachments:[],weights:[],triangles:[],inversionExceptions:[],loopEndpoints:[],frameJumpThresholds:[],frameJumps:[]}).thresholds.attachmentMovingPx;
 const report={version:1,scope:'native-matrix-projected-triangles-and-moving-vertices',status:'unverified',specHash:hashValue(spec),planHash:hashValue(plan),evidenceHash:hashValue(evidence),bindingTolerance:{absolute:TOLERANCE,relative:TOLERANCE},sampleCount:evidence.samples.length,checkedVertexSamples:0,checkedRegistrationVertexSamples:0,maxVertexErrorPx:0,tolerancePx,triangleFailureCount:0,registrationFailureCount:0,checkedTriangleSamples:0,omissions:[],omissionCount:0,omissionsTruncated:false,failures:[],failureCount:0,failuresTruncated:false,visualQuality:'unverified',outsideScope:['gpu-pixels','continuous-motion','strain','layers','assemblies','blends','actions','runtime-constraints','artistic-quality']};
 const omit=o=>{report.omissionCount++;if(report.omissions.length<EXAMPLES)report.omissions.push(o);};
 for(const o of [...omissions,...timelineOmissions])omit(o);
 const clips=new Map(spec.animations.map(c=>[c.id,c]));
 function expectedMatrices(sample){
  const poses=new Map(spec.bones.map(b=>[b.id,{...b.rest}])),unknown=new Set(),result=new Map();
  for(const track of clips.get(sample.clip).tracks){const value=valueAt(track,sample.time);if(value===null)unknown.add(track.bone);else poses.get(track.bone)[track.property]=value;}
  function visit(id){if(result.has(id))return result.get(id);const b=bones.get(id),a=b.parent===null?null:visit(b.parent);if(unknown.has(id)||b.parent!==null&&a===null){result.set(id,null);return null;}const p=poses.get(id),r=b.limits?Math.max(b.limits[0],Math.min(b.limits[1],p.rotation)):p.rotation,c=Math.cos(r),s=Math.sin(r),local=[c*p.scale[0],s*p.scale[0],-s*p.scale[1],c*p.scale[1],...p.position],m=a?multiply(a,local):local;if(!m.every(Number.isFinite))invalid('Nonfinite expected pose transform');result.set(id,m);return m;}
  for(const id of bones.keys())visit(id);
  return new Map([...result].map(([id,m])=>{const skin=m===null?null:multiply(m,inverses.get(id));if(skin!==null&&!skin.every(Number.isFinite))invalid('Nonfinite expected skin transform');return [id,skin];}));
 }
 // Validate the entire receipt above before comparing any sampled deformation.
 for(const sample of evidence.samples){const expectedFrames=expectedMatrices(sample);for(const mesh of evidence.meshes){
  if(report.checkedVertexSamples+mesh.positions.length>8192||report.checkedTriangleSamples+mesh.triangles.length>16384){omit({partId:mesh.part,clipId:sample.clip,time:sample.time,reason:'comparison-budget'});const examples=Math.min(mesh.positions.length,EXAMPLES-report.omissions.length);for(let vertexIndex=0;vertexIndex<examples;vertexIndex++)report.omissions.push({partId:mesh.part,clipId:sample.clip,time:sample.time,vertexIndex,reason:'registration-comparison-budget'});report.omissionCount+=mesh.positions.length;continue;}
  const projected=mesh.positions.map((v,i)=>{
   const weights=mesh.influences[i],sum=weights.reduce((n,w)=>n+w.weight,0),p=[0,0];
   for(const w of weights){const m=sample.matrices[w.bone],f=w.weight/sum;p[0]+=(m[0]*v[0]+m[2]*v[1]+m[4])*f;p[1]+=(m[1]*v[0]+m[3]*v[1]+m[5])*f;}
   if(!p.every(Number.isFinite))invalid('Nonfinite projected native vertex');return p;
  });
  report.checkedVertexSamples+=mesh.positions.length;report.checkedTriangleSamples+=mesh.triangles.length;
  mesh.triangles.forEach((triangle,triangleIndex)=>{
   const restSignedArea=restAreas.get(mesh.part)[triangleIndex],projectedSignedArea=area(...triangle.map(i=>projected[i]));if(!Number.isFinite(projectedSignedArea))invalid('Nonfinite projected native triangle');
   const code=projectedSignedArea===0?'NATIVE_TRIANGLE_COLLAPSE':Math.sign(projectedSignedArea)!==Math.sign(restSignedArea)?'NATIVE_TRIANGLE_INVERSION':null;
   if(code){report.triangleFailureCount++;report.failureCount++;if(report.failures.length<EXAMPLES)report.failures.push({code,partId:mesh.part,clipId:sample.clip,time:sample.time,triangleIndex,triangle:[...triangle],restSignedArea,projectedSignedArea});}
  });
  for(let vertexIndex=0;vertexIndex<mesh.positions.length;vertexIndex++){
   const weights=parts.get(mesh.part).mesh.weights[vertexIndex].filter(w=>w.weight>0),identity={partId:mesh.part,clipId:sample.clip,time:sample.time,vertexIndex};
   if(weights.some(w=>expectedFrames.get(w.bone)===null)){omit({...identity,reason:'before-first-key-or-ancestor'});continue;}
   const expected=[0,0],sum=weights.reduce((n,w)=>n+w.weight,0);
   for(const w of weights){const v=transform(expectedFrames.get(w.bone),authoredPositions.get(mesh.part)[vertexIndex]),f=w.weight/sum;expected[0]+=v[0]*f;expected[1]+=v[1]*f;}
   const actual=projected[vertexIndex],measured=Math.hypot(expected[0]-actual[0],expected[1]-actual[1]);if(!expected.every(Number.isFinite)||!Number.isFinite(measured))invalid('Nonfinite expected vertex registration');report.checkedRegistrationVertexSamples++;report.maxVertexErrorPx=Math.max(report.maxVertexErrorPx,measured);
   if(measured>tolerancePx){report.registrationFailureCount++;report.failureCount++;if(report.failures.length<EXAMPLES)report.failures.push({code:'NATIVE_VERTEX_REGISTRATION_ERROR',...identity,expected,actual,measured,limit:tolerancePx});}
  }
 }
 }
 report.omissionsTruncated=report.omissionCount>report.omissions.length;report.failuresTruncated=report.failureCount>report.failures.length;
 report.status=report.failureCount?'failed':!evidence.samples.length?'unverified':report.omissionCount?'partial':report.checkedTriangleSamples?'passed':'unverified';
 if(Buffer.byteLength(JSON.stringify(report))>OUTPUT_BYTES)invalid('Native skinning report exceeds byte budget');
 if(report.failureCount)throw Object.assign(new Error('Native projected geometry differs from authored motion or triangle winding'),{code:'VISUAL_VALIDATION_FAILED',diagnostics:report.failures,report});return report;
}
module.exports={inspectNativeSkinning};
