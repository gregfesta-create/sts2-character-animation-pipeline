extends SceneTree
var cue_count = 0
func cue(): cue_count += 1
func assign_owners(node, owner_root):
	for child in node.get_children():
		child.owner = owner_root
		assign_owners(child, owner_root)
func _initialize(): call_deferred("run")
func run():
	var source = Node2D.new()
	source.name = "Character"
	source.set_meta("cueCount", 0)
	var skeleton = Skeleton2D.new()
	skeleton.name = "Skeleton"
	source.add_child(skeleton)
	var parent_bone = Bone2D.new()
	parent_bone.name = "root"
	parent_bone.rest = Transform2D.IDENTITY
	parent_bone.set_autocalculate_length_and_angle(false)
	skeleton.add_child(parent_bone)
	var child = Bone2D.new()
	child.name = "hand"
	child.position = Vector2(10, 0)
	child.rest = child.transform
	child.set_autocalculate_length_and_angle(false)
	parent_bone.add_child(child)
	var mesh = Polygon2D.new()
	mesh.name = "Body"
	mesh.polygon = PackedVector2Array([Vector2.ZERO, Vector2(10, 0), Vector2(0, 10)])
	mesh.skeleton = NodePath("../Skeleton")
	mesh.add_bone(NodePath("root"), PackedFloat32Array([1, 0.5, 0]))
	mesh.add_bone(NodePath("root/hand"), PackedFloat32Array([0, 0.5, 1]))
	source.add_child(mesh)
	var player = AnimationPlayer.new()
	player.name = "AnimationPlayer"
	player.callback_mode_process = AnimationMixer.ANIMATION_CALLBACK_MODE_PROCESS_MANUAL
	source.add_child(player)
	var clip = Animation.new()
	clip.length = 1
	clip.loop_mode = Animation.LOOP_LINEAR
	var track = clip.add_track(Animation.TYPE_VALUE)
	clip.track_set_path(track, NodePath("Skeleton/root:position"))
	clip.track_insert_key(track, 0, Vector2.ZERO)
	clip.track_insert_key(track, 0.5, Vector2(5, 0))
	clip.track_insert_key(track, 1, Vector2.ZERO)
	var method = clip.add_track(Animation.TYPE_METHOD)
	clip.track_set_path(method, NodePath("."))
	clip.track_insert_key(method, 0, {"method":"set_meta","args":["cueCount", 1]})
	var library = AnimationLibrary.new()
	library.add_animation("idle", clip)
	player.add_animation_library("", library)
	root.add_child(source)
	player.play("idle")
	player.seek(0.25, true, true)
	player.pause()
	var before = {"position":player.current_animation_position,"parent":parent_bone.transform,"child":child.transform,"loop":clip.loop_mode}
	var options = {"version":1,"canonicalPixelsPerUnit":1.0,"skeletonPath":"Skeleton","playerPath":"AnimationPlayer","meshes":[{"id":"body","path":"Body"}],"loops":[{"id":"idle","animation":"idle"}]}
	var collector = load("res://telemetry.gd")
	assign_owners(source, source)
	var packed = PackedScene.new()
	if packed.pack(source) != OK or ResourceSaver.save(packed, "res://compiled-fixture.tscn") != OK:
		quit(1)
		return
	var reloaded = load("res://compiled-fixture.tscn").instantiate()
	root.add_child(reloaded)
	var compiled_good = collector.collect(reloaded, options, root)
	reloaded.free()
	var good = collector.collect(source, options, root)
	# Evidence IDs name receipts; they need not equal the actual source clip.
	var pose_controller=Node.new()
	pose_controller.name="PoseController"
	pose_controller.set_script(load("res://pose_controller.gd"))
	pose_controller.clip_metadata={"idle":{"duration":1.0,"loop":true,"poseTracks":[]}}
	source.add_child(pose_controller)
	var distinct_options=options.duplicate(true)
	distinct_options.loops=[{"id":"loop0","animation":"idle"}]
	var distinct_loop_id=collector.collect(source,distinct_options,root)
	pose_controller.free()
	clip.track_set_key_value(track, 2, Vector2(2, 0))
	var seam = collector.collect(source, options, root)
	mesh.set_bone_weights(0, PackedFloat32Array([0.5, 0.5, 0]))
	var weights = collector.collect(source, options, root)
	var preserved = player.current_animation_position == before.position and parent_bone.transform == before.parent and child.transform == before.child and clip.loop_mode == before.loop and source.get_meta("cueCount") == 0
	var invalid = collector.collect(source, {"version":1}, root)
	var invalid_options = options.duplicate(true)
	invalid_options.canonicalPixelsPerUnit = 0
	var scale_rejected = collector.collect(source, invalid_options, root).get("ok") == false
	invalid_options.canonicalPixelsPerUnit = 1000000.0
	var oversized_pose_rejected = collector.collect(source, invalid_options, root).get("ok") == false
	invalid_options = options.duplicate(true)
	invalid_options.meshes.append(invalid_options.meshes[0].duplicate())
	var duplicate_rejected = collector.collect(source, invalid_options, root).get("ok") == false
	clip.track_set_key_value(track, 2, Vector2(NAN, 0))
	var nonfinite_rejected = collector.collect(source, options, root).get("ok") == false
	clip.track_set_key_value(track, 2, Vector2(2, 0))
	clip.track_set_key_value(track, 2, Vector2.ZERO)
	mesh.set_bone_weights(0, PackedFloat32Array([1, 0.5, 0]))
	# Numeric rest registration is observed on the actual source Polygon2D.
	source.position = Vector2(71, -23)
	source.rotation = 0.3
	mesh.position = Vector2(3, -4)
	mesh.rotation = PI / 2
	mesh.scale = Vector2(2, 3)
	mesh.polygon = PackedVector2Array([Vector2(1, 2), Vector2(10, 0), Vector2(0, 10)])
	var anchored = options.duplicate(true)
	anchored.canonicalPixelsPerUnit = 2.0
	anchored.meshes[0].restAnchor = [-6.0, -4.0]
	var rest_good = collector.collect(source, anchored, root)
	mesh.position.x += 0.5
	var rest_boundary = collector.collect(source, anchored, root)
	mesh.position.x += 0.1
	var rest_bad = collector.collect(source, anchored, root)
	mesh.position.x -= 0.6
	var exact_options = anchored.duplicate(true)
	exact_options.meshes[0].restAnchor = [0.0,0.0]
	source.transform = Transform2D.IDENTITY
	mesh.transform = Transform2D.IDENTITY
	mesh.polygon[0] = Vector2(0.5,0)
	var exact_boundary = collector.collect(source,exact_options,root)
	source.position = Vector2(71,-23)
	source.rotation = 0.3
	mesh.position = Vector2(3,-4)
	mesh.rotation = PI / 2
	mesh.scale = Vector2(2,3)
	mesh.polygon[0] = Vector2(1,2)
	var rest_preserved = mesh.position.is_equal_approx(Vector2(3,-4)) and mesh.polygon[0] == Vector2(1,2) and source.position == Vector2(71,-23)
	var malformed_anchors_rejected = true
	for anchor in [null, [], [0], [0,0,0], [true,0], ["0",0], [NAN,0], [INF,0], [1000001,0]]:
		var bad = anchored.duplicate(true)
		bad.meshes[0].restAnchor = anchor
		malformed_anchors_rejected = malformed_anchors_rejected and collector.collect(source,bad,root).get("ok") == false
	var bad_fields = anchored.duplicate(true)
	bad_fields.meshes[0].extra = 0
	malformed_anchors_rejected = malformed_anchors_rejected and collector.collect(source,bad_fields,root).get("ok") == false
	var partial_options = anchored.duplicate(true)
	partial_options.meshes.append({"id":"second","path":"Second"})
	var second = mesh.duplicate()
	second.name = "Second"
	source.add_child(second)
	var partial_rest = collector.collect(source,partial_options,root)
	second.free()
	mesh.polygon[0] = Vector2(INF,0)
	var observed_nonfinite_rejected = collector.collect(source,anchored,root).get("ok") == false
	mesh.polygon[0] = Vector2(1000001,0)
	var observed_oversized_rejected = collector.collect(source,anchored,root).get("ok") == false
	mesh.polygon[0] = Vector2(1,2)
	var saved_anchors = PackedScene.new()
	assign_owners(source, source)
	saved_anchors.pack(source)
	ResourceSaver.save(saved_anchors,"res://anchored-fixture.tscn")
	var anchor_loaded = load("res://anchored-fixture.tscn").instantiate()
	root.add_child(anchor_loaded)
	var compiled_rest = collector.collect(anchor_loaded,anchored,root)
	anchor_loaded.free()
	var result = {"partialRest":partial_rest,"observedNonfiniteRejected":observed_nonfinite_rejected,"observedOversizedRejected":observed_oversized_rejected,"exactBoundary":exact_boundary,"restGood":rest_good,"restBoundary":rest_boundary,"restBad":rest_bad,"compiledRest":compiled_rest,"restPreserved":rest_preserved,"malformedAnchorsRejected":malformed_anchors_rejected,"good":good,"compiledGood":compiled_good,"seam":seam,"weights":weights,"preserved":preserved,"cueCount":source.get_meta("cueCount"),"invalidRejected":invalid.get("ok") == false,"scaleRejected":scale_rejected,"oversizedPoseRejected":oversized_pose_rejected,"duplicateRejected":duplicate_rejected,"nonfiniteRejected":nonfinite_rejected,"childCount":root.get_child_count()}
	var output = FileAccess.open("res://result.json", FileAccess.WRITE)
	result.distinctLoopId=distinct_loop_id
	output.store_string(JSON.stringify(result))
	source.free()
	quit(0)
