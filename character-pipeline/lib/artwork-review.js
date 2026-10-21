'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  hashValue,
  hashFile,
  atomicWrite,
  resolveContained,
  ownedStorage
} = require('./assets');
const {
  openJob,
  inspectJob
} = require('./jobs');
const {
  runTool: defaultRunTool
} = require('./process');
const fail = (code, message) => Object.assign(new Error(message), {
  code
});
const HASH = /^[a-f0-9]{64}$/;
async function readRecord(root, name) {
  const file = await resolveContained(root, name);
  if ((await fs.stat(file)).size > 8 * 1024 * 1024) throw fail('INVALID_MANIFEST', 'Artwork review record exceeds limit.');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function verifyFile(root, record, prefix) {
  if (!record || typeof record.relative !== 'string' || !record.relative.startsWith(prefix) || !HASH.test(record.hash) || !Number.isSafeInteger(record.size) || record.size < 0) throw fail('INVALID_MANIFEST', 'Invalid artwork review artifact.');
  const file = await resolveContained(root, record.relative);
  if ((await fs.stat(file)).size !== record.size || (await hashFile(file)) !== record.hash) throw fail('CORRUPT_ARTIFACT', 'Artwork review artifact changed.');
  return file;
}
async function writeBoundedRecord(root, name, value, config) {
  const file = await resolveContained(root, name, {
    mustExist: false
  });
  const previousSize = await fs.stat(file).then(stat => stat.size, cause => {
    if (cause.code === 'ENOENT') return 0;
    throw cause;
  });
  const serialized = JSON.stringify(value, null, 2);
  if ((await ownedStorage(root)) - previousSize + Buffer.byteLength(serialized) > (config.limits?.maxStorageBytes ?? 4 * 1024 ** 3)) throw fail('QUOTA_EXCEEDED', 'Artwork review record exceeds job storage quota.');
  await atomicWrite(file, serialized);
}
function identity(record) {
  return hashValue({
    version: 1,
    jobId: record.jobId,
    content: record.content,
    previews: record.previews
  });
}
function artworkReviewContent(spec, inputs) {
  // Captured audio shares source storage, but is not original artwork to approve.
  const artworkPaths = new Set(['@concept']);
  if (spec.artwork.source) artworkPaths.add(spec.artwork.source);
  for (const part of spec.parts) {
    if (part.image?.path) artworkPaths.add(part.image.path);
    if (!part.image?.prepared && part.mask?.path) artworkPaths.add(part.mask.path);
  }
  for (const reference of spec.references) {
    if (spec.artwork.referenceIds?.includes(reference.id)) artworkPaths.add(reference.path);
  }
  const originals = [...new Map([...artworkPaths].filter(key => Object.hasOwn(inputs, key)).map(key => [inputs[key].hash, inputs[key]])).values()].sort((a, b) => a.hash.localeCompare(b.hash));
  const artwork = structuredClone(spec.artwork);
  if (artwork.source) artwork.source = inputs[artwork.source]?.hash || artwork.source;
  return {
    originals,
    artwork,
    style: spec.style,
    references: spec.references,
    parts: spec.parts.map(part => ({
      id: part.id,
      role: part.role,
      image: inputs[part.image?.path]?.hash || null,
      mask: !part.image?.prepared ? inputs[part.mask?.path]?.hash || null : null
    }))
  };
}
function reviewContent(spec, inputs, componentArtwork = []) {
  const content = artworkReviewContent(spec, inputs);
  if (!Array.isArray(componentArtwork) || componentArtwork.length > 15 || Buffer.byteLength(JSON.stringify(componentArtwork)) > 4 * 1024 * 1024) throw fail('INVALID_MANIFEST', 'Component artwork review exceeds bounds.');
  if (componentArtwork.length) {
    const ids = new Set();
    for (const item of componentArtwork) {
      if (!item || typeof item.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.id) || ids.has(item.id) || !item.content || !Array.isArray(item.content.originals)) throw fail('INVALID_MANIFEST', 'Invalid component artwork review.');
      ids.add(item.id);
    }
    content.components = structuredClone(componentArtwork);
    content.originals = [...new Map([...content.originals, ...componentArtwork.flatMap(item => item.content.originals)].map(item => [item.hash, item])).values()].sort((a,b) => a.hash.localeCompare(b.hash));
  }
  return content;
}
async function verifyReview(root, record) {
  if (!record || record.version !== 1 || !HASH.test(record.reviewId) || identity(record) !== record.reviewId || !Array.isArray(record.content?.originals) || !record.content.originals.length || !Array.isArray(record.previews) || !record.previews.length) throw fail('INVALID_MANIFEST', 'Invalid artwork review.');
  for (const source of record.content.originals) await verifyFile(root, source, 'sources/');
  for (const preview of record.previews) await verifyFile(root, preview, 'review/');
}
async function response(root, record, approved) {
  return {
    status: approved ? 'artwork_approved' : 'awaiting_artwork_approval',
    complete: false,
    approved,
    reviewId: record.reviewId,
    jobId: record.jobId,
    previews: await Promise.all(record.previews.map(async item => ({
      ...item,
      path: await resolveContained(root, item.relative)
    }))),
    originals: await Promise.all(record.content.originals.map(async item => ({
      ...item,
      path: await resolveContained(root, item.relative)
    }))),
    nextAction: approved ? 'Resume the job.' : 'Show the original previews to the user and wait for explicit approval or requested changes. No preparation, rigging or animation may proceed.'
  };
}

// Called only while the build engine holds its job handle. No timeout grants approval.
async function createArtworkReview({
  jobRoot,
  jobId,
  spec,
  inputs,
  componentArtwork = [],
  config,
  runTool = defaultRunTool,
  signal
}) {
  const content = reviewContent(spec, inputs, componentArtwork);
  const originals = content.originals;
  if (!originals.length) throw fail('ART_INPUT_MISSING', 'Original artwork is required before review.');
  for (const source of originals) await verifyFile(jobRoot, source, 'sources/');
  let record;
  try {
    record = await readRecord(jobRoot, 'review/current.json');
    await verifyReview(jobRoot, record);
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
  }
  if (!record || record.jobId !== jobId || hashValue(record.content) !== hashValue(content)) {
    if (!config.tools?.python?.executable) throw fail('CAPABILITY_MISSING', 'Python with Pillow is required for original artwork previews.');
    const relative = 'review/previews-' + crypto.randomUUID();
    const folder = await resolveContained(jobRoot, relative, {
      mustExist: false
    });
    await fs.mkdir(folder, {
      recursive: true
    });
    try {
      const previews = [];
      for (const [index, original] of originals.entries()) {
        const request = {
          input: await verifyFile(jobRoot, original, 'sources/'),
          outputDirectory: path.join(folder, String(index))
        };
        const requestFile = path.join(folder, 'request-' + index + '.json');
        await fs.writeFile(requestFile, JSON.stringify(request));
        const result = await runTool({
          python: config.tools.python
        }, 'python', [path.resolve(__dirname, '../workers/preview.py'), requestFile], {
          signal,
          timeoutMs: 60000,
          maxOutputBytes: 1024 * 1024
        });
        await fs.unlink(requestFile);
        let parsed;
        try {
          parsed = JSON.parse(result.stdout);
        } catch {
          throw fail(result.error?.code || 'PREVIEW_FAILED', 'Original artwork preview failed.');
        }
        if (result.error || result.exitCode !== 0 || parsed?.ok !== true || !Number.isSafeInteger(parsed.image?.width) || !Number.isSafeInteger(parsed.image?.height) || parsed.image.width <= 0 || parsed.image.height <= 0 || parsed.image.width * parsed.image.height > 16000000) throw fail(result.error?.code || 'PREVIEW_FAILED', 'Original artwork preview failed.');
        if (typeof parsed.image.path !== 'string') throw fail('PREVIEW_FAILED', 'Preview path is missing.');
        const previewRelative = path.relative(jobRoot, path.resolve(parsed.image.path)).split(path.sep).join('/');
        if (!previewRelative.startsWith(relative + '/')) throw fail('UNSAFE_PATH', 'Preview escaped its owned directory.');
        const file = await resolveContained(jobRoot, previewRelative);
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw fail('PREVIEW_FAILED', 'Preview size exceeds limit.');
        previews.push({
          relative: previewRelative,
          hash: await hashFile(file),
          size: stat.size,
          sourceHash: original.hash,
          width: parsed.image.width,
          height: parsed.image.height
        });
        if ((await ownedStorage(jobRoot)) > (config.limits?.maxStorageBytes ?? 4 * 1024 ** 3)) throw fail('QUOTA_EXCEEDED', 'Original artwork previews exceed job storage quota.');
      }
      record = {
        version: 1,
        jobId,
        content,
        previews
      };
      record.reviewId = identity(record);
      await writeBoundedRecord(jobRoot, 'review/current.json', record, config);
      await fs.rm(await resolveContained(jobRoot, 'review/approval.json', {
        mustExist: false
      }), {
        force: true
      });
    } catch (cause) {
      // This exact generated directory was resolved within the owned review root.
      const cleanup = await resolveContained(jobRoot, relative);
      await fs.rm(cleanup, {
        recursive: true,
        force: true
      });
      throw cause;
    }
  }
  let approval;
  try {
    approval = await readRecord(jobRoot, 'review/approval.json');
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
  }
  return response(jobRoot, record, approval?.version === 1 && approval.reviewId === record.reviewId && approval.decision === 'approved');
}
async function approveArtwork(jobRoot, {
  config,
  reviewId
} = {}) {
  if (!config?.outputRoot || typeof reviewId !== 'string' || !HASH.test(reviewId)) throw fail('INVALID_INPUT', 'An exact artwork review ID and configured output root are required.');
  const relative = path.relative(path.resolve(config.outputRoot), path.resolve(jobRoot));
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw fail('UNSAFE_PATH', 'Artwork approval must address an owned job.');
  const root = await resolveContained(config.outputRoot, relative);
  const job = await openJob(root);
  try {
    const record = await readRecord(root, 'review/current.json');
    await verifyReview(root, record);
    const manifest = job.manifest;
    if (record.jobId !== manifest.jobId || record.reviewId !== reviewId || hashValue(record.content) !== hashValue(reviewContent(manifest.context.spec, manifest.context.inputs, manifest.context.settings?.componentArtwork))) throw fail('STALE_REVIEW', 'Artwork changed; show and approve the current original preview.');
    await writeBoundedRecord(root, 'review/approval.json', {
      version: 1,
      reviewId,
      decision: 'approved',
      approvedAt: new Date().toISOString()
    }, config);
    return response(root, record, true);
  } finally {
    await job.close();
  }
}
async function inspectArtworkReview(jobRoot) {
  let record;
  try {
    record = await readRecord(jobRoot, 'review/current.json');
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw cause;
  }
  await verifyReview(jobRoot, record);
  const manifest = await inspectJob(jobRoot);
  if (record.jobId !== manifest.jobId || hashValue(record.content) !== hashValue(reviewContent(manifest.context.spec, manifest.context.inputs, manifest.context.settings?.componentArtwork))) return {
    status: 'awaiting_artwork_approval',
    approved: false,
    complete: false,
    nextAction: 'Resume to create and show the current original artwork preview.'
  };
  let approval;
  try {
    approval = await readRecord(jobRoot, 'review/approval.json');
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
  }
  return response(jobRoot, record, approval?.version === 1 && approval.reviewId === record.reviewId && approval.decision === 'approved');
}
module.exports = {
  artworkReviewContent,
  createArtworkReview,
  approveArtwork,
  inspectArtworkReview
};
