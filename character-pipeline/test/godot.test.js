'use strict';

const {
  test
} = require('node:test');
const assert = require('node:assert/strict');
const {
  validateGodotSpec
} = require('../backends/godot');
const {
  createSpec
} = require('../lib/spec');
const fs = require('node:fs/promises');
const path = require('node:path');
const {planRenderViewport}=require('../lib/render-layout');
const {
  compileGodot
} = require('../backends/godot');
// Numeric native receipts: identity skin transforms at rest, not authored pose substitutes.
function skinningReceipt(spec,samples=[],meshes=[]) {
 const bonePath=id=>{const b=spec.bones.find(b=>b.id===id);return b.parent===null?'Skeleton/'+id:bonePath(b.parent)+'/'+id;};
 return {version:1,bones:spec.bones.map((b,index)=>({id:b.id,path:bonePath(b.id),index})),meshes,samples:samples.map(s=>({clip:s.clip,time:s.time,matrices:Object.fromEntries(spec.bones.map(b=>[b.id,[1,0,0,1,...(s.bones[b.id]?[s.bones[b.id][0]-b.rest.position[0],s.bones[b.id][1]-b.rest.position[1]]:[0,0])]]))}))};
}
test('rendered backend preflights telemetry limits before staging or tool launch',async t=>{
 const spec=createSpec({id:'manyBones',description:'synthetic'});
 const bone=structuredClone(spec.bones[0]);spec.bones.push(...Array.from({length:128},(_,i)=>({...structuredClone(bone),id:'bone'+i,parent:'root'})));
 const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'telemetry-preflight-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let called=false;await assert.rejects(compileGodot(spec,{render:true,stagingDir:path.join(dir,'output'),runTool:async()=>{called=true;}}),{code:'CAPABILITY_MISSING'});assert.equal(called,false);await assert.rejects(fs.access(path.join(dir,'output')));
});
test('backend requires verified assembly and explicit tree playback for STS2 graphics', () => {
  for (const field of ['components']) {
    const spec = createSpec({
      id: 'strip',
      description: 'synthetic',
      template: 'custom'
    });
    spec[field] = [{}];
    assert.throws(() => validateGodotSpec(spec), new RegExp(field));
  }
  const spec = createSpec({
    id: 'strip',
    description: 'synthetic',
    template: 'custom'
  });
  spec.export.target = 'sts2';
  assert.throws(() => validateGodotSpec(spec), /STS2.*tree/);
  spec.export.playback='tree';
  const original=structuredClone(spec);
  assert.doesNotThrow(()=>validateGodotSpec(spec));
  assert.deepEqual(spec,original);
});
test('backend accepts full socket inheritance and diagnoses unsupported partial mounts',()=>{
  const spec=createSpec({id:'mountFixture',description:'synthetic source socket'});
  spec.sockets=[{id:'source',bone:'root',transform:{position:[0,0],rotation:0,scale:[1,1]},types:['projectile'],capacity:1,inheritance:{position:true,rotation:true,scale:true}}];
  assert.doesNotThrow(()=>validateGodotSpec(spec));
  spec.sockets[0].inheritance.scale=false;
  assert.throws(()=>validateGodotSpec(spec),/Partial socket inheritance/);
});
test('backend accepts tree playback and rejects unprepared images', () => {
  const spec = createSpec({
    id: 'strip',
    description: 'synthetic strip',
    template: 'custom'
  });
  spec.export.playback = 'tree';
  assert.doesNotThrow(() => validateGodotSpec(spec));
  spec.export.playback = 'player';
  spec.parts = [{
    id: 'strip',
    bone: spec.bones[0].id,
    layer: 0,
    image: {
      path: 'strip.png'
    }
  }];
  assert.throws(() => validateGodotSpec(spec), /prepared/);
});
test('backend rejects unsupported influences, UVs, and joint-limit tracks', () => {
  const spec = createSpec({
    id: 'strip',
    description: 'synthetic',
    template: 'custom'
  });
  spec.parts = [{
    id: 'strip',
    bone: 'root',
    layer: 0,
    image: {
      prepared: true,
      width: 4,
      height: 4
    },
    mesh: {
      weights: [Array(5).fill({
        bone: 'root',
        weight: 0.2
      })],
      uv: [[0, 0]]
    }
  }];
  assert.throws(() => validateGodotSpec(spec), /four/);
  spec.parts[0].mesh.weights = [[{
    bone: 'root',
    weight: 1
  }]];
  spec.parts[0].mesh.uv = [[5, 0]];
  assert.throws(() => validateGodotSpec(spec), /UV/);
  spec.parts = [];
  spec.bones[0].limits = [-0.1, 0.1];
  spec.animations = [{
    id: 'attack',
    duration: 1,
    loop: false,
    events: [],
    tracks: [{
      bone: 'root',
      property: 'rotation',
      keys: [{
        time: 0,
        value: 1
      }]
    }]
  }];
  assert.throws(() => validateGodotSpec(spec), /limits/);
});
test('failed native tool never reports successful compilation', async () => {
  const os = require('node:os');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-godot-'));
  const spec = createSpec({
    id: 'strip',
    description: 'synthetic',
    template: 'custom'
  });
  try {
    await assert.rejects(compileGodot(spec, {
      stagingDir: dir,
      config: {
        godot: {
          executable: process.execPath
        }
      },
      runTool: async () => ({
        stdout: 'SCRIPT ERROR',
        stderr: '',
        error: null
      })
    }), /compilation failed/);
  } finally {
    await fs.rm(dir, {
      recursive: true,
      force: true
    });
  }
});
test('wrapper stages owned textures and returns native evidence paths', async () => {
  const dir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'pipeline-godot-'));
  const spec = createSpec({
    id: 'strip',
    description: 'synthetic',
    template: 'custom'
  });
  const texture = path.join(dir, 'input.png');
  await fs.writeFile(texture, 'controlled fixture');
  spec.parts = [{
    id: 'strip',
    role: 'root',
    bone: 'root',
    pivot: [0, 0],
    layer: 0,
    image: {
      path: texture,
      prepared: true,
      width: 1,
      height: 1,
      alphaBounds: [0, 0, 1, 1],
      cropTranslation: [0, 0],
      pivot: [0, 0],
      pixelsPerUnit: 1
    }
  }];
  try {
    const result = await compileGodot(spec, {
      stagingDir: dir,
      config: {
        tools: {
          megadot: {
            executable: process.execPath
          }
        }
      },
      render: true,
      runTool: async (registry, name, args) => {
        assert.equal(name, 'megadot');
        assert(args.includes('render'));
        assert.equal(registry.megadot.cwd, path.dirname(process.execPath));
        await fs.writeFile(path.join(dir, 'godot/validation.json'), JSON.stringify({
          valid: true,
          frames: [], samples:[], layerOrder:layerReceipt(spec),skinning:skinningReceipt(spec), motionPlan:null,
          renderLayout:planRenderViewport(spec.canvas,1),renderProjection:{pixels:[512,512],transform:[1,0,0,1,0,0]},
          geometry: {requested:true,result:{ok:true,telemetry:{version:1,thresholdVersion:'telemetry-v1',attachments:[{id:'attachment0',phase:'rest',expected:[0,0],actual:[0,0]}],weights:[0,1,2,3].map(i=>({id:'weight'+i,sum:1})),triangles:[],inversionExceptions:[],loopEndpoints:[],frameJumpThresholds:[],frameJumps:[]},sourceMap:{attachments:{attachment0:{meshId:"strip",path:"Meshes/strip",vertex:0}},weights:{},joints:{},loops:{}},collectorCoverage:{weightVertices:4,loopJointPairs:0,excludedTracks:0,restAnchors:1,scope:'static-representative-vertex-registration',uncovered:['attachments','movingAttachments','skinnedVertices','triangles','strain','frameJumps','runtimeConstraints','actionGeometry','mixerBlends','assemblyTransitions']}}}
        }));
        return {
          stdout: '',
          stderr: '',
          error: null,
          exitCode: 0
        };
      }
    });
    assert.deepEqual(result.frames, []);
    assert.equal(result.relative.scene, 'godot/character.tscn');
    const metadata = JSON.parse(await fs.readFile(path.join(dir, 'godot/artifacts.json')));
    assert.equal(JSON.stringify(metadata).includes(dir), false);
    assert.match(await fs.readFile(path.join(dir, 'godot/project.godot'), 'utf8'), /run\/main_scene="res:\/\/character.tscn"/);
    assert.equal(spec.parts[0].image.path, texture);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'godot/spec.json'))).parts[0].image.path, 'texture-strip.png');
  } finally {
    await fs.rm(dir, {
      recursive: true,
      force: true
    });
  }
});
test('nonzero native exit rejects even when a valid report exists', async () => {
  const dir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'pipeline-godot-exit-'));
  const spec = createSpec({
    id: 'strip',
    description: 'synthetic',
    template: 'custom'
  });
  try {
    await assert.rejects(compileGodot(spec, {
      stagingDir: dir,
      config: {
        godot: {
          executable: process.execPath
        }
      },
      runTool: async () => {
        await fs.writeFile(path.join(dir, 'godot/validation.json'), JSON.stringify({
          valid: true,
          frames: []
        }));
        return {
          stdout: '',
          stderr: '',
          error: null,
          exitCode: 9
        };
      }
    }), /compilation failed/);
  } finally {
    await fs.rm(dir, {
      recursive: true,
      force: true
    });
  }
});
test('unsupported animation features and render budgets fail explicitly', async () => {
  const spec = createSpec({
    id: 'strip',
    description: 'synthetic',
    template: 'custom'
  });
  const clip = {
    id: 'idle',
    duration: 1,
    loop: true,
    events: [{
      id: 'hit',
      name: 'hit',
      time: 0
    }],
    tracks: []
  };
  spec.animations = [clip];
  assert.doesNotThrow(() => validateGodotSpec(spec));
  spec.sounds = [{id:'release',path:'sound.wav'}];
  clip.events = [{id:'release',type:'sound',time:0,payload:{sound:'release'}}];
  assert.doesNotThrow(() => validateGodotSpec(spec));
  clip.events = [{id:'hit',name:'hit',time:0}];
  clip.events[0].payload = {type: 'sound'};
  assert.throws(() => validateGodotSpec(spec), /Typed sound/);
  clip.events = [];
  clip.tracks = [{
    bone: 'root',
    property: 'rotation',
    keys: [{
      time: 0,
      value: 0,
      easing: 'step'
    }]
  }];
  assert.doesNotThrow(() => validateGodotSpec(spec));
  clip.tracks = [];
  spec.animations = Array.from({
    length: 33
  }, (_, i) => ({
    ...clip,
    id: 'clip' + i
  }));
  await assert.rejects(compileGodot(spec, {
    render: true
  }), /budget/);
});

test('non-rendered native compilation bounds state graph allocation before launching tools', async () => {
  const spec = createSpec({id:'bounded',description:'bounded state graph'});
  spec.animations = Array.from({length:65},(_,i)=>({id:'clip'+i,duration:1,loop:false,tracks:[],events:[]}));
  await assert.rejects(compileGodot(spec,{render:false}), /Native animation budget/);
  spec.animations.pop();
  assert.doesNotThrow(()=>validateGodotSpec(spec));
});
test('backend validates and shares immutable sound bytes before native compilation',async t=>{
  const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'pipeline-sounds-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const b=Buffer.alloc(48);b.write('RIFF');b.writeUInt32LE(40,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(4,40);
  const source=path.join(dir,'cue.wav');await fs.writeFile(source,b);
  const spec=createSpec({id:'audioFixture',description:'synthetic audio backend test'});
  spec.sounds=[{id:'one',path:source},{id:'two',path:source,volumeDb:-3}];
  spec.sounds.push({id:'unused',path:path.join(dir,'unused-library-asset.wav')});
  spec.animations=[{id:'attack',duration:1,loop:false,tracks:[],events:[{id:'one',type:'sound',time:0,payload:{sound:'one'}},{id:'two',type:'sound',time:.1,payload:{sound:'two'}}]}];
  let decoded=0;
  await compileGodot(spec,{stagingDir:dir,config:{sourceRoots:[dir],tools:{python:{executable:process.execPath},godot:{executable:process.execPath}}},runTool:async(_registry,name)=>{
    if(name==='python'){decoded++;return {exitCode:0,stdout:JSON.stringify({ok:true,audio:{format:'wav',channels:1,sampleRate:8000,frames:2,duration:0.00025,encodedBytes:48,decodedBytes:4}})};}
    const copy=JSON.parse(await fs.readFile(path.join(dir,'godot/spec.json')));
    assert.equal(copy.sounds.length,2);
    assert.equal(copy.sounds[0].path,copy.sounds[1].path);assert.match(copy.sounds[0].path,/^audio-[a-f0-9]{64}\.wav$/);
    assert.equal(copy.audioMetadata.one.frames,2);assert.equal(copy.audioMetadata.two.frames,2);
    await fs.writeFile(path.join(dir,'godot/validation.json'),JSON.stringify({valid:true,frames:[]}));return {exitCode:0,stdout:'',stderr:''};
  }});
  assert.equal(decoded,1);
});


test('backend accepts declared visual states and stages their runtime controller', async t => {
  const dir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'pipeline-states-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const spec = createSpec({id:'statesFixture',description:'explicit empty visual state'});
  spec.visualStates = [{id:'empty',parts:[]}];
  await compileGodot(spec,{stagingDir:dir,config:{godot:{executable:process.execPath}},runTool:async()=>{
    assert.match(await fs.readFile(path.join(dir,'godot/compile.gd'),'utf8'), /visual_states\.states=state_definitions/);
    assert.match(await fs.readFile(path.join(dir,'godot/visual_state_controller.gd'),'utf8'), /func set_visual_state/);
    await fs.writeFile(path.join(dir,'godot/validation.json'),JSON.stringify({valid:true,frames:[]}));
    return {exitCode:0,stdout:'',stderr:''};
  }});
  assert.deepEqual(spec.visualStates,[{id:'empty',parts:[]}]);
});

test('component compilation rejects missing verified registry before staging',async t=>{
 const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'component-preflight-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const spec=createSpec({id:'body',description:'synthetic'});
 spec.sockets=[{id:'arm',bone:'root',types:['arm'],capacity:1,transform:{position:[0,0],rotation:0,scale:[1,1]},inheritance:{position:true,rotation:true,scale:true},layer:0,envelope:[100,100]}];
 spec.components=[{id:'left',socket:'arm',type:'arm',spec:'arm.json'}];
 await assert.rejects(compileGodot(spec,{stagingDir:dir}),/verified component registry/);
 assert.deepEqual(await fs.readdir(dir),[]);
});

test('component registry stages only verified reachable runtime resources and planner frames',async t=>{
 const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'component-resources-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const child=path.join(dir,'child');await fs.mkdir(child);
 const spec=createSpec({id:'body',description:'synthetic'}),sub=createSpec({id:'arm',description:'synthetic'});
 const inheritance={position:true,rotation:true,scale:true},transform={position:[0,0],rotation:0,scale:[1,1]};
 const styleHash=require('../lib/assets').hashValue(spec.style);
 spec.sockets=[{id:'left',bone:'root',types:['arm'],capacity:1,transform:{...transform,position:[10,20]},inheritance,layer:2,envelope:[1024,1024]}];
 spec.components=[{id:'leftArm',socket:'left',type:'arm',spec:'arm.json'}];
 const descriptors=[{version:1,type:'arm',spec:'arm.json',mount:{...transform,position:[2,3]},dimensions:[512,512],styleHash,eventNames:[],layer:2,inheritance}];
 await fs.writeFile(path.join(child,'character.tscn'),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://runtime.gd" id="1"]\n[node name="Arm" type="Node2D"]\nscript = ExtResource("1")\n');
 await fs.writeFile(path.join(child,'runtime.gd'),'extends Node2D\n');await fs.writeFile(path.join(child,'private.log'),'not runtime');
 const artifacts=await Promise.all(['character.tscn','runtime.gd','private.log'].map(async file=>{const b=await fs.readFile(path.join(child,file));return {path:file,size:b.length,hash:require('node:crypto').createHash('sha256').update(b).digest('hex')};}));
 const project={project:child,scene:path.join(child,'character.tscn'),spec:sub,checkpoint:{root:child,artifacts}};
 await compileGodot(spec,{stagingDir:path.join(dir,'parent'),config:{godot:{executable:process.execPath}},componentProjects:{arm:project},componentRegistry:[{id:'arm',types:['arm']}],componentDescriptors:descriptors,assemblyContract:{styleHash,eventNames:[]},runTool:async()=>{
  const output=path.join(dir,'parent/godot');
  assert.deepEqual((await fs.readdir(path.join(output,'components/arm'))).sort(),['character.tscn','runtime.gd']);
  assert.match(await fs.readFile(path.join(output,'components/arm/character.tscn'),'utf8'),/res:\/\/components\/arm\/runtime.gd/);
  const staged=JSON.parse(await fs.readFile(path.join(output,'spec.json')));
  assert.equal(staged.assembly.previewSnapshot.revision,1);
  assert.equal(staged.assembly.previewSnapshot.sequence,0);
  assert.equal(Object.hasOwn(staged.assembly,'envelope'),false);
  assert.equal(staged.assembly.registry.sockets[0].transform.position[0],10);
  const boot=await fs.readFile(path.join(output,'assembly_boot.gd'),'utf8');
  assert.doesNotMatch(boot,/@export var (assembly_id|initial_envelope)/);
  assert.match(boot,/func bind_authoritative/);
  for(const name of ['assembly_planner.gd','state_reconciler.gd','assembly_transport.gd'])assert.ok((await fs.stat(path.join(output,name))).size>0);
  assert.equal(staged.assembly.scenes.arm,'components/arm/character.tscn');
  await fs.writeFile(path.join(output,'validation.json'),JSON.stringify({valid:true,frames:[]}));return {exitCode:0,stdout:'',stderr:''};
 }});
 const options={stagingDir:path.join(dir,'rejected'),componentProjects:{arm:project},componentRegistry:[{id:'arm',types:['arm']}],componentDescriptors:descriptors,assemblyContract:{styleHash,eventNames:[]}};
 for(const transitions of [{install:{duration:1,phases:[{id:'activate',time:0,clip:'missing'}]}},{install:{duration:11,phases:[]}}]){
  let calls=0;
  await assert.rejects(compileGodot(spec,{...options,componentDescriptors:[{...descriptors[0],transitions}],runTool:async()=>{calls++;}}),/transition|clip|duration/i);
  assert.equal(calls,0);await assert.rejects(fs.access(options.stagingDir),{code:'ENOENT'});
 }
 const overSockets=structuredClone(spec);
 overSockets.sockets=Array.from({length:65},(_,i)=>({...structuredClone(spec.sockets[0]),id:'mount'+i}));
 overSockets.components[0].socket='mount0';
 await assert.rejects(compileGodot(overSockets,options),/Native component socket budget exceeded/);
 await assert.rejects(fs.access(options.stagingDir),{code:'ENOENT'});
 const typed=structuredClone(sub);
 typed.animations=[{id:'idle',duration:1,loop:true,tracks:[],events:[{id:'uniqueCueId',type:'sound',time:0,payload:{sound:'cue'}}]}];
 const typedDir=path.join(dir,'typed');
 const unrelated=structuredClone(spec);
 unrelated.sockets.push(...Array.from({length:65},(_,i)=>({...structuredClone(spec.sockets[0]),id:'bow'+i,types:['projectile']})));
 const transitions={install:{duration:0.5,phases:[{id:'activate',time:0,clip:'idle'}]},remove:{duration:0,phases:[]}};
 await compileGodot(unrelated,{...options,stagingDir:typedDir,componentProjects:{arm:{...project,spec:typed}},componentDescriptors:[{...descriptors[0],eventNames:['sound'],transitions}],assemblyContract:{styleHash,eventNames:['sound']},config:{godot:{executable:process.execPath}},runTool:async()=>{
  const staged=JSON.parse(await fs.readFile(path.join(typedDir,'godot/spec.json')));
  assert.deepEqual(staged.assembly.descriptors[0].eventNames,['sound']);
  assert.deepEqual(staged.assembly.descriptors[0].transitions,transitions);
  assert.deepEqual(staged.assembly.registry.descriptors[0].transitions,transitions);
  assert.deepEqual(staged.assembly.sockets,['left']);
  await fs.writeFile(path.join(typedDir,'godot/validation.json'),JSON.stringify({valid:true,frames:[]}));
  return {exitCode:0,stdout:'',stderr:''};
 }});
 for(const [field,value,message]of [['capacity',0,/capacity|specification/i],['transform',{...transform,position:[1,0]},/instance transform/]]){
  const changed=structuredClone(spec);
  if(field==='capacity')changed.sockets[0].capacity=value;else changed.components[0][field]=value;
  await assert.rejects(compileGodot(changed,options),message);
 }
 for(const capacity of [2,64]){
  const accepted=structuredClone(spec);accepted.sockets[0].capacity=capacity;
  if(capacity===64){accepted.sockets[0].capacity=32;accepted.sockets.push({...structuredClone(accepted.sockets[0]),id:'right'});}
  const selectedDescriptors=structuredClone(descriptors),selectedRegistry=[{id:'arm',types:['arm']}];
  if(capacity===2){
   accepted.sockets[0].types.push('other');accepted.components.push({id:'otherArm',socket:'left',type:'other',spec:'other.json'});
   selectedDescriptors.push({...structuredClone(descriptors[0]),type:'other',spec:'other.json',mount:{...transform,position:[20,30]}});
   selectedRegistry[0].types.push('other');
  }
  const before=structuredClone(accepted),target=path.join(dir,'capacity'+capacity);
  await compileGodot(accepted,{...options,componentDescriptors:selectedDescriptors,componentRegistry:selectedRegistry,stagingDir:target,config:{godot:{executable:process.execPath}},runTool:async()=>{
   const staged=JSON.parse(await fs.readFile(path.join(target,'godot/spec.json')));
   assert.equal(staged.assembly.registry.sockets.reduce((sum,socket)=>sum+socket.capacity,0),capacity);
   assert.equal(staged.assembly.previewSnapshot.components.length,capacity===2?2:1);
   await fs.writeFile(path.join(target,'godot/validation.json'),JSON.stringify({valid:true,frames:[]}));return {exitCode:0,stdout:'',stderr:''};
  }});assert.deepEqual(accepted,before);
 }
 for(const capacities of [[64,1],[32,33],[0],[65],[1.5],['2']]){
  const rejected=structuredClone(spec);rejected.sockets=capacities.map((capacity,i)=>({...structuredClone(spec.sockets[0]),id:i?'right':'left',capacity}));
  let calls=0;await assert.rejects(compileGodot(rejected,{...options,runTool:async()=>{calls++;throw Error('unexpected tool');}}),/capacity|budget|specification/i);
  assert.equal(calls,0);await assert.rejects(fs.access(options.stagingDir),{code:'ENOENT'});
 }
 const partial=structuredClone(spec);partial.sockets[0].capacity=2;partial.sockets[0].inheritance.rotation=false;
 await assert.rejects(compileGodot(partial,options),/Partial socket inheritance/);
 const conflict=structuredClone(spec);conflict.sockets[0].capacity=2;conflict.components.push({...conflict.components[0],id:'otherArm'});
 await assert.rejects(compileGodot(conflict,options),/Conflicting component mounts/);
 await assert.rejects(fs.access(options.stagingDir),{code:'ENOENT'});
 const mismatched=structuredClone(sub);mismatched.canvas.width=500;
 await assert.rejects(compileGodot(spec,{...options,componentProjects:{arm:{...project,spec:mismatched}}}),/dimensions or style/);
 await fs.writeFile(path.join(child,'runtime.gd'),'extends Node2D\n#changed');
 await assert.rejects(compileGodot(spec,options),/verified artifact hash/);
 await assert.rejects(fs.access(options.stagingDir),{code:'ENOENT'});
});
test('effect build rejects unavailable capabilities and missing source evidence before staging',async()=>{
 const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'pipeline-effect-reject-'));
 const spec=createSpec({id:'effectFixture',description:'synthetic'});
 try{
  await assert.rejects(compileGodot(spec,{stagingDir:path.join(dir,'output'),effectBuild:{plan:{},catalog:[{id:'trail',capability:'trail'}],resources:[],targets:{}}}),/effect/i);
  await assert.rejects(fs.access(path.join(dir,'output')));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('effect compiler rejects stale or malformed captures and contracts before any writes',async()=>{
 const {fixture}=require('./godot/effect_compile_native');
 const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'pipeline-effect-contract-'));
 const mutations=[
  b=>b.styleHash='b'.repeat(64),b=>b.inventory.complete=false,b=>b.plan.characterId='other',
  b=>b.inventory.fingerprint='b'.repeat(64),b=>b.bindings=[],b=>b.resources[0].hash='b'.repeat(64),
  b=>b.resources[0].size++,b=>b.resources[0].base64+='!',b=>b.resources[0].styleProvenance='different',
  b=>b.resources[0].importSettings={mipmaps:true},b=>b.resources[0].sha256='b'.repeat(64),b=>b.resources[0].approvalProvenance='',b=>b.resources.push(structuredClone(b.resources[0])),
  b=>b.catalog[0].capability='trail',b=>b.catalog[0].presentation.color=[2,1,1,1],
  b=>b.catalog[0].resourceHashes=['b'.repeat(64)],b=>b.catalog[1].presentation.offset=[4096,4096],
  b=>b.catalog[1].presentation.scale=[1e-50,1],b=>b.catalog[1].presentation.scale=[0,1],b=>b.catalog[1].presentation.resourceHash='b'.repeat(64),
  b=>b.targets.arrow.partId='missing',b=>b.targets.unknown={partId:'panel'},
  b=>b.targets.arrow.path='Meshes/panel',b=>delete b.targets.arrow,
  b=>b.catalog.push(structuredClone(b.catalog[0])),b=>b.plan.decisions[0].rule.socketId='missing'
 ];
 try{for(let i=0;i<mutations.length;i++){
  const {spec,build}=fixture('never-read.png');mutations[i](build);const target=path.join(dir,String(i));
  await assert.rejects(compileGodot(spec,{stagingDir:target,effectBuild:build,runTool:async()=>{throw Error('native must not run');}}),/effect/i,'case '+i);
  await assert.rejects(fs.access(target),'case '+i+' wrote staging');
 }}finally{await fs.rm(dir,{recursive:true,force:true});}
});

function effectAtlasPng(){
 const chunk=(type,data)=>{const payload=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of payload){crc^=byte;for(let i=0;i<8;i++)crc=crc>>>1^(crc&1?0xedb88320:0);}const out=Buffer.alloc(payload.length+8);out.writeUInt32BE(data.length);payload.copy(out,4);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;};
 const header=Buffer.alloc(13);header.writeUInt32BE(2);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',require('node:zlib').deflateSync(Buffer.from([0,255,0,0,255,0,0,255,255]))),chunk('IEND',Buffer.alloc(0))]);
}

test('effect compiler captures independent impact atlases and requires native impact configuration evidence',async t=>{
 const {fixture,png}=require('./godot/effect_compile_native');
 const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'impact-atlas-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const image=path.join(dir,'base.png');await fs.writeFile(image,png);
 const {spec,build}=fixture(image),atlas=effectAtlasPng(),hash=require('node:crypto').createHash('sha256').update(atlas).digest('hex');
 build.resources.push({...build.resources[0],hash,base64:atlas.toString('base64'),size:atlas.length});
 build.catalog[0].resourceHashes.push(hash);
 build.catalog[0].impact={durationSeconds:.85,presentation:{resourceHash:hash,offset:[1,-3],scale:[2,2],animation:{columns:2,rows:1,frameCount:2,durations:[.1,.2],loop:false}}};
 const original=structuredClone(build);let calls=0,impactEvidence=false;
 const runTool=async(registry,name,args)=>{
  calls++;const project=args[args.indexOf('--path')+1],captured=JSON.parse(await fs.readFile(path.join(project,'spec.json')));
  assert.deepEqual(captured.effectBuild.catalog[0].impact,build.catalog[0].impact);
  assert.deepEqual(await fs.readFile(path.join(project,'effect-'+hash+'.png')),atlas);
  assert.ok((await fs.readFile(path.join(project,'impact_controller.gd'))).length);
  const effects={configured:true,gameBindings:false,owner:'visual-impact',capabilities:['overlay','tint'],resourceHashes:build.resources.map(r=>r.hash)};
  if(impactEvidence)Object.assign(effects,{impactConfigured:true,impactEffectIds:['green']});
  await fs.writeFile(path.join(project,'validation.json'),JSON.stringify({valid:true,frames:[],effects}));
  return {exitCode:0,stdout:'',stderr:''};
 };
 const options={config:{tools:{megadot:{executable:process.execPath}}},effectBuild:build,runTool};
 await assert.rejects(compileGodot(spec,{...options,stagingDir:path.join(dir,'missing-proof')}),/impact validation metadata/);
 impactEvidence=true;
 const result=await compileGodot(spec,{...options,stagingDir:path.join(dir,'accepted')});
 assert.equal(result.validation.effects.impactConfigured,true);assert.deepEqual(build,original);
 for(const [index,change]of [e=>e.impact.durationSeconds=0,e=>e.impact.durationSeconds=11,e=>e.impact.durationSeconds=NaN,e=>e.impact.extra=true,e=>e.impact.presentation.color=[1,0,0,1],e=>e.impact.presentation.resourceHash='f'.repeat(64),e=>e.impact.presentation.scale=[0,1],e=>e.impact.presentation.animation.columns=3].entries()){
  const invalid=structuredClone(build);change(invalid.catalog[0]);const stagingDir=path.join(dir,'invalid-'+index);
  await assert.rejects(compileGodot(spec,{...options,effectBuild:invalid,stagingDir}),/impact/i);
  await assert.rejects(fs.access(stagingDir));
 }
 assert.equal(calls,2);
});

test('effect compiler stages approved animation descriptors and rejects incompatible atlas geometry before writes',async t=>{
 const {fixture,png}=require('./godot/effect_compile_native');
 const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'effect-atlas-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const image=path.join(dir,'base.png');await fs.writeFile(image,png);
 const {spec,build}=fixture(image),atlas=effectAtlasPng(),hash=require('node:crypto').createHash('sha256').update(atlas).digest('hex');
 build.resources.push({...build.resources[0],hash,base64:atlas.toString('base64'),size:atlas.length});
 const overlay=build.catalog[1];overlay.resourceHashes=[hash];overlay.presentation.resourceHash=hash;
 overlay.presentation.animation={columns:2,rows:1,frameCount:2,durations:[0.1,0.1],loop:true};
 const before=structuredClone(build);let calls=0;
 const runTool=async(registry,name,args)=>{
  calls++;const project=args[args.indexOf('--path')+1],captured=JSON.parse(await fs.readFile(path.join(project,'spec.json')));
  assert.deepEqual(captured.effectBuild.catalog[1].presentation.animation,overlay.presentation.animation);
  assert.deepEqual(await fs.readFile(path.join(project,'effect-'+hash+'.png')),atlas);
  await fs.writeFile(path.join(project,'validation.json'),JSON.stringify({valid:true,frames:[],effects:{configured:true,gameBindings:false,owner:'visual-atlas',capabilities:['overlay','tint'],resourceHashes:build.resources.map(r=>r.hash)}}));
  return {exitCode:0,stdout:'',stderr:''};
 };
 await compileGodot(spec,{stagingDir:path.join(dir,'accepted'),config:{tools:{megadot:{executable:process.execPath}}},effectBuild:build,runTool});
 assert.equal(calls,1);assert.deepEqual(build,before);
 for(const [index,change]of [a=>a.columns=3,a=>{a.columns=1;a.rows=2;},a=>a.durations=[0.1],a=>a.loop=1,a=>a.extra=true].entries()){
  const bad=structuredClone(build);change(bad.catalog[1].presentation.animation);
  const target=path.join(dir,'invalid-'+index);
  await assert.rejects(compileGodot(spec,{stagingDir:target,effectBuild:bad,runTool}),/effect/i);
  await assert.rejects(fs.access(target));
 }
 assert.equal(calls,1);
});

test('effect compiler stages captured PNGs and scripts and requires truthful native contract evidence',async()=>{
 const {fixture,png}=require('./godot/effect_compile_native');
 const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'pipeline-effect-stage-'));
 const image=path.join(dir,'original.png');await fs.writeFile(image,png);
 try{
  const {spec,build}=fixture(image);let nativeMetadata;
  build.plan.evidence[0].path=path.join(dir,'private-source','Power.cs');
  build.plan.decisions[0].reason='Private review narrative: '+build.plan.evidence[0].path;
  const originalBuild=structuredClone(build);
  const runTool=async(registry,name,args)=>{
   const project=args[args.indexOf('--path')+1];
   const captured=JSON.parse(await fs.readFile(path.join(project,'spec.json')));
   assert.deepEqual(captured.effectBuild.targets,build.targets);
   assert.deepEqual(captured.effectBuild.plan,build.plan,'Full development evidence remains in the compile audit');
   assert.deepEqual(captured.effectBuild.runtimePlan,{adapterContractVersion:build.plan.adapterContractVersion,decisions:build.plan.decisions.map(({id,mechanicKey,outcome,bindingId,rule})=>({id,mechanicKey,outcome,bindingId,rule}))});
   assert(!JSON.stringify(captured.effectBuild.runtimePlan).includes('private-source'),'Runtime plan excludes local source evidence and review narrative');
   assert.deepEqual(await fs.readFile(path.join(project,'effect-'+build.resources[0].hash+'.png')),png);
   for(const script of ['effect_boot.gd','effect_scene_controller.gd','effect_rule_controller.gd','effect_controller.gd'])assert.ok((await fs.readFile(path.join(project,script))).length);
   await fs.writeFile(path.join(project,'validation.json'),JSON.stringify({valid:true,frames:[],effects:nativeMetadata}));
   return {exitCode:0,stdout:'',stderr:''};
  };
  const options={config:{tools:{megadot:{executable:process.execPath}}},effectBuild:build,runTool};
  await assert.rejects(compileGodot(spec,{...options,stagingDir:path.join(dir,'missing')}),/effect validation metadata/);
  nativeMetadata={configured:true,gameBindings:false,owner:'visual-123',capabilities:['overlay','tint'],resourceHashes:[build.resources[0].hash]};
  const compiled=await compileGodot(spec,{...options,stagingDir:path.join(dir,'accepted')});
  assert.deepEqual(compiled.validation.effects,nativeMetadata);
  assert.equal(compiled.validation.motionRegistration.status,'not-requested');
  assert.equal(compiled.validation.nativeSkinning.status,'not-requested');
  assert.deepEqual(build,originalBuild,'Runtime projection must not mutate the captured audit');
  const malformed=structuredClone(build),bad=Buffer.from(png);bad.writeUInt32BE(4097,16);
  const hash=require('node:crypto').createHash('sha256').update(bad).digest('hex'),old=malformed.resources[0].hash;
  Object.assign(malformed.resources[0],{hash,base64:bad.toString('base64'),size:bad.length});
  for(const entry of malformed.catalog)entry.resourceHashes=entry.resourceHashes.map(h=>h===old?hash:h);
  malformed.catalog[1].presentation.resourceHash=hash;
  await assert.rejects(compileGodot(spec,{...options,effectBuild:malformed,stagingDir:path.join(dir,'oversize')}),/PNG dimensions/);
  await assert.rejects(fs.access(path.join(dir,'oversize')));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});


test('render compiler uniformly fits the full canonical rectangular canvas without changing bones',async t=>{
 const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'pipeline-layout-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const spec=createSpec({id:'rectangular',description:'Synthetic rectangular preview'});
 spec.canvas.width=2048;spec.canvas.height=256;
 spec.bones[0].rest.position=[1900,128];
 const expected=planRenderViewport(spec.canvas,1);
 await compileGodot(spec,{stagingDir:dir,render:true,config:{godot:{executable:process.execPath}},runTool:async()=>{
  const project=path.join(dir,'godot'),staged=JSON.parse(await fs.readFile(path.join(project,'spec.json')));
  assert.deepEqual(staged.renderLayout,expected);
  assert.deepEqual(staged.bones,spec.bones);
  assert.match(await fs.readFile(path.join(project,'project.godot'),'utf8'),/viewport_width=512\nwindow\/size\/viewport_height=64/);
  const compiler=await fs.readFile(path.join(project,'compile.gd'),'utf8');
  assert.match(compiler,/canvas_transform = Transform2D/);
  await fs.writeFile(path.join(project,'validation.json'),JSON.stringify({valid:true,frames:[],samples:[],layerOrder:layerReceipt(spec),skinning:skinningReceipt(spec),motionPlan:null,renderLayout:expected,renderProjection:{pixels:[...expected.pixels],transform:[expected.scale,0,0,expected.scale,0,0]},geometry:{requested:true,result:{ok:true,telemetry:{version:1,thresholdVersion:'telemetry-v1',attachments:[],weights:[],triangles:[],inversionExceptions:[],loopEndpoints:[],frameJumpThresholds:[],frameJumps:[]},sourceMap:{attachments:{}},collectorCoverage:{weightVertices:0,loopJointPairs:0,restAnchors:0,scope:'static-representative-vertex-registration',uncovered:['attachments','movingAttachments','skinnedVertices','triangles','strain','frameJumps','runtimeConstraints','actionGeometry','mixerBlends','assemblyTransitions']}}}}));
  return {exitCode:0,stdout:'',stderr:''};
 }});
 assert.equal(Object.hasOwn(spec,'renderLayout'),false);
});

test('render compiler rejects missing or false native projection evidence',async t=>{
 const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'pipeline-layout-reject-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const spec=createSpec({id:'badProjection',description:'Synthetic projection contract'});
 for(const [layout,projection] of [[undefined,undefined],[planRenderViewport(spec.canvas,1),undefined],[planRenderViewport(spec.canvas,1),{pixels:[512,512],transform:[2,0,0,2,0,0]}]]){
  await assert.rejects(compileGodot(spec,{stagingDir:dir,render:true,config:{godot:{executable:process.execPath}},runTool:async()=>{
   await fs.writeFile(path.join(dir,'godot/validation.json'),JSON.stringify({valid:true,frames:[],renderLayout:layout,renderProjection:projection}));return {exitCode:0,stdout:'',stderr:''};
  }}),e=>e.code==='VISUAL_VALIDATION_FAILED'&&/projection/.test(e.message));
 }
});

test('render compiler stages bounded authored timelines and verifies every native frame and sample',async t=>{
 const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'pipeline-motion-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const spec=createSpec({id:'motion',description:'Synthetic motion sampling'});
 spec.animations=[{id:'attack',duration:1,loop:false,tracks:[{bone:'root',property:'position',keys:[{time:0,value:[0,0]},{time:.37,value:[10,0]},{time:1,value:[0,0]}]}],events:[{id:'release',name:'release',time:.41}]}];
 const {planMotionSampling}=require('../lib/motion-sampling');
 const plan=planMotionSampling(spec.animations,{framesPerSecond:16,maxFramesPerClip:64,maxTotalFrames:64});
 let corruption=null;
 const runTool=async()=>{const project=path.join(dir,'godot'),staged=JSON.parse(await fs.readFile(path.join(project,'spec.json')));assert.deepEqual(staged.motionPlan,plan);assert.deepEqual(staged.renderLayout,planRenderViewport(spec.canvas,plan.clips[0].times.length));
  const samples=plan.clips.flatMap(c=>c.times.map(time=>({clip:c.id,time,bones:{root:[time<=.37?10*time/.37:10*(1-time)/.63,0,0]}}))),frames=samples.map((s,i)=>`frame-${s.clip}-${i}.png`);
  const value={valid:true,motionPlan:plan,samples,layerOrder:layerReceipt(spec),skinning:skinningReceipt(spec,samples),frames,renderLayout:staged.renderLayout,renderProjection:{pixels:staged.renderLayout.pixels,transform:[1,0,0,1,0,0]},geometry:{requested:true,result:{ok:true,telemetry:{version:1,thresholdVersion:'telemetry-v1',attachments:[],weights:[],triangles:[],inversionExceptions:[],loopEndpoints:[],frameJumpThresholds:[],frameJumps:[]},sourceMap:{attachments:{}},collectorCoverage:{weightVertices:0,loopJointPairs:0,restAnchors:0,scope:'static-representative-vertex-registration',uncovered:['attachments','movingAttachments','skinnedVertices','triangles','strain','frameJumps','runtimeConstraints','actionGeometry','mixerBlends','assemblyTransitions']}}}};
  if(corruption==='missing-bone')delete value.samples[1].bones.root;if(corruption==='wrong-pose')value.samples[1].bones.root[0]+=3;if(corruption==='time')value.samples[1].time+=.01;if(corruption==='frames')value.frames.pop();if(corruption==='order')value.frames.reverse();if(corruption==='plan')value.motionPlan={};
  await fs.writeFile(path.join(project,'validation.json'),JSON.stringify(value));return {exitCode:0,stdout:'',stderr:''};};
 const compiled=await compileGodot(spec,{stagingDir:dir,render:true,config:{godot:{executable:process.execPath}},runTool});assert.equal(compiled.validation.motionRegistration.status,'passed');assert.equal(compiled.validation.nativeSkinning.status,'unverified');assert(compiled.frames.length>2);assert.equal(compiled.validation.samples.at(-1).time,1);assert.equal(Object.hasOwn(spec,'motionPlan'),false);
 for(corruption of ['missing-bone','wrong-pose'])await assert.rejects(compileGodot(spec,{stagingDir:dir,render:true,config:{godot:{executable:process.execPath}},runTool}),e=>e.code==='VISUAL_VALIDATION_FAILED'&&e.diagnostics.some(d=>d.code===(corruption==='wrong-pose'?'BONE_REGISTRATION_ERROR':'INVALID_NATIVE_MOTION')));
 for(corruption of ['time','frames','order','plan'])await assert.rejects(compileGodot(spec,{stagingDir:dir,render:true,config:{godot:{executable:process.execPath}},runTool}),e=>e.code==='VISUAL_VALIDATION_FAILED'&&/motion/.test(e.message));
});


test('render compiler requires native skinning evidence even for empty timelines',async t=>{
 const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'skinning-required-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const spec=createSpec({id:'skinEvidence',description:'numeric'}),layout=planRenderViewport(spec.canvas,1);
 await assert.rejects(compileGodot(spec,{stagingDir:dir,render:true,config:{godot:{executable:process.execPath}},runTool:async()=>{
  await fs.writeFile(path.join(dir,'godot/validation.json'),JSON.stringify({valid:true,frames:[],samples:[],motionPlan:null,renderLayout:layout,renderProjection:{pixels:layout.pixels,transform:[layout.scale,0,0,layout.scale,0,0]},geometry:{requested:true,result:{ok:true,telemetry:{version:1,thresholdVersion:'telemetry-v1',attachments:[],weights:[],triangles:[],inversionExceptions:[],loopEndpoints:[],frameJumpThresholds:[],frameJumps:[]},sourceMap:{attachments:{}},collectorCoverage:{weightVertices:0,loopJointPairs:0,restAnchors:0,scope:'static-representative-vertex-registration',uncovered:['attachments','movingAttachments','skinnedVertices','triangles','strain','frameJumps','runtimeConstraints','actionGeometry','mixerBlends','assemblyTransitions']}}}}));return{exitCode:0,stdout:'',stderr:''};
 }}),e=>e.code==='VISUAL_VALIDATION_FAILED'&&e.diagnostics.some(d=>d.code==='INVALID_NATIVE_SKINNING'));
});

test('rendered rest registration rejects out of range authored anchors before staging',async t=>{
 const spec=createSpec({id:'anchorBounds',description:'synthetic'});spec.bones[0].rest.position=[1000001,0];
 spec.parts=[{id:'body',role:'root',bone:'root',pivot:[0,0],layer:0,image:{path:'unused.png',prepared:true,width:1,height:1,alphaBounds:[0,0,1,1],cropTranslation:[0,0],pivot:[0,0],pixelsPerUnit:1}}];
 const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'anchor-bounds-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let launches=0;await assert.rejects(compileGodot(spec,{render:true,stagingDir:path.join(dir,'output'),runTool:async()=>{launches++;}}),{code:'CAPABILITY_MISSING'});assert.equal(launches,0);await assert.rejects(fs.access(path.join(dir,'output')));
});

test('native rest anchor payload uses affine hierarchy and rejects forged evidence',async t=>{
 const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'rest-anchors-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const texture=path.join(dir,'texture.png');await fs.writeFile(texture,'fixture');
 const spec=createSpec({id:'affineAnchor',description:'numeric'});spec.bones[0].rest={position:[10,20],rotation:Math.PI/2,scale:[-2,3]};spec.bones.push({id:'child',parent:'root',length:5,rest:{position:[2,-1],rotation:Math.PI/2,scale:[2,-1]}});
 const image={path:texture,prepared:true,width:4,height:4,alphaBounds:[0,0,4,4],cropTranslation:[0,0],pivot:[2,2],pixelsPerUnit:2};
 spec.parts=[{id:'implicit',role:'root',bone:'child',pivot:[0,0],layer:0,image},{id:'explicit',role:'root',bone:'child',pivot:[0,0],layer:1,image,mesh:{vertices:[[4,2],[4,4],[2,4]],uv:[[4,2],[4,4],[2,4]],triangles:[[0,1,2]],weights:Array.from({length:3},()=>[{bone:'child',weight:1}])}}];
 let mutation=()=>{};
 const execute=()=>compileGodot(spec,{render:true,stagingDir:dir,config:{tools:{godot:{executable:process.execPath}}},runTool:async()=>{
  const staged=JSON.parse(await fs.readFile(path.join(dir,'godot/spec.json'))),anchors=staged.nativeRestAnchors;
  // Root mirror and nonuniform scale combined with rotated child: [19,18] and [7,16].
  for(const [i,expected]of [[0,[19,18]],[1,[7,16]]])for(let k=0;k<2;k++)assert(Math.abs(anchors[i].restAnchor[k]-expected[k])<1e-12);
  const result={ok:true,telemetry:{version:1,thresholdVersion:'telemetry-v1',attachments:anchors.map((e,i)=>({id:'attachment'+i,phase:'rest',expected:[...e.restAnchor],actual:[...e.restAnchor]})),weights:Array.from({length:7},(_,i)=>({id:'weight'+i,sum:1})),triangles:[],inversionExceptions:[],loopEndpoints:[],frameJumpThresholds:[],frameJumps:[]},sourceMap:{attachments:Object.fromEntries(anchors.map((e,i)=>['attachment'+i,{meshId:e.id,path:e.path,vertex:0}]))},collectorCoverage:{restAnchors:2,scope:'static-representative-vertex-registration',weightVertices:7,loopJointPairs:0,uncovered:['attachments','movingAttachments','skinnedVertices','triangles','strain','frameJumps','runtimeConstraints','actionGeometry','mixerBlends','assemblyTransitions']}};
  mutation(result);const layout=staged.renderLayout;await fs.writeFile(path.join(dir,'godot/validation.json'),JSON.stringify({valid:true,frames:[],samples:[],layerOrder:layerReceipt(spec),skinning:skinningReceipt(spec,[],[{part:'explicit',path:'Meshes/explicit',positions:[[7,16],[7,14],[13,14]],triangles:[[0,1,2]],influences:Array.from({length:3},()=>[{bone:'child',weight:1}])}]),motionPlan:null,renderLayout:layout,renderProjection:{pixels:layout.pixels,transform:[layout.scale,0,0,layout.scale,0,0]},geometry:{requested:true,result}}));return{exitCode:0,stdout:'',stderr:''};
 }});
 assert.equal((await execute()).validation.geometry.status,'passed');
 for(const corrupt of [r=>r.telemetry.attachments.pop(),r=>r.collectorCoverage.restAnchors=1,r=>r.collectorCoverage.scope='skinned',r=>delete r.sourceMap.attachments.attachment0,r=>r.sourceMap.attachments.attachment0.vertex=1,r=>r.sourceMap.attachments.attachment0.path='Meshes/explicit',r=>r.telemetry.attachments[0].expected[0]+=1,r=>r.telemetry.attachments[0].actual=[null,0],r=>r.telemetry.attachments[0].id='forged',r=>r.telemetry.attachments[0].phase='moving',r=>r.telemetry.attachments[0].actual[0]+=2]){mutation=corrupt;await assert.rejects(execute(),{code:'VISUAL_VALIDATION_FAILED'});}
});

test('rendered backend diagnoses loaded skin matrix defects with correct bone origins',async t=>{
 const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'native-skin-matrix-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const texture=path.join(dir,'texture.png');await fs.writeFile(texture,'numeric');
 const spec=createSpec({id:'skinMatrix',description:'numeric'});
 const mesh={vertices:[[0,0],[1,0],[0,1]],uv:[[0,0],[1,0],[0,1]],triangles:[[0,1,2]],weights:Array.from({length:3},()=>[{bone:'root',weight:1}])};
 spec.parts=[{id:'panel',role:'root',bone:'root',pivot:[0,0],layer:0,image:{path:texture,prepared:true,width:1,height:1,alphaBounds:[0,0,1,1],cropTranslation:[0,0],pivot:[0,0],pixelsPerUnit:1},mesh}];
 spec.animations=[{id:'idle',duration:1,loop:false,tracks:[],events:[]}];
 const plan=require('../lib/motion-sampling').planMotionSampling(spec.animations,{framesPerSecond:16,maxFramesPerClip:64,maxTotalFrames:64});
 let corrupt=null;
 const execute=()=>compileGodot(spec,{render:true,stagingDir:dir,config:{godot:{executable:process.execPath}},runTool:async()=>{
  const staged=JSON.parse(await fs.readFile(path.join(dir,'godot/spec.json'))),layout=staged.renderLayout;
  const samples=plan.clips.flatMap(c=>c.times.map(time=>({clip:c.id,time,bones:{root:[0,0,0]}})));
  const skinning=skinningReceipt(spec,samples,spec.parts[0].mesh?[{part:'panel',path:'Meshes/panel',positions:mesh.vertices,triangles:structuredClone(mesh.triangles),influences:mesh.weights}]:[]);
  if(corrupt==='topology')skinning.meshes[0].triangles[0]=[0,2,1];
  if(corrupt==='reflection')skinning.samples[1].matrices.root[0]=-1;
  if(corrupt==='collapse')skinning.samples[1].matrices.root[0]=0;
  if(corrupt==='translation')for(const sample of skinning.samples)sample.matrices.root[4]+=8;
  if(corrupt==='matrix')skinning.samples[1].matrices.root.pop();
  const count=spec.parts[0].mesh?3:4;
  const geometry={requested:true,result:{ok:true,telemetry:{version:1,thresholdVersion:'telemetry-v1',attachments:[{id:'attachment0',phase:'rest',expected:[0,0],actual:[0,0]}],weights:Array.from({length:count},(_,i)=>({id:'weight'+i,sum:1})),triangles:[],inversionExceptions:[],loopEndpoints:[],frameJumpThresholds:[],frameJumps:[]},sourceMap:{attachments:{attachment0:{meshId:'panel',path:'Meshes/panel',vertex:0}}},collectorCoverage:{weightVertices:count,loopJointPairs:0,restAnchors:1,scope:'static-representative-vertex-registration',uncovered:['attachments','movingAttachments','skinnedVertices','triangles','strain','frameJumps','runtimeConstraints','actionGeometry','mixerBlends','assemblyTransitions']}}};
  const value={valid:true,frames:samples.map((s,i)=>`frame-${s.clip}-${i}.png`),samples,motionPlan:plan,skinning,layerOrder:layerReceipt(spec),renderLayout:layout,renderProjection:{pixels:layout.pixels,transform:[layout.scale,0,0,layout.scale,0,0]},geometry};
  if(corrupt==='missing')delete value.skinning;
  await fs.writeFile(path.join(dir,'godot/validation.json'),JSON.stringify(value));return{exitCode:0,stdout:'',stderr:''};
 }});
 const compiled=await execute();assert.equal(compiled.validation.nativeSkinning.status,'passed');assert.equal(compiled.validation.motionRegistration.status,'passed');
 for(const [mutation,code]of [['missing','INVALID_NATIVE_SKINNING'],['matrix','INVALID_NATIVE_SKINNING'],['topology','INVALID_NATIVE_SKINNING'],['reflection','NATIVE_TRIANGLE_INVERSION'],['collapse','NATIVE_TRIANGLE_COLLAPSE']]){corrupt=mutation;await assert.rejects(execute(),e=>e.code==='VISUAL_VALIDATION_FAILED'&&e.diagnostics.some(d=>d.code===code));}
 corrupt='translation';await assert.rejects(execute(),e=>{assert.equal(e.code,'VISUAL_VALIDATION_FAILED');assert(e.diagnostics.some(d=>d.code==='NATIVE_VERTEX_REGISTRATION_ERROR'&&d.measured===8&&d.limit===2));assert.equal(e.report.triangleFailureCount,0);assert(e.report.registrationFailureCount>0);return true;});
 corrupt=null;delete spec.parts[0].mesh;const implicit=await execute();assert.equal(implicit.validation.nativeSkinning.status,'partial');assert(implicit.validation.nativeSkinning.omissions.some(o=>o.reason==='implicit-mesh'));
});

function layerReceipt(spec){const flags={zIndex:0,zAsRelative:true,showBehindParent:false,topLevel:false,ySortEnabled:false};return {version:1,root:{...flags},container:{...flags},parts:spec.parts.map((p,index)=>({...flags,id:p.id,path:'Meshes/'+p.id,index,zIndex:p.layer}))};}
test('native layers preflight rejects noninteger and out of range before writes or tools',async t=>{
 const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'layers-preflight-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 for(const layer of [-4097,4097,.5,null])for(const render of [false,true]){const spec=createSpec({id:'layers',description:'numeric'});spec.parts=[layerPart('unused.png',layer)];let calls=0;const stagingDir=path.join(dir,String(layer)+render);await assert.rejects(compileGodot(spec,{render,stagingDir,runTool:async()=>{calls++;}}),/layer/);assert.equal(calls,0);await assert.rejects(fs.access(stagingDir));}
});

function layerPart(texture,layer=0,id='panel'){return {id,role:'root',bone:'root',pivot:[0,0],layer,image:{path:texture,prepared:true,width:1,height:1,alphaBounds:[0,0,1,1],cropTranslation:[0,0],pivot:[0,0],pixelsPerUnit:1}};}

test('backend captures detailed authored motion using a shared bounded frame budget',async t=>{
 const spec=createSpec({id:'sharedBudget',description:'Synthetic shared native budget'});
 const keys=Array.from({length:42},(_,i)=>({time:i/42,value:0}));
 spec.animations=[{id:'idle',duration:1,loop:false,tracks:[],events:[]},{id:'attack',duration:1,loop:false,tracks:[{bone:'root',property:'rotation',keys}],events:[]}];
 const result=await layerExecute(t,spec),plan=result.validation.motionPlan;
 assert.equal(plan.maxTotalFrames,64);assert.equal(result.frames.length,64);
 const attack=plan.clips.find(c=>c.id==='attack');assert.deepEqual(attack.omittedKeyTimes,[]);
 for(const key of keys)assert(result.validation.samples.some(s=>s.clip==='attack'&&s.time===key.time));
});

async function layerExecute(t,spec,mutate=()=>{},render=true){const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'layers-check-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));for(const p of spec.parts)p.image.path=path.join(dir,'texture.png');await fs.writeFile(path.join(dir,'texture.png'),'numeric');const original=structuredClone(spec);const result=await compileGodot(spec,{render,stagingDir:dir,config:{godot:{executable:process.execPath}},runTool:async()=>{const staged=JSON.parse(await fs.readFile(path.join(dir,'godot/spec.json'))),anchors=staged.nativeRestAnchors||[],layout=staged.renderLayout;const samples=(staged.motionPlan?.clips||[]).flatMap(c=>c.times.map(time=>({clip:c.id,time,bones:Object.fromEntries(spec.bones.map(b=>[b.id,[...b.rest.position,b.rest.rotation]]))})));const value={valid:true,frames:samples.map((s,i)=>`frame-${s.clip}-${i}.png`),samples,skinning:skinningReceipt(spec,samples),motionPlan:staged.motionPlan,layerOrder:layerReceipt(spec),renderLayout:layout,renderProjection:layout?{pixels:layout.pixels,transform:[layout.scale,0,0,layout.scale,0,0]}:null,geometry:{requested:true,result:{ok:true,telemetry:{version:1,thresholdVersion:'telemetry-v1',attachments:anchors.map((a,i)=>({id:'attachment'+i,phase:'rest',expected:a.restAnchor,actual:a.restAnchor})),weights:spec.parts.flatMap((p,n)=>Array.from({length:4},(_,i)=>({id:'weight'+(n*4+i),sum:1}))),triangles:[],inversionExceptions:[],loopEndpoints:[],frameJumpThresholds:[],frameJumps:[]},sourceMap:{attachments:Object.fromEntries(anchors.map((a,i)=>['attachment'+i,{meshId:a.id,path:a.path,vertex:0}]))},collectorCoverage:{weightVertices:spec.parts.length*4,loopJointPairs:0,restAnchors:spec.parts.length,scope:'static-representative-vertex-registration',uncovered:['attachments','movingAttachments','skinnedVertices','triangles','strain','frameJumps','runtimeConstraints','actionGeometry','mixerBlends','assemblyTransitions']}}}};const serialized=await mutate(value,staged,dir);await fs.writeFile(path.join(dir,'godot/validation.json'),typeof serialized?.literal==='string'?serialized.literal:JSON.stringify(value));return {exitCode:0,stdout:'',stderr:''};}});assert.deepEqual(spec,original);return result;}
test('native layer report binds authored boundaries, equal Z order and empty/nonrender scope',async t=>{const spec=createSpec({id:'layers',description:'numeric'});spec.parts=[layerPart('unused',-4096,'back'),layerPart('unused',4096,'front'),layerPart('unused',4096,'edge')];const result=await layerExecute(t,spec);const report=result.validation.nativeLayerOrder;assert.equal(report.status,'passed');assert.equal(report.checkedPairs,1);assert.equal(report.partCount,3);assert.equal(report.specHash,require('../lib/assets').hashValue(spec));assert.equal(report.visualQuality,'unverified');assert.equal(report.scope,'static-parent-authored-draw-order');spec.parts=[];assert.equal((await layerExecute(t,spec)).validation.nativeLayerOrder.status,'unverified');assert.equal((await layerExecute(t,spec,()=>{},false)).validation.nativeLayerOrder.status,'not-requested');});
test('native layer receipt rejects malformed whole evidence before comparisons',async t=>{const spec=createSpec({id:'layers',description:'numeric'});spec.parts=[layerPart('unused',0,'one'),layerPart('unused',0,'two')];for(const mutate of [v=>delete v.layerOrder,v=>v.layerOrder=null,v=>v.layerOrder=[],v=>v.layerOrder.parts={},v=>v.layerOrder.parts[0].index=-1,v=>v.layerOrder.parts[0].index=128,v=>v.layerOrder.parts[0].id='__proto__',v=>v.layerOrder.parts[0].extra=1,v=>v.layerOrder.root.extra=1,v=>v.layerOrder.root.zIndex=null,v=>v.layerOrder.parts[0].zAsRelative=null,v=>v.layerOrder.version=2,v=>v.layerOrder.extra=true,v=>delete v.layerOrder.root,v=>v.layerOrder.container.zAsRelative=1,v=>v.layerOrder.parts[0].zIndex=.5,v=>v.layerOrder.parts[0].path='../bad',v=>v.layerOrder.parts.push(structuredClone(v.layerOrder.parts[0])),v=>v.layerOrder.parts=Array(129).fill(v.layerOrder.parts[0]),v=>v.layerOrder.parts[1].id='one',v=>v.layerOrder.parts[1].path='x'.repeat(65536),v=>{v.layerOrder.parts[0].zIndex=1;v.layerOrder.parts[1].topLevel=null;}])await assert.rejects(layerExecute(t,spec,mutate),e=>e.code==='VISUAL_VALIDATION_FAILED'&&e.diagnostics[0].code==='INVALID_NATIVE_LAYER_EVIDENCE');});
test('native layer mismatch retains bounded report and diagnoses order and defaults',async t=>{const spec=createSpec({id:'layers',description:'numeric'});spec.parts=[layerPart('unused',0,'one'),layerPart('unused',0,'two')];for(const mutate of [v=>v.layerOrder.parts[0].zIndex=1,v=>v.layerOrder.root.zIndex=1,v=>v.layerOrder.container.zAsRelative=false,v=>v.layerOrder.parts[0].showBehindParent=true,v=>v.layerOrder.parts[0].topLevel=true,v=>v.layerOrder.parts[0].ySortEnabled=true,v=>v.layerOrder.root.ySortEnabled=true,v=>v.layerOrder.parts.reverse(),v=>v.layerOrder.parts[0].index=1,v=>v.layerOrder.parts.pop(),v=>v.layerOrder.parts.push({...v.layerOrder.parts[0],id:'extra',path:'Meshes/extra',index:2})])await assert.rejects(layerExecute(t,spec,mutate),e=>e.code==='VISUAL_VALIDATION_FAILED'&&e.report.status==='failed'&&e.diagnostics.some(d=>['NATIVE_LAYER_MISMATCH','NATIVE_PART_ORDER'].includes(d.code)));spec.parts=Array.from({length:128},(_,i)=>layerPart('unused',0,'p'+i));await assert.rejects(layerExecute(t,spec,v=>{for(const p of v.layerOrder.parts){p.zIndex=1;p.zAsRelative=false;p.showBehindParent=true;p.topLevel=true;p.ySortEnabled=true;}}),e=>e.report.failureCount===640&&e.report.failures.length===128&&e.report.failuresTruncated===true);});

test('native layer receipt rejects deeply nested primitive fields without recursive serialization',async t=>{
 const spec=createSpec({id:'deepLayers',description:'numeric'});
 for(const field of ['root','container'])await assert.rejects(layerExecute(t,spec,value=>{
  const receipt=JSON.stringify(value);
  const needle='"'+field+'":{"zIndex":0';
  assert(receipt.includes(needle));
  const literal=receipt.replace(needle,'"'+field+'":{"zIndex":'+'['.repeat(8000)+'0'+']'.repeat(8000));
  assert(Buffer.byteLength(literal)<65536);
  return {literal};
 }),error=>error.code==='VISUAL_VALIDATION_FAILED'&&error.diagnostics[0].code==='INVALID_NATIVE_LAYER_EVIDENCE');
});
test('native mask evidence rejects unsolicited captures and unsupported manifests',async t=>{
 const spec=createSpec({id:'maskReceipt',description:'numeric'});
 for(const raw of [[{}],{},null])await assert.rejects(layerExecute(t,spec,v=>{v.maskCaptures=raw;}),e=>e.code==='VISUAL_VALIDATION_FAILED'&&e.diagnostics[0].code==='INVALID_NATIVE_MASK_EVIDENCE');
 const empty=await layerExecute(t,spec,v=>{v.maskCaptures=[];});assert.deepEqual(empty.maskCaptures,[]);assert.equal(empty.maskPlan.captures.length,0);
});

test('native mask manifests bind every planned identity and actual PNG bytes',async t=>{
 const spec=createSpec({id:'maskPair',description:'numeric'});spec.parts=[layerPart('unused',0,'a'),layerPart('unused',1,'b')];for(const p of spec.parts)p.overlaps=[];spec.animations=[{id:'idle',duration:.01,loop:false,events:[],tracks:[]}];
 const seed=async(value,staged,dir)=>{value.maskCaptures=[];for(const c of staged.maskPlan.captures){const bytes=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.write('IHDR',12);bytes.writeUInt32BE(staged.renderLayout.pixels[0],16);bytes.writeUInt32BE(staged.renderLayout.pixels[1],20);await fs.writeFile(path.join(dir,'godot',c.filename),bytes);value.maskCaptures.push({id:c.id,partId:c.partId,clipId:c.clipId,time:c.time,frameIndex:c.frameIndex,path:c.filename,width:staged.renderLayout.pixels[0],height:staged.renderLayout.pixels[1],sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex')});}};
 const good=await layerExecute(t,spec,seed);assert(good.maskCaptures.length>0);assert(path.isAbsolute(good.maskCaptures[0].path));
 for(const mutation of [v=>delete v.maskCaptures,v=>v.maskCaptures.reverse(),v=>v.maskCaptures.pop(),v=>v.maskCaptures.push(v.maskCaptures[0]),v=>v.maskCaptures[0].id=99,v=>v.maskCaptures[0].partId='wrong',v=>v.maskCaptures[0].clipId='wrong',v=>v.maskCaptures[0].time=99,v=>v.maskCaptures[0].frameIndex=99,v=>v.maskCaptures[0].path='../escape.png',v=>v.maskCaptures[0].width=1,v=>v.maskCaptures[0].height=1,v=>v.maskCaptures[0].sha256='g'.repeat(64),v=>v.maskCaptures[0].sha256='0'.repeat(64),v=>v.maskCaptures[0].extra=true])await assert.rejects(layerExecute(t,spec,async(...args)=>{await seed(...args);mutation(args[0]);}),e=>e.code==='VISUAL_VALIDATION_FAILED'&&e.diagnostics[0].code==='INVALID_NATIVE_MASK_EVIDENCE');
});

test('pose drawing compilation stages the shared selection runtime before scene readiness',async t=>{
 const dir=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'pipeline-poses-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const spec=createSpec({id:'poseFixture',description:'synthetic pose compilation'});
 await compileGodot(spec,{stagingDir:dir,config:{godot:{executable:process.execPath}},runTool:async()=>{
  const project=path.join(dir,'godot'),compiler=await fs.readFile(path.join(project,'compile.gd'),'utf8');
  assert.ok((await fs.readFile(path.join(project,'pose_controller.gd'))).length);
  assert.match(compiler,/pose_controller\.pose_groups\s*=\s*spec\.get\("poseGroups",\[\]\)/);
  assert.match(compiler,/"poseTracks":clip\.get\("poseTracks",\[\]\)/);
  assert.match(compiler,/pose_controller\.part_paths\s*=\s*part_paths\.duplicate\(\)/);
  assert.match(compiler,/apply_pose\(clip\.id,time\)/);
  assert.match(compiler,/nodes\[index\]\.visible = keep\.has\(nodes\[index\]\)/);
  await fs.writeFile(path.join(project,'validation.json'),JSON.stringify({valid:true,frames:[]}));return{exitCode:0,stdout:'',stderr:''};
 }});
});
