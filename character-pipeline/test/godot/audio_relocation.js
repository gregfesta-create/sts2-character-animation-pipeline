'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {runTool}=require('../../lib/process');
async function main(){
  const arg=process.argv.indexOf('--evidence');
  if(arg<0||!process.argv[arg+1])throw new Error('Use --run --evidence ABSOLUTE_OWNED_AUDIO_EVIDENCE');
  const root=path.resolve(__dirname,'../../evidence');
  const evidence=path.resolve(process.argv[arg+1]);
  if(!evidence.startsWith(root+path.sep))throw new Error('Evidence must stay inside the pipeline evidence directory');
  const source=path.join(evidence,'runtime-player/godot');
  const assets=path.join(evidence,'assets');
  const realRoot=await fs.realpath(root);
  for(const target of [evidence,source,assets])if(!(await fs.realpath(target)).startsWith(realRoot+path.sep))throw new Error('Resolved fixture move/copy target escapes pipeline evidence');
  const destination=path.join(evidence,'relocated-'+Date.now());
  await fs.cp(source,destination,{recursive:true,errorOnExist:true,force:false});
  for(const name of await fs.readdir(destination))if(/\.(wav|ogg)$/i.test(name))await fs.unlink(path.join(destination,name));
  await fs.copyFile(path.join(__dirname,'audio_relocation.gd'),path.join(destination,'relocation.gd'));
  const config=JSON.parse(await fs.readFile(path.resolve(__dirname,'../../config/local.tools.json')));
  const tool=config.tools.megadot||config.tools.godot;
  let sourceMoved=false,assetsMoved=false;
  try{
    await fs.rename(source,source+'.source-denied');sourceMoved=true;
    await fs.rename(assets,assets+'.source-denied');assetsMoved=true;
    const result=await runTool({native:{...tool,cwd:path.dirname(tool.executable)}},'native',['--headless','--path',destination,'--script','res://relocation.gd','--log-file',path.join(destination,'native.log')],{timeoutMs:30000});
    await fs.writeFile(path.join(destination,'process.json'),JSON.stringify(result,null,2));
    if(result.exitCode||result.error||/SCRIPT ERROR|ERROR:/.test(result.stdout+result.stderr))throw new Error('Relocated audio failed: '+result.stdout+result.stderr);
    const report=JSON.parse(await fs.readFile(path.join(destination,'relocation-validation.json')));
    if(!report.valid)throw new Error('Relocated audio validation failed');
    console.log(JSON.stringify({sourceDenied:true,rawAudioRemoved:true,...report}));
  }finally{
    if(assetsMoved)await fs.rename(assets+'.source-denied',assets);
    if(sourceMoved)await fs.rename(source+'.source-denied',source);
  }
}
if(process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
