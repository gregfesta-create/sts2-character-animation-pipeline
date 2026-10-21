'use strict';

const libraries = Object.fromEntries(['humanoid', 'mechanical', 'quadruped_or_multilimb'].map(name => [name, require('../library/rigs/' + name + '.json')]));
function fail(message) {
  throw Object.assign(new Error(message), {
    code: 'INVALID_RIG'
  });
}
const finite = n => typeof n === 'number' && Number.isFinite(n);
const pair = a => Array.isArray(a) && a.length === 2 && a.every(finite);
function validate(bones, roles) {
  if (!Array.isArray(bones) || !bones.length || bones.length > 256 || !roles || typeof roles !== 'object' || Array.isArray(roles)) fail('Explicit bones and semantic roles are required');
  const map = new Map();
  for (const b of bones) {
    if (!b || typeof b.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(b.id) || map.has(b.id) || !b.rest || !pair(b.rest.position) || !pair(b.rest.scale) || b.rest.scale.some(n => n <= 0) || !finite(b.rest.rotation) || !finite(b.length) || b.length <= 0 || b.limits && (!pair(b.limits) || b.limits[0] > b.limits[1])) fail('Invalid bone, transform or limits');
    map.set(b.id, b);
    if (b.limits && (b.rest.rotation < b.limits[0] || b.rest.rotation > b.limits[1])) fail('Rest rotation is outside absolute joint limits');
  }
  for (const b of bones) {
    const seen = new Set([b.id]);
    let parent = b.parent;
    while (parent !== null) {
      if (!map.has(parent) || seen.has(parent)) fail('Missing parent or bone cycle');
      seen.add(parent);
      parent = map.get(parent).parent;
    }
  }
  for (const [role, id] of Object.entries(roles)) if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(role) || !map.has(id)) fail('Invalid semantic role binding');
  return map;
}
/** Uniform canonical scaling preserves joint angles and positive rest frames. */
function bindRig(template, overrides = {}) {
  const source = template === 'custom' ? {
    bones: overrides.bones,
    anatomy: {
      template,
      roles: overrides.roles
    }
  } : Object.hasOwn(libraries, template) ? libraries[template] : null;
  if (!source) fail('Unknown rig template');
  const rig = structuredClone(source);
  if (overrides.bones) rig.bones = structuredClone(overrides.bones);
  if (overrides.roles) rig.anatomy.roles = structuredClone(overrides.roles);
  let scale = overrides.scale === undefined ? 1 : overrides.scale;
  let canvasOffset = [0,0];
  if (overrides.canvas) {
    const {
      width,
      height
    } = overrides.canvas;
    if (!finite(width) || !finite(height) || width <= 0 || height <= 0 || width > 16384 || height > 16384) fail('Canonical canvas must have positive dimensions within 16384 pixels');
    const side=Math.min(width,height);
    scale *= side / 512;
    canvasOffset=[(width-side)/2,(height-side)/2];
  }
  if (!finite(scale) || scale <= 0 || scale > 64) fail('Invalid rig scale');
  validate(rig.bones, rig.anatomy.roles);
  for (const b of rig.bones) {
    b.rest.position = b.rest.position.map(v => v * scale);
    if (b.parent === null) b.rest.position=b.rest.position.map((v,i)=>v+canvasOffset[i]);
    b.length *= scale;
  }
  return rig;
}
function globalFrames(bones) {
  const map = validate(bones, {}),
    frames = new Map();
  function visit(id) {
    if (frames.has(id)) return frames.get(id);
    const b = map.get(id),
      r = b.rest,
      local = [Math.cos(r.rotation) * r.scale[0], Math.sin(r.rotation) * r.scale[0], -Math.sin(r.rotation) * r.scale[1], Math.cos(r.rotation) * r.scale[1], ...r.position];
    let result = local;
    if (b.parent !== null) {
      const p = visit(b.parent),
        [a, c, d, e, x, y] = local;
      result = [p[0] * a + p[2] * c, p[1] * a + p[3] * c, p[0] * d + p[2] * e, p[1] * d + p[3] * e, p[0] * x + p[2] * y + p[4], p[1] * x + p[3] * y + p[5]];
    }
    frames.set(id, result);
    return result;
  }
  bones.forEach(b => visit(b.id));
  return frames;
}
/** Strip tessellation in prepared texture pixels. Weight distance is measured
 * against each bone's complete rest segment in world space, never UV space. */
function skinPart(part, bones) {
  const frames = globalFrames(bones),
    d = part.skinning,
    im = part.image;
  if (!d || !['x', 'y'].includes(d.axis) || !Number.isInteger(d.segments) || d.segments < 1 || d.segments > 15 || !Array.isArray(d.bones) || d.bones.length < 1 || d.bones.length > 4 || new Set(d.bones).size !== d.bones.length || d.bones.some(id => !frames.has(id)) || !frames.has(part.bone)) fail('Invalid skinning directive or bone binding; maximum 32 vertices');
  if (!d.bones.includes(part.bone) || ['pinStart','pinEnd'].some(key=>d[key]!==undefined && typeof d[key]!=='boolean')) fail('Skinning requires the attachment bone and boolean endpoint pin settings');
  if (!im || !im.prepared || !Number.isInteger(im.width) || !Number.isInteger(im.height) || im.width <= 0 || im.height <= 0 || !pair(im.pivot) || !finite(im.pixelsPerUnit) || im.pixelsPerUnit <= 0) fail('Skinning requires prepared image geometry');
  const vertices = [],
    triangles = [],
    weights = [],
    origin = frames.get(part.bone),
    map = new Map(bones.map(b => [b.id, b]));
  for (let i = 0; i <= d.segments; i++) for (let edge = 0; edge < 2; edge++) {
    const v = d.axis === 'x' ? [im.width * i / d.segments, im.height * edge] : [im.width * edge, im.height * i / d.segments];
    vertices.push(v);
    const pin = i === 0 && d.pinStart !== false ? part.bone : i === d.segments && d.pinEnd !== false ? d.bones.at(-1) : null;
    if (pin !== null) {
      weights.push(d.bones.map(bone=>({bone,weight:bone===pin?1:0})));
      continue;
    }
    // Match the backend's full attachment global rest transform.
    const localX = (v[0] - im.pivot[0]) / im.pixelsPerUnit;
    const localY = (v[1] - im.pivot[1]) / im.pixelsPerUnit;
    const x = origin[0] * localX + origin[2] * localY + origin[4];
    const y = origin[1] * localX + origin[3] * localY + origin[5];
    const row = d.bones.map(id => {
      const f = frames.get(id),
        len = map.get(id).length,
        dx = f[0] * len,
        dy = f[1] * len;
      const t = Math.max(0, Math.min(1, ((x - f[4]) * dx + (y - f[5]) * dy) / (dx * dx + dy * dy)));
      return {
        bone: id,
        weight: 1 / Math.max(1e-8, (x - f[4] - t * dx) ** 2 + (y - f[5] - t * dy) ** 2)
      };
    });
    const sum = row.reduce((n, w) => n + w.weight, 0);
    weights.push(row.map(w => ({
      ...w,
      weight: w.weight / sum
    })));
  }
  for (let i = 0; i < d.segments; i++) {
    const a = i * 2;
    triangles.push(d.axis === 'x' ? [a, a + 2, a + 1] : [a, a + 1, a + 2], d.axis === 'x' ? [a + 1, a + 2, a + 3] : [a + 1, a + 3, a + 2]);
  }
  const result = structuredClone(part);
  result.mesh = {
    vertices,
    uv: structuredClone(vertices),
    triangles,
    weights
  };
  return result;
}
/** Reject executable, cyclic and excessive inputs before schema traversal or hashing. */
function plainRigInput(input) {
  let nodes=0,bytes=0;
  const ancestors=new Set();
  function walk(value,depth) {
    if(++nodes>100000||depth>64)fail('Rig input exceeds bounded plain data limits');
    if(value===null||typeof value==='boolean')return;
    if(typeof value==='number'){if(!finite(value))fail('Rig input requires finite numbers');return;}
    if(typeof value==='string'){bytes+=Buffer.byteLength(value);if(bytes>8*1024*1024)fail('Rig input exceeds bounded plain data limits');return;}
    if(typeof value!=='object'||ancestors.has(value))fail('Rig input must be acyclic plain data');
    const array=Array.isArray(value),proto=Object.getPrototypeOf(value);
    if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)fail('Rig input must be plain data');
    if(array&&value.length>10000)fail('Rig input exceeds bounded array limits');
    const keys=Reflect.ownKeys(value);if(keys.length>10000)fail('Rig input exceeds bounded object limits');
    ancestors.add(value);
    for(const key of keys){if(array&&key==='length')continue;const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!d.enumerable||!Object.hasOwn(d,'value')||array&&!/^(0|[1-9][0-9]*)$/.test(key))fail('Rig input requires enumerable plain values');bytes+=Buffer.byteLength(key);if(bytes>8*1024*1024)fail('Rig input exceeds bounded plain data limits');walk(d.value,depth+1);}
    if(array&&keys.length!==value.length+1)fail('Rig input must not contain sparse arrays');
    ancestors.delete(value);
  }
  walk(input,0);
}
/** Fit explicit world landmarks to an untouched scaffold, never infer anatomy. */
function fitRig(spec,request) {
  plainRigInput(spec);plainRigInput(request);
  const {assertSpec,applyPatch}=require('./spec'),{hashValue}=require('./assets');
  if(!request||Array.isArray(request)||request.version!==1||Object.keys(request).some(k=>!['version','sourceSpecHash','bones'].includes(k))||!/^[a-f0-9]{64}$/.test(request.sourceSpecHash)||!Array.isArray(request.bones)||request.bones.length<1||request.bones.length>256)fail('Invalid landmark request');
  if(['parts','animations','sockets','components','visualStates','polylines','projectiles'].some(k=>spec?.[k]?.length)||spec?.assembly)fail('Landmark fitting requires an initial scaffold without authored dependent collections or assembly');
  assertSpec(spec);
  if(request.sourceSpecHash!==hashValue(spec))fail('Landmarks refer to a stale source specification');
  if(request.bones.length!==spec.bones.length)fail('Exactly one landmark entry per bone is required');
  const source=new Map(spec.bones.map(b=>[b.id,b])),landmarks=new Map(),fitted=new Map(),frames=new Map();
  for(const entry of request.bones){if(!entry||Array.isArray(entry)||Object.keys(entry).some(k=>!['id','start','end'].includes(k))||!source.has(entry.id)||landmarks.has(entry.id)||!pair(entry.start)||!pair(entry.end)||[...entry.start,...entry.end].some(n=>Math.abs(n)>1000000))fail('Invalid, duplicate or unknown bone landmarks');const length=Math.hypot(entry.end[0]-entry.start[0],entry.end[1]-entry.start[1]);if(!finite(length)||length<0.000001)fail('Landmark segment must satisfy positive schema length');landmarks.set(entry.id,entry);}
  const precision=()=>fail('Rig fitting precision cannot preserve landmark direction, endpoints or joint-limit slack');
  function visit(id){if(fitted.has(id))return;const b=source.get(id),r=landmarks.get(id);if(b.parent!==null)visit(b.parent);const p=b.parent===null?{x:0,y:0,a:0}:frames.get(b.parent),angle=Math.atan2(r.end[1]-r.start[1],r.end[0]-r.start[0]),base=angle-p.a,rotation=base+Math.round((b.rest.rotation-base)/(2*Math.PI))*(2*Math.PI),dx=r.start[0]-p.x,dy=r.start[1]-p.y,c=Math.cos(p.a),s=Math.sin(p.a),position=[c*dx+s*dy,-s*dx+c*dy],length=Math.hypot(r.end[0]-r.start[0],r.end[1]-r.start[1]),out={...structuredClone(b),rest:{position,rotation,scale:[1,1]},length};
    if(!finite(rotation)||!pair(position))precision();
    const globalAngle=p.a+rotation;if(!finite(globalAngle)||Math.abs(Math.atan2(Math.sin(globalAngle-angle),Math.cos(globalAngle-angle)))>1e-10)precision();
    if(b.limits){const delta=rotation-b.rest.rotation;out.limits=b.limits.map(n=>n+delta);const old=[b.rest.rotation-b.limits[0],b.limits[1]-b.rest.rotation],next=[rotation-out.limits[0],out.limits[1]-rotation];if([...old,...next,...out.limits].some(n=>!finite(n))||old.some((n,i)=>Math.abs(n-next[i])>1e-9))precision();}
    const f={x:p.x+c*position[0]-s*position[1],y:p.y+s*position[0]+c*position[1],a:globalAngle};if(Math.hypot(f.x-r.start[0],f.y-r.start[1])>1e-6||Math.hypot(f.x+Math.cos(f.a)*length-r.end[0],f.y+Math.sin(f.a)*length-r.end[1])>1e-6)precision();
    fitted.set(id,out);frames.set(id,f);
  }
  spec.bones.forEach(b=>visit(b.id));
  return applyPatch(spec,{bones:spec.bones.map(b=>fitted.get(b.id))});
}
module.exports = {
  fitRig,
  bindRig,
  skinPart
};
