'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {createAssemblyPlanner}=require('../../lib/components'),{runTool}=require('../../lib/process'),{resolveContained}=require('../../lib/assets');
function fixtures(){
 const transform=()=>({position:[0,0],rotation:0,scale:[1,1]}),inheritance={position:true,rotation:true,scale:true};
 const descriptor=type=>({version:1,type,spec:`components/${type}.json`,mount:transform(),dimensions:[20,40],styleHash:'a'.repeat(64),eventNames:['fire'],layer:1,inheritance:{...inheritance}});
 const config=()=>({styleHash:'a'.repeat(64),eventNames:['fire'],sockets:[{id:'left',bone:'root',transform:transform(),types:['arm','claw'],capacity:1,inheritance:{...inheritance},layer:1,envelope:[100,100]},{id:'right',bone:'root',transform:{...transform(),position:[100,50]},types:['arm','claw'],capacity:1,inheritance:{...inheritance},layer:1,envelope:[100,100]}],descriptors:[descriptor('arm'),descriptor('claw')]});
 const part=(extra={})=>({id:'weapon',socket:'left',type:'arm',revision:1,damageState:'intact',upgrade:0,visualMode:'idle',...extra});
 const state=(components=[],extra={})=>({version:1,instanceId:'robot',sequence:0,revision:1,lifecycle:'alive',visualMode:'idle',components,...extra});
 const cases=[],add=(name,c,method,args)=>{let expected;try{const p=createAssemblyPlanner(c);expected=method==='configure'?true:p[method](...args);}catch(e){assert.equal(e.code,'INVALID_COMPONENT');expected=method==='configure'?false:{error:'INVALID_COMPONENT'};}cases.push({name,config:c,method,args,expected});};
 for(const [name,s]of [['empty',state()],['installed',state([part()])],['dead',state([part({damageState:'destroyed'})],{lifecycle:'dead',visualMode:'guard'})],['removed',state([],{lifecycle:'removed'})]])add(`bootstrap-${name}`,config(),'bootstrap',[s]);
 const plan=(name,b,a,c=config())=>add(name,c,'plan',[b,a]);
 plan('install',state(),state([part()],{revision:2,sequence:1}));
 plan('remove',state([part()]),state([],{revision:2,sequence:1}));
 plan('replace-type',state([part()]),state([part({type:'claw',revision:2})],{revision:2}));
 plan('replace-socket',state([part()]),state([part({socket:'right',revision:2})],{revision:2}));
 plan('upgrade-damage-mode',state([part()]),state([part({revision:2,upgrade:3,damageState:'damaged',visualMode:'hit'})],{revision:2,visualMode:'attack'}));
 plan('repair',state([part({damageState:'damaged'})]),state([part({revision:2})],{revision:2}));
 plan('death-destroy',state([part()]),state([part({revision:2,damageState:'destroyed'})],{revision:2,lifecycle:'dead'}));
 plan('revive-install',state([],{lifecycle:'dead'}),state([part()],{revision:2}));
 plan('terminal-removal',state([part()]),state([],{revision:2,lifecycle:'removed'}));
 plan('reordered-equal',state([part(),part({id:'second',socket:'right'})]),state([part({id:'second',socket:'right'}),part()],{sequence:8}));
 const mirrored=config();mirrored.sockets[0].transform={position:[100,50],rotation:0.72,scale:[-1.7,2.3]};mirrored.descriptors[0].mount={position:[10,20],rotation:-0.31,scale:[-2,0.7]};
 add('mirrored-rotated-nonuniform',mirrored,'bootstrap',[state([part()])]);
 const tiny=config();tiny.sockets[0].transform.scale=[1e-8,1e-8];add('tiny-consumer-independent-frame',tiny,'bootstrap',[state([part()])]);
 const partial=config();partial.sockets[0].inheritance.rotation=false;partial.sockets[1].inheritance.rotation=false;for(const d of partial.descriptors)d.inheritance.rotation=false;add('pure-partial-inheritance',partial,'bootstrap',[state([part()])]);
 const shared=config();shared.sockets[0].capacity=2;shared.descriptors[1].mount.position=[10,20];add('same-socket-distinct-frames',shared,'bootstrap',[state([part(),part({id:'second',type:'claw'})])]);
 const conflict=config();conflict.sockets[0].capacity=2;add('same-socket-conflicting-frames',conflict,'bootstrap',[state([part(),part({id:'second',type:'claw'})])]);
 const boundary=config();boundary.sockets[0].envelope=[20-5e-10,40];add('envelope-tolerance',boundary,'bootstrap',[state([part()])]);
 add('safe-integer-boundary',config(),'bootstrap',[state([part({revision:Number.MAX_SAFE_INTEGER})],{revision:Number.MAX_SAFE_INTEGER,sequence:Number.MAX_SAFE_INTEGER})]);
 for(const [name,mutate]of [
  ['extra-field',c=>c.extra=true],['duplicate-socket',c=>c.sockets.push(c.sockets[0])],['duplicate-descriptor',c=>c.descriptors.push(c.descriptors[0])],['duplicate-type',c=>c.sockets[0].types.push('arm')],['bad-capacity',c=>c.sockets[0].capacity=0],['style',c=>c.descriptors[0].styleHash='b'.repeat(64)],['event',c=>c.descriptors[0].eventNames=['unknown']],['layer',c=>c.descriptors[0].layer=2],['inheritance',c=>c.descriptors[0].inheritance.scale=false],['envelope',c=>c.sockets[0].envelope=[19,40]],['singular',c=>c.descriptors[0].mount.scale=[0,1]],['frame-bound',c=>c.descriptors[0].mount.scale=[1e-15,1]],['pivot',c=>c.descriptors[0].mount.position=[21,0]],['path',c=>c.descriptors[0].spec='../escape.json'],['no-compatible',c=>c.descriptors[0].type='unknown'],['unknown-socket-field',c=>c.sockets[0].bad=true],['too-many-socket-types',c=>c.sockets[0].types=Array.from({length:65},(_,i)=>'type'+i)]]){const c=config();mutate(c);add(`invalid-config-${name}`,c,'configure',[]);}
 for(const [name,s]of [['revision-zero',state([],{revision:0})],['unsafe-integer',state([],{sequence:Number.MAX_SAFE_INTEGER+1})],['unknown-type',state([part({type:'unknown'})])],['unknown-damage',state([part({damageState:'custom'})])],['duplicate-component',state([part(),part()])],['removed-occupied',state([part()],{lifecycle:'removed'})],['unknown-state-field',{...state(),extra:true}]])add(`invalid-bootstrap-${name}`,config(),'bootstrap',[s]);
 for(const [name,b,a]of [['sequence-rollback',state([],{sequence:2}),state([],{revision:2,sequence:1})],['revision-rollback',state([],{revision:2}),state()],['owner',state(),state([],{instanceId:'other'})],['removed-revive',state([],{lifecycle:'removed'}),state([],{revision:2})],['same-revision-change',state(),state([part()])],['component-rollback',state([part({revision:2})]),state([part()],{revision:2})],['component-conflict',state([part()]),state([part({upgrade:1})],{revision:2})]])plan(`invalid-plan-${name}`,b,a);
 return {cases,isolation:{config:config(),snapshot:state([part()]),expected:createAssemblyPlanner(config()).bootstrap(state([part()]))}};
}
async function main(){
 const root=path.resolve(__dirname,'../..'),i=process.argv.indexOf('--evidence'),relative=i<0?'evidence/w5-assembly-planner-native':process.argv[i+1];if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Use pipeline-relative evidence directory.');
 const out=await resolveContained(root,relative,{mustExist:false});await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'fixture.json'),JSON.stringify(fixtures()));
 await fs.writeFile(path.join(out,'project.godot'),'config_version=5\n');
 for(const [source,target]of [['../../godot/assembly_planner.gd','assembly_planner.gd'],['../../godot/state_reconciler.gd','state_reconciler.gd'],['assembly_planner_runtime.gd','probe.gd']])await fs.copyFile(path.join(__dirname,source),path.join(out,target));
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json'))),tool=config.tools.megadot;
 const result=await runTool({native:{...tool,cwd:path.dirname(tool.executable)}},'native',['--headless','--path',out,'--script','res://probe.gd'],{timeoutMs:30000});await fs.writeFile(path.join(out,'process.json'),JSON.stringify(result,null,2));
 if(result.exitCode||result.error||/SCRIPT ERROR|ERROR:/.test(result.stdout+result.stderr))throw Error(JSON.stringify(result));const report=JSON.parse(await fs.readFile(path.join(out,'validation.json')));assert.ok(report.checks.length&&report.checks.every(c=>c.passed));console.log(JSON.stringify(report));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={fixtures};
