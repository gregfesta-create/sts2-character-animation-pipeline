'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {
  discover
} = require('../lib/discovery');
const {
  resolveContained,
  publishSource,
  atomicWrite,
  hashValue
} = require('../lib/assets');
const fail = (code, message) => Object.assign(new Error(message), {
  code
});
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
function pngSize(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(pngSignature) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw fail('IMAGE_INVALID', 'Expected PNG output');
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > 16000000) throw fail('IMAGE_LIMIT', 'PNG dimensions exceed limits');
  // Decode the bounded RGB/RGBA PNG contract emitted by the trusted saver.
  // Reject corrupt checksums, incomplete streams, animation and unknown critical
  // chunks rather than treating a matching eight-byte signature as an image.
  let offset = 8,
    ended = false,
    seenData = false,
    closedData = false;
  const compressed = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw fail('IMAGE_INVALID', 'Truncated PNG chunk');
    const length = bytes.readUInt32BE(offset),
      end = offset + 12 + length;
    if (end > bytes.length) throw fail('IMAGE_INVALID', 'Truncated PNG payload');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, end - 4);
    if (!/^[A-Za-z]{4}$/.test(type) || zlib.crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw fail('IMAGE_INVALID', 'Invalid PNG checksum');
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13 || data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12]) throw fail('IMAGE_INVALID', 'Requires noninterlaced eight-bit RGB/RGBA PNG');
    } else if (type === 'IHDR' || ['acTL', 'fcTL', 'fdAT'].includes(type)) throw fail('IMAGE_INVALID', 'Repeated header or animated PNG');
    if (type === 'IDAT') {
      if (closedData) throw fail('IMAGE_INVALID', 'Noncontiguous PNG image stream');
      seenData = true;
      compressed.push(data);
    } else if (seenData) closedData = true;
    if (type === 'IEND') {
      if (length || end !== bytes.length || !seenData) throw fail('IMAGE_INVALID', 'Invalid PNG end marker');
      ended = true;
      break;
    }
    if (!['IHDR', 'IDAT', 'IEND', 'PLTE'].includes(type) && type[0] === type[0].toUpperCase()) throw fail('IMAGE_INVALID', 'Unsupported critical PNG chunk');
    offset = end;
  }
  if (!ended) throw fail('IMAGE_INVALID', 'PNG image is incomplete');
  const bytesPerPixel = bytes[25] === 6 ? 4 : 3,
    rowLength = width * bytesPerPixel;
  let pixels;
  const compressedBytes = Buffer.concat(compressed);
  try {
    const decoded = zlib.inflateSync(compressedBytes, {
      maxOutputLength: height * (rowLength + 1),
      info: true
    });
    if (decoded.engine.bytesWritten !== compressedBytes.length) throw new Error('Trailing compressed data');
    pixels = decoded.buffer;
  } catch {
    throw fail('IMAGE_INVALID', 'PNG compressed pixels are corrupt or exceed dimensions');
  }
  if (pixels.length !== height * (rowLength + 1)) throw fail('IMAGE_INVALID', 'PNG scanline count differs from dimensions');
  // Reconstruct all filter types to validate/decode actual scanlines.
  for (let y = 0; y < height; y++) {
    const row = y * (rowLength + 1),
      filter = pixels[row];
    if (filter > 4) throw fail('IMAGE_INVALID', 'Invalid PNG row filter');
    if (!filter) continue;
    for (let x = 0; x < rowLength; x++) {
      const current = row + 1 + x;
      const left = x >= bytesPerPixel ? pixels[current - bytesPerPixel] : 0;
      const above = y ? pixels[current - rowLength - 1] : 0;
      const upperLeft = y && x >= bytesPerPixel ? pixels[current - rowLength - 1 - bytesPerPixel] : 0;
      const prediction = left + above - upperLeft;
      const distances = [Math.abs(prediction - left), Math.abs(prediction - above), Math.abs(prediction - upperLeft)];
      const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? above : upperLeft;
      pixels[current] = pixels[current] + [0, left, above, Math.floor((left + above) / 2), paeth][filter] & 255;
    }
  }
  return {
    width,
    height
  };
}
function graph(request, models, uploads, marker) {
  const node = (class_type, inputs) => ({
    class_type,
    inputs
  });
  const result = {
    '1': node('CheckpointLoaderSimple', {
      ckpt_name: models.checkpoint
    }),
    '2': node('CLIPTextEncode', {
      text: request.prompt,
      clip: ['1', 1]
    }),
    '3': node('CLIPTextEncode', {
      text: request.negativePrompt || '',
      clip: ['1', 1]
    }),
    '4': node('EmptyLatentImage', {
      width: request.width,
      height: request.height,
      batch_size: 1
    }),
    '5': node('KSampler', {
      model: ['1', 0],
      seed: request.seed,
      steps: request.steps ?? 8,
      cfg: request.cfg ?? 2,
      sampler_name: 'dpmpp_sde',
      scheduler: 'karras',
      positive: ['2', 0],
      negative: ['3', 0],
      latent_image: ['4', 0],
      denoise: request.denoise ?? 1
    }),
    '6': node('VAEDecode', {
      samples: ['5', 0],
      vae: ['1', 2]
    }),
    '7': node('SaveImage', {
      images: ['6', 0],
      filename_prefix: marker
    })
  };
  if (request.workflow === 'ipadapter') {
    result['8'] = node('LoadImage', {
      image: uploads.reference
    });
    result['9'] = node('IPAdapterModelLoader', {
      ipadapter_file: models.ipadapter
    });
    result['10'] = node('CLIPVisionLoader', {
      clip_name: models.clipVision
    });
    result['11'] = node('IPAdapterAdvanced', {
      model: ['1', 0],
      ipadapter: ['9', 0],
      image: ['8', 0],
      weight: 0.8,
      weight_type: 'linear',
      combine_embeds: 'concat',
      start_at: 0,
      end_at: 1,
      embeds_scaling: 'V only',
      clip_vision: ['10', 0]
    });
    result['5'].inputs.model = ['11', 0];
  }
  if (request.workflow === 'inpainting') {
    delete result['4'];
    result['8'] = node('LoadImage', {
      image: uploads.image
    });
    result['9'] = node('LoadImage', {
      image: uploads.mask
    });
    result['10'] = node('VAEEncode', {
      pixels: ['8', 0],
      vae: ['1', 2]
    });
    result['11'] = node('SetLatentNoiseMask', {
      samples: ['10', 0],
      mask: ['9', 1]
    });
    result['5'].inputs.latent_image = ['11', 0];
  }
  return result;
}
function checkedRequest(request) {
  const keys = ['workflow', 'prompt', 'negativePrompt', 'seed', 'width', 'height', 'steps', 'cfg', 'denoise', 'reference', 'image', 'mask'];
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !keys.includes(key)) || !['generation', 'ipadapter', 'inpainting'].includes(request.workflow) || typeof request.prompt !== 'string' || !request.prompt.length || request.prompt.length > 4096 || request.negativePrompt !== undefined && (typeof request.negativePrompt !== 'string' || request.negativePrompt.length > 4096)) throw fail('INVALID_INPUT', 'Invalid trusted workflow request');
  for (const key of ['width', 'height']) if (!Number.isInteger(request[key]) || request[key] < 64 || request[key] > 4096 || request[key] % 8) throw fail('INVALID_INPUT', 'Dimensions must be multiples of 8 between 64 and 4096');
  if (request.width * request.height > 16000000 || !Number.isSafeInteger(request.seed) || request.seed < 0) throw fail('INVALID_INPUT', 'Invalid seed or pixel quota');
  for (const [key, min, max] of [['steps', 1, 1000], ['cfg', 0, 100], ['denoise', 0, 1]]) if (request[key] !== undefined && (!Number.isFinite(request[key]) || request[key] < min || request[key] > max || key === 'steps' && !Number.isInteger(request[key]))) throw fail('INVALID_INPUT', `Invalid ${key}`);
  for (const key of request.workflow === 'ipadapter' ? ['reference'] : request.workflow === 'inpainting' ? ['image', 'mask'] : []) if (typeof request[key]?.path !== 'string' || Object.keys(request[key]).some(k => k !== 'path')) throw fail('INVALID_INPUT', `${key} source required`);
  return structuredClone(request);
}
function createComfyProvider({
  config,
  stagingDir,
  fetch: fetchImpl = globalThis.fetch,
  signal,
  checkpoint
} = {}) {
  let receipt,
    active = false,
    origin,
    base;
  let runCancellation,
    cancellationRequested = false,
    saveChain = Promise.resolve();
  function ensureActive() {
    if (signal?.aborted || cancellationRequested || receipt?.status === 'cancelled') throw fail('ABORTED', 'ComfyUI operation cancelled');
  }
  const settings = config?.comfyui || {};
  const timeoutMs = settings.timeoutMs ?? 30000,
    maxBytes = settings.maxResponseBytes ?? 8388608,
    maxPolls = settings.maxPolls ?? 120,
    pollInterval = settings.pollIntervalMs ?? 250;
  async function initialize() {
    if (!settings.url) throw fail('CAPABILITY_MISSING', 'ComfyUI endpoint is not configured');
    let url;
    try {
      url = new URL(settings.url);
    } catch {
      throw fail('ENDPOINT_INVALID', 'Invalid ComfyUI URL');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw fail('ENDPOINT_INVALID', 'ComfyUI requires an HTTP(S) origin');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && settings.allowRemote !== true) throw fail('REMOTE_DISABLED', 'Remote endpoint is not authorized');
    origin = url.origin;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 67108864 || !Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 10000 || !Number.isInteger(pollInterval) || pollInterval < 0 || pollInterval > 60000) throw fail('INVALID_INPUT', 'Invalid ComfyUI resource limits');
    await fs.mkdir(stagingDir, {
      recursive: true
    });
    base = await fs.realpath(stagingDir);
  }
  async function api(route, {
    method = 'GET',
    body,
    json = true,
    limit = maxBytes,
    control = false
  } = {}) {
    if (signal?.aborted) throw fail('ABORTED', 'ComfyUI operation cancelled');
    if (!control) ensureActive();
    const localSignal = control ? undefined : runCancellation?.signal;
    const controller = new AbortController();
    let timer, reader;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {
      once: true
    });
    localSignal?.addEventListener('abort', abort, {
      once: true
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reader?.cancel().catch(() => {});
        reject(fail('TIMEOUT', 'ComfyUI request timed out'));
      }, timeoutMs);
    });
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(fail(signal?.aborted || localSignal?.aborted ? 'ABORTED' : 'TIMEOUT', 'ComfyUI request interrupted')), {
        once: true
      });
    });
    try {
      return await Promise.race([(async () => {
        const response = await fetchImpl(origin + route, {
          method,
          body,
          headers: typeof body === 'string' ? {
            'content-type': 'application/json'
          } : undefined,
          redirect: 'error',
          signal: controller.signal
        });
        if (!response.ok) throw fail(route === '/prompt' && response.status === 400 ? 'PROMPT_REJECTED' : 'HTTP_ERROR', `ComfyUI HTTP ${response.status}`);
        if (Number(response.headers.get('content-length')) > limit) throw fail('RESPONSE_LIMIT', 'ComfyUI declared response exceeds quota');
        reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const {
            done,
            value
          } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) throw fail('RESPONSE_LIMIT', 'ComfyUI response exceeds quota');
          chunks.push(Buffer.from(value));
        }
        const bytes = Buffer.concat(chunks);
        if (!json) return bytes;
        let parsed;
        try {
          parsed = JSON.parse(bytes.toString('utf8'));
        } catch {
          throw fail('RESPONSE_INVALID', 'ComfyUI returned invalid JSON');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail('RESPONSE_INVALID', 'ComfyUI JSON object required');
        return parsed;
      })(), timeout, aborted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      localSignal?.removeEventListener('abort', abort);
      controller.abort();
      reader?.cancel().catch(() => {});
    }
  }
  async function save() {
    const snapshot = structuredClone(receipt);
    const write = async () => {
      await atomicWrite(await resolveContained(base, 'comfy-receipt.json', {
        mustExist: false
      }), JSON.stringify(snapshot));
      if (typeof checkpoint === 'function') await checkpoint(snapshot);else await checkpoint?.save?.(snapshot);
    };
    const pending = saveChain.then(write);
    saveChain = pending.catch(() => {});
    await pending;
  }
  async function load() {
    if (receipt) return receipt;
    if (checkpoint?.load) receipt = await checkpoint.load();
    if (!receipt) {
      try {
        receipt = JSON.parse(await fs.readFile(await resolveContained(base, 'comfy-receipt.json'), 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    return receipt;
  }
  function owned(tuple) {
    return Array.isArray(tuple) && typeof tuple[1] === 'string' && tuple[3]?.client_id === receipt.clientId && tuple[3]?.pipeline_marker === receipt.marker && tuple[3]?.request_hash === receipt.requestHash && tuple[2] && hashValue(tuple[2]) === hashValue(receipt.graph);
  }
  async function reconcile() {
    const history = await api('/history?max_items=1000');
    const matches = Object.entries(history).filter(([, record]) => owned(record.prompt)).map(([id]) => id);
    const queue = await api('/queue');
    for (const tuple of [...(queue.queue_running || []), ...(queue.queue_pending || [])]) if (owned(tuple)) matches.push(tuple[1]);
    const unique = [...new Set(matches)];
    if (unique.length > 1) throw fail('SUBMISSION_AMBIGUOUS', 'Multiple owned prompt IDs found');
    if (unique.length) {
      ensureActive();
      receipt.promptId = unique[0];
      receipt.status = 'submitted';
      await save();
      return true;
    }
    return false;
  }
  async function capture(source) {
    let saved;
    for (const root of config.sourceRoots || []) {
      const relative = path.isAbsolute(source.path) ? path.relative(path.resolve(root), source.path) : source.path;
      if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) continue;
      try {
        saved = await publishSource(root, relative, base, {
          maxBytes: 67108864
        });
        break;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    if (!saved) throw fail('UNSAFE_PATH', 'Upload source is outside source roots or missing');
    const bytes = await fs.readFile(saved.path);
    return {
      ...saved,
      bytes,
      ...pngSize(bytes)
    };
  }
  async function upload(saved, key) {
    const bytes = saved.bytes;
    const form = new FormData();
    form.append('image', new Blob([bytes], {
      type: 'image/png'
    }), `${receipt.marker}-${key}.png`);
    form.append('type', 'input');
    form.append('overwrite', 'false');
    const response = await api('/upload/image', {
      method: 'POST',
      body: form
    });
    if (typeof response.name !== 'string' || !response.name || /[\\/]|\.\./.test(response.name) || response.type !== 'input' || typeof response.subfolder !== 'string' || response.subfolder && !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(response.subfolder)) throw fail('RESPONSE_INVALID', 'Unsafe uploaded image receipt');
    return {
      name: (response.subfolder ? response.subfolder + '/' : '') + response.name,
      sha256: saved.hash
    };
  }
  async function run(input) {
    if (active) throw fail('JOB_BUSY', 'A provider run is already active');
    active = true;
    runCancellation = new AbortController();
    try {
      const request = checkedRequest(input);
      await initialize();
      ensureActive();
      const sourceKeys = request.workflow === 'ipadapter' ? ['reference'] : request.workflow === 'inpainting' ? ['image', 'mask'] : [];
      const captured = {},
        identity = structuredClone(request);
      for (const key of sourceKeys) {
        captured[key] = await capture(request[key]);
        ensureActive();
        identity[key] = {
          sha256: captured[key].hash
        };
      }
      if (request.workflow === 'inpainting' && sourceKeys.some(key => captured[key].width !== request.width || captured[key].height !== request.height)) throw fail('INVALID_INPUT', 'Inpainting image and mask dimensions must match requested output');
      if (request.workflow === 'inpainting' && captured.mask.bytes[25] !== 6) throw fail('IMAGE_INVALID', 'Inpainting requires an explicit RGBA alpha mask: transparent pixels are painted');
      const requestHash = hashValue({
        request: identity,
        endpoint: origin,
        checkpoint: settings.checkpoint || null,
        modelFamily: settings.modelFamily || null,
        ipadapter: settings.ipadapter || null,
        clipVision: settings.clipVision || null
      });
      await load();
      if (receipt && (receipt.formatVersion !== 1 || receipt.requestHash !== requestHash || typeof receipt.clientId !== 'string' || !/^[a-f0-9-]{36}$/.test(receipt.clientId) || receipt.marker !== 'pipeline_' + receipt.clientId)) throw fail('RECEIPT_MISMATCH', 'Saved prompt receipt does not match this request');
      if (receipt?.status === 'cancelled') throw fail('ABORTED', 'This owned prompt was cancelled');
      if (receipt?.status === 'rejected' || receipt?.status === 'failed') throw fail('GENERATION_FAILED', 'This owned prompt previously failed; create a new request revision');
      if (receipt && !['preparing', 'submitting', 'submitted', 'completed'].includes(receipt.status)) throw fail('RECEIPT_MISMATCH', 'Unknown prompt receipt status');
      if (!receipt) {
        const discovery = await discover({
          tools: {},
          comfyui: settings
        }, {
          fetch: fetchImpl
        });
        const contract = discovery.comfyui.workflows?.[request.workflow];
        ensureActive();
        if (!discovery.comfyui.available || !contract?.compatible) throw fail('CAPABILITY_MISSING', 'Requested ComfyUI workflow/model contract is unavailable');
        const clientId = crypto.randomUUID();
        receipt = {
          formatVersion: 1,
          requestHash,
          clientId,
          marker: 'pipeline_' + clientId,
          status: 'preparing',
          models: contract.models,
          uploads: {}
        };
        await save();
        ensureActive();
      }
      if (receipt.status === 'preparing') {
        const uploads = {};
        for (const key of sourceKeys) {
          ensureActive();
          const result = await upload(captured[key], key);
          ensureActive();
          uploads[key] = result.name;
          receipt.uploads[key] = result;
          await save();
          ensureActive();
        }
        ensureActive();
        receipt.graph = graph(request, receipt.models, uploads, receipt.marker);
        receipt.status = 'submitting';
        await save();
        ensureActive();
        try {
          const posted = await api('/prompt', {
            method: 'POST',
            body: JSON.stringify({
              prompt: receipt.graph,
              client_id: receipt.clientId,
              extra_data: {
                client_id: receipt.clientId,
                pipeline_marker: receipt.marker,
                request_hash: requestHash
              }
            })
          });
          ensureActive();
          if (typeof posted.prompt_id !== 'string' || !posted.prompt_id || Object.keys(posted.node_errors || {}).length) throw fail('PROMPT_REJECTED', 'ComfyUI rejected prompt');
          receipt.promptId = posted.prompt_id;
          receipt.status = 'submitted';
          await save();
          ensureActive();
        } catch (error) {
          ensureActive();
          if (error.code === 'ABORTED') throw error;
          if (error.code === 'PROMPT_REJECTED') {
            receipt.status = 'rejected';
            await save();
            throw error;
          }
          if (!(await reconcile())) throw fail('SUBMISSION_UNKNOWN', 'Submission outcome unknown; resume will reconcile without resubmitting');
        }
      } else if (!receipt.promptId) {
        if (!(await reconcile())) throw fail('SUBMISSION_UNKNOWN', 'No owned prompt found; submission will not be duplicated');
      }
      for (let attempt = 0; attempt < maxPolls; attempt++) {
        ensureActive();
        const history = await api('/history/' + encodeURIComponent(receipt.promptId));
        ensureActive();
        const record = history[receipt.promptId];
        if (record) {
          if (!owned(record.prompt) || record.prompt[1] !== receipt.promptId) throw fail('FOREIGN_PROMPT', 'Prompt history ownership mismatch');
          if (record.status?.status_str === 'error' || record.status?.messages?.some(m => m[0] === 'execution_error')) {
            receipt.status = 'failed';
            await save();
            throw fail('GENERATION_FAILED', 'ComfyUI execution failed');
          }
          if (record.status?.completed) {
            const outputs = record.outputs?.['7']?.images;
            if (!Array.isArray(outputs) || outputs.length !== 1) throw fail('OUTPUT_MISSING', 'Expected one owned SaveImage output');
            const image = outputs[0];
            if (image.type !== 'output' || typeof image.filename !== 'string' || !image.filename.startsWith(receipt.marker) || /[\\/]|\.\./.test(image.filename) || typeof image.subfolder !== 'string' || image.subfolder && !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(image.subfolder)) throw fail('FOREIGN_OUTPUT', 'Output receipt is not owned');
            const query = new URLSearchParams({
              filename: image.filename,
              subfolder: image.subfolder,
              type: 'output'
            });
            const bytes = await api('/view?' + query, {
              json: false,
              limit: 67108864
            });
            const size = pngSize(bytes);
            ensureActive();
            if (size.width !== request.width || size.height !== request.height) throw fail('IMAGE_INVALID', 'Generated PNG dimensions differ from the requested output');
            const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
            const target = await resolveContained(base, 'generated-' + sha256 + '.png', {
              mustExist: false
            });
            try {
              await fs.writeFile(target, bytes, {
                flag: 'wx'
              });
            } catch (e) {
              if (e.code !== 'EEXIST') throw e;
              if (!Buffer.from(await fs.readFile(target)).equals(bytes)) throw fail('CORRUPT_ARTIFACT', 'Generated immutable output differs');
            }
            ensureActive();
            receipt.status = 'completed';
            await save();
            ensureActive();
            const provenance = {
              workflow: request.workflow,
              requestHash,
              seed: request.seed,
              settings: request,
              models: receipt.models,
              uploads: receipt.uploads,
              promptId: receipt.promptId,
              graphHash: hashValue(receipt.graph)
            };
            await atomicWrite(await resolveContained(base, 'comfy-provenance.json', {
              mustExist: false
            }), JSON.stringify(provenance));
            ensureActive();
            return {
              images: [{
                path: target,
                sha256,
                ...size
              }],
              provenance,
              receipt: structuredClone(receipt)
            };
          }
        }
        if (attempt + 1 < maxPolls) await new Promise((resolve, reject) => {
          const timer = setTimeout(done, pollInterval);
          function done() {
            signal?.removeEventListener('abort', abort);
            resolve();
          }
          function abort() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            reject(fail('ABORTED', 'ComfyUI polling cancelled'));
          }
          signal?.addEventListener('abort', abort, {
            once: true
          });
          if (signal?.aborted) abort();
        });
      }
      throw fail('GENERATION_TIMEOUT', 'Owned prompt did not finish within polling budget');
    } finally {
      active = false;
    }
  }
  async function cancel() {
    const wasActive = active;
    if (wasActive) {
      cancellationRequested = true;
      runCancellation?.abort();
    }
    await initialize();
    await load();
    if (wasActive && receipt) {
      receipt.status = 'cancelled';
      await save();
    }
    if (!receipt?.promptId) return {
      cancelled: false,
      localCancelled: wasActive,
      serverState: 'unknown'
    };
    const queue = await api('/queue', {
      control: true
    });
    const pending = (queue.queue_pending || []).find(tuple => tuple[1] === receipt.promptId && owned(tuple));
    if (pending) {
      await api('/queue', {
        method: 'POST',
        control: true,
        body: JSON.stringify({
          delete: [receipt.promptId]
        })
      });
      // Queue deletion races execution. Recheck both queue and history before
      // claiming the server removed the pending prompt.
      const after = await api('/queue', {
        control: true
      });
      const running = (after.queue_running || []).some(tuple => tuple[1] === receipt.promptId && owned(tuple));
      const remains = (after.queue_pending || []).some(tuple => tuple[1] === receipt.promptId && owned(tuple));
      const history = await api('/history/' + encodeURIComponent(receipt.promptId), {
        control: true
      });
      const completed = history[receipt.promptId] && owned(history[receipt.promptId].prompt);
      if (running || remains || completed) return {
        cancelled: false,
        localCancelled: wasActive,
        serverState: running ? 'running' : remains ? 'pending' : 'completed',
        reason: 'Server deletion was not confirmed; global interrupt is never used'
      };
      receipt.status = 'cancelled';
      await save();
      return {
        cancelled: true,
        localCancelled: true,
        serverState: 'removed'
      };
    }
    const running = (queue.queue_running || []).some(tuple => tuple[1] === receipt.promptId && owned(tuple));
    return {
      cancelled: false,
      localCancelled: wasActive,
      serverState: running ? 'running' : 'unknown',
      reason: 'No owned pending prompt was removed; global interrupt could stop foreign work'
    };
  }
  return {
    run,
    cancel
  };
}
module.exports = {
  createComfyProvider
};
