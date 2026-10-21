using System;
using System.IO;
using System.Text.Json;
using System.Linq;
using System.Security.Cryptography;
using Godot;
using MegaCrit.Sts2.Core.Modding;
using MegaCrit.Sts2.Core.TestSupport;
using MegaCrit.Sts2.Core.Platform.Steam;
public partial class EmptyModLoaderHarness : Node
{
 private int checks;
 private void Check(bool value,string label){if(!value)throw new Exception(label);checks++;}
 private static string UserSnapshot()=>string.Join("|",Directory.GetFiles(OS.GetUserDataDir(),"*",SearchOption.AllDirectories).OrderBy(p=>p,StringComparer.Ordinal).Select(p=>p+":"+Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(p)))));
 private void VerifyIsolation(){
  Check(TestMode.IsOff,"real game mode");Check(!SteamInitializer.Initialized,"Steam never initialized");
  var token=ProjectSettings.GetSetting("application/config/name").AsString();
  Check(token.StartsWith("CharacterPipelineIsolation_",StringComparison.Ordinal),"unique project identity");
  Check(Path.GetFileName(OS.GetUserDataDir())==token,"owned custom user root");
  Check(GetTree().Root.GetChildCount()==1&&GetTree().Root.GetChild(0)==this,"only fixture scene no game autoloads");
  Check(System.Environment.Version.Major==9,"actual dotnet nine runtime");
 }
 public override async void _Ready(){try{
  VerifyIsolation();
  var root=ProjectSettings.GlobalizePath("res://");var owned=Path.Combine(root,"empty-mods");Directory.CreateDirectory(owned);
  using var io=new OwnedModDiscoveryFileIo(owned,Path.GetDirectoryName(OS.GetExecutablePath())!,OS.GetUserDataDir(),ProjectSettings.GetSetting("application/config/name").AsString(),Array.Empty<OwnedModDiscoveryFileIo.Receipt>());
  Check(ModManager.State==ModManagerState.None,"fresh loader");Check(ModManager.Mods.Count==0,"no prior mods");
  var userBefore=UserSnapshot();
  await ModManager.Initialize(io,null,null);
  Check(UserSnapshot()==userBefore,"owned user files unchanged by actual loader");
  Check(ModManager.State==ModManagerState.Initialized,"actual loader initialized");Check(ModManager.Mods.Count==0,"empty receipts no mods");Check(!ModManager.UnmoddedSavesWereCopied,"no saves copied");Check(!ModManager.PlayerAgreedToModLoading,"no settings consent invented");
  VerifyIsolation();
  Check(Directory.GetFileSystemEntries(owned).Length==0,"owned discovery remains empty");
  try{io.FileExists(Path.Combine(root,"unknown.dll"));throw new Exception("Unknown path accepted");}catch(UnauthorizedAccessException){checks++;}
  File.WriteAllText(Path.Combine(root,"result.json"),JsonSerializer.Serialize(new{passed=true,checks,gameStartup=false,modLoaderCalled=true,emptyReceipts=true,gameCombat=false,runtime=System.Environment.Version.ToString(),assembly=typeof(ModManager).Assembly.GetName().Name,userFilesUnchanged=true}));GetTree().Quit();
 }catch(Exception e){GD.PrintErr(e);GetTree().Quit(1);}}
}



