'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {createSpec}=require('../../lib/spec');
const {hashValue}=require('../../lib/assets');
const {compileGodot}=require('../../backends/godot');
const {createAssemblyPlanner}=require('../../lib/components');
const {runTool}=require('../../lib/process');
async function inventory(root,relative=''){
 const out=[];
 for(const e of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
  const name=path.join(relative,e.name);if(e.isDirectory())out.push(...await inventory(root,name));else{const b=await fs.readFile(path.join(root,name));out.push({path:name,size:b.length,hash:crypto.createHash('sha256').update(b).digest('hex')});}
 }return out;
}
function fixture(id,angle){
 const s=createSpec({id,description:'controlled skeletal integration fixture'});s.canvas.width=32;s.canvas.height=16;s.export.playback='tree';
 s.animations=[{id:'idle',duration:1,loop:true,events:id==='red'?Array.from({length:65},(_,i)=>({id:'cue'+i,name:'marker'+i,time:i/100})):[],tracks:[{bone:'root',property:'rotation',keys:[{time:0,value:0},{time:0.5,value:angle},{time:1,value:0}]}]}];return s;
}
async function main(){
 const i=process.argv.indexOf('--evidence'),out=path.resolve(i<0?path.join(__dirname,'../../evidence/w5-component-compile'):process.argv[i+1]);
 const source=path.join(out,'source');await fs.mkdir(source,{recursive:true});
 const config=JSON.parse(await fs.readFile(path.join(__dirname,'../../config/local.tools.json')));
 const componentProjects={},componentRegistry=[];
 for(const [id,angle]of [['red',0.4],['blue',-0.6],['green',0.8]]){
  const spec=fixture(id,angle),stage=path.join(source,id),compiled=await compileGodot(spec,{stagingDir:stage,config});
  componentProjects[id]={project:compiled.project,scene:compiled.scene,spec,checkpoint:{root:stage,artifacts:await inventory(stage)}};componentRegistry.push({id,types:[id]});
 }
 const spec=fixture('body',0.2),inheritance={position:true,rotation:true,scale:true},identity={position:[0,0],rotation:0,scale:[1,1]},styleHash=hashValue(spec.style);
 spec.sockets=['left','right'].map((id,index)=>({id,bone:'root',types:index?['blue','green']:['red','blue','green'],capacity:1,inheritance,layer:2,envelope:[100,100],transform:{position:[20+index*40,10],rotation:0.1,scale:[-1,1]}}));
 spec.components=[{id:'a',socket:'left',type:'red',spec:'red.json'},{id:'b',socket:'right',type:'blue',spec:'blue.json'}];
 const componentDescriptors=['red','blue','green'].map(type=>({version:1,type,spec:type+'.json',mount:{...identity,position:[3,2],rotation:0.2,scale:[1.2,0.8]},dimensions:[32,16],styleHash,eventNames:type==='red'?Array.from({length:65},(_,i)=>'marker'+i).sort():[],layer:2,inheritance}));
 const assemblyContract={styleHash,eventNames:componentDescriptors[0].eventNames};
 const compiled=await compileGodot(spec,{config,render:true,stagingDir:path.join(source,'parent'),componentProjects,componentRegistry,componentDescriptors,assemblyContract});
 if(!compiled.validation.assembly?.productionUnbound||!compiled.validation.assembly.preview||compiled.validation.assembly.previewComponents!==2||!compiled.frames.length)throw Error('Transient render preview did not mount synthetic components');
 const relocated=path.join(out,'relocated');await fs.cp(compiled.project,relocated,{recursive:true});
 await fs.copyFile(path.join(__dirname,'component_compile_runtime.gd'),path.join(relocated,'probe.gd'));
 const planner=createAssemblyPlanner({sockets:spec.sockets,descriptors:componentDescriptors,...assemblyContract});
 let previous={version:1,instanceId:'bodyOne',revision:1,sequence:0,lifecycle:'alive',visualMode:'idle',components:spec.components.map(c=>({id:c.id,socket:c.socket,type:c.type,revision:1,damageState:'intact',upgrade:0,visualMode:'idle'}))};
 await fs.writeFile(path.join(relocated,'initial.json'),JSON.stringify(previous));
 const batches=[];
 for(const type of ['green','blue','red']){const next={...previous,revision:previous.revision+1,sequence:previous.sequence+1,components:previous.components.map(c=>c.id==='a'?{...c,type,revision:c.revision+1}:c)};batches.push({snapshot:next,plan:planner.plan(previous,next)});previous=next;}
 await fs.writeFile(path.join(relocated,'batches.json'),JSON.stringify(batches));
 // Deny the original paths used during every child/parent compilation.
 await fs.rename(source,path.join(out,'source-denied'));
 for(const name of await fs.readdir(relocated))if(name==='compile.gd'||name==='spec.json'||name.endsWith('.log')||name==='process.json')await fs.rm(path.join(relocated,name));
 const tool=config.tools.megadot||config.tools.godot;
 const result=await runTool({native:{...tool,cwd:path.dirname(tool.executable)}},'native',['--headless','--path',relocated,'--script','res://probe.gd'],{timeoutMs:30000});
 await fs.writeFile(path.join(out,'process.json'),JSON.stringify(result,null,2));
 if(result.exitCode||result.error||/SCRIPT ERROR|ERROR:/.test(result.stdout+result.stderr))throw Error(JSON.stringify(result));
 const report=JSON.parse(await fs.readFile(path.join(relocated,'component-validation.json')));
 if(report.checks.some(c=>!c.passed))throw Error(JSON.stringify(report));console.log(JSON.stringify(report));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={fixture,inventory};
