extends SceneTree
var checks=[]
func check(value,label):
 checks.append({"name":label,"passed":value})
 if not value: push_error(label)
func equivalent(a,b,frame=false):
 if a is Dictionary and b is Dictionary:
  if a.size()!=b.size(): return false
  for key in a:
   if not b.has(key) or not equivalent(a[key],b[key],key=="frame"): return false
  return true
 if a is Array and b is Array:
  if a.size()!=b.size(): return false
  for i in a.size():
   if not equivalent(a[i],b[i],frame): return false
  return true
 if frame and (a is float or a is int) and (b is float or b is int): return abs(a-b)<=1e-11*max(1.0,abs(b))
 return a==b
func _initialize(): call_deferred("run")
func run():
 var fixture=JSON.parse_string(FileAccess.get_file_as_string("res://fixture.json"))
 var script=load("res://assembly_planner.gd")
 for scenario in fixture.cases:
  var planner=script.new()
  var configured=planner.configure(scenario.config)
  if scenario.method=="configure":
   check(configured==scenario.expected,scenario.name)
   continue
  check(configured,scenario.name+" configure")
  check(not planner.configure(scenario.config),scenario.name+" one-time configuration")
  var result=planner.callv(scenario.method,scenario.args)
  check(equivalent(result,scenario.expected),scenario.name)
  if not equivalent(result,scenario.expected): print("ACTUAL ",JSON.stringify(result)," EXPECTED ",JSON.stringify(scenario.expected))
  if result.has("instructions"): result.instructions.clear()
  check(equivalent(planner.callv(scenario.method,scenario.args),scenario.expected),scenario.name+" output isolation")
 var isolated=script.new()
 var trusted=fixture.isolation.config.duplicate(true)
 check(isolated.configure(trusted),"isolation configure")
 trusted.sockets.clear()
 trusted.descriptors.clear()
 check(equivalent(isolated.bootstrap(fixture.isolation.snapshot),fixture.isolation.expected),"configuration input isolation")
 var retry=script.new()
 check(not retry.configure({}),"invalid configure does not bind")
 check(retry.configure(fixture.isolation.config),"valid configure after failure")
 for bad in [null,[],Node.new(),{"bad":Callable(self,"run")}, {1:"integer key"}]:
  var invalid=script.new()
  check(not invalid.configure(bad),"native non-data configure rejected")
  check(isolated.bootstrap(bad)=={"error":"INVALID_COMPONENT"},"native non-data snapshot rejected")
  if bad is Node: bad.free()
 var nonfinite=fixture.isolation.config.duplicate(true)
 nonfinite.sockets[0].transform.rotation=INF
 check(not script.new().configure(nonfinite),"native nonfinite rejected")
 var mixed=fixture.isolation.snapshot.duplicate(true)
 mixed.revision=int(mixed.revision)
 mixed.sequence=int(mixed.sequence)
 mixed.components[0].revision=int(mixed.components[0].revision)
 mixed.components[0].upgrade=int(mixed.components[0].upgrade)
 check(equivalent(isolated.bootstrap(mixed),fixture.isolation.expected),"native integer snapshot matches JSON doubles")
 var unchanged=isolated.plan(mixed,fixture.isolation.snapshot)
 check(unchanged.get("instructions")==[],"mixed numeric equal revision is equivalent")
 var file=FileAccess.open("res://validation.json",FileAccess.WRITE)
 file.store_string(JSON.stringify({"checks":checks}))
 quit(0 if checks.all(func(c): return c.passed) else 1)
