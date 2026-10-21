'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {createSpec}=require('../../lib/spec');
const {compileGodot}=require('../../backends/godot');
const {runTool}=require('../../lib/process');
async function main(){
  const arg=process.argv.indexOf('--evidence');
  const out=arg<0?path.resolve(__dirname,'../../evidence/w4-bow'):path.resolve(process.argv[arg+1]);
  await fs.mkdir(out,{recursive:true});
  const chunk=(name,data)=>{const b=Buffer.concat([Buffer.from(name),data]);let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=c>>>1^(c&1?0xedb88320:0);}const out=Buffer.alloc(b.length+8);out.writeUInt32BE(data.length);b.copy(out,4);out.writeUInt32BE((c^0xffffffff)>>>0,out.length-4);return out;};
  const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',require('node:zlib').deflateSync(Buffer.from([0,230,160,40,255]))),chunk('IEND',Buffer.alloc(0))]);
  const texture=path.join(out,'fixture.png');await fs.writeFile(texture,png);
  const wav=Buffer.alloc(44+48000*4);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(2,22);wav.writeUInt32LE(48000,24);wav.writeUInt32LE(192000,28);wav.writeUInt16LE(4,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  const audio=path.join(out,'fixture.wav');await fs.writeFile(audio,wav);
  const impact=path.join(out,'impact.wav');const impactBytes=Buffer.from(wav);impactBytes.writeInt16LE(1,44);await fs.writeFile(impact,impactBytes);
  const config=JSON.parse(await fs.readFile(path.resolve(__dirname,'../../config/local.tools.json')));
  config.sourceRoots=[...(config.sourceRoots||[]),out];
  for(const mode of ['player','tree']){
    const s=createSpec({id:'bowFixture',description:'Synthetic skeletal bow mechanism',template:'custom'});
    s.canvas={width:512,height:512,units:'pixels',xAxis:'right',yAxis:'down',rotation:'clockwise-radians'};
    s.bones=[{id:'root',parent:null,rest:{position:[120,220],rotation:0,scale:[1,1]},length:1},
      ...[['upper',[0,0]],['lower',[0,0]],['nock',[-10,0]]].map(([id,position])=>({id,parent:'root',rest:{position,rotation:0,scale:[1,1]},length:60})),...['upper','lower'].map((id,i)=>({id:id+'Tip',parent:id,rest:{position:[10,i?30:-30],rotation:0,scale:[1,1]},length:36}))];
    const image={path:texture,prepared:true,width:1,height:1,alphaBounds:[0,0,1,1],cropTranslation:[0,0],pivot:[0,0],pixelsPerUnit:1};
    s.parts=[{id:'arrow',role:'arrow',bone:'nock',pivot:[0,0],layer:3,image,mesh:{vertices:[[0,-3],[55,-3],[65,0],[55,3],[0,3]],uv:[[0,0],[1,0],[1,0.5],[1,1],[0,1]],triangles:[[0,1,4],[1,3,4],[1,2,3]],weights:Array.from({length:5},()=>[{bone:'nock',weight:1}])}},
      ...['upper','lower'].map((id,i)=>{
        const sign=i?1:-1;
        const centers=[[0,0],[8,sign*15],[10,sign*30],[3,sign*46],[-10,sign*60]];
        const vertices=[],uv=[],weights=[],triangles=[];
        for(let row=0;row<centers.length;row++) {
          const [x,y]=centers[row];vertices.push([x-3,y],[x+3,y]);uv.push([0,row/4],[1,row/4]);
          const influence=row===0?[{bone:'root',weight:1}]:row===1?[{bone:'root',weight:.5},{bone:id,weight:.5}]:row===2?[{bone:id,weight:1}]:row===3?[{bone:id,weight:.3},{bone:id+'Tip',weight:.7}]:[{bone:id+'Tip',weight:1}];
          weights.push(structuredClone(influence),structuredClone(influence));
          if(row<4){const a=row*2;triangles.push([a,a+1,a+3],[a,a+3,a+2]);}
        }
        return {id,role:id,bone:'root',pivot:[0,0],layer:2,image,mesh:{vertices,uv,triangles,weights}};
      })];
    s.polylines=[{id:'string',anchors:[{bone:'upperTip',position:[-20,-30]},{bone:'nock',position:[0,0]},{bone:'lowerTip',position:[-20,30]}],width:2,color:[1,1,1,1],layer:4}];
    s.sockets=[{id:'release',bone:'nock',transform:{position:[0,0],rotation:0,scale:[1,1]},types:['projectile'],capacity:1,inheritance:{position:true,rotation:true,scale:true}}];
    s.sockets.push({...structuredClone(s.sockets[0]),id:'releaseSpare'});
    s.projectiles=[{id:'arrowShot',part:'arrow',forward:[1,0],flightDuration:.5,lifetime:2,removalPolicy:'cancel',impactSound:'impact'},{id:'unusedShot',part:'arrow',forward:[1,0],flightDuration:.5,lifetime:2,impactSound:'unusedImpact'}];
    s.sounds=[{id:'twang',path:audio,volumeDb:-60},{id:'impact',path:impact,volumeDb:-60},{id:'unusedImpact',path:path.join(out,'must-not-read.wav')}];
    s.animations=[{id:'idle',duration:1,loop:true,tracks:[],events:[]},{id:'draw',duration:1,loop:false,tracks:[{bone:'nock',property:'position',keys:[{time:0,value:[-10,0]},{time:.5,value:[-55,0]},{time:1,value:[-55,0]}]},{bone:'upper',property:'rotation',keys:[{time:0,value:0},{time:.5,value:-.35},{time:1,value:-.35}]},{bone:'lower',property:'rotation',keys:[{time:0,value:0},{time:.5,value:.35},{time:1,value:.35}]}],events:[]},{id:'hold',duration:1,loop:true,tracks:[{bone:'nock',property:'position',keys:[{time:0,value:[-55,0]},{time:1,value:[-55,0]}]}],events:[]},{id:'releaseBow',duration:1,loop:false,tracks:[{bone:'nock',property:'position',keys:[{time:0,value:[-55,0]},{time:.5,value:[-55,0]},{time:.6,value:[-10,0]}]}],events:[{id:'shoot',type:'projectile',time:.5,payload:{projectile:'arrowShot',sourceSocket:'release',nockedPart:'arrow'}}]}];
    s.animations.find(clip=>clip.id==='draw').tracks=s.animations.find(clip=>clip.id==='draw').tracks.filter(track=>track.property==='position');
    for(const [bone,value] of [['upper',-.1],['lower',.1],['upperTip',-.35],['lowerTip',.35]]) {
      s.animations.find(clip=>clip.id==='draw').tracks.push({bone,property:'rotation',keys:[{time:0,value:0},{time:.5,value},{time:1,value}]});
      s.animations.find(clip=>clip.id==='hold').tracks.push({bone,property:'rotation',keys:[{time:0,value},{time:1,value}]});
      s.animations.find(clip=>clip.id==='releaseBow').tracks.push({bone,property:'rotation',keys:[{time:0,value},{time:.5,value},{time:.6,value:0}]});
    }
    s.animations.find(clip=>clip.id==='releaseBow').events.unshift({id:'releaseSound',type:'sound',time:.5,payload:{sound:'twang'}});
    const multi=structuredClone(s.animations.find(clip=>clip.id==='releaseBow'));multi.id='multiRelease';multi.events=multi.events.filter(event=>event.type==='sound');
    for(const id of ['shootA','shootB'])multi.events.push({id,type:'projectile',time:.5,payload:{projectile:'arrowShot',sourceSocket:'release',nockedPart:'arrow'}});
    s.animations.push(multi);
    s.animations.push({id:'directRelease',duration:1,loop:false,tracks:[],events:[{id:'shoot',type:'projectile',time:0,payload:{projectile:'arrowShot',sourceSocket:'release'}}]});
    const partial=structuredClone(multi);partial.id='partialRelease';partial.events.find(event=>event.id==='shootB').payload.sourceSocket='releaseSpare';s.animations.push(partial);
    s.export.playback=mode;
    const result=await compileGodot(s,{config,stagingDir:path.join(out,mode),render:true});
    await fs.copyFile(path.join(__dirname,'bow_runtime.gd'),path.join(result.project,'bow_test.gd'));
    const tool=config.tools.megadot||config.tools.godot;
    const run=await runTool({native:{...tool,cwd:path.dirname(tool.executable)}},'native',['--rendering-method','gl_compatibility','--position','-10000,-10000','--path',result.project,'--script','res://bow_test.gd','--log-file',path.join(result.project,'bow-native.log')],{timeoutMs:30000});
    await fs.writeFile(path.join(out,mode,'bow-process.json'),JSON.stringify(run,null,2));
    if(run.exitCode||run.error||/SCRIPT ERROR|ERROR:/.test(run.stdout+run.stderr))throw new Error(JSON.stringify(run));
    console.log(mode,await fs.readFile(path.join(result.project,'bow-validation.json'),'utf8'));
  }
}
if(process.argv.includes('--run'))main().catch(e=>{console.error(e);process.exitCode=1;});
