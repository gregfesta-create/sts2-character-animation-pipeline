'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {runTool}=require('../../lib/process');
const {createSpec}=require('../../lib/spec');
const {compileGodot}=require('../../backends/godot');
const {planGodotResources}=require('../../adapters/godot');
const {exportGodotPack}=require('../../lib/export');
async function capture(root,relative='') {
 const out=[];
 for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})) {
  const name=path.posix.join(relative,entry.name);
  if(entry.isDirectory()){if(entry.name!=='.godot')out.push(...await capture(root,name));}
  else {const bytes=await fs.readFile(path.join(root,name));out.push({path:name,size:bytes.length,hash:crypto.createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')});}
 } return out;
}
async function main(){
 const pipeline=path.resolve(__dirname,'../..'),argument=process.argv.indexOf('--evidence');
 const out=path.resolve(argument<0?path.join(pipeline,'evidence/w6-packed-visual'):process.argv[argument+1]);
 if(!out.startsWith(pipeline+path.sep))throw Error('Evidence must be inside pipeline');
 await fs.mkdir(out,{recursive:true});
 const config=JSON.parse(await fs.readFile(path.join(pipeline,'config/local.tools.json')));
 const spec=createSpec({id:'packed_native',description:'Synthetic native integration fixture'});spec.export.playback='tree';
 spec.animations=['idle','attack','hit','death','revive'].map(id=>({id,duration:1,loop:id==='idle',events:[],tracks:[{bone:'root',property:'rotation',keys:[{time:0,value:0},{time:.5,value:.1},{time:1,value:0}]}]}));
 const source=path.join(out,'source'),exportDir=path.join(out,'export');
 await fs.mkdir(exportDir,{recursive:true});
 const compiled=await compileGodot(spec,{stagingDir:source,config});
 const plan=planGodotResources({namespace:'packed_native',files:await capture(compiled.project)});
 const pack=await exportGodotPack({plan,stagingParent:exportDir,tool:config.tools.megadot||config.tools.godot});
 const harness=path.join(out,'harness');await fs.mkdir(harness,{recursive:true});
 await fs.copyFile(pack.pack,path.join(harness,'character.pck'));
 await fs.writeFile(path.join(harness,'root.txt'),pack.rootScene);
 await fs.rename(source,source+'-denied');await fs.rename(exportDir,exportDir+'-denied');
 const game='C:/Program Files (x86)/Steam/steamapps/common/Slay the Spire 2/data_sts2_windows_x86_64',base='D:/StS2Modding/downloads/baselib-3.4.7/extracted/BaseLib.dll',engine='D:/StS2Modding/tools/MegaDot';
 for(const [src,dst]of [['adapters/sts2/PipelineVisuals.cs','PipelineVisuals.cs'],['test/sts2/PackedVisualHarness.cs','PackedVisualHarness.cs']])await fs.copyFile(path.join(pipeline,src),path.join(harness,dst));
 await fs.writeFile(path.join(harness,'PackedVisual.csproj'),`<Project Sdk="Godot.NET.Sdk/4.5.1"><PropertyGroup><TargetFramework>net9.0</TargetFramework><Nullable>enable</Nullable><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup><Compile Include="*.cs"/><Reference Include="sts2"><HintPath>${game}/sts2.dll</HintPath><Private>true</Private></Reference><Reference Include="BaseLib"><HintPath>${base}</HintPath><Private>true</Private></Reference><Reference Include="0Harmony"><HintPath>${game}/0Harmony.dll</HintPath><Private>true</Private></Reference></ItemGroup></Project>`);
 await fs.writeFile(path.join(harness,'project.godot'),'[application]\nconfig/name="PackedVisual"\nrun/main_scene="res://main.tscn"\n[dotnet]\nproject/assembly_name="PackedVisual"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
 await fs.writeFile(path.join(harness,'main.tscn'),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://PackedVisualHarness.cs" id="1"]\n[node name="Harness" type="Node"]\nscript=ExtResource("1")\n');
 const build=spawnSync('dotnet',['build',path.join(harness,'PackedVisual.csproj'),'--ignore-failed-sources'],{encoding:'utf8',timeout:60000});await fs.writeFile(path.join(out,'build.log'),build.stdout+build.stderr);if(build.status!==0)throw Error('Build failed; see build.log');
 const run=await runTool({megadot:{executable:path.join(engine,'MegaDot_v4.5.1-stable_mono_win64_console.exe'),cwd:engine}},'megadot',['--headless','--path',harness],{timeoutMs:30000});
 await fs.writeFile(path.join(out,'process.json'),JSON.stringify({cwd:engine,status:run.exitCode,error:run.error,stdout:run.stdout,stderr:run.stderr,packHash:pack.hash,packBytes:pack.bytes,rootScene:pack.rootScene},null,2));
 if(run.error||run.exitCode!==0||/SCRIPT ERROR|ERROR:/.test(run.stdout+run.stderr))throw Error('Native packed integration failed; see process.json');
 console.log(await fs.readFile(path.join(harness,'result.json'),'utf8'));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
