'use strict';

const {
  test
} = require('node:test');
const assert = require('node:assert/strict');
const {
  createSpec,
  validateSpec,
  assertSpec,
  applyPatch
} = require('../lib/spec');
test('animation blend duration is optional, bounded and finite',()=>{
 const spec=createSpec({id:'blendActor',description:'synthetic blend contract'});
 spec.animations=[{id:'idle',duration:1,loop:true,tracks:[],events:[]}];assert.equal(validateSpec(spec).valid,true);
 for(const blendIn of [0,0.25,10]){spec.animations[0].blendIn=blendIn;assert.equal(validateSpec(spec).valid,true);}
 for(const blendIn of [-0.01,10.01,Infinity,NaN,'0.2']){spec.animations[0].blendIn=blendIn;assert.equal(validateSpec(spec).valid,false);}
});
test('spec rejects rest rotations outside absolute limits while accepting boundaries', () => {
  const spec=createSpec({id:'character',description:'character'});
  spec.bones[0].limits=[-1,1];
  for (const rotation of [-1,1]) {spec.bones[0].rest.rotation=rotation; assert.equal(validateSpec(spec).valid,true);}
  for (const rotation of [-1.01,1.01]) {spec.bones[0].rest.rotation=rotation; assert.equal(validateSpec(spec).valid,false);}
});
test('built-in specs bind real reusable anatomy while custom stays editable', () => {
  for (const template of ['humanoid', 'mechanical', 'quadruped_or_multilimb']) {
    const spec = createSpec({id:'character',description:'character',template});
    assert.ok(spec.bones.length > 5);
    assert.ok(spec.anatomy.roles.torso);
    assert.equal(spec.anatomy.template, template);
    assert.equal(validateSpec(spec).valid, true);
    spec.bones[0].rest.position[0] = -999;
    assert.notEqual(createSpec({id:'character',description:'character',template}).bones[0].rest.position[0], -999);
  }
  assert.equal(createSpec({id:'character',description:'character'}).bones.length, 1);
});
test('procedural skinning validates bounds, flags and actual bone bindings', () => {
  const spec = createSpec({id:'character',description:'character'});
  spec.bones.push({id:'tip',parent:'root',rest:{position:[0,1],rotation:0,scale:[1,1]},length:1});
  spec.parts.push({id:'limb',role:'limb',bone:'root',pivot:[0,0],layer:0,skinning:{bones:['root','tip'],axis:'y',segments:15,pinStart:false,pinEnd:true}});
  assert.equal(validateSpec(spec).valid, true);
  for (const patch of [{bones:[]},{bones:['root','root']},{bones:['root','missing']},{bones:['tip']},{bones:['root','tip','a','b','c']},{axis:'z'},{segments:0},{segments:16},{segments:1.5},{pinStart:1},{pinEnd:'yes'},{unknown:true}]) {
    const changed=structuredClone(spec);
    Object.assign(changed.parts[0].skinning,patch);
    assert.equal(validateSpec(changed).valid,false,JSON.stringify(patch));
  }
  const missing=structuredClone(spec); delete missing.parts[0].skinning.axis;
  assert.equal(validateSpec(missing).valid,false);
});
test('artwork background removal is an explicit validated option', () => {
  const spec = createSpec({
    id: 'robot',
    description: 'robot',
    template: 'custom'
  });
  spec.artwork.settings = {
    backgroundRemoval: true
  };
  assert.equal(validateSpec(spec).valid, true);
  spec.artwork.settings.backgroundRemoval = 'download-an-arbitrary-model';
  assert.equal(validateSpec(spec).valid, false);
});
test('templates produce editable canonical specs without generating artwork', () => {
  for (const template of ['humanoid', 'mechanical', 'custom']) {
    const s = createSpec({
      id: 'robot',
      description: 'blue robot',
      template
    });
    assert.equal(s.description, 'blue robot');
    assert.equal(s.canvas.yAxis, 'down');
    assert.equal(validateSpec(s).valid, true);
    assert.notEqual(assertSpec(s), s);
  }
});
test('merge patch validates, increments revision, and preserves original', () => {
  const s = createSpec({
    id: 'robot',
    description: 'robot',
    template: 'mechanical'
  });
  const edited = applyPatch(s, {
    description: 'new',
    revision: 99
  });
  assert.equal(edited.revision, 2);
  assert.equal(s.description, 'robot');
  assert.throws(() => applyPatch(s, {
    bones: null
  }), {
    code: 'INVALID_SPEC'
  });
  assert.throws(() => createSpec({
    id: 'x',
    description: 'x',
    template: 'unknown'
  }), {
    code: 'INVALID_SPEC'
  });
});
test('rejects malformed members, unsafe keys, numeric values, versions and unknown fields', () => {
  const base = createSpec({
    id: 'robot',
    description: 'robot',
    template: 'custom'
  });
  for (const patch of [{
    version: 2
  }, {
    id: '../bad'
  }, {
    canvas: {
      width: NaN
    }
  }, {
    parts: [{}]
  }, {
    bones: [{}]
  }, {
    animations: [{}]
  }, {
    sockets: [{}]
  }, {
    components: [{}]
  }, {
    visualStates: [{}]
  }, {
    artwork: {
      provider: 'shell'
    }
  }, {
    command: 'evil'
  }, {
    style: {
      script: 'evil'
    }
  }]) {
    assert.equal(validateSpec({
      ...base,
      ...patch
    }).valid, false, JSON.stringify(patch));
  }
  assert.equal(validateSpec(JSON.parse('{"__proto__":{}}')).valid, false);
  for (const bad of [null, [], undefined, 42]) assert.equal(validateSpec(bad).valid, false);
});
test('validates references, topology, meshes and animation tracks', () => {
  const s = createSpec({
    id: 'robot',
    description: 'robot',
    template: 'mechanical'
  });
  s.parts = [{
    id: 'body',
    role: 'body',
    bone: 'root',
    pivot: [0, 0],
    layer: 0,
    mesh: {
      vertices: [[0, 0], [1, 0], [0, 1]],
      uv: [[0, 0], [1, 0], [0, 1]],
      triangles: [[0, 1, 2]],
      weights: [[{
        bone: 'root',
        weight: 1
      }], [{
        bone: 'root',
        weight: 1
      }], [{
        bone: 'root',
        weight: 1
      }]]
    }
  }];
  s.animations = [{
    id: 'idle',
    duration: 1,
    loop: true,
    tracks: [{
      bone: 'root',
      property: 'rotation',
      keys: [{
        time: 0,
        value: 0
      }, {
        time: 1,
        value: 0
      }]
    }],
    events: []
  }];
  assert.equal(validateSpec(s).valid, true);
  const bad = fn => {
    const x = structuredClone(s);
    fn(x);
    assert.equal(validateSpec(x).valid, false);
  };
  bad(x => x.bones.push({
    ...x.bones[0]
  }));
  bad(x => x.bones[0].parent = 'root');
  bad(x => x.parts[0].bone = 'missing');
  bad(x => x.parts[0].mesh.weights[0][0].weight = .5);
  bad(x => x.parts[0].mesh.triangles[0][2] = 20);
  bad(x => x.parts[0].mesh.uv.pop());
  bad(x => x.animations[0].tracks[0].keys[1].time = -1);
  bad(x => x.animations[0].tracks[0].bone = 'absent');
  bad(x => x.bones[0].limits = [2, 1]);
  bad(x => x.bones[0].length = 0);
});
test('socket capacity, references, inheritance, states and explicit template expansion', () => {
  const s = createSpec({
    id: 'r',
    description: 'r',
    template: {
      style: {
        palette: ['blue']
      }
    }
  });
  s.sockets = [{
    id: 'mount',
    bone: 'root',
    transform: {
      position: [0, 0],
      rotation: 0,
      scale: [-1, 1]
    },
    types: ['arm'],
    capacity: 1,
    inheritance: {
      position: true,
      rotation: true,
      scale: false
    }
  }];
  s.components = [{
    id: 'arm1',
    socket: 'mount',
    type: 'arm',
    spec: 'arm.json',
    transform: {
      position: [0, 0],
      rotation: 0,
      scale: [1, 1]
    }
  }];
  s.visualStates = [{
    id: 'idle',
    parts: []
  }];
  s.references = [{
    id: 'ref',
    path: 'ref.png'
  }];
  s.artwork = {
    provider: 'comfyui',
    referenceIds: ['ref'],
    settings: {
      steps: 20,
      cfg: 5,
      denoise: .7
    }
  };
  assert.equal(validateSpec(s).valid, true);
  const bad = fn => {
    const x = structuredClone(s);
    fn(x);
    assert.equal(validateSpec(x).valid, false);
  };
  bad(x => x.components.push({
    ...x.components[0],
    id: 'arm2'
  }));
  bad(x => x.components[0].type = 'leg');
  bad(x => x.components[0].socket = 'missing');
  bad(x => x.components[0].transform.scale = [0, 1]);
  bad(x => x.sockets[0].transform.scale = [1, 0]);
  bad(x => x.sockets[0].bone = 'missing');
  bad(x => x.visualStates[0].parts = ['missing']);
  bad(x => x.artwork.referenceIds = ['missing']);
  assert.throws(() => applyPatch(s, JSON.parse('{"constructor":{}}')), {
    code: 'INVALID_SPEC'
  });
  assert.throws(() => applyPatch(s, null), {
    code: 'INVALID_SPEC'
  });
});
test('nested schema constraints and collection diagnostics', () => {
  const s = createSpec({
    id: 'r',
    description: 'r'
  });
  const bad = fn => {
    const x = structuredClone(s);
    fn(x);
    assert.equal(validateSpec(x).valid, false);
  };
  bad(x => x.style.palette = [2]);
  bad(x => x.style.proportions = {
    head: Infinity
  });
  bad(x => x.bones[0].rest.position = [1]);
  bad(x => x.bones[0].rest.scale = [0, 1]);
  bad(x => x.bones[0].parent = 'missing');
  bad(x => x.description = '');
  bad(x => x.id = 'x'.repeat(65));
  bad(x => x.version = 1.5);
  bad(x => x.references = [{
    id: 'same',
    path: 'a'
  }, {
    id: 'same',
    path: 'b'
  }]);
  for (const value of [NaN, [0], [0, 'x'], {}, null]) bad(x => x.animations = [{
    id: 'a',
    duration: 1,
    loop: false,
    tracks: [{
      bone: 'root',
      property: 'rotation',
      keys: [{
        time: 0,
        value
      }]
    }],
    events: []
  }]);
  bad(x => x.animations = [{
    id: 'a',
    duration: 1,
    loop: false,
    tracks: [{
      bone: 'root',
      property: 'position',
      keys: [{
        time: 0,
        value: [0, 'x']
      }]
    }],
    events: []
  }]);
  bad(x => x.animations = [{
    id: 'a',
    duration: 1,
    loop: false,
    tracks: [],
    events: [{
      id: 'x',
      name: 'x',
      time: 1
    }, {
      id: 'x',
      name: 'x',
      time: 0
    }]
  }]);
});
test('raw images are enriched later while prepared images require consistent registration', () => {
  const s = createSpec({
    id: 'images',
    description: 'image boundary'
  });
  s.parts = [{
    id: 'body',
    role: 'body',
    bone: 'root',
    pivot: [0, 0],
    layer: 0,
    image: {
      path: 'body.png'
    }
  }];
  assert.equal(validateSpec(s).valid, true);
  const image = {
    path: 'body.png',
    prepared: true,
    width: 10,
    height: 10,
    alphaBounds: [0, 0, 10, 10],
    cropTranslation: [0, 0],
    pivot: [5, 5],
    pixelsPerUnit: 1
  };
  s.parts[0].image = image;
  assert.equal(validateSpec(s).valid, true);
  for (const bounds of [[9, 9, 1, 1], [-1, 0, 9, 10], [0, 0, 11, 10], [0, 0, 10, 11], [0, 0, 0, 10], [0, 10, 10, 10]]) {
    s.parts[0].image = {
      ...image,
      prepared: false,
      alphaBounds: bounds
    };
    assert.equal(validateSpec(s).valid, false, JSON.stringify(bounds));
  }
  for (const key of ['width', 'height', 'alphaBounds', 'cropTranslation', 'pivot', 'pixelsPerUnit']) {
    const partial = {
      ...image
    };
    delete partial[key];
    s.parts[0].image = partial;
    assert.equal(validateSpec(s).valid, false, key);
  }
  s.parts[0].image = {
    path: 'raw.png',
    alphaBounds: [0, 0, 1, 1]
  };
  assert.equal(validateSpec(s).valid, false);
  s.parts[0].image = {
    ...image,
    pixelsPerUnit: 0
  };
  assert.equal(validateSpec(s).valid, false);
  s.parts[0].image = {
    ...image,
    cropTranslation: [Infinity, 0]
  };
  assert.equal(validateSpec(s).valid, false);
  s.parts[0].image = {
    path: 'raw.png',
    prepared: false
  };
  s.parts[0].mask = {
    ...image,
    path: 'mask.png'
  };
  assert.equal(validateSpec(s).valid, true);
});

test('optional sound assets and typed cues preserve legacy markers and validate strict contracts', () => {
  const base = createSpec({id:'sound_character', description:'sound contract'});
  delete base.sounds;
  assert.equal(validateSpec(base).valid, true);
  base.sounds = [{id:'twang',path:'audio/twang.ogg',volumeDb:-80,pitch:.25}];
  base.animations = [{id:'attack',duration:1,loop:false,tracks:[],events:[
    {id:'cue',type:'sound',time:0,payload:{sound:'twang',volumeDb:6,pitch:4,tail:'finish'}},
    {id:'marker',name:'impact',time:1,payload:{detail:'legacy'}}
  ]}];
  assert.equal(validateSpec(base).valid,true);
  const bad = change => {const copy=structuredClone(base);change(copy);assert.equal(validateSpec(copy).valid,false);};
  for (const asset of [{id:'twang',path:''},{id:'twang',path:'a',volumeDb:-81},{id:'twang',path:'a',volumeDb:7},{id:'twang',path:'a',pitch:.24},{id:'twang',path:'a',pitch:4.01},{id:'twang',path:'a',pitch:NaN},{id:'twang',path:'a',unknown:true}]) bad(s=>s.sounds=[asset]);
  bad(s=>s.sounds.push({...s.sounds[0]}));
  bad(s=>s.sounds=Array.from({length:1001},(_,i)=>({id:'sound_'+i,path:'a'})));
  bad(s=>delete s.sounds);
  for (const payload of [{sound:'missing'},{sound:'twang',tail:'loop'},{sound:'twang',volumeDb:Infinity},{sound:'twang',pitch:0},{sound:'twang',extra:true},{},JSON.parse('{"sound":"twang","constructor":{}}')]) bad(s=>s.animations[0].events[0].payload=payload);
  for (const change of [e=>e.time=1,e=>e.time=-1,e=>e.time=NaN,e=>e.type='music',e=>e.name='ambiguous',e=>delete e.payload,e=>e.extra=true]) bad(s=>change(s.animations[0].events[0]));
  bad(s=>s.animations[0].events.push({...s.animations[0].events[0]}));
  bad(s=>s.animations[0].events.reverse());
  const defaults=structuredClone(base); defaults.sounds=[{id:'twang',path:'a.wav'}];defaults.animations[0].events[0].payload={sound:'twang',tail:'stop'};
  assert.equal(validateSpec(defaults).valid,true);
});

test('generic polyline and projectile contracts resolve references and bound release events', () => {
  const s=createSpec({id:'archer',description:'synthetic bow contract'});
  s.parts=[{id:'arrow',role:'projectile',bone:'root',pivot:[0,0],layer:0}];
  s.sockets=[{id:'nock',bone:'root',transform:{position:[0,0],rotation:0,scale:[1,1]},types:['arrow'],capacity:1,inheritance:{position:true,rotation:true,scale:true}}];
  s.polylines=[{id:'string',anchors:[{bone:'root',position:[0,0]},{bone:'root',position:[0,10]}],width:.1,color:[0,1,.5,1],layer:-4096}];
  s.projectiles=[{id:'shot',part:'arrow',forward:[1,0],flightDuration:.25,lifetime:10,removalPolicy:'finish'}];
  s.animations=[{id:'attack',duration:1,loop:false,tracks:[],events:[{id:'release',type:'projectile',time:0,payload:{projectile:'shot',sourceSocket:'nock',nockedPart:'arrow'}}]}];
  assert.equal(validateSpec(s).valid,true);
  const bad=change=>{const copy=structuredClone(s);change(copy);assert.equal(validateSpec(copy).valid,false);};
  for (const patch of [{anchors:[]},{anchors:[{bone:'root',position:[0,0]}]},{anchors:Array.from({length:33},()=>({bone:'root',position:[0,0]}))},{anchors:[{bone:'absent',position:[0,0]},{bone:'root',position:[0,1]}]},{anchors:[{bone:'root',position:[0,NaN]},{bone:'root',position:[0,1]}]},{width:0},{width:64.1},{color:[1,1,1]},{color:[1,1,1,1.1]},{layer:4097},{layer:1.5},{script:'bad'}]) bad(c=>Object.assign(c.polylines[0],patch));
  for (const patch of [{part:'absent'},{forward:[0,0]},{forward:[1]},{forward:[NaN,1]},{flightDuration:0},{flightDuration:10.1},{flightDuration:2,lifetime:1},{lifetime:0},{lifetime:10.1},{removalPolicy:'linger'},{command:'bad'}]) bad(c=>Object.assign(c.projectiles[0],patch));
  for (const payload of [{projectile:'absent',sourceSocket:'nock'},{projectile:'shot',sourceSocket:'absent'},{projectile:'shot',sourceSocket:'nock',nockedPart:'absent'},{projectile:'shot'},{projectile:'shot',sourceSocket:'nock',target:'arbitrary/path'}]) bad(c=>c.animations[0].events[0].payload=payload);
  bad(c=>c.animations[0].events[0].time=1);
  bad(c=>c.projectiles.push({...c.projectiles[0]}));bad(c=>c.polylines.push({...c.polylines[0]}));
  for (const collection of ['polylines','projectiles']) bad(c=>c[collection]=Array.from({length:257},(_,i)=>({...c[collection][0],id:'item_'+i})));
  const minimal=structuredClone(s);delete minimal.projectiles[0].removalPolicy;delete minimal.animations[0].events[0].payload.nockedPart;
  minimal.polylines[0].width=64;minimal.polylines[0].layer=4096;minimal.projectiles[0].flightDuration=10;
  assert.equal(validateSpec(minimal).valid,true);
  minimal.projectiles[0].flightDuration=Number.MIN_VALUE;minimal.projectiles[0].lifetime=Number.MIN_VALUE;
  assert.equal(validateSpec(minimal).valid,true);
});

test('projectile impact sound is an optional declared sound reference', () => {
  const s=createSpec({id:'impact',description:'impact sound binding'});
  s.parts=[{id:'arrow',role:'projectile',bone:'root',pivot:[0,0],layer:0}];
  s.sounds=[{id:'hit',path:'hit.ogg'}];
  s.projectiles=[{id:'shot',part:'arrow',forward:[1,0],flightDuration:.2,lifetime:1,impactSound:'hit'}];
  assert.equal(validateSpec(s).valid,true);
  s.projectiles[0].impactSound='missing';
  assert.equal(validateSpec(s).valid,false);
  delete s.projectiles[0].impactSound;
  assert.equal(validateSpec(s).valid,true);
});

test('explicit assembly descriptors validate mount frames and parent style without guessing pivots', () => {
  const {hashValue}=require('../lib/assets');
  const s=createSpec({id:'assemblyFixture',description:'explicit component mounts'});
  const inheritance={position:true,rotation:true,scale:true};
  const transform={position:[0,0],rotation:0,scale:[1,1]};
  s.sockets=[{id:'armSocket',bone:'root',transform,types:['arm'],capacity:1,inheritance,layer:2,envelope:[100,100]}];
  s.components=[{id:'armInstance',socket:'armSocket',type:'arm',spec:'parts/arm.json'}];
  const styleHash=hashValue(s.style);
  s.assembly={version:1,styleHash,eventNames:['release'],descriptors:[{version:1,type:'arm',spec:'parts/arm.json',mount:{...transform,position:[10,20]},dimensions:[40,50],styleHash,eventNames:['release'],layer:2,inheritance}]};
  assert.equal(validateSpec(s).valid,true);
  const bad=change=>{const c=structuredClone(s);change(c);assert.equal(validateSpec(c).valid,false);};
  bad(c=>delete c.assembly.descriptors[0].mount);
  bad(c=>c.assembly.styleHash='0'.repeat(64));
  bad(c=>c.assembly.descriptors[0].mount.scale=[0,1]);
  bad(c=>c.assembly.descriptors.push(structuredClone(c.assembly.descriptors[0])));
  bad(c=>c.assembly.descriptors[0].type='missing');
  bad(c=>c.assembly.descriptors[0].spec='../outside.json');
  bad(c=>c.assembly.descriptors[0].eventNames=['unsupported']);
  bad(c=>c.assembly.descriptors=[]);
  bad(c=>c.assembly.command='execute');
});

test('assembly transition profiles are optional schema metadata with ordered finite phases',()=>{
 const {hashValue}=require('../lib/assets'),s=createSpec({id:'phases',description:'numeric transition contract'});
 const inheritance={position:true,rotation:true,scale:true},transform={position:[0,0],rotation:0,scale:[1,1]},styleHash=hashValue(s.style);
 s.sockets=[{id:'mount',bone:'root',transform,types:['arm'],capacity:1,inheritance,layer:0,envelope:[100,100]}];
 s.assembly={version:1,styleHash,eventNames:[],descriptors:[{version:1,type:'arm',spec:'arm.json',mount:transform,dimensions:[20,20],styleHash,eventNames:[],layer:0,inheritance}]};
 assert.equal(validateSpec(s).valid,true);
 const d=s.assembly.descriptors[0];d.transitions={install:{duration:10,phases:[{id:'one',time:0,clip:'activation'},{id:'two',time:10},{id:'three',time:10}]},remove:{duration:0,phases:[]}};
 assert.equal(validateSpec(s).valid,true);
 for(const change of [p=>p.install.duration=NaN,p=>p.install.duration=Infinity,p=>p.install.duration=-1,p=>p.install.duration=10.01,p=>p.install.extra=1,p=>p.install.phases[1].time=-1,p=>p.install.phases[1].time=11,p=>p.install.phases[1].id='one',p=>p.install.phases[0].clip='../bad',p=>p.install.phases[0].extra=1,p=>p.install.phases.reverse(),p=>p.unknown={duration:0,phases:[]}]){const c=structuredClone(s);change(c.assembly.descriptors[0].transitions);assert.equal(validateSpec(c).valid,false);}
});

test('required surface mask is a strict bounded path declaration',()=>{
 const spec=createSpec({id:'coverageActor',description:'surface coverage',template:'humanoid'});
 spec.parts=[{id:'body',role:'body',bone:spec.bones[0].id,pivot:[0,0],layer:0,requiredSurfaceMask:{path:'body-required.png'}}];
 assert.equal(validateSpec(spec).valid,true);
 for(const declaration of [{path:''},{path:'x',tolerance:1},{path:42},{}]){
 spec.parts[0].requiredSurfaceMask=declaration;assert.equal(validateSpec(spec).valid,false);
 }
});
