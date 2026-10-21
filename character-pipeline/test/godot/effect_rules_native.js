'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {createEffectRuntime}=require('../../lib/effects');
const {runTool}=require('../../lib/process');
async function main(){
 const h='a'.repeat(64), evidence={id:'ev',path:'Power.cs',hash:h,symbol:'Power',lineStart:1,lineEnd:1,excerpt:'amount'};
 const effects=[{id:'green',capability:'tint',implemented:true,resources:[{sha256:h,importSettings:{},styleProvenance:'fixture',approvalProvenance:'synthetic'}]}];
 const decisions=['z','a','active'].map((id,i)=>({id,mechanicKey:'mod.'+id,outcome:'effect',reason:'fixture',evidenceIds:['ev'],bindingId:id,rule:{effectIds:['green'],condition:{type:'amountAtLeast',threshold:1},scope:i===2?'whileActive':'attackSnapshot',socketId:'arrow',channel:'tip',priority:1}}));
 const plan={version:1,characterId:'hero',mechanicsFingerprint:h,inspectionVersion:'1',adapterContractVersion:'1',evidence:[evidence],decisions};
 const options={characterInstance:'hero-1',effects,sockets:['arrow'],inventory:{version:1,characterId:'hero',fingerprint:h,evidence:[evidence],mechanics:decisions.map(d=>({key:d.mechanicKey,evidenceIds:['ev']}))},bindings:decisions.map(d=>({id:d.id,mechanicKey:d.mechanicKey,adapterContractVersion:'1'}))};
 const runtime=createEffectRuntime(plan,options),fact=(sequence,amount)=>({characterInstance:'hero-1',sequence,adapterContractVersion:'1',bindings:Object.fromEntries(decisions.map(d=>[d.id,{present:amount>0,amount}]))});
 const action=(id,sequence)=>({characterInstance:'hero-1',actionInstance:id,generation:1,preConsumption:true,observationSequence:sequence,releaseAt:.2,impactAt:.6,target:'enemy'});
 const initial=fact(1,1),consumed=fact(2,0);runtime.observe(initial);const active=runtime.selectWhileActive(),snapshot=runtime.captureAttack(action('last',1));runtime.markReleased('last',1);runtime.retainProjectile('last',1,'one');runtime.retainProjectile('last',1,'two');runtime.observe(consumed);const next=runtime.captureAttack(action('next',2));
 const targetRuntime=createEffectRuntime(plan,options);targetRuntime.observe(initial);const nullTarget={...action('null-target',1),target:null};let nullTargetRejected=false;try{targetRuntime.captureAttack(nullTarget);}catch(error){if(error.code!=='INVALID_EFFECT_STATE')throw error;nullTargetRejected=true;}if(!nullTargetRejected)throw Error('JS must reject explicit null target');const omittedTarget=action('omitted-target',1);delete omittedTarget.target;const omittedSnapshot=targetRuntime.captureAttack(omittedTarget);
 const index=process.argv.indexOf('--evidence'),out=path.resolve(index<0?path.join(__dirname,'../../evidence/e3-effect-rules'):process.argv[index+1]);await fs.mkdir(out,{recursive:true});
 await fs.writeFile(path.join(out,'fixture.json'),JSON.stringify({plan,effects,initial,consumed,action:action('last',1),nextAction:action('next',2),nullTarget,omittedTarget,expected:{active,snapshot,next,nullTargetRejected,omittedSnapshot}}));
 await fs.writeFile(path.join(out,'project.godot'),'config_version=5\n[display]\nwindow/size/viewport_width=128\nwindow/size/viewport_height=64\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
 for(const [source,target]of [['../../godot/effect_rule_controller.gd','effect_rule_controller.gd'],['../../godot/effect_controller.gd','effect_controller.gd'],['effect_rules_runtime.gd','effect_rules_runtime.gd']])await fs.copyFile(path.join(__dirname,source),path.join(out,target));
 const config=JSON.parse(await fs.readFile(path.join(__dirname,'../../config/local.tools.json'))),tool=config.tools.megadot;
 const result=await runTool({native:{...tool,cwd:path.dirname(tool.executable)}},'native',['--rendering-method','gl_compatibility','--position','-10000,-10000','--path',out,'--script','res://effect_rules_runtime.gd'],{timeoutMs:30000});await fs.writeFile(path.join(out,'process.json'),JSON.stringify(result));
 if(result.exitCode||result.error||/SCRIPT ERROR|ERROR:/.test(result.stdout+result.stderr))throw Error(JSON.stringify(result));const report=JSON.parse(await fs.readFile(path.join(out,'validation.json')));if(!report.checks.length||report.checks.some(c=>!c.passed))throw Error(JSON.stringify(report));console.log(JSON.stringify(report));
}
if(process.argv.includes('--run'))main().catch(e=>{console.error(e);process.exitCode=1;});
