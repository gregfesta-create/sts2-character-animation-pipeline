'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {runTool}=require('../../lib/process'),{resolveContained}=require('../../lib/assets');
async function main(){
 const root=path.resolve(__dirname,'../..'),i=process.argv.indexOf('--evidence'),relative=i<0?'evidence/modded-game-startup':process.argv[i+1];if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Use pipeline-relative evidence');
 const out=await resolveContained(root,relative,{mustExist:false});await fs.mkdir(path.dirname(out),{recursive:true});await fs.mkdir(out);const runtime=path.join(out,'runtime');await fs.mkdir(runtime,{recursive:true});
 for(const name of ['ModdedGameStartupHarness.cs','OwnedModDiscoveryFileIo.cs'])await fs.copyFile(path.join(__dirname,name),path.join(runtime,name));
 const game='C:/Program Files (x86)/Steam/steamapps/common/Slay the Spire 2/data_sts2_windows_x86_64',engine='D:/StS2Modding/tools/MegaDot';
 await fs.writeFile(path.join(runtime,'ModdedGameStartupHarness.csproj'),`<Project Sdk="Godot.NET.Sdk/4.5.1"><PropertyGroup><TargetFramework>net9.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup><ItemGroup><Reference Include="0Harmony"><HintPath>${game}/0Harmony.dll</HintPath><Private>true</Private></Reference><Reference Include="sts2"><HintPath>${game}/sts2.dll</HintPath><Private>true</Private></Reference></ItemGroup></Project>`);
 const token='CharacterPipelineIsolation_'+crypto.randomUUID().replaceAll('-','');await fs.writeFile(path.join(runtime,'project.godot'),`config_version=5\n[application]\nconfig/name="${token}"\nconfig/use_custom_user_dir=true\nconfig/custom_user_dir_name="${token}"\nrun/main_scene="res://main.tscn"\n[dotnet]\nproject/assembly_name="ModdedGameStartupHarness"\n[sentry]\noptions/auto_init=false\nconfig/dsn=""\n[Fmod]\nGeneral/is_live_update_enabled=false\n`);await fs.writeFile(path.join(runtime,'main.tscn'),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://ModdedGameStartupHarness.cs" id="1"]\n[node name="Harness" type="Node"]\nscript=ExtResource("1")\n');
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json')));
 const fixture=path.join(out,'fixture-build'),owned=path.join(runtime,'owned');for(const dir of [fixture,owned])await fs.mkdir(dir,{recursive:true});
 const refs=['sts2','0Harmony','Steamworks.NET'];const references=refs.map(name=>`<Reference Include="${name}"><HintPath>${game}/${name}.dll</HintPath><Private>true</Private></Reference>`).join('');
 const tools={dotnet:{...config.tools.dotnet,cwd:engine}};
 const build=async(project,label)=>{const result=await runTool(tools,'dotnet',['build',project,'--ignore-failed-sources'],{timeoutMs:60000});await fs.writeFile(path.join(out,label+'.json'),JSON.stringify(result,null,2));assert.equal(result.error,null,result.stdout+result.stderr);};
 await fs.writeFile(path.join(fixture,'fixture.csproj'),`<Project Sdk="Godot.NET.Sdk/4.5.1"><PropertyGroup><TargetFramework>net9.0</TargetFramework><AssemblyName>pipeline_generated_fixture</AssemblyName></PropertyGroup><ItemGroup>${references}</ItemGroup></Project>`);
 await fs.copyFile(path.join(__dirname,'GeneratedModInitializer.cs'),path.join(fixture,'GeneratedModInitializer.cs'));
 const {createSpec}=require('../../lib/spec'),{compileGodot}=require('../../backends/godot'),{planGodotResources}=require('../../adapters/godot'),{exportGodotPack}=require('../../lib/export'),{emitSts2Integration}=require('../../lib/sts2-integration');
 function crc(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
 function chunk(type,data){const name=Buffer.from(type),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([length,name,data,sum]);}
 const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
 const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',require('node:zlib').deflateSync(Buffer.from([0,255,255,255,255]))),chunk('IEND',Buffer.alloc(0))]);
 const image=path.join(out,'panel.png');await fs.writeFile(image,png);
 const spec=createSpec({id:'pipeline_generated_fixture',description:'Synthetic one pixel mod loader contract'});spec.export={target:'sts2',playback:'tree'};
 spec.parts=[{id:'panel',role:'root',bone:'root',pivot:[0,0],layer:0,image:{path:image,prepared:true,width:1,height:1,alphaBounds:[0,0,1,1],cropTranslation:[0,0],pivot:[0,0],pixelsPerUnit:0.0625}}];
 spec.animations=['idle','attack'].map(id=>({id,duration:1,loop:id==='idle',events:[],tracks:[{bone:'root',property:'rotation',keys:[{time:0,value:0},{time:.5,value:.1},{time:1,value:0}]}]}));
 const compiled=await compileGodot(spec,{stagingDir:path.join(out,'compiled'),config:{...config,tools:{...config.tools,megadot:{...config.tools.megadot,cwd:engine}}}});
 const capture=async(dir,relative='')=>{const files=[];for(const entry of await fs.readdir(path.join(dir,relative),{withFileTypes:true})){const name=path.posix.join(relative,entry.name);if(entry.isDirectory()){if(entry.name!=='.godot')files.push(...await capture(dir,name));}else{const bytes=await fs.readFile(path.join(dir,name));files.push({path:name,size:bytes.length,hash:crypto.createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')});}}return files;};
 const plan=planGodotResources({namespace:'pipeline_generated_fixture',files:await capture(compiled.project)});
 await fs.mkdir(path.join(out,'export'));const exported=await exportGodotPack({plan,stagingParent:path.join(out,'export'),tool:{...config.tools.megadot,cwd:engine}});
 await fs.copyFile(exported.pack,path.join(owned,'pipeline_generated_fixture.pck'));
 const integration=emitSts2Integration({plan,namespace:'GeneratedFixture',className:'Presentation',bounds:{x:0,y:0,width:16,height:16}});
 await fs.writeFile(path.join(fixture,'Presentation.cs'),integration.source);await fs.copyFile(path.join(root,'adapters/sts2/PipelineVisuals.cs'),path.join(fixture,'PipelineVisuals.cs'));
 const base='D:/StS2Modding/downloads/baselib-3.4.7/extracted/BaseLib.dll';const csproj=path.join(fixture,'fixture.csproj');await fs.writeFile(csproj,(await fs.readFile(csproj,'utf8')).replace('</ItemGroup>',`<Reference Include="BaseLib"><HintPath>${base}</HintPath><Private>true</Private></Reference></ItemGroup>`));

 await fs.writeFile(path.join(out,'source-receipts.json'),JSON.stringify({resources:integration.resources,rootScene:integration.rootScene,packHash:exported.hash,packBytes:exported.bytes,sourceHashes:await Promise.all(['Presentation.cs','PipelineVisuals.cs','GeneratedModInitializer.cs'].map(async name=>({name,hash:crypto.createHash('sha256').update(await fs.readFile(path.join(fixture,name))).digest('hex')}))),gameAcceptance:false},null,2));
 await build(path.join(fixture,'fixture.csproj'),'fixture-build');
 const dll=path.join(fixture,'.godot/mono/temp/bin/Debug/pipeline_generated_fixture.dll');await fs.copyFile(dll,path.join(owned,'pipeline_generated_fixture.dll'));
 await fs.writeFile(path.join(owned,'pipeline_generated_fixture.json'),JSON.stringify({id:'pipeline_generated_fixture',name:'Owned synthetic loader fixture',author:'Pipeline test',version:'1.0.0',has_dll:true,has_pck:true,affects_gameplay:false,dependencies:[{id:"BaseLib",min_version:"3.4.7"}]}));
 assert.equal(crypto.createHash('sha256').update(await fs.readFile(base)).digest('hex'),'55863ca6adc30a61a7544874e157a519ffe148ccf2b18025947609c4bff813ce','Known installed BaseLib DLL identity');const manifest=JSON.parse((await fs.readFile(path.join(path.dirname(base),'BaseLib.json'),'utf8')).replace(/^\uFEFF/,''));assert.equal(manifest.id,'BaseLib');assert.equal(manifest.version,'v3.4.7');assert.equal(manifest.has_dll,true);assert.equal(manifest.has_pck,true);for(const name of ['BaseLib.json','BaseLib.dll','BaseLib.pck'])await fs.copyFile(path.join(path.dirname(base),name),path.join(owned,name));
 const modReceipts=[];for(const name of ['BaseLib.json','BaseLib.dll','BaseLib.pck','pipeline_generated_fixture.json','pipeline_generated_fixture.dll','pipeline_generated_fixture.pck']){const bytes=await fs.readFile(path.join(owned,name));modReceipts.push({Path:name,Size:bytes.length,Hash:crypto.createHash('sha256').update(bytes).digest('hex')});}await fs.writeFile(path.join(runtime,'receipts.json'),JSON.stringify(modReceipts));

 await fs.writeFile(path.join(runtime,'ModdedGameStartupHarness.csproj'),`<Project Sdk="Godot.NET.Sdk/4.5.1"><PropertyGroup><TargetFramework>net9.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup><ItemGroup>${references}</ItemGroup></Project>`);
 const runtimeBuild=await runTool({dotnet:{...config.tools.dotnet,cwd:engine}},'dotnet',['build',path.join(runtime,'ModdedGameStartupHarness.csproj'),'--ignore-failed-sources'],{timeoutMs:60000});await fs.writeFile(path.join(out,'build.json'),JSON.stringify(runtimeBuild,null,2));if(runtimeBuild.error)throw Error('Build failed: '+runtimeBuild.stdout+runtimeBuild.stderr);
 const dotnetRoot=path.join(out,'runtime-root');for(const entry of [['host','fxr'],['shared','Microsoft.NETCore.App']]){const dir=path.join(dotnetRoot,...entry);await fs.mkdir(dir,{recursive:true});try{await fs.symlink(path.join('C:/Program Files/dotnet',...entry,'9.0.18'),path.join(dir,'9.0.18'),'junction');}catch(error){if(error.code!=='EEXIST')throw error;}}
 const binaries=['libGodotFmod.windows.template_release.x86_64.dll','libspine_godot.windows.template_release.x86_64.dll','fmod.dll','fmodstudio.dll'];const receipts=[];await fs.mkdir(path.join(runtime,'native'),{recursive:true});for(const name of binaries){const bytes=await fs.readFile(path.join(path.dirname(game),name));await fs.writeFile(path.join(runtime,'native',name),bytes);receipts.push({name,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}await fs.writeFile(path.join(out,'native-receipts.json'),JSON.stringify(receipts,null,2));for(const [id,entry,file,min] of [['fmod','fmod_library_init',binaries[0],'4.5'],['spine','spine_godot_library_init',binaries[1],'4.1']])await fs.writeFile(path.join(runtime,id+'.gdextension'),`[configuration]\nentry_symbol="${entry}"\ncompatibility_minimum="${min}"\n[libraries]\nwindows.x86_64="res://native/${file}"\n`);
 const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
 for(const name of refs){const installed=await fs.readFile(path.join(game,name+'.dll')),copied=await fs.readFile(path.join(runtime,'.godot/mono/temp/bin/Debug',name+'.dll'));assert.equal(sha(copied),sha(installed),'Copied managed dependency must match installed DLL');receipts.push({name:name+'.dll',bytes:installed.length,sha256:sha(installed),managed:true});}
 const binaryPath=r=>path.join(runtime,r.managed?'.godot/mono/temp/bin/Debug':'native',r.name);
 for(const receipt of receipts)assert.equal(sha(await fs.readFile(binaryPath(receipt))),receipt.sha256,'Copied binary identity before launch');
 const expected=structuredClone(receipts);await fs.writeFile(path.join(runtime,'binary-receipts.json'),JSON.stringify(expected,null,2));
 await fs.mkdir(path.join(runtime,".godot"),{recursive:true});await fs.writeFile(path.join(runtime,".godot/extension_list.cfg"),"res://fmod.gdextension\nres://spine.gdextension\n");
 await fs.rename(path.join(out,'compiled'),path.join(out,'compiled-source-denied'));await fs.rename(path.join(out,'export'),path.join(out,'export-source-denied'));await fs.rename(image,image+'.denied');
 const result=await runTool({native:{...config.tools.megadot,dotnetRoot}},'native',['--headless','--path',runtime,'--audio-driver','Dummy','--force-steam=off','--log-file',path.join(out,'engine.log'),...(process.argv.includes('--iteration-no-preload')?['--','--iteration-no-preload']:[])],{timeoutMs:60000});await fs.writeFile(path.join(out,'process.json'),JSON.stringify(result,null,2));
 for(const receipt of receipts)assert.equal(sha(await fs.readFile(binaryPath(receipt))),receipt.sha256,"Copied binary identity after startup");
 let report;try{report=JSON.parse(await fs.readFile(path.join(runtime,'result.json')));}catch(error){if(error.code!=='ENOENT')throw error;}
 const diagnostics=startupDiagnostics(result.stdout+result.stderr);
 await fs.writeFile(path.join(out,'startup-gate.json'),JSON.stringify({passed:result.error===null&&report?.passed===true&&diagnostics.length===0,behavioralPassed:report?.passed===true,actualMainMenuReady:report?.actualMainMenuReady===true,gameAcceptance:false,preloadEnabled:report?.preloadEnabled??!process.argv.includes('--iteration-no-preload'),diagnostics,processError:result.error},null,2));
 assert.equal(result.error,null,'Startup process failed; see process.json and startup-gate.json');assert.equal(diagnostics.length,0,"Engine errors recorded in startup-gate.json and process.json");validateModdedReport(report);assert(report.checks>=25);console.log(JSON.stringify(report));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});









function validateModdedReport(report){
 assert(report.baseLibInitialized===true&&report.baseLibPatches>0&&report.baseLibConfig===true&&report.baseLibScripts===true,'BaseLib initialization evidence missing');
 assert.equal(report.passed,true);assert.equal(report.actualMainMenuReady,true);assert.equal(report.gameStartup,true);assert.equal(report.gameAcceptance,false);assert.equal(report.generatedInitializer,true);
 assert.deepEqual(report.loadedMods,['BaseLib','pipeline_generated_fixture']);
}
if(process.argv.includes('--self-test')){
 const test=require('node:test');
 test('startup diagnostics include ANSI-colored swallowed game and BaseLib errors',()=>{assert.deepEqual(startupDiagnostics('\x1b[31m[ERROR] [BaseLib] partial patch failure\x1b[0m\n[INFO] ready\nERROR: RID leak'),['[ERROR] [BaseLib] partial patch failure','ERROR: RID leak']);});
 test('startup evidence rejects missing actual BaseLib initialization',()=>{
  const report={passed:true,actualMainMenuReady:true,gameStartup:true,gameAcceptance:false,loadedMods:['BaseLib','pipeline_generated_fixture'],baseLibInitialized:false,baseLibPatches:0,baseLibConfig:false,baseLibScripts:false,generatedInitializer:true};
  assert.throws(()=>validateModdedReport(report),/BaseLib initialization evidence/);
 });
}


function startupDiagnostics(text){return text.replace(/\x1b\[[0-9;]*m/g,'').split(/\r?\n/).filter(line=>/SCRIPT ERROR|^ERROR:|^\[ERROR\]/.test(line));}
