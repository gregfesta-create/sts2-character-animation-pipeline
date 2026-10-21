'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {validatePackPlan,exportGodotPack}=require('../lib/export');
const {planGodotResources}=require('../adapters/godot');
const file=(path,text)=>{const b=Buffer.from(text);return {path,size:b.length,hash:crypto.createHash('sha256').update(b).digest('hex'),base64:b.toString('base64')};};
test('pack input accepts only complete verified namespaced captures',()=>{
 const plan=planGodotResources({namespace:'mods/hero',files:[file('character.tscn','[gd_scene format=3]\n[node name="Character" type="Node2D"]\n')]});
 assert.equal(validatePackPlan(plan).rootScene,'mods/hero/character.tscn');
 for(const invalid of [{...plan,files:[{...plan.files[0],hash:'0'.repeat(64)}]},{...plan,files:[...plan.files,file('extra.gd','extends Node')]},{...plan,rootScene:'../bad.tscn'}])assert.throws(()=>validatePackPlan(invalid));
});
test('native failure retains bounded unpublished directories and never claims a pack',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
 const stagingParent=await fs.mkdtemp(path.join(os.tmpdir(),'pack-failure-'));t.after(()=>fs.rm(stagingParent,{recursive:true,force:true}));
 const plan=planGodotResources({namespace:'hero',files:[file('character.tscn','[gd_scene format=3]\n[node name="Character" type="Node2D"]')]});
 await assert.rejects(exportGodotPack({plan,stagingParent,tool:{executable:process.execPath}}),error=>{
  assert.equal(error.cleanupStatus,'retained-unpublished');assert.equal(error.retainedDirectories.length,4);assert.equal(error.process.requestReceipt.size>0,true);assert.equal(error.code,'INVALID_PACK_EXPORT');return true;
 });
 assert.equal((await fs.readdir(stagingParent)).length,4);
 await assert.rejects(exportGodotPack({plan,stagingParent,tool:{executable:'relative.exe'}}));
});
test('pack refuses imported resource dependencies and invalid quotas before native launch',()=>{
 const plan=planGodotResources({namespace:'hero',files:[file('character.tscn','[gd_scene load_steps=2 format=3]\n[ext_resource type="Texture2D" path="res://x.png" id="1"]\n[node name="Character" type="Node2D"]'),file('x.png','png')]});
 assert.throws(()=>validatePackPlan(plan),/import/i);
 assert.throws(()=>validatePackPlan(plan,{maxBytes:0}));
});
test('pack byte ceiling is enforced before creating any staging directories',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
 const stagingParent=await fs.mkdtemp(path.join(os.tmpdir(),'pack-ceiling-'));t.after(()=>fs.rm(stagingParent,{recursive:true,force:true}));
 const plan=planGodotResources({namespace:'hero',files:[file('character.tscn','[gd_scene format=3]\n[node name="Character" type="Node2D"]')]});
 await assert.rejects(exportGodotPack({plan,stagingParent,tool:{executable:process.execPath},maxPackBytes:1}),/conservative/i);
 assert.deepEqual(await fs.readdir(stagingParent),[]);
 const names=Array.from({length:50},(_,i)=>'long-'+ 'x'.repeat(200)+i+'.gd');
 const large=planGodotResources({namespace:'hero',files:[file('character.tscn','[gd_scene format=3]\n'+names.map((name,i)=>`[ext_resource type="Script" path="res://${name}" id="${i}"]`).join('\n')+'\n[node name="Character" type="Node2D"]'),...names.map(name=>file(name,'extends Node'))]});
 await assert.rejects(exportGodotPack({plan:large,stagingParent,tool:{executable:process.execPath}}),error=>{assert.match(error.message,/Native pack creation failed/);assert.equal(error.process.requestReceipt.size>15000,true);return true;});
 assert.equal((await fs.readdir(stagingParent)).length,4);
});
test('Windows locked launcher denies writes and renames until owned child completes',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
 const {runLockedTool}=require('../lib/export');
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pack-lock-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const target=path.join(folder,'locked.gd'),bytes=Buffer.from('original');await fs.writeFile(target,bytes);
 const code='const fs=require("node:fs"),path=require("node:path");const manifest=path.join(process.argv[2],fs.readdirSync(process.argv[2]).find(x=>x.startsWith("runtime-")),"locked-request.json");let count=0;for(const f of [()=>fs.writeFileSync(process.argv[1],"changed"),()=>fs.renameSync(process.argv[1],process.argv[1]+".moved"),()=>fs.renameSync(process.argv[2],process.argv[2]+".moved"),()=>fs.writeFileSync(manifest,"changed"),()=>fs.renameSync(manifest,manifest+".moved")]){try{f();process.exit(9);}catch(e){if(!["EPERM","EACCES","EBUSY"].includes(e.code))throw e;count++;}}console.log("DENIED "+count);process.exit(7);';
 const result=await runLockedTool({tool:{executable:process.execPath},args:['-e',code,target,folder],files:[{path:target,size:bytes.length,hash:crypto.createHash('sha256').update(bytes).digest('hex')}],requestRoot:folder});
 assert.equal(result.exitCode,7);assert.match(result.stdout,/DENIED 5/);assert.equal(await fs.readFile(target,'utf8'),'original');await fs.rename(result.requestReceipt.path,result.requestReceipt.path+'.released');
 await fs.rename(target,target+'.released');await fs.writeFile(target+'.released','released');
});
test('locked launcher refuses changed input and kills timed out child while releasing locks',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');const {runLockedTool}=require('../lib/export');
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pack-lock-failure-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const target=path.join(folder,'input.gd'),bytes=Buffer.from('original');await fs.writeFile(target,bytes);
 const item={path:target,size:bytes.length,hash:crypto.createHash('sha256').update(bytes).digest('hex')};
 const bad=await runLockedTool({tool:{executable:process.execPath},args:['-e','process.exit(9)'],files:[{...item,hash:'0'.repeat(64)}]});
 assert.equal(bad.exitCode,125);assert.match(bad.stderr,/hash changed/);
 const timeout=await runLockedTool({tool:{executable:process.execPath},args:['-e','setInterval(()=>{},1000)'],files:[item],timeoutMs:100});
 assert.equal(timeout.exitCode,125);assert.match(timeout.stderr,/timed out/);await fs.writeFile(target,'released');
 const noisy=await runLockedTool({tool:{executable:process.execPath},args:['-e','process.stdout.write("x".repeat(1200000))'],files:[],requestRoot:folder});assert.equal(noisy.exitCode,125);assert.match(noisy.stderr,/output exceeded/);await fs.rename(noisy.requestReceipt.path,noisy.requestReceipt.path+'.released');
 const missing=await runLockedTool({tool:{executable:path.join(folder,'missing.exe')},args:[],files:[{...item,size:8,hash:crypto.createHash('sha256').update('released').digest('hex')}]});
 assert.equal(missing.exitCode,125);await fs.writeFile(target,'closed after failed start');
});
test('verified request file rejects tampered size hash path and malformed JSON before child starts',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'request-tamper-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const filename=path.join(folder,'request.json'),marker=path.join(folder,'started');
 const bytes=Buffer.from(JSON.stringify({executable:process.execPath,cwd:folder,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`],files:[],timeoutMs:1000}));await fs.writeFile(filename,bytes);
 const helper=await fs.readFile(path.join(__dirname,'../lib/windows-tool-lock.ps1'),'utf8');
 const receipt={path:filename,size:bytes.length,hash:crypto.createHash('sha256').update(bytes).digest('hex')};
 function invoke(value){const command=Buffer.from(helper+"\nexit (Invoke-LockedToolFile '"+Buffer.from(JSON.stringify(value)).toString('base64')+"')",'utf16le').toString('base64');return spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',command],{encoding:'utf8'});}
 for(const changed of [{...receipt,size:receipt.size+1},{...receipt,hash:'0'.repeat(64)},{...receipt,path:path.join(folder,'absent.json')},{...receipt,size:16777217}]){const result=invoke(changed);assert.equal(result.status,125,result.stdout+result.stderr);await fs.rename(filename,filename+'.free');await fs.rename(filename+'.free',filename);}
 const linked=path.join(folder,'linked');await fs.symlink(folder,linked,'junction');const linkedResult=invoke({...receipt,path:path.join(linked,'request.json')});assert.equal(linkedResult.status,125);assert.match(linkedResult.stderr,/reparse point/);await fs.unlink(linked);
 const malformed=Buffer.from('{ invalid');await fs.writeFile(filename,malformed);assert.equal(invoke({...receipt,size:malformed.length,hash:crypto.createHash('sha256').update(malformed).digest('hex')}).status,125);
 await assert.rejects(fs.access(marker));await fs.writeFile(filename,'released');
});
test('Windows request reader accepts verified JSON larger than 2 MiB and still validates resources',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{runLockedTool}=require('../lib/export');
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'request-large-native-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const input=path.join(folder,'input');await fs.writeFile(input,'x');
 const result=await runLockedTool({tool:{executable:process.execPath},args:Array(140).fill('x'.repeat(16000)),files:[{path:input,size:1,hash:'0'.repeat(64)}],requestRoot:folder});
 assert(result.requestReceipt.size>2*1024*1024);assert.equal(result.exitCode,125);assert.match(result.stderr,/hash changed/);await fs.writeFile(input,'released');
});
