'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
function replaceOnce(s,a,b){assert.equal(s.split(a).length,2,'Frozen startup seam changed');return s.replace(a,b);}
function validate(report){
 assert.equal(report.preloadEnabled,true);assert.equal(report.serialWarmup,true);
 for(const k of ['invocations','warmInvocations','originalInvocations','paths','readyResources','coldResources'])assert(Number.isSafeInteger(report[k]),k);
 assert(report.invocations>=1&&report.invocations<=8);assert.equal(report.warmInvocations,1);assert.equal(report.originalInvocations,report.invocations);
 assert(report.paths>0&&report.paths<=2048);assert.equal(report.readyResources,report.paths);assert(report.coldResources>=0&&report.coldResources<=report.paths);
 assert(Array.isArray(report.warmedPaths));assert.equal(report.warmedPaths.length,report.paths);assert.equal(new Set(report.warmedPaths).size,report.paths);
 for(const p of report.warmedPaths)assert(typeof p==='string'&&p.length<=2048&&p.startsWith('res://')&&p.length>6&&!p.slice(6).split('/').some(v=>v===''||v==='.'||v==='..')&&!/[\\\u0000-\u001f]/.test(p));
 assert.equal(report.gameAcceptance,false);assert.equal(report.coldPrefetchAcceptance,false);
}if(process.argv.includes('--self-test')){const test=require('node:test');test('warmup has a real bounded cache prefix before original loading',()=>{const s=fs.readFileSync(path.join(__dirname,'PrefetchCompatibilityHarness.cs'),'utf8');assert.match(s,/ResourceLoader.Load<Resource>/);assert.match(s,/Cache.SetAsset/);assert.match(s,/Postfix/);});test('strict receipt refuses disabled preload and unproved warmup',()=>{assert.throws(()=>validate({preloadEnabled:false}));const r={preloadEnabled:true,serialWarmup:true,invocations:1,warmInvocations:1,originalInvocations:1,paths:2,warmedPaths:['res://a','res://b'],readyResources:2,coldResources:1,gameAcceptance:false,coldPrefetchAcceptance:false};validate(r);for(const k of ['invocations','originalInvocations','paths','readyResources'])assert.throws(()=>validate({...r,[k]:0}));});}
module.exports={validate};
async function main(){
 assert(!process.argv.includes('--iteration-no-preload'),'Disabled preload is forbidden');
 const fsp=require('node:fs/promises'),Module=require('node:module');
 const warm=process.argv.includes('--serial-common-warmup');
 let source=await fsp.readFile(path.join(__dirname,'modded_game_startup_native.js'),'utf8');
 source=replaceOnce(source,"'evidence/modded-game-startup'","'evidence/prefetch-compatibility'");
 const seam="const game='C:/Program Files (x86)/Steam/steamapps/common/Slay the Spire 2/data_sts2_windows_x86_64',engine='D:/StS2Modding/tools/MegaDot';";
 source=replaceOnce(source,seam,`await fs.copyFile(path.join(__dirname,'PrefetchCompatibilityHarness.cs'),path.join(runtime,'PrefetchCompatibilityHarness.cs'));
 let harness=await fs.readFile(path.join(runtime,'ModdedGameStartupHarness.cs'),'utf8');
 const install='  game=ResourceLoader.Load<PackedScene>("res://scenes/game.tscn").Instantiate<NGame>();';assert.equal(harness.split(install).length,2);
 harness=harness.replace(install,${JSON.stringify(warm?'  PrefetchCompatibilityHarness.Install();\n':'')}+install);
 const finish='  Finish(null);';assert.equal(harness.split(finish).length,2);
 harness=harness.replace(finish,${JSON.stringify(warm?'  PrefetchCompatibilityHarness.Finish();\n':'')}+finish);
 await fs.writeFile(path.join(runtime,'ModdedGameStartupHarness.cs'),harness);
 ${seam}`);
 if(warm)source=replaceOnce(source,'console.log(JSON.stringify(report));',"const prefetch=JSON.parse(await fs.readFile(path.join(runtime,'prefetch-result.json')));require(path.join(__dirname,'prefetch_compatibility_native.js')).validate(prefetch);console.log(JSON.stringify({startup:report,prefetch}));");
 source=source.replace("require.main===module&&process.argv.includes('--run')",'false');
 // Virtual filename only: _compile evaluates trusted checked source in memory; no helper file is written.
 const wrapped=new Module(path.join(__dirname,'prefetch_compatibility_runtime.js'),module);wrapped.filename=path.join(__dirname,'prefetch_compatibility_runtime.js');wrapped.paths=module.paths;
 wrapped._compile(source+'\nmodule.exports.run=main;',wrapped.filename);await wrapped.exports.run();
}
if(require.main===module&&process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
if(process.argv.includes('--self-test')){
 const test=require('node:test');
 test('receipt authenticates bounded distinct canonical paths and repeated original calls',()=>{
 const r={preloadEnabled:true,serialWarmup:true,invocations:2,warmInvocations:1,originalInvocations:2,paths:2,warmedPaths:['res://a.tres','res://b.tres'],readyResources:2,coldResources:0,gameAcceptance:false,coldPrefetchAcceptance:false};validate(r);
 for(const patch of [{paths:1},{paths:2.5},{coldResources:3},{coldResources:-1},{invocations:9,originalInvocations:9},{warmInvocations:2},{originalInvocations:1},{warmedPaths:['res://a.tres','res://a.tres']},{warmedPaths:['res://../a','res://b']},{warmedPaths:['res://a//b','res://b']},{warmedPaths:['C:/external','res://b']}])assert.throws(()=>validate({...r,...patch}));
 });
 test('CSharp warmup declares paths once and leaves repeat original calls untouched',()=>{const s=fs.readFileSync(path.join(__dirname,'PrefetchCompatibilityHarness.cs'),'utf8');assert.doesNotMatch(s,/static int[^;]*warmedPaths/);assert.match(s,/if\(invocations>1\)return;/);});
}

