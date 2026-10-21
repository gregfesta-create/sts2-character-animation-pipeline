extends SceneTree

var checks = []
func check(value, label):
	checks.append({"name":label,"passed":bool(value)})
	if not value: push_error(label)

func _initialize():
	call_deferred("run")

func run():
	var scene = load("res://character.tscn")
	var a = scene.instantiate()
	var b = scene.instantiate()
	root.add_child(a)
	root.add_child(b)
	await process_frame
	a.set_process(false)
	b.set_process(false)
	var player = a.get_node("AnimationPlayer")
	var tree = a.get_node_or_null("AnimationTree")
	if tree:
		tree.callback_mode_process = AnimationMixer.ANIMATION_CALLBACK_MODE_PROCESS_MANUAL
		check(tree.tree_root.allow_transition_to_self,"tree self transitions enabled")
	else:
		player.callback_mode_process = AnimationMixer.ANIMATION_CALLBACK_MODE_PROCESS_MANUAL
	check(player.has_animation("RESET"),"full reset clip")
	var markers = []
	a.animation_marker.connect(func(id, name, payload): markers.append([id,name,payload]))
	check(a.play_animation("attack"),"action accepted")
	if tree: tree.advance(0.4)
	else: player.advance(0.4)
	var tip = a.get_node("Skeleton/root/tip")
	check(absf(tip.rotation - 0.56) < 0.001,"exact articulated sample")
	a._process(0)
	a._process(0)
	check(markers.size() == 1 and markers[0][0] == "release", "marker dispatched once")
	a.play_animation("attack")
	if tree: tree.advance(0)
	else: player.advance(0)
	check(absf(tip.rotation) < 0.001,"same action restarts")
	a._process(0.3)
	check(markers.size() == 2, "restart permits marker again")
	if tree:
		var playback = tree.get("parameters/playback")
		playback.travel("Hit")
		tree.advance(0.1)
		a._process(0)
		check(a.current == "hit", "external native alias travel observed")
		playback.travel("Hit")
		tree.advance(0)
		a._process(0)
		check(playback.get_current_play_position() < 0.001, "external self travel restarts")
	a.play_animation("hit")
	a._process(1.1)
	check(a.current == "idle","action returns idle")
	a.play_animation("death")
	a._process(1.1)
	check(a.current == "death" and a.held,"death holds")
	a.play_animation("Revive")
	check(not a.held,"revive resets held flag")
	for easing in ["linear","in","out","inOut","step"]:
		a.play_animation("ease_" + easing)
		if tree: tree.advance(0.25)
		else: player.advance(0.25)
		var expected = {"linear":0.25,"in":0.0625,"out":0.4375,"inOut":0.125,"step":0.0}[easing]
		check(absf(tip.rotation - expected) < 0.001, "native easing " + easing)
	a.play_animation("idle")
	a.hide()
	var before = a.elapsed
	a._process(1)
	check(a.elapsed == before,"hidden time frozen")
	a.show()
	a._process(0.1)
	check(a.elapsed > before,"visible resumes")
	check(b.current == "idle" and b.elapsed == 0,"instances independent")
	a.set_process(true)
	paused = true
	before = a.elapsed
	await process_frame
	await process_frame
	check(a.elapsed == before, "engine pause freezes controller")
	paused = false
	await process_frame
	await process_frame
	check(a.elapsed > before, "unpause resumes controller")
	a.set_process(false)
	root.remove_child(a)
	check(not a.is_inside_tree(),"removed instance detached")
	a.free()
	b.queue_free()
	var passed = true
	for item in checks: passed = passed and item.passed
	var f = FileAccess.open("res://runtime-validation.json",FileAccess.WRITE)
	f.store_string(JSON.stringify({"valid":passed,"checks":checks}))
	f.close()
	quit(0 if passed else 1)
