extends SceneTree
class FaultAssembly:
 extends "res://assembly_controller.gd"
 var fail_mount=false
 func _apply(instruction):
  if fail_mount and instruction.action=="mount": return false
  return super._apply(instruction)
var checks=[]
func check(value,label):
 checks.append({"name":label,"passed":bool(value)})
 if not value: push_error(label)
func _initialize(): call_deferred("run")
func run():
 var f=JSON.parse_string(FileAccess.get_file_as_string("res://fixture.json"))
 var body=Node2D.new()
 root.add_child(body)
 var sockets={}
 for s in f.registry.sockets:
  var node=Node2D.new()
  body.add_child(node)
  sockets[s.id]={"node":node,"types":s.types,"capacity":1,"inheritance":s.inheritance}
 var component=Node2D.new()
 var packed=PackedScene.new()
 packed.pack(component)
 component.free()
 var descriptors={}
 for d in f.registry.descriptors: descriptors[d.type]={"scene":packed,"spec":d.spec,"events":d.eventNames}
 var assembly=FaultAssembly.new()
 body.add_child(assembly)
 assembly.set_process(false)
 var t=load("res://assembly_transport.gd").new()
 check(t.configure_trusted(assembly,f.registry,sockets,descriptors),"trusted recovery transport configured")
 check(t.bind_authoritative("ownerA"),"recovery owner bound")
 check(t.receive_snapshot(f.initial).status=="applied","initial accepted snapshot")
 var accepted=t.get_state()
 var failed=f.initial.duplicate(true)
 failed.revision=2
 failed.sequence=1
 failed.components[0].revision=2
 failed.components[0].type="blue"
 assembly.fail_mount=true
 check(t.receive_snapshot(failed).get("needsPresentationRebuild",false) and assembly.faulted,"post-unmount failure quarantines presentation")
 check(t.get_state()==accepted,"failed candidate does not commit accepted state")
 if not t.has_method("prepare_rebuild_snapshot"):
  check(false,"recovery preparation API exists")
  t.dispose()
  body.free()
  finish()
  return
 check(t.prepare_rebuild_snapshot(f.initial).has("error"),"stale accepted state cannot undo failed newer candidate")
 var prepared=t.prepare_rebuild_snapshot(failed)
 check(prepared.get("status")=="prepared" and prepared.snapshot==failed,"same-sequence genuine failed snapshot prepares")
 check(prepared.floors.sequence==1 and prepared.floors.revision==2,"failed candidate supplies recovery floors")
 prepared.snapshot.components.clear()
 check(t.prepare_rebuild_snapshot(failed).snapshot.components.size()==1,"prepared snapshot is independent copied data")
 var bad=failed.duplicate(true)
 bad.components[0].upgrade=5
 check(t.prepare_rebuild_snapshot(bad).has("error"),"equal revision content conflict rejected")
 t.receive_snapshot(bad)
 check(t.prepare_rebuild_snapshot(failed).get("status")=="prepared","conflicting postfault observation cannot replace baseline")
 bad=failed.duplicate(true)
 bad.revision=3
 bad.sequence=2
 bad.components[0].revision=1
 check(t.prepare_rebuild_snapshot(bad).has("error"),"retained component revision rollback rejected")
 t.receive_snapshot(bad)
 check(t.prepare_rebuild_snapshot(failed).get("status")=="prepared","component rollback observation cannot raise authority")
 var current=failed.duplicate(true)
 current.sequence=2
 current.revision=3
 current.components[0].revision=3
 current.components[0].upgrade=1
 var compatibility=t.receive_snapshot(current)
 var compatibility_fields=compatibility.keys()
 compatibility_fields.sort()
 check(compatibility_fields==["error","needsPresentationRebuild","state"],"postfault receive preserves strict CSharp error schema")
 check(t.prepare_rebuild_snapshot(current).get("status")=="prepared","postfault valid snapshot advances private baseline")
 check(t.prepare_rebuild_snapshot(failed).has("error"),"observation forbids older recovery")
 t.receive_snapshot(failed)
 check(t.prepare_rebuild_snapshot(current).floors.sequence==2,"stale postfault snapshot cannot lower private baseline")
 var event={"version":1,"instanceId":"ownerA","sequence":3,"revision":4,"type":"visualMode","payload":{"visualMode":"attack"}}
 t.receive_event(event)
 current.sequence=3
 current.revision=4
 current.visualMode="attack"
 prepared=t.prepare_rebuild_snapshot(current)
 check(prepared.get("status")=="prepared" and prepared.floors.sequence==3 and prepared.floors.revision==4,"observed contiguous event state accepts genuine full snapshot")
 event.sequence=6
 event.revision=7
 event.payload.visualMode="hit"
 t.receive_event(event)
 check(t.prepare_rebuild_snapshot(current).has("error"),"gap watermarks block otherwise current snapshot")
 var latest=current.duplicate(true)
 latest.sequence=6
 latest.revision=7
 latest.visualMode="hit"
 prepared=t.prepare_rebuild_snapshot(latest)
 check(prepared.get("status")=="prepared" and prepared.floors.sequence==6 and prepared.floors.revision==7,"genuine snapshot meeting gap floors prepares")
 bad=latest.duplicate(true)
 bad.extra=true
 t.receive_snapshot(bad)
 check(t.prepare_rebuild_snapshot(latest).get("status")=="prepared","malformed postfault observation cannot replace baseline")
 check(t.prepare_rebuild_snapshot(current).has("error"),"malformed observations never lower gap floors")
 check(t.get_state()==accepted and assembly.revision==1 and assembly.sequence==0 and assembly.records.is_empty(),"all recovery preparation leaves accepted authority and visuals unchanged")
 var r=load("res://state_reconciler.gd").new()
 check(r.configure({"instanceId":"ownerA","sockets":[{"id":"left","types":["red","blue"],"capacity":1}]}),"standalone recovery reconciler configured")
 r.snapshot(failed)
 var fork=r.recovery_fork()
 check(fork.snapshot(failed).status=="applied","forced full snapshot mode does not ignore equal sequence")
 fork.teardown()
 check(r.get_state()==failed,"recovery fork mutation preserves original")
 var removed=failed.duplicate(true)
 removed.sequence=2
 removed.revision=3
 removed.lifecycle="removed"
 removed.components=[]
 r.snapshot(removed)
 var removed_fork=r.recovery_fork()
 check(removed_fork.snapshot(current).has("error"),"recovery full snapshot cannot resurrect terminal removal")
 check(removed_fork.snapshot(removed).status=="applied","terminal removed snapshot can be validated without fake counters")
 if t.has_method("rebuild_from_snapshot"):
  check(t.rebuild_from_snapshot(latest).get("error")=="REBUILD_FAILED" and t.get_state()==accepted and assembly.revision==1 and assembly.sequence==0,"physical application failure never commits authority counters")
  check(t.prepare_rebuild_snapshot(latest).get("status")=="prepared" and t.prepare_rebuild_snapshot(current).has("error"),"failed rebuild retains validated authority floors")
 t.dispose()
 check(t.prepare_rebuild_snapshot(latest).get("error")=="DISPOSED_TRANSPORT","disposal terminal for preparation")
 check(t.receive_snapshot(latest).get("status")=="disposed","disposal terminal for postfault observations")
 r.teardown()
 check(r.recovery_fork()==null,"disposed reconciler cannot create recovery fork")
 var second_body=Node2D.new()
 root.add_child(second_body)
 var second_sockets={}
 for s in f.registry.sockets:
  var mount=Node2D.new()
  second_body.add_child(mount)
  second_sockets[s.id]={"node":mount,"types":s.types,"capacity":1,"inheritance":s.inheritance}
 var second_assembly=FaultAssembly.new()
 second_body.add_child(second_assembly)
 second_assembly.set_process(false)
 var second_transport=load("res://assembly_transport.gd").new()
 second_transport.configure_trusted(second_assembly,f.registry,second_sockets,descriptors)
 second_transport.bind_authoritative("ownerB")
 var second_initial=f.initial.duplicate(true)
 second_initial.instanceId="ownerB"
 second_transport.receive_snapshot(second_initial)
 # Actual already-faulted-before-receive path: first rebuild signal synchronously
 # delivers newer valid authority, which the outer observation must not overwrite.
 second_assembly.faulted=true
 var outer=failed.duplicate(true)
 outer.instanceId="ownerB"
 var newer=outer.duplicate(true)
 newer.sequence=2
 newer.revision=3
 newer.components[0].revision=3
 newer.components[0].upgrade=2
 var nested=[]
 var handler=func(_owner): nested.append(second_transport.receive_snapshot(newer))
 second_transport.rebuild_required.connect(handler)
 second_transport.receive_snapshot(outer)
 second_transport.rebuild_required.disconnect(handler)
 check(nested.size()==1 and nested[0].get("error")=="PRESENTATION_FAULTED" and nested[0].size()==3,"first rebuild signal observes newer snapshot without changing receive protocol")
 check(second_transport.prepare_rebuild_snapshot(outer).has("error"),"outer observation cannot lower reentrant newer recovery floor")
 var reentrant_prepared=second_transport.prepare_rebuild_snapshot(newer)
 check(reentrant_prepared.get("status")=="prepared" and reentrant_prepared.floors.sequence==2 and reentrant_prepared.floors.revision==3,"reentrant newer authoritative recovery baseline retained")
 # Rebuild uses a real fresh snapshot and keeps the existing chassis/controller.
 var foreign=Node2D.new()
 var wrapper=second_assembly.wrappers.left
 wrapper.position=Vector2(13,17)
 wrapper.add_child(foreign)
 foreign.position=Vector2(5,9)
 var foreign_transform=foreign.global_transform
 var old_native=second_assembly.native.get_instance_id()
 var body_id=second_body.get_instance_id()
 var primary_tree=AnimationTree.new()
 second_body.add_child(primary_tree)
 var primary_tree_id=primary_tree.get_instance_id()
 check(second_transport.has_method("rebuild_from_snapshot"),"bounded rebuild API exists")
 if second_transport.has_method("rebuild_from_snapshot"):
  check(second_transport.rebuild_from_snapshot(outer).has("error"),"invalid old snapshot cannot consume physical attempt")
  var foreign_native=Node.new()
  second_assembly.native.add_child(foreign_native)
  check(second_transport.rebuild_from_snapshot(newer).get("error")=="REBUILD_FAILED" and is_instance_valid(foreign_native) and second_assembly.native.get_instance_id()==old_native,"uncertain native child refuses without deleting foreign nodes")
  foreign_native.free()
  var rebuilt=second_transport.rebuild_from_snapshot(newer)
  check(rebuilt.get("status")=="applied" and second_transport.get_state()==newer,"genuine snapshot commits after successful physical rebuild")
  check(second_body.get_instance_id()==body_id and second_assembly.get_parent()==second_body and second_assembly.instance_id=="ownerB","rebuild preserves chassis controller and owner")
  check(is_instance_valid(primary_tree) and primary_tree.get_instance_id()==primary_tree_id and primary_tree.get_parent()==second_body,"primary chassis AnimationTree survives rebuild")
  check(second_assembly.native.get_instance_id()!=old_native and not second_assembly.faulted,"rebuild replaces owned native presentation")
  check(is_instance_valid(foreign) and foreign.get_parent()==second_sockets.left.node and foreign.global_transform.is_equal_approx(foreign_transform),"foreign wrapper child survives with global transform")
  check(second_transport.rebuild_from_snapshot(newer).get("error")=="PRESENTATION_NOT_FAULTED","healthy presentation cannot be reset")
  # A genuine snapshot at the same counters can reconstruct lost visuals.
  second_assembly.faulted=true
  second_transport.receive_snapshot(newer)
  check(second_transport.rebuild_from_snapshot(newer).get("status")=="applied" and second_assembly.revision==newer.revision and second_assembly.sequence==newer.sequence,"equal revision genuine snapshot rebuilds without counter reset")
  second_assembly.faulted=true
  second_transport.receive_snapshot(newer)
  check(second_transport.rebuild_from_snapshot(newer).get("error")=="REBUILD_LIMIT_REACHED","three physical attempts is a lifetime limit")
 second_transport.dispose()
 second_body.free()
 var third_body=Node2D.new()
 root.add_child(third_body)
 var third_sockets={}
 for definition in f.registry.sockets:
  var mount=Node2D.new()
  third_body.add_child(mount)
  third_sockets[definition.id]={"node":mount,"types":definition.types,"capacity":1,"inheritance":definition.inheritance}
 var third_assembly=FaultAssembly.new()
 third_body.add_child(third_assembly)
 var third_transport=load("res://assembly_transport.gd").new()
 third_transport.configure_trusted(third_assembly,f.registry,third_sockets,descriptors)
 third_transport.bind_authoritative("ownerC")
 var third_snapshot=f.initial.duplicate(true)
 third_snapshot.instanceId="ownerC"
 third_transport.receive_snapshot(third_snapshot)
 third_assembly.faulted=true
 third_transport.receive_snapshot(third_snapshot)
 var cancellation=func(_child): third_transport.dispose()
 third_body.child_entered_tree.connect(cancellation)
 var cancelled=third_transport.rebuild_from_snapshot(third_snapshot)
 third_body.child_entered_tree.disconnect(cancellation)
 check(cancelled.get("status")=="disposed" and third_assembly.records.is_empty(),"reentrant disposal during rebuild is terminal and clears candidate presentation")
 check(third_transport.rebuild_from_snapshot(third_snapshot).get("error")=="DISPOSED_TRANSPORT","disposed rebuild cannot retry or resurrect")
 third_body.free()
 body.free()
 ownership_regressions(f,descriptors)
 multiple_slot_recovery(f,descriptors)
 finish()
func multiple_slot_recovery(f,descriptors):
 for mode in ["success","callback"]:
  var registry=f.registry.duplicate(true)
  registry.sockets[0].capacity=2
  registry.descriptors[1].mount.position=[8,0]
  var body=Node2D.new()
  root.add_child(body)
  var sockets={}
  for definition in registry.sockets:
   var mount=Node2D.new()
   body.add_child(mount)
   sockets[definition.id]={"node":mount,"types":definition.types,"capacity":definition.capacity,"inheritance":definition.inheritance}
  var extra=Node2D.new()
  body.add_child(extra)
  var assembly=FaultAssembly.new()
  body.add_child(assembly)
  assembly.set_process(false)
  var transport=load("res://assembly_transport.gd").new()
  check(transport.configure_trusted(assembly,registry,sockets,descriptors),"multiple recovery trusted "+mode)
  var owner="multiple_recovery_"+mode
  check(transport.bind_authoritative(owner),"multiple recovery bound "+mode)
  var snapshot=f.initial.duplicate(true)
  snapshot.instanceId=owner
  var sibling=snapshot.components[0].duplicate(true)
  sibling.id="sibling"
  sibling.type="blue"
  snapshot.components.append(sibling)
  check(transport.receive_snapshot(snapshot).get("status")=="applied","multiple recovery initial "+mode)
  var accepted_plan=assembly._last_plan.duplicate(true)
  var first=assembly.component_at("arm")
  var second=assembly.component_at("sibling")
  if first==null or second==null:
   check(false,"multiple recovery has both slots "+mode)
   transport.dispose()
   body.free()
   continue
  var foreign_a=Node2D.new()
  var foreign_b=Node2D.new()
  first.get_parent().add_child(foreign_a)
  second.get_parent().add_child(foreign_b)
  foreign_a.global_position=Vector2(13,17)
  foreign_b.global_position=Vector2(23,27)
  var failed=snapshot.duplicate(true)
  failed.revision=2
  failed.sequence=1
  failed.components[0].id="replacement"
  failed.components[0].revision=2
  assembly.fail_mount=true
  check(transport.receive_snapshot(failed).get("needsPresentationRebuild",false),"multiple slot fault quarantines "+mode)
  check(transport.get_state()==snapshot,"multiple slot fault retains state "+mode)
  assembly.fail_mount=false
  if mode=="callback":
   var callback=func(child):
    if child==foreign_a and is_instance_valid(foreign_b): foreign_b.reparent(extra,true)
   sockets.left.node.child_entered_tree.connect(callback)
  var restored=transport.rebuild_from_snapshot(failed)
  if mode=="success":
   check(restored.get("status")=="applied" and assembly.component_at("replacement")!=null and assembly.component_at("sibling")!=null,"multiple slot rebuild restores siblings")
   check(foreign_a.get_parent()==sockets.left.node and foreign_b.get_parent()==sockets.left.node and foreign_a.global_position==Vector2(13,17) and foreign_b.global_position==Vector2(23,27),"multiple slot rebuild preserves both foreign children")
   check(assembly.revision==2 and assembly.sequence==1 and assembly.get_parent()==body,"multiple slot rebuild retains chassis and genuine counters")
  else:
   check(restored.get("error")=="REBUILD_FAILED" and transport.get_state()==snapshot and assembly.faulted,"multiple slot ownership callback refuses commit")
   check(is_instance_valid(foreign_a) and is_instance_valid(foreign_b),"multiple slot callback never deletes foreign content")
   check(foreign_b.get_parent()==extra,"multiple slot callback never steals moved foreign content")
   check(assembly.revision==snapshot.revision and assembly.sequence==snapshot.sequence and assembly._last_plan==accepted_plan,"multiple slot callback retains exact native authority")
  var retained=assembly.wrappers.values()
  retained.append(assembly.native)
  transport.dispose()
  body.free()
  for node in retained:
   if is_instance_valid(node): node.free()
func ownership_regressions(f,descriptors):
 for mode in ["native_exit","wrapper_exit","later_wrapper_exit","move_child","queue_child","move_socket","configure_move","apply_move"]:
  var body=Node2D.new()
  root.add_child(body)
  var sockets={}
  for definition in f.registry.sockets:
   var mount=Node2D.new()
   body.add_child(mount)
   sockets[definition.id]={"node":mount,"types":definition.types,"capacity":1,"inheritance":definition.inheritance}
  var extra=Node2D.new()
  body.add_child(extra)
  var assembly=FaultAssembly.new()
  body.add_child(assembly)
  var transport=load("res://assembly_transport.gd").new()
  transport.configure_trusted(assembly,f.registry,sockets,descriptors)
  var owner="recovery_"+mode
  transport.bind_authoritative(owner)
  var snapshot=f.initial.duplicate(true)
  snapshot.instanceId=owner
  transport.receive_snapshot(snapshot)
  assembly.faulted=true
  transport.receive_snapshot(snapshot)
  var foreign=Node2D.new()
  var wrapper=assembly.wrappers.left
  if mode in ["native_exit","wrapper_exit","later_wrapper_exit"]:
   var target=assembly.wrappers.right if mode=="later_wrapper_exit" else wrapper
   var callback=func(): target.add_child(foreign)
   (assembly.native if mode=="native_exit" else wrapper).tree_exiting.connect(callback,CONNECT_ONE_SHOT)
  elif mode in ["configure_move","apply_move"]:
   wrapper.add_child(foreign)
   if mode=="configure_move":
    var callback=func(_child): foreign.reparent(extra,true)
    body.child_entered_tree.connect(callback,CONNECT_ONE_SHOT)
   else:
    var on_component=func(_child): foreign.reparent(extra,true)
    var on_wrapper=func(child): child.child_entered_tree.connect(on_component,CONNECT_ONE_SHOT)
    var on_native=func(_child): sockets.left.node.child_entered_tree.connect(on_wrapper,CONNECT_ONE_SHOT)
    body.child_entered_tree.connect(on_native,CONNECT_ONE_SHOT)
  else:
   wrapper.add_child(foreign)
   var callback=func(child):
    if child!=foreign: return
    if mode=="move_child": child.reparent(extra,true)
    elif mode=="queue_child": child.queue_free()
    else: sockets.left.node.reparent(extra,true)
   sockets.left.node.child_entered_tree.connect(callback,CONNECT_ONE_SHOT)
  var accepted_plan=assembly._last_plan.duplicate(true)
  var proposed=snapshot.duplicate(true)
  proposed.sequence=1
  proposed.revision=2
  proposed.components[0].revision=2
  var result=transport.rebuild_from_snapshot(proposed)
  check(result.get("error")=="REBUILD_FAILED" and transport.get_state()==snapshot and assembly.faulted,"ownership callback "+mode+" refuses authority commit")
  check(is_instance_valid(foreign),"ownership callback "+mode+" never recursively deletes foreign node")
  check(assembly.revision==snapshot.revision and assembly.sequence==snapshot.sequence and assembly._last_plan==accepted_plan,"ownership callback "+mode+" retains exact accepted native counters and plan")
  # The fixture owns retained quarantined nodes; production intentionally does
  # not infer ownership of foreign content to remove these detached wrappers.
  var retained=assembly.wrappers.values()
  retained.append(assembly.native)
  transport.dispose()
  body.free()
  for node in retained:
   if is_instance_valid(node): node.free()
func finish():
 var file=FileAccess.open("res://validation.json",FileAccess.WRITE)
 file.store_string(JSON.stringify({"checks":checks}))
 quit(0 if checks.all(func(c):return c.passed) else 1)
