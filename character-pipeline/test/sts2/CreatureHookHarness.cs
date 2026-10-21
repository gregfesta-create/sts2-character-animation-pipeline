using System;
using System.IO;
using System.Reflection;
using System.Linq;
using Godot;
using HarmonyLib;
using CharacterPipeline.Sts2;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.Nodes.Combat;
public partial class CreatureHookHarness : Node
{
 private int checks;
 private static Func<Creature,NCreatureVisuals?>? Fixture;
 private static bool FixturePrefix(Creature __instance,ref NCreatureVisuals? __result){__result=Fixture!(__instance);return false;}
 private void Check(bool value,string label){if(!value)throw new Exception(label);checks++;}
 private sealed class Authority : ICreatureAssemblyAuthority
 {
  public string InstanceId{get;} public bool Disposed;public bool FailCapture;public int DisposeCount;public bool ThrowDispose;
  public Authority(string id){InstanceId=id;}
  public event Action<AssemblySnapshot>? SnapshotAvailable;
  public event Action<AssemblyEvent>? EventAvailable;
  public AssemblySnapshot CaptureSnapshot(long sequence,long revision){if(FailCapture)throw new Exception("fixture capture failure");return new(InstanceId,sequence,revision,AssemblyLifecycle.Alive,"idle",Array.Empty<AssemblyComponentState>());}
  public void Dispose(){Disposed=true;DisposeCount++;if(ThrowDispose)throw new Exception("fixture disposal failure");}
 }
 public override async void _Ready(){var fixtureHarmony=new Harmony("characterpipeline.fixture.creaturehook");try{
  var target=typeof(Creature).GetMethod("CreateVisuals",Type.EmptyTypes)!;
  fixtureHarmony.Patch(target,prefix:new HarmonyMethod(typeof(CreatureHookHarness).GetMethod(nameof(FixturePrefix),BindingFlags.Static|BindingFlags.NonPublic)));
  var packed=ResourceLoader.Load<PackedScene>("res://character.tscn");Fixture=_=>PipelineVisuals.Create(packed.Instantiate<Node2D>(),new Rect2(0,0,32,32));
  var errors=0;using var hooks=CreatureAssemblyHooks.Install("characterpipeline.fixture.binding",(_,_,_)=>errors++);
  var creature=new Creature((Player)null!,10,10);Authority? source=null;
  var ignored=creature.CreateVisuals()!;Check(!hooks.TryGetSession(creature,out _),"unregistered factory visuals untouched");ignored.Free();
  using var registration=hooks.Register(c=>ReferenceEquals(c,creature),(c,r)=>source=new Authority("hookOwner"));
  var visuals=creature.CreateVisuals()!;Check(hooks.TryGetSession(creature,out var session)&&!session!.Binding.IsBound,"real installed postfix attaches before insertion");
  AddChild(visuals);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
  Check(session!.Binding.LastAcceptedState?.Revision==1,"postfix session consumes genuine authority after readiness");
  registration.Dispose();Check(source!.Disposed&&session.IsDisposed&&!hooks.TryGetSession(creature,out _),"unregister disposes sessions");visuals.Free();
    Check(errors==0,"successful fixture has no errors");
  using(var foreignRegistration=hooks.Register(_=>true,(c,r)=>throw new Exception("must not call for nonfactory"))){Fixture=_=>new NCreatureVisuals();var foreign=creature.CreateVisuals()!;Check(errors==0&&!hooks.TryGetSession(creature,out _),"nonfactory visuals untouched");foreign.Free();}
  Fixture=_=>PipelineVisuals.Create(packed.Instantiate<Node2D>(),new Rect2(0,0,32,32));
  using(var failing=hooks.Register(_=>true,(c,r)=>throw new Exception("fixture factory failure"))){var failed=creature.CreateVisuals()!;Check(errors==1&&!hooks.TryGetSession(creature,out _),"factory failure reported without game call throwing");failed.Free();}
  Authority? failingSource=null;
  using(var failing=hooks.Register(_=>true,(c,r)=>failingSource=new Authority("captureFailure"){FailCapture=true})){
   var failed=creature.CreateVisuals()!;Check(hooks.TryGetSession(creature,out var failureSession),"deferred failure initially reserved");int closed=0;failureSession!.Closed+=_=>{closed++;failureSession.Dispose();};failureSession.Closed+=_=>throw new Exception("fixture observer failure");
   AddChild(failed);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
   Check(failingSource!.DisposeCount==1&&failureSession.IsDisposed&&closed==1&&!hooks.TryGetSession(creature,out _)&&errors==2,"deferred capture failure reports and releases session once despite observer failure");failed.Free();
  }
  IDisposable? selfRemoving=null;Authority? abandoned=null;
  selfRemoving=hooks.Register(_=>true,(c,r)=>{selfRemoving!.Dispose();return abandoned=new Authority("abandonedOwner");});
  var abandonedVisuals=creature.CreateVisuals()!;Check(abandoned!.DisposeCount==1&&!hooks.TryGetSession(creature,out _),"unregister during factory disposes newly acquired authority");abandonedVisuals.Free();
  Authority? reentrantSource=null;NCreatureVisuals? nested=null;
  using(var reentrant=hooks.Register(_=>true,(c,r)=>{nested=c.CreateVisuals();return reentrantSource=new Authority("reentrantOwner");})){
   var outer=creature.CreateVisuals()!;Check(hooks.TryGetSession(creature,out _)&&errors==3,"reentrant same-creature creation rejects pending duplicate");nested!.Free();
   var duplicate=creature.CreateVisuals()!;Check(errors==4,"duplicate active creation reported");duplicate.Free();outer.Free();
  }
  // Detached nodes never emit TreeExiting; unregister still owns their terminal cleanup.
  Check(reentrantSource!.DisposeCount==1,"unregister cleans detached session");
    Authority? sharedSource=null;var otherCreature=new Creature((Player)null!,10,10);
  using(var shared=hooks.Register(_=>true,(c,r)=>sharedSource??=new Authority("sharedOwner"))){var first=creature.CreateVisuals()!;var second=otherCreature.CreateVisuals()!;Check(sharedSource!.DisposeCount==0&&hooks.TryGetSession(creature,out _)&&!hooks.TryGetSession(otherCreature,out _),"factory cannot steal or dispose active authority");first.Free();second.Free();}
  Authority? rejectedSource=null;
  Fixture=_=>{var invalid=new Node2D();invalid.AddChild(new AnimationTree{Name="AnimationTree",TreeRoot=new AnimationNodeStateMachine()});return PipelineVisuals.Create(invalid,new Rect2(0,0,1,1));};
  using(var invalidRegistration=hooks.Register(_=>true,(c,r)=>rejectedSource=new Authority("invalidRootOwner"))){var invalid=creature.CreateVisuals()!;Check(rejectedSource!.DisposeCount==1&&!hooks.TryGetSession(creature,out _),"failed bridge acquisition disposes transferred authority exactly once");invalid.Free();}
  Fixture=_=>PipelineVisuals.Create(packed.Instantiate<Node2D>(),new Rect2(0,0,32,32));
  int beforeAmbiguous=errors;using(var matchA=hooks.Register(_=>true,(c,r)=>throw new Exception("ambiguous factory must not execute")))using(var matchB=hooks.Register(_=>true,(c,r)=>throw new Exception("ambiguous factory must not execute"))){var ambiguous=creature.CreateVisuals()!;Check(errors==beforeAmbiguous+1&&!hooks.TryGetSession(creature,out _),"ambiguous registrations reject without authority factory");ambiguous.Free();}
  var cappedVisuals=new System.Collections.Generic.List<NCreatureVisuals>();var cappedSources=new System.Collections.Generic.List<Authority>();
  using(var capRegistration=hooks.Register(_=>true,(c,r)=>{var created=new Authority("capOwner"+cappedSources.Count);cappedSources.Add(created);return created;})){
   for(int i=0;i<128;i++)cappedVisuals.Add(new Creature((Player)null!,10,10).CreateVisuals()!);
   int beforeCap=errors;var overflow=new Creature((Player)null!,10,10).CreateVisuals()!;Check(cappedSources.Count==128&&errors==beforeCap+1,"active and pending session capacity bounded to 128");overflow.Free();
  }
  Check(cappedSources.All(s=>s.DisposeCount==1),"capacity unregister disposes every owned authority once");foreach(var cappedVisual in cappedVisuals)cappedVisual.Free();
  var registrations=new System.Collections.Generic.List<IDisposable>();for(int i=0;i<64;i++)registrations.Add(hooks.Register(_=>false,(c,r)=>new Authority("unused")));
  try{hooks.Register(_=>false,(c,r)=>new Authority("unused"));throw new Exception("registration limit absent");}catch(InvalidOperationException){checks++;}foreach(var item in registrations)item.Dispose();
  Check(Harmony.GetPatchInfo(target)!.Owners.Contains("characterpipeline.fixture.creaturehook"),"fixture prefix remains owned separately");
  hooks.Dispose();Check(!Harmony.HasAnyPatches("characterpipeline.fixture.binding")&&Harmony.HasAnyPatches(fixtureHarmony.Id),"disposal removes only own postfix");
    using(var throwingReporter=CreatureAssemblyHooks.Install("characterpipeline.fixture.reporting",(_,_,_)=>throw new Exception("fixture reporter failure"))){using var failure=throwingReporter.Register(_=>true,(c,r)=>throw new Exception("fixture factory failure"));var output=creature.CreateVisuals()!;Check(throwingReporter.LastError!.Contains("reporter failed"),"reporter exceptions retained without breaking creature creation");output.Free();}
  var disposingHooks=CreatureAssemblyHooks.Install("characterpipeline.fixture.disposing",(_,_,_)=>{});Authority? disposedDuringFactory=null;
  using(var disposingRegistration=disposingHooks.Register(_=>true,(c,r)=>{disposingHooks.Dispose();return disposedDuringFactory=new Authority("disposedDuringFactory");})){var output=creature.CreateVisuals()!;Check(disposingHooks.IsDisposed&&disposedDuringFactory!.DisposeCount==1,"installer disposal during factory prevents late attachment and disposes source");output.Free();}
    bool allowReplacement=false;NCreatureVisuals? replacementVisuals=null;Authority? replacementAuthority=null;
  using(var replacingHooks=CreatureAssemblyHooks.Install("characterpipeline.fixture.replacement",(c,m,e)=>{if(!allowReplacement){allowReplacement=true;replacementVisuals=creature.CreateVisuals();}})){
   using var replacementRegistration=replacingHooks.Register(_=>allowReplacement,(c,r)=>replacementAuthority=new Authority("replacementOwner"));
   var departingRegistration=replacingHooks.Register(_=>!allowReplacement,(c,r)=>new Authority("departingOwner"){ThrowDispose=true});
   var departingVisuals=creature.CreateVisuals()!;departingRegistration.Dispose();
   Check(replacementVisuals!=null&&replacingHooks.TryGetSession(creature,out var replacementSession)&&!replacementSession!.IsDisposed,"reentrant error reporter replacement remains tracked after old Close returns");
   replacementRegistration.Dispose();Check(replacementAuthority!.DisposeCount==1&&!replacingHooks.TryGetSession(creature,out _),"replacement registration retains ownership and disposes replacement once");
   departingVisuals.Free();replacementVisuals!.Free();
  }
  File.WriteAllText(ProjectSettings.GlobalizePath("res://result.json"),"{\"passed\":true,\"checks\":"+checks+",\"runtimeVersion\":\""+System.Environment.Version+"\",\"fixturePrefixSkipsRealGameVisualCreation\":true}");GetTree().Quit();
 }catch(Exception e){GD.PushError(e.ToString());GetTree().Quit(1);}finally{fixtureHarmony.UnpatchAll(fixtureHarmony.Id);Fixture=null;}}
}





