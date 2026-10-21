'use strict';
// Opt-in owned numeric fixture. No installed Mods, saves, artwork or retail startup.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(){
 const root=path.resolve(__dirname,'../..'),arg=process.argv.indexOf('--evidence'),relative=arg<0?'evidence/mod-package-native':process.argv[arg+1];
 if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Use pipeline-relative evidence');
 const {resolveContained}=require('../../lib/assets'),{openJob,inspectJob}=require('../../lib/jobs'),{runTool}=require('../../lib/process');
 const out=await resolveContained(root,relative,{mustExist:false});await fs.mkdir(path.dirname(out),{recursive:true});await fs.mkdir(out);
 const runtime=path.join(out,'runtime'),owned=path.join(runtime,'owned'),inputs=path.join(out,'inputs'),jobRoot=path.join(out,'job');
 for(const d of [runtime,owned,inputs,path.join(owned,'BaseLib'),path.join(owned,'packaged')])await fs.mkdir(d,{recursive:true});
 const config=JSON.parse(await fs.readFile(path.join(root,'config/local.tools.json'))),game='C:/Program Files (x86)/Steam/steamapps/common/Slay the Spire 2/data_sts2_windows_x86_64',base='D:/StS2Modding/downloads/baselib-3.4.7/extracted',engine=path.dirname(config.tools.megadot.executable);
 config.outputRoot=out;config.sourceRoots=[out];config.runtimeRoots=[inputs];config.modPackaging={sdkCacheRoot:'C:/Users/Palius/.nuget/packages',dotnetSdkVersion:'10.0.400'};
 config.limits={maxStageBytes:512*1024*1024,maxStorageBytes:4*1024**3};config.tools.dotnet.cwd=engine;config.tools.megadot.cwd=engine;
 const source=path.join(root,'evidence/generated-loader-green4/compiled-source-denied/godot');
 const job=await openJob(jobRoot,{spec:{id:'pipeline_generated_fixture',export:{playback:'tree'}},maxStageBytes:config.limits.maxStageBytes,maxStorageBytes:config.limits.maxStorageBytes});
 try{await job.run([{id:'rig',run:async({stagingDir})=>{
  const project=path.join(stagingDir,'project');await fs.mkdir(project);
  for(const e of await fs.readdir(source,{withFileTypes:true})){if(e.isFile()&&/\.(gd|tscn|tres|res|png|godot)$/.test(e.name))await fs.copyFile(path.join(source,e.name),path.join(project,e.name));}
  const validation=JSON.parse(await fs.readFile(path.join(source,'validation.json')));assert.equal(validation.valid,true);
  await fs.writeFile(path.join(stagingDir,'rig.json'),JSON.stringify({project:'project',scene:'project/character.tscn',validation}));
 }}]);}finally{await job.close();}
 const exported=await require('../../lib/delivery').exportCharacter(jobRoot,{config,namespace:'pipeline_generated_fixture',integration:{namespace:'GeneratedFixture',className:'Presentation',bounds:{x:0,y:0,width:16,height:16}}},{resumeCharacter:async()=>({status:'completed',valid:true,manifest:await inspectJob(jobRoot)})});
 assert.equal(exported.nativeExportStatus,'pack-created');
 await fs.copyFile(path.join(__dirname,'PackagedModInitializer.cs'),path.join(inputs,'PackagedModInitializer.cs'));
 const refs={};for(const name of ['sts2','0Harmony','BaseLib','Steamworks.NET']){refs[name]=path.join(inputs,name+'.dll');await fs.copyFile(name==='BaseLib'?path.join(base,name+'.dll'):path.join(game,name+'.dll'),refs[name]);}
 await fs.copyFile(path.join(base,'BaseLib.json'),path.join(inputs,'BaseLib.json'));
 const request={version:1,profile:'sts2-godot451-net9',mod:{id:'pipeline_generated_fixture',name:'Owned numeric packaged fixture',author:'Pipeline test',description:'Normal CLI packaging contract',version:'1.0.0',affectsGameplay:false},sources:[{name:'PackagedModInitializer.cs',path:path.join(inputs,'PackagedModInitializer.cs'),initializer:true}],references:refs,baseLibManifest:path.join(inputs,'BaseLib.json'),expectedBaseLibVersion:'3.4.7'};
 const configFile=path.join(out,'config.json'),requestFile=path.join(out,'request.json');await fs.writeFile(configFile,JSON.stringify(config));await fs.writeFile(requestFile,JSON.stringify(request));
 const cli=require('../../cli');
 async function invoke(label){let stdout='';const original=process.stdout.write;process.stdout.write=function(chunk,...args){stdout+=chunk.toString();return true;};let code;try{code=await cli.main(['package',jobRoot,'--request',requestFile,'--config',configFile]);}finally{process.stdout.write=original;}await fs.writeFile(path.join(out,label+'.json'),stdout);assert.equal(code,0,stdout);const parsed=JSON.parse(stdout);assert.equal(parsed.ok,true,stdout);return parsed.result;}
 const packaged=await invoke('package-first');assert.equal(packaged.status,'packaged');
 const inventory=(await fs.readdir(packaged.runtime)).sort();assert.deepEqual(inventory,['pipeline_generated_fixture.dll','pipeline_generated_fixture.json','pipeline_generated_fixture.pck']);
 const before=await Promise.all(inventory.map(async n=>[n,hash(await fs.readFile(path.join(packaged.runtime,n)))]));
 await fs.rename(inputs,inputs+'-source-denied');
 // Normal CLI reuse must not capture originals, inspect SDK/tool bytes or launch a build.
 const api=require('../../lib/mod-package-request'),builder=require('../../lib/mod-package-build'),saved=[api.captureModPackageRequest,api.revalidateModPackageTools,builder.buildModAssembly];
 const denied=()=>{throw Error('Cached reuse attempted unavailable original inputs/tool/SDK');};api.captureModPackageRequest=denied;api.revalidateModPackageTools=denied;builder.buildModAssembly=denied;
 let cached;try{cached=await invoke('package-cached');}finally{[api.captureModPackageRequest,api.revalidateModPackageTools,builder.buildModAssembly]=saved;}
 assert.equal(cached.stageId,packaged.stageId);assert.deepEqual(await Promise.all(inventory.map(async n=>[n,hash(await fs.readFile(path.join(cached.runtime,n)))])),before);
 for(const n of inventory)await fs.copyFile(path.join(packaged.runtime,n),path.join(owned,'packaged',n));
 for(const n of ['BaseLib.dll','BaseLib.json','BaseLib.pck'])await fs.copyFile(path.join(base,n),path.join(owned,'BaseLib',n));
 const receipts=[];for(const folder of ['BaseLib','packaged'])for(const n of await fs.readdir(path.join(owned,folder))){const bytes=await fs.readFile(path.join(owned,folder,n));receipts.push({Path:folder+'/'+n,Size:bytes.length,Hash:hash(bytes)});}assert.equal(receipts.length,6);await fs.writeFile(path.join(runtime,'receipts.json'),JSON.stringify(receipts));
 for(const n of ['PackagedModLoaderHarness.cs','OwnedModDiscoveryFileIo.cs'])await fs.copyFile(path.join(__dirname,n),path.join(runtime,n));
 const xml=v=>v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
 const referenceXml=['sts2','0Harmony','Steamworks.NET','BaseLib'].map(n=>`<Reference Include="${n}"><HintPath>${xml(n==='BaseLib'?path.join(base,n+'.dll'):path.join(game,n+'.dll'))}</HintPath><Private>true</Private></Reference>`).join('');
 await fs.writeFile(path.join(runtime,'PackagedModLoaderHarness.csproj'),`<Project Sdk="Godot.NET.Sdk/4.5.1"><PropertyGroup><TargetFramework>net9.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup><ItemGroup>${referenceXml}</ItemGroup></Project>`);
 await fs.writeFile(path.join(runtime,'NuGet.Config'),'<configuration><packageSources><clear /></packageSources></configuration>');await fs.writeFile(path.join(runtime,'global.json'),JSON.stringify({sdk:{version:'10.0.400',rollForward:'disable'}}));
 const token='CharacterPipelineIsolation_'+crypto.randomUUID().replaceAll('-','');await fs.writeFile(path.join(runtime,'project.godot'),`config_version=5\n[application]\nconfig/name="${token}"\nconfig/use_custom_user_dir=true\nconfig/custom_user_dir_name="${token}"\nrun/main_scene="res://main.tscn"\n[dotnet]\nproject/assembly_name="PackagedModLoaderHarness"\n[sentry]\noptions/auto_init=false\nconfig/dsn=""\n`);await fs.writeFile(path.join(runtime,'main.tscn'),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://PackagedModLoaderHarness.cs" id="1"]\n[node name="Harness" type="Node"]\nscript=ExtResource("1")\n');
 const runtimeRoot=path.join(out,'runtime-root');for(const parts of [['host','fxr'],['shared','Microsoft.NETCore.App']]){const target=path.join(runtimeRoot,...parts);await fs.mkdir(target,{recursive:true});await fs.symlink(path.join('C:/Program Files/dotnet',...parts,'9.0.18'),path.join(target,'9.0.18'),'junction');}
 const tools={dotnet:config.tools.dotnet,native:{...config.tools.megadot,dotnetRoot:runtimeRoot}};
 const build=await runTool(tools,'dotnet',['build',path.join(runtime,'PackagedModLoaderHarness.csproj'),'--configfile',path.join(runtime,'NuGet.Config'),'--disable-build-servers'],{timeoutMs:60000});await fs.writeFile(path.join(out,'harness-build.json'),JSON.stringify(build,null,2));assert.equal(build.error,null,build.stdout+build.stderr);
 const result=await runTool(tools,'native',['--headless','--path',runtime,'--force-steam=off','--log-file',path.join(out,'engine.log')],{timeoutMs:30000});await fs.writeFile(path.join(out,'process.json'),JSON.stringify(result,null,2));assert.equal(result.error,null,result.stdout+result.stderr);assert(!/SCRIPT ERROR|ERROR:/.test(result.stdout+result.stderr),result.stdout+result.stderr);
 const report=JSON.parse(await fs.readFile(path.join(runtime,'result.json')));assert.equal(report.passed,true);assert(report.checks>=25);
 const proof={...report,normalCliPackage:true,cachedSourceDenied:true,cachedBuildDenied:true,exactRuntimeFiles:inventory,distributionBytes:packaged.totalBytes,distributionHashes:before,ownedDiscoveryFiles:receipts,gameAcceptance:false};await fs.writeFile(path.join(out,'result.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}
if(require.main===module&&process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
