using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Reflection;
using System.Text.Json;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.Assets;
public static class ColdPrefetchTraceHarness {
 record Entry(long sequence,int thread,int nesting,string operation,string path,string status);
 static readonly object Gate=new();static readonly Queue<Entry> Records=new();static readonly List<string> Patches=new();
 static long sequence;static int overflow;[ThreadStatic]static int nesting;static Harmony? harmony;static ColdPrefetchTraceLogger? logger;static Entry[]? firstErrorContext;
 static string B(string? s)=>s==null?"":s.Substring(0,Math.Min(s.Length,2048));
 public static void Record(string operation,string path,string status){lock(Gate){if(Records.Count==2048){Records.Dequeue();overflow++;}Records.Enqueue(new Entry(++sequence,System.Environment.CurrentManagedThreadId,nesting,B(operation),B(path),B(status)));}}
 public static void Error(string error,string function){Record("engine-error",error,function);lock(Gate){firstErrorContext??=Records.ToArray();}}
 static void Prefix(MethodBase __originalMethod,object[] __args){nesting++;Record("enter:"+__originalMethod.Name,Describe(__args),"");}
 static void Postfix(MethodBase __originalMethod,object? __result){Record("return:"+__originalMethod.Name,"",__result is Resource r?r.GetType().FullName??"Resource":__result?.ToString()??"null");}
 static Exception? Finalizer(Exception? __exception){if(__exception!=null)Record("exception","",__exception.GetType().FullName+":"+__exception.Message);nesting=Math.Max(0,nesting-1);return __exception;}
 static string Describe(object[] args){var first=args.FirstOrDefault();return first is Type t?t.AssemblyQualifiedName??t.FullName??t.Name:first as string??first?.GetType().FullName??"";}
 static void ScriptPrefix(Type __0){nesting++;Record("enter:ScriptType",__0.AssemblyQualifiedName??__0.FullName??__0.Name,"");}
 static void ScriptPostfix(){Record("return:ScriptType","","");}
 static void Patch(MethodInfo? method,bool script){
  if(method==null||method.GetMethodBody()==null){Patches.Add("unsupported:"+(method?.Name??"missing"));return;}
  try{harmony!.Patch(method,prefix:new HarmonyMethod(typeof(ColdPrefetchTraceHarness),script?nameof(ScriptPrefix):nameof(Prefix)),postfix:new HarmonyMethod(typeof(ColdPrefetchTraceHarness),script?nameof(ScriptPostfix):nameof(Postfix)),finalizer:new HarmonyMethod(typeof(ColdPrefetchTraceHarness),nameof(Finalizer)));Patches.Add("observed:"+method.Name);}catch(Exception e){Patches.Add(B("unsupported:"+method.Name+":"+e.GetType().Name+":"+e.Message));}
 }
 public static void Install(){
  if(!PreloadManager.Enabled)throw new Exception("Cold observation requires enabled preloading");
  harmony=new Harmony("CharacterPipeline.ColdPrefetchTrace");logger=new ColdPrefetchTraceLogger();OS.AddLogger(logger);
  foreach(var name in new[]{"LoadThreadedRequest","LoadThreadedGetStatus","LoadThreadedGet"})Patch(typeof(ResourceLoader).GetMethods(BindingFlags.Public|BindingFlags.Static).SingleOrDefault(m=>m.Name==name),false);
  Patch(typeof(Godot.Bridge.ScriptManagerBridge).GetMethod("GetOrLoadOrCreateScriptForType",BindingFlags.NonPublic|BindingFlags.Static),true);
 }
 public static void Finish(){
  if(harmony==null)return;
  if(logger!=null)OS.RemoveLogger(logger);
  lock(Gate)File.WriteAllText(ProjectSettings.GlobalizePath("res://cold-prefetch-trace.json"),JsonSerializer.Serialize(new{observationOnly=true,preloadEnabled=PreloadManager.Enabled,gameAcceptance=false,coldPrefetchAcceptance=false,records=Records.ToArray(),overflow,patches=Patches.ToArray(),firstErrorContext}));
  harmony.UnpatchAll("CharacterPipeline.ColdPrefetchTrace");logger?.Dispose();harmony=null;
 }
}
public partial class ColdPrefetchTraceLogger:Logger {
 public override void _LogError(string function,string file,int line,string code,string rationale,bool editorNotify,int errorType,Godot.Collections.Array<ScriptBacktrace> scriptBacktraces){ColdPrefetchTraceHarness.Error(code+":"+rationale,function+":"+file+":"+line);}
}

