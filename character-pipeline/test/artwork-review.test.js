'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  createArtworkReview,
  approveArtwork,
  inspectArtworkReview
} = require('../lib/artwork-review');
const {
  openJob
} = require('../lib/jobs');
const {
  publishSource
} = require('../lib/assets');
const {
  createSpec
} = require('../lib/spec');
async function fixture(t) {
  const scratch = path.resolve(__dirname, '../../.tmp/artwork-review');
  await fs.mkdir(scratch, {
    recursive: true
  });
  const root = await fs.mkdtemp(path.join(scratch, 'review-'));
  t.after(() => fs.rm(root, {
    recursive: true,
    force: true
  }));
  const jobRoot = path.join(root, 'job');
  await fs.writeFile(path.join(root, 'art.png'), 'immutable art test bytes');
  const stored = await publishSource(root, 'art.png', jobRoot);
  const spec = createSpec({
    id: 'robot',
    description: 'approval fixture',
    template: 'custom'
  });
  const inputs = {
    'art.png': {
      relative: 'sources/' + stored.hash,
      hash: stored.hash,
      size: stored.size
    }
  };
  spec.parts = [{
    id: 'body',
    role: 'body',
    bone: 'root',
    layer: 0,
    pivot: [0, 0],
    image: {
      path: 'art.png'
    }
  }];
  const job = await openJob(jobRoot, {
    spec,
    inputs
  });
  const jobId = job.manifest.jobId;
  await job.close();
  const config = {
    outputRoot: root,
    tools: {
      python: {
        executable: process.execPath
      }
    }
  };
  const runTool = async (registry, name, args) => {
    const request = JSON.parse(await fs.readFile(args[1], 'utf8'));
    await fs.mkdir(request.outputDirectory, {
      recursive: true
    });
    const file = path.join(request.outputDirectory, 'original.png');
    await fs.writeFile(file, Buffer.from('89504e470d0a1a0a', 'hex'));
    return {
      exitCode: 0,
      error: null,
      stdout: JSON.stringify({
        ok: true,
        image: {
          path: file,
          width: 1,
          height: 1
        }
      })
    };
  };
  return {
    root,
    jobRoot,
    jobId,
    spec,
    inputs,
    config,
    runTool
  };
}
test('review waits for exact explicit approval and remains approved after restart', async t => {
  const f = await fixture(t);
  const first = await createArtworkReview(f);
  assert.equal((await inspectArtworkReview(f.jobRoot)).approved, false);
  assert.equal(first.approved, false);
  assert.equal(first.status, 'awaiting_artwork_approval');
  assert.equal(first.previews.length, 1);
  assert.ok((await fs.stat(first.previews[0].path)).isFile());
  await assert.rejects(approveArtwork(f.jobRoot, {
    config: f.config,
    reviewId: '0'.repeat(64)
  }), {
    code: 'STALE_REVIEW'
  });
  const approval = await approveArtwork(f.jobRoot, {
    config: f.config,
    reviewId: first.reviewId
  });
  assert.equal(approval.approved, true);
  assert.equal((await inspectArtworkReview(f.jobRoot)).approved, true);
  assert.equal((await createArtworkReview(f)).approved, true);
});

test('component originals share the explicit review and changed component style invalidates approval', async t => {
  const f = await fixture(t);
  const {artworkReviewContent} = require('../lib/artwork-review');
  await fs.writeFile(path.join(f.root, 'component.png'), 'distinct component original');
  const saved = await publishSource(f.root, 'component.png', f.jobRoot);
  f.inputs['component.png'] = {relative:'sources/'+saved.hash,hash:saved.hash,size:saved.size};
  const child = structuredClone(f.spec);
  child.id = 'armDefinition';
  child.parts[0].image.path = 'component.png';
  const componentArtwork = [{id:child.id,content:artworkReviewContent(child,f.inputs)}];
  let job = await openJob(f.jobRoot,{spec:f.spec,inputs:f.inputs,settings:{componentArtwork}});
  await job.close();
  const first = await createArtworkReview({...f,componentArtwork});
  assert.equal(first.originals.length,2);
  await approveArtwork(f.jobRoot,{config:f.config,reviewId:first.reviewId});
  assert.equal((await inspectArtworkReview(f.jobRoot)).approved,true);
  componentArtwork[0].content.style = {...child.style,description:'changed component style'};
  job = await openJob(f.jobRoot,{settings:{componentArtwork}});
  await job.close();
  assert.equal((await inspectArtworkReview(f.jobRoot)).approved,false);
  await assert.rejects(approveArtwork(f.jobRoot,{config:f.config,reviewId:first.reviewId}),{code:'STALE_REVIEW'});
});
test('style changes invalidate approval while animation changes preserve it', async t => {
  const f = await fixture(t);
  const first = await createArtworkReview(f);
  await approveArtwork(f.jobRoot, {
    config: f.config,
    reviewId: first.reviewId
  });
  f.spec.animations.push({
    id: 'idle',
    duration: 1,
    loop: true,
    tracks: [],
    events: []
  });
  assert.equal((await createArtworkReview(f)).approved, true);
  f.spec.style.shading = 'flat';
  const changed = await createArtworkReview(f);
  assert.notEqual(changed.reviewId, first.reviewId);
  assert.equal(changed.approved, false);
  f.spec.style = {};
  assert.equal((await createArtworkReview(f)).approved, false, 'Returning to older artwork still needs a fresh approval after revision');
});
test('corrupt previews, captures and concurrent approval cannot advance the job', async t => {
  const f = await fixture(t);
  const first = await createArtworkReview(f);
  await fs.writeFile(first.previews[0].path, 'tampered preview');
  await assert.rejects(approveArtwork(f.jobRoot, {
    config: f.config,
    reviewId: first.reviewId
  }), {
    code: 'CORRUPT_ARTIFACT'
  });
  const held = await openJob(f.jobRoot);
  try {
    await assert.rejects(approveArtwork(f.jobRoot, {
      config: f.config,
      reviewId: first.reviewId
    }), {
      code: 'JOB_LOCKED'
    });
  } finally {
    await held.close();
  }
  await fs.writeFile(path.join(f.jobRoot, Object.values(f.inputs)[0].relative), 'tampered original');
  await assert.rejects(createArtworkReview(f), {
    code: 'CORRUPT_ARTIFACT'
  });
  await assert.rejects(approveArtwork(path.join(f.root, '..', 'escape'), {
    config: f.config,
    reviewId: first.reviewId
  }), {
    code: 'UNSAFE_PATH'
  });
});
test('preview failures cannot create an approvable review', async t => {
  const f = await fixture(t);
  await assert.rejects(createArtworkReview({
    ...f,
    runTool: async () => ({
      exitCode: 1,
      error: null,
      stdout: '{}'
    })
  }), {
    code: 'PREVIEW_FAILED'
  });
  await assert.rejects(approveArtwork(f.jobRoot, {
    config: f.config,
    reviewId: '0'.repeat(64)
  }), {
    code: 'ENOENT'
  });
});
test('approval rejects a review superseded by current persisted artwork settings', async t => {
  const f = await fixture(t);
  const first = await createArtworkReview(f);
  const changed = structuredClone(f.spec);
  changed.style.shading = 'changed before preview could be rebuilt';
  const job = await openJob(f.jobRoot, {
    spec: changed
  });
  await job.close();
  await assert.rejects(approveArtwork(f.jobRoot, {
    config: f.config,
    reviewId: first.reviewId
  }), {
    code: 'STALE_REVIEW'
  });
});
test('preview attempts honor total owned storage and clean failed attempts', async t => {
  const f = await fixture(t);
  f.config.limits = {
    maxStorageBytes: 1
  };
  await assert.rejects(createArtworkReview(f), {
    code: 'QUOTA_EXCEEDED'
  });
  assert.deepEqual(await fs.readdir(path.join(f.jobRoot, 'review')), []);
  delete f.config.limits;
  const first = await createArtworkReview(f);
  async function size(dir) {
    let total = 0;
    for (const entry of await fs.readdir(dir, {
      withFileTypes: true
    })) {
      const file = path.join(dir, entry.name);
      total += entry.isDirectory() ? await size(file) : (await fs.stat(file)).size;
    }
    return total;
  }
  const reviewBytes = await size(path.join(f.jobRoot, 'review'));
  const sourceBytes = await size(path.join(f.jobRoot, 'sources'));
  f.config.limits = {
    maxStorageBytes: reviewBytes + sourceBytes
  };
  await assert.rejects(approveArtwork(f.jobRoot, {
    config: f.config,
    reviewId: first.reviewId
  }), {
    code: 'QUOTA_EXCEEDED'
  });
  f.spec.style.shading = 'revised';
  await assert.rejects(createArtworkReview(f), {
    code: 'QUOTA_EXCEEDED'
  });
  assert.equal(await size(path.join(f.jobRoot, 'review')), reviewBytes);
});

test('sound captures never enter original artwork previews or invalidate artwork approval', async t => {
  const f=await fixture(t);
  const capture=async(name,bytes)=>{await fs.writeFile(path.join(f.root,name),bytes);const stored=await publishSource(f.root,name,f.jobRoot);return {relative:'sources/'+stored.hash,hash:stored.hash,size:stored.size};};
  f.spec.sounds=[{id:'twang',path:'twang.wav'}];
  f.inputs['twang.wav']=await capture('twang.wav','RIFF synthetic sound capture');
  const calls=[];const preview=f.runTool;f.runTool=async(...args)=>{const req=JSON.parse(await fs.readFile(args[2][1],'utf8'));calls.push(req.input);return preview(...args);};
  const persist=async()=>{const job=await openJob(f.jobRoot,{spec:f.spec,inputs:f.inputs});await job.close();};
  await persist();
  const first=await createArtworkReview(f);
  assert.equal(calls.length,1);assert.equal(first.originals.length,1);assert.equal(first.originals[0].hash,f.inputs['art.png'].hash);
  await approveArtwork(f.jobRoot,{config:f.config,reviewId:first.reviewId});
  f.inputs['twang.wav']=await capture('twang.wav','different RIFF synthetic sound');await persist();
  assert.equal((await inspectArtworkReview(f.jobRoot)).approved,true);
  assert.equal((await createArtworkReview(f)).approved,true);assert.equal(calls.length,1);
  f.inputs['art.png']=await capture('art.png','new original art bytes');await persist();
  assert.equal((await inspectArtworkReview(f.jobRoot)).approved,false);
  assert.equal((await createArtworkReview(f)).approved,false);assert.equal(calls.length,2);
});

test('artwork selection retains source, raw masks, used references and generated concept', async t => {
  const f=await fixture(t);
  for (const name of ['layer.ora','mask.png','reference.png','unused.png','concept.png']) {
    await fs.writeFile(path.join(f.root,name),name);
    const stored=await publishSource(f.root,name,f.jobRoot);
    f.inputs[name==='concept.png'?'@concept':name]={relative:'sources/'+stored.hash,hash:stored.hash,size:stored.size};
  }
  f.spec.artwork.source='layer.ora';f.spec.artwork.referenceIds=['style'];
  f.spec.parts[0].mask={path:'mask.png'};
  f.spec.references=[{id:'style',path:'reference.png'},{id:'unused',path:'unused.png'}];
  const review=await createArtworkReview(f);
  assert.equal(review.originals.length,5);
  const hashes=review.originals.map(item=>item.hash);
  for (const key of ['art.png','layer.ora','mask.png','reference.png','@concept']) assert.ok(hashes.includes(f.inputs[key].hash),key);
  assert.ok(!hashes.includes(f.inputs['unused.png'].hash));
  f.spec.parts[0].image.prepared=true;
  const prepared=await createArtworkReview(f);
  assert.equal(prepared.originals.length,4);
  assert.ok(!prepared.originals.some(item=>item.hash===f.inputs['mask.png'].hash));
});
