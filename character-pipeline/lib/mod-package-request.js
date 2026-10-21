'use strict';

const fs = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto');
const {
  resolveContained,
  hashValue
} = require('./assets');
const DOTNET_REQUIRED_FILES = ['MSBuild.dll', 'Roslyn/bincore/csc.dll', 'Roslyn/bincore/Microsoft.CodeAnalysis.dll', 'Roslyn/bincore/Microsoft.CodeAnalysis.CSharp.dll', 'Roslyn/bincore/csc.deps.json', 'Roslyn/bincore/csc.runtimeconfig.json', 'Sdks/Microsoft.NET.Sdk/Sdk/Sdk.props', 'Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets'];
const PROFILE = 'sts2-godot451-net9',
  ROLES = ['sts2', '0Harmony', 'BaseLib', 'Steamworks.NET'];
const SDK_REQUIRED_FILES = [...['Sdk.props', 'Sdk.targets', 'SdkPackageVersions.props', 'Android.props', 'iOSNativeAOT.props', 'iOSNativeAOT.targets'].map(n => 'godot.net.sdk/4.5.1/Sdk/' + n), 'godotsharp/4.5.1/lib/net8.0/GodotSharp.dll', 'godot.sourcegenerators/4.5.1/analyzers/dotnet/cs/Godot.SourceGenerators.dll', 'godot.sourcegenerators/4.5.1/build/Godot.SourceGenerators.props', ...['godot.net.sdk', 'godotsharp', 'godot.sourcegenerators'].flatMap(n => [`${n}/4.5.1/${n}.nuspec`, `${n}/4.5.1/${n}.4.5.1.nupkg`, `${n}/4.5.1/.nupkg.metadata`])];
const fail = (code, message) => Object.assign(new Error(message), {
  code
});
const invalid = () => {
  throw fail('INVALID_PACKAGE_REQUEST', 'Invalid explicit mod packaging request');
};
const abort = s => {
  if (s !== undefined && !(s instanceof AbortSignal)) invalid();
  if (s?.aborted) throw fail('ABORTED', 'Mod input capture cancelled');
};
const text = (v, n) => typeof v === 'string' && v.length > 0 && v.length <= n && !v.includes('\0');
const absolute = v => text(v, 4096) && path.isAbsolute(v) && !v.split(/[\\/]/).includes('..');
const version = v => typeof v === 'string' && /^v?\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[A-Za-z0-9.-]{1,64})?$/.test(v);
const normalize = v => v.replace(/^v/, '');
const compatibleBaseLib = v => {
  if (!version(v)) return false;
  const n = normalize(v),
    parts = n.split(/[.-]/).slice(0, 3).map(Number);
  return parts[0] === 3 && (parts[1] > 4 || parts[1] === 4 && (parts[2] > 7 || parts[2] === 7 && !n.includes('-')));
};
function plain(value, maxBytes = 1024 * 1024) {
  let count = 0,
    bytes = 0;
  const seen = new Set();
  function walk(v, depth) {
    if (++count > 10000 || depth > 12) invalid();
    if (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      bytes += Buffer.byteLength(v);
      if (bytes > maxBytes) invalid();
      return v;
    }
    if (!v || typeof v !== 'object' || seen.has(v) || !Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v))) invalid();
    seen.add(v);
    const ownKeys = Reflect.ownKeys(v);
    if (ownKeys.length > 1000 || ownKeys.some(k => typeof k !== 'string')) invalid();
    for (const k of ownKeys) {
      bytes += Buffer.byteLength(k);
      if (bytes > maxBytes) invalid();
    }
    const out = Array.isArray(v) ? [] : {};
    for (const k of ownKeys) {
      if (Array.isArray(v) && k === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!d.enumerable || !Object.hasOwn(d, 'value') || Array.isArray(v) && !/^\d+$/.test(k)) invalid();
      Object.defineProperty(out, k, {
        value: walk(d.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true
      });
    }
    if (Array.isArray(v) && Object.keys(out).length !== v.length) invalid();
    seen.delete(v);
    return out;
  }
  return walk(value, 0);
}
function keys(o, required, optional = []) {
  if (!o || Array.isArray(o) || typeof o !== 'object' || required.some(k => !Object.hasOwn(o, k)) || Object.keys(o).some(k => !required.includes(k) && !optional.includes(k))) invalid();
}
function validateModPackageRequest(input) {
  const r = plain(input);
  keys(r, ['version', 'profile', 'mod', 'sources', 'references', 'baseLibManifest'], ['expectedBaseLibVersion']);
  if (r.version !== 1 || r.profile !== PROFILE || !absolute(r.baseLibManifest) || r.expectedBaseLibVersion !== undefined && !version(r.expectedBaseLibVersion)) invalid();
  keys(r.mod, ['id', 'name', 'author', 'description', 'version', 'affectsGameplay'], ['minGameVersion']);
  if (typeof r.mod.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(r.mod.id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(r.mod.id) || !text(r.mod.name, 256) || !text(r.mod.author, 256) || !text(r.mod.description, 8192) || !version(r.mod.version) || typeof r.mod.affectsGameplay !== 'boolean' || r.mod.minGameVersion !== undefined && !version(r.mod.minGameVersion)) invalid();
  if (!Array.isArray(r.sources) || !r.sources.length || r.sources.length > 32) invalid();
  const names = new Set();
  let initializers = 0;
  for (const s of r.sources) {
    keys(s, ['name', 'path'], ['initializer']);
    if (!text(s.name, 128) || !/^[A-Za-z_][A-Za-z0-9_.-]*\.cs$/i.test(s.name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(s.name) || !absolute(s.path) || s.initializer !== undefined && typeof s.initializer !== 'boolean' || names.has(s.name.toLowerCase())) invalid();
    names.add(s.name.toLowerCase());
    if (s.initializer === true) initializers++;
  }
  if (initializers !== 1) invalid();
  keys(r.references, ROLES);
  if (ROLES.some(role => !absolute(r.references[role]))) invalid();
  return r;
}
function authority(config) {
  if (!config || !Array.isArray(config.runtimeRoots) || !config.runtimeRoots.length || config.runtimeRoots.length > 32 || config.runtimeRoots.some(r => !absolute(r)) || new Set(config.runtimeRoots.map(r => path.resolve(r).toLowerCase())).size !== config.runtimeRoots.length || !absolute(config.modPackaging?.sdkCacheRoot) || typeof config.modPackaging.dotnetSdkVersion !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(config.modPackaging.dotnetSdkVersion) || !absolute(config.tools?.dotnet?.executable)) invalid();
  return {
    runtimeRoots: config.runtimeRoots.map(r => path.resolve(r)),
    sdkCacheRoot: path.resolve(config.modPackaging.sdkCacheRoot),
    dotnetSdkVersion: config.modPackaging.dotnetSdkVersion,
    dotnet: {
      ...plain(config.tools.dotnet),
      executable: path.resolve(config.tools.dotnet.executable)
    }
  };
}
function packagingRequestIdentity(request, {
  config
} = {}) {
  return hashValue({
    request: validateModPackageRequest(request),
    authority: authority(config)
  });
}
const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];
async function rootSafe(root) {
  const s = await fs.lstat(root);
  if (!s.isDirectory() || s.isSymbolicLink() || (await fs.realpath(root)) !== path.resolve(root)) throw fail('UNSAFE_PATH', 'Linked or missing trusted root');
}
async function contained(file, roots) {
  for (const root of roots) {
    const rel = path.relative(root, file);
    if (rel && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)) {
      await rootSafe(root);
      return {
        root,
        relative: rel,
        file: await resolveContained(root, rel)
      };
    }
  }
  throw fail('UNSAFE_PATH', 'Build input is outside dedicated runtimeRoots');
}
async function capture(file, roots, limit, signal, includeBytes = true) {
  abort(signal);
  const c = await contained(file, roots),
    before = await fs.lstat(c.file, {
      bigint: true
    });
  if (!before.isFile() || before.isSymbolicLink()) throw fail('UNSAFE_PATH', 'Build input must be a regular unlinked file');
  if (before.size > BigInt(limit)) throw fail('QUOTA_EXCEEDED', 'Build input byte quota exceeded');
  const handle = await fs.open(c.file, 'r');
  try {
    const opened = await handle.stat({
      bigint: true
    });
    if (fields.some(k => before[k] !== opened[k])) throw fail('SOURCE_CHANGED', 'Build input changed before capture');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      abort(signal);
      const r = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!r.bytesRead) throw fail('SOURCE_CHANGED', 'Build input truncated');
      offset += r.bytesRead;
    }
    const after = await handle.stat({
        bigint: true
      }),
      current = await fs.lstat(await resolveContained(c.root, c.relative), {
        bigint: true
      });
    if ([after, current].some(s => fields.some(k => before[k] !== s[k]))) throw fail('SOURCE_CHANGED', 'Build input changed during capture');
    abort(signal);
    return {
      path: c.file,
      size: bytes.length,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
      identity: Object.fromEntries(fields.map(k => [k, before[k].toString()])),
      ...(includeBytes ? {
        base64: bytes.toString('base64')
      } : {})
    };
  } finally {
    await handle.close();
  }
}
function pe(record) {
  const b = Buffer.from(record.base64, 'base64');
  if (b.length < 64 || b.toString('ascii', 0, 2) !== 'MZ') invalid();
  const n = b.readUInt32LE(60);
  if (n > b.length - 4 || b.toString('ascii', n, n + 4) !== 'PE\0\0') invalid();
}
function freeze(v) {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
async function sdkCapture(root, signal) {
  try {
    await rootSafe(root);
    const files = [];
    let total = 0,
      visitedNodes = 0;
    async function visit(relative) {
      abort(signal);
      // Charge directories as well as files before any path traversal or enumeration.
      if (++visitedNodes > 2048 || relative.split('/').length > 16 || Buffer.byteLength(relative) > 1024) throw fail('QUOTA_EXCEEDED', 'SDK traversal exceeds node, depth or path budget');
      const target = await resolveContained(root, relative),
        s = await fs.lstat(target);
      if (s.isDirectory()) {
        const names = await fs.readdir(target);
        if (names.length > 256) throw fail('QUOTA_EXCEEDED', 'SDK inventory exceeds quota');
        for (const n of names.sort()) await visit(relative + '/' + n);
      } else {
        if (files.length >= 256) throw fail('QUOTA_EXCEEDED', 'SDK inventory exceeds quota');
        const r = await capture(target, [root], 64 * 1024 * 1024, signal, false);
        total += r.size;
        if (total > 64 * 1024 * 1024) throw fail('QUOTA_EXCEEDED', 'SDK bytes exceed quota');
        files.push({
          ...r,
          relativePath: relative
        });
      }
    }
    for (const n of ['godot.net.sdk', 'godotsharp', 'godot.sourcegenerators']) await visit(n + '/4.5.1');
    if (SDK_REQUIRED_FILES.some(p => !files.some(f => f.relativePath === p))) throw fail('CAPABILITY_MISSING', 'Required cached Godot SDK assets are missing');
    return {
      root,
      sdkVersion: '4.5.1',
      targetFramework: 'net9.0',
      files
    };
  } catch (e) {
    if (e.code === 'ENOENT') throw fail('CAPABILITY_MISSING', 'Configured local Godot SDK cache is unavailable');
    throw e;
  }
}
async function captureModPackageRequest(request, {
  config,
  signal
} = {}) {
  abort(signal);
  const r = validateModPackageRequest(request),
    a = authority(config),
    requestIdentity = packagingRequestIdentity(r, {
      config
    });
  for (const root of a.runtimeRoots) await rootSafe(root);
  const sources = [],
    references = [];
  let total = 0;
  for (const s of r.sources) {
    const c = await capture(s.path, a.runtimeRoots, 4 * 1024 * 1024 - total, signal);
    total += c.size;
    sources.push({
      ...c,
      name: s.name,
      initializer: s.initializer === true
    });
  }
  total = 0;
  for (const role of ROLES) {
    const c = await capture(r.references[role], a.runtimeRoots, Math.min(128 * 1024 * 1024, 256 * 1024 * 1024 - total), signal);
    pe(c);
    total += c.size;
    references.push({
      ...c,
      role,
      name: role + '.dll'
    });
  }
  const manifest = await capture(r.baseLibManifest, a.runtimeRoots, 1024 * 1024, signal);
  let metadata;
  try {
    metadata = plain(JSON.parse(new TextDecoder('utf-8', {
      fatal: true
    }).decode(Buffer.from(manifest.base64, 'base64'))));
  } catch {
    invalid();
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) invalid();
  if (metadata.id !== 'BaseLib' || !version(metadata.version) || metadata.has_dll !== true || metadata.has_pck !== true || !compatibleBaseLib(metadata.version) || r.expectedBaseLibVersion && normalize(r.expectedBaseLibVersion) !== normalize(metadata.version)) invalid();
  const sdk = await sdkCapture(a.sdkCacheRoot, signal);
  sdk.dotnetSdkVersion = a.dotnetSdkVersion;
  sdk.dotnetRoot = path.join(path.dirname(a.dotnet.executable), 'sdk', a.dotnetSdkVersion);
  sdk.dotnetFiles = [];
  let compilerTotal = 0;
  try {
    for (const relativePath of DOTNET_REQUIRED_FILES) {
      const record = await capture(path.join(sdk.dotnetRoot, relativePath), [sdk.dotnetRoot], 128 * 1024 * 1024 - compilerTotal, signal, false);
      compilerTotal += record.size;
      sdk.dotnetFiles.push({
        ...record,
        relativePath
      });
    }
  } catch (e) {
    if (e.code === 'ENOENT') throw fail('CAPABILITY_MISSING', 'Configured local .NET SDK compiler assets are unavailable');
    throw e;
  }
  let tool;
  try {
    tool = await capture(a.dotnet.executable, [path.dirname(a.dotnet.executable)], 128 * 1024 * 1024, signal, false);
  } catch (e) {
    if (e.code === 'ENOENT') throw fail('CAPABILITY_MISSING', 'Configured dotnet executable is unavailable');
    throw e;
  }
  return freeze({
    version: 1,
    request: r,
    requestIdentity,
    profile: r.profile,
    metadata: r.mod,
    mod: r.mod,
    sources,
    references,
    baseLibManifest: {
      ...manifest,
      metadata
    },
    baseLibVersion: normalize(metadata.version),
    sdk,
    tool
  });
}
function validateCapturedModPackageInputs(input, {
  config
} = {}) {
  const v = plain(input, 400 * 1024 * 1024);
  keys(v, ['version', 'request', 'requestIdentity', 'profile', 'metadata', 'mod', 'sources', 'references', 'baseLibManifest', 'baseLibVersion', 'sdk', 'tool']);
  const a = authority(config),
    r = validateModPackageRequest(v.request);
  // Owned receipt provenance cannot expand the configured runtime authority.
  for (const file of [...r.sources.map(s => s.path), ...Object.values(r.references), r.baseLibManifest]) {
    if (!a.runtimeRoots.some(root => {
      const relative = path.relative(root, file);
      return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    })) throw fail('UNSAFE_PATH', 'Captured input provenance is outside dedicated runtimeRoots');
  }
  if (v.version !== 1 || v.profile !== PROFILE || v.requestIdentity !== packagingRequestIdentity(r, {
    config
  }) || hashValue(v.metadata) !== hashValue(r.mod) || hashValue(v.mod) !== hashValue(r.mod)) invalid();
  function receipt(f, limit, bytes) {
    keys(f, ['path', 'size', 'hash', 'identity', ...(bytes ? ['base64'] : [])], ['name', 'role', 'initializer', 'relativePath', 'metadata']);
    if (!absolute(f.path) || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > limit || typeof f.hash !== 'string' || !/^[a-f0-9]{64}$/.test(f.hash)) invalid();
    keys(f.identity, fields);
    if (fields.some(k => typeof f.identity[k] !== 'string' || !/^-?\d{1,30}$/.test(f.identity[k])) || f.identity.size !== String(f.size)) invalid();
    if (bytes) {
      if (typeof f.base64 !== 'string' || f.base64.length !== Math.ceil(f.size / 3) * 4) invalid();
      const b = Buffer.from(f.base64, 'base64');
      if (b.length !== f.size || b.toString('base64') !== f.base64 || crypto.createHash('sha256').update(b).digest('hex') !== f.hash) invalid();
    }
  }
  if (!Array.isArray(v.sources) || v.sources.length !== r.sources.length || !Array.isArray(v.references) || v.references.length !== 4) invalid();
  let total = 0;
  for (let i = 0; i < v.sources.length; i++) {
    const f = v.sources[i],
      expected = r.sources[i];
    receipt(f, 4 * 1024 * 1024, true);
    total += f.size;
    if (total > 4 * 1024 * 1024 || f.path !== path.resolve(expected.path) || f.name !== expected.name || f.initializer !== (expected.initializer === true) || f.role !== undefined) invalid();
  }
  total = 0;
  for (let i = 0; i < 4; i++) {
    const f = v.references[i],
      role = ROLES[i];
    receipt(f, 128 * 1024 * 1024, true);
    total += f.size;
    if (total > 256 * 1024 * 1024 || f.role !== role || f.name !== role + '.dll' || f.path !== path.resolve(r.references[role])) invalid();
    pe(f);
  }
  receipt(v.baseLibManifest, 1024 * 1024, true);
  let m;
  try {
    m = JSON.parse(new TextDecoder('utf-8', {
      fatal: true
    }).decode(Buffer.from(v.baseLibManifest.base64, 'base64')));
  } catch {
    invalid();
  }
  if (!m || typeof m !== 'object' || Array.isArray(m) || !v.baseLibManifest.metadata || typeof v.baseLibManifest.metadata !== 'object' || Array.isArray(v.baseLibManifest.metadata)) invalid();
  if (v.baseLibManifest.path !== path.resolve(r.baseLibManifest) || hashValue(m) !== hashValue(v.baseLibManifest.metadata) || m.id !== 'BaseLib' || !version(m.version) || m.has_dll !== true || m.has_pck !== true || !compatibleBaseLib(m.version) || v.baseLibVersion !== normalize(m.version) || r.expectedBaseLibVersion && normalize(r.expectedBaseLibVersion) !== v.baseLibVersion) invalid();
  receipt(v.tool, 128 * 1024 * 1024, false);
  if (v.tool.path !== path.resolve(a.dotnet.executable)) invalid();
  keys(v.sdk, ['root', 'sdkVersion', 'targetFramework', 'files', 'dotnetSdkVersion', 'dotnetRoot', 'dotnetFiles']);
  if (v.sdk.root !== a.sdkCacheRoot || v.sdk.sdkVersion !== '4.5.1' || v.sdk.targetFramework !== 'net9.0' || v.sdk.dotnetSdkVersion !== a.dotnetSdkVersion || v.sdk.dotnetRoot !== path.join(path.dirname(a.dotnet.executable), 'sdk', a.dotnetSdkVersion) || !Array.isArray(v.sdk.files) || v.sdk.files.length > 256 || !Array.isArray(v.sdk.dotnetFiles) || v.sdk.dotnetFiles.length !== DOTNET_REQUIRED_FILES.length) invalid();
  for (const [list, root, required, max] of [[v.sdk.files, v.sdk.root, SDK_REQUIRED_FILES, 64 * 1024 * 1024], [v.sdk.dotnetFiles, v.sdk.dotnetRoot, DOTNET_REQUIRED_FILES, 128 * 1024 * 1024]]) {
    const seen = new Set();
    let size = 0;
    for (const f of list) {
      receipt(f, max, false);
      size += f.size;
      if (typeof f.relativePath !== 'string' || f.relativePath.split('/').some(p => !p || p === '.' || p === '..' || p.includes('\\') || p.includes(':')) || f.path !== path.join(root, f.relativePath) || seen.has(f.relativePath.toLowerCase()) || size > max) invalid();
      seen.add(f.relativePath.toLowerCase());
      if (list === v.sdk.files && !/^(godot.net.sdk|godotsharp|godot.sourcegenerators)\/4\.5\.1\//.test(f.relativePath) || list === v.sdk.dotnetFiles && !required.includes(f.relativePath)) invalid();
    }
    if (required.some(p => !seen.has(p.toLowerCase()))) invalid();
  }
  return freeze(v);
}
async function revalidateModPackageTools(inputs, {
  config,
  signal
} = {}) {
  abort(signal);
  inputs = validateCapturedModPackageInputs(inputs, {
    config
  });
  const a = authority(config);
  if (inputs.requestIdentity !== packagingRequestIdentity(inputs.request, {
    config
  }) || inputs.sdk?.root !== a.sdkCacheRoot || inputs.sdk?.dotnetSdkVersion !== a.dotnetSdkVersion || inputs.tool?.path !== a.dotnet.executable) throw fail('PACKAGE_REFRESH_REQUIRED', 'Packaging authority changed; explicit refresh required');
  const currentSdk = await sdkCapture(a.sdkCacheRoot, signal);
  if (hashValue(currentSdk.files.map(f => ({
    relativePath: f.relativePath,
    hash: f.hash,
    size: f.size
  }))) !== hashValue(inputs.sdk.files.map(f => ({
    relativePath: f.relativePath,
    hash: f.hash,
    size: f.size
  })))) throw fail('PACKAGE_REFRESH_REQUIRED', 'Cached SDK inventory changed; explicit refresh required');
  const expected = [inputs.tool, ...inputs.sdk.files, ...inputs.sdk.dotnetFiles];
  for (const record of expected) {
    let actual;
    try {
      actual = await capture(record.path, [record === inputs.tool ? path.dirname(a.dotnet.executable) : inputs.sdk.files.includes(record) ? a.sdkCacheRoot : inputs.sdk.dotnetRoot], 128 * 1024 * 1024, signal, false);
    } catch (e) {
      if (e.code === 'ENOENT') throw fail('CAPABILITY_MISSING', 'Captured build tool or SDK asset is unavailable');
      throw e;
    }
    if (actual.size !== record.size || actual.hash !== record.hash || fields.some(k => actual.identity[k] !== record.identity[k])) throw fail('PACKAGE_REFRESH_REQUIRED', 'Build tool or SDK asset changed; explicit refresh required');
  }
  return true;
}
module.exports = {
  validateModPackageRequest,
  packagingRequestIdentity,
  captureModPackageRequest,
  validateCapturedModPackageInputs,
  revalidateModPackageTools,
  SDK_REQUIRED_FILES,
  DOTNET_REQUIRED_FILES
};
