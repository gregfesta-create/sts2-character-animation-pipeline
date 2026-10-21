using System;
using System.Collections.Generic;
using System.Threading;
using System.Text.RegularExpressions;
using Godot;
using MegaCrit.Sts2.Core.Entities.Creatures;
namespace CharacterPipeline.Sts2;

/// <summary>Presentation-only bridge. Trusted readers inspect gameplay before consumption;
/// the caller copies their facts and captures them without changing gameplay.</summary>
public sealed class CombatPresentationCaller : IDisposable
{
 const long MaximumSequence=9007199254740991;
 static readonly Regex Token=new("\\A[A-Za-z][A-Za-z0-9_-]{0,63}\\z",RegexOptions.CultureInvariant);
 readonly AttackPresentationBinding binding;
 readonly Node2D root;
 readonly Callable preparedExit;
 readonly Dictionary<PreparedAction,PreparedState> pending=new();
 readonly HashSet<string> pendingIds=new(StringComparer.Ordinal);
 sealed class PreparedState {public required AttackPresentationRequest Request;public required Dictionary<string,AttackBindingFact> Facts;public bool Terminal;}
 /// <summary>A caller-owned, single-use capture. Capture sequence identifies the reader
 /// request; a later BeginPrepared uses a fresh native delivery sequence.</summary>
 public sealed class PreparedAction
 {
  readonly Func<bool> terminal;
  public AttackPresentationRequest Request {get;}
  public bool IsTerminal=>terminal();
  PreparedAction(AttackPresentationRequest request,Func<bool> terminal){Request=request;this.terminal=terminal;}
  // The caller's private membership is authoritative. Unregistered handles cannot start.
  internal static PreparedAction Create(AttackPresentationRequest request,Func<bool> terminal)=>new(request,terminal);
 }
 readonly Creature owner;
 readonly string generation,contract;
 readonly HashSet<string> ids,ownerIds,actionIds;
 readonly Func<Creature,IReadOnlyDictionary<string,AttackBindingFact>> reader;
 readonly Func<Creature,AttackPresentationRequest,IReadOnlyDictionary<string,AttackBindingFact>>? actionReader;
 long sequence;
 bool disposed,reading,delivering;
 string? error;
 public bool HasEffects {get;}
 public bool IsDisposed {get{bool value=disposed||binding.IsDisposed;if(value&&OnMain())InvalidatePrepared();return value;}}
 public string? LastError=>Volatile.Read(ref error);
 CombatPresentationCaller(AttackPresentationBinding binding,Node2D root,Creature owner,string generation,string contract,HashSet<string> ids,HashSet<string> ownerIds,HashSet<string> actionIds,Func<Creature,IReadOnlyDictionary<string,AttackBindingFact>> reader,Func<Creature,AttackPresentationRequest,IReadOnlyDictionary<string,AttackBindingFact>>? actionReader,bool effects){this.binding=binding;this.root=root;this.owner=owner;this.generation=generation;this.contract=contract;this.ids=ids;this.ownerIds=ownerIds;this.actionIds=actionIds;this.reader=reader;this.actionReader=actionReader;HasEffects=effects;preparedExit=Callable.From(InvalidatePrepared);root.Connect(Node.SignalName.TreeExiting,preparedExit);}
 static bool OnMain()=>OS.GetThreadCallerId()==OS.GetMainThreadId();
 static void Id(string value){if(value==null||!Token.IsMatch(value))throw new ArgumentException("Bounded stable ID required.");}
 static HashSet<string> CopyIds(IReadOnlyCollection<string> values){ArgumentNullException.ThrowIfNull(values);if(values.Count>64)throw new ArgumentException("Bounded binding set required.");var copy=new HashSet<string>(StringComparer.Ordinal);foreach(var id in values){Id(id);if(!copy.Add(id)||copy.Count>64)throw new ArgumentException("Unique bounded binding set required.");}if(copy.Count!=values.Count)throw new ArgumentException("Exact binding set required.");return copy;}
 public static CombatPresentationCaller AttachReady(PipelineVisuals.OwnershipReceipt receipt,Creature owner,string generation,string adapterContractVersion,IReadOnlyCollection<string> bindingIds,Func<Creature,IReadOnlyDictionary<string,AttackBindingFact>> readFacts)=>Attach(receipt,owner,generation,adapterContractVersion,bindingIds,readFacts,Array.Empty<string>(),null);
 public static CombatPresentationCaller AttachReadyWithActionFacts(PipelineVisuals.OwnershipReceipt receipt,Creature owner,string generation,string adapterContractVersion,IReadOnlyCollection<string> bindingIds,Func<Creature,IReadOnlyDictionary<string,AttackBindingFact>> readFacts,IReadOnlyCollection<string> actionBindingIds,Func<Creature,AttackPresentationRequest,IReadOnlyDictionary<string,AttackBindingFact>> readActionFacts){ArgumentNullException.ThrowIfNull(readActionFacts);return Attach(receipt,owner,generation,adapterContractVersion,bindingIds,readFacts,actionBindingIds,readActionFacts);}
 static CombatPresentationCaller Attach(PipelineVisuals.OwnershipReceipt receipt,Creature owner,string generation,string adapterContractVersion,IReadOnlyCollection<string> bindingIds,Func<Creature,IReadOnlyDictionary<string,AttackBindingFact>> readFacts,IReadOnlyCollection<string> actionBindingIds,Func<Creature,AttackPresentationRequest,IReadOnlyDictionary<string,AttackBindingFact>>? readActionFacts)
 {
  if(!OnMain())throw new InvalidOperationException("Combat presentation requires the Godot main thread.");
  ArgumentNullException.ThrowIfNull(receipt);ArgumentNullException.ThrowIfNull(owner);ArgumentNullException.ThrowIfNull(readFacts);Id(generation);
  if(string.IsNullOrEmpty(adapterContractVersion)||adapterContractVersion.Length>256)throw new ArgumentException("Bounded contract required.");
  var ids=CopyIds(bindingIds);var actionIds=CopyIds(actionBindingIds);if(!actionIds.IsSubsetOf(ids))throw new ArgumentException("Action bindings must be a subset.");var ownerIds=new HashSet<string>(ids,StringComparer.Ordinal);ownerIds.ExceptWith(actionIds);
  if(!receipt.TryGetPair(out _,out var root)||root==null||!root.IsInsideTree()||!root.IsNodeReady())throw new ArgumentException("Exact ready factory root required.");
  var effects=root.GetNodeOrNull("EffectController");if(effects==null&&ids.Count!=0)throw new ArgumentException("Projectile-only root requires empty bindings.");
  if(effects!=null&&(!effects.IsNodeReady()||!effects.Get("ready_for_effects").AsBool()))throw new ArgumentException("Effects must be ready.");
  return new(AttackPresentationBinding.Attach(receipt),root,owner,generation,adapterContractVersion,ids,ownerIds,actionIds,readFacts,readActionFacts,effects!=null);
 }
 bool Fail(string code){Volatile.Write(ref error,code);return false;}
 bool Ready(){if(!OnMain())return Fail("MAIN_THREAD_REQUIRED");if(reading)return Fail("REENTRANT_CALL");if(IsDisposed){InvalidatePrepared();return Fail("DISPOSED");}return true;}
 bool Next(){if(sequence>=MaximumSequence)return Fail("SEQUENCE_EXHAUSTED");sequence++;return true;}
 bool Suppress(){if(!HasEffects)return false;if(!Next())return false;try{var absent=new Dictionary<string,AttackBindingFact>(StringComparer.Ordinal);foreach(var id in ids)absent.Add(id,new(false,0));return binding.Observe(contract,sequence,absent);}catch{return false;}}
 static void CopyFacts(IReadOnlyDictionary<string,AttackBindingFact> source,HashSet<string> expected,Dictionary<string,AttackBindingFact> copy)
 {
  if(source==null||source.Count!=expected.Count||source.Count>64)throw new ArgumentException();int count=0;
  foreach(var pair in source){if(++count>64||!expected.Contains(pair.Key)||pair.Value==null||!double.IsFinite(pair.Value.Amount)||Math.Abs(pair.Value.Amount)>1000000||!copy.TryAdd(pair.Key,new(pair.Value.Present,pair.Value.Amount)))throw new ArgumentException();}
  if(count!=expected.Count)throw new ArgumentException();
 }
 bool Observe(AttackPresentationRequest? request=null)
 {
  if(!Ready())return false;if(delivering)return Fail("REENTRANT_CALL");if(!Next())return false;
  try{
   var copy=new Dictionary<string,AttackBindingFact>(StringComparer.Ordinal);
   reading=true;
   try{
    CopyFacts(reader(owner),ownerIds,copy);
    if(request!=null&&actionReader!=null)CopyFacts(actionReader(owner,request),actionIds,copy);
    else foreach(var id in actionIds)copy.Add(id,new(false,0));
   }finally{reading=false;}
   if(HasEffects&&!binding.Observe(contract,sequence,copy)){Suppress();return Fail("OBSERVATION_REJECTED");}
   Volatile.Write(ref error,null);return true;
  }catch{bool suppressed=Suppress();return Fail(HasEffects&&!suppressed?"FACTS_REJECTED_SUPPRESSION_FAILED":"FACTS_REJECTED");}finally{if(binding.IsDisposed)InvalidatePrepared();}
 }
 public bool ObserveCurrent()=>Observe();
 AttackPresentationRequest? Request(string actionId,string clipId,AttackPresentationTarget target,double releaseAt,double impactAt)
 {
  try{Id(actionId);Id(clipId);if(target==null||!target.Valid||!target.Position.IsFinite()||Math.Abs(target.Position.X)>1000000||Math.Abs(target.Position.Y)>1000000||!double.IsFinite(releaseAt)||!double.IsFinite(impactAt)||releaseAt<0||impactAt<=releaseAt||impactAt>10)throw new ArgumentException();return new(actionId,generation,clipId,new(target.Valid,target.Position),releaseAt,impactAt,sequence+1);}catch{Fail("INVALID_REQUEST");return null;}
 }
 /// <summary>Copies trusted facts now without beginning a native action. At most 32
 /// pending captures are retained; gameplay readers are never invoked at delivery.</summary>
 public PreparedAction? PrepareBeforeConsumption(string actionId,string clipId,AttackPresentationTarget target,double releaseAt,double impactAt)
 {
  if(!Ready())return null;if(delivering){Fail("REENTRANT_CALL");return null;}
  if(pendingIds.Contains(actionId)){Fail("PREPARED_DUPLICATE");return null;}
  if(pending.Count>=32){Fail("PREPARED_CAPACITY");return null;}
  if(sequence>=MaximumSequence){Fail("SEQUENCE_EXHAUSTED");return null;}
  var request=Request(actionId,clipId,target,releaseAt,impactAt);if(request==null||!Next())return null;
  var copy=new Dictionary<string,AttackBindingFact>(StringComparer.Ordinal);
  try{
   reading=true;
   try{CopyFacts(reader(owner),ownerIds,copy);if(actionReader!=null)CopyFacts(actionReader(owner,request),actionIds,copy);else foreach(var id in actionIds)copy.Add(id,new(false,0));}finally{reading=false;}
   if(!Ready()){copy.Clear();return null;}
   var state=new PreparedState{Request=request,Facts=copy};var handle=PreparedAction.Create(request,()=>state.Terminal);
   pending.Add(handle,state);pendingIds.Add(actionId);Volatile.Write(ref error,null);return handle;
  }catch{copy.Clear();bool suppressed=Suppress();Fail(HasEffects&&!suppressed?"FACTS_REJECTED_SUPPRESSION_FAILED":"FACTS_REJECTED");return null;}
 }
 bool TakePrepared(PreparedAction? handle,out PreparedState? state)
 {
  state=null;if(handle==null||!pending.Remove(handle,out state))return Fail("PREPARED_INVALID");
  pendingIds.Remove(state.Request.ActionId);state.Terminal=true;return true;
 }
 public bool DiscardPrepared(PreparedAction handle)
 {
  if(!Ready()||!TakePrepared(handle,out var state))return false;state!.Facts.Clear();Volatile.Write(ref error,null);return true;
 }
 public bool BeginPrepared(PreparedAction handle)
 {
  if(!Ready())return false;if(delivering)return Fail("REENTRANT_CALL");if(!TakePrepared(handle,out var state))return false;
  // Consume and detach retained facts before invoking any native callbacks.
  var copy=new Dictionary<string,AttackBindingFact>(state!.Facts,StringComparer.Ordinal);state.Facts.Clear();
  if(!Next()){copy.Clear();return false;}
  var captured=state.Request;var delivery=captured with {ObservationSequence=sequence};
  delivering=true;
  try{
   if(HasEffects&&!binding.Observe(contract,sequence,copy)){Suppress();return Fail("OBSERVATION_REJECTED");}
   if(IsDisposed)return Fail("DISPOSED");
   if(!binding.BeginAttack(delivery))return Fail("PRESENTATION_REJECTED");
   Volatile.Write(ref error,null);return true;
  }catch{return Fail("PRESENTATION_EXCEPTION");}finally{copy.Clear();delivering=false;if(binding.IsDisposed)InvalidatePrepared();}
 }
 void InvalidatePrepared(){foreach(var state in pending.Values){state.Terminal=true;state.Facts.Clear();}pending.Clear();pendingIds.Clear();}
 public bool BeginBeforeConsumption(string actionId,string clipId,AttackPresentationTarget target,double releaseAt,double impactAt)
 {
  if(!Ready())return false;if(delivering)return Fail("REENTRANT_CALL");if(sequence>=MaximumSequence)return Fail("SEQUENCE_EXHAUSTED");
  var request=Request(actionId,clipId,target,releaseAt,impactAt);if(request==null)return false;
  if(!Observe(request))return false;return Call(()=>binding.BeginAttack(request));
 }
 bool Call(Func<bool> operation){if(!Ready())return false;try{if(!operation())return Fail("PRESENTATION_REJECTED");Volatile.Write(ref error,null);return true;}catch{return Fail("PRESENTATION_EXCEPTION");}}
 public bool UpdateTarget(string actionId,AttackPresentationTarget target)=>Call(()=>binding.UpdateTarget(actionId,target));
 public bool ConfirmImpact(string actionId,string cueId,double actionClock,Vector2 position)=>Call(()=>binding.ConfirmImpact(actionId,cueId,actionClock,position));
 public bool ConfirmImpact(string actionId,string cueId,string releaseCueId,double actionClock,Vector2 position)=>Call(()=>binding.ConfirmImpact(actionId,cueId,releaseCueId,actionClock,position));
 public bool Complete(string actionId)=>Call(()=>binding.CompleteAttack(actionId));
 public bool Cancel(string actionId)=>Call(()=>binding.CancelAttack(actionId));
 public bool AdvanceClock(double monotonicSeconds)=>Call(()=>binding.AdvanceClock(monotonicSeconds));
 public bool DisposePresentation(){if(!OnMain())return Fail("MAIN_THREAD_REQUIRED");if(reading)return Fail("REENTRANT_CALL");InvalidatePrepared();if(GodotObject.IsInstanceValid(root)&&root.IsConnected(Node.SignalName.TreeExiting,preparedExit))root.Disconnect(Node.SignalName.TreeExiting,preparedExit);if(IsDisposed){disposed=true;return true;}try{binding.Dispose();disposed=true;Volatile.Write(ref error,null);return true;}catch{return Fail("DISPOSAL_EXCEPTION");}}
 public void Dispose(){DisposePresentation();}
}
