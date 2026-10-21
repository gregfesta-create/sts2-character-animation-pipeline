extends SceneTree
var checks: Array=[]
func check(value,label):
 checks.append({"name":label,"passed":bool(value)})
 if not value: push_error(label)
func _initialize(): call_deferred("run")
func fixture(color,canvas=null,pose=Transform2D.IDENTITY):
 var node=Node2D.new()
 node.transform=pose
 if canvas!=null: node.set_meta("canonical_canvas",canvas)
 node.modulate=Color(0.8,0.9,1.0,0.75)
 var skeleton=Skeleton2D.new()
 skeleton.name="Skeleton"
 node.add_child(skeleton)
 skeleton.owner=node
 var bone=Bone2D.new()
 bone.name="RootBone"
 skeleton.add_child(bone)
 bone.owner=node
 bone.rest=Transform2D.IDENTITY
 bone.length=24
 bone.set_autocalculate_length_and_angle(false)
 var mesh=Polygon2D.new()
 mesh.polygon=PackedVector2Array([Vector2(0,-5),Vector2(24,-5),Vector2(24,5),Vector2(0,5)])
 mesh.color=color
 bone.add_child(mesh)
 mesh.owner=node
 var player=AnimationPlayer.new()
 player.name="Player"
 node.add_child(player)
 player.owner=node
 var lib=AnimationLibrary.new()
 var clip=Animation.new()
 clip.length=1.0
 clip.loop_mode=Animation.LOOP_LINEAR
 var track=clip.add_track(Animation.TYPE_VALUE)
 clip.track_set_path(track,NodePath("Skeleton/RootBone:rotation"))
 clip.track_insert_key(track,0.0,-0.4)
 clip.track_insert_key(track,0.5,0.4)
 clip.track_insert_key(track,1.0,-0.4)
 lib.add_animation("idle",clip)
 player.add_animation_library("",lib)
 var scene=PackedScene.new()
 scene.pack(node)
 node.free()
 return scene
func phase_fixture(tree_mode=false, projectile=false, marker=false):
 var scene=fixture(Color.WHITE,Vector2(80,80))
 var node=scene.instantiate()
 var player=node.get_node("Player")
 player.name="AnimationPlayer"
 var lib=player.get_animation_library("")
 lib.add_animation("activate",lib.get_animation("idle").duplicate(true))
 lib.add_animation("RESET",Animation.new())
 node.set_script(load("res://animation_controller.gd"))
 node.clip_metadata={"idle":{"duration":1.0,"loop":true,"events":[]},"activate":{"duration":1.0,"loop":false,"events":[{"id":"release","time":0.0,"type":"projectile","payload":{}}] if projectile else []}}
 if marker: node.clip_metadata.activate.events=[{"id":"nested","time":0.0,"name":"nested","payload":{}}]
 if tree_mode:
  var tree=AnimationTree.new()
  tree.name="AnimationTree"
  node.add_child(tree)
  tree.owner=node
  tree.anim_player=NodePath("../AnimationPlayer")
  var machine=AnimationNodeStateMachine.new()
  for id in ["idle","activate"]:
   var animation=AnimationNodeAnimation.new()
   animation.animation=id
   machine.add_node(id,animation)
  tree.tree_root=machine
 var packed=PackedScene.new()
 packed.pack(node)
 node.free()
 return packed
func phase_checks(controller):
 controller.clear_components()
 var profile={"install":{"duration":1.0,"phases":[{"id":"start","time":0.0,"clip":"activate"},{"id":"lock","time":0.5},{"id":"reveal","time":0.5},{"id":"done","time":1.0}]},"repair":{"duration":0.0,"phases":[{"id":"instant","time":0.0}]}}
 var observations=[]
 var listener=func(socket,operation,id,generation): observations.append([socket,operation,id,generation])
 controller.transition_phase.connect(listener)
 for mode in [false,true]:
  var id="phases_tree" if mode else "phases_player"
  check(controller.register_component(id,phase_fixture(mode),{"type":"arm0","transitions":profile}),"register phase playback mode "+id)
  check(controller.transition("left","install",id,0.2),"phase install "+id)
  var child=controller.component_at("left")
  check(child.current=="activate" and observations.back()[2]=="start","time zero clip uses ready child owner "+id)
  var count=observations.size()
  controller.advance(0)
  check(observations.size()==count,"zero advance does not repeat phase "+id)
  controller.advance(20)
  check(observations.slice(count).map(func(x): return x[2])==["lock","reveal","done"],"large delta dispatches ties in order "+id)
  check(controller.transition("left","repair") and observations.back()[2]=="instant" and not controller.transitions.has("left"),"zero duration emits then completes "+id)
  controller.clear_components()
 check(not controller.register_component("invalid_phase",phase_fixture(),{"type":"arm0","transitions":{"install":{"duration":1,"phases":[{"id":"x","time":2}]}}}),"invalid phase profile rejected")
 check(not controller.register_component("projectile_phase",phase_fixture(false,true),{"type":"arm0","transitions":profile}),"phase projectile clip rejected before registration")
 check(not controller.register_component("missing_phase",fixture(Color.WHITE),{"type":"arm0","transitions":profile}),"missing child animation owner rejected")
 controller.register_component("phase_cancel",phase_fixture(),{"type":"arm0","transitions":profile})
 controller.transition("left","install","phase_cancel")
 var child=controller.component_at("left")
 controller.cancel_transition("left")
 var count=observations.size()
 controller.advance(2)
 check(observations.size()==count and child.current=="activate","cancel stops phases without rewinding started clip")
 controller.clear_components()
 var clear_listener=func(_socket,_op,id,_generation):
  if id=="start": controller.clear_components()
 controller.transition_phase.connect(clear_listener)
 check(not controller.transition("left","install","phase_cancel") and controller.transitions.is_empty() and controller.component_at("left")==null,"time zero reentrant clear suppresses remaining phases")
 controller.transition_phase.disconnect(clear_listener)
 var replace_listener=func(_socket,_op,id,_generation):
  if id=="start": controller.transition("left","repair","",0)
 controller.transition_phase.connect(replace_listener)
 count=observations.size()
 check(not controller.transition("left","install","phase_cancel"),"reentrant phase replacement abandons original start")
 check(observations.slice(count).map(func(x): return x[2])==["start","instant"] and controller.transitions.is_empty(),"reentrant generation abandons original phases")
 controller.transition_phase.disconnect(replace_listener)
 controller.clear_components()
 var free_listener=func(_socket,_op,id,_generation):
  if id=="start": controller.component_at("left").free()
 controller.transition_phase.connect(free_listener)
 count=observations.size()
 check(not controller.transition("left","install","phase_cancel"),"phase callback can free child")
 controller.advance(2)
 check(observations.size()==count+1 and controller.transitions.is_empty(),"freed child cannot receive crossed phases or completion")
 controller.transition_phase.disconnect(free_listener)
 controller.clear_components()
 for bad in [{"install":{"duration":INF,"phases":[]}}, {"install":{"duration":1,"phases":[{"id":"a","time":0},{"id":"a","time":1}]}} , {"install":{"duration":0,"phases":[],"unknown":true}}]:
  check(not controller.register_component("invalid"+str(checks.size()),phase_fixture(),{"type":"arm0","transitions":bad}),"bounded exact profile rejects malformed data")
 controller.transition("left","install","phase_cancel")
 var incumbent=controller.component_at("left")
 var generation=controller.transitions.left.generation
 controller.registry.phase_cancel.contract.transitions.install.phases[0].clip="missing"
 check(not controller.transition("left","replace","phase_cancel") and controller.component_at("left")==incumbent and controller.transitions.left.generation==generation,"whole profile revalidation preserves incumbent before mutation")
 controller.registry.phase_cancel.contract.transitions.install.phases[0].clip="activate"
 controller.clear_components()
 controller.transition("left","install","phase_cancel")
 controller.transition("right","install","phase_cancel")
 controller.advance(0.25)
 controller.cancel_transition("left")
 var right_generation=controller.transitions.right.generation
 controller.advance(0.25)
 check(controller.transitions.right.generation==right_generation and controller.transitions.right.next_phase==3 and not controller.transitions.has("left"),"sibling phase clocks and cancellation independent")
 controller.clear_components()
 var immutable=profile.duplicate(true)
 controller.register_component("immutable_phases",phase_fixture(),{"type":"arm0","transitions":immutable})
 immutable.install.duration=0
 immutable.install.phases.clear()
 controller.transition("left","install","immutable_phases")
 check(controller.transitions.left.duration==1 and controller.transitions.left.phases.size()==4,"registration captures immutable profile copy")
 controller.clear_components()
 for mode in [false,true]:
  var nested_profile={"repair":{"duration":1.0,"phases":[{"id":"first","time":0.0,"clip":"activate"},{"id":"later","time":0.5},{"id":"last","time":1.0}]}}
  var nested_id="nested_tree" if mode else "nested_player"
  controller.register_component(nested_id,phase_fixture(mode,false,true),{"type":"arm0","transitions":nested_profile})
  controller.transition("left","install",nested_id,0)
  var nested_child=controller.component_at("left")
  var nested_calls=[]
  nested_child.animation_marker.connect(func(_id,_name,_payload): nested_calls.append(controller.advance(1)))
  count=observations.size()
  controller.transition("left","repair")
  check(nested_calls==[false] and controller.transitions.has("left") and controller.transitions.left.elapsed==0 and observations.slice(count).map(func(x): return x[2])==["first"],"animation marker nested advance ignored before phase observation "+nested_id)
  controller.advance(1)
  check(observations.slice(count).map(func(x): return x[2])==["first","later","last"] and not controller.transitions.has("left"),"nested marker preserves authored phase order exactly once "+nested_id)
  controller.clear_components()
 controller.transition_phase.disconnect(listener)
func run():
 var chassis=Node2D.new()
 root.add_child(chassis)
 var skeleton=Skeleton2D.new()
 chassis.add_child(skeleton)
 var identity=skeleton.get_instance_id()
 var sockets={}
 for id in ["left","right"]:
  var socket=Node2D.new()
  socket.name=id
  socket.position=Vector2(50 if id=="left" else 110,48)
  chassis.add_child(socket)
  sockets[id]={"path":NodePath("../"+id),"types":["arm0","arm1","arm2"],"capacity":1,"layer":2,"scale":[1.5,1.0],"mirror":id=="left","events":[]}
 var controller=load("res://component_controller.gd").new()
 chassis.add_child(controller)
 check(controller.configure_sockets(sockets),"configure trusted sockets")
 for i in range(3): check(controller.register_component("arm"+str(i),fixture([Color.RED,Color.GREEN,Color.BLUE][i]),{"type":"arm"+str(i),"events":[]}),"register alternative "+str(i))
 check(controller.component_at("left")==null,"begins empty")
 check(not controller.register_component("bad",fixture(Color.WHITE),{"type":"arm0","events":["x","x"]}),"duplicate events rejected")
 var external=Node2D.new()
 external.name="ExternalMount"
 root.add_child(external)
 var invalid=sockets.duplicate(true)
 invalid.left.path=NodePath("../../ExternalMount")
 check(not controller.configure_sockets(invalid),"outside chassis mount refused")
 var aliased=sockets.duplicate(true)
 aliased.right.path=NodePath("../left")
 check(not controller.configure_sockets(aliased),"aliased physical socket refused")
 check(controller.configure_sockets(sockets),"valid sockets survive refusal")
 check(not controller.transition("left","install","unknown",0),"unregistered resource refused")
 for i in range(3):
  check(controller.transition("left","install" if i==0 else "replace","arm"+str(i),0.1),"alternative mounts")
  controller.advance(0.05)
  check(controller.component_at("left").modulate.a>0 and controller.component_at("left").modulate.a<1,"visible transition midpoint")
  controller.advance(0.05)
 check(controller.transition("right","install","arm0",0),"second arm")
 var other_chassis=Node2D.new()
 root.add_child(other_chassis)
 var other_socket=Node2D.new()
 other_socket.name="Socket"
 other_chassis.add_child(other_socket)
 var other=load("res://component_controller.gd").new()
 other_chassis.add_child(other)
 check(other.configure_sockets({"left":{"path":NodePath("../Socket"),"types":["arm0"],"capacity":1}}),"second chassis sockets with omitted optional defaults")
 check(other.register_component("arm0",fixture(Color.WHITE),{"type":"arm0","events":[]}) and other.transition("left","install","arm0",0),"second chassis component")
 check(other.component_at("left")!=controller.component_at("left"),"multiple chassis isolate instances")
 var left=controller.component_at("left")
 var right=controller.component_at("right")
 check(left.transform.x==Vector2(-1.5,0) and left.transform.y==Vector2(0,1),"mirrored scaled mount")
 var lp=left.get_node("Player")
 var rp=right.get_node("Player")
 lp.play("idle")
 rp.play("idle")
 lp.advance(0.125)
 rp.advance(0.125)
 skeleton.rotation=0.2
 check(abs(left.get_node("Skeleton/RootBone").rotation)>0.01 and abs(right.get_node("Skeleton/RootBone").rotation)>0.01 and skeleton.rotation>0,"concurrent component and body motion")
 check(left.get_node("Skeleton")!=right.get_node("Skeleton") and lp!=rp,"independent component skeletons and players")
 await process_frame
 await RenderingServer.frame_post_draw
 root.get_texture().get_image().save_png("res://concurrent.png")
 check(controller.transition("left","destroy","",0.2),"destroy starts")
 controller.advance(0.1)
 check(controller.cancel_transition("left"),"cancel destruction")
 check(left.modulate==Color(0.8,0.9,1.0,0.75) and controller.component_at("left")==left,"interrupted destruction restores original tint")
 for op in ["repair","upgrade"]:
  check(controller.transition("left",op,"arm1" if op=="upgrade" else "",0.1),op)
  controller.advance(0.1)
 check(controller.transition("left","remove","",0.1),"remove")
 controller.advance(0.1)
 check(controller.component_at("left")==null,"removed cleaned immediately")
 check(skeleton.get_instance_id()==identity,"chassis skeleton identity preserved")
 await process_frame
 await RenderingServer.frame_post_draw
 root.get_texture().get_image().save_png("res://components.png")
 controller.clear_components()
 check(controller.component_at("right")==null and controller.transitions.is_empty(),"cleanup cancels all transitions")
 check(is_instance_valid(other.component_at("left")),"other chassis survives cleanup")
 check(controller.transition("left","install","arm0",0.1) and controller.transition("right","install","arm1",0.1),"callback fixture mounts")
 controller.transition_finished.connect(func(_socket,_operation): controller.clear_components(),CONNECT_ONE_SHOT)
 check(controller.advance(0.1) and controller.transitions.is_empty() and controller.component_at("left")==null and controller.component_at("right")==null,"completion callback safely clears remaining transitions")
 controller.transition("left","install","arm0",0.1)
 controller.transition("right","install","arm1",0.2)
 controller.transition_finished.connect(func(_socket,_operation):
  controller.cancel_transition("right")
  controller.transition("right","repair","",0.5)
 ,CONNECT_ONE_SHOT)
 check(controller.advance(0.1) and controller.transitions.right.kind=="repair" and controller.transitions.right.elapsed==0.0,"callback replacement waits until next advance")
 controller.clear_components()
 check(controller.register_component("moving",fixture(Color.WHITE,Vector2(160,80)),{"type":"arm0"}),"register moving component")
 check(controller.transition("left","install","moving",1.0),"approach starts")
 var moving=controller.component_at("left")
 var baseline=Transform2D(Vector2(-1.5,0),Vector2(0,1),Vector2.ZERO)
 check(moving.position==Vector2(0,-10),"approach starts canonical offset")
 controller.advance(0.25)
 check(moving.position.is_equal_approx(Vector2(0,-8.4375)),"approach uses smoothstep")
 controller.cancel_transition("left")
 check(moving.transform==baseline and moving.modulate==Color(0.8,0.9,1.0,0.75),"cancel approach restores exact baseline and tint")
 moving.transform=Transform2D(Vector2(-2,1),Vector2(0.5,3),Vector2(7,9))
 var sheared=moving.transform
 check(controller.transition("left","remove","",1),"reverse removal starts")
 controller.advance(0.5)
 check(moving.transform.origin.is_equal_approx(sheared.origin+sheared.basis_xform(Vector2(0,-5))),"remove offset follows mirrored sheared basis")
 controller.cancel_transition("left")
 check(moving.transform==sheared,"cancel removal restores exact sheared transform")
 for canvas in [Vector2.ZERO,Vector2(-1,4),Vector2(16385,4),Vector2(NAN,4),Vector2(4,INF),Vector2(4,-1),Vector2(4,16385),"bad"]:
  var id="badcanvas"+str(controller.registry.size())
  check(controller.register_component(id,fixture(Color.WHITE,canvas),{"type":"arm0"}),"register invalid metadata candidate")
  controller.transition("left","repair","",1)
  controller.advance(0.2)
  var tint=moving.modulate
  var generation=controller.transitions.left.generation
  check(not controller.transition("left","replace",id,1),"invalid metadata refuses replacement")
  check(controller.component_at("left")==moving and moving.modulate==tint and moving.transform==sheared and controller.transitions.left.generation==generation,"invalid metadata preserves incumbent transition")
 controller.cancel_transition("left")
 controller.transition("left","upgrade","moving",0)
 check(controller.component_at("left").transform==baseline,"zero duration upgrade ends canonical")
 controller.transition("left","remove","",0)
 check(controller.component_at("left")==null,"zero duration removal clears")
 controller.transition("left","install","arm0",1)
 check(controller.component_at("left").position==Vector2.ZERO,"legacy component remains fade only")
 controller.clear_components()
 chassis.transform=Transform2D(0.7,Vector2(2,0.5),0.3,Vector2(30,-20))
 chassis.get_node("left").transform=Transform2D(-0.2,Vector2(0.7,2),0.15,Vector2(-10,30))
 var wrapper=chassis.get_node("left").transform
 controller.transition("left","install","moving",1)
 controller.transition("right","install","moving",1)
 var ml=controller.component_at("left")
 var mr=controller.component_at("right")
 controller.advance(0.25)
 var right_pose=mr.transform
 controller.cancel_transition("left")
 check(ml.transform==baseline and mr.transform==right_pose and controller.transitions.has("right"),"concurrent slots isolate cancellation under transformed ancestors")
 check(chassis.get_node("left").transform==wrapper,"approach never modifies authoritative wrapper")
 controller.advance(0.75)
 check(mr.transform==Transform2D(Vector2(1.5,0),Vector2(0,1),Vector2.ZERO),"completion restores exact baseline under transformed ancestors")
 check(not controller.advance(NAN) and not controller.transition("left","remove","",INF),"invalid timing remains rejected")
 controller.clear_components()
 var authored=Transform2D(0.4,Vector2(2,3),0.25,Vector2(4,6))
 var rotated_scene=fixture(Color.WHITE,Vector2(80,160),authored)
 var expected=rotated_scene.instantiate()
 expected.scale=Vector2(-1.5,1)
 var expected_pose=expected.transform
 expected.free()
 controller.register_component("rotated",rotated_scene,{"type":"arm0"})
 controller.transition("left","install","rotated",1)
 var rotated=controller.component_at("left")
 check(rotated.transform.origin.is_equal_approx(expected_pose.origin+expected_pose.basis_xform(Vector2(0,-10))),"install follows authored rotated sheared basis after socket scale")
 controller.advance(1)
 check(rotated.transform==expected_pose,"install restores exact authored basis")
 controller.transition("left","remove","",1)
 controller.advance(0.25)
 check(rotated.transform.origin.is_equal_approx(expected_pose.origin+expected_pose.basis_xform(Vector2(0,-1.5625))),"removal reverses smoothstep approach")
 controller.transition("left","repair","",0)
 check(rotated.transform==expected_pose and rotated.modulate==Color(0.8,0.9,1,0.75),"reentry cancels movement before capturing next baseline")
 controller.transition("left","replace","moving",1)
 controller.advance(1)
 check(controller.component_at("left").transform==baseline,"marked replacement returns canonical")
 controller.clear_components()
 phase_checks(controller)
 var f=FileAccess.open("res://validation.json",FileAccess.WRITE)
 f.store_string(JSON.stringify({"checks":checks}))
 f.close()
 quit(0 if checks.all(func(c): return c.passed) else 1)





