'use strict';
// Explicit opt-in native integration proof; discovery must never launch Godot.
const fs = require('node:fs/promises');
const path = require('node:path');
const { compileGodot } = require('../../backends/godot');
const { runTool } = require('../../lib/process');
async function main() {
  const config = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../config/local.tools.json')));
  const original = path.resolve(__dirname, '../../evidence/w2-godot/native/godot');
  const index = process.argv.indexOf('--evidence');
  const out = index < 0 ? path.resolve(__dirname,'../../evidence/w4-blend') : path.resolve(process.argv[index+1]);
  for (const mode of ['player','tree']) {
    const spec = JSON.parse(await fs.readFile(path.join(original,'spec.json')));
    spec.export.playback = mode;
    spec.bones.find(bone=>bone.id==='tip').limits=[-3,3];
    for (const part of spec.parts) part.image.path = path.join(original,part.image.path);
    const clip = (id,value,events=[],loop=false) => ({id,duration:1,loop,blendIn:0.4,events,tracks:[{bone:'tip',property:'rotation',keys:[{time:0,value},{time:1,value}]}]});
    spec.animations = [clip('idle',0,[],true),clip('a',0,[{id:'aLate',name:'aLate',time:0.6}]),clip('b',1,[{id:'bStart',name:'bStart',time:0},{id:'bCue',name:'bCue',time:0.2}]),clip('hit',0.5,[{id:'hitCue',name:'hitCue',time:0.2}]),clip('death',1.2),clip('revive',0),clip('loop',0,[{id:'zero',name:'zero',time:0},{id:'tail',name:'tail',time:0.9}],true)];
    spec.sockets=[{id:'release',bone:'root',transform:{position:[0,0],rotation:0,scale:[1,1]},types:['projectile'],capacity:1,inheritance:{position:true,rotation:true,scale:true}}];
    spec.projectiles=[{id:'shotVisual',part:spec.parts[0].id,forward:[1,0],flightDuration:0.5,lifetime:2,removalPolicy:'cancel'}];
    spec.animations.push(clip('shot',0,[{id:'realRelease',type:'projectile',time:0.2,payload:{projectile:'shotVisual',sourceSocket:'release'}}]));
    const result = await compileGodot(spec,{config,stagingDir:path.join(out,mode)});
    await fs.copyFile(path.join(__dirname,'blend_runtime.gd'),path.join(result.project,'blend_test.gd'));
    const tool = config.tools.megadot || config.tools.godot;
    const run = await runTool({native:{...tool,cwd:path.dirname(tool.executable)}},'native',['--headless','--path',result.project,'--script','res://blend_test.gd','--log-file',path.join(result.project,'blend.log')],{timeoutMs:30000});
    await fs.writeFile(path.join(out,mode,'process.json'),JSON.stringify(run,null,2));
    if (run.exitCode || run.error || /SCRIPT ERROR|ERROR:/.test(run.stdout+run.stderr)) throw new Error(JSON.stringify(run));
    console.log(mode,await fs.readFile(path.join(result.project,'blend-validation.json'),'utf8'));
  }
}
if (require.main === module && process.argv.includes('--run')) main().catch(error=>{console.error(error);process.exitCode=1;});

