extends SceneTree

func _initialize():
	var request = JSON.parse_string(FileAccess.get_file_as_string("res://request.json"))
	if not request is Dictionary:
		quit(1)
		return
	var maximum_pack_bytes = 65536
	for entry in request.files:
		maximum_pack_bytes += int(ceil(float(entry.size) / 4096.0)) * 4096
		maximum_pack_bytes += int(ceil(float(("res://" + entry.path).to_utf8_buffer().size() + 256) / 4096.0)) * 4096
	if maximum_pack_bytes != request.maximumPackBytes or maximum_pack_bytes > request.maxPackBytes:
		quit(9)
		return
	var packer = PCKPacker.new()
	if packer.pck_start(request.output) != OK:
		quit(2)
		return
	for entry in request.files:
		var source = request.source.path_join(entry.path)
		var input = FileAccess.open(source, FileAccess.READ)
		if input == null or input.get_length() != entry.size or FileAccess.get_sha256(source) != entry.hash:
			quit(3)
			return
		if packer.add_file("res://" + entry.path, source) != OK:
			quit(4)
			return
	if packer.flush() != OK:
		quit(5)
		return
	var output = FileAccess.open(request.output, FileAccess.READ)
	if output == null or output.get_length() > request.maxPackBytes:
		quit(6)
		return
	if not ProjectSettings.load_resource_pack(request.output, false):
		quit(7)
		return
	for entry in request.files:
		var packed = "res://" + entry.path
		var input = FileAccess.open(packed, FileAccess.READ)
		if input == null or input.get_length() != entry.size or FileAccess.get_sha256(packed) != entry.hash:
			quit(8)
			return
	print("PACK_CREATED ", output.get_length())
	quit(0)
