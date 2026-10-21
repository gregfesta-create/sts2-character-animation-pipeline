'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {runTool}=require('../../lib/process');
const {createAssemblyPlanner}=require('../../lib/components');
function batches(){
 const inheritance={position:true,rotation:true,scale:true};
 const transform={position:[0,0],rotation:0,scale:[1,1]};
 const planner=createAssemblyPlanner({styleHash:'a'.repeat(64),eventNames:[],sockets:['left','right'].map(id=>({id,bone:id,transform:{...transform,position:[4,2]},types:['red','blue'],capacity:1,inheritance,layer:2,envelope:[100,100]})),descriptors:['red','blue'].map(type=>({version:1,type,spec:type+'.json',mount:{...transform,position:[2,1],rotation:0.2,scale:[1.2,0.8]},dimensions:[24,12],styleHash:'a'.repeat(64),eventNames:[],layer:2,inheritance}))});
 const component=(id,socket,type='red',revision=1,damageState='intact')=>({id,socket,type,revision,damageState,upgrade:0,visualMode:'idle'});
 const states=[[],[component('a','left'),component('b','right')],[component('a','left','blue',2),component('b','right')],[component('a','left','blue',3,'damaged'),component('b','right')],[component('a','left','blue',4,'destroyed'),component('b','right')],[component('a','left','blue',5),component('b','right')],[],[]].map((components,i)=>({version:1,instanceId:'fixture',sequence:i,revision:i+1,lifecycle:i===7?'dead':'alive',visualMode:'idle',components}));
 const output=states.slice(1).map((next,i)=>({plan:planner.plan(states[i],next),revision:next.revision,sequence:next.sequence}));
 let previous=states[4];
 for(const [revision,upgrade,damageState] of [[5,0,'destroyed'],[6,1,'destroyed'],[7,1,'intact']]){
  const next={...previous,revision:previous.revision+1,sequence:previous.sequence+1,components:[{...component('a','left','blue',revision,damageState),upgrade},component('b','right')]};
  output.push({plan:planner.plan(previous,next),revision:next.revision,sequence:next.sequence});previous=next;
 }
 return output;
}
function multiBatch(){
 const inheritance={position:true,rotation:true,scale:true};
 const transform={position:[0,0],rotation:0,scale:[1,1]};
 const planner=createAssemblyPlanner({styleHash:'a'.repeat(64),eventNames:[],sockets:[{id:'left',bone:'left',transform,types:['red','blue'],capacity:2,inheritance,layer:2,envelope:[100,100]}],descriptors:['red','blue'].map((type,index)=>({version:1,type,spec:type+'.json',mount:{...transform,position:[index*12,0]},dimensions:[24,12],styleHash:'a'.repeat(64),eventNames:[],layer:2,inheritance}))});
 const before={version:1,instanceId:'fixture',sequence:0,revision:1,lifecycle:'alive',visualMode:'idle',components:[]};
 const after={...before,sequence:1,revision:2,components:['red','blue'].map((type,index)=>({id:index?'b':'a',socket:'left',type,revision:1,damageState:'intact',upgrade:0,visualMode:'idle'}))};
 return {plan:planner.plan(before,after),revision:after.revision,sequence:after.sequence};
}
async function main(){
 const i=process.argv.indexOf('--evidence');
 const out=path.resolve(i<0?path.join(__dirname,'../../evidence/w5-assembly-native'):process.argv[i+1]);
 await fs.mkdir(out,{recursive:true});
 await fs.writeFile(path.join(out,'project.godot'),'config_version=5\n[application]\nconfig/name="Assembly proof"\n[display]\nwindow/size/viewport_width=160\nwindow/size/viewport_height=96\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
 for(const name of ['component_controller.gd','assembly_controller.gd','assembly_planner.gd','assembly_runtime.gd'])await fs.copyFile(path.join(__dirname,name==='assembly_runtime.gd'?name:'../../godot/'+name),path.join(out,name));
 await fs.writeFile(path.join(out,'batches.json'),JSON.stringify(batches()));
 await fs.writeFile(path.join(out,'multi.json'),JSON.stringify(multiBatch()));
 const config=JSON.parse(await fs.readFile(path.join(__dirname,'../../config/local.tools.json')));
 const tool=config.tools.megadot||config.tools.godot;
 const result=await runTool({native:{...tool,cwd:path.dirname(tool.executable)}},'native',['--rendering-method','gl_compatibility','--position','-10000,-10000','--log-file',path.join(out,'native.log'),'--path',out,'--script','res://assembly_runtime.gd'],{timeoutMs:30000});
 await fs.writeFile(path.join(out,'process.json'),JSON.stringify(result,null,2));
 if(result.exitCode||result.error||/SCRIPT ERROR|ERROR:/.test(result.stdout+result.stderr))throw Error(JSON.stringify(result));
 const report=JSON.parse(await fs.readFile(path.join(out,'validation.json')));
 if(!report.checks.length||report.checks.some(c=>!c.passed))throw Error(JSON.stringify(report));
 console.log(JSON.stringify(report));
}
if(process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={batches,multiBatch};
