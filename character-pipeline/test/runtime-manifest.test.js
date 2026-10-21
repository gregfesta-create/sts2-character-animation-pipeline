'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildRuntimeManifest, stageRuntimeManifest } = require('../lib/runtime-manifest');
const resource = (id, file = id + '.gd', extra = {}) => ({ id, path: file, category: 'scripts', ...extra });
const capture = (file, text = 'extends Node\n') => { const bytes = Buffer.from(text); return { path: file, size: bytes.length, hash: require('node:crypto').createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') }; };
test('immutable captures stage exact owned bytes without consulting source paths', async t => {
  const stagingParent = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-capture-'));
  t.after(() => fs.rm(stagingParent, { recursive: true, force: true }));
  const item = capture('nested/a.gd');
  const manifest = buildRuntimeManifest({ roots: ['a'], resources: [resource('a', item.path)] });
  const result = await stageRuntimeManifest({ captures: [item], stagingParent, manifest });
  assert.equal(await fs.readFile(path.join(result.directory, item.path), 'utf8'), 'extends Node\n');
  assert.equal(result.totalBytes, item.size); assert.equal(result.files[0].hash, item.hash);
});
test('capture validation rejects ambiguous inputs, corruption, allowlist changes and budgets before staging', async t => {
  const stagingParent = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-capture-invalid-'));
  t.after(() => fs.rm(stagingParent, { recursive: true, force: true }));
  const item = capture('a.gd');
  const manifest = buildRuntimeManifest({ roots: ['a'], resources: [resource('a')] });
  for (const extra of [
    { sourceRoot: stagingParent }, { captures: undefined }, { captures: [] },
    { captures: [item, item] }, { captures: [item, capture('extra.gd')] },
    { captures: [{ ...item, hash: '0'.repeat(64) }] },
    { captures: [{ ...item, size: item.size + 1 }] },
    { captures: [{ ...item, base64: item.base64 + '\n' }] },
    { captures: [capture('../a.gd')] }, { maxBytes: item.size - 1 },
    { captures: [{ ...item, base64: 'A'.repeat(1000) }], maxBytes: 1 }
  ]) await assert.rejects(stageRuntimeManifest({ captures: [item], stagingParent, manifest, ...extra }));
  assert.deepEqual(await fs.readdir(stagingParent), []);
});
test('capture staging snapshots receipts before awaits and retains failed output without cleanup', async t => {
  const stagingParent = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-capture-retain-'));
  t.after(() => fs.rm(stagingParent, { recursive: true, force: true }));
  const item = capture('a.gd'), manifest = buildRuntimeManifest({ roots: ['a'], resources: [resource('a')] });
  const lstat = fs.lstat;
  t.mock.method(fs, 'lstat', async (...args) => { item.base64 = 'tampered'; item.hash = '0'.repeat(64); return lstat(...args); });
  const result = await stageRuntimeManifest({ captures: [item], stagingParent, manifest });
  assert.equal(await fs.readFile(path.join(result.directory, 'a.gd'), 'utf8'), 'extends Node\n');
  const executable = capture('a.gd', 'MZpayload');
  await assert.rejects(stageRuntimeManifest({ captures: [executable], stagingParent, manifest }), error => {
    assert.equal(error.code, 'UNEXPECTED_EXECUTABLE'); assert.equal(error.cleanupStatus, 'retained-unpublished');
    assert.deepEqual(error.stagingLimits, { maxFiles: 10000, maxBytes: 512 * 1024 * 1024 }); return true;
  });
  assert.equal((await fs.readdir(stagingParent)).length, 2);
});
test('the held final Windows output handle blocks nested and ancestor renames with EPERM', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-anchoring-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source'), stagingParent = path.join(base, 'output');
  await fs.mkdir(path.join(sourceRoot, 'assets'), { recursive: true }); await fs.mkdir(stagingParent);
  const source = path.join(sourceRoot, 'assets/a.gd'); await fs.writeFile(source, 'source');
  const open = fs.open; let checked = 0;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (file === source) {
      const stage = path.join(stagingParent, (await fs.readdir(stagingParent))[0]);
      for (const folder of [path.join(stage, 'assets'), stage, stagingParent]) {
        await assert.rejects(fs.rename(folder, folder + '-moved'), { code: 'EPERM' }); checked++;
      }
    }
    return open(file, ...args);
  });
  const manifest = buildRuntimeManifest({ roots: ['a'], resources: [resource('a', 'assets/a.gd')] });
  await stageRuntimeManifest({ sourceRoot, stagingParent, manifest });
  assert.equal(checked, 3);
});
for (const kind of ['same-inode overwrite', 'unexpected executable']) test(`final validation rejects ${kind}`, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-integrity-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source'), stagingParent = path.join(base, 'output');
  await fs.mkdir(sourceRoot); await fs.mkdir(stagingParent); await fs.writeFile(path.join(sourceRoot, 'a.gd'), 'approved bytes');
  const open = fs.open;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (kind === 'unexpected executable' && file === path.join(sourceRoot, 'a.gd')) {
      const stage = path.join(stagingParent, (await fs.readdir(stagingParent))[0]);
      await fs.writeFile(path.join(stage, 'unlisted.exe'), 'MZ unexpected');
    }
    const handle = await open(file, ...args);
    if (kind === 'same-inode overwrite' && file.startsWith(stagingParent + path.sep) && file.endsWith('a.gd')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...writeArgs) => { await write(...writeArgs); await fs.writeFile(file, 'tampered bytes'); };
    }
    return handle;
  });
  const manifest = buildRuntimeManifest({ roots: ['a'], resources: [resource('a')] });
  await assert.rejects(stageRuntimeManifest({ sourceRoot, stagingParent, manifest }), error => {
    assert.equal(error.cleanupStatus, 'retained-unpublished');
    assert.ok(['OUTPUT_CHANGED', 'UNEXPECTED_STAGED_FILE'].includes(error.code));
    return true;
  });
});
test('failed staging never unlinks paths that an adversary can replace', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-no-unlink-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source'), stagingParent = path.join(base, 'output');
  await fs.mkdir(sourceRoot); await fs.mkdir(stagingParent);
  await fs.writeFile(path.join(sourceRoot, 'a.gd'), 'source');
  await fs.writeFile(path.join(sourceRoot, 'b.gd'), 'source');
  const open = fs.open, unlink = fs.unlink; let output, calls = 0;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (file === path.join(sourceRoot, 'b.gd')) throw Object.assign(new Error('Injected failure'), { code: 'EIO' });
    if (file.startsWith(stagingParent + path.sep) && file.endsWith('a.gd')) output = file;
    return open(file, ...args);
  });
  t.mock.method(fs, 'unlink', async (file, ...args) => {
    calls++;
    if (file === output) { await unlink(file); await fs.writeFile(file, 'unrelated replacement'); }
    return unlink(file, ...args);
  });
  const manifest = buildRuntimeManifest({ roots: ['a', 'b'], resources: [resource('a'), resource('b')] });
  await assert.rejects(stageRuntimeManifest({ sourceRoot, stagingParent, manifest }), { code: 'EIO' });
  assert.equal(calls, 0);
  await unlink(output); await fs.writeFile(output, 'unrelated replacement');
  assert.equal(await fs.readFile(output, 'utf8'), 'unrelated replacement');
});
for (const kind of ['source', 'output']) test(`a failed ${kind} handle stat always closes the opened handle`, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-stat-failure-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source'), stagingParent = path.join(base, 'output');
  await fs.mkdir(sourceRoot); await fs.mkdir(stagingParent); await fs.writeFile(path.join(sourceRoot, 'a.gd'), 'source');
  const open = fs.open; let injected = false, closed = false;
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (!injected && (kind === 'source' ? file === path.join(sourceRoot, 'a.gd') : file.startsWith(stagingParent + path.sep) && file.endsWith('a.gd'))) {
      injected = true;
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); closed = true; };
      handle.stat = async () => { throw Object.assign(new Error('Injected fd stat failure'), { code: 'EIO' }); };
    }
    return handle;
  });
  const manifest = buildRuntimeManifest({ roots: ['a'], resources: [resource('a')] });
  await assert.rejects(stageRuntimeManifest({ sourceRoot, stagingParent, manifest }), { code: 'EIO' });
  assert.equal(injected, true); assert.equal(closed, true);
  await fs.rename(stagingParent, stagingParent + '-released');
});
test('an initial owned-directory stat failure preserves unknown identity without leaking handles', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-initial-stat-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source'), stagingParent = path.join(base, 'output');
  await fs.mkdir(sourceRoot); await fs.mkdir(stagingParent);
  const lstat = fs.lstat; let injected = false;
  t.mock.method(fs, 'lstat', async (file, ...args) => {
    if (!injected && file.startsWith(stagingParent + path.sep)) { injected = true; throw Object.assign(new Error('Injected lstat failure'), { code: 'EIO' }); }
    return lstat(file, ...args);
  });
  const manifest = buildRuntimeManifest({ roots: ['a'], resources: [resource('a')] });
  await assert.rejects(stageRuntimeManifest({ sourceRoot, stagingParent, manifest }), { code: 'EIO' });
  const names = await fs.readdir(stagingParent);
  assert.equal(names.length, 1); assert.deepEqual(await fs.readdir(path.join(stagingParent, names[0])), []);
  await fs.rename(stagingParent, stagingParent + '-released');
});
for (const swapParent of [false, true, 'nested']) test(`destination ${swapParent === 'nested' ? 'nested directory' : swapParent ? 'parent' : 'owned directory'} swap cannot publish outside bytes`, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-destination-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source'), stagingParent = path.join(base, 'output'), outside = path.join(base, 'outside');
  await fs.mkdir(sourceRoot); await fs.mkdir(stagingParent); await fs.mkdir(outside);
  const relative = swapParent === 'nested' ? 'assets/a.gd' : 'a.gd';
  if (swapParent === 'nested') await fs.mkdir(path.join(sourceRoot, 'assets'));
  await fs.writeFile(path.join(sourceRoot, relative), 'runtime secret');
  let swapped = false;
  async function swap(file) {
    if (swapped || typeof file !== 'string' || !file.startsWith(stagingParent + path.sep) || !file.endsWith('a.gd')) return;
    swapped = true;
    const target = swapParent === true ? stagingParent : path.dirname(file);
    await fs.rename(target, target + '-original');
    await fs.symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const write = fs.writeFile, open = fs.open;
  t.mock.method(fs, 'writeFile', async (file, ...args) => { await swap(file); return write(file, ...args); });
  t.mock.method(fs, 'open', async (file, ...args) => { await swap(file); return open(file, ...args); });
  const manifest = buildRuntimeManifest({ roots: ['a'], resources: [resource('a', relative)] });
  await assert.rejects(stageRuntimeManifest({ sourceRoot, stagingParent, manifest }));
  assert.equal(swapped, true);
  for (const name of await fs.readdir(outside)) assert.equal((await fs.stat(path.join(outside, name))).size, 0);
});
test('error cleanup cannot recursively delete an unrelated replacement directory', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-cleanup-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source'), stagingParent = path.join(base, 'output');
  await fs.mkdir(sourceRoot); await fs.mkdir(stagingParent); await fs.writeFile(path.join(sourceRoot, 'a.gd'), 'source');
  let replacement, blocked = false;
  const open = fs.open;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (file === path.join(sourceRoot, 'a.gd')) {
      const directory = path.join(stagingParent, (await fs.readdir(stagingParent))[0]);
      try { await fs.rename(directory, directory + '-owned'); }
      catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; blocked = true; }
      if (!blocked) { await fs.mkdir(directory); replacement = path.join(directory, 'unrelated.txt'); await fs.writeFile(replacement, 'preserve'); }
      throw Object.assign(new Error('Injected source error'), { code: 'EIO' });
    }
    return open(file, ...args);
  });
  const manifest = buildRuntimeManifest({ roots: ['a'], resources: [resource('a')] });
  await assert.rejects(stageRuntimeManifest({ sourceRoot, stagingParent, manifest }), { code: 'EIO' });
  if (replacement) assert.equal(await fs.readFile(replacement, 'utf8'), 'preserve');
  else assert.equal(blocked, true);
});
test('failed staging retains bounded unpublished artifacts and never removes directories', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-final-cleanup-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source'), stagingParent = path.join(base, 'output');
  await fs.mkdir(sourceRoot); await fs.mkdir(stagingParent);
  let removalCalls = 0;
  t.mock.method(fs, 'rmdir', async () => { removalCalls++; throw new Error('Directory removal is forbidden'); });
  t.mock.method(fs, 'rm', async () => { removalCalls++; throw new Error('Recursive removal is forbidden'); });
  const manifest = buildRuntimeManifest({ roots: ['a'], resources: [resource('a')] });
  await assert.rejects(stageRuntimeManifest({ sourceRoot, stagingParent, manifest, maxFiles: 1, maxBytes: 10 }), error => {
    assert.equal(error.code, 'MISSING_SOURCE'); assert.equal(error.cleanupStatus, 'retained-unpublished');
    assert.deepEqual(error.stagingLimits, { maxFiles: 1, maxBytes: 10 });
    assert.equal(path.dirname(error.stagingDirectory), stagingParent);
    return true;
  });
  assert.equal(removalCalls, 0);
  t.mock.restoreAll();
});
test('capture rejects a directory junction swapped immediately before open', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-swap-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source'), stagingParent = path.join(base, 'output'), outside = path.join(base, 'outside');
  await fs.mkdir(path.join(sourceRoot, 'assets'), { recursive: true }); await fs.mkdir(stagingParent); await fs.mkdir(outside);
  await fs.writeFile(path.join(sourceRoot, 'assets/a.gd'), 'inside'); await fs.writeFile(path.join(outside, 'a.gd'), 'outside secret');
  const open = fs.open;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (file === path.join(sourceRoot, 'assets/a.gd')) {
      await fs.rename(path.join(sourceRoot, 'assets'), path.join(sourceRoot, 'original'));
      await fs.symlink(outside, path.join(sourceRoot, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    return open(file, ...args);
  });
  const manifest = buildRuntimeManifest({ roots: ['a'], resources: [resource('a', 'assets/a.gd')] });
  await assert.rejects(stageRuntimeManifest({ sourceRoot, stagingParent, manifest }), { code: 'UNSAFE_PATH' });
  const retained = path.join(stagingParent, (await fs.readdir(stagingParent))[0]);
  assert.equal((await fs.stat(path.join(retained, 'assets/a.gd'))).size, 0);
});
test('capture rejects replacement of source contents after its bytes are read', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-replace-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source'), stagingParent = path.join(base, 'output');
  await fs.mkdir(sourceRoot); await fs.mkdir(stagingParent);
  const file = path.join(sourceRoot, 'a.gd'); await fs.writeFile(file, 'original');
  const open = fs.open;
  t.mock.method(fs, 'open', async (name, ...args) => {
    const handle = await open(name, ...args);
    if (name === file) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!result.bytesRead) await fs.writeFile(file, 'replacement');
        return result;
      };
    }
    return handle;
  });
  const manifest = buildRuntimeManifest({ roots: ['a'], resources: [resource('a')] });
  await assert.rejects(stageRuntimeManifest({ sourceRoot, stagingParent, manifest }), { code: 'SOURCE_CHANGED' });
  const retained = path.join(stagingParent, (await fs.readdir(stagingParent))[0]);
  assert.equal((await fs.stat(path.join(retained, 'a.gd'))).size, 0);
});
test('reachable allowlist is deterministic, explicit and includes declared dynamic references', () => {
  const resources = [resource('unused'), resource('root', 'main.tscn', { dependencies: ['script'], dynamicReferences: ['sound'] }), resource('sound', 'cue.ogg', { category: 'audio' }), resource('script')];
  const manifest = buildRuntimeManifest({ roots: ['root'], resources });
  assert.deepEqual(manifest.allowlist, ['cue.ogg', 'main.tscn', 'script.gd']);
  assert.deepEqual(manifest, buildRuntimeManifest({ roots: ['root'], resources: resources.reverse() }));
});
test('invalid graphs fail with actionable codes', () => {
  const check = (resources, code, roots = ['a']) => assert.throws(() => buildRuntimeManifest({ roots, resources }), { code });
  check([resource('a', 'a.gd', { dependencies: ['missing'] })], 'MISSING_RESOURCE');
  check([resource('a', 'a.gd', { dependencies: ['a'] })], 'DEPENDENCY_CYCLE');
  check([resource('a'), resource('a')], 'DUPLICATE_LOGICAL_ID');
  check([resource('a'), resource('b', 'a.gd')], 'LOGICAL_OWNER_CONFLICT');
  check([resource('a', 'A.gd'), resource('b', 'a.gd')], 'PATH_COLLISION');
  check([resource('a', 'evidence/a.png')], 'PROHIBITED_DEPENDENCY');
  check([resource('a', 'code.cs')], 'PROHIBITED_DEPENDENCY');
  check([resource('a', '../a.gd')], 'UNSAFE_PATH');
  check([resource('a', 'tool.exe')], 'UNEXPECTED_EXECUTABLE');
  check([resource('a', 'a.gd', { dynamicReferences: [null] })], 'UNDECLARED_DYNAMIC_REFERENCE');
});
test('native imported resources and required scripts remain eligible', () => {
  assert.deepEqual(buildRuntimeManifest({ roots: ['a'], resources: [resource('a', '.godot/imported/a.ctex')] }).allowlist, ['.godot/imported/a.ctex']);
});
test('external dependencies are declared without being copied and unknown dynamic references block staging', () => {
  const a = resource('a', 'a.gd', { dynamicReferences: ['BaseLib'] });
  assert.throws(() => buildRuntimeManifest({ roots: ['a'], resources: [a] }), { code: 'UNDECLARED_DYNAMIC_REFERENCE' });
  assert.deepEqual(buildRuntimeManifest({ roots: ['a'], resources: [a], externalDependencies: ['BaseLib'] }).allowlist, ['a.gd']);
  assert.throws(() => buildRuntimeManifest({ roots: ['a'], resources: [resource('a', 'asset.gd'), resource('b', 'asset.gd/child.gd')] }), { code: 'PATH_COLLISION' });
});
test('junction escapes in source and staging parent are rejected', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-link-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source'); const stagingParent = path.join(base, 'output'); const outside = path.join(base, 'outside');
  await fs.mkdir(sourceRoot); await fs.mkdir(stagingParent); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'a.gd'), 'safe');
  await fs.symlink(outside, path.join(sourceRoot, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.symlink(stagingParent, path.join(base, 'linked-output'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = buildRuntimeManifest({ roots: ['a'], resources: [resource('a', 'link/a.gd')] });
  await assert.rejects(stageRuntimeManifest({ sourceRoot, stagingParent, manifest }), { code: 'UNSAFE_PATH' });
  await assert.rejects(stageRuntimeManifest({ sourceRoot, stagingParent: path.join(base, 'linked-output'), manifest }), { code: 'UNSAFE_PATH' });
});
test('contained staging preserves paths and source bytes, shares identity only with matching settings', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-manifest-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source');
  const stagingParent = path.join(base, 'output');
  await fs.mkdir(sourceRoot); await fs.mkdir(stagingParent);
  for (const file of ['a.png', 'b.png', 'c.png', 'unused.png']) await fs.writeFile(path.join(sourceRoot, file), 'same');
  const manifest = buildRuntimeManifest({ roots: ['a', 'b', 'c'], resources: ['a', 'b', 'c'].map(id => resource(id, id + '.png', { category: 'textures', importSettings: { srgb: id !== 'c' } })) });
  const result = await stageRuntimeManifest({ sourceRoot, stagingParent, manifest });
  assert.equal(result.nativeExportStatus, 'pending');
  assert.deepEqual((await fs.readdir(result.directory)).sort(), ['a.png', 'b.png', 'c.png']);
  assert.equal(result.files[0].shareIdentity, result.files[1].shareIdentity);
  assert.notEqual(result.files[0].shareIdentity, result.files[2].shareIdentity);
  assert.equal(await fs.readFile(path.join(sourceRoot, 'unused.png'), 'utf8'), 'same');
  await assert.rejects(stageRuntimeManifest({ sourceRoot, stagingParent: sourceRoot, manifest }), { code: 'UNSAFE_STAGING' });
  await assert.rejects(stageRuntimeManifest({ sourceRoot, stagingParent, manifest, maxBytes: 1 }), { code: 'QUOTA_EXCEEDED' });
});
test('staging rejects missing files and executable contents under innocuous names', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-manifest-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source'); const stagingParent = path.join(base, 'output');
  await fs.mkdir(sourceRoot); await fs.mkdir(stagingParent);
  const manifest = buildRuntimeManifest({ roots: ['a'], resources: [resource('a')] });
  await assert.rejects(stageRuntimeManifest({ sourceRoot, stagingParent, manifest }), { code: 'MISSING_SOURCE' });
  await fs.writeFile(path.join(sourceRoot, 'a.gd'), Buffer.from([0x4d, 0x5a, 0, 0]));
  await assert.rejects(stageRuntimeManifest({ sourceRoot, stagingParent, manifest }), { code: 'UNEXPECTED_EXECUTABLE' });
});
