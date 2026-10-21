'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const candidates=['res://src/Core/Nodes/CommonUi/NVerticalPopup.cs','res://src/Core/Nodes/GodotExtensions/NButton.cs','res://src/Core/Nodes/Screens/MainMenu/NSubmenu.cs'];
function validate(r){assert.equal(r.scriptsWarmup,true);assert.equal(r.preloadEnabled,true);assert.equal(r.coldPrefetchAcceptance,false);assert.equal(r.gameAcceptance,false);assert.deepEqual(r.candidates,candidates);assert(Array.isArray(r.closure)&&r.closure.length>=3&&r.closure.length<=32);assert.equal(r.loadedCount,r.closure.length);assert.equal(new Set(r.closure.map(e=>e.path)).size,r.closure.length);for(const e of r.closure){assert(typeof e.path==='string'&&e.path.startsWith('res://src/')&&e.path.endsWith('.cs')&&e.path.length<=2048&&!e.path.includes('..'));assert(Array.isArray(e.dependencies)&&e.dependencies.length<=256);for(const d of e.dependencies)assert(typeof d==='string'&&d.length<=2048);}for(const c of candidates)assert(r.closure.some(e=>e.path===c));}
module.exports={validate};
if(process.argv.includes('--self-test')){const test=require('node:test');test('script warmup receipt bounds exact candidate/base closure and rejects overclaims',()=>{const r={scriptsWarmup:true,preloadEnabled:true,coldPrefetchAcceptance:false,gameAcceptance:false,candidates,loadedCount:3,closure:candidates.map(path=>({path,dependencies:[]}))};validate(r);for(const p of [{loadedCount:2},{candidates:[]},{closure:[]},{gameAcceptance:true},{preloadEnabled:false},{closure:[...r.closure,{path:'res://scenes/a.tscn',dependencies:[]}],loadedCount:4}])assert.throws(()=>validate({...r,...p}));});test('warmup is restricted to retained real CSharpScripts and public dependency inspection',()=>{const s=fs.readFileSync(path.join(__dirname,'ColdScriptWarmupHarness.cs'),'utf8');assert.match(s,/ResourceLoader.Load<CSharpScript>/);assert.match(s,/ResourceLoader.GetDependencies/);assert.match(s,/Retained.Add/);assert.doesNotMatch(s,/Load<PackedScene>|Cache.SetAsset|PreloadManager\.Enabled\s*=/);});}
function replaceOnce(s,a,b){assert.equal(s.split(a).length,2,'Frozen fixture seam changed');return s.replace(a,b);}
async function main(){
 assert(process.argv.includes('--warm-script-candidates'),'Explicit --warm-script-candidates required');
 const fsp=require('node:fs/promises'),Module=require('node:module');let source=await fsp.readFile(path.join(__dirname,'cold_prefetch_trace_native.js'),'utf8');
 source=replaceOnce(source,"'evidence/cold-prefetch-trace'","'evidence/cold-script-warmup'");
 const copy="let harness=await fs.readFile(path.join(runtime,'ModdedGameStartupHarness.cs'),'utf8');";
 source=replaceOnce(source,copy,"await fs.copyFile(path.join(__dirname,'ColdScriptWarmupHarness.cs'),path.join(runtime,'ColdScriptWarmupHarness.cs'));\n "+copy);
 source=replaceOnce(source,'ColdPrefetchTraceHarness.Install();','ColdPrefetchTraceHarness.Install();'+String.raw`\\n  ColdScriptWarmupHarness.Warm();`);
 source=replaceOnce(source,'ColdPrefetchTraceHarness.Finish();','ColdScriptWarmupHarness.Finish();'+String.raw`\\n  ColdPrefetchTraceHarness.Finish();`);
 const receipt="const trace=JSON.parse(await fs.readFile(path.join(runtime,'cold-prefetch-trace.json')));";
 source=replaceOnce(source,receipt,"const warmup=JSON.parse(await fs.readFile(path.join(runtime,'script-warmup.json')));require(path.join(__dirname,'cold_script_warmup_native.js')).validate(warmup);"+receipt);
 source=replaceOnce(source,"if(require.main===module&&process.argv.includes('--run'))",'if(false)');
 const virtual=path.join(__dirname,'cold_script_warmup_runtime.js');const wrapped=new Module(virtual,module);wrapped.filename=virtual;wrapped.paths=module.paths;wrapped._compile(source+'\nmodule.exports.run=main;',virtual);await wrapped.exports.run();
}
if(require.main===module&&process.argv.includes('--run'))main().catch(e=>{console.error(e);process.exitCode=1;});

