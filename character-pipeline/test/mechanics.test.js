'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {inspectMechanics} = require('../lib/mechanics');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mechanics-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  await fs.writeFile(path.join(root,'Power.cs'),'class VenomPower {\n int Amount;\n}\n');
  return {root,input:{characterId:'robot',sourceRoots:[root],mechanics:[{key:'mod:VenomPower',modId:'mod',modelSymbol:'VenomPower',evidence:[{path:path.join(root,'Power.cs'),symbol:'VenomPower',lineStart:1,lineEnd:2}]}]}};
}
test('inspection binds explicit declarations to bounded hashed source evidence', async t => {
  const {input}=await fixture(t); const a=await inspectMechanics(input);
  assert.equal(a.complete,true); assert.equal(a.evidence[0].excerpt,'class VenomPower {\n int Amount;');
  assert.equal(a.mechanics[0].evidenceIds[0],a.evidence[0].id);
  assert.match(a.sourceFiles[0].hash,/^[a-f0-9]{64}$/);
  assert.deepEqual(await inspectMechanics(input),a);
});
test('fingerprints include membership, bytes and semantic inventory',async t=>{
  const {root,input}=await fixture(t);const a=await inspectMechanics(input);
  await fs.writeFile(path.join(root,'new.json'),'{}'); const b=await inspectMechanics(input);
  assert.notEqual(a.fingerprint,b.fingerprint);
  await fs.writeFile(path.join(root,'new.json'),'{"v":1}');assert.notEqual(b.fingerprint,(await inspectMechanics(input)).fingerprint);
  const c=await inspectMechanics({...input,mechanics:[]}); assert.notEqual(c.fingerprint,b.fingerprint);
  await fs.writeFile(path.join(root,'image.png'),Buffer.from([0,1]));
  assert.equal((await inspectMechanics(input)).diagnostics[0].code,'SKIPPED_BINARY');
});
test('missing, unsupported and fabricated evidence fails closed',async t=>{
  const {root,input}=await fixture(t);
  for(const change of [{symbol:'Absent'},{lineEnd:200},{path:path.join(root,'missing.cs')},{path:path.join(root,'..','escape.cs')}]) {
    const copy=structuredClone(input);Object.assign(copy.mechanics[0].evidence[0],change);
    await assert.rejects(inspectMechanics(copy),e=>e.code==='INVALID_MECHANICS');
  }
  const duplicate=structuredClone(input);duplicate.mechanics.push(duplicate.mechanics[0]);
  await assert.rejects(inspectMechanics(duplicate),{code:'INVALID_MECHANICS'});
  await assert.rejects(inspectMechanics({...input,mechanics:[{...input.mechanics[0],evidence:[]}]}),{code:'INVALID_MECHANICS'});
});
test('limits and unsafe roots reject before publication',async t=>{
  const {root,input}=await fixture(t);
  for(const limits of [{maxFiles:0},{maxTotalBytes:1},{maxFileBytes:1},{maxExcerptBytes:1},{maxEvidence:0},{maxMechanics:0}]) await assert.rejects(inspectMechanics({...input,limits}),{code:'INVALID_MECHANICS'});
  await assert.rejects(inspectMechanics({...input,sourceRoots:[]}),{code:'INVALID_MECHANICS'});
  await assert.rejects(inspectMechanics({...input,sourceRoots:[path.join(root,'Power.cs')]}),{code:'INVALID_MECHANICS'});
  await fs.writeFile(path.join(root,'bad.txt'),Buffer.from([0xff]));
  await assert.rejects(inspectMechanics(input),{code:'INVALID_MECHANICS'});
});
