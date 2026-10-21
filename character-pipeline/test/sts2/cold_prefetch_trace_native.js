'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
function validate(r){
 assert.equal(r.observationOnly,true);assert.equal(r.preloadEnabled,true);assert.equal(r.gameAcceptance,false);assert.equal(r.coldPrefetchAcceptance,false);
 assert(Array.isArray(r.records)&&r.records.length<=2048);assert(Number.isSafeInteger(r.overflow)&&r.overflow>=0);assert(Array.isArray(r.patches)&&r.patches.length<=4);
 for(const p of r.patches)assert(typeof p==='string'&&p.length<=2048&&/^(observed|unsupported):/.test(p));
 if(r.firstErrorContext!=null){assert(Array.isArray(r.firstErrorContext)&&r.firstErrorContext.length<=2048);validate({...r,records:r.firstErrorContext,firstErrorContext:null});}
 let last=0;for(const e of r.records){assert(Number.isSafeInteger(e.sequence)&&e.sequence>last);last=e.sequence;assert(Number.isSafeInteger(e.thread)&&e.thread>0);assert(Number.isSafeInteger(e.nesting)&&e.nesting>=0);for(const k of ['operation','path','status'])assert(typeof e[k]==='string'&&e[k].length<=2048);}
}
if(process.argv.includes('--self-test')){const test=require('node:test');test('trace receipt enforces bounded ordered observations and honest acceptance',()=>{const r={observationOnly:true,preloadEnabled:true,gameAcceptance:false,coldPrefetchAcceptance:false,records:[{sequence:1,thread:1,nesting:0,operation:'request',path:'res://a',status:'Ok'}],overflow:0,patches:[]};validate(r);for(const patch of [{records:Array(2049).fill(r.records[0])},{records:[r.records[0],r.records[0]]},{overflow:-1},{preloadEnabled:false},{gameAcceptance:true},{records:[{...r.records[0],path:'a'.repeat(2049)}]}])assert.throws(()=>validate({...r,...patch}));});test('trace observes real calls without resource loads or behavior replacement',()=>{const s=fs.readFileSync(path.join(__dirname,'ColdPrefetchTraceHarness.cs'),'utf8');assert.match(s,/OS.AddLogger/);assert.match(s,/GetOrLoadOrCreateScriptForType/);assert.doesNotMatch(s,/ResourceLoader.Load<|Cache.SetAsset|PreloadManager\.Enabled\s*=|return false/);});}
module.exports={validate};
function replaceOnce(s,a,b){assert.equal(s.split(a).length,2,'Frozen startup seam changed');return s.replace(a,b);}
async function main(){
 assert(!process.argv.includes('--iteration-no-preload')&&!process.argv.includes('--serial-common-warmup'),'Cold trace forbids preload changes');
 const fsp=require('node:fs/promises'),Module=require('node:module');
 let source=await fsp.readFile(path.join(__dirname,'modded_game_startup_native.js'),'utf8');
 source=replaceOnce(source,"'evidence/modded-game-startup'","'evidence/cold-prefetch-trace'");
 const seam="const game='C:/Program Files (x86)/Steam/steamapps/common/Slay the Spire 2/data_sts2_windows_x86_64',engine='D:/StS2Modding/tools/MegaDot';";
 source=replaceOnce(source,seam,`await fs.copyFile(path.join(__dirname,'ColdPrefetchTraceHarness.cs'),path.join(runtime,'ColdPrefetchTraceHarness.cs'));
 let harness=await fs.readFile(path.join(runtime,'ModdedGameStartupHarness.cs'),'utf8');
 const install='  game=ResourceLoader.Load<PackedScene>("res://scenes/game.tscn").Instantiate<NGame>();';assert.equal(harness.split(install).length,2);
 harness=harness.replace(install,'  ColdPrefetchTraceHarness.Install();\\n'+install);
 const finish='  if(finished)return;finished=true;';assert.equal(harness.split(finish).length,2);
 harness=harness.replace(finish,finish+'\\n  ColdPrefetchTraceHarness.Finish();');
 await fs.writeFile(path.join(runtime,'ModdedGameStartupHarness.cs'),harness);
 ${seam}`);
 source=replaceOnce(source,'const result=await runTool({native:',"if(process.argv.includes('--build-only'))return;const result=await runTool({native:");
 source=replaceOnce(source,'const diagnostics=startupDiagnostics(result.stdout+result.stderr);',"const trace=JSON.parse(await fs.readFile(path.join(runtime,'cold-prefetch-trace.json')));require(path.join(__dirname,'cold_prefetch_trace_native.js')).validate(trace);const diagnostics=startupDiagnostics(result.stdout+result.stderr);");
 source=replaceOnce(source,"require.main===module&&process.argv.includes('--run')",'false');
 // Virtual filename: checked repository source executes in memory, never as a written helper.
 const virtual=path.join(__dirname,'cold_prefetch_trace_runtime.js');const wrapped=new Module(virtual,module);wrapped.filename=virtual;wrapped.paths=module.paths;wrapped._compile(source+'\nmodule.exports.run=main;',virtual);await wrapped.exports.run();
}
if(require.main===module&&process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});

if(process.argv.includes('--self-test')){const test=require('node:test');test('first error context is independently bounded and patches report support explicitly',()=>{const base={observationOnly:true,preloadEnabled:true,gameAcceptance:false,coldPrefetchAcceptance:false,records:[],overflow:0,patches:['observed:LoadThreadedGet'],firstErrorContext:null};validate(base);assert.throws(()=>validate({...base,firstErrorContext:Array(2049).fill({})}));assert.throws(()=>validate({...base,patches:['silently ignored']}));});}

