'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  assertSpec
} = require('./spec');
const {
  openJob,
  inspectJob
} = require('./jobs');
const {
  hashValue,
  hashFile,
  atomicWrite,
  resolveContained,
  publishSource,
  ownedStorage
} = require('./assets');
const {
  createScheduler
} = require('./scheduler');
const {
  runTool
} = require('./process');
const ROOT = path.resolve(__dirname, '..');
const { skinPart } = require('./rig');
const {compileWithRepairs}=require('./compile-repair');
const {inspectAuthoredGeometry}=require('./authored-geometry');
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const canonical = value => JSON.stringify(value);
const error = (code, message) => Object.assign(new Error(message), {
  code
});
async function checkedJobRoot(jobRoot, config) {
  if (!config?.outputRoot || !Array.isArray(config.sourceRoots)) throw error('INVALID_INPUT', 'Configured outputRoot and sourceRoots are required.');
  const relative = path.relative(path.resolve(config.outputRoot), path.resolve(jobRoot));
  if (!relative) throw error('UNSAFE_PATH', 'Use a dedicated job subdirectory inside outputRoot.');
  return resolveContained(config.outputRoot, relative, {
    mustExist: false
  });
}
async function resolveSource(input, roots) {
  for (const root of roots) {
    const relative = path.isAbsolute(input) ? path.relative(path.resolve(root), input) : input;
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) continue;
    try {
      return {
        root,
        relative,
        absolute: await resolveContained(root, relative)
      };
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
    }
  }
  throw error('UNSAFE_PATH', `Artwork input is missing or outside source roots: ${input}`);
}
async function captureInputs(spec, jobRoot, config, captured, componentGraph, componentArtwork) {
  const copy = structuredClone(spec);
  const inputs = {};
  const countedCaptures = new Set();
  let bytes = 0;
  async function capture(input, definition = false) {
    if (Object.hasOwn(inputs, input)) return path.join(jobRoot, inputs[input].relative);
    let record;
    if (captured && Object.hasOwn(captured, input)) {
      record = captured[input];
      if (!record || typeof record.relative !== 'string' || !record.relative.startsWith('sources/') || !/^[a-f0-9]{64}$/.test(record.hash)) throw error('INVALID_MANIFEST', 'Invalid captured source record.');
      const cached = await resolveContained(jobRoot, record.relative);
      if ((await hashFile(cached)) !== record.hash || (await fs.stat(cached)).size !== record.size) throw error('CORRUPT_ARTIFACT', 'Captured source failed integrity validation.');
    } else {
      const source = await resolveSource(input, definition ? [...config.sourceRoots, config.outputRoot] : config.sourceRoots);
      const hash = await hashFile(source.absolute);
      const sourceSize = (await fs.stat(source.absolute)).size;
      if (bytes + (countedCaptures.has('sources/' + hash) ? 0 : sourceSize) > MAX_INPUT_BYTES) throw error('QUOTA_EXCEEDED', 'Combined input artwork exceeds 64 MiB.');
      const stored = await ownedStorage(jobRoot);
      const target = await resolveContained(jobRoot, 'sources/' + hash, {
        mustExist: false
      });
      const exists = await fs.stat(target).then(() => true, cause => {
        if (cause.code === 'ENOENT') return false;
        throw cause;
      });
      if (stored + (exists ? 0 : sourceSize) > (config.limits?.maxStorageBytes ?? 4 * 1024 ** 3)) throw error('QUOTA_EXCEEDED', 'Captured sources exceed job storage quota.');
      const saved = await publishSource(source.root, source.relative, jobRoot, {
        maxBytes: Math.min(MAX_INPUT_BYTES, sourceSize)
      });
      if (saved.hash !== hash || saved.size !== sourceSize) throw error('SOURCE_CHANGED', 'Artwork input changed while capturing it.');
      record = {
        relative: path.relative(jobRoot, saved.path).split(path.sep).join('/'),
        hash: saved.hash,
        size: saved.size
      };
    }
    if (!countedCaptures.has(record.relative)) bytes += record.size;
    countedCaptures.add(record.relative);
    if (!Number.isSafeInteger(bytes) || bytes > MAX_INPUT_BYTES) throw error('QUOTA_EXCEEDED', 'Combined input artwork exceeds 64 MiB.');
    inputs[input] = record;
    return path.join(jobRoot, record.relative);
  }
  for (const part of copy.parts) {
    for (const field of part.image?.prepared ? ['image', 'requiredSurfaceMask'] : ['image', 'mask', 'requiredSurfaceMask']) if (part[field]?.path) part[field].path = await capture(part[field].path);
  }
  for (const sound of copy.sounds || []) sound.path = await capture(sound.path);
  if (copy.artwork.provider === 'layered' && copy.parts.some(part => !part.image?.prepared) && copy.artwork.source) copy.artwork.source = await capture(copy.artwork.source);
  if (copy.artwork.provider === 'comfyui') {
    if (copy.artwork.source) copy.artwork.source = await capture(copy.artwork.source);
    for (const reference of copy.references.filter(item => copy.artwork.referenceIds?.includes(item.id))) reference.path = await capture(reference.path);
  }
  if (componentGraph) {
    for (const receipt of componentGraph.receipts) {
      await capture(receipt.path, receipt.kind === 'spec');
      if (inputs[receipt.path].hash !== receipt.hash || inputs[receipt.path].size !== receipt.size) throw error('SOURCE_CHANGED', 'Component source changed after inspection.');
    }
  } else if (componentArtwork?.length) {
    for (const file of Object.keys(captured || {})) if (!file.startsWith('@concept')) await capture(file);
  }
  return {
    spec: copy,
    inputs
  };
}
async function codeVersion(files) {
  const hashes = await Promise.all(files.map(async file => ({
    file,
    hash: await hashFile(path.join(ROOT, file))
  })));
  return hashValue(hashes);
}
async function capturedCheckpointFile(jobRoot,checkpoint,relative,limit,signal){
  if(signal?.aborted)throw error('ABORTED','Assembly checkpoint capture cancelled');
  const receipt=checkpoint?.artifacts?.find(a=>a.path===relative);
  if(!receipt||!Number.isSafeInteger(receipt.size)||receipt.size<0||receipt.size>limit||!/^[a-f0-9]{64}$/.test(receipt.hash))throw error('CORRUPT_ARTIFACT','Missing or oversized compiler checkpoint receipt');
  const root=await resolveContained(jobRoot,checkpoint.directory),file=await resolveContained(root,relative),handle=await fs.open(file,'r');
  try{
    const before=await handle.stat({bigint:true}),bytes=Buffer.alloc(receipt.size);if(!before.isFile()||before.size!==BigInt(receipt.size))throw error('CORRUPT_ARTIFACT','Compiler checkpoint size differs from receipt');
    let offset=0;while(offset<bytes.length){if(signal?.aborted)throw error('ABORTED','Assembly checkpoint capture cancelled');const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)throw error('CORRUPT_ARTIFACT','Truncated compiler checkpoint');offset+=read.bytesRead;}
    const after=await handle.stat({bigint:true}),current=await fs.lstat(await resolveContained(root,relative),{bigint:true});
    if([after,current].some(s=>!s.isFile()||['dev','ino','size','mtimeNs','ctimeNs'].some(k=>s[k]!==before[k]))||require('node:crypto').createHash('sha256').update(bytes).digest('hex')!==receipt.hash)throw error('CORRUPT_ARTIFACT','Compiler checkpoint changed during capture');
    return bytes;
  }finally{await handle.close();}
}
async function probeVersions(config) {
  const tools = config.tools || {};
  const graphics=await require('./graphics-prerequisites').probeGraphicsPrerequisites(config);
  if(!graphics.available)throw Object.assign(error('CAPABILITY_MISSING','Python graphics prerequisites are unavailable: '+graphics.diagnostics.map(item=>item.code+': '+item.message).join('; ')),{diagnostics:graphics.diagnostics});
  const godot = tools.megadot ? 'megadot' : 'godot';
  const result = {};
  for (const [role, name] of [['python', 'python'], ['godot', godot]]) {
    if (!tools[name]?.executable) throw error('CAPABILITY_MISSING', `${role} is not configured.`);
    const probe = await runTool(tools, name, tools[name].versionArgs || ['--version']);
    if (probe.error || probe.exitCode !== 0) throw error('CAPABILITY_MISSING', `${role} version probe failed: ${probe.error?.message || probe.stderr}`);
    result[role] = {
      executable: tools[name].executable,
      version: probe.stdout.trim()
    };
  }
  result.python.graphics={...graphics,codeHash:await codeVersion(['lib/graphics-prerequisites.js'])};
  return result;
}
async function relativeFile(root, file) {
  if (typeof file !== 'string') throw error('VALIDATION_FAILED', 'Backend did not return an artifact path.');
  const relative = path.relative(root, path.resolve(file));
  await resolveContained(root, relative);
  return relative.split(path.sep).join('/');
}
async function readPart(jobRoot, checkpoint, currentPart, capturedPart) {
  const root = await resolveContained(jobRoot, checkpoint.directory);
  const record = JSON.parse(await fs.readFile(await resolveContained(root, 'prepared-part.json'), 'utf8'));
  if (record.formatVersion !== 1 || !record.part) throw error('INVALID_MANIFEST', 'Unknown prepared-part record format.');
  // Preparation owns only the image registration. Rig metadata always comes
  // from the current revision, including a newly supplied source-coordinate mesh.
  const part = structuredClone(currentPart);
  part.image = record.part.image;
  part.image.path = await resolveContained(root, part.image.path);
  if (currentPart.requiredSurfaceMask) {
    require('./surface-coverage').validateSurfaceCoverage(record.provenance?.surfaceCoverage, {
      width: record.provenance?.source?.width, height: record.provenance?.source?.height,
      sourceSha256: await hashFile(await resolveContained(root, record.provenance?.surfaceCoverageSource)),
      maskSha256: await hashFile(capturedPart.requiredSurfaceMask.path),
      outputSha256: await hashFile(part.image.path)
    });
  } else if (record.provenance?.surfaceCoverage) throw error('INVALID_SURFACE_COVERAGE', 'Unexpected cached surface coverage receipt.');
  if (part.mesh) {
    const transform = record.provenance?.transform;
    const offset = record.provenance?.layerOffset ?? [0, 0];
    const vector = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
    if (!Number.isFinite(transform?.scale) || transform.scale <= 0 || !vector(transform.translation) || !vector(offset)) throw error('INVALID_MANIFEST', 'Cached artwork registration is missing or invalid.');
    for (const field of ['vertices', 'uv']) part.mesh[field] = part.mesh[field].map(point => point.map((value, i) => (value - offset[i]) * transform.scale + transform.translation[i]));
  }
  return part;
}
async function buildCharacter(input, options = {}) {
  const {
    config,
    signal,
    render = true
  } = options;
  if (signal?.aborted) throw error('ABORTED', 'Build cancelled before execution.');
  const spec = assertSpec(input);
  // Snapshot JSON before yielding; callbacks are reconstructed only under the job lease.
  let effectPresentation = null;
  if(options.effectPresentation!==undefined&&options.effectPresentation!==null){
    if(options.effectCapabilities||options.effectApproval)throw error('INVALID_INPUT','Effect presentation cannot be combined with caller capability or approval callbacks.');
    try{const text=JSON.stringify(options.effectPresentation);if(!text||Buffer.byteLength(text)>1024*1024)throw Error();effectPresentation=JSON.parse(text);}catch{throw error('INVALID_EFFECT_REQUEST','Effect presentation must be bounded JSON.');}
    if(options.effectTargets&&hashValue(options.effectTargets)!==hashValue(effectPresentation.targets))throw error('INVALID_INPUT','Effect presentation targets conflict with caller targets.');
    if(!options.effectPlan)throw error('INVALID_INPUT','Effect presentation requires effectPlan.');
  }
  if(options.effectPlan&&(!options.effectPlan||typeof options.effectPlan!=='object'||Array.isArray(options.effectPlan)||Object.keys(options.effectPlan).some(k=>!['planPath','inventoryPath'].includes(k))))throw error('INVALID_INPUT','effectPlan accepts only root planPath and inventoryPath references.');
  if (!['godot','sts2'].includes(spec.export.target)) throw error('CAPABILITY_MISSING', 'The requested game adapter is not registered yet.');
  if (spec.export.target==='sts2'&&spec.export.playback!=='tree') throw error('CAPABILITY_MISSING', 'STS2 graphics require explicit tree playback.');
  if (!['existing', 'layered', 'comfyui'].includes(spec.artwork.provider)) throw error('CAPABILITY_MISSING', 'The requested artwork backend is not registered yet.');
  if (!spec.parts.length || spec.parts.length > 1000) throw error('INVALID_INPUT', 'A build requires 1 to 1000 artwork parts.');
  const jobRoot = await checkedJobRoot(options.jobRoot, config);
  const tools = options.toolVersions || (await probeVersions(config));
  if ((spec.components.length || spec.assembly?.descriptors.length) && options.capturedInputs && !options.refreshSources && !options.componentArtwork?.length) throw error('INVALID_MANIFEST', 'Captured component artwork inventory is missing; rebuild the review from the original component sources.');
  const componentGraph = (spec.components.length || spec.assembly?.descriptors.length) && (!options.capturedInputs || options.refreshSources) ? await require('./component-build').inspectComponentGraph(spec,{sourceRoots:config.sourceRoots,definitionRoots:[...config.sourceRoots,config.outputRoot]}) : null;
  const settings = {render, componentArtwork: options.componentArtwork || [], componentGraph: componentGraph ? {version:1,parentId:componentGraph.parentId,nodes:componentGraph.nodes.map(({id,path,spec,dependencies})=>({id,path,spec,dependencies}))} : options.componentGraph || null};
  const versions = options.versions || {
    assemblyPreview: await codeVersion(['lib/assembly-preview.js','lib/assembly-preview-planning.js','lib/audio-eligibility.js','lib/native-audio-resources.js','godot/inspect_audio_resources.gd','lib/export.js','lib/windows-tool-lock.ps1','lib/runtime-manifest.js','godot/preview_assembly.gd','adapters/godot.js','lib/assets.js','lib/render-layout.js','lib/components.js','lib/state.js','lib/spec.js','lib/rig.js','schema/character.schema.json','library/rigs/humanoid.json','library/rigs/mechanical.json','library/rigs/quadruped_or_multilimb.json','lib/visual-inspection.js','lib/motion-preview.js','lib/process.js','lib/native-launch.js','workers/visual.py','workers/motion.py','workers/images.py']),
    motion: await codeVersion(['lib/motion-preview.js','workers/motion.py','workers/visual.py','workers/images.py','lib/motion-sampling.js']),
    visual: await codeVersion(['lib/mask-inspection.js','workers/masks.py','lib/visual-inspection.js','workers/visual.py','workers/images.py','lib/validation.js','godot/telemetry.gd']),
    artwork: await codeVersion(['lib/artwork.js', 'lib/surface-coverage.js', 'lib/image-tools.js', 'providers/existing.js', 'providers/layered.js', 'providers/generated.js', 'workers/images.py', 'workers/background.py', 'workers/repaint.py']),
    backgroundModel: ((spec.artwork.settings?.backgroundRemoval ?? spec.artwork.provider === 'comfyui') || settings.componentGraph?.nodes.some(node=>node.spec.artwork.settings?.backgroundRemoval ?? node.spec.artwork.provider==='comfyui')) && config.background?.modelPath ? await hashFile(config.background.modelPath) : null,
    generation: (spec.artwork.provider === 'comfyui' || settings.componentGraph?.nodes.some(node=>node.spec.artwork.provider==='comfyui')) ? await codeVersion(['providers/comfyui.js', 'providers/generated.js', 'lib/concepts.js']) : null,
    godot: await codeVersion(['lib/overlap-planning.js','lib/native-skinning.js','lib/motion-registration.js','lib/authored-geometry.js','lib/compile-repair.js','lib/repair.js','lib/repair-operators.js','lib/visual-inspection.js','lib/effect-animation.js','lib/motion-sampling.js','lib/render-layout.js','lib/validation.js','godot/telemetry.gd','backends/godot.js', 'godot/compile.gd', 'godot/limited_bone.gd', 'godot/animation_controller.gd', 'godot/pose_controller.gd', 'godot/audio_controller.gd', 'godot/action_controller.gd', 'godot/visual_state_controller.gd', 'godot/assembly_controller.gd', 'godot/component_controller.gd', 'godot/assembly_planner.gd', 'godot/state_reconciler.gd', 'godot/assembly_transport.gd', 'godot/effect_scene_controller.gd', 'godot/effect_rule_controller.gd', 'godot/effect_controller.gd', 'godot/impact_controller.gd', 'godot/texture_storage.gd', 'lib/components.js', 'lib/state.js', 'lib/rig.js', 'lib/audio.js', 'lib/audio-format.js', 'workers/audio.py'])
  };
  await fs.mkdir(jobRoot, {
    recursive: true
  });
  let captured, capturedEffects, capturedAnimationInventory, effectCapabilities;
  if(options.animationInventory!==undefined&&options.animationInventory!==null&&(!options.animationInventory||typeof options.animationInventory!=='object'||Array.isArray(options.animationInventory)||Object.keys(options.animationInventory).sort().join(',')!=='inventoryPath,planPath'||['planPath','inventoryPath'].some(key=>typeof options.animationInventory[key]!=='string'||!options.animationInventory[key])))throw error('INVALID_INPUT','animationInventory requires only paired planPath and inventoryPath references.');
  settings.animationInventory=options.animationInventory?structuredClone(options.animationInventory):null;
  settings.effectPlan = options.effectPlan ? structuredClone(options.effectPlan) : null;
  settings.effectPresentation = effectPresentation;
  settings.effectCapturePolicy = effectPresentation ? await codeVersion(['lib/effect-request.js','lib/effect-build.js','lib/effect-animation.js']) : null;
  settings.effectTargets = options.effectTargets ? structuredClone(options.effectTargets) : null;
  const artworkConfig = {
    ...config,
    sourceRoots: [...config.sourceRoots, path.join(jobRoot, 'sources')]
  };
  const prepare = options.prepareArtwork || require('./artwork').prepareArtwork;
  const compile = options.compileGodot || require('../backends/godot').compileGodot;
  const leaseDirectory = await resolveContained(config.outputRoot, '.leases', {
    mustExist: false
  });
  await fs.mkdir(leaseDirectory, {
    recursive: true
  });
  const scheduler = options.scheduler || createScheduler({
    gpuLeaseDirectory: leaseDirectory
  });
  const job = await openJob(jobRoot, {
    expectedJobId: options.expectedJobId,
    expectedContextHash: options.expectedContextHash,
    spec,
    backend: 'godot',
    tools,
    versions,
    captureInputs: async () => {
      if (options.persistModification !== undefined) {
        if (typeof options.persistModification !== 'function') throw error('INVALID_INPUT', 'persistModification must be a trusted function.');
        await options.persistModification();
      }
      captured = await captureInputs(spec, jobRoot, config, options.refreshSources ? undefined : options.capturedInputs, componentGraph, settings.componentArtwork);
      if (componentGraph) settings.componentArtwork = componentGraph.nodes.filter(node => node.path).map(node => ({id:node.id,content:require('./artwork-review').artworkReviewContent(node.spec,captured.inputs)}));
      if (spec.artwork.provider === 'comfyui') {
        if (!options.refreshSources && options.capturedInputs?.['@concept']) {
          const record = structuredClone(options.capturedInputs['@concept']);
          if (!/^[a-f0-9]{64}$/.test(record.hash) || record.relative !== 'sources/' + record.hash) throw error('INVALID_MANIFEST', 'Invalid original concept record.');
          const file = await resolveContained(jobRoot, record.relative);
          if ((await fs.stat(file)).size !== record.size || (await hashFile(file)) !== record.hash) throw error('CORRUPT_ARTIFACT', 'Original concept was corrupted.');
          captured.concept = {
            path: file,
            record
          };
        } else {
          const materialize = options.materializeConcept || require('./concepts').materializeConcept;
          captured.concept = await materialize(spec, {
            jobRoot,
            config,
            inputs: captured.inputs,
            version: versions.generation ?? null,
            signal,
            scheduler,
            createComfyProvider: options.createComfyProvider
          });
        }
        captured.inputs['@concept'] = captured.concept.record;
      }
      if (settings.componentGraph) {
        const nodes = await require('./component-build').restoreComponentGraph(settings.componentGraph,captured.inputs,jobRoot);
        settings.componentArtwork = [];
        for (const node of nodes.filter(node=>node.path)) {
          let concept;
          if (node.spec.artwork.provider === 'comfyui') {
            const key='@concept:'+node.id, existing=!options.refreshSources && options.capturedInputs?.[key];
            if(existing) {
              if(!Number.isSafeInteger(existing.size)||existing.size<1||!/^[a-f0-9]{64}$/.test(existing.hash)||existing.relative!=='sources/'+existing.hash)throw error('INVALID_MANIFEST','Invalid component original concept.');
              const file=await resolveContained(jobRoot,existing.relative);
              if((await fs.stat(file)).size!==existing.size||(await hashFile(file))!==existing.hash)throw error('CORRUPT_ARTIFACT','Component original concept changed.');
              concept={path:file,record:existing};
            } else {
              concept=await (options.materializeConcept || require('./concepts').materializeConcept)(node.spec,{jobRoot,config,inputs:captured.inputs,version:versions.generation??null,signal,scheduler,createComfyProvider:options.createComfyProvider});
            }
            captured.inputs[key]=concept.record;
          }
          const reviewInputs={...captured.inputs};delete reviewInputs['@concept'];if(concept)reviewInputs['@concept']=concept.record;
          settings.componentArtwork.push({id:node.id,content:require('./artwork-review').artworkReviewContent(node.spec,reviewInputs)});
        }
      }
      if (settings.effectPlan) {
        const request={...settings.effectPlan,characterId:spec.id};
        for(const key of ['planPath','inventoryPath']){
          const previous=options.capturedInputs?.[request[key]];
          if(previous){
            if(!Number.isSafeInteger(previous.size)||previous.size<0||previous.relative!=='sources/'+previous.hash||!/^[a-f0-9]{64}$/.test(previous.hash))throw error('INVALID_MANIFEST','Invalid captured effect artifact.');
            const file=await resolveContained(jobRoot,previous.relative);
            if((await fs.stat(file)).size!==previous.size||await hashFile(file)!==previous.hash)throw error('CORRUPT_ARTIFACT','Captured effect artifact changed.');
            request[key]=file;
          }
        }
        let firstParty, preflight, capabilities=options.effectCapabilities, approval=options.effectApproval;
        const effectConfig={...config,sourceRoots:[...config.sourceRoots,config.outputRoot,path.join(jobRoot,'sources')]};
        try{
        if(effectPresentation){
          // Reuse the bounded, handle-verified capture reader before constructing authority.
          preflight=await scheduler.schedule('cpu',()=>require('./effect-build').captureEffectPlan(request,{config:effectConfig,styleHash:hashValue(spec.style),signal}),{signal});
          const artifact=kind=>JSON.parse(Buffer.from(preflight.captures.find(c=>c.kind===kind).base64,'base64').toString('utf8').replace(/^\uFEFF/,''));
          const plan=artifact('plan');
          if(plan.decisions.some(d=>d.outcome==='effect')){
          firstParty=await require('./effect-request').captureEffectRequest(effectPresentation,{config,spec,plan,inventory:artifact('inventory'),heldJobRoot:jobRoot});
          capabilities=firstParty.capabilities;approval=firstParty.approval;
          settings.effectTargets=structuredClone(firstParty.targets);
          settings.effectRequestIdentity=structuredClone(firstParty.requestIdentity);
          }
        }
        if(capabilities){
          effectCapabilities={...capabilities,effects:structuredClone(capabilities.effects||[]),bindings:structuredClone(capabilities.bindings||[]),sockets:structuredClone(capabilities.sockets||[])};
          if(options.capturedInputs&&!options.replaceEffectResources)for(const effect of effectCapabilities.effects)for(const resource of effect.resources||[]){
            const receipt=options.capturedInputs[resource.path];
            if(receipt){
              const file=await resolveContained(jobRoot,receipt.relative);
              if(receipt.relative!=='sources/'+receipt.hash||receipt.hash!==resource.sha256||!Number.isSafeInteger(receipt.size)||(await fs.stat(file)).size!==receipt.size||await hashFile(file)!==receipt.hash)throw error('CORRUPT_ARTIFACT','Captured effect resource failed integrity validation.');
              resource.path=file;
            }
          }
        }
        capturedEffects=preflight&&!firstParty?preflight:await scheduler.schedule('cpu',()=>require('./effect-build').captureEffectPlan(request,{config:effectConfig,capabilities:effectCapabilities,styleHash:hashValue(spec.style),approval,signal}),{signal});
        if(preflight&&firstParty)for(const kind of ['plan','inventory']){
          const before=preflight.captures.find(c=>c.kind===kind),after=capturedEffects.captures.find(c=>c.kind===kind);
          if(before.hash!==after.hash||before.size!==after.size)throw error('SOURCE_CHANGED','Effect declaration changed between verified capture phases.');
        }
        }finally{await firstParty?.close();}
        const records=new Map();
        for(const receipt of capturedEffects.captures){
          const relative='sources/'+receipt.hash,file=await resolveContained(jobRoot,relative,{mustExist:false});
          const exists=await fs.stat(file).then(stat=>stat,cause=>{if(cause.code==='ENOENT')return null;throw cause;});
          if(exists){if(exists.size!==receipt.size||await hashFile(file)!==receipt.hash)throw error('CORRUPT_ARTIFACT','Immutable effect source was corrupted.');}
          else {
            if((await ownedStorage(jobRoot))+receipt.size>(config.limits?.maxStorageBytes??4*1024**3))throw error('QUOTA_EXCEEDED','Effect captures exceed job storage quota.');
            await fs.mkdir(path.dirname(file),{recursive:true});await atomicWrite(file,Buffer.from(receipt.base64,'base64'));
          }
          const record={relative,hash:receipt.hash,size:receipt.size};captured.inputs[receipt.path]=record;records.set(receipt.kind,record);
        }
        for(const effect of capabilities?.effects||[])for(const resource of effect.resources||[]){
          const receipt=capturedEffects.captures.find(r=>r.kind==='resource'&&r.hash===resource.sha256);
          if(receipt)captured.inputs[resource.path]={relative:'sources/'+receipt.hash,hash:receipt.hash,size:receipt.size};
        }
        captured.inputs[settings.effectPlan.planPath]=records.get('plan');captured.inputs[settings.effectPlan.inventoryPath]=records.get('inventory');
      }
      if(settings.animationInventory){
        const request={...settings.animationInventory,characterId:spec.id};
        for(const key of ['planPath','inventoryPath']){
          const previous=options.capturedInputs?.[request[key]];
          if(previous){
            if(!Number.isSafeInteger(previous.size)||previous.size<0||previous.relative!=='sources/'+previous.hash||!/^[a-f0-9]{64}$/.test(previous.hash))throw error('INVALID_MANIFEST','Invalid captured animation inventory artifact.');
            const file=await resolveContained(jobRoot,previous.relative);
            if((await fs.stat(file)).size!==previous.size||await hashFile(file)!==previous.hash)throw error('CORRUPT_ARTIFACT','Captured animation inventory artifact changed.');
            request[key]=file;
          }
        }
        capturedAnimationInventory=await scheduler.schedule('cpu',()=>require('./animation-inventory-build').captureAnimationInventory(request,{config:{...config,sourceRoots:[...config.sourceRoots,path.join(jobRoot,'sources')]},spec,signal}),{signal});
        for(const receipt of capturedAnimationInventory.captures){
          const relative='sources/'+receipt.hash,file=await resolveContained(jobRoot,relative,{mustExist:false});
          const exists=await fs.stat(file).then(stat=>stat,cause=>{if(cause.code==='ENOENT')return null;throw cause;});
          if(exists){if(exists.size!==receipt.size||await hashFile(file)!==receipt.hash)throw error('CORRUPT_ARTIFACT','Immutable animation inventory source was corrupted.');}
          else{if((await ownedStorage(jobRoot))+receipt.size>(config.limits?.maxStorageBytes??4*1024**3))throw error('QUOTA_EXCEEDED','Animation inventory captures exceed job storage quota.');await atomicWrite(file,Buffer.from(receipt.base64,'base64'));}
          const key=receipt.kind==='plan'?'planPath':'inventoryPath';captured.inputs[settings.animationInventory[key]]={relative,hash:receipt.hash,size:receipt.size};
        }
      }
      if ((await ownedStorage(jobRoot)) > (config.limits?.maxStorageBytes ?? 4 * 1024 ** 3)) throw error('QUOTA_EXCEEDED', 'Job storage exceeds quota.');
      return captured.inputs;
    },
    settings,
    maxStorageBytes: config.limits?.maxStorageBytes ?? 4 * 1024 ** 3,
    maxStageBytes: config.limits?.maxStageBytes ?? 256 * 1024 ** 2
  });
  try {
    let effectBuild;
    if(capturedEffects?.plan?.decisions.some(d=>d.outcome==='effect')&&settings.effectTargets){
      const targets=settings.effectTargets,used=new Set(capturedEffects.plan.decisions.filter(d=>d.outcome==='effect').flatMap(d=>d.rule.effectIds));
      const parts=new Set(spec.parts.map(p=>p.id)),sockets=new Set(spec.sockets.map(s=>s.id)),seen=new Set();
      if(!targets||Array.isArray(targets)||Object.keys(targets).length>64||Object.entries(targets).some(([socket,t])=>!sockets.has(socket)||!t||Object.keys(t).length!==1||!parts.has(t.partId)||seen.has(t.partId)||!seen.add(t.partId)))throw error('INVALID_EFFECT_PLAN','Explicit effect targets require unique existing socket/part mappings.');
      if(capturedEffects.plan.decisions.some(d=>d.outcome==='effect'&&!Object.hasOwn(targets,d.rule.socketId)))throw error('INVALID_EFFECT_PLAN','Every effect rule requires an explicit target.');
      effectBuild={styleHash:hashValue(spec.style),plan:capturedEffects.plan,inventory:capturedEffects.inventory,bindings:effectCapabilities.bindings,resources:capturedEffects.resources.map(({hash,base64,size,importSettings,styleProvenance,approvalProvenance})=>({hash,base64,size,importSettings,styleProvenance,approvalProvenance})),catalog:effectCapabilities.effects.filter(e=>used.has(e.id)).map(e=>({id:e.id,capability:e.capability,resourceHashes:[...new Set(e.resources.map(r=>r.sha256))],presentation:structuredClone(e.presentation),...(e.impact?{impact:structuredClone(e.impact)}:{})})),targets};
    }
    const effectsSummary=capturedEffects ? {
      status:capturedEffects.status, fingerprint:hashValue({capture:capturedEffects.fingerprint,targets:settings.effectTargets,requestIdentity:settings.effectRequestIdentity??null,policy:settings.effectCapturePolicy}),activated:false,gameIntegrationComplete:false,
      diagnostics:[...capturedEffects.diagnostics],
      effectsIntegrationComplete:capturedEffects.status==='validated'&&capturedEffects.plan.decisions.every(d=>d.outcome==='none')
    }:null;
    if(!effectBuild&&capturedEffects?.plan?.decisions.some(d=>d.outcome==='effect'))effectsSummary.diagnostics.push({code:'EFFECT_COMPILER_UNAVAILABLE',message:'Accepted positive effect rules are captured but no explicit effectTargets mapping was supplied.'});
    const animationSummary=capturedAnimationInventory?{status:capturedAnimationInventory.status,fingerprint:capturedAnimationInventory.fingerprint,diagnostics:structuredClone(capturedAnimationInventory.diagnostics),referencedClipIds:[...capturedAnimationInventory.referencedClipIds]}:null;
    const effectResult={...(effectsSummary ? {effects:effectsSummary,effectsIntegrationComplete:effectsSummary.effectsIntegrationComplete}:{}),...(animationSummary?{animationInventory:animationSummary,animationInventoryComplete:capturedAnimationInventory.animationInventoryComplete}:{})};
    const reviewArtwork = options.reviewArtwork || require('./artwork-review').createArtworkReview;
    const review = await reviewArtwork({
      jobRoot,
      jobId: job.manifest.jobId,
      spec,
      inputs: captured.inputs,
      componentArtwork: settings.componentArtwork,
      config,
      signal
    });
    if (!review.approved) return {
      ...review,
      ...effectResult,
      jobRoot,
      id: spec.id,
      valid: false,
      rendered: false,
      manifest: job.manifest
    };
    function definitionStages(spec, captured, prefix, childNodes = []) {
    const artStages = spec.parts.map(part => {
      const id = prefix + 'art-' + hashValue(part.id).slice(0, 24);
      const paths = [part.image?.path, part.requiredSurfaceMask?.path, !part.image?.prepared ? part.mask?.path : null, !part.image?.prepared && spec.artwork.provider === 'layered' ? spec.artwork.source : null].filter(Boolean);
      return {
        id,
        contextKeys: [],
        fingerprint: {
          formatVersion: 2,
          part: {
            id: part.id,
            role: part.role,
            pivot: part.pivot,
            image: part.image ?? null,
            requiredSurfaceMask: part.requiredSurfaceMask ?? null,
            mask: part.image?.prepared ? null : part.mask ?? null
          },
          artwork: spec.artwork,
          inputs: paths.map(file => captured.inputs[file]),
          code: versions.artwork,
          concept: captured.concept?.record.hash ?? null,
          generation: spec.artwork.provider === 'comfyui' ? versions.generation ?? null : null,
          generationInputs: spec.artwork.provider === 'comfyui' ? {
            characterId: spec.id,
            style: spec.style,
            canvas: spec.canvas,
            description: spec.description,
            models: config.comfyui || {}
          } : null,
          backgroundRuntime: spec.artwork.settings?.backgroundRemoval ?? spec.artwork.provider === 'comfyui' ? config.background || {} : null,
          python: tools.python,
          backgroundModel: (spec.artwork.settings?.backgroundRemoval ?? spec.artwork.provider === 'comfyui') ? versions.backgroundModel ?? null : null
        },
        run: async ({
          stagingDir
        }) => {
          const prepared = await scheduler.schedule('cpu', () => prepare(captured.spec, {
            config: artworkConfig,
            stagingDir,
            partIds: [part.id],
            signal,
            concept: captured.concept ? {
              path: captured.concept.path,
              hash: captured.concept.record.hash,
              approved: true
            } : undefined,
            createComfyProvider: options.createComfyProvider,
            scheduler,
            checkpointForPart: async (partId, requestIdentity) => {
              const key = hashValue({
                partId,
                requestIdentity,
                spec: {
                  artwork: spec.artwork,
                  style: spec.style
                },
                concept: captured.concept?.record.hash ?? null,
                generation: spec.artwork.provider === 'comfyui' ? versions.generation ?? null : null,
                models: config.comfyui || {}
              });
              return require('./concepts').promptCheckpoint(jobRoot, 'provider/parts/' + key, config);
            }
          }), {
            signal
          });
          const output = prepared.spec.parts.find(item => item.id === part.id);
          if (!output?.image?.prepared) throw error('VALIDATION_FAILED', 'Artwork preparation did not produce a prepared part.');
          const checked = assertSpec({
            ...spec,
            parts: spec.parts.map(item => item.id === part.id ? output : item)
          }).parts.find(item => item.id === part.id);
          checked.image.path = await relativeFile(stagingDir, checked.image.path);
          const details = prepared.parts.find(item => item.id === part.id);
          const record = {
            formatVersion: 1,
            part: checked,
            provenance: {
              surfaceCoverage: details?.surfaceCoverage,
              surfaceCoverageSource: details?.surfaceCoverage ? await relativeFile(stagingDir, details.surfaceCoverageSource) : undefined,
              source: details?.source,
              transform: details?.transform,
              layerOffset: details?.layerOffset,
              background: details?.background,
              generation: details?.generation
            }
          };
          await fs.writeFile(path.join(stagingDir, 'prepared-part.json'), JSON.stringify(record));
        }
      };
    });
    const rig = {
      id: prefix + 'rig',
      deps: [...(!prefix&&capturedEffects?['effects-plan']:[]), ...(!prefix&&capturedAnimationInventory?['animation-inventory']:[]), ...artStages.map(stage => stage.id), ...childNodes.map(node => 'component-' + hashValue(node.id).slice(0,16) + '-rig')],
      contextKeys: [],
      fingerprint: {
        spec,
        render,
        code: versions.godot,
        sounds: (spec.sounds || []).map(sound => ({id:sound.id,input:captured.inputs[sound.path]})),
        tool: tools.godot
      },
      run: async ({
        stagingDir,
        dependencies
      }) => {
        const parts = await Promise.all(artStages.map((stage, index) => readPart(jobRoot, dependencies[stage.id], spec.parts[index], captured.spec.parts[index])));
        const prepared = assertSpec({
          ...spec,
          ...(spec.sounds ? {sounds:captured.spec.sounds} : {}),
          parts: parts.map(part => part.skinning ? skinPart(part, spec.bones) : part)
        });
        const componentProjects = {};
        for (const node of childNodes) {
          const checkpoint = dependencies['component-' + hashValue(node.id).slice(0,16) + '-rig'];
          const root = await resolveContained(jobRoot, checkpoint.directory);
          const record = JSON.parse(await fs.readFile(await resolveContained(root,'rig.json'),'utf8'));
          componentProjects[node.id] = {project:await resolveContained(root,record.project),scene:await resolveContained(root,record.scene),spec:node.spec,dependencies:node.dependencies,sourceHash:captured.inputs[node.path]?.hash,checkpoint:{...checkpoint,root}};
        }
        const compileOptions = {
          config: {...config,sourceRoots:[...config.sourceRoots,path.join(jobRoot,'sources')]},
          stagingDir,
          render,
          signal,
          componentProjects,
          ...(!prefix&&effectBuild?{effectBuild}:{}),
          componentRegistry: childNodes.map(({id,path,dependencies})=>({id,path,dependencies,types:(settings.componentGraph?.nodes.find(n=>n.id===spec.id)?.dependencies||[]).filter(d=>d.specId===id).map(d=>d.type)})),
          componentDescriptors: spec.assembly?.descriptors,
          assemblyContract: spec.assembly ? {styleHash:spec.assembly.styleHash,eventNames:spec.assembly.eventNames}:undefined
        };
        // One GPU lease owns the complete bounded compile/repair sequence.
        // Authored animation edits reuse the already captured approved artwork.
        let authoredGeometry;
        const checkedCompile=async(candidate,settings)=>{
          const projection=inspectAuthoredGeometry(candidate);
          const built=await compile(candidate,settings);
          if(hashValue(candidate)!==projection.specHash)throw error('SOURCE_CHANGED','Compiler mutated its projected authored candidate');
          authoredGeometry=projection;
          return built;
        };
        const compilation=await scheduler.schedule('gpu',async()=>render?compileWithRepairs(prepared,{...compileOptions,compile:checkedCompile}):{built:await checkedCompile(prepared,compileOptions)}, {
          signal
        });
        const {built}=compilation;
        if(!authoredGeometry||compilation.repair&&authoredGeometry.specHash!==compilation.repair.repairedSpecHash)throw error('SOURCE_CHANGED','Final authored geometry receipt does not match compiled repair candidate');
        if (built.validation?.valid !== true || !Array.isArray(built.frames) || render && built.frames.length === 0) throw error('VALIDATION_FAILED', 'Native rig validation or requested rendered evidence is missing.');
        const record = {
          project: path.relative(stagingDir, built.project).split(path.sep).join('/'),
          scene: await relativeFile(stagingDir, built.scene),
          frames: [],
          validation: built.validation,
          authoredGeometry
        };
        if(built.maskPlan){
          if(built.maskPlan.specHash!==authoredGeometry.specHash||!Array.isArray(built.maskCaptures)||built.maskCaptures.length>64)throw error('VALIDATION_FAILED','Part mask evidence differs from final compiled candidate');
          record.maskPlan=built.maskPlan;
          record.maskCaptures=[];
          for(const capture of built.maskCaptures)record.maskCaptures.push({...capture,path:await relativeFile(stagingDir,capture.path)});
        }
        if(compilation.repair){
          const repair={...compilation.repair,historyPath:await relativeFile(stagingDir,compilation.repair.historyPath)};
          if(repair.specPath)repair.specPath=await relativeFile(stagingDir,repair.specPath);
          if(Buffer.byteLength(JSON.stringify(repair))>256*1024)throw error('QUOTA_EXCEEDED','Compile repair receipt exceeds publication budget');
          record.repair=repair;
        }
        await resolveContained(stagingDir, record.project);
        for (const frame of built.frames) {
          const relative = await relativeFile(stagingDir, frame);
          const handle = await fs.open(frame, 'r');
          const signature = Buffer.alloc(8);
          try {
            await handle.read(signature, 0, 8, 0);
          } finally {
            await handle.close();
          }
          if (!signature.equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw error('VALIDATION_FAILED', 'Renderer output is not a PNG.');
          record.frames.push(relative);
        }
        await fs.writeFile(path.join(stagingDir, 'rig.json'), JSON.stringify(record));
      }
    };
    return [...artStages,rig];
    }
    const allStages = [];
    if(capturedEffects)allStages.push({id:'effects-plan',contextKeys:[],fingerprint:{capture:effectsSummary.fingerprint,compilerBridge:1},run:async({stagingDir})=>{
      await fs.mkdir(path.join(stagingDir,'effects'));
      await fs.writeFile(path.join(stagingDir,'effects/plan.json'),JSON.stringify(capturedEffects.plan));
      await fs.writeFile(path.join(stagingDir,'effects/status.json'),JSON.stringify({...effectsSummary,inventory:capturedEffects.inventory,resources:capturedEffects.resources.map(({base64,...record})=>record)}));
    }});
    const nodes = settings.componentGraph ? await require('./component-build').restoreComponentGraph(settings.componentGraph,captured.inputs,jobRoot) : [];
    for (const parent of nodes) {
      if(!parent.dependencies.length)continue;
      if(!parent.spec.assembly)throw error('INVALID_COMPONENT','Component builds require an explicit assembly contract.');
      const {descriptors,styleHash,eventNames}=parent.spec.assembly;
      const descriptorTypes=new Set(descriptors.map(d=>d.type));
      if(parent.spec.sockets.filter(s=>s.types.some(type=>descriptorTypes.has(type))).length>64)throw error('INVALID_COMPONENT','Native assembly supports at most 64 component sockets.');
      if(styleHash!==hashValue(parent.spec.style))throw error('INVALID_COMPONENT','Parent style does not match assembly contract.');
      const types=new Set(parent.dependencies.map(d=>d.type));
      if(descriptors.length!==types.size||new Set(descriptors.map(d=>d.type)).size!==types.size)throw error('INVALID_COMPONENT','Assembly descriptors must cover component types exactly.');
      for(const dep of parent.dependencies){
        const child=nodes.find(n=>n.id===dep.specId),descriptor=descriptors.find(d=>d.type===dep.type);
        const names=require('./components').componentEventNames(child.spec);
        if(!descriptor||descriptor.styleHash!==hashValue(child.spec.style)||descriptor.styleHash!==styleHash||canonical(descriptor.dimensions)!==canonical([child.spec.canvas.width,child.spec.canvas.height])||canonical([...descriptor.eventNames].sort())!==canonical(names)||names.some(n=>!eventNames.includes(n)))throw error('INVALID_COMPONENT','Component definition does not match its assembly descriptor.');
        if(Object.hasOwn(descriptor,'transitions'))require('./components').assertTransitionClipCompatibility(descriptor.transitions,child.spec);
        const mount=parent.spec.components.find(c=>c.id===dep.mountId)?.transform;
        if(mount&&(canonical(mount.position)!=='[0,0]'||mount.rotation!==0||canonical(mount.scale)!=='[1,1]'))throw error('INVALID_COMPONENT','Instance transform overrides are unsupported.');
      }
    }
    for (const node of nodes.filter(node=>node.path)) {
      const childCapture = await captureInputs(node.spec,jobRoot,config,captured.inputs);
      if(node.spec.artwork.provider==='comfyui'){const record=captured.inputs['@concept:'+node.id];childCapture.concept={record,path:await resolveContained(jobRoot,record.relative)};}
      allStages.push(...definitionStages(node.spec,childCapture,'component-' + hashValue(node.id).slice(0,16) + '-',nodes.filter(n=>node.dependencies.some(d=>d.specId===n.id))));
    }
    allStages.push(...definitionStages(spec,captured,'',nodes.filter(n=>nodes.find(n=>n.id===spec.id)?.dependencies.some(d=>d.specId===n.id))));
    const previewTool=config.tools?.megadot||config.tools?.godot;
    const previewToolIdentity=previewTool?{configuration:previewTool,hash:await hashFile(previewTool.executable)}:null;
    function presentationStages(definitionSpec,prefix){
      if(!render)return [];
      const stages=[];
      const locations=[];
      function locate(id,relocation,stageId,ancestors=[]){
        if(locations.length>=256||ancestors.includes(id)||ancestors.length>4)throw error('INVALID_COMPONENT','Assembly metadata graph exceeds bounded compiler provenance');
        locations.push({id,prefix:relocation,stageId});
        const node=nodes.find(n=>n.id===id);
        for(const child of [...new Set((node?.dependencies||[]).map(d=>d.specId))])locate(child,(relocation?relocation+'/':'')+'components/'+child,'component-'+hashValue(child).slice(0,16)+'-rig',[...ancestors,id]);
      }
      if(definitionSpec.assembly?.descriptors?.length)locate(definitionSpec.id,'',prefix+'rig');
      if(locations.length)stages.push({id:prefix+'assembly-preview',deps:[...new Set(locations.map(l=>l.stageId))],contextKeys:[],fingerprint:{previewPolicy:2,code:versions.assemblyPreview??null,native:tools.godot,toolIdentity:previewToolIdentity,python:tools.python,limits:config.limits??null,locations},run:async({stagingDir,dependencies})=>{
        const sourceRoot=await resolveContained(jobRoot,dependencies[prefix+'rig'].directory),metadataByStage=new Map(),audioMetadata=[],audioReceipts=[],verifiedAudio=new Set();let metadataBytes=0,audioBytes=0,declarations=0;
        for(const location of locations){
          const checkpoint=dependencies[location.stageId];let record=metadataByStage.get(location.stageId);
          if(!record){try{const bytes=await capturedCheckpointFile(jobRoot,checkpoint,'rig.json',Math.min(4*1024*1024,16*1024*1024-metadataBytes),signal);metadataBytes+=bytes.length;record=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(e){if(e.code)throw e;throw error('CORRUPT_ARTIFACT','Malformed compiler checkpoint metadata');}metadataByStage.set(location.stageId,record);}
          if(record.validation?.valid!==true||typeof record.project!=='string'||typeof record.scene!=='string'||!record.scene.startsWith(record.project+'/'))throw error('CORRUPT_ARTIFACT','Invalid compiler checkpoint metadata');
          audioMetadata.push({id:location.id,prefix:location.prefix,validation:record.validation});
          if(record.validation.audio!==undefined&&(!Array.isArray(record.validation.audio)||record.validation.audio.length>1000))throw error('CORRUPT_ARTIFACT','Compiler audio metadata exceeds declaration budget');
          for(const declaration of record.validation.audio||[]){
            if(++declarations>4000)throw error('QUOTA_EXCEEDED','Assembly audio declaration budget exceeded');
            if(typeof declaration?.resource!=='string'||!declaration.resource.startsWith('res://'))throw error('CORRUPT_ARTIFACT','Invalid compiler audio resource');
            const local=declaration.resource.slice(6),relative=record.project+'/'+local,receipt=checkpoint.artifacts.find(a=>a.path===relative);
            if(!receipt)throw error('CORRUPT_ARTIFACT','Compiler audio artifact has no checkpoint receipt');
            const identity=location.stageId+'\0'+relative;
            if(!verifiedAudio.has(identity)){audioBytes+=(await capturedCheckpointFile(jobRoot,checkpoint,relative,Math.min(17*1024*1024,256*1024*1024-audioBytes),signal)).length;verifiedAudio.add(identity);}
            audioReceipts.push({path:(location.prefix?location.prefix+'/':'')+local,hash:receipt.hash,size:receipt.size});
          }
        }
        require('./audio-eligibility').collectAudioEligibility({metadata:audioMetadata,files:[]});
        const rig=metadataByStage.get(prefix+'rig'),projectPrefix=rig.project+'/';
        const runtimeReceipts=dependencies[prefix+'rig'].artifacts.filter(a=>a.path.startsWith(projectPrefix)).map(a=>({...a,path:a.path.slice(projectPrefix.length)}));
        const report=await (options.createAssemblyPreview||require('./assembly-preview').createAssemblyPreview)(definitionSpec,{compiledSpecHash:rig.authoredGeometry.specHash,sourceRoot,project:await resolveContained(sourceRoot,rig.project),scene:await resolveContained(sourceRoot,rig.scene),stagingDir,storageRoot:jobRoot,audioMetadata,audioReceipts,runtimeReceipts,config,signal});
        const invalid=()=>{throw error('VALIDATION_FAILED','Assembly preview report differs from captured definition or contained artifacts');};
        const plan=require('./assembly-preview-planning').planAssemblyPreview(definitionSpec,{compiledSpecHash:rig.authoredGeometry.specHash});
        if(report?.version!==1||report.scope!=='development-assembly-preview'||report.visualQuality!=='unverified'||!['completed','not-applicable'].includes(report.status)||report.specHash!==hashValue(definitionSpec)||report.compiledSpecHash!==rig.authoredGeometry.specHash||!/^[a-f0-9]{64}$/.test(report.planHash)||!Array.isArray(report.frames)||report.frames.length>64)invalid();
        if(report.status==='not-applicable'&&(report.frames.length||report.contactSheet!==null||report.motionPreview!==null||report.native!==null))invalid();
        if(report.status==='completed'&&(!report.frames.length||!report.contactSheet||!report.motionPreview||!report.native))invalid();
        if(report.planHash!==plan.planHash||report.status!==(plan.status==='not-applicable'?'not-applicable':'completed')||report.frames.length!==plan.frames.length||report.frames.some((frame,i)=>frame.index!==plan.frames[i].index||frame.time!==plan.frames[i].time||frame.configurationId!==plan.frames[i].configurationId||frame.width!==plan.renderLayout.pixels[0]||frame.height!==plan.renderLayout.pixels[1]))invalid();
        for(const artifact of [...report.frames,...(report.contactSheet?[report.contactSheet]:[]),...(report.motionPreview?[report.motionPreview]:[])]){
          try{if(typeof artifact.path!=='string'||path.isAbsolute(artifact.path)||artifact.path.includes('\\')||artifact.path.split('/').includes('..')||!/^[a-f0-9]{64}$/.test(artifact.sha256))invalid();const file=await resolveContained(stagingDir,artifact.path);if(!(await fs.stat(file)).isFile()||artifact.sha256!==await hashFile(file))invalid();}catch{invalid();}
        }
        if(report.audioInspection!==undefined&&report.audioInspection!==null){
          const inspection=report.audioInspection;
          if(!inspection||Object.keys(inspection).sort().join(',')!=='resources,retainedDirectories,version'||inspection.version!==1||!Array.isArray(inspection.resources)||inspection.resources.length>1000||!Array.isArray(inspection.retainedDirectories)||inspection.retainedDirectories.length>1000)invalid();
          for(const directory of inspection.retainedDirectories){try{if(typeof directory!=='string'||!directory||path.isAbsolute(directory)||directory.includes('\\')||directory.split('/').some(p=>!p||p==='.'||p==='..')||!(await fs.stat(await resolveContained(stagingDir,directory))).isDirectory())invalid();}catch{invalid();}}
        }
        const bytes=JSON.stringify(report);if(Buffer.byteLength(bytes)>4*1024*1024)throw error('QUOTA_EXCEEDED','Assembly preview report exceeds publication budget');
        await fs.writeFile(path.join(stagingDir,'assembly-preview.json'),bytes);
      }});
      stages.push({id:prefix+'visual-inspection',deps:[prefix+'rig'],contextKeys:[],fingerprint:{previewPolicy:1,code:versions.visual??null,tool:tools.python},run:async({stagingDir,dependencies})=>{
        const sourceRoot=await resolveContained(jobRoot,dependencies[prefix+'rig'].directory);
        const rig=JSON.parse(await fs.readFile(await resolveContained(sourceRoot,'rig.json'),'utf8'));
        if(!Array.isArray(rig.frames)||!rig.frames.length)throw error('VALIDATION_FAILED','Pixel inspection requires rendered frames');
        const inspect=options.inspectRenderedFrames||require('./visual-inspection').inspectRenderedFrames;
        const report=await inspect(rig.frames,{sourceRoot,stagingDir,config,signal});
        if(report?.version!==1||report.visualQuality!=='unverified'||report.coverage?.frameCount!==rig.frames.length||typeof report.contactSheet?.path!=='string')throw error('VALIDATION_FAILED','Pixel inspection returned invalid evidence');
        const partMasks=rig.maskPlan?await (options.inspectPartMasks||require('./mask-inspection').inspectPartMasks)(rig.maskPlan,rig.maskCaptures,{sourceRoot,stagingDir,config,signal}):{version:1,status:'unverified',scope:'rendered-parent-part-alpha',visualQuality:'unverified',reason:'native-mask-evidence-unavailable'};
        if(partMasks?.version!==1||partMasks.scope!=='rendered-parent-part-alpha'||partMasks.visualQuality!=='unverified'||!['measured','partial','unverified'].includes(partMasks.status))throw error('VALIDATION_FAILED','Part mask inspection returned invalid evidence');
        const stored={...report,partMasks,nativeGeometry:rig.validation.geometry??{status:'unverified',scope:'parent-authored-pose',componentGeometry:'uncovered'},contactSheet:{...report.contactSheet,path:await relativeFile(stagingDir,report.contactSheet.path)}};
        const bytes=JSON.stringify(stored);if(Buffer.byteLength(bytes)>4*1024*1024)throw error('QUOTA_EXCEEDED','Combined pixel/geometry inspection report exceeds publication budget');
        await fs.writeFile(path.join(stagingDir,'inspection.json'),bytes);
      }});
      stages.push({id:prefix+'motion-previews',deps:[prefix+'rig'],contextKeys:[],fingerprint:{previewPolicy:1,code:versions.motion??null,tool:tools.python},run:async({stagingDir,dependencies})=>{
        const sourceRoot=await resolveContained(jobRoot,dependencies[prefix+'rig'].directory),rig=JSON.parse(await fs.readFile(await resolveContained(sourceRoot,'rig.json'),'utf8'));
        const stored={version:1,status:'not-applicable',scope:'development-motion-preview',visualQuality:'unverified',reason:'no-authored-clips',clips:[]};
        if(definitionSpec.animations.length){
          const plan=require('./motion-sampling').planMotionSampling(definitionSpec.animations,{framesPerSecond:16,maxFramesPerClip:64,maxTotalFrames:64});
          const expected=plan.clips.flatMap(clip=>clip.times.map(time=>({clip:clip.id,time}))),samples=rig.validation.samples?.map(sample=>({clip:sample?.clip,time:sample?.time}));
          const expectedNames=expected.map((sample,index)=>'frame-'+sample.clip+'-'+index+'.png');
          if(hashValue(rig.validation.motionPlan??null)!==hashValue(plan)||hashValue(samples??null)!==hashValue(expected)||hashValue(rig.validation.frames??null)!==hashValue(expectedNames)||rig.frames.length!==expected.length||rig.frames.some((file,i)=>file!==path.posix.join(rig.project,expectedNames[i])))throw error('VALIDATION_FAILED','Motion sampling plan differs from captured rig frame order');
          stored.status='completed';delete stored.reason;stored.plan=plan;
          const create=options.createMotionPreview||require('./motion-preview').createMotionPreview;let offset=0;
          for(const clip of plan.clips){
            const frames=clip.times.map((time,i)=>({path:rig.frames[offset+i],time}));offset+=frames.length;
            const report=await create(clip.id,frames,1/plan.framesPerSecond,{sourceRoot,stagingDir,config,signal});
            const invalid=()=>{throw error('VALIDATION_FAILED','Motion preview report differs from captured clip pixels or timeline');};
            if(report?.version!==1||report.scope!=='development-motion-preview'||report.visualQuality!=='unverified'||report.clipId!==clip.id||report.encodedFrames!==frames.length||report.timingMode!=='bounded-rational'||report.maxDurationErrorSeconds!==.000001||report.finalHoldPolicy!=='explicit-seconds'||!Number.isSafeInteger(report.width)||report.width<1||!Number.isSafeInteger(report.height)||report.height<1||report.width*report.height*frames.length>16777216||!Number.isSafeInteger(report.bytes)||report.bytes<1||report.bytes>33554432||typeof report.path!=='string'||!Array.isArray(report.captures)||report.captures.length!==frames.length||!Array.isArray(report.frames)||report.frames.length!==frames.length||!Array.isArray(report.timing)||report.timing.length!==frames.length||!Array.isArray(report.durationsSeconds)||report.durationsSeconds.length!==frames.length)invalid();
            let totalError=0;
            for(let i=0;i<frames.length;i++){
              const frame=frames[i],capture=report.captures[i],record=report.frames[i],timing=report.timing[i],duration=i+1<frames.length?frames[i+1].time-frame.time:1/plan.framesPerSecond;
              if(!capture||capture.source!==frame.path||capture.time!==frame.time||capture.sha256!==await hashFile(await resolveContained(sourceRoot,frame.path))||!record||record.path!=='frame'+i+'.png'||record.time!==frame.time||record.sha256!==capture.sha256||!timing||!Number.isSafeInteger(timing.numerator)||timing.numerator<1||timing.numerator>65535||!Number.isSafeInteger(timing.denominator)||timing.denominator<1||timing.denominator>65535||!Number.isFinite(timing.requestedDurationSeconds)||timing.requestedDurationSeconds<=0||Math.abs(timing.requestedDurationSeconds-duration)>1e-12||timing.representedDurationSeconds!==timing.numerator/timing.denominator||report.durationsSeconds[i]!==timing.representedDurationSeconds||!Number.isFinite(timing.errorSeconds)||Math.abs(timing.errorSeconds)>.000001||Math.abs(timing.representedDurationSeconds-timing.requestedDurationSeconds-timing.errorSeconds)>1e-12)invalid();
              totalError+=timing.errorSeconds;
            }
            if(!Number.isFinite(report.cumulativePlaybackErrorSeconds)||Math.abs(report.cumulativePlaybackErrorSeconds-totalError)>1e-12)invalid();
            let relative;try{relative=await relativeFile(stagingDir,report.path);const stat=await fs.stat(report.path);if(!stat.isFile()||stat.size!==report.bytes||await hashFile(report.path)!==report.sha256)invalid();}catch{invalid();}
            stored.clips.push({...report,path:relative,sampling:clip});
          }
        }
        const bytes=JSON.stringify(stored);if(Buffer.byteLength(bytes)>4*1024*1024)throw error('QUOTA_EXCEEDED','Motion preview report exceeds publication budget');
        await fs.writeFile(path.join(stagingDir,'motion-previews.json'),bytes);
      }});
      return stages;
    }
    for(const node of nodes.filter(node=>node.path))allStages.push(...presentationStages(node.spec,'component-'+hashValue(node.id).slice(0,16)+'-'));
    allStages.push(...presentationStages(spec,''));
    if(capturedAnimationInventory)allStages.push({id:'animation-inventory',contextKeys:[],fingerprint:{capture:capturedAnimationInventory.fingerprint},run:async({stagingDir})=>{await fs.writeFile(path.join(stagingDir,'animation-inventory.json'),JSON.stringify({animationInventory:animationSummary,animationInventoryComplete:capturedAnimationInventory.animationInventoryComplete}));}});
    const manifest = await job.run(allStages);
    async function definitionResult(prefix){
      const rigRoot=await resolveContained(jobRoot,manifest.stages[prefix+'rig'].directory);
      const record=JSON.parse(await fs.readFile(await resolveContained(rigRoot,'rig.json'),'utf8'));
      const repair=record.repair?{...record.repair,historyPath:await resolveContained(rigRoot,record.repair.historyPath),...(record.repair.specPath?{specPath:await resolveContained(rigRoot,record.repair.specPath)}:{})}:null;
      let inspection=null,motionPreviews=null,assemblyPreview={version:1,status:render?'not-applicable':'not-requested',scope:'development-assembly-preview',visualQuality:'unverified',reason:render?'no-assembly-descriptors':'render-disabled'};
      if(render){
        const inspectionRoot=await resolveContained(jobRoot,manifest.stages[prefix+'visual-inspection'].directory);
        inspection=JSON.parse(await fs.readFile(await resolveContained(inspectionRoot,'inspection.json'),'utf8'));
        inspection.contactSheet.path=await resolveContained(inspectionRoot,inspection.contactSheet.path);
        const motionRoot=await resolveContained(jobRoot,manifest.stages[prefix+'motion-previews'].directory);
        motionPreviews=JSON.parse(await fs.readFile(await resolveContained(motionRoot,'motion-previews.json'),'utf8'));
        for(const clip of motionPreviews.clips)clip.path=await resolveContained(motionRoot,clip.path);
        if(manifest.stages[prefix+'assembly-preview']){
          const previewRoot=await resolveContained(jobRoot,manifest.stages[prefix+'assembly-preview'].directory);
          assemblyPreview=JSON.parse(await fs.readFile(await resolveContained(previewRoot,'assembly-preview.json'),'utf8'));
          for(const artifact of [...assemblyPreview.frames,...(assemblyPreview.contactSheet?[assemblyPreview.contactSheet]:[]),...(assemblyPreview.motionPreview?[assemblyPreview.motionPreview]:[])])artifact.path=await resolveContained(previewRoot,artifact.path);
          if(assemblyPreview.audioInspection)assemblyPreview.audioInspection.retainedDirectories=await Promise.all(assemblyPreview.audioInspection.retainedDirectories.map(directory=>resolveContained(previewRoot,directory)));
        }
      }
      return {valid:record.validation.valid,rendered:render&&record.frames.length>0,project:await resolveContained(rigRoot,record.project),scene:await resolveContained(rigRoot,record.scene),frames:await Promise.all(record.frames.map(file=>resolveContained(rigRoot,file))),inspection,motionPreviews,assemblyPreview,repair,authoredGeometry:record.authoredGeometry,validation:record.validation};
    }
    const rootResult=await definitionResult('');
    const components=[];
    for(const node of nodes.filter(node=>node.path))components.push({id:node.id,...await definitionResult('component-'+hashValue(node.id).slice(0,16)+'-')});
    if(effectBuild){
      const proof=rootResult.validation.effects,expectedCaps=[...new Set(effectBuild.catalog.map(e=>e.capability))].sort(),expectedHashes=[...new Set(effectBuild.catalog.flatMap(e=>e.resourceHashes))].sort();
      const impactIds=effectBuild.catalog.filter(effect=>effect.impact).map(effect=>effect.id).sort();
      const verified=proof?.configured===true&&proof.gameBindings===false&&typeof proof.owner==='string'&&proof.owner.length>0&&Array.isArray(proof.capabilities)&&canonical([...proof.capabilities].sort())===canonical(expectedCaps)&&Array.isArray(proof.resourceHashes)&&canonical([...proof.resourceHashes].sort())===canonical(expectedHashes)&&(!impactIds.length||proof.impactConfigured===true&&Array.isArray(proof.impactEffectIds)&&canonical([...proof.impactEffectIds].sort())===canonical(impactIds));
      effectsSummary.activated=verified;
      if(!verified)effectsSummary.diagnostics.push({code:'EFFECT_COMPILER_UNVERIFIED',message:'Compiler metadata did not prove the expected presentation bridge/resources were installed.'});
    }
    return {
      status: 'completed',
      complete: true,
      ...effectResult,
      jobRoot,
      id: spec.id,
      ...rootResult,
      components,
      manifest
    };
  } finally {
    await job.close();
  }
}
async function resumeCharacter(jobRoot, options = {}) {
  const root = await checkedJobRoot(jobRoot, options.config);
  const manifest = await inspectJob(root);
  return buildCharacter(manifest.context.spec, {
    ...options,
    jobRoot: root,
    capturedInputs: Object.fromEntries(Object.entries(manifest.context.inputs).filter(([input])=>![...(options.effectPlan?Object.values(options.effectPlan):[]),...(options.animationInventory?Object.values(options.animationInventory):[])].includes(input))),
    componentArtwork: manifest.context.settings.componentArtwork,
    componentGraph: manifest.context.settings.componentGraph,
    effectPlan: options.effectPlan ?? manifest.context.settings.effectPlan,
    animationInventory: options.animationInventory ?? manifest.context.settings.animationInventory,
    effectTargets: options.effectPresentation ? options.effectTargets : options.effectTargets ?? manifest.context.settings.effectTargets,
    effectPresentation: options.effectPresentation ?? manifest.context.settings.effectPresentation,
    replaceEffectResources: Boolean(options.effectPlan),
    render: options.render ?? manifest.context.settings.render
  });
}
// Revisions operate on the owned snapshot, never on mutable original source files.
async function rebuildCharacter(previousInput, updatedInput, options = {}) {
  for (const input of [previousInput, updatedInput]) {
    const stack=[[input,0]], seen=new Set();let count=0,bytes=0;
    while(stack.length){
      const [value,depth]=stack.pop();
      if(++count>100000||depth>32)throw error('QUOTA_EXCEEDED','Revision specification exceeds structural bounds.');
      if(value===null)continue;
      if(typeof value!=='object'){
        if(!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw error('INVALID_SPEC','Revision specification must be plain JSON.');
        if(typeof value==='string')bytes+=Buffer.byteLength(value);
      }else{
        if(seen.has(value)||![Object.prototype,Array.prototype,null].includes(Object.getPrototypeOf(value)))throw error('INVALID_SPEC','Revision specification must be acyclic plain JSON.');
        seen.add(value);
        for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))){
          if(!Object.hasOwn(descriptor,'value'))throw error('INVALID_SPEC','Revision specification accessors are forbidden.');
          bytes+=Buffer.byteLength(key);stack.push([descriptor.value,depth+1]);
        }
      }
      if(bytes>1024*1024)throw error('QUOTA_EXCEEDED','Revision specification exceeds its byte budget.');
    }
  }
  const previous = assertSpec(previousInput), updated = assertSpec(updatedInput);
  if (previous.id !== updated.id) throw error('STALE_JOB_CONTEXT', 'A revision cannot change the character identity.');
  const root = await checkedJobRoot(options.jobRoot, options.config);
  const manifest = await inspectJob(root);
  if (hashValue(assertSpec(manifest.context.spec)) !== hashValue(previous)) throw error('STALE_JOB_CONTEXT', 'The previous specification does not match this job.');
  const stored = manifest.context.settings;
  const inputs = structuredClone(manifest.context.inputs);
  const generationInputs = spec => {
    const workflow = spec.artwork.workflow || (spec.artwork.referenceIds?.length ? 'ipadapter' : 'generation');
    const paths = workflow === 'ipadapter' ? spec.references.filter(r=>spec.artwork.referenceIds?.includes(r.id)).map(r=>r.path) : workflow === 'inpainting' ? [spec.artwork.source,...spec.parts.filter(p=>p.mask?.path).map(p=>p.mask.path)] : [];
    return {artwork:spec.artwork,description:spec.description,style:spec.style,canvas:spec.canvas,conditioning:paths.map(file=>({path:file,hash:inputs[file]?.hash??null}))};
  };
  if (hashValue(generationInputs(previous)) !== hashValue(generationInputs(updated))) delete inputs['@concept'];
  const hasDefinitions = Boolean(updated.components.length || updated.assembly?.descriptors.length);
  const changedGraph = hashValue({components:previous.components,assembly:previous.assembly??null}) !== hashValue({components:updated.components,assembly:updated.assembly??null});
  let graph = hasDefinitions && !changedGraph ? structuredClone(stored.componentGraph) : null;
  if (graph) {
    const node = graph.nodes.find(node=>node.id===graph.parentId);
    if (!node || node.path) throw error('INVALID_MANIFEST', 'The captured root graph cannot be revised safely.');
    node.spec = structuredClone(updated);
    // Definition references were normalized by inspection; preserve their exact
    // captured dependency identity while replacing all other root metadata.
    node.spec.components.forEach((component,index)=>{component.spec=stored.componentGraph.nodes.find(n=>n.id===graph.parentId).spec.components[index].spec;});
  }
  if (options.effectPlan) for (const file of [options.effectPlan.planPath,options.effectPlan.inventoryPath]) delete inputs[file];
  if (options.animationInventory) for (const file of Object.values(options.animationInventory)) delete inputs[file];
  return buildCharacter(updated, {
    ...options, jobRoot:root,
    expectedJobId:manifest.jobId, expectedContextHash:manifest.contextHash,
    capturedInputs:inputs, refreshSources:hasDefinitions && changedGraph,
    componentArtwork:hasDefinitions&&!changedGraph ? stored.componentArtwork : [],
    componentGraph:graph,
    effectPlan:options.effectPlan??stored.effectPlan,
    animationInventory:options.animationInventory??stored.animationInventory,
    effectTargets:options.effectPresentation ? options.effectTargets : options.effectTargets??stored.effectTargets,
    effectPresentation:options.effectPresentation??stored.effectPresentation,
    replaceEffectResources:Boolean(options.effectPlan),
    render:options.render??stored.render
  });
}
module.exports = {
  buildCharacter,
  resumeCharacter,
  rebuildCharacter
};


