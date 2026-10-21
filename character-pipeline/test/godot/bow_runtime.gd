extends SceneTree
var checks=[]
var primary_target=[400.0,250.0]
func check(value,label):
	checks.append({"name":label,"passed":bool(value)})
	if not value: push_error(label)
func _initialize(): call_deferred("run")
func context(id,release=0.5,impact=1.0,owner="a"):
	return {"characterInstance":owner,"actionInstance":id,"target":{"position":primary_target.duplicate() if owner=="a" else [400,250],"valid":true},"releaseAt":release,"impactAt":impact}
func launch_direct(actor,id,owner="pool"):
	var controller=actor.get_node("ActionController")
	actor.begin_action(context(id,0,0.1,owner))
	controller.queue_projectile("shoot",{"projectile":"arrowShot","sourceSocket":"release"})
	controller.advance_pose(0)
func instance(packed):
	var actor=packed.instantiate()
	root.add_child(actor)
	actor.set_process(false)
	return actor
func run():
	var packed=load("res://character.tscn")
	var parent=Node2D.new()
	parent.position=Vector2(280,50)
	parent.rotation=0.2
	parent.scale=Vector2(-1.1,0.8)
	root.add_child(parent)
	var a=packed.instantiate()
	parent.add_child(a)
	a.set_process(false)
	var b=packed.instantiate()
	root.add_child(b)
	b.position=Vector2(190,100)
	b.set_process(false)
	var actions=a.get_node("ActionController")
	var releases=[]
	var sounds=[]
	var sound_assets=[]
	var hits=[]
	actions.projectile_released.connect(func(action,cue,_projectile): releases.append([action,cue]))
	actions.authoritative_impact.connect(func(action,cue,_position): hits.append([action,cue]))
	a.get_node("AudioController").cue_started.connect(func(id,voice): sounds.append(id);sound_assets.append(voice.stream))
	check(a.get_node("AudioController").sounds.has("impact"),"declared authoritative impact-only asset is packaged without timeline cue")
	check(not a.get_node("AudioController").sounds.has("unusedImpact") and not actions.projectile_definitions.has("unusedShot"),"unused projectile impact assets are pruned without reading missing source")
	var rest_line=actions.get_node("string")
	check(absf(rest_line.points[0].x-rest_line.points[1].x)<0.001 and absf(rest_line.points[1].x-rest_line.points[2].x)<0.001,"resting string is straight between actual curved limb tips")
	var rest_mesh=a.get_node("Meshes/upper").polygon
	check(rest_mesh.size()==10 and rest_mesh[4].x>rest_mesh[0].x and rest_mesh[8].x<rest_mesh[0].x,"resting bow has multi-row curved contour before any draw")
	a.play_animation("draw")
	var grip=a.get_node("Skeleton/root").global_position
	var tip_before=a.get_node("Skeleton/root/upper/upperTip").global_transform*Vector2(-20,-30)
	a.advance_animation(0.5)
	check(absf(a.get_node("Skeleton/root/upper/upperTip").rotation+0.35)<0.001,"weighted bow limb bends across independent segments")
	var line=actions.get_node("string")
	var tip_after=a.get_node("Skeleton/root/upper/upperTip").global_transform*Vector2(-20,-30)
	check(a.get_node("Skeleton/root").global_position==grip and tip_before.distance_to(tip_after)>10,"bow grip stays fixed while upper tip bends toward draw")
	check(line.to_global(line.points[0]).distance_to(tip_after)<0.001,"string tip anchor follows complete bone transform")
	var limb=a.get_node("Meshes/upper")
	var fixed_weights=false
	var tip_weights=false
	for index in limb.get_bone_count():
		var weights=limb.get_bone_weights(index)
		if str(limb.get_bone_path(index))=="root": fixed_weights=weights[0]==1 and weights[1]==1
		if str(limb.get_bone_path(index))=="root/upper/upperTip": tip_weights=weights[8]==1 and weights[9]==1
	check(fixed_weights and tip_weights,"limb grip vertices stay root-weighted while tip vertices deform")
	check(line.points[1].x<line.points[0].x-20 and line.points[0].x<110,"drawing increases bow curvature and pulls string into a deeper V")
	check(line.to_global(line.points[1]).distance_to(a.get_node("Skeleton/root/nock").global_position)<0.001,"string nock remains exactly aligned after mirrored parent pose")
	a.play_animation("hold")
	a.advance_animation(0.3)
	var hold=a.get_node("Skeleton/root/nock").position
	a.advance_animation(0.3)
	check(hold==a.get_node("Skeleton/root/nock").position,"hold pose remains stable")
	check(absf(a.get_node("Skeleton/root/upper/upperTip").rotation+0.35)<0.001,"hold retains bent limb pose")
	var predicted_source=a.get_node("Skeleton/root/nock").global_transform
	var agreed_target=predicted_source.origin+predicted_source.basis_xform(Vector2(1,0)).normalized()*140
	primary_target=[agreed_target.x,agreed_target.y]
	check(a.begin_action(context("shot1")),"typed action context accepted")
	a.play_animation("releaseBow")
	a.advance_animation(0.5)
	check(actions.active_projectile_count()==1,"one arrow releases at cue")
	var projectile=actions.active_projectiles()[0]
	var source=a.get_node("Skeleton/root/nock").global_transform
	var target_direction=(agreed_target-source.origin).normalized()
	var bow_forward=a.get_node("Skeleton/root").global_transform.basis_xform(Vector2(1,0)).normalized()
	var nocked_forward=source.basis_xform(Vector2(1,0)).normalized()
	check(bow_forward.dot(target_direction)>0.999 and nocked_forward.dot(target_direction)>0.999,"bow and nocked arrow face the actual release target before detachment")
	check(projectile.global_position.distance_to(source.origin)<0.001,"detachment has no jump under mirrored rotated scaled ancestors")
	check(projectile.global_transform.basis_xform(Vector2(1,0)).normalized().distance_to(target_direction)<0.001,"projectile forward axis aims at target despite mirrored ancestors")
	check(projectile.get_child(0).texture==a.get_node("Meshes/arrow").texture,"released visual shares immutable source texture")
	check(not a.get_node("Meshes/arrow").visible,"nocked arrow hidden after release")
	check(b.get_node("ActionController").active_projectile_count()==0,"second archer has isolated action state")
	a.advance_animation(0.25)
	check(projectile.global_position.distance_to(source.origin.lerp(agreed_target,0.5))<0.01,"arrow advances half way on agreed impact clock")
	await RenderingServer.frame_post_draw
	root.get_texture().get_image().save_png("res://bow-flight.png")
	a.advance_animation(0.25)
	check(projectile.global_position.distance_to(agreed_target)<0.01,"arrow reaches captured target at authoritative impact boundary")
	check(hits.is_empty(),"arrival never fabricates authoritative hit or damage")
	check(not a.authoritative_hit("shot1","impact",{"clock":0.9}),"early authoritative hit timing rejected")
	check(not a.authoritative_hit("shot1","impact",{"clock":1.0,"sound":"twang"}),"undeclared hit sound is rejected without consuming cue identity")
	for release_cue in ["unknown", "", "x".repeat(129), 7, null]:
		var sound_count=sounds.size()
		check(not a.authoritative_hit("shot1","explicitImpact",{"clock":1.0,"releaseCue":release_cue}) and not actions.ledger.shot1.hits.has("explicitImpact") and sounds.size()==sound_count and hits.is_empty(),"invalid explicit release cue rejected before hit or sound mutation: "+str(release_cue))
	check(a.authoritative_hit("shot1","impact",{"clock":1.0}),"trusted authoritative hit owns declared default impact sound")
	check(sound_assets[-1]==a.get_node("AudioController").sounds.get("impact",{}).get("stream"),"authoritative hit plays distinct declared impact asset")
	check(not a.authoritative_hit("shot1","impact",{"clock":1.0}) and hits.size()==1,"duplicate authoritative hit is ignored")
	check(sounds==["releaseSound","impact"],"release and authoritative impact sounds have separate single owners")
	var missing=context("missing")
	missing.target.valid=false
	check(not a.begin_action(missing),"invalid target rejected before release")
	var invalid=context("invalid",1,0.5)
	check(not a.begin_action(invalid),"impossible release impact timing rejected")
	a.cancel_action()
	check(not a.begin_action(context("unmatchedPhase",0.25,0.75)),"unmatched authored release phase is rejected before action acceptance")
	check(not a.play_animation("releaseBow") and a.current=="idle","release playback before action context is explicitly refused")
	check(not a.begin_action(context("reverseUnmatched",0.25,0.75)),"reversed playback context order cannot accept unsupported release timing")
	check(a.begin_action(context("phaseSelection")),"matching authored release phase is accepted")
	check(not a.play_animation("directRelease") and a.current=="idle","incompatible selected release clip is refused before playback")
	if a.tree:
		var prior=releases.size()
		a.tree.get("parameters/playback").travel("directRelease")
		a.advance_animation(0)
		check(a.current=="idle" and releases.size()==prior,"external incompatible zero-time release is refused without reentrant evaluation")
	check(a.play_animation("releaseBow"),"matching release clip remains playable after timing refusal")
	a.cancel_action()
	a.begin_action(context("delayedStart"))
	a.advance_animation(0.25)
	var delayed_releases=releases.size()
	var delayed_sounds=sounds.size()
	check(not actions.claim_release_sound("clockProbe",0.5,[{"projectile":"arrowShot","sourceSocket":"release"}]) and not actions.ledger.delayedStart.sounds.has("clockProbe"),"release sound clock refusal does not consume its dedup identity")
	check(not a.play_animation("releaseBow") and a.current=="idle","delayed release clip start is refused before playback")
	a.advance_animation(0.5)
	check(releases.size()==delayed_releases and sounds.size()==delayed_sounds,"refused delayed action emits neither arrow nor release sound")
	a.cancel_action()
	if a.tree:
		a.begin_action(context("externalDelayed"))
		a.advance_animation(0.25)
		a.tree.get("parameters/playback").travel("releaseBow")
		a.advance_animation(0)
		check(a.current=="idle" and releases.size()==delayed_releases and sounds.size()==delayed_sounds,"external delayed release clip start is refused before any cue")
		a.cancel_action()
	var generation=context("generation")
	generation.generation=7.0
	check(a.begin_action(generation) and actions.context.generation==7.0,"optional generation token preserves JSON-safe integer identity")
	a.cancel_action()
	var old_releases=releases.size()
	check(a.begin_action(context("cancelled")),"next action accepted")
	a.play_animation("releaseBow")
	a.advance_animation(0.25)
	a.cancel_action()
	a.advance_animation(0.75)
	check(releases.size()==old_releases and a.get_node("Meshes/arrow").visible,"before release cancellation restores nocked part without firing")
	a.begin_action(context("seeked"))
	a.play_animation("releaseBow")
	a.seek_animation(0.75)
	a.advance_animation(0.1)
	check(releases.size()==old_releases,"silent seek does not release a projectile")
	a.begin_action(context("dedup"))
	a.play_animation("releaseBow")
	a.advance_animation(0.5)
	var once=releases.size()
	var sound_once=sounds.size()
	a.play_animation("releaseBow")
	a.advance_animation(0.5)
	check(releases.size()==once and sounds.size()==sound_once,"same action cue cannot duplicate projectile or release sound")
	a.cancel_action()
	a.begin_action(context("multishot"))
	a.play_animation("multiRelease")
	once=releases.size()
	sound_once=sounds.size()
	a.advance_animation(0.5)
	check(releases.size()==once+2 and sounds.size()==sound_once+1,"two simultaneous arrows share exactly one release sound")
	a.cancel_action()
	a.begin_action(context("invalidated"))
	a.play_animation("releaseBow")
	a.update_action_target("invalidated",{"position":primary_target.duplicate(),"valid":false})
	old_releases=releases.size()
	sound_once=sounds.size()
	a.advance_animation(0.5)
	check(releases.size()==old_releases and sounds.size()==sound_once,"target invalidated before release cancels arrow and release sound")
	a.cancel_action()
	a.begin_action(context("moving"))
	a.play_animation("releaseBow")
	a.advance_animation(0.5)
	var moving=actions.active_projectiles()[-1]
	a.advance_animation(0.1)
	var before=moving.global_position
	var moved_target=agreed_target+Vector2(-15,5)
	check(a.update_action_target("moving",{"position":[moved_target.x,moved_target.y],"valid":true}) and moving.global_position==before,"authoritative moving target updates trajectory without jump")
	a.advance_animation(0.4)
	check(moving.global_position.distance_to(moved_target)<0.01,"updated target still arrives at agreed impact boundary")
	a.begin_action(context("removedTarget"))
	a.play_animation("releaseBow")
	a.advance_animation(0.5)
	var captured=actions.active_projectiles()[-1]
	a.update_action_target("removedTarget",{"position":[999,999],"valid":false})
	a.advance_animation(0.5)
	check(captured.global_position.distance_to(agreed_target)<0.01,"target invalid after release retains captured endpoint")
	a.begin_action(context("parallelA"))
	b.begin_action(context("parallelB",0.5,1.0,"b"))
	a.play_animation("releaseBow")
	b.play_animation("releaseBow")
	a.advance_animation(0.5)
	b.advance_animation(0.5)
	var pa=actions.active_projectiles()[-1]
	var pb=b.get_node("ActionController").active_projectiles()[-1]
	check(pa!=pb and pa.flight.owner.get_ref()!=pb.flight.owner.get_ref(),"two concurrent archers own independent projectile instances")
	a.set_process(true)
	paused=true
	before=pa.global_position
	await process_frame
	await process_frame
	check(pa.global_position==before,"scene pause freezes released projectile clock")
	paused=false
	await process_frame
	await process_frame
	check(pa.global_position!=before,"unpause resumes released projectile clock")
	a.set_process(false)
	a.cancel_action()
	actions.detach_projectiles()
	b.get_node("ActionController").detach_projectiles()
	var no_source=instance(packed)
	var no_manager=no_source.get_node("ActionController")
	var mount=no_source.get_node(no_manager.socket_paths.release)
	mount.get_parent().remove_child(mount)
	mount.free()
	no_source.begin_action(context("noSocket",0.5,1.0,"no_source"))
	no_source.play_animation("releaseBow")
	no_source.advance_animation(0.5)
	check(no_manager.active_projectile_count()==0 and no_source.get_node("AudioController").active_voice_count()==0,"removed source socket cancels release and sound")
	no_source.queue_free()
	var partial=instance(packed)
	var partial_manager=partial.get_node("ActionController")
	var spare=partial.get_node(partial_manager.socket_paths.releaseSpare)
	spare.get_parent().remove_child(spare)
	spare.free()
	var partial_sounds=[]
	var partial_diagnostics=[]
	partial.get_node("AudioController").cue_started.connect(func(id,_voice): partial_sounds.append(id))
	partial_manager.action_error.connect(func(code,_message): partial_diagnostics.append(code))
	partial.begin_action(context("partial",0.5,1.0,"partial"))
	partial.play_animation("partialRelease")
	partial.advance_animation(0.5)
	check(partial_manager.active_projectile_count()==1 and partial_sounds==["releaseSound"] and partial_diagnostics.has("PROJECTILE_SOURCE_MISSING"),"mixed valid and removed sources keep valid arrow and one release sound with diagnostic")
	check(not partial.authoritative_hit("partial","receiverHit",{"clock":1.0,"releaseCue":"shootB"}) and not partial_manager.ledger.partial.hits.has("receiverHit") and partial_sounds==["releaseSound"],"authored but unreleased source cue cannot confirm hit or play sound")
	check(partial.authoritative_hit("partial","receiverHit",{"clock":1.0,"releaseCue":"shootA"}) and partial_manager.ledger.partial.hits.has("receiverHit") and partial_sounds==["releaseSound","receiverHit"],"actually released cue accepts distinct hit identity after rejected source without consuming hit dedup")
	check(not partial.authoritative_hit("partial","receiverHit",{"clock":1.0,"releaseCue":"shootA"}) and partial_sounds==["releaseSound","receiverHit"],"explicit source preserves authoritative duplicate hit suppression")
	partial.queue_free()
	var pool=[]
	for index in 9: pool.append(instance(packed))
	for index in 32: launch_direct(pool[0],"cap"+str(index))
	var oldest=pool[0].get_node("ActionController").active_projectiles()[0]
	launch_direct(pool[0],"cap32")
	check(oldest.is_queued_for_deletion() and pool[0].get_node("ActionController").active_projectile_count()==32,"character cap retires oldest owned projectile")
	for owner in range(1,8):
		for index in 32: launch_direct(pool[owner],"scene"+str(index))
	oldest=pool[0].get_node("ActionController").active_projectiles()[0]
	launch_direct(pool[8],"overflow")
	check(oldest.is_queued_for_deletion() and root.get_meta("_pipeline_projectiles").size()==256,"scene cap retires oldest visual across characters")
	for actor in pool: actor.queue_free()
	await process_frame
	var removed=instance(packed)
	launch_direct(removed,"cancelOnRemove","removed")
	var cancelled=removed.get_node("ActionController").active_projectiles()[0]
	root.remove_child(removed)
	check(cancelled.is_queued_for_deletion(),"default owner removal cancels projectile")
	removed.free()
	var finishing=instance(packed)
	var manager=finishing.get_node("ActionController")
	manager.projectile_definitions=manager.projectile_definitions.duplicate(true)
	manager.projectile_definitions.arrowShot.removalPolicy="finish"
	launch_direct(finishing,"finishOnRemove","finishing")
	var independent=manager.active_projectiles()[0]
	root.remove_child(finishing)
	finishing.free()
	check(not independent.is_queued_for_deletion(),"finish policy survives owner removal")
	independent.advance_projectile(0.05)
	check(independent.flight.elapsed==0.05,"detached finished projectile keeps independent clock")
	independent.advance_projectile(2.1)
	check(independent.is_queued_for_deletion(),"finite projectile lifetime cleans detached visual")
	var valid=true
	for c in checks: valid=valid and c.passed
	var f=FileAccess.open("res://bow-validation.json",FileAccess.WRITE)
	f.store_string(JSON.stringify({"valid":valid,"checks":checks}))
	f.close()
	a.queue_free();b.queue_free();parent.queue_free()
	await create_timer(0.1).timeout
	call_deferred("quit",0 if valid else 1)
