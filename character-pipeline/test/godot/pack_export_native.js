'use strict';
// Synthetic fixture only; opt-in so node:test never launches native tools.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {createSpec}=require('../../lib/spec'),{compileGodot}=require('../../backends/godot');
const {planGodotResources}=require('../../adapters/godot'),{exportGodotPack}=require('../../lib/export'),{runTool}=require('../../lib/process');
function png(){const chunk=(type,data)=>{const b=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of b){crc^=byte;for(let i=0;i<8;i++)crc=crc>>>1^(crc&1?0xedb88320:0);}const out=Buffer.alloc(b.length+8);out.writeUInt32BE(data.length);b.copy(out,4);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;};const h=Buffer.alloc(13);h.writeUInt32BE(1);h.writeUInt32BE(1,4);h[8]=8;h[9]=6;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',require('node:zlib').deflateSync(Buffer.from([0,255,60,30,255]))),chunk('IEND',Buffer.alloc(0))]);}
async function main(){
 const root=path.resolve(__dirname,'../..'),index=process.argv.indexOf('--evidence'),relative=index<0?'evidence/w6-pack-native':process.argv[index+1];
 if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Evidence must remain within workspace');
 const out=path.join(root,relative);await fs.mkdir(out,{recursive:true});const source=path.join(out,'source');await fs.mkdir(source);
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json')));for(const tool of Object.values(config.tools))tool.cwd=path.dirname(tool.executable);
 const image=path.join(source,'panel.png');await fs.writeFile(image,png());
 const spec=createSpec({id:'pack-fixture',description:'synthetic pack verification'});spec.export.playback='tree';
 spec.parts=[{id:'panel',role:'panel',bone:'root',pivot:[0,0],layer:0,image:{path:image,prepared:true,width:1,height:1,alphaBounds:[0,0,1,1],cropTranslation:[0,0],pivot:[0,0],pixelsPerUnit:1},mesh:{vertices:[[0,0],[1,0],[1,1],[0,1]],uv:[[0,0],[1,0],[1,1],[0,1]],triangles:[[0,1,2],[0,2,3]],weights:Array.from({length:4},()=>[{bone:'root',weight:1}])}}];
 const compiled=await compileGodot(spec,{stagingDir:source,config});const files=[];
 for(const name of await fs.readdir(compiled.project)){if(!/\.(gd|tscn|tres|png)$/.test(name)||name==='compile.gd')continue;const bytes=await fs.readFile(path.join(compiled.project,name));files.push({path:name,size:bytes.length,hash:crypto.createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')});}
 const plan=planGodotResources({namespace:'mods/pack_fixture',files});const stagingParent=path.join(out,'stages');await fs.mkdir(stagingParent);
 const exported=await exportGodotPack({plan,stagingParent,tool:config.tools.megadot});
 const relocated=path.join(out,'relocated');await fs.mkdir(relocated);await fs.copyFile(exported.pack,path.join(relocated,'character.pck'));
 await fs.writeFile(path.join(relocated,'project.godot'),'config_version=5\n');await fs.copyFile(path.join(__dirname,'pack_export_runtime.gd'),path.join(relocated,'probe.gd'));
 await fs.writeFile(path.join(relocated,'probe.json'),JSON.stringify({pack:path.join(relocated,'character.pck').replaceAll('\\','/'),rootScene:exported.rootScene,files:exported.files}));
 await fs.rename(source,path.join(out,'source-denied'));await fs.rename(stagingParent,path.join(out,'stages-denied'));
 const result=await runTool({native:config.tools.megadot},'native',['--headless','--path',relocated,'--script','res://probe.gd'],{timeoutMs:30000});
 await fs.writeFile(path.join(out,'process.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(out,'export.json'),JSON.stringify(exported,null,2));
 if(result.error||result.exitCode||/SCRIPT ERROR|ERROR:/.test(result.stdout+result.stderr))throw Error(JSON.stringify(result));
 const report=JSON.parse(await fs.readFile(path.join(relocated,'validation.json')));if(report.checks.some(c=>!c.passed))throw Error(JSON.stringify(report));console.log(JSON.stringify(report));
}
if(process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
