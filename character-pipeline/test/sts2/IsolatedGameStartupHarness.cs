using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Text.Json;
using Godot;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using HarmonyLib;
using MegaCrit.Sts2.Core.Nodes;
using MegaCrit.Sts2.Core.Modding;
using MegaCrit.Sts2.Core.Saves;
using MegaCrit.Sts2.Core.Platform.Steam;
using MegaCrit.Sts2.Core.TestSupport;
using MegaCrit.Sts2.Core.Assets;

// Opt-in empty-mod startup proof. This fixture is not game or combat acceptance.
public partial class IsolatedGameStartupHarness : Node {
 record BinaryReceipt(string name,long bytes,string sha256);
 List<FileStream> binaryLocks=new();
 void VerifyBinaryIdentity(){
 var root=ProjectSettings.GlobalizePath("res://");var receipts=JsonSerializer.Deserialize<BinaryReceipt[]>(File.ReadAllText(Path.Combine(root,"binary-receipts.json")))!;
 foreach(var receipt in receipts){
 var native=receipt.name!="sts2.dll";var file=Path.GetFullPath(Path.Combine(root,native?"native":".godot/mono/temp/bin/Debug",receipt.name));
 var held=new FileStream(file,FileMode.Open,System.IO.FileAccess.Read,FileShare.Read);binaryLocks.Add(held);
 Check(held.Length==receipt.bytes&&Convert.ToHexString(SHA256.HashData(held)).Equals(receipt.sha256,StringComparison.OrdinalIgnoreCase),"Native receipt hash mismatch: "+receipt.name);
 if(native){using var process=Process.GetCurrentProcess();var matches=process.Modules.Cast<ProcessModule>().Where(m=>m.ModuleName.Equals(receipt.name,StringComparison.OrdinalIgnoreCase)).ToArray();Check(matches.Length==1&&Path.GetFullPath(matches[0].FileName).Equals(file,StringComparison.OrdinalIgnoreCase),"Loaded native module has exact owned path: "+receipt.name);}
 else{held.Position=0;using var pe=new PEReader(held,PEStreamOptions.LeaveOpen);var metadata=pe.GetMetadataReader();Check(typeof(NGame).Assembly.ManifestModule.ModuleVersionId==metadata.GetGuid(metadata.GetModuleDefinition().Mvid),"Actual sts2 managed MVID matches copied installed binary");}
 }
 }

 static IsolatedGameStartupHarness? active;
 int checks, prefixInvocations; bool entered, finished;
 string user="", token="", configName=""; string[] savePaths=Array.Empty<string>();
 OwnedModDiscoveryFileIo? discovery; FileStream? gamePack; Harmony? harmony; NGame? game;
 const string HarmonyId="CharacterPipeline.IsolatedEmptyStartup";
 void Check(bool condition,string message){if(!condition)throw new Exception(message);checks++;}
 bool SentryEnabled()=>(bool)Type.GetType("Sentry.SentrySdk, Sentry",true)!.GetProperty("IsEnabled")!.GetValue(null)!;
 void GuardIsolation(){
  Check(Path.GetFullPath(OS.GetUserDataDir()).TrimEnd(Path.DirectorySeparatorChar)==user&&ProjectSettings.GetSetting("application/config/name").AsString()==configName,"Unique user root preserved");
  Check(!SteamInitializer.Initialized&&!TestMode.IsOn&&!SentryEnabled(),"Steam, TestMode and Sentry remain off");
  Check(!ProjectSettings.GetSetting("sentry/options/auto_init").AsBool()&&ProjectSettings.GetSetting("sentry/config/dsn").AsString()=="","Explicit telemetry settings preserved");
 }
 string OwnedPath(string path){
  Check(path.StartsWith("user://",StringComparison.Ordinal),"Save and migration paths use user scheme");
  var full=Path.GetFullPath(ProjectSettings.GlobalizePath(path));
  Check(full.Equals(user,StringComparison.OrdinalIgnoreCase)||full.StartsWith(user+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase),"Save and migration path confined to unique user root");
  return full;
 }
 void InspectMigrationPaths(){
  // These are all roots used by AccountScopeUserDataMigrator, ProfileAccountScopeMigrator
  // and the default local SaveManager. MigrationUtil only appends fixed child names.
  savePaths=new[]{"user://",UserDataPathProvider.GetAccountScopedBasePath(""),UserDataPathProvider.GetProfileScopedBasePath(1),UserDataPathProvider.GetAccountScopedBasePath("saves"),UserDataPathProvider.GetAccountScopedBasePath("replays"),UserDataPathProvider.GetLegacyPreAccountPath("console_history.log")}.Select(OwnedPath).ToArray();
 }
 void LoadHeadlessInputAndAudioPrerequisites(){
  // Read only action names from the actual mounted ECFG. No serialized objects,
  // autoloads, telemetry, or application settings are decoded or applied.
  var bytes=Godot.FileAccess.GetFileAsBytes("res://project.binary");
  Check(bytes.Length>=8&&bytes.Length<=4*1024*1024,"Bounded actual packed project configuration");
  using var reader=new BinaryReader(new MemoryStream(bytes));
  Check(reader.ReadUInt32()==0x47464345,"Actual ECFG header");
  var count=reader.ReadUInt32();Check(count<=10000,"Bounded packed setting count");int actions=0;
  for(int i=0;i<count;i++){
   var length=reader.ReadUInt32();Check(length>0&&length<=4096&&length<=reader.BaseStream.Length-reader.BaseStream.Position,"Bounded packed key");
   var key=System.Text.Encoding.UTF8.GetString(reader.ReadBytes((int)length));
   var valueLength=reader.ReadUInt32();Check(valueLength<=1024*1024&&valueLength<=reader.BaseStream.Length-reader.BaseStream.Position,"Bounded packed value");
   reader.BaseStream.Seek(valueLength,SeekOrigin.Current);
   if(key.StartsWith("input/",StringComparison.Ordinal)){
    var action=key.Substring(6);Check(action.Length>0&&action.Length<=128&&!action.Contains('/'),"Actual action name");
    if(!InputMap.HasAction(action))InputMap.AddAction(action);actions++;
   }
  }
  Check(reader.BaseStream.Position==reader.BaseStream.Length&&actions>=30,"Only declared actual input action names registered for input-free headless fixture");
  var buses=ResourceLoader.Load<AudioBusLayout>("res://default_bus_layout.tres");Check(buses!=null,"Actual default audio buses loaded");AudioServer.SetBusLayout(buses!);
 }
 void ReleaseOwnPrewarmedPools(){
  // The actual startup prewarms detached nodes. There is no public shutdown API;
  // release only the two known pools created in this otherwise fresh process.
  var type=typeof(NGame).Assembly.GetType("MegaCrit.Sts2.Core.Nodes.Pooling.NodePool",true)!;
  var pools=(System.Collections.IDictionary)type.GetField("_pools",BindingFlags.Static|BindingFlags.NonPublic)!.GetValue(null)!;
  Check(pools.Count==2,"Only the two real startup pools exist");
  foreach(System.Collections.DictionaryEntry entry in pools){
   Check(new[]{"MegaCrit.Sts2.Core.Nodes.Cards.NCard","MegaCrit.Sts2.Core.Nodes.Cards.Holders.NGridCardHolder"}.Contains(((Type)entry.Key).FullName),"Known fixture-created startup pool");
   var pool=entry.Value!;var used=pool.GetType().GetField("_usedObjects",BindingFlags.Instance|BindingFlags.NonPublic)!.GetValue(pool)!;
   Check((int)used.GetType().GetProperty("Count")!.GetValue(used)! == 0,"No live pool objects during teardown");
   var free=(System.Collections.IEnumerable)pool.GetType().GetProperty("DebugFreeObjects")!.GetValue(pool)!;
   foreach(Node node in free){Check(node.GetParent()==null&&!node.IsInsideTree(),"Only detached prewarmed pool nodes released");node.Free();}
  }
  pools.Clear();
 }
 static void DiscoveryPrefix(ref IModManagerFileIo fileIo){
  var self=active??throw new Exception("Missing startup guard");
  self.Check(self.entered&&self.prefixInvocations==0,"Exactly one real startup discovery invocation");
  self.Check(fileIo.GetType()==typeof(ModManagerFileIo),"Actual startup supplied native ModManagerFileIo");
  // Async state-machine caller retains its original declaring type in the stack.
  self.Check(new StackTrace().GetFrames().Any(f=>f.GetMethod()?.DeclaringType?.FullName?.Contains("OneTimeInitialization",StringComparison.Ordinal)==true),"Actual VeryEarly startup called mod discovery");
  self.GuardIsolation();self.InspectMigrationPaths();
  fileIo=self.discovery??throw new Exception("Discovery receipt lifetime ended");self.prefixInvocations++;
 }
 public override async void _Ready(){try{
  VerifyBinaryIdentity();active=this;user=Path.GetFullPath(OS.GetUserDataDir()).TrimEnd(Path.DirectorySeparatorChar);configName=ProjectSettings.GetSetting("application/config/name").AsString();token=Path.GetFileName(user);
  Check(configName==token&&System.Text.RegularExpressions.Regex.IsMatch(token,"^CharacterPipelineIsolation_[a-f0-9]{32}$"),"Owned unique project and user directory");
  Check(NGame.Instance==null&&GetTree().Root.GetChildCount()==1,"No game started before guard");GuardIsolation();InspectMigrationPaths();
  Check(Engine.GetSingleton("ProjectSettings").GetPropertyList().All(p=>!p["name"].AsString().StartsWith("autoload/",StringComparison.Ordinal)),"No game autoloads");
  Check(!ProjectSettings.GetSetting("Fmod/General/is_live_update_enabled").AsBool(),"Native live update disabled");
  var owned=ProjectSettings.GlobalizePath("res://empty-mods");Directory.CreateDirectory(owned);
  discovery=new OwnedModDiscoveryFileIo(owned,Path.GetDirectoryName(OS.GetExecutablePath())!,user,token,Array.Empty<OwnedModDiscoveryFileIo.Receipt>());
  harmony=new Harmony(HarmonyId);var method=AccessTools.Method(typeof(ModManager),nameof(ModManager.Initialize));
  harmony.Patch(method,prefix:new HarmonyMethod(typeof(IsolatedGameStartupHarness),nameof(DiscoveryPrefix)));
  Check(Harmony.GetPatchInfo(method)?.Prefixes.Count(p=>p.owner==HarmonyId)==1,"Own discovery prefix proven installed before NGame entry");
  IModManagerFileIo probe=new ModManagerFileIo();bool rejected=false;
  try{DiscoveryPrefix(ref probe);}catch(Exception){rejected=true;}
  Check(rejected&&prefixInvocations==0&&probe is ModManagerFileIo,"Controlled premature discovery call refused before any game discovery");
  gamePack=new FileStream("C:/Program Files (x86)/Steam/steamapps/common/Slay the Spire 2/SlayTheSpire2.pck",FileMode.Open,System.IO.FileAccess.Read,FileShare.Read);
  Check(ProjectSettings.LoadResourcePack(gamePack.Name,false),"Read locked game pack mounted");
  LoadHeadlessInputAndAudioPrerequisites();
  typeof(Godot.Bridge.ScriptManagerBridge).GetMethod("LookupScriptsInAssembly",BindingFlags.Static|BindingFlags.Public|BindingFlags.NonPublic)!.Invoke(null,new object[]{typeof(NGame).Assembly});
  Check(ClassDB.ClassExists("FmodEventEmitter2D")&&ClassDB.ClassExists("SpineSprite"),"Actual native scene prerequisites loaded");GuardIsolation();
  // Explicit fixture-only documented iteration option; default preloading stays
  // enabled unless the caller requests this diagnostic mode.
  if(OS.GetCmdlineUserArgs().Contains("--iteration-no-preload"))PreloadManager.Enabled=false;
  game=ResourceLoader.Load<PackedScene>("res://scenes/game.tscn").Instantiate<NGame>();
  // This timer exists independently of game startup completion (which also resolves on failure).
  GetTree().CreateTimer(45).Timeout+=()=>{if(!finished)Finish(new Exception("Actual main menu startup exceeded 45 seconds"));};
  entered=true;AddChild(game);
  while(!game.GameStartupComplete.IsCompleted&&!finished)await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
  if(finished)return;
  Check(game.GameStartupComplete.IsCompletedSuccessfully,"Game startup completion task succeeded");
  Check(game.MainMenu!=null&&game.MainMenu.IsInsideTree()&&game.MainMenu.IsNodeReady(),"Actual main menu is ready in tree");
  Check(prefixInvocations==1&&ModManager.State==ModManagerState.Initialized&&ModManager.Mods.Count==0,"Actual startup initialized exactly empty owned mod discovery");
  GuardIsolation();InspectMigrationPaths();
  Check(SaveManager.Instance.IsProfileInitialized,"Real game initialized isolated profile");OwnedPath(SaveManager.Instance.GetProfileScopedPath("saves"));
  // Observe the actual asset loader going idle rather than guessing a startup delay.
  while(NAssetLoader.Instance.IsProcessing()&&!finished)await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
  if(finished)return;Check(!NAssetLoader.Instance.IsProcessing(),"Actual background asset loader idle before teardown");
  Finish(null);
 }catch(Exception error){Finish(error);}}
 async void Finish(Exception? error){
  if(finished)return;finished=true;
  bool menuReady=game!=null&&GodotObject.IsInstanceValid(game)&&game.MainMenu!=null&&game.MainMenu.IsInsideTree()&&game.MainMenu.IsNodeReady();
  try{
   if(game!=null&&GodotObject.IsInstanceValid(game)){
    var environment=(Node?)typeof(NGame).GetProperty("WorldEnvironment",BindingFlags.Instance|BindingFlags.Public|BindingFlags.NonPublic)!.GetValue(game);var retiring=game;retiring.QueueFree();
    await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
    Check(!GodotObject.IsInstanceValid(retiring),"Actual game freed before releasing discovery and pack locks");game=null;
    if(environment!=null&&GodotObject.IsInstanceValid(environment)&&environment.GetParent()==null)environment.Free();
   }
   ReleaseOwnPrewarmedPools();PreloadManager.Cache.UnloadAssets(PreloadManager.Cache.GetLoadedCacheAssets().ToArray());PreloadManager.Cache.UnloadMissedCacheAssets();AtlasManager.Clear();
   for(int i=0;i<3;i++)await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
   GC.Collect();GC.WaitForPendingFinalizers();GC.Collect();
   for(int i=0;i<3;i++)await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
   GuardIsolation();
  }
  catch(Exception cleanup){error??=cleanup;}
  finally{foreach(var held in binaryLocks)held.Dispose();gamePack?.Dispose();discovery?.Dispose();harmony?.UnpatchAll(HarmonyId);active=null;}
  File.WriteAllText(ProjectSettings.GlobalizePath("res://result.json"),JsonSerializer.Serialize(new{passed=error==null,checks,actualMainMenuReady=menuReady,gameStartup=error==null,gameAcceptance=false,combatAcceptance=false,preloadEnabled=PreloadManager.Enabled,prefixInvocations,emptyMods=true,userRoot=user,savePaths,sentry=SentryEnabled(),steam=SteamInitializer.Initialized,testMode=TestMode.IsOn,error=error?.ToString()}));
  if(error!=null)GD.PrintErr(error);GetTree().Quit(error==null?0:1);
 }
}





