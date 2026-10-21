'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {runTool}=require('../../lib/process');
async function main(){
 const i=process.argv.indexOf('--evidence'),out=path.resolve(i<0?path.join(__dirname,'../../evidence/texture-storage'):process.argv[i+1]);
 await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'project.godot'),'config_version=5\n');
 for(const [source,target]of [['../../godot/texture_storage.gd','texture_storage.gd'],['texture_storage_runtime.gd','probe.gd']])await fs.copyFile(path.join(__dirname,source),path.join(out,target));
 const config=JSON.parse(await fs.readFile(path.join(__dirname,'../../config/local.tools.json'))),tool=config.tools.megadot;
 const result=await runTool({native:{...tool,cwd:path.dirname(tool.executable)}},'native',['--headless','--path',out,'--script','res://probe.gd','--quit-after','60'],{timeoutMs:30000});
 await fs.writeFile(path.join(out,'process.json'),JSON.stringify(result));
 if(result.error||result.exitCode!==0||/SCRIPT ERROR|ERROR:/.test(result.stdout+result.stderr))throw Error(JSON.stringify(result));
 const report=JSON.parse(await fs.readFile(path.join(out,'validation.json')));if(!report.passed)throw Error('Texture validation failed');console.log(JSON.stringify(report));
}
if(process.argv.includes('--run'))main().catch(e=>{console.error(e);process.exitCode=1;});
