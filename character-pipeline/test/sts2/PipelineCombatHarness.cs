using System;
using System.Reflection;
using System.Threading.Tasks;
using Godot;
using System.Linq;
using System.Collections.Generic;
using HarmonyLib;
using MegaCrit.Sts2.Core.Nodes.Pooling;
using MegaCrit.Sts2.Core.Nodes.Cards;
using MegaCrit.Sts2.Core.Nodes.Cards.Holders;
using MegaCrit.Sts2.Core.Nodes.Vfx;
using System.IO;
using System.Text.Json;

// Kept outside the mod assembly: never references or resolves fixture model types
// until the original guarded loader has completed actual game startup.
public static class PipelineCombatHarness {
 const string Id="CharacterPipeline.CombatPoolReceipts";
 static readonly Dictionary<Node,object> issued=new(ReferenceEqualityComparer.Instance);
 static readonly List<NPowerRemovedVfx> powerIssued=new();
 static Harmony? harmony;
 public static void Install(){
  harmony=new Harmony(Id);
  foreach(var type in new[]{typeof(NCard),typeof(NGridCardHolder)}){
   var pool=typeof(NodePool<>).MakeGenericType(type);
   harmony.Patch(pool.GetMethod("Get",Type.EmptyTypes)!,postfix:new HarmonyMethod(typeof(PipelineCombatHarness),nameof(Issued)));
  }
  harmony.Patch(AccessTools.Method(typeof(NPowerRemovedVfx),nameof(NPowerRemovedVfx.Create)),postfix:new HarmonyMethod(typeof(PipelineCombatHarness),nameof(PowerIssued)));
 }
 static void PowerIssued(NPowerRemovedVfx? __result){
  if(__result==null)return;
  if(powerIssued.Count>=8||powerIssued.Any(n=>ReferenceEquals(n,__result))||!GodotObject.IsInstanceValid(__result)||__result.GetParent()!=null||__result.IsInsideTree())throw new Exception("Only bounded exact detached power VFX creations captured");
  powerIssued.Add(__result);
 }
 static void Issued(object __instance,Node __result){
  if(!GodotObject.IsInstanceValid(__result)||(__result.GetType()!=typeof(NCard)&&__result.GetType()!=typeof(NGridCardHolder)))throw new Exception("Only actual known pool issuances tracked");
  if(issued.TryGetValue(__result,out var previous)&&!ReferenceEquals(previous,__instance))throw new Exception("Pool issuance changed owner");
  if(!issued.ContainsKey(__result)&&issued.Count>=128)throw new Exception("Bounded fixture pool issuance registry exceeded");
  issued[__result]=__instance;
 }
 // Called only after actual NGame has been freed. Remove stale managed records
 // for exact issued nodes already freed by game teardown; return only surviving
 // detached nodes to their original pool via its public API.
 public static void ReleaseOwnedPoolObjects(){
  int powerFreed=0;
  foreach(var node in powerIssued){
   if(!GodotObject.IsInstanceValid(node))continue;
   if(node.GetParent()!=null||node.IsInsideTree()||node.IsQueuedForDeletion())throw new Exception("Exact captured power VFX still owned by tree");
   node.Free();powerFreed++;
  }
  if(powerIssued.Any(GodotObject.IsInstanceValid))throw new Exception("Exact power VFX retirement failed");
  var pools=(System.Collections.IDictionary)typeof(NodePool).GetField("_pools",BindingFlags.Static|BindingFlags.NonPublic)!.GetValue(null)!;
  foreach(System.Collections.DictionaryEntry entry in pools){
   var type=(Type)entry.Key;if(type!=typeof(NCard)&&type!=typeof(NGridCardHolder))throw new Exception("Unexpected fixture pool type");
   var pool=entry.Value!;var used=pool.GetType().GetField("_usedObjects",BindingFlags.Instance|BindingFlags.NonPublic)!.GetValue(pool)!;
   var nodes=((System.Collections.IEnumerable)used).Cast<Node>().ToArray();if(nodes.Length>128)throw new Exception("Bounded pool teardown exceeded");
   foreach(var node in nodes){
    if(!issued.TryGetValue(node,out var owner)||!ReferenceEquals(owner,pool))throw new Exception("Unreceipted used pool object refused");
    if(GodotObject.IsInstanceValid(node)){
     if(node.GetParent()!=null||node.IsInsideTree()||node.IsQueuedForDeletion())throw new Exception("Pool node still owned by a live tree");
     NodePool.Free((IPoolable)node);
    }else used.GetType().GetMethod("Remove")!.Invoke(used,new object[]{node});
   }
  }
  File.WriteAllText(ProjectSettings.GlobalizePath("res://lifetime-result.json"),JsonSerializer.Serialize(new{passed=true,powerIssued=powerIssued.Count,powerFreed,remainingPowerNodes=powerIssued.Count(GodotObject.IsInstanceValid),powerRetired=true}));
  harmony?.UnpatchAll(Id);issued.Clear();powerIssued.Clear();
 }
 public static async Task RunAsync() {
  var assembly=Array.Find(AppDomain.CurrentDomain.GetAssemblies(),a=>a.GetName().Name=="pipeline_generated_fixture")??throw new Exception("Actual mod assembly missing");
  var type=assembly.GetType("PipelineCombatFixture",true)!;
  await (Task)type.GetMethod("RunCombatAsync",BindingFlags.Public|BindingFlags.Static)!.Invoke(null,null)!;
 }
}
