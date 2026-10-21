extends RefCounted
# Trusted root-only bridge. No game subscriptions, counter synthesis or preview reset.
# Incoming messages contain state only; registry and scenes are application-owned.
signal snapshot_required(owner, minimum_sequence, minimum_revision)
signal rebuild_required(owner)
static var _owners={}
var last_error=""
var _assembly
var _planner
var _registry={}
var _socket_map={}
var _descriptor_map={}
var _reconciler
var _configured=false
var _bound=false
var _disposed=false
var _owner=""
var _last_request=[]
var _busy=false
var _needs_rebuild=false
var _recovery_baseline
var _dispose_pending=false
var _binding=false
var _rebuild_attempts=0
func _fail(message):
 last_error=message
 return false
func _names(a,b):
 if not a is Array or not b is Array: return false
 for value in b:
  if not value is String: return false
 var first=a.duplicate()
 var second=b.duplicate()
 first.sort()
 second.sort()
 return first==second
func _full(value): return value=={"position":true,"rotation":true,"scale":true}
func _capacity(value): return (value is int or value is float) and is_finite(float(value)) and value==floor(value) and value>=1 and value<=64
func _fresh(assembly):
 return is_instance_valid(assembly) and assembly is Node and assembly.get_parent() is Node2D and assembly.has_method("apply_batch") and assembly.has_method("_preflight") and assembly.native==null and assembly.revision==-1 and assembly.sequence==-1 and assembly.records.is_empty() and assembly.pending.is_empty() and assembly.wrappers.is_empty()
func configure_trusted(assembly,planner_registry,socket_map,descriptor_map):
 if _configured or _disposed or not _fresh(assembly) or not socket_map is Dictionary or not descriptor_map is Dictionary: return _fail("Fresh unconfigured root assembly required")
 var planner=load("res://assembly_planner.gd").new()
 if not planner.configure(planner_registry): return _fail("Invalid trusted planner registry")
 if planner_registry.sockets.size()>64 or socket_map.size()!=planner_registry.sockets.size() or descriptor_map.size()!=planner_registry.descriptors.size(): return _fail("Native registry capacity or membership mismatch")
 var nodes={}
 var capacity_total=0
 for s in planner_registry.sockets:
  var native=socket_map.get(s.id)
  if not _capacity(s.capacity) or not _full(s.inheritance) or not native is Dictionary or not _capacity(native.get("capacity")) or native.capacity!=s.capacity or not _full(native.get("inheritance")) or not _names(s.types,native.get("types")): return _fail("Unsupported native socket contract")
  capacity_total+=int(s.capacity)
  if capacity_total>64: return _fail("Native registry aggregate capacity exceeded")
  var node=native.get("node")
  if not is_instance_valid(node) or not node is Node2D or node==assembly.get_parent() or not assembly.get_parent().is_ancestor_of(node) or nodes.has(node.get_instance_id()): return _fail("Mount must be uniquely owned by root chassis")
  nodes[node.get_instance_id()]=true
 for d in planner_registry.descriptors:
  var native=descriptor_map.get(d.type)
  if not native is Dictionary or native.get("spec")!=d.spec or not _names(d.eventNames,native.get("events",[])) or not native.get("scene") is PackedScene: return _fail("Descriptor source/event/scene mismatch")
  var candidate=native.scene.instantiate()
  var valid=candidate is Node2D
  if candidate!=null: candidate.free()
  if not valid: return _fail("Component root must be Node2D")
 _assembly=assembly
 _planner=planner
 _registry=planner_registry.duplicate(true)
 _socket_map=socket_map.duplicate(true)
 _descriptor_map=descriptor_map.duplicate(true)
 _configured=true
 return true
func bind_authoritative(owner):
 if not _configured or _bound or _binding or _disposed or not owner is String or not _fresh(_assembly): return _fail("Transport cannot bind or rebind")
 if _owners.has(owner):
  if _owners[owner].get_ref()!=null: return _fail("Authoritative owner already bound")
  _owners.erase(owner)
 var reconciler=load("res://state_reconciler.gd").new()
 var sockets=[]
 for s in _registry.sockets: sockets.append({"id":s.id,"capacity":s.capacity,"types":s.types.duplicate()})
 if not reconciler.configure({"instanceId":owner,"sockets":sockets}): return _fail("Invalid authoritative owner")
 _owner=owner
 _reconciler=reconciler
 _owners[owner]=weakref(self)
 _binding=true
 var accepted=_assembly.configure(owner,_socket_map,_descriptor_map)
 _binding=false
 if not accepted or _disposed:
  if is_instance_valid(_assembly): _assembly.clear_assembly()
  if _owners.has(owner) and _owners[owner].get_ref()==self: _owners.erase(owner)
  _dispose_pending=false
  return _fail("Native binding rejected or cancelled")
 _bound=true
 return true
func get_state(): return _reconciler.get_state() if _bound else {}
func _error(code): return {"error":code,"state":get_state()}
# Rebuild requires a host-supplied genuine snapshot. Quarantine never fabricates
# a rollback, rebinds the owner, or commits unpresented authority.
func _rebuild_result(code):
 var result={"error":code,"needsPresentationRebuild":true,"state":get_state()}
 if not _needs_rebuild:
  _needs_rebuild=true
  rebuild_required.emit(_owner)
 if _disposed: return _reconciler.teardown()
 return result
# A busy disposal acknowledges terminal closure immediately and guarantees
# final teardown before the in-flight receive returns. No candidate may commit.
func _pending_disposal_result():
 return {"status":"disposal_pending","completionGuaranteed":true,"requestSnapshot":false,"state":get_state()}
func _complete_disposal():
 _disposed=true
 _dispose_pending=false
 var result=_reconciler.teardown()
 if is_instance_valid(_assembly): _assembly.clear_assembly()
 if _owners.has(_owner) and _owners[_owner].get_ref()==self: _owners.erase(_owner)
 return result
func _finish_receive(result,candidate=null,commit=false):
 if _dispose_pending:
  _busy=false
  return _complete_disposal()
 if commit: _reconciler=candidate
 _busy=false
 if result.get("requestSnapshot",false):
  var request=[_owner,candidate._required_sequence,candidate._required_revision]
  if request!=_last_request:
   _last_request=request
   snapshot_required.emit(request[0],request[1],request[2])
 if _disposed: return _reconciler.teardown()
 return result
# While presentation is quarantined, only this private baseline observes valid
# authority messages. get_state() deliberately remains the last state whose
# presentation application succeeded. No history replay or physical rebuild.
func _floors(baseline):
 var state=baseline.get_state()
 return {"sequence":max(baseline._required_sequence,0 if state.sequence==null else state.sequence),"revision":max(baseline._required_revision,0 if state.revision==null else state.revision)}
func _observe_fault(method,message):
 if _recovery_baseline==null: _recovery_baseline=_reconciler.fork()
 var candidate=_recovery_baseline.recovery_fork() if method=="snapshot" else _recovery_baseline.fork()
 var observed=candidate.call(method,message)
 if not observed.has("error"):
  if observed.status!="applied" or not _planner.bootstrap(observed.state).has("error"):
   if observed.status in ["applied","blocked"]: _recovery_baseline=candidate
 # Retain candidate BEFORE the first synchronous rebuild signal. Its handler
 # may immediately deliver newer authority; never overwrite that newer baseline
 # after returning from the handler.
 # Keep the established strict receive error schema consumed by the C# host.
 # Recovery floors/evidence are returned only by prepare_rebuild_snapshot.
 return _rebuild_result("PRESENTATION_FAULTED")
# Prepare copied validation evidence for a later bounded host rebuild. Preparing
# does not commit authority, lower floors, release ownership or touch scene nodes.
func prepare_rebuild_snapshot(snapshot):
 if _disposed: return _error("DISPOSED_TRANSPORT")
 if not _bound: return _error("UNBOUND_TRANSPORT")
 if _busy: return _error("TRANSPORT_BUSY")
 if not _needs_rebuild or _recovery_baseline==null: return _error("PRESENTATION_NOT_FAULTED")
 var candidate=_recovery_baseline.recovery_fork()
 var result=candidate.snapshot(snapshot)
 if result.has("error"): return _error(result.error)
 if result.status!="applied": return _error("STALE_RECOVERY_SNAPSHOT")
 if _planner.bootstrap(result.state).has("error"): return _error("INVALID_COMPONENT")
 var baseline=_recovery_baseline.get_state()
 var accepted=get_state()
 return {"status":"prepared","snapshot":result.state.duplicate(true),"floors":_floors(_recovery_baseline),"evidence":{"baselineSequence":baseline.sequence,"baselineRevision":baseline.revision,"acceptedSequence":accepted.sequence,"acceptedRevision":accepted.revision}}
func _receive(method,message):
 if not _bound: return _error("UNBOUND_TRANSPORT")
 if _dispose_pending: return _pending_disposal_result()
 if _busy: return _error("TRANSPORT_BUSY")
 if not _disposed and is_instance_valid(_assembly) and _assembly.faulted: return _observe_fault(method,message)
 _busy=true
 var candidate=_reconciler.fork()
 var result=candidate.call(method,message)
 if result.has("error"): return _finish_receive(result)
 if result.status=="applied":
  var before=_reconciler.get_state()
  var plan=_planner.bootstrap(result.state) if before.revision==null else _planner.plan(before,result.state)
  if plan.has("error"): return _finish_receive(_error("INVALID_COMPONENT"))
  var applied=is_instance_valid(_assembly) and _assembly.apply_batch({"revision":result.state.revision,"sequence":result.state.sequence,"plan":plan})
  if _dispose_pending: return _finish_receive(result)
  if not applied:
   _busy=false
   if is_instance_valid(_assembly) and _assembly.faulted:
    _recovery_baseline=candidate
    return _rebuild_result("ASSEMBLY_REJECTED")
   return _error("ASSEMBLY_REJECTED")
 return _finish_receive(result,candidate,true)
func receive_snapshot(message): return _receive("snapshot",message)
func receive_event(message): return _receive("event",message)
func dispose():
 if _binding:
  _disposed=true
  _dispose_pending=true
  return _pending_disposal_result()
 if not _bound:
  _disposed=true
  return _error("UNBOUND_TRANSPORT")
 if _busy:
  _dispose_pending=true
  _disposed=true
  return _pending_disposal_result()
 return _complete_disposal()


# Bounded presentation recovery keeps the same owner and reconciler history.
# A rejected snapshot never spends a physical attempt; the budget is lifetime.
func rebuild_from_snapshot(snapshot):
 var prepared=prepare_rebuild_snapshot(snapshot)
 if prepared.has("error"): return prepared
 if _rebuild_attempts>=3: return _error("REBUILD_LIMIT_REACHED")
 var candidate=_recovery_baseline.recovery_fork()
 var result=candidate.snapshot(snapshot)
 var plan=_planner.bootstrap(result.state)
 _busy=true
 _rebuild_attempts+=1
 # Even a physical failure must retain this validated newer authority floor.
 _recovery_baseline=candidate
 var applied=is_instance_valid(_assembly) and _assembly._rebuild_owned({"revision":result.state.revision,"sequence":result.state.sequence,"plan":plan})
 if _dispose_pending: return _finish_receive(result)
 if not applied:
  _busy=false
  return _error("REBUILD_FAILED")
 _needs_rebuild=false
 _recovery_baseline=null
 _last_request=[]
 return _finish_receive(result,candidate,true)
