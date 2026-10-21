'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
// The reused executable fixture checks process.argv when imported.
const runIndex=process.argv.indexOf('--run');if(runIndex>=0)process.argv.splice(runIndex,1);
const {fixture,png}=require('./effect_compile_native');
if(runIndex>=0)process.argv.splice(runIndex,0,'--run');
const {compileGodot}=require('../../backends/godot');
const {runTool}=require('../../lib/process');
function atlasPng(){
 function crc(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
 function chunk(type,data){const name=Buffer.from(type),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([len,name,data,sum]);}
 const h=Buffer.alloc(13);h.writeUInt32BE(2);h.writeUInt32BE(1,4);h[8]=8;h[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',zlib.deflateSync(Buffer.from([0,255,0,0,255,0,0,255,255]))),chunk('IEND',Buffer.alloc(0))]);
}
async function main(){
 const i=process.argv.indexOf('--evidence'),out=path.resolve(i<0?path.join(__dirname,'../../evidence/impact-compile-native'):process.argv[i+1]),source=path.join(out,'source');await fs.mkdir(source,{recursive:true});
 const image=path.join(source,'panel.png');await fs.writeFile(image,png);
 const {spec,build}=fixture(image),atlas=atlasPng(),hash=crypto.createHash('sha256').update(atlas).digest('hex');
 build.resources.push({...build.resources[0],hash,base64:atlas.toString('base64'),size:atlas.length});
 build.catalog[0].resourceHashes.push(hash);
 build.catalog[0].impact={durationSeconds:0.85,presentation:{resourceHash:hash,offset:[0,0],scale:[8,8],animation:{columns:2,rows:1,frameCount:2,durations:[0.1,0.1],loop:true}}};
 build.catalog[1].impact={durationSeconds:1.2,presentation:{resourceHash:build.resources[0].hash,offset:[12,0],scale:[4,4]}};
 const config=JSON.parse(await fs.readFile(path.join(__dirname,'../../config/local.tools.json'))),compiled=await compileGodot(spec,{stagingDir:path.join(source,'compile'),config,effectBuild:build});
 if(compiled.validation.effects.impactConfigured!==true)throw Error('missing actual compiler impact metadata');
 const relocated=path.join(out,'relocated');await fs.cp(compiled.project,relocated,{recursive:true});await fs.copyFile(path.join(__dirname,'impact_compile_runtime.gd'),path.join(relocated,'probe.gd'));
 await fs.rename(source,path.join(out,'source-denied'));
 for(const name of await fs.readdir(relocated))if((name.startsWith('effect-')&&name.endsWith('.png'))||['compile.gd','spec.json'].includes(name))await fs.rm(path.join(relocated,name));
 const tool=config.tools.megadot,result=await runTool({native:{...tool,cwd:path.dirname(tool.executable)}},'native',['--rendering-method','gl_compatibility','--position','-10000,-10000','--path',relocated,'--script','res://probe.gd'],{timeoutMs:30000});await fs.writeFile(path.join(out,'process.json'),JSON.stringify(result));
 if(result.exitCode||result.error||/SCRIPT ERROR|ERROR:/.test(result.stdout+result.stderr))throw Error(JSON.stringify(result));
 const report=JSON.parse(await fs.readFile(path.join(relocated,'impact-validation.json')));report.resourceHashes=build.resources.map(r=>r.hash);report.metadata=compiled.validation.effects;report.syntheticOnly=true;report.actualGameAcceptance=false;
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));if(report.checks.some(c=>!c.passed))throw Error(JSON.stringify(report));console.log(JSON.stringify(report));
}
if(process.argv.includes('--run'))main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={atlasPng};
