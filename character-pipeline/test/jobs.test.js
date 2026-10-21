'use strict';

const {
  test
} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  openJob
} = require('../lib/jobs');
async function temp(t) {
  const r = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-jobs-'));
  t.after(() => fs.rm(r, {
    recursive: true,
    force: true
  }));
  return r;
}
function stages(count, version = 1) {
  return [{
    id: 'arm',
    fingerprint: version,
    run: async ({
      stagingDir
    }) => {
      count.arm++;
      await fs.writeFile(path.join(stagingDir, 'a'), 'arm' + version);
    }
  }, {
    id: 'body',
    run: async ({
      stagingDir
    }) => {
      count.body++;
      await fs.writeFile(path.join(stagingDir, 'b'), 'body');
    }
  }, {
    id: 'render',
    deps: ['arm', 'body'],
    run: async ({
      stagingDir
    }) => {
      count.render++;
      await fs.writeFile(path.join(stagingDir, 'r'), 'render');
    }
  }];
}

test('stage publication retries transient sharing failures without rerunning work and bounds permanent errors',async t=>{
 const root=await temp(t),original=fs.rename;let calls=0,runs=0,mode='transient';
 fs.rename=async(source,destination)=>{
  if(source.startsWith(path.join(root,'staging')+path.sep)){
   calls++;
   if(mode==='permanent'||mode==='transient'&&calls<3)throw Object.assign(Error('sharing violation'),{code:'EPERM'});
   if(mode==='other')throw Object.assign(Error('unrelated I/O'),{code:'EIO'});
  }
  return original(source,destination);
 };
 t.after(()=>{fs.rename=original;});
 const job=await openJob(root);try{
 const stage={id:'publish',fingerprint:1,run:async({stagingDir})=>{runs++;await fs.writeFile(path.join(stagingDir,'result'),'verified bytes');}};
 const first=await job.run([stage]);assert.equal(calls,3);assert.equal(runs,1);assert.equal(await fs.readFile(path.join(root,first.stages.publish.directory,'result'),'utf8'),'verified bytes');
 mode='permanent';calls=0;await assert.rejects(job.run([{...stage,fingerprint:2}]),{code:'EPERM'});assert.equal(calls,4);assert.equal(runs,2);
 mode='other';calls=0;await assert.rejects(job.run([{...stage,fingerprint:3}]),{code:'EIO'});assert.equal(calls,1);assert.equal(runs,3);
 }finally{await job.close();fs.rename=original;}
});
test('resumes DAG, invalidates descendants only, repairs corruption and excludes concurrent owner', async t => {
  const root = await temp(t),
    count = {
      arm: 0,
      body: 0,
      render: 0
    };
  let j = await openJob(root, {
    spec: {
      id: 'x'
    }
  });
  await assert.rejects(openJob(root, {
    spec: {}
  }), {
    code: 'JOB_LOCKED'
  });
  await j.run(stages(count));
  await j.run(stages(count));
  assert.deepEqual(count, {
    arm: 1,
    body: 1,
    render: 1
  });
  await j.run(stages(count, 2));
  assert.deepEqual(count, {
    arm: 2,
    body: 1,
    render: 2
  });
  await fs.writeFile(path.join(root, j.manifest.stages.arm.directory, 'a'), 'bad');
  await j.run(stages(count, 2));
  assert.deepEqual(count, {
    arm: 3,
    body: 1,
    render: 3
  });
  await j.close();
  j = await openJob(root, {
    spec: {
      id: 'x'
    }
  });
  await j.run(stages(count, 2));
  assert.equal(count.arm, 3);
  await j.close();
});
test('failure preserves old outputs and checkpoint, quotas and DAG are enforced', async t => {
  const root = await temp(t);
  let j = await openJob(root, {
    spec: {}
  });
  const c = {
    arm: 0,
    body: 0,
    render: 0
  };
  await j.run(stages(c));
  const old = j.manifest.stages.arm.directory;
  await assert.rejects(j.run([{
    id: 'arm',
    fingerprint: 2,
    run: async ({
      stagingDir
    }) => {
      await fs.writeFile(path.join(stagingDir, 'a'), 'bad');
    },
    validate: async () => false
  }]));
  assert.equal(j.manifest.stages.arm.directory, old);
  assert.equal(j.manifest.errors.length, 1);
  await assert.rejects(j.run([{
    id: 'x',
    deps: ['x'],
    run: async () => {}
  }]));
  await assert.rejects(j.run([{
    id: '../x',
    run: async () => {}
  }]));
  await j.close();
  j = await openJob(root, {
    spec: {},
    maxStageBytes: 1
  });
  await assert.rejects(j.run(stages(c, 3)), {
    code: 'QUOTA_EXCEEDED'
  });
  await j.close();
});
test('fault boundaries resume committed results and discard uncommitted publication', async t => {
  for (const boundary of ['beforeCommit', 'afterCommit']) {
    const root = await temp(t);
    let once = true;
    let j = await openJob(root, {
      fault: async point => {
        if (point === boundary && once) {
          once = false;
          throw new Error('crash');
        }
      }
    });
    let calls = 0;
    const work = [{
      id: 'a',
      run: async ({
        stagingDir
      }) => {
        calls++;
        await fs.writeFile(path.join(stagingDir, 'a'), 'a');
      }
    }];
    await assert.rejects(j.run(work));
    await j.close();
    j = await openJob(root);
    await j.run(work);
    assert.equal(calls, boundary === 'beforeCommit' ? 2 : 1);
    await j.close();
  }
});
test('context keys allow local edits, global tool and source revisions invalidate', async t => {
  const root = await temp(t),
    c = {
      arm: 0,
      body: 0,
      render: 0
    };
  let j = await openJob(root, {
    spec: {
      arm: 1
    },
    tools: {
      v: 1
    },
    inputs: {
      hash: 'a'
    },
    versions: {
      template: 1
    },
    settings: {
      seed: 1
    }
  });
  const work = () => stages(c).map(s => ({
    ...s,
    contextKeys: ['tools', 'inputs', 'versions', 'settings']
  }));
  await j.run(work());
  await j.close();
  j = await openJob(root, {
    spec: {
      arm: 2
    }
  });
  await j.run(work());
  assert.equal(c.arm, 1);
  await j.close();
  for (const options of [{
    tools: {
      v: 2
    }
  }, {
    inputs: {
      hash: 'b'
    }
  }, {
    versions: {
      template: 2
    }
  }, {
    settings: {
      seed: 2
    }
  }]) {
    j = await openJob(root, options);
    await j.run(work());
    await j.close();
  }
  assert.equal(c.arm, 5);
});
test('malformed and escaped recovered manifests are refused', async t => {
  const root = await temp(t);
  let j = await openJob(root);
  await j.run(stages({
    arm: 0,
    body: 0,
    render: 0
  }));
  await j.close();
  const file = path.join(root, 'manifest.json'),
    good = await fs.readFile(file, 'utf8');
  for (const mutation of [m => {
    m.contextHash = 'bad';
  }, m => {
    m.stages.arm.directory = 'outputs/arm-../../escape';
  }, m => {
    m.stages.arm.artifacts[0].path = '../escape';
  }, m => {
    m.stages.arm.artifacts[0].size = -1;
  }]) {
    const m = JSON.parse(good);
    mutation(m);
    await fs.writeFile(file, JSON.stringify(m));
    await assert.rejects(openJob(root));
  }
  await fs.writeFile(file, '{');
  await assert.rejects(openJob(root));
});
test('dead owner recovery, simultaneous recovery and safe foreign release', async t => {
  const root = await temp(t);
  const child = require('node:child_process').spawnSync(process.execPath, ['-e', '']);
  await fs.writeFile(path.join(root, 'job.lock'), JSON.stringify({
    pid: child.pid,
    token: 'dead'
  }));
  const results = await Promise.allSettled([openJob(root), openJob(root), openJob(root)]);
  const handles = results.filter(r => r.status === 'fulfilled');
  assert.equal(handles.length, 1);
  const j = handles[0].value;
  await fs.writeFile(path.join(root, 'job.lock'), JSON.stringify({
    pid: process.pid,
    token: 'foreign'
  }));
  await assert.rejects(j.close(), {
    code: 'JOB_LOCKED'
  });
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'job.lock'), 'utf8')).token, 'foreign');
});
test('concurrent manifest modification is not overwritten and close during run fails', async t => {
  const root = await temp(t);
  const j = await openJob(root);
  await j.run(stages({
    arm: 0,
    body: 0,
    render: 0
  }));
  let unblock;
  const running = j.run([{
    id: 'slow',
    run: async () => new Promise(resolve => {
      unblock = resolve;
    })
  }]);
  while (!unblock) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(j.close(), {
    code: 'JOB_BUSY'
  });
  await assert.rejects(j.run([]), {
    code: 'JOB_BUSY'
  });
  const file = path.join(root, 'manifest.json');
  const m = JSON.parse(await fs.readFile(file, 'utf8'));
  m.revision++;
  await fs.writeFile(file, JSON.stringify(m));
  unblock();
  await assert.rejects(running, {
    code: 'CONCURRENT_MODIFICATION'
  });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).revision, m.revision);
  await j.close();
  await assert.rejects(j.run([]), {
    code: 'JOB_CLOSED'
  });
});
test('job storage quota and unknown dependency fail', async t => {
  const root = await temp(t);
  const j = await openJob(root, {
    maxStorageBytes: 1
  });
  await assert.rejects(j.run(stages({
    arm: 0,
    body: 0,
    render: 0
  })), {
    code: 'QUOTA_EXCEEDED'
  });
  await assert.rejects(j.run([{
    id: 'x',
    deps: ['missing'],
    run: async () => {}
  }]), {
    code: 'INVALID_DAG'
  });
  await j.close();
});
test('separate processes contend for a dead-owner lock without removing a winner', async t => {
  const root = await temp(t);
  const {
    spawn,
    spawnSync
  } = require('node:child_process');
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  await fs.writeFile(path.join(root, 'job.lock'), JSON.stringify({
    pid: dead,
    token: 'stale'
  }));
  const code = `const {openJob}=require(process.argv[1]);openJob(process.argv[2]).then(async j=>{console.log('winner');await new Promise(r=>setTimeout(r,300));await j.close();}).catch(e=>console.log(e.code));`;
  async function child() {
    return new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ['-e', code, path.resolve(__dirname, '../lib/jobs.js'), root], {
        windowsHide: true
      });
      let out = '';
      c.stdout.on('data', d => out += d);
      c.on('error', reject);
      c.on('exit', () => resolve(out.trim()));
    });
  }
  const results = await Promise.all([child(), child(), child()]);
  assert.equal(results.filter(x => x === 'winner').length, 1);
  assert.equal(results.filter(x => x === 'JOB_LOCKED').length, 2);
});
test('unsafe stage output junctions and malformed lock owners are rejected', async t => {
  const root = await temp(t);
  let j = await openJob(root);
  await fs.mkdir(path.join(root, 'foreign'));
  await assert.rejects(j.run([{
    id: 'link',
    run: async ({
      stagingDir
    }) => fs.symlink(path.join(root, 'foreign'), path.join(stagingDir, 'link'), 'junction')
  }]), {
    code: 'UNSAFE_PATH'
  });
  await j.close();
  for (const text of ['{', JSON.stringify({
    pid: -1
  }), JSON.stringify({
    pid: process.pid,
    token: 'live'
  })]) {
    await fs.writeFile(path.join(root, 'job.lock'), text);
    await assert.rejects(openJob(root), {
      code: 'JOB_LOCKED'
    });
    await fs.unlink(path.join(root, 'job.lock'));
  }
  await assert.rejects(openJob(root, {
    maxStageBytes: -1
  }), {
    code: 'INVALID_INPUT'
  });
});
test('recovered checkpoint rejects invalid topology and artifact hash claims', async t => {
  const root = await temp(t);
  const j = await openJob(root);
  await j.run(stages({
    arm: 0,
    body: 0,
    render: 0
  }));
  await j.close();
  const file = path.join(root, 'manifest.json'),
    good = await fs.readFile(file, 'utf8');
  for (const mutate of [m => m.stages.arm.deps = ['render'], m => m.stages.arm.deps = ['missing'], m => m.stages.arm.resultHash = 'bad', m => m.stages.arm.artifacts[0].hash = 'bad', m => m.stages = [], m => m.stages.arm.validation = {
    passed: false
  }]) {
    const m = JSON.parse(good);
    mutate(m);
    await fs.writeFile(file, JSON.stringify(m));
    await assert.rejects(require('../lib/jobs').inspectJob(root), {
      code: 'INVALID_MANIFEST'
    });
  }
});
test('replacing the entire staging directory with a junction cannot publish foreign outputs', async t => {
  const root = await temp(t),
    foreign = await temp(t);
  await fs.writeFile(path.join(foreign, 'secret'), 'private');
  const j = await openJob(root);
  await assert.rejects(j.run([{
    id: 'escape',
    run: async ({
      stagingDir
    }) => {
      await fs.rmdir(stagingDir);
      await fs.symlink(foreign, stagingDir, 'junction');
    }
  }]), {
    code: 'UNSAFE_PATH'
  });
  assert.equal(await fs.readFile(path.join(foreign, 'secret'), 'utf8'), 'private');
  assert.deepEqual(j.manifest.stages, {});
  await j.close();
});
test('unsafe existing job lock releases its acquisition gate', async t => {
  const root = await temp(t),
    foreign = await temp(t);
  await fs.symlink(foreign, path.join(root, 'job.lock'), 'junction');
  await assert.rejects(openJob(root), {
    code: 'UNSAFE_PATH'
  });
  await assert.rejects(fs.stat(path.join(root, 'acquire.lock')), {
    code: 'ENOENT'
  });
});
test('changing dependency identity invalidates equal-content dependency cache', async t => {
  const root = await temp(t);
  const j = await openJob(root);
  const leaf = id => ({
    id,
    run: async ({
      stagingDir
    }) => fs.writeFile(path.join(stagingDir, 'same'), 'identical')
  });
  let renders = 0;
  const render = dependency => ({
    id: 'render',
    deps: [dependency],
    run: async ({
      stagingDir,
      dependencies
    }) => {
      renders++;
      await fs.writeFile(path.join(stagingDir, 'selected'), Object.keys(dependencies).join(','));
    }
  });
  await j.run([leaf('a'), leaf('b'), render('a')]);
  assert.equal(j.manifest.stages.a.resultHash, j.manifest.stages.b.resultHash);
  await j.run([leaf('a'), leaf('b'), render('b')]);
  assert.equal(renders, 2);
  assert.deepEqual(j.manifest.stages.render.deps, ['b']);
  assert.equal(await fs.readFile(path.join(root, j.manifest.stages.render.directory, 'selected'), 'utf8'), 'b');
  await j.close();
});
test('context revisions persist through cached, empty and unopened runs without regeneration', async t => {
  const root = await temp(t);
  let calls = 0;
  const work = [{
    id: 'a',
    contextKeys: ['tools'],
    run: async ({
      stagingDir
    }) => {
      calls++;
      await fs.writeFile(path.join(stagingDir, 'a'), 'unchanged');
    }
  }];
  let j = await openJob(root, {
    spec: {
      revision: 1
    },
    tools: {
      version: 1
    }
  });
  await j.run(work);
  await j.close();
  j = await openJob(root, {
    spec: {
      revision: 2
    }
  });
  await j.run(work);
  await j.close();
  assert.equal(calls, 1);
  assert.equal((await require('../lib/jobs').inspectJob(root)).context.spec.revision, 2);
  j = await openJob(root, {
    spec: {
      revision: 3
    }
  });
  await j.run([]);
  await j.close();
  assert.equal((await require('../lib/jobs').inspectJob(root)).context.spec.revision, 3);
  j = await openJob(root, {
    spec: {
      revision: 4
    }
  });
  await j.close();
  j = await openJob(root);
  assert.equal(j.manifest.context.spec.revision, 4);
  await j.run(work);
  await j.close();
  assert.equal(calls, 1);
});
test('failed context checkpoint retains previous valid manifest and releases lock', async t => {
  const root = await temp(t);
  let j = await openJob(root, {
    spec: {
      revision: 1
    }
  });
  await j.run([]);
  await j.close();
  const before = await fs.readFile(path.join(root, 'manifest.json'), 'utf8');
  await assert.rejects(openJob(root, {
    spec: {
      revision: 2
    },
    fault: async point => {
      if (point === 'beforeContextCommit') throw new Error('context write failure');
    }
  }), /context write failure/);
  assert.equal(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'), before);
  j = await openJob(root);
  assert.equal(j.manifest.context.spec.revision, 1);
  await j.close();
});
test('simultaneous run calls reserve the job before awaiting ownership', async t => {
  const root = await temp(t),
    j = await openJob(root);
  let unblock;
  const first = j.run([{
    id: 'slow',
    run: async () => new Promise(resolve => {
      unblock = resolve;
    })
  }]);
  const second = j.run([]);
  await assert.rejects(second, {
    code: 'JOB_BUSY'
  });
  while (!unblock) await new Promise(resolve => setImmediate(resolve));
  unblock();
  await first;
  await assert.rejects(j.run(null), {
    code: 'INVALID_DAG'
  });
  await j.run([]);
  await j.close();
});
test('caller mutations cannot change an opened checkpoint context', async t => {
  const root = await temp(t),
    spec = {
      revision: 1
    },
    tools = {
      version: 1
    };
  const j = await openJob(root, {
    spec,
    tools
  });
  spec.revision = 2;
  tools.version = 2;
  assert.equal(j.manifest.context.spec.revision, 1);
  assert.equal(j.manifest.context.tools.version, 1);
  await j.run([]);
  await j.close();
  assert.equal((await require('../lib/jobs').inspectJob(root)).context.spec.revision, 1);
});
test('validation cannot silently alter the bytes selected for publication',async t=>{
  const root=await temp(t),j=await openJob(root);
  await assert.rejects(j.run([{id:'a',run:async({stagingDir})=>fs.writeFile(path.join(stagingDir,'a'),'before'),validate:async({stagingDir})=>{await fs.writeFile(path.join(stagingDir,'a'),'after');return true;}}]),{code:'VALIDATION_MUTATED_OUTPUT'});
  assert.deepEqual(j.manifest.stages,{});await j.close();
});

test('checked opens reject absent, wrong and stale contexts before source capture and release ownership', async t => {
  const root = await temp(t);
  let captures = 0;
  const captureInputs = async () => { captures++; return {source: 'new'}; };
  const missing = {expectedJobId: 'missing-job', expectedContextHash: '0'.repeat(64), captureInputs};
  await assert.rejects(openJob(root, missing), {code: 'STALE_JOB_CONTEXT'});
  assert.equal(captures, 0);
  await assert.rejects(fs.stat(path.join(root, 'manifest.json')), {code: 'ENOENT'});
  let j = await openJob(root, {spec: {revision: 1}});
  const original = j.manifest;
  await j.close();
  const before = await fs.readFile(path.join(root, 'manifest.json'), 'utf8');
  for (const expected of [
    {expectedJobId: 'wrong-job', expectedContextHash: original.contextHash},
    {expectedJobId: original.jobId, expectedContextHash: '0'.repeat(64)}
  ]) {
    await assert.rejects(openJob(root, {...expected, spec: {revision: 2}, captureInputs}), {code: 'STALE_JOB_CONTEXT'});
    assert.equal(captures, 0);
    assert.equal(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'), before);
    await assert.rejects(fs.stat(path.join(root, 'job.lock')), {code: 'ENOENT'});
  }
  j = await openJob(root, {spec: {revision: 2}});
  await j.close();
  await assert.rejects(openJob(root, {expectedJobId: original.jobId, expectedContextHash: original.contextHash, captureInputs}), {code: 'STALE_JOB_CONTEXT'});
  assert.equal(captures, 0);
  j = await openJob(root);
  const current = j.manifest;
  await j.close();
  j = await openJob(root, {expectedJobId: current.jobId, expectedContextHash: current.contextHash, spec: {revision: 3}, captureInputs});
  assert.equal(captures, 1);
  assert.equal(j.manifest.jobId, current.jobId);
  assert.equal(j.manifest.context.spec.revision, 3);
  assert.deepEqual(j.manifest.context.inputs, {source: 'new'});
  assert.equal(Object.hasOwn(j.manifest.context, 'expectedJobId'), false);
  await j.close();
});

test('checked open preconditions are paired bounded trusted options', async t => {
  const root = await temp(t);
  for (const options of [
    {expectedJobId: 'job'}, {expectedContextHash: 'a'.repeat(64)},
    {expectedJobId: '', expectedContextHash: 'a'.repeat(64)},
    {expectedJobId: 'a'.repeat(129), expectedContextHash: 'a'.repeat(64)},
    {expectedJobId: {}, expectedContextHash: 'a'.repeat(64)},
    {expectedJobId: 'job', expectedContextHash: 'bad'},
    {expectedJobId: 'job', expectedContextHash: 12}
  ]) await assert.rejects(openJob(root, options), {code: 'INVALID_INPUT'});
  await assert.rejects(fs.stat(path.join(root, 'job.lock')), {code: 'ENOENT'});
  const j = await openJob(root, {spec: {expectedJobId: 'not-authority', expectedContextHash: 'bad'}});
  await j.close();
});

test('failed source capture never creates an empty manifest or replaces a valid one', async t => {
  const root = await temp(t);
  const captureInputs = async () => { throw new Error('capture failed'); };
  await assert.rejects(openJob(root, {captureInputs}), /capture failed/);
  await assert.rejects(fs.stat(path.join(root, 'manifest.json')), {code: 'ENOENT'});
  let j = await openJob(root, {spec: {revision: 1}});
  const expected = {expectedJobId: j.manifest.jobId, expectedContextHash: j.manifest.contextHash};
  await j.close();
  const before = await fs.readFile(path.join(root, 'manifest.json'), 'utf8');
  await assert.rejects(openJob(root, {...expected, spec: {revision: 2}, captureInputs}), /capture failed/);
  assert.equal(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'), before);
  j = await openJob(root);
  await j.close();
});
