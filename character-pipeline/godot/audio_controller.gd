extends Node

signal cue_started(id, voice)
signal cue_error(code, message)

@export var sounds: Dictionary = {}
var voices = {}
var budget_owner = null
var paused = false

func set_budget_owner(actor):
	if not voices.is_empty(): return false
	budget_owner = weakref(actor)
	return true

func _budget():
	if budget_owner != null:
		return budget_owner.get_ref()
	return get_parent()

func active_voice_count():
	return voices.size()

func _failure(code, message):
	cue_error.emit(code, message)
	return false

func play_cue(id, payload):
	var sound = sounds.get(payload.get("sound", ""), {})
	if not sound.get("stream") is AudioStream:
		return _failure("SOUND_MISSING", "Sound resource is unavailable")
	var actor = _budget()
	if not is_instance_valid(actor): return _failure("AUDIO_OWNER_MISSING", "Audio budget owner is unavailable")
	if voices.size() >= 16:
		_release(voices.keys()[0])
		cue_error.emit("AUDIO_VOICE_RETIRED","Oldest controller voice retired at voice limit")
	var registry = actor.get_meta("_pipeline_audio_voices",[])
	if registry.size() >= 64:
		var oldest = registry[0]
		var controller = oldest.controller.get_ref()
		var previous_voice = oldest.voice.get_ref()
		if is_instance_valid(controller) and is_instance_valid(previous_voice): controller._release(previous_voice)
		cue_error.emit("AUDIO_VOICE_RETIRED","Oldest character voice retired at shared voice limit")
	var stream = sound.stream
	if stream is AudioStreamWAV:
		if stream.loop_mode != AudioStreamWAV.LOOP_DISABLED:
			stream = stream.duplicate(false)
			stream.loop_mode = AudioStreamWAV.LOOP_DISABLED
	elif stream is AudioStreamOggVorbis:
		if stream.loop:
			stream = stream.duplicate(false)
			stream.loop = false
	else: return _failure("SOUND_UNSUPPORTED", "Only prepared WAV and Ogg streams are supported")
	var voice = AudioStreamPlayer.new()
	voice.stream = stream
	voice.bus = "SFX" if AudioServer.get_bus_index("SFX") >= 0 else "Master"
	voice.volume_db = clampf(sound.get("volumeDb",0.0) + payload.get("volumeDb",0.0),-80.0,6.0)
	voice.pitch_scale = clampf(sound.get("pitch",1.0) * payload.get("pitch",1.0),0.25,4.0)
	add_child(voice)
	voices[voice] = {"id":id,"tail":payload.get("tail","stop"),"actor":weakref(actor)}
	registry = actor.get_meta("_pipeline_audio_voices",[])
	registry.append({"controller":weakref(self),"voice":weakref(voice)})
	actor.set_meta("_pipeline_audio_voices",registry)
	actor.set_meta("_pipeline_audio_voice_count",registry.size())
	voice.finished.connect(func(): _release(voice))
	voice.play()
	voice.stream_paused = paused
	cue_started.emit(id,voice)
	return true

func _release(voice):
	if not voices.has(voice): return
	var actor = voices[voice].actor.get_ref()
	if is_instance_valid(actor):
		var registry = actor.get_meta("_pipeline_audio_voices",[])
		for index in range(registry.size()-1,-1,-1):
			if registry[index].voice.get_ref() == voice: registry.remove_at(index)
		actor.set_meta("_pipeline_audio_voices",registry)
		actor.set_meta("_pipeline_audio_voice_count",registry.size())
	voices.erase(voice)
	if is_instance_valid(voice):
		voice.stop()
		voice.queue_free()

func stop_interrupted():
	for voice in voices.keys():
		if voices[voice].tail != "finish": _release(voice)

func stop_all():
	for voice in voices.keys(): _release(voice)

func set_paused(value):
	paused = value
	for voice in voices: voice.stream_paused = value

func _exit_tree():
	stop_all()
