"""Lossless visual preview of supplied originals, before artwork preparation."""
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import zipfile
from PIL import Image
# Windows embedded Python deliberately omits the script directory from sys.path.
# Add only this trusted worker directory, never a request-selected import path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from images import destination, layered, limits, read, require, safe_path


def run(request):
    require(isinstance(request, dict), 'Expected request object')
    cap = limits(request)
    source = safe_path(request['input'])
    data = read(source, cap['maxFileBytes'])
    root = safe_path(request['outputDirectory'])
    target = destination(root, 'original.png')
    root.mkdir(parents=True, exist_ok=True)
    if zipfile.is_zipfile(io.BytesIO(data)):
        # Existing importer validates every member and XML structure. Temporary
        # layer files are never published as approved/prepared character parts.
        with tempfile.TemporaryDirectory(prefix='.preview-', dir=root) as temporary:
            parsed = layered(dict(input=str(source)), safe_path(temporary), cap)
            image = Image.new('RGBA', (parsed['width'], parsed['height']))
            # OpenRaster XML lists the topmost layer first.
            for layer in reversed(parsed['layers']):
                with Image.open(layer['input']) as pixels:
                    image.alpha_composite(pixels.convert('RGBA'), tuple(layer['offset']))
    else:
        with Image.open(io.BytesIO(data)) as original:
            require(0 < original.width * original.height <= cap['maxPixels'] and getattr(original, 'n_frames', 1) == 1, 'Invalid image dimensions or animation')
            original.load()
            image = original.convert('RGBA')
    image.save(target)
    return dict(ok=True, image=dict(path=str(target), width=image.width, height=image.height, sha256=hashlib.sha256(target.read_bytes()).hexdigest()))


def main():
    try:
        require(len(sys.argv) == 2, 'Usage: preview.py request.json')
        print(json.dumps(run(json.loads(read(sys.argv[1], 4194304))), allow_nan=False))
        return 0
    except Exception as error:
        print(json.dumps(dict(ok=False, error=dict(code='PREVIEW_FAILED', message=str(error)))))
        return 2


if __name__ == '__main__':
    sys.exit(main())
