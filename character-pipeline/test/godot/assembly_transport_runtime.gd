extends SceneTree
class RejectingAssembly:
 extends "res://assembly_controller.gd"
 var reject_instruction=false
 var reject_mount=false
 func _apply(instruction):
  if reject_instruction or reject_mount and instruction.action=="mount": return false
  return super._apply(instruction)
var checks=[]
func check(value,label):
 checks.append({"name":label,"passed":bool(value)})
 if not value: push_error(label)
func normalized(value): return JSON.parse_string(JSON.stringify(value))
func _initialize(): call_deferred("run")
func scene(valid=true):
 var n=Node2D.new() if valid else Node.new()
 var skeleton=Skeleton2D.new()
 skeleton.name="Skeleton"
 n.add_child(skeleton)
 skeleton.owner=n
 var packed=PackedScene.new()
 packed.pack(n)
 n.free()
 return packed
func setup(registry,rejecting=false):
 var body=Node2D.new()
 root.add_child(body)
 var skeleton=Skeleton2D.new()
 skeleton.name="Skeleton"
 body.add_child(skeleton)
 var sockets={}
 for s in registry.sockets:
  var node=Node2D.new()
  body.add_child(node)
  sockets[s.id]={"node":node,"types":s.types.duplicate(),"capacity":s.capacity,"inheritance":s.inheritance.duplicate()}
 var descriptors={}
 for d in registry.descriptors: descriptors[d.type]={"scene":scene(),"spec":d.spec,"events":d.eventNames.duplicate()}
 var assembly=RejectingAssembly.new() if rejecting else load("res://assembly_controller.gd").new()
 body.add_child(assembly)
 assembly.set_process(false)
 var transport=load("res://assembly_transport.gd").new()
 check(transport.configure_trusted(assembly,registry,sockets,descriptors),"trusted transport configured")
 return {"body":body,"assembly":assembly,"transport":transport,"sockets":sockets,"descriptors":descriptors,"skeleton":skeleton.get_instance_id()}
func run():
 var f=JSON.parse_string(FileAccess.get_file_as_string("res://fixture.json"))
 multiple_components(f)
 var a=setup(f.registry)
 var t=a.transport
 var bad_sockets=a.sockets.duplicate(true)
 bad_sockets.left.types=["red"]
 check(not load("res://assembly_transport.gd").new().configure_trusted(a.assembly,f.registry,bad_sockets,a.descriptors),"mismatched socket types reject before binding")
 var bad_descriptors=a.descriptors.duplicate(true)
 bad_descriptors.red.spec="wrong.json"
 check(not load("res://assembly_transport.gd").new().configure_trusted(a.assembly,f.registry,a.sockets,bad_descriptors),"mismatched descriptor source rejects")
 bad_descriptors=a.descriptors.duplicate(true)
 bad_descriptors.red.events=["invented"]
 check(not load("res://assembly_transport.gd").new().configure_trusted(a.assembly,f.registry,a.sockets,bad_descriptors),"mismatched descriptor events reject")
 var unsupported=f.registry.duplicate(true)
 unsupported.sockets[0].capacity=2
 check(not load("res://assembly_transport.gd").new().configure_trusted(a.assembly,unsupported,a.sockets,a.descriptors),"declared native capacity mismatch rejects")
 unsupported=f.registry.duplicate(true)
 unsupported.sockets=[]
 var oversized={}
 for i in 65:
  var s=f.registry.sockets[0].duplicate(true)
  s.id="socket"+str(i)
  unsupported.sockets.append(s)
  oversized[s.id]=a.sockets.left.duplicate(true)
 check(not load("res://assembly_transport.gd").new().configure_trusted(a.assembly,unsupported,oversized,a.descriptors),"65 sockets reject before binding")
 if not t.has_method("bind_authoritative"):
  check(false,"transport bind API required")
  finish()
  return
 check(a.assembly.native==null and a.assembly.revision==-1,"configuration does not invent authority or preview components")
 check(t.bind_authoritative("ownerA"),"one-time authoritative owner binding")
 check(not t.bind_authoritative("ownerA"),"same transport cannot rebind")
 check(not load("res://assembly_transport.gd").new().configure_trusted(a.assembly,f.registry,a.sockets,a.descriptors),"configured assembly cannot be reset into authority")
 var requests=[]
 t.snapshot_required.connect(func(owner,seq,rev):requests.append([owner,seq,rev]))
 check(normalized(t.receive_snapshot(f.initial))==f.expected.initial,"revision1 snapshot bootstraps real components")
 a.assembly.advance(0.2)
 var arm=a.assembly.component_at("arm")
 var arm_id=arm.get_instance_id()
 check(normalized(t.receive_event(f.noop))==f.expected.noop,"equal revision higher sequence no-op accepted")
 check(a.assembly.sequence==1 and a.assembly.component_at("arm").get_instance_id()==arm_id,"no-op acknowledges sequence without replacing visuals")
 check(not a.assembly.apply_batch({"revision":1,"sequence":2,"plan":f.expected.bootstrap}),"same revision nonempty conflicting plan still rejects")
 check(normalized(t.receive_event(f.gap))==f.expected.gap,"gap blocks speculation")
 check(requests.size()==1 and requests[0][0]=="ownerA" and requests[0][1]==f.gap.sequence and requests[0][2]==f.gap.revision and a.assembly.component_at("arm").get_instance_id()==arm_id,"gap requests exact owner watermarks and retains visuals")
 check(normalized(t.receive_snapshot(f.old))==f.expected.old,"insufficient recovery snapshot blocked")
 a.assembly.descriptors.blue.scene=scene(false)
 var rejected=t.receive_snapshot(f.recovery)
 check(rejected.get("error")=="ASSEMBLY_REJECTED" and not a.assembly.faulted and normalized(t.get_state())==f.expected.beforeRecovery,"failing scene preflight rolls back candidate state")
 check(a.assembly.component_at("arm").get_instance_id()==arm_id,"failing scene preflight preserves existing component")
 a.assembly.descriptors.blue.scene=scene()
 a.assembly.native.registry.blue.scene=a.assembly.descriptors.blue.scene
 check(normalized(t.receive_snapshot(f.recovery))==f.expected.recovery,"valid current snapshot recovers gap")
 var accepted=t.get_state()
 check(t.receive_event(f.plannerBad).get("error")=="INVALID_COMPONENT" and t.get_state()==accepted,"planner rejection leaves accepted state unchanged")
 check(normalized(t.receive_event(f.dead))==f.expected.dead,"authoritative death")
 check(normalized(t.receive_event(f.revive))==f.expected.revive,"authoritative revive")
 var b=setup(f.registry)
 check(b.transport.bind_authoritative("ownerB"),"second unique owner binds")
 check(b.transport.receive_snapshot(f.other).status=="applied","second owner snapshot")
 check(b.transport.receive_event(f.dead).get("error")=="INVALID_STATE" and b.transport.get_state().instanceId=="ownerB","cross-owner event rejects")
 var duplicate=setup(f.registry)
 check(not duplicate.transport.bind_authoritative("ownerA"),"active duplicate owner rejects")
 check(normalized(t.receive_event(f.removed))==f.expected.removed and a.assembly.records.is_empty(),"authoritative removal clears owned components")
 check(normalized(t.receive_event(f.late))==f.expected.late,"removed is terminal")
 check(normalized(t.dispose())==f.expected.disposed,"dispose is terminal")
 check(not t.bind_authoritative("another"),"disposed transport cannot rebind")
 check(a.skeleton==a.body.get_node("Skeleton").get_instance_id() and b.skeleton==b.body.get_node("Skeleton").get_instance_id(),"both chassis skeleton identities preserved")
 for kind in ["detached_socket","freed_socket","detached_wrapper","freed_wrapper","detached_controller","freed_controller"]:
  var broken=setup(f.registry)
  var owner="broken_"+kind
  broken.transport.bind_authoritative(owner)
  var initial=f.initial.duplicate(true)
  initial.instanceId=owner
  var other=initial.components[0].duplicate(true)
  other.id="other"
  other.socket="right"
  initial.components.append(other)
  broken.transport.receive_snapshot(initial)
  broken.assembly.advance(0.2)
  var before=broken.transport.get_state()
  var right_id=broken.assembly.component_at("other").get_instance_id()
  var old_left=broken.assembly.component_at("arm")
  var left_id=old_left.get_instance_id()
  var mount=broken.sockets.left.node
  var wrapper=broken.assembly.wrappers.left
  if kind=="detached_socket": broken.body.remove_child(mount)
  elif kind=="freed_socket": mount.free()
  elif kind=="detached_wrapper": mount.remove_child(wrapper)
  elif kind=="freed_wrapper": wrapper.free()
  elif kind=="detached_controller": broken.body.remove_child(broken.assembly.native)
  else: broken.assembly.native.free()
  var replacement=initial.duplicate(true)
  replacement.sequence=1
  replacement.revision=2
  replacement.components[0].revision=2
  replacement.components[0].type="blue"
  var result=broken.transport.receive_snapshot(replacement)
  check(result.get("error")=="ASSEMBLY_REJECTED" and not broken.assembly.faulted and broken.transport.get_state()==before,kind+" rejects without committing candidate")
  check(broken.assembly.sequence==0 and broken.assembly.revision==1,kind+" preserves accepted native counters")
  if not kind.ends_with("controller"):
   check(broken.assembly.component_at("other").get_instance_id()==right_id,kind+" preserves unaffected visual")
  if kind in ["detached_socket","detached_wrapper"]:
   check(is_instance_valid(old_left) and old_left.get_instance_id()==left_id,kind+" preserves detached existing visual")
  broken.transport.dispose()
  broken.body.free()
  if kind=="detached_socket" and is_instance_valid(mount): mount.free()
 var failed=setup(f.registry,true)
 failed.transport.bind_authoritative("failedApply")
 var initial_failure=f.initial.duplicate(true)
 initial_failure.instanceId="failedApply"
 failed.transport.receive_snapshot(initial_failure)
 failed.assembly.advance(0.2)
 var accepted_failure=failed.transport.get_state()
 var visual_id=failed.assembly.component_at("arm").get_instance_id()
 var first_sentinel=Node2D.new()
 first_sentinel.name="HostFeature"
 failed.assembly.wrappers.left.add_child(first_sentinel)
 failed.assembly.reject_instruction=true
 var replacement_failure=initial_failure.duplicate(true)
 replacement_failure.revision=2
 replacement_failure.sequence=1
 replacement_failure.components[0].type="blue"
 replacement_failure.components[0].revision=2
 check(is_instance_valid(first_sentinel) and first_sentinel.get_parent()==failed.assembly.wrappers.left,"first fault preserves unrelated host child under wrapper")
 check(failed.transport.receive_snapshot(replacement_failure).get("error")=="ASSEMBLY_REJECTED","actual instruction application failure propagates")
 check(failed.transport.get_state()==accepted_failure and failed.assembly.revision==1 and failed.assembly.sequence==0,"application failure preserves authority counters and candidate")
 check(failed.assembly.faulted and failed.assembly.records.is_empty(),"unexpected first instruction failure quarantines presentation")
 check(is_instance_valid(first_sentinel) and first_sentinel.get_parent()==failed.assembly.wrappers.left,"first fault preserves unrelated host child under wrapper")
 check(failed.transport.receive_snapshot(replacement_failure).get("needsPresentationRebuild",false),"faulted assembly cannot retry authority batches")
 failed.transport.dispose()
 failed.body.free()
 var later=setup(f.registry,true)
 later.transport.bind_authoritative("laterFailure")
 var later_initial=f.initial.duplicate(true)
 later_initial.instanceId="laterFailure"
 later.transport.receive_snapshot(later_initial)
 later.assembly.advance(0.2)
 var later_accepted=later.transport.get_state()
 var chassis_id=later.skeleton
 var rebuilds=[]
 later.transport.rebuild_required.connect(func(owner):rebuilds.append(owner))
 var later_sentinel=Node2D.new()
 later_sentinel.name="HostFeature"
 later.assembly.wrappers.left.add_child(later_sentinel)
 later.assembly.reject_mount=true
 var later_replacement=later_initial.duplicate(true)
 later_replacement.revision=2
 later_replacement.sequence=1
 later_replacement.components[0].type="blue"
 later_replacement.components[0].revision=2
 var later_result=later.transport.receive_snapshot(later_replacement)
 check(later_result.get("needsPresentationRebuild",false) and later.assembly.faulted,"post-unmount failure reports quarantine rather than fake rollback")
 check(later.transport.get_state()==later_accepted and later.assembly.revision==1 and later.assembly.sequence==0,"late failure retains last accepted authority counters and state")
 check(is_instance_valid(later_sentinel) and later_sentinel.get_parent()==later.assembly.wrappers.left,"late fault preserves unrelated host child under wrapper")
 check(later.assembly.records.is_empty() and later.assembly.native.mounted.is_empty(),"quarantine clears inconsistent owned component presentation")
 later.assembly.reject_mount=false
 check(later.transport.receive_snapshot(later_replacement).get("needsPresentationRebuild",false) and rebuilds==["laterFailure"],"quarantine rejects retry and emits one actionable rebuild request")
 check(not later.assembly.apply_batch({"revision":2,"sequence":1,"plan":f.expected.bootstrap}),"quarantine rejects direct consumer bypass retry")
 check(later.body.get_node("Skeleton").get_instance_id()==chassis_id,"quarantine preserves chassis identity")
 later.transport.dispose()
 later.body.free()
 b.transport.dispose()
 for item in [a,b,duplicate]: item.body.free()
 finish()
func multiple_components(f):
 var registry=f.registry.duplicate(true)
 registry.sockets[0].capacity=2
 registry.descriptors[1].mount.position=[8,0]
 var item=setup(registry)
 var t=item.transport
 check(item.assembly.native==null and item.assembly.wrappers.is_empty(),"capacity2 configuration creates no physical presentation")
 for capacity in [0,1,1.5,65,"2",true]:
  var sockets=item.sockets.duplicate(true)
  sockets.left.capacity=capacity
  check(not load("res://assembly_transport.gd").new().configure_trusted(item.assembly,registry,sockets,item.descriptors),"invalid or mismatching native capacity rejects "+str(capacity))
  check(item.assembly.native==null and item.assembly.wrappers.is_empty(),"capacity rejection preserves fresh physical assembly")
 var overflow=registry.duplicate(true)
 overflow.sockets[0].capacity=64
 overflow.sockets[1].capacity=1
 var overflow_sockets=item.sockets.duplicate(true)
 overflow_sockets.left.capacity=64
 check(not load("res://assembly_transport.gd").new().configure_trusted(item.assembly,overflow,overflow_sockets,item.descriptors),"aggregate65 rejects before binding")
 overflow.sockets[0].capacity=63
 overflow_sockets.left.capacity=63
 check(load("res://assembly_transport.gd").new().configure_trusted(item.assembly,overflow,overflow_sockets,item.descriptors),"aggregate64 trusted capacity accepted without binding")
 check(item.assembly.native==null and item.assembly.wrappers.is_empty(),"aggregate64 validation preserves fresh physical assembly")
 for capacity in [0,1.5,65,"2",true]:
  var malformed=registry.duplicate(true)
  malformed.sockets[0].capacity=capacity
  check(not load("res://assembly_transport.gd").new().configure_trusted(item.assembly,malformed,item.sockets,item.descriptors),"malformed planner capacity rejects "+str(capacity))
 var membership=item.sockets.duplicate(true)
 membership.wrong=membership.right
 membership.erase("right")
 check(not load("res://assembly_transport.gd").new().configure_trusted(item.assembly,registry,membership,item.descriptors),"capacity2 wrong socket membership rejects before binding")
 var partial=item.sockets.duplicate(true)
 partial.left.inheritance.rotation=false
 check(not load("res://assembly_transport.gd").new().configure_trusted(item.assembly,registry,partial,item.descriptors),"capacity2 partial inheritance rejects")
 check(t.bind_authoritative("multiOwner"),"capacity2 authoritative owner binds")
 if item.assembly.native==null:
  item.body.free()
  return
 var initial=f.initial.duplicate(true)
 initial.instanceId="multiOwner"
 var sibling=initial.components[0].duplicate(true)
 sibling.id="sibling"
 sibling.type="blue"
 initial.components.append(sibling)
 check(t.receive_snapshot(initial).get("status")=="applied","capacity2 snapshot mounts both components")
 item.assembly.advance(0.2)
 var first=item.assembly.component_at("arm")
 var second=item.assembly.component_at("sibling")
 check(is_instance_valid(first) and is_instance_valid(second) and first!=second,"capacity2 components have independent native instances")
 if not is_instance_valid(first) or not is_instance_valid(second):
  t.dispose()
  item.body.free()
  return
 var first_id=first.get_instance_id()
 var second_id=second.get_instance_id()
 check(first.get_parent()!=second.get_parent() and first.global_transform!=second.global_transform,"capacity2 descriptors use distinct private mount frames")
 var change={"version":1,"instanceId":"multiOwner","sequence":1,"revision":2,"type":"upsert","payload":initial.components[0].duplicate(true)}
 change.payload.revision=2
 change.payload.damageState="damaged"
 check(t.receive_event(change).get("status")=="applied","capacity2 sibling damage event accepted")
 check(item.assembly.component_at("arm").get_instance_id()==first_id and item.assembly.component_at("sibling").get_instance_id()==second_id,"capacity2 damage preserves both native instances")
 var accepted=t.get_state()
 check(t.receive_event(change).get("status")=="ignored" and t.get_state()==accepted,"capacity2 duplicate event preserves counters and presentation")
 var requests=[]
 t.snapshot_required.connect(func(owner,seq,rev):requests.append([owner,seq,rev]))
 var gap=change.duplicate(true)
 gap.sequence=3
 gap.revision=4
 gap.payload.revision=4
 check(t.receive_event(gap).get("requestSnapshot",false) and requests==[["multiOwner",3,4]],"capacity2 missed event requests exact authoritative counters")
 check(item.assembly.component_at("sibling").get_instance_id()==second_id,"capacity2 missed event retains unaffected sibling")
 var recovery=initial.duplicate(true)
 recovery.sequence=3
 recovery.revision=4
 recovery.components[0]=gap.payload
 check(t.receive_snapshot(recovery).get("status")=="applied" and item.assembly.sequence==3 and item.assembly.revision==4,"capacity2 snapshot reconciles caller supplied counters")
 check(item.assembly.component_at("sibling").get_instance_id()==second_id,"capacity2 reconciliation preserves unaffected sibling instance")
 var too_many=recovery.duplicate(true)
 too_many.sequence=4
 too_many.revision=5
 var extra=sibling.duplicate(true)
 extra.id="extra"
 too_many.components.append(extra)
 var state=t.get_state()
 check(t.receive_snapshot(too_many).has("error") and t.get_state()==state and item.assembly.sequence==3,"capacity2 overflow rejects before authority or physical mutation")
 t.dispose()
 item.body.free()
func finish():
 var file=FileAccess.open("res://validation.json",FileAccess.WRITE)
 file.store_string(JSON.stringify({"checks":checks}))
 quit(0 if checks.all(func(c):return c.passed) else 1)
