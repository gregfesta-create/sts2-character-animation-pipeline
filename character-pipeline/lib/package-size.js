'use strict';
// Categories are physical file categories. Scene/animation/effect aliases share
// scenes; metadata and notices remain separate. Unknown classifications fail.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalJson, resolveContained } = require('./assets');
const CATEGORIES = Object.freeze(['assemblies', 'scripts', 'textures', 'audio', 'scenes', 'metadata', 'notices']);
const aliases = Object.freeze({ animations: 'scenes', effects: 'scenes', animation: 'scenes', scene: 'scenes', texture: 'textures', script: 'scripts', assembly: 'assemblies', notice: 'notices' });
const fail = (code, message) => Object.assign(new Error(message), { code });
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function freeze(value) { if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); } return value; }
function category(value) { const result = aliases[value] || value; if (!CATEGORIES.includes(result)) throw fail('UNKNOWN_CATEGORY', `Unknown runtime category: ${value}`); return result; }
function validateBaseline(value, maxFiles) {
  if (value === undefined) return null;
  const invalid = () => fail('INVALID_BASELINE', 'Expected complete bounded version 1 measured size report');
  let baseline;
  try { baseline = JSON.parse(canonicalJson(value)); } catch { throw invalid(); }
  const bytes = n => Number.isSafeInteger(n) && n >= 0;
  if (!baseline || baseline.version !== 1 || !bytes(baseline.installedBytes) || !(baseline.archiveBytes === null || bytes(baseline.archiveBytes)) || !baseline.categories || Array.isArray(baseline.categories) || !Array.isArray(baseline.largestFiles) || baseline.largestFiles.length > maxFiles) throw invalid();
  if (Object.keys(baseline.categories).length !== CATEGORIES.length || Object.keys(baseline.categories).some(k => !CATEGORIES.includes(k))) throw invalid();
  const totals = Object.fromEntries(CATEGORIES.map(k => [k, { count: 0, bytes: 0 }]));
  const seen = new Set(); let total = 0;
  for (const file of baseline.largestFiles) {
    if (!file || typeof file.path !== 'string' || !file.path || file.path.length > 512 || /[\x00-\x1f:*?"<>|\\]/.test(file.path) || file.path.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p)) || !CATEGORIES.includes(file.category) || !bytes(file.bytes) || typeof file.hash !== 'string' || !/^[a-f0-9]{64}$/.test(file.hash)) throw invalid();
    const key = file.path.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw invalid(); seen.add(key);
    total += file.bytes; totals[file.category].count++; totals[file.category].bytes += file.bytes;
    if (!Number.isSafeInteger(total)) throw invalid();
  }
  if (total !== baseline.installedBytes) throw invalid();
  for (const key of CATEGORIES) {
    const item = baseline.categories[key];
    if (!item || !bytes(item.count) || !bytes(item.bytes) || item.count !== totals[key].count || item.bytes !== totals[key].bytes) throw invalid();
  }
  return baseline;
}
function compareBaseline(previous, installedBytes, archiveBytes, categories, files) {
  if (!previous) return { status: 'unavailable', growthBytes: null };
  const old = new Map(previous.largestFiles.map(f => [f.path, f])), current = new Map(files.map(f => [f.path, f]));
  const changes = [];
  for (const name of [...new Set([...old.keys(), ...current.keys()])].sort(cmp)) {
    const before = old.get(name), after = current.get(name);
    if (before && after && before.hash === after.hash && before.bytes === after.bytes && before.category === after.category && canonicalJson(before.importSettings || {}) === canonicalJson(after.importSettings || {})) continue;
    changes.push({ path: name, kind: !before ? 'added' : !after ? 'removed' : 'replaced', deltaBytes: (after?.bytes || 0) - (before?.bytes || 0), previousBytes: before?.bytes ?? null, currentBytes: after?.bytes ?? null, previousHash: before?.hash ?? null, currentHash: after?.hash ?? null });
  }
  return { status: 'available', growthBytes: installedBytes - previous.installedBytes, archiveDeltaBytes: archiveBytes === null || previous.archiveBytes === null ? null : archiveBytes - previous.archiveBytes, categoryDeltas: Object.fromEntries(CATEGORIES.map(k => [k, { count: categories[k].count - previous.categories[k].count, bytes: categories[k].bytes - previous.categories[k].bytes }])), changes };
}
async function rootWithoutLinks(root) {
  const absolute = path.resolve(root); let current = path.parse(absolute).root;
  for (const part of path.relative(current, absolute).split(path.sep).filter(Boolean)) { current = path.join(current, part); if ((await fs.lstat(current)).isSymbolicLink()) throw fail('UNSAFE_PATH', 'Linked root is forbidden'); }
  if (!(await fs.stat(absolute)).isDirectory()) throw fail('UNSAFE_PATH', 'Expected owned directory');
  return fs.realpath(absolute);
}
async function capture(root, relative, limit) {
  const original = await resolveContained(root, relative);
  const handle = await fs.open(original, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW || 0));
  try {
    const initial = await handle.stat();
    if (!initial.isFile()) throw fail('UNSAFE_PATH', 'Expected regular file');
    async function verify() {
      if (await rootWithoutLinks(root) !== root || await resolveContained(root, relative) !== original) throw fail('UNSAFE_PATH', 'Containment changed');
      for (const stat of [await fs.lstat(original), await handle.stat()]) {
        if (stat.isSymbolicLink()) throw fail('UNSAFE_PATH', 'Linked file is forbidden');
        if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(k => stat[k] !== initial[k])) throw fail('SOURCE_CHANGED', 'File changed during measurement');
      }
    }
    await verify();
    if (initial.size > limit) throw fail('QUOTA_EXCEEDED', 'Measurement exceeds bounded byte quota');
    const hash = crypto.createHash('sha256'); let bytes = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(65536, limit - bytes + 1));
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
      if (bytes > limit) throw fail('QUOTA_EXCEEDED', 'Measurement exceeds bounded byte quota');
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    await verify();
    if (bytes !== initial.size) throw fail('SOURCE_CHANGED', 'File size changed');
    return { bytes, hash: hash.digest('hex'), identity: initial };
  } finally { await handle.close(); }
}
async function inventory(root, maxFiles) {
  const files = []; let visited = 0;
  async function walk(dir, prefix) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (++visited > maxFiles * 4) throw fail('QUOTA_EXCEEDED', 'Directory inventory exceeds quota');
      const relative = prefix + entry.name, absolute = await resolveContained(root, relative);
      const stat = await fs.lstat(absolute);
      if (stat.isDirectory()) await walk(absolute, relative + '/');
      else if (stat.isFile()) files.push(relative);
      else throw fail('UNSAFE_PATH', 'Unexpected staged entry');
    }
  }
  await walk(root, ''); return files.sort(cmp);
}
/** Read-only staging report; archivePath is relative to ownedRoot. An arbitrary
 * archive's compression/container overhead cannot be inferred from its length.
 * No dedup savings or memory estimates are inferred from sharing metadata.
 */
async function reportPackageSize({ staged, ownedRoot, archivePath, budgets = {}, baseline, maxBytes = 512 * 1024 * 1024, maxFiles = 10000 }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxFiles) || maxFiles < 1) throw fail('INVALID_INPUT', 'Invalid measurement quota');
  // Snapshot caller data before awaits, so mutation cannot alter the report.
  const snapshot = JSON.parse(canonicalJson(staged));
  const previous = validateBaseline(baseline, maxFiles);
  if (!snapshot || !Array.isArray(snapshot.files) || !Array.isArray(snapshot.allowlist) || snapshot.files.length > maxFiles) throw fail('INVALID_INPUT', 'Expected bounded staged manifest');
  const limits = JSON.parse(canonicalJson(budgets));
  if (!limits || Array.isArray(limits) || typeof limits !== 'object' || Object.keys(limits).some(k => !['installedBytes', 'archiveBytes', 'categories'].includes(k))) throw fail('INVALID_BUDGET', 'Unknown budget field');
  const validLimit = n => Number.isSafeInteger(n) && n > 0;
  for (const key of ['installedBytes', 'archiveBytes']) if (key in limits && !validLimit(limits[key])) throw fail('INVALID_BUDGET', `Invalid ${key}`);
  if ('categories' in limits && (!limits.categories || Array.isArray(limits.categories) || typeof limits.categories !== 'object')) throw fail('INVALID_BUDGET', 'Invalid category budgets');
  for (const [key, value] of Object.entries(limits.categories || {})) if (!CATEGORIES.includes(key) || !validLimit(value)) throw fail('INVALID_BUDGET', `Invalid category budget: ${key}`);
  const owned = await rootWithoutLinks(ownedRoot);
  const relative = path.relative(owned, path.resolve(snapshot.directory));
  if (!relative) throw fail('UNSAFE_PATH', 'Staging must be a child of owned root');
  const directory = await resolveContained(owned, relative);
  await rootWithoutLinks(directory);
  const declared = snapshot.files.map(f => f.path).sort(cmp);
  if (new Set(declared.map(p => p.normalize('NFC').toLowerCase())).size !== declared.length || canonicalJson(declared) !== canonicalJson([...snapshot.allowlist].sort(cmp))) throw fail('ALLOWLIST_MISMATCH', 'Declared files differ from allowlist');
  const categories = Object.fromEntries(CATEGORIES.map(k => [k, { count: 0, bytes: 0 }]));
  const largestFiles = [], identities = []; let installedBytes = 0;
  if (canonicalJson(await inventory(directory, maxFiles)) !== canonicalJson(declared)) throw fail('ALLOWLIST_MISMATCH', 'Staged files differ from allowlist');
  for (const file of [...snapshot.files].sort((a, b) => cmp(a.path, b.path))) {
    const key = category(file.category);
    const measured = await capture(directory, file.path, maxBytes - installedBytes);
    identities.push({ path: file.path, stat: measured.identity });
    if (measured.bytes !== file.bytes || measured.hash !== file.hash) throw fail('CONTENT_MISMATCH', `Staged hash/bytes mismatch: ${file.path}`);
    installedBytes += measured.bytes; categories[key].count++; categories[key].bytes += measured.bytes;
    largestFiles.push({ path: file.path, category: key, bytes: measured.bytes, hash: measured.hash, logicalOwners: [file.id], importSettings: file.importSettings || {} });
  }
  if (await rootWithoutLinks(owned) !== owned || await resolveContained(owned, relative) !== directory || canonicalJson(await inventory(directory, maxFiles)) !== canonicalJson(declared)) throw fail('SOURCE_CHANGED', 'Staging changed during measurement');
  let archiveBytes = null;
  if (archivePath !== undefined) { try { archiveBytes = (await capture(owned, archivePath, maxBytes)).bytes; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  for (const entry of identities) {
    const stat = await fs.lstat(await resolveContained(directory, entry.path));
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(k => stat[k] !== entry.stat[k])) throw fail('SOURCE_CHANGED', 'Staged identity changed during report');
  }
  if (await rootWithoutLinks(owned) !== owned || await rootWithoutLinks(directory) !== directory || await resolveContained(owned, relative) !== directory || canonicalJson(await inventory(directory, maxFiles)) !== canonicalJson(declared)) throw fail('SOURCE_CHANGED', 'Owned staging changed during report');
  largestFiles.sort((a, b) => b.bytes - a.bytes || cmp(a.path, b.path));
  const violations = [];
  function check(name, actual, limit) { if (limit !== undefined && actual !== null && actual > limit) violations.push({ name, measuredBytes: actual, maximumBytes: limit }); }
  check('installedBytes', installedBytes, limits.installedBytes); check('archiveBytes', archiveBytes, limits.archiveBytes);
  for (const [key, limit] of Object.entries(limits.categories || {})) check(key, categories[key].bytes, limit);
  const configured = 'installedBytes' in limits || 'archiveBytes' in limits || Object.keys(limits.categories || {}).length > 0;
  const report = freeze({ version: 1, nativeExportStatus: 'pending', installedBytes, archiveBytes, archiveStatus: archiveBytes === null ? 'unavailable' : 'measured', categories, largestFiles, duplicateBytesAvoided: 0, excludedDevelopmentBytes: null, containerOverheadBytes: null, baseline: compareBaseline(previous, installedBytes, archiveBytes, categories, largestFiles), decodedMemory: { textures: { status: 'unavailable', bytes: null }, audio: { status: 'unavailable', bytes: null } }, budget: { status: violations.length ? 'failed' : !configured ? 'unset' : limits.archiveBytes !== undefined && archiveBytes === null ? 'unavailable' : 'passed', limits, violations } });
  if (violations.length) throw Object.assign(fail('BUDGET_EXCEEDED', 'Package exceeds configured budget; inspect report.largestFiles'), { report });
  return report;
}
module.exports = { CATEGORIES, reportPackageSize };
