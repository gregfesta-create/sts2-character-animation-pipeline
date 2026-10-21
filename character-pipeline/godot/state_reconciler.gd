extends RefCounted
# Pure authoritative message reconciler. No scene nodes, planner, game counters or gameplay mutation.
# configure is one-time per owner. Methods return lib/state.js results, or
# {error:"INVALID_STATE",state:<unchanged copy>} instead of throwing a JS exception.
var _configured=false
var _instance=""
var _sockets={}
var _state={}
var _required_sequence=0
var _required_revision=0
var _needs_snapshot=true
var _disposed=false
var _recovery_full_snapshot=false
func _fields(value, keys):
 if not value is Dictionary or value.size()!=keys.size(): return false
 for key in keys:
  if not value.has(key): return false
 return true
func _id(value):
 return value is String and value.length()<=64 and RegEx.create_from_string("^[A-Za-z][A-Za-z0-9_-]{0,63}$").search(value)!=null
func _integer(value, minimum=0, maximum=9007199254740991):
 return (value is int or value is float) and is_finite(value) and value>=minimum and value<=maximum and floor(value)==value
func _lifecycle(value): return value in ["alive","dead","removed"]
func configure(config):
 if _configured or not _fields(config,["instanceId","sockets"]) or not _id(config.instanceId) or not config.sockets is Array or config.sockets.size()>256: return false
 var sockets={}
 for socket in config.sockets:
  if not _fields(socket,["id","capacity","types"]) or not _id(socket.id) or sockets.has(socket.id) or not _integer(socket.capacity,1,64) or not socket.types is Array or socket.types.is_empty() or socket.types.size()>64: return false
  var types={}
  for type in socket.types:
   if not _id(type) or types.has(type): return false
   types[type]=true
  sockets[socket.id]=socket.duplicate(true)
 _sockets=sockets
 _instance=config.instanceId
 _state={"version":1,"instanceId":_instance,"sequence":null,"revision":null,"lifecycle":"alive","visualMode":"idle","components":[]}
 _configured=true
 return true
# Caller owns the transaction: mutate this independent candidate, then retain it
# only after downstream planning/application succeeds. No message history replay.
func fork():
 if not _configured: return null
 var candidate=get_script().new()
 candidate._configured=true
 candidate._instance=_instance
 candidate._sockets=_sockets.duplicate(true)
 candidate._state=_state.duplicate(true)
 candidate._required_sequence=_required_sequence
 candidate._required_revision=_required_revision
 candidate._needs_snapshot=_needs_snapshot
 candidate._disposed=_disposed
 candidate._recovery_full_snapshot=_recovery_full_snapshot
 return candidate
# A recovery validation fork preserves all authoritative constraints and gap
# watermarks, but requires a full snapshot even at the already observed sequence.
# This is validation only; it never resets the live owner or fabricates counters.
func recovery_fork():
 if not _configured or _disposed: return null
 var candidate=fork()
 candidate._needs_snapshot=true
 candidate._recovery_full_snapshot=true
 if _state.sequence!=null: candidate._required_sequence=max(candidate._required_sequence,_state.sequence)
 if _state.revision!=null: candidate._required_revision=max(candidate._required_revision,_state.revision)
 return candidate
func get_state(): return _state.duplicate(true)
func _invalid(): return {"error":"INVALID_STATE","state":get_state()}
func _result(status): return {"status":status,"requestSnapshot":_needs_snapshot and not _disposed and _state.lifecycle!="removed","state":get_state()}
func _component(value):
 if not _fields(value,["id","socket","type","revision","damageState","upgrade","visualMode"]): return false
 for key in ["id","socket","type","damageState","visualMode"]:
  if not _id(value[key]): return false
 return _integer(value.revision,1) and _integer(value.upgrade,0,1000000) and _sockets.has(value.socket) and value.type in _sockets[value.socket].types
func _occupancy(components):
 if not components is Array or components.size()>4096: return false
 var ids={}
 var counts={}
 for value in components:
  if not _component(value): return false
  var count=counts.get(value.socket,0)+1
  if ids.has(value.id) or count>_sockets[value.socket].capacity: return false
  ids[value.id]=true
  counts[value.socket]=count
 return true
func _envelope(message,keys):
 return _configured and _fields(message,keys) and _integer(message.version,1,1) and message.instanceId==_instance and _integer(message.sequence) and _integer(message.revision,1)
func _previous(id):
 for component in _state.components:
  if component.id==id: return component
 return null
func _same_component(value,previous):
 # JS has one Number type; Godot Dictionary equality distinguishes int/float.
 # Validated component fields are scalars, so compare their numeric values.
 for key in previous:
  if value[key]!=previous[key]: return false
 return true
func _retained(value,previous):
 return value.revision>=previous.revision and (value.revision!=previous.revision or _same_component(value,previous))
func _global(next):
 if next.revision!=_state.revision: return true
 if next.lifecycle!=_state.lifecycle or next.visualMode!=_state.visualMode or next.components.size()!=_state.components.size(): return false
 for value in next.components:
  var previous=_previous(value.id)
  if previous==null or not _same_component(value,previous): return false
 return true
func snapshot(message):
 if not _envelope(message,["version","instanceId","sequence","revision","lifecycle","visualMode","components"]) or not _lifecycle(message.lifecycle) or not _id(message.visualMode) or not _occupancy(message.components): return _invalid()
 if message.lifecycle=="removed" and not message.components.is_empty(): return _invalid()
 if _disposed: return _result("disposed")
 if _state.lifecycle=="removed":
  if not _recovery_full_snapshot: return _result("removed")
  if message.lifecycle!="removed": return _invalid()
 if _state.sequence!=null and (message.sequence<_state.sequence or message.revision<_state.revision): return _result("ignored")
 if message.sequence<_required_sequence or message.revision<_required_revision: return _result("blocked")
 if not _needs_snapshot and message.sequence==_state.sequence: return _result("ignored")
 for value in message.components:
  var previous=_previous(value.id)
  if previous!=null and not _retained(value,previous): return _invalid()
 if not _global(message): return _invalid()
 _state=message.duplicate(true)
 _needs_snapshot=false
 _recovery_full_snapshot=false
 return _result("applied")
func event(message):
 if not _envelope(message,["version","instanceId","sequence","revision","type","payload"]): return _invalid()
 var type=message.type
 var payload=message.payload
 if type=="upsert":
  if not _component(payload): return _invalid()
 elif type=="remove":
  if not _fields(payload,["id"]) or not _id(payload.id): return _invalid()
 elif type=="lifecycle":
  if not _fields(payload,["lifecycle"]) or not _lifecycle(payload.lifecycle): return _invalid()
 elif type=="visualMode":
  if not _fields(payload,["visualMode"]) or not _id(payload.visualMode): return _invalid()
 else: return _invalid()
 if _disposed: return _result("disposed")
 if _state.lifecycle=="removed": return _result("removed")
 if _state.sequence!=null and (message.sequence<=_state.sequence or message.revision<_state.revision): return _result("ignored")
 if _needs_snapshot or message.sequence!=_state.sequence+1:
  _needs_snapshot=true
  _required_sequence=max(_required_sequence,message.sequence)
  _required_revision=max(_required_revision,message.revision)
  return _result("blocked")
 var next=get_state()
 if type=="upsert":
  var index=-1
  for i in next.components.size():
   if next.components[i].id==payload.id: index=i;break
  if index>=0:
   if not _retained(payload,next.components[index]): return _invalid()
   next.components[index]=payload.duplicate(true)
  else: next.components.append(payload.duplicate(true))
  if not _occupancy(next.components): return _invalid()
 elif type=="remove":
  var index=-1
  for i in next.components.size():
   if next.components[i].id==payload.id: index=i;break
  if index<0: return _invalid()
  next.components.remove_at(index)
 elif type=="lifecycle":
  next.lifecycle=payload.lifecycle
  if payload.lifecycle=="removed": next.components=[]
 else: next.visualMode=payload.visualMode
 next.sequence=message.sequence
 next.revision=message.revision
 if not _global(next): return _invalid()
 _state=next
 return _result("applied")
func teardown():
 if not _configured: return _invalid()
 _disposed=true
 _state.lifecycle="removed"
 _state.components=[]
 return _result("disposed")
