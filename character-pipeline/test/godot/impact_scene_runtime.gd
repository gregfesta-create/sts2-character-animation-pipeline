extends SceneTree
var checks: Array = []
func check(value: bool, label: String) -> void:
 checks.append({"name":label,"passed":value})
 if not value: push_error(label)
func _initialize() -> void: call_deferred("run")
func texture(color: Color) -> Texture2D:
 var image = Image.create(4,4,false,Image.FORMAT_RGBA8)
 image.fill(color)
 return ImageTexture.create_from_image(image)
func scene(catalog: Array):
 var node = load("res://effect_scene_controller.gd").new()
 root.add_child(node)
 var target = Node2D.new()
 root.add_child(target)
 var ok: bool = node.configure_trusted({"adapterContractVersion":"1","decisions":[]},catalog,"hero",{"wing":target})
 check(ok,"configure declared impact resources")
 return node
func run() -> void:
 var red = texture(Color.RED)
 var blue = texture(Color.BLUE)
 var poison = texture(Color.GREEN)
 var catalog: Array = [{"id":"fire","capability":"tint","presentation":{"color":Color.RED},"impact":{"durationSeconds":0.85,"presentation":{"frames":[red,blue],"durations":[0.1,0.1],"offset":Vector2.ZERO,"scale":Vector2.ONE,"loop":true}}},{"id":"poison","capability":"overlay","presentation":{"texture":poison,"offset":Vector2.ZERO,"scale":Vector2.ONE},"impact":{"durationSeconds":1.2,"presentation":{"texture":poison,"offset":Vector2(8,0),"scale":Vector2.ONE}}}]
 catalog.append({"id":"plain","capability":"tint","presentation":{"color":Color.WHITE}})
 var node = scene(catalog)
 var generation_ids: Array[String] = ["fire"]
 check(node.confirm_impact("generation", "RealGust", "hit", Vector2.ZERO,generation_ids),"string generation accepts actual binding token")
 node.cancel_attack("generation","RealGust")
 check(node.impact_status().anchors==0,"string generation cancellation exact")
 var enemy = Node2D.new()
 enemy.position=Vector2(30,30)
 enemy.modulate=Color(0.3,0.6,0.9)
 root.add_child(enemy)
 check(node.confirm_impact("typed", "1", "hit",Vector2.ZERO,generation_ids) and node.confirm_impact("typed",1.0,"hit",Vector2.ZERO,generation_ids),"numeric and string generations remain distinct")
 check(not node.confirm_impact("typed",1,"hit",Vector2.ZERO,generation_ids),"integer and integral float generation deduplicate")
 node.cancel_attack("typed",1)
 check(node.impact_status().anchors==1,"numeric cancellation leaves string generation")
 node.cancel_attack("typed","1")
 var diagnostic_before: int = node.impact_status().diagnostics.size()
 node.report_impact_diagnostic("ambiguous_release_socket")
 check(node.impact_status().diagnostics.size()==diagnostic_before+1 and node.impact_status().anchors==0,"trusted omitted-visual diagnostic allocates no visual")
 var ids: Array[String] = ["fire","poison"]
 check(node.confirm_impact("attack",1,"hit",Vector2(30,30),ids),"simultaneous confirmed overlays")
 ids.clear()
 catalog[0].impact.durationSeconds=0.01
 check(node.impact_status().configured and node.impact_status().effectIds==["fire","poison"],"compiled impact IDs exposed by runtime")
 check(enemy.get_child_count()==0 and enemy.position==Vector2(30,30) and enemy.modulate==Color(0.3,0.6,0.9),"receiver enemy properties and children untouched")
 var impacts = node._impacts
 var anchor = impacts.get_child(0)
 check(anchor.global_position==Vector2(30,30) and anchor.get_child_count()==2,"owned world anchor with two actual renderers and sprites")
 check(anchor.get_child(0).texture==red and anchor.get_child(1).texture==poison,"actual resource textures")
 check(not node.confirm_impact("attack",1,"hit",Vector2.ZERO,ids),"duplicate hit rejected")
 check(node.advance(0.15) and anchor.get_child(0).texture==blue,"animation advanced deterministically")
 node.set_paused(true)
 check(not anchor.visible,"pause hides without destroying")
 node.set_paused(false)
 check(anchor.visible and anchor.get_child(0).texture==blue,"resume preserves animation phase")
 node.complete_attack("attack",1)
 check(node.impact_status().anchors==1,"complete preserves started impacts")
 check(node.advance(0.9) and anchor.get_child_count()==1 and anchor.get_child(0).texture==poison,"independent expiry and catalog input copied")
 check(not node.advance(0.8) and node.impact_status().anchors==1,"clock rollback rejected")
 check(node.advance(1.2) and node.impact_status().anchors==0,"all effects expire")
 var both: Array[String] = ["fire","poison"]
 var undeclared: Array[String] = ["unknown"]
 var before_unknown: Dictionary = node.impact_status()
 check(not node.confirm_impact("unknown",1,"cue",Vector2.ZERO,undeclared) and node.impact_status().anchors==before_unknown.anchors and node.impact_status().dedupKeys==before_unknown.dedupKeys,"undeclared IDs rejected without allocation or dedup")
 var unknown: Array[String] = ["plain"]
 check(node.confirm_impact("neutral",1,"none",Vector2.ZERO,unknown) and node.impact_status().anchors==0,"unknown or no-impact IDs allocate nothing")
 var repeated: Array[String] = ["fire","fire"]
 check(not node.confirm_impact("bad",1,"cue",Vector2.ZERO,repeated) and node.impact_status().anchors==0,"whole invalid selection rejected before allocation")
 check(not node.confirm_impact("bad",1,"cue",Vector2(INF,0),both),"nonfinite position rejected")
 check(not node.confirm_impact("bad",-1,"cue",Vector2.ZERO,both),"invalid generation rejected")
 var many: Array[String] = ["a","b","c","d","e","f","g","h","i"]
 check(not node.confirm_impact("bad",1,"cue",Vector2.ZERO,many),"selected cap enforced")
 check(node.confirm_impact("cancel",1,"one",Vector2.ZERO,both) and node.confirm_impact("keep",1,"two",Vector2.ZERO,both),"distinct hit cues allocate independently")
 node.cancel_attack("cancel",1)
 check(node.impact_status().anchors==1,"cancel clears only action ownership")
 node.combat_end()
 check(node.impact_status().anchors==0 and node.impact_status().dedupKeys==0,"combat end clears anchors and ledger")
 for index in range(32): node.confirm_impact("quota",1,str(index),Vector2.ZERO,both)
 check(node.impact_status().anchors==32 and not node.confirm_impact("quota",1,"overflow",Vector2.ZERO,both),"owner anchor budget rejects without eviction")
 var other = scene(catalog)
 check(other.confirm_impact("other",1,"hit",Vector2.ZERO,both),"separate owner remains independent")
 node.combat_end()
 check(other.impact_status().anchors==1,"owner cleanup does not affect another owner")
 other.free()
 var owners: Array = []
 for index in range(8):
  var owner = scene(catalog)
  owners.append(owner)
  for hit in range(32): owner.confirm_impact("quota",1,str(hit),Vector2.ZERO,both)
 var clone = load("res://impact_controller_clone.gd").new()
 root.add_child(clone)
 check(clone.configure(catalog) and not clone.confirm("clone",1,"hit",Vector2.ZERO,both),"separate script resource shares scene anchor quota")
 clone.free()
 var extra = scene(catalog)
 check(not extra.confirm_impact("overflow",1,"hit",Vector2.ZERO,both) and owners[0].impact_status().anchors==32,"scene budget without eviction")
 for owner in owners: owner.free()
 check(extra.confirm_impact("overflow",1,"hit",Vector2.ZERO,both),"root exit releases scene quota")
 extra.free()
 check(root.get_meta("_character_pipeline_impact_registry_v1").anchors.size()==0,"all owner teardown empties shared registry")
 root.set_meta("_character_pipeline_impact_registry_v1",{"version":1,"anchors":["corrupt"]})
 var corrupt_owner = scene(catalog)
 check(not corrupt_owner.confirm_impact("corrupt",1,"hit",Vector2.ZERO,both) and corrupt_owner.impact_status().anchors==0 and corrupt_owner.impact_status().dedupKeys==0,"corrupt shared registry fails closed without allocation")
 corrupt_owner.free()
 root.remove_meta("_character_pipeline_impact_registry_v1")
 var dead_anchor = Node2D.new()
 var dead_ref = weakref(dead_anchor)
 dead_anchor.free()
 var queued_anchor = Node2D.new()
 root.add_child(queued_anchor)
 queued_anchor.queue_free()
 root.set_meta("_character_pipeline_impact_registry_v1",{"version":1,"anchors":[dead_ref,weakref(queued_anchor)]})
 var cleanup_owner = scene(catalog)
 check(cleanup_owner.confirm_impact("cleanup",1,"hit",Vector2.ZERO,both) and root.get_meta("_character_pipeline_impact_registry_v1").anchors.size()==1,"dead and queued registry anchors pruned before quota check")
 cleanup_owner.free()
 for index in range(4096): node.confirm_impact("ledger",1,str(index),Vector2.ZERO,unknown)
 check(node.impact_status().dedupKeys==4096 and not node.confirm_impact("ledger",1,"overflow",Vector2.ZERO,both),"dedup bounded without eviction")
 for index in range(200): node.confirm_impact("",1,"bad",Vector2.ZERO,both)
 check(node.impact_status().diagnostics.size()==128,"diagnostics bounded")
 node.dispose()
 check(not node.confirm_impact("disposed",1,"hit",Vector2.ZERO,both),"dispose rejects new visuals")
 # Override the owned allocation method, not gameplay or renderer logic.
 var failure_script = GDScript.new()
 failure_script.source_code='extends "res://impact_controller.gd"\nvar allocations: int = 0\nfunc _create_renderer():\n allocations+=1\n return null if allocations==2 else Renderer.new()\n'
 check(failure_script.reload()==OK,"deterministic allocation failure fixture compiles")
 var failure = failure_script.new()
 root.add_child(failure)
 check(failure.configure(catalog) and not failure.confirm("failure",1,"hit",Vector2.ZERO,both) and failure.get_child_count()==0 and failure.status().dedupKeys==0,"allocation failure rolls back all owned nodes and ledger")
 failure.free()
 var atlas = AtlasTexture.new()
 atlas.atlas=red
 atlas.region=Rect2(0,0,2,2)
 var atlas_catalog: Array = catalog.duplicate(true)
 atlas_catalog[1].impact.presentation.texture=atlas
 var atlas_owner = scene(atlas_catalog)
 var only_poison: Array[String] = ["poison"]
 check(atlas_owner.confirm_impact("atlas",1,"hit",Vector2.ZERO,only_poison) and atlas_owner._impacts.get_child(0).get_child(0).texture is AtlasTexture,"actual AtlasTexture overlay uses existing renderer")
 atlas_owner.free()
 var invalid = load("res://impact_controller.gd").new()
 var bad_catalog: Array = catalog.duplicate(true)
 bad_catalog[0].impact.presentation={"color":Color.RED}
 check(not invalid.configure(bad_catalog) and invalid.get_child_count()==0,"impact tint rejected atomically")
 bad_catalog=catalog.duplicate(true)
 bad_catalog[0].impact.durationSeconds=INF
 check(not invalid.configure(bad_catalog),"unbounded duration rejected")
 invalid.free()
 var output = FileAccess.open("res://validation.json",FileAccess.WRITE)
 output.store_string(JSON.stringify({"checks":checks}))
 quit(1 if checks.any(func(c):return not c.passed) else 0)









