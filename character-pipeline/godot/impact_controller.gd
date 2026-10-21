extends Node
# Trusted visual-only receiver; callers supply captured IDs after a confirmed hit.
const Renderer = preload("res://effect_controller.gd")
const REGISTRY_KEY: String = "_character_pipeline_impact_registry_v1"
var _catalog: Dictionary = {}
var _declared: Dictionary = {}
var _entries: Dictionary = {}
var _seen: Dictionary = {}
var _diagnostics: Array = []
var _clock: float = 0.0
var _paused: bool = false
var _disposed: bool = false
var _registry_root: WeakRef
var _configured: bool = false
func _diagnose(code: String) -> bool:
 if _diagnostics.size()<128: _diagnostics.append(code)
 return false
func _registry() -> Dictionary:
 var scene_root = _registry_root.get_ref() if _registry_root!=null else (get_tree().root if is_inside_tree() else null)
 if not is_instance_valid(scene_root): return {}
 _registry_root=weakref(scene_root)
 var payload = scene_root.get_meta(REGISTRY_KEY,{"version":1,"anchors":[]})
 if not payload is Dictionary or payload.size()!=2 or not payload.get("version") is int or payload.version!=1 or not payload.get("anchors") is Array or payload.anchors.size()>256: return {}
 var live: Array = []
 for ref in payload.anchors:
  if not ref is WeakRef: return {}
  var anchor = ref.get_ref()
  if not is_instance_valid(anchor): continue
  if not anchor is Node2D: return {}
  if anchor.is_queued_for_deletion() or not anchor.is_inside_tree(): continue
  if anchor.get_tree().root!=scene_root: return {}
  live.append(ref)
 payload={"version":1,"anchors":live}
 scene_root.set_meta(REGISTRY_KEY,payload)
 return payload
func _integer(value: Variant) -> bool:
 return (value is int or value is float) and is_finite(float(value)) and float(value)>=0 and float(value)<=9007199254740991 and floor(float(value))==float(value)
func _action_key(action: String, generation: Variant) -> String:
 if action.is_empty() or action.length()>256 or not ((generation is String and not generation.is_empty() and generation.length()<=256) or _integer(generation)): return ""
 return JSON.stringify([action,str(int(generation)) if _integer(generation) else generation,generation is String])
func report_diagnostic(code: String) -> void:
 if not _disposed and not code.is_empty() and code.length()<=256: _diagnose(code)
func _register(renderer, id: String, p: Dictionary) -> bool:
 if p.size()==3 and p.get("texture") is Texture2D and p.get("offset") is Vector2 and p.get("scale") is Vector2:
  return renderer.register_overlay(id,p.texture,p.offset,p.scale)
 if p.size()==5 and p.get("frames") is Array and p.get("durations") is Array and p.get("offset") is Vector2 and p.get("scale") is Vector2 and p.get("loop") is bool:
  return renderer.register_animated_overlay(id,p.frames,p.durations,p.offset,p.scale,p.loop)
 return false
func configure(catalog: Array) -> bool:
 if _configured or _disposed: return false
 var compiled: Dictionary = {}
 var declared: Dictionary = {}
 var probe = Renderer.new()
 for effect in catalog:
  if not effect is Dictionary or not effect.get("id") is String or effect.id.is_empty() or effect.id.length()>256 or declared.has(effect.id):
   probe.free()
   return false
  declared[effect.id]=true
  if not effect.has("impact"): continue
  var impact = effect.impact
  if not impact is Dictionary or impact.size()!=2 or not impact.get("presentation") is Dictionary or not (impact.get("durationSeconds") is int or impact.get("durationSeconds") is float):
   probe.free()
   return false
  var duration: float = impact.durationSeconds
  if not is_finite(duration) or duration<=0 or duration>10 or not _register(probe,effect.id,impact.presentation):
   probe.free()
   return false
  compiled[effect.id]=impact.duplicate(true)
 probe.free()
 _catalog=compiled
 _declared=declared
 _configured=true
 return true
func _create_anchor() -> Node2D:
 return Node2D.new()
func _create_renderer():
 return Renderer.new()
func confirm(action: String, generation: Variant, cue: String, position: Vector2, ids: Array[String]) -> bool:
 if not _configured or _disposed or not is_inside_tree(): return _diagnose("unavailable")
 var action_key := _action_key(action,generation)
 if action_key.is_empty() or cue.is_empty() or cue.length()>256 or not position.is_finite() or abs(position.x)>1000000 or abs(position.y)>1000000 or ids.size()>8: return _diagnose("invalid_request")
 var unique: Dictionary = {}
 var selected: Array[String] = []
 for id in ids:
  if id.is_empty() or id.length()>256 or unique.has(id) or not _declared.has(id): return _diagnose("invalid_selection")
  unique[id]=true
  if _catalog.has(id): selected.append(id)
 var key := JSON.stringify([action_key,cue])
 if _seen.has(key): return _diagnose("duplicate")
 if _seen.size()>=4096: return _diagnose("dedup_budget")
 if selected.is_empty():
  _seen[key]=true
  return true
 var registry := _registry()
 if registry.is_empty(): return _diagnose("invalid_scene_registry")
 if _entries.size()>=32 or registry.anchors.size()>=256: return _diagnose("anchor_budget")
 var anchor = _create_anchor()
 if not is_instance_valid(anchor) or anchor.get_parent()!=null:
  return _diagnose("allocation")
 var effects: Array = []
 for id in selected:
  var renderer = _create_renderer()
  if not is_instance_valid(renderer) or not _register(renderer,id,_catalog[id].presentation):
   if is_instance_valid(renderer): renderer.free()
   for prior in effects:
    prior.renderer.clear_all()
    prior.renderer.free()
   anchor.free()
   return _diagnose("allocation")
  # Renderer remains detached; its overlay nodes alone belong to the anchor.
  renderer.advance(_clock)
  var one: Array[String] = [id]
  if not renderer.apply_projectile("impact",anchor,one,_clock):
   renderer.free()
   for prior in effects:
    prior.renderer.clear_all()
    prior.renderer.free()
   anchor.free()
   return _diagnose("allocation")
  effects.append({"renderer":renderer,"expires":_clock+float(_catalog[id].durationSeconds)})
 add_child(anchor)
 anchor.global_position=position
 anchor.visible=not _paused
 _entries[key]={"actionKey":action_key,"anchor":anchor,"effects":effects}
 _seen[key]=true
 registry.anchors.append(weakref(anchor))
 return true
func _remove(key: String) -> void:
 var entry: Dictionary = _entries[key]
 for effect in entry.effects:
  effect.renderer.clear_all()
  effect.renderer.free()
 if is_instance_valid(entry.anchor): entry.anchor.free()
 _entries.erase(key)
 _registry()
func advance(seconds: float) -> bool:
 if _disposed or not is_finite(seconds) or seconds<_clock: return false
 _clock=seconds
 for key in _entries.keys():
  var entry: Dictionary = _entries[key]
  for index in range(entry.effects.size()-1,-1,-1):
   var effect: Dictionary = entry.effects[index]
   if seconds>=effect.expires:
    effect.renderer.clear_all()
    effect.renderer.free()
    entry.effects.remove_at(index)
   else: effect.renderer.advance(seconds)
  if entry.effects.is_empty(): _remove(key)
 return true
func set_paused(value: bool) -> void:
 _paused=value
 for entry in _entries.values(): entry.anchor.visible=not value
func cancel(action: String, generation: Variant) -> void:
 for key in _entries.keys():
  if _entries[key].actionKey==_action_key(action,generation): _remove(key)
func combat_end() -> void:
 for key in _entries.keys(): _remove(key)
 _seen.clear()
func dispose() -> void:
 combat_end()
 _disposed=true
func status() -> Dictionary:
 var ids: Array = _catalog.keys()
 ids.sort()
 return {"configured":_configured,"effectIds":ids,"anchors":_entries.size(),"dedupKeys":_seen.size(),"diagnostics":_diagnostics.duplicate(),"disposed":_disposed}
func _exit_tree() -> void: dispose()






