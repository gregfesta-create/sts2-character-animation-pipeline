using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using Godot;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Nodes.Combat;
namespace CharacterPipeline.Sts2;

/// <summary>Trusted host authority. Callbacks run on the Godot main thread; counters and lifecycle come from game state.</summary>
public interface ICreatureAssemblyAuthority : IDisposable
{
 string InstanceId { get; }
 AssemblySnapshot CaptureSnapshot(long minimumSequence,long minimumRevision);
 event Action<AssemblySnapshot>? SnapshotAvailable;
 event Action<AssemblyEvent>? EventAvailable;
}

/// <summary>Opt-in, presentation-only lifetime bridge. Does not install hooks or infer game mechanics.</summary>
public sealed class CreatureAssemblyBinding : IDisposable
{
 private static readonly ConditionalWeakTable<Creature,CreatureAssemblyBinding> Creatures=new();
 private static readonly ConditionalWeakTable<ICreatureAssemblyAuthority,CreatureAssemblyBinding> Authorities=new();
 private static readonly HashSet<string> Owners=new(StringComparer.Ordinal);
 private readonly Creature creature;
 private readonly ICreatureAssemblyAuthority authority;
 private readonly PipelineVisuals.OwnershipReceipt receipt;
 private readonly NCreatureVisuals visuals;
 private readonly Callable exitCallback;
 private bool reserved,processing,pending,rebuild;
 private long minimumSequence,minimumRevision=1;
 public AssemblyStateBinding Binding {get;private set;}=null!;
 public bool IsDisposed {get;private set;}
 public string? LastError {get;private set;}
 public event Action<string?>? Closed;
 private readonly string owner;
 private CreatureAssemblyBinding(Creature creature,PipelineVisuals.OwnershipReceipt receipt,ICreatureAssemblyAuthority authority,NCreatureVisuals visuals)
 {
  this.creature=creature;this.receipt=receipt;this.authority=authority;this.visuals=visuals;owner=authority.InstanceId;exitCallback=Callable.From(Dispose);
 }
 private static void MainThread(){if(OS.GetThreadCallerId()!=OS.GetMainThreadId())throw new InvalidOperationException("Creature assembly authority must run on the Godot main thread.");}
 public static CreatureAssemblyBinding Attach(Creature creature,PipelineVisuals.OwnershipReceipt receipt,ICreatureAssemblyAuthority authority)
  =>AttachOwned(creature,receipt,authority,null);
 internal static bool IsAuthorityReserved(ICreatureAssemblyAuthority authority){MainThread();return Authorities.TryGetValue(authority,out _);}
 internal static CreatureAssemblyBinding AttachOwned(Creature creature,PipelineVisuals.OwnershipReceipt receipt,ICreatureAssemblyAuthority authority,Action? authorityAcquired)
 {
  MainThread();ArgumentNullException.ThrowIfNull(creature);ArgumentNullException.ThrowIfNull(receipt);ArgumentNullException.ThrowIfNull(authority);
  if(!receipt.TryGetPair(out var visuals,out var root)||visuals!.IsInsideTree()||root!.IsInsideTree())throw new ArgumentException("Exact factory presentation must be detached before binding.");
  if(Creatures.TryGetValue(creature,out _)||Authorities.TryGetValue(authority,out _)||Owners.Contains(authority.InstanceId))throw new ArgumentException("Creature, authority and owner must have a unique active presentation lifetime.");
  var session=new CreatureAssemblyBinding(creature,receipt,authority,visuals!);
  Creatures.Add(creature,session);Authorities.Add(authority,session);Owners.Add(session.owner);session.reserved=true;
  try{
   authorityAcquired?.Invoke();
   session.Binding=AssemblyStateBinding.Attach(root!,session.owner);
   session.Binding.Bound+=session.OnBound;session.Binding.BindingFailed+=session.OnFailed;
   session.Binding.SnapshotRequired+=session.OnSnapshotRequired;session.Binding.RebuildRequired+=session.OnRebuildRequired;
   authority.SnapshotAvailable+=session.OnSnapshot;authority.EventAvailable+=session.OnEvent;
   creature.Died+=session.OnCreatureRefresh;creature.Revived+=session.OnCreatureRefresh;
   if(visuals!.Connect(Node.SignalName.TreeExiting,session.exitCallback)!=Error.Ok)throw new InvalidOperationException("Cannot subscribe exact visuals lifetime.");
   return session;
  }catch{session.Dispose();throw;}
 }
 private void CheckPair(){if(!receipt.TryGetPair(out var v,out _)||!ReferenceEquals(v,visuals)||authority.InstanceId!=owner)throw new InvalidOperationException("Authoritative presentation ownership changed.");}
 private void OnFailed(string error){LastError=error;Dispose();}
 private void OnBound()=>Request(0,1,false);
 private void OnCreatureRefresh(Creature value){MainThread();if(ReferenceEquals(value,creature))Request(0,1,false);}
 private void OnSnapshotRequired(string id,long sequence,long revision){MainThread();if(id==owner)Request(sequence,revision,false);}
 private void OnRebuildRequired(string id){MainThread();if(id==owner)Request(0,1,true);}
 private void Request(long sequence,long revision,bool needsRebuild)
 {
  MainThread();if(IsDisposed)return;minimumSequence=Math.Max(minimumSequence,sequence);minimumRevision=Math.Max(minimumRevision,revision);pending=true;rebuild|=needsRebuild;Drain();
 }
 private void OnSnapshot(AssemblySnapshot snapshot)
 {
  MainThread();if(IsDisposed)return;
  if(!ObserveEnvelope(snapshot?.InstanceId,snapshot?.Sequence,snapshot?.Revision))return;
  if(processing){Request(snapshot.Sequence,snapshot.Revision,false);return;}
  Receive(()=>Binding.ApplySnapshot(snapshot));
 }
 private void OnEvent(AssemblyEvent message)
 {
  MainThread();if(IsDisposed)return;
  if(!ObserveEnvelope(message?.InstanceId,message?.Sequence,message?.Revision))return;
  if(processing){Request(message.Sequence,message.Revision,false);return;}
  Receive(()=>Binding.ApplyEvent(message));
 }
 private bool ObserveEnvelope(string? id,long? sequence,long? revision)
 {
  if(id!=owner||sequence==null||revision==null||sequence<0||revision<1||sequence>AssemblyStateBinding.MaximumCounter||revision>AssemblyStateBinding.MaximumCounter){LastError="Authority callback has invalid owner or counters.";Dispose();return false;}
  minimumSequence=Math.Max(minimumSequence,sequence.Value);minimumRevision=Math.Max(minimumRevision,revision.Value);return true;
 }
 private void Receive(Func<AssemblyResult> apply)
 {
  processing=true;try{CheckPair();if(!Binding.IsBound){pending=true;return;}var result=apply();Observe(result);}catch(Exception e){LastError=e.Message;Dispose();}finally{processing=false;}
  Drain();
 }
 private void Observe(AssemblyResult result)
 {
  if(result.RequestSnapshot)pending=true;
  if(result.NeedsPresentationRebuild){pending=true;rebuild=true;}
  if(result.Error!=null&&!result.NeedsPresentationRebuild)LastError=result.Error;
 }
 private void Drain()
 {
  if(processing||IsDisposed||!Binding.IsBound)return;
  processing=true;
  try{
   for(int attempt=0;pending&&!IsDisposed&&attempt<4;attempt++){
    CheckPair();pending=false;bool recovering=rebuild;rebuild=false;
    var snapshot=authority.CaptureSnapshot(minimumSequence,minimumRevision);
    if(IsDisposed)break;
    if(snapshot.InstanceId!=owner||snapshot.Sequence<minimumSequence||snapshot.Revision<minimumRevision)throw new InvalidOperationException("Authority snapshot does not satisfy requested owner and counter floors.");
    CheckPair();Observe(recovering?Binding.RebuildFromSnapshot(snapshot):Binding.ApplySnapshot(snapshot));
   }
   if(pending&&!IsDisposed)throw new InvalidOperationException("Authority refresh exceeded bounded coalesced requests.");
  }catch(Exception e){LastError=e.Message;Dispose();}finally{processing=false;}
 }
 public void Dispose()
 {
  MainThread();if(IsDisposed)return;
  // Keep reservations if native disposal cannot guarantee authority release.
  Binding?.Dispose();IsDisposed=true;
  if(Binding!=null){Binding.Bound-=OnBound;Binding.BindingFailed-=OnFailed;Binding.SnapshotRequired-=OnSnapshotRequired;Binding.RebuildRequired-=OnRebuildRequired;}
  authority.SnapshotAvailable-=OnSnapshot;authority.EventAvailable-=OnEvent;creature.Died-=OnCreatureRefresh;creature.Revived-=OnCreatureRefresh;
  if(GodotObject.IsInstanceValid(visuals)&&visuals.IsConnected(Node.SignalName.TreeExiting,exitCallback))visuals.Disconnect(Node.SignalName.TreeExiting,exitCallback);
  try{authority.Dispose();}catch(Exception error){LastError="Authority disposal failed: "+error.Message;}
  if(reserved){Creatures.Remove(creature);Authorities.Remove(authority);Owners.Remove(owner);reserved=false;}
  var observers=Closed;Closed=null;
  if(observers!=null)foreach(Action<string?> observer in observers.GetInvocationList())try{observer(LastError);}catch(Exception error){LastError="Closure observer failed: "+error.Message;}
 }
}
