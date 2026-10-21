extends SceneTree

var walked = 0
var objects = {}

func walk(value, depth: int, root_resource: Resource, packet: Resource) -> bool:
	walked += 1
	if walked > 65536 or depth > 16: return false
	if value is Object:
		if value == null: return true
		if value != root_resource and value != packet: return false
		if value.get_script() != null: return false
		var identity = value.get_instance_id()
		if objects.has(identity): return true
		objects[identity] = true
		for key in value.get_meta_list():
			if not walk(value.get_meta(key), depth + 1, root_resource, packet): return false
		for property in value.get_property_list():
			if int(property.usage) & PROPERTY_USAGE_STORAGE:
				if not walk(value.get(property.name), depth + 1, root_resource, packet): return false
	elif value is Array:
		if value.size() > 65536: return false
		for child in value:
			if not walk(child, depth + 1, root_resource, packet): return false
	elif value is Dictionary:
		if value.size() > 256: return false
		for key in value:
			if not walk(key, depth + 1, root_resource, packet) or not walk(value[key], depth + 1, root_resource, packet): return false
	elif value is PackedByteArray:
		if value.size() > 16 * 1024 * 1024: return false
	elif value is PackedInt64Array:
		if value.size() > 65536: return false
	elif typeof(value) not in [TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING, TYPE_STRING_NAME]:
		return false
	return true

func inspect(entry: Dictionary):
	var file = "res://" + entry.path
	var input = FileAccess.open(file, FileAccess.READ)
	if input == null or input.get_length() != entry.size or FileAccess.get_sha256(file) != entry.hash: return null
	# Dependencies are rejected before any native resource deserialization.
	var dependencies = ResourceLoader.get_dependencies(file)
	if not dependencies.is_empty(): return null
	var stream = ResourceLoader.load(file, "", ResourceLoader.CACHE_MODE_IGNORE)
	if stream == null or stream.get_class() not in ["AudioStreamWAV", "AudioStreamOggVorbis"] or stream.get_script() != null: return null
	var packet = null
	var rate = 0
	var channels = 0
	var frames = null
	var granule = null
	var format_name = "wav"
	if stream.get_class() == "AudioStreamWAV":
		if stream.format != AudioStreamWAV.FORMAT_16_BITS or stream.loop_mode != AudioStreamWAV.LOOP_DISABLED: return null
		rate = stream.mix_rate
		channels = 2 if stream.stereo else 1
		if stream.data.size() % (channels * 2) != 0: return null
		frames = stream.data.size() / (channels * 2)
	else:
		format_name = "ogg-vorbis"
		if stream.loop: return null
		packet = stream.packet_sequence
		if packet == null or packet.get_class() != "OggPacketSequence" or packet.get_script() != null: return null
		rate = packet.sampling_rate
		var pages = packet.packet_data
		if pages.is_empty() or pages[0].is_empty(): return null
		var header = pages[0][0]
		if not header is PackedByteArray or header.size() != 30 or header[0] != 1 or header.slice(1, 7).get_string_from_ascii() != "vorbis": return null
		channels = header[11]
		if header.decode_u32(12) != rate: return null
		var positions = packet.granule_positions
		if positions.is_empty() or positions.size() > 65536: return null
		var previous = -1
		for position in positions:
			if position < -1 or (position >= 0 and position < previous): return null
			if position >= 0: previous = position
		granule = previous
	if rate < 8000 or rate > 96000 or channels not in [1, 2]: return null
	var count = frames if frames != null else granule
	var duration = stream.get_length()
	if count == null or count <= 0 or count * channels * 2 > 16 * 1024 * 1024 or not is_finite(duration) or duration <= 0 or duration > 30 or absf(float(count) / rate - duration) > maxf(1.0 / rate, 0.00001): return null
	walked = 0
	objects.clear()
	if not walk(stream, 0, stream, packet): return null
	# Exercise native decoding in a bounded buffer; this is not an exact source-frame assertion.
	var playback = stream.instantiate_playback()
	if playback == null: return null
	playback.start(0)
	var mixed = playback.mix_audio(1.0, 256)
	playback.stop()
	if mixed.is_empty() or mixed.size() > 256: return null
	for sample in mixed:
		if not is_finite(sample.x) or not is_finite(sample.y): return null
	return {"path":entry.path,"hash":entry.hash,"size":entry.size,"class":stream.get_class(),"format":format_name,"duration":duration,"sampleRate":rate,"channels":channels,"frames":frames,"granuleFrames":granule,"dependencies":[],"script":false}

func exact_keys(value, names: Array) -> bool:
	if not value is Dictionary or value.size() != names.size(): return false
	for key in names:
		if not value.has(key): return false
	return true

func safe_resource(value) -> bool:
	if not value is String or value.length() > 512 or not value.ends_with(".res"): return false
	var regex = RegEx.new()
	regex.compile("^[A-Za-z0-9_./-]+[.]res$")
	if regex.search(value) == null: return false
	for part in value.split("/"):
		if part.is_empty() or part in [".", ".."] or part.ends_with(".") or part.ends_with(" "): return false
	return true

func _initialize():
	var request_file = FileAccess.open("res://request.json", FileAccess.READ)
	if request_file == null or request_file.get_length() > 1024 * 1024:
		quit(1)
		return
	var request = JSON.parse_string(request_file.get_as_text())
	if not exact_keys(request, ["version", "files", "expected"]) or request.version != 1 or not request.files is Array or request.files.is_empty() or request.files.size() > 4 or not request.expected is Array or request.expected.size() != request.files.size():
		quit(1)
		return
	var names = {}
	var total = 0
	# Validate the whole request before the first native resource deserialization.
	for index in range(request.files.size()):
		var entry = request.files[index]
		var expected = request.expected[index]
		if not exact_keys(entry, ["path", "hash", "size"]) or not safe_resource(entry.path) or names.has(entry.path.to_lower()) or not entry.hash is String or entry.hash.length() != 64 or not (entry.size is float or entry.size is int) or entry.size != floor(entry.size) or entry.size < 4 or entry.size > 17 * 1024 * 1024:
			quit(1)
			return
		var hex = RegEx.new()
		hex.compile("^[a-f0-9]{64}$")
		if hex.search(entry.hash) == null or not exact_keys(expected, ["path", "format", "duration"]) or expected.path != entry.path or expected.format not in ["wav", "ogg-vorbis"] or not (expected.duration is float or expected.duration is int) or not is_finite(expected.duration) or expected.duration <= 0 or expected.duration > 30:
			quit(1)
			return
		names[entry.path.to_lower()] = true
		total += entry.size
		if total > 68 * 1024 * 1024:
			quit(1)
			return
	var resources = []
	for entry in request.files:
		var result = inspect(entry)
		if result == null:
			push_error("Unsupported or invalid compiler audio resource")
			quit(2)
			return
		resources.append(result)
	print("AUDIO_RESOURCES ", JSON.stringify({"version":1,"resources":resources}))
	quit(0)
