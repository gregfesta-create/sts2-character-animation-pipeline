using System.Linq;
using System;
using Godot;
using MegaCrit.Sts2.Core.Modding;
[ModInitializer(nameof(Initialize))]
public static class PackagedModInitializer
{
 public static bool Initialized, MountedBeforeInitializer, SceneFreed, FactoryReceipt, PrimaryTree, BaseLibAnimation, PreparedPanel;
 public static void Initialize() {
  if(Initialized)throw new InvalidOperationException("Fixture initialized twice");
  if(!ModManager.GetLoadedMods().Any(m=>m.manifest?.id=="BaseLib"))throw new InvalidOperationException("BaseLib must load before packaged initializer");
  MountedBeforeInitializer=Godot.FileAccess.FileExists("res://pipeline_generated_fixture/character.tscn");
  if(!MountedBeforeInitializer)throw new InvalidOperationException("Generated PCK not mounted before initializer");
  var visuals=GeneratedFixture.Presentation.Create(out var receipt);
  Node2D? root=null;
  try {
   FactoryReceipt=receipt.TryGetPair(out var issued,out root)&&ReferenceEquals(issued,visuals)&&root!=null;
   if(!FactoryReceipt)throw new InvalidOperationException("Generated factory ownership receipt missing");
   PrimaryTree=root!.GetNodeOrNull<AnimationTree>("AnimationTree")?.TreeRoot is AnimationNodeStateMachine;
   var player=root.GetNode<AnimationPlayer>("AnimationPlayer");
   if(!PrimaryTree||!player.HasAnimation("idle")||!player.HasAnimation("attack"))throw new InvalidOperationException("Compiled animation contract missing");
   var panel=root.GetNode<Polygon2D>("Meshes/panel");
   PreparedPanel=panel.Texture!=null&&panel.Texture.GetSize()==Vector2.One&&panel.Polygon.Length==4;
   if(!PreparedPanel)throw new InvalidOperationException("Actual prepared synthetic panel missing");
   var tree=(SceneTree)Engine.GetMainLoop();tree.Root.GetChild(0).AddChild(visuals);
   if(visuals.Body!=root||visuals.Bounds.Size!=new Vector2(16,16))throw new InvalidOperationException("Generated native visuals mismatch");
   BaseLibAnimation=BaseLib.Utils.CustomAnimation.PlayCustomAnimation(visuals,"attack");
   if(!BaseLibAnimation)throw new InvalidOperationException("Actual BaseLib animation routing failed");
  } finally {
   visuals.Free();SceneFreed=!GodotObject.IsInstanceValid(visuals)&&!GodotObject.IsInstanceValid(root);
   if(receipt.TryGetPair(out _,out _))throw new InvalidOperationException("Freed visual receipt remained valid");
  }
  Initialized=true;
 }
}
