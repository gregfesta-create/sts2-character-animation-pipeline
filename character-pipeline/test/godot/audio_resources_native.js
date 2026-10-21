'use strict';
// Opt-in native check. Reuses previously compiler-generated synthetic audio;
// performs no Python decoding, creative generation, installs, or game changes.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {inspectNativeAudioResources}=require('../../lib/native-audio-resources');
const {runLockedTool}=require('../../lib/export');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const capture=(p,b)=>({path:p,size:b.length,hash:digest(b),base64:b.toString('base64')});
async function main(){
 const root=path.resolve(__dirname,'../..'),option=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
 const out=path.resolve(option('--evidence')||path.join(root,'evidence/audio-resource-inspection'));
 const project=path.resolve(option('--project')||path.join(root,'evidence/w4-audio-final-edges/runtime-tree/godot'));
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json'))),tool=config.tools.megadot||config.tools.godot;
 const validation=JSON.parse(await fs.readFile(path.join(project,'validation.json'))),audio=validation.audio;
 assert.ok(audio.some(a=>a.format==='wav')&&audio.some(a=>a.format==='ogg-vorbis'));
 const files=await Promise.all(audio.map(async a=>{const p=a.resource.slice(6);assert.match(p,/^audio-[a-f0-9]{64}\.res$/);return capture(p,await fs.readFile(path.join(project,p)));}));
 await fs.mkdir(out,{recursive:true});
 // Only captured .res files exist in newly staged projects, so source WAV/Ogg
 // containers and original compiled project paths cannot satisfy resource loads.
 const result=await inspectNativeAudioResources({files,audio,stagingParent:out,tool});
 assert.equal(result.resources.length,2);assert.ok(result.resources.every(r=>r.sampleRate===48000&&r.channels===2));
 const fixture=path.join(out,'negative-fixture');await fs.mkdir(fixture,{recursive:true});
 const script=await fs.readFile(path.join(__dirname,'audio_resources_runtime.gd'));
 const controls=[capture('audio_resources_runtime.gd',script),capture('project.godot',Buffer.from('config_version=5\n'))];
 for(const c of controls)await fs.writeFile(path.join(fixture,c.path),Buffer.from(c.base64,'base64'));
 const generated=await runLockedTool({tool,args:['--headless','--path',fixture,'--script','res://audio_resources_runtime.gd'],files:controls.map(c=>({path:path.join(fixture,c.path),size:c.size,hash:c.hash}))});
 if(generated.error||generated.exitCode||/SCRIPT ERROR|ERROR:/.test(generated.stdout+generated.stderr))throw new Error(JSON.stringify(generated));
 const rejected=[];
 for(const p of ['object.res','embedded.res','external.res','loop.res']){
  const c=capture(p,await fs.readFile(path.join(fixture,p)));
  await assert.rejects(()=>inspectNativeAudioResources({files:[c],audio:[{id:'invalid',format:'wav',duration:1,resource:'res://'+p}],stagingParent:out,tool}));rejected.push(p);
 }
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify({...result,sourceFree:true,rejected},null,2));
 console.log(JSON.stringify({passed:true,resources:result.resources,rejected}));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(e=>{console.error(e,e.process);process.exitCode=1;});
