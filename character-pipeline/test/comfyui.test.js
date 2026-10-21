'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  createComfyProvider
} = require('../providers/comfyui');
function nodes() {
  const defs = {
    CheckpointLoaderSimple: [{
      ckpt_name: ['model.safetensors']
    }, ['MODEL', 'CLIP', 'VAE']],
    EmptyLatentImage: [{
      width: 'INT',
      height: 'INT',
      batch_size: 'INT'
    }, ['LATENT']],
    CLIPTextEncode: [{
      text: 'STRING',
      clip: 'CLIP'
    }, ['CONDITIONING']],
    KSampler: [{
      model: 'MODEL',
      seed: 'INT',
      steps: 'INT',
      cfg: 'FLOAT',
      sampler_name: ['dpmpp_sde'],
      scheduler: ['karras'],
      positive: 'CONDITIONING',
      negative: 'CONDITIONING',
      latent_image: 'LATENT',
      denoise: 'FLOAT'
    }, ['LATENT']],
    VAEDecode: [{
      samples: 'LATENT',
      vae: 'VAE'
    }, ['IMAGE']],
    SaveImage: [{
      images: 'IMAGE',
      filename_prefix: 'STRING'
    }, []],
    LoadImage: [{
      image: ['uploaded.png']
    }, ['IMAGE', 'MASK']],
    VAEEncode: [{
      pixels: 'IMAGE',
      vae: 'VAE'
    }, ['LATENT']],
    SetLatentNoiseMask: [{
      samples: 'LATENT',
      mask: 'MASK'
    }, ['LATENT']],
    IPAdapterModelLoader: [{
      ipadapter_file: ['ip-adapter-plus_sdxl_vit-h.safetensors']
    }, ['IPADAPTER']],
    CLIPVisionLoader: [{
      clip_name: ['CLIP-ViT-H-14.safetensors']
    }, ['CLIP_VISION']],
    IPAdapterAdvanced: [{
      model: 'MODEL',
      ipadapter: 'IPADAPTER',
      image: 'IMAGE',
      weight: 'FLOAT',
      weight_type: ['linear'],
      combine_embeds: ['concat'],
      start_at: 'FLOAT',
      end_at: 'FLOAT',
      embeds_scaling: ['V only'],
      clip_vision: 'CLIP_VISION'
    }, ['MODEL']]
  };
  const result = Object.fromEntries(Object.entries(defs).map(([name, [inputs, output]]) => [name, {
    input: {
      required: Object.fromEntries(Object.entries(inputs).map(([key, type]) => [key, [type]]))
    },
    output
  }]));
  result.SaveImage.output_node = true;
  return result;
}
const zlib = require('node:zlib');
function pngFixture({
  width = 64,
  height = 64,
  value = 0,
  filter = 0
} = {}) {
  const chunk = (name, data) => {
    const type = Buffer.from(name);
    const result = Buffer.alloc(12 + data.length);
    result.writeUInt32BE(data.length);
    type.copy(result, 4);
    data.copy(result, 8);
    result.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])), 8 + data.length);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4), value);
  for (let y = 0; y < height; y++) pixels[y * (1 + width * 4)] = filter;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const png = pngFixture();
const request = {
  workflow: 'generation',
  prompt: 'synthetic test only',
  seed: 42,
  width: 64,
  height: 64
};
async function setup(t, behavior = {}) {
  const scratch = path.resolve(__dirname, '../../.tmp/character-pipeline-tests');
  await fs.mkdir(scratch, {
    recursive: true
  });
  const root = await fs.mkdtemp(path.join(scratch, 'comfy-test-'));
  t.after(() => fs.rm(root, {
    recursive: true,
    force: true
  }));
  const config = {
    tools: {},
    sourceRoots: [root],
    comfyui: {
      url: 'http://127.0.0.1:8197',
      checkpoint: 'model.safetensors',
      modelFamily: 'sdxl',
      pollIntervalMs: 1,
      maxPolls: 3,
      // Semantic tests include checkpoint IO under coverage; deadline tests
      // below explicitly select short budgets for their timeout assertions.
      timeoutMs: 1000,
      maxResponseBytes: 8192
    }
  };
  let submitted;
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({
      url,
      options
    });
    const route = new URL(url).pathname;
    if (behavior.fetch) {
      const special = await behavior.fetch(route, options, submitted);
      if (special) return special;
    }
    if (route === '/system_stats') return Response.json({
      system: {},
      devices: []
    });
    if (route === '/object_info') return Response.json(behavior.nodes || nodes());
    if (route === '/prompt') {
      submitted = JSON.parse(options.body);
      if (behavior.ambiguous) throw Error('connection lost after accepted');
      return Response.json({
        prompt_id: 'owned-id'
      });
    }
    if (route.startsWith('/history')) {
      if (behavior.noHistory) return Response.json({});
      const prompt = submitted ? [1, 'owned-id', submitted.prompt, submitted.extra_data, ['7']] : null;
      return Response.json(prompt ? {
        'owned-id': {
          prompt,
          outputs: {
            '7': {
              images: [{
                filename: submitted.extra_data.pipeline_marker + '_00001_.png',
                subfolder: '',
                type: 'output'
              }]
            }
          },
          status: {
            completed: true,
            status_str: behavior.failed ? 'error' : 'success'
          }
        }
      } : {});
    }
    if (route === '/queue') return Response.json({
      queue_running: [],
      queue_pending: []
    });
    if (route === '/view') return new Response(behavior.png || png);
    if (route === '/upload/image') return Response.json({
      name: 'uploaded.png',
      subfolder: '',
      type: 'input'
    });
    throw Error('unexpected ' + route);
  };
  return {
    root,
    config,
    calls,
    fetch,
    stagingDir: path.join(root, 'stage')
  };
}
test('trusted generation records deterministic seed, owned receipt and bounded image bytes', async t => {
  const f = await setup(t);
  const result = await createComfyProvider(f).run(request);
  assert.equal(result.images.length, 1);
  assert.equal(result.provenance.seed, 42);
  assert.equal(result.receipt.promptId, 'owned-id');
  const post = JSON.parse(f.calls.find(c => c.url.endsWith('/prompt')).options.body);
  assert.equal(post.prompt['5'].inputs.seed, 42);
  assert.ok(await fs.stat(result.images[0].path));
  assert.equal(post.extra_data.client_id, result.receipt.clientId);
});
test('capability rejection and invalid endpoints never submit', async t => {
  for (const change of [f => delete f.config.comfyui, f => f.config.comfyui.url = 'https://example.com', f => f.config.comfyui.url = 'http://user:secret@localhost', f => f.config.comfyui.checkpoint = 'absent']) {
    const f = await setup(t);
    change(f);
    await assert.rejects(createComfyProvider(f).run(request));
    assert.equal(f.calls.some(c => c.url.endsWith('/prompt')), false);
  }
});
test('ambiguous submission reconciles owned history without duplicate generation', async t => {
  const f = await setup(t, {
    ambiguous: true
  });
  const provider = createComfyProvider(f);
  const result = await provider.run(request);
  assert.equal(result.receipt.promptId, 'owned-id');
  await provider.run(request);
  assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 1);
});
test('unresolved ambiguity never retries POST, failed or missing outputs cannot pass', async t => {
  for (const behavior of [{
    ambiguous: true,
    noHistory: true
  }, {
    failed: true
  }, {
    png: Buffer.from('not a png')
  }]) {
    const f = await setup(t, behavior);
    const provider = createComfyProvider(f);
    await assert.rejects(provider.run(request));
    if (behavior.ambiguous) await assert.rejects(provider.run(request));
    assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 1);
  }
});
test('PNG validation rejects corrupted CRC, truncated streams, invalid filters and wrong dimensions', async t => {
  const corrupt = Buffer.from(png);
  corrupt[45] ^= 1;
  for (const bytes of [corrupt, png.subarray(0, png.length - 12), pngFixture({
    filter: 5
  }), pngFixture({
    width: 32
  }), Buffer.concat([png, Buffer.from('trailing')])]) {
    const f = await setup(t, {
      png: bytes
    });
    await assert.rejects(createComfyProvider(f).run(request), error => ['IMAGE_INVALID', 'IMAGE_LIMIT'].includes(error.code));
  }
});
test('source bytes identify reference jobs and source mutations cannot resume an old output', async t => {
  const f = await setup(t);
  const file = path.join(f.root, 'reference.png');
  await fs.writeFile(file, png);
  const provider = createComfyProvider(f);
  const input = {
    ...request,
    workflow: 'ipadapter',
    reference: {
      path: file
    }
  };
  const first = await provider.run(input);
  assert.equal(first.provenance.uploads.reference.sha256, require('node:crypto').createHash('sha256').update(png).digest('hex'));
  await fs.writeFile(file, pngFixture({
    value: 10
  }));
  await assert.rejects(provider.run(input), {
    code: 'RECEIPT_MISMATCH'
  });
  assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 1);
});
test('cancelled receipts cannot silently return completed work', async t => {
  const f = await setup(t);
  const first = await createComfyProvider(f).run(request);
  await fs.writeFile(path.join(f.stagingDir, 'comfy-receipt.json'), JSON.stringify({
    ...first.receipt,
    status: 'cancelled'
  }));
  await assert.rejects(createComfyProvider(f).run(request), {
    code: 'ABORTED'
  });
});
test('trusted supplied-image graphs use uploaded references and mask alpha without arbitrary graph injection', async t => {
  for (const workflow of ['ipadapter', 'inpainting']) {
    const f = await setup(t);
    const input = path.join(f.root, 'source.png');
    await fs.writeFile(input, png);
    const requestWithSource = {
      ...request,
      workflow,
      ...(workflow === 'ipadapter' ? {
        reference: {
          path: input
        }
      } : {
        image: {
          path: input
        },
        mask: {
          path: input
        }
      })
    };
    const result = await createComfyProvider(f).run(requestWithSource);
    const posted = JSON.parse(f.calls.find(c => c.url.endsWith('/prompt')).options.body);
    if (workflow === 'ipadapter') {
      assert.equal(posted.prompt['11'].class_type, 'IPAdapterAdvanced');
      assert.deepEqual(posted.prompt['5'].inputs.model, ['11', 0]);
    } else {
      assert.equal(posted.prompt['11'].class_type, 'SetLatentNoiseMask');
      assert.deepEqual(posted.prompt['11'].inputs.mask, ['9', 1]);
      assert.equal(posted.prompt['4'], undefined);
    }
    assert.equal(Object.keys(result.provenance.uploads).length, workflow === 'ipadapter' ? 1 : 2);
    const form = f.calls.find(c => c.url.endsWith('/upload/image')).options.body;
    assert.deepEqual(Buffer.from(await form.get('image').arrayBuffer()), png);
    await assert.rejects(createComfyProvider({
      ...f,
      stagingDir: path.join(f.root, 'invalid')
    }).run({
      ...requestWithSource,
      graph: {
        evil: true
      }
    }), {
      code: 'INVALID_INPUT'
    });
  }
});
test('durable checkpoints resume completed work into another stage with identical source bytes at renamed paths', async t => {
  const f = await setup(t);
  const input = path.join(f.root, 'reference.png');
  await fs.writeFile(input, png);
  let saved;
  const checkpoint = {
    load: async () => saved,
    save: async receipt => {
      saved = structuredClone(receipt);
    }
  };
  const first = await createComfyProvider({
    ...f,
    checkpoint
  }).run({
    ...request,
    workflow: 'ipadapter',
    reference: {
      path: input
    }
  });
  const renamed = path.join(f.root, 'renamed.png');
  await fs.copyFile(input, renamed);
  const second = await createComfyProvider({
    ...f,
    checkpoint,
    stagingDir: path.join(f.root, 'new-stage')
  }).run({
    ...request,
    workflow: 'ipadapter',
    reference: {
      path: renamed
    }
  });
  assert.equal(second.receipt.requestHash, first.receipt.requestHash);
  assert.notEqual(second.images[0].path, first.images[0].path);
  assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 1);
});
test('preparing checkpoint interrupted during upload resumes safely without an earlier prompt', async t => {
  let failUpload = true;
  const f = await setup(t, {
    fetch: async route => {
      if (route === '/upload/image' && failUpload) {
        failUpload = false;
        return new Response('upload failed', {
          status: 500
        });
      }
    }
  });
  const source = path.join(f.root, 'reference.png');
  await fs.writeFile(source, png);
  const input = {
    ...request,
    workflow: 'ipadapter',
    reference: {
      path: source
    }
  };
  await assert.rejects(createComfyProvider(f).run(input), {
    code: 'HTTP_ERROR'
  });
  assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 0);
  assert.equal((await createComfyProvider(f).run(input)).receipt.status, 'completed');
  assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 1);
});
test('owned pending cancellation deletes only its prompt and never calls global interrupt', async t => {
  let pending;
  const f = await setup(t, {
    noHistory: true,
    fetch: async (route, options, submitted) => {
      if (route === '/queue' && options.method === 'GET' && submitted) return Response.json({
        queue_pending: pending ? [] : [[1, 'owned-id', submitted.prompt, submitted.extra_data, ['7']]],
        queue_running: [[2, 'foreign', {}, {
          client_id: 'someone-else'
        }, []]]
      });
      if (route === '/queue' && options.method === 'POST') {
        pending = JSON.parse(options.body);
        return Response.json({});
      }
    }
  });
  const provider = createComfyProvider(f);
  await assert.rejects(provider.run(request), {
    code: 'GENERATION_TIMEOUT'
  });
  assert.equal((await provider.cancel()).cancelled, true);
  assert.deepEqual(pending, {
    delete: ['owned-id']
  });
  assert.equal(f.calls.some(c => c.url.includes('/interrupt')), false);
  await assert.rejects(provider.run(request), {
    code: 'ABORTED'
  });
});
test('foreign histories, missing outputs and execution failures never download', async t => {
  for (const kind of ['foreign', 'missing', 'failed']) {
    const f = await setup(t, {
      fetch: async (route, _options, submitted) => {
        if (route.startsWith('/history') && submitted) {
          return Response.json({
            'owned-id': {
              prompt: [1, 'owned-id', submitted.prompt, kind === 'foreign' ? {} : submitted.extra_data, ['7']],
              outputs: {},
              status: {
                completed: true,
                status_str: kind === 'failed' ? 'error' : 'success'
              }
            }
          });
        }
      }
    });
    await assert.rejects(createComfyProvider(f).run(request), {
      code: kind === 'foreign' ? 'FOREIGN_PROMPT' : kind === 'failed' ? 'GENERATION_FAILED' : 'OUTPUT_MISSING'
    });
    assert.equal(f.calls.some(c => c.url.includes('/view')), false);
  }
});
test('explicit rejection is terminal and does not become ambiguous or retry POST', async t => {
  const f = await setup(t, {
    fetch: async route => route === '/prompt' ? Response.json({
      node_errors: {
        '5': {
          errors: ['bad model']
        }
      }
    }) : null
  });
  const provider = createComfyProvider(f);
  await assert.rejects(provider.run(request), {
    code: 'PROMPT_REJECTED'
  });
  await assert.rejects(createComfyProvider(f).run(request), {
    code: 'GENERATION_FAILED'
  });
  assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 1);
});
test('corrupt PNG compressed stream with valid chunk CRC and RGBA-less inpaint mask are rejected', async t => {
  const bad = Buffer.from(png);
  const start = 33;
  const length = bad.readUInt32BE(start);
  bad[start + 9] ^= 0xff;
  bad.writeUInt32BE(zlib.crc32(bad.subarray(start + 4, start + 8 + length)), start + 8 + length);
  const f = await setup(t, {
    png: bad
  });
  await assert.rejects(createComfyProvider(f).run(request), {
    code: 'IMAGE_INVALID'
  });
  const source = path.join(f.root, 'rgb.png');
  const rgb = pngFixture();
  rgb[25] = 2;
  rgb.writeUInt32BE(zlib.crc32(rgb.subarray(12, 29)), 29);
  await fs.writeFile(source, rgb);
  await assert.rejects(createComfyProvider({
    ...f,
    stagingDir: path.join(f.root, 'mask-stage')
  }).run({
    ...request,
    workflow: 'inpainting',
    image: {
      path: source
    },
    mask: {
      path: source
    }
  }));
});
test('PNG all standard filters decode and declared download limits are enforced', async t => {
  for (let filter = 0; filter <= 4; filter++) {
    const f = await setup(t, {
      png: pngFixture({
        filter
      })
    });
    assert.equal((await createComfyProvider(f).run(request)).images[0].width, 64);
  }
  const f = await setup(t, {
    fetch: async route => route === '/view' ? new Response(png, {
      headers: {
        'content-length': '67108865'
      }
    }) : null
  });
  await assert.rejects(createComfyProvider(f).run(request), {
    code: 'RESPONSE_LIMIT'
  });
});
test('hung headers/body are timed out and pre-cancelled requests never submit', async t => {
  for (const body of [false, true]) {
    const f = await setup(t, {
      fetch: async route => {
        if (route.startsWith('/history')) return body ? new Response(new ReadableStream({
          start() {}
        })) : new Promise(() => {});
      }
    });
    f.config.comfyui.timeoutMs = 10;
    await assert.rejects(createComfyProvider(f).run(request), {
      code: 'TIMEOUT'
    });
  }
  const f = await setup(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createComfyProvider({
    ...f,
    signal: controller.signal
  }).run(request), {
    code: 'ABORTED'
  });
  assert.equal(f.calls.length, 0);
});
test('ambiguous submission accepts only a unique owned queue receipt', async t => {
  for (const mode of ['owned', 'foreign', 'duplicate']) {
    const f = await setup(t, {
      ambiguous: true,
      noHistory: true,
      fetch: async (route, options, submitted) => {
        if (route === '/queue' && submitted) {
          const extra = mode === 'foreign' ? {
            client_id: 'foreign'
          } : submitted.extra_data;
          const tuple = [1, 'owned-id', submitted.prompt, extra, ['7']];
          return Response.json({
            queue_pending: mode === 'duplicate' ? [tuple, [2, 'other-id', submitted.prompt, extra, ['7']]] : [tuple],
            queue_running: []
          });
        }
      }
    });
    await assert.rejects(createComfyProvider(f).run(request), {
      code: mode === 'duplicate' ? 'SUBMISSION_AMBIGUOUS' : mode === 'foreign' ? 'SUBMISSION_UNKNOWN' : 'GENERATION_TIMEOUT'
    });
    assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 1);
  }
});
test('running and foreign jobs are never interrupted or removed by cancellation', async t => {
  const f = await setup(t, {
    noHistory: true,
    fetch: async (route, _options, submitted) => route === '/queue' && submitted ? Response.json({
      queue_running: [[1, 'owned-id', submitted.prompt, submitted.extra_data, ['7']]],
      queue_pending: [[2, 'foreign-id', {}, {}, []]]
    }) : null
  });
  const provider = createComfyProvider(f);
  assert.equal((await provider.cancel()).cancelled, false);
  await assert.rejects(provider.run(request), {
    code: 'GENERATION_TIMEOUT'
  });
  assert.equal((await provider.cancel()).cancelled, false);
  assert.equal(f.calls.filter(c => c.url.endsWith('/queue') && c.options.method === 'POST').length, 0);
});
test('missing workflow contracts, invalid resource budgets and malformed requests fail before submission', async t => {
  const badNodes = nodes();
  delete badNodes.SetLatentNoiseMask;
  const f = await setup(t, {
    nodes: badNodes
  });
  const source = path.join(f.root, 'image.png');
  await fs.writeFile(source, png);
  await assert.rejects(createComfyProvider(f).run({
    ...request,
    workflow: 'inpainting',
    image: {
      path: source
    },
    mask: {
      path: source
    }
  }), {
    code: 'CAPABILITY_MISSING'
  });
  for (const input of [{
    ...request,
    seed: -1
  }, {
    ...request,
    width: 65
  }, {
    ...request,
    steps: 0
  }, {
    ...request,
    cfg: NaN
  }, {
    ...request,
    denoise: 2
  }, {
    ...request,
    workflow: 'other'
  }, {
    ...request,
    prompt: ''
  }, {
    ...request,
    workflow: 'ipadapter'
  }, {
    ...request,
    height: 4096,
    width: 4096
  }]) await assert.rejects(createComfyProvider({
    ...f,
    stagingDir: path.join(f.root, 'bad')
  }).run(input), {
    code: 'INVALID_INPUT'
  });
  const g = await setup(t);
  g.config.comfyui.maxPolls = 0;
  await assert.rejects(createComfyProvider(g).run(request), {
    code: 'INVALID_INPUT'
  });
  assert.equal(f.calls.some(c => c.url.endsWith('/prompt')), false);
});
test('source escapes and invalid uploaded/server output receipts are rejected', async t => {
  const f = await setup(t);
  await assert.rejects(createComfyProvider(f).run({
    ...request,
    workflow: 'ipadapter',
    reference: {
      path: '../outside.png'
    }
  }), {
    code: 'UNSAFE_PATH'
  });
  for (const type of ['upload', 'output']) {
    const g = await setup(t, {
      fetch: async (route, _options, submitted) => {
        if (type === 'upload' && route === '/upload/image') return Response.json({
          name: '../escape',
          subfolder: '',
          type: 'input'
        });
        if (type === 'output' && route.startsWith('/history') && submitted) return Response.json({
          'owned-id': {
            prompt: [1, 'owned-id', submitted.prompt, submitted.extra_data, ['7']],
            status: {
              completed: true
            },
            outputs: {
              '7': {
                images: [{
                  filename: 'foreign.png',
                  type: 'output',
                  subfolder: ''
                }]
              }
            }
          }
        });
      }
    });
    const source = path.join(g.root, 'reference.png');
    await fs.writeFile(source, png);
    await assert.rejects(createComfyProvider(g).run(type === 'upload' ? {
      ...request,
      workflow: 'ipadapter',
      reference: {
        path: source
      }
    } : request), {
      code: type === 'upload' ? 'RESPONSE_INVALID' : 'FOREIGN_OUTPUT'
    });
  }
});
test('inflight cancellation aborts this client without globally interrupting the server', async t => {
  const controller = new AbortController();
  const f = await setup(t, {
    fetch: async route => {
      if (route.startsWith('/history')) {
        queueMicrotask(() => controller.abort());
        return new Promise(() => {});
      }
    }
  });
  await assert.rejects(createComfyProvider({
    ...f,
    signal: controller.signal
  }).run(request), {
    code: 'ABORTED'
  });
  assert.equal(f.calls.some(c => c.url.includes('/interrupt')), false);
});
test('streamed response quota and concurrent invocation fail with bounded diagnostics', async t => {
  const f = await setup(t, {
    fetch: async route => route.startsWith('/history') ? new Response('x'.repeat(8193)) : null
  });
  await assert.rejects(createComfyProvider(f).run(request), {
    code: 'RESPONSE_LIMIT'
  });
  let started;
  const ready = new Promise(resolve => started = resolve);
  const g = await setup(t, {
    fetch: async route => {
      if (route === '/history/owned-id') {
        started();
        return new Response(new ReadableStream({
          start() {}
        }));
      }
    }
  });
  g.config.comfyui.timeoutMs = 15;
  const provider = createComfyProvider(g);
  const pending = provider.run(request);
  await ready;
  await assert.rejects(provider.run(request), {
    code: 'JOB_BUSY'
  });
  await assert.rejects(pending, {
    code: 'TIMEOUT'
  });
});
test('cancel during outstanding history aborts local completion and confirms server removal', async t => {
  let historyReady,
    releaseHistory,
    deleted = false,
    historyRequests = 0;
  const ready = new Promise(resolve => historyReady = resolve);
  const outstanding = new Promise(resolve => releaseHistory = resolve);
  const f = await setup(t, {
    fetch: async (route, options, submitted) => {
      if (route === '/history/owned-id') {
        if (historyRequests++) return Response.json({});
        historyReady();
        return outstanding;
      }
      if (route === '/history') return Response.json({});
      if (route === '/queue') {
        if (options.method === 'POST') {
          deleted = true;
          return Response.json({});
        }
        return Response.json({
          queue_pending: deleted ? [] : [[1, 'owned-id', submitted.prompt, submitted.extra_data, ['7']]],
          queue_running: []
        });
      }
    }
  });
  const provider = createComfyProvider(f);
  const running = provider.run(request);
  const outcome = running.then(value => ({
    value
  }), error => ({
    error
  }));
  await ready;
  const cancelled = await provider.cancel();
  releaseHistory(Response.json({}));
  const result = await outcome;
  assert.equal(cancelled.cancelled, true);
  assert.equal(result.error?.code, 'ABORTED');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.stagingDir, 'comfy-receipt.json'), 'utf8')).status, 'cancelled');
  assert.equal(f.calls.some(c => c.url.includes('/view')), false);
});
test('queue-delete success cannot claim cancellation when owned prompt moved to running', async t => {
  let deleted = false;
  const f = await setup(t, {
    noHistory: true,
    fetch: async (route, options, submitted) => {
      if (route === '/queue' && submitted) {
        if (options.method === 'POST') {
          deleted = true;
          return Response.json({});
        }
        const tuple = [1, 'owned-id', submitted.prompt, submitted.extra_data, ['7']];
        return Response.json({
          queue_pending: deleted ? [] : [tuple],
          queue_running: deleted ? [tuple] : []
        });
      }
    }
  });
  const provider = createComfyProvider(f);
  await assert.rejects(provider.run(request), {
    code: 'GENERATION_TIMEOUT'
  });
  const result = await provider.cancel();
  assert.equal(result.cancelled, false);
  assert.equal(result.serverState, 'running');
  assert.equal(f.calls.some(c => c.url.endsWith('/interrupt')), false);
});
test('terminal cancellation survives an upload checkpoint completing after cancellation', async t => {
  const f = await setup(t);
  const source = path.join(f.root, 'reference.png');
  await fs.writeFile(source, png);
  let ready,
    release,
    blocked = false,
    cancelInitiated = false;
  const transitions = [];
  const checkpointReady = new Promise(resolve => ready = resolve);
  const blockedSave = new Promise(resolve => release = resolve);
  const checkpoint = {
    save: async receipt => {
      if (cancelInitiated) transitions.push(receipt.status);
      if (!blocked && receipt.status === 'preparing' && receipt.uploads.reference) {
        blocked = true;
        ready();
        await blockedSave;
      }
    }
  };
  const provider = createComfyProvider({
    ...f,
    checkpoint
  });
  const running = provider.run({
    ...request,
    workflow: 'ipadapter',
    reference: {
      path: source
    }
  });
  const outcome = running.then(value => ({
    value
  }), error => ({
    error
  }));
  await checkpointReady;
  cancelInitiated = true;
  const cancelling = provider.cancel();
  await new Promise(resolve => setImmediate(resolve));
  release();
  await cancelling;
  assert.equal((await outcome).error?.code, 'ABORTED');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.stagingDir, 'comfy-receipt.json'), 'utf8')).status, 'cancelled');
  assert.equal(f.calls.filter(call => call.url.endsWith('/prompt')).length, 0);
  assert.equal(transitions.includes('submitting'), false);
});
