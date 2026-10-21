'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  createSpec
} = require('../../lib/spec');
const {
  compileGodot
} = require('../../backends/godot');
async function main() {
  const out = path.resolve(__dirname, '../../evidence/w2-godot/native');
  await fs.mkdir(out, {
    recursive: true
  });
  // Controlled 4x4 RGBA solid-color PNG, expanded to a strip by its mesh.
  const chunk = (type, data) => {
    const b = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of b) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(b.length + 8);
    result.writeUInt32BE(data.length);
    b.copy(result, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.alloc(68);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const i = y * 17 + 1 + x * 4;
    rows[i] = x % 2 ? 255 : 30;
    rows[i + 1] = y % 2 ? 230 : 60;
    rows[i + 2] = 80;
    rows[i + 3] = 255;
  }
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', require('node:zlib').deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  await fs.writeFile(path.join(out, 'strip.png'), png);
  const spec = createSpec({
    id: 'strip',
    description: 'synthetic skeletal strip',
    template: 'custom'
  });
  spec.bones = [{
    id: 'root',
    parent: null,
    rest: {
      position: [64, 128],
      rotation: 0,
      scale: [1, 1]
    },
    length: 64
  }, {
    id: 'tip',
    parent: 'root',
    rest: {
      position: [64, 0],
      rotation: 0,
      scale: [1, 1]
    },
    length: 64,
    limits: [-1, 1]
  }];
  spec.parts = [{
    id: 'strip',
    role: 'root',
    bone: 'root',
    pivot: [0, 2],
    layer: 0,
    image: {
      path: path.join(out, 'strip.png'),
      width: 4,
      height: 4,
      prepared: true,
      alphaBounds: [0, 0, 4, 4],
      cropTranslation: [0, 0],
      pivot: [0, 2],
      pixelsPerUnit: 1
    },
    mesh: {
      vertices: [[64, 116], [128, 116], [192, 116], [64, 140], [128, 140], [192, 140]],
      uv: [[0, 0], [2, 0], [4, 0], [0, 4], [2, 4], [4, 4]],
      triangles: [[0, 1, 3], [1, 4, 3], [1, 2, 4], [2, 5, 4]],
      weights: [[{
        bone: 'root',
        weight: 1
      }], [{
        bone: 'root',
        weight: 0.5
      }, {
        bone: 'tip',
        weight: 0.5
      }], [{
        bone: 'tip',
        weight: 1
      }], [{
        bone: 'root',
        weight: 1
      }], [{
        bone: 'root',
        weight: 0.5
      }, {
        bone: 'tip',
        weight: 0.5
      }], [{
        bone: 'tip',
        weight: 1
      }]]
    }
  }];
  spec.animations = ['idle', 'attack', 'hit', 'death'].map(id => ({
    id,
    duration: 1,
    loop: id === 'idle',
    events: [],
    tracks: [{
      bone: 'tip',
      property: 'rotation',
      keys: [{
        time: 0,
        value: 0
      }, {
        time: 0.5,
        value: 0.7
      }, {
        time: 1,
        value: 0
      }]
    }]
  }));
  spec.parts[0].mesh.vertices = spec.parts[0].mesh.vertices.map(([x, y]) => [x - 64, y - 114]);
  const config = require('../../config/local.tools.json');
  if (process.argv.includes('--regression')) {
    const transformed = structuredClone(spec);
    transformed.bones[0].rest = {
      position: [64, 128],
      rotation: Math.PI / 2,
      scale: [2, 3]
    };
    transformed.bones[1].rest = {
      position: [10, 0],
      rotation: 0,
      scale: [1, 2]
    };
    transformed.parts[0].id = 'root';
    transformed.parts[0].bone = 'tip';
    transformed.parts[0].image.pivot = [0, 0];
    transformed.parts[0].mesh = {
      vertices: [[0, 0], [1, 0], [0, 1]],
      uv: [[0, 0], [1, 0], [0, 1]],
      triangles: [[0, 1, 2]],
      weights: Array.from({
        length: 3
      }, () => [{
        bone: 'tip',
        weight: 1
      }])
    };
    transformed.animations = [];
    const {
      runTool
    } = require('../../lib/process');
    const result = await compileGodot(transformed, {
      config,
      stagingDir: path.join(out, 'transform-regression'),
      runTool: (registry, name, args, options) => runTool(registry, name, args, {
        ...options,
        timeoutMs: 8000
      })
    });
    const assert = require('node:assert/strict');
    const mesh = result.validation.meshes[0];
    assert.equal(mesh.path, 'Meshes/root');
    const expected = [[64, 148], [64, 150], [58, 148]];
    for (let i = 0; i < 3; i++) for (let axis = 0; axis < 2; axis++) assert(Math.abs(mesh.positions[i][axis] - expected[i][axis]) < .0001);
    console.log(JSON.stringify(result.validation));
    return;
  }
  const result = await compileGodot(spec, {
    config,
    stagingDir: out,
    render: process.argv.includes('--render')
  });
  const assert = require('node:assert/strict');
  const sceneText = await fs.readFile(result.scene, 'utf8');
  assert.equal(sceneText.includes(out), false);
  assert.equal(/(?:"[A-Za-z]:[\\/]|file:\/\/)/.test(sceneText), false);
  const relocated = await fs.mkdtemp(path.join(out, 'relocated-'));
  await fs.cp(result.project, relocated, {
    recursive: true
  });
  await fs.copyFile(path.join(__dirname, 'startup_probe.gd'), path.join(relocated, 'startup_probe.gd'));
  const executable = config.tools.megadot.executable;
  const {
    runTool
  } = require('../../lib/process');
  const playback = await runTool({
    megadot: {
      executable,
      cwd: path.dirname(executable)
    }
  }, 'megadot', ['--headless', '--path', relocated, '--log-file', path.join(relocated, 'main-scene.log'), '--script', 'res://startup_probe.gd'], {
    timeoutMs: 30000
  });
  assert.equal(playback.error, null, JSON.stringify(playback));
  assert.doesNotMatch(playback.stdout + playback.stderr, /ERROR:|SCRIPT ERROR/);
  const startup = JSON.parse(await fs.readFile(path.join(relocated, 'startup-validation.json')));
  assert.equal(startup.valid, true);
  await fs.writeFile(path.join(out, 'relocation-validation.json'), JSON.stringify({
    valid: true,
    relative: result.relative,
    mainSceneExitCode: playback.exitCode,
    startup
  }, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv.includes('--run')) main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
