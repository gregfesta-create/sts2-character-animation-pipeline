extends SceneTree
var checks: Array = []
func check(value: bool, label: String) -> void:
	checks.append({"name":label,"passed":value})
	if not value: push_error(label)
func _initialize() -> void: call_deferred("run")
func square(at: Vector2) -> Sprite2D:
	var image := Image.create(16,16,false,Image.FORMAT_RGBA8)
	image.fill(Color.WHITE)
	var sprite := Sprite2D.new()
	sprite.texture=ImageTexture.create_from_image(image)
	sprite.position=at
	root.add_child(sprite)
	return sprite
func frame(name: String) -> Image:
	await process_frame
	await RenderingServer.frame_post_draw
	var image := root.get_texture().get_image()
	image.save_png("res://"+name+".png")
	return image
func run() -> void:
	var script = load("res://effect_scene_controller.gd")
	var left := square(Vector2(24,32))
	var right := square(Vector2(72,32))
	var arrow := square(Vector2(120,32))
	var second := square(Vector2(168,32))
	var overlay_image := Image.create(4,4,false,Image.FORMAT_RGBA8)
	overlay_image.fill(Color.WHITE)
	var overlay := ImageTexture.create_from_image(overlay_image)
	ResourceSaver.save(overlay,"res://overlay.tres")
	var catalog := [{"id":"green","capability":"tint","presentation":{"color":Color.GREEN}},{"id":"dot","capability":"overlay","presentation":{"texture":load("res://overlay.tres"),"offset":Vector2(0,-12),"scale":Vector2.ONE}}]
	var decisions: Array = []
	for scope in ["whileActive","attackSnapshot"]:
		decisions.append({"id":scope,"bindingId":"poison","mechanicKey":"poison","outcome":"effect","rule":{"scope":scope,"condition":{"type":"amountAtLeast","threshold":1},"effectIds":["green","dot"],"socketId":"arrow","channel":"tip","priority":1}})
	var plan := {"adapterContractVersion":"1","decisions":decisions}
	var bridge = script.new()
	root.add_child(bridge)
	check(bridge.configure_trusted(plan,catalog,"hero",{"arrow":left}),"trusted resource and explicit target configuration")
	var other = script.new()
	root.add_child(other)
	check(other.configure_trusted(plan,catalog,"other",{"arrow":right}),"independent owner configuration")
	var facts := {"characterInstance":"hero","adapterContractVersion":"1","sequence":1,"bindings":{"poison":{"present":true,"amount":1}}}
	check(bridge.observe(facts),"authoritative facts accepted")
	var initial := await frame("active")
	check(initial.get_pixel(24,32).g>0.9 and initial.get_pixel(24,32).r<0.1,"actual active tint pixel")
	check(initial.get_pixel(24,20).g>0.9 and initial.get_pixel(24,20).r<0.1,"actual overlay resource pixel")
	check(initial.get_pixel(72,32).r>0.9,"other owner unaffected")
	var action := {"actionInstance":"last","generation":1,"preConsumption":true,"observationSequence":1,"releaseAt":0.2,"impactAt":0.6}
	check(not bridge.capture_attack(action).is_empty(),"pre-consumption capture")
	bridge.mark_released("last",1)
	check(not bridge.retain_projectile("last",1,"one","arrow",arrow).is_empty(),"first projectile retained")
	check(bridge.retain_projectile("last",1,"one","arrow",second).is_empty(),"projectile target cannot be rebound")
	check(bridge.retain_projectile("last",1,"alias","arrow",arrow).is_empty(),"projectile targets cannot alias")
	check(bridge.retain_projectile("last",1,"active-alias","arrow",left).is_empty(),"active target cannot become projectile")
	var active_child := Node2D.new()
	left.add_child(active_child)
	var projectile_child := Node2D.new()
	arrow.add_child(projectile_child)
	var active_parent := Node2D.new()
	root.add_child(active_parent)
	left.reparent(active_parent)
	var projectile_parent := Node2D.new()
	root.add_child(projectile_parent)
	arrow.reparent(projectile_parent)
	var before: Dictionary = bridge.status()
	check(bridge.retain_projectile("last",1,"active-child","arrow",active_child).is_empty(),"active descendant projectile rejected")
	check(bridge.retain_projectile("last",1,"active-parent","arrow",active_parent).is_empty(),"active ancestor projectile rejected")
	check(bridge.retain_projectile("last",1,"projectile-child","arrow",projectile_child).is_empty(),"projectile descendant rejected")
	check(bridge.retain_projectile("last",1,"projectile-parent","arrow",projectile_parent).is_empty(),"projectile ancestor rejected")
	check(bridge.status()==before and active_child.modulate==Color.WHITE and projectile_child.modulate==Color.WHITE and active_parent.modulate==Color.WHITE and projectile_parent.modulate==Color.WHITE,"ancestry rejection changes no presentation or retained state")
	left.reparent(root)
	arrow.reparent(root)
	active_child.free()
	projectile_child.free()
	active_parent.free()
	projectile_parent.free()
	facts.sequence=2
	facts.bindings.poison={"present":false,"amount":0}
	bridge.observe(facts)
	check(not bridge.retain_projectile("last",1,"two","arrow",second).is_empty(),"second projectile uses immutable snapshot after consumption")
	var retained := await frame("retained")
	check(retained.get_pixel(24,32).r>0.9 and left.get_child_count()==0,"active tint and overlay removed")
	check(retained.get_pixel(120,32).r<0.1 and retained.get_pixel(168,32).r<0.1,"last charge multi-arrow pixels retained")
	var next: Dictionary = action.duplicate(true)
	next.actionInstance="next"
	next.observationSequence=2
	check(bridge.capture_attack(next).selectedEffects.is_empty(),"next attack refreshes consumed facts")
	bridge.set_paused(true)
	var paused := await frame("paused")
	check(paused.get_pixel(120,32).r>0.9 and arrow.get_child_count()==0,"pause restores tint and removes overlay")
	bridge.set_paused(false)
	check(arrow.modulate==Color.GREEN and arrow.get_child_count()==1,"resume retained visual")
	bridge.complete_attack("last",1)
	bridge.release_projectile("last",1,"one")
	check(arrow.modulate==Color.WHITE and second.modulate==Color.GREEN,"release removes only one projectile")
	check(bridge.advance(10) and second.modulate==Color.WHITE and second.get_child_count()==0,"expiry restores remaining projectile")
	check(not bridge.advance(9),"clock cannot regress")
	facts.sequence=3
	facts.bindings.poison={"present":true,"amount":1}
	bridge.observe(facts)
	bridge.combat_end()
	check(left.modulate==Color.WHITE and left.get_child_count()==0,"combat end restores active target")
	bridge.dispose()
	check(not bridge.observe(facts) and bridge.status().disposed,"disposed bridge rejects facts")
	var invalid = script.new()
	root.add_child(invalid)
	check(not invalid.configure_trusted(plan,[{"id":"bad","capability":"trail","presentation":{}}],"bad",{"arrow":right}),"unimplemented capability rejected")
	check(not invalid.configure_trusted(plan,[{"id":"green","capability":"tint","presentation":{"color":Color(2,1,1,1)}}],"bad",{"arrow":right}),"out of range tint rejected")
	check(not invalid.configure_trusted(plan,catalog,"bad",{"arrow":right,"alias":right}),"socket target alias rejected")
	var configuration_child := Node2D.new()
	right.add_child(configuration_child)
	var nested = script.new()
	root.add_child(nested)
	check(not nested.configure_trusted(plan,catalog,"nested",{"arrow":right,"other":configuration_child}),"configured ancestor before descendant rejected")
	var reversed = script.new()
	root.add_child(reversed)
	check(not reversed.configure_trusted(plan,catalog,"nested",{"arrow":configuration_child,"other":right}),"configured descendant before ancestor rejected")
	check(right.modulate==Color.WHITE and configuration_child.modulate==Color.WHITE and nested.get_child_count()==0 and reversed.get_child_count()==0,"configuration ancestry rejection leaves renderers and visuals untouched")
	configuration_child.free()
	var other_facts: Dictionary = facts.duplicate(true)
	other_facts.characterInstance="other"
	check(other.observe(other_facts) and right.modulate==Color.GREEN,"second owner renders independently")
	other_facts.characterInstance="wrong"
	check(not other.observe(other_facts) and right.modulate==Color.WHITE,"invalid facts restore stale presentation")
	other_facts.characterInstance="other"
	other_facts.sequence=4
	other.observe(other_facts)
	other.free()
	await process_frame
	check(right.modulate==Color.WHITE and right.get_child_count()==0,"tree teardown restores target")
	check(facts.bindings.poison.amount==1,"gameplay facts remain untouched")
	await animated_layer_checks(script)
	var output := FileAccess.open("res://validation.json",FileAccess.WRITE)
	output.store_string(JSON.stringify({"checks":checks}))
	output.close()
	quit(1 if checks.any(func(c):return not c.passed) else 0)

func animated_layer_checks(script) -> void:
	var wind := square(Vector2(24,54))
	var projectile := square(Vector2(120,54))
	var textures: Array = []
	for color in [Color.RED,Color.BLUE]:
		var image := Image.create(4,4,false,Image.FORMAT_RGBA8)
		image.fill(color)
		textures.append(ImageTexture.create_from_image(image))
	var presentation := {"frames":textures,"durations":[0.1,0.1],"offset":Vector2(0,-10),"scale":Vector2.ONE,"loop":true}
	var catalog := [{"id":"flame","capability":"overlay","presentation":presentation}]
	var decisions: Array = []
	for scope in ["whileActive","attackSnapshot"]:
		decisions.append({"id":scope,"bindingId":"fire","mechanicKey":"fire","outcome":"effect","rule":{"scope":scope,"condition":{"type":"amountAtLeast","threshold":1},"effectIds":["flame"],"socketId":"wind","channel":"fire","priority":1}})
	var plan := {"adapterContractVersion":"1","decisions":decisions}
	var bridge = script.new()
	root.add_child(bridge)
	var accepted: bool = bridge.configure_trusted(plan,catalog,"animated",{"wind":wind})
	check(accepted,"animated partial overlay accepted through trusted scene catalog")
	if not accepted:
		bridge.free()
		return
	var facts := {"characterInstance":"animated","adapterContractVersion":"1","sequence":1,"bindings":{"fire":{"present":true,"amount":1}}}
	check(bridge.observe(facts),"animated layer follows authoritative facts")
	var initial := await frame("animated-initial")
	check(initial.get_pixel(24,44).r>0.9 and initial.get_pixel(24,44).b<0.1,"active animation begins at first texture")
	check(initial.get_pixel(24,54).r>0.9 and initial.get_pixel(24,54).g>0.9,"separate fire layer preserves wind base pixels")
	check(bridge.advance(0.1),"scene advances active overlay clock")
	var boundary := await frame("animated-boundary")
	check(boundary.get_pixel(24,44).b>0.9 and boundary.get_pixel(24,44).r<0.1,"active frame boundary selects second texture")
	facts.sequence=2
	check(bridge.observe(facts),"repeated active facts accepted")
	check(wind.get_child(0).texture==textures[1],"repeated facts do not restart active animation")
	var action := {"actionInstance":"fire-shot","generation":1,"preConsumption":true,"observationSequence":2,"releaseAt":0.2,"impactAt":0.8}
	check(not bridge.capture_attack(action).is_empty() and not bridge.mark_released("fire-shot",1).is_empty(),"animated selection captured before last charge consumption")
	check(not bridge.retain_projectile("fire-shot",1,"gust","wind",projectile).is_empty(),"animated projectile retained")
	check(bridge.advance(0.15),"active and projectile advance on shared scene clock")
	var independent := await frame("animated-independent")
	check(independent.get_pixel(24,44).b>0.9 and independent.get_pixel(120,44).r>0.9,"active and later projectile have independent animation origins")
	check(bridge.advance(0.21),"projectile frame advances")
	facts.sequence=3
	facts.bindings.fire={"present":false,"amount":0}
	bridge.observe(facts)
	var retained := await frame("animated-last-charge")
	check(wind.get_child_count()==0 and retained.get_pixel(120,44).b>0.9,"consumed active buff removes only active layer and retains projectile animation")
	check(retained.get_pixel(120,54).g>0.9,"projectile base remains unchanged by animated overlay")
	bridge.set_paused(true)
	check(projectile.get_child_count()==0,"pause clears animated presentation")
	bridge.set_paused(false)
	check(projectile.get_child_count()==1 and projectile.get_child(0).texture==textures[0],"resume restarts retained presentation without changing snapshot")
	check(bridge.advance(0.32) and projectile.get_child(0).texture==textures[1],"resumed layer advances deterministically")
	check(not bridge.advance(0.31) and projectile.get_child(0).texture==textures[1],"clock rollback changes no animated texture")
	bridge.combat_end()
	check(projectile.get_child_count()==0 and projectile.modulate==Color.WHITE,"combat end cleans animated layers and preserves base")
	bridge.free()
	var invalid = script.new()
	root.add_child(invalid)
	for change in ["mixed","extra","bad-loop","bad-duration"]:
		var bad := presentation.duplicate(true)
		if change=="mixed": bad.texture=textures[0]
		if change=="extra": bad.arbitrary=true
		if change=="bad-loop": bad.loop=1
		if change=="bad-duration": bad.durations=[0.1,-1.0]
		check(not invalid.configure_trusted(plan,[{"id":"flame","capability":"overlay","presentation":bad}],"bad",{"wind":wind}),"invalid animated catalog rejected before publication: "+change)
	check(invalid.get_child_count()==0,"invalid catalogs create no renderer children")
	invalid.free()




