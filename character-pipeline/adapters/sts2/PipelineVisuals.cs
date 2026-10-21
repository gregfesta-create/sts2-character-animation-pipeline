using System;
using System.Runtime.CompilerServices;
using Godot;
using BaseLib.Extensions;
using MegaCrit.Sts2.Core.Nodes.Combat;

namespace CharacterPipeline.Sts2;

/// <summary>Presentation-only factory. Caller loads and verifies the owned compiled scene before transfer.</summary>
public static class PipelineVisuals
{
    private static readonly object Issuer = new();
    private static readonly ConditionalWeakTable<NCreatureVisuals, OwnershipReceipt> Receipts = new();

    /// <summary>Identity evidence from this factory only; does not verify package contents or game authority.</summary>
    public sealed class OwnershipReceipt
    {
        private readonly WeakReference<NCreatureVisuals> visuals;
        private readonly WeakReference<Node2D> root;

        private OwnershipReceipt(NCreatureVisuals visuals, Node2D root)
        {
            this.visuals = new(visuals);
            this.root = new(root);
        }

        internal static OwnershipReceipt Issue(object issuer, NCreatureVisuals visuals, Node2D root)
        {
            if (!ReferenceEquals(issuer, Issuer)) throw new ArgumentException("Invalid receipt issuer.", nameof(issuer));
            return new(visuals, root);
        }

        public bool TryGetPair(out NCreatureVisuals? ownedVisuals, out Node2D? compiledRoot)
        {
            ownedVisuals = null;
            compiledRoot = null;
            if (!visuals.TryGetTarget(out var v) || !root.TryGetTarget(out var r) ||
                !GodotObject.IsInstanceValid(v) || !GodotObject.IsInstanceValid(r) ||
                v.IsQueuedForDeletion() || r.IsQueuedForDeletion() || r.GetParent() != v ||
                !Receipts.TryGetValue(v, out var issued) || !ReferenceEquals(issued, this)) return false;
            ownedVisuals = v;
            compiledRoot = r;
            return true;
        }
    }

    public static bool TryGetReceipt(NCreatureVisuals? visuals, out OwnershipReceipt? receipt)
    {
        receipt = null;
        if (visuals == null || !GodotObject.IsInstanceValid(visuals) || visuals.IsQueuedForDeletion() ||
            !Receipts.TryGetValue(visuals, out var issued) || !issued.TryGetPair(out _, out _)) return false;
        receipt = issued;
        return true;
    }

    public static NCreatureVisuals Create(Node2D compiledRoot, Rect2 bounds, Node2D? phobiaRoot = null)
    {
        ArgumentNullException.ThrowIfNull(compiledRoot);
        if (compiledRoot.GetParent() != null || compiledRoot.IsInsideTree())
            throw new ArgumentException("Compiled root must be detached and ownership transferred once.", nameof(compiledRoot));
        if (!bounds.Position.IsFinite() || !bounds.Size.IsFinite() || bounds.Size.X <= 0 || bounds.Size.Y <= 0)
            throw new ArgumentException("Bounds must be finite and positive.", nameof(bounds));
        if (phobiaRoot != null && (phobiaRoot == compiledRoot || phobiaRoot.GetParent() != null || phobiaRoot.IsInsideTree()))
            throw new ArgumentException("Optional phobia body must be a separate detached root.", nameof(phobiaRoot));
        var tree = compiledRoot.GetNodeOrNull<AnimationTree>("AnimationTree");
        if (tree == null || tree.TreeRoot is not AnimationNodeStateMachine || FirstTree(compiledRoot) != tree)
            throw new ArgumentException("A persistent primary state-machine AnimationTree must precede component trees.", nameof(compiledRoot));
        var visuals = new NCreatureVisuals { Name = "PipelineVisuals" };
        visuals.AddUnique(compiledRoot, "Visuals");
        if (phobiaRoot != null) { phobiaRoot.Visible = false; visuals.AddUnique(phobiaRoot, "PhobiaModeVisuals"); }
        visuals.AddUnique(new Control { Position = bounds.Position, Size = bounds.Size, MouseFilter = Control.MouseFilterEnum.Ignore }, "Bounds");
        var center = bounds.Position + bounds.Size * new Vector2(.5f, .5f);
        visuals.AddUnique(new Marker2D { Position = center }, "CenterPos");
        visuals.AddUnique(new Marker2D { Position = bounds.Position + bounds.Size * new Vector2(.5f, 0) + new Vector2(0, -70) }, "IntentPos");
        visuals.AddUnique(new Marker2D { Position = center }, "OrbPos");
        visuals.AddUnique(new Marker2D { Position = center }, "TalkPos");
        visuals.AddUnique(new Control { MouseFilter = Control.MouseFilterEnum.Ignore }, "FormVfx");
        Receipts.Add(visuals, OwnershipReceipt.Issue(Issuer, visuals, compiledRoot));
        return visuals;
    }

    private static AnimationTree? FirstTree(Node parent)
    {
        foreach (Node child in parent.GetChildren())
        {
            if (child is AnimationTree tree) return tree;
            var nested = FirstTree(child);
            if (nested != null) return nested;
        }
        return null;
    }
}
