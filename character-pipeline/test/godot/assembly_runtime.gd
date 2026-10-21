extends SceneTree
var checks=[]
func check(value,label):
 checks.append({"name":label,"passed":bool(value)})
 if not value: push_error(label)
func _initialize(): call_deferred("run")
func fixture(color,canvas=null,clips=false):
 var n=Node2D.new()
 if clips:
  n.set_script(load("res://phase_fixture.gd"))
  var player=AnimationPlayer.new()
  player.name="AnimationPlayer"
  n.add_child(player)
  player.owner=n
  var library=AnimationLibrary.new()
  var animation=Animation.new()
  animation.length=1
  library.add_animation("activate",animation)
  player.add_animation_library("",library)
 if canvas!=null: n.set_meta("canonical_canvas",canvas)
 var skeleton=Skeleton2D.new()
 skeleton.name="Skeleton"
 n.add_child(skeleton)
 skeleton.owner=n
 var p=Polygon2D.new()
 p.polygon=PackedVector2Array([Vector2.ZERO,Vector2(24,0),Vector2(24,12),Vector2(0,12)])
 p.color=color
 n.add_child(p)
 p.owner=n
 var packed=PackedScene.new()
 packed.pack(n)
 n.free()
 return packed
func setup(instance="fixture",capacity=1,profiles={},clips=false):
 var chassis=Node2D.new()
 root.add_child(chassis)
 var skeleton=Skeleton2D.new()
 chassis.add_child(skeleton)
 var sockets={}
 for id in ["left","right"]:
  var mount=Node2D.new()
  mount.position=Vector2(40 if id=="left" else 100,40)
  chassis.add_child(mount)
  sockets[id]={"node":mount,"capacity":capacity,"types":["red","blue"],"inheritance":{"position":true,"rotation":true,"scale":true}}
 var controller=load("res://assembly_controller.gd").new()
 chassis.add_child(controller)
 var definitions={"red":{"scene":fixture(Color.RED,null,clips),"spec":"red.json","events":[]},"blue":{"scene":fixture(Color.BLUE,null,clips),"spec":"blue.json","events":[]}}
 for type in profiles: definitions[type].transitions=profiles[type]
 check(controller.configure(instance,sockets,definitions),"trusted assembly configured")
 controller.set_process(false)
 controller.native.set_process(false)
 return [controller,skeleton]
func run():
 var batches=JSON.parse_string(FileAccess.get_file_as_string("res://batches.json"))
 var script_file=FileAccess.open("res://phase_fixture.gd",FileAccess.WRITE)
 script_file.store_string("extends Node2D\n@export var clip_metadata={\"activate\":{\"events\":[]}}\nfunc play_animation(id): $AnimationPlayer.play(id)\nfunc _init():\n if Engine.has_meta(\"phase_preflight_callback\"): Engine.get_meta(\"phase_preflight_callback\").call()\n")
 script_file.close()
 var clip_profiles={"red":{"install":{"duration":0.4,"phases":[{"id":"activate","time":0,"clip":"activate"}]}},"blue":{}}
 var live=setup("fixture",1,clip_profiles,true)[0]
 check(live.apply_batch(batches[0]),"live metadata fixture mounted")
 var live_a=live.component_at("a")
 var live_b=live.component_at("b")
 live_b.clip_metadata={}
 var live_batch=batches[1].duplicate(true)
 live_batch.plan.instructions.push_front({"action":"cancel","id":"a"})
 var original_generation=live.native.transitions[live.allocations.a].generation
 check(not live.apply_batch(live_batch) and live.component_at("a")==live_a and live.component_at("b")==live_b and live.native.transitions[live.allocations.a].generation==original_generation,"missing live clip metadata rejects whole batch before earlier cancel")
 live_b.clip_metadata={"activate":{"events":[]}}
 var recursive=[]
 Engine.set_meta("phase_preflight_callback",func(): recursive.append(live.apply_batch(live_batch)))
 check(live.apply_batch(live_batch) and not recursive.is_empty() and recursive.all(func(value): return value==false),"scene instantiation cannot recursively apply batch during preflight")
 Engine.remove_meta("phase_preflight_callback")
 var clear_batch=batches[2].duplicate(true)
 Engine.set_meta("phase_preflight_callback",func(): live.clear_assembly())
 check(not live.apply_batch(clear_batch) and live.records.is_empty() and live.native.mounted.is_empty(),"preflight callback clear prevents later batch mutation")
 Engine.remove_meta("phase_preflight_callback")
 live.clear_assembly()
 var armed=setup("fixture",1,clip_profiles,true)[0]
 var armed_calls=[0]
 var armed_revision=armed.revision
 Engine.set_meta("phase_preflight_callback",func():
  armed_calls[0]+=1
  # Two registry candidates, two mount instructions and their two trailing
  # install instructions are preflighted before _mount's seventh check.
  if armed_calls[0]==7: armed.clear_assembly()
 )
 check(not armed.apply_batch(batches[0]) and armed_calls[0]==7 and armed.records.is_empty() and armed.native.mounted.is_empty() and armed.revision==armed_revision,"seventh mount-time scene initialization clear prevents records and counter commit")
 Engine.remove_meta("phase_preflight_callback")
 var phased=setup("fixture",1,{"red":{"install":{"duration":0.4,"phases":[{"id":"redReady","time":0}]}},"blue":{"replace":{"duration":0.6,"phases":[{"id":"blueReady","time":0},{"id":"blueLock","time":0.3}]}}})[0]
 var phases=[]
 phased.transition_phase.connect(func(id,socket,operation,phase,generation): phases.append([id,socket,operation,phase,generation]))
 check(phased.apply_batch(batches[0]),"profile initial batch accepted")
 check(phases.size()==2 and phases[0].slice(0,4)==["a","left","install","redReady"] and phases[1].slice(0,4)==["b","right","install","redReady"],"time zero phases resolve logical identities before records commit")
 check(phased.apply_batch(batches[1]),"profile replacement accepted")
 check(phases.size()==3 and phases[2].slice(0,4)==["a","left","replace","blueReady"],"new child replacement profile dispatched once without duplicate install")
 phased.advance(0.3)
 check(phases.size()==4 and phases[3].slice(0,4)==["a","left","replace","blueLock"],"replacement duration and later authored phase preserved")
 var before=phased.component_at("a")
 phased.descriptors.blue.transitions.replace.phases[0]["clip"]="missing"
 var rejected=batches[2].duplicate(true)
 check(not phased.apply_batch(rejected) and phased.component_at("a")==before and phases.size()==4,"malformed saved profile refused before batch mutations")
 phased.clear_assembly()
 var f=setup()
 var c=f[0]
 var identity=f[1].get_instance_id()
 var unsupported=batches[0].duplicate(true)
 unsupported.plan.instructions[0].inheritance.scale=false
 check(not c.apply_batch(unsupported) and c.records.is_empty() and c.native.mounted.is_empty(),"partial inheritance batch refused atomically")
 check(c.apply_batch(batches[0]),"real planner two arms")
 var reentry=[]
 c.native.transition_finished.connect(func(_socket,_kind): reentry.append(c.apply_batch(batches[1])),CONNECT_ONE_SHOT)
 c.advance(0.2)
 check(reentry==[false] and c.revision==batches[0].revision,"native completion cannot reenter batch mutation")
 check(c.component_at("a")!=null and c.component_at("b")!=null,"two visible arms")
 check(c.component_at("a").get_node("Skeleton")!=c.component_at("b").get_node("Skeleton"),"independent skeletons")
 var frame=batches[0].plan.instructions[0].frame
 check(c.component_at("a").get_parent().transform.is_equal_approx(Transform2D(Vector2(frame[0],frame[1]),Vector2(frame[2],frame[3]),Vector2(frame[4],frame[5]))),"full affine mount frame")
 var old=c.component_at("a")
 check(c.apply_batch(batches[1]) and not is_instance_valid(old),"replacement collapses old transition")
 check(c.apply_batch(batches[1]),"identical authoritative replay is idempotent")
 c.advance(0.2)
 check(c.apply_batch(batches[2]),"damage")
 c.advance(0.2)
 check(c.apply_batch(batches[3]),"destroy")
 c.advance(0.1)
 check(c.component_at("a")!=null and c.component_at("a").modulate.a>0,"destroy keeps visible fade")
 c.advance(0.1)
 check(c.component_at("a")==null and c.records.has("a"),"destroy retains authoritative record")
 check(c.apply_batch(batches[4]) and c.component_at("a")!=null,"repair remounts registered scene")
 c.advance(0.2)
 await process_frame
 await RenderingServer.frame_post_draw
 root.get_texture().get_image().save_png("res://assembly.png")
 var bad=batches[5].duplicate(true)
 bad.plan.instructions.append({"action":"unknown"})
 check(not c.apply_batch(bad) and c.component_at("a")!=null,"whole batch preflight before mutation")
 check(c.apply_batch(batches[5]) and c.component_at("a")!=null,"unmount defers deletion through fade")
 c.advance(0.1)
 check(c.apply_batch(batches[6]),"lifecycle cancels pending removal")
 check(c.native.mounted.is_empty(),"lifecycle cleans cancelled unmounted visuals")
 check(f[1].get_instance_id()==identity,"chassis skeleton preserved")
 check(not c.apply_batch(batches[4]),"stale authoritative envelope ignored")
 var conflict=batches[6].duplicate(true)
 conflict.plan.instructions=[]
 check(not c.apply_batch(conflict),"equal revision conflicting batch refused")
 var other=setup()
 check(other[0].apply_batch(batches[0]),"independent second chassis")
 var atomic=other[0]
 var transition_snapshot=atomic.native.transitions.duplicate(true)
 var saved_blue=atomic.descriptors.blue.scene
 for canvas in ["invalid",Vector2.ZERO,Vector2(NAN,16),Vector2(32,16385)]:
  var invalid_scene=fixture(Color.BLUE,canvas)
  atomic.descriptors.blue.scene=invalid_scene
  atomic.native.registry.blue.scene=invalid_scene
  var invalid_metadata=batches[1].duplicate(true)
  # The incumbent is red; validate a later blue mount after cancelling red.
  var mount=batches[0].plan.instructions[0].duplicate(true)
  mount.id="later"
  mount.socket="right"
  mount.type="blue"
  mount.spec="blue.json"
  mount.state.id="later"
  mount.state.socket="right"
  mount.state.type="blue"
  invalid_metadata.plan.instructions=[{"action":"cancel","id":"a"},{"action":"unmount","id":"b"},mount]
  var previous_records=atomic.records.duplicate(true)
  var previous_allocations=atomic.allocations.duplicate(true)
  var previous_a=atomic.component_at("a")
  var previous_b=atomic.component_at("b")
  check(not atomic.apply_batch(invalid_metadata) and not atomic.faulted and not atomic._busy and atomic.records==previous_records and atomic.allocations==previous_allocations and atomic.component_at("a")==previous_a and atomic.component_at("b")==previous_b and atomic.native.transitions==transition_snapshot and atomic.revision==batches[0].revision and atomic.sequence==batches[0].sequence,"later malformed component metadata rejects before prior cancellation or unmount "+str(canvas))
  var unconfigured=load("res://assembly_controller.gd").new()
  atomic.get_parent().add_child(unconfigured)
  check(not unconfigured.configure("badMetadata",atomic.sockets,atomic.descriptors) and unconfigured.native==null and unconfigured.wrappers.is_empty(),"initial malformed component metadata rejected without native allocation "+str(canvas))
  unconfigured.free()
 atomic.descriptors.blue.scene=saved_blue
 atomic.native.registry.blue.scene=saved_blue
 var malformed=batches[1].duplicate(true)
 malformed.plan.instructions=[{"action":"cancel","id":"a"},{"action":"transition","id":"a","kind":"repair","state":"invalid"}]
 check(not atomic.apply_batch(malformed) and not atomic._busy and atomic.native.transitions==transition_snapshot,"invalid later transition state rejects whole batch without busy latch")
 for field in ["revision","upgrade","id","extra"]:
  var state=atomic.records.a.state.duplicate(true)
  state[field]=INF if field=="revision" else ("wrong" if field in ["upgrade","id"] else true)
  malformed.plan.instructions=[{"action":"cancel","id":"a"},{"action":"update","id":"a","state":state}]
  check(not atomic.apply_batch(malformed) and not atomic._busy and atomic.native.transitions==transition_snapshot,"typed bounded whole state rejects "+field)
 malformed.plan.instructions=[{"action":"lifecycle","kind":"removed"},{"action":"update","id":"a","state":atomic.records.a.state.duplicate(true)}]
 check(not atomic.apply_batch(malformed) and not atomic._busy and atomic.component_at("a")!=null,"removed then update rejected before lifecycle mutation")
 c.clear_assembly()
 check(other[0].component_at("a")!=null,"independent cleanup")
 var invalid=load("res://assembly_controller.gd").new()
 c.get_parent().add_child(invalid)
 var unsupported_sockets=c.sockets.duplicate(true)
 unsupported_sockets.left.capacity=65
 check(not invalid.configure("fixture",unsupported_sockets,c.descriptors) and invalid.native==null,"unsupported capacity rejected before native setup")
 for capacity in [0,1.5,"2",true,65]:
  var malformed_controller=load("res://assembly_controller.gd").new()
  c.get_parent().add_child(malformed_controller)
  var registry=c.sockets.duplicate(true)
  registry.left.capacity=capacity
  check(not malformed_controller.configure("fixture",registry,c.descriptors) and malformed_controller.native==null and malformed_controller.wrappers.is_empty(),"invalid capacity rejected before mutation "+str(capacity))
 var budget=load("res://assembly_controller.gd").new()
 c.get_parent().add_child(budget)
 var budget_sockets=c.sockets.duplicate(true)
 budget_sockets.left.capacity=64
 check(not budget.configure("fixture",budget_sockets,c.descriptors) and budget.native==null and budget.wrappers.is_empty(),"aggregate65 rejected before mutation")
 budget_sockets.left.capacity=63
 check(budget.configure("fixture",budget_sockets,c.descriptors) and budget.wrappers.size()==64 and budget._physical_ready(),"aggregate64 exact budget accepted")
 budget.set_process(false)
 var destroyed=setup()[0]
 for index in range(4):
  check(destroyed.apply_batch(batches[index]),"destroyed bookkeeping fixture "+str(index))
  destroyed.advance(0.1 if index==3 else 0.2)
 check(destroyed.apply_batch(batches[7]),"revision only update during destroy")
 destroyed.advance(0.2)
 check(destroyed.component_at("a")==null,"destroyed revision update cannot cancel removal permanently")
 check(destroyed.apply_batch(batches[8]),"upgrade while destroyed")
 destroyed.advance(0.2)
 check(destroyed.component_at("a")==null and destroyed.records.a.state.upgrade==1,"destroyed upgrade remains hidden with authoritative record")
 check(destroyed.apply_batch(batches[9]) and destroyed.component_at("a")!=null,"repair after hidden upgrade remounts")
 var multi=setup("fixture",2)[0]
 var pair=JSON.parse_string(FileAccess.get_file_as_string("res://multi.json"))
 check(multi.apply_batch(pair),"capacity2 exact capacity succeeds")
 if multi.records.size()==2:
  multi.advance(0.2)
  var a=multi.component_at("a")
  var b=multi.component_at("b")
  check(a!=b and a.get_parent()!=b.get_parent(),"same socket independent private wrappers")
  check(a.get_parent().position!=b.get_parent().position,"distinct frames retained")
  var overflow=pair.duplicate(true)
  overflow.revision+=1
  overflow.sequence+=1
  var third=pair.plan.instructions[0].duplicate(true)
  third.id="third"
  third.state.id="third"
  third.frame[4]+=60
  overflow.plan.instructions=[third]
  check(not multi.apply_batch(overflow) and multi.component_at("a")==a and multi.component_at("b")==b,"capacity overflow atomic sibling preservation")
  var coincident=overflow.duplicate(true)
  coincident.plan.instructions=[{"action":"unmount","id":"a"},third]
  coincident.plan.instructions[1].frame=pair.plan.instructions[2].frame.duplicate()
  check(not multi.apply_batch(coincident) and multi.component_at("a")==a,"coincident frame whole preflight rejects")
  var revision=pair.revision
  for kind in ["damage","upgrade","destroy","repair"]:
   revision+=1
   var state=multi.records.a.state.duplicate(true)
   state.revision+=1
   state.damageState="destroyed" if kind=="destroy" else "intact"
   if kind=="upgrade": state.upgrade+=1
   var update={"revision":revision,"sequence":revision,"plan":{"version":1,"instanceId":"fixture","preserveChassis":true,"instructions":[{"action":"cancel","id":"a"},{"action":"transition","id":"a","kind":kind,"state":state}]}}
   var owned_slot=multi.allocations.a
   check(multi.apply_batch(update),"same socket "+kind)
   multi.advance(0.2)
   check(multi.component_at("b")==b,"sibling retained through "+kind)
   check(multi.allocations.a==owned_slot,"destroyed authoritative allocation retained "+kind)
  revision+=1
  var remove={"revision":revision,"sequence":revision,"plan":{"version":1,"instanceId":"fixture","preserveChassis":true,"instructions":[{"action":"transition","id":"a","kind":"remove"},{"action":"unmount","id":"a"}]}}
  check(multi.apply_batch(remove) and multi.pending.has("a"),"pending fade holds allocation")
  revision+=1
  var replacement=pair.plan.instructions[0].duplicate(true)
  replacement.id="third"
  replacement.state.id="third"
  remove.revision=revision
  remove.sequence=revision
  remove.plan.instructions=[replacement]
  check(multi.apply_batch(remove) and not multi.pending.has("a") and multi.component_at("b")==b,"pending fade reclaimed only within same socket")
  revision+=1
  remove.revision=revision
  remove.sequence=revision
  remove.plan.instructions=[{"action":"transition","id":"third","kind":"remove"},{"action":"unmount","id":"third"},replacement]
  check(multi.apply_batch(remove) and not multi.pending.has("third") and multi.component_at("third")!=null and multi.component_at("b")==b,"same ID return retires predecessor fade")
  revision+=1
  remove.revision=revision
  remove.sequence=revision
  remove.plan.instructions=[{"action":"transition","id":"third","kind":"remove"},{"action":"unmount","id":"third"}]
  check(multi.apply_batch(remove),"second pending fade accepted")
  multi.advance(0.2)
  check(not multi.allocations.has("third") and multi.component_at("b")==b,"finished pending fade releases only owned slot")
  var sibling_slot=multi.allocations.b
  multi.socket_slots.left[0]=multi.socket_slots.left[1]
  check(not multi._physical_ready(),"duplicate private allocation registry rejected")
  multi.socket_slots.left[0]="@left:0"
  check(multi._physical_ready() and multi.allocations.b==sibling_slot,"private slot mapping restored without sibling change")
  multi.clear_assembly()
  check(multi.allocations.is_empty() and multi.pending.is_empty() and multi.native.mounted.is_empty(),"private allocation cleanup")
 var out=FileAccess.open("res://validation.json",FileAccess.WRITE)
 out.store_string(JSON.stringify({"checks":checks}))
 quit(0 if checks.all(func(v): return v.passed) else 1)
