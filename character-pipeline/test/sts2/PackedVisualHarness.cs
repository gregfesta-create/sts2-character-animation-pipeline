using System;
using System.IO;
using Godot;
using BaseLib.Utils;
using CharacterPipeline.Sts2;

public partial class PackedVisualHarness : Node
{
    private int checks;
    private void Check(bool value, string message) { if (!value) throw new Exception(message); checks++; }
    public override void _Ready()
    {
        try
        {
            Check(ProjectSettings.LoadResourcePack("res://character.pck"), "load relocated PCK");
            var scenePath = File.ReadAllText(ProjectSettings.GlobalizePath("res://root.txt"));
            var body = ResourceLoader.Load<PackedScene>(scenePath).Instantiate<Node2D>();
            var primary = body.GetNode<AnimationTree>("AnimationTree");
            var visuals = PipelineVisuals.Create(body, new Rect2(-16, -32, 32, 32));
            AddChild(visuals);
            Check(body.IsNodeReady() && body.Get("player").AsGodotObject() != null, "compiled controller ready");
            body.SetProcess(false);
            Check(visuals.Body == body && visuals.Bounds.Size == new Vector2(32, 32), "native body and bounds");
            Check(visuals.IntentPosition != null && visuals.OrbPosition != null && visuals.TalkPosition != null && visuals.VfxSpawnPosition != null && visuals.FormVfxHolder != null, "native markers");
            Check(CustomAnimation.HasCustomAnimation(visuals), "BaseLib real compiled tree");
            foreach (var pair in new[] {("Attack", "attack"), ("Idle", "idle"), ("Hit", "hit"), ("Dead", "death"), ("Revive", "revive")})
            {
                Check(CustomAnimation.PlayCustomAnimation(visuals, pair.Item1), "native alias " + pair.Item1);
                body.Call("advance_animation", .05);
                Check(body.Get("current").AsString() == pair.Item2, "controller alias " + pair.Item1);
            }
            CustomAnimation.PlayCustomAnimation(visuals, "Attack"); body.Call("advance_animation", .3);
            var elapsed = body.Get("elapsed").AsDouble();
            Check(elapsed > .2, "attack advanced");
            CustomAnimation.PlayCustomAnimation(visuals, "Attack"); body.Call("advance_animation", .01);
            Check(body.Get("elapsed").AsDouble() < .1, "same state restarts");
            var nested = new Node2D { Name = "ReplacementComponent" };
            body.AddChild(nested);
            nested.AddChild(new AnimationTree { TreeRoot = new AnimationNodeStateMachine() });
            body.MoveChild(nested, 0);
            Check(CustomAnimation.PlayCustomAnimation(visuals, "Hit"), "cached primary through component reorder");
            body.Call("advance_animation", .05);
            Check(body.Get("current").AsString() == "hit", "body remains routed");
            CustomAnimation.PlayCustomAnimation(visuals, "Dead"); body.Call("advance_animation", 1.1);
            Check(body.Get("held").AsBool() && body.Get("current").AsString() == "death", "death holds");
            CustomAnimation.PlayCustomAnimation(visuals, "Revive"); body.Call("advance_animation", 1.1);
            Check(!body.Get("held").AsBool() && body.Get("current").AsString() == "idle", "revive returns idle");
            visuals.Free();
            File.WriteAllText(ProjectSettings.GlobalizePath("res://result.json"), "{\"passed\":true,\"checks\":" + checks + ",\"gameAcceptance\":false}");
            GetTree().Quit();
        }
        catch (Exception error) { GD.PushError(error.ToString()); GetTree().Quit(1); }
    }
}
