'use strict';

// Explicit native integration check; automatic node:test discovery must not launch Godot.
async function main() {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const assert = require('node:assert/strict');
  const { buildCharacter, resumeCharacter } = require('../../lib/engine');
  const root = path.resolve(__dirname, '../..');
  const config = require('../../config/local.tools.json');
  const fixture = path.join(root, 'evidence/w2-godot/native/godot');
  const spec = JSON.parse(await fs.readFile(path.join(fixture, 'spec.json'), 'utf8'));
  spec.parts[0].image = { path: path.join(fixture, 'texture-strip.png') };
  const outputIndex = process.argv.indexOf('--evidence');
  const outputRelative = outputIndex < 0 ? 'evidence/artwork-approval' : process.argv[outputIndex + 1];
  if (!outputRelative || path.isAbsolute(outputRelative) || outputRelative.split(/[\\/]/).includes('..')) throw new Error('Use an evidence directory within the pipeline workspace.');
  const { resolveContained } = require('../../lib/assets');
  const evidenceRoot = await resolveContained(root, outputRelative, { mustExist: false });
  await fs.mkdir(evidenceRoot, { recursive: true });
  const jobRoot = path.join(evidenceRoot, 'native-job');
  let result = await buildCharacter(spec, { config, jobRoot, render: true });
  if (result.status === 'awaiting_artwork_approval') {
    // This explicit harness approves only its synthetic test texture, never user artwork.
    const { approveArtwork } = require('../../lib/artwork-review');
    await approveArtwork(jobRoot, { config, reviewId: result.reviewId });
    result = await resumeCharacter(jobRoot, { config });
  }
  assert.equal(result.valid, true);
  assert.equal(result.rendered, true);
  assert.equal(result.frames.length, 8);
  assert.equal(result.validation.bone_count, 2);
  const repeated = await resumeCharacter(jobRoot, { config });
  assert.equal(repeated.valid, true);
  for (const [id, record] of Object.entries(result.manifest.stages)) {
    assert.equal(repeated.manifest.stages[id].directory, record.directory, `Cached ${id} was rebuilt`);
  }
  const receipt = { valid: true, project: result.project, frames: result.frames, cachedResume: true };
  await fs.writeFile(path.join(evidenceRoot, 'native-result.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv.includes('--run')) main().catch(error => { console.error(error); process.exitCode = 1; });
