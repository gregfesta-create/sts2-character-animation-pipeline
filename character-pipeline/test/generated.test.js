'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {
  generated
} = require('../providers/generated');
const {runImageOperation} = require('../lib/image-tools');
const {pythonTestTools} = require('./support/python-tool');
function fixturePng(value = 0, width = 64, height = 64) {
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]);
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    body.copy(result, 4);
    result.writeUInt32BE(zlib.crc32(body), result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4 + 1;
  const pixels = Buffer.alloc(height * stride, value);
  for (let y = 0; y < height; y++) pixels[y * stride] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const spec = {
  id: 'robot',
  canvas: {
    width: 64,
    height: 64
  },
  style: {
    palette: ['blue'],
    shading: 'painted'
  },
  artwork: {
    provider: 'comfyui',
    prompt: 'repair robot',
    seed: 42,
    negativePrompt: 'blur',
    settings: {
      steps: 8,
      cfg: 2
    }
  },
  parts: [{
    id: 'arm',
    role: 'left_arm',
    pivot: [12, 24]
  }]
};
async function fixture(t) {
  const scratch = path.resolve(__dirname, '../../.tmp/character-pipeline-tests');
  await fs.mkdir(scratch, {
    recursive: true
  });
  const root = await fs.mkdtemp(path.join(scratch, 'generated-'));
  t.after(() => fs.rm(root, {
    recursive: true,
    force: true
  }));
  const concept = path.join(root, 'concept.png');
  await fs.writeFile(concept, fixturePng());
  const calls = [];
  const context = {
    selected: spec.parts,
    config: {
      sourceRoots: [root],
      tools: pythonTestTools()
    },
    concept: {
      path: concept,
      hash: hash(fixturePng()),
      approved: true
    },
    fail: (code, message) => Object.assign(new Error(message), {
      code
    }),
    source: async file => {
      if (!path.resolve(file).startsWith(root + path.sep)) throw Object.assign(Error('unsafe'), {
        code: 'UNSAFE_PATH'
      });
      return file;
    },
    directory: async name => {
      const folder = path.join(root, name);
      await fs.mkdir(folder, {
        recursive: true
      });
      return folder;
    },
    output: async file => {
      if (!path.resolve(file).startsWith(root + path.sep)) throw Object.assign(Error('unsafe'), {
        code: 'UNSAFE_PATH'
      });
      await fs.stat(file);
      return file;
    },
    createComfyProvider: options => {
      calls.push({
        options
      });
      return {
        run: async request => {
          calls.push({
            request
          });
          const output = path.join(options.stagingDir, 'generated.png');
          await fs.mkdir(options.stagingDir, {
            recursive: true
          });
          const bytes = fixturePng(1, request.width, request.height);
          await fs.writeFile(output, bytes);
          return {
            images: [{
              path: output,
              width: request.width,
              height: request.height,
              sha256: hash(bytes)
            }],
            provenance: {
              seed: request.seed
            },
            receipt: {
              requestHash: 'hash',
              promptId: 'owned'
            }
          };
        }
      };
    }
  };
  return {
    root,
    calls,
    context
  };
}
test('unapproved or modified concept blocks all downstream generation', async t => {
  const f = await fixture(t);
  for (const concept of [undefined, {
    ...f.context.concept,
    approved: false
  }, {
    ...f.context.concept,
    hash: '0'.repeat(64)
  }]) await assert.rejects(generated(spec, {
    ...f.context,
    concept
  }), {
    code: concept?.approved ? 'CORRUPT_ARTIFACT' : 'APPROVAL_REQUIRED'
  });
  assert.equal(f.calls.length, 0);
});
test('semantic part uses approved reference, shared style and stable per-part seed with provenance', async t => {
  const f = await fixture(t);
  const first = await generated(spec, f.context);
  const request = f.calls.find(c => c.request).request;
  assert.equal(request.workflow, 'ipadapter');
  assert.match(request.prompt, /left_arm/);
  assert.match(request.prompt, /repair robot/);
  assert.match(request.prompt, /painted/);
  assert.match(request.prompt, /blue/);
  const normalized = await runImageOperation('inspect-raster', {input: f.context.concept.path}, {config: f.context.config, stagingDir: f.root});
  assert.deepEqual(await fs.readFile(request.reference.path), await fs.readFile(normalized.image.path));
  assert.equal(first[0].generation.identity.paddedConditioningHash, hash(await fs.readFile(request.reference.path)));
  assert.deepEqual(first[0].pivot, [12, 24]);
  assert.equal(first[0].generation.conceptHash, f.context.concept.hash);
  assert.equal(first[0].generation.receipt.promptId, 'owned');
  assert.equal(first[0].generation.workflow, 'ipadapter');
  const second = await generated(spec, {
    ...f.context,
    directory: async name => {
      const folder = path.join(f.root, 'again', name);
      await fs.mkdir(folder, {
        recursive: true
      });
      return folder;
    }
  });
  assert.equal(second[0].generation.seed, first[0].generation.seed);
});
test('missing semantic identity and incomplete repaint inputs fail before client creation', async t => {
  const f = await fixture(t);
  for (const part of [{
    id: 'arm',
    pivot: [0, 0]
  }, {
    id: 'arm',
    role: 'arm',
    pivot: [0, 0],
    mask: {
      path: 'missing'
    }
  }, {
    id: '../arm',
    role: 'arm',
    pivot: [0, 0]
  }]) await assert.rejects(generated({
    ...spec,
    parts: [part]
  }, {
    ...f.context,
    selected: [part]
  }));
  assert.equal(f.calls.length, 0);
});
test('explicit repaint converts mask then strictly composites original pixels and preserves provenance', async t => {
  const f = await fixture(t);
  const original = path.join(f.root, 'original.png'),
    paint = path.join(f.root, 'paint.png');
  await fs.writeFile(original, fixturePng(3));
  await fs.writeFile(paint, fixturePng());
  const part = {
    ...spec.parts[0],
    image: {
      path: original,
      pixelsPerUnit: 2
    },
    mask: {
      path: paint
    }
  };
  const operations = [];
  let checkpointIdentity;
  const result = await generated({
    ...spec,
    parts: [part]
  }, {
    ...f.context,
    selected: [part],
    checkpointForPart: async (id, identity) => {
      checkpointIdentity = {
        id,
        identity
      };
      return {
        load: async () => null,
        save: async () => {}
      };
    },
    scheduler: {
      schedule: async (resource, fn) => {
        assert.equal(resource, 'gpu');
        return fn();
      }
    },
    runImageOperation: async (action, request, options) => {
      if (['inspect-raster', 'pad-raster', 'crop-raster'].includes(action)) return runImageOperation(action, request, options);
      operations.push({
        action,
        request
      });
      const output = path.join(options.stagingDir, action + '.png');
      await fs.copyFile(action === 'mask' ? request.input : request.original, output);
      return {
        image: {
          path: output,
          width: 64,
          height: 64
        },
        preservedUnmasked: action === 'composite'
      };
    }
  });
  assert.deepEqual(operations.map(op => op.action), ['mask', 'mask', 'composite']);
  assert.deepEqual(await fs.readFile(result[0].input), await fs.readFile(original));
  const request = f.calls.find(c => c.request).request;
  assert.equal(request.workflow, 'inpainting');
  assert.ok(request.mask.path.endsWith('mask.png'));
  assert.equal(request.reference, undefined);
  assert.equal(result[0].pixelsPerUnit, 2);
  assert.equal(result[0].generation.preservedUnmasked, true);
  assert.equal(checkpointIdentity.id, 'arm');
  assert.equal(checkpointIdentity.identity.originalHash, hash(fixturePng(3)));
  assert.ok(f.calls[0].options.checkpoint);
});
test('escaped, missing, incorrectly sized or corrupted generated outputs cannot become worker inputs', async t => {
  for (const kind of ['escape', 'missing', 'dimensions', 'hash']) {
    const f = await fixture(t);
    const factory = options => ({
      run: async () => {
        const file = path.join(options.stagingDir, 'output.png');
        await fs.mkdir(options.stagingDir, {
          recursive: true
        });
        await fs.writeFile(file, fixturePng());
        return {
          images: kind === 'missing' ? [] : [{
            path: kind === 'escape' ? path.resolve(f.root, '..', 'foreign.png') : file,
            width: kind === 'dimensions' ? 32 : 64,
            height: 64,
            sha256: kind === 'hash' ? '0'.repeat(64) : hash(fixturePng())
          }]
        };
      }
    });
    await assert.rejects(generated(spec, {
      ...f.context,
      createComfyProvider: factory
    }));
  }
});
test('cancelled or oversized requests and absent repaint preservation fail clearly', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(generated(spec, {
    ...f.context,
    signal: controller.signal
  }), {
    code: 'ABORTED'
  });
  await assert.rejects(generated({
    ...spec,
    artwork: {
      ...spec.artwork,
      prompt: 'x'.repeat(4096)
    }
  }, f.context), {
    code: 'INVALID_INPUT'
  });
  const original = path.join(f.root, 'original.png');
  await fs.writeFile(original, fixturePng());
  const part = {
    ...spec.parts[0],
    image: {
      path: original
    },
    mask: {
      path: original
    }
  };
  await assert.rejects(generated({
    ...spec,
    parts: [part]
  }, {
    ...f.context,
    selected: [part],
    runImageOperation: async (action, _request, options) => {
      if (['inspect-raster', 'pad-raster', 'crop-raster'].includes(action)) return runImageOperation(action, _request, options);
      const target = path.join(options.stagingDir, action + '.png');
      await fs.writeFile(target, fixturePng());
      return {
        image: {
          path: target
        },
        preservedUnmasked: false
      };
    }
  }), {
    code: 'SEMANTIC_PART_OUTPUT'
  });
});
test('part seed and checkpoint identity are independent of selection order and work directories', async t => {
  const f = await fixture(t);
  const second = {
    ...spec.parts[0],
    id: 'leg',
    role: 'left_leg'
  };
  const input = {
    ...spec,
    parts: [spec.parts[0], second]
  };
  const combined = await generated(input, {
    ...f.context,
    selected: input.parts
  });
  const alone = await generated(input, {
    ...f.context,
    selected: [second],
    directory: async name => {
      const folder = path.join(f.root, 'alone', name);
      await fs.mkdir(folder, {
        recursive: true
      });
      return folder;
    }
  });
  assert.equal(alone[0].generation.seed, combined[1].generation.seed);
  assert.notEqual(combined[0].generation.seed, combined[1].generation.seed);
  assert.deepEqual(alone[0].generation.identity, combined[1].generation.identity);
});
test('approved JPEG original is preserved while trusted preview normalizes only its conditioning copy', async t => {
  const f = await fixture(t);
  const original = path.join(f.root, 'original-art.jpg');
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 255, 217]);
  await fs.writeFile(original, jpeg);
  let previewCalls = 0;
  const result = await generated(spec, {
    ...f.context,
    concept: {
      path: original,
      hash: hash(jpeg),
      approved: true
    },
    runImageOperation: async (action, request, options) => {
      if (['inspect-raster', 'pad-raster', 'crop-raster'].includes(action)) return runImageOperation(action, request, options);
      assert.equal(action, 'preview');
      assert.deepEqual(await fs.readFile(request.input), jpeg);
      previewCalls++;
      const output = path.join(options.stagingDir, 'reference-preview.png');
      await fs.writeFile(output, fixturePng());
      return {
        image: {
          path: output,
          width: 64,
          height: 64
        }
      };
    }
  });
  assert.equal(previewCalls, 1);
  assert.deepEqual(await fs.readFile(original), jpeg);
  const request = f.calls.find(call => call.request).request;
  const normalized = await runImageOperation('inspect-raster', {input: path.join(f.root, 'generated-arm', 'reference-preview.png')}, {config: f.context.config, stagingDir: f.root});
  assert.deepEqual(await fs.readFile(request.reference.path), await fs.readFile(normalized.image.path));
  assert.equal(result[0].generation.conceptHash, hash(jpeg));
  assert.equal(result[0].generation.conditioningHash, hash(fixturePng()));
});

test('source raster generation pads odd approved dimensions without changing combat registration', async t => {
  const f = await fixture(t);
  const bytes = fixturePng(8, 67, 71);
  await fs.writeFile(f.context.concept.path, bytes);
  f.context.concept.hash = hash(bytes);
  let identity;
  const output = await generated({...spec, canvas: {width: 23, height: 29}}, {
    ...f.context,
    checkpointForPart: async (_id, value) => { identity = value; },
    createComfyProvider: options => ({run: async request => {
      assert.equal(request.width, 72);
      assert.equal(request.height, 72);
      const file = path.join(options.stagingDir, 'output.png');
      await fs.mkdir(options.stagingDir, {recursive: true});
      const padded = fixturePng(9, request.width, request.height);
      await fs.writeFile(file, padded);
      return {images: [{path: file, width: request.width, height: request.height, sha256: hash(padded)}]};
    }})
  });
  assert.deepEqual(output[0].pivot, [12, 24]);
  assert.deepEqual(identity.raster.sourceSize, {width: 67, height: 71});
  assert.deepEqual(identity.raster.paddedSize, {width: 72, height: 72});
  assert.deepEqual(identity.raster.offset, {x: 0, y: 0});
  assert.equal(identity.raster.policyVersion, 1);
  const final = await fs.readFile(output[0].input);
  assert.equal(final.readUInt32BE(16), 67);
  assert.equal(final.readUInt32BE(20), 71);
});

test('real worker repaint roundtrip preserves original 1312x1199 pixels and source identity before checkpoint', async t => {
  const f = await fixture(t);
  const original = path.join(f.root, 'bird.png'), mask = path.join(f.root, 'paint.png');
  await fs.writeFile(original, fixturePng(37, 1312, 1199));
  await fs.writeFile(mask, fixturePng(0, 1312, 1199));
  const part = {...spec.parts[0], pivot: [812.75, 1109.125], image: {path: original, pixelsPerUnit: 1199 / 162}, mask: {path: mask}};
  const identities = [];
  const operations = [];
  const context = {...f.context, selected: [part],
    runImageOperation: async (action, request, options) => {
      operations.push(action);
      return runImageOperation(action, request, options);
    },
    checkpointForPart: async (_id, identity) => {
      assert.ok(operations.includes('pad-raster'));
      assert.equal(f.calls.length, 0);
      identities.push(identity);
    }
  };
  const input = {...spec, canvas: {width: 225, height: 226}, parts: [part]};
  const result = await generated(input, context);
  const request = f.calls.find(c => c.request).request;
  assert.deepEqual([request.width, request.height], [1312, 1200]);
  assert.deepEqual(result[0].pivot, part.pivot);
  assert.equal(result[0].pixelsPerUnit, part.image.pixelsPerUnit);
  assert.equal(result[0].generation.preservedUnmasked, true);
  const normalized = await runImageOperation('inspect-raster', {input: original}, {config: context.config, stagingDir: f.root});
  assert.deepEqual(await fs.readFile(result[0].input), await fs.readFile(normalized.image.path));
  assert.equal(identities[0].originalHash, hash(await fs.readFile(original)));
  assert.equal(identities[0].maskHash, hash(await fs.readFile(mask)));
  assert.deepEqual(identities[0].raster.sourceSize, {width: 1312, height: 1199});
  assert.deepEqual(identities[0].raster.paddedSize, {width: 1312, height: 1200});
  assert.deepEqual(identities[0].raster.offset, {x: 0, y: 0});
  assert.ok(operations.indexOf('crop-raster') < operations.indexOf('composite'));
  const firstIdentity = result[0].generation.identity;
  await fs.writeFile(mask, fixturePng(1, 1312, 1199));
  f.calls.length = 0;
  const changed = await generated(input, context);
  assert.notEqual(changed[0].generation.identity.maskHash, firstIdentity.maskHash);
  await fs.writeFile(original, fixturePng(38, 1312, 1199));
  f.calls.length = 0;
  const changedOriginal = await generated(input, context);
  assert.notEqual(changedOriginal[0].generation.identity.originalHash, firstIdentity.originalHash);
});

test('source bounds and mismatched paint reject before model or checkpoint', async t => {
  for (const [width, height, maskWidth] of [[4097, 1, 4097], [4000, 4001, 4000], [67, 71, 66]]) {
    const f = await fixture(t);
    const original = path.join(f.root, 'source.png'), mask = path.join(f.root, 'paint.png');
    await fs.writeFile(original, fixturePng(4, width, height));
    await fs.writeFile(mask, fixturePng(0, maskWidth, height));
    const part = {...spec.parts[0], image: {path: original}, mask: {path: mask}};
    let checkpoints = 0;
    await assert.rejects(generated({...spec, parts: [part]}, {...f.context, selected: [part], checkpointForPart: () => {checkpoints++;}}));
    assert.equal(checkpoints, 0);
    assert.equal(f.calls.length, 0);
  }
});

test('tiny source pads to model minimum and actual output size is decoded before crop', async t => {
  const f = await fixture(t);
  const original = fixturePng(11, 1, 3);
  await fs.writeFile(f.context.concept.path, original);
  f.context.concept.hash = hash(original);
  const result = await generated({...spec, canvas: {width: 9, height: 13}}, f.context);
  const request = f.calls.find(c => c.request).request;
  assert.deepEqual([request.width, request.height], [64, 64]);
  const image = await fs.readFile(result[0].input);
  assert.deepEqual([image.readUInt32BE(16), image.readUInt32BE(20)], [1, 3]);
  await assert.rejects(generated(spec, {...f.context, createComfyProvider: options => ({run: async () => {
    const file = path.join(options.stagingDir, 'lying.png');
    await fs.mkdir(options.stagingDir, {recursive: true});
    const bytes = fixturePng(3, 63, 64);
    await fs.writeFile(file, bytes);
    return {images: [{path: file, width: 64, height: 64, sha256: hash(bytes)}]};
  }})}), /Generated raster dimensions differ/);
});

test('malformed source mapping is rejected before checkpoint and GPU work', async t => {
  for (const mutate of [
    value => {value.raster.sourceSize.width = 0;},
    value => {value.raster.sourceSize.height = 63;},
    value => {value.raster.paddedSize.width = 72; value.image.width = 72;},
    value => {value.raster.offset.x = 1;},
    value => {value.image.width = 63;}
  ]) {
    const f = await fixture(t);
    let checkpoints = 0;
    await assert.rejects(generated(spec, {...f.context,
      checkpointForPart: () => {checkpoints++;},
      runImageOperation: async (action, request, options) => {
        const value = await runImageOperation(action, request, options);
        if (action === 'pad-raster') mutate(value);
        return value;
      }
    }), {code: 'INVALID_WORKER_OUTPUT'});
    assert.equal(checkpoints, 0);
    assert.equal(f.calls.length, 0);
  }
});
