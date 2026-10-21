extends SceneTree

func _initialize():
	call_deferred("verify")

func verify():
	var request = JSON.parse_string(FileAccess.get_file_as_string("res://probe.json"))
	var checks = []
	checks.append({"name":"pack mounted", "passed":ProjectSettings.load_resource_pack(request.pack, false)})
	for entry in request.files:
		checks.append({"name":"exact capture " + entry.path,"passed":FileAccess.get_sha256("res://" + entry.path) == entry.hash})
	var scene = load(request.rootScene)
	checks.append({"name":"packed scene loaded", "passed":scene is PackedScene})
	if scene is PackedScene:
		var character = scene.instantiate()
		root.add_child(character)
		await process_frame
		checks.append({"name":"skeleton retained", "passed":character.get_node_or_null("Skeleton") is Skeleton2D})
		checks.append({"name":"lossless mesh texture retained", "passed":character.get_node("Meshes/panel").texture is PortableCompressedTexture2D})
		checks.append({"name":"animation tree retained", "passed":character.find_child("AnimationTree",true,false) is AnimationTree})
		checks.append({"name":"runtime script retained", "passed":character.get_script() is GDScript and character.get_node("ActionController").get_script() is GDScript})
	var file = FileAccess.open("res://validation.json",FileAccess.WRITE)
	file.store_string(JSON.stringify({"checks":checks}))
	for check in checks:
		if not check.passed:
			quit(1)
			return
	quit(0)
