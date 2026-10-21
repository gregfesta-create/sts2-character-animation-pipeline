using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text.Json;
using Godot;
using MegaCrit.Sts2.Core.Modding;
using MegaCrit.Sts2.Core.TestSupport;
using MegaCrit.Sts2.Core.Platform.Steam;
public partial class PackagedModLoaderHarness : Node
{
 private int checks;
 private void Check(bool value,string message){if(!value)throw new Exception(message);checks++;}
 private static bool SentryEnabled()=> (bool)Type.GetType("Sentry.SentrySdk, Sentry",true)!.GetProperty("IsEnabled")!.GetValue(null)!;
 private static Dictionary<string,string> SnapshotUser(string user){
  user=Path.GetFullPath(user).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar);
  var result=new Dictionary<string,string>(StringComparer.Ordinal);long total=0;
  foreach(var file in Directory.EnumerateFiles(user,"*",SearchOption.AllDirectories)){
   var relative=Path.GetRelativePath(user,file).Replace('\\','/');if(relative.StartsWith("logs/",StringComparison.Ordinal))continue;
   for(var cursor=Path.GetFullPath(file);!cursor.Equals(user,StringComparison.OrdinalIgnoreCase);cursor=Path.GetDirectoryName(cursor)??throw new Exception("Private user path escaped")){if((File.GetAttributes(cursor)&FileAttributes.ReparsePoint)!=0)throw new Exception("Linked private user file");}
   var info=new FileInfo(file);if(info.Length>65536||result.Count>=64||(total+=info.Length)>1048576)throw new Exception("Private user fixture quota exceeded");
   result.Add(relative,Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))));
  }
  return result;
 }
 private static bool ExpectedBaseLibConfig(string file){
  const string expected="""
  {"ShowModConfigInMainMenu":"True","SfxPlayerLimit":"16","OpenLogWindowOnStartup":"False","OpenLogWindowOnError":"False","LimitedLogSize":"256","LogFontSize":"14","ModIdDisplayMode":"Id","ShowCardModSource":"False","ShowRelicModSource":"True","ShowPotionModSource":"True","ShowAncientModSource":"True","ShowEventModSource":"True","ShowMonsterModSource":"False","ShowCombatElementModSource":"False","HarmonyPatchDumpOutputPath":"","HarmonyPatchDumpOnFirstMainMenu":"False","LastLogLevel":"3","LogUseRegex":"False","LogInvertFilter":"False","LogLastFilter":"","LogLastSizeX":"0","LogLastSizeY":"0","LogLastPosX":"-2147483648","LogLastPosY":"-2147483648","LastModConfigModId":""}
  """;
  var wanted=JsonSerializer.Deserialize<Dictionary<string,string>>(expected)!;
  using var actual=JsonDocument.Parse(File.ReadAllBytes(file));
  return actual.RootElement.ValueKind==JsonValueKind.Object&&actual.RootElement.EnumerateObject().Count()==wanted.Count&&actual.RootElement.EnumerateObject().All(p=>p.Value.ValueKind==JsonValueKind.String&&wanted.TryGetValue(p.Name,out var value)&&value==p.Value.GetString());
 }
 public override async void _Ready(){try{
  var root=ProjectSettings.GlobalizePath("res://");var owned=Path.Combine(root,"owned");
  Check(TestMode.IsOff&&!SteamInitializer.Initialized,"Real loader, Steam off");
  Check(System.Environment.Version.Major==9,"Existing .NET 9 runtime");
  Check(OS.GetCmdlineArgs().Contains("--force-steam=off"),"Steam disabled argument");
  Check(GetTree().Root.GetChildCount()==1&&GetParent()==GetTree().Root,"Only isolated harness, no game autoloads");
  Check(!ProjectSettings.GetSetting("sentry/options/auto_init").AsBool()&&ProjectSettings.GetSetting("sentry/config/dsn").AsString()=="","Sentry explicitly disabled");
  Check(!SentryEnabled(),"Actual Sentry SDK disabled before loader");
  var projectName=ProjectSettings.GetSetting("application/config/name").AsString();
  Check(ModManager.Mods.Count==0,"Fresh loader");
  Check(!Godot.FileAccess.FileExists("res://pipeline_generated_fixture/character.tscn"),"Scene not mounted before loader");
  var receipts=JsonSerializer.Deserialize<OwnedModDiscoveryFileIo.Receipt[]>(File.ReadAllText(Path.Combine(root,"receipts.json")))!;
  using var guard=new OwnedModDiscoveryFileIo(owned,Path.GetDirectoryName(OS.GetExecutablePath())!,OS.GetUserDataDir(),ProjectSettings.GetSetting("application/config/name").AsString(),receipts);
  var user=OS.GetUserDataDir();
  var before=SnapshotUser(user);
  var settings=new ModSettings{PlayerAgreedToModLoading=true,ModList=new(){new SettingsSaveMod{Id="BaseLib",Source=ModSource.ModsDirectory,IsEnabled=true},new SettingsSaveMod{Id="pipeline_generated_fixture",Source=ModSource.ModsDirectory,IsEnabled=true}}};
  await ModManager.Initialize(guard,settings,null);
  Check(ModManager.State==ModManagerState.Initialized,"Loader initialized");
  Check(ModManager.Mods.Count==2&&ModManager.GetLoadedMods().Count()==2,"Exactly BaseLib and packaged mod");
  Check(receipts.Length==6,"Exactly six owned discovery receipts");
  var dependency=ModManager.Mods.Single(m=>m.manifest?.id=="BaseLib");
  Check(dependency.state==ModLoadState.Loaded&&dependency.errors==null,"Actual BaseLib dependency loaded without errors");
  Check(Path.GetFullPath(dependency.path)==Path.GetFullPath(Path.Combine(owned,"BaseLib")),"Separate owned dependency fixture");
  var mod=ModManager.Mods.Single(m=>m.manifest?.id=="pipeline_generated_fixture");Check(mod.state==ModLoadState.Loaded&&mod.errors==null,"Mod loaded without errors");
  Check(mod.manifest!.dependencies?.Count==1&&mod.manifest.dependencies[0].id=="BaseLib"&&mod.manifest.dependencies[0].minVersion=="3.4.7","Versioned BaseLib dependency resolves");
  Check(mod.manifest?.id=="pipeline_generated_fixture"&&Path.GetFullPath(mod.path)==Path.GetFullPath(Path.Combine(owned,"packaged")),"Owned fixture identity");
  var assembly=mod.assemblies.Single();Check(Path.GetFullPath(assembly.Location)==Path.GetFullPath(Path.Combine(owned,"packaged","pipeline_generated_fixture.dll")),"Actual owned assembly");
  var type=assembly.GetType("PackagedModInitializer",true)!;
  Check((bool)type.GetField("Initialized")!.GetValue(null)!,"Actual initializer observed");
  Check((bool)type.GetField("MountedBeforeInitializer")!.GetValue(null)!,"PCK mounted before initializer");
  Check((bool)type.GetField("SceneFreed")!.GetValue(null)!,"Owned scene freed");
  foreach(var field in new[]{"FactoryReceipt","PrimaryTree","BaseLibAnimation","PreparedPanel"})Check((bool)type.GetField(field)!.GetValue(null)!,"Generated integration contract: "+field);
  Check(!ModManager.UnmoddedSavesWereCopied,"No save copy");
  Check(settings.ModList.Count==2&&settings.ModList.Any(m=>m.Id=="BaseLib")&&settings.ModList.Any(m=>m.Id=="pipeline_generated_fixture"),"Only fixture in memory settings");
  Check(TestMode.IsOff&&!SteamInitializer.Initialized,"Steam and TestMode remain off");
  Check(GetTree().Root.GetChildCount()==1&&ProjectSettings.GetSetting("application/config/name").AsString()==projectName,"Fixture tree and project settings preserved");
  Check(!ProjectSettings.GetSetting("sentry/options/auto_init").AsBool()&&ProjectSettings.GetSetting("sentry/config/dsn").AsString()=="","Sentry settings remain disabled");
  Check(!SentryEnabled(),"Actual Sentry SDK remains disabled after loader");
  var after=SnapshotUser(user);var created=after.Where(p=>!before.ContainsKey(p.Key)).ToDictionary(p=>p.Key,p=>p.Value);
  File.WriteAllText(Path.Combine(root,"private-user-files.json"),JsonSerializer.Serialize(new{before,after,created}));
  Check(before.All(p=>after.TryGetValue(p.Key,out var value)&&value==p.Value),"Every preexisting private user file unchanged");
  Check(created.All(p=>p.Key=="mod_configs/BaseLib.cfg"&&ExpectedBaseLibConfig(Path.Combine(user,"mod_configs","BaseLib.cfg"))),"Only exact default BaseLib config may be created in private user directory");
  File.WriteAllText(Path.Combine(root,"result.json"),JsonSerializer.Serialize(new{passed=true,checks,actualModLoader=true,baseLibDependency=true,normalCliPackage=true,actualDll=true,actualPck=true,generatedFactory=true,baseLibAnimation=true,gameStartup=false,gameAcceptance=false,testMode=false,steam=false,saveCopy=false,preexistingUserFilesUnchanged=true,expectedPrivateUserFiles=created,runtime=System.Environment.Version.ToString()}));GetTree().Quit();
 }catch(Exception error){GD.PrintErr(error);GetTree().Quit(1);}}
}



