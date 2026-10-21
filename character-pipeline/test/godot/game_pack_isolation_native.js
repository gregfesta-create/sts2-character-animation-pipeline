'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {runTool}=require('../../lib/process'),{resolveContained}=require('../../lib/assets');
function validateReport(report,token){
 assert.match(token,/^CharacterPipelineIsolation_[a-f0-9]{32}$/);
 assert.equal(report.token,token);assert.equal(report.mounted,true);
 assert.equal(typeof report.before.userData,'string');
 assert(path.win32.isAbsolute(report.before.userData)||path.posix.isAbsolute(report.before.userData));
 assert(!report.before.userData.split(/[\\/]/).some(part=>part==='.'||part==='..'));
 assert(!report.before.userData.includes('://'));
 assert.equal(report.before.userData.split(/[\\/]/).at(-1),token);
 assert.deepEqual(report.after,report.before);
 assert.deepEqual(report.before.children,['IsolationFixture']);
 assert.equal(report.before.projectName,token);assert.equal(report.before.mainScene,'');assert.deepEqual(report.before.autoloads,[]);
 assert.equal(report.gameStartupExecuted,false);
}
async function main(){
 const root=path.resolve(__dirname,'../..'),index=process.argv.indexOf('--evidence'),relative=index<0?'evidence/game-pack-isolation':process.argv[index+1];
 if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Use pipeline-relative evidence');
 const out=await resolveContained(root,relative,{mustExist:false});await fs.mkdir(out,{recursive:true});
 const token='CharacterPipelineIsolation_'+crypto.randomUUID().replaceAll('-','');
 const pack='C:/Program Files (x86)/Steam/steamapps/common/Slay the Spire 2/SlayTheSpire2.pck';
 const before=await fs.stat(pack);assert(before.isFile()&&before.size>0&&before.size<8*1024**3);
 await fs.writeFile(path.join(out,'project.godot'),`config_version=5\n[application]\nconfig/name="${token}"\nconfig/use_custom_user_dir=true\nconfig/custom_user_dir_name="${token}"\n`);
 await fs.copyFile(path.join(__dirname,'game_pack_isolation_runtime.gd'),path.join(out,'probe.gd'));
 await fs.writeFile(path.join(out,'input.json'),JSON.stringify({token,pack}));
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json')));
 const result=await runTool({native:config.tools.megadot},'native',['--headless','--path',out,'--log-file',path.join(out,'engine.log'),'--script','res://probe.gd'],{timeoutMs:30000,maxOutputBytes:1024*1024});
 await fs.writeFile(path.join(out,'process.json'),JSON.stringify(result,null,2));
 assert.equal(result.error,null,JSON.stringify(result));assert(!/SCRIPT ERROR|ERROR:/.test(result.stdout+result.stderr),result.stdout+result.stderr);
 const report=JSON.parse(await fs.readFile(path.join(out,'validation.json')));validateReport(report,token);
 const after=await fs.stat(pack);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);
 const receipt={passed:true,...report,packMetadata:{path:pack,size:before.size,mtimeMs:before.mtimeMs},remainingBlocker:'Executable-adjacent mods and mods_STEAMTEST discovery is not isolated; no game startup was attempted.'};
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}
module.exports={validateReport};
if(require.main===module&&process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
