extends SceneTree
var checks: Array = []
func check(value: bool, label: String) -> void:
 checks.append({"name":label,"passed":value})
 if not value: push_error(label)
func _initialize(): call_deferred("run")
func run():
 var fixture=JSON.parse_string(FileAccess.get_file_as_string("res://fixture.json"))
 var script=load("res://state_reconciler.gd")
 for scenario in fixture.cases:
  var reconciler=script.new()
  check(reconciler.configure(scenario.config),scenario.name+" configure")
  check(not reconciler.configure(scenario.config),scenario.name+" one-time owner binding")
  var index=0
  for step in scenario.steps:
   var result
   if step.get("nativeIntegers",false):
    for key in ["version","sequence","revision"]: step.message[key]=int(step.message[key])
    var parts=step.message.get("components",[step.message.get("payload",{})])
    for part in parts:
     if part.has("revision"): part.revision=int(part.revision)
     if part.has("upgrade"): part.upgrade=int(part.upgrade)
   if step.method=="getState": result={"state":reconciler.get_state()}
   elif step.method=="teardown": result=reconciler.teardown()
   else: result=reconciler.call(step.method,step.message)
   var normalized=JSON.parse_string(JSON.stringify(result))
   check(normalized==step.expected,scenario.name+" step "+str(index))
   if normalized!=step.expected: print("ACTUAL ",JSON.stringify(result)," EXPECTED ",JSON.stringify(step.expected))
   if result.has("state"): result.state.components.clear()
   index+=1
 var a=script.new()
 var b=script.new()
 a.configure(fixture.ownership.firstConfig)
 b.configure(fixture.ownership.secondConfig)
 a.snapshot(fixture.ownership.firstSnapshot)
 b.snapshot(fixture.ownership.secondSnapshot)
 a.event(fixture.ownership.firstEvent)
 check(JSON.parse_string(JSON.stringify(a.get_state()))==fixture.ownership.expectedFirst,"simultaneous first owner state")
 check(JSON.parse_string(JSON.stringify(b.get_state()))==fixture.ownership.expectedSecond,"simultaneous second owner remains isolated")
 var f=fixture.forks
 var original=script.new()
 original.configure(f.config)
 original.snapshot(f.initial)
 original.event(f.gap)
 var candidate=original.fork()
 check(not candidate.configure(f.config),"fork retains one-time configured owner")
 check(JSON.parse_string(JSON.stringify(candidate.snapshot(f.oldRecovery)))==f.expected.candidateOld,"fork preserves required gap watermarks")
 check(JSON.parse_string(JSON.stringify(candidate.snapshot(f.recovery)))==f.expected.candidateRecovered,"candidate accepts sufficiently current recovery")
 check(JSON.parse_string(JSON.stringify(candidate.event(f.candidateEvent)))==f.expected.candidateEvent,"candidate mutates independently after recovery")
 check(JSON.parse_string(JSON.stringify(original.snapshot(f.oldRecovery)))==f.expected.originalOld,"original gap watermark survives candidate acceptance")
 check(JSON.parse_string(JSON.stringify(original.get_state()))==f.expected.originalState,"discarded candidate leaves original accepted state unchanged")
 var rejected=original.fork()
 var bad=f.recovery.duplicate(true)
 bad.components[0].revision=0
 check(rejected.snapshot(bad).get("error")=="INVALID_STATE" and JSON.parse_string(JSON.stringify(original.get_state()))==f.expected.originalState,"candidate rejection is isolated")
 var removed=script.new()
 removed.configure(f.config)
 removed.snapshot(f.removedInitial)
 check(JSON.parse_string(JSON.stringify(removed.fork().snapshot(f.later)))==f.expectedRemoved,"fork preserves terminal removal")
 var disposed=script.new()
 disposed.configure(f.config)
 disposed.snapshot(f.initial)
 disposed.teardown()
 check(JSON.parse_string(JSON.stringify(disposed.fork().snapshot(f.later)))==f.expectedDisposed,"fork preserves disposed status")
 check(script.new().fork()==null,"unconfigured reconciler cannot fork an owner")
 for config in fixture.invalidConfigs:
  var invalid=script.new()
  check(not invalid.configure(config),"invalid configuration rejected")
 var file=FileAccess.open("res://validation.json",FileAccess.WRITE)
 file.store_string(JSON.stringify({"checks":checks}))
 quit(0 if checks.all(func(c): return c.passed) else 1)
