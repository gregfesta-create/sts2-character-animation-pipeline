"""Convert white-paint masks for ComfyUI and preserve unmasked source pixels."""
import io
import json
from pathlib import Path
import sys
from PIL import Image, ImageChops

sys.path.insert(0, str(Path(__file__).resolve().parent))
from images import require, limits, read, safe_path, destination


def load_image(path, cap, mode):
    with Image.open(io.BytesIO(read(path, cap['maxFileBytes']))) as image:
        require(0 < image.width * image.height <= cap['maxPixels'], 'Invalid image dimensions')
        require(getattr(image, 'n_frames', 1) == 1, 'Animated inputs are unsupported')
        image.load()
        return image.convert(mode)


def raster_mapping(width, height, cap):
    require(type(width) is int and type(height) is int and width > 0 and height > 0,
            'Invalid source dimensions')
    padded_width, padded_height = max(64, (width + 7) // 8 * 8), max(64, (height + 7) // 8 * 8)
    require(padded_width <= 4096 and padded_height <= 4096 and
            padded_width * padded_height <= cap['maxPixels'], 'Source raster exceeds generation bounds')
    return dict(policyVersion=1, sourceSize=dict(width=width, height=height),
                paddedSize=dict(width=padded_width, height=padded_height), offset=dict(x=0, y=0))


def raster_operation(request, root, cap, action):
    original = load_image(request['input'], cap, 'RGBA')
    if action == 'crop-raster':
        mapping = request.get('raster')
        require(isinstance(mapping, dict) and isinstance(mapping.get('sourceSize'), dict), 'Invalid raster mapping')
        source = mapping['sourceSize']
        expected = raster_mapping(source.get('width'), source.get('height'), cap)
        # Equality alone accepts booleans as integers in Python: validate numeric transport explicitly.
        require(type(mapping.get('policyVersion')) is int and mapping.get('policyVersion') == 1 and
                isinstance(mapping.get('offset'), dict) and
                all(type(mapping['offset'].get(axis)) is int for axis in ('x', 'y')) and
                isinstance(mapping.get('paddedSize'), dict) and
                all(type(mapping['paddedSize'].get(axis)) is int for axis in ('width', 'height')) and
                mapping == expected, 'Invalid raster mapping')
        require(original.size == (expected['paddedSize']['width'], expected['paddedSize']['height']),
                'Generated raster dimensions differ')
        result = original.crop((0, 0, source['width'], source['height']))
    else:
        mapping = raster_mapping(original.width, original.height, cap)
        result = original
        if action == 'pad-raster':
            size = (mapping['paddedSize']['width'], mapping['paddedSize']['height'])
            result = Image.new('RGBA', size, (0, 0, 0, 0))
            result.paste(original, (0, 0))
    paint = None
    if action == 'pad-raster' and request.get('mask') is not None:
        paint = load_image(request['mask'], cap, 'L')
        require(paint.size == original.size, 'Paint mask dimensions differ')
        padded_paint = Image.new('L', result.size, 0)
        padded_paint.paste(paint, (0, 0))
        paint = padded_paint
    output = destination(root, 'raster.png')
    mask_output = destination(root, 'paint.png') if paint is not None else None
    result.save(output)
    response = dict(ok=True, image=dict(path=str(output), width=result.width, height=result.height), raster=mapping)
    if paint is not None:
        paint.save(mask_output)
        response['mask'] = dict(path=str(mask_output), width=paint.width, height=paint.height)
    return response


def run(request):
    require(isinstance(request, dict), 'Request must be an object')
    cap = limits(request)
    root = safe_path(request['outputDirectory'])
    root.mkdir(parents=True, exist_ok=True)
    action = request.get('action')
    require(action in ('mask', 'composite', 'inspect-raster', 'pad-raster', 'crop-raster'), 'Unknown action')
    if action.endswith('-raster'):
        return raster_operation(request, root, cap, action)
    if action == 'mask':
        paint = load_image(request['input'], cap, 'L')
        result = Image.new('RGBA', paint.size, (255, 255, 255, 255))
        result.putalpha(ImageChops.invert(paint))
    else:
        original = load_image(request['original'], cap, 'RGBA')
        generated = load_image(request['generated'], cap, 'RGBA')
        paint = ImageChops.invert(load_image(request['mask'], cap, 'RGBA').getchannel('A'))
        require(original.size == generated.size == paint.size, 'Inpainting dimensions differ')
        result = Image.composite(generated, original, paint)
    output = destination(root, 'mask.png' if action == 'mask' else 'composite.png')
    result.save(output)
    return dict(ok=True, image=dict(path=str(output), width=result.width, height=result.height),
                preservedUnmasked=action == 'composite')


def main():
    try:
        require(len(sys.argv) == 2, 'Usage: repaint.py request.json')
        result = run(json.loads(read(sys.argv[1], 4194304)))
        print(json.dumps(result, allow_nan=False))
        return 0
    except Exception as error:
        print(json.dumps(dict(ok=False, error=dict(code='REPAINT_INVALID', message=str(error)))))
        return 2


if __name__ == '__main__':
    sys.exit(main())
