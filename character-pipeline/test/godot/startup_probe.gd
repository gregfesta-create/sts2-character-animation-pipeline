extends SceneTree

func _initialize():
	call_deferred("verify_startup")

func verify_startup():
	var main_scene = load(ProjectSettings.get_setting("application/run/main_scene")).instantiate()
	get_root().add_child(main_scene)
	var player = main_scene.get_node("AnimationPlayer")
	await process_frame
	var start = player.current_animation_position
	await create_timer(0.1).timeout
	var finish = player.current_animation_position
	var valid = player.autoplay == "idle" and player.is_playing() and finish > start
	var file = FileAccess.open("res://startup-validation.json", FileAccess.WRITE)
	file.store_string(JSON.stringify({"valid":valid,"autoplay":player.autoplay,"start":start,"finish":finish}))
	file.close()
	quit(0 if valid else 1)
