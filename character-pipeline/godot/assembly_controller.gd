extends Node2D
const ComponentController=preload("res://component_controller.gd")
signal transition_phase(component_id,logical_socket,operation,phase_id,generation)
# Consumer of validated immutable JS planner data. Revision/sequence come from
# the authoritative state envelope, never a locally computed gameplay value.
var native
var sockets={}
var descriptors={}
var records={}
var wrappers={}
var pending={}
var allocations={}
var socket_slots={}
var slot_logical={}
var instance_id=""
var revision=-1
var sequence=-1
var last_error=""
var _busy=false
var _last_plan={}
var _chassis
var _native_id=0
var faulted=false
var _rebuilding=false
var _exit_cleanup_pending=false
var _mount_context={}
var _replacement_ids={}
var _presentation_epoch=0
func _fail(message):
 last_error=message
 return false
func _full(value): return value=={"position":true,"rotation":true,"scale":true}
func _fields(value, keys):
 if not value is Dictionary or value.size()!=keys.size(): return false
 for key in keys:
  if not value.has(key): return false
 return true
func _id(value):
 return value is String and value.length()<=64 and RegEx.create_from_string("^[A-Za-z][A-Za-z0-9_-]{0,63}$").search(value)!=null
func _integer(value,minimum,maximum):
 return (value is int or value is float) and is_finite(value) and value>=minimum and value<=maximum and floor(value)==value
func _state(value, id, socket, type):
 if not _fields(value,["id","socket","type","revision","damageState","upgrade","visualMode"]): return false
 return value.id==id and value.socket==socket and value.type==type and _id(value.id) and _id(value.socket) and _id(value.type) and _id(value.visualMode) and value.damageState in ["intact","damaged","destroyed"] and _integer(value.revision,1,9007199254740991) and _integer(value.upgrade,0,1000000)
func configure(id, socket_map, descriptor_map):
 if native!=null or not id is String or id.is_empty() or id.length()>64 or not socket_map is Dictionary or socket_map.size()>64 or not descriptor_map is Dictionary or descriptor_map.size()>256: return _fail("Invalid trusted assembly registry")
 var nodes={}
 var total_capacity=0
 for key in socket_map:
  var s=socket_map[key]
  if not _id(key) or not s is Dictionary or not _integer(s.get("capacity"),1,64) or not _full(s.get("inheritance")): return _fail("Unsupported capacity or partial inheritance")
  total_capacity+=int(s.capacity)
  if total_capacity>64: return _fail("Private slot budget exceeded")
  var node=s.get("node")
  if not node is Node2D or node==get_parent() or not get_parent().is_ancestor_of(node) or nodes.has(node.get_instance_id()): return _fail("Mount must be unique and owned by chassis")
  if not s.get("types") is Array or s.types.is_empty() or s.types.size()>64: return _fail("Invalid socket types")
  nodes[node.get_instance_id()]=true
 var event_union={}
 for type in descriptor_map:
  var d=descriptor_map[type]
  if not type is String or not d is Dictionary or not d.get("scene") is PackedScene or not d.get("spec") is String or not d.get("events",[]) is Array or d.get("events",[]).size()>256: return _fail("Invalid trusted PackedScene descriptor")
  for event in d.get("events",[]):
   event_union[event]=true
  if event_union.size()>256: return _fail("Assembly event union exceeds parent contract capacity")
  var candidate=d.scene.instantiate()
  var valid=ComponentController.supported_root(candidate) and ComponentController.supported_profiles(candidate,d.get("transitions",{}))
  if candidate!=null: candidate.free()
  if not valid: return _fail("Unsupported component root or canonical canvas metadata")
 _busy=true
 var controller=load("res://component_controller.gd").new()
 get_parent().add_child(controller)
 var definitions={}
 for key in socket_map:
  socket_slots[key]=[]
  for index in range(int(socket_map[key].capacity)):
   # The delimiter cannot occur in authored logical IDs. Capacity1 stays compatible.
   var slot=key if socket_map[key].capacity==1 else "@"+key+":"+str(index)
   socket_slots[key].append(slot)
   slot_logical[slot]=key
   var wrapper=Node2D.new()
   socket_map[key].node.add_child(wrapper)
   wrappers[slot]=wrapper
   definitions[slot]={"path":controller.get_path_to(wrapper),"types":socket_map[key].types.duplicate(),"capacity":1,"events":[]}
   for type in descriptor_map:
    if type not in socket_map[key].types: continue
    for event in descriptor_map[type].get("events",[]):
     if not event in definitions[slot].events: definitions[slot].events.append(event)
 if not controller.configure_sockets(definitions):
  controller.free()
  for wrapper in wrappers.values(): wrapper.free()
  wrappers.clear()
  socket_slots.clear()
  slot_logical.clear()
  _busy=false
  return _fail("Unsupported native socket registry")
 for type in descriptor_map:
  var contract={"type":type,"events":descriptor_map[type].get("events",[])}
  if descriptor_map[type].has("transitions"): contract.transitions=descriptor_map[type].transitions.duplicate(true)
  if not controller.register_component(type,descriptor_map[type].scene,contract):
   controller.free()
   for wrapper in wrappers.values(): wrapper.free()
   wrappers.clear()
   socket_slots.clear()
   slot_logical.clear()
   _busy=false
   return _fail("Unsupported native component registry")
 native=controller
 native.transition_phase.connect(_on_transition_phase)
 native.set_process(false)
 sockets=socket_map.duplicate(true)
 descriptors=descriptor_map.duplicate(true)
 instance_id=id
 _chassis=get_parent()
 _native_id=native.get_instance_id()
 _busy=false
 if _exit_cleanup_pending:
  clear_assembly()
  return _fail("Assembly exited during configuration")
 return true
func component_at(id):
 if not is_instance_valid(native): return null
 var record=records.get(id,pending.get(id))
 return native.component_at(allocations.get(id,"")) if record!=null else null
func _on_transition_phase(slot,operation,phase_id,generation):
 if not is_instance_valid(native) or not native.transitions.has(slot): return
 var state=native.transitions[slot]
 var node=native.component_at(slot)
 if not is_instance_valid(node) or state.generation!=generation or state.instance_id!=node.get_instance_id(): return
 var record=_mount_context.get(slot)
 if record==null:
  for id in allocations:
   if allocations[id]==slot:
    record=records.get(id,pending.get(id))
    break
 if record==null or slot_logical.get(slot)!=record.socket: return
 transition_phase.emit(record.id,record.socket,operation,phase_id,generation)
 # Do not continue through a reentrant clear/replacement or freed child.
 if not is_instance_valid(native) or not is_instance_valid(node) or native.component_at(slot)!=node or not native.transitions.has(slot) or native.transitions[slot].generation!=generation: return
# A post-mutation failure is not rollback. Quarantine until a bounded owned rebuild,
# clear bounded owned components, retain authority counters, and require the host
# to rebuild owned presentation from a genuine snapshot. The chassis is retained.
func _quarantine(message):
 faulted=true
 # Only native.mounted tracks pipeline-created component nodes. A wrapper may
 # also contain unrelated host features; never infer ownership from parentage.
 clear_assembly()
 set_process(false)
 for key in ["assembly_lifecycle","assembly_visual_mode"]:
  if has_meta(key): remove_meta(key)
 return _fail(message)
func _physical_ready():
 if not is_instance_valid(_chassis) or _chassis.is_queued_for_deletion() or is_queued_for_deletion() or get_parent()!=_chassis or not is_instance_valid(native) or native.get_instance_id()!=_native_id or native.is_queued_for_deletion() or native.get_parent()!=_chassis: return false
 if wrappers.size()!=slot_logical.size() or native.sockets.size()!=wrappers.size() or native.registry.size()!=descriptors.size() or socket_slots.size()!=sockets.size(): return false
 var expected_slots=0
 for logical in sockets:
  if not socket_slots.get(logical) is Array or socket_slots[logical].size()!=int(sockets[logical].capacity): return false
  expected_slots+=int(sockets[logical].capacity)
  var unique_slots={}
  for slot in socket_slots[logical]:
   if unique_slots.has(slot): return false
   unique_slots[slot]=true
   if slot_logical.get(slot)!=logical: return false
 if expected_slots!=wrappers.size(): return false
 if allocations.size()!=records.size()+pending.size(): return false
 for id in records:
  if not allocations.has(id) or pending.has(id) or slot_logical.get(allocations[id])!=records[id].socket: return false
 for id in pending:
  if not allocations.has(id) or slot_logical.get(allocations[id])!=pending[id].socket: return false
 var occupied={}
 for id in allocations:
  var slot=allocations[id]
  if not slot_logical.has(slot) or occupied.has(slot): return false
  occupied[slot]=true
 for slot in wrappers:
  var socket=slot_logical.get(slot,"")
  if not sockets.has(socket): return false
  var mount=sockets[socket].get("node")
  var wrapper=wrappers.get(slot)
  if not is_instance_valid(mount) or not mount is Node2D or mount.is_queued_for_deletion() or not _chassis.is_ancestor_of(mount): return false
  if not is_instance_valid(wrapper) or not wrapper is Node2D or wrapper.is_queued_for_deletion() or wrapper.get_parent()!=mount: return false
  var definition=native.sockets.get(slot)
  if not definition is Dictionary: return false
  var expected_events=[]
  for type in descriptors:
   if type in sockets[socket].types:
    for event in descriptors[type].get("events",[]):
     if event not in expected_events: expected_events.append(event)
  expected_events.sort()
  if not definition.get("events",[]) is Array: return false
  var actual_events=definition.get("events",[]).duplicate()
  for event in actual_events:
   if not event is String: return false
  actual_events.sort()
  if actual_events!=expected_events: return false
  if not definition.get("path") is NodePath or native.get_node_or_null(definition.path)!=wrapper or definition.get("types")!=sockets[socket].types: return false
 for type in descriptors:
  if not native.registry.has(type) or native.registry[type].scene!=descriptors[type].scene or native.registry[type].contract.type!=type or native.registry[type].contract.events!=descriptors[type].get("events",[]): return false
  if native.registry[type].contract.get("transitions",{})!=descriptors[type].get("transitions",{}): return false
 return true
func _scene_ready(type):
 if not descriptors.has(type) or not descriptors[type].get("scene") is PackedScene or native==null or not native.registry.has(type) or native.registry[type].scene!=descriptors[type].scene: return false
 var epoch=_presentation_epoch
 var controller=native
 var candidate=descriptors[type].scene.instantiate()
 var valid=ComponentController.supported_root(candidate) and ComponentController.supported_profiles(candidate,descriptors[type].get("transitions",{}))
 if candidate!=null: candidate.free()
 return valid and epoch==_presentation_epoch and is_instance_valid(controller) and native==controller and not _exit_cleanup_pending and _physical_ready()
func _preflight(plan):
 var was_busy=_busy
 var epoch=_presentation_epoch
 _busy=true
 var valid=_preflight_body(plan)
 _busy=was_busy
 return valid and epoch==_presentation_epoch and not _exit_cleanup_pending and _physical_ready()
func _preflight_body(plan):
 if faulted or not _physical_ready(): return false
 # Validate the complete captured registry and live clip owners before any
 # earlier instruction can cancel or mutate a different component.
 for type in descriptors:
  if not _scene_ready(type): return false
 for slot in native.mounted:
  var child=native.component_at(slot)
  if not is_instance_valid(child): continue
  var type=child.get_meta("component_definition_id","")
  if not descriptors.has(type) or not ComponentController.supported_profiles(child,descriptors[type].get("transitions",{})): return false
 if not _fields(plan,["version","instanceId","preserveChassis","instructions"]) or plan.get("version")!=1 or plan.get("instanceId")!=instance_id or plan.get("preserveChassis")!=true or not plan.get("instructions") is Array or plan.instructions.size()>32768: return false
 var simulated=records.duplicate(true)
 var terminal=false
 for i in plan.instructions:
  if not i is Dictionary: return false
  var action=i.get("action")
  if terminal and action!="visualMode": return false
  if action in ["cancelAll","lifecycle","visualMode"]:
   if not _fields(i,["action"] if action=="cancelAll" else ["action","kind" if action=="lifecycle" else "mode"]): return false
   if action=="lifecycle" and not i.get("kind") in ["death","revive","removed"]: return false
   if action=="visualMode" and not _id(i.get("mode")): return false
   if action=="lifecycle" and i.kind=="removed":
    simulated.clear()
    terminal=true
   continue
  if not _id(i.get("id")): return false
  if action=="mount":
   if not _fields(i,["action","id","socket","type","spec","frame","layer","inheritance","state"]): return false
   if simulated.has(i.id) or not sockets.has(i.get("socket")) or not descriptors.has(i.get("type")): return false
   var d=descriptors[i.type]
   if not _scene_ready(i.type) or i.type not in sockets[i.socket].types or i.get("spec")!=d.spec or not _full(i.get("inheritance")) or not i.get("frame") is Array or i.frame.size()!=6 or not _integer(i.get("layer"),-4096,4096) or not i.get("state") is Dictionary: return false
   for n in i.frame:
    if not (n is int or n is float) or not is_finite(n) or abs(n)>1000000: return false
   if abs(i.frame[0]*i.frame[3]-i.frame[1]*i.frame[2])<0.000000001: return false
   if not _state(i.state,i.id,i.socket,i.type): return false
   var count=0
   for r in simulated.values():
    if r.socket==i.socket:
     count+=1
     if r.frame==i.frame: return false
   if count>=sockets[i.socket].capacity: return false
   simulated[i.id]=i.duplicate(true)
  elif action in ["cancel","transition","unmount","update"]:
   if not simulated.has(i.id): return false
   var keys=["action","id"]
   if action=="transition":
    keys.append("kind")
    if i.has("state"): keys.append("state")
   elif action=="update": keys.append("state")
   if not _fields(i,keys): return false
   if action=="transition" and not i.get("kind") in ["install","remove","replace","upgrade","repair","destroy","damage"]: return false
   if action=="transition" and not _scene_ready(simulated[i.id].type): return false
   if i.has("state"):
    var r=simulated[i.id]
    if not _state(i.state,i.id,r.socket,r.type): return false
    simulated[i.id].state=i.state.duplicate(true)
   if action=="unmount": simulated.erase(i.id)
  else: return false
 return true
func apply_batch(envelope):
 if faulted: return _fail("Presentation quarantined; owned rebuild required")
 if _busy or not _physical_ready(): return _fail("Assembly physical ownership unavailable or reentrant")
 if not envelope is Dictionary or not (envelope.get("revision") is int or envelope.get("revision") is float) or not (envelope.get("sequence") is int or envelope.get("sequence") is float): return _fail("Missing authoritative envelope")
 var rev=envelope.revision
 var seq=envelope.sequence
 if not is_finite(rev) or not is_finite(seq) or rev<1 or seq<0 or rev>9007199254740991 or seq>9007199254740991 or floor(rev)!=rev or floor(seq)!=seq: return _fail("Invalid authoritative counters")
 if rev<revision or seq<sequence: return _fail("Stale authoritative envelope")
 if rev==revision and not _rebuilding:
  if envelope.get("plan")!=_last_plan:
   var acknowledgement=envelope.get("plan")
   if seq<=sequence or not _preflight(acknowledgement) or not acknowledgement.instructions.is_empty(): return _fail("Conflicting authoritative revision")
   _last_plan=acknowledgement.duplicate(true)
  sequence=seq
  return true
 var plan=envelope.get("plan")
 if not _preflight(plan): return _fail("Unsupported assembly batch")
 _busy=true
 _replacement_ids.clear()
 var batch_epoch=_presentation_epoch
 for i in plan.instructions:
  var applied=_apply(i)
  # Explicit lifecycle removal owns one clear. Any additional clear belongs
  # to a callback and abandons this batch before publishing authority.
  if i.action=="lifecycle" and i.kind=="removed": batch_epoch+=1
  if not applied or batch_epoch!=_presentation_epoch or _exit_cleanup_pending or not _physical_ready():
   _busy=false
   return _quarantine("Native instruction application failed; owned rebuild required")
 # A cancelled fade never overrides latest authoritative destroyed state.
 # Keep an active destruction fade; otherwise remove its cancelled visual now.
 for record in records.values():
  if record.state.get("damageState")=="destroyed" and (not native.transitions.has(allocations[record.id]) or native.transitions[allocations[record.id]].kind!="destroy"):
   if not _drop(allocations[record.id]):
    _busy=false
    return _quarantine("Native destruction cleanup failed; owned rebuild required")
 # Recovery stages the envelope until its outer ownership checks finish.
 # A failure retains the exact previously accepted counters and plan.
 if batch_epoch!=_presentation_epoch or _exit_cleanup_pending or not _physical_ready():
  _busy=false
  return _quarantine("Presentation changed before authority commit")
 if not _rebuilding:
  revision=rev
  sequence=seq
  _last_plan=plan.duplicate(true)
 _busy=false
 last_error=""
 return true
func _drop(slot,release=false):
 if not is_instance_valid(native): return false
 var epoch=_presentation_epoch
 var controller=native
 native.cancel_transition(slot)
 var node=native.component_at(slot)
 if is_instance_valid(node): node.free()
 if epoch!=_presentation_epoch or not is_instance_valid(controller) or native!=controller or _exit_cleanup_pending: return false
 native.mounted.erase(slot)
 for id in pending.keys():
  if allocations.get(id)==slot:
   pending.erase(id)
   allocations.erase(id)
 if release:
  for id in allocations.keys():
   if allocations[id]==slot: allocations.erase(id)
 return true
func _allocate(record):
 if pending.has(record.id):
  if not _drop(allocations[record.id],true): return ""
 if allocations.has(record.id): return allocations[record.id]
 var occupied=allocations.values()
 for slot in socket_slots[record.socket]:
  if slot not in occupied:
   allocations[record.id]=slot
   return slot
 # Only a pending removal in this logical socket may be reclaimed.
 for slot in socket_slots[record.socket]:
  for id in pending.keys():
   if allocations.get(id)==slot:
    if not _drop(slot,true): return ""
    allocations[record.id]=slot
    return slot
 return ""
func _mount(record,operation="install"):
 var epoch=_presentation_epoch
 if not _physical_ready() or not _scene_ready(record.type): return false
 if epoch!=_presentation_epoch or not _physical_ready(): return false
 var slot=_allocate(record)
 if slot.is_empty() or not _drop(slot): return false
 var f=record.frame
 wrappers[slot].transform=Transform2D(Vector2(f[0],f[1]),Vector2(f[2],f[3]),Vector2(f[4],f[5]))
 wrappers[slot].z_index=int(record.layer)
 _mount_context[slot]=record.duplicate(true)
 var result=native.transition(slot,"install",record.type,0.2,"replace" if operation=="replace" else "")
 _mount_context.erase(slot)
 return result and epoch==_presentation_epoch and not _exit_cleanup_pending and is_instance_valid(native) and is_instance_valid(native.component_at(slot))
func _apply(i):
 var action=i.action
 if action=="cancelAll":
  for socket in native.transitions.keys(): native.cancel_transition(socket)
  for r in pending.values():
   if not _drop(allocations[r.id],true): return false
  pending.clear()
 elif action=="mount":
  if not _mount(i,"replace" if _replacement_ids.has(i.id) else "install"): return false
  _replacement_ids.erase(i.id)
  records[i.id]=i.duplicate(true)
 elif action in ["transition","cancel","unmount","update"]:
  var r=records[i.id]
  var slot=allocations[i.id]
  if action=="cancel": native.cancel_transition(slot)
  elif action=="unmount":
   if native.transitions.has(slot) and native.transitions[slot].kind in ["remove","destroy"]: pending[i.id]=r
   elif not _drop(allocations[r.id],true): return false
   records.erase(i.id)
  elif action=="update": r.state=i.state.duplicate(true)
  else:
   if i.has("state"): r.state=i.state.duplicate(true)
   if i.kind=="replace":
    _replacement_ids[i.id]=true
    return true
   if r.state.get("damageState")=="destroyed" and i.kind in ["upgrade","repair","damage"]: return _drop(slot)
   if i.kind=="install":
    if r.state.get("damageState")=="destroyed": return native.transition(slot,"destroy","",0.2)
    return true
   if component_at(i.id)==null and i.kind in ["repair","upgrade","damage"]:
    if not _mount(r): return false
   if component_at(i.id)!=null: return native.transition(slot,i.kind,r.type if i.kind=="upgrade" else "",0.2)
 elif action=="lifecycle":
  if i.kind=="removed": clear_assembly()
  set_meta("assembly_lifecycle",i.kind)
 elif action=="visualMode": set_meta("assembly_visual_mode",i.mode)
 return true
func advance(delta):
 if faulted or _busy or not _physical_ready(): return false
 _busy=true
 var epoch=_presentation_epoch
 var result=native.advance(delta)
 if epoch!=_presentation_epoch or _exit_cleanup_pending or not is_instance_valid(native):
  _busy=false
  return false
 for id in pending.keys():
  if native.component_at(allocations[id])==null:
   allocations.erase(id)
   pending.erase(id)
 _busy=false
 return result
func _process(delta): advance(delta)
func clear_assembly():
 _presentation_epoch+=1
 _mount_context.clear()
 _replacement_ids.clear()
 if is_instance_valid(native): native.clear_components()
 records.clear()
 pending.clear()
 allocations.clear()
 if _exit_cleanup_pending and not _busy:
  _exit_cleanup_pending=false
  if is_instance_valid(native): native.queue_free()
  for wrapper in wrappers.values():
   if is_instance_valid(wrapper) and wrapper.get_child_count()==0: wrapper.queue_free()
  wrappers.clear()
  socket_slots.clear()
  slot_logical.clear()
func _exit_tree():
 # A descendant mount callback may remove the root during add_child. Do not
 # free that busy wrapper; transport finalization completes owned teardown.
 _exit_cleanup_pending=true
 set_process(false)
 if not _busy: clear_assembly()



# Internal presentation-only reset. Authority counters and controller identity
# survive; only positively tracked native nodes are replaced.
func _rebuild_owned(envelope):
 if not faulted or _busy or not _physical_ready(): return _fail("Rebuild ownership unavailable")
 if native.get_child_count()!=0: return _fail("Unowned native controller children")
 var foreign=[]
 for slot in wrappers:
  var socket=slot_logical[slot]
  var wrapper=wrappers[slot]
  for child in wrapper.get_children():
   if child in native.mounted.values(): continue
   if not child is Node2D or child.is_queued_for_deletion(): return _fail("Uncertain wrapper child ownership")
   foreign.append({"node":child,"original_wrapper":wrapper,"original_wrapper_transform":wrapper.global_transform,"mount":sockets[socket].node,"transform":child.global_transform,"mount_parent":sockets[socket].node.get_parent(),"mount_transform":sockets[socket].node.global_transform})
 # Every foreign child was checked before any mutation.
 _busy=true
 var preserved=[]
 for index in range(foreign.size()):
  var item=foreign[index]
  if not _foreign_pending_ready(foreign.slice(index)):
   _busy=false
   return _quarantine("Foreign child changed during rebuild")
  item.node.reparent(item.mount,true)
  if not _foreign_rebuild_ready([item],false) or not _foreign_pending_ready(foreign.slice(index+1)):
   _busy=false
   return _quarantine("Foreign child removed during rebuild")
  item.node.global_transform=item.transform
  preserved.append(item)
  if not _foreign_rebuild_ready(preserved):
   _busy=false
   return _quarantine("Foreign ownership changed during rebuild")
  if _exit_cleanup_pending:
   _busy=false
   return _quarantine("Chassis exited during rebuild")
 clear_assembly()
 # Synchronous host callbacks may have inserted nodes during cleanup/reparent.
 # Refuse instead of extending ownership to those newly introduced children.
 if native.get_child_count()!=0:
  _busy=false
  return _quarantine("Native ownership changed during rebuild")
 for wrapper in wrappers.values():
  if not is_instance_valid(wrapper) or wrapper.get_child_count()!=0:
   _busy=false
   return _quarantine("Wrapper ownership changed during rebuild")
 # Detach every tracked node first: exit callbacks run before any free, and
 # may populate this or a later wrapper. Never recursively free uncertain nodes.
 var retiring=[native]
 retiring.append_array(wrappers.values())
 for node in retiring:
  if not is_instance_valid(node) or node.is_queued_for_deletion():
   _busy=false
   return _quarantine("Retiring presentation ownership changed")
  if node.get_parent()!=null: node.get_parent().remove_child(node)
 for node in retiring:
  if not is_instance_valid(node) or node.get_parent()!=null or node.is_inside_tree() or node.is_queued_for_deletion() or node.get_child_count()!=0:
   _busy=false
   return _quarantine("Retiring presentation acquired foreign ownership")
 if not _foreign_rebuild_ready(foreign):
  _busy=false
  return _quarantine("Foreign ownership changed during teardown")
 for node in retiring: node.free()
 native=null
 wrappers.clear()
 socket_slots.clear()
 slot_logical.clear()
 _busy=false
 if not configure(instance_id,sockets,descriptors): return _quarantine("Rebuild configuration failed")
 if not _foreign_rebuild_ready(foreign): return _quarantine("Foreign ownership changed during configuration")
 faulted=false
 _rebuilding=true
 var applied=apply_batch(envelope)
 _rebuilding=false
 if not applied: return _quarantine("Rebuild application failed")
 if not _foreign_rebuild_ready(foreign): return _quarantine("Foreign ownership changed during application")
 revision=envelope.revision
 sequence=envelope.sequence
 _last_plan=envelope.plan.duplicate(true)
 set_process(true)
 return true

func _foreign_rebuild_ready(items,check_transform=true):
 if not is_instance_valid(_chassis) or _chassis.is_queued_for_deletion() or get_parent()!=_chassis or _exit_cleanup_pending: return false
 for item in items:
  if not is_instance_valid(item.node) or item.node.is_queued_for_deletion() or not is_instance_valid(item.mount) or item.mount.is_queued_for_deletion(): return false
  if item.node.get_parent()!=item.mount or item.mount.get_parent()!=item.mount_parent or not _chassis.is_ancestor_of(item.mount): return false
  if not item.mount.global_transform.is_equal_approx(item.mount_transform): return false
  if check_transform and not item.node.global_transform.is_equal_approx(item.transform): return false
 return true

# Unprocessed foreign nodes must still occupy the exact wrapper observed before
# any callbacks ran. A callback moving a later child revokes our presentation
# ownership; never take that child back from its new host location.
func _foreign_pending_ready(items):
 if not is_instance_valid(_chassis) or _chassis.is_queued_for_deletion() or get_parent()!=_chassis or _exit_cleanup_pending: return false
 for item in items:
  if not is_instance_valid(item.node) or item.node.is_queued_for_deletion() or not is_instance_valid(item.original_wrapper) or item.original_wrapper.is_queued_for_deletion(): return false
  if not is_instance_valid(item.mount) or item.mount.is_queued_for_deletion() or item.mount.get_parent()!=item.mount_parent or not _chassis.is_ancestor_of(item.mount): return false
  if item.node.get_parent()!=item.original_wrapper or item.original_wrapper.get_parent()!=item.mount: return false
  if not item.mount.global_transform.is_equal_approx(item.mount_transform) or not item.original_wrapper.global_transform.is_equal_approx(item.original_wrapper_transform) or not item.node.global_transform.is_equal_approx(item.transform): return false
 return true
