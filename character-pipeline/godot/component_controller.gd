extends Node2D
# Registrations are trusted PackedScenes supplied by the compiler; no runtime path loading.
signal transition_finished(socket,operation)
signal transition_phase(socket,operation,phase_id,generation)
var sockets={}
var registry={}
var mounted={}
var transitions={}
var transition_generation=0
var evaluation_depth=0
var last_error=""
static func supported_root(node):
 if not node is Node2D: return false
 if not node.has_meta("canonical_canvas"): return true
 var canvas=node.get_meta("canonical_canvas")
 return canvas is Vector2 and is_finite(canvas.x) and is_finite(canvas.y) and canvas.x>0 and canvas.y>0 and canvas.x<=16384 and canvas.y<=16384
static func supported_profiles(node,profiles):
 if profiles is Dictionary and profiles.is_empty(): return true
 if not load("res://assembly_planner.gd").valid_transition_profiles(profiles): return false
 for operation in profiles:
  for phase in profiles[operation].phases:
   if not phase.has("clip"): continue
   if not node.has_method("play_animation"): return false
   var metadata=node.get("clip_metadata")
   var player=node.get_node_or_null("AnimationPlayer")
   if not metadata is Dictionary or not metadata.has(phase.clip) or not player is AnimationPlayer or not player.has_animation(phase.clip): return false
   var clip=metadata[phase.clip]
   if not clip is Dictionary or not clip.get("events") is Array or clip.events.size()>10000: return false
   for event in clip.events:
    if not event is Dictionary or event.get("type","")=="projectile": return false
 return true
func _fail(message):
 last_error=message
 return false
func _token(value): return value is String and value.length()>0 and value.length()<=128
func _tokens(value,maximum=64):
 if not value is Array or value.is_empty() or value.size()>maximum: return false
 var seen={}
 for item in value:
  if not _token(item) or seen.has(item): return false
  seen[item]=true
 return true
func _events(value):
 return value is Array and value.size()<=256 and (value.is_empty() or _tokens(value,256))
func configure_sockets(definitions):
 if not definitions is Dictionary or definitions.size()>64 or not mounted.is_empty(): return _fail("Invalid socket registry")
 var checked={}
 var physical_mounts={}
 for id in definitions:
  var d=definitions[id]
  if not _token(id) or not d is Dictionary or not d.get("path") is NodePath or not _tokens(d.get("types")) or d.get("capacity")!=1: return _fail("Unsupported socket contract")
  for key in d:
   if not key in ["path","types","capacity","layer","scale","mirror","events"]: return _fail("Unknown socket field")
  var node=get_node_or_null(d.path)
  if not node is Node2D: return _fail("Missing owned mount")
  if node==get_parent() or not get_parent().is_ancestor_of(node): return _fail("Mount escapes owned chassis")
  if physical_mounts.has(node.get_instance_id()): return _fail("Conflicting physical mount")
  physical_mounts[node.get_instance_id()]=true
  var size=d.get("scale",[1,1])
  if not node is Node2D or not size is Array or size.size()!=2: return _fail("Invalid mount")
  for n in size:
   if not (n is int or n is float) or not is_finite(n) or n<=0 or n>100: return _fail("Invalid mount scale")
  if not d.get("layer",0) is int or abs(d.get("layer",0))>4096 or not d.get("mirror",false) is bool or not _events(d.get("events",[])): return _fail("Invalid mount contract")
  checked[id]=d.duplicate(true)
  checked[id].scale=size.duplicate()
  checked[id].events=d.get("events",[]).duplicate()
  checked[id].layer=d.get("layer",0)
  checked[id].mirror=d.get("mirror",false)
 sockets=checked
 return true
func register_component(id,scene,contract):
 if not _token(id) or registry.size()>=256 or registry.has(id) or not scene is PackedScene or not contract is Dictionary or not _token(contract.get("type")) or not _events(contract.get("events",[])): return _fail("Invalid trusted component registration")
 for key in contract:
  if not key in ["type","events","transitions"]: return _fail("Unknown component contract field")
 var candidate=scene.instantiate()
 var compatible=supported_profiles(candidate,contract.get("transitions",{}))
 candidate.free()
 if not compatible: return _fail("Invalid transition profiles or child clip metadata")
 registry[id]={"scene":scene,"contract":contract.duplicate(true)}
 return true
func component_at(socket): return mounted.get(socket)
func cancel_transition(socket):
 if not transitions.has(socket): return false
 var state=transitions[socket]
 transitions.erase(socket)
 var node=component_at(socket)
 if is_instance_valid(node):
  node.transform=state.baseline
  node.modulate=node.get_meta("component_base_modulate",Color.WHITE)
 return true
func transition(socket,operation,component_id="",duration=0.2,profile_operation=""):
 if profile_operation!="" and not (operation=="install" and profile_operation=="replace"): return _fail("Invalid profile operation")
 var kind=operation if profile_operation=="" else profile_operation
 if not sockets.has(socket) or not operation in ["install","remove","replace","upgrade","repair","destroy","damage","visual"]: return _fail("Unknown transition")
 if not (duration is int or duration is float) or not is_finite(duration) or duration<0 or duration>10: return _fail("Invalid duration")
 var current=component_at(socket)
 var creates=operation in ["install","replace","upgrade"]
 if creates:
  if not registry.has(component_id) or not registry[component_id].contract.type in sockets[socket].types: return _fail("Incompatible component")
  for event in registry[component_id].contract.get("events",[]):
   if not event in sockets[socket].get("events",[]): return _fail("Unsupported event")
  if operation=="install" and current!=null: return _fail("Socket full")
  if operation!="install" and current==null: return _fail("Socket empty")
 elif current==null: return _fail("Socket empty")
 var profile_registry=registry.get(component_id,{}) if creates else registry.get(current.get_meta("component_definition_id",""),{})
 var profiles=profile_registry.get("contract",{}).get("transitions",{})
 var candidate=null
 if creates:
  candidate=registry[component_id].scene.instantiate()
  if not supported_root(candidate) or not supported_profiles(candidate,profiles):
   candidate.free()
   return _fail("Unsupported component root or canonical canvas")
 elif not supported_profiles(current,profiles): return _fail("Invalid transition profiles or child clip metadata")
 var profile=profiles.get(kind,{"duration":duration,"phases":[]}).duplicate(true)
 cancel_transition(socket)
 if creates:
  if is_instance_valid(current): current.free()
  var definition=sockets[socket]
  get_node(definition.path).add_child(candidate)
  candidate.scale=Vector2(definition.scale[0]*(-1 if definition.get("mirror",false) else 1),definition.scale[1])
  candidate.z_index=definition.get("layer",0)
  candidate.set_meta("component_base_modulate",candidate.modulate)
  mounted[socket]=candidate
  candidate.set_meta("component_definition_id",component_id)
 transition_generation+=1
 var node=component_at(socket)
 var offset=Vector2.ZERO
 if node.has_meta("canonical_canvas"):
  var canvas=node.get_meta("canonical_canvas")
  offset=Vector2(0,-minf(canvas.x,canvas.y)/8.0)
 transitions[socket]={"kind":kind,"elapsed":0.0,"duration":float(profile.duration),"generation":transition_generation,"baseline":node.transform,"offset":offset,"instance_id":node.get_instance_id(),"phases":profile.phases,"next_phase":0}
 if not profile.phases.is_empty() and not node.is_node_ready():
  var generation=transition_generation
  node.ready.connect(func():
   if is_instance_valid(self) and transitions.has(socket) and transitions[socket].generation==generation: _evaluate(socket)
  ,CONNECT_ONE_SHOT)
 var state=transitions[socket]
 _evaluate(socket)
 if creates and (not is_instance_valid(node) or component_at(socket)!=node): return false
 return _current(socket,state,node) or state.get("completed",false)
func _process(delta): advance(delta)
func advance(delta):
 # Child clip markers and phase observers run synchronously. Reject clock
 # reentry so they cannot consume later phases before the current observation.
 # Cancel/clear/new transitions remain available and use generation guards.
 if evaluation_depth>0: return false
 if not (delta is float or delta is int) or not is_finite(delta) or delta<0: return false
 var generations={}
 for socket in transitions: generations[socket]=transitions[socket].generation
 for socket in generations:
  if not transitions.has(socket) or transitions[socket].generation!=generations[socket]: continue
  if not is_instance_valid(component_at(socket)):
   _evaluate(socket)
   continue
  if not transitions[socket].phases.is_empty() and not component_at(socket).is_node_ready(): continue
  transitions[socket].elapsed+=delta
  _evaluate(socket)
 return true
func _current(socket,state,node):
 return is_instance_valid(self) and is_instance_valid(node) and transitions.has(socket) and transitions[socket].generation==state.generation and component_at(socket)==node and node.get_instance_id()==state.instance_id
func _evaluate(socket):
 evaluation_depth+=1
 _evaluate_state(socket)
 evaluation_depth-=1
func _evaluate_state(socket):
 if not transitions.has(socket): return
 var t=transitions[socket]
 var node=component_at(socket)
 if not is_instance_valid(node):
  transitions.erase(socket)
  mounted.erase(socket)
  return
 if node.get_instance_id()!=t.instance_id: return
 # Child animation owners initialize their own player/tree in _ready().
 if not t.phases.is_empty() and not node.is_node_ready(): return
 while t.next_phase<t.phases.size() and t.phases[t.next_phase].time<=minf(t.elapsed,t.duration):
  var phase=t.phases[t.next_phase]
  t.next_phase+=1
  if phase.has("clip"):
   node.play_animation(phase.clip)
   if not _current(socket,t,node): return
  transition_phase.emit(socket,t.kind,phase.id,t.generation)
  if not _current(socket,t,node): return
 var progress=1.0 if t.duration==0 else clampf(t.elapsed/t.duration,0,1)
 if t.kind in ["install","replace","upgrade","remove"]:
  var eased=progress*progress*(3.0-2.0*progress)
  var pose=t.baseline
  pose.origin+=pose.basis_xform(t.offset)*(eased if t.kind=="remove" else 1.0-eased)
  node.transform=pose
 if t.kind in ["remove","destroy"]: node.modulate.a=node.get_meta("component_base_modulate",Color.WHITE).a*(1-progress)
 elif t.kind in ["install","replace","upgrade"]: node.modulate.a=node.get_meta("component_base_modulate",Color.WHITE).a*progress
 else: node.modulate=node.get_meta("component_base_modulate",Color.WHITE)*Color(1,1-progress*0.5,1-progress*0.5,1)
 if progress>=1:
  t.completed=true
  if t.kind in ["remove","destroy"]:
   node.free()
   mounted.erase(socket)
  else:
   node.transform=t.baseline
   node.modulate=node.get_meta("component_base_modulate",Color.WHITE)
  transitions.erase(socket)
  transition_finished.emit(socket,t.kind)
func clear_components():
 transitions.clear()
 for node in mounted.values():
  if is_instance_valid(node): node.free()
 mounted.clear()
func _exit_tree(): clear_components()

