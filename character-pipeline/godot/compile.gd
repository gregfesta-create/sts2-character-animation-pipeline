extends SceneTree
const TextureStorage=preload("res://texture_storage.gd")

var bones = {}
var paths = {}
var frames = []
var stored_textures = {}

# Isolation owns only the reloaded preview subtree. Every descendant mode is
# frozen, including children with explicit PROCESS_MODE_ALWAYS.
func collect_part_masks(scene, viewport, requests):
	var nodes = [scene]
	var cursor = 0
	while cursor < nodes.size() and nodes.size() <= 32768:
		nodes.append_array(nodes[cursor].get_children())
		cursor += 1
	if nodes.size() > 32768 or requests.size() > 64:
		return {"error":"Part mask isolation budget exceeded","captures":[]}
	for request in requests:
		if not scene.has_node("Meshes/" + request.partId) or not request.id is float or request.id < 0 or request.id > 63 or request.id != floor(request.id):
			return {"error":"Invalid part mask request","captures":[]}
	var modes = []
	var visibility = []
	for node in nodes:
		modes.append(node.process_mode)
		visibility.append(node.visible if node is CanvasItem else null)
	for node in nodes: node.process_mode = Node.PROCESS_MODE_DISABLED
	var captures = []
	var failure = ""
	for request in requests:
		if failure != "": break
		var selected = scene.get_node("Meshes/" + request.partId)
		var keep = {}
		var ancestor = selected
		while ancestor != null:
			keep[ancestor] = true
			if ancestor == scene: break
			ancestor = ancestor.get_parent()
		for index in nodes.size():
			if nodes[index] is CanvasItem: nodes[index].visible = keep.has(nodes[index])
		await RenderingServer.frame_post_draw
		var image = viewport.get_texture().get_image()
		var filename = "part-mask-%d.png" % int(request.id)
		var saved_mask = image.save_png("res://" + filename)
		if saved_mask != OK:
			failure = "Part mask PNG save failed"
		else:
			captures.append({"id":int(request.id),"partId":request.partId,"clipId":request.clipId,"time":request.time,"frameIndex":request.frameIndex,"path":filename,"width":image.get_width(),"height":image.get_height(),"sha256":FileAccess.get_sha256("res://" + filename)})
	# One cleanup path; no return or quit while any isolation state is active.
	var restored = true
	for index in nodes.size():
		if nodes[index] is CanvasItem: nodes[index].visible = visibility[index]
		nodes[index].process_mode = modes[index]
	for index in nodes.size():
		restored = restored and nodes[index].process_mode == modes[index]
		if nodes[index] is CanvasItem: restored = restored and nodes[index].visible == visibility[index]
	if not restored: failure = "Part mask isolation restoration failed"
	return {"error":failure,"captures":captures,"restored":restored,"nodeCount":nodes.size()}

func stored_texture(file):
	var hash=FileAccess.get_sha256(file)
	if stored_textures.has(hash): return stored_textures[hash]
	var image=Image.load_from_file(file)
	var texture=TextureStorage.from_image(image)
	if texture!=null: stored_textures[hash]=texture
	return texture

func vec(a):
	return Vector2(a[0], a[1])

func own(node, parent, root):
	parent.add_child(node)
	node.owner = root

func observed_canvas_order(node):
	return {"zIndex":node.z_index,"zAsRelative":node.is_z_relative(),"showBehindParent":node.is_draw_behind_parent_enabled(),"topLevel":node.is_set_as_top_level(),"ySortEnabled":node.is_y_sort_enabled()}

func effect_atlas_frames(texture: Texture2D, animation) -> Array:
	if texture==null or not animation is Dictionary or animation.size()!=5: return []
	for key in ["columns","rows","frameCount","durations","loop"]:
		if not animation.has(key): return []
	for key in ["columns","rows","frameCount"]:
		var value = animation[key]
		if not (value is int or value is float) or not is_finite(float(value)) or value<1 or value>64 or value!=floor(value): return []
	var columns: int = int(animation.columns)
	var rows: int = int(animation.rows)
	var count: int = int(animation.frameCount)
	if count<2 or count!=columns*rows or not animation.loop is bool or not animation.durations is Array or animation.durations.size()!=count: return []
	var total: float = 0.0
	for duration in animation.durations:
		if not (duration is int or duration is float) or not is_finite(float(duration)) or duration<1.0/240.0 or duration>10.0: return []
		total+=float(duration)
		if total>10.0: return []
	var width: int = texture.get_width()
	var height: int = texture.get_height()
	if width<1 or height<1 or width>4096 or height>4096 or width%columns!=0 or height%rows!=0: return []
	var cell_width: int = width/columns
	var cell_height: int = height/rows
	if cell_width<1 or cell_height<1 or cell_width*cell_height*count>16777216: return []
	var result: Array = []
	for index in range(count):
		var frame := AtlasTexture.new()
		frame.atlas=texture
		frame.region=Rect2((index%columns)*cell_width,(index/columns)*cell_height,cell_width,cell_height)
		frame.filter_clip=true
		result.append(frame)
	return result

func effect_overlay_presentation(p) -> Dictionary:
	var texture=stored_texture("res://effect-"+p.resourceHash+".png")
	if texture==null: return {}
	if p.has("animation"):
		var frames=effect_atlas_frames(texture,p.animation)
		if frames.is_empty(): return {}
		return {"frames":frames,"durations":p.animation.durations,"loop":p.animation.loop,"offset":vec(p.offset),"scale":vec(p.scale)}
	return {"texture":texture,"offset":vec(p.offset),"scale":vec(p.scale)}

func _initialize():
	call_deferred("compile_character")

func restore_plan_numbers(spec):
	var entries = spec.get("planNumberBits", [])
	if not entries is Array or entries.size() > 8192: return false
	var seen = {}
	for entry in entries:
		if not entry is Dictionary or entry.size() != 2 or not entry.has("path") or not entry.has("hex"): return false
		var keys = entry.path
		var hex = entry.hex
		if not keys is Array or keys.size() < 2 or keys.size() > 16 or not keys[0] in ["motionPlan", "maskPlan", "nativeRestAnchors", "renderLayout"]: return false
		if not hex is String or hex.length() != 16: return false
		for digit in hex:
			if not digit in "0123456789abcdef": return false
		var identity = JSON.stringify(keys)
		if seen.has(identity): return false
		seen[identity] = true
		var target = spec
		for index in keys.size():
			var key = keys[index]
			if target is Dictionary:
				if not key is String or key.length() > 4096 or not target.has(key): return false
			elif target is Array:
				if not key is float or key < 0 or key != floor(key) or key >= target.size(): return false
				key = int(key)
			else: return false
			if index == keys.size() - 1:
				if not target[key] is float: return false
				var number = hex.hex_decode().decode_double(0)
				if not is_finite(number): return false
				target[key] = number
			else:
				target = target[key]
	return true

func compile_character():
	var spec = JSON.parse_string(FileAccess.get_file_as_string("res://spec.json"))
	if not spec is Dictionary or not restore_plan_numbers(spec):
		push_error("Invalid compiler plan numeric transport")
		quit(2)
		return
	var root = Node2D.new()
	root.name = "Character"
	root.set_meta("canonical_canvas", Vector2(spec.canvas.width, spec.canvas.height))
	var skeleton = Skeleton2D.new()
	skeleton.name = "Skeleton"
	own(skeleton, root, root)
	var remaining = spec.bones.duplicate()
	while remaining.size():
		for b in remaining.duplicate():
			if b.parent != null and not bones.has(b.parent):
				continue
			var bone = Bone2D.new()
			bone.name = b.id
			bone.position = vec(b.rest.position)
			bone.rotation = b.rest.rotation
			bone.scale = vec(b.rest.scale)
			bone.rest = bone.transform
			bone.set_autocalculate_length_and_angle(false)
			bone.length = b.length
			if b.has("limits"):
				bone.set_script(load("res://limited_bone.gd"))
				bone.set_meta("joint_limits", b.limits)
			own(bone, skeleton if b.parent == null else bones[b.parent], root)
			bones[b.id] = bone
			paths[b.id] = str(root.get_path_to(bone))
			remaining.erase(b)
	get_root().add_child(root)
	await process_frame
	var meshes = Node2D.new()
	meshes.name = "Meshes"
	own(meshes, root, root)
	for part in spec.parts:
		var poly = Polygon2D.new()
		poly.name = part.id
		poly.z_index = part.layer
		poly.texture = stored_texture("res://" + part.image.path)
		if poly.texture==null:
			push_error("Part texture decode or lossless storage failed")
			quit(1)
			return
		var vertices = PackedVector2Array()
		var uv = PackedVector2Array()
		var weights = []
		if part.has("mesh"):
			for v in part.mesh.vertices:
				var local = (vec(v) - vec(part.image.pivot)) / part.image.pixelsPerUnit
				vertices.append(bones[part.bone].global_transform * local)
			for v in part.mesh.uv:
				uv.append(vec(v))
			weights = part.mesh.weights
			var triangles = []
			for triangle in part.mesh.triangles:
				triangles.append(PackedInt32Array(triangle))
			poly.polygons = triangles
		else:
			var im = part.image
			for v in [[0,0],[im.width,0],[im.width,im.height],[0,im.height]]:
				uv.append(vec(v))
				var local = (vec(v) - vec(im.pivot)) / im.pixelsPerUnit
				vertices.append(bones[part.bone].global_transform * local)
				weights.append([{"bone":part.bone,"weight":1.0}])
		poly.polygon = vertices
		poly.uv = uv
		own(poly, meshes, root)
		poly.skeleton = NodePath("../../Skeleton")
		for id in bones:
			var values = PackedFloat32Array()
			var used = false
			for influences in weights:
				var w = 0.0
				for influence in influences:
					if influence.bone == id:
						w += influence.weight
				values.append(w)
				used = used or w > 0
			if used:
				poly.add_bone(skeleton.get_path_to(bones[id]), values)
	var player = AnimationPlayer.new()
	var audio_resources = {}
	var audio_checks = []
	for sound in spec.get("sounds", []):
		var info = spec.audioMetadata[sound.id]
		var stream = AudioStreamWAV.load_from_file("res://" + sound.path) if info.format == "wav" else AudioStreamOggVorbis.load_from_file("res://" + sound.path)
		if stream == null or absf(stream.get_length() - info.duration) > maxf(1.0 / info.sampleRate, 0.00001):
			push_error("Native audio load or duration validation failed: " + sound.id)
			quit(1)
			return
		if stream is AudioStreamWAV: stream.loop_mode = AudioStreamWAV.LOOP_DISABLED
		else: stream.loop = false
		var resource_path = "res://" + sound.path.get_basename() + ".res"
		if ResourceSaver.save(stream, resource_path) != OK:
			push_error("Cannot save runtime audio resource")
			quit(1)
			return
		audio_resources[sound.id] = {"stream":load(resource_path),"volumeDb":sound.get("volumeDb",0.0),"pitch":sound.get("pitch",1.0)}
		audio_checks.append({"id":sound.id,"format":info.format,"duration":stream.get_length(),"resource":resource_path})
	var audio_controller = Node.new()
	audio_controller.name = "AudioController"
	audio_controller.set_script(load("res://audio_controller.gd"))
	audio_controller.sounds = audio_resources
	own(audio_controller, root, root)
	player.name = "AnimationPlayer"
	own(player, root, root)
	var library = AnimationLibrary.new()
	var metadata = {}
	var reset = Animation.new()
	reset.length = 0.001
	for b in spec.bones:
		for property in ["position", "rotation", "scale"]:
			var ri = reset.add_track(Animation.TYPE_VALUE)
			reset.track_set_path(ri, NodePath(paths[b.id] + ":" + property))
			reset.track_insert_key(ri, 0, vec(b.rest[property]) if b.rest[property] is Array else b.rest[property])
	library.add_animation("RESET", reset)
	for clip in spec.animations:
		metadata[clip.id] = {"duration":clip.duration,"loop":clip.loop,"events":clip.events,"blendIn":clip.get("blendIn",0.0),"poseTracks":clip.get("poseTracks",[])}
		var animation = Animation.new()
		animation.length = clip.duration
		animation.loop_mode = Animation.LOOP_LINEAR if clip.loop else Animation.LOOP_NONE
		# Every clip owns every transform, avoiding stale values after interruption.
		for b in spec.bones:
			for property in ["position", "rotation", "scale"]:
				var supplied = false
				for track in clip.tracks:
					supplied = supplied or (track.bone == b.id and track.property == property)
				if not supplied:
					var base = animation.add_track(Animation.TYPE_VALUE)
					animation.track_set_path(base, NodePath(paths[b.id] + ":" + property))
					animation.track_insert_key(base, 0, vec(b.rest[property]) if b.rest[property] is Array else b.rest[property])
		for track in clip.tracks:
			var index = animation.add_track(Animation.TYPE_VALUE)
			animation.track_set_path(index, NodePath(paths[track.bone] + ":" + track.property))
			for key in track.keys:
				var transition = {"linear":1.0,"in":2.0,"out":0.5,"inOut":-2.0,"step":0.0}.get(key.get("easing","linear"),1.0)
				animation.track_insert_key(index, key.time, vec(key.value) if key.value is Array else key.value, transition)
		library.add_animation(clip.id, animation)
	player.add_animation_library("", library)
	var action_controller=Node2D.new()
	action_controller.name="ActionController"
	action_controller.set_script(load("res://action_controller.gd"))
	action_controller.bone_paths=paths.duplicate()
	action_controller.polylines=spec.get("polylines",[])
	var sockets={}
	for socket in spec.get("sockets",[]):
		var mount=Node2D.new()
		mount.name="Socket_"+socket.id
		mount.position=vec(socket.transform.position)
		mount.rotation=socket.transform.rotation
		mount.scale=vec(socket.transform.scale)
		own(mount,bones[socket.bone],root)
		sockets[socket.id]=str(root.get_path_to(mount))
	action_controller.socket_paths=sockets
	var part_paths={}
	for part in spec.parts: part_paths[part.id]="Meshes/"+part.id
	# Bind before entering the tree so child readiness and idle initialization
	# share one visibility compositor, retaining flat Meshes/<part> paths.
	var pose_controller=Node.new()
	pose_controller.name="PoseController"
	pose_controller.set_script(load("res://pose_controller.gd"))
	pose_controller.pose_groups=spec.get("poseGroups",[])
	pose_controller.clip_metadata=metadata.duplicate(true)
	pose_controller.part_paths=part_paths.duplicate()
	own(pose_controller,root,root)
	action_controller.part_paths=part_paths
	var visual_states=Node.new()
	visual_states.name="VisualStateController"
	visual_states.set_script(load("res://visual_state_controller.gd"))
	visual_states.part_paths=part_paths.duplicate()
	var state_definitions={}
	for state in spec.get("visualStates",[]): state_definitions[state.id]=state.parts.duplicate()
	visual_states.states=state_definitions
	own(visual_states,root,root)
	var projectile_definitions={}
	for definition in spec.get("projectiles",[]):
		var part={}
		for candidate in spec.parts:
			if candidate.id==definition.part: part=candidate
		var source=root.get_node(part_paths[part.id])
		var visual=Polygon2D.new()
		visual.texture=source.texture
		visual.uv=source.uv
		visual.polygons=source.polygons
		visual.z_index=part.layer
		var vertices=PackedVector2Array()
		if part.has("mesh"):
			for point in part.mesh.vertices: vertices.append((vec(point)-vec(part.image.pivot))/part.image.pixelsPerUnit)
		else:
			for point in [[0,0],[part.image.width,0],[part.image.width,part.image.height],[0,part.image.height]]: vertices.append((vec(point)-vec(part.image.pivot))/part.image.pixelsPerUnit)
		visual.polygon=vertices
		var prototype=PackedScene.new()
		prototype.pack(visual)
		visual.free()
		var entry=definition.duplicate(true)
		entry.visual=prototype
		projectile_definitions[definition.id]=entry
	action_controller.projectile_definitions=projectile_definitions
	own(action_controller,root,root)
	root.set_script(load("res://animation_controller.gd"))
	root.set_process(false)
	root.clip_metadata = metadata
	var aliases = {}
	for pair in [["Idle","idle"],["Attack","attack"],["Cast","cast"],["Hit","hit"],["Dead","death"],["Revive","revive"]]:
		if library.has_animation(pair[1]) and not library.has_animation(pair[0]):
			library.add_animation(pair[0], library.get_animation(pair[1]))
			aliases[pair[0]] = pair[1]
	root.aliases = aliases
	if spec.export.get("playback","player") == "tree":
		var tree = AnimationTree.new()
		tree.name = "AnimationTree"
		own(tree, root, root)
		tree.anim_player = NodePath("../AnimationPlayer")
		var machine = AnimationNodeStateMachine.new()
		machine.allow_transition_to_self = true
		for id in metadata.keys() + aliases.keys():
			var node = AnimationNodeAnimation.new()
			node.animation = id
			machine.add_node(id,node)
		for from in metadata.keys() + aliases.keys():
			for to in metadata.keys() + aliases.keys():
				if from != to:
					var transition = AnimationNodeStateMachineTransition.new()
					transition.reset = true
					transition.xfade_time = float(metadata[aliases.get(to,to)].get("blendIn",0.0))
					machine.add_transition(from,to,transition)
		tree.tree_root = machine
		tree.active = false
		# Recursive discovery must always encounter the persistent body tree first.
		root.move_child(tree,0)
	if spec.has("assembly"):
		var assembly=Node2D.new()
		assembly.name="AssemblyController"
		assembly.set_script(load("res://assembly_boot.gd"))
		assembly.planner_registry=spec.assembly.registry
		var socket_definitions={}
		for socket in spec.sockets:
			if socket.id not in spec.assembly.sockets: continue
			# Planner frame already includes socket.transform; mount directly on bone.
			var mount=Node2D.new()
			mount.name="AssemblyMount_"+socket.id
			own(mount,bones[socket.bone],root)
			socket_definitions[socket.id]={"path":str(root.get_path_to(mount)),"capacity":socket.capacity,"inheritance":socket.inheritance,"types":socket.types}
		assembly.socket_definitions=socket_definitions
		var definitions={}
		for descriptor in spec.assembly.descriptors:
			definitions[descriptor.type]={"scene":load("res://"+spec.assembly.scenes[descriptor.type]),"spec":descriptor.spec,"events":descriptor.eventNames}
			if descriptor.has("transitions"): definitions[descriptor.type].transitions=descriptor.transitions.duplicate(true)
		assembly.scene_definitions=definitions
		own(assembly,root,root)
	if library.has_animation("idle") and spec.export.get("playback","player") == "player":
		player.autoplay = "idle"
	var effect_checks={"configured":false,"capabilities":[],"resourceHashes":[],"gameBindings":false}
	if spec.has("effectBuild"):
		var controller=Node.new()
		controller.name="EffectController"
		controller.set_script(load("res://effect_boot.gd"))
		controller.compiled_plan=spec.effectBuild.runtimePlan
		var catalog=[]
		for effect in spec.effectBuild.catalog:
			var entry={"id":effect.id,"capability":effect.capability,"presentation":{}}
			var p=effect.presentation
			if effect.capability=="tint": entry.presentation.color=Color(p.color[0],p.color[1],p.color[2],p.color[3])
			else:
				entry.presentation=effect_overlay_presentation(p)
				if entry.presentation.is_empty():
					push_error("Effect overlay image or animation atlas is invalid")
					quit(1)
					return
			if effect.has("impact"):
				var impact_presentation=effect_overlay_presentation(effect.impact.presentation)
				if impact_presentation.is_empty():
					push_error("Impact overlay image or animation atlas is invalid")
					quit(1)
					return
				entry.impact={"durationSeconds":effect.impact.durationSeconds,"presentation":impact_presentation}
			catalog.append(entry)
			if effect.capability not in effect_checks.capabilities: effect_checks.capabilities.append(effect.capability)
			for hash in effect.resourceHashes:
				if hash not in effect_checks.resourceHashes: effect_checks.resourceHashes.append(hash)
		controller.compiled_catalog=catalog
		var targets={}
		for id in spec.effectBuild.targets: targets[id]=NodePath("Meshes/"+spec.effectBuild.targets[id].partId)
		controller.compiled_targets=targets
		own(controller,root,root)
	var packed = PackedScene.new()
	packed.pack(root)
	var saved = ResourceSaver.save(packed,"res://character.tscn")
	root.queue_free()
	await process_frame
	var reloaded = load("res://character.tscn").instantiate()
	reloaded.preview_silent = true
	# An isolated render target avoids desktop window minimum-size clamping.
	var preview_viewport = get_root()
	if spec.has("renderLayout"):
		preview_viewport = SubViewport.new()
		preview_viewport.size = Vector2i(int(spec.renderLayout.pixels[0]),int(spec.renderLayout.pixels[1]))
		preview_viewport.transparent_bg = true
		preview_viewport.disable_3d = true
		preview_viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
		get_root().add_child(preview_viewport)
	preview_viewport.add_child(reloaded)
	if spec.has("renderLayout"):
		var preview_scale = float(spec.renderLayout.scale)
		preview_viewport.canvas_transform = Transform2D(Vector2(preview_scale,0),Vector2(0,preview_scale),Vector2.ZERO)
	reloaded.set_process(false)
	var test_tree = reloaded.get_node_or_null("AnimationTree")
	if test_tree: test_tree.active = false
	var reload_player = reloaded.get_node("AnimationPlayer")
	await process_frame
	reload_player.pause()
	var layer_order = null
	if "render" in OS.get_cmdline_user_args():
		var layer_container = reloaded.get_node("Meshes")
		var layer_children = layer_container.get_children()
		if layer_children.size() > 128:
			push_error("Native layer observation budget exceeded")
			quit(1)
			return
		layer_order = {"version":1,"root":observed_canvas_order(reloaded),"container":observed_canvas_order(layer_container),"parts":[]}
		for child in layer_children:
			if not child is Polygon2D:
				push_error("Unexpected native main part child")
				quit(1)
				return
			var observed = observed_canvas_order(child)
			observed.merge({"id":str(child.name),"path":str(reloaded.get_path_to(child)),"index":child.get_index()})
			layer_order.parts.append(observed)
	var native_valid = saved == OK
	var assembly_checks={"configured":false,"productionUnbound":true,"preview":false,"gameBindings":false}
	if spec.has("assembly"):
		var assembly=reloaded.get_node("AssemblyController")
		assembly_checks.configured=assembly.ready_for_state
		assembly_checks.productionUnbound=assembly.native==null and assembly.revision==-1 and assembly.sequence==-1 and assembly.records.is_empty() and assembly.get_state().is_empty()
		native_valid=native_valid and assembly_checks.configured and assembly_checks.productionUnbound
		if "render" in OS.get_cmdline_user_args():
			assembly_checks.preview=assembly.start_preview(spec.assembly.previewSnapshot)
			assembly_checks.previewComponents=assembly.records.size()
			native_valid=native_valid and assembly_checks.preview
	if spec.has("effectBuild"):
		var effects=reloaded.get_node("EffectController")
		effect_checks.configured=effects.ready_for_effects
		effect_checks.owner=effects.status().get("characterInstance","" )
		native_valid=native_valid and effect_checks.configured
		if spec.effectBuild.catalog.any(func(effect): return effect.has("impact")):
			var impact_status=effects.impact_status()
			effect_checks.impactConfigured=impact_status.configured
			effect_checks.impactEffectIds=impact_status.effectIds
			native_valid=native_valid and effect_checks.impactConfigured
	var mesh_checks = []
	for part in spec.parts:
		var polygon = reloaded.get_node("Meshes/" + part.id)
		var positions = []
		for vertex in polygon.polygon:
			positions.append([vertex.x, vertex.y])
		var sums = []
		for vertex in polygon.polygon.size():
			var total = 0.0
			for index in polygon.get_bone_count():
				total += polygon.get_bone_weights(index)[vertex]
			native_valid = native_valid and absf(total - 1.0) < 0.00001
			sums.append(total)
		mesh_checks.append({
			"part": part.id,
			"path": str(reloaded.get_path_to(polygon)),
			"positions": positions,
			"vertices": polygon.polygon.size(),
			"bones": polygon.get_bone_count(),
			"weight_sums": sums,
			"uv": Array(polygon.uv)
		})
	var geometry_checks = {"requested":false,"status":"not-requested"}
	if "render" in OS.get_cmdline_user_args():
		var geometry_meshes = []
		var geometry_loops = []
		for entry in spec.nativeRestAnchors: geometry_meshes.append(entry)
		for clip in spec.animations:
			if clip.loop: geometry_loops.append({"id":clip.id,"animation":clip.id})
		geometry_checks={"requested":true,"result":load("res://telemetry.gd").collect(reloaded,{"version":1,"canonicalPixelsPerUnit":1.0,"skeletonPath":"Skeleton","playerPath":"AnimationPlayer","meshes":geometry_meshes,"loops":geometry_loops},get_root())}
	var limit_checks = []
	for b in spec.bones:
		if b.has("limits"):
			var bone = reloaded.get_node(paths[b.id])
			bone.rotation = b.limits[1] + 1.0
			await process_frame
			native_valid = native_valid and absf(bone.rotation-b.limits[1]) < 0.00001
			limit_checks.append({"bone":b.id,"rotation":bone.rotation,"maximum":b.limits[1]})
			bone.rotation = b.rest.rotation
	var skinning = null
	var skin_skeleton = reloaded.get_node("Skeleton")
	if "render" in OS.get_cmdline_user_args():
		skinning = {"version":1,"bones":[],"meshes":[],"samples":[]}
		# These observations use the compiler's identity mesh/skeleton frame subset.
		native_valid = native_valid and reloaded.transform == Transform2D.IDENTITY and skin_skeleton.transform == Transform2D.IDENTITY and reloaded.get_node("Meshes").transform == Transform2D.IDENTITY
		var vertex_count = 0
		var triangle_count = 0
		for index in skin_skeleton.get_bone_count():
			var bone = skin_skeleton.get_bone(index)
			skinning.bones.append({"id":str(bone.name),"path":str(reloaded.get_path_to(bone)),"index":bone.get_index_in_skeleton()})
		for part in spec.parts:
			if not part.has("mesh"): continue
			var polygon = reloaded.get_node("Meshes/" + part.id)
			native_valid = native_valid and polygon.transform == Transform2D.IDENTITY and polygon.offset == Vector2.ZERO
			var positions = []
			var triangles = []
			var influences = []
			for vertex in polygon.polygon:
				positions.append([vertex.x,vertex.y])
				influences.append([])
			for triangle in polygon.polygons: triangles.append(Array(triangle))
			for index in polygon.get_bone_count():
				var bone = skin_skeleton.get_node(polygon.get_bone_path(index))
				var weights = polygon.get_bone_weights(index)
				for vertex in weights.size():
					if weights[vertex] > 0: influences[vertex].append({"bone":str(bone.name),"weight":weights[vertex]})
			for entry in influences: native_valid = native_valid and entry.size() > 0 and entry.size() <= 4
			vertex_count += positions.size()
			triangle_count += triangles.size()
			skinning.meshes.append({"part":part.id,"path":str(reloaded.get_path_to(polygon)),"positions":positions,"triangles":triangles,"influences":influences})
		native_valid = native_valid and skinning.bones.size() <= 128 and skinning.meshes.size() <= 128 and vertex_count <= 8192 and triangle_count <= 16384
		if not native_valid:
			push_error("Native skinning coordinate frames or collection bounds are invalid")
			quit(1)
			return
	var mask_captures = []
	var mask_cleanup = []
	var samples = []
	for clip_index in range(spec.animations.size()):
		var clip = spec.animations[clip_index]
		var sample_times = [0.0, clip.duration * 0.5]
		var preview_animation = reload_player.get_animation(clip.id)
		var original_loop = preview_animation.loop_mode
		if spec.has("motionPlan") and spec.motionPlan != null:
			sample_times = spec.motionPlan.clips[clip_index].times
			# Canonical exact endpoint must not wrap looping animations to zero.
			preview_animation.loop_mode = Animation.LOOP_NONE
		for time in sample_times:
			reload_player.play(clip.id)
			reload_player.seek(time,true)
			reload_player.pause()
			await process_frame
			var pose_result=reloaded.get_node("PoseController").apply_pose(clip.id,time)
			if not pose_result:
				push_error("Native pose drawing selection failed")
				quit(1)
				return
			var transforms = {}
			for id in paths:
				var b = reloaded.get_node(paths[id])
				transforms[id] = [b.global_position.x,b.global_position.y,b.global_rotation]
			samples.append({"clip":clip.id,"time":time,"bones":transforms})
			if "render" in OS.get_cmdline_user_args():
				await RenderingServer.frame_post_draw
				var skin_matrices = {}
				for entry in skinning.bones:
					var matrix = RenderingServer.skeleton_bone_get_transform_2d(skin_skeleton.get_skeleton(),entry.index)
					skin_matrices[entry.id] = [matrix.x.x,matrix.x.y,matrix.y.x,matrix.y.y,matrix.origin.x,matrix.origin.y]
				skinning.samples.append({"clip":clip.id,"time":time,"matrices":skin_matrices})
				if skinning.samples.size() > 64 or skinning.samples.size() * skinning.bones.size() > 8192:
					push_error("Native skinning sample budget exceeded")
					quit(1)
					return
				var filename = "frame-%s-%s.png" % [clip.id, frames.size()]
				preview_viewport.get_texture().get_image().save_png("res://"+filename)
				frames.append(filename)
				var mask_requests = []
				for request in spec.get("maskPlan",{}).get("captures",[]):
					if request.frameIndex == frames.size() - 1: mask_requests.append(request)
				if not mask_requests.is_empty():
					var isolated = await collect_part_masks(reloaded,preview_viewport,mask_requests)
					mask_cleanup.append({"frameIndex":frames.size()-1,"restored":isolated.get("restored",false),"nodeCount":isolated.get("nodeCount",0)})
					if isolated.error != "":
						var cleanup_file = FileAccess.open("res://mask-cleanup.json",FileAccess.WRITE)
						cleanup_file.store_string(JSON.stringify(mask_cleanup))
						cleanup_file.close()
						push_error(isolated.error)
						quit(1)
						return
					mask_captures.append_array(isolated.captures)
		preview_animation.loop_mode = original_loop
	mask_captures.sort_custom(func(a,b): return a.id < b.id)
	var result = {
		"valid": native_valid,
		"motionPlan": spec.get("motionPlan",null),
		"renderLayout": spec.get("renderLayout",null),
		"renderProjection": {"pixels":[preview_viewport.size.x,preview_viewport.size.y],"transform":[preview_viewport.canvas_transform.x.x,preview_viewport.canvas_transform.x.y,preview_viewport.canvas_transform.y.x,preview_viewport.canvas_transform.y.y,preview_viewport.canvas_transform.origin.x,preview_viewport.canvas_transform.origin.y]},
		"audio": audio_checks,
		"geometry": geometry_checks,
		"effects": effect_checks,
		"assembly": assembly_checks,
		"reload": true,
		"bone_count": bones.size(),
		"meshes": mesh_checks,
		"limits": limit_checks,
		"samples": samples,
		"skinning": skinning,
		"layerOrder": layer_order,
		"maskCaptures": mask_captures,
		"maskCleanup": mask_cleanup,
		"frames": frames
	}
	var file = FileAccess.open("res://validation.json",FileAccess.WRITE)
	file.store_string(JSON.stringify(result,"",true,true))
	file.close()
	# Release scene-owned voices before shutdown; deferred quit lets this
	# coroutine drop its temporary resource references before engine cleanup.
	var preview_audio = reloaded.get_node_or_null("AudioController")
	if preview_audio: preview_audio.stop_all()
	reloaded.queue_free()
	if preview_viewport != get_root(): preview_viewport.queue_free()
	await process_frame
	await process_frame
	call_deferred("quit", 0 if native_valid else 1)



