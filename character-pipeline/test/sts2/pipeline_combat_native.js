'use strict';
const assert=require('node:assert/strict');
function validateCombatReport(report){
 assert.equal(report.cardPlayed,true,'Actual queued fixture card receipt missing');
 assert.equal(report.cleanup,true,'Actual combat cleanup missing');
 assert.equal(report.bannerCompleted,true,'Actual player-turn banner completion missing');
 assert.equal(report.damage,5);assert.equal(report.cardCalls,3);assert(Number.isSafeInteger(report.attackAnimations)&&report.attackAnimations>0&&report.attackAnimations<=16);assert.equal(report.visualBindings,1);
 assert.equal(report.gameAcceptance,false);assert.equal(report.normalPreloadAcceptance,false);
 assert.equal(report.preloadEnabled,true);assert.equal(report.diagnosticNoPreload,false);
 assert.equal(report.coldPrefetchAcceptance,false);assert.equal(report.serialCommonWarmup,true);assert.equal(report.frameCaptured,true);assert.equal(report.modalVisible,false);
 assert(Number.isSafeInteger(report.frameWidth)&&report.frameWidth>0&&report.frameWidth<=4096);assert(Number.isSafeInteger(report.frameHeight)&&report.frameHeight>0&&report.frameHeight<=4096);
}
function replaceOnce(source,before,after){assert.equal(source.split(before).length,2,'Read-only startup seam changed: '+before);return source.replace(before,after);}
function validateLifetimeReport(report){assert.equal(report.passed,true);assert(Number.isSafeInteger(report.powerIssued)&&report.powerIssued>=1&&report.powerIssued<=8);assert(Number.isSafeInteger(report.powerFreed)&&report.powerFreed>=0&&report.powerFreed<=report.powerIssued);assert.equal(report.remainingPowerNodes,0);assert.equal(report.powerRetired,true);}
function validatePresentationReport(report){
 for(const field of ['passed','lastChargeConsumed','powerUiSeen','powerUiRemoved','activeCleared','gameOwnsDamage'])assert.equal(report[field],true,field);
 assert.equal(report.queuedBowAttacks,2);assert.equal(report.confirmedImpacts,4);assert.equal(report.manualAnimationAdvance,false);assert.equal(report.gameAcceptance,false);
 assert(Array.isArray(report.colors)&&report.colors.length===4);report.colors.forEach((color,i)=>{assert(Array.isArray(color)&&color.length===4&&color.every(Number.isFinite));assert(color[1]>.9&&color[3]>.9);assert(i<2?color[0]<.1&&color[2]<.1:color[0]>.9&&color[2]>.9);});
 assert(Array.isArray(report.impactClocks)&&report.impactClocks.length===2&&report.impactClocks.every(t=>Number.isFinite(t)&&t>=1&&t<=10));
 assert(Array.isArray(report.releasePositions)&&report.releasePositions.length===4&&report.releasePositions.every(p=>Array.isArray(p)&&p.length===2&&p.every(v=>Number.isFinite(v)&&Math.abs(v)<=1000000)));
 assert(Array.isArray(report.drawnPoses)&&report.drawnPoses.length===2&&report.drawnPoses.every(p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite)&&p[0]<=-45&&p[1]<-.05&&p[2]>.05));
 assert.equal(report.frameDistinguishesArrowPair,false);
 assert.deepEqual(report.origin,[120,360]);assert.deepEqual(report.appliedBounds,[-70,-210,150,140]);
 assert.deepEqual(report.frames,['bow-before.png','bow-drawn.png','bow-released-green.png','bow-next-before.png','bow-next-drawn.png','bow-released-white.png']);
}
async function main(){
 const fs=require('node:fs/promises'),path=require('node:path'),Module=require('node:module');
 assert(process.argv.includes('--serial-common-warmup'),'Explicit --serial-common-warmup is required');assert(!process.argv.includes('--iteration-no-preload'),'Original preloading must remain enabled');
 let source=await fs.readFile(path.join(__dirname,'modded_game_startup_native.js'),'utf8');
 source=replaceOnce(source,"'evidence/modded-game-startup'","'evidence/pipeline-combat'");
 source=replaceOnce(source,"await fs.copyFile(path.join(__dirname,'GeneratedModInitializer.cs'),path.join(fixture,'GeneratedModInitializer.cs'));","await fs.copyFile(path.join(__dirname,'PipelineCombatFixture.cs'),path.join(fixture,'PipelineCombatFixture.cs'));");
 source=source.replaceAll("'GeneratedModInitializer.cs'","'PipelineCombatFixture.cs'");
 const specStart=source.indexOf(' const spec=createSpec('),specEnd=source.indexOf(' const compiled=await compileGodot(',specStart);assert(specStart>=0&&specEnd>specStart,'Frozen synthetic spec seam changed');
 source=source.slice(0,specStart)+` const presentation=require(path.join(__dirname,'combat_presentation_fixture.js')).createCombatPresentationFixture({imagePath:image,pngBytes:png,powerSourceBytes:await fs.readFile(path.join(__dirname,'PipelineCombatPresentation.cs')),powerSourcePath:path.join(__dirname,'PipelineCombatPresentation.cs'),powerSymbol:'PipelineArrowChargePower'});const spec=presentation.spec;await fs.writeFile(path.join(out,'presentation-audit.json'),JSON.stringify({plan:presentation.effectBuild.plan,inventory:presentation.effectBuild.inventory,sourceHash:crypto.createHash('sha256').update(await fs.readFile(path.join(__dirname,'PipelineCombatPresentation.cs'))).digest('hex')},null,2));\n`+source.slice(specEnd);
 source=replaceOnce(source,"stagingDir:path.join(out,'compiled'),config:","stagingDir:path.join(out,'compiled'),effectBuild:presentation.effectBuild,config:");
 source=replaceOnce(source,'bounds:{x:0,y:0,width:16,height:16}','bounds:{x:50,y:150,width:150,height:140},origin:{x:120,y:360}');
 source=replaceOnce(source,"const plan=planGodotResources({namespace:'pipeline_generated_fixture',files:await capture(compiled.project)});","const plan=planGodotResources({namespace:'pipeline_generated_fixture',files:await capture(compiled.project)});const runtimeScene=Buffer.from(plan.files.find(f=>f.sourcePath==='character.tscn').base64,'base64').toString('utf8');assert(!/\"(?:evidence|excerpt|reason)\"/.test(runtimeScene)&&!runtimeScene.includes('PipelineCombatPresentation.cs')&&!runtimeScene.includes(path.join(__dirname,'PipelineCombatPresentation.cs')),'Runtime scene contains development source evidence');");
 source=replaceOnce(source,"await fs.copyFile(path.join(root,'adapters/sts2/PipelineVisuals.cs'),path.join(fixture,'PipelineVisuals.cs'));","await fs.copyFile(path.join(root,'adapters/sts2/PipelineVisuals.cs'),path.join(fixture,'PipelineVisuals.cs'));await fs.copyFile(path.join(root,'adapters/sts2/AttackPresentationBinding.cs'),path.join(fixture,'AttackPresentationBinding.cs'));await fs.copyFile(path.join(__dirname,'PipelineCombatPresentation.cs'),path.join(fixture,'PipelineCombatPresentation.cs'));");
 source=replaceOnce(source,"['Presentation.cs','PipelineVisuals.cs','PipelineCombatFixture.cs']","['Presentation.cs','PipelineVisuals.cs','AttackPresentationBinding.cs','PipelineCombatFixture.cs','PipelineCombatPresentation.cs']");
 const copySeam="const game='C:/Program Files (x86)/Steam/steamapps/common/Slay the Spire 2/data_sts2_windows_x86_64',engine='D:/StS2Modding/tools/MegaDot';";
 source=replaceOnce(source,copySeam,`await fs.copyFile(path.join(__dirname,'PipelineCombatHarness.cs'),path.join(runtime,'PipelineCombatHarness.cs'));
 await fs.copyFile(path.join(__dirname,'PrefetchCompatibilityHarness.cs'),path.join(runtime,'PrefetchCompatibilityHarness.cs'));
 let harness=await fs.readFile(path.join(runtime,'ModdedGameStartupHarness.cs'),'utf8');
 const once=(a,b)=>{assert.equal(harness.split(a).length,2,'Frozen CSharp seam changed: '+a);harness=harness.replace(a,b);};
 once('  game=ResourceLoader.Load<PackedScene>("res://scenes/game.tscn").Instantiate<NGame>();','  PrefetchCompatibilityHarness.Install();\\n  PipelineCombatHarness.Install();\\n  game=ResourceLoader.Load<PackedScene>("res://scenes/game.tscn").Instantiate<NGame>();');
 once('   ReleaseOwnPrewarmedPools();','   PipelineCombatHarness.ReleaseOwnedPoolObjects();ReleaseOwnPrewarmedPools();');
 once('MegaCrit.Sts2.Core.Nodes.Screens.MainMenu.NEarlyAccessDisclaimer? ownedDisclaimer;','readonly List<MegaCrit.Sts2.Core.Nodes.Screens.MainMenu.NEarlyAccessDisclaimer> ownedDisclaimers=new();');
 once('self.Check(self.entered&&self.ownedDisclaimer==null&&__result.GetParent()==null,"Only newly created actual startup disclaimer retained for owned cleanup");self.ownedDisclaimer=__result;','self.Check(self.entered&&self.ownedDisclaimers.Count<4&&__result.GetParent()==null&&!__result.IsInsideTree()&&!self.ownedDisclaimers.Any(n=>ReferenceEquals(n,__result)),"Only bounded newly issued detached disclaimers retained");self.ownedDisclaimers.Add(__result);');
 once('if(ownedDisclaimer!=null&&GodotObject.IsInstanceValid(ownedDisclaimer)){Check(ownedDisclaimer.GetParent()==null&&!ownedDisclaimer.IsInsideTree(),"Only captured detached startup disclaimer freed");ownedDisclaimer.Free();}ownedDisclaimer=null;','foreach(var disclaimer in ownedDisclaimers){if(GodotObject.IsInstanceValid(disclaimer)){Check(disclaimer.GetParent()==null&&!disclaimer.IsInsideTree(),"Only exact captured detached disclaimer freed");disclaimer.Free();}}ownedDisclaimers.Clear();');
 const combatSeam='  Finish(null);';assert.equal(harness.split(combatSeam).length,2,'Startup combat injection seam changed');
 harness=harness.replace(combatSeam,'  await PipelineCombatHarness.RunAsync();\\n  PrefetchCompatibilityHarness.Finish();\\n'+combatSeam);
 await fs.writeFile(path.join(runtime,'ModdedGameStartupHarness.cs'),harness);
 ${copySeam}`);
 source=replaceOnce(source,"affects_gameplay:false","affects_gameplay:true");
 source=replaceOnce(source,'const result=await runTool({native:',"if(process.argv.includes('--build-only'))return;const result=await runTool({native:");
 source=replaceOnce(source,"console.log(JSON.stringify(report));","const combat=JSON.parse(await fs.readFile(path.join(runtime,'combat-result.json')));require(path.join(__dirname,'pipeline_combat_native.js')).validateCombatReport(combat);const prefetch=JSON.parse(await fs.readFile(path.join(runtime,'prefetch-result.json')));require(path.join(__dirname,'prefetch_compatibility_native.js')).validate(prefetch);assert(prefetch.invocations>=2,'Actual return menu common loader observed');const frame=await fs.readFile(path.join(runtime,'combat-frame.png'));assert(frame.length>100&&frame.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'Actual rendered combat PNG missing');console.log(JSON.stringify({startup:report,combat,prefetch}));");
 source=replaceOnce(source,"console.log(JSON.stringify({startup:report,combat,prefetch}));","const lifetime=JSON.parse(await fs.readFile(path.join(runtime,'lifetime-result.json')));require(path.join(__dirname,'pipeline_combat_native.js')).validateLifetimeReport(lifetime);console.log(JSON.stringify({startup:report,combat,prefetch,lifetime}));");
 source=replaceOnce(source,"console.log(JSON.stringify({startup:report,combat,prefetch,lifetime}));","const presentationResult=JSON.parse(await fs.readFile(path.join(runtime,'presentation-result.json')));require(path.join(__dirname,'pipeline_combat_native.js')).validatePresentationReport(presentationResult);for(const name of presentationResult.frames){const pixels=await fs.readFile(path.join(runtime,name));assert(pixels.length>100&&pixels.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));}console.log(JSON.stringify({startup:report,combat,prefetch:{...prefetch,warmedPaths:undefined},lifetime,presentation:presentationResult}));");
 source=replaceOnce(source,"['--headless','--path',runtime","[...(process.argv.includes('--verbose')?['--verbose']:[]),'--rendering-method','gl_compatibility','--rendering-driver','opengl3','--windowed','--position','30000,30000','--path',runtime");
 source=replaceOnce(source,"...(process.argv.includes('--iteration-no-preload')?['--','--iteration-no-preload']:[])","'--','-wpos','30000','30000','--serial-common-warmup'");
 source=source.replace('/SCRIPT ERROR|^ERROR:/','/SCRIPT ERROR|^ERROR:|^\\[ERROR\\]/');
 const wrapped=new Module(path.join(__dirname,'pipeline_combat_runtime.js'),module);wrapped.filename=path.join(__dirname,'pipeline_combat_runtime.js');wrapped.paths=module.paths;
 // The original opt-in guard only runs the entry module. This transformed copy
 // invokes its same private main and keeps all startup isolation checks intact.
 source=source.replace('require.main===module&&process.argv.includes(\'--run\')','false');
 wrapped._compile(source+'\nmodule.exports.run=main;',wrapped.filename);await wrapped.exports.run();
}
if(require.main===module&&process.argv.includes('--run'))main().catch(error=>{console.error(error);process.exitCode=1;});
if(process.argv.includes('--self-test')){
 const test=require('node:test');
 test('combat gate requires the genuine queued action receipt',()=>{assert.throws(()=>validateCombatReport({cardPlayed:false}),/Actual queued/);assert.throws(()=>validateCombatReport({cardPlayed:true}),/Actual combat cleanup/);});
 test('combat gate rejects incomplete, duplicated, or overstated native receipts',()=>{
  const valid={cardPlayed:true,cleanup:true,damage:5,cardCalls:3,attackAnimations:1,visualBindings:1,gameAcceptance:false,normalPreloadAcceptance:false,diagnosticNoPreload:false,preloadEnabled:true,coldPrefetchAcceptance:false,serialCommonWarmup:true,frameCaptured:true,frameWidth:1920,frameHeight:1080,modalVisible:false,bannerCompleted:true};
  validateCombatReport(valid);
  for(const [key,value]of Object.entries({damage:0,cardCalls:2,attackAnimations:0,visualBindings:0,gameAcceptance:true,normalPreloadAcceptance:true,diagnosticNoPreload:true}))assert.throws(()=>validateCombatReport({...valid,[key]:value}),key);
 });
 test('actual default preloading is recorded without claiming normal game acceptance',()=>{validateCombatReport({cardPlayed:true,cleanup:true,damage:5,cardCalls:3,attackAnimations:1,visualBindings:1,gameAcceptance:false,normalPreloadAcceptance:false,diagnosticNoPreload:false,preloadEnabled:true,coldPrefetchAcceptance:false,serialCommonWarmup:true,frameCaptured:true,frameWidth:1920,frameHeight:1080,modalVisible:false,bannerCompleted:true});});
 test('read-only startup injection refuses absent or ambiguous seams',()=>{assert.equal(replaceOnce('before','before','after'),'after');assert.throws(()=>replaceOnce('missing','before','after'));assert.throws(()=>replaceOnce('before before','before','after'));});
 test('auto-added fixture card declares the required actual BaseLib pool attribute',()=>{const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'PipelineCombatFixture.cs'),'utf8');assert.match(source,/\[BaseLib\.Utils\.Pool\(typeof\(IroncladCardPool\)\)\]\s*public sealed class PipelineFixtureAttack/);});
 test('GPU combat receipt refuses missing capture and overstated cold prefetch acceptance',()=>{const receipt={cardPlayed:true,cleanup:true,damage:5,cardCalls:3,attackAnimations:1,visualBindings:1,gameAcceptance:false,normalPreloadAcceptance:false,diagnosticNoPreload:false,preloadEnabled:true};assert.throws(()=>validateCombatReport({...receipt,coldPrefetchAcceptance:true}));});
 test('receipt rejects disabled preload and unbounded animation evidence',()=>{const r={cardPlayed:true,cleanup:true,damage:5,cardCalls:3,attackAnimations:1,visualBindings:1,gameAcceptance:false,normalPreloadAcceptance:false,diagnosticNoPreload:false,preloadEnabled:true,coldPrefetchAcceptance:false,serialCommonWarmup:true,frameCaptured:true,frameWidth:1920,frameHeight:1080,modalVisible:false,bannerCompleted:true};for(const patch of [{preloadEnabled:false,diagnosticNoPreload:true},{attackAnimations:Infinity},{attackAnimations:NaN},{attackAnimations:1.5}])assert.throws(()=>validateCombatReport({...r,...patch}));});
 test('exact VFX lifetime receipt refuses missing, unbounded, or surviving issuance',()=>{const r={passed:true,powerIssued:1,powerFreed:1,remainingPowerNodes:0,powerRetired:true};validateLifetimeReport(r);for(const patch of[{powerRetired:false},{powerIssued:0},{powerIssued:9},{powerFreed:2},{remainingPowerNodes:1}])assert.throws(()=>validateLifetimeReport({...r,...patch}));});
 test('real bow receipt requires two green then two white releases and actual game impacts',()=>{
  assert.throws(()=>validatePresentationReport({passed:true,lastChargeConsumed:true}));
  const valid={passed:true,lastChargeConsumed:true,powerUiSeen:true,powerUiRemoved:true,activeCleared:true,gameOwnsDamage:true,queuedBowAttacks:2,confirmedImpacts:4,manualAnimationAdvance:false,gameAcceptance:false,colors:[[0,1,0,1],[0,1,0,1],[1,1,1,1],[1,1,1,1]],impactClocks:[1,1],releasePositions:[[1,2],[1,2],[1,2],[1,2]],drawnPoses:[[-55,-.1,.1],[-55,-.1,.1]],frameDistinguishesArrowPair:false,origin:[120,360],appliedBounds:[-70,-210,150,140],frames:['bow-before.png','bow-drawn.png','bow-released-green.png','bow-next-before.png','bow-next-drawn.png','bow-released-white.png']};
  validatePresentationReport(valid);
  for(const patch of[{lastChargeConsumed:false},{powerUiRemoved:false},{confirmedImpacts:2},{manualAnimationAdvance:true},{impactClocks:[.9,1]},{colors:[[1,1,1,1],[1,1,1,1],[1,1,1,1],[1,1,1,1]]},{drawnPoses:[[-10,0,0],[-55,-.1,.1]]},{releasePositions:[[Infinity,1]]},{frameDistinguishesArrowPair:true},{origin:[0,0]}])assert.throws(()=>validatePresentationReport({...valid,...patch}));
 });
 test('combat capture requires the actual player turn banner to finish normally',()=>{const r={cardPlayed:true,cleanup:true,damage:5,cardCalls:3,attackAnimations:1,visualBindings:1,gameAcceptance:false,normalPreloadAcceptance:false,diagnosticNoPreload:false,preloadEnabled:true,coldPrefetchAcceptance:false,serialCommonWarmup:true,frameCaptured:true,frameWidth:1920,frameHeight:1080,modalVisible:false,bannerCompleted:false};assert.throws(()=>validateCombatReport(r));});
}
module.exports={validateCombatReport,validateLifetimeReport,validatePresentationReport};





