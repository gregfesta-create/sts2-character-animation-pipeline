extends SceneTree
var checks: Array = []
func check(value: bool,label: String) -> void:
	checks.append({"name":label,"passed":value})
	if not value: push_error(label)
func _initialize() -> void: call_deferred("run")
func frame(name: String) -> Image:
	await process_frame
	await RenderingServer.frame_post_draw
	var image=root.get_texture().get_image()
	image.save_png("res://"+name+".png")
	return image
func run() -> void:
	var scene=load("res://character.tscn")
	var left=scene.instantiate()
	var right=scene.instantiate()
	left.position=Vector2(24,32)
	right.position=Vector2(96,32)
	root.add_child(left)
	root.add_child(right)
	await process_frame
	await process_frame
	var a=left.get_node("EffectController")
	var b=right.get_node("EffectController")
	check(a.ready_for_effects and b.ready_for_effects,"packed bridge ready")
	check(a.status().characterInstance!=b.status().characterInstance,"per instance owner identity")
	check(a.compiled_catalog[1].presentation.texture is Texture2D,"overlay embedded texture resource")
	var facts={"characterInstance":a.status().characterInstance,"adapterContractVersion":"1","sequence":1,"bindings":{"poison":{"present":true,"amount":1}}}
	check(a.observe(facts),"compiled trusted facts accepted")
	var active=await frame("active")
	check(active.get_pixel(28,36).g>0.9 and active.get_pixel(28,36).r<0.1,"compiled active tint pixel")
	check(active.get_pixel(32,28).g>0.9 and active.get_pixel(32,28).r<0.1,"compiled embedded overlay pixel")
	check(active.get_pixel(100,36).r>0.9,"independent instance remains ordinary")
	facts.sequence=2
	facts.bindings.poison={"present":false,"amount":0}
	check(a.observe(facts),"removal facts accepted")
	var cleared=await frame("cleared")
	check(cleared.get_pixel(28,36).r>0.9 and left.get_node("Meshes/panel").get_child_count()==0,"compiled tint and overlay removed")
	var file=FileAccess.open("res://effect-validation.json",FileAccess.WRITE)
	file.store_string(JSON.stringify({"checks":checks}))
	file.close()
	quit(1 if checks.any(func(c):return not c.passed) else 0)
