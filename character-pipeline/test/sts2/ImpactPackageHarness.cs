using System;
using System.IO;
using System.Linq;
using Godot;
using CharacterPipeline.Sts2;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Entities.Players;
public partial class ImpactPackageHarness : Node {
 int checks; void Check(bool v,string s){if(!v)throw new Exception(s);checks++;}
 int Anchors(Node2D r)=>(int)r.GetNode("EffectController").Call("impact_status").AsGodotDictionary()["anchors"].AsInt64();
 Node2D Anchor(Node2D r,int i=0)=>(Node2D)r.GetNode("EffectController").Get("_impacts").AsGodotObject().Get("_entries").AsGodotDictionary().Values.ToArray()[i].AsGodotDictionary()["anchor"].AsGodotObject();
 public override async void _Ready(){try{
 Check(ProjectSettings.LoadResourcePack("res://owned/effects/pipeline_impact.pck"),"relocated normal PCK");
 var owner=new Creature((Player)null!,10,10);var ancestry=new Node2D{Position=new Vector2(47,91),Scale=new Vector2(1.7f,.8f),Rotation=.2f};AddChild(ancestry);
 async System.Threading.Tasks.Task<(Node2D,CombatPresentationCaller,Node)> New(string generation){var visual=ImpactFixture.Presentation.Create(out var receipt);Check(receipt.TryGetPair(out _,out var root)&&root!=null,"normal generated factory receipt");ancestry.AddChild(visual);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);root!.SetProcess(false);return(root,ImpactFixtureFacts.Attach(receipt,owner,generation),visual);}
 ImpactFixtureFacts.Charge=1;var(root,c,visual)=await New("mixed");var target=new AttackPresentationTarget(true,new Vector2(420,175));
 Check(c.BeginBeforeConsumption("mixed","splitRelease",target,.2,.6),"preconsumption captured mixed selection");ImpactFixtureFacts.Charge=0;Check(c.ObserveCurrent(),"last charge consumed and current facts clear");root.Call("advance_animation",.2);Check(Anchors(root)==0,"release is not a hit");Check(!c.ConfirmImpact("mixed","early","sourceA",.3,target.Position)&&Anchors(root)==0,"early hit rejected");root.Call("advance_animation",.4);
 Check(c.ConfirmImpact("mixed","legacy",.6,target.Position)&&Anchors(root)==0,"legacy ambiguous source accepted without guessed effects");
 bool hit=c.ConfirmImpact("mixed","a","sourceA",.6,target.Position);Check(hit&&Anchors(root)==1&&Anchor(root).GetChildCount()==2,"captured poison plus fire same source: hit="+hit+" error="+c.LastError+" status="+Json.Stringify(root.GetNode("EffectController").Call("impact_status")));Check(Anchor(root).GlobalPosition.DistanceTo(target.Position)<.01f,"world hit anchor under translated scaled rotated ancestry");Check(Anchor(root).GetChild(0) is Sprite2D sprite && sprite.Texture is AtlasTexture atlas && atlas.Region.Size==new Vector2(1,1),"normal captured impact atlas actual native texture");
 Check(!c.ConfirmImpact("mixed","a","sourceA",.6,target.Position)&&Anchors(root)==1,"duplicate no allocation");bool hitB=c.ConfirmImpact("mixed","b","sourceB",.6,target.Position);Check(hitB&&Anchors(root)==2&&Anchor(root,1).GetChildCount()==1,"second source poison isolated from fire: hit="+hitB+" anchors="+Anchors(root)+" children="+(Anchors(root)>1?Anchor(root,1).GetChildCount():-1)+" status="+Json.Stringify(root.GetNode("EffectController").Call("impact_status")));
 foreach(var shot in root.GetNode("ActionController").Call("active_projectiles").AsGodotArray())shot.AsGodotObject().Call("expire_projectile");await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);Check(root.GetNode("ActionController").Call("active_projectiles").AsGodotArray().Count==0,"projectile nodes retired");Check(c.ConfirmImpact("mixed","retired","sourceA",2.6,target.Position)&&Anchors(root)==3&&Anchor(root,2).GetChildCount()==2,"captured source selection survives projectile retirement");Check(c.Complete("mixed")&&Anchors(root)==3,"completion preserves started effects");Check(c.AdvanceClock(.9)&&Anchor(root).GetChildCount()==1&&Anchor(root,1).GetChildCount()==1,"fire .85 expiry independently retains poison");Check(c.AdvanceClock(1.3)&&Anchors(root)==0,"poison 1.2 expiry");
 Check(c.BeginBeforeConsumption("neutral","multiRelease",target,.2,.6),"neutral next begins");root.Call("advance_animation",.2);root.Call("advance_animation",.4);Check(c.ConfirmImpact("neutral","n","shootA",.6,target.Position)&&Anchors(root)==0,"neutral next has no lingering modifiers");c.Cancel("neutral");
 ImpactFixtureFacts.Charge=1;Check(c.BeginBeforeConsumption("cancel","multiRelease",target,.2,.6),"cancel fixture begins");root.Call("advance_animation",.2);root.Call("advance_animation",.4);Check(c.ConfirmImpact("cancel","h","shootA",.6,target.Position)&&Anchors(root)==1,"cancel fixture hit");Check(c.Cancel("cancel")&&Anchors(root)==0,"cancel clears owned impacts");
 var (exitRoot,exitCaller,exitVisual)=await New("exit");Check(exitCaller.BeginBeforeConsumption("exit","multiRelease",target,.2,.6),"exit fixture begins");exitRoot.Call("advance_animation",.2);exitRoot.Call("advance_animation",.4);Check(exitCaller.ConfirmImpact("exit","hit","shootA",.6,target.Position)&&Anchors(exitRoot)==1,"exit fixture impact");exitVisual.QueueFree();await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);Check(exitCaller.IsDisposed&&!exitCaller.ObserveCurrent(),"root exit terminal cleanup");c.Dispose();
 ImpactFixtureFacts.Charge=1;var(preparedRoot,preparedCaller,preparedVisual)=await New("prepared");
 var poisoned=preparedCaller.PrepareBeforeConsumption("preparedPoison","multiRelease",target,.2,.6);
 ImpactFixtureFacts.Charge=0;var plain=preparedCaller.PrepareBeforeConsumption("preparedNeutral","multiRelease",target,.2,.6);
 Check(poisoned!=null&&plain!=null&&preparedRoot.GetNode("ActionController").Get("context").AsGodotDictionary().Count==0,"prepared generated helpers capture without starting a native action");
 Check(preparedCaller.ObserveCurrent()&&preparedCaller.BeginPrepared(poisoned!),"prepared poison starts after consumption and newer passive observation");
 preparedRoot.Call("advance_animation",.2);preparedRoot.Call("advance_animation",.4);
 Check(preparedCaller.ConfirmImpact("preparedPoison","p","shootA",.6,target.Position)&&Anchors(preparedRoot)==1&&Anchor(preparedRoot).GetChildCount()==2,"normal packaged prepared snapshot retains poison and fire after consumption");
 Check(!preparedCaller.BeginPrepared(poisoned!)&&Anchors(preparedRoot)==1,"prepared handle replay cannot disturb its active packaged action");
 Check(preparedCaller.Complete("preparedPoison")&&preparedCaller.AdvanceClock(1.3)&&Anchors(preparedRoot)==0,"prepared action completes and owned impact tails expire");
 ImpactFixtureFacts.Charge=1;Check(preparedCaller.ObserveCurrent()&&preparedCaller.BeginPrepared(plain!),"older prepared neutral starts with a fresh native observation sequence");
 preparedRoot.Call("advance_animation",.2);preparedRoot.Call("advance_animation",.4);
 Check(preparedCaller.ConfirmImpact("preparedNeutral","n","shootA",.6,target.Position)&&Anchors(preparedRoot)==0,"prepared neutral never rereads the now-active modifier");
 preparedCaller.Cancel("preparedNeutral");var discarded=preparedCaller.PrepareBeforeConsumption("discarded","multiRelease",target,.2,.6);
 Check(discarded!=null&&preparedCaller.DiscardPrepared(discarded)&&!preparedCaller.BeginPrepared(discarded),"generated helper discards an unstarted snapshot without playback");
 var terminal=preparedCaller.PrepareBeforeConsumption("terminal","multiRelease",target,.2,.6);preparedVisual.QueueFree();await ToSignal(GetTree(),SceneTree.SignalName.ProcessFrame);
 Check(terminal!=null&&terminal.IsTerminal&&!preparedCaller.BeginPrepared(terminal),"factory root exit invalidates prepared handles in the packaged kit");preparedCaller.Dispose();
 File.WriteAllText(ProjectSettings.GlobalizePath("res://result.json"),System.Text.Json.JsonSerializer.Serialize(new{passed=true,checks,syntheticOnly=true,actualGameAcceptance=false,normalGeneratedHelpers=true,worldHitAnchor=true,preparedSnapshots=true}));GetTree().Quit();
 }catch(Exception e){GD.PushError(e.ToString());GetTree().Quit(1);}}
}
