'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {createSpec}=require('../../lib/spec');const {hashValue}=require('../../lib/assets');const {compileGodot}=require('../../backends/godot');const {runTool}=require('../../lib/process');
function crc(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([length,name,data,sum]);}
const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',require('node:zlib').deflateSync(Buffer.from([0,255,255,255,255]))),chunk('IEND',Buffer.alloc(0))]);
function fixture(image){
 const spec=createSpec({id:'effectBody',description:'synthetic compiled effects'});spec.canvas.width=192;spec.canvas.height=64;
 spec.parts=[{id:'panel',role:'root',bone:'root',pivot:[0,0],layer:0,image:{path:image,prepared:true,width:1,height:1,alphaBounds:[0,0,1,1],cropTranslation:[0,0],pivot:[0,0],pixelsPerUnit:0.0625}}];
 spec.sockets=[{id:'arrow',bone:'root',transform:{position:[0,0],rotation:0,scale:[1,1]},types:['projectile'],capacity:1,inheritance:{position:true,rotation:true,scale:true}}];
 const hash=crypto.createHash('sha256').update(png).digest('hex'),h='a'.repeat(64),evidence={id:'source',path:'Power.cs',hash:h,symbol:'Power',lineStart:1,lineEnd:1,excerpt:'amount'};
 const decision={id:'poison',mechanicKey:'mod.poison',outcome:'effect',reason:'synthetic',evidenceIds:['source'],bindingId:'poison',rule:{effectIds:['green','dot'],condition:{type:'amountAtLeast',threshold:1},scope:'whileActive',socketId:'arrow',channel:'tip',priority:1}};
 const plan={version:1,characterId:spec.id,mechanicsFingerprint:h,inspectionVersion:'1',adapterContractVersion:'1',evidence:[evidence],decisions:[decision]};
 const build={styleHash:hashValue(spec.style),plan,inventory:{version:1,complete:true,characterId:spec.id,fingerprint:h,evidence:[evidence],mechanics:[{key:'mod.poison',evidenceIds:['source']}]},bindings:[{id:'poison',mechanicKey:'mod.poison',adapterContractVersion:'1'}],resources:[{hash,base64:png.toString('base64'),size:png.length,importSettings:{},styleProvenance:hashValue(spec.style),approvalProvenance:'synthetic fixture'}],catalog:[{id:'green',capability:'tint',resourceHashes:[hash],presentation:{color:[0,1,0,1]}},{id:'dot',capability:'overlay',resourceHashes:[hash],presentation:{resourceHash:hash,offset:[8,-4],scale:[4,4]}}],targets:{arrow:{partId:'panel'}}};
 return {spec,build};
}
async function main(){
 const i=process.argv.indexOf('--evidence'),out=path.resolve(i<0?path.join(__dirname,'../../evidence/e3-effect-compile'):process.argv[i+1]),source=path.join(out,'source');await fs.mkdir(source,{recursive:true});
 const image=path.join(source,'panel.png');await fs.writeFile(image,png);const {spec,build}=fixture(image),config=JSON.parse(await fs.readFile(path.join(__dirname,'../../config/local.tools.json')));
 const compiled=await compileGodot(spec,{stagingDir:path.join(source,'compile'),config,effectBuild:build});
 const relocated=path.join(out,'relocated');await fs.cp(compiled.project,relocated,{recursive:true});await fs.copyFile(path.join(__dirname,'effect_compile_runtime.gd'),path.join(relocated,'probe.gd'));
 await fs.rename(source,path.join(out,'source-denied'));
 // Prove the PackedScene embeds the overlay instead of reopening its captured PNG.
 for(const name of await fs.readdir(relocated))if(name.startsWith('effect-')&&name.endsWith('.png')||['compile.gd','spec.json'].includes(name))await fs.rm(path.join(relocated,name));
 const tool=config.tools.megadot;const result=await runTool({native:{...tool,cwd:path.dirname(tool.executable)}},'native',['--rendering-method','gl_compatibility','--position','-10000,-10000','--path',relocated,'--script','res://probe.gd'],{timeoutMs:30000});await fs.writeFile(path.join(out,'process.json'),JSON.stringify(result));
 if(result.exitCode||result.error||/SCRIPT ERROR|ERROR:/.test(result.stdout+result.stderr))throw Error(JSON.stringify(result));const report=JSON.parse(await fs.readFile(path.join(relocated,'effect-validation.json')));if(report.checks.some(c=>!c.passed))throw Error(JSON.stringify(report));console.log(JSON.stringify(report));
}
if(process.argv.includes('--run'))main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={fixture,png};


