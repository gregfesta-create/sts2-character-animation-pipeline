extends Node
# Compiled native contract: catalog entries carry real Color / Texture2D resources;
# socket targets are explicit Node2D references supplied by the owning scene.
const Rules = preload("res://effect_rule_controller.gd")
const Renderer = preload("res://effect_controller.gd")
const Impacts = preload("res://impact_controller.gd")
var _impacts
var _rules
var _catalog: Array = []
var _targets: Dictionary = {}
var _active: Dictionary = {}
var _projectiles: Dictionary = {}
var _clock: float = 0.0
var _paused: bool = false
var _disposed: bool = false
func _overlaps(left: Node, right: Node) -> bool:
	return is_instance_valid(left) and is_instance_valid(right) and (left==right or left.is_ancestor_of(right) or right.is_ancestor_of(left))
func _register(renderer, effect: Dictionary) -> bool:
	var p: Dictionary = effect.presentation
	if effect.get("capability")=="tint" and p.size()==1 and p.get("color") is Color:
		return renderer.register_tint(effect.id,p.color)
	if effect.get("capability")!="overlay": return false
	if p.size()==3 and p.get("texture") is Texture2D and p.get("offset") is Vector2 and p.get("scale") is Vector2:
		return renderer.register_overlay(effect.id,p.texture,p.offset,p.scale)
	if p.size()==5 and p.get("frames") is Array and p.get("durations") is Array and p.get("offset") is Vector2 and p.get("scale") is Vector2 and p.get("loop") is bool:
		return renderer.register_animated_overlay(effect.id,p.frames,p.durations,p.offset,p.scale,p.loop)
	return false
func _renderer():
	var renderer = Renderer.new()
	for effect in _catalog: _register(renderer,effect)
	add_child(renderer)
	return renderer
func configure_trusted(plan: Dictionary, catalog: Array, owner: String, targets: Dictionary, budget = null) -> bool:
	if _rules!=null or _disposed or catalog.size()>64 or targets.is_empty() or targets.size()>64: return false
	var seen: Dictionary = {}
	var nodes: Array = []
	for socket in targets:
		if not socket is String or socket.is_empty() or socket.length()>256 or not is_instance_valid(targets[socket]) or not targets[socket] is Node2D or targets[socket] in nodes: return false
		for node in nodes:
			if _overlaps(node,targets[socket]): return false
		nodes.append(targets[socket])
	var probe = Renderer.new()
	for effect in catalog:
		if not effect is Dictionary or not effect.get("id") is String or seen.has(effect.id) or not effect.get("presentation") is Dictionary:
			probe.free()
			return false
		if not _register(probe,effect):
			probe.free()
			return false
		seen[effect.id]=true
	probe.free()
	for decision in plan.get("decisions",[]):
		if decision.get("outcome")=="effect":
			if not targets.has(decision.rule.socketId) or decision.rule.effectIds.size()>8: return false
			for id in decision.rule.effectIds:
				if not seen.has(id): return false
	var impacts = Impacts.new()
	if not impacts.configure(catalog):
		impacts.free()
		return false
	var rules = Rules.new()
	if not rules.configure_trusted(plan,catalog,owner,budget):
		impacts.free()
		return false
	_impacts=impacts
	add_child(impacts)
	_rules=rules
	_catalog=catalog.duplicate(true)
	for socket in targets:
		_targets[socket]=weakref(targets[socket])
		_active[socket]=_renderer()
	return true
func confirm_impact(action: String, generation: Variant, hit_cue: String, world_position: Vector2, selected_ids: Array[String]) -> bool:
	return false if _disposed or _impacts==null else _impacts.confirm(action,generation,hit_cue,world_position,selected_ids)
func report_impact_diagnostic(code: String) -> void:
	if not _disposed and _impacts!=null: _impacts.report_diagnostic(code)
func impact_status() -> Dictionary:
	return {} if _impacts==null else _impacts.status()
func _selected(selections: Array, socket: String) -> Array[String]:
	var ids: Array[String] = []
	for selection in selections:
		if selection.socketId==socket:
			for id in selection.effectIds:
				if not id in ids: ids.append(id)
	return ids
func _refresh() -> bool:
	if _rules==null or _disposed: return false
	var selections: Array = _rules.select_while_active()
	for socket in _targets:
		if _selected(selections,socket).size()>8:
			for renderer in _active.values(): renderer.clear_all()
			return false
	for socket in _targets:
		var target = _targets[socket].get_ref()
		if is_instance_valid(target):
			var selected: Array[String] = []
			if not _paused: selected=_selected(selections,socket)
			_active[socket].apply_active(target,selected)
		else: _active[socket].clear_all()
	return true
func observe(facts: Dictionary) -> bool:
	if _rules==null or _disposed: return false
	var accepted: bool = _rules.observe(facts)
	_refresh()
	return accepted
func select_while_active() -> Array:
	return [] if _rules==null or _disposed else _rules.select_while_active()
func capture_attack(context: Dictionary) -> Dictionary:
	return {} if _rules==null or _disposed else _rules.capture_attack(context)
func mark_released(action: String, generation: Variant) -> Dictionary:
	return {} if _rules==null or _disposed else _rules.mark_released(action,generation)
func _key(action: String, generation: Variant, projectile: String) -> String:
	return JSON.stringify([action,generation,projectile])
func retain_projectile(action: String, generation: Variant, projectile: String, socket: String, target: Node2D) -> Dictionary:
	if _rules==null or _disposed or not _targets.has(socket) or not is_instance_valid(target): return {}
	# A projectile must have its own visual, never the active socket's target.
	for ref in _targets.values():
		if _overlaps(ref.get_ref(),target): return {}
	var key := _key(action,generation,projectile)
	if _projectiles.has(key):
		var entry: Dictionary = _projectiles[key]
		if entry.target.get_ref()!=target or entry.socket!=socket: return {}
	for other_key in _projectiles:
		if other_key!=key and _overlaps(_projectiles[other_key].target.get_ref(),target): return {}
	var snapshot: Dictionary = _rules.retain_projectile(action,generation,projectile)
	if snapshot.is_empty(): return {}
	var ids := _selected(snapshot.selectedEffects,socket)
	if ids.size()>8:
		_rules.release_projectile(action,generation,projectile)
		return {}
	if not _projectiles.has(key):
		var renderer = _renderer()
		renderer.advance(_clock)
		_projectiles[key]={"action":action,"generation":generation,"projectile":projectile,"socket":socket,"target":weakref(target),"renderer":renderer,"ids":ids,"started":snapshot.startedAt}
		if not _paused: renderer.apply_projectile("projectile",target,ids,_clock)
	return snapshot
func _remove(key: String) -> void:
	var entry: Dictionary = _projectiles[key]
	entry.renderer.clear_all()
	entry.renderer.queue_free()
	_projectiles.erase(key)
func release_projectile(action: String, generation: Variant, projectile: String) -> bool:
	if _rules==null or _disposed: return false
	var key := _key(action,generation,projectile)
	if _projectiles.has(key): _remove(key)
	return _rules.release_projectile(action,generation,projectile)
func complete_attack(action: String, generation: Variant) -> bool:
	return false if _rules==null or _disposed else _rules.complete_attack(action,generation)
func cancel_attack(action: String, generation: Variant) -> bool:
	if _impacts!=null: _impacts.cancel(action,generation)
	if _rules==null or _disposed: return false
	for key in _projectiles.keys():
		var entry: Dictionary = _projectiles[key]
		if entry.action==action and entry.generation==generation: release_projectile(action,generation,entry.projectile)
	return _rules.cancel_attack(action,generation)
func advance(seconds: float) -> bool:
	if _rules==null or _disposed or not _rules.advance(seconds): return false
	_clock=seconds
	if _impacts!=null: _impacts.advance(seconds)
	for renderer in _active.values(): renderer.advance(seconds)
	for key in _projectiles.keys():
		var entry: Dictionary = _projectiles[key]
		if not is_instance_valid(entry.target.get_ref()) or _clock-entry.started>=10:
			release_projectile(entry.action,entry.generation,entry.projectile)
		else: entry.renderer.advance(seconds)
	return true
func set_paused(value: bool) -> void:
	_paused=value
	if _impacts!=null: _impacts.set_paused(value)
	_refresh()
	for entry in _projectiles.values():
		entry.renderer.clear_all()
		var target = entry.target.get_ref()
		if not value and is_instance_valid(target): entry.renderer.apply_projectile("projectile",target,entry.ids,_clock)
func combat_end() -> void:
	if _impacts!=null: _impacts.combat_end()
	if _rules==null: return
	_rules.combat_end()
	for renderer in _active.values(): renderer.clear_all()
	for key in _projectiles.keys(): _remove(key)
func dispose() -> void:
	combat_end()
	if _rules!=null: _rules.dispose()
	_disposed=true
	if _impacts!=null: _impacts.dispose()
func status() -> Dictionary:
	return {} if _rules==null else _rules.status()
func _exit_tree() -> void: dispose()
