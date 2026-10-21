"""Pixel assertions for the native synthetic skeletal deformation fixture."""
import json
import sys
from pathlib import Path
from PIL import Image, ImageChops

folder = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / 'evidence/w2-godot/native/godot'
validation = json.loads((folder / 'validation.json').read_text())
assert validation['reload'] and validation['bone_count'] == 2
checks = []
for i in range(0, 8, 2):
    a = Image.open(folder / validation['frames'][i]).convert('RGB')
    b = Image.open(folder / validation['frames'][i+1]).convert('RGB')
    # The base stays fixed while the distal half visibly bends.
    assert ImageChops.difference(a.crop((65, 129, 90, 139)), b.crop((65, 129, 90, 139))).getbbox() is None
    changed = ImageChops.difference(a.crop((145, 100, 215, 210)), b.crop((145, 100, 215, 210))).getbbox()
    assert changed is not None
    assert a.getbbox() is not None and b.getbbox() is not None
    first, second = validation['samples'][i:i+2]
    assert abs(first['bones']['tip'][2]) < 0.0001
    assert abs(second['bones']['tip'][2] - .7) < 0.0001
    assert first['bones']['root'] == second['bones']['root']
    checks.append({'clip': first['clip'], 'fixed_anchor': True, 'moving_tip_region': list(changed)})
result = {'valid': True, 'checks': checks}
(folder.parent / 'pixel-validation.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
