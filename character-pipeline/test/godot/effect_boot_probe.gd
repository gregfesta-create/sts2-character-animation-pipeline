extends SceneTree
var checks = []
func check(value, label): checks.append({"name":label,"passed":bool(value)})
func _initialize(): call_deferred("run")
func run():
	var packed = load("res://character.tscn")
	var live = packed.instantiate()
	root.add_child(live)
	await process_frame
	var live_effect = live.get_node("EffectController")
	check(live_effect.ready_for_effects and live_effect._rules != null, "live generated boot configures effects")
	var retired = packed.instantiate()
	root.add_child(retired)
	var retired_effect = retired.get_node("EffectController")
	root.remove_child(retired)
	check(retired_effect._disposed and not retired_effect.is_inside_tree(), "exit_tree disposes before deferred startup")
	await process_frame
	check(not retired_effect.ready_for_effects and retired_effect._rules == null, "detached disposed boot stays retired")
	retired.free()
	var queued = packed.instantiate()
	root.add_child(queued)
	var queued_effect = queued.get_node("EffectController")
	queued.tree_exiting.connect(func(): check(not queued_effect.ready_for_effects and queued_effect._rules == null, "queued root does not initialize before deletion"))
	queued.queue_free()
	await process_frame
	check(not is_instance_valid(queued) or queued.is_queued_for_deletion(), "queued retirement accepted")
	var disposed = packed.instantiate()
	root.add_child(disposed)
	var disposed_effect = disposed.get_node("EffectController")
	disposed_effect.dispose()
	await process_frame
	check(not disposed_effect.ready_for_effects and disposed_effect._rules == null, "explicitly disposed boot stays retired")
	disposed.queue_free()
	var malformed = packed.instantiate()
	var malformed_effect = malformed.get_node("EffectController")
	malformed_effect.compiled_targets = {}
	root.add_child(malformed)
	await process_frame
	check(not malformed_effect.ready_for_effects and malformed_effect._rules == null, "malformed live boot still fails")
	malformed.queue_free()
	live.queue_free()
	await process_frame
	var result = {"checks":checks,"passed":checks.all(func(item): return item.passed)}
	var file = FileAccess.open("res://effect-boot-result.json", FileAccess.WRITE)
	file.store_string(JSON.stringify(result, "  "))
	file.close()
	quit(0 if result.passed else 1)
