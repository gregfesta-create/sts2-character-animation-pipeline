extends Node
# Presentation foundation only. Trusted host normalizes validated selections to IDs.
# No native mechanic observation, action hook, resource loading or gameplay mutation.
const MAX_OWNERS: int = 32
const MAX_EFFECTS: int = 64
const MAX_SELECTED: int = 8
const MAX_LIFETIME: float = 10.0
var _catalog: Dictionary = {}
var _owners: Dictionary = {}
var _sealed: bool = false
var _clock: float = 0.0
func _valid_id(id: String) -> bool:
	return not id.is_empty() and id.length()<=256
func _color_valid(color: Color) -> bool:
	return is_finite(color.r) and is_finite(color.g) and is_finite(color.b) and is_finite(color.a) and color.r>=0 and color.r<=1 and color.g>=0 and color.g<=1 and color.b>=0 and color.b<=1 and color.a>=0 and color.a<=1
func _registerable(id: String) -> bool:
	return not _sealed and _valid_id(id) and not _catalog.has(id) and _catalog.size()<MAX_EFFECTS
func register_tint(id: String, color: Color) -> bool:
	if not _registerable(id) or not _color_valid(color): return false
	_catalog[id]={"kind":"tint","color":color}
	return true
func register_overlay(id: String, texture: Texture2D, offset: Vector2, size_scale: Vector2) -> bool:
	if not _registerable(id) or texture==null or texture.get_width()>4096 or texture.get_height()>4096 or texture.get_width()<1 or texture.get_height()<1: return false
	if not offset.is_finite() or offset.length()>4096 or not size_scale.is_finite() or size_scale.x<=0 or size_scale.y<=0 or size_scale.x>16 or size_scale.y>16: return false
	_catalog[id]={"kind":"overlay","texture":texture,"offset":offset,"scale":size_scale}
	return true
func register_animated_overlay(id: String, frames: Array, durations: Array, offset: Vector2, size_scale: Vector2, loop: bool) -> bool:
	if not _registerable(id) or frames.size()<2 or frames.size()>64 or durations.size()!=frames.size(): return false
	if not offset.is_finite() or offset.length()>4096 or not size_scale.is_finite() or size_scale.x<=0 or size_scale.y<=0 or size_scale.x>16 or size_scale.y>16: return false
	var dimensions := Vector2i.ZERO
	var pixels: int = 0
	var total: float = 0.0
	for index in range(frames.size()):
		var texture = frames[index]
		if not texture is Texture2D: return false
		var current := Vector2i(texture.get_width(),texture.get_height())
		if current.x<1 or current.y<1 or current.x>4096 or current.y>4096: return false
		if index==0: dimensions=current
		elif current!=dimensions: return false
		pixels+=current.x*current.y
		if pixels>16777216: return false
		var duration = durations[index]
		if not (duration is float or duration is int): return false
		if not is_finite(float(duration)) or duration<1.0/240.0 or duration>10.0: return false
		total+=float(duration)
		if total>10.0: return false
	_catalog[id]={"kind":"animated_overlay","frames":frames.duplicate(),"durations":durations.duplicate(),"duration":total,"offset":offset,"scale":size_scale,"loop":loop}
	return true
func _update_overlays(entry: Dictionary) -> void:
	var elapsed: float = _clock-entry.started
	for animated in entry.get("animated",[]):
		if not is_instance_valid(animated.node): continue
		var definition: Dictionary = _catalog[animated.id]
		var position: float = fmod(elapsed,definition.duration) if definition.loop else elapsed
		var selected: int = definition.frames.size()-1
		var boundary: float = 0.0
		for index in range(definition.frames.size()):
			boundary+=float(definition.durations[index])
			if position<boundary:
				selected=index
				break
		animated.node.texture=definition.frames[selected]
func _selection_valid(selected: Array[String]) -> bool:
	if selected.size()>MAX_SELECTED: return false
	var seen: Dictionary = {}
	for id in selected:
		if not _catalog.has(id) or seen.has(id): return false
		seen[id]=true
	return true
func _restore(owner: String) -> void:
	if not _owners.has(owner): return
	var entry: Dictionary = _owners[owner]
	var target = entry.target.get_ref()
	if is_instance_valid(target): target.modulate=entry.original
	for overlay in entry.overlays:
		if is_instance_valid(overlay):
			if overlay.get_parent()!=null: overlay.get_parent().remove_child(overlay)
			overlay.queue_free()
	_owners.erase(owner)
func _apply(owner: String, target: Node2D, selected: Array[String], projectile: bool) -> bool:
	if not is_instance_valid(target) or not _selection_valid(selected): return false
	# A target has one presentation owner. Competing owners must resolve upstream.
	for key in _owners:
		if key!=owner and _owners[key].target.get_ref()==target: return false
	if not _owners.has(owner) and not selected.is_empty() and _owners.size()>=MAX_OWNERS: return false
	if _owners.has(owner) and _owners[owner].target.get_ref()==target and _owners[owner].selected==selected: return true
	_sealed=true
	_restore(owner)
	if selected.is_empty(): return true
	var entry: Dictionary = {"target":weakref(target),"original":target.modulate,"overlays":[],"animated":[],"selected":selected.duplicate(),"projectile":projectile,"started":_clock}
	var tint := Color.WHITE
	for id in selected:
		var definition: Dictionary = _catalog[id]
		if definition.kind=="tint": tint*=definition.color
		else:
			var overlay := Sprite2D.new()
			overlay.texture=definition.frames[0] if definition.kind=="animated_overlay" else definition.texture
			overlay.position=definition.offset
			overlay.scale=definition.scale
			target.add_child(overlay)
			entry.overlays.append(overlay)
			if definition.kind=="animated_overlay": entry.animated.append({"node":overlay,"id":id})
	target.modulate=entry.original*tint
	_owners[owner]=entry
	return true
func apply_active(target: Node2D, selected: Array[String]) -> bool:
	return _apply("active",target,selected,false)
func apply_projectile(owner: String, target: Node2D, selected: Array[String], native_seconds: float) -> bool:
	if not _valid_id(owner) or owner=="active" or not is_finite(native_seconds) or native_seconds!=_clock: return false
	if _owners.has(owner):
		var entry: Dictionary = _owners[owner]
		return entry.target.get_ref()==target and entry.selected==selected
	return _apply(owner,target,selected,true)
func remove_projectile(owner: String) -> void:
	if owner!="active": _restore(owner)
func advance(native_seconds: float) -> bool:
	if not is_finite(native_seconds) or native_seconds<_clock: return false
	_clock=native_seconds
	for owner in _owners.keys():
		var entry: Dictionary = _owners[owner]
		if not is_instance_valid(entry.target.get_ref()) or (entry.projectile and _clock-entry.started>=MAX_LIFETIME): _restore(owner)
		else: _update_overlays(entry)
	return true
func clear_all() -> void:
	for owner in _owners.keys(): _restore(owner)
func _exit_tree() -> void:
	clear_all()
