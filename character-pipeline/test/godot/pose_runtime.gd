extends SceneTree

var checks=[]
func check(value,label):
	checks.append({"name":label,"passed":bool(value)})
	if not value: push_error(label)

func _initialize(): call_deferred("run")

func fixture():
	var scene=Node2D.new()
	for id in ["body","open","forward","arrow"]:
		var part=Polygon2D.new()
		part.name=id
		scene.add_child(part)
	var pose=Node.new()
	pose.name="PoseController"
	pose.set_script(load("res://pose_controller.gd"))
	pose.part_paths={"body":NodePath("body"),"open":NodePath("open"),"forward":NodePath("forward"),"arrow":NodePath("arrow")}
	pose.pose_groups=[{"id":"wings","parts":["open","forward"],"defaultPart":"open"}]
	pose.clip_metadata={"idle":{"duration":1.0,"loop":true},"attack":{"duration":1.0,"loop":false,"poseTracks":[{"group":"wings","keys":[{"time":0.0,"part":"open"},{"time":0.4,"part":"forward"}]}]},"loop":{"duration":1.0,"loop":true,"poseTracks":[{"group":"wings","keys":[{"time":0.0,"part":"open"},{"time":0.4,"part":"forward"}]}]}}
	scene.add_child(pose)
	root.add_child(scene)
	return scene

func animated_fixture():
	var scene=fixture()
	root.remove_child(scene)
	scene.set_script(load("res://animation_controller.gd"))
	scene.request_ready()
	var pose=scene.get_node("PoseController")
	var metadata=pose.clip_metadata.duplicate(true)
	metadata["death"]={"duration":1.0,"loop":false,"poseTracks":metadata.attack.poseTracks}
	for id in metadata: metadata[id]["events"]=[]
	metadata.attack.events=[{"id":"atKey","name":"atKey","time":0.4,"payload":{}}]
	metadata.attack["blendIn"]=0.2
	scene.clip_metadata=metadata
	pose.clip_metadata=metadata
	var player=AnimationPlayer.new()
	player.name="AnimationPlayer"
	var library=AnimationLibrary.new()
	for id in ["RESET","idle","attack","loop","death"]:
		var animation=Animation.new()
		animation.length=1.0
		animation.loop_mode=Animation.LOOP_LINEAR if id in ["idle","loop"] else Animation.LOOP_NONE
		library.add_animation(id,animation)
	player.add_animation_library("",library)
	scene.add_child(player)
	var state=Node.new()
	state.name="VisualStateController"
	state.set_script(load("res://visual_state_controller.gd"))
	state.part_paths=pose.part_paths.duplicate()
	state.states={"bodyOnly":["body"],"all":["body","open","forward","arrow"]}
	scene.add_child(state)
	var action=Node2D.new()
	action.name="ActionController"
	action.set_script(load("res://action_controller.gd"))
	action.part_paths=pose.part_paths.duplicate()
	scene.add_child(action)
	root.add_child(scene)
	scene.set_process(false)
	return scene

func run():
	if not ResourceLoader.exists("res://pose_controller.gd"):
		check(false,"pose compositor exists")
	else:
		var a=fixture()
		var b=fixture()
		var p=a.get_node("PoseController")
		check(p.apply_pose("idle",0) and a.get_node("open").visible and not a.get_node("forward").visible,"default exclusive drawing")
		check(p.apply_pose("attack",0.4) and a.get_node("forward").visible and not a.get_node("open").visible,"exact key selects incoming drawing")
		check(p.apply_pose("attack",0.1) and a.get_node("open").visible,"backward seek stateless")
		p.apply_pose("loop",1.5)
		check(a.get_node("forward").visible,"loop wraps")
		p.apply_pose("attack",8)
		check(a.get_node("forward").visible,"nonloop holds endpoint")
		p.set_state_selection(["body","open","arrow"])
		check(not a.get_node("forward").visible,"state and pose intersect")
		p.clear_state_selection()
		check(a.get_node("forward").visible and not a.get_node("open").visible,"state clear retains exclusive pose")
		p.set_action_hidden("forward",true)
		check(not a.get_node("forward").visible,"action veto")
		p.apply_pose("idle",0)
		p.clear_action_hidden()
		check(a.get_node("open").visible and not a.get_node("forward").visible,"cancel does not reveal inactive pose")
		check(b.get_node("PoseController").apply_pose("attack",0.5) and a.get_node("open").visible,"instances isolated")
		var b_pose=b.get_node("PoseController")
		b_pose.part_paths.erase("body")
		b_pose.part_paths["replacement"]=NodePath("body")
		check(not b_pose.apply_pose("idle",0) and b_pose.last_error.code=="POSE_BINDING_MISSING" and b.get_node("forward").visible,"equal-size binding membership replacement rejected atomically")
		a.get_node("forward").free()
		check(not p.apply_pose("attack",0.5) and p.last_error.code=="POSE_BINDING_MISSING" and a.get_node("open").visible,"missing binding fails before partial visibility mutation")
		a.free()
		b.free()
		var animated=animated_fixture()
		var observed=[]
		animated.animation_marker.connect(func(_id,_name,_payload): observed.append(animated.get_node("forward").visible))
		check(animated.get_node("open").visible and not animated.get_node("forward").visible,"controller idle default")
		animated.play_animation("attack")
		animated.advance_animation(0.5)
		check(observed==[true] and animated.get_node("forward").visible,"pose selection precedes cue dispatch during incoming blend")
		animated.seek_animation(0.1)
		check(animated.get_node("open").visible and observed.size()==1,"backward controller seek silent")
		animated.seek_animation(0.7)
		var states=animated.get_node("VisualStateController")
		states.set_visual_state("bodyOnly")
		states.clear_visual_state()
		check(animated.get_node("forward").visible and not animated.get_node("open").visible,"visual controller baseline includes all authored parts")
		var actions=animated.get_node("ActionController")
		actions.context={"actionInstance":"synthetic"}
		check(not states.set_visual_state("bodyOnly") and states.last_error.code=="VISUAL_STATE_ACTION_ACTIVE","active action state guard retained")
		actions.context={}
		actions.nocked_visibility={NodePath("forward"):true}
		animated.get_node("PoseController").set_action_hidden("forward",true)
		animated.get_node("PoseController").apply_pose("idle",0)
		actions.cancel_action()
		check(animated.get_node("open").visible and not animated.get_node("forward").visible,"action controller cancel only removes veto")
		animated.play_animation("death")
		animated.advance_animation(1.1)
		check(animated.held and animated.get_node("forward").visible,"death holds final drawing")
		animated.cancel_action()
		check(animated.current=="idle" and animated.get_node("open").visible,"interrupt returns idle default")
		animated.play_animation("loop")
		animated.advance_animation(1.5)
		check(animated.get_node("forward").visible,"controller loop selection")
		animated.play_animation("attack")
		animated.advance_animation(1.1)
		check(animated.current=="idle" and animated.get_node("open").visible,"nonloop action returns idle drawing")
		var before_generation=animated.cue_generation
		var before_clock=animated.elapsed
		actions.context={"actionInstance":"preserved"}
		actions.pending=[{"id":"preserved"}]
		animated.get_node("PoseController").set_action_hidden("forward",true)
		actions.nocked_visibility={NodePath("forward"):true}
		animated.get_node("forward").free()
		check(not animated.play_animation("death") and animated.current=="idle" and animated.cue_generation==before_generation and animated.elapsed==before_clock,"play binding failure preserves controller generation and clip")
		check(not actions.cancel_action() and actions.context.get("actionInstance")=="preserved" and actions.pending.size()==1 and not actions.nocked_visibility.is_empty(),"cancel binding failure preserves action ownership and pending cues")
		check(not animated.seek_animation(0.4) and actions.context.get("actionInstance")=="preserved" and animated.elapsed==before_clock,"seek binding failure preserves action and playhead")
		animated.free()
		var release_scene=animated_fixture()
		var release_action=release_scene.get_node("ActionController")
		var socket=Node2D.new()
		socket.name="socket"
		release_scene.add_child(socket)
		release_action.socket_paths={"muzzle":NodePath("socket")}
		var visual=PackedScene.new()
		var visual_node=Node2D.new()
		visual.pack(visual_node)
		visual_node.free()
		release_action.projectile_definitions={"arrow":{"lifetime":2.0,"forward":[1,0],"visual":visual}}
		release_action.context={"actionInstance":"release","target":{"valid":true,"position":[10,0]},"releaseAt":0.4,"impactAt":0.8}
		release_action.action_clock=0.4
		release_action.evaluation_clock=0.4
		release_action.ledger={"release":{"releases":{},"impact_sounds":{}}}
		var released=[]
		release_action.projectile_released.connect(func(_action,_cue,_projectile): released.append(true))
		var payload={"projectile":"arrow","sourceSocket":"muzzle","nockedPart":"arrow"}
		check(release_action.queue_projectile("releaseCue",payload),"queue valid release before binding disappears")
		release_scene.get_node("forward").free()
		release_action.advance_pose(0)
		check(release_action.active_projectile_count()==0 and release_action.ledger.release.releases.is_empty() and released.is_empty() and release_scene.get_node("arrow").visible,"removed pose binding before queued release does not spawn consume or emit")
		release_scene.free()
	var file=FileAccess.open("res://validation.json",FileAccess.WRITE)
	file.store_string(JSON.stringify({"checks":checks}))
	quit(0 if checks.all(func(c):return c.passed) else 1)
