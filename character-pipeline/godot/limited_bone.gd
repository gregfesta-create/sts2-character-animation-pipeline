extends Bone2D

# Applied after AnimationPlayer updates, including independently loaded scenes.
func _ready():
	process_priority = 100

func _process(_delta):
	if has_meta("joint_limits"):
		var limits = get_meta("joint_limits")
		rotation = clampf(rotation, limits[0], limits[1])
