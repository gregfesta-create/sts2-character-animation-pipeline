extends Node

signal pose_error(code,message)
@export var pose_groups: Array = []
@export var clip_metadata: Dictionary = {}
@export var part_paths: Dictionary = {}
var last_error = {}
var state_selection = {}
var selected = {}
var action_hidden = {}
var bindings = {}
var bound = false

# Pure, side-effect-free selection shared by live playback and native capture.
static func selection_at(groups,metadata,clip,time):
	if not metadata.has(clip) or not (time is float or time is int) or not is_finite(time) or time<0:
		return {"valid":false,"code":"POSE_SELECTION_INVALID","message":"Unknown pose clip or invalid time"}
	var meta=metadata[clip]
	var duration=float(meta.get("duration",0))
	if duration<=0: return {"valid":false,"code":"POSE_SELECTION_INVALID","message":"Pose clip duration is invalid"}
	var clock=fmod(time,duration) if meta.get("loop",false) else minf(time,duration)
	var selection={}
	for group in groups:
		var part=group.defaultPart
		for track in meta.get("poseTracks",[]):
			if track.group!=group.id: continue
			for key in track.keys:
				if key.time<=clock: part=key.part
		if not part in group.parts: return {"valid":false,"code":"POSE_SELECTION_INVALID","message":"Selected pose is not a group member"}
		for member in group.parts: selection[member]=member==part
	return {"valid":true,"selection":selection}

func _error(code,message):
	last_error={"code":code,"message":message}
	pose_error.emit(code,message)
	return false

func _resolve():
	var resolved={}
	if bound and part_paths.size()!=bindings.size(): return _error("POSE_BINDING_MISSING","Pose binding membership changed")
	for id in part_paths:
		if bound and not bindings.has(id): return _error("POSE_BINDING_MISSING","Pose binding membership changed")
		var part=get_parent().get_node_or_null(part_paths[id])
		if not part is CanvasItem or (bindings.has(id) and bindings[id]!=part):
			return _error("POSE_BINDING_MISSING","Pose part is unavailable: "+str(id))
		resolved[id]=part
	for group in pose_groups:
		for id in group.parts:
			if not resolved.has(id): return _error("POSE_BINDING_MISSING","Pose group part is unavailable: "+str(id))
	bindings=resolved
	bound=true
	return true

func _commit(next_state,next_selected,next_hidden):
	if not _resolve(): return false
	for collection in [next_state,next_selected,next_hidden]:
		for id in collection:
			if not bindings.has(id): return _error("POSE_BINDING_MISSING","Pose selection part is unavailable: "+str(id))
	state_selection=next_state.duplicate()
	selected=next_selected.duplicate()
	action_hidden=next_hidden.duplicate()
	for id in bindings:
		bindings[id].visible=state_selection.get(id,true) and selected.get(id,true) and not action_hidden.get(id,false)
	last_error={}
	return true

func apply_pose(clip,time):
	var result=selection_at(pose_groups,clip_metadata,clip,time)
	if not result.valid: return _error(result.code,result.message)
	return _commit(state_selection,result.selection,action_hidden)

func validate_pose(clip,time):
	var result=selection_at(pose_groups,clip_metadata,clip,time)
	if not result.valid: return _error(result.code,result.message)
	return _resolve()

func set_state_selection(parts):
	var next={}
	for id in part_paths: next[id]=id in parts
	for id in parts:
		if not part_paths.has(id): return _error("POSE_BINDING_MISSING","Visual state part is unavailable: "+str(id))
	return _commit(next,selected,action_hidden)

func clear_state_selection(): return _commit({},selected,action_hidden)

func set_action_hidden(id,hidden):
	if not part_paths.has(id): return _error("POSE_BINDING_MISSING","Action part is unavailable: "+str(id))
	var next=action_hidden.duplicate()
	if hidden: next[id]=true
	else: next.erase(id)
	return _commit(state_selection,selected,next)

func validate_action_hidden(id):
	if not part_paths.has(id): return _error("POSE_BINDING_MISSING","Action part is unavailable: "+str(id))
	return _resolve()

func validate_bindings(): return _resolve()

func clear_action_hidden(): return _commit(state_selection,selected,{})
