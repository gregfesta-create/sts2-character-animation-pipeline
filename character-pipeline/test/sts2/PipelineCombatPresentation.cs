#nullable enable
using System;
using System.Linq;
using System.IO;
using System.Text.Json;
using System.Collections.Generic;
using System.Threading.Tasks;
using Godot;
using BaseLib.Abstracts;
using CharacterPipeline.Sts2;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Models.Powers;
using MegaCrit.Sts2.Core.Entities.Powers;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.GameActions.Multiplayer;
using MegaCrit.Sts2.Core.Commands;
using MegaCrit.Sts2.Core.Nodes;
using MegaCrit.Sts2.Core.Nodes.Combat;
using MegaCrit.Sts2.Core.Nodes.Rooms;

// Genuine game power and explicit owning-card consumption, limited to this
// synthetic developer fixture. No game or user mechanic is inferred here.
public sealed class PipelineArrowChargePower : CustomPowerModel {
 public override PowerType Type=>PowerType.Buff;
 public override PowerStackType StackType=>PowerStackType.Counter;
 public override string CustomPackedIconPath=>ModelDb.Power<VigorPower>().PackedIconPath;
 public override string CustomBigIconPath=>ModelDb.Power<VigorPower>().ResolvedBigIconPath;
 public override List<(string,string)> Localization=>new(){("title","Fixture arrow charge"),("description","The next fixture attack has green arrows.")};
}

public partial class PipelineCombatPresentation : Node {
 Node2D root=null!;Node actions=null!;Polygon2D arrow=null!;
 AttackPresentationBinding binding=null!;Creature owner=null!;
 readonly Dictionary<string,List<Node2D>> released=new();
 Callable releaseCallback;
 long sequence;int attacks,confirmedImpacts;bool chargeConsumed,powerUiSeen,powerUiRemoved,activeCleared;
 readonly List<string> frames=new();
 readonly List<double> impactClocks=new();
 readonly List<float[]> colors=new();
 readonly List<float[]> releasePositions=new();
 readonly List<float[]> drawnPoses=new();
 public static PipelineCombatPresentation? Current;
 static void Check(bool condition,string message){if(!condition)throw new Exception(message);}
 static async Task Wait(Func<bool> ready,string stage){var tree=(SceneTree)Engine.GetMainLoop();var end=Time.GetTicksMsec()+10000;while(!ready()){Check(Time.GetTicksMsec()<end,"Timed out: "+stage);await tree.ToSignal(tree,SceneTree.SignalName.ProcessFrame);}}
 public static async Task<PipelineCombatPresentation> Attach(Creature creature,PipelineVisuals.OwnershipReceipt receipt){
  Check(receipt.TryGetPair(out var visuals,out var root)&&root!=null&&visuals!=null,"Exact actual combat receipt required");
  Check(root!.Position==new Vector2(-120,-360)&&visuals!.Bounds.Position==new Vector2(-70,-210)&&visuals.Bounds.Size==new Vector2(150,140),"Actual factory applies explicit authored origin consistently to body and bounds");
  await Wait(()=>root!.IsInsideTree()&&root.IsNodeReady()&&root.GetNode("EffectController").Get("ready_for_effects").AsBool(),"ready actual effect controller");
  var node=new PipelineCombatPresentation{root=root!,owner=creature};node.actions=root!.GetNode("ActionController");node.arrow=root.GetNode<Polygon2D>("Meshes/arrow");
  node.binding=AttackPresentationBinding.Attach(receipt);
  node.releaseCallback=Callable.From<string,string,Node2D>(node.Released);
  node.actions.Connect("projectile_released",node.releaseCallback);root.AddChild(node);Current=node;
  return node;
 }
 public override void _Process(double delta){if(!binding.IsDisposed)Check(binding.AdvanceClock(Time.GetTicksMsec()/1000d),"Actual monotonic presentation clock accepted");}
 public override void _ExitTree(){if(GodotObject.IsInstanceValid(actions)&&actions.IsConnected("projectile_released",releaseCallback))actions.Disconnect("projectile_released",releaseCallback);binding.Dispose();if(ReferenceEquals(Current,this))Current=null;}
 void Released(string action,string cue,Node2D projectile){Check(released.TryGetValue(action,out var list)&&list.Count<2,"Exact owned authored two-arrow release");list!.Add(projectile);if(action=="baseline")return;colors.Add(new[]{projectile.Modulate.R,projectile.Modulate.G,projectile.Modulate.B,projectile.Modulate.A});releasePositions.Add(new[]{projectile.GlobalPosition.X,projectile.GlobalPosition.Y});}
 public void BeginBaseline(Creature target){Observe();released.Add("baseline",new());Check(binding.BeginAttack(new("baseline","combat-generation","attack",new(true,NCombatRoom.Instance.GetCreatureNode(target)!.VfxSpawnPosition),.5,1,sequence)),"Explicit baseline action context before actual BaseLib fallback");}
 public void EndBaseline(){Check(binding.CancelAttack("baseline"),"Baseline presentation cancelled after actual game attack");}
 void Observe(){var power=owner.GetPower<PipelineArrowChargePower>();var fact=new AttackBindingFact(power!=null,power?.Amount??0);Check(binding.Observe("1",++sequence,new Dictionary<string,AttackBindingFact>{{"poisonActive",fact},{"poisonSnapshot",fact}}),"Actual power facts observed");}
 static bool Green(Node2D node)=>node.Modulate.G>.9f&&node.Modulate.R<.1f&&node.Modulate.B<.1f;
 static bool White(Node2D node)=>node.Modulate==Colors.White;
 static IEnumerable<NPower> PowerNodes(Node node,int depth=0){Check(depth<=12,"Bounded actual power UI depth");foreach(Node child in node.GetChildren()){if(child is NPower power)yield return power;foreach(var nested in PowerNodes(child,depth+1))yield return nested;}}
 async Task Capture(string name){await ToSignal(RenderingServer.Singleton,RenderingServer.SignalName.FramePostDraw);using var image=GetViewport().GetTexture().GetImage();Check(image.GetWidth()<=4096&&image.GetHeight()<=4096,"Bounded real combat frame");Check(image.SavePng(ProjectSettings.GlobalizePath("res://"+name+".png"))==Error.Ok,"Actual combat frame saved");frames.Add(name+".png");}
 public async Task Play(CustomCardModel card,PlayerChoiceContext choice,CardPlay play){
  Check(ReferenceEquals(card.Owner.Creature,owner)&&play.Target!=null&&attacks<2,"Exact actual owning card/target");
  bool first=attacks++==0;var id=first?"last-charge":"unbuffed";var clip=first?"attack":"attackUnbuffed";
  var creatureNode=NCombatRoom.Instance.GetCreatureNode(owner)!;var targetNode=NCombatRoom.Instance.GetCreatureNode(play.Target)!;
  var targetPosition=targetNode.VfxSpawnPosition;
  if(first){
   var power=await PowerCmd.Apply<PipelineArrowChargePower>(choice,owner,1m,owner,card);Check(power!=null&&power.Amount==1,"Actual one-charge game power applied");
   await Wait(()=>PowerNodes(creatureNode).Any(n=>ReferenceEquals(n.Model,power)),"real one-charge buff UI");powerUiSeen=true;
  }
  Observe();Check(first?Green(arrow):White(arrow),"Active nocked arrow reflects actual power");
  await Capture(first?"bow-before":"bow-next-before");
  released.Add(id,new());
  Check(binding.BeginAttack(new(id,"combat-generation",clip,new(true,targetPosition),.5,1,sequence)),"Pre-consumption snapshot began actual owned action: "+binding.LastError);
  Task<int>? consumption=null;
  if(first){
   var power=owner.GetPower<PipelineArrowChargePower>()!;
   // Observe actual state changes while the original command's standard
   // removal VFX wait runs; await command completion before dealing damage.
   consumption=PowerCmd.ModifyAmount(choice,power,-1m,owner,card);
   await Wait(()=>owner.GetPower<PipelineArrowChargePower>()==null,"actual final charge removal");
   chargeConsumed=owner.GetPower<PipelineArrowChargePower>()==null;
   Observe();activeCleared=White(arrow);Check(chargeConsumed&&activeCleared,"Actual zero charge clears active visual");
   await Wait(()=>!PowerNodes(creatureNode).Any(n=>n.Model is PipelineArrowChargePower),"actual zero-charge buff UI removal");powerUiRemoved=true;
  }
  await Wait(()=>actions.Get("action_clock").AsDouble()>=.4,"actual draw phase");
  var nock=root.GetNode<Bone2D>("Skeleton/root/nock");var upper=root.GetNode<Bone2D>("Skeleton/root/upper");var lower=root.GetNode<Bone2D>("Skeleton/root/lower");
  var drawClock=actions.Get("action_clock").AsDouble();var playback=root.GetNode<AnimationTree>("AnimationTree").Get("parameters/playback").As<AnimationNodeStateMachinePlayback>();
  File.WriteAllText(ProjectSettings.GlobalizePath("res://"+id+"-draw-diagnostic.json"),JsonSerializer.Serialize(new{actionClock=drawClock,elapsed=root.Get("elapsed").AsDouble(),current=root.Get("current").AsString(),treeState=playback.GetCurrentNode().ToString(),treePosition=playback.GetCurrentPlayPosition(),nockX=nock.Position.X,upperRotation=upper.Rotation,lowerRotation=lower.Rotation}));
  drawnPoses.Add(new[]{nock.Position.X,upper.Rotation,lower.Rotation});Check(nock.Position.X<=-45&&upper.Rotation<-.05&&lower.Rotation>.05,"Actual native bow draw moves nock and bends both limbs; clock="+drawClock+", nock="+nock.Position.X+", upper="+upper.Rotation+", lower="+lower.Rotation);
  await Capture(first?"bow-drawn":"bow-next-drawn");
  await Wait(()=>released[id].Count==2,"actual two authored releases");
  Check(released[id].All(first?Green:White),"Each released arrow retained the genuine pre-consumption snapshot");
  Check(binding.RetainedProjectileCount>=2,"Actual typed bridge retained both released arrows");
  await Capture(first?"bow-released-green":"bow-released-white");
  if(consumption!=null)Check(await consumption==0,"Original actual power consumption command completed at zero");
  var hp=play.Target!.CurrentHp;
  var command=await DamageCmd.Attack(1m).FromCard(card,play).Targeting(play.Target).WithHitCount(2).WithNoAttackerAnim().Execute(choice);
  Check(command.Results.Count()==2&&command.Results.All(hit=>hit.Count==1&&ReferenceEquals(hit[0].Receiver,play.Target))&&play.Target.CurrentHp==hp-2,"Actual game-owned two-hit damage results");
  await Wait(()=>actions.Get("action_clock").AsDouble()>=1,"actual authored impact clock");
  var actualClock=actions.Get("action_clock").AsDouble();impactClocks.Add(actualClock);
  foreach(var cue in new[]{"impactA","impactB"}){Check(binding.ConfirmImpact(id,cue,actualClock,targetPosition),"Actual game hit confirmed after real authored impact clock");confirmedImpacts++;}
  Check(binding.CompleteAttack(id),"Owned action completes without changing game state");
 }
 public void WriteReceipt(){
  Check(attacks==2&&colors.Count==4&&confirmedImpacts==4,"Both genuine queued bow actions completed");
  File.WriteAllText(ProjectSettings.GlobalizePath("res://presentation-result.json"),JsonSerializer.Serialize(new{passed=true,lastChargeConsumed=chargeConsumed,powerUiSeen,powerUiRemoved,activeCleared,queuedBowAttacks=attacks,confirmedImpacts,colors,releasePositions,drawnPoses,impactClocks,frames,origin=new[]{120,360},appliedBounds=new[]{-70,-210,150,140},frameDistinguishesArrowPair=false,manualAnimationAdvance=false,gameOwnsDamage=true,gameAcceptance=false}));
 }
}
