'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {runTool}=require('../../lib/process');
async function main(){
 const i=process.argv.indexOf('--evidence');
 const out=path.resolve(i<0?path.join(__dirname,'../../evidence/w5-native'):process.argv[i+1]);
 await fs.mkdir(out,{recursive:true});
 await fs.writeFile(path.join(out,'project.godot'),'config_version=5\n[application]\nconfig/name="Component proof"\n[display]\nwindow/size/viewport_width=160\nwindow/size/viewport_height=96\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
 for(const name of ['component_controller.gd','assembly_planner.gd','animation_controller.gd','component_runtime.gd'])await fs.copyFile(path.join(__dirname,name!=='component_runtime.gd'?'../../godot/'+name:name),path.join(out,name));
 const config=JSON.parse(await fs.readFile(path.join(__dirname,'../../config/local.tools.json')));
 const tool=config.tools.megadot||config.tools.godot;
 const result=await runTool({native:{...tool,cwd:path.dirname(tool.executable)}},'native',['--rendering-method','gl_compatibility','--position','-10000,-10000','--path',out,'--script','res://component_runtime.gd'],{timeoutMs:30000});
 await fs.writeFile(path.join(out,'process.json'),JSON.stringify(result,null,2));
 if(result.exitCode||result.error||/SCRIPT ERROR|ERROR:/.test(result.stdout+result.stderr))throw Error(JSON.stringify(result));
 const report=JSON.parse(await fs.readFile(path.join(out,'validation.json')));
 if(!report.checks.length||report.checks.some(c=>!c.passed))throw Error(JSON.stringify(report));
 console.log(JSON.stringify(report));
}
if(process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
