'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createScheduler,
  runWithRetries
} = require('../lib/scheduler');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-lease-'));
  t.after(() => fs.rmSync(dir, {
    recursive: true,
    force: true
  }));
  return dir;
}
test('CPU bounded FIFO and throw releases permit', async () => {
  const scheduler = createScheduler({
    cpu: 1,
    maxQueue: 2
  });
  const order = [];
  const first = scheduler.schedule('cpu', async () => {
    await delay(10);
    order.push(1);
    throw Error('failed');
  });
  const second = scheduler.schedule('cpu', async () => order.push(2));
  await assert.rejects(first, /failed/);
  await second;
  assert.deepEqual(order, [1, 2]);
  assert.equal(scheduler.stats().cpu.running, 0);
});
test('queue capacity, queued cancellation and task-owned running cancellation', async () => {
  const s = createScheduler({
    cpu: 1,
    maxQueue: 1
  });
  let release;
  const first = s.schedule('cpu', () => new Promise(r => {
    release = r;
  }));
  await delay(1);
  const c = new AbortController();
  const queued = s.schedule('cpu', () => assert.fail(), {
    signal: c.signal
  });
  await assert.rejects(s.schedule('cpu', () => {}), {
    code: 'QUEUE_FULL'
  });
  c.abort();
  await assert.rejects(queued, {
    code: 'ABORT_ERR'
  });
  release('done');
  assert.equal(await first, 'done');
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(s.schedule('cpu', () => {}, {
    signal: aborted.signal
  }), {
    code: 'ABORT_ERR'
  });
  const running = new AbortController();
  const value = s.schedule('cpu', async signal => {
    running.abort();
    assert.equal(signal.aborted, true);
    return 'completed';
  }, {
    signal: running.signal
  });
  assert.equal(await value, 'completed');
});
test('GPU lease coordinates scheduler instances, stale PID and ownership refusal', async t => {
  const dir = directory(t);
  const a = createScheduler({
    gpuLeaseDirectory: dir
  });
  const b = createScheduler({
    gpuLeaseDirectory: dir
  });
  let active = 0;
  let peak = 0;
  await Promise.all([a, b].map(s => s.schedule('gpu', async () => {
    peak = Math.max(peak, ++active);
    await delay(8);
    active--;
  })));
  assert.equal(peak, 1);
  fs.writeFileSync(path.join(dir, 'gpu.json'), JSON.stringify({
    pid: 2147483647,
    token: 'dead'
  }));
  await a.schedule('gpu', () => 42);
  assert.equal(fs.existsSync(path.join(dir, 'gpu.json')), false);
  await assert.rejects(a.schedule('gpu', () => {
    fs.writeFileSync(path.join(dir, 'gpu.json'), JSON.stringify({
      pid: process.pid,
      token: 'foreign'
    }));
  }), {
    code: 'LEASE_OWNERSHIP'
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'gpu.json'))).token, 'foreign');
});
test('invalid scheduler configuration and missing GPU authorization', async () => {
  for (const options of [{
    cpu: 0
  }, {
    gpu: 2
  }, {
    maxQueue: -1
  }]) assert.throws(() => createScheduler(options));
  const s = createScheduler();
  await assert.rejects(s.schedule('other', () => {}), {
    code: 'INVALID_INPUT'
  });
  await assert.rejects(s.schedule('cpu', null), {
    code: 'INVALID_INPUT'
  });
  await assert.rejects(s.schedule('gpu', () => {}), {
    code: 'LEASE_DIRECTORY'
  });
});
test('transient retries bounded with diagnostics and callbacks', async () => {
  const seen = [];
  let calls = 0;
  const result = await runWithRetries(() => {
    if (++calls < 3) throw Object.assign(Error('offline'), {
      code: 'ECONNRESET'
    });
    return 7;
  }, {
    backoffMs: 1,
    onAttempt: d => seen.push(d)
  });
  assert.equal(result.value, 7);
  assert.equal(result.attempts.length, 3);
  assert.equal(seen[0].classification, 'transient');
  await assert.rejects(runWithRetries(() => {
    throw Object.assign(Error('offline'), {
      code: 'ETIMEDOUT'
    });
  }, {
    maxAttempts: 2,
    backoffMs: 0
  }), e => e.attempts.length === 2);
});
test('permission/config unsupported and repeated repair never retry blindly', async () => {
  for (const code of ['EACCES', 'EPERM', 'CONFIGURATION', 'UNSUPPORTED']) {
    let n = 0;
    await assert.rejects(runWithRetries(() => {
      n++;
      throw Object.assign(Error(code), {
        code
      });
    }, {
      backoffMs: 0
    }));
    assert.equal(n, 1);
  }
  let n = 0;
  await assert.rejects(runWithRetries(() => {
    n++;
    throw Error('bad asset');
  }, {
    backoffMs: 0,
    classify: () => ({
      classification: 'asset',
      diagnosis: 'gap',
      action: 'crop'
    })
  }), e => e.code === 'REPEATED_REPAIR');
  assert.equal(n, 2);
  let changed = 0;
  const r = await runWithRetries(() => {
    if (++changed < 3) throw Error('asset');
    return true;
  }, {
    backoffMs: 0,
    classify: () => ({
      classification: 'asset',
      diagnosis: 'gap',
      action: String(changed)
    })
  });
  assert.equal(r.value, true);
});
test('retry option validation and cancellation', async () => {
  for (const options of [{
    maxAttempts: 4
  }, {
    maxAttempts: 0
  }, {
    backoffMs: -1
  }]) await assert.rejects(runWithRetries(() => {}, options));
  const c = new AbortController();
  c.abort();
  await assert.rejects(runWithRetries(() => assert.fail(), {
    signal: c.signal
  }), {
    code: 'ABORT_ERR'
  });
  const d = new AbortController();
  await assert.rejects(runWithRetries(() => {
    setTimeout(() => d.abort(), 2);
    throw Object.assign(Error('offline'), {
      code: 'ECONNRESET'
    });
  }, {
    signal: d.signal,
    backoffMs: 50
  }), {
    code: 'ABORT_ERR'
  });
});
test('lease blocks across processes and waiting cancellation preserves foreign lease', async t => {
  const {
    spawn
  } = require('node:child_process');
  const dir = directory(t);
  const modulePath = path.resolve(__dirname, '../lib/scheduler.js');
  const child = spawn(process.execPath, ['-e', `const {createScheduler}=require(${JSON.stringify(modulePath)});createScheduler({gpuLeaseDirectory:${JSON.stringify(dir)}}).schedule('gpu',async()=>{console.log('ready');await new Promise(r=>setTimeout(r,150));});`], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
    child.once('exit', code => {
      if (code) reject(Error('child failed'));
    });
  });
  const s = createScheduler({
    gpuLeaseDirectory: dir
  });
  const c = new AbortController();
  const queued = s.schedule('gpu', () => assert.fail(), {
    signal: c.signal
  });
  setTimeout(() => c.abort(), 5);
  await assert.rejects(queued, {
    code: 'ABORT_ERR'
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'gpu.json'))).pid, child.pid);
  await s.schedule('gpu', () => assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'gpu.json'))).pid, process.pid));
});
test('lease rejects corruption and absent directories without task execution', async t => {
  const dir = directory(t);
  const s = createScheduler({
    gpuLeaseDirectory: dir
  });
  for (const text of ['{', JSON.stringify({
    pid: -1,
    token: 'x'
  }), JSON.stringify({
    pid: process.pid
  })]) {
    fs.writeFileSync(path.join(dir, 'gpu.json'), text);
    await assert.rejects(s.schedule('gpu', () => assert.fail()), {
      code: 'LEASE_CORRUPT'
    });
  }
  await assert.rejects(createScheduler({
    gpuLeaseDirectory: path.join(dir, 'absent')
  }).schedule('gpu', () => {}), {
    code: 'ENOENT'
  });
  await assert.rejects(runWithRetries(() => {
    throw Error('x');
  }, {
    classify: () => null
  }), {
    code: 'INVALID_CLASSIFICATION'
  });
  await assert.rejects(runWithRetries(() => {
    throw 'plain';
  }, {
    backoffMs: 0
  }), /plain/);
});
test('classification override cannot retry permission or configuration failures', async () => {
  for (const code of ['EACCES', 'EPERM', 'CONFIGURATION', 'UNSUPPORTED']) {
    let calls = 0;
    await assert.rejects(runWithRetries(() => {
      calls++;
      throw Object.assign(Error(code), { code });
    }, { backoffMs: 0, classify: () => ({ classification: 'transient' }) }));
    assert.equal(calls, 1);
  }
});
test('lease wait timeout bounds abandoned guards and preserves foreign files', async t => {
  const dir = directory(t);
  fs.mkdirSync(path.join(dir, 'gpu.guard'));
  fs.writeFileSync(path.join(dir, 'gpu.json'), JSON.stringify({pid: process.pid, token:'foreign'}));
  const scheduler = createScheduler({gpuLeaseDirectory:dir,leaseTimeoutMs:15});
  await assert.rejects(scheduler.schedule('gpu', () => assert.fail(), {signal:AbortSignal.timeout(100)}), {code:'LEASE_TIMEOUT',phase:'acquire'});
  assert.equal(scheduler.stats().gpu.running,0);
  assert.equal(fs.existsSync(path.join(dir,'gpu.guard')),true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'gpu.json'))).token,'foreign');
});
test('release timeout restores permits and preserves ambiguous guard and owned lease', async t => {
  const dir=directory(t);const scheduler=createScheduler({gpuLeaseDirectory:dir,leaseTimeoutMs:15});
  const fallback=setTimeout(()=>fs.rmSync(path.join(dir,'gpu.guard'),{recursive:true,force:true}),120);t.after(()=>clearTimeout(fallback));
  await assert.rejects(scheduler.schedule('gpu',()=>{fs.mkdirSync(path.join(dir,'gpu.guard'));}),{code:'LEASE_TIMEOUT',phase:'release'});
  assert.equal(scheduler.stats().gpu.running,0);
  assert.equal(fs.existsSync(path.join(dir,'gpu.guard')),true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'gpu.json'))).pid,process.pid);
  assert.equal(await scheduler.schedule('cpu',()=>42),42);
});
test('lease timeout configuration and invalid signals fail before allocation',async()=>{
  for(const leaseTimeoutMs of [0,-1,Infinity,1200001,1.5])assert.throws(()=>createScheduler({leaseTimeoutMs}),{code:'INVALID_INPUT'});
  const scheduler=createScheduler();
  await assert.rejects(scheduler.schedule('cpu',()=>assert.fail(),{signal:{aborted:false}}),{code:'INVALID_INPUT'});
  assert.equal(scheduler.stats().cpu.running,0);
});
