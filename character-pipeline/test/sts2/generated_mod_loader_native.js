'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {runTool}=require('../../lib/process'),{resolveContained}=require('../../lib/assets');
async function main(){
 const root=path.resolve(__dirname,'../..'),index=process.argv.indexOf('--evidence'),relative=index<0?'evidence/generated-mod-loader':process.argv[index+1];
 if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Use pipeline-relative evidence');
 const out=await resolveContained(root,relative,{mustExist:false});await fs.mkdir(path.dirname(out),{recursive:true});await fs.mkdir(out);const runtime=path.join(out,'runtime'),fixture=path.join(out,'fixture-build'),owned=path.join(runtime,'owned');for(const dir of [runtime,fixture,owned])await fs.mkdir(dir,{recursive:true});
 const game='C:/Program Files (x86)/Steam/steamapps/common/Slay the Spire 2/data_sts2_windows_x86_64',engine='D:/StS2Modding/tools/MegaDot';
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json')));
 const dotnetRoot=path.join(out,'runtime-root');for(const entry of [['host','fxr'],['shared','Microsoft.NETCore.App']]){const dir=path.join(dotnetRoot,...entry);await fs.mkdir(dir,{recursive:true});try{await fs.symlink(path.join('C:/Program Files/dotnet',...entry,'9.0.18'),path.join(dir,'9.0.18'),'junction');}catch(error){if(error.code!=='EEXIST')throw error;}}
 const tools={dotnet:{...config.tools.dotnet,cwd:engine},native:{...config.tools.megadot,cwd:engine,dotnetRoot}};
 const refs=['sts2','0Harmony','Steamworks.NET'];const references=refs.map(name=>`<Reference Include="${name}"><HintPath>${game}/${name}.dll</HintPath><Private>true</Private></Reference>`).join('');
 await fs.copyFile(path.join(__dirname,'GeneratedModLoaderHarness.cs'),path.join(runtime,'GeneratedModLoaderHarness.cs'));await fs.copyFile(path.join(__dirname,'OwnedModDiscoveryFileIo.cs'),path.join(runtime,'OwnedModDiscoveryFileIo.cs'));
 await fs.writeFile(path.join(runtime,'GeneratedModLoaderHarness.csproj'),`<Project Sdk="Godot.NET.Sdk/4.5.1"><PropertyGroup><TargetFramework>net9.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup><ItemGroup>${references}</ItemGroup></Project>`);
 const token='CharacterPipelineIsolation_'+crypto.randomUUID().replaceAll('-','');await fs.writeFile(path.join(runtime,'project.godot'),`config_version=5\n[application]\nconfig/name="${token}"\nconfig/use_custom_user_dir=true\nconfig/custom_user_dir_name="${token}"\nrun/main_scene="res://main.tscn"\n[dotnet]\nproject/assembly_name="GeneratedModLoaderHarness"\n[sentry]\noptions/auto_init=false\nconfig/dsn=""\n`);await fs.writeFile(path.join(runtime,'main.tscn'),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://GeneratedModLoaderHarness.cs" id="1"]\n[node name="Harness" type="Node"]\nscript=ExtResource("1")\n');
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
 const runtimeProject=path.join(runtime,'GeneratedModLoaderHarness.csproj');await fs.writeFile(runtimeProject,(await fs.readFile(runtimeProject,'utf8')).replace('</ItemGroup>',`<Reference Include="BaseLib"><HintPath>${base}</HintPath><Private>true</Private></Reference></ItemGroup>`));
 await fs.writeFile(path.join(out,'source-receipts.json'),JSON.stringify({resources:integration.resources,rootScene:integration.rootScene,packHash:exported.hash,packBytes:exported.bytes,sourceHashes:await Promise.all(['Presentation.cs','PipelineVisuals.cs','GeneratedModInitializer.cs'].map(async name=>({name,hash:crypto.createHash('sha256').update(await fs.readFile(path.join(fixture,name))).digest('hex')}))),gameAcceptance:false},null,2));
 await build(path.join(fixture,'fixture.csproj'),'fixture-build');
 const dll=path.join(fixture,'.godot/mono/temp/bin/Debug/pipeline_generated_fixture.dll');await fs.copyFile(dll,path.join(owned,'pipeline_generated_fixture.dll'));
 await fs.writeFile(path.join(owned,'pipeline_generated_fixture.json'),JSON.stringify({id:'pipeline_generated_fixture',name:'Owned synthetic loader fixture',author:'Pipeline test',version:'1.0.0',has_dll:true,has_pck:true,affects_gameplay:false,dependencies:[]}));
 const receipts=[];for(const name of ['pipeline_generated_fixture.json','pipeline_generated_fixture.dll','pipeline_generated_fixture.pck']){const bytes=await fs.readFile(path.join(owned,name));receipts.push({Path:name,Size:bytes.length,Hash:crypto.createHash('sha256').update(bytes).digest('hex')});}await fs.writeFile(path.join(runtime,'receipts.json'),JSON.stringify(receipts));
 await build(path.join(runtime,'GeneratedModLoaderHarness.csproj'),'build');
 const dependencies=[];for(const name of [...refs,'BaseLib']){const bytes=await fs.readFile(name==='BaseLib'?base:path.join(game,name+'.dll'));dependencies.push({name,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}await fs.writeFile(path.join(out,'installed-dependencies.json'),JSON.stringify(dependencies,null,2));
 await fs.rename(path.join(out,'compiled'),path.join(out,'compiled-source-denied'));await fs.rename(path.join(out,'export'),path.join(out,'export-source-denied'));await fs.rename(image,image+'.denied');
 const result=await runTool(tools,'native',['--headless','--path',runtime,'--force-steam=off','--log-file',path.join(out,'engine.log')],{timeoutMs:30000});await fs.writeFile(path.join(out,'process.json'),JSON.stringify(result,null,2));assert.equal(result.error,null,result.stdout+result.stderr);assert(!/SCRIPT ERROR|ERROR:/.test(result.stdout+result.stderr),result.stdout+result.stderr);const report=JSON.parse(await fs.readFile(path.join(runtime,'result.json')));assert.equal(report.passed,true);assert(report.checks>=25);console.log(JSON.stringify(report));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});





