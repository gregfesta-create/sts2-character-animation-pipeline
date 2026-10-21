using System;
using System.IO;
using Godot;
using BaseLib.Utils;
using CharacterPipeline.Sts2;

public partial class VisualAdapterHarness : Node
{
    private int checks;
    private void Check(bool value, string message) { if (!value) throw new Exception(message); checks++; }
    public override void _Ready()
    {
        try
        {
            var root = new Node2D { Name = "Compiled" };
            var player = new AnimationPlayer { Name = "AnimationPlayer" };
            root.AddChild(player); player.Owner = root;
            var library = new AnimationLibrary();
            library.AddAnimation("idle", new Animation { Length = 1 });
            library.AddAnimation("attack", new Animation { Length = 1 });
            player.AddAnimationLibrary("", library);
            var tree = new AnimationTree { Name = "AnimationTree", AnimPlayer = "../AnimationPlayer" };
            var machine = new AnimationNodeStateMachine();
            machine.AddNode("idle", new AnimationNodeAnimation { Animation = "idle" });
            machine.AddNode("attack", new AnimationNodeAnimation { Animation = "attack" });
            tree.TreeRoot = machine;
            root.AddChild(tree); tree.Owner = root;
            root.MoveChild(tree, 0);
            var component = new Node2D { Name = "Component" };
            root.AddChild(component); component.Owner = root;
            var nested = new AnimationTree { Name = "AnimationTree", TreeRoot = new AnimationNodeStateMachine() };
            component.AddChild(nested); nested.Owner = root;
            var scene = new PackedScene(); Check(scene.Pack(root) == Error.Ok, "pack fixture");
            Check(ResourceSaver.Save(scene, "res://fixture.tscn") == Error.Ok, "save fixture"); root.Free();
            var loaded = ResourceLoader.Load<PackedScene>("res://fixture.tscn").Instantiate<Node2D>();
            var primary = loaded.GetNode<AnimationTree>("AnimationTree");
            var phobia = new Node2D();
            var visuals = PipelineVisuals.Create(loaded, new Rect2(-16, -32, 32, 32), phobia);
            Check(visuals.Body == null, "not readied before insertion");
            Check(PipelineVisuals.TryGetReceipt(visuals, out var receipt), "factory issues receipt before insertion");
            Check(receipt!.TryGetPair(out var issuedVisuals, out var issuedRoot) && issuedVisuals == visuals && issuedRoot == loaded, "exact issued pair");
            Check(PipelineVisuals.TryGetReceipt(visuals, out var sameReceipt) && ReferenceEquals(receipt, sameReceipt), "stable opaque receipt");
            Check(!PipelineVisuals.TryGetReceipt(null, out _), "null visuals rejected");
            try { PipelineVisuals.OwnershipReceipt.Issue(new object(), visuals, loaded); throw new Exception("forged issuer accepted"); }
            catch (ArgumentException) { checks++; }
            var foreign = new MegaCrit.Sts2.Core.Nodes.Combat.NCreatureVisuals();
            Check(!PipelineVisuals.TryGetReceipt(foreign, out _), "foreign visuals rejected");
            foreign.Free();
            var clone = (MegaCrit.Sts2.Core.Nodes.Combat.NCreatureVisuals)visuals.Duplicate();
            Check(!PipelineVisuals.TryGetReceipt(clone, out _), "cloned visuals rejected");
            clone.Free();
            AddChild(visuals);
            Check(visuals.Body == loaded, "native body");
            Check(visuals.Bounds.Size == new Vector2(32, 32), "native bounds");
            Check(visuals.IntentPosition != null && visuals.OrbPosition != null && visuals.TalkPosition != null, "markers");
            Check(visuals.VfxSpawnPosition != null && visuals.FormVfxHolder != null, "vfx markers");
            Check(visuals.GetNode<Node2D>("%PhobiaModeVisuals").Visible == false, "phobia hidden");
            Check(CustomAnimation.HasCustomAnimation(visuals), "BaseLib discovers body tree");
            Check(CustomAnimation.PlayCustomAnimation(visuals, "attack"), "BaseLib routes attack");
            var playback = (AnimationNodeStateMachinePlayback)primary.Get("parameters/playback");
            primary.Advance(0);
            Check(playback.GetCurrentNode() == "attack", "primary selected instead of nested");
            loaded.MoveChild(loaded.GetNode("Component"), 0);
            Check(CustomAnimation.PlayCustomAnimation(visuals, "idle"), "cached primary survives component reorder");
            primary.Advance(0);
            Check(playback.GetCurrentNode() == "idle", "cached body idle");
            RemoveChild(visuals);
            Check(visuals.GetNode<Node2D>("%Visuals") == loaded, "owner unique markers survive detachment");
            AddChild(visuals);
            Check(CustomAnimation.PlayCustomAnimation(visuals, "attack"), "cached animation survives reentry");
            visuals.Free();
            Check(!receipt.TryGetPair(out _, out _) && !PipelineVisuals.TryGetReceipt(visuals, out _), "freed pair rejected");
            var movedRoot = ResourceLoader.Load<PackedScene>("res://fixture.tscn").Instantiate<Node2D>();
            var movedVisuals = PipelineVisuals.Create(movedRoot, new Rect2(0, 0, 1, 1));
            Check(PipelineVisuals.TryGetReceipt(movedVisuals, out var movedReceipt), "second exact pair issued");
            movedVisuals.RemoveChild(movedRoot);
            var unrelated = new Node2D(); unrelated.AddChild(movedRoot);
            Check(!movedReceipt!.TryGetPair(out _, out _) && !PipelineVisuals.TryGetReceipt(movedVisuals, out _), "reparented root rejected");
            unrelated.Free(); movedVisuals.Free();
            var queuedRoot = ResourceLoader.Load<PackedScene>("res://fixture.tscn").Instantiate<Node2D>();
            var queuedVisuals = PipelineVisuals.Create(queuedRoot, new Rect2(0, 0, 1, 1));
            Check(PipelineVisuals.TryGetReceipt(queuedVisuals, out var queuedReceipt), "queued pair initially owned");
            queuedRoot.QueueFree();
            Check(!queuedReceipt!.TryGetPair(out _, out _), "queued root rejected");
            queuedVisuals.Free();
            var queuedVisualRoot = ResourceLoader.Load<PackedScene>("res://fixture.tscn").Instantiate<Node2D>();
            var queuedOwner = PipelineVisuals.Create(queuedVisualRoot, new Rect2(0, 0, 1, 1));
            Check(PipelineVisuals.TryGetReceipt(queuedOwner, out var queuedOwnerReceipt), "owner initially valid");
            queuedOwner.QueueFree();
            Check(!queuedOwnerReceipt!.TryGetPair(out _, out _) && !PipelineVisuals.TryGetReceipt(queuedOwner, out _), "queued visuals rejected");
            queuedOwner.Free();
            var invalid = new Node2D();
            try { PipelineVisuals.Create(invalid, new Rect2(0, 0, 1, 1)); throw new Exception("missing tree accepted"); }
            catch (ArgumentException) { checks++; }
            invalid.Free();
            File.WriteAllText(ProjectSettings.GlobalizePath("res://result.json"), "{\"passed\":true,\"checks\":" + checks + "}");
            GetTree().Quit();
        }
        catch (Exception error) { GD.PushError(error.ToString()); GetTree().Quit(1); }
    }
}
