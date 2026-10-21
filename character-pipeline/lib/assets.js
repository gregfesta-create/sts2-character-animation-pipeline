'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  createReadStream
} = require('node:fs');
function fail(code, message) {
  return Object.assign(new Error(message), {
    code
  });
}
function canonicalJson(value) {
  const seen = new Set();
  function visit(v) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v !== 'object' || seen.has(v)) throw fail('INVALID_INPUT', 'Expected finite JSON data');
    seen.add(v);
    let out;
    if (Array.isArray(v)) out = v.map(visit);else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw fail('INVALID_INPUT', 'Expected plain JSON object');
      out = {};
      for (const k of Object.keys(v).sort()) Object.defineProperty(out, k, {
        value: visit(v[k]),
        enumerable: true
      });
    }
    seen.delete(v);
    return out;
  }
  return JSON.stringify(visit(value));
}
function hashValue(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function resolveContained(root, relative, {
  mustExist = true
} = {}) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\0') || relative.split(/[\\/]/).some(p => p === '..' || p === '.' || !p) || relative.includes(':')) throw fail('UNSAFE_PATH', 'Invalid relative path');
  const base = await fs.realpath(root);
  let current = base;
  const parts = relative.split(/[\\/]/);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const s = await fs.lstat(current);
      if (s.isSymbolicLink()) throw fail('UNSAFE_PATH', 'Symlinks and junctions are forbidden');
      const actual = await fs.realpath(current);
      if (actual !== base && !actual.startsWith(base + path.sep)) throw fail('UNSAFE_PATH', 'Path escapes root');
    } catch (e) {
      if (e.code !== 'ENOENT' || mustExist) throw e;
    }
  }
  return current;
}
async function atomicWrite(file, data) {
  const tmp = file + '.tmp-' + crypto.randomUUID();
  try {
    const handle = await fs.open(tmp, 'wx');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, {
      force: true
    });
  }
}
async function publishSource(inputRoot, relative, jobRoot, {
  maxBytes = 64 * 1024 * 1024
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw fail('INVALID_INPUT', 'Invalid source quota');
  const source = await resolveContained(inputRoot, relative);
  const stat = await fs.stat(source);
  if (!stat.isFile()) throw fail('INVALID_INPUT', 'Source is not a file');
  if (stat.size > maxBytes) throw fail('QUOTA_EXCEEDED', 'Source exceeds quota');
  const chunks = [];
  let size = 0;
  for await (const chunk of createReadStream(source)) {
    size += chunk.length;
    if (size > maxBytes) throw fail('QUOTA_EXCEEDED', 'Source exceeds quota');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.mkdir(jobRoot, {
    recursive: true
  });
  const base = await fs.realpath(jobRoot);
  const store = await resolveContained(base, 'sources', {
    mustExist: false
  });
  await fs.mkdir(store, {
    recursive: true
  });
  const target = await resolveContained(base, 'sources/' + hash, {
    mustExist: false
  });
  try {
    await fs.writeFile(target, bytes, {
      flag: 'wx'
    });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if ((await hashFile(target)) !== hash) throw fail('CORRUPT_ARTIFACT', 'Immutable source was corrupted');
  }
  return {
    path: target,
    hash,
    size: bytes.length
  };
}
async function ownedStorage(root) {
  let total = 0;
  let entries = 0;
  async function visit(relative) {
    let directory;
    try {
      directory = await resolveContained(root, relative);
    } catch (cause) {
      if (cause.code === 'ENOENT') return;
      throw cause;
    }
    for (const entry of await fs.readdir(directory, {
      withFileTypes: true
    })) {
      if (++entries > 10000) throw fail('QUOTA_EXCEEDED', 'Too many owned storage entries.');
      const rel = relative + '/' + entry.name;
      const file = await resolveContained(root, rel);
      if (entry.isDirectory()) await visit(rel);else if (entry.isFile()) total += (await fs.stat(file)).size;else throw fail('UNSAFE_PATH', 'Owned storage must contain regular files.');
    }
  }
  for (const name of ['sources', 'outputs', 'review', 'provider']) await visit(name);
  return total;
}
module.exports = {
  ownedStorage,
  canonicalJson,
  hashValue,
  hashFile,
  resolveContained,
  atomicWrite,
  publishSource
};
