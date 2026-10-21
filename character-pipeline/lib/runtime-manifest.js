'use strict';

// This is a staging foundation. A native export adapter must still rewrite and
// validate engine references before these files can be called a game package.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalJson, resolveContained } = require('./assets');
const fail = (code, message) => Object.assign(new Error(message), { code });
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const forbiddenDirectories = /^(models?|editor|tools?|evidence|tests?|cache|logs?|source[-_ ]?art|artwork|previews?|node_modules|\.git|\.tmp|__pycache__)$/i;
function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\x00-\x1f:*?"<>|]/.test(value) || /^[\\/]/.test(value)) throw fail('UNSAFE_PATH', `Invalid runtime path: ${value}`);
  const parts = value.split(/[\\/]/);
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))) throw fail('UNSAFE_PATH', `Invalid runtime path: ${value}`);
  return parts.join('/');
}
function policy(file, category) {
  if (/\.(exe|com|bat|cmd|ps1|sh|msi|scr|py|pyc)$/i.test(file)) throw fail('UNEXPECTED_EXECUTABLE', `Executable/tool requested: ${file}`);
  if (file.split('/').some(p => forbiddenDirectories.test(p)) || /\.(cs|csproj|sln|psd|kra|xcf|blend|safetensors|ckpt|pt|pth|onnx|log|tmp)$/i.test(file)) throw fail('PROHIBITED_DEPENDENCY', `Development dependency requested: ${file}`);
  if (/\.(dll|so|dylib)$/i.test(file) && category !== 'assemblies') throw fail('UNEXPECTED_EXECUTABLE', `Assembly requires explicit assemblies category: ${file}`);
}
function ids(value, label) {
  if (!Array.isArray(value) || value.length > 10000 || value.some(v => typeof v !== 'string' || !v || v.length > 256) || new Set(value).size !== value.length) throw fail('INVALID_MANIFEST', `Invalid ${label}`);
  return [...value].sort(compare);
}
function buildRuntimeManifest(input) {
  if (!input || !Array.isArray(input.resources) || input.resources.length > 10000) throw fail('INVALID_MANIFEST', 'Expected bounded resources');
  const roots = ids(input.roots, 'roots');
  if (!roots.length) throw fail('INVALID_MANIFEST', 'At least one root is required');
  const externalDependencies = ids(input.externalDependencies || [], 'external dependencies');
  const external = new Set(externalDependencies);
  const resources = new Map(); const paths = new Map(); let edgeCount = 0;
  for (const item of input.resources) {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 256 || typeof item.category !== 'string' || !item.category) throw fail('INVALID_MANIFEST', 'Invalid resource');
    if (resources.has(item.id) || external.has(item.id)) throw fail('DUPLICATE_LOGICAL_ID', `Duplicate logical ID: ${item.id}`);
    const file = safePath(item.path); const key = file.normalize('NFC').toLowerCase();
    if (paths.has(key)) throw fail(paths.get(key) === file ? 'LOGICAL_OWNER_CONFLICT' : 'PATH_COLLISION', `Multiple logical owners/colliding paths: ${file}`);
    paths.set(key, file);
    const dependencies = ids(item.dependencies || [], 'dependencies');
    let dynamicReferences;
    try { dynamicReferences = ids(item.dynamicReferences || [], 'dynamic references'); }
    catch { throw fail('UNDECLARED_DYNAMIC_REFERENCE', `Declare every dynamic reference for ${item.id}`); }
    edgeCount += dependencies.length + dynamicReferences.length;
    if (edgeCount > 50000) throw fail('INVALID_MANIFEST', 'Dependency count exceeds bound');
    const importSettings = JSON.parse(canonicalJson(item.importSettings || {}));
    resources.set(item.id, { id: item.id, path: file, category: item.category, dependencies, dynamicReferences, importSettings });
  }
  for (const key of paths.keys()) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) throw fail('PATH_COLLISION', `File/directory path collision: ${key}`);
  }
  const visiting = new Set(); const reached = new Set();
  function visit(id, from, dynamic = false) {
    if (external.has(id)) return;
    const item = resources.get(id);
    if (!item) throw fail(dynamic ? 'UNDECLARED_DYNAMIC_REFERENCE' : 'MISSING_RESOURCE', `Missing resource ${id} referenced by ${from}`);
    if (visiting.has(id)) throw fail('DEPENDENCY_CYCLE', `Dependency cycle at ${id}`);
    if (reached.has(id)) return;
    if (visiting.size >= 256) throw fail('INVALID_MANIFEST', 'Dependency depth exceeds bound');
    policy(item.path, item.category); visiting.add(id);
    for (const dep of item.dependencies) visit(dep, id);
    for (const dep of item.dynamicReferences) visit(dep, id, true);
    visiting.delete(id); reached.add(id);
  }
  for (const id of roots) {
    if (external.has(id)) throw fail('INVALID_MANIFEST', 'Runtime roots must be local resources');
    visit(id, 'roots');
  }
  const selected = [...reached].sort(compare).map(id => resources.get(id));
  return { version: 1, nativeExportStatus: 'pending', roots, externalDependencies, resources: selected, allowlist: selected.map(r => r.path).sort(compare) };
}
function within(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
async function directoryWithoutLinks(directory) {
  const absolute = path.resolve(directory); const root = path.parse(absolute).root;
  let current = root;
  for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw fail('UNSAFE_PATH', 'Symlinks and junctions are forbidden');
  }
  const stat = await fs.stat(absolute);
  if (!stat.isDirectory()) throw fail('UNSAFE_PATH', 'Expected directory');
  return fs.realpath(absolute);
}
async function stageRuntimeManifest({ sourceRoot, captures, stagingParent, manifest, maxFiles = 10000, maxBytes = 512 * 1024 * 1024 }) {
  // Windows holds directories against renaming while a descendant file is open.
  // Node exposes no portable handle-relative write API with equivalent guarantees.
  if (process.platform !== 'win32') throw fail('UNSUPPORTED_PLATFORM', 'Runtime staging requires Windows file-handle directory anchoring');
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw fail('INVALID_INPUT', 'Invalid staging quota');
  // Rebuild rather than trusting a caller-mutated allowlist or previous result.
  const graph = buildRuntimeManifest(manifest);
  if (graph.resources.length > maxFiles) throw fail('QUOTA_EXCEEDED', 'Runtime file count exceeds quota');
  if ((sourceRoot !== undefined) === (captures !== undefined)) throw fail('INVALID_INPUT', 'Provide exactly one sourceRoot or captures');
  let captured;
  if (captures !== undefined) {
    if (!Array.isArray(captures) || captures.length !== graph.allowlist.length || captures.length > maxFiles) throw fail('INVALID_INPUT', 'Captures must exactly match the runtime allowlist');
    captured = new Map(); let total = 0;
    for (const item of captures) {
      if (!item || !Number.isSafeInteger(item.size) || item.size < 0 || typeof item.base64 !== 'string' || typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash)) throw fail('INVALID_INPUT', 'Invalid immutable capture');
      const file = safePath(item.path);
      if (!graph.allowlist.includes(file) || captured.has(file)) throw fail('INVALID_INPUT', 'Capture path is duplicated or absent from runtime allowlist');
      if (item.size > maxBytes - total || item.base64.length !== Math.ceil(item.size / 3) * 4) throw fail('QUOTA_EXCEEDED', 'Capture bytes exceed declared size or quota');
      const bytes = Buffer.from(item.base64, 'base64');
      if (bytes.length !== item.size || bytes.toString('base64') !== item.base64 || digest(bytes) !== item.hash) throw fail('INVALID_INPUT', 'Capture bytes or hash differ from receipt');
      captured.set(file, bytes); total += bytes.length;
    }
  }
  const source = captured ? null : await directoryWithoutLinks(sourceRoot);
  const parent = await directoryWithoutLinks(stagingParent);
  if (source && (within(source, parent) || within(parent, source))) throw fail('UNSAFE_STAGING', 'Source and staging trees must be disjoint');
  const parentStat = await fs.lstat(parent);
  const directory = await fs.mkdtemp(path.join(parent, 'runtime-'));
  const directories = new Map(), outputs = [];
  const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
  async function guard() {
    if (await directoryWithoutLinks(parent) !== parent || !identity(await fs.lstat(parent), parentStat)) throw fail('UNSAFE_STAGING', 'Staging parent identity changed');
    for (const [name, stat] of directories) {
      if (await directoryWithoutLinks(name) !== name || !identity(await fs.lstat(name), stat)) throw fail('UNSAFE_STAGING', 'Owned staging directory identity changed');
    }
  }
  async function openOwnedFile(file) {
    const handle = await fs.open(file, 'wx+');
    try {
      return { path: file, handle, stat: await handle.stat() };
    } catch (error) {
      // A file may exist, but without its identity it is unsafe to unlink it.
      // Closing is mandatory even when fstat fails before ownership is recorded.
      try { await handle.close(); } catch {}
      throw error;
    }
  }
  async function verifyFile(entry) {
    await guard();
    const rel = path.relative(directory, entry.path);
    if (await resolveContained(directory, rel) !== entry.path) throw fail('UNSAFE_STAGING', 'Output containment changed');
    const current = await fs.lstat(entry.path), opened = await entry.handle.stat();
    if (!current.isFile() || current.isSymbolicLink() || !identity(current, entry.stat) || !identity(opened, entry.stat)) throw fail('UNSAFE_STAGING', 'Output identity changed');
    if (entry.writtenStat && [current, opened].some(stat => stat.size !== entry.writtenStat.size || stat.mtimeMs !== entry.writtenStat.mtimeMs || stat.ctimeMs !== entry.writtenStat.ctimeMs)) throw fail('OUTPUT_CHANGED', 'Staged output changed after writing');
  }
  async function inventory() {
    await guard();
    const expected = new Set(graph.allowlist), seen = new Set();
    const expectedDirectories = new Set([...directories.keys()].map(name => path.relative(directory, name).split(path.sep).join('/')));
    let entries = 0;
    async function visit(folder) {
      for await (const entry of await fs.opendir(folder)) {
        if (++entries > graph.allowlist.length + expectedDirectories.size) throw fail('UNEXPECTED_STAGED_FILE', 'Staging inventory exceeds declared files/directories');
        const file = path.join(folder, entry.name), relative = path.relative(directory, file).split(path.sep).join('/');
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) throw fail('UNEXPECTED_STAGED_FILE', 'Staged links are forbidden');
        if (stat.isDirectory() && expectedDirectories.has(relative)) await visit(file);
        else if (stat.isFile() && expected.has(relative)) seen.add(relative);
        else throw fail('UNEXPECTED_STAGED_FILE', `Unlisted staged entry: ${relative}`);
      }
    }
    await visit(directory);
    if (seen.size !== expected.size) throw fail('UNEXPECTED_STAGED_FILE', 'Staging inventory is missing declared files');
    await guard();
  }
  async function readback(entry) {
    await verifyFile(entry);
    const hash = crypto.createHash('sha256'); let position = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, entry.expectedBytes - position + 1));
      const { bytesRead } = await entry.handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      if (position > entry.expectedBytes) throw fail('OUTPUT_CHANGED', 'Staged output exceeds expected bytes');
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (position !== entry.expectedBytes || hash.digest('hex') !== entry.expectedHash) throw fail('OUTPUT_CHANGED', 'Staged output bytes differ from captured source');
    await verifyFile(entry);
  }
  async function release() {
    // Pure Node provides no atomic unlink-by-file-identity on Windows. Retain
    // failed unpublished staging rather than deleting a replaceable path.
    for (const entry of outputs) {
      try { await entry.handle.close(); } catch {}
    }
  }
  try {
    // If this first identity read fails, retain the empty directory rather than
    // deleting an unverified path that might have been replaced concurrently.
    directories.set(directory, await fs.lstat(directory));
    await guard();
    let totalBytes = 0; const files = [];
    for (const item of [...graph.resources].sort((a, b) => compare(a.path, b.path))) {
      const target = await resolveContained(directory, item.path, { mustExist: false });
      let parentDirectory = directory;
      for (const part of item.path.split('/').slice(0, -1)) {
        parentDirectory = path.join(parentDirectory, part);
        if (!directories.has(parentDirectory)) {
          await guard();
          await fs.mkdir(parentDirectory);
          directories.set(parentDirectory, await fs.lstat(parentDirectory));
          await guard();
        }
      }
      await guard();
      // The final exclusive output handle itself anchors its directory and
      // ancestors before reading or publishing bytes; no extra lock files ship.
      const entry = await openOwnedFile(target);
      outputs.push(entry);
      await verifyFile(entry);
      let bytes;
      if (captured) bytes = captured.get(item.path);
      else {
      let original;
      try { original = await resolveContained(source, item.path); }
      catch (error) { if (error.code === 'ENOENT') throw fail('MISSING_SOURCE', `Missing runtime source: ${item.path}`); throw error; }
      const handle = await fs.open(original, constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW || 0)));
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw fail('INVALID_INPUT', `Runtime source is not a regular file: ${item.path}`);
        async function verify() {
          if (await directoryWithoutLinks(source) !== source) throw fail('UNSAFE_PATH', 'Source root changed during capture');
          if (await resolveContained(source, item.path) !== original) throw fail('UNSAFE_PATH', 'Source containment changed during capture');
          const current = await fs.lstat(original), opened = await handle.stat();
          if (current.isSymbolicLink()) throw fail('UNSAFE_PATH', 'Source became a link during capture');
          if (current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs || opened.ctimeMs !== stat.ctimeMs) throw fail('SOURCE_CHANGED', 'Source identity changed during capture');
        }
        await verify();
        if (stat.size > maxBytes - totalBytes) throw fail('QUOTA_EXCEEDED', `Runtime bytes exceed quota at ${item.path}`);
        // Read at most the remaining quota plus one; changes cannot force an unbounded allocation.
        const chunks = []; let count = 0;
        while (true) {
          const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - totalBytes - count + 1));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          count += bytesRead;
          if (count > maxBytes - totalBytes) throw fail('QUOTA_EXCEEDED', `Runtime bytes exceed quota at ${item.path}`);
          chunks.push(buffer.subarray(0, bytesRead));
        }
        await verify();
        if (count !== stat.size) throw fail('SOURCE_CHANGED', 'Source size changed during capture');
        bytes = Buffer.concat(chunks);
      } finally { await handle.close(); }
      }
      const executable = bytes.subarray(0, 2).equals(Buffer.from('MZ')) || bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || bytes.subarray(0, 2).equals(Buffer.from('#!'));
      if (executable && !(item.category === 'assemblies' && /\.(dll|so|dylib)$/i.test(item.path))) throw fail('UNEXPECTED_EXECUTABLE', `Executable content in ${item.path}`);
      totalBytes += bytes.length;
      await verifyFile(entry);
      await entry.handle.writeFile(bytes);
      entry.writtenStat = await entry.handle.stat();
      entry.expectedBytes = bytes.length;
      entry.expectedHash = digest(bytes);
      if (entry.writtenStat.size !== entry.expectedBytes) throw fail('OUTPUT_CHANGED', 'Staged output size differs from captured source');
      await verifyFile(entry);
      const hash = digest(bytes);
      files.push({ ...item, bytes: bytes.length, hash, shareIdentity: digest(canonicalJson({ hash, category: item.category, extension: path.extname(item.path).toLowerCase(), importSettings: item.importSettings })) });
    }
    await guard();
    await inventory();
    for (const entry of outputs) await readback(entry);
    await inventory();
    for (const entry of outputs) await verifyFile(entry);
    await release();
    return { ...graph, directory, files, totalBytes };
  } catch (error) {
    await release();
    error.stagingDirectory = directory;
    error.cleanupStatus = 'retained-unpublished';
    error.stagingLimits = { maxFiles, maxBytes };
    throw error;
  }
}
module.exports = { buildRuntimeManifest, stageRuntimeManifest };
