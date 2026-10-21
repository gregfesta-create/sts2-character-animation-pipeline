using System;
using System.IO;
using Godot;
using CharacterPipeline.Sts2;
using FixtureIntegration;
public partial class GeneratedIntegrationHarness : Node
{
 private int checks;private void Check(bool value,string label){if(!value)throw new Exception(label);checks++;}
 public override void _Ready(){try{
  Check(ProjectSettings.LoadResourcePack("res://character.pck"),"mount captured PCK");
  var visuals=Presentation.Create(out var receipt);Check(receipt.TryGetPair(out var issued,out var root)&&ReferenceEquals(issued,visuals)&&root!=null,"generated factory returns exact opaque ownership receipt");
  AddChild(visuals);Check(visuals.Body==root&&visuals.Bounds.Size==new Vector2(32,32),"generated bounds and exact native body");
  Check(BaseLib.Utils.CustomAnimation.PlayCustomAnimation(visuals,"attack"),"real BaseLib animation routing");visuals.Free();
  var before=Performance.GetMonitor(Performance.Monitor.ObjectNodeCount);
  try{WrongPresentation.Create();throw new Exception("incorrect resource hash accepted");}catch(InvalidDataException error){Check(error.Message.Contains("hash mismatch"),"actual mounted resource bytes checked before load");}
  Check(Performance.GetMonitor(Performance.Monitor.ObjectNodeCount)==before,"hash rejection creates no leaked nodes");
    try{InvalidPresentation.Create();throw new Exception("missing primary tree accepted");}catch(ArgumentException){checks++;}
  Check(Performance.GetMonitor(Performance.Monitor.ObjectNodeCount)==before,"factory failure frees instantiated invalid root");
  File.WriteAllText(ProjectSettings.GlobalizePath("res://result.json"),"{\"passed\":true,\"checks\":"+checks+",\"gameAcceptance\":false}");GetTree().Quit();
 }catch(Exception error){GD.PushError(error.ToString());GetTree().Quit(1);}}
}

