'use strict';

const schema = require('../schema/character.schema.json');
const {bindRig} = require('./rig');
const unsafe = new Set(['__proto__', 'prototype', 'constructor', 'command', 'script', 'executable', 'shell']);
function validateSpec(spec) {
  const errors = [];
  const error = (path, code, message) => errors.push({
    path,
    code,
    message
  });
  function check(value, rule, path) {
    if (rule.$ref) rule = schema.$defs[rule.$ref.split('/').pop()];
    if (rule.anyOf) {
      const start = errors.length;
      let valid = false;
      for (const option of rule.anyOf) {
        check(value, option, path);
        if (errors.length === start) valid = true;
        errors.splice(start);
      }
      if (!valid) error(path, 'TYPE', 'No supported value shape matches');
      return;
    }
    if (rule.enum && !rule.enum.includes(value)) error(path, 'ENUM', 'Value is not supported');
    const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (rule.type && !(Array.isArray(rule.type) ? rule.type : [rule.type]).some(t => t === type || t === 'integer' && Number.isInteger(value))) {
      error(path, 'TYPE', 'Expected ' + rule.type);
      return;
    }
    if (type === 'number') {
      if (!Number.isFinite(value) || rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum) error(path, 'NUMBER', 'Number outside permitted range');
    }
    if (type === 'string' && (rule.pattern && !new RegExp(rule.pattern).test(value) || rule.minLength && value.length < rule.minLength || rule.maxLength && value.length > rule.maxLength)) error(path, 'STRING', 'Invalid string');
    if (type === 'array') {
      if (rule.minItems !== undefined && value.length < rule.minItems || rule.maxItems !== undefined && value.length > rule.maxItems) error(path, 'LENGTH', 'Invalid array length');
      value.forEach((v, i) => check(v, rule.items || {}, `${path}/${i}`));
    }
    if (type === 'object') {
      if (rule.if && rule.then && value.prepared === true) {
        check(value, rule.then, path);
      }
      for (const key of rule.required || []) if (!Object.hasOwn(value, key)) error(`${path}/${key}`, 'REQUIRED', 'Missing required field');
      for (const [key, v] of Object.entries(value)) {
        if (unsafe.has(key)) {
          error(`${path}/${key}`, 'UNSAFE', 'Executable or prototype fields are forbidden');
          continue;
        }
        const child = rule.properties?.[key];
        if (child) check(v, child, `${path}/${key}`);else if (rule.additionalProperties === false) error(`${path}/${key}`, 'UNKNOWN', 'Unknown field');else if (typeof rule.additionalProperties === 'object') check(v, rule.additionalProperties, `${path}/${key}`);else check(v, {}, `${path}/${key}`);
      }
    }
  }
  check(spec, schema, '');
  if (errors.length) return {
    valid: false,
    errors
  };
  const finiteVector = v => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);
  const transform = (t, path) => {
    if (t.scale.some(v => v === 0)) error(path, 'DEGENERATE', 'Scale cannot be zero');
  };
  const maps = {};
  for (const collection of ['bones', 'parts', 'animations', 'sockets', 'components', 'visualStates', 'references', 'sounds', 'polylines', 'projectiles', 'poseGroups']) {
    maps[collection] = new Map();
    (spec[collection] || []).forEach((item, i) => {
      if (maps[collection].has(item.id)) error(`/${collection}/${i}/id`, 'DUPLICATE', 'Duplicate stable ID');
      maps[collection].set(item.id, item);
    });
  }
  const ref = (collection, id, path) => {
    if (id !== null && !maps[collection].has(id)) error(path, 'REFERENCE', `Unknown ${collection} reference: ${id}`);
  };
  for (const [i, b] of spec.bones.entries()) {
    transform(b.rest, `/bones/${i}/rest`);
    ref('bones', b.parent, `/bones/${i}/parent`);
    const seen = new Set([b.id]);
    let parent = b.parent;
    while (parent !== null && maps.bones.has(parent)) {
      if (seen.has(parent)) {
        error(`/bones/${i}`, 'CYCLE', 'Bone hierarchy contains a cycle');
        break;
      }
      seen.add(parent);
      parent = maps.bones.get(parent).parent;
    }
    if (b.limits && b.limits[0] > b.limits[1]) error(`/bones/${i}/limits`, 'ORDER', 'Minimum exceeds maximum');
    if (b.limits && (b.rest.rotation < b.limits[0] || b.rest.rotation > b.limits[1])) error(`/bones/${i}/rest/rotation`, 'LIMIT', 'Rest rotation is outside absolute joint limits');
  }
  for (const [role, id] of Object.entries(spec.anatomy.roles)) ref('bones', id, `/anatomy/roles/${role}`);
  for (const [i, p] of spec.parts.entries()) {
    ref('bones', p.bone, `/parts/${i}/bone`);
    if (p.skinning) {
      const seen = new Set();
      for (const [j, id] of p.skinning.bones.entries()) {
        ref('bones', id, `/parts/${i}/skinning/bones/${j}`);
        if (seen.has(id)) error(`/parts/${i}/skinning/bones/${j}`, 'DUPLICATE', 'Repeated skinning bone');
        seen.add(id);
      }
      if (!seen.has(p.bone)) error(`/parts/${i}/skinning/bones`, 'REFERENCE', 'Skinning must include the attachment bone');
    }
    for (const kind of ['image', 'mask']) {
      const image = p[kind];
      if (!image || !image.alphaBounds) continue;
      const [left, top, right, bottom] = image.alphaBounds;
      if (image.width === undefined || image.height === undefined || left < 0 || top < 0 || right <= left || bottom <= top || right > image.width || bottom > image.height) {
        error(`/parts/${i}/${kind}/alphaBounds`, 'IMAGE_BOUNDS', 'Alpha bounds must be nonempty [left, top, right, bottom] inside known source dimensions');
      }
    }
    for (const id of p.overlaps || []) ref('parts', id, `/parts/${i}/overlaps`);
    if (!p.mesh) continue;
    const m = p.mesh,
      n = m.vertices.length;
    if (m.uv.length !== n || m.weights.length !== n) error(`/parts/${i}/mesh`, 'LENGTH', 'UV and weights must match vertices');
    m.triangles.forEach(t => {
      if (new Set(t).size !== 3 || t.some(v => v >= n)) error(`/parts/${i}/mesh/triangles`, 'TRIANGLE', 'Invalid triangle indices');else {
        const [a, b, c] = t.map(v => m.vertices[v]);
        if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 1e-10) error(`/parts/${i}/mesh/triangles`, 'DEGENERATE', 'Triangle has no area');
      }
    });
    m.weights.forEach((weights, v) => {
      const seen = new Set();
      let sum = 0;
      for (const w of weights) {
        ref('bones', w.bone, `/parts/${i}/mesh/weights/${v}`);
        if (seen.has(w.bone)) error(`/parts/${i}/mesh/weights/${v}`, 'DUPLICATE', 'Repeated influence');
        seen.add(w.bone);
        sum += w.weight;
      }
      if (Math.abs(sum - 1) > 1e-5) error(`/parts/${i}/mesh/weights/${v}`, 'WEIGHTS', 'Weights must sum to one');
    });
  }
  const poseMemberships = new Set();
  let membershipCount = 0;
  for (const [i, group] of (spec.poseGroups || []).entries()) {
    if (unsafe.has(group.id)) error(`/poseGroups/${i}/id`, 'UNSAFE', 'Unsafe pose group ID is forbidden');
    for (const [j, id] of group.parts.entries()) {
      ref('parts', id, `/poseGroups/${i}/parts/${j}`);
      if (poseMemberships.has(id)) error(`/poseGroups/${i}/parts/${j}`, 'DUPLICATE', 'Part may belong to only one pose group and appear only once');
      poseMemberships.add(id);
      membershipCount++;
    }
    if (!group.parts.includes(group.defaultPart)) error(`/poseGroups/${i}/defaultPart`, 'REFERENCE', 'Default part must belong to the pose group');
  }
  if (membershipCount > 256) error('/poseGroups', 'LENGTH', 'Pose groups exceed the total membership budget');
  for (const [i, line] of (spec.polylines || []).entries()) {
    for (const [j, anchor] of line.anchors.entries()) ref('bones', anchor.bone, `/polylines/${i}/anchors/${j}/bone`);
  }
  for (const [i, projectile] of (spec.projectiles || []).entries()) {
    ref('parts', projectile.part, `/projectiles/${i}/part`);
    if (projectile.impactSound !== undefined) ref('sounds', projectile.impactSound, `/projectiles/${i}/impactSound`);
    if (projectile.forward.every(value => value === 0)) error(`/projectiles/${i}/forward`, 'DEGENERATE', 'Projectile forward vector cannot be zero');
    if (projectile.flightDuration <= 0 || projectile.lifetime <= 0) error(`/projectiles/${i}`, 'TIME', 'Projectile durations must be positive');
    if (projectile.flightDuration > projectile.lifetime) error(`/projectiles/${i}/flightDuration`, 'TIME', 'Flight duration exceeds projectile lifetime');
  }
  for (const [i, a] of spec.animations.entries()) {
    const poseOwned = new Set();
    for (const [j, track] of (a.poseTracks || []).entries()) {
      const path = `/animations/${i}/poseTracks/${j}`;
      ref('poseGroups', track.group, `${path}/group`);
      if (poseOwned.has(track.group)) error(path, 'DUPLICATE', 'Pose group has multiple tracks');
      poseOwned.add(track.group);
      const group = maps.poseGroups.get(track.group);
      let previous = -1;
      for (const [k, key] of track.keys.entries()) {
        if (k === 0 && key.time !== 0 || key.time <= previous || key.time > a.duration || a.loop && key.time === a.duration) error(`${path}/keys/${k}/time`, 'TIME', 'Pose keys must start at zero and increase within the clip interval');
        previous = key.time;
        if (group && !group.parts.includes(key.part)) error(`${path}/keys/${k}/part`, 'REFERENCE', 'Selected part must belong to the pose group');
      }
    }
    const owned = new Set();
    for (const [j, t] of a.tracks.entries()) {
      ref('bones', t.bone, `/animations/${i}/tracks/${j}/bone`);
      const key = t.bone + ':' + t.property;
      if (owned.has(key)) error(`/animations/${i}/tracks/${j}`, 'DUPLICATE', 'Property has multiple tracks');
      owned.add(key);
      let previous = -1;
      for (const k of t.keys) {
        if (k.time <= previous || k.time > a.duration) error(`/animations/${i}/tracks/${j}`, 'TIME', 'Keys must increase within duration');
        previous = k.time;
        if (t.property === 'rotation' ? !Number.isFinite(k.value) : !finiteVector(k.value)) error(`/animations/${i}/tracks/${j}`, 'TYPE', 'Track value does not match property');
      }
    }
    const ids = new Set();
    let previous = -1;
    for (const [j, e] of a.events.entries()) {
      if (e.type === 'sound') {
        ref('sounds', e.payload.sound, `/animations/${i}/events/${j}/payload/sound`);
        if (e.time >= a.duration) error(`/animations/${i}/events/${j}/time`, 'TIME', 'Sound cue must precede the excluded clip end');
      }
      if (e.type === 'projectile') {
        ref('projectiles', e.payload.projectile, `/animations/${i}/events/${j}/payload/projectile`);
        ref('sockets', e.payload.sourceSocket, `/animations/${i}/events/${j}/payload/sourceSocket`);
        if (e.payload.nockedPart !== undefined) ref('parts', e.payload.nockedPart, `/animations/${i}/events/${j}/payload/nockedPart`);
        if (e.time >= a.duration) error(`/animations/${i}/events/${j}/time`, 'TIME', 'Projectile release must precede the excluded clip end');
      }
      if (ids.has(e.id) || e.time < previous || e.time > a.duration) error(`/animations/${i}/events`, 'EVENT', 'Duplicate or unordered event');
      ids.add(e.id);
      previous = e.time;
    }
  }
  spec.sockets.forEach((s, i) => {
    ref('bones', s.bone, `/sockets/${i}/bone`);
    transform(s.transform, `/sockets/${i}/transform`);
  });
  for (const id of spec.artwork.referenceIds || []) ref('references', id, '/artwork/referenceIds');
  const occupied = new Map();
  spec.components.forEach((c, i) => {
    ref('sockets', c.socket, `/components/${i}/socket`);
    if (c.transform) transform(c.transform, `/components/${i}/transform`);
    const socket = maps.sockets.get(c.socket);
    if (socket) {
      const count = (occupied.get(c.socket) || 0) + 1;
      occupied.set(c.socket, count);
      if (count > socket.capacity || !socket.types.includes(c.type)) error(`/components/${i}`, 'COMPATIBILITY', 'Socket capacity or type mismatch');
    }
  });
  spec.visualStates.forEach((s, i) => {
    for (const id of s.parts) ref('parts', id, `/visualStates/${i}/parts`);
  });
  if (spec.assembly) {
    const {hashValue}=require('./assets');
    if (spec.assembly.styleHash !== hashValue(spec.style)) error('/assembly/styleHash','COMPATIBILITY','Assembly style must match the parent style identity');
    const types = new Set(spec.assembly.descriptors.map(item=>item.type));
    for (const component of spec.components) if (!types.has(component.type)) error('/assembly/descriptors','REFERENCE','Missing component descriptor: '+component.type);
    try {
      require('./components').createAssemblyPlanner({
        sockets:spec.sockets.filter(socket=>socket.types.some(type=>types.has(type))),
        descriptors:spec.assembly.descriptors,
        styleHash:spec.assembly.styleHash,
        eventNames:spec.assembly.eventNames
      });
    } catch (cause) { error('/assembly','COMPATIBILITY',cause.message); }
  }
  return {
    valid: errors.length === 0,
    errors
  };
}
function assertSpec(spec) {
  const result = validateSpec(spec);
  if (!result.valid) {
    const error = new Error('Invalid character specification');
    error.code = 'INVALID_SPEC';
    error.diagnostics = result.errors;
    throw error;
  }
  return structuredClone(spec);
}
function createSpec({
  id,
  description,
  template = 'custom'
}) {
  const transform = {
    position: [0, 0],
    rotation: 0,
    scale: [1, 1]
  };
  const known = ['humanoid', 'mechanical', 'quadruped_or_multilimb', 'custom'];
  if (typeof template === 'string' && !known.includes(template)) {
    const e = new Error('Unknown template');
    e.code = 'INVALID_SPEC';
    throw e;
  }
  const base = {
    version: 1,
    id,
    revision: 1,
    description,
    canvas: {
      width: 512,
      height: 512,
      units: 'pixels',
      xAxis: 'right',
      yAxis: 'down',
      rotation: 'clockwise-radians'
    },
    anatomy: {
      template: typeof template === 'string' ? template : 'custom',
      roles: {
        root: 'root'
      }
    },
    style: {},
    references: [],
    artwork: {
      provider: 'existing'
    },
    bones: [{
      id: 'root',
      parent: null,
      rest: transform,
      length: 1
    }],
    parts: [],
    animations: [],
    sounds: [],
    sockets: [],
    components: [],
    visualStates: [],
    export: {
      target: 'godot'
    }
  };
  if (typeof template === 'string' && template !== 'custom') {
    const rig = bindRig(template, {canvas:base.canvas});
    base.bones = rig.bones;
    base.anatomy = rig.anatomy;
  }
  return assertSpec(typeof template === 'object' ? merge(base, template) : base);
}
function merge(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return structuredClone(patch);
  const out = target && typeof target === 'object' && !Array.isArray(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (unsafe.has(key)) {
      const e = new Error('Forbidden patch key');
      e.code = 'INVALID_SPEC';
      throw e;
    }
    if (value === null) delete out[key];else Object.defineProperty(out, key, {
      value: merge(out[key], value),
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  return out;
}
function applyPatch(spec, patch) {
  const source = assertSpec(spec);
  const result = merge(source, patch);
  if (result && typeof result === 'object' && !Array.isArray(result)) result.revision = source.revision + 1;
  return assertSpec(result);
}
module.exports = {
  validateSpec,
  assertSpec,
  createSpec,
  applyPatch
};
