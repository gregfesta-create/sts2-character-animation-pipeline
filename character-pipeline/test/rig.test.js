'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  bindRig,
  skinPart,
  fitRig
} = require('../lib/rig');
const {createSpec}=require('../lib/spec');
const {hashValue}=require('../lib/assets');
function fitRequest(spec, points) {return {version:1,sourceSpecHash:hashValue(spec),bones:spec.bones.map(b=>({id:b.id,...(points?.[b.id]||{start:[0,0],end:[1,0]})}))};}
test('landmark fitting reconstructs unordered asymmetric branches and preserves specification identity',()=>{
 const spec=createSpec({id:'landmarks',description:'Explicit landmarks',template:'custom'});
 spec.bones=[{id:'child',parent:'root',rest:{position:[4,5],rotation:6.2,scale:[2,3]},length:2,limits:[5.2,6.7]},{id:'other',parent:null,rest:{position:[2,3],rotation:-0.2,scale:[4,2]},length:5},{id:'root',parent:null,rest:{position:[0,0],rotation:0,scale:[2,2]},length:4},{id:'branch',parent:'root',rest:{position:[3,1],rotation:0,scale:[1,1]},length:2}];
 const req=fitRequest(spec,{root:{start:[20,30],end:[20,40]},child:{start:[18,37],end:[8,37]},branch:{start:[22,38],end:[25,42]},other:{start:[-5,7],end:[0,2]}}),before=structuredClone(spec),requestBefore=structuredClone(req),out=fitRig(spec,req),frames=new Map();
 function frame(b){if(frames.has(b.id))return frames.get(b.id);const p=b.parent===null?{x:0,y:0,a:0}:frame(out.bones.find(x=>x.id===b.parent)),c=Math.cos(p.a),s=Math.sin(p.a),f={x:p.x+c*b.rest.position[0]-s*b.rest.position[1],y:p.y+s*b.rest.position[0]+c*b.rest.position[1],a:p.a+b.rest.rotation};frames.set(b.id,f);return f;}
 for(const b of out.bones){const f=frame(b),r=req.bones.find(x=>x.id===b.id);assert.ok(Math.hypot(f.x-r.start[0],f.y-r.start[1])<1e-6);assert.ok(Math.hypot(f.x+Math.cos(f.a)*b.length-r.end[0],f.y+Math.sin(f.a)*b.length-r.end[1])<1e-6);assert.deepEqual(b.rest.scale,[1,1]);}
 const child=out.bones[0];assert.ok(Math.abs(child.rest.rotation-6.2)<Math.PI);assert.ok(Math.abs(child.rest.rotation-child.limits[0]-1)<1e-9);assert.ok(Math.abs(child.limits[1]-child.rest.rotation-0.5)<1e-9);
 assert.equal(out.revision,spec.revision+1);for(const k of ['anatomy','canvas','artwork','references','style','id'])assert.deepEqual(out[k],spec[k]);assert.deepEqual(spec,before);assert.deepEqual(req,requestBefore);
});
test('landmark fitting rejects stale, incomplete, unsafe and dependent data before evaluating accessors',()=>{
 const spec=createSpec({id:'landmarks',description:'Explicit landmarks'}),valid=fitRequest(spec);
 const rejects=[{...valid,sourceSpecHash:'0'.repeat(64)},{...valid,bones:[]},{...valid,bones:[...valid.bones,valid.bones[0]]},{...valid,bones:[{id:'unknown',start:[0,0],end:[1,0]}]},{...valid,bones:[{id:'root',start:[0,0],end:[0,0]}]},{...valid,bones:[{id:'root',start:[0,0],end:[1000001,0]}]},{...valid,bones:[{id:'root',start:[0,0],end:[Infinity,0]}]},{...valid,extra:true}];
 for(const r of rejects)assert.throws(()=>fitRig(spec,r),{code:'INVALID_RIG'});
 for(const key of ['parts','animations','sockets','components','visualStates','polylines','projectiles']){const s=structuredClone(spec);s[key]=[{}];assert.throws(()=>fitRig(s,fitRequest(s)),{code:'INVALID_RIG'});}
 let calls=0;for(const base of [spec,valid]){const bad={...base};Object.defineProperty(bad,'trap',{get(){calls++;throw Error('getter');},enumerable:true});assert.throws(()=>fitRig(base===spec?bad:spec,base===valid?bad:valid),{code:'INVALID_RIG'});}assert.equal(calls,0);
 const cyclic={...valid};cyclic.loop=cyclic;assert.throws(()=>fitRig(spec,cyclic),{code:'INVALID_RIG'});assert.throws(()=>fitRig(spec,{...valid,bones:new Array(100000)}),{code:'INVALID_RIG'});
});
test('landmark fitting rejects finite but numerically unrepresentable rotations and limit slack',()=>{
 for(const rotation of [1e30,Number.MAX_VALUE]){const s=createSpec({id:'precision',description:'Precision'});s.bones[0].rest.rotation=rotation;assert.throws(()=>fitRig(s,fitRequest(s,{root:{start:[0,0],end:[0,1]}})),e=>e.code==='INVALID_RIG'&&/precision/i.test(e.message));}
 const s=createSpec({id:'precision',description:'Precision'});s.bones[0].rest.rotation=1e8;s.bones[0].limits=[1e8-0.1,1e8+0.2];assert.throws(()=>fitRig(s,fitRequest(s,{root:{start:[0,0],end:[0,1]}})),{code:'INVALID_RIG'});
});
test('landmark fitting wraps both parent and child near prior angles and accepts bounded extreme points',()=>{
 const s=createSpec({id:'wrap',description:'Wrapped parent frames'});s.bones=[{id:'child',parent:'root',rest:{position:[0,0],rotation:-6.2,scale:[3,2]},length:1,limits:[-7.2,-5.7]},{id:'root',parent:null,rest:{position:[0,0],rotation:2*Math.PI-0.1,scale:[5,2]},length:1,limits:[5,9]}];
 const out=fitRig(s,fitRequest(s,{root:{start:[10,20],end:[10,30]},child:{start:[15,22],end:[19,22]}}));assert.ok(Math.abs(out.bones[1].rest.rotation-2.5*Math.PI)<1e-12);assert.ok(Math.abs(out.bones[0].rest.rotation+2.5*Math.PI)<1e-12);assert.ok(Math.abs(out.bones[0].rest.position[0]-2)<1e-12);assert.ok(Math.abs(out.bones[0].rest.position[1]+5)<1e-12);
 const plain=createSpec({id:'edge',description:'Bounded points'});plain.bones[0].rest.scale=[-2,3];assert.equal(fitRig(plain,fitRequest(plain,{root:{start:[-1000000,-1000000],end:[1000000,1000000]}})).bones[0].length,Math.hypot(2000000,2000000));
 for(const bad of [Object.assign(Object.create({}),fitRequest(plain)),{...fitRequest(plain),extra:undefined},{...fitRequest(plain),extra:'x'.repeat(8*1024*1024+1)}])assert.throws(()=>fitRig(plain,bad),{code:'INVALID_RIG'});
 const deep=fitRequest(plain);let node=deep;for(let i=0;i<65;i++)node=node.next={};assert.throws(()=>fitRig(plain,deep),{code:'INVALID_RIG'});
 const assembly={...plain,assembly:{descriptors:[]}};assert.throws(()=>fitRig(assembly,fitRequest(assembly)),{code:'INVALID_RIG'});
});
test('every built-in rest pose is inside its absolute joint limits and custom poses obey them', () => {
  for (const name of ['humanoid','mechanical','quadruped_or_multilimb']) {
    for (const bone of bindRig(name).bones) {
      if (bone.limits) assert.ok(bone.rest.rotation >= bone.limits[0] && bone.rest.rotation <= bone.limits[1], `${name}/${bone.id}`);
    }
  }
  const bone={id:'root',parent:null,length:1,rest:{position:[0,0],rotation:2,scale:[1,1]},limits:[-1,1]};
  assert.throws(()=>bindRig('custom',{bones:[bone],roles:{root:'root'}}),{code:'INVALID_RIG'});
  for (const rotation of [-1,1]) assert.equal(bindRig('custom',{bones:[{...bone,rest:{...bone.rest,rotation}}],roles:{root:'root'}}).bones[0].rest.rotation,rotation);
});
test('built-in rigs contain articulated independent limbs and return isolated scaled data', () => {
  for (const name of ['humanoid', 'mechanical', 'quadruped_or_multilimb']) {
    const rig = bindRig(name);
    assert.ok(rig.bones.length > 12);
    assert.ok(rig.anatomy.roles.head);
    const big = bindRig(name, {
      canvas: {
        width: 1024,
        height: 1024
      }
    });
    assert.equal(big.bones[1].length, rig.bones[1].length * 2);
    rig.bones[0].rest.position[0] = 900;
    assert.notEqual(bindRig(name).bones[0].rest.position[0], 900);
  }
});
test('custom asymmetric topologies and semantic overrides validate references, cycles and limits', () => {
  const bones = [{
    id: 'base',
    parent: null,
    rest: {
      position: [5, 6],
      rotation: 0,
      scale: [1, 1]
    },
    length: 10,
    limits: [-1, 1]
  }];
  assert.equal(bindRig('custom', {
    bones,
    roles: {
      root: 'base',
      head: 'base'
    }
  }).bones[0].id, 'base');
  for (const options of [{}, {
    bones,
    roles: {
      root: 'missing'
    }
  }, {
    bones: [{
      ...bones[0],
      parent: 'base'
    }],
    roles: {}
  }, {
    bones: [{
      ...bones[0],
      limits: [1, -1]
    }],
    roles: {}
  }]) {
    assert.throws(() => bindRig('custom', options), {
      code: 'INVALID_RIG'
    });
  }
  assert.throws(() => bindRig('unknown'), {
    code: 'INVALID_RIG'
  });
  assert.throws(() => bindRig('humanoid', {
    scale: 0
  }), {
    code: 'INVALID_RIG'
  });
  const rectangle=bindRig('humanoid',{canvas:{width:512,height:768}});
  assert.deepEqual(rectangle.bones[0].rest.position,[256,428]);
});
test('skinning produces texture pixel strips with normalized spatially varying weights', () => {
  const bones = [{
    id: 'a',
    parent: null,
    rest: {
      position: [0, 0],
      rotation: 0,
      scale: [1, 1]
    },
    length: 5
  }, {
    id: 'b',
    parent: 'a',
    rest: {
      position: [5, 0],
      rotation: 0,
      scale: [1, 1]
    },
    length: 5
  }];
  const part = {
    id: 'strip',
    bone: 'a',
    image: {
      prepared: true,
      width: 10,
      height: 4,
      pivot: [0, 2],
      pixelsPerUnit: 1
    },
    skinning: {
      bones: ['a', 'b'],
      axis: 'x',
      segments: 4
    }
  };
  const result = skinPart(part, bones);
  assert.equal(result.mesh.vertices.length, 10);
  assert.equal(result.mesh.triangles.length, 8);
  assert.deepEqual(result.mesh.vertices, result.mesh.uv);
  for (const row of result.mesh.weights) assert.ok(Math.abs(row.reduce((n, x) => n + x.weight, 0) - 1) < 1e-10);
  assert.ok(result.mesh.weights[0][0].weight > result.mesh.weights[8][0].weight);
  assert.equal(part.mesh, undefined);
  assert.equal(skinPart({
    ...part,
    skinning: {
      ...part.skinning,
      axis: 'y'
    }
  }, bones).mesh.vertices[8][1], 4);
});
test('skinning rejects unsupported and malformed directives and honors rotated parents', () => {
  const rig = bindRig('humanoid');
  const p = {
    bone: 'root',
    image: {
      prepared: true,
      width: 8,
      height: 8,
      pivot: [0, 0],
      pixelsPerUnit: 1
    },
    skinning: {
      bones: ['root'],
      axis: 'y',
      segments: 1
    }
  };
  assert.equal(skinPart(p, rig.bones).mesh.weights[0][0].weight, 1);
  for (const bad of [{
    ...p,
    image: {}
  }, {
    ...p,
    skinning: {
      ...p.skinning,
      bones: ['missing']
    }
  }, {
    ...p,
    skinning: {
      ...p.skinning,
      axis: 'z'
    }
  }, {
    ...p,
    skinning: {
      ...p.skinning,
      segments: 0
    }
  }]) assert.throws(() => skinPart(bad, rig.bones), {
    code: 'INVALID_RIG'
  });
  const b = [{
    id: 'r',
    parent: null,
    rest: {
      position: [0, 0],
      rotation: Math.PI / 2,
      scale: [1, 1]
    },
    length: 8
  }, {
    id: 'c',
    parent: 'r',
    rest: {
      position: [8, 0],
      rotation: 0,
      scale: [1, 1]
    },
    length: 8
  }];
  const mesh = skinPart({
    ...p,
    bone: 'c',
    skinning: {
      bones: ['r', 'c'],
      axis: 'x',
      segments: 2,
      pinStart: false,
      pinEnd: false
    }
  }, b).mesh;
  assert.equal(mesh.vertices.length, 6);
  assert.ok(Math.abs(mesh.weights[0][0].weight - .5) < 1e-8);
  assert.ok(mesh.weights[4][1].weight > .999);
});
test('strip endpoints pin to mount and final bone by default with explicit free blending',()=>{
 const bones=[{id:'a',parent:null,rest:{position:[0,0],rotation:0,scale:[1,1]},length:5},{id:'b',parent:'a',rest:{position:[5,0],rotation:0,scale:[1,1]},length:5}];
 const part={bone:'a',image:{prepared:true,width:10,height:4,pivot:[0,2],pixelsPerUnit:1},skinning:{bones:['a','b'],axis:'x',segments:4}};
 const pinned=skinPart(part,bones).mesh;
 for(const i of [0,1]) assert.deepEqual(pinned.weights[i],[{bone:'a',weight:1},{bone:'b',weight:0}]);
 for(const i of [8,9]) assert.deepEqual(pinned.weights[i],[{bone:'a',weight:0},{bone:'b',weight:1}]);
 assert.ok(pinned.weights[4].every(w=>w.weight>0));
 const free=skinPart({...part,skinning:{...part.skinning,pinStart:false,pinEnd:false}},bones).mesh;
 assert.ok(free.weights[0][1].weight>0);assert.ok(free.weights[8][0].weight>0);
 assert.throws(()=>skinPart({...part,skinning:{...part.skinning,bones:['b']}},bones),{code:'INVALID_RIG'});
 assert.throws(()=>skinPart({...part,skinning:{...part.skinning,pinStart:'yes'}},bones),{code:'INVALID_RIG'});
});
test('rig validation rejects unsafe names, duplicate IDs, missing parents and invalid numeric frames', () => {
  const b = {
    id: 'root',
    parent: null,
    rest: {
      position: [0, 0],
      rotation: 0,
      scale: [1, 1]
    },
    length: 5
  };
  for (const bones of [[], [b, b], [{
    ...b,
    id: '../root'
  }], [{
    ...b,
    parent: 'missing'
  }], [{
    ...b,
    length: NaN
  }], [{
    ...b,
    rest: {
      ...b.rest,
      scale: [0, 1]
    }
  }], [{
    ...b,
    limits: [0, Infinity]
  }]]) assert.throws(() => bindRig('custom', {
    bones,
    roles: {}
  }), {
    code: 'INVALID_RIG'
  });
  assert.throws(() => bindRig('custom', {
    bones: [b],
    roles: {
      'bad role': 'root'
    }
  }), {
    code: 'INVALID_RIG'
  });
  assert.throws(() => bindRig('constructor'), {
    code: 'INVALID_RIG'
  });
  const custom = bindRig('custom', {
    bones: [b],
    roles: {
      root: 'root'
    },
    scale: 2
  });
  assert.equal(custom.bones[0].length, 10);
  assert.equal(b.length, 5);
  assert.equal(bindRig('humanoid', {
    roles: {
      torso: 'head'
    }
  }).anatomy.roles.torso, 'head');
});
test('skinning rejects excess geometry, duplicate weights and malformed image geometry', () => {
  const bones = bindRig('humanoid').bones;
  const p = {
    bone: 'root',
    image: {
      prepared: true,
      width: 8,
      height: 8,
      pivot: [0, 0],
      pixelsPerUnit: 1
    },
    skinning: {
      bones: ['root'],
      axis: 'x',
      segments: 15
    }
  };
  assert.equal(skinPart(p, bones).mesh.vertices.length, 32);
  for (const d of [undefined, {
    ...p.skinning,
    segments: 16
  }, {
    ...p.skinning,
    bones: []
  }, {
    ...p.skinning,
    bones: ['root', 'root']
  }]) assert.throws(() => skinPart({
    ...p,
    skinning: d
  }, bones), {
    code: 'INVALID_RIG'
  });
  for (const im of [{
    ...p.image,
    width: 0
  }, {
    ...p.image,
    pivot: [NaN, 0]
  }, {
    ...p.image,
    pixelsPerUnit: 0
  }]) assert.throws(() => skinPart({
    ...p,
    image: im
  }, bones), {
    code: 'INVALID_RIG'
  });
  assert.throws(() => skinPart({
    ...p,
    bone: 'missing'
  }, bones), {
    code: 'INVALID_RIG'
  });
});
