using System;
using System.Linq;
using System.IO;
using System.Reflection;
using System.Collections.Generic;
using System.Text.Json;
using Godot;
using MegaCrit.Sts2.Core.Assets;
public static class ColdScriptWarmupHarness {
 static readonly Type[] Types={typeof(MegaCrit.Sts2.Core.Nodes.CommonUi.NVerticalPopup),typeof(MegaCrit.Sts2.Core.Nodes.GodotExtensions.NButton),typeof(MegaCrit.Sts2.Core.Nodes.Screens.MainMenu.NSubmenu)};
 static readonly List<CSharpScript> Retained=new();
 record Receipt(string path,string[] dependencies);
 static readonly List<Receipt> Closure=new();static string[] candidates=Array.Empty<string>();static bool started;
 static string PathFor(Type t)=>t.GetCustomAttribute<ScriptPathAttribute>(false)?.Path??"";
 public static void Warm(){
  if(started||!PreloadManager.Enabled)throw new Exception("Single enabled candidate-script experiment required");started=true;
  candidates=Types.Select(PathFor).ToArray();var paths=new HashSet<string>(StringComparer.Ordinal);
  foreach(var candidate in Types){int depth=0;for(Type? t=candidate;t!=null;t=t.BaseType){if(++depth>32)throw new Exception("Bounded managed base chain");var path=PathFor(t);if(path=="")continue;if(paths.Add(path)&&paths.Count>32)throw new Exception("Bounded script closure");}}
  foreach(var path in paths){
   if(!path.StartsWith("res://src/",StringComparison.Ordinal)||!path.EndsWith(".cs",StringComparison.Ordinal)||path.Contains("..")||path.Length>2048)throw new Exception("Only actual packed managed script paths");
   var dependencies=ResourceLoader.GetDependencies(path);if(dependencies.Length>256||dependencies.Any(p=>p.Length>2048))throw new Exception("Bounded actual dependency receipt");
   var script=ResourceLoader.Load<CSharpScript>(path);if(script==null||!GodotObject.IsInstanceValid(script))throw new Exception("Real script resource failed: "+path);
   Retained.Add(script);Closure.Add(new Receipt(path,dependencies));
  }
 }
 public static void Finish(){
  // Keep script wrappers alive through game teardown; process exit owns final release.
  if(!started)return;
  File.WriteAllText(ProjectSettings.GlobalizePath("res://script-warmup.json"),JsonSerializer.Serialize(new{scriptsWarmup=true,preloadEnabled=PreloadManager.Enabled,coldPrefetchAcceptance=false,gameAcceptance=false,candidates,closure=Closure.ToArray(),loadedCount=Retained.Count}));
 }
}
