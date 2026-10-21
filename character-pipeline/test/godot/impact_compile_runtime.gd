extends SceneTree
var checks: Array = []
func check(value: bool,label: String) -> void:
 checks.append({"name":label,"passed":value})
 if not value: push_error(label)
func _initialize() -> void: call_deferred("run")
func run() -> void:
 var packed=load("res://character.tscn")
 check(packed is PackedScene,"relocated normal compiled PackedScene loads without captured effect PNGs")
 var character=packed.instantiate()
 character.position=Vector2(20,20)
 root.add_child(character)
 await process_frame
 await process_frame
 character.set_process(false)
 var bridge=character.get_node("EffectController")
 check(bridge.ready_for_effects,"normal compiled bridge ready")
 var catalog=bridge.compiled_catalog
 check(catalog[0].presentation.color is Color and not catalog[0].presentation.has("texture"),"legacy travel tint remains independent of hit texture")
 check(catalog[1].presentation.texture is Texture2D,"legacy static travel overlay embedded")
 var frames=catalog[0].impact.presentation.frames
 check(frames.size()==2 and frames[0] is AtlasTexture and frames[1] is AtlasTexture,"hit atlas frames embedded by normal compiler")
 check(frames[0].atlas==frames[1].atlas and frames[0].region!=frames[1].region,"hit atlas shares sheet with distinct regions")
 check(frames[0].atlas.get_image().get_pixel(0,0)==Color.RED and frames[1].atlas.get_image().get_pixel(1,0)==Color.BLUE,"captured red and blue atlas pixels survive source denial")
 check(catalog[1].impact.presentation.texture is Texture2D,"independent static hit resource embedded")
 var enemy=Node2D.new()
 enemy.position=Vector2(100,80)
 root.add_child(enemy)
 var ids: Array[String]=["green","dot"]
 check(bridge.confirm_impact("fixture","generation-string","hit",enemy.global_position,ids),"direct trusted string generation confirms both selected impacts")
 var anchor=bridge._impacts.get_child(0)
 check(anchor.global_position==enemy.global_position and anchor.get_child_count()==2,"two partial overlays at actual target world position")
 check(enemy.get_child_count()==0 and enemy.modulate==Color.WHITE,"enemy remains unmodified")
 check(anchor.get_child(0).texture==frames[0] and anchor.get_child(1).texture==catalog[1].impact.presentation.texture,"actual renderers use separately embedded impact textures")
 check(bridge.advance(0.15) and anchor.get_child(0).texture==frames[1],"embedded atlas hit advances to second frame")
 check(bridge.advance(0.9) and anchor.get_child_count()==1 and anchor.get_child(0).texture==catalog[1].impact.presentation.texture,"short animated impact expires while longer static impact persists")
 check(bridge.advance(1.2) and bridge.impact_status().anchors==0,"independent impact lifetimes fully expire")
 check(bridge.confirm_impact("again","generation-string","hit",Vector2(140,90),ids),"later hit accepts independently positioned target")
 bridge.combat_end()
 check(bridge.impact_status().anchors==0 and bridge.impact_status().dedupKeys==0,"combat teardown clears owned hit visuals and ledger")
 var file=FileAccess.open("res://impact-validation.json",FileAccess.WRITE)
 file.store_string(JSON.stringify({"checks":checks}))
 file.close()
 quit(1 if checks.any(func(c):return not c.passed) else 0)

