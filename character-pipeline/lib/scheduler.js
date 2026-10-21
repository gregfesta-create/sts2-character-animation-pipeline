'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  randomUUID
} = require('node:crypto');
function failure(code, message) {
  return Object.assign(new Error(message), {
    code
  });
}
function aborted() {
  return failure('ABORT_ERR', 'Operation cancelled');
}
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const done = () => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(aborted());
    };
    signal?.addEventListener('abort', cancel, {
      once: true
    });
  });
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) throw failure('LEASE_CORRUPT', 'Invalid lease owner');
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
// A short synchronous guard serializes all lease inspection and mutation. Never
// reclaim an ambiguous guard: a crashed guard requires explicit operator recovery.
function guarded(directory, operation) {
  const guard = path.join(directory, 'gpu.guard');
  try {
    fs.mkdirSync(guard);
  } catch (error) {
    if (error.code === 'EEXIST') return {
      busy: true
    };
    throw error;
  }
  try {
    return {
      value: operation()
    };
  } finally {
    fs.rmdirSync(guard);
  }
}
function leaseTimeout(phase, timeoutMs) {
  return Object.assign(failure('LEASE_TIMEOUT', `GPU lease ${phase} exceeded ${timeoutMs}ms; existing ownership records preserved`), {phase, timeoutMs});
}
async function gpuLease(directory, signal, timeoutMs) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw failure('LEASE_DIRECTORY', 'GPU requires an authorized absolute lease directory');
  const canonical = fs.realpathSync(directory);
  if (path.resolve(directory) !== canonical) throw failure('LEASE_DIRECTORY', 'Lease directory must be canonical and contain no links');
  const file = path.join(canonical, 'gpu.json');
  const token = randomUUID();
  const acquireDeadline = performance.now() + timeoutMs;
  while (true) {
    if (signal?.aborted) throw aborted();
    if (performance.now() >= acquireDeadline) throw leaseTimeout('acquire', timeoutMs);
    const result = guarded(canonical, () => {
      if (fs.existsSync(file)) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw failure('LEASE_CORRUPT', 'Invalid GPU lease file');
        let owner;
        try {
          owner = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          throw failure('LEASE_CORRUPT', 'Unreadable GPU lease');
        }
        if (typeof owner.token !== 'string') throw failure('LEASE_CORRUPT', 'Invalid GPU owner token');
        if (alive(owner.pid)) return false;
        fs.unlinkSync(file);
      }
      fs.writeFileSync(file, JSON.stringify({
        pid: process.pid,
        token
      }), {
        flag: 'wx'
      });
      return true;
    });
    if (result.value) break;
    await pause(Math.min(5, Math.max(0, acquireDeadline - performance.now())), signal);
  }
  return async () => {
    const releaseDeadline = performance.now() + timeoutMs;
    while (true) {
      if (performance.now() >= releaseDeadline) throw leaseTimeout('release', timeoutMs);
      const result = guarded(canonical, () => {
        const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (owner.token !== token || owner.pid !== process.pid) throw failure('LEASE_OWNERSHIP', 'GPU lease owner changed; foreign lease preserved');
        fs.unlinkSync(file);
      });
      if (!result.busy) return;
      await pause(Math.min(5, Math.max(0, releaseDeadline - performance.now())));
    }
  };
}
function createScheduler({
  cpu = 2,
  gpu = 1,
  maxQueue = 100,
  gpuLeaseDirectory,
  leaseTimeoutMs = 30000
} = {}) {
  if (!Number.isInteger(cpu) || cpu < 1 || cpu > 256 || gpu !== 1 || !Number.isInteger(maxQueue) || maxQueue < 0 || !Number.isInteger(leaseTimeoutMs) || leaseTimeoutMs < 1 || leaseTimeoutMs > 1200000) throw failure('INVALID_INPUT', 'Invalid scheduler limits');
  const pools = {
    cpu: {
      limit: cpu,
      running: 0,
      queue: []
    },
    gpu: {
      limit: gpu,
      running: 0,
      queue: []
    }
  };
  function pump(resource) {
    const pool = pools[resource];
    while (pool.running < pool.limit && pool.queue.length) {
      const job = pool.queue.shift();
      job.signal?.removeEventListener('abort', job.cancel);
      pool.running++;
      Promise.resolve().then(async () => {
        let release;
        try {
          if (job.signal?.aborted) throw aborted();
          if (resource === 'gpu') release = await gpuLease(gpuLeaseDirectory, job.signal, leaseTimeoutMs);
          return await job.fn(job.signal);
        } finally {
          if (release) await release();
        }
      }).then(value => {
        pool.running--;
        pump(resource);
        job.resolve(value);
      }, error => {
        pool.running--;
        pump(resource);
        job.reject(error);
      });
    }
  }
  return {
    schedule(resource, fn, {
      signal
    } = {}) {
      return new Promise((resolve, reject) => {
        if (!Object.hasOwn(pools, resource) || typeof fn !== 'function' || (signal !== undefined && !(signal instanceof AbortSignal))) {
          reject(failure('INVALID_INPUT', 'Unknown resource or missing task'));
          return;
        }
        if (signal?.aborted) {
          reject(aborted());
          return;
        }
        const pool = pools[resource];
        if (pool.running >= pool.limit && pool.queue.length >= maxQueue) {
          reject(failure('QUEUE_FULL', 'Resource queue limit exceeded'));
          return;
        }
        const job = {
          fn,
          signal,
          resolve,
          reject
        };
        job.cancel = () => {
          const index = pool.queue.indexOf(job);
          if (index >= 0) {
            pool.queue.splice(index, 1);
            reject(aborted());
          }
        };
        signal?.addEventListener('abort', job.cancel, {
          once: true
        });
        pool.queue.push(job);
        pump(resource);
      });
    },
    stats() {
      return Object.fromEntries(Object.entries(pools).map(([key, pool]) => [key, {
        running: pool.running,
        queued: pool.queue.length,
        limit: pool.limit
      }]));
    }
  };
}
function defaultClassify(error) {
  if (['EACCES', 'EPERM', 'CONFIGURATION'].includes(error.code)) return {
    classification: 'configuration'
  };
  if (error.code === 'UNSUPPORTED') return {
    classification: 'unsupported'
  };
  return {
    classification: ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(error.code) ? 'transient' : 'asset'
  };
}
async function runWithRetries(fn, {
  maxAttempts = 3,
  backoffMs = 100,
  maxBackoffMs = 5000,
  signal,
  classify = defaultClassify,
  onAttempt
} = {}) {
  if (typeof fn !== 'function' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3 || !Number.isFinite(backoffMs) || backoffMs < 0 || !Number.isFinite(maxBackoffMs) || maxBackoffMs < 0 || maxBackoffMs > 60000 || typeof classify !== 'function') throw failure('INVALID_INPUT', 'Invalid retry settings');
  const attempts = [];
  const repairs = new Set();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw aborted();
    let value;
    let error;
    try {
      value = await fn({
        attempt,
        signal,
        attempts: structuredClone(attempts)
      });
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error(String(cause));
    }
    if (!error) {
      const diagnostic = {
        attempt,
        status: 'succeeded'
      };
      attempts.push(diagnostic);
      await onAttempt?.(structuredClone(diagnostic));
      return {
        value,
        attempts
      };
    }
    const detail = ['EACCES', 'EPERM', 'CONFIGURATION', 'UNSUPPORTED'].includes(error.code) ? defaultClassify(error) : classify(error, {
      attempt
    });
    const diagnosis = typeof detail === 'string' ? {
      classification: detail
    } : detail;
    if (!diagnosis || !['transient', 'configuration', 'asset', 'unsupported'].includes(diagnosis.classification)) throw failure('INVALID_CLASSIFICATION', 'Unknown failure classification');
    const diagnostic = {
      attempt,
      status: 'failed',
      code: error.code || 'OPERATION_FAILED',
      message: error.message,
      ...diagnosis
    };
    attempts.push(diagnostic);
    await onAttempt?.(structuredClone(diagnostic));
    let retry = diagnosis.classification === 'transient';
    if (diagnosis.classification === 'asset' && diagnosis.diagnosis && diagnosis.action) {
      const key = JSON.stringify([diagnosis.diagnosis, diagnosis.action]);
      if (repairs.has(key)) {
        const repeated = failure('REPEATED_REPAIR', 'Identical unsuccessful repair cannot repeat');
        repeated.attempts = attempts;
        throw repeated;
      }
      repairs.add(key);
      retry = true;
    }
    if (!retry || attempt === maxAttempts) {
      error.attempts = attempts;
      throw error;
    }
    await pause(Math.min(maxBackoffMs, backoffMs * 2 ** (attempt - 1)), signal);
  }
}
module.exports = {
  createScheduler,
  runWithRetries
};


