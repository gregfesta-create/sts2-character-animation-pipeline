'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  hashValue,
  hashFile,
  publishSource,
  resolveContained,
  atomicWrite,
  ownedStorage
} = require('./assets');
const fail = (code, message) => Object.assign(new Error(message), {
  code
});
async function promptCheckpoint(jobRoot, relative, config) {
  if (!relative.startsWith('provider/')) throw fail('UNSAFE_PATH', 'Prompt journals must remain in owned provider storage.');
  const folder = await resolveContained(jobRoot, relative, {
    mustExist: false
  });
  await fs.mkdir(folder, {
    recursive: true
  });
  return {
    load: async () => {
      try {
        const file = await resolveContained(jobRoot, relative + '/receipt.json');
        if ((await fs.stat(file)).size > 4 * 1024 * 1024) throw fail('INVALID_MANIFEST', 'Prompt receipt exceeds limit.');
        return JSON.parse(await fs.readFile(file, 'utf8'));
      } catch (cause) {
        if (cause.code === 'ENOENT') return null;
        throw cause;
      }
    },
    save: async value => {
      const serialized = JSON.stringify(value);
      const file = await resolveContained(jobRoot, relative + '/receipt.json', {
        mustExist: false
      });
      const previous = await fs.stat(file).then(stat => stat.size, cause => {
        if (cause.code === 'ENOENT') return 0;
        throw cause;
      });
      if (Buffer.byteLength(serialized) > 4 * 1024 * 1024 || (await ownedStorage(jobRoot)) - previous + Buffer.byteLength(serialized) > (config.limits?.maxStorageBytes ?? 4 * 1024 ** 3)) throw fail('QUOTA_EXCEEDED', 'Prompt receipt exceeds storage limit.');
      await atomicWrite(file, serialized);
    }
  };
}
async function materializeConcept(spec, {
  jobRoot,
  config,
  inputs,
  version,
  signal,
  scheduler,
  createComfyProvider: factory,
  runImageOperation: imageOperation
} = {}) {
  const workflow = spec.artwork.workflow || (spec.artwork.referenceIds?.length ? 'ipadapter' : 'generation');
  if (!['generation', 'ipadapter', 'inpainting'].includes(workflow)) throw fail('UNSUPPORTED', 'Unknown trusted concept workflow.');
  if (spec.artwork.source && workflow !== 'inpainting') {
    const record = inputs[spec.artwork.source];
    if (!record || record.relative !== 'sources/' + record.hash) throw fail('ART_INPUT_MISSING', 'Supplied original artwork was not captured.');
    const file = await resolveContained(jobRoot, record.relative);
    if ((await fs.stat(file)).size !== record.size || (await hashFile(file)) !== record.hash) throw fail('CORRUPT_ARTIFACT', 'Supplied original artwork changed.');
    return {
      record: structuredClone(record),
      path: file,
      provenance: {
        provider: 'supplied-original'
      }
    };
  }
  if ((spec.artwork.referenceIds?.length || 0) > 1) throw fail('UNSUPPORTED', 'This workflow accepts one conditioning reference; choose one reference explicitly.');
  const conditioningPaths = workflow === 'ipadapter' ? spec.references.filter(reference => spec.artwork.referenceIds?.includes(reference.id)).map(reference => reference.path) : workflow === 'inpainting' ? [spec.artwork.source, ...spec.parts.filter(part => part.mask?.path).map(part => part.mask.path)] : [];
  const fingerprint = hashValue({
    artwork: spec.artwork,
    description: spec.description,
    style: spec.style,
    canvas: spec.canvas,
    inputs: conditioningPaths.map(file => inputs[file]?.hash ?? null),
    settings: config.comfyui || {},
    version
  });
  const folder = await resolveContained(jobRoot, 'provider/concepts/' + fingerprint, {
    mustExist: false
  });
  await fs.mkdir(folder, {
    recursive: true
  });
  const savedPath = await resolveContained(jobRoot, 'provider/concepts/' + fingerprint + '/concept.json', {
    mustExist: false
  });
  async function checkedRecord(record) {
    if (!record || record.fingerprint !== fingerprint || !/^[a-f0-9]{64}$/.test(record.record?.hash) || record.record.relative !== 'sources/' + record.record.hash) throw fail('INVALID_MANIFEST', 'Invalid concept checkpoint.');
    const file = await resolveContained(jobRoot, record.record.relative);
    if ((await fs.stat(file)).size !== record.record.size || (await hashFile(file)) !== record.record.hash) throw fail('CORRUPT_ARTIFACT', 'Original concept checkpoint was corrupted.');
    return {
      ...record,
      path: file
    };
  }
  try {
    if ((await fs.stat(savedPath)).size > 1024 * 1024) throw fail('INVALID_MANIFEST', 'Concept checkpoint exceeds limit.');
    return await checkedRecord(JSON.parse(await fs.readFile(savedPath, 'utf8')));
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
  }
  const prompt = `${spec.artwork.prompt || spec.description}\nOriginal complete character concept. Shared style: ${JSON.stringify(spec.style)}`;
  if (prompt.length > 4096) throw fail('INVALID_INPUT', 'Concept prompt and style exceed the supported prompt limit.');
  const request = {
    workflow,
    prompt,
    negativePrompt: spec.artwork.negativePrompt,
    seed: spec.artwork.seed ?? 0,
    width: spec.canvas.width,
    height: spec.canvas.height,
    ...Object.fromEntries(['steps', 'cfg', 'denoise'].filter(key => spec.artwork.settings?.[key] !== undefined).map(key => [key, spec.artwork.settings[key]]))
  };
  const captured = input => {
    const record = inputs[input];
    if (!record) throw fail('ART_INPUT_MISSING', 'Concept conditioning input was not captured.');
    return {
      path: path.join(jobRoot, record.relative)
    };
  };
  if (workflow === 'ipadapter') {
    const reference = spec.references.find(item => item.id === spec.artwork.referenceIds?.[0]);
    if (!reference) throw fail('ART_INPUT_MISSING', 'Reference-conditioned concept requires a selected reference.');
    request.reference = captured(reference.path);
  }
  let mask;
  const operate = imageOperation || require('./image-tools').runImageOperation;
  if (workflow === 'inpainting') {
    request.image = captured(spec.artwork.source);
    const selected = spec.parts.filter(part => part.mask?.path);
    if (selected.length !== 1) throw fail('ART_INPUT_MISSING', 'Concept inpainting requires exactly one explicit paint mask.');
    mask = await operate('mask', {
      input: captured(selected[0].mask.path).path
    }, {
      config,
      stagingDir: folder,
      signal
    });
    request.mask = {
      path: mask.image.path
    };
  }
  const checkpoint = await promptCheckpoint(jobRoot, 'provider/concepts/' + fingerprint, config);
  const create = factory || require('../providers/comfyui').createComfyProvider;
  const client = await create({
    config: {
      ...config,
      sourceRoots: [...(config.sourceRoots || []), jobRoot]
    },
    stagingDir: path.join(folder, 'generation'),
    signal,
    checkpoint
  });
  try {
    const generate = () => client.run(request);
    const result = scheduler ? await scheduler.schedule('gpu', generate, {
      signal
    }) : await generate();
    if (!Array.isArray(result.images) || result.images.length !== 1) throw fail('VALIDATION_FAILED', 'A concept workflow must return one original image.');
    let file = await resolveContained(folder, path.relative(folder, path.resolve(result.images[0].path)));
    if (workflow === 'inpainting') file = (await operate('composite', {
      original: request.image.path,
      generated: file,
      mask: mask.image.path
    }, {
      config,
      stagingDir: folder,
      signal
    })).image.path;
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw fail('QUOTA_EXCEEDED', 'Concept image exceeds source limit.');
    const hash = await hashFile(file);
    const source = await resolveContained(jobRoot, 'sources/' + hash, {
      mustExist: false
    });
    const exists = await fs.stat(source).then(() => true, cause => {
      if (cause.code === 'ENOENT') return false;
      throw cause;
    });
    const record = {
      fingerprint,
      record: {
        relative: 'sources/' + hash,
        hash,
        size: stat.size
      },
      provenance: result.provenance
    };
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized) > 1024 * 1024 || (await ownedStorage(jobRoot)) + (exists ? 0 : stat.size) + Buffer.byteLength(serialized) > (config.limits?.maxStorageBytes ?? 4 * 1024 ** 3)) throw fail('QUOTA_EXCEEDED', 'Concept generation exceeds job storage quota.');
    const saved = await publishSource(folder, path.relative(folder, file), jobRoot, {
      maxBytes: stat.size
    });
    if (saved.hash !== hash || saved.size !== stat.size) throw fail('SOURCE_CHANGED', 'Concept image changed during source publication.');
    await atomicWrite(savedPath, serialized);
    return checkedRecord(record);
  } catch (cause) {
    if (cause.code === 'QUOTA_EXCEEDED') {
      // Preserve the small external prompt journal so retries reconcile the same
      // server job, while discarding this exact owned candidate workspace.
      for (const entry of await fs.readdir(folder, {
        withFileTypes: true
      })) {
        if (entry.name === 'receipt.json') continue;
        const cleanup = await resolveContained(folder, entry.name);
        await fs.rm(cleanup, {
          recursive: entry.isDirectory(),
          force: true
        });
      }
    }
    throw cause;
  }
}
module.exports = {
  materializeConcept,
  promptCheckpoint
};
