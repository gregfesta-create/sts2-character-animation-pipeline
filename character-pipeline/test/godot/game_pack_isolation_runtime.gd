extends SceneTree

func snapshot() -> Dictionary:
	var autoloads: Array = []
	for item in ProjectSettings.get_property_list():
		if String(item.name).begins_with("autoload/"):
			autoloads.append(String(item.name))
	var children: Array = []
	for child in root.get_children():
		children.append(String(child.name))
	return {"userData": OS.get_user_data_dir(), "projectName": ProjectSettings.get_setting("application/config/name", ""), "mainScene": str(ProjectSettings.get_setting("application/run/main_scene", "")), "autoloads": autoloads, "children": children}

func _initialize() -> void:
	var input = JSON.parse_string(FileAccess.get_file_as_string("res://input.json"))
	var fixture := Node.new()
	fixture.name = "IsolationFixture"
	root.add_child(fixture)
	var before := snapshot()
	if before.userData.get_file() != input.token or before.projectName != input.token or before.mainScene != "" or not before.autoloads.is_empty():
		push_error("Isolation preflight failed")
		quit(1)
		return
	# Mount data only. Never load a packed game script, class, scene or autoload.
	var mounted := ProjectSettings.load_resource_pack(input.pack, false)
	var after := snapshot()
	var report := {"token": input.token, "mounted": mounted, "before": before, "after": after, "gameStartupExecuted": false}
	# Absolute workspace path survives the mounted pack without res:// ambiguity.
	var output := FileAccess.open(ProjectSettings.globalize_path("res://validation.json"), FileAccess.WRITE)
	output.store_string(JSON.stringify(report))
	output.close()
	quit(0 if mounted and before == after else 1)
