using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Diagnostics;
using System.Collections.Generic;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Godot;
using MegaCrit.Sts2.Core.Nodes;
using MegaCrit.Sts2.Core.Platform.Steam;
public partial class GameScenePrerequisiteHarness : Node {
 int checks; void Check(bool x,string message){if(!x)throw new Exception(message);checks++;}
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
 string UserDigest(string user)=>Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("\n",Directory.EnumerateFiles(user,"*",SearchOption.AllDirectories).Where(p=>!p.Contains(Path.DirectorySeparatorChar+"logs"+Path.DirectorySeparatorChar)).Order().Select(p=>Path.GetRelativePath(user,p)+":"+Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(p))))))));
 string Autoloads()=>string.Join("\n",Engine.GetSingleton("ProjectSettings").GetPropertyList().Select(p=>p["name"].AsString()).Where(p=>p.StartsWith("autoload/")).Order().Select(p=>p+":"+ProjectSettings.GetSetting(p).AsString()));
 bool SentryEnabled()=>(bool)Type.GetType("Sentry.SentrySdk, Sentry",true)!.GetProperty("IsEnabled")!.GetValue(null)!;
 public override void _Ready(){try{
 VerifyBinaryIdentity();
 var name=ProjectSettings.GetSetting("application/config/name").AsString();var main=ProjectSettings.GetSetting("application/run/main_scene").AsString();var user=OS.GetUserDataDir();
 var beforeUser=UserDigest(user);var beforeAutoloads=Autoloads();Check(beforeAutoloads=="","No game autoload settings");Check(!ProjectSettings.GetSetting("Fmod/General/is_live_update_enabled").AsBool(),"FMOD live update explicitly disabled");
 Check(name.StartsWith("CharacterPipelineIsolation_")&&user.EndsWith(name),"Owned unique user directory");
 Check(!SentryEnabled()&&!ProjectSettings.GetSetting("sentry/options/auto_init").AsBool()&&ProjectSettings.GetSetting("sentry/config/dsn").AsString()=="","Sentry disabled");
 Check(NGame.Instance==null&&!SteamInitializer.Initialized&&GetTree().Root.GetChildCount()==1,"No game startup");
 
 foreach(var id in new[]{"fmod","spine"}) Check(GDExtensionManager.IsExtensionLoaded("res://"+id+".gdextension"),"Installed native extension loaded before scene "+id);
 var pack="C:/Program Files (x86)/Steam/steamapps/common/Slay the Spire 2/SlayTheSpire2.pck";using var held=new FileStream(pack,FileMode.Open,System.IO.FileAccess.Read,FileShare.Read);var size=held.Length;
 Check(ProjectSettings.LoadResourcePack(pack,false),"Mount actual read locked game pack");
 Check(ClassDB.ClassExists("FmodEventEmitter2D")&&ClassDB.ClassExists("SpineSprite"),"Native scene prerequisites registered");
 var lookup=typeof(Godot.Bridge.ScriptManagerBridge).GetMethod("LookupScriptsInAssembly",BindingFlags.Static|BindingFlags.Public|BindingFlags.NonPublic);Check(lookup!=null,"Actual script registration bridge exists");lookup!.Invoke(null,new object[]{typeof(NGame).Assembly});
 var scene=ResourceLoader.Load<PackedScene>("res://scenes/game.tscn");Check(scene!=null,"Actual game scene loaded");var node=scene!.Instantiate();try{Check(node is NGame&&node.GetParent()==null&&!node.IsInsideTree(),"Actual NGame detached");}finally{node.Free();}
 Check(NGame.Instance==null&&!SteamInitializer.Initialized&&GetTree().Root.GetChildCount()==1,"No game startup after free");
 Check(!SentryEnabled()&&ProjectSettings.GetSetting("application/config/name").AsString()==name&&ProjectSettings.GetSetting("application/run/main_scene").AsString()==main&&OS.GetUserDataDir()==user,"Isolation settings preserved");Check(held.Length==size,"Pack unchanged");
 Check(beforeAutoloads==Autoloads()&&beforeUser==UserDigest(user),"Autoloads and user files unchanged excluding logs");Check(!ProjectSettings.GetSetting("sentry/options/auto_init").AsBool()&&ProjectSettings.GetSetting("sentry/config/dsn").AsString()==""&&!ProjectSettings.GetSetting("Fmod/General/is_live_update_enabled").AsBool(),"Telemetry and live update remain disabled");
 File.WriteAllText(ProjectSettings.GlobalizePath("res://result.json"),JsonSerializer.Serialize(new{passed=true,checks,detachedActualGame=true,gameStartup=false,gameAcceptance=false,sentry=false}));GetTree().Quit();
 }catch(Exception e){GD.PrintErr(e);GetTree().Quit(1);}finally{foreach(var held in binaryLocks)held.Dispose();}}
}




