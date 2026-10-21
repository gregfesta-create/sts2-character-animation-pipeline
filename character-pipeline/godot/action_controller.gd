extends Node2D

signal action_error(code,message)
signal projectile_released(action_id,cue_id,projectile)
signal authoritative_impact(action_id,cue_id,position)

@export var bone_paths: Dictionary = {}
@export var socket_paths: Dictionary = {}
@export var part_paths: Dictionary = {}
@export var polylines: Array = []
@export var projectile_definitions: Dictionary = {}
var context = {}
var action_clock = 0.0
var evaluation_clock = 0.0
var character_key = ""
var ledger = {}
var pending = []
var projectiles = []
var nocked_visibility = {}
var flight = {}
var clock_rate = 1.0
var action_clip = ""
var last_error = {}

func _ready():
	process_priority = 110
	if not flight.is_empty(): return
	for binding in polylines:
		var line=Line2D.new()
		line.name=binding.id
		line.width=binding.width
		line.default_color=Color(binding.color[0],binding.color[1],binding.color[2],binding.color[3])
		line.z_index=binding.layer
		add_child(line)
	update_bindings()

func _error(code,message):
	last_error={"code":code,"message":message}
	action_error.emit(code,message)
	return false

func _finite_point(value):
	return value is Array and value.size()==2 and (value[0] is float or value[0] is int) and (value[1] is float or value[1] is int) and is_finite(value[0]) and is_finite(value[1]) and absf(value[0])<=1000000 and absf(value[1])<=1000000

func begin_action(value):
	if not value is Dictionary or value.size()<5 or value.size()>6: return _error("INVALID_ACTION_CONTEXT","Action context requires explicit identity, target and timing")
	for key in value:
		if not key in ["characterInstance","actionInstance","target","releaseAt","impactAt","generation"]: return _error("INVALID_ACTION_CONTEXT","Unknown action context field")
	if value.has("generation"):
		var generation=value.generation
		if not ((generation is String and not generation.is_empty() and generation.length()<=256) or ((generation is int or generation is float) and is_finite(generation) and generation>=0 and generation<=9007199254740991 and floor(generation)==generation)):
			return _error("INVALID_ACTION_CONTEXT","Generation must be a bounded stable token")
	for key in ["characterInstance","actionInstance"]:
		if not value.get(key) is String or value[key].is_empty() or value[key].length()>128: return _error("INVALID_ACTION_CONTEXT","Action identity must be a bounded string")
	var target=value.get("target",{})
	if not target is Dictionary or target.size()!=2 or not target.get("valid") is bool or target.valid!=true or not _finite_point(target.get("position")): return _error("INVALID_ACTION_TARGET","Action requires a valid captured target position")
	var release=value.get("releaseAt")
	var impact=value.get("impactAt")
	if not (release is int or release is float) or not (impact is int or impact is float) or not is_finite(release) or not is_finite(impact) or release<0 or impact<=release or impact-release>10:
		return _error("UNSUPPORTED_ACTION_TIMING","Require 0 <= releaseAt < impactAt and a flight interval within ten seconds")
	var max_lifetime=0.0
	for definition in projectile_definitions.values(): max_lifetime=maxf(max_lifetime,definition.lifetime)
	if impact-release>max_lifetime: return _error("UNSUPPORTED_ACTION_TIMING","Flight interval exceeds configured projectile lifetimes")
	var supported_phase=false
	for clip in get_parent().clip_metadata:
		if _clip_has_projectile(clip) and _clip_matches_timing(clip,release,impact): supported_phase=true
	if not supported_phase: return _error("UNSUPPORTED_ACTION_TIMING","No authored projectile clip supports the requested release phase and flight interval")
	if character_key!="" and character_key!=value.characterInstance: return _error("ACTION_OWNER_MISMATCH","Context belongs to another character")
	if not context.is_empty() and context.actionInstance==value.actionInstance:
		return context==value
	if ledger.has(value.actionInstance): return _error("ACTION_ALREADY_SEEN","Action identity cannot be reused")
	if ledger.size()>=16384: return _error("ACTION_LEDGER_BUDGET","Action identity ledger exhausted")
	if not cancel_action(): return false
	character_key=value.characterInstance
	context=value.duplicate(true)
	action_clock=0.0
	evaluation_clock=0.0
	ledger[context.actionInstance]={"context":context.duplicate(true),"releases":{},"sounds":{},"hits":{},"impact_sounds":{}}
	return true

func _clip_has_projectile(clip):
	for event in get_parent().clip_metadata[clip].events:
		if event.get("type","")=="projectile": return true
	return false

func _clip_matches_timing(clip,release,impact):
	for event in get_parent().clip_metadata[clip].events:
		if event.get("type","")!="projectile": continue
		var definition=projectile_definitions.get(event.payload.projectile,{})
		if absf(event.time-release)>0.00001 or definition.is_empty() or impact-release>definition.lifetime: return false
	return true

func validate_animation(clip):
	if not _clip_has_projectile(clip): return true
	if context.is_empty(): return _error("ACTION_CONTEXT_MISSING","Begin an action before requesting projectile playback")
	if not _clip_matches_timing(clip,context.releaseAt,context.impactAt): return _error("UNSUPPORTED_ACTION_TIMING","Selected clip cannot honor the agreed release and impact schedule")
	if action_clock>0.00001: return _error("UNSUPPORTED_ACTION_TIMING","Projectile clip must start at the agreed action-clock origin")
	return true

func cancel_action():
	var pose=get_parent().get_node_or_null("PoseController")
	if pose and not pose.clear_action_hidden(): return _error(pose.last_error.code,pose.last_error.message)
	context={}
	action_clip=""
	pending.clear()
	for path in nocked_visibility:
		var node=get_parent().get_node_or_null(path)
		if node and not pose: node.visible=nocked_visibility[path]
	nocked_visibility.clear()
	return true

func on_animation_changed(clip,has_projectile):
	if str(clip).to_lower() in ["death","dead"]: detach_projectiles()
	elif not context.is_empty():
		if has_projectile: action_clip=clip
		elif action_clip!="" and action_clip!=clip: cancel_action()

func claim_release_sound(id,time,payloads):
	if context.is_empty() or absf(time-context.releaseAt)>0.00001: return _error("ACTION_CONTEXT_MISSING","Release sound requires its matching action context")
	var available=false
	for payload in payloads:
		if _release_available(payload): available=true
	if not available: return false
	var record=ledger[context.actionInstance]
	if record.sounds.has(id): return false
	record.sounds[id]=true
	return true

func queue_projectile(id,payload):
	if context.is_empty(): return _error("ACTION_CONTEXT_MISSING","Projectile release requires an explicit action context")
	if not _release_available(payload): return false
	pending.append({"id":id,"payload":payload.duplicate(true),"action":context.actionInstance})
	return true

func _release_available(payload):
	if context.is_empty() or context.target.valid!=true: return _error("INVALID_ACTION_TARGET","Target became invalid before release")
	if absf(evaluation_clock-context.releaseAt)>0.00001: return _error("UNSUPPORTED_ACTION_TIMING","Release evaluation does not match the agreed action clock")
	var definition=projectile_definitions.get(payload.projectile,{})
	if definition.is_empty(): return _error("PROJECTILE_MISSING","Projectile visual is unavailable")
	if context.impactAt-context.releaseAt>definition.lifetime: return _error("UNSUPPORTED_ACTION_TIMING","Agreed flight exceeds projectile lifetime")
	if not get_parent().get_node_or_null(socket_paths.get(payload.sourceSocket,NodePath(""))): return _error("PROJECTILE_SOURCE_MISSING","Release source socket was removed")
	return true

func update_action_target(action_id,value):
	if context.is_empty() or context.actionInstance!=action_id or not value is Dictionary or value.size()!=2 or not value.get("valid") is bool or not _finite_point(value.get("position")):
		return _error("INVALID_ACTION_TARGET","Target update requires the current action identity and bounded position")
	var target=Vector2(value.position[0],value.position[1])
	if value.valid:
		for projectile in active_projectiles():
			if projectile.flight.action_id!=action_id: continue
			var remaining=context.impactAt-action_clock
			if remaining<=0: return _error("UNSUPPORTED_ACTION_TIMING","Target moved after the agreed impact boundary")
		for projectile in active_projectiles():
			if projectile.flight.action_id!=action_id: continue
			projectile.flight.start=projectile.global_position
			projectile.flight.target=target
			projectile.flight.duration=context.impactAt-action_clock
			projectile.flight.lifetime-=projectile.flight.elapsed
			projectile.flight.elapsed=0.0
			var direction=target-projectile.global_position
			if direction.length_squared()>0.0000001:
				var forward=projectile.global_transform.basis_xform(projectile.flight.forward)
				var transform=Transform2D(forward.angle_to(direction),Vector2.ZERO)*projectile.global_transform
				transform.origin=projectile.global_position
				projectile.global_transform=transform
	context.target=value.duplicate(true)
	ledger[action_id].context.target=value.duplicate(true)
	return true

func time_to_release():
	if context.is_empty() or action_clock>=context.releaseAt-0.0000001: return INF
	return context.releaseAt-action_clock

func prepare_pose(delta):
	evaluation_clock=action_clock+delta

func advance_pose(delta,rate=1.0):
	clock_rate=rate
	for projectile in active_projectiles(): projectile.advance_projectile(delta)
	if not context.is_empty(): action_clock+=delta
	evaluation_clock=action_clock
	update_bindings()
	var queued=pending
	pending=[]
	for cue in queued: _release_projectile(cue)

func update_bindings():
	if not flight.is_empty(): return
	for binding in polylines:
		var line=get_node_or_null(NodePath(binding.id))
		if not line: continue
		var points=PackedVector2Array()
		for anchor in binding.anchors:
			var bone=get_parent().get_node_or_null(bone_paths.get(anchor.bone,NodePath("")))
			if not bone: return
			points.append(line.to_local(bone.global_transform*Vector2(anchor.position[0],anchor.position[1])))
		line.points=points

func _release_projectile(cue):
	if context.is_empty() or cue.action!=context.actionInstance: return
	var record=ledger[cue.action]
	if record.releases.has(cue.id): return
	if not _release_available(cue.payload): return
	var definition=projectile_definitions.get(cue.payload.projectile,{})
	if definition.is_empty():
		_error("PROJECTILE_MISSING","Projectile visual is unavailable")
		return
	var duration=context.impactAt-context.releaseAt
	if duration>definition.lifetime or absf(action_clock-context.releaseAt)>0.00001:
		_error("UNSUPPORTED_ACTION_TIMING","Release cue does not match the agreed action clock or projectile lifetime")
		return
	var socket=get_parent().get_node_or_null(socket_paths.get(cue.payload.sourceSocket,NodePath("")))
	if not socket:
		_error("PROJECTILE_SOURCE_MISSING","Release source socket was removed")
		return
	# Cue listeners can remove bindings after playback's initial validation.
	# Validate and commit the visibility veto before consuming release identity
	# or creating/registering any projectile. No callbacks occur in this gap.
	var pose=get_parent().get_node_or_null("PoseController")
	if pose and not pose.validate_bindings():
		_error(pose.last_error.code,pose.last_error.message)
		return
	if pose and cue.payload.has("nockedPart"):
		if not pose.validate_action_hidden(cue.payload.nockedPart):
			_error(pose.last_error.code,pose.last_error.message)
			return
		if not pose.set_action_hidden(cue.payload.nockedPart,true):
			_error(pose.last_error.code,pose.last_error.message)
			return
	var target=Vector2(context.target.position[0],context.target.position[1])
	var transform=socket.global_transform
	var direction=target-transform.origin
	var forward=transform.basis_xform(Vector2(definition.forward[0],definition.forward[1]))
	if direction.length_squared()>0.0000001:
		var rotation=Transform2D(forward.angle_to(direction),Vector2.ZERO)
		transform=rotation*transform
		transform.origin=socket.global_position
	var scene=get_tree().root
	var registry=scene.get_meta("_pipeline_projectiles",[])
	while active_projectile_count()>=32: _retire(active_projectiles()[0],"Character projectile limit retired oldest visual")
	registry=_clean_registry(registry)
	while registry.size()>=256:
		var oldest=registry[0].get_ref()
		_retire(oldest,"Scene projectile limit retired oldest visual")
		registry=_clean_registry(scene.get_meta("_pipeline_projectiles",[]))
	var projectile=Node2D.new()
	projectile.set_script(load("res://action_controller.gd"))
	projectile.flight={"owner":weakref(self),"scene":weakref(scene),"action_id":cue.action,"forward":Vector2(definition.forward[0],definition.forward[1]),"start":transform.origin,"target":target,"duration":duration,"lifetime":definition.lifetime,"policy":definition.get("removalPolicy","cancel"),"elapsed":0.0,"rate":clock_rate}
	projectile.name="Projectile"
	scene.add_child(projectile)
	projectile.global_transform=transform
	projectile.add_child(definition.visual.instantiate())
	projectiles.append(weakref(projectile))
	registry.append(weakref(projectile))
	scene.set_meta("_pipeline_projectiles",registry)
	record.releases[cue.id]=true
	if definition.has("impactSound"): record.impact_sounds[definition.impactSound]=true
	if cue.payload.has("nockedPart"):
		var path=part_paths.get(cue.payload.nockedPart,NodePath(""))
		var part=get_parent().get_node_or_null(path)
		if part:
			if not nocked_visibility.has(path): nocked_visibility[path]=part.visible
			if not pose: part.visible=false
	projectile_released.emit(cue.action,cue.id,projectile)

func _clean_registry(registry):
	return registry.filter(func(ref): return is_instance_valid(ref.get_ref()) and not ref.get_ref().is_queued_for_deletion())

func active_projectiles():
	projectiles=_clean_registry(projectiles)
	return projectiles.map(func(ref): return ref.get_ref())

func active_projectile_count(): return active_projectiles().size()

func _retire(projectile,message):
	if is_instance_valid(projectile): projectile.expire_projectile()
	_error("PROJECTILE_RETIRED",message)

func advance_projectile(delta):
	if flight.is_empty() or is_queued_for_deletion(): return
	flight.elapsed+=delta
	global_position=flight.start.lerp(flight.target,clampf(flight.elapsed/flight.duration,0,1))
	if flight.elapsed>=flight.lifetime: expire_projectile()

func expire_projectile():
	if flight.is_empty(): return
	var scene=flight.scene.get_ref()
	if is_instance_valid(scene):
		var registry=scene.get_meta("_pipeline_projectiles",[])
		registry=registry.filter(func(ref): return ref.get_ref()!=self and is_instance_valid(ref.get_ref()) and not ref.get_ref().is_queued_for_deletion())
		scene.set_meta("_pipeline_projectiles",registry)
	queue_free()

func authoritative_hit(action_id,cue_id,value):
	if not ledger.has(action_id) or not value is Dictionary or not value.get("clock",-1) is float and not value.get("clock",-1) is int: return _error("INVALID_HIT_CONTEXT","Hit requires an existing action and authoritative clock")
	var record=ledger[action_id]
	if not is_finite(value.clock) or value.clock<record.context.impactAt: return _error("UNSUPPORTED_ACTION_TIMING","Authoritative hit precedes agreed impact time")
	if record.releases.is_empty(): return _error("INVALID_HIT_CONTEXT","Action has no released projectile")
	if value.has("releaseCue"):
		var release_cue=value.releaseCue
		if not release_cue is String or release_cue.is_empty() or release_cue.length()>128 or not record.releases.has(release_cue):
			return _error("INVALID_HIT_CONTEXT","Hit source must identify an actually released projectile cue")
	if not cue_id is String or cue_id.is_empty() or cue_id.length()>128: return _error("INVALID_HIT_CONTEXT","Hit cue identity must be a bounded string")
	if record.hits.has(cue_id): return false
	var position=value.get("position",record.context.target.position)
	if not _finite_point(position): return _error("INVALID_HIT_CONTEXT","Invalid authoritative impact position")
	var sound=""
	if value.has("sound"):
		if not record.impact_sounds.has(value.sound): return _error("UNDECLARED_IMPACT_SOUND","Hit sound is not declared by this action's released projectile")
		sound=value.sound
	elif record.impact_sounds.size()==1: sound=record.impact_sounds.keys()[0]
	elif record.impact_sounds.size()>1: return _error("AMBIGUOUS_IMPACT_SOUND","Hit must select one declared impact sound")
	if sound!="":
		var audio=get_parent().get_node_or_null("AudioController")
		if not audio or not audio.sounds.has(sound): return _error("IMPACT_SOUND_MISSING","Declared impact sound is unavailable")
		if not audio.play_cue(cue_id,{"sound":sound}): return false
	record.hits[cue_id]=true
	authoritative_impact.emit(action_id,cue_id,Vector2(position[0],position[1]))
	return true

func detach_projectiles():
	for projectile in active_projectiles():
		if projectile.flight.policy=="finish":
			projectile.flight.owner=null
			projectile.flight.rate=clock_rate
		else: projectile.expire_projectile()
	projectiles=[]
	cancel_action()

func _process(delta):
	if flight.is_empty(): update_bindings()
	elif flight.owner==null or not is_instance_valid(flight.owner.get_ref()) or not flight.owner.get_ref().is_inside_tree(): advance_projectile(delta*flight.rate)

func _exit_tree():
	if flight.is_empty(): detach_projectiles()
