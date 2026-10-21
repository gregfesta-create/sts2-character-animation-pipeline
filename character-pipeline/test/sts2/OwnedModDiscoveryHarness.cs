using System;
using System.IO;
using System.Text;
using System.Security.Cryptography;
using System.Text.Json;
using Godot;
public partial class OwnedModDiscoveryHarness : Node
{
 private int checks;
 private void Check(bool value,string label){if(!value)throw new Exception(label);checks++;}
 private void Denied(Action action,string label){try{action();}catch(Exception){checks++;return;}throw new Exception("Expected denial: "+label);}
 private static OwnedModDiscoveryFileIo.Receipt Capture(string relative,string root){var bytes=File.ReadAllBytes(Path.Combine(root,relative));return new(relative,bytes.Length,Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());}
 public override void _Ready(){try{
  var workspace=ProjectSettings.GlobalizePath("res://");var owned=Path.GetFullPath(Path.Combine(workspace,"owned"));var outside=Path.Combine(workspace,"outside");Directory.CreateDirectory(owned);Directory.CreateDirectory(outside);
  var emptyParent=Path.Combine(workspace,"discovery-parent");var empty=Path.Combine(emptyParent,"empty-discovery");Directory.CreateDirectory(empty);
  using(var guard=new OwnedModDiscoveryFileIo(empty,Path.GetDirectoryName(OS.GetExecutablePath())!,OS.GetUserDataDir(),ProjectSettings.GetSetting("application/config/name").AsString(),Array.Empty<OwnedModDiscoveryFileIo.Receipt>())){
   Denied(()=>Directory.Move(empty,empty+"-moved"),"empty discovery directory held deny-rename");
   Denied(()=>Directory.Move(emptyParent,emptyParent+"-moved"),"discovery ancestor held deny-rename");
  }
  Directory.Move(empty,empty+"-moved");Directory.Move(empty+"-moved",empty);checks++;
  Directory.Move(emptyParent,emptyParent+"-moved");Directory.Move(emptyParent+"-moved",emptyParent);checks++;
  File.WriteAllText(Path.Combine(owned,"fixture.json"),"{\"id\":\"fixture\",\"has_dll\":true,\"has_pck\":true}");File.WriteAllText(Path.Combine(owned,"fixture.dll"),"dummy never loaded");File.WriteAllText(Path.Combine(owned,"fixture.pck"),"dummy never mounted");
  var receipts=new[]{Capture("fixture.json",owned),Capture("fixture.dll",owned),Capture("fixture.pck",owned)};var exe=Path.GetDirectoryName(OS.GetExecutablePath())!;var primary=Path.Combine(exe,"mods");var secondary=Path.Combine(exe,"mods_STEAMTEST");
  using(var io=new OwnedModDiscoveryFileIo(owned,exe,OS.GetUserDataDir(),ProjectSettings.GetSetting("application/config/name").AsString(),receipts)){
   Check(io.DirectoryExists(primary),"virtual primary exists");Check(!io.DirectoryExists(secondary),"secondary excluded");Check(io.GetFilesAt(secondary).Length==0,"secondary enumeration empty");
   var files=io.GetFilesAt(primary);Check(files.Length==3&&Array.TrueForAll(files,p=>Path.IsPathFullyQualified(p)&&p.StartsWith(owned+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)),"real absolute receipt enumeration");
   Check(io.GetDirectoriesAt(primary).Length==0,"no disk directory walk");Check(io.FileExists(Path.Combine(owned,"fixture.dll")),"declared DLL");
   using(var stream=io.OpenStream(Path.Combine(owned,"fixture.json"),Godot.FileAccess.ModeFlags.Read)){Check(stream.ReadByte()==123,"manifest readonly stream");}
   Denied(()=>io.FileExists(Path.Combine(outside,"secret")),"outside path");Denied(()=>io.OpenStream(Path.Combine(owned,"fixture.json"),Godot.FileAccess.ModeFlags.Write),"write mode");Denied(()=>io.MakeDirRecursive("user://new"),"mkdir");Denied(()=>io.CopyFile("user://a","user://b"),"copy");
   Denied(()=>File.WriteAllText(Path.Combine(owned,"fixture.dll"),"mutated"),"receipt held deny-write");Denied(()=>File.Delete(Path.Combine(owned,"fixture.pck")),"receipt held deny-delete");
   Denied(()=>Directory.Move(owned,owned+"-moved"),"owned directory held deny-rename");
   Denied(()=>io.FileExists(Path.Combine(owned,"..","owned","fixture.dll")),"noncanonical traversal");
  }
  File.WriteAllText(Path.Combine(owned,"fixture.dll"),"mutation after dispose succeeds");checks++;
  Directory.Move(owned,owned+"-moved");Directory.Move(owned+"-moved",owned);checks++;
  Denied(()=>new OwnedModDiscoveryFileIo(owned,exe,OS.GetUserDataDir(),ProjectSettings.GetSetting("application/config/name").AsString(),receipts),"hash mismatch");
  var raced=Path.Combine(owned,"raced.dll");var external=Path.Combine(outside,"matching.dll");File.WriteAllText(raced,"matching bytes");File.WriteAllText(external,"matching bytes");var racedReceipt=new[]{Capture("raced.dll",owned)};
  Denied(()=>{using var guard=new OwnedModDiscoveryFileIo(owned,exe,OS.GetUserDataDir(),ProjectSettings.GetSetting("application/config/name").AsString(),racedReceipt,filename=>{File.Delete(filename);File.CreateSymbolicLink(filename,external);});},"receipt swapped to external symlink between check and open");File.Delete(raced);
  File.WriteAllText(Path.Combine(owned,"fixture.json"),"{\"id\":\"../bad\"}");var bad=new[]{Capture("fixture.json",owned)};Denied(()=>new OwnedModDiscoveryFileIo(owned,exe,OS.GetUserDataDir(),ProjectSettings.GetSetting("application/config/name").AsString(),bad),"manifest id");
  var link=Path.Combine(owned,"linked");try{Directory.CreateSymbolicLink(link,outside);Denied(()=>new OwnedModDiscoveryFileIo(link,exe,OS.GetUserDataDir(),ProjectSettings.GetSetting("application/config/name").AsString(),Array.Empty<OwnedModDiscoveryFileIo.Receipt>()),"reparse root");}finally{if(Directory.Exists(link))Directory.Delete(link);}
  File.WriteAllText(Path.Combine(workspace,"result.json"),JsonSerializer.Serialize(new{passed=true,checks,gameStartup=false,modLoaderCalled=false,allWritesDenied=true}));GetTree().Quit();
 }catch(Exception error){GD.PrintErr(error);GetTree().Quit(1);}}
}

