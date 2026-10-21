extends SceneTree
var checks = []
func check(value,label):
 checks.append({"name":label,"passed":bool(value)})
 if not value: push_error(label)
class AudioSpy:
 extends Node
 var cues=[]
 func stop_interrupted(): pass
 func stop_all(): pass
 func play_cue(id,_payload): cues.append(id)
 func set_paused(_value): pass
class ActionSpy:
 extends Node
 var clock=0.0
 var evaluation=0.0
 var releases=[]
 func validate_animation(_clip): return true
 func on_animation_changed(_clip,_release): clock=0.0
 func prepare_pose(delta): evaluation=clock+delta
 func advance_pose(delta,_rate=1): clock+=delta
 func time_to_release(): return 0.2-clock if clock<0.2-0.0000001 else INF
 func queue_projectile(id,_payload): releases.append([id,evaluation])
 func claim_release_sound(_id,_time,_payloads): return true
func _initialize(): call_deferred("run")
func run():
 var scene=load("res://character.tscn")
 var a=scene.instantiate()
 var b=scene.instantiate()
 root.add_child(a)
 root.add_child(b)
 await process_frame
 a.set_process(false)
 b.set_process(false)
 var tip=a.get_node("Skeleton/root/tip")
 var markers=[]
 a.animation_marker.connect(func(id,_name,_payload): markers.append(id))
 a.play_animation("a")
 a.advance_animation(0.5)
 a.play_animation("b")
 check(markers==["bStart"],"incoming time-zero cue dispatches immediately")
 a.advance_animation(0.1)
 check(tip.rotation>0.05 and tip.rotation<0.95,"native mixer interpolates transition midpoint")
 check(not markers.has("aLate"),"outgoing marker suppressed during blend")
 a.advance_animation(0.1)
 check(markers==["bStart","bCue"],"incoming cue uses authored clock without fade delay")
 a.play_animation("a")
 a.advance_animation(0.1)
 a.play_animation("b")
 a.advance_animation(0.21)
 check(markers.count("bCue")==2 and markers.count("bStart")==2,"interrupted alternating blend has one incoming cue owner")
 a.advance_animation(0.25)
 check(absf(tip.rotation-1.0)<0.001,"destination transform exact after blend")
 a.play_animation("b")
 check(a.elapsed==0 and absf(tip.rotation-1.0)<0.001,"same canonical clip restarts immediately")
 check(markers.count("bStart")==3,"same clip time-zero cue exactly once")
 a.advance_animation(0.21)
 check(markers.count("bCue")==3,"same clip later cue exactly once")
 var before=markers.size()
 a.play_animation("a")
 a.advance_animation(0.1)
 a.play_animation("b")
 before=markers.size()
 a.seek_animation(0.8)
 check(markers.size()==before,"seek is silent")
 check(absf(tip.rotation-1.0)<0.001,"seek ends an in-progress fade immediately")
 a.advance_animation(0.21)
 check(a.current=="idle","completed action returns idle")
 a.play_animation("death")
 a.advance_animation(1.1)
 check(a.current=="death" and a.held,"death holds final transform")
 a.play_animation("Revive")
 check(not a.held and a.elapsed==0,"revive starts new clock")
 a.play_animation("loop")
 markers.clear()
 a.advance_animation(2.1)
 check(markers==["tail","zero","tail","zero"],"loop crossings include each new zero cue once")
 if a.tree:
  var playback=a.tree.get("parameters/playback")
  a.play_animation("b")
  a.advance_animation(0.05)
  playback.travel("Hit")
  a.advance_animation(0.21)
  check(a.current=="hit" and markers.count("hitCue")==1,"external alias travel adopts incoming cue clock")
  playback.travel("Hit")
  a.advance_animation(0)
  a.advance_animation(0.21)
  check(markers.count("hitCue")==2,"external alias self travel restarts cues once")
 a.clip_metadata.b.events=[{"id":"nearEnd","name":"nearEnd","time":0.999999}]
 a.play_animation("b")
 markers.clear()
 a.advance_animation(0.999995)
 check(a.current=="b" and markers.is_empty(),"nonloop clip remains active before exact end")
 a.advance_animation(0.000006)
 check(markers==["nearEnd"] and a.current=="idle","near-end cue dispatches before exact completion")
 a.clip_metadata.death.events=[{"id":"deathEnd","name":"deathEnd","time":0.999999}]
 a.play_animation("death")
 markers.clear()
 a.advance_animation(0.999995)
 check(a.current=="death" and not a.held and markers.is_empty(),"death does not hold before exact end")
 a.advance_animation(0.000006)
 check(markers==["deathEnd"] and a.held,"death near-end cue dispatches before final hold")
 # Finite positive event times retain exact half-open crossing semantics.
 for looping in [false,true]:
  a.clip_metadata.b.loop=looping
  a.clip_metadata.b.events=[{"id":"nearZero","name":"nearZero","time":0.0000000005}]
  a.play_animation("b")
  markers.clear()
  a.advance_animation(0.0000000005)
  check(markers==["nearZero"],"subnanosecond cue after zero is crossed once loop="+str(looping))
  a.advance_animation(0)
  check(markers==["nearZero"],"subnanosecond cue is not redelivered loop="+str(looping))
  a.clip_metadata.b.events=[{"id":"nearSeek","name":"nearSeek","time":0.2}]
  a.play_animation("b")
  a.seek_animation(0.2-0.0000000005)
  markers.clear()
  a.advance_animation(0.000000001)
  check(markers==["nearSeek"],"silent seek immediately before cue preserves crossing loop="+str(looping))
 a.clip_metadata.b.loop=false
 a.clip_metadata.loop.events=[{"id":"loopZero","name":"loopZero","time":0},{"id":"loopTail","name":"loopTail","time":0.98}]
 a.play_animation("loop")
 a.advance_animation(0.95)
 markers.clear()
 var native_mixer=a.tree if a.tree else a.player
 native_mixer.advance(0.1)
 a.advance_animation(0)
 check(markers==["loopTail","loopZero"],"external native loop wrap is not mistaken for restart")
 a.clip_metadata.b.events=[{"id":"switchDeath","name":"switchDeath","time":0.2}]
 a.play_animation("b")
 var switch_callback=func(_id,_name,_payload): a.play_animation("death")
 a.animation_marker.connect(switch_callback,CONNECT_ONE_SHOT)
 native_mixer.advance(0.5)
 a.advance_animation(0)
 check(a.current=="death" and a.elapsed==0 and not a.held,"external crossed marker preserves reentrant new clip clock")
 a.clip_metadata.b.events=[{"id":"switchAtStart","name":"switchAtStart","time":0}]
 a.play_animation("idle")
 a.animation_marker.connect(switch_callback,CONNECT_ONE_SHOT)
 if a.tree:
  a.tree.get("parameters/playback").travel("b")
  a.tree.advance(0.5)
  a.advance_animation(0)
  check(a.current=="death" and a.elapsed==0 and not a.held,"external adopted start marker preserves reentrant new clip clock")
 else:
  a.animation_marker.disconnect(switch_callback)
 var real_actions=a.get_node("ActionController")
 var real_releases=[]
 real_actions.projectile_released.connect(func(_action,_cue,_projectile):
  real_releases.append(true)
  a.play_animation("death"),CONNECT_ONE_SHOT)
 check(a.begin_action({"characterInstance":"blend","actionInstance":"releaseReentry","target":{"position":[400,250],"valid":true},"releaseAt":0.2,"impactAt":0.7}),"real release callback action accepted")
 a.play_animation("shot")
 a.advance_animation(0.8)
 check(real_releases.size()==1 and a.current=="death" and a.elapsed==0 and not a.held,"real projectile release callback cancels old multi-piece advance")
 real_actions.projectile_released.connect(func(_action,_cue,_projectile): a.seek_animation(0),CONNECT_ONE_SHOT)
 a.begin_action({"characterInstance":"blend","actionInstance":"releaseSeek","target":{"position":[400,250],"valid":true},"releaseAt":0.2,"impactAt":0.7})
 a.play_animation("shot")
 a.advance_animation(0.8)
 check(a.current=="shot" and a.elapsed==0,"real projectile release seek cancels old multi-piece advance")
 a.clip_metadata.b.events=[]
 a.play_animation("b")
 var finished=[]
 var mixer_callback=func():
  if finished.is_empty() and a.tree.get("parameters/playback").get_current_play_position()>0:
   finished.append(true)
   a.play_animation("death")
 if a.tree:
  native_mixer.mixer_applied.connect(mixer_callback)
 else:
  native_mixer.animation_finished.connect(func(_name):
   finished.append(true)
   a.play_animation("death"),CONNECT_ONE_SHOT)
 a.advance_animation(1.1)
 if a.tree: native_mixer.mixer_applied.disconnect(mixer_callback)
 check(finished.size()==1 and a.current=="death" and a.elapsed==0 and not a.held,"native mixer callback cancels old advance" if a.tree else "native animation-finished callback cancels old advance")
 var audio=AudioSpy.new()
 var actions=ActionSpy.new()
 a.audio=audio
 a.actions=actions
 a.clip_metadata.b.events=[{"id":"sound","type":"sound","time":0.2,"payload":{}},{"id":"arrow","type":"projectile","time":0.2,"payload":{}},{"id":"outgoing","type":"sound","time":0.3,"payload":{}}]
 a.play_animation("a")
 a.advance_animation(0.5)
 a.play_animation("b")
 a.advance_animation(0.2)
 check(audio.cues==["sound"] and actions.releases.size()==1 and absf(actions.releases[0][1]-0.2)<0.00001,"sound and projectile dispatch at prepared authored action clock")
 a.play_animation("a")
 a.advance_animation(0.2)
 check(audio.cues==["sound"] and actions.releases.size()==1,"outgoing sound and projectile never dispatch")
 check(b.current=="idle" and b.elapsed==0,"instances own independent clocks and transforms")
 a.audio=null
 a.actions=null
 audio.free()
 actions.free()
 a.free()
 b.free()
 var valid=true
 for item in checks: valid=valid and item.passed
 var file=FileAccess.open("res://blend-validation.json",FileAccess.WRITE)
 file.store_string(JSON.stringify({"valid":valid,"checks":checks}))
 file.close()
 quit(0 if valid else 1)

