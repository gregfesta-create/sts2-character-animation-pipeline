using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using Godot;
using MegaCrit.Sts2.Core.Modding;
using MegaCrit.Sts2.Core.TestSupport;
using MegaCrit.Sts2.Core.Platform.Steam;
public partial class GeneratedModLoaderHarness : Node
{
 private int checks;
 private void Check(bool value,string message){if(!value)throw new Exception(message);checks++;}
 private static bool SentryEnabled()=> (bool)Type.GetType("Sentry.SentrySdk, Sentry",true)!.GetProperty("IsEnabled")!.GetValue(null)!;
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
  string DigestUser()=>Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(string.Join("\n",Directory.EnumerateFiles(user,"*",SearchOption.AllDirectories).Where(p=>!p.Contains(Path.DirectorySeparatorChar+"logs"+Path.DirectorySeparatorChar)).Order().Select(p=>Path.GetRelativePath(user,p)+":"+Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(p))))))));
  var before=DigestUser();
  var settings=new ModSettings{PlayerAgreedToModLoading=true,ModList=new(){new SettingsSaveMod{Id="pipeline_generated_fixture",Source=ModSource.ModsDirectory,IsEnabled=true}}};
  await ModManager.Initialize(guard,settings,null);
  Check(ModManager.State==ModManagerState.Initialized,"Loader initialized");
  Check(ModManager.Mods.Count==1&&ModManager.GetLoadedMods().Count()==1,"Exactly one mod");
  var mod=ModManager.Mods.Single();Check(mod.state==ModLoadState.Loaded&&mod.errors==null,"Mod loaded without errors");
  Check(mod.manifest?.id=="pipeline_generated_fixture"&&Path.GetFullPath(mod.path)==Path.GetFullPath(owned),"Owned fixture identity");
  var assembly=mod.assemblies.Single();Check(Path.GetFullPath(assembly.Location)==Path.GetFullPath(Path.Combine(owned,"pipeline_generated_fixture.dll")),"Actual owned assembly");
  var type=assembly.GetType("GeneratedModInitializer",true)!;
  Check((bool)type.GetField("Initialized")!.GetValue(null)!,"Actual initializer observed");
  Check((bool)type.GetField("MountedBeforeInitializer")!.GetValue(null)!,"PCK mounted before initializer");
  Check((bool)type.GetField("SceneFreed")!.GetValue(null)!,"Owned scene freed");
  foreach(var field in new[]{"FactoryReceipt","PrimaryTree","BaseLibAnimation","PreparedPanel"})Check((bool)type.GetField(field)!.GetValue(null)!,"Generated integration contract: "+field);
  Check(!ModManager.UnmoddedSavesWereCopied,"No save copy");
  Check(settings.ModList.Count==1&&settings.ModList[0].Id=="pipeline_generated_fixture","Only fixture in memory settings");
  Check(TestMode.IsOff&&!SteamInitializer.Initialized,"Steam and TestMode remain off");
  Check(GetTree().Root.GetChildCount()==1&&ProjectSettings.GetSetting("application/config/name").AsString()==projectName,"Fixture tree and project settings preserved");
  Check(!ProjectSettings.GetSetting("sentry/options/auto_init").AsBool()&&ProjectSettings.GetSetting("sentry/config/dsn").AsString()=="","Sentry settings remain disabled");
  Check(!SentryEnabled(),"Actual Sentry SDK remains disabled after loader");
  Check(before==DigestUser(),"User files unchanged excluding engine logs");
  File.WriteAllText(Path.Combine(root,"result.json"),JsonSerializer.Serialize(new{passed=true,checks,actualModLoader=true,actualDll=true,actualPck=true,generatedFactory=true,baseLibAnimation=true,gameStartup=false,gameAcceptance=false,testMode=false,steam=false,saveCopy=false,userFilesUnchanged=true,runtime=System.Environment.Version.ToString()}));GetTree().Quit();
 }catch(Exception error){GD.PrintErr(error);GetTree().Quit(1);}}
}



