'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {probeGraphicsPrerequisites,GRAPHICS_PROBE_IMPLEMENTATION_HASH}=require('../lib/graphics-prerequisites');
const config={tools:{python:{executable:'trusted-python',versionArgs:['--version']}}};
const report=()=>({version:1,python:{version:'3.13.14'},pathApi:{isJunction:true},pillow:{version:'11.3.0',pngRoundTrip:true,error:null},numpy:{version:'2.3.3',arrayOperation:true,error:null}});
const runner=value=>async()=>({exitCode:0,signal:null,stdout:JSON.stringify(value),stderr:'',error:null});
test('fixed graphics probe uses registered interpreter, bounded execution and observed capabilities',async()=>{
 const r=await probeGraphicsPrerequisites(config,{runTool:async(registry,name,args,options)=>{
 assert.equal(registry,config.tools);assert.equal(name,'python');assert.deepEqual(args.slice(0,2),['-B','-c']);assert.equal(args.length,3);assert.match(args[2],/BytesIO/);assert.match(args[2],/is_junction/);assert.equal(options.timeoutMs,30000);assert.equal(options.maxOutputBytes,32768);return runner(report())();
 }});assert.equal(r.available,true);assert.deepEqual(r.diagnostics,[]);assert.equal(r.pillow.version,'11.3.0');assert.equal(r.implementationHash,GRAPHICS_PROBE_IMPLEMENTATION_HASH);assert.match(r.implementationHash,/^[a-f0-9]{64}$/);
});
test('missing interpreter is explicit and does not launch',async()=>{const r=await probeGraphicsPrerequisites({tools:{}},{runTool:()=>{throw Error('must not run')}});assert.equal(r.available,false);assert.equal(r.python.version,null);assert.equal(r.diagnostics[0].code,'PYTHON_NOT_CONFIGURED');});
test('individual graphics failures retain observed partial versions and actionable diagnostics',async()=>{
 for(const [section,key,code] of [['pathApi','isJunction','PATH_API_MISSING'],['pillow','pngRoundTrip','PILLOW_UNAVAILABLE'],['numpy','arrayOperation','NUMPY_UNAVAILABLE']]){
 const value=report();value[section][key]=false;if(section!=='pathApi'){value[section].version=null;value[section].error='Module unavailable';}
 const r=await probeGraphicsPrerequisites(config,{runTool:runner(value)});assert.equal(r.available,false);assert.ok(r.diagnostics.some(d=>d.code===code));assert.equal(r.python.version,'3.13.14');
 }
 const wrong=report();wrong.pillow.pngRoundTrip=false;const r=await probeGraphicsPrerequisites(config,{runTool:runner(wrong)});assert.equal(r.available,false);assert.equal(r.pillow.version,'11.3.0');
});
test('malformed, inconsistent, oversized and unbounded reports cannot pass',async()=>{
 const cases=['{bad','[]','x'.repeat(32769)];
 for(const mutate of [r=>r.version=2,r=>r.python.version='bad',r=>r.numpy.version='x'.repeat(129),r=>r.numpy.version=null,r=>r.pillow.error='error despite success',r=>r.extra=true,r=>r.pathApi.isJunction=1,r=>r.pillow.error='x'.repeat(513)]){const r=report();mutate(r);cases.push(JSON.stringify(r));}
 for(const stdout of cases){const r=await probeGraphicsPrerequisites(config,{runTool:async()=>({exitCode:0,stdout,stderr:'',error:null})});assert.equal(r.available,false);assert.ok(r.diagnostics.length);}
});
test('process nonzero, signal, timeout, exceptions and stderr output budget fail closed',async()=>{
 for(const runTool of [async()=>({exitCode:1,stdout:JSON.stringify(report())}),async()=>({exitCode:0,signal:'SIGKILL',stdout:JSON.stringify(report())}),async()=>({exitCode:null,error:{code:'TIMEOUT',message:'timed out'}}),async()=>{throw Error('runner failed')},async()=>({exitCode:0,stdout:JSON.stringify(report()),stderr:'x'.repeat(32769)}),async()=>null]){
 const r=await probeGraphicsPrerequisites(config,{runTool});assert.equal(r.available,false);assert.ok(r.diagnostics.length);
 }
});

