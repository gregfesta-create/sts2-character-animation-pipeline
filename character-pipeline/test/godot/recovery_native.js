'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {fixture}=require('./assembly_transport_native'),{runTool}=require('../../lib/process'),{resolveContained}=require('../../lib/assets');
async function main(){
 const root=path.resolve(__dirname,'../..'),i=process.argv.indexOf('--evidence'),relative=i<0?'evidence/w5-recovery':process.argv[i+1];if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Use pipeline-relative evidence.');
 const out=await resolveContained(root,relative,{mustExist:false});await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'fixture.json'),JSON.stringify(fixture()));await fs.writeFile(path.join(out,'project.godot'),'config_version=5\n');
 for(const name of ['state_reconciler.gd','assembly_planner.gd','component_controller.gd','assembly_controller.gd','assembly_transport.gd'])await fs.copyFile(path.join(root,'godot',name),path.join(out,name));await fs.copyFile(path.join(__dirname,'recovery_runtime.gd'),path.join(out,'probe.gd'));
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json'))),tool=config.tools.megadot,result=await runTool({native:{...tool,cwd:path.dirname(tool.executable)}},'native',['--headless','--path',out,'--script','res://probe.gd'],{timeoutMs:30000});await fs.writeFile(path.join(out,'process.json'),JSON.stringify(result));if(result.error||result.exitCode||/SCRIPT ERROR|ERROR:/.test(result.stdout+result.stderr))throw Error(JSON.stringify(result));const report=JSON.parse(await fs.readFile(path.join(out,'validation.json')));assert.ok(report.checks.length&&report.checks.every(c=>c.passed));console.log(JSON.stringify(report));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
