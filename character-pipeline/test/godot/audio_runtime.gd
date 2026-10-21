extends SceneTree
var checks = []
func check(value,label):
	checks.append({"name":label,"passed":bool(value)})
	if not value: push_error(label)
func _initialize(): call_deferred("run")
func make_audio(parent):
	if parent.has_node("AudioController"): return parent.get_node("AudioController")
	var audio = Node.new()
	audio.name = "AudioController"
	audio.set_script(load("res://audio_controller.gd"))
	var stream = AudioStreamWAV.load_from_file("res://cue.wav")
	stream.loop_mode = AudioStreamWAV.LOOP_FORWARD
	audio.sounds = {"cue":{"stream":stream,"volumeDb":5.0,"pitch":3.0}}
	parent.add_child(audio)
	return audio
func make_character():
	var actor = load("res://character.tscn").instantiate()
	var player = actor.get_node("AnimationPlayer")
	var library = player.get_animation_library("").duplicate(true)
	player.remove_animation_library("")
	player.add_animation_library("",library)
	for config in [{"id":"audioAction","duration":1.0,"loop":false,"events":[{"id":"release","type":"sound","time":0.3,"payload":{"sound":"cue"}}]}, {"id":"audioLoop","duration":0.1,"loop":true,"events":[{"id":"loop","type":"sound","time":0.02,"payload":{"sound":"cue"}}]}, {"id":"ordered","duration":1.0,"loop":false,"events":[{"id":"z","type":"sound","time":0.2,"payload":{"sound":"cue"}},{"id":"a","type":"sound","time":0.2,"payload":{"sound":"cue"}}]}]:
		var animation = Animation.new()
		animation.length = config.duration
		animation.loop_mode = Animation.LOOP_LINEAR if config.loop else Animation.LOOP_NONE
		if not library.has_animation(config.id): library.add_animation(config.id,animation)
		actor.clip_metadata[config.id] = config
	make_audio(actor)
	root.add_child(actor)
	actor.set_process(false)
	return actor
func run():
	var actor = Node.new()
	root.add_child(actor)
	var audio = make_audio(actor)
	var diagnostics = []
	audio.cue_error.connect(func(code,_message): diagnostics.append(code))
	check(audio.play_cue("one",{"sound":"cue","volumeDb":5,"pitch":3}),"actual voice starts")
	var voice = audio.get_child(0)
	check(voice is AudioStreamPlayer and voice.playing,"engine audio stream is playing")
	check(voice.volume_db == 6 and voice.pitch_scale == 4,"combined gain and pitch clamp")
	check(voice.stream.loop_mode == AudioStreamWAV.LOOP_DISABLED,"looping source forced one shot")
	audio.stop_all()
	check(audio.active_voice_count() == 0,"stop all cleans reservations")
	audio.play_cue("tail",{"sound":"cue","tail":"finish"})
	audio.play_cue("cut",{"sound":"cue"})
	audio.stop_interrupted()
	check(audio.active_voice_count() == 1,"finish tail survives interruption")
	audio.set_paused(true)
	check(audio.voices.keys()[0].stream_paused,"active stream is paused")
	audio.set_paused(false)
	check(not audio.voices.keys()[0].stream_paused,"active stream resumes")
	audio.stop_all()
	for i in 16: check(audio.play_cue(str(i),{"sound":"cue"}),"voice budget accepts " + str(i))
	var oldest = audio.voices.keys()[0]
	check(audio.play_cue("overflow",{"sound":"cue"}) and not audio.voices.has(oldest) and audio.active_voice_count() == 16,"controller cap retires oldest voice deterministically")
	check(diagnostics.has("AUDIO_VOICE_RETIRED"),"voice retirement emits explicit diagnostic")
	audio.stop_all()
	check(actor.get_meta("_pipeline_audio_voice_count",0) == 0,"budget reservations released")
	var shared = []
	for c in 5:
		var node = Node.new()
		actor.add_child(node)
		var controller = make_audio(node)
		controller.set_budget_owner(actor)
		shared.append(controller)
	for c in 4:
		for i in 16: shared[c].play_cue(str(i),{"sound":"cue"})
	oldest = shared[0].voices.keys()[0]
	check(shared[4].play_cue("overflow",{"sound":"cue"}) and not shared[0].voices.has(oldest) and actor.get_meta("_pipeline_audio_voice_count",0) == 64,"shared character cap retires oldest across controllers")
	for controller in shared: controller.stop_all()
	check(actor.get_meta("_pipeline_audio_voice_count",0) == 0,"shared character reservations released")
	var a = make_character()
	var b = make_character()
	var aa = a.get_node("AudioController")
	var ba = b.get_node("AudioController")
	check(aa.sounds.ogg.stream is AudioStreamOggVorbis,"packed Ogg resource loaded")
	aa.play_cue("ogg",{"sound":"ogg"})
	check(aa.voices.keys()[0].playing and aa.voices.keys()[0].stream == aa.sounds.ogg.stream,"prepared Ogg plays shared immutable stream")
	aa.stop_all()
	var cues = []
	var generic = []
	aa.cue_started.connect(func(id,_voice): cues.append(id))
	a.animation_marker.connect(func(id,_name,_payload): generic.append(id))
	a.play_animation("audioAction")
	if not a.tree:
		a.player.speed_scale = 0.5
		a.advance_animation(0.4)
		check(cues.is_empty(),"sound follows half-speed playhead")
		a.advance_animation(0.3)
	else:
		a.advance_animation(0.2)
		check(cues.is_empty(),"tree sound waits for actual playhead")
		a.advance_animation(0.15)
	check(cues == ["release"] and aa.active_voice_count() == 1,"sound begins at actual animated cue")
	check(generic.is_empty(),"sound is not duplicated through generic marker signal")
	check(ba.active_voice_count() == 0,"second character stays silent")
	if a.tree:
		a.play_animation("zeroSound")
		var immediate_old = aa.voices.keys()[0]
		a.tree.get("parameters/playback").travel("zeroSound")
		a.advance_animation(0)
		check(aa.active_voice_count() == 1 and not aa.voices.has(immediate_old),"immediate time-zero external self travel replaces exactly one voice")
		a.play_animation("zeroSound")
		a.advance_animation(0.4)
		var old_zero = aa.voices.keys()[0]
		a.tree.get("parameters/playback").travel("zeroSound")
		a.advance_animation(0)
		check(aa.active_voice_count() == 1 and not aa.voices.has(old_zero),"external zero-time self travel keeps replacement sound")
		a.play_animation("audioAction")
		a.advance_animation(0.35)
		a.tree.get("parameters/playback").travel("audioAction")
		a.advance_animation(0)
		check(aa.active_voice_count() == 0,"external repeated tree travel stops previous sound")
	a.play_animation("audioAction")
	check(aa.active_voice_count() == 0,"same action restart stops previous voice")
	a.player.speed_scale = 1
	a.advance_animation(0.4)
	a.seek_animation(0.1)
	check(aa.active_voice_count() == 0,"silent seek stops cursor voices")
	aa.play_cue("tail",{"sound":"cue","tail":"finish"})
	a.play_animation("hit")
	check(aa.active_voice_count() == 1,"finish tail survives animation interruption")
	a.play_animation("death")
	check(aa.active_voice_count() == 0,"death stops all previous voices including tails")
	if a.tree:
		a.play_animation("hit")
		aa.play_cue("tail",{"sound":"cue","tail":"finish"})
		a.tree.get("parameters/playback").travel("Dead")
		a.advance_animation(0)
		check(aa.active_voice_count() == 0,"external native death stops all sounds")
	cues.clear()
	a.play_animation("ordered")
	a.advance_animation(0.25)
	check(cues == ["a","z"],"same-time sounds dispatch once in stable ID order")
	cues.clear()
	a.play_animation("audioLoop")
	a.advance_animation(0.25)
	check(cues == ["loop","loop","loop"],"looping animation emits each sound crossing")
	check(not a.advance_animation(13.0),"per-tick sound crossing budget enforced")
	a.play_animation("dense")
	cues.clear()
	check(a.advance_animation(0.001) and cues.is_empty(),"65-sound clip permits frame with no actual crossings")
	check(a.advance_animation(0.6) and cues.size() == 65,"65 actual sound crossings remain within budget")
	a.play_animation("dense")
	cues.clear()
	check(not a.advance_animation(2.0) and cues.is_empty(),"130 actual sound crossings rejected before dispatch")
	aa.stop_all()
	aa.play_cue("finite",{"sound":"cue"})
	await create_timer(0.6).timeout
	check(aa.active_voice_count() == 0,"natural audio completion releases voice reservation")
	aa.play_cue("remove",{"sound":"cue"})
	root.remove_child(a)
	check(aa.active_voice_count() == 0 and a.get_meta("_pipeline_audio_voice_count",0) == 0,"removing character stops voices and releases budget")
	a.free()
	var valid = true
	for c in checks: valid = valid and c.passed
	var file = FileAccess.open("res://audio-validation.json",FileAccess.WRITE)
	file.store_string(JSON.stringify({"valid":valid,"checks":checks}))
	file.close()
	actor.queue_free()
	b.queue_free()
	await create_timer(0.1).timeout
	call_deferred("quit",0 if valid else 1)
