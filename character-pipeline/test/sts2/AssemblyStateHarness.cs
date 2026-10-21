using System;
using System.Collections.Generic;
using System.IO;
using Godot;
using BaseLib.Utils;
using CharacterPipeline.Sts2;

public partial class AssemblyStateHarness : Node
{
    private int checks;
    private void Check(bool value,string name){if(!value)throw new Exception(name);checks++;}
    private void Reject(Action action,string name){try{action();}catch(ArgumentException){checks++;return;}throw new Exception(name);}
    public override async void _Ready()
    {
        try
        {
            var packed=ResourceLoader.Load<PackedScene>("res://character.tscn");
            var outer=new Node2D();outer.AddChild(packed.Instantiate<Node2D>());
            Reject(()=>AssemblyStateBinding.Attach(outer,"nested"),"nested controller is not a root controller");outer.Free();
            var contenderRoot=packed.Instantiate<Node2D>();var contenderVisuals=PipelineVisuals.Create(contenderRoot,new Rect2(0,0,32,32));AddChild(contenderVisuals);
            await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
            bool contenderRejected=false;
            var cancelRoot=packed.Instantiate<Node2D>();var cancelVisuals=PipelineVisuals.Create(cancelRoot,new Rect2(0,0,32,32));
            using var cancelled=AssemblyStateBinding.Attach(cancelRoot,"cancelInitialBind");int cancelledBound=0;bool cancelledInsertion=false;
            cancelled.Bound+=()=>cancelledBound++;
            cancelRoot.ChildEnteredTree+=child=>{if(cancelledInsertion||child.GetScript().VariantType==Variant.Type.Nil||!child.GetScript().AsGodotObject().Get("resource_path").AsString().EndsWith("/component_controller.gd"))return;cancelledInsertion=true;contenderRejected=!contenderRoot.GetNode("AssemblyController").Call("bind_authoritative","cancelInitialBind").AsBool();cancelled.Dispose();Reject(()=>AssemblyStateBinding.Attach(cancelRoot,"reservationSteal"),"in-flight cancellation retains root reservation");};
            AddChild(cancelVisuals);
            await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
            Check(cancelledInsertion&&cancelled.IsDisposed&&!cancelled.IsBound&&cancelledBound==0,"initial controller insertion disposal never publishes Bound");
            var retryRoot=packed.Instantiate<Node2D>();var retryVisuals=PipelineVisuals.Create(retryRoot,new Rect2(0,0,32,32));using var retry=AssemblyStateBinding.Attach(retryRoot,"cancelInitialBind");AddChild(retryVisuals);
            await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
            Check(contenderRejected,"native owner reservation rejects reentrant competing bind");contenderVisuals.Free();
            Check(retry.IsBound,"cancelled initial binding releases native owner");retry.Dispose();retryVisuals.Free();cancelVisuals.Free();
            var a=packed.Instantiate<Node2D>();var b=packed.Instantiate<Node2D>();
            var av=PipelineVisuals.Create(a,new Rect2(0,0,32,32));var bv=PipelineVisuals.Create(b,new Rect2(0,0,32,32));
            using var binding=AssemblyStateBinding.Attach(a,"ownerA");using var other=AssemblyStateBinding.Attach(b,"ownerB");
            Check(!binding.IsBound&&!other.IsBound,"detached roots wait for deferred assembly readiness");
            Reject(()=>AssemblyStateBinding.Attach(a,"duplicateRoot"),"pending root reservation");
            int ready=0,requests=0,rebuilds=0;string? requestedOwner=null;long requestedSequence=-1,requestedRevision=-1;
            binding.Bound+=()=>ready++;
            binding.SnapshotRequired+=(owner,sequence,revision)=>{requests++;requestedOwner=owner;requestedSequence=sequence;requestedRevision=revision;};
            binding.RebuildRequired+=owner=>{Check(owner=="ownerA","rebuild owner routing");rebuilds++;};
            AddChild(av);AddChild(bv);
            Check(!binding.IsBound,"root Ready alone is not deferred assembly readiness");
            await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
            await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
            Check(binding.IsBound&&other.IsBound&&ready==1,"actual assembly_ready binds each unique root once");
            Check(binding.GetState().Revision==null&&binding.GetState().Sequence==null,"binding does not synthesize initial counters");
            Check(CustomAnimation.HasCustomAnimation(av),"real BaseLib retains native primary animation bridge");
            var skeleton=a.GetNode("Skeleton").GetInstanceId();var secondSkeleton=b.GetNode("Skeleton").GetInstanceId();
            var component=new AssemblyComponentState("arm","left","red",1,AssemblyDamageState.Intact,0,"idle");
            var list=new List<AssemblyComponentState>{component};var initial=new AssemblySnapshot("ownerA",0,1,AssemblyLifecycle.Alive,"idle",list);list.Clear();
            Check(binding.ApplySnapshot(initial).Status=="applied","genuine first revision snapshot installs copied DTO");
            try{((IList<AssemblyComponentState>)binding.LastAcceptedState!.Components).Clear();throw new Exception("mutable accepted components");}catch(NotSupportedException){checks++;}
            Reject(()=>new AssemblySnapshot("ownerA",0,1,AssemblyLifecycle.Alive,"idle",new AssemblyComponentState[65]),"snapshot occupancy bound");
            Check(binding.LastAcceptedState?.Components.Count==1&&binding.LastAcceptedState.Revision==1,"immutable accepted state retained");
            Check(other.ApplySnapshot(new AssemblySnapshot("ownerB",0,1,AssemblyLifecycle.Alive,"idle",Array.Empty<AssemblyComponentState>())).Status=="applied","second owner empty authoritative snapshot");
            Check(binding.ApplyEvent(new AssemblyUpsert("ownerA",1,1,component)).Status=="applied","same revision no-op higher sequence");
            var gap=binding.ApplyEvent(new AssemblyUpsert("ownerA",3,3,component with {Type="blue",Revision=2}));
            Check(gap.Status=="blocked"&&gap.RequestSnapshot&&requests==1&&requestedOwner=="ownerA"&&requestedSequence==3&&requestedRevision==3,"typed snapshot-required watermarks");
            Check(binding.LastAcceptedState?.Sequence==1&&binding.LastAcceptedState.Components[0].Type=="red","gap does not overwrite last accepted state");
            Reject(()=>binding.ApplySnapshot(new AssemblySnapshot("ownerB",3,3,AssemblyLifecycle.Alive,"idle",Array.Empty<AssemblyComponentState>())) ,"cross owner rejected before native call");
            Reject(()=>binding.ApplyEvent(new AssemblyRemove("ownerA",-1,3,"arm")),"negative counter rejects");
            Reject(()=>binding.ApplyEvent(new AssemblyRemove("ownerA",9007199254740992,3,"arm")),"unsafe numeric counter rejects");
            var recovery=binding.ApplySnapshot(new AssemblySnapshot("ownerA",3,3,AssemblyLifecycle.Alive,"idle",new[]{component with {Type="blue",Revision=2}}));
            Check(recovery.Status=="applied"&&recovery.State.Components[0].Type=="blue","current full snapshot recovers accepted state");
            var rejected=binding.ApplyEvent(new AssemblyUpsert("ownerA",4,4,component with {Type="blue",Revision=1}));
            Check(rejected.Error=="INVALID_STATE"&&binding.LastAcceptedState?.Sequence==3,"native rejection preserves accepted state");
            Check(other.LastAcceptedState?.Components.Count==0&&other.LastAcceptedState.Sequence==0,"two owner state remains isolated");
            var controller=a.GetNode("AssemblyController");controller.EmitSignal("rebuild_required","ownerA");Check(rebuilds==1,"native rebuild signal reaches typed host");
            Check(a.GetNode("Skeleton").GetInstanceId()==skeleton&&b.GetNode("Skeleton").GetInstanceId()==secondSkeleton,"state changes preserve both chassis skeletons");
            var primaryTree=a.GetNode("AnimationTree").GetInstanceId();var controllerId=controller.GetInstanceId();
            var native=(Node)controller.Get("native").AsGodotObject();var registry=native.Get("registry").AsGodotDictionary();var savedRed=registry["red"];
            var departing=(Node)native.Call("component_at","left").AsGodotObject();
            departing.TreeExiting+=()=>registry.Remove("red");
            var repairSnapshot=new AssemblySnapshot("ownerA",4,4,AssemblyLifecycle.Alive,"idle",new[]{component with {Revision=3}});
            var fault=binding.ApplySnapshot(repairSnapshot);registry["red"]=savedRed;
            Check(fault.NeedsPresentationRebuild&&controller.Get("faulted").AsBool()&&binding.LastAcceptedState?.Sequence==3,"actual post-unmount native failure quarantines without authority commit");
            Reject(()=>binding.RebuildFromSnapshot(new AssemblySnapshot("ownerB",4,4,AssemblyLifecycle.Alive,"idle",Array.Empty<AssemblyComponentState>())),"rebuild rejects another owner before native call");
            Check(binding.RebuildFromSnapshot(initial).Error=="STALE_RECOVERY_SNAPSHOT","rebuild refuses stale genuine snapshot");
            Check(binding.RebuildFromSnapshot(repairSnapshot).Status=="applied"&&binding.LastAcceptedState?.Sequence==4,"typed rebuild commits genuine current snapshot");
            Check(controller.GetInstanceId()==controllerId&&a.GetNode("Skeleton").GetInstanceId()==skeleton&&a.GetNode("AnimationTree").GetInstanceId()==primaryTree&&binding.InstanceId=="ownerA","typed rebuild preserves controller chassis primary tree and owner");
            Check(binding.RebuildFromSnapshot(repairSnapshot).Error=="PRESENTATION_NOT_FAULTED","healthy typed rebuild explicitly refuses reset");
            var accepted=binding.LastAcceptedState;var requestsBeforeDispose=requests;var rebuildsBeforeDispose=rebuilds;
            RemoveChild(av);
            Check(binding.IsDisposed&&!binding.IsBound,"TreeExiting permanently disposes binding");
            Check(binding.LastAcceptedState==accepted,"local teardown preserves last authoritative accepted receipt");
            Check(controller.Get("ready_for_batches").AsBool()==false,"successful authority disposal releases native batch readiness");
            AddChild(av);Check(binding.IsDisposed&&!binding.IsBound,"visual reentry cannot revive binding");
            var releasedRoot=packed.Instantiate<Node2D>();var releasedVisuals=PipelineVisuals.Create(releasedRoot,new Rect2(0,0,32,32));
            using var released=AssemblyStateBinding.Attach(releasedRoot,"ownerA");AddChild(releasedVisuals);
            await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
            await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
            Check(released.IsBound,"tree exit releases owner for a fresh presentation lifetime");
            Check(released.ApplySnapshot(new AssemblySnapshot("ownerA",accepted!.Sequence!.Value,accepted.Revision!.Value,accepted.Lifecycle,accepted.VisualMode,accepted.Components)).Status=="applied","fresh lifetime bootstraps actual retained counters without synthesizing predecessor");
            released.Dispose();releasedVisuals.Free();
            controller.EmitSignal("snapshot_required","ownerA",10L,10L);controller.EmitSignal("rebuild_required","ownerA");Check(requests==requestsBeforeDispose&&rebuilds==rebuildsBeforeDispose,"disposed callbacks disconnected");
            var duplicate=packed.Instantiate<Node2D>();var dv=PipelineVisuals.Create(duplicate,new Rect2(0,0,32,32));AddChild(dv);
            await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
            await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
            using var failed=AssemblyStateBinding.Attach(duplicate,"ownerB");Check(failed.IsDisposed&&failed.BindingError!=null,"duplicate active owner attachment fails explicitly");
            Check(other.ApplyEvent(new AssemblyVisualMode("ownerB",1,2,"guard")).Status=="applied","failed attachment cannot dispose another owner");
            Check(other.ApplyEvent(new AssemblyLifecycleChange("ownerB",2,3,AssemblyLifecycle.Dead)).Status=="applied","typed authoritative death");
            Check(other.ApplyEvent(new AssemblyLifecycleChange("ownerB",3,4,AssemblyLifecycle.Alive)).Status=="applied","typed authoritative revive");
            Check(other.ApplyEvent(new AssemblyLifecycleChange("ownerB",4,5,AssemblyLifecycle.Removed)).Status=="applied","typed authoritative removal");
            Check(other.ApplyEvent(new AssemblyUpsert("ownerB",5,6,component)).Status=="removed"&&other.LastAcceptedState?.Revision==5,"native removal remains terminal");
            var pendingRoot=packed.Instantiate<Node2D>();var pv=PipelineVisuals.Create(pendingRoot,new Rect2(0,0,32,32));
            using var pending=AssemblyStateBinding.Attach(pendingRoot,"pendingOwner");pending.Dispose();AddChild(pv);
            await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
            await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
            Check(pending.IsDisposed&&!pending.IsBound&&!pendingRoot.GetNode("AssemblyController").Get("ready_for_batches").AsBool(),"pending disposal disconnects deferred binding without acquiring authority");pv.Free();
            foreach(var exitRoot in new[]{false,true})
            {
                string owner=exitRoot?"exitDuringMount":"disposeDuringMount";
                var busyRoot=packed.Instantiate<Node2D>();var busyVisuals=PipelineVisuals.Create(busyRoot,new Rect2(0,0,32,32));
                using var busy=AssemblyStateBinding.Attach(busyRoot,owner);AddChild(busyVisuals);
                await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
                await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
                var busyController=busyRoot.GetNode("AssemblyController");var wrappers=busyController.Get("wrappers").AsGodotDictionary();
                var wrapper=(Node)wrappers["left"].AsGodotObject();bool triggered=false;int callbacks=0;
                busy.SnapshotRequired+=(_,_,_)=>callbacks++;busy.RebuildRequired+=_=>callbacks++;
                var sentinel=new Node2D();wrapper.AddChild(sentinel);
                wrapper.ChildEnteredTree+=child=>{if(triggered)return;triggered=true;if(exitRoot)child.Ready+=()=>RemoveChild(busyVisuals);else busy.Dispose();};
                var stopped=busy.ApplySnapshot(new AssemblySnapshot(owner,0,1,AssemblyLifecycle.Alive,"idle",new[]{component}));
                Check(triggered&&busy.IsDisposed&&stopped.Status=="disposed"&&busy.LastAcceptedState==null,owner+" disposes before in-flight candidate commit");
                Check(GodotObject.IsInstanceValid(sentinel),owner+" preserves unrelated wrapper child");
                var stoppedState=busyController.Call("get_state").AsGodotDictionary();
                Check(stoppedState["lifecycle"].AsString()=="removed"&&stoppedState["revision"].VariantType==Variant.Type.Nil,owner+" releases authority without inventing accepted counters");
                busyController.EmitSignal("snapshot_required",owner,2L,2L);busyController.EmitSignal("rebuild_required",owner);Check(callbacks==0,owner+" prevents later callbacks");
                var freshRoot=packed.Instantiate<Node2D>();var freshVisuals=PipelineVisuals.Create(freshRoot,new Rect2(0,0,32,32));using var fresh=AssemblyStateBinding.Attach(freshRoot,owner);AddChild(freshVisuals);
                await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
                await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
                Check(fresh.IsBound,owner+" releases unique owner before in-flight return");
                Check(fresh.ApplySnapshot(new AssemblySnapshot(owner,0,1,AssemblyLifecycle.Alive,"idle",new[]{component})).Status=="applied",owner+" fresh presentation bootstraps genuine snapshot");
                fresh.Dispose();freshVisuals.Free();busyVisuals.Free();
            }
            other.Dispose();other.Dispose();Check(other.IsDisposed,"explicit dispose is idempotent");
            av.Free();bv.Free();dv.Free();
            File.WriteAllText(ProjectSettings.GlobalizePath("res://result.json"),"{\"passed\":true,\"checks\":"+checks+",\"sourceUnavailable\":true,\"gameHooks\":false}");
            GetTree().Quit();
        }
        catch(Exception error){GD.PushError(error.ToString());GetTree().Quit(1);}
    }
}
