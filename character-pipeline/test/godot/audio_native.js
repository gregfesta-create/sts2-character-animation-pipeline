'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { runTool } = require('../../lib/process');
const { createSpec } = require('../../lib/spec');
const { compileGodot } = require('../../backends/godot');
const { runAudioOperation } = require('../../lib/audio');
async function main() {
  const evidenceOption = process.argv.indexOf('--evidence');
  if(evidenceOption >= 0 && !process.argv[evidenceOption+1]) throw new Error('--evidence requires a directory');
  const out = evidenceOption >= 0 ? path.resolve(process.argv[evidenceOption+1]) : path.resolve(__dirname,'../../evidence/w4-audio');
  const assets = path.join(out,'assets');
  await fs.mkdir(assets,{recursive:true});
  const wav=Buffer.alloc(44+48000*4);
  wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(2,22);wav.writeUInt32LE(48000,24);wav.writeUInt32LE(192000,28);wav.writeUInt16LE(4,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  for(let i=0;i<48000;i++) for(let channel=0;channel<2;channel++) wav.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/48000)*200),44+i*4+channel*2);
  const wavPath=path.join(assets,'cue.wav');
  await fs.writeFile(wavPath,wav);
  const config=JSON.parse(await fs.readFile(path.resolve(__dirname,'../../config/local.tools.json')));
  config.sourceRoots = [...(config.sourceRoots||[]),out];
  const ogg = await runAudioOperation('encode-vorbis',wavPath,{config,stagingDir:assets});
  for(const mode of ['player','tree']) {
    const stagingDir=path.join(out,'runtime-'+mode);
    const spec=createSpec({id:'audioFixture',description:'Synthetic audio runtime test',template:'custom'});
    spec.export.playback=mode;
    spec.sounds=[{id:'cue',path:wavPath,volumeDb:5,pitch:3},{id:'ogg',path:ogg.path}];
    spec.animations = ['idle','hit','death'].map(id=>({id,duration:1,loop:id==='idle',events:[],tracks:[]}));
    spec.animations.push({id:'dense',duration:1,loop:true,tracks:[],events:Array.from({length:65},(_,i)=>({id:'dense'+String(i).padStart(3,'0'),type:'sound',time:.5,payload:{sound:'cue'}}))});
    spec.animations.push({id:'zeroSound',duration:1,loop:false,tracks:[],events:[{id:'zeroCue',type:'sound',time:0,payload:{sound:'cue'}}]}, {id:'oggAction',duration:1,loop:false,tracks:[],events:[{id:'oggCue',type:'sound',time:.3,payload:{sound:'ogg'}}]}, {id:'audioAction',duration:1,loop:false,tracks:[],events:[{id:'release',type:'sound',time:.3,payload:{sound:'cue'}}]},
      {id:'audioLoop',duration:.1,loop:true,tracks:[],events:[{id:'loop',type:'sound',time:.02,payload:{sound:'cue'}}]},
      {id:'ordered',duration:1,loop:false,tracks:[],events:[{id:'z',type:'sound',time:.2,payload:{sound:'cue'}},{id:'a',type:'sound',time:.2,payload:{sound:'cue'}}]});
    const result=await compileGodot(spec,{config,stagingDir});
    const project=result.project;
    await fs.copyFile(wavPath,path.join(project,'cue.wav'));
    await fs.copyFile(path.join(__dirname,'audio_runtime.gd'),path.join(project,'audio_test.gd'));
    const tool=config.tools.megadot||config.tools.godot;
    const run=await runTool({native:{...tool,cwd:path.dirname(tool.executable)}},'native',['--headless','--path',project,'--script','res://audio_test.gd','--log-file',path.join(project,'audio-native.log')],{timeoutMs:30000});
    await fs.writeFile(path.join(stagingDir,'audio-process.json'),JSON.stringify(run,null,2));
    if(run.exitCode||run.error||/SCRIPT ERROR|ERROR:/.test(run.stdout+run.stderr)) throw new Error(JSON.stringify(run));
    console.log(mode,await fs.readFile(path.join(project,'audio-validation.json'),'utf8'));
  }
}
if(process.argv.includes('--run')) main().catch(e=>{console.error(e);process.exitCode=1;});
