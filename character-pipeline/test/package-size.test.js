'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { stageRuntimeManifest } = require('../lib/runtime-manifest');
const { reportPackageSize } = require('../lib/package-size');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'size-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source'), stagingParent = path.join(root, 'owned');
  await fs.mkdir(sourceRoot); await fs.mkdir(stagingParent);
  await fs.writeFile(path.join(sourceRoot, 'a.gd'), 'hello');
  await fs.writeFile(path.join(sourceRoot, 'b.gd'), 'hello');
  const staged = await stageRuntimeManifest({ sourceRoot, stagingParent, manifest: { roots: ['a', 'b'], resources: ['a', 'b'].map(id => ({ id, path: id + '.gd', category: 'scripts' })) } });
  return { staged, ownedRoot: stagingParent };
}
test('reports actual physical bytes deterministically without claiming metadata sharing saves bytes', async t => {
  const input = await fixture(t), report = await reportPackageSize(input);
  assert.equal(report.installedBytes, 10);
  assert.deepEqual(report.categories.scripts, { count: 2, bytes: 10 });
  assert.equal(report.duplicateBytesAvoided, 0);
  assert.equal(report.archiveBytes, null);
  assert.equal(report.baseline.status, 'unavailable');
  assert.equal(report.budget.status, 'unset');
  assert.ok(Object.isFrozen(report.largestFiles));
  assert.deepEqual(report, await reportPackageSize(input));
});
test('verifies hashes, bytes and exact allowlist', async t => {
  const input = await fixture(t);
  await fs.writeFile(path.join(input.staged.directory, 'a.gd'), 'other');
  await assert.rejects(reportPackageSize(input), { code: 'CONTENT_MISMATCH' });
  await fs.writeFile(path.join(input.staged.directory, 'a.gd'), 'hello');
  await fs.writeFile(path.join(input.staged.directory, 'extra'), 'x');
  await assert.rejects(reportPackageSize(input), { code: 'ALLOWLIST_MISMATCH' });
});
test('measures optional owned archive and checks explicit budgets', async t => {
  const input = await fixture(t);
  await fs.writeFile(path.join(input.ownedRoot, 'candidate.zip'), Buffer.alloc(17));
  const report = await reportPackageSize({ ...input, archivePath: 'candidate.zip', budgets: { installedBytes: 11, archiveBytes: 18, categories: { scripts: 11 } } });
  assert.equal(report.archiveBytes, 17);
  assert.equal(report.containerOverheadBytes, null);
  assert.equal(report.budget.status, 'passed');
  await assert.rejects(reportPackageSize({ ...input, budgets: { installedBytes: 9 } }), { code: 'BUDGET_EXCEEDED' });
  for (const budgets of [{ categories: { surprise: 2 } }, { archiveBytes: 0 }, { other: 5 }]) await assert.rejects(reportPackageSize({ ...input, budgets }), { code: 'INVALID_BUDGET' });
  input.staged.files[0].category = 'surprise';
  await assert.rejects(reportPackageSize(input), { code: 'UNKNOWN_CATEGORY' });
});
test('rejects outside staging, linked files, and traversal archives', async t => {
  const input = await fixture(t);
  await assert.rejects(reportPackageSize({ ...input, ownedRoot: input.staged.directory }), { code: 'UNSAFE_PATH' });
  await assert.rejects(reportPackageSize({ ...input, archivePath: '../outside.zip' }), { code: 'UNSAFE_PATH' });
  await fs.copyFile(path.join(input.staged.directory, 'a.gd'), path.join(input.ownedRoot, 'original'));
  await fs.unlink(path.join(input.staged.directory, 'a.gd'));
  try { await fs.symlink(path.join(input.ownedRoot, 'original'), path.join(input.staged.directory, 'a.gd')); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Windows symlink privilege unavailable'); throw error; }
  await assert.rejects(reportPackageSize(input), { code: 'UNSAFE_PATH' });
});
test('detects file replacement during bounded read', async t => {
  const input = await fixture(t), open = fs.open;
  t.mock.method(fs, 'open', async (name, ...args) => {
    const handle = await open(name, ...args), read = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await read(...readArgs);
      if (!result.bytesRead) await fs.writeFile(name, 'changed');
      return result;
    };
    return handle;
  });
  await assert.rejects(reportPackageSize(input), { code: 'SOURCE_CHANGED' });
});
test('compares measured baseline and identifies added removed and replaced contributors', async t => {
  const input = await fixture(t), old = await reportPackageSize(input);
  const baseline = { ...old, installedBytes: 13, archiveBytes: 20, categories: { ...old.categories, scripts: { count: 2, bytes: 13 } }, largestFiles: [{ ...old.largestFiles[0], bytes: 7, hash: 'a'.repeat(64) }, { ...old.largestFiles[1], path: 'removed.gd', bytes: 6 }] };
  const report = await reportPackageSize({ ...input, baseline });
  assert.equal(report.baseline.status, 'available');
  assert.equal(report.baseline.growthBytes, -3);
  assert.equal(report.baseline.archiveDeltaBytes, null);
  assert.equal(report.baseline.categoryDeltas.scripts.bytes, -3);
  assert.deepEqual(report.baseline.changes.map(c => [c.path, c.kind, c.deltaBytes]), [['a.gd', 'replaced', -2], ['b.gd', 'added', 5], ['removed.gd', 'removed', -6]]);
  assert.deepEqual(report, await reportPackageSize({ ...input, baseline }));
  await fs.writeFile(path.join(input.ownedRoot, 'candidate.zip'), Buffer.alloc(17));
  assert.equal((await reportPackageSize({ ...input, baseline, archivePath: 'candidate.zip' })).baseline.archiveDeltaBytes, -3);
  for (const invalid of [{}, { ...baseline, installedBytes: -1 }, { ...baseline, largestFiles: [...baseline.largestFiles, baseline.largestFiles[0]] }, { ...baseline, archiveBytes: Infinity }, { ...baseline, largestFiles: [{ path: '../escape', hash: 'bad', bytes: 1 }] }]) await assert.rejects(reportPackageSize({ ...input, baseline: invalid }), { code: 'INVALID_BASELINE' });
});
