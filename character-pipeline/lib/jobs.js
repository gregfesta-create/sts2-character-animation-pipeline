'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  canonicalJson,
  hashValue,
  hashFile,
  resolveContained,
  atomicWrite,
  ownedStorage
} = require('./assets');
const error = (code, message) => Object.assign(new Error(message), {
  code
});
const idPattern = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
async function inventory(root, relative = '', budget = {
  remaining: 512 * 1024 * 1024,
  count: 0
}) {
  if ((await fs.lstat(root)).isSymbolicLink()) throw error('UNSAFE_PATH', 'Output root cannot be a link');
  let result = [];
  for (const entry of await fs.readdir(path.join(root, relative), {
    withFileTypes: true
  })) {
    const rel = relative ? relative + '/' + entry.name : entry.name;
    const file = await resolveContained(root, rel);
    if (++budget.count > 10000) throw error('QUOTA_EXCEEDED', 'Too many stage entries');
    if (entry.isDirectory()) result.push(...(await inventory(root, rel, budget)));else if (entry.isFile()) {
      const size = (await fs.stat(file)).size;
      budget.remaining -= size;
      if (budget.remaining < 0) throw error('QUOTA_EXCEEDED', 'Output byte quota exceeded');
      result.push({
        path: rel,
        size,
        hash: await hashFile(file)
      });
    } else throw error('UNSAFE_PATH', 'Only regular stage outputs are allowed');
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
async function readManifest(root) {
  const file = await resolveContained(root, 'manifest.json');
  if ((await fs.stat(file)).size > 16 * 1024 * 1024) throw error('INVALID_MANIFEST', 'Manifest too large');
  let m;
  try {
    m = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw error('INVALID_MANIFEST', 'Invalid manifest JSON');
  }
  if (!object(m) || m.formatVersion !== 1 || typeof m.jobId !== 'string' || !object(m.context) || !object(m.stages) || !Array.isArray(m.errors) || m.errors.length > 100 || !Number.isSafeInteger(m.revision) || m.revision < 0 || m.contextHash !== hashValue(m.context)) throw error('INVALID_MANIFEST', 'Malformed manifest');
  for (const [id, s] of Object.entries(m.stages)) {
    if (!idPattern.test(id) || !object(s) || !Array.isArray(s.artifacts) || s.artifacts.length > 10000 || !Array.isArray(s.attempts) || s.attempts.length > 20 || !Array.isArray(s.deps) || s.deps.some(dep => !idPattern.test(dep)) || new Set(s.deps).size !== s.deps.length || !hashPattern.test(s.fingerprint) || s.resultHash !== hashValue({
      fingerprint: s.fingerprint,
      artifacts: s.artifacts
    }) || s.validation?.passed !== true || typeof s.directory !== 'string' || !s.directory.startsWith('outputs/' + id + '-')) throw error('INVALID_MANIFEST', 'Invalid stage checkpoint');
    await resolveContained(root, s.directory, {
      mustExist: false
    });
    for (const a of s.artifacts) {
      if (!object(a) || !hashPattern.test(a.hash) || !Number.isSafeInteger(a.size) || a.size < 0 || typeof a.path !== 'string') throw error('INVALID_MANIFEST', 'Invalid artifact');
      await resolveContained(root, s.directory + '/' + a.path, {
        mustExist: false
      });
    }
  }
  const visited = new Set(),
    visiting = new Set();
  function check(id) {
    if (visiting.has(id) || !Object.hasOwn(m.stages, id)) throw error('INVALID_MANIFEST', 'Invalid checkpoint topology');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of m.stages[id].deps) check(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of Object.keys(m.stages)) check(id);
  return m;
}
async function inspectJob(root) {
  return readManifest(await fs.realpath(root));
}
// A short-lived acquisition gate serializes the read/prove-dead/remove sequence.
// An unverifiable acquisition gate is deliberately never stolen by age.
async function acquireLock(root, token) {
  const gate = await resolveContained(root, 'acquire.lock', {
    mustExist: false
  });
  let gateHandle;
  try {
    gateHandle = await fs.open(gate, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') throw error('JOB_LOCKED', 'Lock acquisition in progress');
    throw e;
  }
  try {
    const lock = await resolveContained(root, 'job.lock', {
      mustExist: false
    });
    let prior;
    try {
      prior = JSON.parse(await fs.readFile(lock, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw error('JOB_LOCKED', 'Unverifiable lock owner');
    }
    if (prior) {
      if (!Number.isInteger(prior.pid) || prior.pid <= 0 || typeof prior.token !== 'string') throw error('JOB_LOCKED', 'Unverifiable lock owner');
      try {
        process.kill(prior.pid, 0);
        throw error('JOB_LOCKED', 'Job has a live owner');
      } catch (e) {
        if (e.code !== 'ESRCH') throw error('JOB_LOCKED', 'Owner cannot be proven dead');
      }
      await fs.unlink(lock);
    }
    await fs.writeFile(lock, JSON.stringify({
      pid: process.pid,
      token
    }), {
      flag: 'wx'
    });
    return lock;
  } finally {
    await gateHandle.close();
    await fs.unlink(gate);
  }
}
async function openJob(jobRoot, options = {}) {
  const checkedContext = options.expectedJobId !== undefined || options.expectedContextHash !== undefined;
  if (checkedContext && (typeof options.expectedJobId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(options.expectedJobId) || typeof options.expectedContextHash !== 'string' || !hashPattern.test(options.expectedContextHash))) throw error('INVALID_INPUT', 'Expected job ID and context hash must be supplied together as bounded values');
  await fs.mkdir(jobRoot, {
    recursive: true
  });
  const stat = await fs.lstat(jobRoot);
  if (stat.isSymbolicLink()) throw error('UNSAFE_PATH', 'Job root cannot be a link');
  const root = await fs.realpath(jobRoot);
  for (const quota of ['maxStageBytes', 'maxStorageBytes']) if (options[quota] !== undefined && (!Number.isSafeInteger(options[quota]) || options[quota] < 0)) throw error('INVALID_INPUT', 'Invalid quota');
  const token = crypto.randomUUID();
  const lock = await acquireLock(root, token);
  let closed = false,
    running = false,
    manifest,
    persistedHash = null;
  async function owned() {
    if (closed) throw error('JOB_CLOSED', 'Job closed');
    const current = JSON.parse(await fs.readFile(lock, 'utf8'));
    if (current.token !== token) throw error('JOB_LOCKED', 'Lock ownership changed');
  }
  async function close() {
    if (running) throw error('JOB_BUSY', 'Cannot close active run');
    if (closed) return;
    await owned();
    await fs.unlink(lock);
    closed = true;
  }
  try {
    try {
      manifest = await readManifest(root);
      persistedHash = hashValue(manifest);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (checkedContext) throw error('STALE_JOB_CONTEXT', 'Expected job does not exist');
      manifest = {
        formatVersion: 1,
        jobId: crypto.randomUUID(),
        revision: 0,
        context: {},
        contextHash: hashValue({}),
        stages: {},
        errors: []
      };
    }
    if (checkedContext && (manifest.jobId !== options.expectedJobId || manifest.contextHash !== options.expectedContextHash)) throw error('STALE_JOB_CONTEXT', 'Job identity or context changed before ownership was acquired');
    // Source publication must share the same ownership lock as stage commits.
    // Check the existing context first; this callback is a trusted caller
    // capability, never specification data. Failed capture saves no manifest.
    if (options.captureInputs) options = {
      ...options,
      inputs: await options.captureInputs(root)
    };
    if (Object.keys(options).some(k => ['spec', 'backend', 'tools', 'settings', 'inputs', 'versions'].includes(k))) {
      const context = {};
      for (const key of ['spec', 'backend', 'tools', 'settings', 'inputs', 'versions']) context[key] = structuredClone(options[key] ?? manifest.context[key] ?? {});
      manifest.context = context;
      manifest.contextHash = hashValue(context);
    }
    for (const dir of ['outputs', 'staging']) {
      const p = await resolveContained(root, dir, {
        mustExist: false
      });
      await fs.mkdir(p, {
        recursive: true
      });
    }
    // Context is a checkpoint independently of stage execution. A cached or
    // empty run must not leave resume using a superseded specification.
    if (hashValue(manifest) !== persistedHash) {
      await options.fault?.('beforeContextCommit');
      await save();
    }
  } catch (e) {
    await close();
    throw e;
  }
  async function save() {
    await owned();
    let diskHash = null;
    try {
      diskHash = hashValue(await readManifest(root));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (diskHash !== persistedHash) throw error('CONCURRENT_MODIFICATION', 'Manifest changed outside this job handle');
    manifest.revision++;
    await atomicWrite(path.join(root, 'manifest.json'), canonicalJson(manifest));
    persistedHash = hashValue(manifest);
  }
  return {
    get manifest() {
      return structuredClone(manifest);
    },
    close,
    async run(stages) {
      if (running) throw error('JOB_BUSY', 'Run already active');
      running = true;
      try {
        await owned();
        if (!Array.isArray(stages)) throw error('INVALID_DAG', 'Expected stages');
        const map = new Map();
        for (const s of stages) {
          if (!s || !idPattern.test(s.id) || map.has(s.id) || typeof s.run !== 'function' || s.deps !== undefined && (!Array.isArray(s.deps) || new Set(s.deps).size !== s.deps.length) || s.contextKeys !== undefined && (!Array.isArray(s.contextKeys) || s.contextKeys.some(k => !['spec', 'backend', 'tools', 'settings', 'inputs', 'versions'].includes(k)))) throw error('INVALID_DAG', 'Invalid or duplicate stage');
          map.set(s.id, s);
        }
        const dirty = new Set();
        const order = [],
          visiting = new Set(),
          done = new Set();
        function visit(s) {
          if (visiting.has(s.id)) throw error('INVALID_DAG', 'Dependency cycle');
          if (done.has(s.id)) return;
          visiting.add(s.id);
          for (const dep of s.deps ?? []) {
            if (!map.has(dep)) throw error('INVALID_DAG', 'Unknown dependency');
            visit(map.get(dep));
          }
          visiting.delete(s.id);
          done.add(s.id);
          order.push(s);
        }
        for (const s of stages) visit(s);
        for (const stage of order) {
          await owned();
          const deps = stage.deps ?? [];
          const fingerprint = hashValue({
            context: stage.contextKeys ? Object.fromEntries(stage.contextKeys.map(key => [key, manifest.context[key] ?? null])) : manifest.contextHash,
            stage: stage.fingerprint ?? null,
            deps: deps.map(id => ({
              id,
              resultHash: manifest.stages[id].resultHash
            }))
          });
          const prior = manifest.stages[stage.id];
          let intact = false;
          if (prior?.fingerprint === fingerprint && !deps.some(id => dirty.has(id))) {
            try {
              intact = hashValue(await inventory(await resolveContained(root, prior.directory))) === hashValue(prior.artifacts);
            } catch {
              intact = false;
            }
          }
          if (intact) continue;
          dirty.add(stage.id);
          const nonce = crypto.randomUUID();
          const stagingDir = await resolveContained(root, 'staging/' + stage.id + '-' + nonce, {
            mustExist: false
          });
          await fs.mkdir(stagingDir);
          const started = new Date().toISOString();
          try {
            await stage.run({
              stagingDir,
              dependencies: Object.fromEntries(deps.map(id => [id, structuredClone(manifest.stages[id])]))
            });
            const artifacts = await inventory(stagingDir, '', {
              remaining: options.maxStageBytes ?? 64 * 1024 * 1024,
              count: 0
            });
            const size = artifacts.reduce((n, a) => n + a.size, 0);
            if (size > (options.maxStageBytes ?? 64 * 1024 * 1024)) throw error('QUOTA_EXCEEDED', 'Stage output quota exceeded');
            if (size + (await ownedStorage(root)) > (options.maxStorageBytes ?? 512 * 1024 * 1024)) throw error('QUOTA_EXCEEDED', 'Job storage quota exceeded');
            if (stage.validate && (await stage.validate({
              stagingDir,
              artifacts: structuredClone(artifacts)
            })) === false) throw error('VALIDATION_FAILED', 'Stage validation failed');
            if (stage.validate) {
              const verified = await inventory(stagingDir, '', {
                remaining: options.maxStageBytes ?? 64 * 1024 * 1024,
                count: 0
              });
              if (hashValue(verified) !== hashValue(artifacts)) throw error('VALIDATION_MUTATED_OUTPUT', 'Validation changed stage output bytes');
            }
            await options.fault?.('beforeCommit', stage.id);
            await owned();
            const directory = 'outputs/' + stage.id + '-' + nonce;
            for(let attempt=0;;attempt++){
              await owned();
              const source=await resolveContained(root,path.relative(root,stagingDir));
              const destination=await resolveContained(root,directory,{mustExist:false});
              try{await fs.rename(source,destination);break;}
              catch(e){
                if(!['EPERM','EBUSY'].includes(e.code)||attempt>=3)throw e;
                await new Promise(resolve=>setTimeout(resolve,25*2**attempt));
              }
            }
            const record = {
              deps,
              fingerprint,
              directory,
              artifacts,
              resultHash: hashValue({
                fingerprint,
                artifacts
              }),
              validation: {
                passed: true
              },
              attempts: [...(prior?.attempts ?? []).slice(-19), {
                started,
                completed: new Date().toISOString(),
                passed: true
              }]
            };
            manifest.stages[stage.id] = record;
            try {
              await save();
            } catch (e) {
              if (prior) manifest.stages[stage.id] = prior;else delete manifest.stages[stage.id];
              throw e;
            }
            await options.fault?.('afterCommit', stage.id);
          } catch (e) {
            // Resolve the owned parent and remove a replaced root as a link only.
            const ownedParent = await resolveContained(root, 'staging');
            if (path.dirname(stagingDir) !== ownedParent) throw error('UNSAFE_PATH', 'Staging cleanup escaped job');
            try {
              if ((await fs.lstat(stagingDir)).isSymbolicLink()) await fs.unlink(stagingDir);else await fs.rm(stagingDir, {
                recursive: true,
                force: true
              });
            } catch (cleanup) {
              if (cleanup.code !== 'ENOENT') throw cleanup;
            }
            if (prior) prior.attempts = [...prior.attempts.slice(-19), {
              started,
              completed: new Date().toISOString(),
              passed: false,
              code: e.code ?? 'STAGE_FAILED'
            }];
            manifest.errors.push({
              stage: stage.id,
              code: e.code ?? 'STAGE_FAILED',
              message: String(e.message),
              at: new Date().toISOString()
            });
            manifest.errors = manifest.errors.slice(-100);
            await save();
            throw e;
          }
        }
        return structuredClone(manifest);
      } finally {
        running = false;
      }
    }
  };
}
module.exports = {
  openJob,
  inspectJob
};
