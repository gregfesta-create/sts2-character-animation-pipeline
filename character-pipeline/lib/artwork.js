'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  hashFile,
  publishSource,
  resolveContained
} = require('./assets');
const {
  runTool: defaultRunTool
} = require('./process');
const {
  existing
} = require('../providers/existing');
const {
  layered
} = require('../providers/layered');
const {
  generated
} = require('../providers/generated');
function fail(code, message) {
  return Object.assign(new Error(message), {
    code
  });
}
const MAX_BYTES = 64 * 1024 * 1024;
async function prepareArtwork(spec, {
  config = {},
  stagingDir,
  runTool = defaultRunTool,
  signal,
  partIds,
  concept,
  createComfyProvider,
  checkpointForPart,
  scheduler
} = {}) {
  const providers = {
    existing,
    layered,
    comfyui: generated
  };
  const provider = Object.hasOwn(providers, spec?.artwork?.provider) ? providers[spec.artwork.provider] : null;
  if (!provider) throw fail('UNSUPPORTED_PROVIDER', `Unsupported artwork provider: ${spec?.artwork?.provider}`);
  if (!config.tools?.python?.executable) throw fail('CAPABILITY_MISSING', 'Configured Python with Pillow is required');
  if (!Array.isArray(config.sourceRoots) || !config.sourceRoots.length) throw fail('UNSAFE_PATH', 'Configured source roots are required');
  if (!Array.isArray(spec.parts) || !spec.parts.length || spec.parts.length > 1000) throw fail('INVALID_INPUT', 'Expected 1 to 1000 parts');
  const selected = spec.parts.filter(p => !partIds || partIds.includes(p.id));
  if (!selected.length || new Set(selected.map(p => p.id)).size !== selected.length || selected.some(p => !/^\w[\w-]{0,63}$/.test(p.id))) throw fail('INVALID_INPUT', 'Invalid selected part IDs');
  await fs.mkdir(stagingDir, {
    recursive: true
  });
  const base = await fs.realpath(stagingDir);
  const directory = async name => {
    const target = await resolveContained(base, name, {
      mustExist: false
    });
    await fs.mkdir(target, {
      recursive: true
    });
    return target;
  };
  let sourceBytes = 0;
  async function source(input) {
    if (typeof input !== 'string' || input.includes('\0')) throw fail('UNSAFE_PATH', 'Invalid source path');
    for (const root of config.sourceRoots) {
      const relative = path.isAbsolute(input) ? path.relative(path.resolve(root), input) : input;
      if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) continue;
      try {
        const saved = await publishSource(root, relative, base, {
          maxBytes: MAX_BYTES
        });
        sourceBytes += saved.size;
        if (sourceBytes > MAX_BYTES) throw fail('QUOTA_EXCEEDED', 'Artwork sources exceed byte quota');
        return saved.path;
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        throw e;
      }
    }
    throw fail('UNSAFE_PATH', 'Artwork path is outside configured source roots or missing');
  }
  async function output(file) {
    if (typeof file !== 'string') throw fail('INVALID_WORKER_OUTPUT', 'Worker output path missing');
    const relative = path.relative(base, path.resolve(file));
    const target = await resolveContained(base, relative);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw fail('QUOTA_EXCEEDED', 'Invalid artwork output size');
    return target;
  }
  async function worker(request) {
    const requestPath = await resolveContained(base, 'request-' + crypto.randomUUID() + '.json', {
      mustExist: false
    });
    const payload = {
      ...request,
      limits: {
        maxPixels: 16000000,
        maxFileBytes: MAX_BYTES
      }
    };
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json) > 1024 * 1024) throw fail('QUOTA_EXCEEDED', 'Artwork request too large');
    await fs.writeFile(requestPath, json, {
      flag: 'wx'
    });
    const execution = await runTool({
      python: config.tools.python
    }, 'python', [path.resolve(__dirname, '../workers/images.py'), requestPath], {
      timeoutMs: 120000,
      maxOutputBytes: 1024 * 1024,
      signal
    });
    let parsed;
    try {
      parsed = JSON.parse(execution.stdout);
    } catch {
      throw fail(execution.error?.code || 'INVALID_WORKER_OUTPUT', 'Image worker returned invalid JSON');
    }
    if (parsed?.ok === false) throw fail(parsed.error?.code || 'ART_PREP_FAILED', parsed.error?.message || 'Image preparation failed');
    if (execution.error || execution.exitCode !== 0) throw fail(execution.error?.code || 'ART_PREP_FAILED', 'Image worker failed');
    if (parsed?.ok !== true) throw fail('INVALID_WORKER_OUTPUT', 'Image worker did not confirm completion');
    return parsed;
  }
  // Prepared parts already use texture-pixel registration even when their
  // original source was an OpenRaster archive. Reimport those images directly.
  const context = {
    source,
    worker,
    output,
    directory,
    fail,
    config,
    signal,
    concept,
    createComfyProvider,
    checkpointForPart,
    scheduler
  };
  const preparedParts = selected.filter(part => part.image?.prepared);
  const rawParts = selected.filter(part => !part.image?.prepared);
  const suppliedParts = provider === generated && spec.artwork.workflow !== 'inpainting' ? rawParts.filter(part => part.image?.path && !part.mask?.path) : [];
  const providerParts = rawParts.filter(part => !suppliedParts.includes(part));
  const directParts = [...preparedParts, ...suppliedParts];
  const inputs = [...(directParts.length ? await existing(spec, {
    ...context,
    selected: directParts
  }) : []), ...(providerParts.length ? await provider(spec, {
    ...context,
    selected: providerParts
  }) : [])];
  // Capture requirements centrally so every provider, including prepared inputs,
  // reaches the same worker enforcement boundary.
  for (const input of inputs) {
    const declaration = selected.find(part => part.id === input.id)?.requiredSurfaceMask;
    if (declaration) input.requiredSurfaceMask = await source(declaration.path);
  }
  const backgrounds = new Map();
  if (spec.artwork.settings?.backgroundRemoval || inputs.some(input => input.generation)) {
    const {
      runImageOperation
    } = require('./image-tools');
    for (const input of inputs) {
      if (preparedParts.some(part => part.id === input.id)) continue;
      if (!(spec.artwork.settings?.backgroundRemoval ?? input.generation?.workflow === 'ipadapter')) continue;
      const result = await runImageOperation('remove-background', {
        input: input.input
      }, {
        config,
        stagingDir: base,
        runTool,
        signal
      });
      if (result.alignment?.scale !== 1 || result.alignment.translation?.some(value => value !== 0)) throw fail('INVALID_WORKER_OUTPUT', 'Background extraction changed image registration.');
      input.input = result.image.path;
      backgrounds.set(input.id, {
        model: result.model,
        source: result.source,
        alignment: result.alignment,
        sha256: result.image.sha256
      });
    }
  }
  const result = await worker({
    action: 'prepare',
    parts: inputs.map(({
      layerOffset,
      ...input
    }) => input),
    outputDirectory: await directory('prepared')
  });
  if (!Array.isArray(result.parts) || result.parts.length !== selected.length) throw fail('INVALID_WORKER_OUTPUT', 'Worker part count mismatch');
  const prepared = structuredClone(spec);
  const seen = new Set();
  for (const part of result.parts) {
    if (backgrounds.has(part.id)) part.background = backgrounds.get(part.id);
    const generation = inputs.find(input => input.id === part.id)?.generation;
    if (generation) part.generation = generation;
    if (!selected.some(p => p.id === part.id) || seen.has(part.id)) throw fail('INVALID_WORKER_OUTPUT', 'Unexpected worker part');
    seen.add(part.id);
    await output(part.image?.path);
    const input = inputs.find(input => input.id === part.id);
    if (input.requiredSurfaceMask) require('./surface-coverage').validateSurfaceCoverage(part.surfaceCoverage, {
      width: part.source?.width, height: part.source?.height,
      sourceSha256: await hashFile(input.input),
      maskSha256: await hashFile(input.requiredSurfaceMask),
      outputSha256: await hashFile(part.image.path)
    });
    if (input.requiredSurfaceMask) part.surfaceCoverageSource = input.input;
    else if (part.surfaceCoverage) throw fail('INVALID_SURFACE_COVERAGE', 'Unexpected surface coverage receipt');
    const image = part.image;
    const transform = part.transform;
    if (!image.prepared || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.width * image.height > 16000000 || !Number.isFinite(image.pixelsPerUnit) || image.pixelsPerUnit <= 0 || !Array.isArray(image.pivot) || image.pivot.length !== 2 || !image.pivot.every(Number.isFinite) || !Number.isFinite(transform?.scale) || transform.scale <= 0 || !Array.isArray(transform.translation) || transform.translation.length !== 2 || !transform.translation.every(Number.isFinite)) throw fail('INVALID_WORKER_OUTPUT', 'Invalid prepared registration');
    const bounds = image.alphaBounds;
    if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[0] < 0 || bounds[1] < 0 || bounds[2] <= bounds[0] || bounds[3] <= bounds[1] || bounds[2] > image.width || bounds[3] > image.height || !Array.isArray(image.cropTranslation) || image.cropTranslation.length !== 2 || !image.cropTranslation.every(Number.isFinite) || image.cropTranslation.some((value, i) => value !== transform.translation[i])) throw fail('INVALID_WORKER_OUTPUT', 'Invalid alpha bounds or crop translation');
    const target = prepared.parts.find(p => p.id === part.id);
    target.image = image;
    const layerOffset = inputs.find(p => p.id === part.id).layerOffset || [0, 0];
    if (provider === layered) part.layerOffset = layerOffset;
    if (target.mesh) {
      target.mesh = structuredClone(target.mesh);
      for (const field of ['vertices', 'uv']) target.mesh[field] = target.mesh[field].map(point => point.map((value, i) => (value - layerOffset[i]) * transform.scale + transform.translation[i]));
    }
  }
  if (result.atlas) await output(result.atlas.path);
  return {
    spec: prepared,
    parts: result.parts,
    ...(result.atlas ? {
      atlas: result.atlas
    } : {}),
    diagnostics: []
  };
}
module.exports = {
  prepareArtwork
};
