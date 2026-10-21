'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { runTool } = require('../lib/process');

const fixture = path.join(__dirname, 'fixtures', 'process-child.cjs');
const registry = { node: { executable: process.execPath, cwd: __dirname } };
const invoke = (mode, options, args = []) => runTool(registry, 'node', [fixture, mode, ...args], options);
test('trusted runtime selection is inherited only by the launched child',async t=>{
 const fs=require('node:fs/promises'),os=require('node:os');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pipeline-dotnet-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'host','fxr'),{recursive:true});
 await fs.mkdir(path.join(root,'shared','Microsoft.NETCore.App'),{recursive:true});
 const before={root:process.env.DOTNET_ROOT,x64:process.env.DOTNET_ROOT_X64};
 const result=await runTool({node:{executable:process.execPath,dotnetRoot:root}},'node',['-e','console.log(JSON.stringify([process.env.DOTNET_ROOT,process.env.DOTNET_ROOT_X64]))']);
 assert.equal(result.error,null);assert.deepEqual(JSON.parse(result.stdout),[root,root]);
 assert.equal(process.env.DOTNET_ROOT,before.root);assert.equal(process.env.DOTNET_ROOT_X64,before.x64);
 const denied=await runTool({node:{executable:process.execPath,env:{DOTNET_ROOT:root}}},'node',[]);
 assert.equal(denied.error.code,'INVALID_INPUT');
});

test('success preserves spaces, quotes, and shell metacharacters as literal arguments', async () => {
  const args = ['two words', '"quoted"', '$HOME', '& echo injected', '; exit 1', '`text`', ''];
  const result = await invoke('echo', undefined, args);
  assert.equal(result.error, null);
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, 'diagnostic');
  assert.deepEqual(JSON.parse(result.stdout), { args, cwd: __dirname });
  assert.ok(result.durationMs >= 0);
});

test('default args/options work without configured cwd', async () => {
  const result = await runTool({ node: { executable: process.execPath } }, 'node');
  assert.equal(result.error, null);
  assert.equal(result.stdout, '');
});

test('nonzero exits preserve diagnostics', async () => {
  const result = await invoke('fail');
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, 'intentional failure');
  assert.equal(result.error.code, 'NONZERO_EXIT');
});

test('missing executable and cwd produce structured spawn failures', async () => {
  for (const tool of [{ executable: path.join(__dirname, 'absent-executable') },
    { executable: process.execPath, cwd: path.join(__dirname, 'absent-cwd') }]) {
    const result = await runTool({ missing: tool }, 'missing');
    assert.equal(result.error.code, 'SPAWN_FAILED');
    assert.equal(result.exitCode, null);
    assert.ok(result.error.message.length);
  }
});

test('timeout kills its child and preserves partial output', async () => {
  const result = await invoke('hang', { timeoutMs: 500 });
  assert.equal(result.error.code, 'TIMEOUT');
  assert.ok(result.durationMs < 5000);
  assert.match(result.stdout, /^\d+$/);
  assert.throws(() => process.kill(Number(result.stdout), 0), { code: 'ESRCH' });
});

test('cancellation kills only its child while a separate process stays alive', async (t) => {
  const foreign = spawn(process.execPath, [fixture, 'hang'], { windowsHide: true, stdio: 'pipe' });
  t.after(() => foreign.kill('SIGKILL'));
  await once(foreign.stdout, 'data');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  t.after(() => clearTimeout(timer));
  const result = await invoke('hang', { signal: controller.signal });
  assert.equal(result.error.code, 'ABORTED');
  assert.match(result.stdout, /^\d+$/);
  assert.throws(() => process.kill(Number(result.stdout), 0), { code: 'ESRCH' });
  assert.equal(process.kill(foreign.pid, 0), true);
});

test('pre-aborted execution returns without trying to spawn', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runTool({ tool: { executable: 'definitely-missing' } }, 'tool', [], { signal: controller.signal });
  assert.equal(result.error.code, 'ABORTED');
  assert.equal(result.exitCode, null);
  assert.equal(result.stdout, '');
});

test('combined output budget terminates noisy tools with bounded UTF-8 diagnostics', async () => {
  for (const mode of ['flood', 'stderr-flood', 'unicode']) {
    const result = await invoke(mode, { maxOutputBytes: 13 });
    assert.equal(result.error.code, 'OUTPUT_LIMIT');
    assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 13);
    assert.ok(result.stdout.length + result.stderr.length > 0);
    assert.ok(!result.stdout.includes('\ufffd'));
  }
});

test('output exactly at the limit succeeds', async () => {
  const result = await invoke('exact', { maxOutputBytes: 5 });
  assert.equal(result.error, null);
  assert.equal(result.stdout, '12345');
});

test('invalid UTF-8 cannot expand returned text beyond the byte cap', async () => {
  const result = await invoke('binary', { maxOutputBytes: 13 });
  assert.equal(result.error.code, 'OUTPUT_LIMIT');
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 13);
});

test('signal exits are reported as failures', async () => {
  const result = await invoke('signal');
  assert.equal(result.error.code, 'NONZERO_EXIT');
  assert.ok(result.signal || result.exitCode !== 0);
});

test('rejects unknown and inherited tool names', async () => {
  for (const name of ['missing', 'toString', '__proto__']) {
    assert.equal((await runTool(registry, name)).error.code, 'TOOL_NOT_FOUND');
  }
});

test('invalid registry, name, args, and options never spawn', async () => {
  const invalidCalls = [
    [null, 'node'], [[], 'node'], ['registry', 'node'], [registry, ''], [registry, 3],
    [{ node: null }, 'node'], [{ node: {} }, 'node'], [{ node: { executable: '' } }, 'node'],
    [{ node: { executable: 'bad\0path' } }, 'node'],
    [{ node: { executable: 123 } }, 'node'],
    [{ node: { executable: process.execPath, cwd: 12 } }, 'node'],
    [{ node: { executable: process.execPath, cwd: '' } }, 'node'],
    [{ node: { executable: process.execPath, cwd: 'bad\0path' } }, 'node'],
    [registry, 'node', 'string'], [registry, 'node', [3]], [registry, 'node', ['bad\0arg']],
    [registry, 'node', new Array(1)],
    [registry, 'node', [], null], [registry, 'node', [], []],
    ...[0, -1, 1.5, Infinity, '5', 2147483648].map(timeoutMs => [registry, 'node', [], { timeoutMs }]),
    ...[0, -1, 1.5, Infinity, '5'].map(maxOutputBytes => [registry, 'node', [], { maxOutputBytes }]),
    [registry, 'node', [], { signal: {} }],
    [registry, 'node', [], { shell: true }],
    [registry, 'node', [], { executable: 'other-tool' }]
  ];
  for (const args of invalidCalls) {
    const result = await runTool(...args);
    assert.equal(result.error.code, 'INVALID_INPUT', JSON.stringify(args));
    assert.equal(result.exitCode, null);
    assert.equal(result.stderr, '');
  }
});
