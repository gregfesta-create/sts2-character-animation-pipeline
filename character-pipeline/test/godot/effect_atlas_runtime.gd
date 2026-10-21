extends SceneTree
var checks: Array = []
func check(value: bool,label: String) -> void:
 checks.append({"name":label,"passed":value})
 if not value: push_error(label)
func _initialize() -> void: call_deferred("run")
func capture(label: String) -> Image:
 await process_frame
 await RenderingServer.frame_post_draw
 var image=root.get_texture().get_image()
 image.save_png("res://"+label+".png")
 return image
func run() -> void:
 var request=JSON.parse_string(FileAccess.get_file_as_string("res://probe.json"))
 check(ProjectSettings.load_resource_pack(request.pack,false),"namespaced pack mounted")
 for entry in request.files:
  check(FileAccess.get_sha256("res://"+entry.path)==entry.hash,"exact packed capture "+entry.path)
 var scene=load(request.rootScene)
 check(scene is PackedScene,"serialized packed scene reloaded")
 var character=scene.instantiate()
 character.position=Vector2(32,32)
 root.add_child(character)
 await process_frame
 await process_frame
 character.set_process(false)
 var bridge=character.get_node("EffectController")
 check(bridge.ready_for_effects,"compiled bridge ready")
 for effect in bridge.compiled_catalog:
  check(effect.presentation.frames.size()==2,"two serialized atlas frames "+effect.id)
  check(effect.presentation.frames[0] is AtlasTexture and effect.presentation.frames[1] is AtlasTexture,"AtlasTexture resources retained "+effect.id)
  check(effect.presentation.frames[0].atlas==effect.presentation.frames[1].atlas,"one shared embedded sheet "+effect.id)
 var before=await capture("before")
 check(before.get_pixel(64,64).r>0.7 and before.get_pixel(64,64).g>0.4,"gold base visible")
 var mesh=character.get_node("Meshes/panel")
 var center=mesh.global_position
 print("PANEL_CENTER ",center)
 var facts={"characterInstance":bridge.status().characterInstance,"adapterContractVersion":"synthetic-v1","sequence":1,"bindings":{"syntheticPower":{"present":true,"amount":1}}}
 check(bridge.observe(facts),"synthetic whileActive observation accepted")
 var times=[0.0,0.099,0.1,0.199,0.2,0.4]
 for t in times:
  check(bridge.advance(t),"monotonic native clock "+str(t))
  var image=await capture("frame-"+str(t))
  check(image.get_pixel(64,64)==before.get_pixel(64,64),"base pixels unchanged "+str(t))
  var left=image.get_pixel(12,32)
  var right=image.get_pixel(52,32)
  var first=t<0.1 or t>=0.2
  check((left.r>0.9 and left.b<0.1) if first else (left.b>0.9 and left.r<0.1),"loop frame at boundary "+str(t))
  check((right.r>0.9 and right.b<0.1) if t<0.1 else (right.b>0.9 and right.r<0.1),"nonloop holds last "+str(t))
 facts.sequence=2
 facts.bindings.syntheticPower={"present":false,"amount":0}
 check(bridge.observe(facts),"synthetic removal accepted")
 var cleared=await capture("cleared")
 check(cleared.get_pixel(12,32)==before.get_pixel(12,32) and cleared.get_pixel(52,32)==before.get_pixel(52,32),"overlays removed without base mutation")
 var file=FileAccess.open("res://validation.json",FileAccess.WRITE)
 file.store_string(JSON.stringify({"checks":checks,"syntheticOnly":true}))
 file.close()
 quit(1 if checks.any(func(c):return not c.passed) else 0)


