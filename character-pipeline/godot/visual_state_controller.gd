extends Node

signal visual_state_error(code, message)
@export var states: Dictionary = {}
@export var part_paths: Dictionary = {}
var last_error = {}
var current_state = ""
var baseline = {}

func _ready():
 for id in part_paths:
  var part=get_parent().get_node_or_null(part_paths[id])
  if part is CanvasItem: baseline[id]=true if get_parent().get_node_or_null("PoseController") else part.visible

func _error(code,message):
 last_error={"code":code,"message":message}
 visual_state_error.emit(code,message)
 return false

func _apply(selection):
 var action=get_parent().get_node_or_null("ActionController")
 if action and (not action.context.is_empty() or not action.nocked_visibility.is_empty()):
  return _error("VISUAL_STATE_ACTION_ACTIVE","Cancel the active action before changing visual state")
 var bindings={}
 for id in part_paths:
  var part=get_parent().get_node_or_null(part_paths[id])
  if not part is CanvasItem or not baseline.has(id): return _error("VISUAL_STATE_BINDING_MISSING","Visual state part is unavailable: "+str(id))
  bindings[id]=part
 for id in selection:
  if not bindings.has(id): return _error("VISUAL_STATE_BINDING_MISSING","Visual state declares an unavailable part: "+str(id))
 var pose=get_parent().get_node_or_null("PoseController")
 if pose:
  if not pose.set_state_selection(selection): return _error(pose.last_error.code,pose.last_error.message)
 else:
  for id in bindings: bindings[id].visible=selection.has(id)
 last_error={}
 return true

func set_visual_state(id):
 if not id is String or not states.has(id): return _error("VISUAL_STATE_UNKNOWN","Unknown visual state: "+str(id))
 if not _apply(states[id]): return false
 current_state=id
 return true

func clear_visual_state():
 var selection=[]
 for id in baseline:
  if baseline[id]: selection.append(id)
 if not _apply(selection): return false
 current_state=""
 return true
