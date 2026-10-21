extends SceneTree
var checks = []
func check(value, label):
	checks.append({"name":label,"passed":bool(value)})
func _initialize(): call_deferred("run")
func run():
	AudioServer.add_bus()
	var sfx = AudioServer.bus_count - 1
	AudioServer.set_bus_name(sfx, "SFX")
	AudioServer.set_bus_send(sfx, "Master")
	var actor = Node.new()
	root.add_child(actor)
	var audio = Node.new()
	audio.set_script(load("res://audio_controller.gd"))
	actor.add_child(audio)
	var pcm = AudioStreamWAV.new()
	pcm.format = AudioStreamWAV.FORMAT_16_BITS
	pcm.mix_rate = 22050
	pcm.data = PackedByteArray()
	var samples = PackedByteArray()
	samples.resize(22050 * 2)
	for sample in range(22050): samples.encode_s16(sample * 2, int(sin(sample * TAU * 440.0 / 22050.0) * 200))
	pcm.data = samples
	audio.sounds = {"cue":{"stream":pcm}}
	var started = []
	audio.cue_started.connect(func(id, voice): started.append({"id":id,"voice":voice}))
	check(audio.play_cue("attack", {"sound":"cue"}), "cue accepted")
	var voice = started[0].voice
	check(voice.bus == "SFX", "game voice routes to SFX")
	check(AudioServer.get_bus_send(AudioServer.get_bus_index(voice.bus)) == "Master", "voice SFX sends to Master")
	AudioServer.set_bus_volume_db(sfx, -18.0)
	check(AudioServer.get_bus_volume_db(sfx) == -18.0 and AudioServer.get_bus_volume_db(0) == 0.0 and voice.volume_db == 0.0, "SFX gain isolated from Master and voice gain")
	AudioServer.set_bus_mute(sfx, true)
	check(AudioServer.is_bus_mute(AudioServer.get_bus_index(voice.bus)) and not AudioServer.is_bus_mute(0), "SFX mute controls voice route without muting Master")
	check(audio.active_voice_count() == 1 and actor.get_meta("_pipeline_audio_voice_count") == 1, "voice registered")
	audio.stop_all()
	await process_frame
	check(audio.active_voice_count() == 0 and actor.get_meta("_pipeline_audio_voice_count") == 0 and not is_instance_valid(voice), "stop releases controller and owner voice")
	AudioServer.remove_bus(sfx)
	check(audio.play_cue("preview", {"sound":"cue"}), "standalone cue accepted")
	check(started[1].voice.bus == "Master", "standalone missing SFX falls back to Master")
	audio.set_paused(true)
	check(started[1].voice.stream_paused, "fallback voice pauses")
	audio.stop_interrupted()
	await process_frame
	check(audio.active_voice_count() == 0 and actor.get_meta("_pipeline_audio_voice_count") == 0, "interruption releases voice")
	audio.set_paused(false)
	audio.play_cue("finished", {"sound":"cue"})
	await create_timer(1.2).timeout
	check(audio.active_voice_count() == 0 and actor.get_meta("_pipeline_audio_voice_count") == 0, "natural finish releases voice")
	audio.play_cue("exit", {"sound":"cue","tail":"finish"})
	audio.queue_free()
	await process_frame
	check(actor.get_meta("_pipeline_audio_voice_count") == 0, "controller exit clears owner registry")
	var passed = checks.all(func(item): return item.passed)
	var file = FileAccess.open("res://audio-bus-result.json", FileAccess.WRITE)
	file.store_string(JSON.stringify({"passed":passed,"checks":checks,"audibleGameAcceptance":false}, "  "))
	file.close()
	quit(0 if passed else 1)
