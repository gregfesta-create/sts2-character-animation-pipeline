'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {createStateReconciler}=require('../../lib/state');const {runTool}=require('../../lib/process');const {resolveContained}=require('../../lib/assets');
function fixtures(){
 const config=owner=>({instanceId:owner,sockets:[{id:'arm',capacity:2,types:['weapon']}]}),part=(id='left',revision=1)=>({id,socket:'arm',type:'weapon',revision,damageState:'intact',upgrade:0,visualMode:'idle'});
 const snapshot=(owner,sequence=0,revision=1,components=[],lifecycle='alive')=>({version:1,instanceId:owner,sequence,revision,lifecycle,visualMode:'idle',components});
 const event=(owner,sequence,revision,type,payload)=>({version:1,instanceId:owner,sequence,revision,type,payload});
 const S=message=>({method:'snapshot',message}),E=message=>({method:'event',message}),owner='robotOne';
 const cases=[
  {name:'bootstrap-gap-recovery',config:config(owner),steps:[E(event(owner,2,3,'upsert',part())),S(snapshot(owner,1,2)),S(snapshot(owner,2,3,[part()])),E(event(owner,3,4,'upsert',{...part('left',2),upgrade:3})),E(event(owner,3,4,'remove',{id:'left'})),E(event(owner,5,6,'remove',{id:'left'})),E(event(owner,4,5,'visualMode',{visualMode:'hit'})),S(snapshot(owner,5,5)),S(snapshot(owner,5,6,[part('left',2)])),S(snapshot(owner,4,7)),S(snapshot(owner,5,6,[]))]},
  {name:'conflicts-atomicity',config:config(owner),steps:[S(snapshot(owner,0,1,[part()])),E(event(owner,1,2,'upsert',{...part(),upgrade:2})),E(event(owner,1,1,'visualMode',{visualMode:'hit'})),E(event(owner,1,2,'upsert',part('right'))),S(snapshot(owner,2,3,[part('left',0)])),E(event(owner,2,3,'remove',{id:'missing'})),S(snapshot(owner,2,3,[part(),part('right'),part('third')])),E(event('other',2,3,'remove',{id:'left'})),E({...event(owner,2,3,'remove',{id:'left'}),extra:true}),S({...snapshot(owner,2,3),sequence:9007199254740992}),E(event(owner,2,3,'upsert',{...part('left',2),damageState:'customState'}))]},
  {name:'lifecycle-terminal',config:config(owner),steps:[S(snapshot(owner,0,1,[part()])),E(event(owner,1,2,'lifecycle',{lifecycle:'dead'})),E(event(owner,2,3,'lifecycle',{lifecycle:'alive'})),E(event(owner,3,4,'lifecycle',{lifecycle:'removed'})),E(event(owner,4,5,'upsert',part())),S(snapshot(owner,5,6)),{method:'teardown'},S(snapshot(owner,6,7)),E({...event(owner,7,8,'visualMode',{visualMode:'idle'}),bad:true})]},
  {name:'owner-isolation',config:config('robotTwo'),steps:[S(snapshot('robotTwo',0,1)),E(event(owner,1,2,'upsert',part())),E(event('robotTwo',1,2,'upsert',part('other'))),{method:'getState'}]},
  {name:'native-number-representation',config:config(owner),steps:[S(snapshot(owner,0,1,[part()])),{...E(event(owner,1,1,'upsert',part())),nativeIntegers:true},{...S(snapshot(owner,2,1,[part()])),nativeIntegers:true}]},
  {name:'validation-boundaries',config:config(owner),steps:[S(snapshot(owner,0,1,[part()])),S({...snapshot(owner,1,2),components:[{...part(),id:'a'.repeat(65)}]}),E(event(owner,1,2,'unknown',{})),E(event(owner,1,2,'lifecycle',{lifecycle:'bogus'})),S({...snapshot(owner,1,2),components:[part(),part()]}),S(snapshot(owner,1,2,[part()],'removed'))]}
 ];
 for(const scenario of cases){const r=createStateReconciler(scenario.config);for(const step of scenario.steps){try{step.expected=step.method==='getState'?{state:r.getState()}:r[step.method](step.message);}catch(error){assert.equal(error.code,'INVALID_STATE');step.expected={error:'INVALID_STATE',state:r.getState()};}}}
 const invalidConfigs=[{...config(owner),extra:true},{instanceId:'bad owner',sockets:[]},{instanceId:owner,sockets:[...config(owner).sockets,...config(owner).sockets]},{instanceId:owner,sockets:[{id:'arm',capacity:0,types:['weapon']}]},{instanceId:owner,sockets:[{id:'arm',capacity:1,types:['weapon','weapon']}]}];
 for(const c of invalidConfigs)assert.throws(()=>createStateReconciler(c),{code:'INVALID_STATE'});
 const first=createStateReconciler(config('ownerA')),second=createStateReconciler(config('ownerB'));
 const firstSnapshot=snapshot('ownerA',0,1),secondSnapshot=snapshot('ownerB',0,1),firstEvent=event('ownerA',1,2,'upsert',part());first.snapshot(firstSnapshot);second.snapshot(secondSnapshot);first.event(firstEvent);
 const forkConfig=config('forkOwner'),forkInitial=snapshot('forkOwner',0,1,[part()]),gap=event('forkOwner',3,4,'visualMode',{visualMode:'guard'}),oldRecovery=snapshot('forkOwner',2,3,[part()]),recovery=snapshot('forkOwner',3,4,[part()]),candidateEvent=event('forkOwner',4,5,'remove',{id:'left'});
 const original=createStateReconciler(forkConfig),candidate=createStateReconciler(forkConfig);for(const r of [original,candidate]){r.snapshot(forkInitial);r.event(gap);}
 const forkExpected={candidateOld:candidate.snapshot(oldRecovery),candidateRecovered:candidate.snapshot(recovery),candidateEvent:candidate.event(candidateEvent),originalOld:original.snapshot(oldRecovery),originalState:original.getState()};
 const removed=createStateReconciler(forkConfig),removedInitial=snapshot('forkOwner',0,1,[],'removed');removed.snapshot(removedInitial);const later=snapshot('forkOwner',1,2);
 const disposed=createStateReconciler(forkConfig);disposed.snapshot(forkInitial);disposed.teardown();
 const forks={config:forkConfig,initial:forkInitial,gap,oldRecovery,recovery,candidateEvent,expected:forkExpected,removedInitial,later,expectedRemoved:removed.snapshot(later),expectedDisposed:disposed.snapshot(later)};
 return {cases,invalidConfigs,forks,ownership:{firstConfig:config('ownerA'),secondConfig:config('ownerB'),firstSnapshot,secondSnapshot,firstEvent,expectedFirst:first.getState(),expectedSecond:second.getState()}};
}
async function main(){
 const root=path.resolve(__dirname,'../..'),i=process.argv.indexOf('--evidence'),relative=i<0?'evidence/w5-state-reconciler-native':process.argv[i+1];if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Use pipeline-relative evidence directory.');
 const out=await resolveContained(root,relative,{mustExist:false});await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'fixture.json'),JSON.stringify(fixtures(),null,2));
 await fs.writeFile(path.join(out,'project.godot'),'config_version=5\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
 for(const [source,target]of [['../../godot/state_reconciler.gd','state_reconciler.gd'],['state_reconciler_runtime.gd','probe.gd']])await fs.copyFile(path.join(__dirname,source),path.join(out,target));
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json'))),tool=config.tools.megadot;
 const result=await runTool({native:{...tool,cwd:path.dirname(tool.executable)}},'native',['--headless','--path',out,'--script','res://probe.gd'],{timeoutMs:30000});await fs.writeFile(path.join(out,'process.json'),JSON.stringify(result,null,2));
 if(result.exitCode||result.error||/SCRIPT ERROR|ERROR:/.test(result.stdout+result.stderr))throw Error(JSON.stringify(result));const report=JSON.parse(await fs.readFile(path.join(out,'validation.json')));assert.ok(report.checks.length&&report.checks.every(c=>c.passed));console.log(JSON.stringify(report));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={fixtures};
