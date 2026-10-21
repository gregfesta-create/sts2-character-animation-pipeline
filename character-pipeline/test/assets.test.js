'use strict';

const {
  test
} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const a = require('../lib/assets');
test('canonical hashes and safe immutable source publication', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assets-'));
  t.after(() => fs.rm(root, {
    recursive: true,
    force: true
  }));
  await fs.mkdir(path.join(root, 'input'));
  await fs.mkdir(path.join(root, 'job'));
  await fs.writeFile(path.join(root, 'input', 'a'), 'hello');
  assert.equal(a.hashValue({
    b: 2,
    a: 1
  }), a.hashValue({
    a: 1,
    b: 2
  }));
  const r = await a.publishSource(path.join(root, 'input'), 'a', path.join(root, 'job'));
  assert.equal(await a.hashFile(r.path), r.hash);
  assert.deepEqual(await a.publishSource(path.join(root, 'input'), 'a', path.join(root, 'job')), r);
  await assert.rejects(a.resolveContained(root, '../x'));
  await assert.rejects(a.resolveContained(root, path.resolve(root, 'x')));
  await assert.rejects(a.publishSource(path.join(root, 'input'), 'a', path.join(root, 'job'), {
    maxBytes: 1
  }));
  assert.throws(() => a.canonicalJson({
    x: undefined
  }));
});
test('reject links, missing files, malformed JSON values and changed immutable sources', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-assets-'));
  t.after(() => fs.rm(root, {
    recursive: true,
    force: true
  }));
  await fs.mkdir(path.join(root, 'outside'));
  await fs.writeFile(path.join(root, 'outside', 'a'), 'original');
  await fs.mkdir(path.join(root, 'inside'));
  await fs.symlink(path.join(root, 'outside'), path.join(root, 'inside', 'link'), 'junction');
  await assert.rejects(a.resolveContained(path.join(root, 'inside'), 'link/a'), {
    code: 'UNSAFE_PATH'
  });
  await assert.rejects(a.resolveContained(root, 'missing'));
  assert.throws(() => a.canonicalJson(Infinity));
  assert.throws(() => a.canonicalJson(new Date()));
  const cyclic = {};
  cyclic.x = cyclic;
  assert.throws(() => a.canonicalJson(cyclic));
  assert.equal(a.canonicalJson([null, true, 2, 'a']), '[null,true,2,"a"]');
  const r = await a.publishSource(path.join(root, 'outside'), 'a', path.join(root, 'job'));
  await fs.writeFile(r.path, 'modified');
  await assert.rejects(a.publishSource(path.join(root, 'outside'), 'a', path.join(root, 'job')), {
    code: 'CORRUPT_ARTIFACT'
  });
  await assert.rejects(a.publishSource(root, 'outside', path.join(root, 'job')), {
    code: 'INVALID_INPUT'
  });
  await assert.rejects(a.publishSource(root, 'outside/a', path.join(root, 'job'), {
    maxBytes: -1
  }), {
    code: 'INVALID_INPUT'
  });
});
