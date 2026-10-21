'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {runTool} = require('../../lib/process');
const crypto = require('node:crypto');
async function main() {
  const pipeline = path.resolve(__dirname, '../..');
  const argument = process.argv.indexOf('--evidence');
  const out = path.resolve(argument < 0 ? path.join(pipeline, 'evidence/w6-visual-adapter') : process.argv[argument + 1]);
  if (!out.startsWith(pipeline + path.sep)) throw Error('Evidence must be inside pipeline');
  await fs.mkdir(out, {recursive:true});
  const game = 'C:/Program Files (x86)/Steam/steamapps/common/Slay the Spire 2/data_sts2_windows_x86_64';
  const base = 'D:/StS2Modding/downloads/baselib-3.4.7/extracted/BaseLib.dll';
  const engine = 'D:/StS2Modding/tools/MegaDot';
  for (const [source, target] of [['test/sts2/VisualAdapterHarness.cs', 'VisualAdapterHarness.cs'], ['adapters/sts2/PipelineVisuals.cs', 'PipelineVisuals.cs']]) {
    try { await fs.copyFile(path.join(pipeline, source), path.join(out, target)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const project = `<Project Sdk="Godot.NET.Sdk/4.5.1"><PropertyGroup><TargetFramework>net9.0</TargetFramework><Nullable>enable</Nullable><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup><Compile Include="*.cs"/><Reference Include="sts2"><HintPath>${game}/sts2.dll</HintPath><Private>true</Private></Reference><Reference Include="BaseLib"><HintPath>${base}</HintPath><Private>true</Private></Reference><Reference Include="0Harmony"><HintPath>${game}/0Harmony.dll</HintPath><Private>true</Private></Reference></ItemGroup></Project>`;
  await fs.writeFile(path.join(out,'VisualAdapter.csproj'),project);
  await fs.writeFile(path.join(out,'project.godot'),'[application]\nconfig/name="VisualAdapter"\nrun/main_scene="res://main.tscn"\n[dotnet]\nproject/assembly_name="VisualAdapter"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
  await fs.writeFile(path.join(out,'main.tscn'),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://VisualAdapterHarness.cs" id="1"]\n[node name="Harness" type="Node"]\nscript = ExtResource("1")\n');
  const build = spawnSync('dotnet',['build',path.join(out,'VisualAdapter.csproj'),'--ignore-failed-sources'],{encoding:'utf8',timeout:60000});
  await fs.writeFile(path.join(out,'build.log'),build.stdout+build.stderr);
  if (build.status !== 0) throw Error('Native harness build failed; see '+path.join(out,'build.log'));
  await fs.rm(path.join(out,'result.json'),{force:true});
  const run=await runTool({megadot:{executable:path.join(engine,'MegaDot_v4.5.1-stable_mono_win64_console.exe'),cwd:engine}},'megadot',['--headless','--path',out],{timeoutMs:30000});
  const hashes={}; for(const file of [game+'/sts2.dll',base]) hashes[file]=crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  await fs.writeFile(path.join(out,'process.json'),JSON.stringify({cwd:engine,status:run.exitCode,error:run.error,stdout:run.stdout,stderr:run.stderr,hashes},null,2));
  if(run.error||run.exitCode!==0 || /SCRIPT ERROR|ERROR:/.test(run.stdout+run.stderr)) throw Error('Native harness failed; see process.json');
  console.log(await fs.readFile(path.join(out,'result.json'),'utf8'));
}
if(process.argv.includes('--run')) main().catch(error=>{console.error(error);process.exitCode=1;});
