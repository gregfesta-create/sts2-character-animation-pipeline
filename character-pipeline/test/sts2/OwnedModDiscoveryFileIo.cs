using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using Godot;
using MegaCrit.Sts2.Core.Modding;
// Test-only discovery prerequisite. This does not sandbox executable mod code.
public sealed class OwnedModDiscoveryFileIo : IModManagerFileIo, IDisposable
{
 public sealed record Receipt(string Path,long Size,string Hash);
 private readonly string owned,user,primary,secondary;
 private readonly Dictionary<string,FileStream> locked=new(StringComparer.OrdinalIgnoreCase);
 private readonly HashSet<string> directories=new(StringComparer.OrdinalIgnoreCase);
 private readonly Dictionary<string,SafeFileHandle> directoryLocks=new(StringComparer.OrdinalIgnoreCase);
 private bool disposed;
 private static Exception Denied()=>new UnauthorizedAccessException("Path or operation is outside immutable discovery receipts");
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 private static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,StringBuilder path,uint length,uint flags);
 private static void VerifyHandlePath(SafeFileHandle handle,string expected){
  var final=new StringBuilder(32768);var length=GetFinalPathNameByHandleW(handle,final,(uint)final.Capacity,0);
  if(length==0||length>=final.Capacity)throw Denied();
  var resolved=final.ToString();if(resolved.StartsWith(@"\\?\UNC\",StringComparison.Ordinal))resolved=@"\\"+resolved.Substring(8);else if(resolved.StartsWith(@"\\?\",StringComparison.Ordinal))resolved=resolved.Substring(4);
  if(!Canonical(resolved).Equals(Canonical(expected),StringComparison.OrdinalIgnoreCase))throw Denied();
  NoReparse(expected);
 }
 private void LockAncestors(string path){
  if(!OperatingSystem.IsWindows())throw Denied();
  for(string? cursor=path;!string.IsNullOrEmpty(cursor);cursor=System.IO.Path.GetDirectoryName(cursor)){
   var key=Canonical(cursor);if(directoryLocks.ContainsKey(key))continue;
   NoReparse(cursor);
   // Retain directories without FILE_SHARE_DELETE, including every ancestor.
   var handle=CreateFileW(cursor,0x80000000,3,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
   if(handle.IsInvalid){handle.Dispose();throw Denied();}
   try{
    VerifyHandlePath(handle,cursor);directoryLocks.Add(key,handle);
   }catch{handle.Dispose();throw;}
  }
 }
 private static string Canonical(string value){
  if(!System.IO.Path.IsPathFullyQualified(value)||value.IndexOf('\0')>=0||value.Split(new[]{'/', '\\'}).Any(p=>p==".."||p=="."))throw Denied();
  return System.IO.Path.GetFullPath(value).TrimEnd(System.IO.Path.DirectorySeparatorChar,System.IO.Path.AltDirectorySeparatorChar);
 }
 private static bool Under(string value,string root)=>value.Equals(root,StringComparison.OrdinalIgnoreCase)||value.StartsWith(root+System.IO.Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase);
 private static void NoReparse(string value){
  for(var cursor=value;!string.IsNullOrEmpty(cursor);cursor=System.IO.Path.GetDirectoryName(cursor))if((File.GetAttributes(cursor)&FileAttributes.ReparsePoint)!=0)throw Denied();
 }
 public OwnedModDiscoveryFileIo(string ownedRoot,string executableDirectory,string userRoot,string expectedToken,IReadOnlyList<Receipt> receipts,Action<string>? beforeReceiptOpenForTests=null){
  owned=Canonical(ownedRoot);user=Canonical(userRoot);var executable=Canonical(executableDirectory);primary=System.IO.Path.Combine(executable,"mods");secondary=System.IO.Path.Combine(executable,"mods_STEAMTEST");
  if(!Regex.IsMatch(expectedToken,"^CharacterPipelineIsolation_[a-f0-9]{32}$")||System.IO.Path.GetFileName(user)!=expectedToken||!Canonical(OS.GetUserDataDir()).Equals(user,StringComparison.OrdinalIgnoreCase)||receipts.Count>128)throw Denied();
  NoReparse(owned);NoReparse(user);directories.Add(owned);
  try{
   LockAncestors(owned);
   foreach(var receipt in receipts){
    if(System.IO.Path.IsPathRooted(receipt.Path)||receipt.Path.Split(new[]{'/', '\\'}).Length>8||receipt.Size<0||receipt.Size>64*1024*1024||!Regex.IsMatch(receipt.Hash,"^[a-f0-9]{64}$"))throw Denied();
    var filename=Canonical(System.IO.Path.Combine(owned,receipt.Path));if(!Under(filename,owned)||locked.ContainsKey(filename)||!new[]{".json",".dll",".pck"}.Contains(System.IO.Path.GetExtension(filename),StringComparer.OrdinalIgnoreCase))throw Denied();
    LockAncestors(System.IO.Path.GetDirectoryName(filename)!);NoReparse(filename);beforeReceiptOpenForTests?.Invoke(filename);var stream=new FileStream(filename,FileMode.Open,System.IO.FileAccess.Read,FileShare.Read);
    locked.Add(filename,stream);VerifyHandlePath(stream.SafeFileHandle,filename);if(stream.Length!=receipt.Size||Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant()!=receipt.Hash)throw Denied();stream.Position=0;
    for(var parent=System.IO.Path.GetDirectoryName(filename)!;Under(parent,owned);parent=System.IO.Path.GetDirectoryName(parent)!){directories.Add(parent);if(parent.Equals(owned,StringComparison.OrdinalIgnoreCase))break;}
   }
   foreach(var pair in locked.Where(p=>System.IO.Path.GetExtension(p.Key).Equals(".json",StringComparison.OrdinalIgnoreCase))){
    if(pair.Value.Length>256*1024)throw Denied();using var json=JsonDocument.Parse(pair.Value);pair.Value.Position=0;
    if(!json.RootElement.TryGetProperty("id",out var idElement)||idElement.ValueKind!=JsonValueKind.String)throw Denied();var id=idElement.GetString()!;
    if(!Regex.IsMatch(id,"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")||id.Contains(".."))throw Denied();
    var parent=System.IO.Path.GetDirectoryName(pair.Key)!;
    foreach(var item in new[]{("has_dll",".dll"),("has_pck",".pck")})if(json.RootElement.TryGetProperty(item.Item1,out var present)&&present.GetBoolean()&&!locked.ContainsKey(System.IO.Path.Combine(parent,id+item.Item2)))throw Denied();
   }
  }catch{Dispose();throw;}
 }
 private void Active(){if(disposed)throw new ObjectDisposedException(nameof(OwnedModDiscoveryFileIo));}
 private string Resolve(string value){
  Active();if(value.StartsWith("user://",StringComparison.Ordinal)){value=Canonical(ProjectSettings.GlobalizePath(value));if(!Under(value,user))throw Denied();return value;}
  var full=Canonical(value);if(full.Equals(primary,StringComparison.OrdinalIgnoreCase))return owned;if(full.Equals(secondary,StringComparison.OrdinalIgnoreCase))return secondary;
  if(!Under(full,owned)&&!Under(full,user))throw Denied();return full;
 }
 public string[] GetFilesAt(string path){var full=Resolve(path);if(full.Equals(secondary,StringComparison.OrdinalIgnoreCase))return Array.Empty<string>();if(!directories.Contains(full))throw Denied();return locked.Keys.Where(f=>System.IO.Path.GetDirectoryName(f)!.Equals(full,StringComparison.OrdinalIgnoreCase)).OrderBy(f=>f,StringComparer.Ordinal).ToArray();}
 public string[] GetDirectoriesAt(string path){var full=Resolve(path);if(full.Equals(secondary,StringComparison.OrdinalIgnoreCase))return Array.Empty<string>();if(!directories.Contains(full))throw Denied();return directories.Where(f=>!f.Equals(owned,StringComparison.OrdinalIgnoreCase)&&System.IO.Path.GetDirectoryName(f)!.Equals(full,StringComparison.OrdinalIgnoreCase)).OrderBy(f=>f,StringComparer.Ordinal).ToArray();}
 public bool DirectoryExists(string path){var full=Resolve(path);if(full.Equals(secondary,StringComparison.OrdinalIgnoreCase))return false;if(Under(full,user)){if(Directory.Exists(full)){NoReparse(full);return true;}return false;}return directories.Contains(full);}
 public bool FileExists(string path){var full=Resolve(path);if(full.Equals(secondary,StringComparison.OrdinalIgnoreCase))return false;if(Under(full,user)){if(File.Exists(full)){NoReparse(full);return true;}return false;}if(locked.ContainsKey(full)){NoReparse(full);return true;}return false;}
 public Stream OpenStream(string path,Godot.FileAccess.ModeFlags mode){if(mode!=Godot.FileAccess.ModeFlags.Read)throw Denied();var full=Resolve(path);if(!locked.ContainsKey(full)&&!Under(full,user))throw Denied();NoReparse(full);return new FileStream(full,FileMode.Open,System.IO.FileAccess.Read,FileShare.Read);}
 public void MakeDirRecursive(string path)=>throw Denied();
 public Error CopyFile(string sourcePath,string destinationPath)=>throw Denied();
 public void Dispose(){if(disposed)return;disposed=true;foreach(var stream in locked.Values)stream.Dispose();locked.Clear();foreach(var handle in directoryLocks.Values)handle.Dispose();directoryLocks.Clear();}
}
