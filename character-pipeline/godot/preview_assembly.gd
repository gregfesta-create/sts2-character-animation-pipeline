extends SceneTree
# This script is staged beside immutable reachable runtime resources only. Every
# automatic process mode is disabled before _ready, including ALWAYS children.
var character
var assembly
var skeleton
var skeleton_id=0
var request={}
var plan={}
var error_message=""
var current_time=0.0
var observations=[]
var observation_count=0
var unexpected_marker_count=0
var steps_taken=0
var owners_seen={}
var receipt={}
func _initialize():
 node_added.connect(_silence_node)
 call_deferred("run")
func _fail(message):
 if error_message.is_empty(): error_message=message
 return false
func _silence_node(node):
 if character==null or not (node==character or character.is_ancestor_of(node)): return
 node.process_mode=Node.PROCESS_MODE_DISABLED
 if node.has_method("advance_animation"):
  node.preview_silent=true
  node.suppress_cues=true
  if node.has_signal("animation_marker") and not node.animation_marker.is_connected(_unexpected_marker): node.animation_marker.connect(_unexpected_marker)
  if node.has_signal("animation_runtime_error") and not node.animation_runtime_error.is_connected(_animation_error): node.animation_runtime_error.connect(_animation_error)
func _unexpected_marker(_id,_name,_payload):
 unexpected_marker_count+=1
 _fail("Preview owner emitted an unexpected animation marker")
func _animation_error(code,message): _fail(str(code)+": "+str(message))
func _freeze():
 var pending=[character]
 var count=0
 while not pending.is_empty():
  var node=pending.pop_back()
  count+=1
  if count>32768: return _fail("Owned node traversal exceeds budget")
  _silence_node(node)
  for child in node.get_children(): pending.append(child)
 return true
func _owners():
 var result=[]
 var pending=[character]
 var count=0
 while not pending.is_empty():
  var node=pending.pop_front()
  count+=1
  if count>32768:
   _fail("Animation ownership traversal exceeds budget")
   return []
  if node.has_method("advance_animation") and node.is_node_ready():
   if not node.preview_silent or node.sound_dispatch_count!=0 or node.marker_dispatch_count!=0:
    _fail("Preview owner dispatched cues or was not silenced before ready")
    return []
   result.append(node)
  for child in node.get_children(): pending.append(child)
 return result
func _phase(component_id,socket,operation,phase_id,generation):
 observation_count+=1
 if observations.size()<4096: observations.append({"componentId":component_id,"socket":socket,"operation":operation,"phaseId":phase_id,"generation":generation,"time":current_time})
func _advance(delta):
 steps_taken+=1
 if steps_taken>8192: return _fail("Fixed simulation step budget exceeded")
 if not assembly.advance(delta): return _fail("Assembly advancement failed: "+assembly.last_error)
 # Breadth-first tree order is deterministic; each distinct ready owner appears
 # exactly once. Assembly's native controller does not advance local animations.
 for owner in _owners():
  if not is_instance_valid(owner): continue
  owners_seen[str(owner.get_instance_id())]=true
  if owner.current=="": continue
  if not owner.advance_animation(delta): return _fail("Local animation advancement failed")
  if not owner.last_error.is_empty(): return _fail("Local animation owner runtime error")
 if not _freeze(): return false
 return error_message.is_empty()
func run():
 var parsed=JSON.parse_string(FileAccess.get_file_as_string("res://assembly-request.json"))
 if not parsed is Dictionary or parsed.get("version")!=1:
  _fail("Invalid assembly capture request")
  _finish()
  return
 request=parsed
 plan=request.plan
 if not plan.frames is Array or plan.frames.is_empty() or plan.frames.size()>64 or plan.simulation.maximumSteps!=8192:
  _fail("Invalid assembly frame budget")
  _finish()
  return
 var packed=load("res://"+request.scene)
 if not packed is PackedScene:
  _fail("Missing cached runtime scene")
  _finish()
  return
 character=packed.instantiate()
 _silence_node(character)
 if not _freeze():
  _finish()
  return
 var viewport=SubViewport.new()
 viewport.size=Vector2i(int(plan.renderLayout.pixels[0]),int(plan.renderLayout.pixels[1]))
 viewport.transparent_bg=true
 viewport.render_target_update_mode=SubViewport.UPDATE_ALWAYS
 root.add_child(viewport)
 var projection=Node2D.new()
 projection.scale=Vector2.ONE*float(plan.renderLayout.scale)
 viewport.add_child(projection)
 projection.add_child(character)
 assembly=character.get_node_or_null("AssemblyController")
 skeleton=character.get_node_or_null("Skeleton")
 if assembly==null or skeleton==null:
  _fail("Assembly or chassis skeleton is absent")
  _finish()
  return
 skeleton_id=skeleton.get_instance_id()
 for attempt in range(8):
  if assembly.ready_for_state: break
  if not _freeze(): break
  await process_frame
 if not assembly.ready_for_state or assembly.ready_for_batches or not assembly.get_state().is_empty():
  _fail("Saved production assembly was bound or failed readiness")
  _finish()
  return
 if not assembly.bind_authoritative(plan.instanceId):
  _fail("Preview identity binding failed")
  _finish()
  return
 assembly.transition_phase.connect(_phase)
 receipt={"version":1,"planHash":plan.planHash,"compiledSpecHash":plan.compiledSpecHash,"inventoryHash":request.inventoryHash,"frames":[],"applied":[],"startedUnbound":true}
 var next_step=0
 for frame in plan.frames:
  var target=float(frame.time)
  while error_message.is_empty():
   if next_step<plan.steps.size() and float(plan.steps[next_step].time)<=current_time+0.00000001:
    var step=plan.steps[next_step]
    var response=assembly.receive_snapshot(step.snapshot)
    if response.get("status")!="applied":
     _fail("Preview snapshot rejected: "+JSON.stringify(response))
     break
    receipt.applied.append({"configurationId":step.configurationId,"time":step.time})
    next_step+=1
    if not _freeze(): break
    continue
   if current_time>=target-0.00000001: break
   var destination=minf(target,current_time+1.0/60.0)
   if next_step<plan.steps.size(): destination=minf(destination,float(plan.steps[next_step].time))
   var delta=destination-current_time
   if delta<=0:
    _fail("Nonprogressing simulation schedule")
    break
   current_time=destination
   if not _advance(delta): break
  if not error_message.is_empty(): break
  if not _freeze(): break
  await process_frame
  await RenderingServer.frame_post_draw
  if not _freeze(): break
  if not is_instance_valid(skeleton) or skeleton.get_instance_id()!=skeleton_id or character.get_node_or_null("Skeleton")!=skeleton:
   _fail("Chassis skeleton identity changed")
   break
  var image=viewport.get_texture().get_image()
  var filename="assembly-frame-"+str(int(frame.index))+".png"
  if filename!=frame.filename or image.get_width()!=int(plan.renderLayout.pixels[0]) or image.get_height()!=int(plan.renderLayout.pixels[1]) or image.save_png("res://"+filename)!=OK:
   _fail("Assembly capture save failed")
   break
  var ids=assembly.records.keys()
  ids.sort()
  var states=[]
  for id in ids:
   var record=assembly.records[id]
   states.append({"id":id,"type":record.type,"socket":record.socket,"revision":record.state.revision})
  receipt.frames.append({"index":frame.index,"time":frame.time,"path":filename,"configurationId":frame.configurationId,"components":ids,"componentStates":states,"width":image.get_width(),"height":image.get_height(),"sha256":FileAccess.get_sha256("res://"+filename),"skeletonPreserved":true})
 if error_message.is_empty() and (next_step!=plan.steps.size() or not assembly.records.is_empty() or not assembly.pending.is_empty()): _fail("Preview did not complete with an empty assembly")
 receipt.simulationSteps=steps_taken
 receipt.ownersAdvanced=owners_seen.size()
 receipt.allOwnersSilent=true
 receipt.unexpectedMarkerCount=unexpected_marker_count
 receipt.phaseObservations=observations
 receipt.phaseObservationCount=observation_count
 receipt.phaseObservationsTruncated=observation_count>4096
 receipt.skeletonPreserved=is_instance_valid(skeleton) and skeleton.get_instance_id()==skeleton_id
 receipt.finalEmpty=assembly.records.is_empty() and assembly.pending.is_empty()
 _finish()
func _finish():
 var output=FileAccess.open("res://assembly-receipt.json",FileAccess.WRITE)
 if output!=null:
  if not error_message.is_empty(): receipt.error=error_message
  output.store_string(JSON.stringify(receipt))
 if not error_message.is_empty():
  push_error(error_message)
  quit(1)
 else: quit(0)

