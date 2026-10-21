'use strict';
// Explicit opt-in only. Native Godot needs its complete installed runtime.
const fs = require('node:fs/promises');
const path = require('node:path');
const { compileGodot } = require('../../backends/godot');
const { runTool } = require('../../lib/process');
async function main() {
  const config = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../config/local.tools.json')));
  const original = path.resolve(__dirname, '../../evidence/w2-godot/native/godot');
  if (process.argv.includes('--families')) {
    const { expandClips } = require('../../lib/animation');
    const { createSpec } = require('../../lib/spec');
    let spec = createSpec({id:'clipFixture',description:'Synthetic articulated motion fixtures',template:'custom'});
    const source = JSON.parse(await fs.readFile(path.join(original,'spec.json')));
    spec.bones[0].rest.position = [256,256];
    for (const [i, role] of ['torso','armLeft','armRight','legLeft','legRight'].entries()) {
      spec.bones.push({id:role,parent:'root',rest:{position:[(i-2)*35, i>2?40:0],rotation:0,scale:[1,1]},length:40,limits:[-3,3]});
      spec.anatomy.roles[role] = role;
      const part = structuredClone(source.parts[0]);
      part.id = role; part.role = role; part.bone = role; delete part.mesh;
      part.image.path = path.join(original,part.image.path);
      part.image.pixelsPerUnit = 0.1;
      spec.parts.push(part);
    }
    spec = expandClips(spec);
    for(const mode of ['player','tree']) {
      spec.export.playback = mode;
      const result = await compileGodot(spec,{config,stagingDir:path.resolve(__dirname,'../../evidence/w4-runtime/families-'+mode),render:true});
      if(result.frames.length !== 24) throw new Error('All twelve clip families must render two samples');
      console.log(mode, 'all twelve families:',result.frames.length,'rendered frames');
    }
    return;
  }
  for (const mode of ['player', 'tree']) {
    const spec = JSON.parse(await fs.readFile(path.join(original, 'spec.json')));
    spec.export.playback = mode;
    spec.animations.push({id:'startcue',duration:1,loop:false,tracks:[],events:[{id:'start',name:'start',time:0}]});
    spec.animations.push({id:'fastloop',duration:0.01,loop:true,tracks:[],events:[{id:'early',name:'early',time:0.002},{id:'tail',name:'tail',time:0.0098}]});
    spec.animations.push({id:'loopcue',duration:1,loop:true,tracks:[],events:[{id:'early',name:'early',time:0.2},{id:'tail',name:'tail',time:0.98}]});
    spec.animations.push({ id:'revive',duration:1,loop:false,events:[],tracks:[] });
    spec.animations.find(a => a.id === 'attack').events = [{id:'release',name:'release',time:0.3,payload:{type:'marker',value:1}}];
    for(const easing of ['linear','in','out','inOut','step']) spec.animations.push({id:'ease_'+easing,duration:1,loop:false,events:[],tracks:[{bone:'tip',property:'rotation',keys:[{time:0,value:0,easing},{time:1,value:1}]}]});
    for (const part of spec.parts) part.image.path = path.join(original, part.image.path);
    const stagingDir = path.resolve(__dirname, process.argv.includes('--markers') || process.argv.includes('--fix') ? '../../evidence/w4-marker-fix' : '../../evidence/w4-runtime', process.argv.includes('--fix') ? 'regression-' + mode : mode);
    const result = await compileGodot(spec, { config, stagingDir });
    await fs.copyFile(path.join(__dirname, process.argv.includes('--markers') ? 'marker_runtime.gd' : 'animation_runtime.gd'), path.join(result.project, 'runtime_test.gd'));
    const tool = config.tools.megadot || config.tools.godot;
    const registry = { native: { ...tool, cwd: path.dirname(tool.executable) } };
    const run = await runTool(registry, 'native', ['--headless','--path',result.project,'--script','res://runtime_test.gd','--log-file',path.join(result.project,'runtime.log')], { timeoutMs: 30000 });
    await fs.writeFile(path.join(stagingDir, 'runtime-process.json'), JSON.stringify(run, null, 2));
    if (run.exitCode || run.error || /SCRIPT ERROR|ERROR:/.test(run.stdout + run.stderr)) throw new Error(JSON.stringify(run));
    console.log(mode, await fs.readFile(path.join(result.project, process.argv.includes('--markers') ? 'marker-validation.json' : 'runtime-validation.json'), 'utf8'));
  }
}
if (process.argv.includes('--run')) main().catch(e => { console.error(e); process.exitCode = 1; });
