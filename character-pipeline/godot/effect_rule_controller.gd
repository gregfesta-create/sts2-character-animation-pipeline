extends RefCounted
# Trusted, already validated compiled plan only; native adapter wiring is pending.
# Observations are copied numeric facts, never native gameplay objects or reflection paths.
class SceneBudget:
	extends RefCounted
	var limit: int = 256
	var used: int = 0
	var projectiles: int = 0
var _instance: String
var _version: String
var _rules: Array = []
var _effects: Dictionary = {}
var _observation: Dictionary = {}
var _last: Dictionary = {}
var _disputed: int = -1
var _pending: Dictionary = {}
var _history: Dictionary = {}
var _clock: float = 0.0
var _disposed: bool = false
var _budget: SceneBudget
var _diagnostics: Array = []
func configure_trusted(plan: Dictionary, catalog: Array, owner: String, budget: SceneBudget = null) -> bool:
	if _budget!=null or owner.is_empty() or owner.length()>256 or plan.get("decisions",[]).size()>1000 or catalog.size()>64: return false
	var rules: Array = []
	var channels: Dictionary = {}
	for d in plan.decisions:
		if d.outcome=="effect":
			rules.append(d.duplicate(true))
			channels[d.rule.channel]=true
	if rules.size()>64 or channels.size()>8 or (budget!=null and (budget.limit<1 or budget.limit>256)): return false
	_instance=owner
	_version=plan.adapterContractVersion
	_rules=rules
	for effect in catalog: _effects[effect.id]=effect.duplicate(true)
	_budget=budget if budget!=null else SceneBudget.new()
	return true
func _diag(message: String) -> void:
	if message in _diagnostics: return
	if _diagnostics.size()==128: _diagnostics.pop_front()
	_diagnostics.append(message)
func observe(facts: Dictionary) -> bool:
	if _disposed: return false
	if facts.get("characterInstance")!=_instance or facts.get("adapterContractVersion")!=_version or not _integer(facts.get("sequence")) or not facts.get("bindings") is Dictionary:
		_observation={}
		_diag("Invalid observation envelope; effects suppressed")
		return false
	var sequence: int = int(facts.sequence)
	if not _last.is_empty() and sequence<int(_last.sequence): return false
	var bindings: Dictionary = {}
	for d in _rules:
		var f = facts.bindings.get(d.bindingId)
		if not f is Dictionary or not f.get("present") is bool or not _number(f.get("amount")):
			_diag("Missing or invalid authoritative observation: "+d.bindingId)
			continue
		bindings[d.bindingId]={"present":f.present,"amount":f.amount}
	var next := {"characterInstance":_instance,"adapterContractVersion":_version,"sequence":sequence,"bindings":bindings}
	if not _last.is_empty() and sequence==int(_last.sequence):
		if next!=_last:
			_observation={}
			_disputed=sequence
			_diag("Conflicting observation sequence %s; newer verified facts required" % sequence)
			return false
		if sequence<=_disputed: return false
	_observation=next
	_last=next.duplicate(true)
	return true
func _number(value: Variant) -> bool:
	return (value is int or value is float) and is_finite(float(value))
func _integer(value: Variant) -> bool:
	return _number(value) and float(value)>=0 and float(value)<=9007199254740991 and floor(float(value))==float(value)
func _choose(scope: String) -> Array:
	var winners: Dictionary = {}
	var competitors: Dictionary = {}
	if _disposed or _observation.is_empty(): return []
	for d in _rules:
		var rule: Dictionary = d.rule
		var fact: Dictionary = _observation.bindings.get(d.bindingId,{})
		if rule.scope!=scope or fact.is_empty() or not fact.present: continue
		if rule.condition.type=="amountAtLeast" and fact.amount<rule.condition.threshold: continue
		if not competitors.has(rule.channel): competitors[rule.channel]=[]
		competitors[rule.channel].append(d.id+"("+d.mechanicKey+")")
		var previous: Dictionary = winners.get(rule.channel,{})
		if previous.is_empty() or rule.priority>previous.rule.priority or (rule.priority==previous.rule.priority and d.id<previous.id): winners[rule.channel]=d
	var channels: Array = winners.keys()
	channels.sort()
	var result: Array = []
	for channel in channels:
		var d: Dictionary = winners[channel]
		if competitors[channel].size()>1:
			competitors[channel].sort()
			_diag("Exclusive channel "+channel+" owners="+",".join(competitors[channel])+" winner="+d.id)
		var selected: Dictionary = d.rule.duplicate(true)
		selected.ruleId=d.id
		selected.effects=[]
		for id in d.rule.effectIds: selected.effects.append(_effects[id].duplicate(true))
		result.append(selected)
	return result
func select_while_active() -> Array: return _choose("whileActive")
func _key(action: String, generation: Variant) -> String:
	if action.is_empty() or action.length()>256 or not ((generation is String and not generation.is_empty() and generation.length()<=256) or _integer(generation)): return ""
	# Numeric tokens normalize JSON's int/float representation; string generations stay distinct.
	return JSON.stringify([action,str(int(generation)) if _integer(generation) else generation, generation is String])
func capture_attack(context: Dictionary) -> Dictionary:
	if _disposed or context.get("preConsumption")!=true or context.get("characterInstance",_instance)!=_instance: return {}
	var key := _key(context.get("actionInstance",""),context.get("generation"))
	if key.is_empty() or not _number(context.get("releaseAt")) or not _number(context.get("impactAt")) or context.releaseAt<0 or context.impactAt<=context.releaseAt or context.impactAt>10: return {}
	var target = context.get("target")
	if context.has("target") and not (target is String and not target.is_empty() and target.length()<=256):
		if not target is Dictionary or target.size()!=2 or not target.get("valid") is bool or not target.get("position") is Array or target.position.size()!=2 or not _number(target.position[0]) or not _number(target.position[1]): return {}
	var facts := {"characterInstance":_instance,"actionInstance":context.actionInstance,"generation":context.generation,"observationSequence":context.get("observationSequence"),"releaseAt":context.releaseAt,"impactAt":context.impactAt}
	if context.has("target"): facts.target=target
	if _history.has(key):
		if _history[key].facts!=facts or not _pending.has(key): return {}
		return _pending[key].snapshot.duplicate(true)
	if _observation.is_empty() or context.get("observationSequence")!=_observation.sequence: return {}
	var exhausted: String = "pending" if _pending.size()>=32 else ("scene" if _budget.used>=_budget.limit else ("history" if _history.size()>=1024 else ""))
	if not exhausted.is_empty():
		_diag("Presentation snapshot capacity exceeded: "+exhausted)
		return {}
	var snapshot := facts.duplicate(true)
	snapshot.startedAt=_clock
	snapshot.selectedEffects=_choose("attackSnapshot")
	var entry := {"facts":facts.duplicate(true),"snapshot":snapshot,"released":false,"completed":false,"projectiles":{}}
	_pending[key]=entry
	_history[key]=entry
	_budget.used+=1
	return snapshot.duplicate(true)
func mark_released(action: String, generation: Variant) -> Dictionary:
	var entry: Dictionary = _pending.get(_key(action,generation),{})
	if _disposed or entry.is_empty() or entry.completed: return {}
	entry.released=true
	return entry.snapshot.duplicate(true)
func retain_projectile(action: String, generation: Variant, projectile: String) -> Dictionary:
	var entry: Dictionary = _pending.get(_key(action,generation),{})
	if _disposed or entry.is_empty() or entry.completed or not entry.released or projectile.is_empty() or projectile.length()>256: return {}
	if not entry.projectiles.has(projectile):
		if status().projectiles>=32 or _budget.projectiles>=256: return {}
		entry.projectiles[projectile]=true
		_budget.projectiles+=1
	return entry.snapshot.duplicate(true)
func _retire(key: String) -> void:
	if not _pending.has(key): return
	_budget.used-=1
	_budget.projectiles-=_pending[key].projectiles.size()
	_pending.erase(key)
func release_projectile(action: String, generation: Variant, projectile: String) -> bool:
	var key := _key(action,generation)
	if not _pending.has(key): return false
	var entry: Dictionary = _pending[key]
	if entry.projectiles.erase(projectile): _budget.projectiles-=1
	if entry.completed and entry.projectiles.is_empty(): _retire(key)
	return true
func complete_attack(action: String, generation: Variant) -> bool:
	var key := _key(action,generation)
	if _disposed or not _pending.has(key): return false
	_pending[key].completed=true
	if not _pending[key].released or _pending[key].projectiles.is_empty(): _retire(key)
	return true
func cancel_attack(action: String, generation: Variant) -> bool: return complete_attack(action,generation)
func advance(seconds: float) -> bool:
	if _disposed or not is_finite(seconds) or seconds<_clock: return false
	_clock=seconds
	for key in _pending.keys():
		if _clock-_pending[key].snapshot.startedAt>=10:
			_diag("Snapshot lifetime expired: "+_pending[key].snapshot.actionInstance)
			_retire(key)
	return true
func combat_end() -> void:
	for key in _pending.keys(): _retire(key)
	_history.clear()
	_observation.clear()
	_last.clear()
	_disputed=-1
func dispose() -> void:
	combat_end()
	_disposed=true
func status() -> Dictionary:
	var count: int = 0
	for entry in _pending.values(): count+=entry.projectiles.size()
	return {"characterInstance":_instance,"pending":_pending.size(),"projectiles":count,"clock":_clock,"disposed":_disposed,"diagnostics":_diagnostics.duplicate()}
