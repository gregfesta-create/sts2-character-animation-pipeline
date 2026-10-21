extends SceneTree
func _initialize():
	var arbitrary = Resource.new()
	if ResourceSaver.save(arbitrary, "res://object.res") != OK: quit(1); return
	var stream = AudioStreamWAV.new()
	stream.format = AudioStreamWAV.FORMAT_16_BITS
	stream.mix_rate = 48000
	stream.stereo = true
	stream.data = PackedByteArray()
	var data = PackedByteArray()
	data.resize(192000)
	stream.data = data
	stream.set_meta("hidden", Resource.new())
	if ResourceSaver.save(stream, "res://embedded.res") != OK: quit(2); return
	stream.remove_meta("hidden")
	var external = Resource.new()
	if ResourceSaver.save(external, "res://external.tres") != OK: quit(3); return
	stream.set_meta("hidden", external)
	if ResourceSaver.save(stream, "res://external.res") != OK: quit(4); return
	stream.remove_meta("hidden")
	stream.loop_mode = AudioStreamWAV.LOOP_FORWARD
	if ResourceSaver.save(stream, "res://loop.res") != OK: quit(5); return
	quit(0)
