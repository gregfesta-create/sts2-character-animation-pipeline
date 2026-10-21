using System;
using System.IO;
using System.Collections.Generic;
using Godot;
using CharacterPipeline.Sts2;
public partial class AttackPresentationHarness : Node
{
 private int checks;
 private void Check(bool value,string label){if(!value)throw new Exception(label);checks++;}
 public override async void _Ready(){try{
  var root=ResourceLoader.Load<PackedScene>("res://character.tscn").Instantiate<Node2D>();
  var visuals=PipelineVisuals.Create(root,new Rect2(0,0,64,64));PipelineVisuals.TryGetReceipt(visuals,out var receipt);
  try{AttackPresentationBinding.Attach(receipt!);throw new Exception("detached root accepted");}catch(ArgumentException){checks++;}
  AddChild(visuals);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);root.SetProcess(false);
  using var binding=AttackPresentationBinding.Attach(receipt!);
  try{AttackPresentationBinding.Attach(receipt!);throw new Exception("duplicate binding accepted");}catch(ArgumentException){checks++;}
  var effects=root.GetNode("EffectController");var actions=root.GetNode("ActionController");var part=root.GetNode<Node2D>("Meshes/panel");
  Check(binding.CharacterInstance==effects.Call("status").AsGodotDictionary()["characterInstance"].AsString(),"exact runtime effect owner");
  var facts=new Dictionary<string,AttackBindingFact>{{"poison0",new(true,1)},{"poison1",new(true,1)}};
  Check(binding.Observe("1",1,facts),"pre-consumption authoritative facts accepted");facts["poison0"]=new(false,0);facts["poison1"]=new(false,0);
  Check(part.Modulate.G>0.9f&&part.Modulate.R<0.1f,"active buff shown");
  var attack=new AttackPresentationRequest("last-charge","generation-one","multiRelease",new(true,new Vector2(120,32)),0.2,0.6,1);
  Check(binding.BeginAttack(attack),"typed bow action begins after immutable snapshot capture");
  Check(binding.Observe("1",2,facts),"game-owned last charge consumption observed");Check(part.Modulate==Colors.White,"active buff clears after consumption");
  root.Call("advance_animation",0.2);
  var projectiles=actions.Call("active_projectiles").AsGodotArray();Check(projectiles.Count==2,"native authored bow emits two arrows");
  foreach(var item in projectiles){var arrow=item.AsGodotObject() as Node2D;Check(arrow!=null&&arrow.Modulate.G>0.9f&&arrow.Modulate.R<0.1f,"each released arrow retains captured poison");}
  Check(binding.RetainedProjectileCount==2,"typed bridge retains both native projectiles");
  Check(!binding.ConfirmImpact("last-charge","early",0.3,new Vector2(120,32)),"premature authoritative impact rejected");
  root.Call("advance_animation",0.4);Check(binding.ConfirmImpact("last-charge","impact",0.6,new Vector2(120,32)),"game-owned authoritative impact accepted");
  Check(!binding.ConfirmImpact("last-charge","impact",0.6,new Vector2(120,32)),"duplicate impact suppressed");
  Check(binding.CompleteAttack("last-charge"),"completed attack retains flying arrow effects");
  Check(binding.BeginAttack(new("next","generation-two","multiRelease",new(true,new Vector2(120,32)),0.2,0.6,2)),"next attack uses consumed observations");
  root.Call("advance_animation",0.2);projectiles=actions.Call("active_projectiles").AsGodotArray();Check(projectiles.Count==4,"second pair released");
  for(int i=2;i<4;i++)Check(((Node2D)projectiles[i].AsGodotObject()).Modulate==Colors.White,"subsequent arrows have no stale poison");
  var rejected=await System.Threading.Tasks.Task.Run(()=>{try{binding.Observe("1",3,facts);return false;}catch(InvalidOperationException){return true;}});Check(rejected,"off-thread facts refused");
  binding.CancelAttack("next");binding.Dispose();Check(binding.IsDisposed&&binding.RetainedProjectileCount==0,"terminal disposal releases all owned effect references");
  try{binding.BeginAttack(attack);throw new Exception("disposed action accepted");}catch(ObjectDisposedException){checks++;}
  var secondRoot=ResourceLoader.Load<PackedScene>("res://character.tscn").Instantiate<Node2D>();var secondVisuals=PipelineVisuals.Create(secondRoot,new Rect2(0,0,64,64));PipelineVisuals.TryGetReceipt(secondVisuals,out var secondReceipt);AddChild(secondVisuals);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);secondRoot.SetProcess(false);
  var secondBinding=AttackPresentationBinding.Attach(secondReceipt!);Check(secondBinding.Observe("1",1,facts),"independent owner facts accepted");Check(secondBinding.BeginAttack(new("loss","generation-loss","multiRelease",new(true,new Vector2(120,32)),.2,.6,1)),"owned attack before controller removal");
  var removedActions=secondRoot.GetNode("ActionController");secondRoot.RemoveChild(removedActions);
  try{secondBinding.Observe("1",2,facts);throw new Exception("lost controller accepted");}catch(ObjectDisposedException){checks++;}Check(secondBinding.IsDisposed,"controller loss tears down without recursion");removedActions.Free();secondVisuals.QueueFree();
  visuals.QueueFree();await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
  File.WriteAllText(ProjectSettings.GlobalizePath("res://result.json"),System.Text.Json.JsonSerializer.Serialize(new{passed=true,checks,gameplayMutation=false,actualGameAttackHook=false}));GetTree().Quit();
 }catch(Exception error){GD.PushError(error.ToString());GetTree().Quit(1);}}
}
