extends SceneTree
var checks=[]
func check(value,label):
 checks.append({"name":label,"passed":bool(value)})
 if not value: push_error(label)
func _initialize(): call_deferred("run")
func first_tree(node):
 if node is AnimationTree: return node
 for child in node.get_children():
  var found=first_tree(child)
  if found!=null:return found
 return null
func run():
 var scene=load("res://character.tscn")
 var early=scene.instantiate()
 root.add_child(early)
 var early_assembly=early.get_node("AssemblyController")
 early_assembly.dispose_authoritative()
 var body=scene.instantiate()
 var other=scene.instantiate()
 root.add_child(body)
 root.add_child(other)
 await process_frame
 check(not early_assembly.ready_for_state and early_assembly.native==null,"early disposal prevents deferred registry startup")
 check(not early_assembly.bind_authoritative("earlyOwner"),"early disposed instance cannot bind after deferred startup")
 check(not early_assembly.start_preview({}),"early disposed instance cannot start preview")
 body.set_process(false)
 other.set_process(false)
 var assembly=body.get_node("AssemblyController")
 assembly.set_process(false)
 var other_assembly=other.get_node("AssemblyController")
 var initial=JSON.parse_string(FileAccess.get_file_as_string("res://initial.json"))
 check(assembly.ready_for_state and other_assembly.ready_for_state,"deferred assembly exposes trusted registry readiness")
 for actor in [assembly,other_assembly]:
  check(not actor.ready_for_batches and actor.native==null and actor.revision==-1 and actor.sequence==-1 and actor.records.is_empty() and actor.get_state().is_empty(),"production scene starts empty and unbound")
  check(actor.receive_snapshot(initial).get("error")=="UNBOUND_TRANSPORT","snapshot before owner binding rejected")
 check(assembly.bind_authoritative("bodyOne"),"first unique authoritative owner bound")
 check(not other_assembly.bind_authoritative("bodyOne"),"duplicate owner cannot bind another instance")
 check(other_assembly.bind_authoritative("bodyTwo"),"second unique authoritative owner bound")
 check(not assembly.bind_authoritative("bodyAgain"),"bound production instance cannot rebind")
 check(assembly.receive_snapshot(initial).get("status")=="applied","first genuine revision one snapshot installs")
 var other_initial=initial.duplicate(true)
 other_initial.instanceId="bodyTwo"
 check(other_assembly.receive_snapshot(other_initial).get("status")=="applied","second genuine revision one snapshot installs")
 var arriving=assembly.component_at("a")
 var arriving_b=assembly.component_at("b")
 check(body.get_meta("canonical_canvas",null)==Vector2(32,16) and arriving.get_meta("canonical_canvas",null)==Vector2(32,16) and arriving_b.get_meta("canonical_canvas",null)==Vector2(32,16),"copied reloaded compiler roots retain exact canonical canvas capability")
 var arriving_wrapper=arriving.get_parent().transform
 check(arriving.position==Vector2(0,-2) and arriving_b.position==Vector2(0,-2),"planner install begins at canonical approach offset")
 assembly.advance(0.1)
 check(arriving.position.is_equal_approx(Vector2(0,-1)) and arriving.get_parent().transform==arriving_wrapper,"planner install midpoint moves only owned component root")
 assembly.advance(0.1)
 check(arriving.transform==Transform2D.IDENTITY and arriving_b.transform==Transform2D.IDENTITY and arriving.get_parent().transform==arriving_wrapper,"planner install restores exact baseline without changing wrapper")
 other_assembly.advance(0.2)
 check(assembly.revision==1 and assembly.sequence==0,"first counters remain genuine revision one sequence zero")
 check(other_assembly.receive_snapshot(initial).get("error")=="INVALID_STATE","cross-owner snapshot rejected")
 var preview=scene.instantiate()
 root.add_child(preview)
 await process_frame
 var preview_assembly=preview.get_node("AssemblyController")
 check(preview_assembly.start_preview(initial),"explicit transient preview installs components")
 check(preview_assembly.preview_only and preview_assembly.get_state().instanceId.begins_with("preview-") and preview_assembly.component_at("a")!=null,"preview uses unique marked owner")
 check(not preview_assembly.bind_authoritative("productionOwner"),"preview cannot rebind as production")
 check(assembly.native.registry.red.contract.events.size()==65 and assembly.native.sockets.left.events.size()==65,"65 canonical marker event contract accepted by native assembly")
 check(assembly.native.sockets.right.events.is_empty(),"socket event union excludes unrelated descriptor types")
 var maximum_events=[]
 for i in 256: maximum_events.append("event"+str(i))
 check(assembly.native._events(maximum_events),"native component event boundary accepts 256 distinct names")
 maximum_events.append("event256")
 check(not assembly.native._events(maximum_events),"native component event boundary rejects 257 distinct names")
 var overflow=load("res://assembly_controller.gd").new()
 body.add_child(overflow)
 var overflow_descriptors=assembly.descriptors.duplicate(true)
 overflow_descriptors.red.events=maximum_events.slice(0,129)
 overflow_descriptors.blue.events=maximum_events.slice(129)
 overflow_descriptors.green.events=[]
 check(not overflow.configure("overflow",assembly.sockets,overflow_descriptors) and overflow.native==null and overflow.wrappers.is_empty(),"total assembly event union over 256 rejects before native mutation")
 overflow.free()
 var skeleton=body.get_node("Skeleton")
 var skeleton_id=skeleton.get_instance_id()
 var primary=body.get_node("AnimationTree")
 check(first_tree(body)==primary,"body AnimationTree discovered ahead of mounted trees")
 var a=assembly.component_at("a")
 var b=assembly.component_at("b")
 check(a!=null and b!=null and a!=b,"compiled scene loads two independent mounted components")
 check(a.get_node("Skeleton")!=b.get_node("Skeleton"),"independent component skeleton instances")
 check(a.get_node("Skeleton").owner==a and b.get_node("Skeleton").owner==b and skeleton.owner==body,"native scene ownership survives compilation and relocation")
 check(other.get_node("AssemblyController").component_at("a")!=a,"independent chassis instances")
 check(body.is_ancestor_of(a) and body.is_ancestor_of(b),"runtime components remain inside owned chassis hierarchy")
 for actor in [body,a,b]:
  actor.set_process(false)
  actor.play_animation("idle")
  actor.advance_animation(0.25)
 check(abs(body.get_node("Skeleton/root").rotation)>0.01 and abs(a.get_node("Skeleton/root").rotation)>0.01 and abs(b.get_node("Skeleton/root").rotation)>0.01,"body and both arms advance independently and concurrently")
 var preserved_b=b.get_instance_id()
 var batches=JSON.parse_string(FileAccess.get_file_as_string("res://batches.json"))
 for batch in batches:
  check(assembly.receive_snapshot(batch.snapshot).get("status")=="applied","real authoritative replacement snapshot applied")
  assembly.advance(0.2)
  check(body.get_node("Skeleton").get_instance_id()==skeleton_id and first_tree(body)==primary,"replacement preserves chassis skeleton and primary controller")
  check(assembly.component_at("b").get_instance_id()==preserved_b,"replacement preserves unaffected arm")
  var frame=batch.plan.instructions[3].frame
  var mounted=assembly.wrappers.left.transform
  check(mounted.is_equal_approx(Transform2D(Vector2(frame[0],frame[1]),Vector2(frame[2],frame[3]),Vector2(frame[4],frame[5]))),"exact mirrored rotated scaled planner mount frame")
 check(assembly.revision==4 and assembly.records.a.type=="red","three compatible alternatives reach authoritative final state")
 var before_remove=assembly.get_state().duplicate(true)
 var after_remove=before_remove.duplicate(true)
 after_remove.revision+=1
 after_remove.sequence+=1
 after_remove.components=after_remove.components.filter(func(component):return component.id!="a")
 var departing=assembly.component_at("a")
 var departing_wrapper=departing.get_parent().transform
 var body_pose=body.get_node("Skeleton/root").transform
 var sibling_pose=b.get_node("Skeleton/root").transform
 check(assembly.receive_snapshot(after_remove).get("status")=="applied" and departing.transform==Transform2D.IDENTITY,"planner removal starts at exact baseline")
 assembly.advance(0.1)
 check(departing.position.is_equal_approx(Vector2(0,-1)) and departing.get_parent().transform==departing_wrapper,"planner removal reverses approach on owned child")
 check(body.get_node("Skeleton/root").transform==body_pose and b.get_node("Skeleton/root").transform==sibling_pose and assembly.component_at("b").get_instance_id()==preserved_b,"approach removal preserves chassis and sibling skeleton pose and identity")
 assembly.advance(0.1)
 check(not is_instance_valid(departing) and assembly.component_at("a")==null and assembly.component_at("b")==b,"planner removal frees only tracked departing component")
 check(other_assembly.revision==1 and other_assembly.records.a.type=="red","other owner remains at independent initial state")
 check(other_assembly.dispose_authoritative().get("status")=="disposed","explicit root authority disposal exposed")
 check(not other_assembly.bind_authoritative("newOwner") and other_assembly.component_at("a")==null,"disposed instance cannot bind again and components are removed")
 body.free()
 var replacement=scene.instantiate()
 root.add_child(replacement)
 await process_frame
 check(replacement.get_node("AssemblyController").bind_authoritative("bodyOne"),"exit disposal releases authoritative owner")
 check(replacement.get_node("AssemblyController").get_state().revision==null,"replacement owner requires fresh real snapshot")
 var file=FileAccess.open("res://component-validation.json",FileAccess.WRITE)
 file.store_string(JSON.stringify({"checks":checks,"source_denied":not FileAccess.file_exists("res://spec.json"),"reload":true}))
 file.close()
 other.queue_free()
 preview.queue_free()
 replacement.queue_free()
 early.queue_free()
 await process_frame
 await process_frame
 quit(0 if checks.all(func(c):return c.passed) else 1)

