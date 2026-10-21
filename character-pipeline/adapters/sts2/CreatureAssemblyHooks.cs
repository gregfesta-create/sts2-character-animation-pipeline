using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Nodes.Combat;
namespace CharacterPipeline.Sts2;

/// <summary>Explicit opt-in presentation hook. No gameplay state, counters or damage are inferred here.</summary>
public sealed class CreatureAssemblyHooks : IDisposable
{
 private static CreatureAssemblyHooks? installed;
 private readonly Harmony harmony;
 private readonly MethodInfo target;
 private readonly Action<Creature?,string,Exception?> reporter;
 private readonly List<Registration> registrations=new();
 private readonly Dictionary<Creature,Entry> sessions=new(ReferenceEqualityComparer.Instance);
 private readonly HashSet<Creature> pending=new(ReferenceEqualityComparer.Instance);
 public bool IsDisposed {get;private set;}
 public string? LastError {get;private set;}
 private sealed class Entry
 {
  internal readonly CreatureAssemblyBinding Binding;internal readonly Registration Registration;
  internal Entry(CreatureAssemblyBinding binding,Registration registration){Binding=binding;Registration=registration;}
 }
 private sealed class Registration : IDisposable
 {
  internal readonly CreatureAssemblyHooks Host;internal readonly Func<Creature,bool> Predicate;internal readonly Func<Creature,PipelineVisuals.OwnershipReceipt,ICreatureAssemblyAuthority> Factory;
  internal bool Active=true;
  internal Registration(CreatureAssemblyHooks host,Func<Creature,bool> predicate,Func<Creature,PipelineVisuals.OwnershipReceipt,ICreatureAssemblyAuthority> factory){Host=host;Predicate=predicate;Factory=factory;}
  public void Dispose(){MainThread();if(!Active)return;Active=false;Host.registrations.Remove(this);foreach(var pair in Host.sessions.Where(p=>ReferenceEquals(p.Value.Registration,this)).ToArray())Host.Close(pair.Key,pair.Value);}
 }
 private CreatureAssemblyHooks(string id,MethodInfo target,Action<Creature?,string,Exception?> reporter){harmony=new Harmony(id);this.target=target;this.reporter=reporter;}
 private static void MainThread(){if(OS.GetThreadCallerId()!=OS.GetMainThreadId())throw new InvalidOperationException("Creature visuals hooks require the Godot main thread.");}
 public static CreatureAssemblyHooks Install(string harmonyId,Action<Creature?,string,Exception?> reportError)
 {
  MainThread();ArgumentNullException.ThrowIfNull(reportError);
  if(harmonyId==null||!Regex.IsMatch(harmonyId,"\\A[A-Za-z][A-Za-z0-9_.-]{0,127}\\z"))throw new ArgumentException("Explicit bounded unique Harmony ID required.");
  if(installed!=null||Harmony.HasAnyPatches(harmonyId))throw new InvalidOperationException("Hook or Harmony owner already installed.");
  var target=typeof(Creature).GetMethod("CreateVisuals",BindingFlags.Instance|BindingFlags.Public,null,Type.EmptyTypes,null);
  if(target==null||target.IsStatic||target.ReturnType!=typeof(NCreatureVisuals)||target.ContainsGenericParameters)throw new InvalidOperationException("Installed Creature.CreateVisuals signature is unsupported.");
  var host=new CreatureAssemblyHooks(harmonyId,target,reportError);installed=host;
  try{host.harmony.Patch(target,postfix:new HarmonyMethod(typeof(CreatureAssemblyHooks).GetMethod(nameof(Postfix),BindingFlags.Static|BindingFlags.NonPublic)));return host;}
  catch{host.harmony.Unpatch(target,HarmonyPatchType.Postfix,harmonyId);installed=null;throw;}
 }
 public IDisposable Register(Func<Creature,bool> predicate,Func<Creature,PipelineVisuals.OwnershipReceipt,ICreatureAssemblyAuthority> authorityFactory)
 {
  MainThread();ObjectDisposedException.ThrowIf(IsDisposed,this);ArgumentNullException.ThrowIfNull(predicate);ArgumentNullException.ThrowIfNull(authorityFactory);
  if(registrations.Count>=64)throw new InvalidOperationException("At most 64 opt-in registrations are supported.");
  var registration=new Registration(this,predicate,authorityFactory);registrations.Add(registration);return registration;
 }
 public bool TryGetSession(Creature creature,out CreatureAssemblyBinding? binding)
 {
  MainThread();binding=null;if(sessions.TryGetValue(creature,out var entry)){binding=entry.Binding;return !binding.IsDisposed;}return false;
 }
 private static void Postfix(Creature __instance,NCreatureVisuals? __result)
 {
  var host=installed;if(host==null||host.IsDisposed)return;
  try{MainThread();host.Observe(__instance,__result);}catch(Exception error){host.Report(__instance,"Creature visuals hook rejected presentation.",error);}
 }
 private void Observe(Creature creature,NCreatureVisuals? visuals)
 {
  if(visuals==null||!PipelineVisuals.TryGetReceipt(visuals,out var receipt)||!receipt!.TryGetPair(out _,out var root)||visuals.IsInsideTree()||root!.IsInsideTree())return;
  if(sessions.ContainsKey(creature)||pending.Contains(creature)){Report(creature,"Creature already has an active or pending presentation.",null);return;}
  if(sessions.Count+pending.Count>=128){Report(creature,"Creature presentation limit of 128 reached.",null);return;}
  pending.Add(creature);
  ICreatureAssemblyAuthority? source=null;CreatureAssemblyBinding? binding=null;bool transferred=false;
  try{
   var matches=new List<Registration>();foreach(var registration in registrations.ToArray())if(registration.Active&&registration.Predicate(creature))matches.Add(registration);
   if(IsDisposed)return;
   if(matches.Count==0)return;if(matches.Count!=1){Report(creature,"Multiple opt-in registrations matched one creature.",null);return;}
   var selected=matches[0];if(!selected.Active)return;
   source=selected.Factory(creature,receipt)??throw new InvalidOperationException("Authority factory returned null.");
   if(CreatureAssemblyBinding.IsAuthorityReserved(source)){transferred=true;throw new InvalidOperationException("Factory returned an authority already owned by another session.");}
   if(IsDisposed||!selected.Active)return;
   binding=CreatureAssemblyBinding.AttachOwned(creature,receipt,source,()=>transferred=true);
   var entry=new Entry(binding,selected);sessions.Add(creature,entry);
   binding.Closed+=error=>{if(sessions.TryGetValue(creature,out var current)&&ReferenceEquals(current,entry))sessions.Remove(creature);if(error!=null)Report(creature,"Creature authority session closed: "+error,null);};
  }catch(Exception error){Report(creature,"Cannot attach opted-in creature authority.",error);}
  finally{
   if(!transferred&&source!=null){try{source.Dispose();}catch(Exception error){Report(creature,"Authority disposal failed after rejected presentation.",error);}}
   pending.Remove(creature);
  }
 }
 private void Report(Creature? creature,string message,Exception? error)
 {
  LastError=error==null?message:message+" "+error.Message;
  try{reporter(creature,message,error);}catch(Exception callbackError){LastError+=" Error reporter failed: "+callbackError.Message;}
 }
 private void Close(Creature creature,Entry entry)
 {
  try{entry.Binding.Dispose();if(entry.Binding.IsDisposed&&sessions.TryGetValue(creature,out var current)&&ReferenceEquals(current,entry))sessions.Remove(creature);}catch(Exception error){Report(creature,"Creature authority teardown failed; reservation retained.",error);}
 }
 public void Dispose()
 {
  MainThread();if(IsDisposed)return;IsDisposed=true;
  harmony.Unpatch(target,HarmonyPatchType.Postfix,harmony.Id);
  foreach(var registration in registrations.ToArray())registration.Dispose();
  foreach(var pair in sessions.ToArray())Close(pair.Key,pair.Value);
  if(ReferenceEquals(installed,this))installed=null;
 }
}
