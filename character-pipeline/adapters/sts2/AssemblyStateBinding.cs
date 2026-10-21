using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Godot;
using GDictionary = Godot.Collections.Dictionary;
using GArray = Godot.Collections.Array;

namespace CharacterPipeline.Sts2;

public enum AssemblyLifecycle { Alive, Dead, Removed }
public enum AssemblyDamageState { Intact, Damaged, Destroyed }
public sealed record AssemblyComponentState(string Id,string Socket,string Type,long Revision,AssemblyDamageState DamageState,long Upgrade,string VisualMode);

/// <summary>Copied immutable authoritative snapshot; construction never invents counters.</summary>
public sealed class AssemblySnapshot
{
    public string InstanceId { get; }
    public long Sequence { get; }
    public long Revision { get; }
    public AssemblyLifecycle Lifecycle { get; }
    public string VisualMode { get; }
    public IReadOnlyList<AssemblyComponentState> Components { get; }
    public AssemblySnapshot(string instanceId,long sequence,long revision,AssemblyLifecycle lifecycle,string visualMode,IEnumerable<AssemblyComponentState> components)
    {
        ArgumentNullException.ThrowIfNull(components);
        var copy=components.Take(65).ToArray();
        if(copy.Length>64)throw new ArgumentException("Native component snapshot exceeds 64 entries.",nameof(components));
        InstanceId=instanceId;Sequence=sequence;Revision=revision;Lifecycle=lifecycle;VisualMode=visualMode;Components=Array.AsReadOnly(copy);
    }
}
public abstract record AssemblyEvent(string InstanceId,long Sequence,long Revision);
public sealed record AssemblyUpsert(string InstanceId,long Sequence,long Revision,AssemblyComponentState Component):AssemblyEvent(InstanceId,Sequence,Revision);
public sealed record AssemblyRemove(string InstanceId,long Sequence,long Revision,string Id):AssemblyEvent(InstanceId,Sequence,Revision);
public sealed record AssemblyLifecycleChange(string InstanceId,long Sequence,long Revision,AssemblyLifecycle Lifecycle):AssemblyEvent(InstanceId,Sequence,Revision);
public sealed record AssemblyVisualMode(string InstanceId,long Sequence,long Revision,string VisualMode):AssemblyEvent(InstanceId,Sequence,Revision);
public sealed record AssemblyState(string InstanceId,long? Sequence,long? Revision,AssemblyLifecycle Lifecycle,string VisualMode,IReadOnlyList<AssemblyComponentState> Components);
public sealed record AssemblyResult(string? Status,string? Error,bool RequestSnapshot,bool NeedsPresentationRebuild,AssemblyState State);

/// <summary>
/// Main-thread-only typed host boundary. Attach to the exact verified compiled root after
/// PipelineVisuals.Create and before inserting visuals. Waits for ready_for_state/assembly_ready,
/// not Node.Ready alone. The host supplies unique owner IDs, genuine snapshots and counters.
/// No game subscriptions, polling, reflection paths, queued state or automated rebuilds.
/// Tree exit is terminal; re-entry needs a newly owned presentation, never a reset/rebind.
/// </summary>
public sealed class AssemblyStateBinding : IDisposable
{
    public const long MaximumCounter=9007199254740991;
    private static readonly ConditionalWeakTable<Node2D,AssemblyStateBinding> Roots=new();
    private static readonly Regex Identifier=new("\\A[A-Za-z][A-Za-z0-9_-]{0,63}\\z",RegexOptions.CultureInvariant);
    private static readonly HashSet<string> Statuses=new(){"applied","ignored","blocked","removed","disposed"};
    private static readonly HashSet<string> Errors=new(){"INVALID_STATE","INVALID_COMPONENT","ASSEMBLY_REJECTED","PRESENTATION_FAULTED","UNBOUND_TRANSPORT","TRANSPORT_BUSY","DISPOSED_TRANSPORT","PRESENTATION_NOT_FAULTED","STALE_RECOVERY_SNAPSHOT","REBUILD_LIMIT_REACHED","REBUILD_FAILED"};
    private readonly Node2D root;
    private readonly Node controller;
    private readonly Callable readyCallback,snapshotCallback,rebuildCallback,exitCallback;
    private bool ownsAuthority;
    private bool reserved;
    public string InstanceId { get; }
    public bool IsBound => ownsAuthority&&!IsDisposed;
    public bool IsDisposed { get; private set; }
    public string? BindingError { get; private set; }
    public AssemblyState? LastAcceptedState { get; private set; }
    public event Action? Bound;
    public event Action<string>? BindingFailed;
    public event Action<string,long,long>? SnapshotRequired;
    public event Action<string>? RebuildRequired;

    private AssemblyStateBinding(Node2D root,Node controller,string owner)
    {
        this.root=root;this.controller=controller;InstanceId=owner;
        readyCallback=Callable.From(TryBind);exitCallback=Callable.From(Dispose);
        snapshotCallback=Callable.From<string,Variant,Variant>((id,seq,rev)=>
        {
            if(IsDisposed||!ownsAuthority||id!=InstanceId)return;
            SnapshotRequired?.Invoke(id,Number(seq,0),Number(rev,0));
        });
        rebuildCallback=Callable.From<string>(id=>{if(!IsDisposed&&ownsAuthority&&id==InstanceId)RebuildRequired?.Invoke(id);});
    }
    private static void MainThread()
    {
        if(OS.GetThreadCallerId()!=OS.GetMainThreadId())throw new InvalidOperationException("Assembly binding must run on the Godot main thread.");
    }
    public static AssemblyStateBinding Attach(Node2D compiledRoot,string instanceId)
    {
        MainThread();ArgumentNullException.ThrowIfNull(compiledRoot);Id(instanceId);
        if(!GodotObject.IsInstanceValid(compiledRoot)||compiledRoot.IsQueuedForDeletion())throw new ArgumentException("Compiled root is unavailable.",nameof(compiledRoot));
        var direct=compiledRoot.GetNodeOrNull<Node>("AssemblyController");
        if(direct==null||direct.GetParent()!=compiledRoot||direct.IsQueuedForDeletion())throw new ArgumentException("Exact root AssemblyController required.",nameof(compiledRoot));
        foreach(var method in new[]{"bind_authoritative","receive_snapshot","receive_event","rebuild_from_snapshot","get_state","dispose_authoritative"})
            if(!direct.HasMethod(method))throw new ArgumentException("Compiled root lacks authoritative assembly API.",nameof(compiledRoot));
        foreach(var signal in new[]{"assembly_ready","snapshot_required","rebuild_required"})
            if(!direct.HasSignal(signal))throw new ArgumentException("Compiled root lacks assembly signals.",nameof(compiledRoot));
        var binding=new AssemblyStateBinding(compiledRoot,direct,instanceId);
        try
        {
            Roots.Add(compiledRoot,binding);binding.reserved=true;
            if(compiledRoot.Connect(Node.SignalName.Ready,binding.readyCallback)!=Godot.Error.Ok||compiledRoot.Connect(Node.SignalName.TreeExiting,binding.exitCallback)!=Godot.Error.Ok)throw new InvalidOperationException("Cannot subscribe root lifetime.");
            binding.Connect("assembly_ready",binding.readyCallback);
            binding.Connect("snapshot_required",binding.snapshotCallback);
            binding.Connect("rebuild_required",binding.rebuildCallback);
            binding.TryBind();return binding;
        }
        catch{binding.Dispose();throw;}
    }
    private void Connect(string signal,Callable callback)
    {
        if(controller.Connect(signal,callback)!=Godot.Error.Ok)throw new InvalidOperationException("Cannot connect "+signal);
    }
    private bool bindingInFlight;
    private void TryBind()
    {
        if(IsDisposed||ownsAuthority||bindingInFlight)return;
        if(!GodotObject.IsInstanceValid(root)||!GodotObject.IsInstanceValid(controller)||controller.GetParent()!=root){FailBinding("Compiled root/controller unavailable.");return;}
        // Subscribe before reading this flag, so deferred initialization cannot be missed.
        if(!root.IsInsideTree()||!root.IsNodeReady()||!controller.Get("ready_for_state").AsBool())return;
        bindingInFlight=true;
        Variant result;try{result=controller.Call("bind_authoritative",InstanceId);}finally{bindingInFlight=false;}
        if(IsDisposed){ownsAuthority=result.VariantType==Variant.Type.Bool&&result.AsBool();IsDisposed=false;Dispose();return;}
        if(result.VariantType!=Variant.Type.Bool||!result.AsBool()){FailBinding("Native authoritative owner binding rejected.");return;}
        ownsAuthority=true;
        if(root.IsConnected(Node.SignalName.Ready,readyCallback))root.Disconnect(Node.SignalName.Ready,readyCallback);Disconnect("assembly_ready",readyCallback);
        Bound?.Invoke();
    }
    private void FailBinding(string message)
    {
        BindingError=message;Dispose();BindingFailed?.Invoke(message);
    }
    private void EnsureBound()
    {
        MainThread();ObjectDisposedException.ThrowIf(IsDisposed,this);
        if(!IsBound)throw new InvalidOperationException("Assembly is not yet bound; wait for Bound.");
        if(!GodotObject.IsInstanceValid(root)||!GodotObject.IsInstanceValid(controller)||controller.GetParent()!=root)throw new InvalidOperationException("Bound root/controller unavailable.");
    }
    private static void Id(string value)
    {
        if(value==null||!Identifier.IsMatch(value))throw new ArgumentException("Expected a bounded stable ID.");
    }
    private static void Counter(long value,long minimum=0)
    {
        if(value<minimum||value>MaximumCounter)throw new ArgumentOutOfRangeException(nameof(value),"Counter outside exact native protocol range.");
    }
    private static string Lifecycle(AssemblyLifecycle value)=>value switch{AssemblyLifecycle.Alive=>"alive",AssemblyLifecycle.Dead=>"dead",AssemblyLifecycle.Removed=>"removed",_=>throw new ArgumentException("Unknown lifecycle.")};
    private static string Damage(AssemblyDamageState value)=>value switch{AssemblyDamageState.Intact=>"intact",AssemblyDamageState.Damaged=>"damaged",AssemblyDamageState.Destroyed=>"destroyed",_=>throw new ArgumentException("Unknown damage state.")};
    private GDictionary Envelope(string owner,long sequence,long revision)
    {
        Id(owner);if(owner!=InstanceId)throw new ArgumentException("Authoritative message belongs to another owner.");Counter(sequence);Counter(revision,1);
        return new GDictionary{{"version",1L},{"instanceId",owner},{"sequence",sequence},{"revision",revision}};
    }
    private static GDictionary Component(AssemblyComponentState component)
    {
        ArgumentNullException.ThrowIfNull(component);foreach(var id in new[]{component.Id,component.Socket,component.Type,component.VisualMode})Id(id);
        Counter(component.Revision,1);if(component.Upgrade<0||component.Upgrade>1000000)throw new ArgumentOutOfRangeException(nameof(component.Upgrade));
        return new GDictionary{{"id",component.Id},{"socket",component.Socket},{"type",component.Type},{"revision",component.Revision},{"damageState",Damage(component.DamageState)},{"upgrade",component.Upgrade},{"visualMode",component.VisualMode}};
    }
    public AssemblyResult ApplySnapshot(AssemblySnapshot snapshot)
    {
        EnsureBound();return Receive("receive_snapshot",SnapshotMessage(snapshot));
    }
    /// <summary>Recover a quarantined presentation using a genuine same-owner full snapshot. Native lifetime attempt limits remain authoritative.</summary>
    public AssemblyResult RebuildFromSnapshot(AssemblySnapshot snapshot)
    {
        EnsureBound();return Receive("rebuild_from_snapshot",SnapshotMessage(snapshot));
    }
    private GDictionary SnapshotMessage(AssemblySnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);var message=Envelope(snapshot.InstanceId,snapshot.Sequence,snapshot.Revision);Id(snapshot.VisualMode);
        var components=new GArray();var ids=new HashSet<string>();foreach(var c in snapshot.Components){ArgumentNullException.ThrowIfNull(c);if(!ids.Add(c.Id))throw new ArgumentException("Duplicate installed component ID.");components.Add(Component(c));}
        if(snapshot.Components.Count>64||snapshot.Lifecycle==AssemblyLifecycle.Removed&&snapshot.Components.Count!=0)throw new ArgumentException("Invalid native snapshot occupancy.");
        message["lifecycle"]=Lifecycle(snapshot.Lifecycle);message["visualMode"]=snapshot.VisualMode;message["components"]=components;
        return message;
    }
    public AssemblyResult ApplyEvent(AssemblyEvent message)
    {
        EnsureBound();ArgumentNullException.ThrowIfNull(message);var envelope=Envelope(message.InstanceId,message.Sequence,message.Revision);
        switch(message)
        {
            case AssemblyUpsert upsert:envelope["type"]="upsert";envelope["payload"]=Component(upsert.Component);break;
            case AssemblyRemove remove:Id(remove.Id);envelope["type"]="remove";envelope["payload"]=new GDictionary{{"id",remove.Id}};break;
            case AssemblyLifecycleChange lifecycle:envelope["type"]="lifecycle";envelope["payload"]=new GDictionary{{"lifecycle",Lifecycle(lifecycle.Lifecycle)}};break;
            case AssemblyVisualMode mode:Id(mode.VisualMode);envelope["type"]="visualMode";envelope["payload"]=new GDictionary{{"visualMode",mode.VisualMode}};break;
            default:throw new ArgumentException("Unsupported authoritative event.");
        }
        return Receive("receive_event",envelope);
    }
    private AssemblyResult Receive(string method,GDictionary message)
    {
        var raw=controller.Call(method,message);if(raw.VariantType!=Variant.Type.Dictionary)throw new InvalidOperationException("Native assembly returned no result dictionary.");
        var result=raw.AsGodotDictionary();bool error=result.ContainsKey("error");
        Fields(result,error?new[]{"error","state","needsPresentationRebuild"}:new[]{"status","requestSnapshot","state"},error?new[]{"error","state"}:null);
        string? status=error?null:Text(result["status"]),code=error?Text(result["error"]):null;
        if(error?!Errors.Contains(code!):!Statuses.Contains(status!))throw new InvalidOperationException("Unknown native assembly result.");
        var state=ReadState(result["state"]);var accepted=new AssemblyResult(status,code,!error&&Bool(result["requestSnapshot"]),result.ContainsKey("needsPresentationRebuild")&&Bool(result["needsPresentationRebuild"]),state);
        if(status=="applied")LastAcceptedState=state;
        return accepted;
    }
    public AssemblyState GetState(){EnsureBound();return ReadState(controller.Call("get_state"));}
    private AssemblyState ReadState(Variant value)
    {
        if(value.VariantType!=Variant.Type.Dictionary)throw new InvalidOperationException("Invalid native state dictionary.");var d=value.AsGodotDictionary();Fields(d,new[]{"version","instanceId","sequence","revision","lifecycle","visualMode","components"});
        if(Number(d["version"],1)!=1||Text(d["instanceId"])!=InstanceId)throw new InvalidOperationException("Native state owner/version mismatch.");
        long? sequence=d["sequence"].VariantType==Variant.Type.Nil?null:Number(d["sequence"],0),revision=d["revision"].VariantType==Variant.Type.Nil?null:Number(d["revision"],1);
        if(sequence.HasValue!=revision.HasValue)throw new InvalidOperationException("Incomplete native authority counters.");
        var lifecycle=Text(d["lifecycle"]) switch{"alive"=>AssemblyLifecycle.Alive,"dead"=>AssemblyLifecycle.Dead,"removed"=>AssemblyLifecycle.Removed,_=>throw new InvalidOperationException("Unknown native lifecycle.")};var mode=Text(d["visualMode"]);Id(mode);
        if(d["components"].VariantType!=Variant.Type.Array)throw new InvalidOperationException("Invalid native components.");var array=d["components"].AsGodotArray();if(array.Count>64)throw new InvalidOperationException("Native occupancy exceeds bound.");var copy=new List<AssemblyComponentState>();var ids=new HashSet<string>();
        foreach(var item in array)
        {
            if(item.VariantType!=Variant.Type.Dictionary)throw new InvalidOperationException("Invalid native component.");var c=item.AsGodotDictionary();Fields(c,new[]{"id","socket","type","revision","damageState","upgrade","visualMode"});
            var damage=Text(c["damageState"]) switch{"intact"=>AssemblyDamageState.Intact,"damaged"=>AssemblyDamageState.Damaged,"destroyed"=>AssemblyDamageState.Destroyed,_=>throw new InvalidOperationException("Invalid native damage state.")};
            var component=new AssemblyComponentState(Text(c["id"]),Text(c["socket"]),Text(c["type"]),Number(c["revision"],1),damage,Number(c["upgrade"],0),Text(c["visualMode"]));Component(component);if(!ids.Add(component.Id))throw new InvalidOperationException("Duplicate native component ID.");copy.Add(component);
        }
        return new AssemblyState(InstanceId,sequence,revision,lifecycle,mode,Array.AsReadOnly(copy.ToArray()));
    }
    private static void Fields(GDictionary d,string[] allowed,string[]? required=null)
    {
        required??=allowed;if(required.Any(k=>!d.ContainsKey(k))||d.Keys.Any(k=>k.VariantType!=Variant.Type.String||!allowed.Contains(k.AsString())))throw new InvalidOperationException("Malformed native protocol fields.");
    }
    private static string Text(Variant value)=>value.VariantType==Variant.Type.String?value.AsString():throw new InvalidOperationException("Native protocol string required.");
    private static bool Bool(Variant value)=>value.VariantType==Variant.Type.Bool?value.AsBool():throw new InvalidOperationException("Native protocol boolean required.");
    private static long Number(Variant value,long minimum)
    {
        if(value.VariantType==Variant.Type.Int){var integer=value.AsInt64();Counter(integer,minimum);return integer;}
        if(value.VariantType==Variant.Type.Float){var number=value.AsDouble();if(!double.IsFinite(number)||number<minimum||number>MaximumCounter||Math.Truncate(number)!=number)throw new InvalidOperationException("Invalid native numeric counter.");return (long)number;}
        throw new InvalidOperationException("Native numeric counter required.");
    }
    private void Disconnect(string signal,Callable callback)
    {
        if(GodotObject.IsInstanceValid(controller)&&controller.IsConnected(signal,callback))controller.Disconnect(signal,callback);
    }
    public void Dispose()
    {
        MainThread();if(IsDisposed)return;IsDisposed=true;
        if(bindingInFlight)return;
        // Disposal may run inside a native mount callback. Only drop ownership
        // after an immediate teardown or an explicit guaranteed-completion ack.
        if(ownsAuthority&&GodotObject.IsInstanceValid(controller))
        {
            try
            {
                var raw=controller.Call("dispose_authoritative");
                if(raw.VariantType!=Variant.Type.Dictionary)throw new InvalidOperationException("Native disposal returned no acknowledgment.");
                var ack=raw.AsGodotDictionary();
                if(!ack.ContainsKey("status"))throw new InvalidOperationException("Native disposal refused authority release.");
                var status=Text(ack["status"]);
                if(status!="disposed"&&(status!="disposal_pending"||!ack.ContainsKey("completionGuaranteed")||!Bool(ack["completionGuaranteed"])))throw new InvalidOperationException("Native disposal did not guarantee completion.");
            }
            catch{IsDisposed=false;BindingError="Native disposal did not acknowledge authority release.";throw;}
        }
        if(GodotObject.IsInstanceValid(root)){if(root.IsConnected(Node.SignalName.Ready,readyCallback))root.Disconnect(Node.SignalName.Ready,readyCallback);if(root.IsConnected(Node.SignalName.TreeExiting,exitCallback))root.Disconnect(Node.SignalName.TreeExiting,exitCallback);}
        Disconnect("assembly_ready",readyCallback);Disconnect("snapshot_required",snapshotCallback);Disconnect("rebuild_required",rebuildCallback);
        ownsAuthority=false;if(reserved){Roots.Remove(root);reserved=false;}
    }
}

