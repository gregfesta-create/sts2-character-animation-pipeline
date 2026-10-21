'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {planGodotResources}=require('../adapters/godot');
test('large locked requests use an owned receipt file and a bounded encoded envelope',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),Module=require('node:module');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'request-envelope-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const load=Module._load;let command;
 Module._load=function(name,parent,...rest){if(name==='./process'&&parent.filename.endsWith('export.js'))return {runTool:async(_r,_n,args)=>{command=Buffer.from(args.at(-1),'base64').toString('utf16le');assert(args.at(-1).length<=30000);return {exitCode:0};}};return load.call(this,name,parent,...rest);};
 const filename=require.resolve('../lib/export');delete require.cache[filename];const {runLockedTool}=require(filename);Module._load=load;delete require.cache[filename];
 const files=Array.from({length:1000},(_,i)=>({path:path.join(root,'x'.repeat(180)+i),size:0,hash:'0'.repeat(64)}));
 const result=await runLockedTool({tool:{executable:process.execPath},args:['literal " $value'],files,requestRoot:root});
 assert.equal(result.exitCode,0);assert.equal(result.requestReceipt.size>200000,true);
 const bytes=await fs.readFile(result.requestReceipt.path);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),result.requestReceipt.hash);assert.deepEqual(JSON.parse(bytes).files,files);
 assert.match(command,/Invoke-LockedToolFile/);assert(!command.includes('literal'));assert.deepEqual(result.retainedDirectories,[path.dirname(result.requestReceipt.path)]);
 const before=await fs.readdir(root);
 for(const options of [{files:Array(10004).fill(files[0])},{files:[{...files[0],path:'relative'}]},{args:[42]},{files:Array(600).fill({...files[0],path:path.join(root,'q'.repeat(32000))})},{args:Array(600).fill('q'.repeat(32000))}])await assert.rejects(runLockedTool({tool:{executable:process.execPath},args:[],files:[],requestRoot:root,...options}),/Invalid|budget/);
 assert.deepEqual(await fs.readdir(root),before);
});
test('locked native export preflights the engine before launching its PowerShell helper',()=>{
 const {spawnSync}=require('node:child_process');
 const script=`const assert=require('node:assert/strict'),Module=require('node:module');
 const load=Module._load;let checked=false;
 Module._load=function(name,parent,...rest){
  if(name==='./native-launch')return {prepareNativeTool:async tool=>{assert.equal(tool.executable,'blocked-engine');checked=true;throw Object.assign(Error('Blocked before native launch'),{code:'NATIVE_LAUNCH_BLOCKED'});}};
  if(name==='./process'&&parent.filename.endsWith('export.js'))return {runTool:()=>{throw Error('PowerShell must not launch');}};
  return load.call(this,name,parent,...rest);
 };
 require(${JSON.stringify(require.resolve('../lib/export'))}).runLockedTool({tool:{executable:'blocked-engine'},args:[],files:[]}).then(()=>{throw Error('Unexpected launch');},error=>{assert.equal(error.code,'NATIVE_LAUNCH_BLOCKED');assert.equal(checked,true);}).catch(error=>{console.error(error);process.exitCode=1;});`;
 const result=spawnSync(process.execPath,['-e',script],{encoding:'utf8'});
 assert.equal(result.status,0,result.stdout+result.stderr);
});
test('locked helper receives trusted runtime selection as process configuration rather than command text',()=>{
 const {spawnSync}=require('node:child_process');
 const script=`const assert=require('node:assert/strict'),Module=require('node:module');const load=Module._load;
 const root='D:/runtime with spaces';let launched=false;
 Module._load=function(name,parent,...rest){
  if(name==='./native-launch')return {prepareNativeTool:async tool=>tool};
  if(name==='./process'&&parent.filename.endsWith('export.js'))return {runTool:async(registry,name,args)=>{launched=true;assert.equal(registry.lock.dotnetRoot,root);assert(!Buffer.from(args.at(-1),'base64').toString('utf16le').includes(root));return {exitCode:0,error:null};}};
  return load.call(this,name,parent,...rest);
 };
 Object.defineProperty(process,'platform',{value:'win32'});
 require(${JSON.stringify(require.resolve('../lib/export'))}).runLockedTool({tool:{executable:'C:/engine/Godot.exe',dotnetRoot:root},args:[],files:[]}).then(result=>{assert.equal(result.error,null);assert.equal(launched,true);}).catch(error=>{console.error(error);process.exitCode=1;});`;
 const result=spawnSync(process.execPath,['-e',script],{encoding:'utf8'});
 assert.equal(result.status,0,result.stdout+result.stderr);
});
const file=(path,text)=>{const bytes=Buffer.from(text);return {path,base64:bytes.toString('base64'),hash:crypto.createHash('sha256').update(bytes).digest('hex')};};
function fixture(){return {namespace:'mods/fixture',rootScene:'character.tscn',files:[file('character.tscn','[ext_resource type="Script" path="res://runtime.gd" id="1"]\n[ext_resource type="Texture2D" path="res://texture.png" id="2"]'),file('runtime.gd','extends Node\nfunc again(): return load("res://character.tscn")'),file('texture.png','synthetic'),file('compile.gd','tool only')]};}
test('plans only reachable runtime files and rewrites static references into an owned namespace',()=>{
 const result=planGodotResources(fixture());assert.equal(result.rootScene,'mods/fixture/character.tscn');
 assert.deepEqual(result.files.map(f=>f.path),['mods/fixture/character.tscn','mods/fixture/runtime.gd','mods/fixture/texture.png']);
 assert.match(Buffer.from(result.files[0].base64,'base64').toString(),/res:\/\/mods\/fixture\/runtime.gd/);
 assert.ok(Object.isFrozen(result.files[0]));assert.equal(result.nativeExportStatus,'pending');
});

test('rendered part masks and inspection receipts remain outside the runtime resource closure',()=>{
 const input=fixture();input.files.push(file('part-mask-0.png','numeric alpha fixture'),file('part-mask-63.png','numeric alpha fixture'),file('inspection.json',JSON.stringify({path:'part-mask-0.png'})),file('rig.json',JSON.stringify({maskCaptures:[{path:'part-mask-63.png'}]})));
 const packed=planGodotResources(input);
 assert.deepEqual(packed.files.map(f=>f.path),['mods/fixture/character.tscn','mods/fixture/runtime.gd','mods/fixture/texture.png']);
 assert.ok(!packed.files.some(f=>/part-mask-|inspection\.json|rig\.json/.test(f.path)));
});
test('refuses missing dependencies, path collisions, corrupt captures and development resources',()=>{
 let input=fixture();input.files.pop();input.files=input.files.filter(f=>f.path!=='texture.png');assert.throws(()=>planGodotResources(input),/Missing/);
 input=fixture();input.files.push(file('Texture.png','other'));assert.throws(()=>planGodotResources(input),/collision/i);
 input=fixture();input.files[0].base64=Buffer.from('changed').toString('base64');assert.throws(()=>planGodotResources(input),/hash/i);
 input=fixture();input.files[0]=file('character.tscn','[ext_resource path="res://tools/builder.gd"]');input.files.push(file('tools/builder.gd','extends Node'));assert.throws(()=>planGodotResources(input),/Development/);
});
test('refuses external paths and implicit dynamic loads; explicit dynamic dependencies remain reachable',()=>{
 for(const source of ['load("res://" + name)','load("D:/foreign/file.tres")','load("user://file.tres")','load("../outside.tres")','load("/outside.tres")','load("res://texture.png" + suffix)']){
  const input=fixture();input.files[1]=file('runtime.gd',source);assert.throws(()=>planGodotResources(input),/Dynamic|External/);
 }
 const input=fixture();input.files[1]=file('runtime.gd','extends Node\nfunc load_choice(path): return load(path)');input.files.push(file('choice.tres','[resource]'));
 input.dynamicReferences={'runtime.gd':['choice.tres']};assert.ok(planGodotResources(input).files.some(f=>f.path.endsWith('/choice.tres')));
});
test('namespace and resource bounds fail before packaging',()=>{
 const input=fixture();for(const namespace of ['../foreign','res://foreign','mods/CON','mods/name.'])assert.throws(()=>planGodotResources({...input,namespace}),/path|namespace/i);
 assert.throws(()=>planGodotResources({...input,maxBytes:1}),/budget/i);
});
test('binary Godot resources require native dependency inspection rather than guessed closure',()=>{
 const input=fixture();input.files[0]=file('character.tscn','[ext_resource path="res://audio.res"]');input.files.push(file('audio.res','RSRC opaque uid-only or relative dependency'));
 assert.throws(()=>planGodotResources(input),/Binary resource/);
});
