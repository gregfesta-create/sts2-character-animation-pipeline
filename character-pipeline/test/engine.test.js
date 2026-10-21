'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  createSpec
} = require('../lib/spec');
const {
  buildCharacter,
  resumeCharacter
} = require('../lib/engine');
const renderPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64');

function graphicsProbeEngine(t,state){
 const engineFile=require.resolve('../lib/engine'),processFile=require.resolve('../lib/process'),graphicsFile=path.resolve(__dirname,'../lib/graphics-prerequisites.js');
 const savedEngine=require.cache[engineFile],savedGraphics=require.cache[graphicsFile],savedProcess=require.cache[processFile].exports;
 require.cache[processFile].exports={...savedProcess,runTool:async(registry,name)=>({exitCode:0,stdout:name==='python'?'Python 3.13.14':'4.5.1',stderr:''})};
 require.cache[graphicsFile]={id:graphicsFile,filename:graphicsFile,loaded:true,exports:{probeGraphicsPrerequisites:async()=>{state.calls++;return structuredClone(state.report);}}};
 delete require.cache[engineFile];const engine=require('../lib/engine');
 t.after(()=>{require.cache[engineFile]=savedEngine;require.cache[processFile].exports=savedProcess;if(savedGraphics)require.cache[graphicsFile]=savedGraphics;else delete require.cache[graphicsFile];});return engine;
}
function readyGraphics(){return {version:1,available:true,implementationHash:'a'.repeat(64),python:{version:'3.13.14'},pillow:{version:'12.0.0',pngRoundTrip:true},numpy:{version:'2.3.0',arrayOperation:true},pathApi:{isJunction:true},diagnostics:[]};}

test('graphics prerequisite failure precedes component source capture and original-art review',async t=>{
 const f=await fixture(t),state={calls:0,report:{...readyGraphics(),available:false,diagnostics:[{code:'PILLOW_MISSING',message:'Install Pillow in the configured Python environment.'}]}};
 const engine=graphicsProbeEngine(t,state);f.options.toolVersions=undefined;f.options.config.tools={python:{executable:process.execPath},godot:{executable:process.execPath}};
 f.spec.sockets=[{id:'mount',bone:'root',transform:{position:[0,0],rotation:0,scale:[1,1]},types:['arm'],capacity:1,inheritance:{position:true,rotation:true,scale:true}}];
 f.spec.components=[{id:'child',socket:'mount',type:'arm',spec:path.join(f.source,'missing-component.json')}];
 let approvals=0;f.options.reviewArtwork=async()=>{approvals++;return {approved:true};};
 await assert.rejects(engine.buildCharacter(f.spec,f.options),e=>e.code==='CAPABILITY_MISSING'&&e.message.includes('PILLOW_MISSING'));
 assert.equal(state.calls,1);assert.equal(approvals,0);assert.deepEqual(f.counts,{arm:0,body:0,rig:0});await assert.rejects(fs.stat(f.options.jobRoot),{code:'ENOENT'});
});

test('observed graphics identities invalidate dependent cached work on source-free resume',async t=>{
 const f=await fixture(t),state={calls:0,report:readyGraphics()},engine=graphicsProbeEngine(t,state);f.options.toolVersions=undefined;f.options.config.tools={python:{executable:process.execPath},godot:{executable:process.execPath}};
 const first=await engine.buildCharacter(f.spec,f.options);assert.equal(state.calls,1);assert.ok(first.manifest.context.tools.python.graphics);const initial=structuredClone(f.counts);
 await fs.rm(f.source,{recursive:true});await engine.resumeCharacter(f.options.jobRoot,f.options);assert.deepEqual(f.counts,initial);assert.equal(state.calls,2);
 state.report.numpy.version='2.4.0';const changed=await engine.resumeCharacter(f.options.jobRoot,f.options);assert.equal(state.calls,3);assert.notDeepEqual(changed.manifest.context.tools.python.graphics,first.manifest.context.tools.python.graphics);assert.deepEqual(f.counts,{arm:2,body:2,rig:2});
 state.report.available=false;state.report.diagnostics=[{code:'NUMPY_MISSING',message:'NumPy is unavailable.'}];await assert.rejects(engine.resumeCharacter(f.options.jobRoot,f.options),{code:'CAPABILITY_MISSING'});assert.deepEqual(f.counts,{arm:2,body:2,rig:2});
});

test('successful graphics preflight never grants original-art approval',async t=>{
 const f=await fixture(t),state={calls:0,report:readyGraphics()},engine=graphicsProbeEngine(t,state);f.options.toolVersions=undefined;f.options.config.tools={python:{executable:process.execPath},godot:{executable:process.execPath}};
 let reviews=0;f.options.reviewArtwork=async()=>{reviews++;return {approved:false,status:'awaiting_artwork_approval'};};
 const result=await engine.buildCharacter(f.spec,f.options);assert.equal(result.status,'awaiting_artwork_approval');assert.equal(state.calls,1);assert.equal(reviews,1);assert.deepEqual(f.counts,{arm:0,body:0,rig:0});
});

test('component originals are captured and reviewed before processing, including source-free resume', async t => {
  const f = await fixture(t);
  const dir = f.options.config.sourceRoots[0];
  const image = path.join(dir,'component.png');
  await fs.writeFile(image,'distinct component original');
  const child = createSpec({id:'armDefinition',description:'component',template:'custom'});
  child.parts = [structuredClone(f.spec.parts[0])];
  child.parts[0].image.path = 'component.png';
  const file = path.join(dir,'component.json');
  await fs.writeFile(file,JSON.stringify(child));
  f.spec.sockets = [{id:'armSocket',bone:'root',transform:{position:[0,0],rotation:0,scale:[1,1]},types:['armType'],capacity:1,inheritance:{position:true,rotation:true,scale:true}}];
  f.spec.components = [{id:'installedArm',socket:'armSocket',type:'armType',spec:file}];
  let calls = 0;
  f.options.reviewArtwork = async ({componentArtwork,inputs}) => {
    calls++;
    assert.equal(componentArtwork.length,1);
    assert.equal(componentArtwork[0].id,'armDefinition');
    assert.ok(inputs[image]);
    assert.equal(componentArtwork[0].content.originals[0].hash,inputs[image].hash);
    return {approved:false,status:'awaiting_artwork_approval'};
  };
  assert.equal((await buildCharacter(f.spec,f.options)).status,'awaiting_artwork_approval');
  assert.deepEqual(f.counts,{arm:0,body:0,rig:0});
  await fs.rm(image);await fs.rm(file);
  assert.equal((await resumeCharacter(f.options.jobRoot,f.options)).status,'awaiting_artwork_approval');
  assert.equal(calls,2);
  assert.deepEqual(f.counts,{arm:0,body:0,rig:0});
});

test('relative root sources and absolute graph receipts share captured byte accounting', async t => {
  const f = await fixture(t);
  const dir = f.options.config.sourceRoots[0];
  await fs.writeFile(path.join(dir,'large.png'),Buffer.alloc(33*1024*1024,17));
  f.spec.parts = [f.spec.parts[0]];
  f.spec.parts[0].image.path = 'large.png';
  const child = createSpec({id:'child',description:'child artwork',template:'custom'});
  child.parts = [structuredClone(f.spec.parts[0])];
  child.parts[0].image.path = 'body.png';
  const file = path.join(dir,'child.json');
  await fs.writeFile(file,JSON.stringify(child));
  f.spec.sockets = [{id:'socket',bone:'root',transform:{position:[0,0],rotation:0,scale:[1,1]},types:['arm'],capacity:1,inheritance:{position:true,rotation:true,scale:true}}];
  f.spec.components = [{id:'childMount',socket:'socket',type:'arm',spec:file}];
  f.options.reviewArtwork = async () => ({approved:false,status:'awaiting_artwork_approval'});
  assert.equal((await buildCharacter(f.spec,f.options)).status,'awaiting_artwork_approval');
  assert.deepEqual(f.counts,{arm:0,body:0,rig:0});
});
async function fixture(t) {
  const scratch = path.resolve(__dirname, '../../.tmp/character-pipeline-engine');
  await fs.mkdir(scratch, {
    recursive: true
  });
  const root = await fs.mkdtemp(path.join(scratch, 'test-'));
  t.after(() => fs.rm(root, {
    recursive: true,
    force: true
  }));
  const source = path.join(root, 'inputs');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'arm.png'), 'original arm pixels');
  await fs.writeFile(path.join(source, 'body.png'), 'original body pixels');
  const spec = createSpec({
    id: 'fixture',
    description: 'pipeline stage fixture',
    template: 'custom'
  });
  spec.parts = ['arm', 'body'].map(id => ({
    id,
    role: id,
    bone: 'root',
    pivot: [1, 1],
    layer: 0,
    image: {
      path: path.join(source, id + '.png')
    }
  }));
  const counts = {
    arm: 0,
    body: 0,
    rig: 0
  };
  const options = {
    jobRoot: path.join(root, 'job'),
    config: {
      tools: {},
      sourceRoots: [source],
      outputRoot: root
    },
    toolVersions: {
      python: 'fixture-python',
      godot: 'fixture-godot'
    },
    versions: {
      artwork: 'fixture-provider-v1',
      godot: 'fixture-backend-v1'
    },
    reviewArtwork: async () => ({
      approved: true
    }),
    createAssemblyPreview: async (input,{compiledSpecHash,stagingDir}) => {
      const plan=require('../lib/assembly-preview-planning').planAssemblyPreview(input,{compiledSpecHash}),report={version:1,status:plan.status==='not-applicable'?'not-applicable':'completed',scope:'development-assembly-preview',visualQuality:'unverified',specHash:require('../lib/assets').hashValue(input),compiledSpecHash,planHash:plan.planHash,frames:[],contactSheet:null,motionPreview:null,native:null};
      if(report.status==='completed'){await fs.writeFile(path.join(stagingDir,'preview.png'),renderPng);const sha256=await require('../lib/assets').hashFile(path.join(stagingDir,'preview.png'));report.frames=plan.frames.map(({index,time,configurationId})=>({index,time,configurationId,path:'preview.png',width:plan.renderLayout.pixels[0],height:plan.renderLayout.pixels[1],sha256}));report.contactSheet={path:'preview.png',sha256};report.motionPreview={path:'preview.png',sha256};report.native={fixture:true};}return report;
    },
    inspectRenderedFrames: async (frames,{stagingDir}) => {
      const sheet=path.join(stagingDir,'contact-sheet.png');
      await fs.writeFile(sheet,Buffer.from('89504e470d0a1a0a00000000','hex'));
      return {version:1,visualQuality:'unverified',coverage:{frameCount:frames.length},contactSheet:{path:sheet}};
    },
    prepareArtwork: async (input, {
      partIds,
      stagingDir
    }) => {
      const id = partIds[0];
      counts[id]++;
      const part = structuredClone(input.parts.find(p => p.id === id));
      const bytes = await fs.readFile(part.image.path);
      const imagePath = path.join(stagingDir, `${id}.png`);
      await fs.writeFile(imagePath, bytes);
      part.image = {
        path: imagePath,
        prepared: true,
        width: 4,
        height: 4,
        alphaBounds: [0, 0, 4, 4],
        cropTranslation: [0, 0],
        pivot: [1, 1],
        pixelsPerUnit: 1
      };
      const result = structuredClone(input);
      result.parts[result.parts.findIndex(p => p.id === id)] = part;
      return {
        spec: result,
        parts: [{
          id,
          image: part.image,
          source: {
            width: 4,
            height: 4,
            pivot: [1, 1]
          },
          transform: {
            scale: 1,
            translation: [0, 0]
          }
        }],
        diagnostics: []
      };
    },
    compileGodot: async (input, {
      stagingDir
    }) => {
      counts.rig++;
      for (const part of input.parts) assert.ok((await fs.readFile(part.image.path)).length > 0);
      const project = path.join(stagingDir, 'godot');
      await fs.mkdir(project);
      const scene = path.join(project, 'character.tscn');
      const frame = path.join(project, 'frame.png');
      await fs.writeFile(scene, '[gd_scene format=3]\n[node name="Fixture" type="Node2D"]');
      await fs.writeFile(frame, renderPng);
      return {
        project,
        scene,
        frames: [frame],
        validation: {
          valid: true,
          frames:['frame.png'],
          geometry: {status:'unverified',scope:'parent-authored-pose',componentGeometry:'uncovered',report:{status:'unverified',visualQuality:'unverified'}},
          rendered: true
        },
        log: null
      };
    }
  };
  return {
    root,
    source,
    spec,
    counts,
    options
  };
}
test('build connects immutable artwork stages to a relocatable rig checkpoint; resume reuses valid outputs', async t => {
  const f = await fixture(t);
  const result = await buildCharacter(f.spec, f.options);
  assert.equal(result.valid, true);
  assert.equal(result.rendered, true);
  assert.equal(f.counts.rig, 1);
  assert.ok((await fs.stat(result.scene)).isFile());
  assert.ok(result.scene.includes(`${path.sep}outputs${path.sep}`));
  const checkpoint = Object.values(result.manifest.stages).find(stage => stage.artifacts.some(artifact => artifact.path === 'arm.png'));
  const registration = JSON.parse(await fs.readFile(path.join(f.options.jobRoot, checkpoint.directory, 'prepared-part.json'), 'utf8'));
  assert.equal(registration.provenance.source.width, 4);
  const cached = await resumeCharacter(f.options.jobRoot, f.options);
  assert.equal(cached.scene, result.scene);
  assert.deepEqual(f.counts, {
    arm: 1,
    body: 1,
    rig: 1
  });
});
test('rendered jobs publish cached pixel inspection and retry inspection without rebuilding the rig',async t=>{
 const f=await fixture(t),inspect=f.options.inspectRenderedFrames;let calls=0;
 f.options.inspectRenderedFrames=async(...args)=>{calls++;if(calls===1)throw Object.assign(new Error('pixel fixture failure'),{code:'VISUAL_INSPECTION_FAILED'});return inspect(...args);};
 await assert.rejects(()=>buildCharacter(f.spec,f.options),{code:'VISUAL_INSPECTION_FAILED'});
 const result=await resumeCharacter(f.options.jobRoot,f.options);assert.equal(result.inspection.visualQuality,'unverified');assert.deepEqual(result.inspection.nativeGeometry,result.validation.geometry);assert.equal(result.inspection.nativeGeometry.componentGeometry,'uncovered');assert.equal(result.inspection.coverage.frameCount,1);assert.ok((await fs.stat(result.inspection.contactSheet.path)).isFile());assert.equal(f.counts.rig,1);
 await resumeCharacter(f.options.jobRoot,f.options);assert.equal(calls,2);assert.equal(f.counts.rig,1);
});

test('rendered overlap inspection retains final compiled identities and retries independently of rig and art',async t=>{
 const f=await fixture(t),compile=f.options.compileGodot;let inspections=0,fail=true;
 const specHash=require('../lib/assets').hashValue;
 f.options.compileGodot=async(spec,options)=>{
  const built=await compile(spec,options),mask=path.join(options.stagingDir,'part-mask-0.png');await fs.writeFile(mask,renderPng);
  return {...built,maskPlan:{version:1,specHash:specHash(spec),planHash:'a'.repeat(64)},maskCaptures:[{id:0,path:mask,sha256:await require('../lib/assets').hashFile(mask)}]};
 };
 f.options.inspectPartMasks=async(plan,captures,{sourceRoot})=>{
  inspections++;assert.equal(plan.version,1);assert.match(plan.specHash,/^[a-f0-9]{64}$/);assert.equal(captures.length,1);assert.equal(path.isAbsolute(captures[0].path),false);assert.deepEqual(await fs.readFile(path.join(sourceRoot,captures[0].path)),renderPng);
  if(fail)throw Object.assign(Error('forbidden alpha'),{code:'VISUAL_VALIDATION_FAILED'});
  return {version:1,scope:'rendered-parent-part-alpha',visualQuality:'unverified',status:'measured',planHash:plan.planHash};
 };
 await assert.rejects(buildCharacter(f.spec,f.options),{code:'VISUAL_VALIDATION_FAILED'});assert.equal(f.counts.rig,1);
 fail=false;const result=await resumeCharacter(f.options.jobRoot,f.options);assert.equal(result.inspection.partMasks.status,'measured');assert.equal(inspections,2);assert.equal(f.counts.rig,1);
 await fs.rm(f.source,{recursive:true});const resumed=await resumeCharacter(f.options.jobRoot,f.options);assert.deepEqual(resumed.inspection.partMasks,result.inspection.partMasks);assert.equal(inspections,2);assert.equal(f.counts.rig,1);
});

test('missing native mask evidence stays explicitly unverified without launching mask inspection',async t=>{
 const f=await fixture(t);f.options.inspectPartMasks=()=>{throw Error('No captured masks should invoke a worker');};
 const result=await buildCharacter(f.spec,f.options);assert.equal(result.inspection.partMasks.status,'unverified');assert.equal(result.inspection.partMasks.reason,'native-mask-evidence-unavailable');
});

test('overlap annotations invalidate rig and inspection while approved prepared art stays cached',async t=>{
 const f=await fixture(t);await buildCharacter(f.spec,f.options);
 f.spec.parts.forEach(part=>part.overlaps=[]);const second=await buildCharacter(f.spec,f.options);
 assert.deepEqual(f.counts,{arm:1,body:1,rig:2});assert.equal(second.inspection.partMasks.status,'unverified');
});

test('native mask receipts must bind the exact final candidate and owned files before rig publication',async t=>{
 for(const kind of ['wrong-spec','missing-captures','foreign-path']){
  const f=await fixture(t),compile=f.options.compileGodot;
  f.options.compileGodot=async(spec,options)=>({...await compile(spec,options),maskPlan:{version:1,specHash:kind==='wrong-spec'?'0'.repeat(64):require('../lib/assets').hashValue(spec)},...(kind==='missing-captures'?{}:{maskCaptures:[{path:path.join(f.source,'arm.png')}]})});
  await assert.rejects(buildCharacter(f.spec,f.options),e=>['VALIDATION_FAILED','UNSAFE_PATH'].includes(e.code));
 }
});
test('authored geometry fails before compiler and safe cached receipts remain separate from native evidence',async t=>{
 const f=await fixture(t);f.options.render=false;
 f.spec.parts[0].mesh={vertices:[[0,0],[2,0],[0,3]],uv:[[0,0],[2,0],[0,3]],triangles:[[0,1,2]],weights:Array.from({length:3},()=>[{bone:'root',weight:1}])};
 f.spec.animations=[{id:'pose',duration:1,loop:false,events:[],tracks:[{bone:'root',property:'scale',keys:[{time:0,value:[-1,1]},{time:1,value:[-1,1]}]}]}];
 await assert.rejects(buildCharacter(f.spec,f.options),{code:'AUTHORED_GEOMETRY_FAILED'});assert.equal(f.counts.rig,0);
 const g=await fixture(t);g.options.render=false;g.spec.parts[0].mesh=structuredClone(f.spec.parts[0].mesh);g.spec.animations=[{id:'pose',duration:1,loop:false,events:[],tracks:[]}];
 const result=await buildCharacter(g.spec,g.options);assert.equal(result.authoredGeometry.status,'partial');assert.equal(result.authoredGeometry.nativeGeometry,'uncovered');
 const resumed=await resumeCharacter(g.options.jobRoot,g.options);assert.deepEqual(resumed.authoredGeometry,result.authoredGeometry);assert.equal(g.counts.rig,1);
});

test('non-rendered native jobs retain support for 33 clips beyond bounded authored projection',async t=>{
 const f=await fixture(t);f.options.render=false;f.spec.animations=Array.from({length:33},(_,i)=>({id:'clip'+i,duration:1,loop:false,tracks:[],events:[]}));
 const result=await buildCharacter(f.spec,f.options);assert.equal(result.valid,true);assert.equal(f.counts.rig,1);assert.deepEqual(result.authoredGeometry.sampling.omittedClipIds,['clip32']);
});

test('every repaired candidate is projected before compilation and closure shares the bounded correction budget',async t=>{
 const f=await fixture(t);f.spec.bones.push({id:'moving',parent:'root',rest:{position:[0,0],rotation:0,scale:[1,1]},length:1});
 f.spec.parts[0].mesh={vertices:[[0,0],[2,0],[0,3]],uv:[[0,0],[2,0],[0,3]],triangles:[[0,1,2]],weights:[[{bone:'moving',weight:1}],[{bone:'root',weight:1}],[{bone:'root',weight:1}]]};
 // The unsafe start is an omitted loop endpoint, followed immediately by the
 // first cadence sample. No interior is sampled there; closing the last key
 // creates a sampled inversion later. This tests the repair boundary within
 // bounded sampling, without relying on nonlinear interiors being omitted.
 f.spec.animations=[{id:'loop',duration:1,loop:true,events:[],tracks:[{bone:'moving',property:'position',keys:[{time:0,value:[0,6],easing:'in'},{time:.0625,value:[0,0]},{time:1,value:[0,0]}]}]}];
 let calls=0;f.options.compileGodot=async()=>{calls++;throw Object.assign(new Error('loop seam'),{code:'VISUAL_VALIDATION_FAILED',diagnostics:[{code:'LOOP_SEAM',clipId:'loop',jointId:'joint0',measured:2,limit:1}]});};
 // Closing the loop creates a sampled inversion; damping makes the sampled
 // interior positive. Only that corrected candidate reaches native again.
 // Its deliberately persistent native seam remains an explicit failure.
 await assert.rejects(buildCharacter(f.spec,f.options),e=>e.code==='VISUAL_VALIDATION_FAILED'&&e.repair.attempts===2&&e.repair.status==='irreparable');assert.equal(calls,2);
});

test('normal engine corrects authored deformation before native compilation and resumes approved captured sources',async t=>{
 const f=await motionFixture(t);f.spec.bones.push({id:'moving',parent:'root',rest:{position:[0,0],rotation:0,scale:[1,1]},length:1});
 f.spec.parts[0].mesh={vertices:[[0,0],[4,0],[0,4]],uv:[[0,0],[4,0],[0,4]],triangles:[[0,1,2]],weights:[[{bone:'root',weight:1}],[{bone:'moving',weight:1}],[{bone:'root',weight:1}]]};
 f.spec.animations=[{id:'attack',duration:.125,loop:false,events:[],tracks:[{bone:'moving',property:'position',keys:[{time:0,value:[0,0]},{time:.125,value:[-8,0]}]}]}];
 const original=structuredClone(f.spec),compile=f.options.compileGodot,inputs=[];let approvals=0;
 f.options.reviewArtwork=async()=>{approvals++;return {approved:true};};
 f.options.compileGodot=async(input,options)=>{inputs.push(structuredClone(input));assert.deepEqual(input.animations[0].tracks[0].keys.at(-1).value,[-2,0]);return compile(input,options);};
 const result=await buildCharacter(f.spec,f.options);assert.equal(inputs.length,1);assert.deepEqual(f.spec,original);assert.deepEqual(f.counts,{arm:1,body:1,rig:1});assert.equal(approvals,1);
 assert.equal(result.repair.attempts,2);assert.equal(result.repair.scope,'authored-local-animation');assert.equal(result.repair.status,'passed');
 const repaired=JSON.parse(await fs.readFile(result.repair.specPath,'utf8'));assert.equal(require('../lib/assets').hashValue(repaired),result.repair.repairedSpecHash);assert.equal(result.authoredGeometry.specHash,result.repair.repairedSpecHash);assert.notEqual(result.repair.originalSpecHash,result.repair.repairedSpecHash);
 await fs.rm(f.source,{recursive:true});const resumed=await resumeCharacter(f.options.jobRoot,f.options);assert.equal(inputs.length,1);assert.deepEqual(f.counts,{arm:1,body:1,rig:1});assert.deepEqual(resumed.repair,result.repair);assert.equal(approvals,2);
});

test('normal rendered rig repairs explicit loop seams and rehydrates durable repair receipts without rebuilding sources',async t=>{
 const f=await motionFixture(t);f.spec.animations=[{id:'idle',duration:.125,loop:true,tracks:[{bone:'root',property:'position',keys:[{time:0,value:[0,0]},{time:.0625,value:[1,0]},{time:.125,value:[2,0]}]}],events:[]}];
 const before=structuredClone(f.spec),compile=f.options.compileGodot,inputs=[];let approvals=0;
 f.options.reviewArtwork=async()=>{approvals++;return {approved:true};};
 f.options.compileGodot=async(input,options)=>{inputs.push(structuredClone(input));if(inputs.length===1)throw Object.assign(new Error('native loop seam'),{code:'VISUAL_VALIDATION_FAILED',diagnostics:[{code:'LOOP_SEAM',id:'loop0',clipId:'idle',jointId:'joint0',measured:2,limit:1}]});return compile(input,options);};
 const result=await buildCharacter(f.spec,f.options);assert.equal(inputs.length,2);assert.deepEqual(f.spec,before);assert.deepEqual(inputs[1].animations[0].tracks[0].keys.at(-1).value,[0,0]);assert.deepEqual(inputs[0].parts,inputs[1].parts);assert.equal(approvals,1);assert.equal(result.repair.status,'passed');assert.equal(result.repair.attempts,1);assert.notEqual(result.repair.originalSpecHash,result.repair.repairedSpecHash);
 const rigRoot=path.join(f.options.jobRoot,result.manifest.stages.rig.directory),record=JSON.parse(await fs.readFile(path.join(rigRoot,'rig.json'),'utf8'));
 assert.equal(path.isAbsolute(record.repair.historyPath),false);assert.equal(path.isAbsolute(record.repair.specPath),false);assert.ok((await fs.stat(result.repair.historyPath)).isFile());assert.equal(path.relative(result.project,result.repair.specPath).startsWith('..'),true);
 assert.equal(require('../lib/assets').hashValue(JSON.parse(await fs.readFile(result.repair.specPath,'utf8'))),result.repair.repairedSpecHash);
 assert.equal(result.authoredGeometry.specHash,result.repair.repairedSpecHash);assert.notEqual(result.authoredGeometry.specHash,result.repair.originalSpecHash);
 await fs.rm(f.source,{recursive:true});const resumed=await resumeCharacter(f.options.jobRoot,f.options);assert.equal(inputs.length,2);assert.deepEqual(resumed.repair,result.repair);assert.equal(approvals,2);assert.equal(f.motionCalls,1);
});
test('normal rendered rig does not repeat unknown visual failures or mutate original input on cancellation',async t=>{
 const f=await fixture(t),original=structuredClone(f.spec);let calls=0;
 f.options.compileGodot=async()=>{calls++;throw Object.assign(new Error('unknown rendered failure'),{code:'VISUAL_VALIDATION_FAILED',diagnostics:[{code:'ATTACHMENT_ERROR'}]});};
 await assert.rejects(buildCharacter(f.spec,f.options),{code:'VISUAL_VALIDATION_FAILED'});assert.equal(calls,1);assert.deepEqual(f.spec,original);
 const g=await fixture(t),controller=new AbortController(),compile=g.options.compileGodot,before=structuredClone(g.spec);g.options.signal=controller.signal;g.options.compileGodot=async(...args)=>{const result=await compile(...args);controller.abort();return result;};await assert.rejects(buildCharacter(g.spec,g.options),{code:'CANCELLED'});assert.deepEqual(g.spec,before);
});

async function motionFixture(t){
 const f=await fixture(t);
 f.spec.animations=[{id:'attack',duration:.125,loop:false,tracks:[],events:[]}];
 return configureMotionFixture(f);
}

test('detailed attack previews reuse capacity left by a simple idle clip',async t=>{
 const f=await motionFixture(t);
 const keys=Array.from({length:42},(_,i)=>({time:i/16,value:0}));
 f.spec.animations=[{id:'idle',duration:.125,loop:true,tracks:[],events:[]},{id:'attack',duration:3,loop:false,tracks:[{bone:'root',property:'rotation',keys}],events:[]}];
 const result=await buildCharacter(f.spec,f.options);
 const attack=result.motionPreviews.clips.find(c=>c.clipId==='attack');
 assert.deepEqual(attack.sampling.omittedKeyTimes,[]);
 for(const key of keys)assert(attack.captures.some(c=>c.time===key.time));
 assert(result.motionPreviews.clips.reduce((n,c)=>n+c.captures.length,0)<=64);
});
function configureMotionFixture(f){
 const compile=f.options.compileGodot;
 f.options.compileGodot=async(...args)=>{
  const result=await compile(...args),plan=require('../lib/motion-sampling').planMotionSampling(args[0].animations,{framesPerSecond:16,maxFramesPerClip:64,maxTotalFrames:64});
  result.frames=[];let index=0;result.validation.frames=[];result.validation.samples=[];result.validation.motionPlan=plan;
  for(const clip of plan.clips)for(const time of clip.times){const name='frame-'+clip.id+'-'+index+++'.png',file=path.join(result.project,name);await fs.writeFile(file,renderPng);result.frames.push(file);result.validation.frames.push(name);result.validation.samples.push({clip:clip.id,time});}
  return result;
 };
 f.motionCalls=0;
 f.options.createMotionPreview=async(clipId,frames,hold,{sourceRoot,stagingDir})=>{
  f.motionCalls++;const {hashFile}=require('../lib/assets'),bytes=Buffer.from('verified motion fixture'),file=path.join(stagingDir,clipId+'.png');await fs.writeFile(file,bytes);
  const captures=await Promise.all(frames.map(async x=>({source:x.path,time:x.time,sha256:await hashFile(path.join(sourceRoot,x.path))})));
  const durations=frames.map((x,i)=>i+1<frames.length?frames[i+1].time-x.time:hold);
  return {version:1,scope:'development-motion-preview',visualQuality:'unverified',clipId,path:file,width:1,height:1,encodedFrames:frames.length,frames:frames.map((x,i)=>({path:'frame'+i+'.png',time:x.time,sha256:captures[i].sha256})),captures,durationsSeconds:durations,timingMode:'bounded-rational',maxDurationErrorSeconds:.000001,finalHoldPolicy:'explicit-seconds',timing:durations.map(x=>({requestedDurationSeconds:x,numerator:x*16,denominator:16,representedDurationSeconds:x,errorSeconds:0})),cumulativePlaybackErrorSeconds:0,sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
 };
 return f;
}
test('normal rendered jobs publish cached motion previews and source-free resume rehydrates paths',async t=>{
 const f=await motionFixture(t),result=await buildCharacter(f.spec,f.options);
 assert.equal(result.motionPreviews.status,'completed');assert.equal(result.motionPreviews.visualQuality,'unverified');assert.equal(result.motionPreviews.clips[0].sampling.times.length,3);assert.ok((await fs.stat(result.motionPreviews.clips[0].path)).isFile());
 const stage=result.manifest.stages['motion-previews'],stored=JSON.parse(await fs.readFile(path.join(f.options.jobRoot,stage.directory,'motion-previews.json'),'utf8'));
 assert.equal(path.isAbsolute(stored.clips[0].path),false);assert.equal(stage.artifacts.some(a=>a.path.endsWith('.png')),true);assert.equal(path.relative(result.project,result.motionPreviews.clips[0].path).startsWith('..'),true);
 await fs.rm(f.source,{recursive:true});const resumed=await resumeCharacter(f.options.jobRoot,f.options);assert.equal(resumed.motionPreviews.clips[0].path,result.motionPreviews.clips[0].path);assert.equal(f.motionCalls,1);assert.equal(f.counts.rig,1);
 const config={...f.options.config,tools:{megadot:{executable:process.execPath}}};let exportedFiles;
 await require('../lib/delivery').exportCharacter(f.options.jobRoot,{config,namespace:'motion_fixture'}, {resumeCharacter:async()=>resumed,exportGodotPack:async({plan,stagingParent})=>{
  exportedFiles=plan.files.map(file=>file.path);const pack=path.join(stagingParent,'fixture.pck'),bytes=Buffer.from('GDPCmotion runtime fixture');await fs.writeFile(pack,bytes);return {pack,bytes:bytes.length,hash:require('node:crypto').createHash('sha256').update(bytes).digest('hex'),rootScene:'res://'+plan.rootScene,sizeReport:{}};
 }});
 assert.deepEqual(exportedFiles,['motion_fixture/character.tscn']);
});
test('motion preview failure retries only failed stage and rejects mismatched clip/frame/timing/hash reports',async t=>{
 const f=await motionFixture(t),create=f.options.createMotionPreview;let first=true;
 f.options.createMotionPreview=async(...args)=>{if(first){first=false;throw Object.assign(new Error('motion fixture failure'),{code:'MOTION_PREVIEW_FAILED'});}return create(...args);};
 await assert.rejects(()=>buildCharacter(f.spec,f.options),{code:'MOTION_PREVIEW_FAILED'});const result=await resumeCharacter(f.options.jobRoot,f.options);assert.equal(result.motionPreviews.clips.length,1);assert.equal(f.counts.rig,1);
 for(const change of [r=>{r.clipId='wrong';},r=>{r.captures[0].time=.01;},r=>{r.timing[0].errorSeconds=1;},r=>{r.sha256='0'.repeat(64);},r=>{r.path=path.join(f.root,'missing.png');}]){
  const g=await motionFixture(t),run=g.options.createMotionPreview;g.options.createMotionPreview=async(...args)=>{const r=await run(...args);change(r);return r;};await assert.rejects(()=>buildCharacter(g.spec,g.options),{code:'VALIDATION_FAILED'});
 }
});
test('motion plan metadata cannot contradict captured frame mapping and no clips are honestly not applicable',async t=>{
 const f=await motionFixture(t),compile=f.options.compileGodot;f.options.compileGodot=async(...args)=>{const r=await compile(...args);r.validation.samples[0].time=.01;return r;};await assert.rejects(()=>buildCharacter(f.spec,f.options),{code:'VALIDATION_FAILED'});assert.equal(f.motionCalls,0);
 const empty=await fixture(t),result=await buildCharacter(empty.spec,empty.options);assert.deepEqual(result.motionPreviews,{version:1,status:'not-applicable',scope:'development-motion-preview',visualQuality:'unverified',reason:'no-authored-clips',clips:[]});
});

test('changing one source rebuilds only its artwork and dependent rig; resume uses captured sources', async t => {
  const f = await fixture(t);
  await buildCharacter(f.spec, f.options);
  await fs.writeFile(path.join(f.source, 'arm.png'), 'updated arm');
  await buildCharacter(f.spec, f.options);
  assert.deepEqual(f.counts, {
    arm: 2,
    body: 1,
    rig: 2
  });
  await fs.rm(f.source, {
    recursive: true
  });
  await resumeCharacter(f.options.jobRoot, f.options);
  assert.deepEqual(f.counts, {
    arm: 2,
    body: 1,
    rig: 2
  });
});
test('a failed backend preserves prepared stages and resume retries only the backend', async t => {
  const f = await fixture(t);
  const compile = f.options.compileGodot;
  await assert.rejects(buildCharacter(f.spec, {
    ...f.options,
    compileGodot: async () => {
      throw Object.assign(new Error('native test failure'), {
        code: 'GODOT_FAILED'
      });
    }
  }), {
    code: 'GODOT_FAILED'
  });
  await resumeCharacter(f.options.jobRoot, {
    ...f.options,
    compileGodot: compile
  });
  assert.deepEqual(f.counts, {
    arm: 1,
    body: 1,
    rig: 1
  });
});
test('corrupt prepared outputs invalidate dependent artifacts while unrelated parts remain cached', async t => {
  const f = await fixture(t);
  const result = await buildCharacter(f.spec, f.options);
  const stage = Object.values(result.manifest.stages).find(s => s.artifacts.some(a => a.path === 'arm.png'));
  await fs.writeFile(path.join(f.options.jobRoot, stage.directory, 'arm.png'), 'corrupted');
  await resumeCharacter(f.options.jobRoot, f.options);
  assert.deepEqual(f.counts, {
    arm: 2,
    body: 1,
    rig: 2
  });
});
test('STS2 tree jobs use the normal artwork approval and source-free resume pipeline', async t => {
  const f=await fixture(t);f.spec.export={...f.spec.export,target:'sts2',playback:'tree'};
  f.options.reviewArtwork=async()=>({approved:false,status:'awaiting_artwork_approval'});
  const waiting=await buildCharacter(f.spec,f.options);
  assert.equal(waiting.status,'awaiting_artwork_approval');
  assert.deepEqual(f.counts,{arm:0,body:0,rig:0});
  await fs.rm(f.source,{recursive:true});
  f.options.reviewArtwork=async()=>({approved:true});
  const resumed=await resumeCharacter(f.options.jobRoot,f.options);
  assert.equal(resumed.status,'completed');assert.equal(resumed.manifest.context.spec.export.target,'sts2');
  assert.equal(resumed.manifest.context.spec.export.playback,'tree');assert.deepEqual(f.counts,{arm:1,body:1,rig:1});
});

test('unsupported export, invalid roots, cancellation and missing native tools fail explicitly', async t => {
  const f = await fixture(t);
  const invalid = structuredClone(f.spec);
  invalid.export.target = 'sts2';
  await assert.rejects(buildCharacter(invalid, f.options), {
    code: 'CAPABILITY_MISSING'
  });
  await assert.rejects(buildCharacter(f.spec, {
    ...f.options,
    jobRoot: path.join(f.root, '..', 'escape')
  }), {
    code: 'UNSAFE_PATH'
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(buildCharacter(f.spec, {
    ...f.options,
    signal: controller.signal
  }), {
    code: 'ABORTED'
  });
  await assert.rejects(buildCharacter(f.spec, {
    ...f.options,
    toolVersions: undefined
  }), {
    code: 'CAPABILITY_MISSING'
  });
});
test('storage quota includes immutable inputs and preserves an explicit zero limit', async t => {
  const f = await fixture(t);
  const zero = {
    ...f.options,
    config: {
      ...f.options.config,
      limits: {
        maxStorageBytes: 0
      }
    }
  };
  await assert.rejects(buildCharacter(f.spec, zero), {
    code: 'QUOTA_EXCEEDED'
  });
  assert.deepEqual(f.counts, {
    arm: 0,
    body: 0,
    rig: 0
  });
  const first = await buildCharacter(f.spec, f.options);
  async function size(dir) {
    let total = 0;
    for (const entry of await fs.readdir(dir, {
      withFileTypes: true
    })) {
      const file = path.join(dir, entry.name);
      total += entry.isDirectory() ? await size(file) : (await fs.stat(file)).size;
    }
    return total;
  }
  const prior = await size(path.join(first.jobRoot, 'sources'));
  const outputs = await size(path.join(first.jobRoot, 'outputs'));
  await fs.writeFile(path.join(f.source, 'arm.png'), 'new source that must not be captured');
  const limited = {
    ...f.options,
    config: {
      ...f.options.config,
      limits: {
        maxStorageBytes: prior + outputs
      }
    }
  };
  await assert.rejects(buildCharacter(f.spec, limited), {
    code: 'QUOTA_EXCEEDED'
  });
  assert.equal(await size(path.join(first.jobRoot, 'sources')), prior);
  assert.deepEqual(f.counts, {
    arm: 1,
    body: 1,
    rig: 1
  });
});
test('source publication waits for exclusive job ownership and stage zero quota is honored', async t => {
  const f = await fixture(t);
  const {
    openJob
  } = require('../lib/jobs');
  const owner = await openJob(f.options.jobRoot, {
    spec: f.spec
  });
  try {
    await assert.rejects(buildCharacter(f.spec, f.options), {
      code: 'JOB_LOCKED'
    });
    await assert.rejects(fs.stat(path.join(f.options.jobRoot, 'sources')), {
      code: 'ENOENT'
    });
  } finally {
    await owner.close();
  }
  const limited = {
    ...f.options,
    config: {
      ...f.options.config,
      limits: {
        maxStageBytes: 0
      }
    }
  };
  await assert.rejects(buildCharacter(f.spec, limited), {
    code: 'QUOTA_EXCEEDED'
  });
  assert.equal(f.counts.rig, 0);
});
test('rebuilding a prepared part does not require its already-applied mask or original archive', async t => {
  const f = await fixture(t);
  const first = await buildCharacter(f.spec, f.options);
  const records = await Promise.all(Object.values(first.manifest.stages).filter(s => s.artifacts.some(a => a.path === 'prepared-part.json')).map(async s => {
    const record = JSON.parse(await fs.readFile(path.join(first.jobRoot, s.directory, 'prepared-part.json'), 'utf8'));
    record.part.image.path = path.join(first.jobRoot, s.directory, record.part.image.path);
    record.part.mask = {
      path: path.join(f.source, 'no-longer-required-mask.png')
    };
    return record.part;
  }));
  const spec = {
    ...f.spec,
    parts: records,
    artwork: {
      provider: 'layered',
      source: path.join(f.source, 'no-longer-required.ora')
    }
  };
  const result = await buildCharacter(spec, {
    ...f.options,
    config: {
      ...f.options.config,
      sourceRoots: [f.root]
    },
    jobRoot: path.join(f.root, 'reimport')
  });
  assert.equal(result.valid, true);
});
test('build and resume wait for original artwork approval before preparation and invalidate changed art', async t => {
  const f = await fixture(t);
  const {
    createArtworkReview,
    approveArtwork
  } = require('../lib/artwork-review');
  f.options.config.tools.python = {
    executable: process.execPath
  };
  f.options.reviewArtwork = async args => createArtworkReview({
    ...args,
    runTool: async (registry, name, argv) => {
      const request = JSON.parse(await fs.readFile(argv[1], 'utf8'));
      await fs.mkdir(request.outputDirectory, {
        recursive: true
      });
      const file = path.join(request.outputDirectory, 'original.png');
      await fs.writeFile(file, Buffer.from('89504e470d0a1a0a', 'hex'));
      return {
        exitCode: 0,
        error: null,
        stdout: JSON.stringify({
          ok: true,
          image: {
            path: file,
            width: 1,
            height: 1
          }
        })
      };
    }
  });
  const pending = await buildCharacter(f.spec, f.options);
  assert.equal(pending.status, 'awaiting_artwork_approval');
  assert.equal(pending.complete, false);
  assert.equal(Object.keys(pending.manifest.stages).length, 0);
  assert.deepEqual(f.counts, {
    arm: 0,
    body: 0,
    rig: 0
  });
  assert.equal((await resumeCharacter(f.options.jobRoot, f.options)).status, pending.status);
  await approveArtwork(f.options.jobRoot, {
    config: f.options.config,
    reviewId: pending.reviewId
  });
  assert.equal((await resumeCharacter(f.options.jobRoot, f.options)).valid, true);
  configureMotionFixture(f);
  f.spec.animations.push({
    id: 'idle',
    duration: 1,
    loop: true,
    tracks: [],
    events: []
  });
  assert.equal((await buildCharacter(f.spec, f.options)).valid, true);
  await fs.writeFile(path.join(f.source, 'arm.png'), 'revised original art');
  const changed = await buildCharacter(f.spec, f.options);
  assert.equal(changed.status, 'awaiting_artwork_approval');
  assert.notEqual(changed.reviewId, pending.reviewId);
  assert.deepEqual(f.counts, {
    arm: 1,
    body: 1,
    rig: 2
  });
});
test('generated original concept reaches approval before any part generation', async t => {
  const f = await fixture(t);
  f.spec.artwork = {
    provider: 'comfyui',
    prompt: 'fixture concept',
    seed: 1
  };
  let concepts = 0;
  const {
    publishSource
  } = require('../lib/assets');
  const options = {
    ...f.options,
    materializeConcept: async (spec, context) => {
      concepts++;
      const saved = await publishSource(f.source, 'arm.png', context.jobRoot);
      return {
        path: saved.path,
        record: {
          relative: 'sources/' + saved.hash,
          hash: saved.hash,
          size: saved.size
        }
      };
    },
    reviewArtwork: async ({
      inputs
    }) => {
      assert.ok(inputs['@concept']);
      return {
        approved: false,
        status: 'awaiting_artwork_approval',
        complete: false,
        reviewId: 'fixture'
      };
    }
  };
  const waiting = await buildCharacter(f.spec, options);
  assert.equal(waiting.status, 'awaiting_artwork_approval');
  assert.equal(concepts, 1);
  assert.deepEqual(f.counts, {
    arm: 0,
    body: 0,
    rig: 0
  });
  await resumeCharacter(f.options.jobRoot, options);
  assert.equal(concepts, 1, 'Resume reuses immutable original concept');
  const prepare = options.prepareArtwork;
  const approved = await resumeCharacter(f.options.jobRoot, {
    ...options,
    reviewArtwork: async () => ({
      approved: true
    }),
    prepareArtwork: async (spec, context) => {
      assert.equal(context.concept.approved, true);
      assert.ok(context.concept.path.startsWith(f.options.jobRoot));
      return prepare(spec, context);
    }
  });
  assert.equal(approved.valid, true);
});
test('approved generated part caches bind style, canvas, description and model settings but preserve rig-only edits', async t => {
  const f = await fixture(t);
  f.spec.artwork = {
    provider: 'comfyui',
    source: path.join(f.source, 'body.png'),
    prompt: 'fixture concept',
    seed: 1
  };
  const {
    publishSource
  } = require('../lib/assets');
  const options = {
    ...f.options,
    materializeConcept: async (spec, context) => {
      const saved = await publishSource(f.source, 'body.png', context.jobRoot);
      return {
        path: saved.path,
        record: {
          relative: 'sources/' + saved.hash,
          hash: saved.hash,
          size: saved.size
        }
      };
    }
  };
  await buildCharacter(f.spec, options);
  f.spec.style.shading = 'flat';
  await buildCharacter(f.spec, options);
  assert.deepEqual(f.counts, {
    arm: 2,
    body: 2,
    rig: 2
  });
  f.spec.canvas.width += 64;
  await buildCharacter(f.spec, options);
  f.spec.description = 'changed generation description';
  await buildCharacter(f.spec, options);
  options.config.comfyui = {
    checkpoint: 'changed-model'
  };
  await buildCharacter(f.spec, options);
  assert.deepEqual(f.counts, {
    arm: 5,
    body: 5,
    rig: 5
  });
  f.spec.bones[0].rest.position = [5, 0];
  await buildCharacter(f.spec, options);
  assert.deepEqual(f.counts, {
    arm: 5,
    body: 5,
    rig: 6
  });
});
test('generated part caches bind character identity while supplied artwork caches remain reusable', async t => {
  const f = await fixture(t);
  f.spec.artwork = { provider: 'comfyui', source: path.join(f.source, 'body.png'), seed: 1 };
  for (const part of f.spec.parts) delete part.image;
  const {publishSource, hashValue} = require('../lib/assets');
  const seeds = [];
  const prepare = f.options.prepareArtwork;
  f.options.materializeConcept = async (spec, context) => {
    const saved = await publishSource(f.source, 'body.png', context.jobRoot);
    return {path:saved.path,record:{relative:'sources/'+saved.hash,hash:saved.hash,size:saved.size}};
  };
  f.options.prepareArtwork = async (spec, context) => {
    // Match the production generated provider's deterministic per-character seed.
    seeds.push(Number.parseInt(hashValue({seed:spec.artwork.seed ?? 0,character:spec.id,part:context.partIds[0]}).slice(0,12),16));
    assert.equal(spec.parts.find(part=>part.id===context.partIds[0]).image,undefined);
    const supplied = structuredClone(spec);
    supplied.parts.find(part=>part.id===context.partIds[0]).image = {path:context.concept.path};
    return prepare(supplied,context);
  };
  await buildCharacter(f.spec,f.options);
  const initialSeeds = [...seeds];
  await buildCharacter(f.spec,f.options);
  assert.deepEqual(f.counts,{arm:1,body:1,rig:1});
  f.spec.id = 'revisedIdentity';
  await buildCharacter(f.spec,f.options);
  assert.deepEqual(f.counts,{arm:2,body:2,rig:2});
  assert.notDeepEqual(seeds.slice(2),initialSeeds);
  await fs.rm(f.source,{recursive:true});
  await resumeCharacter(f.options.jobRoot,f.options);
  assert.deepEqual(f.counts,{arm:2,body:2,rig:2});

  const existing = await fixture(t);
  await buildCharacter(existing.spec,existing.options);
  existing.spec.id = 'suppliedIdentity';
  await buildCharacter(existing.spec,existing.options);
  assert.deepEqual(existing.counts,{arm:1,body:1,rig:2});
});

test('rig metadata edits reuse artwork and rebase current mesh through cached registration', async t => {
  const f = await fixture(t);
  const prepare = f.options.prepareArtwork;
  f.options.prepareArtwork = async (...args) => {
    const result = await prepare(...args);
    result.parts[0].transform = {
      scale: 2,
      translation: [-2, -4]
    };
    result.parts[0].layerOffset = [3, 5];
    return result;
  };
  const compile = f.options.compileGodot;
  let compiled;
  f.options.compileGodot = async (input, options) => {
    compiled = structuredClone(input);
    return compile(input, options);
  };
  await buildCharacter(f.spec, f.options);
  f.spec.bones.push({
    id: 'other',
    parent: 'root',
    rest: {
      position: [2, 3],
      rotation: 0,
      scale: [1, 1]
    },
    length: 10
  });
  const arm = f.spec.parts[0];
  arm.bone = 'other';
  arm.layer = 8;
  arm.mesh = {
    vertices: [[4, 6], [6, 6], [4, 8]],
    uv: [[4, 6], [6, 6], [4, 8]],
    triangles: [[0, 1, 2]],
    weights: Array.from({
      length: 3
    }, () => [{
      bone: 'root',
      weight: 1
    }])
  };
  await buildCharacter(f.spec, f.options);
  assert.deepEqual(f.counts, {
    arm: 1,
    body: 1,
    rig: 2
  });
  assert.equal(compiled.parts[0].bone, 'other');
  assert.equal(compiled.parts[0].layer, 8);
  assert.deepEqual(compiled.parts[0].mesh.vertices, [[0, -2], [4, -2], [0, 2]]);
  assert.deepEqual(compiled.parts[0].mesh.uv, [[0, -2], [4, -2], [0, 2]]);
  delete arm.mesh;
  delete arm.skinning;
  await buildCharacter(f.spec, f.options);
  assert.equal(compiled.parts[0].mesh, undefined);
  assert.equal(compiled.parts[0].skinning, undefined);
  assert.deepEqual(f.counts, {
    arm: 1,
    body: 1,
    rig: 3
  });
});
test('art-relevant pivot, role and image metadata edits invalidate only that preparation', async t => {
  const f = await fixture(t);
  await buildCharacter(f.spec, f.options);
  for (const edit of [p => p.pivot = [2, 1], p => p.role = 'hand', p => p.image.pixelsPerUnit = 2]) {
    edit(f.spec.parts[0]);
    await buildCharacter(f.spec, f.options);
  }
  assert.deepEqual(f.counts, {
    arm: 4,
    body: 1,
    rig: 4
  });
});
test('raw mesh uses cached crop without layer offset and rejects missing transform provenance', async t => {
  const f = await fixture(t);
  const compile = f.options.compileGodot;
  let compiled;
  f.options.compileGodot = async (input, options) => {
    compiled = input;
    return compile(input, options);
  };
  await buildCharacter(f.spec, f.options);
  f.spec.parts[0].mesh = {
    vertices: [[0, 0], [2, 0], [0, 2]],
    uv: [[0, 0], [2, 0], [0, 2]],
    triangles: [[0, 1, 2]],
    weights: Array.from({
      length: 3
    }, () => [{
      bone: 'root',
      weight: 1
    }])
  };
  await buildCharacter(f.spec, f.options);
  assert.deepEqual(compiled.parts[0].mesh.vertices, [[0, 0], [2, 0], [0, 2]]);
  assert.equal(f.counts.arm, 1);
  const g = await fixture(t);
  const prepare = g.options.prepareArtwork;
  g.options.prepareArtwork = async (...args) => {
    const r = await prepare(...args);
    delete r.parts[0].transform;
    return r;
  };
  await buildCharacter(g.spec, g.options);
  g.spec.parts[0].mesh = structuredClone(f.spec.parts[0].mesh);
  await assert.rejects(buildCharacter(g.spec, g.options), {
    code: 'INVALID_MANIFEST'
  });
  assert.equal(g.counts.arm, 1);
});

test('procedural skinning is rebuilt from cached artwork after rig-only edits', async t => {
  const f = await fixture(t);
  const compile = f.options.compileGodot;
  let compiled;
  f.options.compileGodot = async (input, options) => { compiled = structuredClone(input); return compile(input, options); };
  f.spec.bones.push({id:'tip',parent:'root',rest:{position:[3,0],rotation:0,scale:[1,1]},length:2});
  f.spec.parts[0].skinning = {bones:['root','tip'],axis:'x',segments:2};
  await buildCharacter(f.spec, f.options);
  assert.equal(compiled.parts[0].mesh.vertices.length, 6);
  assert.deepEqual(compiled.parts[0].mesh.weights[0].map(w=>w.weight),[1,0]);
  const before = structuredClone(compiled.parts[0].mesh.weights);
  f.spec.bones[1].rest.position=[0,3];
  await buildCharacter(f.spec, f.options);
  assert.deepEqual(f.counts,{arm:1,body:1,rig:2});
  assert.notDeepEqual(compiled.parts[0].mesh.weights,before);
});
test('sound inputs are captured immutably and invalidate only the compiled rig',async t=>{
  const f=await fixture(t);const sound=path.join(f.root,'inputs','cue.wav');
  await fs.writeFile(sound,'test sound bytes');f.spec.sounds=[{id:'cue',path:sound}];
  const compile=f.options.compileGodot;let compiled;
  f.options.compileGodot=async(input,options)=>{compiled=structuredClone(input);return compile(input,options);};
  await buildCharacter(f.spec,f.options);
  assert.notEqual(compiled.sounds[0].path,sound);
  assert.equal(await fs.readFile(compiled.sounds[0].path,'utf8'),'test sound bytes');
  await fs.writeFile(sound,'updated sound bytes');
  await buildCharacter(f.spec,f.options);
  assert.deepEqual(f.counts,{arm:1,body:1,rig:2});
  assert.equal(await fs.readFile(compiled.sounds[0].path,'utf8'),'updated sound bytes');
  await fs.rm(sound);await resumeCharacter(f.options.jobRoot,f.options);
  assert.deepEqual(f.counts,{arm:1,body:1,rig:2});
});

test('approved components compile once before parent and resume without original sources', async t => {
 const f=await fixture(t), dir=f.options.config.sourceRoots[0];
 const child=createSpec({id:'childDefinition',description:'child',template:'custom'});
 child.parts=[structuredClone(f.spec.parts[0])];
 child.parts[0].image.path=path.join(dir,'child.png');await fs.writeFile(child.parts[0].image.path,'child version one');
 const source=path.join(dir,'child.json');await fs.writeFile(source,JSON.stringify(child));
 f.spec.sockets=[{id:'socket',bone:'root',transform:{position:[0,0],rotation:0,scale:[1,1]},types:['arm'],capacity:2,inheritance:{position:true,rotation:true,scale:true}}];
 f.spec.components=[{id:'left',socket:'socket',type:'arm',spec:source},{id:'right',socket:'socket',type:'arm',spec:source}];
 f.spec.sockets[0].layer=0;f.spec.sockets[0].envelope=[child.canvas.width,child.canvas.height];
 f.spec.assembly={version:1,styleHash:require('../lib/assets').hashValue(f.spec.style),eventNames:[],descriptors:[{version:1,type:'arm',spec:'child.json',mount:{position:[0,0],rotation:0,scale:[1,1]},dimensions:[child.canvas.width,child.canvas.height],styleHash:require('../lib/assets').hashValue(child.style),eventNames:[],layer:0,inheritance:{position:true,rotation:true,scale:true}}]};
 const calls=[],compile=f.options.compileGodot;
 f.options.compileGodot=async (spec,options)=>{calls.push(spec.id);if(spec.id==='fixture')assert.ok(options.componentProjects.childDefinition);return compile(spec,options);};
 await buildCharacter(f.spec,f.options);
 assert.deepEqual(calls,['childDefinition','fixture']);
 const mounted=f.spec.components;f.spec.components=[];
 const emptyCounts={...f.counts};await buildCharacter(f.spec,f.options);
 assert.equal(f.counts.arm,emptyCounts.arm);assert.equal(f.counts.body,emptyCounts.body);
 f.spec.components=mounted;
 const before={...f.counts};await fs.writeFile(child.parts[0].image.path,'child version two');
 await buildCharacter(f.spec,f.options);
 assert.equal(f.counts.body,before.body);assert.equal(f.counts.arm,before.arm+1);
 assert.deepEqual(calls,['childDefinition','fixture','fixture','childDefinition','fixture']);
 await fs.rm(child.parts[0].image.path);
 await fs.rm(source);await fs.rm(path.join(dir,'arm.png'));await fs.rm(path.join(dir,'body.png'));
 await resumeCharacter(f.options.jobRoot,f.options);
 assert.deepEqual(calls,['childDefinition','fixture','fixture','childDefinition','fixture']);
});

test('unseen child generated original is materialized for explicit review before preparation',async t=>{
 const f=await fixture(t),dir=f.options.config.sourceRoots[0];
 const child=createSpec({id:'generatedChild',description:'child concept',template:'custom'});
 child.parts=[structuredClone(f.spec.parts[0])];child.artwork.provider='comfyui';
 const source=path.join(dir,'child.json');await fs.writeFile(source,JSON.stringify(child));
 f.spec.sockets=[{id:'socket',bone:'root',transform:{position:[0,0],rotation:0,scale:[1,1]},types:['arm'],capacity:1,inheritance:{position:true,rotation:true,scale:true}}];
 f.spec.components=[{id:'left',socket:'socket',type:'arm',spec:source}];
 let materialized=0;
 f.options.materializeConcept=async(spec,{jobRoot})=>{
  materialized++;assert.equal(spec.id,'generatedChild');
  const bytes=Buffer.from('synthetic unseen child concept'),hash=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const file=path.join(jobRoot,'sources',hash);await fs.writeFile(file,bytes);
  return {path:file,record:{relative:'sources/'+hash,hash,size:bytes.length}};
 };
 f.options.reviewArtwork=async({componentArtwork,inputs})=>{
  assert.equal(componentArtwork[0].content.originals.some(r=>r.hash===inputs['@concept:generatedChild'].hash),true);
  return {approved:false,status:'awaiting_artwork_approval'};
 };
 assert.equal((await buildCharacter(f.spec,f.options)).status,'awaiting_artwork_approval');
 assert.deepEqual(f.counts,{arm:0,body:0,rig:0});assert.equal(materialized,1);
 await fs.rm(source);await resumeCharacter(f.options.jobRoot,f.options);assert.equal(materialized,1);
});

test('unrelated generated and background runtime versions preserve existing artwork caches',async t=>{
 const f=await fixture(t);await buildCharacter(f.spec,f.options);
 f.options.versions={...f.options.versions,generation:'added-generated-child-runtime',backgroundModel:'added-background-child-model'};
 await buildCharacter(f.spec,f.options);
 assert.deepEqual(f.counts,{arm:1,body:1,rig:1});
});

test('compiled rig version fingerprints every emitted assembly runtime and planner dependency',async t=>{
 const f=await fixture(t);delete f.options.versions;
 const result=await buildCharacter(f.spec,f.options);
 const {hashValue,hashFile}=require('../lib/assets');
 const files=['lib/overlap-planning.js','lib/native-skinning.js','lib/motion-registration.js','lib/authored-geometry.js','lib/compile-repair.js','lib/repair.js','lib/repair-operators.js','lib/visual-inspection.js','lib/effect-animation.js','lib/motion-sampling.js','lib/render-layout.js','lib/validation.js','godot/telemetry.gd','backends/godot.js','godot/compile.gd','godot/limited_bone.gd','godot/animation_controller.gd','godot/pose_controller.gd','godot/audio_controller.gd','godot/action_controller.gd','godot/visual_state_controller.gd','godot/assembly_controller.gd','godot/component_controller.gd','godot/assembly_planner.gd','godot/state_reconciler.gd','godot/assembly_transport.gd','godot/effect_scene_controller.gd','godot/effect_rule_controller.gd','godot/effect_controller.gd','godot/impact_controller.gd','godot/texture_storage.gd','lib/components.js','lib/state.js','lib/rig.js','lib/audio.js','lib/audio-format.js','workers/audio.py'];
 assert.equal(result.manifest.context.versions.godot,hashValue(await Promise.all(files.map(async file=>({file,hash:await hashFile(path.join(__dirname,'..',file))})))));
 const previewFiles=['lib/assembly-preview.js','lib/assembly-preview-planning.js','lib/audio-eligibility.js','lib/native-audio-resources.js','godot/inspect_audio_resources.gd','lib/export.js','lib/windows-tool-lock.ps1','lib/runtime-manifest.js','godot/preview_assembly.gd','adapters/godot.js','lib/assets.js','lib/render-layout.js','lib/components.js','lib/state.js','lib/spec.js','lib/rig.js','schema/character.schema.json','library/rigs/humanoid.json','library/rigs/mechanical.json','library/rigs/quadruped_or_multilimb.json','lib/visual-inspection.js','lib/motion-preview.js','lib/process.js','lib/native-launch.js','workers/visual.py','workers/motion.py','workers/images.py'];
 assert.equal(result.manifest.context.versions.assemblyPreview,hashValue(await Promise.all(previewFiles.map(async file=>({file,hash:await hashFile(path.join(__dirname,'..',file))})))));
});

test('native component socket bound rejects before preparation while excluding unrelated sockets',async t=>{
 const f=await fixture(t),dir=f.options.config.sourceRoots[0],child=createSpec({id:'child',description:'bounded assembly',template:'custom'});
 child.parts=[structuredClone(f.spec.parts[0])];await fs.writeFile(path.join(dir,'child.json'),JSON.stringify(child));
 const inheritance={position:true,rotation:true,scale:true},styleHash=require('../lib/assets').hashValue(f.spec.style);
 f.spec.assembly={version:1,styleHash,eventNames:[],descriptors:[{version:1,type:'arm',spec:'child.json',mount:{position:[0,0],rotation:0,scale:[1,1]},dimensions:[child.canvas.width,child.canvas.height],styleHash,eventNames:[],layer:0,inheritance:{...inheritance}}]};
 f.spec.sockets=Array.from({length:65},(_,i)=>({id:'socket'+i,bone:'root',types:['arm'],capacity:1,inheritance:{...inheritance},layer:0,envelope:[512,512],transform:{position:[i,0],rotation:0,scale:[1,1]}}));
 await assert.rejects(buildCharacter(f.spec,f.options),{code:'INVALID_COMPONENT'});
 assert.deepEqual(f.counts,{arm:0,body:0,rig:0});
 f.spec.sockets[64].types=['bowOnly'];
 assert.equal((await buildCharacter(f.spec,f.options)).valid,true);
});

async function effectFixture(f,outcome='none'){
 const root=path.join(f.source,'mechanics');await fs.mkdir(root);const source=path.join(root,'Power.cs');await fs.writeFile(source,'class Power {}');
 f.options.config.mechanics={sourceRoots:[root]};
 const inventory=await require('../lib/mechanics').inspectMechanics({characterId:f.spec.id,sourceRoots:[root],mechanics:[{key:'mod.Power',modId:'mod',modelSymbol:'Power',evidence:[{path:source,symbol:'Power',lineStart:1,lineEnd:1}]}]});
 const decision={id:'power',mechanicKey:'mod.Power',outcome,reason:'Synthetic decision',evidenceIds:inventory.mechanics[0].evidenceIds};
 if(outcome==='effect')Object.assign(decision,{bindingId:'power',rule:{effectIds:['green'],condition:{type:'present'},scope:'whileActive',socketId:'tip',channel:'tip',priority:1}});
 const plan={version:1,characterId:f.spec.id,mechanicsFingerprint:inventory.fingerprint,inspectionVersion:'1',adapterContractVersion:'synthetic',evidence:inventory.evidence,decisions:[decision]};
 const planPath=path.join(f.source,'effects.json'),inventoryPath=path.join(f.source,'inventory.json');await fs.writeFile(planPath,JSON.stringify(plan));await fs.writeFile(inventoryPath,JSON.stringify(inventory));f.options.effectPlan={planPath,inventoryPath};return {source,plan,inventory,planPath,inventoryPath};
}
test('effect artifacts checkpoint under job ownership and preserve artwork approval/cache on resume',async t=>{
 const f=await fixture(t),e=await effectFixture(f);let reviewCalls=0;
 f.options.reviewArtwork=async()=>{reviewCalls++;return {approved:true};};
 const result=await buildCharacter(f.spec,f.options);assert.equal(result.effects.status,'validated');assert.equal(result.effectsIntegrationComplete,true);assert.ok(result.manifest.stages['effects-plan']);
 const stage=result.manifest.stages['effects-plan'];assert.ok(stage.artifacts.some(a=>a.path==='effects/plan.json'));assert.ok(result.manifest.stages.rig.deps.includes('effects-plan'));
 await fs.rm(e.planPath);await fs.rm(e.inventoryPath);
 delete f.options.effectPlan;
 const resumed=await resumeCharacter(f.options.jobRoot,f.options);assert.equal(resumed.effects.fingerprint,result.effects.fingerprint);assert.deepEqual(f.counts,{arm:1,body:1,rig:1});assert.equal(reviewCalls,2);
 await fs.writeFile(e.source,'class Power { int changed; }');await assert.rejects(resumeCharacter(f.options.jobRoot,f.options),{code:'STALE_EFFECT_PLAN'});assert.deepEqual(f.counts,{arm:1,body:1,rig:1});
});
test('requested positive effects never claim compiler integration when native catalog is unavailable',async t=>{
 const f=await fixture(t);await effectFixture(f,'effect');const result=await buildCharacter(f.spec,f.options);
 assert.equal(result.effects.status,'unresolved');assert.equal(result.effectsIntegrationComplete,false);assert.equal(result.effects.activated,false);assert.ok(result.effects.diagnostics.length);
});

test('accepted positive effects remain explicitly uninstalled and resource captures obey storage/corruption gates',async t=>{
 const f=await fixture(t);await effectFixture(f,'effect');const resource=path.join(f.source,'effect.png');await fs.writeFile(resource,'synthetic effect');
 const hash=await require('../lib/assets').hashFile(resource),styleHash=require('../lib/assets').hashValue(f.spec.style);
 f.options.effectCapabilities={version:'1',adapterContractVersion:'synthetic',gameFingerprint:'synthetic-game',baseLibFingerprint:'synthetic-baselib',bindings:[{id:'power',mechanicKey:'mod.Power',adapterContractVersion:'synthetic'}],sockets:['tip'],supportsEffect:()=>true,effects:[{id:'green',capability:'overlay',resources:[{path:resource,sha256:hash,importSettings:{},styleHash,approvalId:'synthetic-approval'}]}]};f.options.effectApproval=async()=>true;
 const result=await buildCharacter(f.spec,f.options);assert.equal(result.effects.status,'validated');assert.equal(result.effectsIntegrationComplete,false);assert.equal(result.effects.activated,false);assert.ok(result.effects.diagnostics.some(d=>d.code==='EFFECT_COMPILER_UNAVAILABLE'));
 const record=result.manifest.context.inputs[resource];await fs.writeFile(path.join(f.options.jobRoot,record.relative),'corrupted');
 await assert.rejects(resumeCharacter(f.options.jobRoot,f.options),{code:'CORRUPT_ARTIFACT'});
});
test('revised mechanic decisions invalidate dependent runtime while preserving prepared artwork',async t=>{
 const f=await fixture(t),e=await effectFixture(f);const first=await buildCharacter(f.spec,f.options);
 await fs.writeFile(e.source,'class Power { int Changed; }');
 const previous=e.inventory.mechanics[0],ev=e.inventory.evidence[0];
 const inventory=await require('../lib/mechanics').inspectMechanics({characterId:f.spec.id,sourceRoots:f.options.config.mechanics.sourceRoots,mechanics:[{key:previous.key,modId:previous.modId,modelSymbol:previous.modelSymbol,evidence:[{path:ev.path,symbol:ev.symbol,lineStart:ev.lineStart,lineEnd:ev.lineEnd}]}]});
 e.plan.mechanicsFingerprint=inventory.fingerprint;e.plan.evidence=inventory.evidence;e.plan.decisions[0].evidenceIds=inventory.mechanics[0].evidenceIds;
 await fs.writeFile(e.planPath,JSON.stringify(e.plan));await fs.writeFile(e.inventoryPath,JSON.stringify(inventory));
 const next=await buildCharacter(f.spec,f.options);assert.notEqual(next.effects.fingerprint,first.effects.fingerprint);assert.deepEqual(f.counts,{arm:1,body:1,rig:2});
});

test('effect source quota rejects before publishing excess bytes or preparing artwork',async t=>{
 const f=await fixture(t);const e=await effectFixture(f),effectPlan=f.options.effectPlan;delete f.options.effectPlan;
 await buildCharacter(f.spec,f.options);const {ownedStorage,hashFile}=require('../lib/assets');
 const before=await ownedStorage(f.options.jobRoot);f.options.effectPlan=effectPlan;f.options.config.limits={maxStorageBytes:before+1};
 await assert.rejects(buildCharacter(f.spec,f.options),{code:'QUOTA_EXCEEDED'});
 const sourceFile=path.join(f.options.jobRoot,'sources',await hashFile(e.planPath));await assert.rejects(fs.stat(sourceFile),{code:'ENOENT'});
 assert.deepEqual(f.counts,{arm:1,body:1,rig:1});assert.equal(await ownedStorage(f.options.jobRoot),before);
});

test('effect decisions produced in the configured output root can join an artwork build',async t=>{
 const f=await fixture(t),e=await effectFixture(f),out=f.options.config.outputRoot;
 const planPath=path.join(out,'effects.json'),inventoryPath=path.join(out,'inventory.json');
 await fs.copyFile(e.planPath,planPath);await fs.copyFile(e.inventoryPath,inventoryPath);f.options.effectPlan={planPath,inventoryPath};
 assert.equal((await buildCharacter(f.spec,f.options)).effects.status,'validated');
});

test('explicit resume effect artifacts replace same-path captures while ordinary resume retains them',async t=>{
 const f=await fixture(t),e=await effectFixture(f),first=await buildCharacter(f.spec,f.options);
 e.plan.decisions[0].reason='A revised explicit source decision';await fs.writeFile(e.planPath,JSON.stringify(e.plan));
 const explicit=await resumeCharacter(f.options.jobRoot,f.options);assert.notEqual(explicit.effects.fingerprint,first.effects.fingerprint);assert.deepEqual(f.counts,{arm:1,body:1,rig:2});
 delete f.options.effectPlan;await fs.rm(e.planPath);await fs.rm(e.inventoryPath);
 const ordinary=await resumeCharacter(f.options.jobRoot,f.options);assert.equal(ordinary.effects.fingerprint,explicit.effects.fingerprint);assert.deepEqual(f.counts,{arm:1,body:1,rig:2});
});

async function positiveEffectFixture(f){
 const e=await effectFixture(f,'effect'),resource=path.join(f.source,'effect.png');await fs.writeFile(resource,'synthetic effect');
 const hash=await require('../lib/assets').hashFile(resource),styleHash=require('../lib/assets').hashValue(f.spec.style);
 f.options.effectCapabilities={version:'1',adapterContractVersion:'synthetic',gameFingerprint:'synthetic-game',baseLibFingerprint:'synthetic-baselib',bindings:[{id:'power',mechanicKey:'mod.Power',adapterContractVersion:'synthetic'}],sockets:['tip'],supportsEffect:()=>true,effects:[{id:'green',capability:'overlay',presentation:{resourceHash:hash,offset:[0,0],scale:[1,1]},resources:[{path:resource,sha256:hash,importSettings:{},styleHash,approvalId:'synthetic-approval'}]}]};f.options.effectApproval=async()=>true;
 f.spec.sockets=[{id:'tip',bone:'root',types:['effectTarget'],capacity:1,inheritance:{position:true,rotation:true,scale:true},transform:{position:[0,0],rotation:0,scale:[1,1]}}];f.options.effectTargets={tip:{partId:'arm'}};
 return {...e,resource,hash};
}
test('impact captures survive engine projection and require native impact evidence before activation',async t=>{
 for(const verified of [false,true]){
  const f=await fixture(t),e=await positiveEffectFixture(f),compile=f.options.compileGodot;
  const impact={durationSeconds:.85,presentation:{resourceHash:e.hash,offset:[2,-3],scale:[1,1]}};
  f.options.effectCapabilities.effects[0].impact=structuredClone(impact);
  f.options.compileGodot=async(spec,options)=>{
   assert.deepEqual(options.effectBuild.catalog[0].impact,impact);
   const built=await compile(spec,options);
   built.validation.effects={configured:true,capabilities:['overlay'],resourceHashes:[e.hash],gameBindings:false,owner:'visual-test',...(verified?{impactConfigured:true,impactEffectIds:['green']}:{})};
   return built;
  };
  const result=await buildCharacter(f.spec,f.options);
  assert.equal(result.effects.activated,verified);
  assert.equal(result.effects.gameIntegrationComplete,false);
  assert.equal(result.effects.diagnostics.some(d=>d.code==='EFFECT_COMPILER_UNVERIFIED'),!verified);
 }
});

test('positive effects reach root compiler with exact verified captures and source-free resume stays cached',async t=>{
 const f=await fixture(t),e=await positiveEffectFixture(f),compile=f.options.compileGodot;let calls=0;
 f.options.compileGodot=async(spec,options)=>{calls++;assert.equal(options.effectBuild.plan.characterId,f.spec.id);assert.deepEqual(options.effectBuild.targets,f.options.effectTargets);assert.equal(options.effectBuild.catalog[0].presentation.resourceHash,e.hash);const built=await compile(spec,options);built.validation.effects={configured:true,capabilities:['overlay'],resourceHashes:[e.hash],gameBindings:false,owner:'visual-test'};return built;};
 const result=await buildCharacter(f.spec,f.options);delete f.options.effectPlan;assert.equal(result.effects.activated,true);assert.equal(result.effects.gameIntegrationComplete,false);assert.equal(result.effectsIntegrationComplete,false);
 await fs.rm(e.resource);await fs.rm(e.planPath);await fs.rm(e.inventoryPath);
 const resumed=await resumeCharacter(f.options.jobRoot,f.options);assert.equal(resumed.effects.activated,true);assert.equal(calls,1);assert.equal(resumed.effects.fingerprint,result.effects.fingerprint);
 assert.equal(f.options.effectCapabilities.effects[0].resources[0].path,e.resource);
 f.options.effectTargets={tip:{partId:'body'}};await resumeCharacter(f.options.jobRoot,f.options);assert.equal(calls,2);assert.deepEqual(f.counts,{arm:1,body:1,rig:2});
 f.options.effectCapabilities.effects[0].presentation.offset=[1,0];await resumeCharacter(f.options.jobRoot,f.options);assert.equal(calls,3);
 f.options.effectCapabilities.version='2';await resumeCharacter(f.options.jobRoot,f.options);assert.equal(calls,4);
 await fs.writeFile(e.source,'class Power { int Changed; }');await assert.rejects(resumeCharacter(f.options.jobRoot,f.options),{code:'STALE_EFFECT_PLAN'});
});
test('false compiler effect metadata cannot claim installed presentation',async t=>{
 const f=await fixture(t),e=await positiveEffectFixture(f),compile=f.options.compileGodot;
 f.options.compileGodot=async(spec,options)=>{assert.ok(options.effectBuild);const built=await compile(spec,options);built.validation.effects={configured:false,capabilities:['overlay'],resourceHashes:[e.hash],gameBindings:false,owner:'visual-test'};return built;};
 const result=await buildCharacter(f.spec,f.options);assert.equal(result.effects.activated,false);assert.ok(result.effects.diagnostics.some(d=>d.code==='EFFECT_COMPILER_UNVERIFIED'));
});

test('normal effect resume keeps captured resource originals while explicit replacement refreshes approved bytes',async t=>{
 const f=await fixture(t),e=await positiveEffectFixture(f),compile=f.options.compileGodot;let calls=0,approvals=0;
 f.options.effectApproval=async()=>{approvals++;return true;};
 f.options.compileGodot=async(spec,options)=>{calls++;const built=await compile(spec,options);if(options.effectBuild)built.validation.effects={configured:true,capabilities:['overlay'],resourceHashes:[options.effectBuild.resources[0].hash],gameBindings:false,owner:'visual-test'};return built;};
 await buildCharacter(f.spec,f.options);const replacement=f.options.effectPlan;delete f.options.effectPlan;
 await fs.writeFile(e.resource,'replacement synthetic effect');await resumeCharacter(f.options.jobRoot,f.options);assert.equal(calls,1);assert.equal(approvals,2);
 const hash=await require('../lib/assets').hashFile(e.resource);f.options.effectCapabilities.effects[0].resources[0].sha256=hash;f.options.effectCapabilities.effects[0].presentation.resourceHash=hash;
 const replaced=await resumeCharacter(f.options.jobRoot,{...f.options,effectPlan:replacement});assert.equal(calls,2);assert.equal(replaced.manifest.context.inputs[e.resource].hash,hash);assert.equal(replaced.effects.activated,true);
 f.options.effectApproval=async()=>false;const unapproved=await resumeCharacter(f.options.jobRoot,f.options);assert.equal(unapproved.effects.activated,false);assert.ok(unapproved.effects.diagnostics.some(d=>d.code==='ARTWORK_APPROVAL_REQUIRED'));
});


test('first-party presentation persists pure request and rehydrates capabilities on ordinary resume',async t=>{
 const f=await fixture(t),e=await effectFixture(f,'effect');e.plan.adapterContractVersion='1';await fs.writeFile(e.planPath,JSON.stringify(e.plan));
 f.spec.sockets=[{id:'tip',bone:'root',types:['effectTarget'],capacity:1,inheritance:{position:true,rotation:true,scale:true},transform:{position:[0,0],rotation:0,scale:[1,1]}}];
 const {publishSource}=require('../lib/assets'),{openJob}=require('../lib/jobs'),{createArtworkReview,approveArtwork}=require('../lib/artwork-review');
 const approved=path.join(f.options.config.outputRoot,'approved'),source=path.join(f.source,'body.png'),stored=await publishSource(f.source,'body.png',approved);
 const reviewSpec=structuredClone(f.spec);reviewSpec.parts=[reviewSpec.parts[1]];
 const inputs={[source]:{relative:'sources/'+stored.hash,hash:stored.hash,size:stored.size}},job=await openJob(approved,{spec:reviewSpec,inputs});const jobId=job.manifest.jobId;await job.close();
 f.options.config.tools.python={executable:process.execPath};
 const review=await createArtworkReview({jobRoot:approved,jobId,spec:reviewSpec,inputs,config:f.options.config,runTool:async(_,__,args)=>{const r=JSON.parse(await fs.readFile(args[1],'utf8'));await fs.mkdir(r.outputDirectory,{recursive:true});const output=path.join(r.outputDirectory,'original.png');await fs.writeFile(output,'synthetic preview');return {exitCode:0,stdout:JSON.stringify({ok:true,image:{path:output,width:1,height:1}})};}});await approveArtwork(approved,{config:f.options.config,reviewId:review.reviewId});
 const pe=Buffer.alloc(128);pe.write('MZ');pe.writeUInt32LE(64,60);pe.write('PE\0\0',64,'binary');for(const n of ['game.dll','base.dll'])await fs.writeFile(path.join(f.source,n),pe);
 f.options.effectPresentation={version:1,runtime:{gameAssembly:path.join(f.source,'game.dll'),baseLibAssembly:path.join(f.source,'base.dll')},resources:[{id:'original',job:'approved',reviewId:review.reviewId,sourceHash:stored.hash}],bindings:[{id:'power',mechanicKey:'mod.Power'}],effects:[{id:'green',capability:'tint',resourceId:'original',presentation:{color:[0,1,0,1]}}],targets:{tip:{partId:'body'}}};
 const result=await buildCharacter(f.spec,f.options);assert.equal(result.effects.status,'validated');assert.equal(result.effects.gameIntegrationComplete,false);assert.deepEqual(result.manifest.context.settings.effectPresentation,f.options.effectPresentation);assert.match(result.manifest.context.settings.effectCapturePolicy,/^[a-f0-9]{64}$/);
 const declaration=path.join(f.source,'presentation.json'),configuration=path.join(f.source,'tools.json');await fs.writeFile(declaration,JSON.stringify(f.options.effectPresentation));await fs.writeFile(configuration,JSON.stringify(f.options.config));
 const validated=require('node:child_process').spawnSync(process.execPath,[path.resolve(__dirname,'../cli.js'),'validate-effects',e.planPath,'--inventory',e.inventoryPath,'--effect-presentation',declaration,'--job',f.options.jobRoot,'--config',configuration],{encoding:'utf8',windowsHide:true});assert.equal(validated.status,0,validated.stdout+validated.stderr);assert.equal(JSON.parse(validated.stdout).result.valid,true);
 const cliMutation=path.join(f.source,'cli-mutation.cjs');await fs.writeFile(cliMutation,`const fs=require('node:fs/promises'),boundary=require(${JSON.stringify(path.resolve(__dirname,'../lib/effect-request.js'))}),original=boundary.captureEffectRequest;boundary.captureEffectRequest=async(...args)=>{const captured=await original(...args),file=${JSON.stringify(e.planPath)},plan=JSON.parse(await fs.readFile(file,'utf8'));plan.decisions[0].reason='Changed after CLI helper';await fs.writeFile(file,JSON.stringify(plan));return captured;};`);
 const mutated=require('node:child_process').spawnSync(process.execPath,['--require',cliMutation,path.resolve(__dirname,'../cli.js'),'validate-effects',e.planPath,'--inventory',e.inventoryPath,'--effect-presentation',declaration,'--job',f.options.jobRoot,'--config',configuration],{encoding:'utf8',windowsHide:true});assert.equal(JSON.parse(mutated.stdout).error?.code,'SOURCE_CHANGED',mutated.stdout+mutated.stderr);await fs.writeFile(e.planPath,JSON.stringify(e.plan));
 for(const root of [approved,f.options.jobRoot]){const released=await openJob(root);await released.close();}

 delete f.options.effectPlan;delete f.options.effectPresentation;await fs.rm(e.planPath);await fs.rm(e.inventoryPath);
 const resumed=await resumeCharacter(f.options.jobRoot,f.options);assert.equal(resumed.effects.fingerprint,result.effects.fingerprint);assert.deepEqual(f.counts,{arm:1,body:1,rig:1});
 const changed=structuredClone(result.manifest.context.settings.effectPresentation);changed.effects[0].presentation.color=[1,0,0,1];const updated=await resumeCharacter(f.options.jobRoot,{...f.options,effectPresentation:changed});assert.notEqual(updated.effects.fingerprint,result.effects.fingerprint);assert.deepEqual(f.counts,{arm:1,body:1,rig:2});
 await assert.rejects(buildCharacter(f.spec,{...f.options,effectPresentation:changed,effectCapabilities:{}}),{code:'INVALID_INPUT'});
 const none=structuredClone(e.plan);none.decisions=none.decisions.map(({bindingId,rule,...d})=>({...d,outcome:'none'}));await fs.writeFile(e.planPath,JSON.stringify(none));await fs.writeFile(e.inventoryPath,JSON.stringify(e.inventory));await fs.rm(changed.runtime.gameAssembly);await fs.rm(changed.runtime.baseLibAssembly);
 const inactive=await resumeCharacter(f.options.jobRoot,{...f.options,effectPlan:{planPath:e.planPath,inventoryPath:e.inventoryPath}});assert.equal(inactive.effects.status,'validated');assert.equal(inactive.effectsIntegrationComplete,true);assert.equal(inactive.effects.gameIntegrationComplete,false);
 const archived=approved+'-unused';await fs.rename(approved,archived);
 try{for(const outcome of ['none','unresolved']){
  const inactivePlan={...none,decisions:none.decisions.map(d=>({...d,outcome}))};await fs.writeFile(e.planPath,JSON.stringify(inactivePlan));
  const checked=require('node:child_process').spawnSync(process.execPath,[path.resolve(__dirname,'../cli.js'),'validate-effects',e.planPath,'--inventory',e.inventoryPath,'--effect-presentation',declaration,'--job',f.options.jobRoot,'--config',configuration],{encoding:'utf8',windowsHide:true});assert.equal(checked.status,0,checked.stdout+checked.stderr);const report=JSON.parse(checked.stdout).result;assert.equal(report.gameAcceptance,false);assert.equal(report.gameIntegrationComplete,false);assert.equal(report.valid,true);
  const held=await openJob(f.options.jobRoot);await held.close();
 }}finally{await fs.rename(archived,approved);}
 for(const n of ['game.dll','base.dll'])await fs.writeFile(path.join(f.source,n),pe);await fs.writeFile(e.planPath,JSON.stringify(e.plan));
 const boundary=require('../lib/effect-request'),captureRequest=boundary.captureEffectRequest;
 boundary.captureEffectRequest=async(...args)=>{const captured=await captureRequest(...args);await fs.writeFile(e.planPath,JSON.stringify({...e.plan,decisions:e.plan.decisions.map(d=>({...d,reason:'Changed between verified capture phases'}))}));return captured;};
 try{await assert.rejects(resumeCharacter(f.options.jobRoot,{...f.options,effectPresentation:changed,effectPlan:{planPath:e.planPath,inventoryPath:e.inventoryPath}}),{code:'SOURCE_CHANGED'});}finally{boundary.captureEffectRequest=captureRequest;}
 const released=await openJob(approved);await released.close();


});


test('generated component definitions use output authority without granting artwork authority',async t=>{
 const f=await fixture(t),output=f.options.config.outputRoot,child=createSpec({id:'generatedDefinition',description:'numeric fixture',template:'custom'});
 child.parts=[structuredClone(f.spec.parts[0])];const definition=path.join(output,'generated.json');await fs.writeFile(definition,JSON.stringify(child));
 f.spec.sockets=[{id:'socket',bone:'root',transform:{position:[0,0],rotation:0,scale:[1,1]},types:['arm'],capacity:1,inheritance:{position:true,rotation:true,scale:true}}];f.spec.components=[{id:'child',socket:'socket',type:'arm',spec:'generated.json'}];
 f.spec.sockets[0].layer=0;f.spec.sockets[0].envelope=[child.canvas.width,child.canvas.height];
 f.spec.assembly={version:1,styleHash:require('../lib/assets').hashValue(f.spec.style),eventNames:[],descriptors:[{version:1,type:'arm',spec:'generated.json',mount:{position:[0,0],rotation:0,scale:[1,1]},dimensions:[child.canvas.width,child.canvas.height],styleHash:require('../lib/assets').hashValue(child.style),eventNames:[],layer:0,inheritance:{position:true,rotation:true,scale:true}}]};
 let reviews=0;f.options.reviewArtwork=async()=>{reviews++;return {approved:false,status:'awaiting_artwork_approval'};};
 assert.equal((await buildCharacter(f.spec,f.options)).status,'awaiting_artwork_approval');assert.equal(reviews,1);assert.deepEqual(f.counts,{arm:0,body:0,rig:0});
 const calls=[],compile=f.options.compileGodot;f.options.compileGodot=async(s,o)=>{calls.push(s.id);return compile(s,o);};f.options.reviewArtwork=async()=>({approved:true});
 await resumeCharacter(f.options.jobRoot,f.options);assert.deepEqual(calls,['generatedDefinition','fixture']);const counts={...f.counts};
 await fs.rm(definition);await fs.rm(f.source,{recursive:true});await resumeCharacter(f.options.jobRoot,f.options);assert.deepEqual(f.counts,counts);
 const blocked=await fixture(t),bad=createSpec({id:'bad',description:'blocked',template:'custom'});bad.parts=[structuredClone(blocked.spec.parts[0])];bad.parts[0].image.path=path.join(blocked.options.config.outputRoot,'forbidden.png');await fs.writeFile(bad.parts[0].image.path,'bytes');
 await fs.writeFile(path.join(blocked.options.config.outputRoot,'bad.json'),JSON.stringify(bad));blocked.spec.sockets=f.spec.sockets;blocked.spec.components=[{id:'child',socket:'socket',type:'arm',spec:'bad.json'}];await assert.rejects(buildCharacter(blocked.spec,blocked.options),{code:'UNSAFE_PATH'});assert.deepEqual(blocked.counts,{arm:0,body:0,rig:0});
});

test('generated definitions changed after inspection fail before artwork preparation',async t=>{
 const f=await fixture(t),child=createSpec({id:'changingDefinition',description:'before',template:'custom'});child.parts=[structuredClone(f.spec.parts[0])];const file=path.join(f.options.config.outputRoot,'changing.json');await fs.writeFile(file,JSON.stringify(child));
 f.spec.sockets=[{id:'socket',bone:'root',transform:{position:[0,0],rotation:0,scale:[1,1]},types:['arm'],capacity:1,inheritance:{position:true,rotation:true,scale:true}}];f.spec.components=[{id:'child',socket:'socket',type:'arm',spec:'changing.json'}];
 const inspector=require('../lib/component-build'),original=inspector.inspectComponentGraph;t.mock.method(inspector,'inspectComponentGraph',async(...args)=>{const graph=await original(...args);child.description='after';await fs.writeFile(file,JSON.stringify(child));return graph;});
 await assert.rejects(buildCharacter(f.spec,f.options),{code:'SOURCE_CHANGED'});assert.deepEqual(f.counts,{arm:0,body:0,rig:0});
});

test('revised jobs retain immutable artwork and render settings while rejecting stale identity before persistence',async t=>{
 const f=await fixture(t);f.options.render=false;const first=await buildCharacter(f.spec,f.options);await fs.rm(f.source,{recursive:true});
 const next=structuredClone(f.spec);next.revision++;next.bones[0].length+=1;let persisted=0;
 const {rebuildCharacter}=require('../lib/engine');const result=await rebuildCharacter(f.spec,next,{...f.options,render:undefined,persistModification:async()=>{persisted++;}});
 assert.equal(persisted,1);assert.equal(result.manifest.context.settings.render,false);assert.deepEqual(f.counts,{arm:1,body:1,rig:2});assert.equal(result.manifest.jobId,first.manifest.jobId);
 await assert.rejects(rebuildCharacter(f.spec,next,{...f.options,persistModification:async()=>{persisted++;}}),{code:'STALE_JOB_CONTEXT'});assert.equal(persisted,1);
 const wrong=structuredClone(next);wrong.id='other';await assert.rejects(rebuildCharacter(next,wrong,f.options),{code:'STALE_JOB_CONTEXT'});
});

test('revised generated inputs invalidate original concepts but rig-only edits retain them',async t=>{
 const f=await fixture(t);f.spec.artwork.provider='comfyui';let calls=0;
 f.options.materializeConcept=async(spec,{jobRoot})=>{calls++;const bytes=Buffer.from(spec.description),hash=require('node:crypto').createHash('sha256').update(bytes).digest('hex');await fs.mkdir(path.join(jobRoot,'sources'),{recursive:true});const file=path.join(jobRoot,'sources',hash);await fs.writeFile(file,bytes);return {path:file,record:{relative:'sources/'+hash,hash,size:bytes.length}};};
 f.options.reviewArtwork=async()=>({approved:false,status:'awaiting_artwork_approval'});await buildCharacter(f.spec,f.options);
 const {rebuildCharacter}=require('../lib/engine'),rig=structuredClone(f.spec);rig.revision++;rig.bones[0].length++;
 await rebuildCharacter(f.spec,rig,f.options);assert.equal(calls,1);
 const changed=structuredClone(rig);changed.revision++;changed.description='new original character';assert.equal((await rebuildCharacter(rig,changed,f.options)).status,'awaiting_artwork_approval');assert.equal(calls,2);assert.deepEqual(f.counts,{arm:0,body:0,rig:0});
});

test('revised jobs inherit captured effect declarations without a caller repeat',async t=>{
 const f=await fixture(t),e=await effectFixture(f);await buildCharacter(f.spec,f.options);await fs.rm(e.planPath);await fs.rm(e.inventoryPath);delete f.options.effectPlan;
 const next=structuredClone(f.spec);next.revision++;next.bones[0].length++;const result=await require('../lib/engine').rebuildCharacter(f.spec,next,f.options);
 assert.equal(result.effects.status,'validated');assert.deepEqual(result.manifest.context.settings.effectPlan,{planPath:e.planPath,inventoryPath:e.inventoryPath});
});

test('revised component graphs refresh root metadata, reject missing changed definitions and clear removed graphs',async t=>{
 const f=await fixture(t),dir=f.source,child=createSpec({id:'child',description:'component',template:'custom'});child.parts=[structuredClone(f.spec.parts[0])];
 const file=path.join(dir,'child.json');await fs.writeFile(file,JSON.stringify(child));
 f.spec.sockets=[{id:'socket',bone:'root',transform:{position:[0,0],rotation:0,scale:[1,1]},types:['arm'],capacity:1,inheritance:{position:true,rotation:true,scale:true}}];f.spec.components=[{id:'left',socket:'socket',type:'arm',spec:file}];
 f.options.reviewArtwork=async()=>({approved:false,status:'awaiting_artwork_approval'});await buildCharacter(f.spec,f.options);await fs.rm(file);
 const {rebuildCharacter}=require('../lib/engine'),next=structuredClone(f.spec);next.revision++;next.description='revised root metadata';await rebuildCharacter(f.spec,next,f.options);
 const {inspectJob}=require('../lib/jobs');const before=await inspectJob(f.options.jobRoot),root=before.context.settings.componentGraph.nodes.at(-1);assert.equal(root.spec.description,next.description);assert.equal(root.spec.revision,next.revision);
 const bad=structuredClone(next);bad.revision++;bad.components[0].spec=path.join(dir,'missing.json');let saved=0;await assert.rejects(rebuildCharacter(next,bad,{...f.options,persistModification:async()=>{saved++;}}),{code:'UNSAFE_PATH'});assert.equal(saved,0);assert.equal((await inspectJob(f.options.jobRoot)).contextHash,before.contextHash);
 const fresh=structuredClone(next);fresh.revision++;fresh.components[0].id='right';child.description='fresh child definition';await fs.writeFile(file,JSON.stringify(child));await rebuildCharacter(next,fresh,f.options);const updated=await inspectJob(f.options.jobRoot);assert.equal(updated.context.settings.componentGraph.nodes[0].spec.description,child.description);
 const removed=structuredClone(fresh);removed.revision++;removed.components=[];await fs.rm(f.source,{recursive:true});await rebuildCharacter(fresh,removed,f.options);const final=await inspectJob(f.options.jobRoot);assert.equal(final.context.settings.componentGraph,null);assert.deepEqual(final.context.settings.componentArtwork,[]);
});

test('revised jobs reject full prior spec mismatch and concurrent context replacement before persistence',async t=>{
 const f=await fixture(t);await buildCharacter(f.spec,f.options);let writes=0;
 const wrong=structuredClone(f.spec);wrong.description='same ID and revision, different specification';const next=structuredClone(f.spec);next.revision++;
 await assert.rejects(require('../lib/engine').rebuildCharacter(wrong,next,{...f.options,persistModification:async()=>{writes++;}}),{code:'STALE_JOB_CONTEXT'});
 const jobsFile=require.resolve('../lib/jobs'),engineFile=require.resolve('../lib/engine'),savedJobs=require.cache[jobsFile].exports,savedEngine=require.cache[engineFile];
 require.cache[jobsFile].exports={...savedJobs,inspectJob:async root=>{const snapshot=await savedJobs.inspectJob(root),changed=structuredClone(snapshot);changed.context.settings.render=false;changed.contextHash=require('../lib/assets').hashValue(changed.context);await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify(changed));return snapshot;}};
 delete require.cache[engineFile];const engine=require('../lib/engine');t.after(()=>{require.cache[jobsFile].exports=savedJobs;require.cache[engineFile]=savedEngine;});
 await assert.rejects(engine.rebuildCharacter(f.spec,next,{...f.options,persistModification:async()=>{writes++;}}),{code:'STALE_JOB_CONTEXT'});assert.equal(writes,0);assert.deepEqual(f.counts,{arm:1,body:1,rig:1});await assert.rejects(fs.stat(path.join(f.options.jobRoot,'owner.lock')),{code:'ENOENT'});
});

test('revised job specifications reject accessors before reading them',async t=>{
 const f=await fixture(t);let reads=0;Object.defineProperty(f.spec,'description',{enumerable:true,get(){reads++;return 'unsafe';}});
 await assert.rejects(require('../lib/engine').rebuildCharacter(f.spec,f.spec,f.options),{code:'INVALID_SPEC'});assert.equal(reads,0);
});

async function componentMotionFixture(t){
 const f=await motionFixture(t),{hashValue}=require('../lib/assets');f.definitions=[];
 for(const [id,type] of [['installed','arm'],['alternative','spare']]){
  const child=createSpec({id,description:id,template:'custom'});child.parts=[structuredClone(f.spec.parts[0])];child.animations=[{id:id+'Motion',duration:.125,loop:false,tracks:[],events:[]}];
  const file=path.join(f.source,id+'.json');await fs.writeFile(file,JSON.stringify(child));f.definitions.push({child,file,type});
 }
 f.spec.sockets=[{id:'socket',bone:'root',transform:{position:[0,0],rotation:0,scale:[1,1]},types:['arm','spare'],capacity:2,inheritance:{position:true,rotation:true,scale:true},layer:0,envelope:[f.spec.canvas.width,f.spec.canvas.height]}];
 f.spec.components=[{id:'left',socket:'socket',type:'arm',spec:f.definitions[0].file},{id:'right',socket:'socket',type:'arm',spec:f.definitions[0].file}];
 f.spec.assembly={version:1,styleHash:hashValue(f.spec.style),eventNames:[],descriptors:f.definitions.map(({child,file,type})=>({version:1,type,spec:path.basename(file),mount:{position:[0,0],rotation:0,scale:[1,1]},dimensions:[child.canvas.width,child.canvas.height],styleHash:hashValue(child.style),eventNames:[],layer:0,inheritance:{position:true,rotation:true,scale:true}}))};
 f.compileCalls=[];const compile=f.options.compileGodot;f.options.compileGodot=async(input,options)=>{f.compileCalls.push(input.id);return compile(input,options);};return f;
}

test('authored assembly phase-only changes retain child rigs and approved art on cached resume',async t=>{
 const f=await componentMotionFixture(t);f.options.render=false;
 f.spec.assembly.descriptors[0].transitions={install:{duration:.5,phases:[{id:'activate',time:.25,clip:'installedMotion'}]}};
 const first=await buildCharacter(f.spec,f.options);assert.equal(f.compileCalls.length,3);const childDirs=first.components.map(c=>c.project),counts={...f.counts};
 f.spec.assembly.descriptors[0].transitions.install.phases[0].time=.3;
 const changed=await buildCharacter(f.spec,f.options);assert.equal(f.compileCalls.length,4);assert.deepEqual(changed.components.map(c=>c.project),childDirs);assert.equal(f.counts.arm,counts.arm);assert.equal(f.counts.body,counts.body);
 await fs.rm(f.source,{recursive:true});const resumed=await resumeCharacter(f.options.jobRoot,f.options);assert.deepEqual(resumed.components,changed.components);assert.equal(f.compileCalls.length,4);
});

test('assembly phase clips require exact captured child animation before any rig compile',async t=>{
 for(const kind of ['missing','projectile']){
  const f=await componentMotionFixture(t);f.options.render=false;
  const child=f.definitions[0];if(kind==='projectile'){
   child.child.sockets=[{id:'launch',bone:'root',transform:{position:[0,0],rotation:0,scale:[1,1]},types:['arrow'],capacity:1,inheritance:{position:true,rotation:true,scale:true}}];
   child.child.projectiles=[{id:'arrow',part:child.child.parts[0].id,forward:[1,0],flightDuration:.1,lifetime:.2}];
   child.child.animations[0].events=[{id:'fire',time:.05,type:'projectile',payload:{projectile:'arrow',sourceSocket:'launch'}}];
   f.spec.assembly.eventNames=['projectile'];f.spec.assembly.descriptors[0].eventNames=['projectile'];await fs.writeFile(child.file,JSON.stringify(child.child));
  }
  f.spec.assembly.descriptors[0].transitions={install:{duration:.5,phases:[{id:'activate',time:.25,clip:kind==='missing'?'absent':'installedMotion'}]}};
  await assert.rejects(buildCharacter(f.spec,f.options),e=>e.code==='INVALID_COMPONENT');assert.equal(f.compileCalls.length,0);
 }
});
test('component graphics previews expose independent installed and alternative definitions with cached contained evidence',async t=>{
 const f=await componentMotionFixture(t),result=await buildCharacter(f.spec,f.options);
 assert.deepEqual(result.components.map(x=>x.id),['installed','alternative']);
 for(const item of result.components){assert.equal(item.motionPreviews.clips[0].clipId,item.id+'Motion');assert.equal(item.frames.length,3);assert.equal(item.inspection.coverage.frameCount,3);assert.equal(item.authoredGeometry.visualQuality,'unverified');assert.equal(item.repair.status,'passed');assert.ok((await fs.stat(item.repair.historyPath)).isFile());for(const file of [item.scene,...item.frames,item.inspection.contactSheet.path,item.motionPreviews.clips[0].path])assert.ok((await fs.stat(file)).isFile());}
 assert.equal(result.motionPreviews.clips[0].clipId,'attack');assert.equal(f.motionCalls,3);assert.equal(f.compileCalls.filter(id=>id==='installed').length,1);
 await fs.rm(f.source,{recursive:true});const cached=await resumeCharacter(f.options.jobRoot,f.options);assert.deepEqual(cached.components,result.components);assert.equal(f.motionCalls,3);assert.equal(f.compileCalls.length,3);
 const clip=result.components[0].motionPreviews.clips[0];await fs.writeFile(clip.path,'corrupted');await resumeCharacter(f.options.jobRoot,f.options);assert.equal(f.motionCalls,4);assert.equal(f.compileCalls.length,3);
});
test('component graphics render false omits all previews and root-only results retain compatibility',async t=>{
 const f=await componentMotionFixture(t);f.options.render=false;const result=await buildCharacter(f.spec,f.options);assert.equal(result.components.length,2);for(const item of result.components){assert.equal(item.inspection,null);assert.equal(item.motionPreviews,null);assert.ok(item.authoredGeometry);assert.ok(item.validation.valid);}assert.equal(f.motionCalls,0);assert.ok(!Object.keys(result.manifest.stages).some(x=>/visual-inspection|motion-previews/.test(x)));
 const g=await motionFixture(t);assert.deepEqual((await buildCharacter(g.spec,g.options)).components,[]);
});

test('component graphics failures retry only the affected presentation stage and reject malformed child evidence',async t=>{
 for(const kind of ['inspection','motion']){
  const f=await componentMotionFixture(t),inspection=f.options.inspectRenderedFrames,motion=f.options.createMotionPreview;const calls={};let fail=true;
  f.options.inspectRenderedFrames=async(frames,options)=>{const child=options.sourceRoot.includes('component-');const key=(child?'child':'root')+'inspection';calls[key]=(calls[key]||0)+1;if(kind==='inspection'&&child&&fail){fail=false;throw Object.assign(new Error('child inspection'),{code:'VISUAL_INSPECTION_FAILED'});}return inspection(frames,options);};
  f.options.createMotionPreview=async(id,...args)=>{calls[id]=(calls[id]||0)+1;if(kind==='motion'&&id==='installedMotion'&&fail){fail=false;throw Object.assign(new Error('child motion'),{code:'MOTION_PREVIEW_FAILED'});}return motion(id,...args);};
  await assert.rejects(buildCharacter(f.spec,f.options),{code:kind==='inspection'?'VISUAL_INSPECTION_FAILED':'MOTION_PREVIEW_FAILED'});const before={...calls},compiled=f.compileCalls.length;
  const result=await resumeCharacter(f.options.jobRoot,f.options);assert.equal(result.components.length,2);assert.equal(f.compileCalls.length,compiled);assert.equal(calls.attack,1);assert.equal(calls.alternativeMotion,1);assert.equal(calls.rootinspection,1);assert.equal(calls.installedMotion,kind==='motion'?2:1);assert.ok(Object.keys(before).length);
 }
 for(const kind of ['inspection','escaped-motion','malformed-motion']){
  const f=await componentMotionFixture(t),inspection=f.options.inspectRenderedFrames,motion=f.options.createMotionPreview;
  f.options.inspectRenderedFrames=async(frames,options)=>{const report=await inspection(frames,options);if(kind==='inspection'&&options.sourceRoot.includes('component-'))report.coverage.frameCount=999;return report;};
  f.options.createMotionPreview=async(id,...args)=>{const report=await motion(id,...args);if(id==='installedMotion'){if(kind==='escaped-motion')report.path=path.join(f.root,'escape.png');if(kind==='malformed-motion')report.captures[0].sha256='0'.repeat(64);}return report;};
  await assert.rejects(buildCharacter(f.spec,f.options),{code:'VALIDATION_FAILED'});
 }
});
test('component graphics clip edits invalidate the changed definition and ancestor without sibling presentation rebuilds',async t=>{
 const f=await componentMotionFixture(t),first=await buildCharacter(f.spec,f.options),child=f.definitions[0];child.child.animations[0].duration=.25;await fs.writeFile(child.file,JSON.stringify(child.child));
 const next=await buildCharacter(f.spec,f.options);assert.deepEqual(f.compileCalls,['installed','alternative','fixture','installed','fixture']);assert.equal(f.motionCalls,5);assert.equal(next.components[0].motionPreviews.clips[0].sampling.times.at(-1),.25);assert.deepEqual(next.components[1],first.components[1]);
});

test('assembly preview is independently cached and bound to original and compiled definitions',async t=>{
 const f=await componentMotionFixture(t);let calls=0;const preview=f.options.createAssemblyPreview;
 f.options.createAssemblyPreview=async(...args)=>{calls++;return preview(...args);};
 const first=await buildCharacter(f.spec,f.options);assert.equal(calls,1);assert.equal(first.assemblyPreview.scope,'development-assembly-preview');assert.equal(first.assemblyPreview.specHash,require('../lib/assets').hashValue(f.spec));assert.equal(first.assemblyPreview.compiledSpecHash,first.authoredGeometry.specHash);assert.notEqual(first.assemblyPreview.specHash,first.assemblyPreview.compiledSpecHash);assert.equal(f.motionCalls,3);
 for(const child of first.components)assert.equal(child.assemblyPreview.status,'not-applicable');
 await fs.rm(f.source,{recursive:true});const resumed=await resumeCharacter(f.options.jobRoot,f.options);assert.deepEqual(resumed.assemblyPreview,first.assemblyPreview);assert.equal(calls,1);
 await fs.writeFile(first.assemblyPreview.contactSheet.path,'corrupt preview');await resumeCharacter(f.options.jobRoot,f.options);assert.equal(calls,2);assert.equal(f.compileCalls.length,3);
 f.options.versions.assemblyPreview='changed-preview-only';await resumeCharacter(f.options.jobRoot,f.options);assert.equal(calls,3);assert.equal(f.compileCalls.length,3);assert.equal(f.motionCalls,3);
});
test('assembly preview failures retry independently and reject escaped or mismatched reports',async t=>{
 const f=await componentMotionFixture(t),preview=f.options.createAssemblyPreview;let calls=0;
 f.options.createAssemblyPreview=async(...args)=>{if(++calls===1)throw Object.assign(new Error('capture failed'),{code:'ASSEMBLY_PREVIEW_FAILED'});return preview(...args);};
 await assert.rejects(buildCharacter(f.spec,f.options),{code:'ASSEMBLY_PREVIEW_FAILED'});await resumeCharacter(f.options.jobRoot,f.options);assert.equal(calls,2);assert.equal(f.compileCalls.length,3);assert.equal(f.motionCalls,3);
 for(const kind of ['spec','compiled','path','quality','plan','time','dimensions','hash']){const g=await componentMotionFixture(t),create=g.options.createAssemblyPreview;g.options.createAssemblyPreview=async(...args)=>{const r=await create(...args);if(kind==='spec')r.specHash='0'.repeat(64);if(kind==='compiled')r.compiledSpecHash='0'.repeat(64);if(kind==='path')r.frames[0].path='../escape.png';if(kind==='quality')r.visualQuality='passed';if(kind==='plan')r.planHash='0'.repeat(64);if(kind==='time')r.frames[0].time=.123;if(kind==='dimensions')r.frames[0].width++;if(kind==='hash')r.contactSheet.sha256='0'.repeat(64);return r;};await assert.rejects(buildCharacter(g.spec,g.options),{code:'VALIDATION_FAILED'});}
});

test('nested component definitions publish and retry their own assembly previews',async t=>{
 const f=await componentMotionFixture(t),child=f.definitions[0].child;
 child.sockets=[{...structuredClone(f.spec.sockets[0]),types:['spare']}];child.assembly={...structuredClone(f.spec.assembly),descriptors:[structuredClone(f.spec.assembly.descriptors[1])]};
 await fs.writeFile(f.definitions[0].file,JSON.stringify(child));
 const preview=f.options.createAssemblyPreview,calls={};let fail=true;
 f.options.createAssemblyPreview=async(input,...args)=>{calls[input.id]=(calls[input.id]||0)+1;if(input.id==='installed'&&fail){fail=false;throw Object.assign(new Error('child assembly preview failure'),{code:'ASSEMBLY_PREVIEW_FAILED'});}return preview(input,...args);};
 await assert.rejects(buildCharacter(f.spec,f.options),{code:'ASSEMBLY_PREVIEW_FAILED'});const compiled=f.compileCalls.length;
 const result=await resumeCharacter(f.options.jobRoot,f.options),installed=result.components.find(c=>c.id==='installed');assert.equal(installed.assemblyPreview.status,'completed');assert.equal(result.assemblyPreview.status,'completed');assert.equal(calls.installed,2);assert.equal(calls.fixture,1);assert.equal(f.compileCalls.length,compiled);
 await fs.rm(f.source,{recursive:true});const cached=await resumeCharacter(f.options.jobRoot,f.options);assert.deepEqual(cached.components,result.components);assert.equal(calls.installed,2);assert.equal(calls.fixture,1);
});

test('assembly previews receive only receipt-verified recursive compiler audio eligibility',async t=>{
 const f=await componentMotionFixture(t),child=f.definitions[0].child;
 child.sockets=[{...structuredClone(f.spec.sockets[0]),types:['spare']}];child.assembly={...structuredClone(f.spec.assembly),descriptors:[structuredClone(f.spec.assembly.descriptors[1])]};await fs.writeFile(f.definitions[0].file,JSON.stringify(child));
 const compile=f.options.compileGodot,preview=f.options.createAssemblyPreview,seen={};
 f.options.compileGodot=async(...args)=>{const result=await compile(...args);await fs.mkdir(path.join(result.project,'audio'),{recursive:true});await fs.writeFile(path.join(result.project,'audio/sameSound.res'),'compiled leaf');result.validation.audio=[{id:'sameSound',format:'wav',duration:.01,resource:'res://audio/sameSound.res'}];return result;};
 f.options.createAssemblyPreview=async(input,options)=>{seen[input.id]=options.audioMetadata;assert.equal(options.storageRoot,f.options.jobRoot);return preview(input,options);};
 const result=await buildCharacter(f.spec,f.options);
 assert.deepEqual(seen.fixture.map(m=>[m.id,m.prefix]),[['fixture',''],['installed','components/installed'],['alternative','components/installed/components/alternative'],['alternative','components/alternative']]);
 assert.deepEqual(seen.installed.map(m=>[m.id,m.prefix]),[['installed',''],['alternative','components/alternative']]);
 for(const entries of Object.values(seen))for(const entry of entries){assert.equal(entry.validation.valid,true);assert.equal(entry.validation.audio[0].id,'sameSound');}
 const calls=Object.keys(seen).length;await fs.rm(f.source,{recursive:true});await resumeCharacter(f.options.jobRoot,f.options);assert.equal(Object.keys(seen).length,calls);assert.equal(result.assemblyPreview.status,'completed');
});

test('assembly preview rejects changed component metadata or audio bytes before native capture',async t=>{
 for(const kind of ['metadata','audio']){
  const f=await componentMotionFixture(t),compile=f.options.compileGodot,preview=f.options.createAssemblyPreview;let calls=0;
  f.options.createAssemblyPreview=async(...args)=>{calls++;return preview(...args);};
  f.options.compileGodot=async(input,options)=>{const result=await compile(input,options);await fs.writeFile(path.join(result.project,'voice.res'),'RSRCnumeric');result.validation.audio=[{id:'voice',format:'wav',duration:.01,resource:'res://voice.res'}];
   if(input.id==='fixture'){const entry=options.componentProjects.installed;if(kind==='metadata')await fs.appendFile(path.join(entry.checkpoint.root,'rig.json'),' ');else await fs.writeFile(path.join(entry.project,'voice.res'),'RSRCchanged');}return result;};
  await assert.rejects(buildCharacter(f.spec,f.options),{code:'CORRUPT_ARTIFACT'});assert.equal(calls,0);
 }
});

test('assembly audio inspection diagnostics remain contained and usable after publication and cache',async t=>{
 const f=await componentMotionFixture(t),preview=f.options.createAssemblyPreview;let calls=0;
 f.options.createAssemblyPreview=async(input,options)=>{calls++;const report=await preview(input,options);await fs.mkdir(path.join(options.stagingDir,'inspection-retained'));await fs.writeFile(path.join(options.stagingDir,'inspection-retained/request.json'),'numeric diagnostic');report.audioInspection={version:1,resources:[],retainedDirectories:['inspection-retained']};return report;};
 const first=await buildCharacter(f.spec,f.options),directory=first.assemblyPreview.audioInspection.retainedDirectories[0];assert(path.isAbsolute(directory));assert((await fs.stat(directory)).isDirectory());assert.equal(await fs.readFile(path.join(directory,'request.json'),'utf8'),'numeric diagnostic');
 const checkpoint=first.manifest.stages['assembly-preview'],stored=JSON.parse(await fs.readFile(path.join(f.options.jobRoot,checkpoint.directory,'assembly-preview.json'),'utf8'));assert.deepEqual(stored.audioInspection.retainedDirectories,['inspection-retained']);
 await fs.rm(f.source,{recursive:true});const cached=await resumeCharacter(f.options.jobRoot,f.options);assert.deepEqual(cached.assemblyPreview.audioInspection,first.assemblyPreview.audioInspection);assert((await fs.stat(cached.assemblyPreview.audioInspection.retainedDirectories[0])).isDirectory());assert.equal(calls,1);
 const bad=await componentMotionFixture(t),create=bad.options.createAssemblyPreview;bad.options.createAssemblyPreview=async(...args)=>({...await create(...args),audioInspection:{version:1,resources:[],retainedDirectories:['../outside']}});await assert.rejects(buildCharacter(bad.spec,bad.options),{code:'VALIDATION_FAILED'});
});

test('surface masks are captured, invalidate only preparation, and resume without original files',async t=>{
 const f=await fixture(t);const mask=path.join(f.source,'required.png');await fs.writeFile(mask,'mask-v1');f.spec.parts[0].requiredSurfaceMask={path:mask};
 const prepare=f.options.prepareArtwork;f.options.prepareArtwork=async(input,options)=>{
 const result=await prepare(input,options),part=result.parts[0],source=input.parts.find(p=>p.id===part.id);
 if(source.requiredSurfaceMask){const local=path.join(options.stagingDir,'coverage-source');await fs.copyFile(source.image.path,local);const hashFile=require('../lib/assets').hashFile;
 part.surfaceCoverageSource=local;part.surfaceCoverage={version:1,status:'verified',sourceSha256:await hashFile(local),maskSha256:await hashFile(source.requiredSurfaceMask.path),outputSha256:await hashFile(part.image.path),width:4,height:4,requiredPixels:4,missingPixels:0,alphaThreshold:1};}
 return result;
 };
 const first=await buildCharacter(f.spec,f.options);assert.equal(first.valid,true);assert.ok(first.manifest.context.inputs[mask]);
 await fs.writeFile(mask,'mask-v2');await buildCharacter(f.spec,f.options);assert.deepEqual(f.counts,{arm:2,body:1,rig:2});
 await fs.rm(f.source,{recursive:true});await resumeCharacter(f.options.jobRoot,f.options);assert.deepEqual(f.counts,{arm:2,body:1,rig:2});
});

test('declared coverage cannot bypass rig checks through a prepared provider without a receipt',async t=>{
 const f=await fixture(t);const mask=path.join(f.source,'required.png');await fs.writeFile(mask,'mask');f.spec.parts[0].requiredSurfaceMask={path:mask};
 await assert.rejects(buildCharacter(f.spec,f.options));assert.equal(f.counts.rig,0);
});

test('component required masks share immutable source authority without becoming original-art previews',async t=>{
 const f=await fixture(t),mask=path.join(f.source,'child-required.png');await fs.writeFile(mask,'child mask');
 const child=createSpec({id:'coverageChild',description:'component surface',template:'custom'});child.parts=[structuredClone(f.spec.parts[0])];child.parts[0].requiredSurfaceMask={path:'child-required.png'};
 const file=path.join(f.source,'child.json');await fs.writeFile(file,JSON.stringify(child));
 f.spec.sockets=[{id:'mount',bone:'root',transform:{position:[0,0],rotation:0,scale:[1,1]},types:['arm'],capacity:1,inheritance:{position:true,rotation:true,scale:true}}];f.spec.components=[{id:'child',socket:'mount',type:'arm',spec:file}];
 f.options.reviewArtwork=async({inputs,componentArtwork})=>{assert.ok(inputs[mask]);assert.equal(componentArtwork[0].content.originals.some(item=>item.hash===inputs[mask].hash),false);return {approved:false};};
 await buildCharacter(f.spec,f.options);await fs.rm(f.source,{recursive:true});await resumeCharacter(f.options.jobRoot,f.options);assert.equal(f.counts.rig,0);
});

test('restored declared coverage requires decoded source dimensions in provenance',async t=>{
 const f=await fixture(t),mask=path.join(f.source,'required.png');await fs.writeFile(mask,'mask');f.spec.parts[0].requiredSurfaceMask={path:mask};const prepare=f.options.prepareArtwork;
 f.options.prepareArtwork=async(input,options)=>{
 const result=await prepare(input,options),part=result.parts[0],source=input.parts.find(p=>p.id===part.id);
 if(source.requiredSurfaceMask){const local=path.join(options.stagingDir,'coverage-source');await fs.copyFile(source.image.path,local);const hashFile=require('../lib/assets').hashFile;part.surfaceCoverageSource=local;part.surfaceCoverage={version:1,status:'verified',sourceSha256:await hashFile(local),maskSha256:await hashFile(source.requiredSurfaceMask.path),outputSha256:await hashFile(part.image.path),width:4,height:4,requiredPixels:4,missingPixels:0,alphaThreshold:1};delete part.source;}
 return result;
 };
 await assert.rejects(buildCharacter(f.spec,f.options),{code:'INVALID_SURFACE_COVERAGE'});assert.equal(f.counts.rig,0);
});
async function animationFixture(t,outcome='none'){
 const f=await fixture(t),mechanics=path.join(f.source,'mod');await fs.mkdir(mechanics);const file=path.join(mechanics,'Card.cs');await fs.writeFile(file,'class Strike {}');
 const receipt=await require('../lib/mechanics').inspectMechanics({characterId:f.spec.id,sourceRoots:[mechanics],mechanics:[{key:'strike',modId:'mod',modelSymbol:'Strike',evidence:[{path:file,symbol:'Strike',lineStart:1,lineEnd:1}]}]});
 const plan={version:1,characterId:f.spec.id,mechanicsFingerprint:receipt.fingerprint,inspectionVersion:'1',decisions:[{mechanicKey:'strike',evidenceIds:receipt.mechanics[0].evidenceIds,outcome,clipIds:[],reason:'Inspected card presentation'}]};
 const pair={planPath:path.join(f.source,'animation.json'),inventoryPath:path.join(f.source,'mechanics.json')};await fs.writeFile(pair.planPath,JSON.stringify(plan));await fs.writeFile(pair.inventoryPath,JSON.stringify(receipt));f.options.animationInventory=pair;f.options.config.mechanics={sourceRoots:[mechanics]};return {...f,pair,plan,file};
}
test('animation inventory persists live validation and blocks stale source before cached compile',async t=>{
 const f=await animationFixture(t);const first=await buildCharacter(f.spec,f.options);assert.equal(first.animationInventoryComplete,true);assert.equal(first.animationInventory.status,'validated');assert.ok(first.manifest.stages['animation-inventory']);assert.deepEqual(first.manifest.context.settings.animationInventory,f.pair);
 await fs.unlink(f.pair.planPath);await fs.unlink(f.pair.inventoryPath);const options={...f.options};delete options.animationInventory;assert.equal((await resumeCharacter(f.options.jobRoot,options)).animationInventoryComplete,true);await fs.appendFile(f.file,' // changed');await assert.rejects(resumeCharacter(f.options.jobRoot,options),{code:'STALE_ANIMATION_INVENTORY'});assert.equal(f.counts.rig,1);
});
test('animation inventory unresolved preserves graphics and original approval gate',async t=>{
 const f=await animationFixture(t,'unresolved');f.options.reviewArtwork=async()=>({approved:false,status:'awaiting_artwork_approval'});const blocked=await buildCharacter(f.spec,f.options);assert.equal(blocked.animationInventoryComplete,false);assert.equal(blocked.status,'awaiting_artwork_approval');assert.equal(f.counts.rig,0);f.options.reviewArtwork=async()=>({approved:true});const built=await resumeCharacter(f.options.jobRoot,f.options);assert.equal(built.animationInventoryComplete,false);assert.equal(built.status,'completed');assert.ok(built.animationInventory.diagnostics.length);
});
test('animation inventory replacement retains art cache and revisions revalidate clips',async t=>{
 const f=await animationFixture(t);await buildCharacter(f.spec,f.options);const counts=structuredClone(f.counts);f.plan.decisions[0].reason='Refined evidence decision';await fs.writeFile(f.pair.planPath,JSON.stringify(f.plan));const replaced=await resumeCharacter(f.options.jobRoot,f.options);assert.equal(replaced.animationInventoryComplete,true);assert.equal(f.counts.arm,counts.arm);assert.equal(f.counts.body,counts.body);
 const updated=structuredClone(f.spec);updated.description='Same approved artwork, revised rig';const opts={...f.options};delete opts.animationInventory;const revised=await require('../lib/engine').rebuildCharacter(f.spec,updated,opts);assert.equal(revised.animationInventoryComplete,true);assert.deepEqual(revised.manifest.context.settings.animationInventory,f.pair);
});
test('animation inventory captured corruption and malformed pairing reject',async t=>{
 const f=await animationFixture(t),first=await buildCharacter(f.spec,f.options),record=first.manifest.context.inputs[f.pair.planPath];await fs.writeFile(path.join(f.options.jobRoot,record.relative),'corrupted');const opts={...f.options};delete opts.animationInventory;await assert.rejects(resumeCharacter(f.options.jobRoot,opts),{code:'CORRUPT_ARTIFACT'});await assert.rejects(buildCharacter(f.spec,{...f.options,animationInventory:{planPath:f.pair.planPath}}),{code:'INVALID_INPUT'});
});
test('animation inventory live membership and removed clip fail before rig publication',async t=>{
 const f=await animationFixture(t),clip={id:'attack',duration:1,loop:false,tracks:[],events:[]};f.options.render=false;f.spec.animations=[clip];f.plan.decisions[0].outcome='animate';f.plan.decisions[0].clipIds=['attack'];await fs.writeFile(f.pair.planPath,JSON.stringify(f.plan));await buildCharacter(f.spec,f.options);const opts={...f.options};delete opts.animationInventory;const updated=structuredClone(f.spec);updated.animations=[];await assert.rejects(require('../lib/engine').rebuildCharacter(f.spec,updated,opts),{code:'INVALID_ANIMATION_INVENTORY'});const count=f.counts.rig;await fs.writeFile(path.join(path.dirname(f.file),'New.cs'),'class Extra {}');await assert.rejects(resumeCharacter(f.options.jobRoot,opts),{code:'STALE_ANIMATION_INVENTORY'});assert.equal(f.counts.rig,count);
});


test('animation inventory pose revisions recapture while source-free art and unavailable mechanics stay explicit',async t=>{
 const f=await animationFixture(t);f.options.render=false;f.spec.animations=[{id:'attack',duration:1,loop:false,tracks:[],events:[]}];f.plan.decisions[0].outcome='animate';f.plan.decisions[0].clipIds=['attack'];await fs.writeFile(f.pair.planPath,JSON.stringify(f.plan));const first=await buildCharacter(f.spec,f.options);await fs.unlink(path.join(f.source,'arm.png'));await fs.unlink(path.join(f.source,'body.png'));
 const updated=structuredClone(f.spec);updated.animations[0].duration=2;const opts={...f.options};delete opts.animationInventory;const revised=await require('../lib/engine').rebuildCharacter(f.spec,updated,opts);assert.notEqual(revised.animationInventory.fingerprint,first.animationInventory.fingerprint);assert.equal(revised.animationInventoryComplete,true);assert.equal(f.counts.arm,1);assert.equal(f.counts.body,1);
 delete opts.config.mechanics;const unavailable=await resumeCharacter(f.options.jobRoot,opts);assert.equal(unavailable.animationInventoryComplete,false);assert.ok(unavailable.animationInventory.diagnostics.some(d=>d.code==='MECHANICS_UNAVAILABLE'));assert.equal(unavailable.status,'completed');
});
test('mod inventory synthetic normal flow covers shared distinct none and unresolved cards',async t=>{
 const f=await fixture(t),mechanics=path.join(f.source,'mod');await fs.mkdir(mechanics);const keys=['strike','doubleStrike','cast','draw','unknown'];const declarations=[];
 for(const key of keys){const symbol=key[0].toUpperCase()+key.slice(1),file=path.join(mechanics,symbol+'.cs');await fs.writeFile(file,'class '+symbol+' {}');declarations.push({key,modId:'mod',modelSymbol:symbol,evidence:[{path:file,symbol,lineStart:1,lineEnd:1}]});}
 const receipt=await require('../lib/mechanics').inspectMechanics({characterId:f.spec.id,sourceRoots:[mechanics],mechanics:declarations});
 f.spec.animations=['attack','cast'].map(id=>({id,duration:1,loop:false,tracks:[],events:[]}));f.options.render=false;f.options.config.mechanics={sourceRoots:[mechanics]};
 const decisions=receipt.mechanics.map(m=>({mechanicKey:m.key,evidenceIds:m.evidenceIds,outcome:m.key==='draw'?'none':m.key==='unknown'?'unresolved':'animate',clipIds:['draw','unknown'].includes(m.key)?[]:[m.key==='cast'?'cast':'attack'],reason:m.key==='unknown'?'Execution target requires further inspection':m.key==='draw'?'Inspected card changes hand only':'Inspected card action presentation'}));
 const plan={version:1,characterId:f.spec.id,mechanicsFingerprint:receipt.fingerprint,inspectionVersion:'1',decisions};const pair={planPath:path.join(f.source,'animation.json'),inventoryPath:path.join(f.source,'mechanics.json')};await fs.writeFile(pair.planPath,JSON.stringify(plan));await fs.writeFile(pair.inventoryPath,JSON.stringify(receipt));f.options.animationInventory=pair;
 const first=await buildCharacter(f.spec,f.options);assert.equal(first.status,'completed');assert.equal(first.animationInventoryComplete,false);assert.deepEqual([...first.animationInventory.referencedClipIds].sort(),['attack','cast']);assert.ok(first.animationInventory.diagnostics.length);assert.deepEqual(decisions.filter(d=>d.clipIds.includes('attack')).map(d=>d.mechanicKey).sort(),['doubleStrike','strike']);
 const checkpoint=first.manifest.stages['animation-inventory'];assert.ok(checkpoint);const persisted=JSON.parse(await fs.readFile(path.join(f.options.jobRoot,checkpoint.directory,'animation-inventory.json'),'utf8'));assert.equal(persisted.animationInventoryComplete,false);assert.deepEqual(persisted.animationInventory,first.animationInventory);
 const options={...f.options};delete options.animationInventory;await fs.unlink(pair.planPath);await fs.unlink(pair.inventoryPath);const resumed=await resumeCharacter(f.options.jobRoot,options);assert.equal(resumed.animationInventoryComplete,false);assert.deepEqual(resumed.animationInventory,first.animationInventory);assert.equal(f.counts.rig,1);
});
