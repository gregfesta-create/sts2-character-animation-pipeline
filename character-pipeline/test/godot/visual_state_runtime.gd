extends SceneTree
var checks=[]
func check(value,label):
 checks.append({"name":label,"passed":bool(value)})
 if not value: push_error(label)
func _initialize(): call_deferred("run")
func fixture():
 var character=Node2D.new()
 for id in ["body","arrow"]:
  var part=Polygon2D.new()
  part.name=id
  part.polygon=PackedVector2Array([Vector2(0,0),Vector2(20,0),Vector2(20,20),Vector2(0,20)])
  part.position=Vector2(0 if id=="body" else 25,0)
  part.color=Color.RED if id=="body" else Color.GREEN
  character.add_child(part)
  part.owner=character
 var controller=load("res://visual_state_controller.gd").new()
 controller.name="VisualStateController"
 controller.part_paths={"body":"body","arrow":"arrow"}
 controller.states={"bodyOnly":["body"],"empty":[],"all":["body","arrow"]}
 character.add_child(controller)
 controller.owner=character
 var scene=PackedScene.new()
 scene.pack(character)
 character.free()
 return scene
func run():
 var compiled_scene=load("res://character.tscn")
 var compiled_a=compiled_scene.instantiate()
 var compiled_b=compiled_scene.instantiate()
 root.add_child(compiled_a)
 root.add_child(compiled_b)
 compiled_a.position=Vector2(20,70)
 compiled_b.position=Vector2(90,70)
 compiled_a.get_node("Meshes/body").color=Color.RED
 compiled_a.get_node("Meshes/arrow").color=Color.GREEN
 compiled_b.get_node("Meshes/body").color=Color.RED
 compiled_b.get_node("Meshes/arrow").color=Color.GREEN
 var compiled_controller=compiled_a.get_node("VisualStateController")
 check(compiled_controller.states.bodyOnly==["body"] and compiled_controller.part_paths.arrow=="Meshes/arrow","compiler persisted states and bindings")
 check(compiled_controller.set_visual_state("bodyOnly"),"compiled packed scene state accepted")
 check(compiled_a.get_node("Meshes/body").visible and not compiled_a.get_node("Meshes/arrow").visible and compiled_b.get_node("Meshes/arrow").visible,"compiled scene visibility isolated")
 await process_frame
 await RenderingServer.frame_post_draw
 var compiled_frame=root.get_texture().get_image()
 compiled_frame.save_png("res://compiled-subset.png")
 check(compiled_frame.get_pixel(46,75).g<0.5 and compiled_frame.get_pixel(116,75).g>0.8,"actual compiled mesh rendered subset")
 check(compiled_controller.clear_visual_state() and compiled_a.get_node("Meshes/arrow").visible,"compiled scene clear restores baseline")
 compiled_a.queue_free()
 compiled_b.queue_free()
 await process_frame
 var scene=fixture()
 var a=scene.instantiate()
 var b=scene.instantiate()
 root.add_child(a)
 root.add_child(b)
 a.position=Vector2(20,30)
 b.position=Vector2(90,30)
 var c=a.get_node("VisualStateController")
 check(a.get_node("arrow").visible,"no invented initial state")
 check(c.set_visual_state("bodyOnly"),"explicit state accepted")
 check(a.get_node("body").visible and not a.get_node("arrow").visible,"exact subset visible")
 check(b.get_node("arrow").visible,"instance visibility independent")
 check(not c.set_visual_state("unknown") and c.last_error.code=="VISUAL_STATE_UNKNOWN","unknown diagnostic")
 check(a.get_node("body").visible and not a.get_node("arrow").visible,"unknown atomic")
 await process_frame
 await RenderingServer.frame_post_draw
 var rendered=root.get_texture().get_image()
 rendered.save_png("res://subset.png")
 check(rendered.get_pixel(46,35).g<0.5 and rendered.get_pixel(116,35).g>0.8,"rendered subset and independent full instance")
 check(c.set_visual_state("empty") and not a.get_node("body").visible,"empty subset")
 check(c.clear_visual_state() and a.get_node("arrow").visible and a.get_node("body").visible,"clear restores baseline")
 # Simulate the exact trusted ActionController fields used by production, without claiming projectile integration.
 var locked=load("res://action_controller.gd").new()
 locked.name="ActionController"
 a.add_child(locked)
 locked.context={"actionInstance":"active"}
 check(not c.set_visual_state("empty") and c.last_error.code=="VISUAL_STATE_ACTION_ACTIVE","active action refuses state mutation")
 check(not c.clear_visual_state(),"active action refuses clear")
 check(a.get_node("arrow").visible,"action refusal atomic")
 locked.context={}
 locked.nocked_visibility={"arrow":true}
 check(not c.set_visual_state("empty"),"nocked ownership refuses mutation")
 locked.queue_free()

 await process_frame
 check(c.set_visual_state("bodyOnly"),"state usable after action release")
 a.get_node("arrow").free()
 check(not c.set_visual_state("all") and a.get_node("body").visible,"missing binding atomic")
 check(b.get_node("VisualStateController").states.all.size()==2,"state declarations unchanged")
 a.queue_free()
 b.queue_free()
 await process_frame
 var file=FileAccess.open("res://validation.json",FileAccess.WRITE)
 file.store_string(JSON.stringify({"checks":checks,"frames":["subset.png","compiled-subset.png"]}))
 file.close()
 quit(0 if checks.all(func(v):return v.passed) else 1)



