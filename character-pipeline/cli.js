#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  discover
} = require('./lib/discovery');
const REVISION_RECOVERY = Symbol('revisionRecovery');
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const HELP = `Character production pipeline

Commands currently available:
  discover --config tools.json [--json]
  create --description TEXT --template humanoid|mechanical|quadruped_or_multilimb|custom --out spec.json [--id ID]
  component create --chassis SPEC.json --socket ID --template humanoid|mechanical|quadruped_or_multilimb|custom --description TEXT --id ID --out COMPONENT.json [--type TYPE]
  modify spec.json --patch patch.json [--job JOB_DIRECTORY]
  fit-rig SPEC.json --landmarks LANDMARKS.json --out FITTED.json
  author-clips SPEC.json --request REQUEST.json --out AUTHORED.json [--animation-inventory FILE --mechanics-inventory RECEIPT]
  build spec.json --job JOB_DIRECTORY [--no-render] [--effects PLAN.json --inventory RECEIPT.json] [--effect-presentation REQUEST.json]
  resume JOB_DIRECTORY [--no-render] [--effects PLAN.json --inventory RECEIPT.json] [--effect-presentation REQUEST.json]
  export JOB_DIRECTORY --namespace mods/YOUR_MOD [--integration REQUEST.json]
  package JOB_DIRECTORY --request REQUEST.json [--refresh]
  validate spec.json [--render --job JOB_DIRECTORY] [--json]
  approve-artwork JOB_DIRECTORY --review REVIEW_ID
  status JOB_DIRECTORY
  inspect-mechanics --request inspection.json --out receipt.json
  validate-effects plan.json --inventory receipt.json [--effect-presentation REQUEST.json --job JOB_DIRECTORY]

All commands accept --config tools.json. JSON is written to stdout.
Build and resume also accept paired --animation-inventory FILE --mechanics-inventory RECEIPT.
An AI agent authors the specification from your request; structured inputs work directly.
Build and rendered validation use configured artwork and Godot tools; export adapters follow.
`;
function invalid(message, code = 'INVALID_INPUT') {
  return Object.assign(new Error(message), {
    code
  });
}
function parse(argv) {
  if (argv.length === 1 && ['--help', 'help', '-h'].includes(argv[0])) return {
    command: 'help'
  };
  let [command, ...rest] = argv;
  if(command==='component'){
    if(rest.shift()!=='create')throw invalid('component expects the create subcommand.');
    command='component-create';
  }
  const allowed = {
    discover: [],
    create: ['description', 'template', 'out', 'id'],
    'component-create':['chassis','socket','template','description','id','out','type'],
    modify: ['patch', 'job'],
    'fit-rig': ['landmarks','out'],
    'author-clips': ['request','out','animation-inventory','mechanics-inventory'],
    validate: ['render', 'job'],
    build: ['job', 'no-render', 'effects', 'inventory', 'effect-presentation','animation-inventory','mechanics-inventory'],
    resume: ['no-render', 'effects', 'inventory', 'effect-presentation','animation-inventory','mechanics-inventory'],
    export: ['namespace','integration'],
    package: ['request','refresh'],
    'approve-artwork': ['review'],
    status: [],
    'inspect-mechanics': ['request','out'],
    'validate-effects': ['inventory','effect-presentation','job']
  };
  if (!Object.hasOwn(allowed, command)) throw invalid('Expected a supported command. Use --help.');
  const options = {},
    positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (!['config', 'json', ...allowed[command]].includes(key) || Object.hasOwn(options, key)) throw invalid(`Unknown or repeated option: ${arg}`);
    if (['json', 'render', 'no-render', 'refresh'].includes(key)) options[key] = true;else {
      if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw invalid(`Missing value for ${arg}`);
      options[key] = rest[++i];
    }
  }
  const count = ['modify', 'fit-rig', 'author-clips', 'validate', 'status', 'build', 'resume', 'export', 'package', 'approve-artwork','validate-effects'].includes(command) ? 1 : 0;
  if (positional.length !== count) throw invalid(`${command} expects ${count} positional argument(s).`);
  if (command === 'create' && (!options.description || !options.template || !options.out)) throw invalid('create requires --description, --template and --out.');
  if(command==='component-create'&&['chassis','socket','template','description','id','out'].some(key=>!options[key]))throw invalid('component create requires --chassis, --socket, --template, --description, --id and --out.');
  if (command === 'modify' && !options.patch) throw invalid('modify requires --patch.');
  if(command==='fit-rig'&&(!options.landmarks||!options.out))throw invalid('fit-rig requires --landmarks and --out.');
  if(command==='author-clips'&&(!options.request||!options.out))throw invalid('author-clips requires --request and --out.');
  if (command === 'build' && !options.job) throw invalid('build requires --job.');
  if(command==='package'&&!options.request)throw invalid('package requires --request REQUEST.json.');
  if(command==='export'&&(typeof options.namespace!=='string'||options.namespace.length>256||!/^([A-Za-z][A-Za-z0-9_-]{0,63})(\/[A-Za-z][A-Za-z0-9_-]{0,63})*$/.test(options.namespace)))throw invalid('export requires --namespace with slash-separated stable identifiers, for example mods/my_mod.');
  if(['build','resume'].includes(command)&&!!options.effects!==!!options.inventory)throw invalid('Effect artifacts require both --effects and --inventory.');
  if(['author-clips','build','resume'].includes(command)&&!!options['animation-inventory']!==!!options['mechanics-inventory'])throw invalid('Animation artifacts require both --animation-inventory and --mechanics-inventory.');
  if(command==='build'&&options['effect-presentation']&&!options.effects)throw invalid('Effect presentation requires --effects and --inventory.');
  if(command==='validate-effects'&&!!options['effect-presentation']!==!!options.job)throw invalid('Positive validation requires both --effect-presentation and --job.');
  if (command === 'approve-artwork' && !options.review) throw invalid('approve-artwork requires --review REVIEW_ID.');
  if (command === 'inspect-mechanics' && (!options.request || !options.out)) throw invalid('inspect-mechanics requires --request and --out.');
  if (command === 'validate-effects' && !options.inventory) throw invalid('validate-effects requires --inventory.');
  return {
    command,
    options,
    positional
  };
}
async function readJson(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw invalid('JSON input exceeds the size limit or is not a regular file.');
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}
async function readInput(file, config) {
  const {
    resolveContained
  } = require('./lib/assets');
  for (const root of [...(config.sourceRoots || []),config.outputRoot].filter(Boolean)) {
    try {
      const resolved = await resolveContained(root, path.relative(path.resolve(root), path.resolve(file)), {
        mustExist: true
      });
      return await readJson(resolved);
    } catch (error) {
      if (!['PATH_ESCAPE', 'OUTSIDE_ROOT', 'UNSAFE_PATH'].includes(error.code)) throw error;
    }
  }
  throw invalid('Input is outside configured source roots.', 'PATH_ESCAPE');
}
async function outputPath(file, config) {
  const {
    resolveContained
  } = require('./lib/assets');
  if (!config.outputRoot) throw invalid('A configured outputRoot is required.');
  return resolveContained(config.outputRoot, path.relative(path.resolve(config.outputRoot), path.resolve(file)), {
    mustExist: false
  });
}
async function refuseExisting(file) {
  try {
    await fs.access(file);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw invalid(`Output already exists: ${file}`, 'OUTPUT_EXISTS');
}
async function execute(parsed) {
  const {
    command,
    options,
    positional
  } = parsed;
  const config = await readJson(path.resolve(options.config || path.join(__dirname, 'config/local.tools.json')));
  if (command === 'discover') return discover(config);
  if(command==='component-create'){
    const chassis=await readInput(options.chassis,config),target=await outputPath(options.out,config);
    await refuseExisting(target);
    const outputRoot=await fs.realpath(config.outputRoot),specPath=path.relative(outputRoot,target).split(path.sep).join('/');
    const authored=require('./lib/component-authoring').createComponent({chassis,socketId:options.socket,template:options.template,description:options.description,id:options.id,specPath,...(options.type?{type:options.type}:{})});
    const {resolveContained}=require('./lib/assets');
    // Component definitions resolve source roots before the owned output root.
    // A relative descriptor must resolve to this new file, never an older source.
    for(const root of config.sourceRoots||[]){
      try{
        const candidate=await resolveContained(root,specPath,{mustExist:true});
        if(candidate!==target)throw invalid('Component definition path is shadowed by a configured source root; choose another owned output path.');
      }catch(error){if(error.code!=='ENOENT')throw error;}
    }
    await fs.mkdir(path.dirname(target),{recursive:true});
    await outputPath(target,config);
    try{await fs.writeFile(target,JSON.stringify(authored.specification,null,2)+'\n',{flag:'wx'});}catch(error){if(error.code==='EEXIST')throw invalid(`Output already exists: ${target}`,'OUTPUT_EXISTS');throw error;}
    return {...authored,specification:target};
  }
  if (['inspect-mechanics','validate-effects'].includes(command)) {
    if (!Array.isArray(config.mechanics?.sourceRoots) || !config.mechanics.sourceRoots.length) throw invalid('Configure mechanics.sourceRoots for actual mechanic evidence.','CAPABILITY_MISSING');
    const {inspectMechanics}=require('./lib/mechanics');
    if (command === 'inspect-mechanics') {
      const declaration=await readInput(options.request,config);
      if(!declaration || typeof declaration!=='object' || Array.isArray(declaration) || Object.keys(declaration).some(key=>!['characterId','mechanics','limits'].includes(key))) throw invalid('Invalid mechanics declaration fields.');
      const receipt=await inspectMechanics({...declaration,sourceRoots:config.mechanics.sourceRoots});
      const target=await outputPath(options.out,config);
      for(const root of config.mechanics.sourceRoots) {
        const relative=path.relative(await fs.realpath(root),target);
        if(!path.isAbsolute(relative)&&!relative.split(/[\\/]/).includes('..'))throw invalid('Inspection receipts must be outside inspected source roots to avoid self-invalidating evidence.','UNSAFE_PATH');
      }
      if(receipt.sourceFiles.some(file=>file.path===target))throw invalid('Inspection output cannot overwrite inspected source.','OUTPUT_EXISTS');
      try {
        const previous=await readJson(target);
        if(previous?.version!==1||previous.characterId!==receipt.characterId||previous.complete!==true||!Array.isArray(previous.mechanics)||!Array.isArray(previous.evidence)||!Array.isArray(previous.sourceFiles)||!/^[a-f0-9]{64}$/.test(previous.fingerprint))throw invalid('Inspection output belongs to another artifact.','OUTPUT_EXISTS');
      } catch(error) {if(error.code!=='ENOENT')throw error;}
      const {atomicWrite}=require('./lib/assets');
      await atomicWrite(target,JSON.stringify(receipt,null,2)+'\n');
      return {receipt:target,characterId:receipt.characterId,fingerprint:receipt.fingerprint,mechanics:receipt.mechanics.length,diagnostics:receipt.diagnostics};
    }
    if(options['effect-presentation']){
      const declaration=await readInput(options['effect-presentation'],config),jobRoot=await outputPath(options.job,config);
      const job=await require('./lib/jobs').openJob(jobRoot);let captured;
      try{
        const request={characterId:job.manifest.context.spec.id,planPath:path.resolve(positional[0]),inventoryPath:path.resolve(options.inventory)},captureOptions={config:{...config,sourceRoots:[...config.sourceRoots,config.outputRoot]},styleHash:require('./lib/assets').hashValue(job.manifest.context.spec.style)};
        const {captureEffectPlan}=require('./lib/effect-build'),preflight=await captureEffectPlan(request,captureOptions);
        const artifact=kind=>JSON.parse(Buffer.from(preflight.captures.find(c=>c.kind===kind).base64,'base64').toString('utf8').replace(/^\uFEFF/,'')),plan=artifact('plan'),inventory=artifact('inventory');
        if(!plan.decisions.some(d=>d.outcome==='effect'))return {valid:preflight.status==='validated',characterId:plan.characterId,status:preflight.status,gameIntegrationComplete:false,gameAcceptance:false,diagnostics:preflight.diagnostics};
        captured=await require('./lib/effect-request').captureEffectRequest(declaration,{config,spec:job.manifest.context.spec,plan,inventory,heldJobRoot:jobRoot});
        const result=await captureEffectPlan(request,{...captureOptions,capabilities:captured.capabilities,approval:captured.approval});
        for(const kind of ['plan','inventory']){
          const before=preflight.captures.find(c=>c.kind===kind),after=result.captures.find(c=>c.kind===kind);
          if(before.hash!==after.hash||before.size!==after.size)throw invalid('Effect declaration changed between verified capture phases.','SOURCE_CHANGED');
        }
        return {valid:result.status==='validated',characterId:plan.characterId,status:result.status,gameIntegrationComplete:false,gameAcceptance:false,diagnostics:result.diagnostics};
      }finally{try{await captured?.close();}finally{await job.close();}}
    }

    const plan=await readInput(positional[0],config);
    const inventory=await readInput(options.inventory,config);
    if(!Array.isArray(inventory?.mechanics)||!Array.isArray(inventory?.evidence)) throw invalid('Invalid inspection receipt.','INVALID_MECHANICS');
    const evidence=new Map(inventory.evidence.map(item=>[item.id,item]));
    const mechanics=inventory.mechanics.map(item=>({key:item.key,modId:item.modId,modelSymbol:item.modelSymbol,evidence:(item.evidenceIds||[]).map(id=>{
      const record=evidence.get(id);
      if(!record)throw invalid('Inspection receipt has missing evidence.','INVALID_MECHANICS');
      return {path:record.path,symbol:record.symbol,lineStart:record.lineStart,lineEnd:record.lineEnd};
    })}));
    const current=await inspectMechanics({characterId:inventory.characterId,sourceRoots:config.mechanics.sourceRoots,mechanics});
    const {assertEffectPlan}=require('./lib/effect-plan');
    const accepted=assertEffectPlan(plan,{inventory:current});
    return {valid:true,characterId:accepted.characterId,decisions:accepted.decisions.length,mechanicsFingerprint:current.fingerprint};
  }
  if (command === 'approve-artwork') {
    const {
      approveArtwork
    } = require('./lib/artwork-review');
    const job = await outputPath(positional[0], config);
    return approveArtwork(job, {
      config,
      reviewId: options.review
    });
  }
  if(command==='package'){
    const jobRoot=await outputPath(positional[0],config),request=await readInput(path.resolve(options.request),config);
    return require('./lib/mod-package').packageCharacter(jobRoot,{config,request,refresh:!!options.refresh});
  }
  if(command==='export'){
    const jobRoot=await outputPath(positional[0],config);
    const integration=options.integration===undefined?undefined:await readInput(path.resolve(options.integration),config);
    return require('./lib/delivery').exportCharacter(jobRoot,{config,namespace:options.namespace,...(integration===undefined?{}:{integration})});
  }
  if (command === 'resume') {
    const {
      resumeCharacter
    } = require('./lib/engine');
    const root = await outputPath(positional[0], config);
    return resumeCharacter(root, {
      config,
      ...(options['animation-inventory']?{animationInventory:{planPath:path.resolve(options['animation-inventory']),inventoryPath:path.resolve(options['mechanics-inventory'])}}:{}),
      ...(options.effects?{effectPlan:{planPath:path.resolve(options.effects),inventoryPath:path.resolve(options.inventory)}}:{}),
      ...(options['effect-presentation']?{effectPresentation:await readInput(path.resolve(options['effect-presentation']),config)}:{}),
      ...(options['no-render'] ? {
        render: false
      } : {})
    });
  }
  if (command === 'status') {
    const {
      inspectJob
    } = require('./lib/jobs');
    const root = await outputPath(positional[0], config);
    const {
      inspectArtworkReview
    } = require('./lib/artwork-review');
    const manifest = await inspectJob(root);
    return {
      ...manifest,
      artworkReview: await inspectArtworkReview(root, {
        config
      })
    };
  }
  const {
    createSpec,
    assertSpec,
    applyPatch
  } = require('./lib/spec');
  const {
    atomicWrite
  } = require('./lib/assets');
  if (command === 'create') {
    const target = await outputPath(options.out, config);
    await refuseExisting(target);
    const id = options.id || path.basename(target, path.extname(target)).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'character';
    const spec = createSpec({
      id,
      description: options.description,
      template: options.template
    });
    await atomicWrite(target, JSON.stringify(spec, null, 2) + '\n');
    return {
      specification: target,
      id: spec.id,
      revision: spec.revision
    };
  }
  const original = await readInput(positional[0], config);
  if(command==='fit-rig'){
    const landmarks=await readInput(options.landmarks,config),target=await outputPath(options.out,config);
    await refuseExisting(target);
    const fitted=require('./lib/rig').fitRig(original,landmarks);
    // Exclusive creation prevents a concurrent output from being overwritten.
    try{await fs.writeFile(target,JSON.stringify(fitted,null,2)+'\n',{flag:'wx'});}catch(error){if(error.code==='EEXIST')throw invalid(`Output already exists: ${target}`,'OUTPUT_EXISTS');throw error;}
    return {specification:target,id:fitted.id,revision:fitted.revision};
  }
  const spec = assertSpec(original);
  if(command==='author-clips'){
    const request=await readInput(options.request,config),target=await outputPath(options.out,config);
    await refuseExisting(target);
    if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).length!==3||Object.keys(request).some(key=>!['version','sourceSpecHash','clips'].includes(key))||request.version!==1||typeof request.sourceSpecHash!=='string'||!/^[a-f0-9]{64}$/.test(request.sourceSpecHash)||!Array.isArray(request.clips)||request.clips.length<1||request.clips.length>64)throw invalid('Clip request requires version 1, sourceSpecHash and 1–64 explicit clips.','INVALID_CLIP');
    if(request.sourceSpecHash!==require('./lib/assets').hashValue(spec))throw invalid('Clip request does not match the current source specification.','STALE_CLIP_REQUEST');
    const expanded=require('./lib/animation').expandClips(spec,request.clips),authored=applyPatch(spec,{animations:expanded.animations});
    const inventory=options['animation-inventory']?await require('./lib/animation-inventory-build').captureAnimationInventory({characterId:spec.id,planPath:path.resolve(options['animation-inventory']),inventoryPath:path.resolve(options['mechanics-inventory'])},{config:{...config,sourceRoots:[...(config.sourceRoots||[]),config.outputRoot].filter(Boolean)},spec:authored}):undefined;
    await outputPath(target,config);
    try{await fs.writeFile(target,JSON.stringify(authored,null,2)+'\n',{flag:'wx'});}catch(error){if(error.code==='EEXIST')throw invalid(`Output already exists: ${target}`,'OUTPUT_EXISTS');throw error;}
    return {specification:target,id:authored.id,revision:authored.revision,authoredClips:request.clips.map(clip=>typeof clip==='string'?{id:clip,family:clip}:{id:clip.id??clip.family,family:clip.family}),readyToBuild:false,...(inventory?{animationInventory:{status:inventory.status,fingerprint:inventory.fingerprint,referencedClipIds:inventory.referencedClipIds,diagnostics:inventory.diagnostics},animationInventoryComplete:inventory.animationInventoryComplete}:{})};
  }
  if (command === 'build' || command === 'validate' && options.render) {
    if (!options.job) throw invalid('Rendered validation requires --job JOB_DIRECTORY.', 'CAPABILITY_MISSING');
    const {
      buildCharacter
    } = require('./lib/engine');
    const jobRoot = await outputPath(options.job, config);
    return buildCharacter(spec, {
      config,
      jobRoot,
      ...(options['animation-inventory']?{animationInventory:{planPath:path.resolve(options['animation-inventory']),inventoryPath:path.resolve(options['mechanics-inventory'])}}:{}),
      ...(options.effects?{effectPlan:{planPath:path.resolve(options.effects),inventoryPath:path.resolve(options.inventory)}}:{}),
      ...(options['effect-presentation']?{effectPresentation:await readInput(path.resolve(options['effect-presentation']),config)}:{}),
      render: !options['no-render']
    });
  }
  if (command === 'validate') {
    return {
      valid: true,
      scope: 'specification',
      id: spec.id,
      revision: spec.revision
    };
  }
  const patch = await readInput(options.patch, config);
  const updated = applyPatch(spec, patch);
  const target = await outputPath(positional[0], config);
  const previous = await outputPath(`${target}.revision-${spec.revision}.json`, config);
  const jobRoot = options.job ? await outputPath(options.job, config) : undefined;
  const patchPath = await fs.realpath(options.patch);
  const equivalent = (left, right) => path.relative(left, right) === '';
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
  };
  if (equivalent(patchPath, target) || equivalent(patchPath, previous) || jobRoot && [target, previous, patchPath].some(file => contains(jobRoot, file) || contains(file, jobRoot))) throw invalid('Revision inputs and outputs must be distinct from the job directory.', 'UNSAFE_PATH');
  await refuseExisting(previous);
  let backupWritten = false, persisted = false;
  const persistModification = async () => {
    if (backupWritten) throw invalid('Modification persistence already ran.', 'OUTPUT_EXISTS');
    await outputPath(target, config);
    await outputPath(previous, config);
    const {hashValue} = require('./lib/assets');
    let current;
    try { current = assertSpec(await readJson(target)); } catch { throw invalid('Specification changed before revision persistence.', 'STALE_JOB_CONTEXT'); }
    if (hashValue(current) !== hashValue(spec)) throw invalid('Specification changed before revision persistence.', 'STALE_JOB_CONTEXT');
    try { await fs.writeFile(previous, JSON.stringify(spec, null, 2) + '\n', {flag:'wx'}); }
    catch (error) { if (error.code === 'EEXIST') throw invalid(`Output already exists: ${previous}`, 'OUTPUT_EXISTS'); throw error; }
    backupWritten = true;
    await outputPath(target, config);
    await atomicWrite(target, JSON.stringify(updated, null, 2) + '\n');
    persisted = true;
  };
  const revision = {specification:target, previous, id:updated.id, revision:updated.revision};
  try {
    if (!jobRoot) { await persistModification(); return revision; }
    const build = await require('./lib/engine').rebuildCharacter(spec, updated, {config, jobRoot, persistModification});
    return {...revision, build};
  } catch (error) {
    if (backupWritten) error[REVISION_RECOVERY] = {...Object.fromEntries(Object.entries(revision).map(([key,value])=>[key,typeof value==='string'?value.slice(0,4096):value])), ...(jobRoot ? {jobRoot:jobRoot.slice(0,4096)} : {}), persisted,
      nextAction:'Inspect status for the job. Resume only if its committed specification matches the saved revision; otherwise build the saved specification into the job. Preserve the previous revision backup.'};
    error.recovery = error[REVISION_RECOVERY];
    throw error;
  }
}
async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parse(argv);
    if (parsed.command === 'help') {
      process.stdout.write(HELP);
      return 0;
    }
    const result = await execute(parsed);
    process.stdout.write(JSON.stringify({
      ok: true,
      result
    }) + '\n');
    return 0;
  } catch (error) {
    const code = error.code || (error instanceof SyntaxError || error instanceof TypeError ? 'INVALID_INPUT' : 'RUNTIME_ERROR');
    let exitCode = 5;
    if (['INVALID_ANIMATION_INVENTORY', 'STALE_ANIMATION_INVENTORY', 'INVALID_PACKAGE_REQUEST', 'INVALID_MOD_BUILD', 'INVALID_MOD_PACKAGE', 'STALE_CLIP_REQUEST', 'INVALID_CLIP', 'JOINT_LIMIT', 'STALE_JOB_CONTEXT', 'STALE_REVIEW', 'INVALID_INPUT', 'INVALID_COMPONENT', 'INVALID_RIG', 'INVALID_AUTHORED_GEOMETRY', 'INVALID_STS2_INTEGRATION', 'INVALID_SPEC', 'INVALID_EFFECT_PLAN','INVALID_MECHANICS', 'INVALID_PATCH', 'INVALID_MANIFEST', 'INVALID_DAG', 'UNSAFE_PATH', 'PATH_ESCAPE', 'OUTPUT_EXISTS', 'ENOENT', 'EISDIR', 'ENOTDIR', 'ENAMETOOLONG', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE'].includes(code)) exitCode = 2;else if (['PACKAGE_REFRESH_REQUIRED', 'PACKAGE_NOT_READY', 'UNSUPPORTED_CLIP', 'UNSUPPORTED_BINDING', 'CAPABILITY_MISSING', 'COMPONENT_CONTRACT_REQUIRED', 'TOOL_NOT_FOUND', 'UNSUPPORTED', 'EXPORT_NOT_READY'].includes(code)) exitCode = 3;else if (['INVALID_MOD_ASSEMBLY', 'MOD_BUILD_FAILED', 'VALIDATION_FAILED', 'VISUAL_VALIDATION_FAILED', 'AUTHORED_GEOMETRY_FAILED', 'CORRUPT_ARTIFACT'].includes(code)) exitCode = 4;else if (['ABORTED', 'ABORT_ERR', 'ERR_ABORTED'].includes(code)) exitCode = 130;
    process.stdout.write(JSON.stringify({
      ok: false,
      error: {
        code,
        message: error.message,
        diagnostics: error.diagnostics || [],
        ...(error[REVISION_RECOVERY] ? {recovery:error[REVISION_RECOVERY]} : {})
      }
    }) + '\n');
    return exitCode;
  }
}
if (require.main === module) main().then(code => {
  process.exitCode = code;
});
module.exports = {
  main
};
