using System;
using System.IO;
using Godot;
using CharacterPipeline.Sts2;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Entities.Players;
public partial class CreatureAssemblyHarness : Node
{
 private int checks;
 private void Check(bool condition,string label){if(!condition)throw new Exception(label);checks++;}
 private sealed class FixtureAuthority : ICreatureAssemblyAuthority
 {
  public string InstanceId {get;} public long Sequence; public long Revision=1; public int Captures; public bool Disposed;
  public AssemblyComponentState[] Components=Array.Empty<AssemblyComponentState>(); public Action? DuringCapture; public event Action<AssemblySnapshot>? SnapshotAvailable;
  public event Action<AssemblyEvent>? EventAvailable;
  public FixtureAuthority(string id){InstanceId=id;}
  public AssemblySnapshot CaptureSnapshot(long minSequence,long minRevision){Captures++;DuringCapture?.Invoke();Sequence=Math.Max(Sequence,minSequence);Revision=Math.Max(Revision,minRevision);return new(InstanceId,Sequence,Revision,AssemblyLifecycle.Alive,"idle",Components);}
  public void Emit(AssemblyEvent e)=>EventAvailable?.Invoke(e);
  public void Refresh()=>SnapshotAvailable?.Invoke(CaptureSnapshot(Sequence,Revision));
  public void Dispose(){Disposed=true;}
 }
 public override async void _Ready(){try{
  var packed=ResourceLoader.Load<PackedScene>("res://character.tscn");var root=packed.Instantiate<Node2D>();var visuals=PipelineVisuals.Create(root,new Rect2(0,0,32,32));
  PipelineVisuals.TryGetReceipt(visuals,out var receipt);var creature=new Creature((Player)null!,10,10);var source=new FixtureAuthority("fixtureOwner");
  source.Components=new[]{new AssemblyComponentState("arm","left","red",1,AssemblyDamageState.Intact,0,"idle")};
  using var session=CreatureAssemblyBinding.Attach(creature,receipt!,source);
  Check(!session.Binding.IsBound && source.Captures==0,"no invented snapshot before ready");
    var unusedRoot=packed.Instantiate<Node2D>();var unusedVisuals=PipelineVisuals.Create(unusedRoot,new Rect2(0,0,32,32));PipelineVisuals.TryGetReceipt(unusedVisuals,out var unusedReceipt);
  var duplicateSource=new FixtureAuthority("differentOwner");
  try{CreatureAssemblyBinding.Attach(creature,unusedReceipt!,duplicateSource);throw new Exception("duplicate creature accepted");}catch(ArgumentException){checks++;}
  Check(!duplicateSource.Disposed,"rejected unused authority remains caller owned");
  var otherCreature=new Creature((Player)null!,10,10);
  try{CreatureAssemblyBinding.Attach(otherCreature,unusedReceipt!,source);throw new Exception("duplicate source accepted");}catch(ArgumentException){checks++;}
  try{CreatureAssemblyBinding.Attach(otherCreature,unusedReceipt!,new FixtureAuthority(source.InstanceId));throw new Exception("duplicate owner accepted");}catch(ArgumentException){checks++;}
  unusedVisuals.Free();
  AddChild(visuals);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
  Check(session.Binding.LastAcceptedState?.Sequence==0 && source.Captures==1,"bound captures genuine initial snapshot");
  source.Emit(new AssemblyVisualMode(source.InstanceId,3,3,"idle"));
  Check(source.Captures==2 && session.Binding.LastAcceptedState?.Sequence==3,"gap refresh uses genuine source floors without native recursion");
    var threadRejected=await System.Threading.Tasks.Task.Run(()=>{try{source.Emit(new AssemblyVisualMode(source.InstanceId,4,4,"idle"));return false;}catch(InvalidOperationException){return true;}});
  Check(threadRejected&&session.Binding.LastAcceptedState?.Sequence==3,"off-thread callbacks reject before state mutation");
    var controller=root.GetNode("AssemblyController");var native=(Node)controller.Get("native").AsGodotObject();var registry=native.Get("registry").AsGodotDictionary();var savedBlue=registry["blue"];
  var departing=(Node)native.Call("component_at","left").AsGodotObject();departing.TreeExiting+=()=>registry.Remove("blue");
  source.Sequence=4;source.Revision=4;source.Components=new[]{source.Components[0] with{Type="blue",Revision=2}};source.DuringCapture=()=>registry["blue"]=savedBlue;
  source.Emit(new AssemblyUpsert(source.InstanceId,4,4,source.Components[0]));source.DuringCapture=null;
  Check(!session.IsDisposed&&session.Binding.LastAcceptedState?.Sequence==4&&session.Binding.LastAcceptedState.Components[0].Type=="blue"&&!controller.Get("faulted").AsBool(),"real post-unmount fault routes genuine snapshot into native rebuild");
  foreach(var eventName in new[]{"Died","Revived"}){
   var callback=(Action<Creature>?)typeof(Creature).GetField(eventName,System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!.GetValue(creature);callback?.Invoke(creature);
  }
  Check(source.Captures==5&&session.Binding.LastAcceptedState?.Sequence==4&&session.Binding.LastAcceptedState?.Lifecycle==AssemblyLifecycle.Alive,"fixture death/revival notifications refresh without manufacturing counters or lifecycle");
  RemoveChild(visuals);Check(session.IsDisposed&&source.Disposed,"visual tree exit disposes authority and subscriptions");
  source.Emit(new AssemblyVisualMode(source.InstanceId,4,4,"idle"));Check(session.Binding.LastAcceptedState?.Sequence==4,"disposed source cannot mutate presentation");visuals.Free();
    var boundedRoot=packed.Instantiate<Node2D>();var boundedVisuals=PipelineVisuals.Create(boundedRoot,new Rect2(0,0,32,32));PipelineVisuals.TryGetReceipt(boundedVisuals,out var boundedReceipt);var boundedSource=new FixtureAuthority("boundedOwner");
  boundedSource.DuringCapture=()=>boundedSource.Refresh();
  // Refresh() itself captures, so emit a genuine event directly inside capture instead.
  boundedSource.DuringCapture=()=>boundedSource.Emit(new AssemblyVisualMode("boundedOwner",0,1,"idle"));
  using var bounded=CreatureAssemblyBinding.Attach(creature,boundedReceipt!,boundedSource);AddChild(boundedVisuals);
  await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
  Check(bounded.IsDisposed&&boundedSource.Disposed&&boundedSource.Captures==4&&bounded.LastError!.Contains("bounded"),"reentrant refresh requests are coalesced and bounded");boundedVisuals.Free();
  var invalidRoot=new Node2D();var tree=new AnimationTree{Name="AnimationTree",TreeRoot=new AnimationNodeStateMachine()};invalidRoot.AddChild(tree);
  var invalidVisuals=PipelineVisuals.Create(invalidRoot,new Rect2(0,0,1,1));PipelineVisuals.TryGetReceipt(invalidVisuals,out var invalidReceipt);var invalidSource=new FixtureAuthority("failureOwner");
  try{CreatureAssemblyBinding.Attach(creature,invalidReceipt!,invalidSource);throw new Exception("missing assembly API accepted");}catch(ArgumentException){checks++;}
  Check(invalidSource.Disposed,"failed attachment releases acquired authority lifetime");invalidVisuals.Free();
    var pendingRoot=packed.Instantiate<Node2D>();var pendingVisuals=PipelineVisuals.Create(pendingRoot,new Rect2(0,0,32,32));PipelineVisuals.TryGetReceipt(pendingVisuals,out var pendingReceipt);var pendingSource=new FixtureAuthority("pendingOwner");
  using var pending=CreatureAssemblyBinding.Attach(creature,pendingReceipt!,pendingSource);
  pendingSource.Emit(new AssemblyVisualMode("pendingOwner",7,8,"idle"));
  AddChild(pendingVisuals);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
  Check(pending.Binding.LastAcceptedState?.Sequence==7&&pending.Binding.LastAcceptedState?.Revision==8,"pre-bound genuine event floors retained for first capture");
  pendingSource.Emit(new AssemblyVisualMode("wrongOwner",900,900,"idle"));
  Check(pending.IsDisposed&&pendingSource.Disposed,"foreign callback disposes without advancing authority");pendingVisuals.Free();
  var reentrantRoot=packed.Instantiate<Node2D>();var reentrantVisuals=PipelineVisuals.Create(reentrantRoot,new Rect2(0,0,32,32));PipelineVisuals.TryGetReceipt(reentrantVisuals,out var reentrantReceipt);var reentrantSource=new FixtureAuthority("reentrantOwner");
  reentrantSource.DuringCapture=()=>reentrantSource.Emit(new AssemblyVisualMode("wrongOwner",900,900,"idle"));
  using var reentrant=CreatureAssemblyBinding.Attach(creature,reentrantReceipt!,reentrantSource);AddChild(reentrantVisuals);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
  Check(reentrant.IsDisposed&&reentrant.Binding.LastAcceptedState==null,"foreign reentrant callback cannot bootstrap state");reentrantVisuals.Free();
  File.WriteAllText(ProjectSettings.GlobalizePath("res://result.json"),"{\"passed\":true,\"checks\":"+checks+"}");GetTree().Quit();
 }catch(Exception e){GD.PushError(e.ToString());GetTree().Quit(1);}}
}



