'use strict';

const {
  assertSpec
} = require('./spec');
const families = ['idle', 'move', 'attack', 'cast', 'defend', 'hit', 'death', 'retreat', 'repair', 'construct', 'transform', 'activate'];
const library = new Map(families.map(id => [id, require('../library/animations/' + id + '.json')]));
function fail(code, message) {
  throw Object.assign(new Error(message), {
    code
  });
}
function listClipFamilies() {
  return [...families];
}
/** Bind functional roles to local bone rotations. Values are radians relative to rest. */
function expandClips(spec, requests = families) {
  const out = assertSpec(spec);
  if (!Array.isArray(requests) || requests.length > 1000) fail('INVALID_CLIP', 'Clip requests must be a bounded array');
  const generated = new Set();
  for (const input of requests) {
    const request = typeof input === 'string' ? {
      family: input
    } : input;
    if (!request || typeof request !== 'object' || Array.isArray(request)) fail('INVALID_CLIP', 'Invalid clip request');
    for (const key of Object.keys(request)) if (!['family', 'id', 'duration', 'amplitude', 'easing', 'events', 'blendIn'].includes(key)) fail('INVALID_CLIP', 'Unknown clip parameter: ' + key);
    const template = library.get(request.family);
    if (!template) fail('UNSUPPORTED_CLIP', 'Unknown clip family: ' + request.family);
    const id = request.id ?? request.family,
      duration = request.duration ?? template.duration,
      amplitude = request.amplitude ?? 1,
      easing = request.easing ?? 'inOut';
    if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) || generated.has(id)) fail('INVALID_CLIP', 'Invalid or duplicate clip ID');
    if (!Number.isFinite(duration) || duration <= 0 || duration > 600 || !Number.isFinite(amplitude) || amplitude <= 0 || amplitude > 10 || !['linear', 'in', 'out', 'inOut', 'step'].includes(easing)) fail('INVALID_CLIP', 'Invalid duration, amplitude or easing');
    generated.add(id);
    if(request.blendIn!==undefined&&(!Number.isFinite(request.blendIn)||request.blendIn<0||request.blendIn>10))fail('INVALID_CLIP','Invalid blend duration');
    const used = new Set(),
      tracks = [];
    for (const [role, values] of Object.entries(template.poses)) {
      const boneId = out.anatomy.roles[role],
        bone = out.bones.find(b => b.id === boneId);
      if (!bone || used.has(boneId)) fail('UNSUPPORTED_BINDING', 'Clip ' + id + ' requires a distinct bone for role ' + role);
      used.add(boneId);
      const keys = values.map((offset, index) => {
        const value = bone.rest.rotation + offset * amplitude;
        if (bone.limits && (value < bone.limits[0] || value > bone.limits[1])) fail('JOINT_LIMIT', 'Clip ' + id + ' exceeds joint limits for ' + boneId);
        return {
          time: duration * index / (values.length - 1),
          value,
          easing
        };
      });
      tracks.push({
        bone: boneId,
        property: 'rotation',
        keys
      });
    }
    const events = (template.markers ?? []).map(([name, phase]) => ({
      id: name,
      name,
      time: duration * phase
    }));
    if (request.events !== undefined) {
      if (!Array.isArray(request.events)) fail('INVALID_CLIP', 'Events must be an array');
      events.push(...structuredClone(request.events));
    }
    events.sort((a, b) => a.time - b.time);
    const clip = {
      id,
      duration,
      loop: template.loop,
      tracks,
      events
    };
    const index = out.animations.findIndex(c => c.id === id);
    if(request.blendIn!==undefined)clip.blendIn=request.blendIn;
    if (index < 0) out.animations.push(clip);else out.animations[index] = clip;
  }
  return assertSpec(out);
}
module.exports = {
  expandClips,
  listClipFamilies
};
