'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSpec,
  validateSpec
} = require('../lib/spec');
const {
  expandClips,
  listClipFamilies
} = require('../lib/animation');
test('clip requests preserve explicit blend duration and reject unsupported values',()=>{
 const spec=fixture();const clip=expandClips(spec,[{family:'idle',blendIn:0.25}]).animations[0];assert.equal(clip.blendIn,0.25);
 assert.equal(Object.hasOwn(expandClips(spec,['idle']).animations[0],'blendIn'),false);
 for(const blendIn of [-1,10.1,NaN,Infinity,'0.5'])assert.throws(()=>expandClips(spec,[{family:'idle',blendIn}]),{code:'INVALID_CLIP'});
});
function fixture() {
  const s = createSpec({
    id: 'Actor',
    description: 'fixture'
  });
  s.anatomy.roles = {};
  for (const role of ['torso', 'armLeft', 'armRight', 'legLeft', 'legRight']) {
    s.bones.push({
      id: role,
      parent: 'root',
      rest: {
        position: [0, 0],
        rotation: 0,
        scale: [1, 1]
      },
      length: 20,
      limits: [-2, 2]
    });
    s.anatomy.roles[role] = role;
  }
  return s;
}
test('twelve reusable families have articulated numeric poses and loop seams', () => {
  const s = fixture(),
    before = JSON.stringify(s),
    out = expandClips(s);
  assert.equal(out.animations.length, 12);
  assert.equal(listClipFamilies().length, 12);
  assert.equal(validateSpec(out).valid, true);
  assert.equal(JSON.stringify(s), before);
  for (const clip of out.animations) {
    assert.ok(clip.tracks.length >= 2);
    assert.ok(clip.tracks.some(t => t.keys.some(k => k.value !== 0)));
    if (clip.loop) for (const t of clip.tracks) assert.equal(t.keys[0].value, t.keys.at(-1).value);
  }
  assert.equal(out.animations.find(c => c.id === 'attack').tracks.find(t => t.bone === 'armRight').keys[2].value, 0.9);
});
test('overrides retime poses and markers without mutable library leakage', () => {
  let s = fixture();
  let a = expandClips(s, [{
    family: 'attack',
    id: 'slash',
    duration: 2,
    amplitude: 0.5,
    easing: 'out',
    events: [{
      id: 'cue',
      time: 0.3,
      name: 'cue'
    }]
  }]);
  let c = a.animations[0];
  assert.equal(c.duration, 2);
  assert.equal(c.tracks.find(t => t.bone === 'armRight').keys[2].value, 0.45);
  assert.equal(c.tracks[0].keys[1].easing, 'out');
  assert.equal(c.events.find(e => e.id === 'impact').time, 1);
  assert.equal(c.events.find(e => e.id === 'cue').time, 0.3);
  a.animations[0].tracks[0].keys[0].value = 999;
  assert.notEqual(expandClips(s, ['attack']).animations[0].tracks[0].keys[0].value, 999);
  s = expandClips(s, ['idle']);
  assert.equal(expandClips(s, ['idle']).animations.length, 1);
});
test('bindings support custom bone identities and reject missing or aliased anatomy', () => {
  let s = fixture();
  s.bones.find(b => b.id === 'armRight').id = 'tentacle';
  s.anatomy.roles.armRight = 'tentacle';
  assert.ok(expandClips(s, ['attack']).animations[0].tracks.some(t => t.bone === 'tentacle'));
  delete s.anatomy.roles.armRight;
  assert.throws(() => expandClips(s, ['attack']), {
    code: 'UNSUPPORTED_BINDING'
  });
  s = fixture();
  s.anatomy.roles.armRight = 'armLeft';
  assert.throws(() => expandClips(s, ['attack']), {
    code: 'UNSUPPORTED_BINDING'
  });
});
test('invalid requests, constraints, events and families fail explicitly', () => {
  for (const request of [null, {}, 'bogus', {
    family: 'idle',
    duration: 0
  }, {
    family: 'idle',
    amplitude: NaN
  }, {
    family: 'idle',
    easing: 'bad'
  }, {
    family: 'idle',
    unknown: true
  }, {
    family: 'idle',
    events: [{
      id: 'bad',
      name: 'bad',
      time: 99
    }]
  }]) assert.throws(() => expandClips(fixture(), [request]));
  assert.throws(() => expandClips(fixture(), {}));
  assert.throws(() => expandClips(fixture(), ['idle', 'idle']));
  let s = fixture();
  s.bones.find(b => b.id === 'armRight').limits = [-0.1, 0.1];
  assert.throws(() => expandClips(s, ['attack']), {
    code: 'JOINT_LIMIT'
  });
  assert.throws(() => expandClips(fixture(), [{
    family: 'attack',
    events: [{
      id: 'impact',
      name: 'other',
      time: 0.2
    }]
  }]));
});
test('rest rotations and timing are canonical and errors do not mutate input', () => {
  const s = fixture();
  s.bones.find(b => b.id === 'armRight').rest.rotation = .2;
  const c = expandClips(s, [{
    family: 'attack',
    duration: 4
  }]).animations[0];
  assert.equal(c.tracks.find(t => t.bone === 'armRight').keys[0].value, .2);
  assert.equal(c.tracks.find(t => t.bone === 'armRight').keys[2].value, 1.1);
  assert.equal(c.events[0].time, 2);
  assert.equal(c.tracks[0].keys.at(-1).time, 4);
  const before = JSON.stringify(s);
  assert.throws(() => expandClips(s, [{
    family: 'idle',
    events: [{
      id: 'later',
      name: 'cue',
      time: 1
    }, {
      id: 'later',
      name: 'cue',
      time: .2
    }]
  }]));
  assert.equal(JSON.stringify(s), before);
});
test('request boundaries and event order are deterministic', () => {
  for (const r of [{
    family: 'idle',
    id: '../bad'
  }, {
    family: 'idle',
    amplitude: 0
  }, {
    family: 'idle',
    amplitude: 11
  }, {
    family: 'idle',
    duration: 601
  }, {
    family: 'idle',
    events: {}
  }, [], 5]) assert.throws(() => expandClips(fixture(), [r]));
  assert.throws(() => expandClips(fixture(), Array(1001).fill('idle')));
  const c = expandClips(fixture(), [{
    family: 'attack',
    events: [{
      id: 'end',
      name: 'end',
      time: .8
    }, {
      id: 'start',
      name: 'start',
      time: 0
    }]
  }]).animations[0];
  assert.deepEqual(c.events.map(e => e.id), ['start', 'impact', 'end']);
  const names = listClipFamilies();
  names.push('fake');
  assert.equal(listClipFamilies().length, 12);
  assert.deepEqual(expandClips(fixture(), []).animations, []);
});
