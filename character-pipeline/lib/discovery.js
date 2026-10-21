'use strict';
const os = require('node:os');
const fs = require('node:fs/promises');
const {probeGraphicsPrerequisites}=require('./graphics-prerequisites');

// These contracts describe the inspected templates, not arbitrary installed nodes.
const CONTRACTS = {
  CheckpointLoaderSimple: [{ckpt_name:'CHOICE'}, ['MODEL','CLIP','VAE']],
  EmptyLatentImage: [{width:'INT',height:'INT',batch_size:'INT'}, ['LATENT']],
  CLIPTextEncode: [{text:'STRING',clip:'CLIP'}, ['CONDITIONING']],
  KSampler: [{model:'MODEL',seed:'INT',steps:'INT',cfg:'FLOAT',sampler_name:['dpmpp_sde'],scheduler:['karras'],positive:'CONDITIONING',negative:'CONDITIONING',latent_image:'LATENT',denoise:'FLOAT'}, ['LATENT']],
  VAEDecode: [{samples:'LATENT',vae:'VAE'}, ['IMAGE']],
  SaveImage: [{images:'IMAGE',filename_prefix:'STRING'}, []],
  LoadImage: [{image:'CHOICE'}, ['IMAGE','MASK']],
  VAEEncode: [{pixels:'IMAGE',vae:'VAE'}, ['LATENT']],
  SetLatentNoiseMask: [{samples:'LATENT',mask:'MASK'}, ['LATENT']],
  IPAdapterModelLoader: [{ipadapter_file:'CHOICE'}, ['IPADAPTER']],
  CLIPVisionLoader: [{clip_name:'CHOICE'}, ['CLIP_VISION']],
  IPAdapterAdvanced: [{model:'MODEL',ipadapter:'IPADAPTER',image:'IMAGE',weight:'FLOAT',weight_type:['linear'],combine_embeds:['concat'],start_at:'FLOAT',end_at:'FLOAT',embeds_scaling:['V only'],clip_vision:'CLIP_VISION'}, ['MODEL']],
};
const GENERATION = ['CheckpointLoaderSimple','EmptyLatentImage','CLIPTextEncode','KSampler','VAEDecode','SaveImage'];
const diagnostic = (code,message) => ({code,message});
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateConfig(config) {
  if (!isObject(config) || !isObject(config.tools)) throw new TypeError('Invalid config: tools registry required');
  for (const tool of Object.values(config.tools)) {
    if (!isObject(tool) || typeof tool.executable !== 'string' || !tool.executable || !Array.isArray(tool.versionArgs) || tool.versionArgs.some(v=>typeof v !== 'string')) throw new TypeError('Invalid config: executable/versionArgs');
    if (tool.minimumVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(tool.minimumVersion)) throw new TypeError('Invalid config: minimumVersion');
  }
  for (const [key,ceiling] of [['timeoutMs',300000],['maxResponseBytes',64*1024*1024]]) {
    const value = config.comfyui?.[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > ceiling)) throw new TypeError(`Invalid config: ${key}`);
  }
}

function versionAtLeast(text, minimum) {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  const needed = minimum.split('.').map(Number);
  for (let i=0;i<3;i++) {
    if (actual[i] !== needed[i]) return actual[i] > needed[i];
  }
  return true;
}

async function probeTools(config, runTool) {
  const entries = await Promise.all(Object.entries(config.tools).map(async ([name,tool]) => {
    let probe;
    try { probe = await runTool(config.tools,name,tool.versionArgs,{timeoutMs:30000,maxOutputBytes:8*1024*1024}); }
    catch (error) { probe = {exitCode:null,error:diagnostic('TOOL_ERROR',error.message)}; }
    const diagnostics = [];
    if (probe.error || probe.exitCode !== 0) diagnostics.push(probe.error || diagnostic('TOOL_EXIT',`Tool exited ${probe.exitCode}`));
    const version = (probe.stdout || probe.stderr || '').trim();
    if (!diagnostics.length && !version) diagnostics.push(diagnostic('VERSION_EMPTY','Tool returned no version output'));
    if (!diagnostics.length && tool.minimumVersion && !versionAtLeast(version,tool.minimumVersion)) diagnostics.push(diagnostic('VERSION_INCOMPATIBLE',`Requires ${tool.minimumVersion}, observed ${version}`));
    return [name,{available:diagnostics.length===0,executable:tool.executable,version,diagnostics,probe}];
  }));
  return Object.fromEntries(entries);
}

function endpoint(options) {
  const url = new URL(options.url);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Object.assign(new Error('Endpoint must be an HTTP(S) origin without credentials'),{code:'ENDPOINT_INVALID'});
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) && options.allowRemote !== true) throw Object.assign(new Error('Remote ComfyUI requires allowRemote: true in trusted configuration'),{code:'REMOTE_DISABLED'});
  return url.origin;
}

async function getJson(url, options, fetchImpl) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxBytes = options.maxResponseBytes ?? 8*1024*1024;
  let timer,reader;
  const timeout = new Promise((resolve,reject)=>{
    timer = setTimeout(()=>{
      controller.abort();
      if (reader) reader.cancel().catch(()=>{});
      reject(Object.assign(new Error(`API exceeded ${timeoutMs}ms`),{code:'TIMEOUT'}));
    },timeoutMs);
  });
  const operation = async()=>{
    const response = await fetchImpl(url,{signal:controller.signal,redirect:'error'});
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`),{code:'HTTP_ERROR'});
    if (Number(response.headers.get('content-length')) > maxBytes) throw Object.assign(new Error('Declared API response exceeds byte limit'),{code:'RESPONSE_LIMIT'});
    reader = response.body.getReader();
    const chunks=[];
    let size=0;
    while(true){
      const {done,value}=await reader.read();
      if(done) break;
      size+=value.byteLength;
      if(size>maxBytes) throw Object.assign(new Error('API response exceeds byte limit'),{code:'RESPONSE_LIMIT'});
      chunks.push(Buffer.from(value));
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!isObject(parsed)) throw Object.assign(new Error('API response must be an object'),{code:'RESPONSE_INVALID'});
    return parsed;
  };
  try { return await Promise.race([operation(),timeout]); }
  finally { clearTimeout(timer); controller.abort(); if(reader) reader.cancel().catch(()=>{}); }
}

function inspectContract(nodes, names) {
  const errors=[];
  for(const name of names){
    const node=nodes[name];
    if(!isObject(node)){ errors.push(diagnostic('NODE_MISSING',name)); continue; }
    const [expected,outputs]=CONTRACTS[name];
    const required=node.input?.required || {};
    const inputs={...required,...node.input?.optional};
    for(const [key,type] of Object.entries(expected)){
      const actual=inputs[key]?.[0];
      const matches= type==='CHOICE' ? Array.isArray(actual) : Array.isArray(type) ? Array.isArray(actual)&&type.every(v=>actual.includes(v)) : actual===type;
      if(!matches) errors.push(diagnostic('INPUT_INCOMPATIBLE',`${name}.${key}`));
    }
    for(const key of Object.keys(required)) if(!(key in expected)) errors.push(diagnostic('INPUT_UNSUPPORTED',`${name}.${key} is a new required input`));
    if(!Array.isArray(node.output) || outputs.some((value,index)=>node.output[index]!==value)) errors.push(diagnostic('OUTPUT_INCOMPATIBLE',name));
    if(name==='SaveImage' && node.output_node!==true) errors.push(diagnostic('OUTPUT_INCOMPATIBLE','SaveImage is not an output node'));
  }
  return errors;
}

function choices(nodes,name,input) {
  const values=nodes[name]?.input?.required?.[input]?.[0];
  return Array.isArray(values) ? values.filter(v=>typeof v==='string') : [];
}

function workflows(nodes,options) {
  const models={checkpoints:choices(nodes,'CheckpointLoaderSimple','ckpt_name'),ipadapter:choices(nodes,'IPAdapterModelLoader','ipadapter_file'),clipVision:choices(nodes,'CLIPVisionLoader','clip_name')};
  const checkpoint=options.checkpoint || models.checkpoints[0];
  const base=inspectContract(nodes,GENERATION);
  if(!checkpoint || !models.checkpoints.includes(checkpoint)) base.push(diagnostic('MODEL_MISSING','Selected checkpoint is absent'));
  const inpainting=[...base,...inspectContract(nodes,['LoadImage','VAEEncode','SetLatentNoiseMask'])];
  const ipadapter=[...base,...inspectContract(nodes,['LoadImage','IPAdapterModelLoader','CLIPVisionLoader','IPAdapterAdvanced'])];
  // Family is trusted configuration, because filenames cannot prove checkpoint tensor architecture.
  const ipModel=options.ipadapter || models.ipadapter.find(v=>/plus_sdxl_vit-h/i.test(v));
  const vision=options.clipVision || models.clipVision.find(v=>/vit-h-14/i.test(v));
  if(options.modelFamily!=='sdxl') ipadapter.push(diagnostic('MODEL_FAMILY_UNVERIFIED','This inspected IPAdapter template requires explicitly configured SDXL checkpoint family'));
  if(!ipModel || !models.ipadapter.includes(ipModel) || !/plus_sdxl_vit-h/i.test(ipModel)) ipadapter.push(diagnostic('MODEL_INCOMPATIBLE','SDXL plus ViT-H adapter missing or incompatible'));
  if(!vision || !models.clipVision.includes(vision) || !/vit-h-14/i.test(vision)) ipadapter.push(diagnostic('MODEL_INCOMPATIBLE','ViT-H-14 vision encoder missing or incompatible'));
  const status=(diagnostics,selected)=>({compatible:diagnostics.length===0,verified:false,diagnostics,models:selected});
  return {models,workflows:{generation:status(base,{checkpoint}),inpainting:status(inpainting,{checkpoint}),ipadapter:status(ipadapter,{checkpoint,ipadapter:ipModel,clipVision:vision})}};
}

async function probeComfy(options,fetchImpl) {
  if(!options?.url) return {available:false,diagnostics:[diagnostic('NOT_CONFIGURED','ComfyUI URL is not configured')]};
  try {
    const url=endpoint(options);
    const system=await getJson(`${url}/system_stats`,options,fetchImpl);
    if(!isObject(system.system) || !Array.isArray(system.devices)) throw Object.assign(new Error('Malformed system_stats contract'),{code:'RESPONSE_INVALID'});
    const nodes=await getJson(`${url}/object_info`,options,fetchImpl);
    return {available:true,url,diagnostics:[],system,nodes:Object.keys(nodes).sort(),...workflows(nodes,options)};
  } catch(error) { return {available:false,url:options.url,diagnostics:[diagnostic(error.code || 'API_ERROR',error.message)]}; }
}

async function resources(outputRoot) {
  let disk={available:false,diagnostics:[diagnostic('NOT_CONFIGURED','outputRoot is not configured')]};
  if(outputRoot){
    try {
      const stats=await fs.statfs(outputRoot);
      disk={available:true,path:outputRoot,totalBytes:stats.blocks*stats.bsize,freeBytes:stats.bavail*stats.bsize};
    }catch(error){disk={available:false,path:outputRoot,diagnostics:[diagnostic(error.code,error.message)]};}
  }
  return {cpu:{logicalCount:os.cpus().length},memory:{totalBytes:os.totalmem(),freeBytes:os.freemem()},disk};
}

/** Read-only discovery. Configuration is an operator-owned registry, never a character specification. */
async function discover(config, dependencies={}) {
  validateConfig(config);
  const runTool=dependencies.runTool || require('./process.js').runTool;
  const [tools,graphics,comfyui,resourceReport]=await Promise.all([probeTools(config,runTool),probeGraphicsPrerequisites(config,{runTool}),probeComfy(config.comfyui,dependencies.fetch || globalThis.fetch),resources(config.outputRoot)]);
  return {schemaVersion:1,tools,graphics,comfyui,resources:resourceReport,sourceRoots:config.sourceRoots || [],outputRoot:config.outputRoot || null};
}
module.exports={discover};

