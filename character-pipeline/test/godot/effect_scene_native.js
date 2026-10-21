'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {runTool}=require('../../lib/process');
async function main(){
 const index=process.argv.indexOf('--evidence'),out=path.resolve(index<0?path.join(__dirname,'../../evidence/e3-effect-scene'):process.argv[index+1]);
 const source=path.join(out,'source'),relocated=path.join(out,'relocated');await fs.mkdir(source,{recursive:true});
 await fs.writeFile(path.join(source,'project.godot'),'config_version=5\n[display]\nwindow/size/viewport_width=192\nwindow/size/viewport_height=64\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
 for(const [src,dst] of [['../../godot/effect_rule_controller.gd','effect_rule_controller.gd'],['../../godot/effect_controller.gd','effect_controller.gd'],['../../godot/effect_scene_controller.gd','effect_scene_controller.gd'],['../../godot/impact_controller.gd','impact_controller.gd'],['effect_scene_runtime.gd','effect_scene_runtime.gd']])await fs.copyFile(path.join(__dirname,src),path.join(source,dst));
 await fs.rename(source,relocated);
 const config=JSON.parse(await fs.readFile(path.join(__dirname,'../../config/local.tools.json'))),tool=config.tools.megadot;
 const result=await runTool({native:{...tool,cwd:path.dirname(tool.executable)}},'native',['--rendering-method','gl_compatibility','--position','-10000,-10000','--path',relocated,'--script','res://effect_scene_runtime.gd'],{timeoutMs:30000});await fs.writeFile(path.join(out,'process.json'),JSON.stringify(result));
 if(result.exitCode||result.error||/SCRIPT ERROR|ERROR:/.test(result.stdout+result.stderr))throw Error(JSON.stringify(result));const report=JSON.parse(await fs.readFile(path.join(relocated,'validation.json')));if(!report.checks.length||report.checks.some(c=>!c.passed))throw Error(JSON.stringify(report));console.log(JSON.stringify(report));
}
if(process.argv.includes('--run'))main().catch(e=>{console.error(e);process.exitCode=1;});

