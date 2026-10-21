extends Node2D

signal animation_marker(id, name, payload)
signal animation_runtime_error(code, message)

@export var clip_metadata: Dictionary = {}
@export var aliases: Dictionary = {}
var current = ""
var elapsed = 0.0
var observed_position = 0.0
var held = false
var last_error = {}
var suppress_cues = false
var preview_silent = false
var sound_dispatch_count = 0
var marker_dispatch_count = 0
var pending_state = ""
var cue_generation = 0
@onready var player = get_node("AnimationPlayer")
@onready var tree = get_node_or_null("AnimationTree")
@onready var audio = get_node_or_null("AudioController")
@onready var actions = get_node_or_null("ActionController")
@onready var poses = get_node_or_null("PoseController")

func _apply_pose(clip,time):
	if not poses: return true
	if poses.apply_pose(clip,time): return true
	last_error=poses.last_error.duplicate()
	animation_runtime_error.emit(last_error.code,last_error.message)
	return false

func _validate_pose(clip,time):
	if not poses or poses.validate_pose(clip,time): return true
	last_error=poses.last_error.duplicate()
	animation_runtime_error.emit(last_error.code,last_error.message)
	return false


func _ready():
	process_priority = 50
	# Each instance owns its animation library and authoritative cue clock.
	var library = player.get_animation_library("").duplicate(true)
	player.remove_animation_library("")
	player.add_animation_library("", library)
	# Cue delivery belongs to the incoming playhead, never to blended clips.
	# Outgoing native method tracks cannot identify their playback generation.
	player.callback_mode_method = AnimationMixer.ANIMATION_CALLBACK_MODE_METHOD_IMMEDIATE
	player.callback_mode_process = AnimationMixer.ANIMATION_CALLBACK_MODE_PROCESS_MANUAL
	if tree:
		# AnimationTree mirrors the player's libraries when anim_player is assigned.
		# Rebind after replacing the per-instance library so it sees cue tracks.
		var player_path = tree.anim_player
		tree.anim_player = NodePath("")
		tree.anim_player = player_path
		tree.clear_caches()
		tree.callback_mode_method = AnimationMixer.ANIMATION_CALLBACK_MODE_METHOD_IMMEDIATE
		tree.callback_mode_process = AnimationMixer.ANIMATION_CALLBACK_MODE_PROCESS_MANUAL
		tree.active = true
		tree.get("parameters/playback").state_started.connect(_state_started)
	play_animation("idle")

func _state_started(state):
	if not suppress_cues: pending_state = str(state)

func _dispatch_start():
	var generation = cue_generation
	var ordered = clip_metadata[current].events.duplicate(true)
	ordered.sort_custom(func(a,b): return a.id < b.id if a.time == b.time else a.time < b.time)
	for event in ordered:
		if generation != cue_generation: return
		if event.time == 0: _animation_cue(current, event)

func _dispatch_crossings(start, distance):
	if distance <= 0 or suppress_cues or preview_silent: return
	var meta = clip_metadata[current]
	var generation = cue_generation
	var crossed = []
	for event in meta.events:
		if meta.loop:
			var first = int(floor((start-event.time)/meta.duration)) + 1
			var last = int(floor((start+distance-event.time)/meta.duration))
			for cycle in range(first,last+1): crossed.append({"at":cycle*meta.duration+event.time,"event":event})
		elif event.time > start and event.time <= start+distance:
			crossed.append({"at":event.time,"event":event})
	crossed.sort_custom(func(a,b): return a.event.id < b.event.id if a.at == b.at else a.at < b.at)
	for entry in crossed:
		if generation != cue_generation: return
		_animation_cue(current,entry.event)

func _animation_cue(clip, event):
	if suppress_cues or preview_silent: return
	if clip != current: return
	if event.get("type","") == "projectile":
		if actions: actions.queue_projectile(event.id,event.payload)
		else: animation_runtime_error.emit("ACTION_CONTROLLER_MISSING","Projectile cue has no action runtime")
	elif event.get("type","") == "sound":
		var matching_releases=[]
		for other in clip_metadata[clip].events:
			if other.get("type","")=="projectile" and other.time==event.time:
				matching_releases.append(other.payload)
		if not matching_releases.is_empty():
			if not actions or not actions.claim_release_sound(event.id,event.time,matching_releases): return
		sound_dispatch_count += 1
		if sound_dispatch_count > 128:
			animation_runtime_error.emit("SOUND_DISPATCH_BUDGET","Sound cue dispatch budget exceeded")
			return
		if audio: audio.play_cue(event.id,event.payload)
		else: animation_runtime_error.emit("AUDIO_CONTROLLER_MISSING","Sound cue has no audio runtime")
	else:
		marker_dispatch_count += 1
		if marker_dispatch_count > 4096:
			animation_runtime_error.emit("MARKER_DISPATCH_BUDGET","Marker cue dispatch budget exceeded")
			return
		animation_marker.emit(event.id,event.get("name",event.id),event.get("payload",{}).duplicate(true))

func _notify_action_clip(clip):
	if not actions: return
	var releases=false
	for event in clip_metadata[clip].events:
		releases=releases or event.get("type","")=="projectile"
	actions.on_animation_changed(clip,releases)

func begin_action(value):
	return actions.begin_action(value) if actions else false

func cancel_action():
	if clip_metadata.has("idle") and not _validate_pose("idle",0): return false
	if actions and not actions.cancel_action(): return false
	if audio: audio.stop_interrupted()
	if clip_metadata.has("idle"): play_animation("idle")
	return true

func authoritative_hit(action_id,cue_id,value):
	return actions.authoritative_hit(action_id,cue_id,value) if actions else false

func update_action_target(action_id,value):
	return actions.update_action_target(action_id,value) if actions else false

func seek_animation(time):
	if current == "" or not is_finite(time) or time < 0: return false
	if not _validate_pose(current,time): return false
	if audio: audio.stop_all()
	if actions and not actions.cancel_action(): return false
	var meta = clip_metadata[current]
	var position = fmod(time, meta.duration) if meta.loop else minf(time, meta.duration)
	if not _apply_pose(current,position): return false
	suppress_cues = true
	if tree:
		var playback = tree.get("parameters/playback")
		var state = str(playback.get_current_node())
		playback.start(state, true)
		tree.advance(0)
		tree.advance(position)
	else:
		# Seeking is an immediate pose change, never a continuation of a fade.
		player.stop()
		player.play(current,0.0)
		player.seek(position, true, true)
	suppress_cues = false
	pending_state = ""
	elapsed = position
	observed_position = tree.get("parameters/playback").get_current_play_position() if tree else player.current_animation_position
	cue_generation += 1
	return true

func play_animation(name):
	var clip = aliases.get(name, name)
	if not clip_metadata.has(clip): return false
	if not _validate_pose(str(clip),0): return false
	if actions and not actions.validate_animation(str(clip)): return false
	if audio:
		if str(clip).to_lower() in ["death","dead"]: audio.stop_all()
		else: audio.stop_interrupted()
	sound_dispatch_count = 0
	marker_dispatch_count = 0
	cue_generation += 1
	var previous = current
	var blend = float(clip_metadata[clip].get("blendIn",0.0)) if previous != "" and previous != str(clip) else 0.0
	current = str(clip)
	elapsed = 0.0
	held = false
	_notify_action_clip(clip)
	suppress_cues = true
	if tree:
		var playback = tree.get("parameters/playback")
		var destination = str(name) if aliases.has(name) else current
		if blend > 0:
			playback.travel(destination)
			playback.next()
		else: playback.start(destination, true)
		tree.advance(0)
		tree.advance(0)
	else:
		if blend <= 0:
			player.stop()
			player.play("RESET")
			player.advance(0)
		player.play(current,blend)
		player.advance(0)
	suppress_cues = false
	pending_state = ""
	observed_position = tree.get("parameters/playback").get_current_play_position() if tree else player.current_animation_position
	if not _apply_pose(current,elapsed): return false
	_dispatch_start()
	return true

func advance_animation(delta):
	if not is_finite(delta) or delta < 0: return false
	if current == "" or not is_visible_in_tree(): return false
	if not _validate_pose(current,elapsed): return false
	sound_dispatch_count = 0
	marker_dispatch_count = 0
	# Apply pending external Travel before selecting the active clip's bounds.
	if tree:
		tree.advance(0)
		var playback = tree.get("parameters/playback")
		if not playback.get_travel_path().is_empty(): playback.next()
		tree.advance(0)
	if _sync_playhead(true)==false: return false
	if actions: actions.advance_pose(0)
	# Subdivision keeps authored action release boundaries and loop crossings
	# precise even after a long frame, with a hard bound on dispatch work.
	var rate = 1.0 if tree else absf(player.speed_scale)
	var step = clip_metadata[current].duration / maxf(rate, 1.0) / 4.0
	var steps = ceil(delta / step)
	if steps > 1024 or not _within_cue_budget(elapsed,delta * rate):
		last_error = {"code":"ANIMATION_ADVANCE_BUDGET","message":"Animation advance exceeds bounded cue dispatch budget"}
		animation_runtime_error.emit(last_error.code, last_error.message)
		return false
	# The validated budget, mixer and rate belong to exactly this generation.
	var generation = cue_generation
	var count = maxi(1,int(steps))
	var mixer = tree if tree else player
	for i in count:
		var remaining=delta/count
		while remaining>0:
			var piece=remaining
			if actions and rate>0:
				var until=actions.time_to_release()
				if generation != cue_generation: return true
				if until>0: piece=minf(piece,until/rate)
			if actions: actions.prepare_pose(piece*rate)
			if generation != cue_generation: return true
			mixer.advance(piece)
			if generation != cue_generation: return true
			# Native blend weights settle on the next evaluation at this clock.
			mixer.advance(0)
			if generation != cue_generation: return true
			if not _apply_pose(current,elapsed+piece*rate): return false
			_dispatch_crossings(elapsed,piece*rate)
			if generation != cue_generation: return true
			var meta = clip_metadata[current]
			elapsed = fmod(elapsed+piece*rate,meta.duration) if meta.loop else minf(elapsed+piece*rate,meta.duration)
			if actions: actions.advance_pose(piece*rate,rate)
			if generation != cue_generation: return true
			remaining-=piece
	_sync_playhead()
	return true

func _within_cue_budget(start, distance):
	var meta = clip_metadata[current]
	var end = start + distance
	var sounds = sound_dispatch_count
	var markers = marker_dispatch_count
	for event in meta.events:
		var crossings = 0.0
		if meta.loop:
			crossings = floor((end-event.time)/meta.duration) - floor((start-event.time)/meta.duration)
		elif event.time > start and event.time <= minf(end,meta.duration):
			crossings = 1.0
		if event.get("type","") == "sound": sounds += crossings
		else: markers += crossings
		if sounds > 128 or markers > 4096: return false
	return true

func _process(delta):
	if not is_visible_in_tree():
		# Both mixers are manual. Keeping the tree active preserves its state;
		# toggling active resets state-machine playback on the next visible frame.
		if audio: audio.set_paused(true)
		return
	if audio: audio.set_paused(false)
	if tree: tree.active = true
	elif not held and not player.is_playing() and current != "": player.play(current)
	advance_animation(delta)

func _sync_playhead(external_check = false):
	var position = player.current_animation_position if not tree else 0.0
	if tree:
		tree.active = true
		var playback = tree.get("parameters/playback")
		var state = str(playback.get_current_node())
		var clip = str(aliases.get(state,state))
		position = playback.get_current_play_position()
		var restart = pending_state != ""
		if clip_metadata.has(clip) and (clip != current or restart):
			if not _validate_pose(clip,position): return false
			pending_state = ""
			if actions and not actions.validate_animation(clip):
				if clip_metadata.has("idle"): play_animation("idle")
				return
			if audio:
				if clip.to_lower() in ["death","dead"]: audio.stop_all()
				else: audio.stop_interrupted()
			cue_generation += 1
			current = clip
			held = false
			elapsed = 0.0
			observed_position = 0.0
			_notify_action_clip(clip)
			var generation = cue_generation
			if not _apply_pose(current,position): return
			_dispatch_start()
			if generation != cue_generation: return
		else: pending_state = ""
	# Direct native mixer advancement is observed at the next controller boundary.
	# Controller-owned advances update elapsed per step, so this cannot redeliver.
	if current != "" and external_check:
		var distance = position-observed_position
		if distance < 0 and clip_metadata[current].loop: distance += clip_metadata[current].duration
		if distance > 0:
			if not _within_cue_budget(elapsed,distance): return
			var generation = cue_generation
			if not _apply_pose(current,elapsed+distance): return
			_dispatch_crossings(elapsed,distance)
			if generation != cue_generation: return
			var clock_meta = clip_metadata[current]
			elapsed = fmod(elapsed+distance,clock_meta.duration) if clock_meta.loop else minf(elapsed+distance,clock_meta.duration)
	observed_position = position
	if current != "" and not _apply_pose(current,elapsed): return
	if current == "" or held: return
	var meta = clip_metadata[current]
	if not meta.loop and elapsed >= meta.duration:
		if current.to_lower() in ["death", "dead"]:
			held = true
		elif clip_metadata.has("idle"):
			play_animation("idle")

