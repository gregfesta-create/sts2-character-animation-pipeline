'use strict';
// Explicit synthetic CLI proof. Never approves user art or calls creative models.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {createSpec}=require('../../lib/spec'),{runTool}=require('../../lib/process'),{resolveContained}=require('../../lib/assets');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function png(){
 const chunk=(type,data)=>{const b=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of b){crc^=byte;for(let i=0;i<8;i++)crc=crc>>>1^(crc&1?0xedb88320:0);}const out=Buffer.alloc(b.length+8);out.writeUInt32BE(data.length);b.copy(out,4);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;};
 const h=Buffer.alloc(13);h.writeUInt32BE(16);h.writeUInt32BE(16,4);h[8]=8;h[9]=6;const rows=Buffer.alloc(16*65);for(let y=0;y<16;y++)for(let x=0;x<16;x++){const i=y*65+1+x*4;rows[i]=40;rows[i+1]=180;rows[i+2]=100;rows[i+3]=255;}
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',require('node:zlib').deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
async function main(){
 const root=path.resolve(__dirname,'../..'),index=process.argv.indexOf('--evidence'),relative=index<0?'evidence/w6-delivery-native':process.argv[index+1];
 if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Evidence must remain in pipeline workspace');
 const out=await resolveContained(root,relative,{mustExist:false});await fs.mkdir(out,{recursive:true});const source=path.join(out,'source');await fs.mkdir(source);
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json')));config.outputRoot=out;config.sourceRoots=[source];for(const tool of Object.values(config.tools))tool.cwd=path.dirname(tool.executable);
 const configPath=path.join(out,'tools.json');await fs.writeFile(configPath,JSON.stringify(config));
 await fs.writeFile(path.join(source,'panel.png'),png());const spec=createSpec({id:'delivery-fixture',description:'synthetic CLI artwork and pack fixture',template:'custom'});spec.canvas.width=32;spec.canvas.height=32;spec.export.playback='tree';spec.bones[0].rest.position=[8,8];
 spec.parts=[{id:'panel',role:'panel',bone:'root',pivot:[8,8],layer:0,image:{path:'panel.png'},mesh:{vertices:[[0,0],[16,0],[16,16],[0,16]],uv:[[0,0],[16,0],[16,16],[0,16]],triangles:[[0,1,2],[0,2,3]],weights:Array.from({length:4},()=>[{bone:'root',weight:1}])}}];
 spec.animations=[{id:'idle',duration:1,loop:true,events:[],tracks:[{bone:'root',property:'rotation',keys:[{time:0,value:0},{time:.5,value:.2},{time:1,value:0}]}]}];
 const specPath=path.join(source,'character.json');await fs.writeFile(specPath,JSON.stringify(spec));const jobRoot=path.join(out,'job'),checks=[];
 async function cli(name,args){const result=await runTool({node:{executable:process.execPath,cwd:path.dirname(config.tools.megadot.executable)}},'node',[path.join(root,'cli.js'),...args,'--config',configPath],{timeoutMs:60000,maxOutputBytes:4*1024*1024});await fs.writeFile(path.join(out,name+'-process.json'),JSON.stringify(result,null,2));if(result.error||result.exitCode)throw Error(name+': '+JSON.stringify(result));const response=JSON.parse(result.stdout);assert.equal(response.ok,true);return response.result;}
 const pending=await cli('build',['build',specPath,'--job',jobRoot,'--no-render']);assert.equal(pending.status,'awaiting_artwork_approval');assert.equal(Object.keys(pending.manifest.stages).length,0);checks.push({name:'CLI pauses before any prep for exact synthetic original approval',passed:true});
 const approved=await cli('approve',['approve-artwork',jobRoot,'--review',pending.reviewId]);assert.equal(approved.approved,true);assert.equal(approved.reviewId,pending.reviewId);
 const built=await cli('resume',['resume',jobRoot,'--no-render']);assert.equal(built.valid,true);assert.equal(built.rendered,false);checks.push({name:'CLI approval and real Pillow/native rig resume',passed:true});
 const exported=await cli('export',['export',jobRoot,'--namespace','mods/delivery_fixture']);assert.equal(exported.status,'exported');assert.equal(exported.gameAcceptance,false);assert.equal(exported.rootScene,'res://mods/delivery_fixture/character.tscn');
 const pack=await fs.readFile(exported.pack);assert.equal(hash(pack),exported.hash);assert.equal(pack.length,exported.bytes);assert.equal(pack.subarray(0,4).toString(),'GDPC');assert.equal(exported.sizeReport.archiveBytes,pack.length);checks.push({name:'CLI publishes physical PCK with matching size/hash/root receipt',passed:true});
 const artifactNames=exported.manifest.stages.export.artifacts.map(a=>path.basename(a.path)).sort();assert.deepEqual(artifactNames,['character.pck','delivery.json']);const receipt=JSON.parse(await fs.readFile(path.join(path.dirname(exported.pack),'delivery.json'),'utf8'));assert.equal(receipt.hash,exported.hash);checks.push({name:'Published export contains only runtime pack and delivery receipt',passed:true});
 await fs.rename(source,path.join(out,'source-denied'));const second=await cli('export-cached',['export',jobRoot,'--namespace','mods/delivery_fixture']);assert.equal(second.hash,exported.hash);assert.equal(second.pack,exported.pack);
 for(const [id,stage]of Object.entries(exported.manifest.stages)){assert.equal(second.manifest.stages[id].directory,stage.directory);assert.equal(second.manifest.stages[id].attempts.length,stage.attempts.length);}checks.push({name:'CLI export reuses every checkpoint after original source paths are denied',passed:true});
 const relocated=path.join(out,'relocated');await fs.mkdir(relocated);await fs.copyFile(exported.pack,path.join(relocated,'character.pck'));await fs.writeFile(path.join(relocated,'project.godot'),'config_version=5\n');await fs.copyFile(path.join(__dirname,'pack_export_runtime.gd'),path.join(relocated,'probe.gd'));
 await fs.writeFile(path.join(relocated,'probe.json'),JSON.stringify({pack:path.join(relocated,'character.pck').replaceAll('\\','/'),rootScene:exported.rootScene,files:exported.sizeReport.largestFiles}));
 await fs.rename(jobRoot,path.join(out,'job-denied'));
 const processResult=await runTool({native:config.tools.megadot},'native',['--headless','--path',relocated,'--script','res://probe.gd'],{timeoutMs:30000,maxOutputBytes:1024*1024});await fs.writeFile(path.join(out,'loader-process.json'),JSON.stringify(processResult,null,2));if(processResult.error||processResult.exitCode||/SCRIPT ERROR|ERROR:/.test(processResult.stdout+processResult.stderr))throw Error(JSON.stringify(processResult));
 const native=JSON.parse(await fs.readFile(path.join(relocated,'validation.json')));assert.ok(native.checks.length);assert.ok(native.checks.every(c=>c.passed));checks.push(...native.checks);
 const result={checks,packBytes:exported.bytes,packHash:exported.hash,gameAcceptance:false};await fs.writeFile(path.join(out,'validation.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
