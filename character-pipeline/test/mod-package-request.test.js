'use strict';

const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const {
  validateModPackageRequest,
  packagingRequestIdentity,
  captureModPackageRequest,
  SDK_REQUIRED_FILES,
  DOTNET_REQUIRED_FILES
} = require('../lib/mod-package-request');
const request = root => ({
  version: 1,
  profile: 'sts2-godot451-net9',
  mod: {
    id: 'numeric_mod',
    name: 'Numeric',
    author: 'Tester',
    description: 'Fixture',
    version: '1.0.0',
    affectsGameplay: false
  },
  sources: [{
    name: 'Initializer.cs',
    path: path.join(root, 'init.cs'),
    initializer: true
  }],
  references: Object.fromEntries(['sts2', '0Harmony', 'BaseLib', 'Steamworks.NET'].map(r => [r, path.join(root, r + '.dll')])),
  baseLibManifest: path.join(root, 'BaseLib.json')
});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mod-input-'));
  t.after(() => fs.rm(root, {
    recursive: true,
    force: true
  }));
  const config = {
    runtimeRoots: [root],
    tools: {
      dotnet: {
        executable: path.join(root, 'dotnet.exe')
      }
    },
    modPackaging: {
      sdkCacheRoot: path.join(root, 'cache'),
      dotnetSdkVersion: '10.0.400'
    }
  };
  const r = request(root);
  await fs.writeFile(r.sources[0].path, 'public class Init {}');
  const pe = Buffer.alloc(128);
  pe.write('MZ');
  pe.writeUInt32LE(64, 60);
  pe.write('PE\0\0', 64);
  for (const f of Object.values(r.references)) await fs.writeFile(f, pe);
  await fs.writeFile(config.tools.dotnet.executable, pe);
  await fs.writeFile(r.baseLibManifest, JSON.stringify({
    id: 'BaseLib',
    version: 'v3.4.7',
    has_dll: true,
    has_pck: true
  }));
  for (const f of SDK_REQUIRED_FILES) {
    const p = path.join(config.modPackaging.sdkCacheRoot, f);
    await fs.mkdir(path.dirname(p), {
      recursive: true
    });
    await fs.writeFile(p, 'fixture');
  }
  for (const f of DOTNET_REQUIRED_FILES) {
    const p = path.join(root, 'sdk', '10.0.400', f);
    await fs.mkdir(path.dirname(p), {
      recursive: true
    });
    await fs.writeFile(p, 'compiler fixture');
  }
  return {
    root,
    config,
    r
  };
}
test('pure request identity rejects unknown fields/accessors before IO', () => {
  const r = request(path.resolve('missing'));
  assert.equal(validateModPackageRequest(r).mod.id, 'numeric_mod');
  const config = {
    runtimeRoots: [path.resolve('missing')],
    tools: {
      dotnet: {
        executable: path.resolve('missing/tool')
      }
    },
    modPackaging: {
      sdkCacheRoot: path.resolve('missing/cache'),
      dotnetSdkVersion: '10.0.400'
    }
  };
  assert.equal(packagingRequestIdentity(r, {
    config
  }), packagingRequestIdentity(structuredClone(r), {
    config
  }));
  assert.throws(() => validateModPackageRequest({
    ...r,
    args: []
  }));
  let read = false;
  Object.defineProperty(r, 'evil', {
    enumerable: true,
    get() {
      read = true;
      throw Error();
    }
  });
  assert.throws(() => validateModPackageRequest(r));
  assert.equal(read, false);
});
test('capture binds immutable source reference manifest tool and SDK bytes', async t => {
  const {
    config,
    r
  } = await fixture(t);
  const got = await captureModPackageRequest(r, {
    config
  });
  assert.equal(got.sources.length, 1);
  assert.equal(got.references.length, 4);
  assert.equal(got.baseLibVersion, '3.4.7');
  assert.ok(got.sdk.files.length >= SDK_REQUIRED_FILES.length);
  assert.ok(Object.isFrozen(got.sources[0]));
  await fs.writeFile(r.sources[0].path, 'changed');
  assert.equal(Buffer.from(got.sources[0].base64, 'base64').toString(), 'public class Init {}');
  assert.match(got.tool.hash, /^[a-f0-9]{64}$/);
});
test('source collisions, initializer count and forbidden schema rejected', () => {
  const r = request(path.resolve('.'));
  assert.throws(() => validateModPackageRequest({
    ...r,
    sources: [r.sources[0], {
      ...r.sources[0],
      name: 'initializer.CS'
    }]
  }));
  assert.throws(() => validateModPackageRequest({
    ...r,
    sources: [{
      ...r.sources[0],
      initializer: false
    }]
  }));
  assert.throws(() => validateModPackageRequest({
    ...r,
    sources: [{
      ...r.sources[0],
      name: 'CON.cs'
    }]
  }));
  assert.throws(() => validateModPackageRequest({
    ...r,
    mod: {
      ...r.mod,
      version: 'bad'
    }
  }));
  const cycle = {};
  cycle.x = cycle;
  assert.throws(() => validateModPackageRequest(cycle));
});
test('dedicated roots, malformed PE, manifest mismatch, missing SDK and cancellation fail closed', async t => {
  const {
    config,
    r,
    root
  } = await fixture(t);
  await assert.rejects(captureModPackageRequest(r, {
    config: {
      ...config,
      runtimeRoots: [path.join(root, 'cache')]
    }
  }), {
    code: 'UNSAFE_PATH'
  });
  await fs.writeFile(r.references.sts2, 'not PE');
  await assert.rejects(captureModPackageRequest(r, {
    config
  }), {
    code: 'INVALID_PACKAGE_REQUEST'
  });
  const f = await fixture(t);
  await assert.rejects(captureModPackageRequest({
    ...f.r,
    expectedBaseLibVersion: '3.4.8'
  }, {
    config: f.config
  }), {
    code: 'INVALID_PACKAGE_REQUEST'
  });
  await fs.rm(path.join(f.config.modPackaging.sdkCacheRoot, SDK_REQUIRED_FILES[0]));
  await assert.rejects(captureModPackageRequest(f.r, {
    config: f.config
  }), {
    code: 'CAPABILITY_MISSING'
  });
  await assert.rejects(captureModPackageRequest(r, {
    config,
    signal: AbortSignal.abort()
  }), {
    code: 'ABORTED'
  });
});
test('linked source and quota reject before capture', async t => {
  const {
    config,
    r,
    root
  } = await fixture(t);
  const link = path.join(root, 'linked.cs');
  try {
    await fs.symlink(r.sources[0].path, link);
  } catch (e) {
    if (e.code === 'EPERM') return;
    throw e;
  }
  await assert.rejects(captureModPackageRequest({
    ...r,
    sources: [{
      ...r.sources[0],
      path: link
    }]
  }, {
    config
  }), {
    code: 'UNSAFE_PATH'
  });
  await fs.writeFile(r.sources[0].path, Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(captureModPackageRequest(r, {
    config
  }), {
    code: 'QUOTA_EXCEEDED'
  });
});
test('tool and selected compiler identities revalidate without original source or references', async t => {
  const {
    revalidateModPackageTools
  } = require('../lib/mod-package-request');
  const {
    config,
    r
  } = await fixture(t);
  const got = await captureModPackageRequest(r, {
    config
  });
  await fs.rm(r.sources[0].path);
  await fs.rm(r.references.sts2);
  await revalidateModPackageTools(got, {
    config
  });
  await fs.writeFile(got.sdk.dotnetFiles[0].path, 'changed');
  await assert.rejects(revalidateModPackageTools(got, {
    config
  }), {
    code: 'PACKAGE_REFRESH_REQUIRED'
  });
  await fs.rm(got.tool.path);
  await assert.rejects(revalidateModPackageTools(got, {
    config
  }), {
    code: 'CAPABILITY_MISSING'
  });
});
test('persisted captures reject forged metadata paths and byte receipts', async t => {
  const {
    validateCapturedModPackageInputs
  } = require('../lib/mod-package-request');
  const {
    config,
    r
  } = await fixture(t);
  const got = await captureModPackageRequest(r, {
    config
  });
  assert.equal(validateCapturedModPackageInputs(got, {
    config
  }).requestIdentity, got.requestIdentity);
  for (const change of [x => x.metadata.id = 'other', x => x.sources[0].hash = '0'.repeat(64), x => x.sdk.dotnetRoot = path.resolve('elsewhere'), x => x.references[0].role = 'other']) {
    const bad = structuredClone(got);
    change(bad);
    assert.throws(() => validateCapturedModPackageInputs(bad, {
      config
    }));
  }
});
test('rename during capture cannot substitute another same-sized file', async t => {
  const {
      config,
      r
    } = await fixture(t),
    original = fs.open;
  let replaced = false;
  fs.open = async function (file, ...args) {
    const h = await original.call(this, file, ...args);
    if (file === r.sources[0].path && !replaced) {
      replaced = true;
      await fs.rename(file, file + '.old');
      await fs.writeFile(file, 'public class Bad {}');
    }
    return h;
  };
  try {
    await assert.rejects(captureModPackageRequest(r, {
      config
    }), {
      code: 'SOURCE_CHANGED'
    });
  } finally {
    fs.open = original;
  }
});
test('SDK inventory additions require refresh and missing selected compiler gives capability diagnostic', async t => {
  const {
    revalidateModPackageTools
  } = require('../lib/mod-package-request');
  const {
    config,
    r
  } = await fixture(t);
  const got = await captureModPackageRequest(r, {
    config
  });
  const extra = path.join(got.sdk.root, 'godot.net.sdk/4.5.1/Sdk/Unexpected.targets');
  await fs.writeFile(extra, 'extra');
  await assert.rejects(revalidateModPackageTools(got, {
    config
  }), {
    code: 'PACKAGE_REFRESH_REQUIRED'
  });
  await fs.rm(extra);
  await fs.rm(got.sdk.dotnetFiles[0].path);
  await assert.rejects(revalidateModPackageTools(got, {
    config
  }), {
    code: 'CAPABILITY_MISSING'
  });
});
test('registered adapter rejects BaseLib below its proven minimum', async t => {
  const {
    config,
    r
  } = await fixture(t);
  await fs.writeFile(r.baseLibManifest, JSON.stringify({
    id: 'BaseLib',
    version: 'v3.4.6',
    has_dll: true,
    has_pck: true
  }));
  await assert.rejects(captureModPackageRequest(r, {
    config
  }), {
    code: 'INVALID_PACKAGE_REQUEST'
  });
});
test("runtime mod identifiers reject Windows device names", () => {
  const r = request(path.resolve("."));
  for (const id of ["CON", "nul", "COM1", "LPT9"]) assert.throws(() => validateModPackageRequest({
    ...r,
    mod: {
      ...r.mod,
      id
    }
  }));
});
test('plain request bounds own keys and key bytes before retrieving descriptors', () => {
  for (const raw of [Object.fromEntries(Array.from({
    length: 1001
  }, (_, i) => ['k' + i, 0])), {
    ['x'.repeat(1024 * 1024 + 1)]: 0
  }]) {
    let descriptors = 0;
    const input = new Proxy(raw, {
      getOwnPropertyDescriptor(target, key) {
        descriptors++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });
    assert.throws(() => validateModPackageRequest(input), {
      code: 'INVALID_PACKAGE_REQUEST'
    });
    assert.equal(descriptors, 0);
  }
});
test('persisted input paths remain under runtime authority even with recomputed request identity', async t => {
  const {
    validateCapturedModPackageInputs
  } = require('../lib/mod-package-request');
  const {
    config,
    r,
    root
  } = await fixture(t);
  const captured = await captureModPackageRequest(r, {
    config
  });
  for (const kind of ['source', 'reference', 'manifest']) {
    const bad = structuredClone(captured),
      outside = path.join(path.dirname(root), 'outside-input');
    if (kind === 'source') {
      bad.request.sources[0].path = outside;
      bad.sources[0].path = outside;
    } else if (kind === 'reference') {
      bad.request.references.sts2 = outside;
      bad.references[0].path = outside;
    } else {
      bad.request.baseLibManifest = outside;
      bad.baseLibManifest.path = outside;
    }
    bad.requestIdentity = packagingRequestIdentity(bad.request, {
      config
    });
    assert.throws(() => validateCapturedModPackageInputs(bad, {
      config
    }), {
      code: 'UNSAFE_PATH'
    });
  }
});
for (const kind of ['depth', 'nodes']) test('SDK traversal bounds ' + kind, async t => {
  const {
      config,
      r
    } = await fixture(t),
    base = path.join(config.modPackaging.sdkCacheRoot, 'godot.net.sdk/4.5.1');
  if (kind === 'depth') {
    await fs.mkdir(path.join(base, ...Array(18).fill('nested')), {
      recursive: true
    });
  } else {
    for (let i = 0; i < 9; i++) {
      const parent = path.join(base, 'empty' + i);
      await fs.mkdir(parent);
      await Promise.all(Array.from({
        length: 240
      }, (_, j) => fs.mkdir(path.join(parent, 'leaf' + j))));
    }
  }
  await assert.rejects(captureModPackageRequest(r, {
    config
  }), {
    code: 'QUOTA_EXCEEDED'
  });
});
test('BaseLib malformed JSON shapes fail typed validation for fresh and persisted inputs', async t => {
  const {
    validateCapturedModPackageInputs
  } = require('../lib/mod-package-request');
  const {
      config,
      r
    } = await fixture(t),
    captured = await captureModPackageRequest(r, {
      config
    });
  for (const value of [null, [], 42, 'BaseLib', true]) {
    const bytes = Buffer.from(JSON.stringify(value));
    await fs.writeFile(r.baseLibManifest, bytes);
    await assert.rejects(captureModPackageRequest(r, {
      config
    }), {
      code: 'INVALID_PACKAGE_REQUEST'
    });
    const forged = structuredClone(captured);
    Object.assign(forged.baseLibManifest, {
      base64: bytes.toString('base64'),
      size: bytes.length,
      hash: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
      metadata: value
    });
    forged.baseLibManifest.identity.size = String(bytes.length);
    assert.throws(() => validateCapturedModPackageInputs(forged, {
      config
    }), {
      code: 'INVALID_PACKAGE_REQUEST'
    });
  }
  const forged = structuredClone(captured);
  forged.baseLibManifest.metadata = null;
  assert.throws(() => validateCapturedModPackageInputs(forged, {
    config
  }), {
    code: 'INVALID_PACKAGE_REQUEST'
  });
});
test('BaseLib UTF8 BOM is accepted without changing byte authority and invalid UTF8 fails typed', async t => {
  const {
    validateCapturedModPackageInputs
  } = require('../lib/mod-package-request');
  const {
    config,
    r
  } = await fixture(t);
  const json = await fs.readFile(r.baseLibManifest);
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), json]);
  await fs.writeFile(r.baseLibManifest, bom);
  const got = await captureModPackageRequest(r, {
    config
  });
  assert.equal(got.baseLibManifest.base64, bom.toString('base64'));
  assert.equal(validateCapturedModPackageInputs(got, {
    config
  }).baseLibVersion, '3.4.7');
  const bad = Buffer.concat([json.subarray(0, json.length - 1), Buffer.from(',"bad":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  await fs.writeFile(r.baseLibManifest, bad);
  await assert.rejects(captureModPackageRequest(r, {
    config
  }), {
    code: 'INVALID_PACKAGE_REQUEST'
  });
  const forged = structuredClone(got);
  Object.assign(forged.baseLibManifest, {
    base64: bad.toString('base64'),
    size: bad.length,
    hash: require('node:crypto').createHash('sha256').update(bad).digest('hex')
  });
  forged.baseLibManifest.identity.size = String(bad.length);
  assert.throws(() => validateCapturedModPackageInputs(forged, {
    config
  }), {
    code: 'INVALID_PACKAGE_REQUEST'
  });
});
test('malformed captured top shapes and scalar mod IDs fail typed without coercion', async t => {
  const {
    validateCapturedModPackageInputs
  } = require('../lib/mod-package-request');
  const {
    config,
    r
  } = await fixture(t);
  for (const value of [null, true, 42, 'input', []]) assert.throws(() => validateCapturedModPackageInputs(value, {
    config
  }), {
    code: 'INVALID_PACKAGE_REQUEST'
  });
  for (const id of [null, true, false, 42, {}, []]) assert.throws(() => validateModPackageRequest({
    ...r,
    mod: {
      ...r.mod,
      id
    }
  }), {
    code: 'INVALID_PACKAGE_REQUEST'
  });
  const got = await captureModPackageRequest(r, {
    config
  });
  for (const field of ['request', 'metadata', 'mod', 'sources', 'references', 'baseLibManifest', 'sdk', 'tool']) {
    const bad = structuredClone(got);
    bad[field] = null;
    assert.throws(() => validateCapturedModPackageInputs(bad, {
      config
    }), {
      code: 'INVALID_PACKAGE_REQUEST'
    });
  }
});
test('equivalent configured Windows slash spelling revalidates captured tool', async t => {
  const {
    revalidateModPackageTools
  } = require('../lib/mod-package-request');
  const {
    config,
    r
  } = await fixture(t);
  config.tools.dotnet.executable = config.tools.dotnet.executable.replaceAll('\\', '/');
  const got = await captureModPackageRequest(r, {
    config
  });
  assert.equal(await revalidateModPackageTools(got, {
    config
  }), true);
  assert.equal(packagingRequestIdentity(r, {
    config
  }), packagingRequestIdentity(r, {
    config: {
      ...config,
      tools: {
        ...config.tools,
        dotnet: {
          ...config.tools.dotnet,
          executable: path.resolve(config.tools.dotnet.executable)
        }
      }
    }
  }));
});
