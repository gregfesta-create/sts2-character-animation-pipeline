'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {validateSpec}=require('../../lib/spec');
const {validateEffectPlan}=require('../../lib/effect-plan');
const {createCombatPresentationFixture}=require('./combat_presentation_fixture');
const pngBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==','base64');
// Real checked-in C# bytes exercise evidence provenance; this test does not
// pretend that the existing attack card is an implemented buff mechanic.
const powerSourcePath=path.join(__dirname,'PipelineCombatFixture.cs'),powerSourceBytes=fs.readFileSync(powerSourcePath);
const args=()=>({imagePath:path.join(__dirname,'synthetic.png'),pngBytes,powerSourcePath,powerSourceBytes,powerSymbol:'PipelineFixtureAttack'});
test('synthetic combat bow and effects satisfy production contracts with exact supplied source provenance',()=>{
 const compressed=[];for(let offset=8;offset<pngBytes.length;){const length=pngBytes.readUInt32BE(offset);if(pngBytes.toString('ascii',offset+4,offset+8)==='IDAT')compressed.push(pngBytes.subarray(offset+8,offset+8+length));offset+=length+12;}
 assert.equal(pngBytes[24],8);assert.equal(pngBytes[25],6);
 assert.deepEqual([...require('node:zlib').inflateSync(Buffer.concat(compressed))],[0,255,255,255,255],'Neutral opaque white pixel preserves multiplicative green tint');
 const f=createCombatPresentationFixture(args());assert.deepEqual(validateSpec(f.spec),{valid:true,errors:[]});
 const b=f.effectBuild,e=b.plan.evidence[0];assert.equal(e.hash,crypto.createHash('sha256').update(powerSourceBytes).digest('hex'));assert.equal(e.path,powerSourcePath);assert(e.excerpt.includes('PipelineFixtureAttack'));
 assert.equal(e.excerpt,powerSourceBytes.toString('utf8').split(/\r?\n/)[e.lineStart-1]);
 const effects=b.catalog.map(c=>({...c,implemented:true,resources:b.resources.map(r=>({sha256:r.hash,...r}))}));
 assert.deepEqual(validateEffectPlan(b.plan,{inventory:b.inventory,bindings:b.bindings,effects,sockets:f.spec.sockets}),{valid:true,errors:[]});
 assert(b.plan.decisions.every(d=>/synthetic developer fixture/i.test(d.reason)));
});
test('curved limbs have straight resting string and drawn V string with two physical release cues',()=>{
 const f=createCombatPresentationFixture(args()),s=f.spec;
 assert.equal(s.export.playback,'tree');assert.equal(s.sounds.length,0);
 const upper=s.parts.find(p=>p.id==='upper');assert(new Set(upper.mesh.vertices.filter((_,i)=>i%2===0).map(v=>v[0])).size>2);
 const anchors=s.polylines[0].anchors;const bones=new Map(s.bones.map(b=>[b.id,b]));
 const x=a=>a.position[0]+bones.get(a.bone).rest.position[0];assert.equal(x(anchors[0]),x(anchors[1]));assert.equal(x(anchors[1]),x(anchors[2]));
 for(const id of Object.values(f.clipIds)){
  const clip=s.animations.find(a=>a.id===id),events=clip.events.filter(e=>e.type==='projectile');assert.equal(events.length,2);assert.equal(new Set(events.map(e=>e.id)).size,2);
  assert(events.every(e=>e.time===f.releaseAt&&e.payload.nockedPart==='arrow'&&e.payload.sourceSocket==='release'));
  const nock=clip.tracks.find(t=>t.bone==='nock');assert(nock.keys.find(k=>k.time===f.releaseAt).value[0]<-40);
  assert(clip.tracks.some(t=>t.bone==='upperTip'&&t.keys.some(k=>k.value<0)));
 }
 assert(f.impactAt>f.releaseAt);assert.equal(s.projectiles[0].forward[0],1);
});
test('fresh deeply immutable results cannot alias caller buffers or another fixture',()=>{
 const a={...args(),pngBytes:Buffer.from(pngBytes),powerSourceBytes:Buffer.from(powerSourceBytes)},f=createCombatPresentationFixture(a),g=createCombatPresentationFixture(a);assert.notEqual(f,g);assert.notEqual(f.spec.parts,g.spec.parts);
 assert.throws(()=>{f.spec.bones[0].rest.position[0]=0;},TypeError);
 const before=f.effectBuild.resources[0].base64,sourceHash=f.effectBuild.plan.evidence[0].hash;a.pngBytes.fill(0);a.powerSourceBytes.fill(0);assert.equal(f.effectBuild.resources[0].base64,before);assert.equal(f.effectBuild.plan.evidence[0].hash,sourceHash);
});
test('missing symbols, non-PNG bytes and relative source/image paths are rejected',()=>{
 for(const changes of [{powerSymbol:'MissingPower'},{pngBytes:Buffer.from('not png')},{powerSourcePath:'relative.cs'},{imagePath:'relative.png'},{powerSourceBytes:Buffer.alloc(0)}])assert.throws(()=>createCombatPresentationFixture({...args(),...changes}));
});
