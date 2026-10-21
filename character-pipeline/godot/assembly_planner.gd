extends RefCounted
# Pure lib/components.js planner. Frames remain six scalar doubles until the
# scene consumer explicitly applies its supported native subset.
var last_error=""
var _configured=false
var _config={}
var _sockets={}
var _descriptors={}
static func valid_transition_profiles(value):
 if not value is Dictionary or value.size()>8: return false
 for operation in value:
  if operation not in ["install","remove","replace","upgrade","repair","destroy","damage","visual"]: return false
  var profile=value[operation]
  if not profile is Dictionary or profile.size()!=2 or not profile.has("duration") or not profile.has("phases"): return false
  var duration=profile.duration
  if not (duration is int or duration is float) or not is_finite(duration) or duration<0 or duration>10: return false
  if not profile.phases is Array or profile.phases.size()>16: return false
  var seen={}
  var last=0.0
  for phase in profile.phases:
   if not phase is Dictionary or not phase.has("id") or not phase.has("time") or phase.size()!=(3 if phase.has("clip") else 2): return false
   if not phase.id is String or RegEx.create_from_string("^[A-Za-z][A-Za-z0-9_-]{0,63}$").search(phase.id)==null or seen.has(phase.id): return false
   if not (phase.time is int or phase.time is float) or not is_finite(phase.time) or phase.time<last or phase.time>duration: return false
   if phase.has("clip") and (not phase.clip is String or RegEx.create_from_string("^[A-Za-z][A-Za-z0-9_-]{0,63}$").search(phase.clip)==null): return false
   seen[phase.id]=true
   last=phase.time
 return true
func _fail(message):
 last_error=message
 return {"error":"INVALID_COMPONENT"}
func _data(value,depth,budget):
 budget[0]-=1
 if budget[0]<0 or depth>16: return false
 if value==null or value is bool: return true
 if value is String: return value.length()<=4096
 if value is int or value is float: return is_finite(value)
 if value is Array:
  if value.size()>10000: return false
  for item in value:
   if not _data(item,depth+1,budget): return false
  return true
 if value is Dictionary:
  if value.size()>10001: return false
  for key in value:
   if not key is String or key in ["__proto__","constructor","prototype"] or not _data(value[key],depth+1,budget): return false
  return true
 return false
func _fields(value,keys):
 if not value is Dictionary or value.size()!=keys.size(): return false
 for key in keys:
  if not value.has(key): return false
 return true
func _id(value): return value is String and RegEx.create_from_string("^[A-Za-z][A-Za-z0-9_-]{0,63}$").search(value)!=null
func _integer(value,minimum,maximum): return (value is int or value is float) and is_finite(value) and value>=minimum and value<=maximum and floor(value)==value
func _list(value,maximum=256): return value is Array and value.size()<=maximum
func _names(value):
 if not _list(value): return false
 var seen={}
 for item in value:
  if not _id(item) or seen.has(item): return false
  seen[item]=true
 return true
func _pair(value,positive=false):
 if not value is Array or value.size()!=2: return false
 for n in value:
  if not (n is int or n is float) or not is_finite(n) or abs(n)>1000000 or (positive and n<=0): return false
 return true
func _inheritance(value):
 if not _fields(value,["position","rotation","scale"]): return false
 for v in value.values():
  if not v is bool: return false
 return true
func _transform(value):
 return _fields(value,["position","rotation","scale"]) and _pair(value.position) and _pair(value.scale) and value.scale[0]!=0 and value.scale[1]!=0 and (value.rotation is int or value.rotation is float) and is_finite(value.rotation) and abs(value.rotation)<=1000000
func _hash(value): return value is String and RegEx.create_from_string("^[a-f0-9]{64}$").search(value)!=null
func _matrix(t):
 var c=cos(t.rotation)
 var s=sin(t.rotation)
 return [c*t.scale[0],s*t.scale[0],-s*t.scale[1],c*t.scale[1],t.position[0],t.position[1]]
func _attachment(socket,mount):
 var t=_matrix(mount)
 var a=t[0]
 var b=t[1]
 var c=t[2]
 var d=t[3]
 var x=t[4]
 var y=t[5]
 var det=a*d-b*c
 # JS division by zero produces infinities/NaN, rejected by its frame bound.
 if det==0: return null
 var n=[d/det,-b/det,-c/det,a/det,(c*y-d*x)/det,(b*x-a*y)/det]
 var m=_matrix(socket)
 var result=[m[0]*n[0]+m[2]*n[1],m[1]*n[0]+m[3]*n[1],m[0]*n[2]+m[2]*n[3],m[1]*n[2]+m[3]*n[3],m[0]*n[4]+m[2]*n[5]+m[4],m[1]*n[4]+m[3]*n[5]+m[5]]
 for i in result.size():
  if not is_finite(result[i]) or abs(result[i])>1000000: return null
  if result[i]==0: result[i]=0.0
 return result
func configure(input):
 if _configured: last_error="Planner already configured"; return false
 if not _data(input,0,[100000]) or not _fields(input,["sockets","descriptors","styleHash","eventNames"]): last_error="Invalid planner data"; return false
 if not _hash(input.styleHash) or not _names(input.eventNames) or not _list(input.sockets) or not _list(input.descriptors): last_error="Invalid registry"; return false
 var sockets={}
 var descriptors={}
 for s in input.sockets:
  if not _fields(s,["id","bone","transform","types","capacity","inheritance","layer","envelope"]): last_error="Invalid socket fields"; return false
  if not _id(s.id) or not _id(s.bone) or not _transform(s.transform) or not _names(s.types) or s.types.is_empty() or s.types.size()>64 or sockets.has(s.id) or not _integer(s.capacity,1,64) or not _integer(s.layer,-4096,4096) or not _inheritance(s.inheritance) or not _pair(s.envelope,true): last_error="Invalid socket contract"; return false
  sockets[s.id]=s
 for d in input.descriptors:
  var descriptor_fields=["version","type","spec","mount","dimensions","styleHash","eventNames","layer","inheritance"]
  if d is Dictionary and d.has("transitions"): descriptor_fields.append("transitions")
  if not _fields(d,descriptor_fields): last_error="Invalid descriptor fields"; return false
  if d.has("transitions") and not valid_transition_profiles(d.transitions): last_error="Invalid transition profiles"; return false
  if not _integer(d.version,1,1) or not _id(d.type) or descriptors.has(d.type) or not d.spec is String or RegEx.create_from_string("^([A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+\\.json$").search(d.spec)==null or not _transform(d.mount) or not _pair(d.dimensions,true) or not _hash(d.styleHash) or not _names(d.eventNames) or not _integer(d.layer,-4096,4096) or not _inheritance(d.inheritance): last_error="Invalid descriptor contract"; return false
  if d.styleHash!=input.styleHash: last_error="Incompatible style"; return false
  for event in d.eventNames:
   if event not in input.eventNames: last_error="Incompatible events"; return false
  for i in 2:
   if d.mount.position[i]<0 or d.mount.position[i]>d.dimensions[i]: last_error="Mount pivot outside dimensions"; return false
  var compatible=false
  for s in sockets.values():
   if d.type not in s.types: continue
   if d.layer!=s.layer or d.inheritance!=s.inheritance: last_error="Incompatible layer or inheritance"; return false
   var c=abs(cos(d.mount.rotation))
   var sn=abs(sin(d.mount.rotation))
   var w=d.dimensions[0]
   var h=d.dimensions[1]
   if (c*w+sn*h)/abs(d.mount.scale[0])>s.envelope[0]+1e-9 or (sn*w+c*h)/abs(d.mount.scale[1])>s.envelope[1]+1e-9 or _attachment(s.transform,d.mount)==null: last_error="Unbounded or oversized component"; return false
   compatible=true
  if not compatible: last_error="Descriptor has no compatible socket"; return false
  descriptors[d.type]=d
 _config=input.duplicate(true)
 _sockets=sockets.duplicate(true)
 _descriptors=descriptors.duplicate(true)
 _configured=true
 last_error=""
 return true
func _validate(state):
 if not _configured or not _data(state,0,[100000]) or not state is Dictionary or not state.has("instanceId"): return false
 var registry=[]
 for s in _config.sockets: registry.append({"id":s.id,"types":s.types,"capacity":s.capacity})
 var r=load("res://state_reconciler.gd").new()
 if not r.configure({"instanceId":state.instanceId,"sockets":registry}) or r.snapshot(state).has("error"): return false
 var mounts={}
 for component in state.components:
  if not _descriptors.has(component.type) or component.damageState not in ["intact","damaged","destroyed"]: return false
  # Each type's attachment is deterministic. Compare numeric arrays directly;
  # JS's socket+frame string key only detects equal frames within one socket.
  var frame=_attachment(_sockets[component.socket].transform,_descriptors[component.type].mount)
  for previous in mounts.get(component.socket,[]):
   if previous==frame: return false
  if not mounts.has(component.socket): mounts[component.socket]=[]
  mounts[component.socket].append(frame)
 return true
func _mount(component):
 var d=_descriptors[component.type]
 var s=_sockets[component.socket]
 return {"action":"mount","id":component.id,"socket":component.socket,"type":component.type,"spec":d.spec,"frame":_attachment(s.transform,d.mount),"layer":s.layer,"inheritance":s.inheritance.duplicate(true),"state":component.duplicate(true)}
func _lifecycle(value): return "death" if value=="dead" else "revive" if value=="alive" else "removed"
func _output(state,instructions):
 last_error=""
 return {"version":1,"instanceId":state.instanceId,"preserveChassis":true,"instructions":instructions}
func bootstrap(snapshot):
 if not _validate(snapshot): return _fail("Invalid authoritative state")
 var state=snapshot.duplicate(true)
 var instructions=[]
 for component in state.components:
  instructions.append(_mount(component))
  instructions.append({"action":"transition","id":component.id,"kind":"install","state":component.duplicate(true)})
 instructions.append({"action":"lifecycle","kind":_lifecycle(state.lifecycle)})
 instructions.append({"action":"visualMode","mode":state.visualMode})
 return _output(state,instructions)
func _changed(a,b):
 for key in a:
  if a[key]!=b[key]: return true
 return false
func plan(previous,next):
 if not _validate(previous) or not _validate(next): return _fail("Invalid authoritative state")
 var before=previous.duplicate(true)
 var after=next.duplicate(true)
 if before.instanceId!=after.instanceId or after.revision<before.revision or after.sequence<before.sequence or (before.lifecycle=="removed" and after.lifecycle!="removed"): return _fail("Invalid authoritative progression")
 var old={}
 var current={}
 for c in before.components: old[c.id]=c
 for c in after.components: current[c.id]=c
 var equivalent_state=before.lifecycle==after.lifecycle and before.visualMode==after.visualMode and old.size()==current.size()
 for c in after.components:
  if not old.has(c.id) or _changed(old[c.id],c): equivalent_state=false
 if after.revision==before.revision and not equivalent_state: return _fail("Conflicting authoritative revision")
 var instructions=[]
 if before.lifecycle!=after.lifecycle: instructions.append({"action":"cancelAll"})
 for a in before.components:
  var b=current.get(a.id)
  var replace=b!=null and (a.type!=b.type or a.socket!=b.socket)
  if b!=null and (b.revision<a.revision or (b.revision==a.revision and _changed(a,b))): return _fail("Conflicting component revision")
  if b==null or replace:
   instructions.append({"action":"cancel","id":a.id})
   instructions.append({"action":"transition","id":a.id,"kind":"replace" if replace else "destroy" if a.damageState=="destroyed" else "remove"})
   instructions.append({"action":"unmount","id":a.id})
 for b in after.components:
  var a=old.get(b.id)
  var fresh=a==null or a.type!=b.type or a.socket!=b.socket
  if fresh:
   instructions.append(_mount(b))
   instructions.append({"action":"transition","id":b.id,"kind":"install","state":b.duplicate(true)})
  elif _changed(a,b):
   instructions.append({"action":"cancel","id":b.id})
   if a.upgrade!=b.upgrade: instructions.append({"action":"transition","id":b.id,"kind":"upgrade","state":b.duplicate(true)})
   if a.damageState!=b.damageState: instructions.append({"action":"transition","id":b.id,"kind":"destroy" if b.damageState=="destroyed" else "repair" if b.damageState=="intact" else "damage","state":b.duplicate(true)})
   if a.visualMode!=b.visualMode or a.revision!=b.revision: instructions.append({"action":"update","id":b.id,"state":b.duplicate(true)})
 if before.lifecycle!=after.lifecycle: instructions.append({"action":"lifecycle","kind":_lifecycle(after.lifecycle)})
 if before.visualMode!=after.visualMode: instructions.append({"action":"visualMode","mode":after.visualMode})
 return _output(after,instructions)
