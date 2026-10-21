extends RefCounted
# Samples authored bone poses in a script-free private graph. It deliberately
# does not certify renderer skinning, runtime constraints, blends or actions.
const UNCOVERED = ["attachments", "triangles", "strain", "frameJumps", "runtimeConstraints", "actionGeometry", "mixerBlends", "assemblyTransitions", "movingAttachments", "skinnedVertices"]

static func invalid(message):
	return {"ok":false,"error":{"code":"INVALID_NATIVE_TELEMETRY","message":message}}

static func token(value):
	if not value is String or value.length() < 1 or value.length() > 64: return false
	var regex = RegEx.new()
	regex.compile("^[A-Za-z][A-Za-z0-9_-]*$")
	return regex.search(value) != null

static func local_path(value):
	if not value is String or value.length() < 1 or value.length() > 512 or ":" in value or value.begins_with("/") or "\\" in value: return false
	for part in value.split("/"):
		if part in ["", ".", ".."]: return false
	return true

static func point(value: Vector2, scale: float):
	var p = value * scale
	if not is_finite(p.x) or not is_finite(p.y) or absf(p.x) > 1000000 or absf(p.y) > 1000000: return null
	return [p.x,p.y]

static func collect(source, request, parent):
	if not source is Node2D or not parent is Node or not parent.is_inside_tree() or not request is Dictionary: return invalid("Expected owned scene, sampling parent and request")
	if request.size() != 6 or not request.get("version") is int or request.get("version") != 1 or not request.get("canonicalPixelsPerUnit") is float and not request.get("canonicalPixelsPerUnit") is int: return invalid("Invalid version or fields")
	var scale = float(request.canonicalPixelsPerUnit)
	if not is_finite(scale) or scale <= 0 or scale > 1000000 or not local_path(request.get("skeletonPath")) or not local_path(request.get("playerPath")): return invalid("Invalid scale or node paths")
	if not request.get("meshes") is Array or request.meshes.size() > 128 or not request.get("loops") is Array or request.loops.size() > 32: return invalid("Collection budget")
	var skeleton = source.get_node_or_null(NodePath(request.skeletonPath))
	var source_player = source.get_node_or_null(NodePath(request.playerPath))
	if not skeleton is Skeleton2D or not source_player is AnimationPlayer or source_player.get_node_or_null(source_player.root_node) != source: return invalid("Unsupported skeleton or player root")
	var bone_count = skeleton.get_bone_count()
	if bone_count < 1 or bone_count > 128 or bone_count * request.loops.size() > 4096: return invalid("Bone or loop budget")
	var bones = []
	var bone_paths = {}
	var source_map = {"attachments":{},"weights":{},"joints":{},"loops":{}}
	for i in bone_count:
		var bone = skeleton.get_bone(i)
		if not bone is Bone2D or (bone.get_parent() != skeleton and not bone.get_parent() in bones): return invalid("Unsupported bone hierarchy")
		var bone_path = str(source.get_path_to(bone))
		bones.append(bone)
		bone_paths[bone_path] = i
		source_map.joints["joint%d" % i] = bone_path
	var telemetry = {"version":1,"thresholdVersion":"telemetry-v1","attachments":[],"weights":[],"triangles":[],"inversionExceptions":[],"loopEndpoints":[],"frameJumpThresholds":[],"frameJumps":[]}
	var ids = {}
	var paths = {}
	var vertex_count = 0
	var elements = 0
	for entry in request.meshes:
		if not entry is Dictionary or (entry.size() != 2 and entry.size() != 3) or (entry.size() == 3 and not entry.has("restAnchor")) or not token(entry.get("id")) or not local_path(entry.get("path")) or ids.has(entry.id) or paths.has(entry.path): return invalid("Invalid mesh declaration")
		ids[entry.id] = true
		paths[entry.path] = true
		var mesh = source.get_node_or_null(NodePath(entry.path))
		if not mesh is Polygon2D or mesh.get_node_or_null(mesh.skeleton) != skeleton or mesh.polygon.is_empty() or mesh.get_bone_count() < 1 or mesh.get_bone_count() > 128: return invalid("Unbound native mesh")
		if entry.has("restAnchor"):
			var anchor = entry.restAnchor
			if not anchor is Array or anchor.size() != 2: return invalid("Invalid mesh rest anchor")
			for coordinate in anchor:
				if (not coordinate is float and not coordinate is int) or not is_finite(float(coordinate)) or absf(float(coordinate)) > 1000000: return invalid("Invalid mesh rest anchor")
			var measured = point(source.to_local(mesh.to_global(mesh.polygon[0])), scale)
			if measured == null: return invalid("Invalid observed mesh rest anchor")
			var attachment_id = "attachment%d" % telemetry.attachments.size()
			telemetry.attachments.append({"id":attachment_id,"phase":"rest","expected":anchor.duplicate(),"actual":measured})
			source_map.attachments[attachment_id] = {"meshId":entry.id,"path":entry.path,"vertex":0}
		vertex_count += mesh.polygon.size()
		elements += mesh.polygon.size() * mesh.get_bone_count()
		if vertex_count > 8192 or elements > 262144: return invalid("Weight inspection budget")
		var sums = []
		sums.resize(mesh.polygon.size())
		sums.fill(0.0)
		var mesh_bones = {}
		for index in mesh.get_bone_count():
			var bone = skeleton.get_node_or_null(mesh.get_bone_path(index))
			if not bone in bones or mesh_bones.has(bone): return invalid("Invalid mesh bone binding")
			mesh_bones[bone] = true
			var weights = mesh.get_bone_weights(index)
			if weights.size() != sums.size(): return invalid("Weight array length differs")
			for vertex in weights.size():
				if not is_finite(weights[vertex]) or weights[vertex] < 0 or weights[vertex] > 1000000: return invalid("Invalid native weight")
				sums[vertex] += weights[vertex]
		for vertex in sums.size():
			var id = "weight%d" % telemetry.weights.size()
			if sums[vertex] > 1000000: return invalid("Invalid native weight sum")
			telemetry.weights.append({"id":id,"sum":sums[vertex]})
			source_map.weights[id] = {"meshId":entry.id,"path":entry.path,"vertex":vertex}
	var clips = []
	var key_count = 0
	var excluded_tracks = 0
	ids.clear()
	for entry in request.loops:
		if not entry is Dictionary or entry.size() != 2 or not token(entry.get("id")) or not entry.get("animation") is String or entry.animation.length() > 128 or ids.has(entry.id) or not source_player.has_animation(entry.animation): return invalid("Invalid loop declaration")
		ids[entry.id] = true
		var animation = source_player.get_animation(entry.animation)
		if animation.loop_mode == Animation.LOOP_NONE or not is_finite(animation.length) or animation.length <= 0 or animation.length > 60 or animation.get_track_count() > 4096: return invalid("Unsupported loop clip")
		for index in animation.get_track_count():
			key_count += animation.track_get_key_count(index)
			if key_count > 65536: return invalid("Animation key budget")
		var copy = animation.duplicate(true)
		copy.loop_mode = Animation.LOOP_NONE
		for index in copy.get_track_count():
			var track_path = copy.track_get_path(index)
			var target_path = str(track_path.get_concatenated_names())
			var accepted = copy.track_get_type(index) == Animation.TYPE_VALUE and track_path.get_subname_count() == 1 and str(track_path.get_subname(0)) in ["position","rotation","scale"] and bone_paths.has(target_path)
			if copy.track_is_enabled(index) and not accepted:
				if bone_paths.has(target_path) and copy.track_get_type(index) not in [Animation.TYPE_METHOD,Animation.TYPE_AUDIO,Animation.TYPE_ANIMATION]: return invalid("Unsupported authored bone track")
				if source.get_node_or_null(NodePath(target_path)) == skeleton: return invalid("Animated skeleton transforms are unsupported")
				excluded_tracks += 1
			if accepted:
				var property = str(track_path.get_subname(0))
				for key in copy.track_get_key_count(index):
					var time = copy.track_get_key_time(index,key)
					var value = copy.track_get_key_value(index,key)
					if not is_finite(time) or time < 0 or time > copy.length: return invalid("Invalid bone key time")
					if property == "rotation":
						if (not value is float and not value is int) or not is_finite(float(value)) or absf(float(value)) > 1000000: return invalid("Invalid bone angle key")
					elif not value is Vector2 or point(value,1.0) == null: return invalid("Invalid bone vector key")
			copy.track_set_enabled(index, accepted and copy.track_is_enabled(index))
		clips.append({"id":entry.id,"animation":entry.animation,"clip":copy})
		source_map.loops[entry.id] = entry.animation
	# Everything before this point is read-only validation of the original graph.
	var private_root = Node2D.new()
	private_root.name = "TelemetryPose"
	var private_skeleton = Skeleton2D.new()
	private_skeleton.name = skeleton.name
	private_root.add_child(private_skeleton)
	# The first subset supports the compiler's direct root Skeleton path only.
	if skeleton.get_parent() != source:
		private_root.free()
		return invalid("Nested skeleton roots are unsupported")
	private_skeleton.transform = skeleton.transform
	var private_bones = []
	for bone in bones:
		var duplicate = Bone2D.new()
		duplicate.name = bone.name
		duplicate.rest = bone.rest
		duplicate.transform = bone.rest
		duplicate.set_autocalculate_length_and_angle(false)
		duplicate.length = bone.length
		if bone.get_parent() == skeleton: private_skeleton.add_child(duplicate)
		else: private_bones[bones.find(bone.get_parent())].add_child(duplicate)
		private_bones.append(duplicate)
	var player = AnimationPlayer.new()
	player.name = "TelemetryPlayer"
	player.callback_mode_process = AnimationMixer.ANIMATION_CALLBACK_MODE_PROCESS_MANUAL
	private_root.add_child(player)
	var library = AnimationLibrary.new()
	for entry in clips: library.add_animation(entry.id, entry.clip)
	player.add_animation_library("", library)
	parent.add_child(private_root)
	var error = ""
	# This clone contains bones only. Validate drawing selection at the same
	# clock with the shared pure helper; only normal rendered frames prove pixels.
	var pose_controller=source.get_node_or_null("PoseController")
	for entry in clips:
		var positions = []
		for time in [0.0,entry.clip.length]:
			if pose_controller!=null:
				var selected=load("res://pose_controller.gd").selection_at(pose_controller.pose_groups,pose_controller.clip_metadata,entry.animation,time)
				if not selected.get("valid",false):
					private_root.free()
					return invalid("Invalid pose drawing selection")
			player.stop()
			for bone in private_bones: bone.transform = bone.rest
			player.play(entry.id, 0.0)
			player.seek(time, true, true)
			player.pause()
			var row = []
			for bone in private_bones:
				var measured = point(private_root.to_local(bone.global_position), scale)
				if measured == null: error = "Nonfinite or oversized sampled pose"
				row.append(measured)
			positions.append(row)
		for i in private_bones.size():
			telemetry.loopEndpoints.append({"id":"loop%d" % telemetry.loopEndpoints.size(),"clipId":entry.id,"jointId":"joint%d" % i,"start":positions[0][i],"end":positions[1][i]})
	private_root.free()
	if error != "": return invalid(error)
	var uncovered = UNCOVERED.duplicate()
	var result = {"ok":true,"version":1,"telemetry":telemetry,"sourceMap":source_map,"collectorCoverage":{"scope":"static-representative-vertex-registration","restAnchors":telemetry.attachments.size(),"weightVertices":vertex_count,"loopJointPairs":telemetry.loopEndpoints.size(),"excludedTracks":excluded_tracks,"uncovered":uncovered}}
	if JSON.stringify(result).to_utf8_buffer().size() > 2097152: return invalid("Telemetry output budget")
	return result
