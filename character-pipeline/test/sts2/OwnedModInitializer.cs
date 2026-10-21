using Godot;
using MegaCrit.Sts2.Core.Modding;
[ModInitializer(nameof(Initialize))]
public static class OwnedModInitializer
{
 public static bool Initialized;
 public static bool MountedBeforeInitializer;
 public static bool SceneFreed;
 public static void Initialize() {
  if(Initialized)throw new System.InvalidOperationException("Fixture initialized twice");
  var scene=ResourceLoader.Load<PackedScene>("res://pipeline_loader_fixture/scene.tscn");
  MountedBeforeInitializer=scene!=null;
  if(!MountedBeforeInitializer)throw new System.InvalidOperationException("Fixture PCK was not mounted before initialization");
  var node=scene.Instantiate<Node2D>();
  try{if(node.Name!="OwnedLoaderFixture"||node.GetChildCount()!=0||node.GetScript().VariantType!=Variant.Type.Nil)throw new System.InvalidOperationException("Unexpected fixture scene");}
  finally{node.Free();SceneFreed=!GodotObject.IsInstanceValid(node);}
  Initialized=true;
 }
}
