#nullable enable
using System;
using System.Linq;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Text.Json;
using System.IO;
using Godot;
using HarmonyLib;
using BaseLib.Abstracts;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Models.CardPools;
using MegaCrit.Sts2.Core.Models.RelicPools;
using MegaCrit.Sts2.Core.Models.PotionPools;
using MegaCrit.Sts2.Core.Models.Encounters;
using MegaCrit.Sts2.Core.Entities.Characters;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.GameActions;
using MegaCrit.Sts2.Core.GameActions.Multiplayer;
using MegaCrit.Sts2.Core.Commands;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Runs;
using MegaCrit.Sts2.Core.Map;
using MegaCrit.Sts2.Core.Rooms;
using MegaCrit.Sts2.Core.Nodes;
using MegaCrit.Sts2.Core.Nodes.Combat;
using MegaCrit.Sts2.Core.Nodes.Rooms;
using MegaCrit.Sts2.Core.Modding;
using MegaCrit.Sts2.Core.Saves;
using MegaCrit.Sts2.Core.Assets;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using MegaCrit.Sts2.Core.Nodes.Screens.ModdingScreen;
using MegaCrit.Sts2.Core.Nodes.GodotExtensions;

// Test-only content. Vanilla pools and the empty relic list are deliberately not
// generated product defaults. No game artwork is copied into the fixture pack.
public sealed class PipelineFixtureCharacter : PlaceholderCharacterModel {
 public override CharacterGender Gender=>CharacterGender.Masculine;
 public override Color NameColor=>Colors.White;
 public override int StartingHp=>80;
 public override CardPoolModel CardPool=>ModelDb.CardPool<IroncladCardPool>();
 public override RelicPoolModel RelicPool=>ModelDb.RelicPool<IroncladRelicPool>();
 public override PotionPoolModel PotionPool=>ModelDb.PotionPool<IroncladPotionPool>();
 public override IEnumerable<CardModel> StartingDeck=>Enumerable.Repeat<CardModel>(ModelDb.Card<PipelineFixtureAttack>(),5);
 public override IReadOnlyList<RelicModel> StartingRelics=>Array.Empty<RelicModel>();
 public override List<(string,string)> Localization=>new(){("title","Pipeline fixture"),("titleObject","Pipeline fixture"),("description","Synthetic integration fixture"),("pronounObject","it"),("pronounSubject","it"),("pronounPossessive","its"),("possessiveAdjective","its"),("bestiaryQuote","Synthetic fixture"),("cardsModifierTitle","Fixture cards"),("cardsModifierDescription","Synthetic integration cards"),("unlockText","Fixture only")};
 public override NCreatureVisuals CreateCustomVisuals(){var visuals=GeneratedFixture.Presentation.Create(out var receipt);PipelineCombatFixture.LastVisuals=visuals;PipelineCombatFixture.LastReceipt=receipt;return visuals;}
}
[BaseLib.Utils.Pool(typeof(IroncladCardPool))]
public sealed class PipelineFixtureAttack : CustomCardModel {
 public PipelineFixtureAttack():base(0,CardType.Attack,CardRarity.Basic,TargetType.AnyEnemy){}
 public override Texture2D CustomPortrait=>ModelDb.Card<MegaCrit.Sts2.Core.Models.Cards.StrikeIronclad>().Portrait;
 public override List<(string,string)> Localization=>new(){("title","Fixture strike"),("description","Deal 1 damage.")};
 protected override async Task OnPlay(PlayerChoiceContext choiceContext,CardPlay cardPlay){
  if(cardPlay.Target==null)throw new Exception("Actual queued target missing");
  PipelineCombatFixture.Target=cardPlay.Target;PipelineCombatFixture.CardCalls++;
  if(PipelineCombatFixture.CardCalls==1){PipelineCombatPresentation.Current!.BeginBaseline(cardPlay.Target);await DamageCmd.Attack(1m).FromCard(this,cardPlay).Targeting(cardPlay.Target).Execute(choiceContext);PipelineCombatPresentation.Current.EndBaseline();}
  else await PipelineCombatPresentation.Current!.Play(this,choiceContext,cardPlay);
 }
 protected override void OnUpgrade(){}
}
[ModInitializer(nameof(Initialize))]
public static class GeneratedModInitializer {
 public static bool Initialized,MountedBeforeInitializer,SceneFreed,FactoryReceipt,PrimaryTree,BaseLibAnimation,PreparedPanel;
 public static void Initialize(){
  MountedBeforeInitializer=Godot.FileAccess.FileExists("res://pipeline_generated_fixture/character.tscn");
  var visuals=GeneratedFixture.Presentation.Create(out var receipt);
  Node2D root=null!;
  try{
   FactoryReceipt=receipt.TryGetPair(out var issued,out root)&&ReferenceEquals(issued,visuals);
   PrimaryTree=root.GetNode<AnimationTree>("AnimationTree").TreeRoot is AnimationNodeStateMachine;
   PreparedPanel=root.GetNode<Polygon2D>("Meshes/arrow").Texture.GetSize()==Vector2.One&&root.GetNode<Polygon2D>("Meshes/upper").Polygon.Length==10&&root.GetNode<Polygon2D>("Meshes/lower").Polygon.Length==10;
   ((SceneTree)Engine.GetMainLoop()).Root.GetChild(0).AddChild(visuals);
   BaseLibAnimation=BaseLib.Utils.CustomAnimation.PlayCustomAnimation(visuals,"attack");
  }finally{visuals.Free();SceneFreed=!GodotObject.IsInstanceValid(visuals)&&!GodotObject.IsInstanceValid(root);}
  var harmony=new Harmony("CharacterPipeline.ActualCombatFixture");
  harmony.Patch(AccessTools.Method(typeof(Creature),nameof(Creature.CreateVisuals)),postfix:new HarmonyMethod(typeof(PipelineCombatFixture),nameof(PipelineCombatFixture.Created)));
  harmony.Patch(AccessTools.Method(typeof(BaseLib.Utils.CustomAnimation),nameof(BaseLib.Utils.CustomAnimation.PlayCustomAnimation)),postfix:new HarmonyMethod(typeof(PipelineCombatFixture),nameof(PipelineCombatFixture.Animated)));
  harmony.Patch(AccessTools.Method(typeof(NPlayerTurnBanner),nameof(NPlayerTurnBanner.Create)),postfix:new HarmonyMethod(typeof(PipelineCombatFixture),nameof(PipelineCombatFixture.BannerCreated)));
  harmony.Patch(AccessTools.Method(typeof(NCombatStartBanner),nameof(NCombatStartBanner.Create)),postfix:new HarmonyMethod(typeof(PipelineCombatFixture),nameof(PipelineCombatFixture.StartBannerCreated)));
  Initialized=MountedBeforeInitializer&&FactoryReceipt&&PrimaryTree&&PreparedPanel&&BaseLibAnimation&&SceneFreed;
 }
}
public static class PipelineCombatFixture {
 public static NCreatureVisuals? LastVisuals;
 public static CharacterPipeline.Sts2.PipelineVisuals.OwnershipReceipt? LastReceipt;
 public static Creature? BoundCreature,Target;
 public static int CardCalls,AttackAnimations,VisualBindings;
 static NPlayerTurnBanner? ownedTurnBanner;static int bannerCreations;
 static NCombatStartBanner? ownedStartBanner;static int startBannerCreations;
 public static void BannerCreated(int roundNumber,NPlayerTurnBanner? __result){Require(roundNumber==1&&bannerCreations==0&&__result!=null&&__result.GetParent()==null&&!__result.IsInsideTree(),"Only exact first-turn original banner creation observed");ownedTurnBanner=__result;bannerCreations++;}
 public static void StartBannerCreated(NCombatStartBanner? __result){Require(startBannerCreations==0&&__result!=null&&__result.GetParent()==null&&!__result.IsInsideTree(),"Only exact original combat-start banner creation observed");ownedStartBanner=__result;startBannerCreations++;}
 public static void Created(Creature __instance,NCreatureVisuals? __result){
  if(__instance.Player?.Character is not PipelineFixtureCharacter)return;
  Require(ReferenceEquals(__result,LastVisuals)&&LastReceipt!=null&&LastReceipt.TryGetPair(out var issued,out var root)&&ReferenceEquals(issued,__result)&&root!=null,"Actual Creature.CreateVisuals issued exact generated pair");
  BoundCreature=__instance;VisualBindings++;
 }
 public static void Animated(Node n,string[] tryAnimNames,bool __result){if(n is NCreature creature&&ReferenceEquals(creature.Entity,BoundCreature)&&ReferenceEquals(creature.Visuals,LastVisuals)&&__result&&tryAnimNames.Contains("attack"))AttackAnimations++;}
 static void Require(bool condition,string message){if(!condition)throw new Exception(message);}
 static async Task WaitFor(Func<bool> ready,string stage){
  var tree=(SceneTree)Engine.GetMainLoop();var deadline=Time.GetTicksMsec()+10000;
  while(!ready()){Require(Time.GetTicksMsec()<deadline,"Timed out waiting for actual "+stage);await tree.ToSignal(tree,SceneTree.SignalName.ProcessFrame);}
 }
 public static async Task RunCombatAsync(){
  var tree=(SceneTree)Engine.GetMainLoop();
  var diagnosticNoPreload=OS.GetCmdlineUserArgs().Contains("--iteration-no-preload");
  Require(PreloadManager.Enabled==!diagnosticNoPreload,"Actual preload mode matches explicit launch arguments");
  var serialCommonWarmup=OS.GetCmdlineUserArgs().Contains("--serial-common-warmup");Require(serialCommonWarmup,"Explicit serial common warmup diagnostic required");
  Require(NModalContainer.Instance.OpenModal is NConfirmModLoadingPopup,"Exact initial mod consent popup expected");
  var consent=(NConfirmModLoadingPopup)NModalContainer.Instance.OpenModal;
  var noButton=consent.GetNode<NVerticalPopup>("VerticalPopup").NoButton;
  Require(ReferenceEquals(consent.DefaultFocusedControl,noButton)&&noButton.IsInsideTree(),"Exact actual cancel callback button");
  noButton.EmitSignal(NClickableControl.SignalName.Released,noButton);
  await WaitFor(()=>!GodotObject.IsInstanceValid(consent)&&NModalContainer.Instance.OpenModal==null,"actual popup cancel callback");
  Require(ModManager.PlayerAgreedToModLoading&&SaveManager.Instance.SettingsSave.ModSettings?.PlayerAgreedToModLoading==false,"Cancel only updated isolated settings; owned loaded mod authority preserved");
  // The guard has already proved this is a new unique userdata root. This
  // input-free fixture disables tutorials only in that isolated test profile.
  SaveManager.Instance.SetFtuesEnabled(false);
  var state=await NGame.Instance.StartNewSingleplayerRun(ModelDb.Character<PipelineFixtureCharacter>(),false,ActModel.GetDefaultList().ToList(),Array.Empty<ModifierModel>(),"PIPELINEFIXTURE",GameMode.Standard);
  GodotObject? oldVisuals=null,oldRoot=null;int damage=0,frameWidth=0,frameHeight=0;bool frameCaptured=false;
  try{
  await RunManager.Instance.EnterRoomDebug(RoomType.Monster,MapPointType.Unassigned,ModelDb.Encounter<BattlewornDummyEventV1Encounter>().ToMutable(),showTransition:false);
  var player=state.Players.Single();
  await WaitFor(()=>CombatManager.Instance.IsInProgress&&player.PlayerCombatState?.Phase==PlayerTurnPhase.Play,"player play phase");
  Require(startBannerCreations==1&&ownedStartBanner!=null,"Actual original combat-start banner was created");
  await WaitFor(()=>bannerCreations==1&&ownedTurnBanner!=null,"actual chained first-turn banner creation");
  await WaitFor(()=>!GodotObject.IsInstanceValid(ownedTurnBanner)&&!GodotObject.IsInstanceValid(ownedStartBanner),"actual standard combat/player-turn banner tween completion");
  var combat=player.Creature.CombatState!;var target=combat.Creatures.Single(c=>c.IsMonster);
  Require(ReferenceEquals(BoundCreature,player.Creature)&&VisualBindings==1,"Real custom character visual binding observed");
  var node=NCombatRoom.Instance.GetCreatureNode(player.Creature)!;
  Require(ReferenceEquals(node.Visuals,LastVisuals)&&node.IsInsideTree(),"Actual NCreature owns generated visual pair");
  Require(LastReceipt!.TryGetPair(out _,out var compiledRoot)&&compiledRoot!=null,"Actual generated body receipt remains valid");
  var panel=compiledRoot!.GetNode<Polygon2D>("Meshes/arrow");Require(panel.Visible&&panel.IsVisibleInTree()&&panel.Texture!=null,"Actual generated synthetic arrow visible in tree");
  var presentation=await PipelineCombatPresentation.Attach(player.Creature,LastReceipt!);
  var card=combat.CreateCard<PipelineFixtureAttack>(player);await CardPileCmd.Add(card,PileType.Hand);
  var hp=target.CurrentHp;var action=new PlayCardAction(card,target);
  RunManager.Instance.ActionQueueSynchronizer.RequestEnqueue(action);await WaitFor(()=>action.CompletionTask.IsCompleted,"queued card completion");await action.CompletionTask;
  Require(action.Exception==null&&CardCalls==1&&ReferenceEquals(Target,target)&&target.CurrentHp==hp-1,"Actual queued attack resolved exact one damage");
  Require(AttackAnimations>0,"Actual game attack routed through BaseLib into generated animation tree");
  for(int i=0;i<2;i++){
   var bowCard=combat.CreateCard<PipelineFixtureAttack>(player);await CardPileCmd.Add(bowCard,PileType.Hand);
   var bowAction=new PlayCardAction(bowCard,target);RunManager.Instance.ActionQueueSynchronizer.RequestEnqueue(bowAction);
   await WaitFor(()=>bowAction.CompletionTask.IsCompleted,"actual queued bow action");await bowAction.CompletionTask;
   Require(bowAction.Exception==null,"Actual queued bow action completed without exception");
  }
  presentation.WriteReceipt();Require(target.CurrentHp==hp-5&&CardCalls==3,"All three real queued fixture cards own their damage");
  Require(NModalContainer.Instance.OpenModal==null,"No modal overlays actual combat capture");
  await tree.ToSignal(RenderingServer.Singleton,RenderingServer.SignalName.FramePostDraw);
  using(var frame=tree.Root.GetTexture().GetImage()){
   frameWidth=frame.GetWidth();frameHeight=frame.GetHeight();Require(frameWidth>0&&frameWidth<=4096&&frameHeight>0&&frameHeight<=4096,"Bounded actual rendered combat frame");
   Require(frame.SavePng(ProjectSettings.GlobalizePath("res://combat-frame.png"))==Error.Ok,"Owned actual combat frame saved");frameCaptured=true;
  }
  oldVisuals=LastVisuals;oldRoot=node.Body;damage=hp-target.CurrentHp;
  }finally{
   if(RunManager.Instance.DebugOnlyGetState()!=null)await NGame.Instance.ReturnToMainMenu();
   for(int i=0;i<3;i++)await tree.ToSignal(tree,SceneTree.SignalName.ProcessFrame);
   new Harmony("CharacterPipeline.ActualCombatFixture").UnpatchAll("CharacterPipeline.ActualCombatFixture");
  }
  var cleaned=RunManager.Instance.DebugOnlyGetState()==null&&!CombatManager.Instance.IsInProgress&&!GodotObject.IsInstanceValid(oldVisuals)&&!GodotObject.IsInstanceValid(oldRoot);
  Require(cleaned,"Actual combat cleanup releases run state and generated visuals");
  File.WriteAllText(ProjectSettings.GlobalizePath("res://combat-result.json"),JsonSerializer.Serialize(new{cardPlayed=true,cleanup=cleaned,damage,cardCalls=CardCalls,attackAnimations=AttackAnimations,visualBindings=VisualBindings,bannerCompleted=bannerCreations==1&&startBannerCreations==1&&!GodotObject.IsInstanceValid(ownedTurnBanner)&&!GodotObject.IsInstanceValid(ownedStartBanner),gameAcceptance=false,normalPreloadAcceptance=false,coldPrefetchAcceptance=false,serialCommonWarmup,frameCaptured,frameWidth,frameHeight,modalVisible=false,diagnosticNoPreload,preloadEnabled=PreloadManager.Enabled}));
 }
}
