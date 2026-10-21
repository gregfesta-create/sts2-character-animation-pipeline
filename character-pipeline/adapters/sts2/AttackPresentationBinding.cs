using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Godot;
using GDictionary=Godot.Collections.Dictionary;
using GArray=Godot.Collections.Array;

namespace CharacterPipeline.Sts2;

public sealed record AttackBindingFact(bool Present,double Amount);
public sealed record AttackPresentationTarget(bool Valid,Vector2 Position);
public sealed record AttackPresentationRequest(string ActionId,string Generation,string ClipId,AttackPresentationTarget Target,double ReleaseAt,double ImpactAt,long ObservationSequence);

/// <summary>
/// Explicit presentation-only gameplay boundary. The owning gameplay code must
/// observe and begin BEFORE consuming charges, select the real target/timing,
/// confirm actual impacts, and advance the monotonic presentation clock. This
/// facade never deals damage, changes powers, guesses targets or controls game waits.
/// Generation tokens are strings; action IDs remain unique for the native root's
/// lifetime even across generations. Attach only after the exact compiled root
/// and optional deferred effect controller are ready. Tree exit is terminal.
/// </summary>
public sealed class AttackPresentationBinding : IDisposable
{
 private const long MaximumCounter=9007199254740991;
 private static readonly Regex Token=new("\\A[A-Za-z][A-Za-z0-9_-]{0,63}\\z",RegexOptions.CultureInvariant);
 private static readonly ConditionalWeakTable<Node2D,AttackPresentationBinding> Roots=new();
 private readonly PipelineVisuals.OwnershipReceipt receipt;
 private readonly Node2D root;
 private readonly Node actions;
 private readonly Node? effects;
 private readonly Callable releaseCallback,exitCallback;
 private readonly Dictionary<string,Attack> attacks=new();
 private string? current;
 private double clock;
 private sealed class Attack
 {
  public AttackPresentationRequest Request {get;}
  public Dictionary<string,string> Sockets {get;}
  public Dictionary<string,Projectile> Projectiles {get;}=new();
  public Dictionary<string,string> ReleasedSockets {get;}=new(StringComparer.Ordinal);
  public Dictionary<string,string[]> Selected {get;}
  public bool Completed;
  public Attack(AttackPresentationRequest request,Dictionary<string,string> sockets,Dictionary<string,string[]> selected){Request=request;Sockets=sockets;Selected=selected;}
 }
 private sealed record Projectile(Node2D Node,Callable Exit);
 public string CharacterInstance {get;}
 public bool IsDisposed {get;private set;}
 public string? LastError {get;private set;}
 public int RetainedProjectileCount=>attacks.Values.Sum(a=>a.Projectiles.Count);
 private AttackPresentationBinding(PipelineVisuals.OwnershipReceipt receipt,Node2D root,Node actions,Node? effects,string owner)
 {
  this.receipt=receipt;this.root=root;this.actions=actions;this.effects=effects;CharacterInstance=owner;
  releaseCallback=Callable.From<string,string,Node2D>(Released);exitCallback=Callable.From(Dispose);
  actions.Connect("projectile_released",releaseCallback);root.Connect(Node.SignalName.TreeExiting,exitCallback);
 }
 private static void MainThread(){if(OS.GetThreadCallerId()!=OS.GetMainThreadId())throw new InvalidOperationException("Attack presentation requires the Godot main thread.");}
 private static void Id(string value){if(value==null||!Token.IsMatch(value))throw new ArgumentException("A bounded stable ID is required.");}
 private static void Counter(long value){if(value<0||value>MaximumCounter)throw new ArgumentOutOfRangeException(nameof(value));}
 private static void Target(AttackPresentationTarget value,bool requireValid){if(value==null||requireValid&&!value.Valid||!value.Position.IsFinite()||Math.Abs(value.Position.X)>1000000||Math.Abs(value.Position.Y)>1000000)throw new ArgumentException("A valid bounded captured target is required.");}
 public static AttackPresentationBinding Attach(PipelineVisuals.OwnershipReceipt receipt)
 {
  MainThread();ArgumentNullException.ThrowIfNull(receipt);
  if(!receipt.TryGetPair(out _,out var root)||root==null||!root.IsInsideTree()||!root.IsNodeReady()||Roots.TryGetValue(root,out _))throw new ArgumentException("Exact ready factory-owned root required; an attack binding is terminal.");
  var actions=root.GetNodeOrNull("ActionController");var effects=root.GetNodeOrNull("EffectController");
  if(actions==null||!actions.IsNodeReady()||!root.HasMethod("begin_action")||!root.HasMethod("play_animation")||!actions.HasSignal("projectile_released"))throw new ArgumentException("Compiled action runtime is unavailable.");
  string owner="action-"+root.GetInstanceId();
  if(effects!=null){if(!effects.Get("ready_for_effects").AsBool())throw new ArgumentException("Deferred effects are not ready.");owner=effects.Call("status").AsGodotDictionary()["characterInstance"].AsString();}
  if(string.IsNullOrEmpty(owner)||owner.Length>128)throw new ArgumentException("Invalid native presentation owner.");
  var binding=new AttackPresentationBinding(receipt,root,actions,effects,owner);Roots.Add(root,binding);return binding;
 }
 private void Check()
 {
  MainThread();ObjectDisposedException.ThrowIf(IsDisposed,this);
  if(!receipt.TryGetPair(out _,out var owned)||owned!=root||!root.IsInsideTree()||root.GetNodeOrNull("ActionController")!=actions||root.GetNodeOrNull("EffectController")!=effects){Dispose();throw new ObjectDisposedException(nameof(AttackPresentationBinding));}
 }
 private static GDictionary NativeTarget(AttackPresentationTarget target)=>new(){{"valid",target.Valid},{"position",new GArray{target.Position.X,target.Position.Y}}};
 public bool Observe(string adapterContractVersion,long sequence,IReadOnlyDictionary<string,AttackBindingFact> bindings)
 {
  Check();Counter(sequence);ArgumentNullException.ThrowIfNull(bindings);
  if(string.IsNullOrEmpty(adapterContractVersion)||adapterContractVersion.Length>256||bindings.Count>64)throw new ArgumentException("Bounded authoritative facts required.");
  var facts=new GDictionary();foreach(var pair in bindings.Take(65)){Id(pair.Key);if(pair.Value==null||!double.IsFinite(pair.Value.Amount)||Math.Abs(pair.Value.Amount)>1000000||facts.ContainsKey(pair.Key))throw new ArgumentException("Invalid authoritative binding fact.");facts[pair.Key]=new GDictionary{{"present",pair.Value.Present},{"amount",pair.Value.Amount}};}
  if(facts.Count>64)throw new ArgumentException("Binding fact budget exceeded.");
  return effects!=null&&effects.Call("observe",new GDictionary{{"characterInstance",CharacterInstance},{"adapterContractVersion",adapterContractVersion},{"sequence",sequence},{"bindings",facts}}).AsBool();
 }
 public bool BeginAttack(AttackPresentationRequest request)
 {
  Check();ArgumentNullException.ThrowIfNull(request);Id(request.ActionId);Id(request.Generation);Id(request.ClipId);Counter(request.ObservationSequence);Target(request.Target,true);
  if(!double.IsFinite(request.ReleaseAt)||!double.IsFinite(request.ImpactAt)||request.ReleaseAt<0||request.ImpactAt<=request.ReleaseAt||request.ImpactAt>10)throw new ArgumentException("Require an explicit bounded release/impact schedule.");
  if(attacks.ContainsKey(request.ActionId)||attacks.Count>=32){LastError="ACTION_ID_OR_CAPACITY";return false;}
  var metadata=root.Get("clip_metadata").AsGodotDictionary();if(!metadata.ContainsKey(request.ClipId)){LastError="UNKNOWN_CLIP";return false;}
  var sockets=new Dictionary<string,string>();foreach(var item in metadata[request.ClipId].AsGodotDictionary()["events"].AsGodotArray()){
   var e=item.AsGodotDictionary();if(!e.ContainsKey("type")||e["type"].AsString()!="projectile")continue;
   if(Math.Abs(e["time"].AsDouble()-request.ReleaseAt)>0.00001){LastError="UNSUPPORTED_RELEASE_TIMING";return false;}
   sockets.Add(e["id"].AsString(),e["payload"].AsGodotDictionary()["sourceSocket"].AsString());
  }
  if(sockets.Count==0){LastError="PROJECTILE_CLIP_REQUIRED";return false;}
  var context=new GDictionary{{"characterInstance",CharacterInstance},{"actionInstance",request.ActionId},{"generation",request.Generation},{"target",NativeTarget(request.Target)},{"releaseAt",request.ReleaseAt},{"impactAt",request.ImpactAt}};
  // Capture before begin/play. Later observations cannot recolor this snapshot.
  var selected=new Dictionary<string,string[]>(StringComparer.Ordinal);
  if(effects!=null){var capture=context.Duplicate(true);capture["preConsumption"]=true;capture["observationSequence"]=request.ObservationSequence;var snapshot=effects.Call("capture_attack",capture).AsGodotDictionary();if(snapshot.Count==0){LastError="SNAPSHOT_REJECTED";return false;}try{selected=CopySelected(snapshot);}catch{effects.Call("cancel_attack",request.ActionId,request.Generation);LastError="SNAPSHOT_SELECTION_REJECTED";return false;}}
  if(!root.Call("begin_action",context).AsBool()){effects?.Call("cancel_attack",request.ActionId,request.Generation);LastError="ACTION_CONTEXT_REJECTED";return false;}
  if(current!=null&&attacks.TryGetValue(current,out var previous)){previous.Completed=true;effects?.Call("complete_attack",current,previous.Request.Generation);if(previous.Projectiles.Count==0)attacks.Remove(current);}
  attacks[request.ActionId]=new Attack(request,sockets,selected);current=request.ActionId;
  if(!root.Call("play_animation",request.ClipId).AsBool()){CancelAttack(request.ActionId);LastError="PLAYBACK_REJECTED";return false;}
  LastError=null;return true;
 }
 private void Released(string actionId,string cueId,Node2D projectile)
 {
  if(IsDisposed)return;
  if(!attacks.TryGetValue(actionId,out var attack)||!attack.Sockets.TryGetValue(cueId,out var socket)||attack.Projectiles.ContainsKey(cueId)){LastError="UNBOUND_PROJECTILE";projectile.QueueFree();return;}
  attack.ReleasedSockets[cueId]=socket;
  if(effects!=null&&(effects.Call("mark_released",actionId,attack.Request.Generation).AsGodotDictionary().Count==0||effects.Call("retain_projectile",actionId,attack.Request.Generation,cueId,socket,projectile).AsGodotDictionary().Count==0)){LastError="PROJECTILE_SNAPSHOT_REJECTED";projectile.QueueFree();return;}
  var callback=Callable.From(()=>Release(actionId,cueId));attack.Projectiles[cueId]=new Projectile(projectile,callback);projectile.Connect(Node.SignalName.TreeExiting,callback);
 }
 private void Release(string actionId,string cueId)
 {
  if(IsDisposed||!attacks.TryGetValue(actionId,out var attack)||!attack.Projectiles.Remove(cueId,out var projectile))return;
  if(GodotObject.IsInstanceValid(projectile.Node)&&projectile.Node.IsConnected(Node.SignalName.TreeExiting,projectile.Exit))projectile.Node.Disconnect(Node.SignalName.TreeExiting,projectile.Exit);
  effects?.Call("release_projectile",actionId,attack.Request.Generation,cueId);if(attack.Completed&&attack.Projectiles.Count==0)attacks.Remove(actionId);
 }
 public bool UpdateTarget(string actionId,AttackPresentationTarget target){Check();Id(actionId);Target(target,false);return attacks.ContainsKey(actionId)&&root.Call("update_action_target",actionId,NativeTarget(target)).AsBool();}
 private static Dictionary<string,string[]> CopySelected(GDictionary snapshot)
 {
  var copy=new Dictionary<string,HashSet<string>>(StringComparer.Ordinal);
  foreach(var value in snapshot["selectedEffects"].AsGodotArray()){
   var selection=value.AsGodotDictionary();string socket=selection["socketId"].AsString();Id(socket);
   if(!copy.TryGetValue(socket,out var ids)){if(copy.Count>=64)throw new ArgumentException();copy.Add(socket,ids=new(StringComparer.Ordinal));}
   foreach(var item in selection["effectIds"].AsGodotArray()){string id=item.AsString();Id(id);ids.Add(id);if(ids.Count>8)throw new ArgumentException();}
  }
  return copy.ToDictionary(p=>p.Key,p=>p.Value.ToArray(),StringComparer.Ordinal);
 }
 public bool ConfirmImpact(string actionId,string cueId,double actionClock,Vector2 position)=>Confirm(actionId,cueId,null,actionClock,position);
 public bool ConfirmImpact(string actionId,string cueId,string releaseCueId,double actionClock,Vector2 position){Id(releaseCueId);return Confirm(actionId,cueId,releaseCueId,actionClock,position);}
 private bool Confirm(string actionId,string cueId,string? releaseCueId,double actionClock,Vector2 position)
 {
  Check();Id(actionId);Id(cueId);Target(new(true,position),true);if(!double.IsFinite(actionClock)||actionClock<0||actionClock>600)throw new ArgumentException("Invalid authoritative action clock.");
  if(!attacks.TryGetValue(actionId,out var attack))return false;
  var value=new GDictionary{{"clock",actionClock},{"position",new GArray{position.X,position.Y}}};if(releaseCueId!=null)value["releaseCue"]=releaseCueId;
  if(!root.Call("authoritative_hit",actionId,cueId,value).AsBool())return false;
  // Native hit signals may cancel or dispose this exact action synchronously.
  if(IsDisposed||!attacks.TryGetValue(actionId,out var retained)||!ReferenceEquals(attack,retained)||effects==null||!GodotObject.IsInstanceValid(effects)||!effects.HasMethod("confirm_impact"))return true;
  string? socket=null;
  if(releaseCueId!=null)attack.ReleasedSockets.TryGetValue(releaseCueId,out socket);
  else {var sources=attack.ReleasedSockets.Values.Distinct(StringComparer.Ordinal).Take(2).ToArray();if(sources.Length==1)socket=sources[0];else if(sources.Length>1){Diagnostic("ambiguous_source");return true;}}
  if(socket==null)return true;
  var ids=new Godot.Collections.Array<string>();if(attack.Selected.TryGetValue(socket,out var captured))foreach(var id in captured)ids.Add(id);
  try{if(!effects.Call("confirm_impact",actionId,attack.Request.Generation,cueId,position,ids).AsBool())Diagnostic("presentation_rejected");}catch{Diagnostic("presentation_failed");}
  return true;
 }
 private void Diagnostic(string code){try{if(effects!=null&&GodotObject.IsInstanceValid(effects)&&effects.HasMethod("report_impact_diagnostic"))effects.Call("report_impact_diagnostic",code);}catch{/* Optional graphics never change confirmed-hit success. */}}
 public bool CompleteAttack(string actionId){Check();Id(actionId);if(!attacks.TryGetValue(actionId,out var attack))return false;attack.Completed=true;effects?.Call("complete_attack",actionId,attack.Request.Generation);if(attack.Projectiles.Count==0)attacks.Remove(actionId);return true;}
 public bool CancelAttack(string actionId)
 {
  Check();Id(actionId);if(!attacks.TryGetValue(actionId,out var attack))return false;
  if(current==actionId){root.Call("cancel_action");current=null;}
  foreach(var pair in attack.Projectiles.ToArray()){var projectile=pair.Value.Node;Release(actionId,pair.Key);if(GodotObject.IsInstanceValid(projectile))projectile.Call("expire_projectile");}
  effects?.Call("cancel_attack",actionId,attack.Request.Generation);attacks.Remove(actionId);return true;
 }
 public bool AdvanceClock(double monotonicSeconds){Check();if(!double.IsFinite(monotonicSeconds)||monotonicSeconds<clock)throw new ArgumentException("Presentation clock must be finite and monotonic.");clock=monotonicSeconds;return effects==null||effects.Call("advance",clock).AsBool();}
 public void Dispose()
 {
  MainThread();if(IsDisposed)return;IsDisposed=true;
  if(GodotObject.IsInstanceValid(actions)&&actions.IsConnected("projectile_released",releaseCallback))actions.Disconnect("projectile_released",releaseCallback);
  if(GodotObject.IsInstanceValid(root)&&root.IsConnected(Node.SignalName.TreeExiting,exitCallback))root.Disconnect(Node.SignalName.TreeExiting,exitCallback);
  foreach(var attack in attacks.Values)foreach(var projectile in attack.Projectiles.Values)if(GodotObject.IsInstanceValid(projectile.Node)){
   if(projectile.Node.IsConnected(Node.SignalName.TreeExiting,projectile.Exit))projectile.Node.Disconnect(Node.SignalName.TreeExiting,projectile.Exit);
   if(projectile.Node.HasMethod("expire_projectile"))projectile.Node.Call("expire_projectile");
  }
  // Do not call the public checked methods here: teardown must also work after
  // receipt/controller ownership has been lost, without recursive Dispose.
  if(GodotObject.IsInstanceValid(actions)&&GodotObject.IsInstanceValid(root)&&actions.GetParent()==root&&actions.HasMethod("cancel_action"))actions.Call("cancel_action");
  if(effects!=null&&GodotObject.IsInstanceValid(effects))effects.Call("dispose");attacks.Clear();current=null;
 }
}
