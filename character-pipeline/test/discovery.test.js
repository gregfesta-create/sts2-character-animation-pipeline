'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { discover } = require('../lib/discovery.js');

function fixture() {
  const defs = {
    CheckpointLoaderSimple: [{ ckpt_name: ['DreamShaperXL.safetensors'] }, ['MODEL', 'CLIP', 'VAE']],
    EmptyLatentImage: [{ width:'INT',height:'INT',batch_size:'INT' }, ['LATENT']],
    CLIPTextEncode: [{ text:'STRING',clip:'CLIP' }, ['CONDITIONING']],
    KSampler: [{ model:'MODEL',seed:'INT',steps:'INT',cfg:'FLOAT',sampler_name:['dpmpp_sde'],scheduler:['karras'],positive:'CONDITIONING',negative:'CONDITIONING',latent_image:'LATENT',denoise:'FLOAT' }, ['LATENT']],
    VAEDecode: [{ samples:'LATENT',vae:'VAE' }, ['IMAGE']],
    SaveImage: [{ images:'IMAGE',filename_prefix:'STRING' }, []],
    LoadImage: [{ image:['existing.png'] }, ['IMAGE','MASK']],
    VAEEncode: [{ pixels:'IMAGE',vae:'VAE' }, ['LATENT']],
    SetLatentNoiseMask: [{ samples:'LATENT',mask:'MASK' }, ['LATENT']],
    IPAdapterModelLoader: [{ ipadapter_file:['ip-adapter-plus_sdxl_vit-h.safetensors'] }, ['IPADAPTER']],
    CLIPVisionLoader: [{ clip_name:['CLIP-ViT-H-14.safetensors'] }, ['CLIP_VISION']],
    IPAdapterAdvanced: [{ model:'MODEL',ipadapter:'IPADAPTER',image:'IMAGE',weight:'FLOAT',weight_type:['linear'],combine_embeds:['concat'],start_at:'FLOAT',end_at:'FLOAT',embeds_scaling:['V only'] }, ['MODEL']],
  };
  const nodes = Object.fromEntries(Object.entries(defs).map(([name,[inputs,outputs]]) => [name,{input:{required:Object.fromEntries(Object.entries(inputs).map(([key,type])=>[key,[type]]))},output:outputs}]));
  nodes.IPAdapterAdvanced.input.optional = { clip_vision:['CLIP_VISION'] };
  nodes.SaveImage.output_node = true;
  return nodes;
}
function mockFetch(nodes = fixture(), system = {system:{comfyui_version:'0.39.0'},devices:[{name:'fixture GPU',vram_total:100,vram_free:50}]}) {
  return async url => new Response(JSON.stringify(url.endsWith('/system_stats') ? system : nodes));
}
const conf = () => ({ tools:{node:{executable:process.execPath,versionArgs:['--version'],minimumVersion:'24.0.0'}},comfyui:{url:'http://127.0.0.1:8197',checkpoint:'DreamShaperXL.safetensors',modelFamily:'sdxl'},outputRoot:process.cwd(),sourceRoots:[process.cwd()] });
const goodRun = async () => ({exitCode:0,signal:null,stdout:'v24.19.0\n',stderr:'',durationMs:1,error:null});

test('discovery uses trusted registry and reports probed versions/resources and complete workflows', async () => {
  const config = conf();
  const result = await discover(config,{runTool:async(registry,name,args,options)=>{
    assert.equal(registry,config.tools); assert.equal(name,'node'); assert.deepEqual(args,['--version']); assert.equal(options.timeoutMs,30000); return goodRun();
  },fetch:mockFetch()});
  assert.equal(result.tools.node.version,'v24.19.0');
  assert.equal(result.tools.node.available,true);
  for(const value of Object.values(result.comfyui.workflows)){ assert.equal(value.compatible,true); assert.equal(value.verified,false); }
  assert.equal(result.comfyui.system.devices[0].name,'fixture GPU');
  assert.ok(result.resources.memory.totalBytes > 0); assert.ok(result.resources.disk.freeBytes > 0);
});
test('tool absence, thrown failure and incompatible version are explicit',async()=>{
  for(const runTool of [async()=>({...await goodRun(),exitCode:null,error:{code:'ENOENT',message:'missing'}}),async()=>{throw Error('bad runner');},async()=>({...await goodRun(),stdout:'v20.0.0'})]){
    const r=await discover(conf(),{runTool,fetch:mockFetch()}); assert.equal(r.tools.node.available,false); assert.ok(r.tools.node.diagnostics.length);
  }
});
test('rejects missing models, changed typed contracts, unknown required inputs and non-output savers',async()=>{
  for(const mutate of [n=>n.CheckpointLoaderSimple.input.required.ckpt_name=[[]],n=>n.KSampler.input.required.model=['WRONG'],n=>n.KSampler.input.required.new_required=['INT'],n=>n.VAEDecode.output=['WRONG'],n=>n.SaveImage.output_node=false,n=>delete n.CLIPTextEncode]) {
    const nodes=fixture(); mutate(nodes); const r=await discover(conf(),{runTool:goodRun,fetch:mockFetch(nodes)}); assert.equal(r.comfyui.workflows.generation.compatible,false);
  }
});
test('inpainting and IPAdapter failures do not disable independent generation',async()=>{
  const nodes=fixture(); delete nodes.SetLatentNoiseMask; nodes.IPAdapterModelLoader.input.required.ipadapter_file=[['sd15.bin']];
  const r=await discover(conf(),{runTool:goodRun,fetch:mockFetch(nodes)});
  assert.equal(r.comfyui.workflows.generation.compatible,true); assert.equal(r.comfyui.workflows.inpainting.compatible,false); assert.equal(r.comfyui.workflows.ipadapter.compatible,false);
});
test('IPAdapter requires declared compatible model family and matching vision encoder',async()=>{
  const c=conf(); delete c.comfyui.modelFamily;
  let r=await discover(c,{runTool:goodRun,fetch:mockFetch()}); assert.equal(r.comfyui.workflows.ipadapter.compatible,false);
  c.comfyui.modelFamily='sdxl'; c.comfyui.clipVision='missing.safetensors';
  r=await discover(c,{runTool:goodRun,fetch:mockFetch()}); assert.equal(r.comfyui.workflows.ipadapter.compatible,false);
});
test('API offline, HTTP failure, malformed JSON/schema and oversized declared/streamed bodies fail closed',async()=>{
  for(const fetch of [async()=>{throw Error('offline')},async()=>new Response('error',{status:503}),async()=>new Response('{bad'),async()=>new Response('[]'),async()=>new Response('{}',{headers:{'content-length':'999999999'}}),async()=>new Response('x'.repeat(1025))]){
    const c=conf(); c.comfyui.maxResponseBytes=1024; const r=await discover(c,{runTool:goodRun,fetch}); assert.equal(r.comfyui.available,false); assert.ok(r.comfyui.diagnostics.length);
  }
});
test('API timeout covers headers and stalled response body',async()=>{
  for(const fetch of [()=>new Promise(()=>{}),async()=>new Response(new ReadableStream({start(){}}))]){
    const c=conf(); c.comfyui.timeoutMs=10; const r=await discover(c,{runTool:goodRun,fetch}); assert.equal(r.comfyui.diagnostics[0].code,'TIMEOUT');
  }
});
test('remote endpoints require explicit authorization; redirects never followed',async()=>{
  for(const url of ['https://example.com','file:///tmp/a','http://user:pass@127.0.0.1','http://127.0.0.1/path','http://127.0.0.1?secret=yes']){
    const c=conf(); c.comfyui.url=url; let calls=0; const r=await discover(c,{runTool:goodRun,fetch:async()=>{calls++;return new Response('{}')}}); assert.equal(r.comfyui.available,false); assert.equal(calls,0);
  }
  const c=conf(); c.comfyui.url='https://example.com'; c.comfyui.allowRemote=true;
  const r=await discover(c,{runTool:goodRun,fetch:async(url,opts)=>{assert.equal(opts.redirect,'error');return mockFetch()(url)}}); assert.equal(r.comfyui.available,true);
});
test('no server configured stays unavailable and unavailable disk has explicit diagnostics',async()=>{
  const r=await discover({tools:{},outputRoot:'Z:/does-not-exist'},{runTool:goodRun}); assert.equal(r.comfyui.available,false); assert.equal(r.resources.disk.available,false);
});
test('configuration bounds and malformed tool definitions are rejected before probes',async()=>{
  for(const c of [null,{}, {tools:[]}, {...conf(),comfyui:{url:'http://localhost',timeoutMs:0}}, {...conf(),tools:{bad:{executable:'x',versionArgs:'--version'}}}]) await assert.rejects(()=>discover(c,{runTool:goodRun,fetch:mockFetch()}),/config/i);
});

test('graphics capability is separate from interpreter availability and Comfy workflows',async()=>{
 const c=conf();c.tools.python={executable:'trusted-python',versionArgs:['--version']};
 const r=await discover(c,{runTool:async(registry,name,args)=>args[0]==='-B'&&args[1]==='-c'?{exitCode:0,stdout:JSON.stringify({version:1,python:{version:'3.13.14'},pathApi:{isJunction:true},pillow:{version:null,pngRoundTrip:false,error:'ModuleNotFoundError: PIL'},numpy:{version:'2.3.3',arrayOperation:true,error:null}}),stderr:''}:name==='python'?{exitCode:0,stdout:'Python 3.13.14'}:goodRun(),fetch:mockFetch()});
 assert.equal(r.tools.python.available,true);assert.equal(r.graphics.available,false);assert.equal(r.graphics.numpy.version,'2.3.3');assert.equal(r.comfyui.workflows.generation.compatible,true);
 const nodeOnly=await discover(conf(),{runTool:goodRun,fetch:mockFetch()});assert.equal(nodeOnly.graphics.available,false);assert.equal(nodeOnly.graphics.diagnostics[0].code,'PYTHON_NOT_CONFIGURED');assert.equal(nodeOnly.tools.node.available,true);
});

