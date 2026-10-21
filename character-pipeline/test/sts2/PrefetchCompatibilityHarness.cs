using System;
using System.Linq;
using System.IO;
using System.Text.Json;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.Assets;
// Fixture-only host diagnosis. Original enabled prefetch still runs; no production behavior is changed.
public static class PrefetchCompatibilityHarness {
 const string Id="CharacterPipeline.SerialCommonWarmup";
 static string[] warmedPaths=Array.Empty<string>();static Harmony? harmony;static int invocations,warmInvocations,originalInvocations,paths,readyResources,coldResources;
 public static void Install(){
  if(!PreloadManager.Enabled)throw new Exception("Preloading must remain enabled");
  harmony=new Harmony(Id);var method=AccessTools.Method(typeof(PreloadManager),nameof(PreloadManager.LoadCommonAndMainMenuAssets));
  harmony.Patch(method,prefix:new HarmonyMethod(typeof(PrefetchCompatibilityHarness),nameof(Prefix)),postfix:new HarmonyMethod(typeof(PrefetchCompatibilityHarness),nameof(Postfix)));
 }
 static void Prefix(){
  if(++invocations>8||!PreloadManager.Enabled)throw new Exception("Bounded enabled original common preload required");
  if(invocations>1)return;
  warmInvocations++;
  var entries=AssetSets.CommonAssets.Concat(AssetSets.MainMenuSet).Distinct(StringComparer.Ordinal).Take(2049).ToArray();
  if(entries.Length==0||entries.Length>2048)throw new Exception("Bounded real common asset set required");
  warmedPaths=entries;paths=entries.Length;var before=PreloadManager.Cache.GetLoadedCacheAssets().ToHashSet(StringComparer.Ordinal);coldResources=entries.Count(p=>!before.Contains(p));
  foreach(var path in entries){
   if(!path.StartsWith("res://",StringComparison.Ordinal)||path.Length<=6||path.Substring(6).Split('/' ).Any(s=>s.Length==0||s=="."||s=="..")||path.Any(c=>char.IsControl(c)||c=='\\')||path.Length>2048)throw new Exception("Only canonical packed game paths allowed");
   var resource=ResourceLoader.Load<Resource>(path);if(resource==null||!GodotObject.IsInstanceValid(resource))throw new Exception("Actual resource failed: "+path);
   PreloadManager.Cache.SetAsset(path,resource);readyResources++;
  }
 }
 // Harmony postfix observes the original returning its Task, not task completion.
 static void Postfix(){originalInvocations++;}
 public static void Finish(){
  File.WriteAllText(ProjectSettings.GlobalizePath("res://prefetch-result.json"),JsonSerializer.Serialize(new{preloadEnabled=PreloadManager.Enabled,serialWarmup=true,invocations,warmInvocations,originalInvocations,paths,warmedPaths,readyResources,coldResources,gameAcceptance=false,coldPrefetchAcceptance=false}));
  harmony?.UnpatchAll(Id);
 }
}



