'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  spawnSync
} = require('node:child_process');
const cli = path.resolve(__dirname, '../cli.js');
test('CLI mod animation inventory validates resulting shared clips and live evidence before output',async t=>{
 const {root,config}=await workspace(t),source=path.join(root,'actor.json'),request=path.join(root,'request.json'),planPath=path.join(root,'plan.json'),receiptPath=path.join(root,'receipt.json'),mechanics=path.join(root,'mod');await fs.mkdir(mechanics);const card=path.join(mechanics,'Cards.cs');await fs.writeFile(card,'class Strike {}\nclass Guard {}');
 const settings=JSON.parse(await fs.readFile(config));settings.mechanics={sourceRoots:[mechanics]};await fs.writeFile(config,JSON.stringify(settings));
 const spec=require('../lib/spec').createSpec({id:'actor',description:'Fixture',template:'humanoid'});spec.animations=require('../lib/animation').expandClips(spec,[{family:'defend',id:'keep'}]).animations;await fs.writeFile(source,JSON.stringify(spec));await fs.writeFile(request,JSON.stringify({version:1,sourceSpecHash:require('../lib/assets').hashValue(spec),clips:[{family:'attack',id:'strike'}]}));
 const receipt=await require('../lib/mechanics').inspectMechanics({characterId:'actor',sourceRoots:[mechanics],mechanics:['Strike','Guard'].map((symbol,i)=>({key:symbol.toLowerCase(),modId:'mod',modelSymbol:symbol,evidence:[{path:card,symbol,lineStart:i+1,lineEnd:i+1}]}))});await fs.writeFile(receiptPath,JSON.stringify(receipt));
 const plan={version:1,characterId:'actor',mechanicsFingerprint:receipt.fingerprint,inspectionVersion:'1',decisions:receipt.mechanics.map(m=>({mechanicKey:m.key,evidenceIds:m.evidenceIds,outcome:'animate',clipIds:['keep','strike'],reason:'Shared presentation'}))};await fs.writeFile(planPath,JSON.stringify(plan));
 const args=out=>['author-clips',source,'--request',request,'--out',out,'--animation-inventory',planPath,'--mechanics-inventory',receiptPath,'--config',config],out=path.join(root,'out.json');let r=run(args(out));assert.equal(r.status,0,r.stdout);assert.equal(r.json.result.animationInventoryComplete,true);assert.equal(r.json.result.animationInventory.status,'validated');assert.deepEqual(JSON.parse(await fs.readFile(out)).animations.map(c=>c.id),['keep','strike']);assert.equal(run(args(out)).json.error.code,'OUTPUT_EXISTS');
 plan.decisions[0].clipIds=['absent'];await fs.writeFile(planPath,JSON.stringify(plan));const missing=path.join(root,'missing.json');r=run(args(missing));assert.equal(r.status,2,r.stdout);assert.equal(r.json.error.code,'INVALID_ANIMATION_INVENTORY');await assert.rejects(fs.stat(missing),{code:'ENOENT'});
 plan.decisions[0].outcome='unresolved';plan.decisions[0].clipIds=[];await fs.writeFile(planPath,JSON.stringify(plan));r=run(args(path.join(root,'unresolved.json')));assert.equal(r.status,0,r.stdout);assert.equal(r.json.result.animationInventoryComplete,false);assert.equal(r.json.result.animationInventory.status,'unresolved');assert.ok(r.json.result.animationInventory.diagnostics.length);
 plan.decisions[0].outcome='animate';plan.decisions[0].clipIds=['strike'];await fs.writeFile(planPath,JSON.stringify(plan));await fs.appendFile(card,'\n// changed');const stale=path.join(root,'stale.json');r=run(args(stale));assert.equal(r.status,2,r.stdout);assert.equal(r.json.error.code,'STALE_ANIMATION_INVENTORY');await assert.rejects(fs.stat(stale),{code:'ENOENT'});
 const outside=path.join(root,'..','outside-plan.json'),escaped=path.join(root,'escaped.json');r=run(args(escaped).map(a=>a===planPath?outside:a));assert.equal(r.status,2,r.stdout);assert.equal(r.json.error.code,'UNSAFE_PATH');await assert.rejects(fs.stat(escaped),{code:'ENOENT'});
});
test('CLI animation inventory flags are paired and forwarded only as root references',async t=>{
 const {root,config}=await workspace(t),source=path.join(root,'actor.json'),job=path.join(root,'job'),plan=path.join(root,'plan.json'),receipt=path.join(root,'receipt.json'),preload=path.join(root,'engine.cjs');await fs.writeFile(source,JSON.stringify(require('../lib/spec').createSpec({id:'actor',description:'Fixture'})));
 await fs.writeFile(preload,`require.cache[require.resolve(${JSON.stringify(path.resolve(__dirname,'../lib/engine.js'))})]={exports:{buildCharacter:async(s,o)=>({inventory:o.animationInventory}),resumeCharacter:async(j,o)=>({inventory:o.animationInventory})}};`);
 for(const command of [['build',source,'--job',job],['resume',job],['author-clips',source,'--request','r.json','--out','o.json']])for(const flag of ['--animation-inventory','--mechanics-inventory']){const r=run([...command,flag,plan,'--config',config],preload);assert.equal(r.status,2,r.stdout);assert.match(r.json.error.message,/both --animation-inventory and --mechanics-inventory/);}
 for(const command of [['build',source,'--job',job],['resume',job]]){const r=run([...command,'--animation-inventory',plan,'--mechanics-inventory',receipt,'--config',config],preload);assert.equal(r.status,0,r.stdout);assert.deepEqual(r.json.result.inventory,{planPath:plan,inventoryPath:receipt});}
 assert.match(run(['--help']).stdout,/author-clips.*--animation-inventory.*--mechanics-inventory/);
});
test('CLI effect validation reads its exact presentation option when inventory flags are absent',async t=>{
 const {root,config}=await workspace(t),request=path.join(root,'presentation.json'),preload=path.join(root,'effect-validation.cjs');await fs.writeFile(request,'{}');const settings=JSON.parse(await fs.readFile(config));settings.mechanics={sourceRoots:[root]};await fs.writeFile(config,JSON.stringify(settings));
 const plan={characterId:'actor',decisions:[]},receipt={mechanics:[]};await fs.writeFile(preload,`require.cache[require.resolve(${JSON.stringify(path.resolve(__dirname,'../lib/jobs.js'))})]={exports:{openJob:async()=>({manifest:{context:{spec:{id:'actor',style:{}}}},close:async()=>{}})}};require.cache[require.resolve(${JSON.stringify(path.resolve(__dirname,'../lib/effect-build.js'))})]={exports:{captureEffectPlan:async()=>({status:'validated',diagnostics:[],captures:${JSON.stringify([['plan',plan],['inventory',receipt]].map(([kind,value])=>({kind,base64:Buffer.from(JSON.stringify(value)).toString('base64')})))}})}};`);
 const r=run(['validate-effects',path.join(root,'plan.json'),'--inventory',path.join(root,'receipt.json'),'--effect-presentation',request,'--job',path.join(root,'job'),'--config',config],preload);assert.equal(r.status,0,r.stdout);assert.equal(r.json.result.valid,true);
});
async function workspace(t) {
  const scratch = path.resolve(__dirname, '../../.tmp/character-pipeline-tests');
  await fs.mkdir(scratch, {
    recursive: true
  });
  const root = await fs.mkdtemp(path.join(scratch, 'character-cli-'));
  t.after(() => fs.rm(root, {
    recursive: true,
    force: true
  }));
  const config = path.join(root, 'tools.json');
  await fs.writeFile(config, JSON.stringify({
    tools: {
      node: {
        executable: process.execPath,
        versionArgs: ['--version']
      }
    },
    sourceRoots: [root],
    outputRoot: root
  }));
  return {
    root,
    config
  };
}
function run(args, preload) {
  const result = spawnSync(process.execPath, [...(preload ? ['--require', preload] : []), cli, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true
  });
  return {
    ...result,
    json: result.stdout.trim().startsWith('{') ? JSON.parse(result.stdout) : null
  };
}
function componentChassis(){
 const s=require('../lib/spec').createSpec({id:'chassis',description:'Numeric component authoring fixture'}),inheritance={position:true,rotation:true,scale:true},styleHash=require('../lib/assets').hashValue(s.style);
 s.sockets=[{id:'mount',bone:'root',transform:{position:[100,100],rotation:0,scale:[1,1]},types:['module'],capacity:1,inheritance,layer:1,envelope:[512,512]}];
 s.assembly={version:1,styleHash,eventNames:[],descriptors:[{version:1,type:'module',spec:'old.json',mount:{position:[0,0],rotation:0,scale:[1,1]},dimensions:[32,32],styleHash,eventNames:[],layer:1,inheritance}]};return s;
}
test('CLI author-clips expands selected families into one fresh revision without changing inputs',async t=>{
 const {root,config}=await workspace(t),source=path.join(root,'actor.json'),request=path.join(root,'clips.json'),out=path.join(root,'authored.json');
 const created=run(['create','--description','Animation scaffold','--template','humanoid','--out',source,'--config',config]);assert.equal(created.status,0,created.stdout);
 const s=JSON.parse(await fs.readFile(source,'utf8'));s.animations=require('../lib/animation').expandClips(s,[{family:'defend',id:'keep'}]).animations;await fs.writeFile(source,JSON.stringify(s));
 const declaration={version:1,sourceSpecHash:require('../lib/assets').hashValue(require('../lib/spec').assertSpec(s)),clips:['idle',{family:'attack',id:'strike',duration:2,amplitude:0.5,easing:'linear',blendIn:0.2,events:[{id:'custom',name:'custom',time:0.1}]}]};await fs.writeFile(request,JSON.stringify(declaration));
 const before=await fs.readFile(source,'utf8'),requestBefore=await fs.readFile(request,'utf8'),args=target=>['author-clips',source,'--request',request,'--out',target,'--config',config];
 const result=run(args(out));assert.equal(result.status,0,result.stdout);const authored=JSON.parse(await fs.readFile(out,'utf8'));assert.equal(authored.revision,s.revision+1);assert.deepEqual(authored.animations.map(c=>c.id),['keep','idle','strike']);assert.equal(authored.animations[2].duration,2);assert.equal(authored.animations[2].blendIn,0.2);assert.ok(authored.animations[2].events.some(e=>e.id==='custom'));assert.equal(result.json.result.readyToBuild,false);assert.deepEqual(result.json.result.authoredClips,[{id:'idle',family:'idle'},{id:'strike',family:'attack'}]);assert.equal(run(['validate',out,'--config',config]).status,0);
 assert.equal(await fs.readFile(source,'utf8'),before);assert.equal(await fs.readFile(request,'utf8'),requestBefore);
 for(const target of [out,source,request,path.join(root,'..','escape.json'),path.join(root,'missing','new.json')])assert.equal(run(args(target)).status,2);
 declaration.clips=[{family:'hit',id:'keep'}];await fs.writeFile(request,JSON.stringify(declaration));const replaced=path.join(root,'replaced.json');assert.equal(run(args(replaced)).status,0);assert.equal(JSON.parse(await fs.readFile(replaced,'utf8')).animations.length,1);
 assert.match(run(['--help']).stdout,/author-clips SPEC.json/);
});
test('CLI author-clips rejects invalid, stale, incompatible and excessive requests with machine exits',async t=>{
 const {root,config}=await workspace(t),source=path.join(root,'actor.json'),request=path.join(root,'request.json'),out=path.join(root,'out.json'),s=require('../lib/spec').createSpec({id:'actor',description:'Fixture',template:'humanoid'});await fs.writeFile(source,JSON.stringify(s));
 const valid={version:1,sourceSpecHash:require('../lib/assets').hashValue(s),clips:['idle']},args=['author-clips',source,'--request',request,'--out',out,'--config',config];
 for(const value of [null,[],{...valid,extra:true},{...valid,version:2},{...valid,clips:[]},{...valid,clips:Array(65).fill('idle')},{version:1,sourceSpecHash:valid.sourceSpecHash},{...valid,sourceSpecHash:'bad'},{...valid,clips:[{family:'idle',amplitude:-1}]}]){await fs.writeFile(request,JSON.stringify(value));const r=run(args);assert.equal(r.status,2,r.stdout);}
 await fs.writeFile(request,JSON.stringify({...valid,sourceSpecHash:'0'.repeat(64)}));let r=run(args);assert.equal(r.status,2);assert.equal(r.json.error.code,'STALE_CLIP_REQUEST');
 await fs.writeFile(request,JSON.stringify({...valid,clips:['unknown']}));r=run(args);assert.equal(r.status,3);assert.equal(r.json.error.code,'UNSUPPORTED_CLIP');
 const limited=structuredClone(s);for(const bone of limited.bones)bone.limits=[bone.rest.rotation-0.001,bone.rest.rotation+0.001];await fs.writeFile(source,JSON.stringify(limited));await fs.writeFile(request,JSON.stringify({...valid,sourceSpecHash:require('../lib/assets').hashValue(limited),clips:['attack']}));r=run(args);assert.equal(r.status,2,r.stdout);assert.equal(r.json.error.code,'JOINT_LIMIT');
 s.anatomy.roles={};await fs.writeFile(source,JSON.stringify(s));await fs.writeFile(request,JSON.stringify({...valid,sourceSpecHash:require('../lib/assets').hashValue(s)}));r=run(args);assert.equal(r.status,3);assert.equal(r.json.error.code,'UNSUPPORTED_BINDING');
 await fs.writeFile(request,'{');assert.equal(run(args).status,2);await fs.writeFile(request,' '.repeat(8*1024*1024+1));assert.equal(run(args).status,2);
 await assert.rejects(fs.access(out),{code:'ENOENT'});
 assert.equal(run(['author-clips',source,'--out',out,'--config',config]).status,2);
});
test('CLI author-clips exclusive output creation refuses a concurrent writer',async t=>{
 const {root,config}=await workspace(t),source=path.join(root,'actor.json'),request=path.join(root,'request.json'),out=path.join(root,'out.json'),preload=path.join(root,'race.cjs'),s=require('../lib/spec').createSpec({id:'actor',description:'Fixture',template:'humanoid'});await fs.writeFile(source,JSON.stringify(s));await fs.writeFile(request,JSON.stringify({version:1,sourceSpecHash:require('../lib/assets').hashValue(s),clips:['idle']}));
 await fs.writeFile(preload,`const fs=require('node:fs/promises');const original=fs.writeFile;fs.writeFile=async function(file,data,options){if(file===${JSON.stringify(out)}&&options?.flag==='wx')await original(file,'concurrent');return original.apply(this,arguments);};`);
 const r=run(['author-clips',source,'--request',request,'--out',out,'--config',config],preload);assert.equal(r.status,2,r.stdout);assert.equal(r.json.error.code,'OUTPUT_EXISTS');assert.equal(await fs.readFile(out,'utf8'),'concurrent');
});
test('CLI component create writes a fresh compatible scaffold and returns pending authoring metadata',async t=>{
 const {root,config}=await workspace(t),source=path.join(root,'chassis.json'),out=path.join(root,'components','module.json'),s=componentChassis(),bytes=JSON.stringify(s);await fs.writeFile(source,bytes);
 const args=['component','create','--chassis',source,'--socket','mount','--template','custom','--description','Editable module','--id','moduleDefinition','--out',out,'--config',config];
 const result=run(args);assert.equal(result.status,0,result.stdout);const r=result.json.result,created=JSON.parse(await fs.readFile(out,'utf8'));require('../lib/spec').assertSpec(created);
 assert.equal(r.specification,out);assert.equal(created.id,'moduleDefinition');assert.deepEqual(created.parts,[]);assert.deepEqual(created.references,[]);assert.equal(r.descriptor.spec,'components/module.json');assert.deepEqual(r.descriptor.mount.position,[0,0]);assert.equal(r.readyToBuild,false);assert.equal(r.gameAcceptance,false);assert.ok(r.remainingAuthoring.includes('parts'));assert.equal(await fs.readFile(source,'utf8'),bytes);
 assert.equal(run(args).status,2);assert.equal(await fs.readFile(source,'utf8'),bytes);
 assert.match(run(['--help']).stdout,/component create --chassis/);
 const explicit=run(args.map(a=>a===out?path.join(root,'explicit.json'):a).concat(['--type','module']));assert.equal(explicit.status,0,explicit.stdout);
});
test('CLI component create rejects shadowed paths, missing contracts and unsafe or malformed requests',async t=>{
 const {root,config}=await workspace(t),source=path.join(root,'chassis.json'),s=componentChassis(),out=path.join(root,'new.json');await fs.writeFile(source,JSON.stringify(s));
 const args=target=>['component','create','--chassis',source,'--socket','mount','--template','custom','--description','Module','--id','moduleDefinition','--out',target,'--config',config];
 for(const target of [source,path.join(root,'..','escape.json'),path.join(root,'bad.txt'),path.join(root,'CON.json')])assert.equal(run(args(target)).status,2);
 const shadow=path.join(root,'source');await fs.mkdir(shadow);await fs.writeFile(path.join(shadow,'new.json'),'owned elsewhere');const cfg=JSON.parse(await fs.readFile(config));cfg.sourceRoots=[shadow,root];await fs.writeFile(config,JSON.stringify(cfg));const collision=run(args(out));assert.equal(collision.status,2,collision.stdout);assert.match(collision.json.error.message,/shadow/i);await assert.rejects(fs.stat(out),{code:'ENOENT'});
 await fs.rm(path.join(shadow,'new.json'));delete s.assembly;await fs.writeFile(source,JSON.stringify(s));const missing=run(args(out));assert.equal(missing.status,3,missing.stdout);assert.equal(missing.json.error.code,'COMPONENT_CONTRACT_REQUIRED');
 s.assembly=componentChassis().assembly;s.sockets[0].types.push('other');await fs.writeFile(source,JSON.stringify(s));const ambiguous=run(args(out));assert.equal(ambiguous.status,2);assert.equal(ambiguous.json.error.code,'INVALID_COMPONENT');
 for(const a of [['component'],['component','wrong'],['component','create'],args(out).concat(['--id','duplicate'])])assert.equal(run(a).status,2);
});
test('CLI authored component follows normal captured build only after explicit fixture parts and events are supplied',async t=>{
 const {root,config}=await workspace(t),sourceRoot=path.join(root,'sources'),outputRoot=path.join(root,'outputs');await fs.mkdir(sourceRoot);await fs.mkdir(outputRoot);
 const cfg=JSON.parse(await fs.readFile(config));cfg.sourceRoots=[sourceRoot];cfg.outputRoot=outputRoot;await fs.writeFile(config,JSON.stringify(cfg));
 const chassis=componentChassis(),source=path.join(sourceRoot,'chassis.json'),definition=path.join(outputRoot,'components','module.json'),job=path.join(outputRoot,'job');chassis.assembly.eventNames=['pulse'];chassis.assembly.descriptors[0].eventNames=['pulse'];await fs.writeFile(source,JSON.stringify(chassis));
 const made=run(['component','create','--chassis',source,'--socket','mount','--template','custom','--description','Numeric fixture','--id','moduleDefinition','--out',definition,'--config',config]);assert.equal(made.status,0,made.stdout);assert.ok(made.json.result.remainingAuthoring.includes('eventChoreography'));
 const child=JSON.parse(await fs.readFile(definition,'utf8')),art=path.join(sourceRoot,'numeric-fixture.bin');await fs.writeFile(art,'synthetic fixture bytes, no artwork');
 const part={id:'body',role:'body',bone:'root',pivot:[1,1],layer:0,image:{path:art}};child.parts=[part];child.animations=[{id:'pulseClip',duration:1,loop:false,tracks:[],events:[{id:'pulseEvent',name:'pulse',time:.5}]}];await fs.writeFile(definition,JSON.stringify(child));
 chassis.parts=[part];chassis.components=[{id:'moduleInstance',socket:'mount',type:'module',spec:made.json.result.descriptor.spec}];chassis.assembly.descriptors=[made.json.result.descriptor];const authored=path.join(outputRoot,'authored-chassis.json');await fs.writeFile(authored,JSON.stringify(chassis));
 const preload=path.join(root,'synthetic-build.cjs'),engine=path.resolve(__dirname,'../lib/engine.js');
 await fs.writeFile(preload,`const fs=require('node:fs/promises'),path=require('node:path'),engine=require(${JSON.stringify(engine)});require.cache[require.resolve(${JSON.stringify(engine)})].exports={...engine,buildCharacter:async(spec,options)=>engine.buildCharacter(spec,{...options,toolVersions:{python:'fixture',godot:'fixture'},versions:{artwork:'fixture',godot:'fixture'},reviewArtwork:async()=>({approved:process.env.SYNTHETIC_APPROVAL==='yes',status:'awaiting_artwork_approval'}),prepareArtwork:async(input,{partIds,stagingDir})=>{const part=structuredClone(input.parts.find(p=>p.id===partIds[0])),image=path.join(stagingDir,'fixture.bin');await fs.copyFile(part.image.path,image);part.image={path:image,prepared:true,width:4,height:4,alphaBounds:[0,0,4,4],cropTranslation:[0,0],pivot:[1,1],pixelsPerUnit:1};const spec=structuredClone(input);spec.parts[spec.parts.findIndex(p=>p.id===part.id)]=part;return {spec,parts:[{id:part.id,image:part.image,source:{width:4,height:4,pivot:[1,1]},transform:{scale:1,translation:[0,0]}}],diagnostics:[]};},compileGodot:async(input,{stagingDir,componentProjects})=>{if(input.id==='chassis'&&!componentProjects.moduleDefinition)throw Error('Missing component checkpoint');const project=path.join(stagingDir,'godot');await fs.mkdir(project);const scene=path.join(project,'fixture.tscn');await fs.writeFile(scene,'numeric fixture');return {project,scene,frames:[],validation:{valid:true,rendered:false}};}})};`);
 const pending=run(['build',authored,'--job',job,'--no-render','--config',config],preload);assert.equal(pending.status,0,pending.stdout);assert.equal(pending.json.result.status,'awaiting_artwork_approval');
 const approvedPreload=path.join(root,'approved-synthetic-build.cjs');await fs.writeFile(approvedPreload,`process.env.SYNTHETIC_APPROVAL='yes';require(${JSON.stringify(preload)});`);
 const built=run(['build',authored,'--job',job,'--no-render','--config',config],approvedPreload);assert.equal(built.status,0,built.stdout);assert.equal(built.json.result.valid,true);assert.equal(built.json.result.rendered,false);assert.ok(Object.keys(built.json.result.manifest.stages).some(id=>id.startsWith('component-')));
 assert.deepEqual(cfg.sourceRoots,[sourceRoot]);assert.equal(JSON.parse(await fs.readFile(config)).sourceRoots.includes(outputRoot),false);
});
test('CLI component create preserves a concurrent writer and rejects foreign chassis inputs',async t=>{
 const {root,config}=await workspace(t),source=path.join(root,'chassis.json'),out=path.join(root,'components','race.json'),preload=path.join(root,'race.cjs');await fs.writeFile(source,JSON.stringify(componentChassis()));
 const args=['component','create','--chassis',source,'--socket','mount','--template','custom','--description','Module','--id','moduleDefinition','--out',out,'--config',config];
 await fs.writeFile(preload,`const fs=require('node:fs/promises'),write=fs.writeFile;fs.writeFile=async(file,data,options)=>{if(file===${JSON.stringify(out)}&&options?.flag==='wx')await write(file,'concurrent owner');return write(file,data,options);};`);
 const race=run(args,preload);assert.equal(race.status,2,race.stdout);assert.equal(race.json.error.code,'OUTPUT_EXISTS');assert.equal(await fs.readFile(out,'utf8'),'concurrent owner');
 assert.equal(run(args.map(a=>a===source?path.join(root,'..','foreign.json'):a)).status,2);
});
test('CLI fit-rig authors a fresh contained specification without jobs or artwork processing',async t=>{
 const {root,config}=await workspace(t),spec=require('../lib/spec').createSpec({id:'fitted',description:'Landmark scaffold'}),source=path.join(root,'source.json'),request=path.join(root,'landmarks.json'),out=path.join(root,'fitted.json'),bytes=JSON.stringify(spec);
 await fs.writeFile(source,bytes);await fs.writeFile(request,JSON.stringify({version:1,sourceSpecHash:require('../lib/assets').hashValue(spec),bones:[{id:'root',start:[20,30],end:[20,50]}]}));
 const result=run(['fit-rig',source,'--landmarks',request,'--out',out,'--config',config]);assert.equal(result.status,0,result.stdout);const fitted=JSON.parse(await fs.readFile(out,'utf8'));require('../lib/spec').assertSpec(fitted);assert.equal(fitted.revision,2);assert.deepEqual(fitted.bones[0].rest.position,[20,30]);assert.equal(fitted.bones[0].length,20);assert.equal(await fs.readFile(source,'utf8'),bytes);assert.deepEqual((await fs.readdir(root)).sort(),['fitted.json','landmarks.json','source.json','tools.json']);
 for(const target of [out,source,request])assert.equal(run(['fit-rig',source,'--landmarks',request,'--out',target,'--config',config]).status,2);
 assert.equal(run(['fit-rig',source,'--landmarks',request,'--out',path.join(root,'..','escape.json'),'--config',config]).status,2);
 assert.equal(run(['fit-rig',source,'--out',path.join(root,'new.json'),'--config',config]).status,2);
 assert.match(run(['--help']).stdout,/fit-rig SPEC.json --landmarks LANDMARKS.json --out FITTED.json/);
 await fs.writeFile(request,JSON.stringify({version:1,sourceSpecHash:'0'.repeat(64),bones:[]}));const invalid=run(['fit-rig',source,'--landmarks',request,'--out',path.join(root,'invalid.json'),'--config',config]);assert.equal(invalid.status,2,invalid.stdout);assert.equal(invalid.json.error.code,'INVALID_RIG');
});

test('CLI export routes a contained job and explicit namespace through owned delivery',async t=>{
 const {root,config}=await workspace(t),job=path.join(root,'job'),preload=path.join(root,'delivery-mock.cjs');
 await fs.writeFile(preload,`require.cache[require.resolve(${JSON.stringify(path.resolve(__dirname,'../lib/delivery.js'))})]={exports:{exportCharacter:async(job,o)=>({job,namespace:o.namespace,configured:!!o.config.tools,gameAcceptance:false})}};`);
 const result=run(['export',job,'--namespace','mods/my_mod','--config',config],preload);assert.equal(result.status,0,result.stdout);
 assert.equal(result.json.result.job,job);assert.equal(result.json.result.namespace,'mods/my_mod');assert.equal(result.json.result.configured,true);assert.equal(result.json.result.gameAcceptance,false);
 for(const args of [['export',job],['export',job,'--namespace','../foreign'],['export',path.join(root,'..','foreign'),'--namespace','mods/my_mod']])assert.equal(run([...args,'--config',config],preload).status,2);
 assert.match(run(['--help']).stdout,/export JOB_DIRECTORY.*--namespace/);
});

test('CLI export reads an explicit bounded integration request through configured source policy',async t=>{
 const {root,config}=await workspace(t),job=path.join(root,'job'),request=path.join(root,'integration.json'),preload=path.join(root,'integration-delivery.cjs'),integration={namespace:'Example.Character',className:'CharacterPresentation',bounds:{x:0,y:0,width:32,height:32}};
 await fs.writeFile(request,JSON.stringify(integration));await fs.writeFile(preload,`require.cache[require.resolve(${JSON.stringify(path.resolve(__dirname,'../lib/delivery.js'))})]={exports:{exportCharacter:async(job,o)=>({integration:o.integration})}};`);
 const result=run(['export',job,'--namespace','mods/hero','--integration',request,'--config',config],preload);assert.equal(result.status,0,result.stdout);assert.deepEqual(result.json.result.integration,integration);
 assert.equal(run(['export',job,'--namespace','mods/hero','--integration',path.join(root,'..','outside.json'),'--config',config],preload).status,2);
 await fs.writeFile(request,'x'.repeat(4*1024*1024+1));assert.equal(run(['export',job,'--namespace','mods/hero','--integration',request,'--config',config],preload).status,2);
 assert.match(run(['--help']).stdout,/--integration REQUEST.json/);
 await fs.writeFile(preload,`require.cache[require.resolve(${JSON.stringify(path.resolve(__dirname,'../lib/delivery.js'))})]={exports:{exportCharacter:async()=>{throw Object.assign(new Error('Invalid integration class'),{code:'INVALID_STS2_INTEGRATION'});}}};`);
 assert.equal(run(['export',job,'--namespace','mods/hero','--config',config],preload).status,2);
});
test('CLI build and resume accept paired effect artifacts without granting a native capability catalog',async t=>{
 const {root,config}=await workspace(t),file=path.join(root,'robot.json'),job=path.join(root,'job');
 assert.equal(run(['create','--description','Robot','--template','custom','--out',file,'--config',config]).status,0);
 const preload=path.join(root,'effects-engine.cjs'),engine=path.resolve(__dirname,'../lib/engine.js');
 await fs.writeFile(preload,`require.cache[require.resolve(${JSON.stringify(engine)})]={exports:{buildCharacter:async(s,o)=>({effectPlan:o.effectPlan,catalog:!!o.effectCapabilities}),resumeCharacter:async(j,o)=>({effectPlan:o.effectPlan,catalog:!!o.effectCapabilities})}};`);
 const plan=path.join(root,'effects.json'),inventory=path.join(root,'inventory.json');
 for(const command of [['build',file,'--job',job],['resume',job]]){
  const result=run([...command,'--effects',plan,'--inventory',inventory,'--config',config],preload);
  assert.equal(result.status,0,result.stdout);assert.deepEqual(result.json.result.effectPlan,{planPath:plan,inventoryPath:inventory});assert.equal(result.json.result.catalog,false);
  for(const extra of [['--effects',plan],['--inventory',inventory]])assert.equal(run([...command,...extra,'--config',config],preload).status,2);
 }
});
test('CLI help explains implemented commands and unknown/malformed arguments fail clearly', () => {
  assert.equal(run(['--help']).status, 0);
  assert.match(run(['--help']).stdout, /discover.*create.*modify.*validate.*status/s);
  for (const args of [[], ['unknown'], ['create', '--description'], ['create', '--unknown', 'x']]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.json.ok, false);
    assert.ok(result.json.error.message);
  }
});
test('CLI discovers a configured installed tool with JSON stdout', async t => {
  const {
    config
  } = await workspace(t);
  const result = run(['discover', '--config', config, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.result.tools.node.available, true);
});
test('CLI creates, validates and modifies a specification while preserving its prior revision', async t => {
  const {
    root,
    config
  } = await workspace(t);
  const file = path.join(root, 'test-robot.json');
  const created = run(['create', '--description', 'An articulated maintenance robot', '--template', 'mechanical', '--out', file, '--config', config]);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  const first = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(first.id, 'test-robot');
  assert.equal(first.revision, 1);
  assert.equal(run(['validate', file, '--config', config]).status, 0);
  const patch = path.join(root, 'patch.json');
  await fs.writeFile(patch, JSON.stringify({
    description: 'A maintenance robot with blue armor'
  }));
  const modified = run(['modify', file, '--patch', patch, '--config', config]);
  assert.equal(modified.status, 0, modified.stdout + modified.stderr);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).revision, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(modified.json.result.previous, 'utf8')), first);
});
test('CLI reads its own structured outputs and refreshes mechanics evidence before effect validation',async t=>{
  const {root,config}=await workspace(t);
  const assets=path.join(root,'assets'),out=path.join(root,'output'),code=path.join(root,'mechanics');
  for(const folder of [assets,out,code])await fs.mkdir(folder);
  const settings=JSON.parse(await fs.readFile(config));settings.sourceRoots=[assets];settings.outputRoot=out;settings.mechanics={sourceRoots:[code]};await fs.writeFile(config,JSON.stringify(settings));
  const spec=path.join(out,'robot.json');
  assert.equal(run(['create','--description','Robot','--template','custom','--out',spec,'--config',config]).status,0);
  assert.equal(run(['validate',spec,'--config',config]).status,0);
  const source=path.join(code,'SimplePower.cs');await fs.writeFile(source,'class SimplePower { int Amount; }');
  const request=path.join(out,'inspection.json'),receipt=path.join(out,'receipt.json');
  await fs.writeFile(request,JSON.stringify({characterId:'robot',mechanics:[{key:'mod:SimplePower',modId:'mod',modelSymbol:'SimplePower',evidence:[{path:source,symbol:'SimplePower',lineStart:1,lineEnd:1}]}]}));
  const inspected=run(['inspect-mechanics','--request',request,'--out',receipt,'--config',config]);assert.equal(inspected.status,0,inspected.stdout);
  const inventory=JSON.parse(await fs.readFile(receipt));const plan=path.join(out,'effects.json');
  await fs.writeFile(plan,JSON.stringify({version:1,characterId:'robot',mechanicsFingerprint:inventory.fingerprint,inspectionVersion:'1',adapterContractVersion:'unbound-1',evidence:inventory.evidence,decisions:[{id:'counter',mechanicKey:'mod:SimplePower',outcome:'none',reason:'Numeric bookkeeping has no separate visual intent.',evidenceIds:inventory.mechanics[0].evidenceIds}]}));
  const validated=run(['validate-effects',plan,'--inventory',receipt,'--config',config]);assert.equal(validated.status,0,validated.stdout);
  assert.equal(validated.json.result.valid,true);
  await fs.writeFile(source,'class SimplePower { int Amount; int NewMechanic; }');
  const stale=run(['validate-effects',plan,'--inventory',receipt,'--config',config]);assert.equal(stale.status,2,stale.stdout);
  assert.equal(stale.json.error.code,'INVALID_EFFECT_PLAN');
  const before=await fs.readFile(spec,'utf8');
  const collision=run(['inspect-mechanics','--request',request,'--out',spec,'--config',config]);
  assert.equal(collision.status,2,collision.stdout);assert.equal(await fs.readFile(spec,'utf8'),before);
  const sourceRequest=path.join(assets,'inspection.json');await fs.copyFile(request,sourceRequest);
  settings.outputRoot=code;await fs.writeFile(config,JSON.stringify(settings));
  const recursive=run(['inspect-mechanics','--request',sourceRequest,'--out',path.join(code,'receipt.json'),'--config',config]);
  assert.equal(recursive.status,2,recursive.stdout);
  await assert.rejects(fs.stat(path.join(code,'receipt.json')),{code:'ENOENT'});
});
test('CLI refuses invalid specifications/patches and paths outside configured outputs', async t => {
  const {
    root,
    config
  } = await workspace(t);
  const invalid = path.join(root, 'invalid.json');
  await fs.writeFile(invalid, '{"version":999}');
  const validation = run(['validate', invalid, '--config', config]);
  assert.equal(validation.status, 2);
  const file = path.join(root, 'robot.json');
  assert.equal(run(['create', '--description', 'Robot', '--template', 'mechanical', '--out', file, '--config', config]).status, 0);
  const before = await fs.readFile(file, 'utf8');
  const patch = path.join(root, 'bad-patch.json');
  await fs.writeFile(patch, '{"id":"../escape"}');
  assert.equal(run(['modify', file, '--patch', patch, '--config', config]).status, 2);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  const escaped = run(['create', '--description', 'Robot', '--template', 'mechanical', '--out', path.join(root, '..', 'escape-robot.json'), '--config', config]);
  assert.notEqual(escaped.status, 0);
  assert.equal(escaped.json.ok, false);
});
test('CLI reports missing files and oversized input without corrupting JSON stdout', async t => {
  const {
    root,
    config
  } = await workspace(t);
  const absent = run(['validate', path.join(root, 'missing.json'), '--config', config]);
  assert.equal(absent.status, 2);
  assert.equal(absent.json.ok, false);
  const large = path.join(root, 'huge.json');
  await fs.writeFile(large, ' '.repeat(8 * 1024 * 1024 + 1));
  const result = run(['validate', large, '--config', config]);
  assert.equal(result.status, 2);
  assert.match(result.json.error.message, /limit|large|size/i);
});
test('CLI never claims rendered validation when no render backend is registered', async t => {
  const {
    root,
    config
  } = await workspace(t);
  const file = path.join(root, 'robot.json');
  assert.equal(run(['create', '--description', 'Robot', '--template', 'mechanical', '--out', file, '--config', config]).status, 0);
  const result = run(['validate', file, '--render', '--config', config]);
  assert.equal(result.status, 3);
  assert.equal(result.json.ok, false);
});
test('CLI status reads a persisted job and create refuses to overwrite a specification', async t => {
  const {
    root,
    config
  } = await workspace(t);
  const {
    openJob
  } = require('../lib/jobs');
  const directory = path.join(root, 'job');
  const job = await openJob(directory, {
    spec: {
      id: 'fixture'
    }
  });
  try {
    await job.run([{
      id: 'fixture',
      run: async ({
        stagingDir
      }) => fs.writeFile(path.join(stagingDir, 'data.txt'), 'preserved output')
    }]);
  } finally {
    await job.close();
  }
  const result = run(['status', directory, '--config', config]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.json.result.context.spec.id, 'fixture');
  assert.equal(result.json.result.stages.fixture.artifacts[0].path, 'data.txt');
  const file = path.join(root, 'robot.json');
  const args = ['create', '--description', 'Robot', '--template', 'mechanical', '--out', file, '--config', config];
  assert.equal(run(args).status, 0);
  const before = await fs.readFile(file, 'utf8');
  const collision = run(args);
  assert.equal(collision.status, 2);
  assert.equal(collision.json.error.code, 'OUTPUT_EXISTS');
  assert.equal(await fs.readFile(file, 'utf8'), before);
});
test('CLI rejects malformed JSON and unconfigured source reads', async t => {
  const {
    root,
    config
  } = await workspace(t);
  const file = path.join(root, 'bad.json');
  await fs.writeFile(file, '{not valid');
  assert.equal(run(['validate', file, '--config', config]).status, 2);
  const outside = run(['validate', path.resolve(__dirname, '../config/tools.example.json'), '--config', config]);
  assert.equal(outside.status, 2);
  assert.equal(outside.json.error.code, 'PATH_ESCAPE');
  assert.equal(run(['discover', '--config', config, '--config', config]).status, 2);
  assert.equal(run(['create', '--description', 'Robot', '--config', config]).status, 2);
  assert.equal(run(['modify', file, '--config', config]).status, 2);
});
test('CLI classifies filesystem runtime failures and standard cancellation codes for callers', async t => {
  const {
    root,
    config
  } = await workspace(t);
  for (const [code, exitCode] of [['EIO', 5], ['ENOSPC', 5], ['EACCES', 5], ['ABORT_ERR', 130], ['ABORTED', 130]]) {
    const preload = path.join(root, `inject-${code}.cjs`);
    await fs.writeFile(preload, `const fs = require('node:fs/promises'); const original = fs.stat; fs.stat = async function(file, ...args) { if (file === ${JSON.stringify(config)}) { const error = new Error('injected ${code} while accessing configured input'); error.code = '${code}'; throw error; } return original.call(this,file,...args); };`);
    const result = run(['discover', '--config', config], preload);
    assert.equal(result.status, exitCode, `${code}: ${result.stdout}`);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.error.code, code);
    assert.match(result.json.error.message, new RegExp(code));
  }
});
test('CLI build, resume and rendered validation route through the native engine', async t => {
  const {
    root,
    config
  } = await workspace(t);
  const file = path.join(root, 'robot.json');
  const job = path.join(root, 'job');
  assert.equal(run(['create', '--description', 'Robot', '--template', 'mechanical', '--out', file, '--config', config]).status, 0);
  const preload = path.join(root, 'engine-mock.cjs');
  const engine = path.resolve(__dirname, '../lib/engine.js');
  await fs.writeFile(preload, `require.cache[require.resolve(${JSON.stringify(engine)})]={exports:{buildCharacter:async(spec,options)=>({method:'build',id:spec.id,rendered:options.render,jobRoot:options.jobRoot,configured:!!options.config.tools}),resumeCharacter:async(jobRoot,options)=>({method:'resume',jobRoot,rendered:options.render})}};`);
  for (const command of [['build', file, '--job', job], ['validate', file, '--render', '--job', job]]) {
    const result = run([...command, '--config', config], preload);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.json.result.method, 'build');
    assert.equal(result.json.result.jobRoot, job);
    assert.equal(result.json.result.rendered, true);
    assert.equal(result.json.result.configured, true);
  }
  const resume = run(['resume', job, '--config', config], preload);
  assert.equal(resume.status, 0, resume.stdout);
  assert.equal(resume.json.result.method, 'resume');
  assert.equal(resume.json.result.rendered, undefined);
  const noRenderResume = run(['resume', job, '--no-render', '--config', config], preload);
  assert.equal(noRenderResume.status, 0, noRenderResume.stdout);
  assert.equal(noRenderResume.json.result.rendered, false);
  const structural = run(['build', file, '--job', job, '--no-render', '--config', config], preload);
  assert.equal(structural.status, 0, structural.stdout);
  assert.equal(structural.json.result.rendered, false);
  assert.equal(run(['build', file, '--config', config], preload).status, 2);
  const escape = run(['build', file, '--job', path.join(root, '..', 'escaped-job'), '--config', config], preload);
  assert.equal(escape.status, 2);
});
test('CLI engine failures retain capability, validation, runtime and cancellation exits', async t => {
  const {
    root,
    config
  } = await workspace(t);
  const file = path.join(root, 'robot.json');
  const job = path.join(root, 'job');
  assert.equal(run(['create', '--description', 'Robot', '--template', 'mechanical', '--out', file, '--config', config]).status, 0);
  for (const [code, exit] of [['CAPABILITY_MISSING', 3], ['VALIDATION_FAILED', 4], ['VISUAL_VALIDATION_FAILED',4], ['AUTHORED_GEOMETRY_FAILED',4], ['INVALID_AUTHORED_GEOMETRY',2], ['ART_PREP_FAILED', 5], ['ABORTED', 130]]) {
    const preload = path.join(root, `engine-${code}.cjs`);
    await fs.writeFile(preload, `require.cache[require.resolve(${JSON.stringify(path.resolve(__dirname, '../lib/engine.js'))})]={exports:{buildCharacter:async()=>{throw Object.assign(new Error('engine failed'),{code:${JSON.stringify(code)}})}}};`);
    const result = run(['build', file, '--job', job, '--config', config], preload);
    assert.equal(result.status, exit, result.stdout);
    assert.equal(result.json.error.code, code);
  }
});
test('CLI approve-artwork requires exact review ID and passes contained job to review service', async t => {
  const {
    root,
    config
  } = await workspace(t);
  const job = path.join(root, 'job');
  const preload = path.join(root, 'review-mock.cjs');
  const review = path.resolve(__dirname, '../lib/artwork-review.js');
  await fs.writeFile(preload, `require.cache[require.resolve(${JSON.stringify(review)})]={exports:{approveArtwork:async(job,options)=>({job,reviewId:options.reviewId,configured:!!options.config.tools})}};`);
  const result = run(['approve-artwork', job, '--review', 'review-123', '--config', config], preload);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.json.result.job, job);
  assert.equal(result.json.result.reviewId, 'review-123');
  assert.equal(result.json.result.configured, true);
  for (const args of [['approve-artwork', job], ['approve-artwork', '--review', 'review-123'], ['approve-artwork', job, '--review'], ['approve-artwork', job, '--review', 'review-123', '--review', 'review-456']]) assert.equal(run([...args, '--config', config], preload).status, 2);
  assert.equal(run(['approve-artwork', path.join(root, '..', 'outside'), '--review', 'review-123', '--config', config], preload).status, 2);
  assert.match(run(['--help']).stdout, /approve-artwork.*--review/);
});
test('CLI artwork approval reports stale IDs, corruption and operational failures with exact exit codes', async t => {
  const {
    root,
    config
  } = await workspace(t);
  const job = path.join(root, 'job');
  for (const [code, exit] of [['STALE_REVIEW', 2], ['CORRUPT_ARTIFACT', 4], ['CAPABILITY_MISSING', 3], ['EIO', 5]]) {
    const preload = path.join(root, `review-${code}.cjs`);
    await fs.writeFile(preload, `require.cache[require.resolve(${JSON.stringify(path.resolve(__dirname, '../lib/artwork-review.js'))})]={exports:{approveArtwork:async()=>{throw Object.assign(new Error('approval failed'),{code:${JSON.stringify(code)}})}}};`);
    const result = run(['approve-artwork', job, '--review', 'review-123', '--config', config], preload);
    assert.equal(result.status, exit, result.stdout);
    assert.equal(result.json.error.code, code);
  }
});
test('CLI status preserves manifest fields and includes the exact artwork review preview', async t => {
  const {
    root,
    config
  } = await workspace(t);
  const job = path.join(root, 'job');
  const preload = path.join(root, 'status-review.cjs');
  const service = path.resolve(__dirname, '../lib/artwork-review.js');
  const jobs = path.resolve(__dirname, '../lib/jobs.js');
  await fs.writeFile(preload, `require.cache[require.resolve(${JSON.stringify(jobs)})]={exports:{inspectJob:async()=>({jobId:'owned',context:{spec:{id:'robot'}},stages:{}})}};require.cache[require.resolve(${JSON.stringify(service)})]={exports:{inspectArtworkReview:async(job,options)=>({reviewId:'review-exact',status:'awaiting_artwork_approval',previews:[job+'/review/original.png'],configured:!!options.config.tools})}};`);
  const result = run(['status', job, '--config', config], preload);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.json.result.jobId, 'owned');
  assert.equal(result.json.result.context.spec.id, 'robot');
  assert.equal(result.json.result.artworkReview.reviewId, 'review-exact');
  assert.equal(result.json.result.artworkReview.previews[0], job + '/review/original.png');
  assert.equal(result.json.result.artworkReview.configured, true);
});

test('effect presentation CLI requires a plan pair and validation job',()=>{
 assert.match(run(['build','s.json','--job','job','--effect-presentation','r.json']).json.error.message,/require.*effects|requires.*effects/i);
 assert.match(run(['validate-effects','p.json','--inventory','i.json','--effect-presentation','r.json']).json.error.message,/job/i);
 assert.doesNotMatch(run(['resume','job','--effect-presentation','r.json']).json.error.message,/Unknown/);
});

test('CLI build and resume pass only contained JSON presentation declarations',async t=>{
 const {root,config}=await workspace(t),file=path.join(root,'spec.json'),job=path.join(root,'job'),request=path.join(root,'request.json'),preload=path.join(root,'request-engine.cjs');
 assert.equal(run(['create','--description','Synthetic','--template','custom','--out',file,'--config',config]).status,0);
 const declaration={version:1,targets:{tip:{partId:'body'}}};await fs.writeFile(request,JSON.stringify(declaration));
 await fs.writeFile(preload,`require.cache[require.resolve(${JSON.stringify(path.resolve(__dirname,'../lib/engine.js'))})]={exports:{buildCharacter:async(s,o)=>({request:o.effectPresentation}),resumeCharacter:async(j,o)=>({request:o.effectPresentation})}};`);
 for(const command of [['build',file,'--job',job],['resume',job]]){
  const result=run([...command,'--effects',path.join(root,'plan.json'),'--inventory',path.join(root,'inventory.json'),'--effect-presentation',request,'--config',config],preload);assert.equal(result.status,0,result.stdout);assert.deepEqual(result.json.result.request,declaration);
  const outside=run([...command,'--effects','plan.json','--inventory','inventory.json','--effect-presentation',path.join(root,'..','outside.json'),'--config',config],preload);assert.equal(outside.status,2);
 }
});

test('CLI modify --job persists only inside checked rebuild and serializes recovery after failure',async t=>{
 const {root,config}=await workspace(t),file=path.join(root,'robot.json'),patch=path.join(root,'patch.json'),job=path.join(root,'job'),preload=path.join(root,'modify-engine.cjs'),engine=path.resolve(__dirname,'../lib/engine.js');
 assert.equal(run(['create','--description','Robot','--template','custom','--out',file,'--config',config]).status,0);await fs.writeFile(patch,JSON.stringify({description:'Revised robot'}));const original=await fs.readFile(file,'utf8'),backup=file+'.revision-1.json';
 const args=['modify',file,'--patch',patch,'--job',job,'--config',config];
 await fs.writeFile(preload,`require.cache[require.resolve(${JSON.stringify(engine)})]={exports:{rebuildCharacter:async()=>{throw Object.assign(Error('Wrong job'),{code:'STALE_JOB_CONTEXT'});}}};`);
 const stale=run(args,preload);assert.equal(stale.status,2,stale.stdout);assert.equal(stale.json.error.code,'STALE_JOB_CONTEXT');assert.equal(await fs.readFile(file,'utf8'),original);await assert.rejects(fs.stat(backup),{code:'ENOENT'});
 await fs.writeFile(preload,`require.cache[require.resolve(${JSON.stringify(engine)})]={exports:{rebuildCharacter:async(before,after,o)=>{await o.persistModification();return {status:'awaiting_artwork_approval',jobRoot:o.jobRoot,id:after.id};}}};`);
 const success=run(args,preload);assert.equal(success.status,0,success.stdout);assert.equal(success.json.result.build.status,'awaiting_artwork_approval');assert.equal(JSON.parse(await fs.readFile(file)).revision,2);assert.deepEqual(JSON.parse(await fs.readFile(backup)),JSON.parse(original));
 await fs.rm(backup);await fs.writeFile(file,original);
 await fs.writeFile(preload,`require.cache[require.resolve(${JSON.stringify(engine)})]={exports:{rebuildCharacter:async(before,after,o)=>{await o.persistModification();throw Object.assign(Error('Compile failed'),{code:'VALIDATION_FAILED',recovery:{untrusted:'do not serialize'}});}}};`);
 const failure=run(args,preload);assert.equal(failure.status,4,failure.stdout);assert.equal(failure.json.ok,false);assert.equal(failure.json.error.recovery.specification,file);assert.equal(failure.json.error.recovery.jobRoot,job);assert.equal(failure.json.error.recovery.revision,2);assert.match(failure.json.error.recovery.nextAction,/status.*resume.*build/i);assert.equal(failure.json.error.recovery.untrusted,undefined);assert.equal(JSON.parse(await fs.readFile(file)).revision,2);assert.ok(await fs.stat(backup));
});

test('CLI modify refuses aliases, backup collisions and concurrent writers without overwriting source',async t=>{
 const {root,config}=await workspace(t),file=path.join(root,'robot.json'),patch=path.join(root,'patch.json'),job=path.join(root,'job'),backup=file+'.revision-1.json',preload=path.join(root,'modify-race.cjs');
 assert.equal(run(['create','--description','Robot','--template','custom','--out',file,'--config',config]).status,0);await fs.writeFile(patch,JSON.stringify({description:'New'}));const original=await fs.readFile(file,'utf8');
 const args=['modify',file,'--patch',patch,'--job',job,'--config',config],engine=path.resolve(__dirname,'../lib/engine.js');
 await fs.writeFile(preload,`const fs=require('node:fs/promises'),write=fs.writeFile;require.cache[require.resolve(${JSON.stringify(engine)})]={exports:{rebuildCharacter:async(a,b,o)=>{await o.persistModification();return {};}}};fs.writeFile=async(file,data,options)=>{if(file===${JSON.stringify(backup)}&&options?.flag==='wx')await write(file,'concurrent owner');return write(file,data,options);};`);
 const race=run(args,preload);assert.equal(race.status,2,race.stdout);assert.equal(race.json.error.code,'OUTPUT_EXISTS');assert.equal(await fs.readFile(backup,'utf8'),'concurrent owner');assert.equal(await fs.readFile(file,'utf8'),original);
 assert.equal(run(args).status,2);await fs.rm(backup);
 for(const other of [file,patch,backup])assert.equal(run(args.map(a=>a===job?other:a),preload).status,2);
 const changed=path.join(root,'changed.cjs');await fs.writeFile(changed,`const fs=require('node:fs/promises');require.cache[require.resolve(${JSON.stringify(engine)})]={exports:{rebuildCharacter:async(a,b,o)=>{await fs.writeFile(${JSON.stringify(file)},'concurrent source');await o.persistModification();return {};}}};`);
 const sourceRace=run(args,changed);assert.equal(sourceRace.status,2,sourceRace.stdout);assert.equal(sourceRace.json.error.code,'STALE_JOB_CONTEXT');assert.equal(await fs.readFile(file,'utf8'),'concurrent source');await assert.rejects(fs.stat(backup),{code:'ENOENT'});
});

test('CLI modify --job uses actual rebuild with source-free snapshots and inherited render',async t=>{
 const {root,config}=await workspace(t),file=path.join(root,'robot.json'),patch=path.join(root,'patch.json'),job=path.join(root,'job'),art=path.join(root,'fixture.bin'),preload=path.join(root,'actual-modify.cjs'),engine=path.resolve(__dirname,'../lib/engine.js');
 const spec=require('../lib/spec').createSpec({id:'robot',description:'Numeric fixture'});spec.parts=[{id:'body',role:'body',bone:'root',pivot:[1,1],layer:0,image:{path:art}}];await fs.writeFile(art,'synthetic bytes');await fs.writeFile(file,JSON.stringify(spec));await fs.writeFile(patch,JSON.stringify({animations:[{id:'idle',duration:1,loop:true,tracks:[],events:[]}]}));
 await fs.writeFile(preload,`const fs=require('node:fs/promises'),path=require('node:path'),engine=require(${JSON.stringify(engine)}),injected={toolVersions:{python:'fixture',godot:'fixture'},versions:{artwork:'fixture',godot:'fixture'},reviewArtwork:async()=>({approved:true}),prepareArtwork:async(input,{stagingDir})=>{const spec=structuredClone(input),image=path.join(stagingDir,'prepared.bin');await fs.copyFile(spec.parts[0].image.path,image);spec.parts[0].image={path:image,prepared:true,width:4,height:4,alphaBounds:[0,0,4,4],cropTranslation:[0,0],pivot:[1,1],pixelsPerUnit:1};return {spec,parts:[{id:'body',image:spec.parts[0].image,source:{width:4,height:4,pivot:[1,1]},transform:{scale:1,translation:[0,0]}}],diagnostics:[]};},compileGodot:async(input,{stagingDir})=>{const project=path.join(stagingDir,'godot');await fs.mkdir(project);const scene=path.join(project,'fixture.tscn');await fs.writeFile(scene,'numeric fixture');return {project,scene,frames:[],validation:{valid:true,rendered:false}};}};require.cache[require.resolve(${JSON.stringify(engine)})].exports={...engine,buildCharacter:(s,o)=>engine.buildCharacter(s,{...o,...injected}),rebuildCharacter:(a,b,o)=>engine.rebuildCharacter(a,b,{...o,...injected})};`);
 const built=run(['build',file,'--job',job,'--no-render','--config',config],preload);assert.equal(built.status,0,built.stdout);assert.equal(built.json.result.rendered,false);await fs.rm(art);
 const modified=run(['modify',file,'--patch',patch,'--job',job,'--config',config],preload);assert.equal(modified.status,0,modified.stdout);assert.equal(modified.json.result.build.valid,true);assert.equal(modified.json.result.build.rendered,false);assert.equal(modified.json.result.build.manifest.context.spec.revision,2);assert.deepEqual(modified.json.result.build.manifest.context.settings.effectPlan,built.json.result.manifest.context.settings.effectPlan);assert.deepEqual(modified.json.result.build.manifest.context.settings.effectPresentation,built.json.result.manifest.context.settings.effectPresentation);
});

test('CLI modify refuses Windows casing aliases between the job and revision inputs', {skip:process.platform!=='win32'}, async t=>{
 const {root,config}=await workspace(t),folder=path.join(root,'job'),file=path.join(folder,'robot.json'),patch=path.join(root,'patch.json');await fs.mkdir(folder);await fs.writeFile(file,JSON.stringify(require('../lib/spec').createSpec({id:'robot',description:'Fixture'})));await fs.writeFile(patch,JSON.stringify({description:'Changed'}));const before=await fs.readFile(file,'utf8');
 const alias=folder.slice(0,-3)+'JOB',result=run(['modify',file,'--patch',patch,'--job',alias,'--config',config]);assert.equal(result.status,2,result.stdout);assert.equal(result.json.error.code,'UNSAFE_PATH');assert.equal(await fs.readFile(file,'utf8'),before);await assert.rejects(fs.stat(file+'.revision-1.json'),{code:'ENOENT'});
 const same=run(['modify',file,'--patch',file.toUpperCase(),'--config',config]);assert.equal(same.status,2,same.stdout);assert.equal(same.json.error.code,'UNSAFE_PATH');
});

test('CLI package invokes owned packaging with an explicit request and refresh only',async t=>{
 const {root,config}=await workspace(t),job=path.join(root,'job'),request=path.join(root,'package.json'),preload=path.join(root,'package-preload.cjs');await fs.mkdir(job);await fs.writeFile(request,JSON.stringify({version:1,marker:'exact'}));
 await fs.writeFile(preload,`const Module=require('node:module'),load=Module._load;Module._load=function(id,...args){if(id.endsWith('/lib/mod-package')||id==='./lib/mod-package')return {packageCharacter:async(job,o)=>{if(o.request.marker!=='exact'||!o.config.outputRoot)throw Error('Bad request');return {status:'packaged',jobRoot:job,refresh:o.refresh,gameAcceptance:false};}};return load.call(this,id,...args);};`);
 for(const refresh of [false,true]){const r=run(['package',job,'--request',request,...(refresh?['--refresh']:[]),'--config',config],preload);assert.equal(r.status,0,r.stdout);assert.equal(r.json.result.jobRoot,job);assert.equal(r.json.result.refresh,refresh);assert.equal(r.json.result.gameAcceptance,false);}
 for(const args of [['package',job],['package',job,'--request'],['package',job,'--request',request,'--refresh','true'],['package',job,'--request',request,'--namespace','mods/x'],['package',job,'--request',request,'--refresh','--refresh']])assert.equal(run([...args,'--config',config],preload).status,2);
 assert.equal(run(['package',path.join(root,'..','outside'),'--request',request,'--config',config],preload).status,2);
 assert.equal(run(['package',job,'--request',path.join(root,'..','outside.json'),'--config',config],preload).status,2);
 assert.match(run(['--help']).stdout,/package JOB_DIRECTORY --request REQUEST.json/);
});

test('CLI package reports typed request refresh build and cancellation failures',async t=>{
 const {root,config}=await workspace(t),job=path.join(root,'job'),request=path.join(root,'package.json'),preload=path.join(root,'package-failure.cjs');await fs.mkdir(job);await fs.writeFile(request,'{}');
 for(const [code,expected]of [['INVALID_MOD_PACKAGE',2],['INVALID_PACKAGE_REQUEST',2],['INVALID_MOD_BUILD',2],['INVALID_MOD_ASSEMBLY',4],['PACKAGE_REFRESH_REQUIRED',3],['PACKAGE_NOT_READY',3],['CAPABILITY_MISSING',3],['MOD_BUILD_FAILED',4],['CORRUPT_ARTIFACT',4],['ABORTED',130]]){
  await fs.writeFile(preload,`const Module=require('node:module'),load=Module._load;Module._load=function(id,...args){if(id.endsWith('/lib/mod-package')||id==='./lib/mod-package')return {packageCharacter:async()=>{throw Object.assign(Error('Package failed'),{code:${JSON.stringify(code)}});}};return load.call(this,id,...args);};`);
  const r=run(['package',job,'--request',request,'--config',config],preload);assert.equal(r.status,expected,r.stdout);assert.equal(r.json.error.code,code);
 }
});
