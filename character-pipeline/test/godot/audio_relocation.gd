extends SceneTree

func _initialize(): call_deferred("run")

func run():
	var actor = load("res://character.tscn").instantiate()
	root.add_child(actor)
	actor.set_process(false)
	var audio = actor.get_node("AudioController")
	var checks = []
	for id in ["cue", "ogg"]:
		var stream = audio.sounds[id].stream
		var started = audio.play_cue(id,{"sound":id})
		checks.append({"id":id,"local_resource":str(stream.resource_path).begins_with("res://"),"duration":stream.get_length(),"started":started})
	await create_timer(0.02).timeout
	var valid = audio.active_voice_count() == 2
	for check in checks: valid = valid and check.started and check.local_resource and absf(check.duration - 1.0) < 0.0001
	var file = FileAccess.open("res://relocation-validation.json",FileAccess.WRITE)
	file.store_string(JSON.stringify({"valid":valid,"checks":checks,"voices":audio.active_voice_count()}))
	file.close()
	audio.stop_all()
	actor.queue_free()
	await create_timer(0.1).timeout
	call_deferred("quit",0 if valid else 1)
