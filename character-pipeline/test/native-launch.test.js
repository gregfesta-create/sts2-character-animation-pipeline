'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {prepareNativeTool}=require('../lib/native-launch');
const executable='D:\\tools\\MegaDot\\MegaDot_mono_win64_console.exe';
test('trusted runtime roots require absolute host and framework directories, and arbitrary environment overrides are rejected',async()=>{
 const f=fixture();f.fs.stat=async()=>({isDirectory:()=>true});
 const tool={executable:'C:\\tools\\node.exe',dotnetRoot:'D:\\runtime9'};
 assert.equal((await prepareNativeTool(tool,f)).dotnetRoot,tool.dotnetRoot);
 await assert.rejects(prepareNativeTool({...tool,dotnetRoot:'relative'},f),{code:'CAPABILITY_MISSING'});
 f.fs.stat=async()=>({isDirectory:()=>false});
 await assert.rejects(prepareNativeTool(tool,f),{code:'CAPABILITY_MISSING'});
 await assert.rejects(prepareNativeTool({executable:tool.executable,env:{DOTNET_ROOT:'anything'}},f),{code:'INVALID_INPUT'});
});
function fixture(){const calls=[];return {calls,platform:'win32',env:{CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY:'test'},fs:{access:async p=>calls.push(['access',p]),open:async(p,mode)=>{calls.push(['open',p,mode]);return {close:async()=>calls.push(['close'])};},unlink:async p=>calls.push(['unlink',p])}};}
test('native launch uses executable directory and verifies runtime before a disposable permission probe',async()=>{
 const f=fixture(),tool={executable,cwd:'C:\\wrong',versionArgs:['--version']},result=await prepareNativeTool(tool,f);
 assert.equal(result.cwd,'D:\\tools\\MegaDot');assert.equal(tool.cwd,'C:\\wrong');assert.equal(f.calls[0][0],'access');assert.match(f.calls[0][1],/GodotSharp\\Api\\Debug\\GodotSharp.dll$/);assert.equal(f.calls[1][2],'wx');assert.equal(f.calls[2][0],'close');assert.equal(f.calls[3][0],'unlink');assert.equal(f.calls[1][1],f.calls[3][1]);
});
test('restricted permission fails before engine launch and never deletes a file it did not create',async()=>{
 const f=fixture();f.fs.open=async()=>{throw Object.assign(Error('denied'),{code:'EPERM'});};
 await assert.rejects(prepareNativeTool({executable},f),e=>e.code==='NATIVE_LAUNCH_BLOCKED'&&/authorized/.test(e.message));assert(!f.calls.some(c=>c[0]==='unlink'));
});
test('missing runtime and cleanup errors fail closed with actionable diagnostics',async()=>{
 const f=fixture();f.fs.access=async()=>{throw Error('absent');};await assert.rejects(prepareNativeTool({executable},f),{code:'CAPABILITY_MISSING'});
 const g=fixture();g.fs.unlink=async()=>{throw Error('locked');};await assert.rejects(prepareNativeTool({executable},g),{code:'NATIVE_LAUNCH_BLOCKED'});
});
test('ordinary callers and other tools do not require writable installations',async()=>{
 const f=fixture();delete f.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY;assert.equal((await prepareNativeTool({executable},f)).cwd,'D:\\tools\\MegaDot');assert.equal(f.calls.length,1);
 const other={executable:'C:\\tools\\python.exe',cwd:'C:\\project'};assert.equal(await prepareNativeTool(other,fixture()),other);
 const linux=fixture();linux.platform='linux';const portable={executable:'/tools/godot'};assert.equal(await prepareNativeTool(portable,linux),portable);
});
