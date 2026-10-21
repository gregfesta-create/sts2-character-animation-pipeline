extends SceneTree
var checks = []
func check(value,label):
	checks.append({"name":label,"passed":bool(value)})
	if not value: push_error(label)
func _initialize(): call_deferred("run")
func run():
	var a = load("res://character.tscn").instantiate()
	root.add_child(a)
	await process_frame
	a.set_process(false)
	var player = a.get_node("AnimationPlayer")
	var tree = a.get_node_or_null("AnimationTree")
	var mixer = tree if tree else player
	mixer.callback_mode_process = AnimationMixer.ANIMATION_CALLBACK_MODE_PROCESS_MANUAL
	var markers = []
	a.animation_marker.connect(func(id,_name,_payload): markers.append(id))
	a.play_animation("startcue")
	check(markers == ["start"],"time-zero cue dispatches at explicit start")
	a.advance_animation(0)
	a.advance_animation(0)
	a.advance_animation(0.1)
	check(markers == ["start"],"time-zero cue is not duplicated by initialization")
	a.play_animation("startcue")
	a.advance_animation(0)
	check(markers == ["start","start"],"time-zero cue repeats exactly once after restart")
	markers.clear()
	a.play_animation("loopcue")
	a.advance_animation(0.95)
	check(markers == ["early"],"initial loop marker")
	a.advance_animation(0.10)
	check(markers == ["early","tail"],"tail marker survives loop boundary")
	markers.clear()
	a.play_animation("loopcue")
	a.advance_animation(2.5)
	check(markers == ["early","tail","early","tail","early"],"multi-loop dispatch preserves each crossing")
	markers.clear()
	a.play_animation("loopcue")
	a._process(2.5)
	check(markers == ["early","tail","early","tail","early"],"actual process stall dispatch preserves each crossing")
	markers.clear()
	a.play_animation("loopcue")
	check(a.seek_animation(0.99),"silent seek accepted")
	check(markers.is_empty(),"silent seek emits no skipped cues")
	a.advance_animation(0.22)
	check(markers == ["early"],"advancing after seek emits only new crossings")
	var before = a.elapsed
	markers.clear()
	check(not a.advance_animation(10000),"overrun rejected before advancing")
	check(a.elapsed == before and markers.is_empty() and a.last_error.code == "ANIMATION_ADVANCE_BUDGET", "overrun has bounded explicit diagnostic")
	markers.clear()
	a.play_animation("attack")
	if tree:
		a.play_animation("idle")
		var playback = tree.get("parameters/playback")
		playback.travel("fastloop")
		a._process(0.1)
		check(markers.size() == 20, "external travel uses new short clip dispatch bounds")
		markers.clear()
		a.play_animation("attack")
	if not tree:
		player.speed_scale = 0.5
		a.advance_animation(0.4)
		check(markers.is_empty(),"speed scale does not dispatch early")
		a.advance_animation(0.3)
		check(markers == ["release"],"speed scale follows actual playhead")
		player.speed_scale = 1
	var valid = true
	for c in checks: valid = valid and c.passed
	var f = FileAccess.open("res://marker-validation.json",FileAccess.WRITE)
	f.store_string(JSON.stringify({"valid":valid,"checks":checks}))
	f.close()
	quit(0 if valid else 1)
