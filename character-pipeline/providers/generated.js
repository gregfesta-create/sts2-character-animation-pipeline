'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  hashFile,
  hashValue,
  canonicalJson,
  resolveContained
} = require('../lib/assets');
const {
  createComfyProvider
} = require('./comfyui');
const {
  runImageOperation
} = require('../lib/image-tools');
const failure = (code, message) => Object.assign(new Error(message), {
  code
});
async function generated(spec, context) {
  const fail = context.fail || failure;
  if (context.concept?.approved !== true || typeof context.concept.path !== 'string' || !/^[a-f0-9]{64}$/.test(context.concept.hash || '')) throw fail('APPROVAL_REQUIRED', 'Show the exact original concept and obtain explicit approval before generating 2D parts');
  const selected = context.selected;
  if (!Array.isArray(selected) || !selected.length || selected.length > 1000 || new Set(selected.map(p => p.id)).size !== selected.length) throw fail('SEMANTIC_PART_INPUT', 'Expected selected semantic parts');
  for (const part of selected) {
    if (typeof part.id !== 'string' || typeof part.role !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(part.id) || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(part.role) || !Array.isArray(part.pivot) || part.pivot.length !== 2 || !part.pivot.every(Number.isFinite) || !spec.parts.some(p => p.id === part.id)) throw fail('SEMANTIC_PART_INPUT', 'Each generated part requires an explicit ID, semantic role and source-pixel pivot');
    if (Boolean(part.image?.path) !== Boolean(part.mask?.path) || spec.artwork.workflow === 'inpainting' && (!part.image?.path || !part.mask?.path)) throw fail('SEMANTIC_PART_INPUT', `Part ${part.id} repaint requires both an original image and white-paint mask`);
  }
  const concept = await context.source(context.concept.path);
  if ((await hashFile(concept)) !== context.concept.hash) throw fail('CORRUPT_ARTIFACT', 'Approved original concept bytes changed; show and approve the new original');
  const style = canonicalJson(spec.style || {});
  if (style.length > 2048) throw fail('INVALID_INPUT', 'Shared style exceeds generation prompt budget');
  const factory = context.createComfyProvider || createComfyProvider,
    operate = context.runImageOperation || runImageOperation;
  const result = [];
  for (const part of selected) {
    if (context.signal?.aborted) throw fail('ABORTED', 'Semantic part generation cancelled');
    const directory = await context.directory('generated-' + part.id);
    const base = await fs.realpath(directory);
    async function copyInput(file, label) {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 67108864) throw fail('QUOTA_EXCEEDED', 'Generation input exceeds byte quota');
      const bytes = await fs.readFile(file);
      if (bytes.length > 67108864) throw fail('QUOTA_EXCEEDED', 'Generation input exceeds byte quota');
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      const target = await resolveContained(base, label + '-' + digest + '.png', {
        mustExist: false
      });
      try {
        await fs.writeFile(target, bytes, {
          flag: 'wx'
        });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if ((await hashFile(target)) !== digest) throw fail('CORRUPT_ARTIFACT', 'Immutable generation input was changed');
      }
      return {
        path: target,
        hash: digest
      };
    }
    let reference = await copyInput(concept, 'approved-reference');
    if (reference.hash !== context.concept.hash) throw fail('CORRUPT_ARTIFACT', 'Approved concept changed while capturing input');
    const handle = await fs.open(reference.path, 'r');
    const header = Buffer.alloc(33);
    let bytesRead;
    try {
      ({
        bytesRead
      } = await handle.read(header, 0, header.length, 0));
    } finally {
      await handle.close();
    }
    if (bytesRead !== 33 || !header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || header[24] !== 8 || ![2, 6].includes(header[25]) || header[28] !== 0) {
      // Approval remains bound to original bytes. Re-encoding only supplies a
      // compatible, pixel-preserving conditioning image to the trusted client.
      const preview = await operate('preview', {
        input: reference.path
      }, {
        config: context.config,
        stagingDir: base,
        signal: context.signal
      });
      reference = await copyInput(await context.output(preview?.image?.path), 'conditioning-reference');
    }
    const seed = Number.parseInt(hashValue({
      seed: spec.artwork.seed ?? 0,
      character: spec.id,
      part: part.id
    }).slice(0, 12), 16);
    const repaint = Boolean(part.image?.path && part.mask?.path);
    const prompt = [spec.artwork.prompt || spec.description || '', `Create only the isolated 2D semantic part '${part.id}' with role '${part.role}' from the approved character reference. Preserve its identity, proportions, materials, lighting and style. Preserve the canvas registration and source-pixel pivot [${part.pivot.join(', ')}]. Reconstruct hidden surfaces as needed. Do not include other body parts or the complete character.`, `Shared style: ${style}`].join('\n');
    if (prompt.length > 4096) throw fail('INVALID_INPUT', 'Semantic part prompt exceeds limit');
    const operationOptions = {config: context.config, stagingDir: base, signal: context.signal};
    let original, mask, originalHash, maskHash, paint;
    if (repaint) {
      const image = await copyInput(await context.source(part.image.path), 'original');
      original = image.path;
      originalHash = image.hash;
      paint = await copyInput(await context.source(part.mask.path), 'paint');
      maskHash = paint.hash;
    }
    // Source pixels, rather than the unrelated combat canvas, define registration.
    // Padding is reversible and never rescales artwork, pivots or pixelsPerUnit.
    const inspected = await operate('inspect-raster', {input: repaint ? original : reference.path}, operationOptions);
    const padded = await operate('pad-raster', {
      input: await context.output(inspected?.image?.path),
      ...(repaint ? {mask: paint.path} : {})
    }, operationOptions);
    const raster = padded.raster;
    const width = raster?.paddedSize?.width, height = raster?.paddedSize?.height;
    const sourceWidth = raster?.sourceSize?.width, sourceHeight = raster?.sourceSize?.height;
    if (raster?.policyVersion !== 1 || ![sourceWidth, sourceHeight].every(value => Number.isInteger(value) && value > 0) ||
      ![width, height].every(value => Number.isInteger(value) && value >= 64 && value <= 4096 && value % 8 === 0) ||
      width !== Math.max(64, Math.ceil(sourceWidth / 8) * 8) || height !== Math.max(64, Math.ceil(sourceHeight / 8) * 8) ||
      width * height > 16000000 || raster.offset?.x !== 0 || raster.offset?.y !== 0 ||
      padded.image?.width !== width || padded.image?.height !== height ||
      inspected.image?.width !== sourceWidth || inspected.image?.height !== sourceHeight ||
      canonicalJson(inspected.raster) !== canonicalJson(raster)) throw fail('INVALID_WORKER_OUTPUT', 'Invalid source raster mapping');
    const conditioning = await context.output(padded?.image?.path);
    const conditioningHash = await hashFile(conditioning);
    const request = {
      workflow: repaint ? 'inpainting' : 'ipadapter',
      prompt,
      negativePrompt: spec.artwork.negativePrompt || '',
      seed,
      width,
      height,
      steps: spec.artwork.settings?.steps ?? 8,
      cfg: spec.artwork.settings?.cfg ?? 2,
      denoise: spec.artwork.settings?.denoise ?? 1
    };
    if (repaint) {
      const converted = await operate('mask', {
        input: paint.path
      }, {
        config: context.config,
        stagingDir: base,
        signal: context.signal
      });
      mask = await context.output(converted?.image?.path);
      const paddedMask = await operate('mask', {input: await context.output(padded?.mask?.path)}, operationOptions);
      request.image = {
        path: conditioning
      };
      request.mask = {
        path: await context.output(paddedMask?.image?.path)
      };
    } else request.reference = {
      path: conditioning
    };
    const identity = {
      partId: part.id,
      conceptHash: context.concept.hash,
      conditioningHash: reference.hash,
      raster,
      paddedConditioningHash: conditioningHash,
      ...(repaint ? {paddedMaskHash: await hashFile(request.mask.path)} : {}),
      styleHash: hashValue(spec.style || {}),
      seed,
      workflow: request.workflow,
      prompt,
      negativePrompt: request.negativePrompt,
      width,
      height,
      steps: request.steps,
      cfg: request.cfg,
      denoise: request.denoise,
      ...(repaint ? {
        originalHash,
        maskHash
      } : {})
    };
    const checkpoint = await context.checkpointForPart?.(part.id, identity);
    const client = factory({
      config: {
        ...context.config,
        sourceRoots: [...(context.config.sourceRoots || []), base]
      },
      stagingDir: await context.directory('generated-' + part.id + '/client'),
      signal: context.signal,
      ...(checkpoint ? {
        checkpoint
      } : {})
    });
    const execute = () => client.run(request);
    const generatedResult = context.scheduler ? await context.scheduler.schedule('gpu', execute, {
      signal: context.signal
    }) : await execute();
    if (!Array.isArray(generatedResult?.images) || generatedResult.images.length !== 1) throw fail('SEMANTIC_PART_OUTPUT', `Part ${part.id} requires exactly one generated image`);
    const generatedImage = generatedResult.images[0];
    let input = await context.output(generatedImage.path);
    if (generatedImage.width !== width || generatedImage.height !== height || !/^[a-f0-9]{64}$/.test(generatedImage.sha256 || '') || (await hashFile(input)) !== generatedImage.sha256) throw fail('SEMANTIC_PART_OUTPUT', `Part ${part.id} output dimensions or hash are inconsistent`);
    const cropped = await operate('crop-raster', {input, raster}, operationOptions);
    input = await context.output(cropped?.image?.path);
    if (repaint) {
      const composite = await operate('composite', {
        original,
        generated: input,
        mask
      }, {
        config: context.config,
        stagingDir: base,
        signal: context.signal
      });
      input = await context.output(composite?.image?.path);
      if (composite.preservedUnmasked !== true) throw fail('SEMANTIC_PART_OUTPUT', 'Repaint worker did not confirm strict unmasked-pixel preservation');
    }
    result.push({
      id: part.id,
      input,
      pivot: [...part.pivot],
      pixelsPerUnit: part.image?.pixelsPerUnit || 1,
      generation: {
        workflow: request.workflow,
        conceptHash: context.concept.hash,
        conditioningHash: reference.hash,
        seed,
        identity,
        provenance: generatedResult.provenance,
        receipt: generatedResult.receipt,
        ...(repaint ? {
          preservedUnmasked: true
        } : {})
      }
    });
  }
  return result;
}
module.exports = {
  generated
};
