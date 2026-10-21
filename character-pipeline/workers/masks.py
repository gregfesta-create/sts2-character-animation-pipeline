"""Bounded intersections of supplied isolated native alpha; no artistic approval."""
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import warnings
from PIL import Image


def require(value, message):
    if not value:
        raise ValueError(message)


def exact(value, fields):
    require(isinstance(value, dict) and set(value) == set(fields), 'Unexpected fields')


def integer(value, low, high):
    return type(value) is int and low <= value <= high


def run(request):
    exact(request, ['version', 'sourceRoot', 'planHash', 'renderLayoutHash', 'captures', 'comparisons'])
    require(type(request['version']) is int and request['version'] == 1, 'Unsupported contract')
    for key in ['planHash', 'renderLayoutHash']:
        require(isinstance(request[key], str) and re.fullmatch('[a-f0-9]{64}', request[key]), 'Invalid binding')
    root = Path(request['sourceRoot'])
    require(root.is_absolute() and root.is_dir() and not root.is_symlink(), 'Invalid source root')
    require(all(not parent.is_symlink() for parent in root.parents), 'Linked source ancestor')
    root = root.resolve()
    captures, comparisons = request['captures'], request['comparisons']
    require(isinstance(captures, list) and 0 < len(captures) <= 64, 'Invalid capture count')
    require(isinstance(comparisons, list) and 0 < len(comparisons) <= 256, 'Invalid comparison count')
    images, records, total_bytes, total_pixels = {}, [], 0, 0
    for capture in captures:
        exact(capture, ['id', 'path', 'sha256', 'width', 'height'])
        identity = capture['id']
        require(integer(identity, 0, 63) and identity not in images, 'Duplicate capture')
        require(capture['path'] == f'part-mask-{identity}.png', 'Invalid source path')
        require(all(integer(capture[key], 1, 512) for key in ['width', 'height']), 'Invalid dimensions')
        file = root / capture['path']
        require(not file.is_symlink() and file.is_file(), 'Unsafe mask')
        size = file.stat().st_size
        require(0 < size <= 16777216 and total_bytes + size <= 67108864, 'Mask byte quota')
        with file.open('rb') as source:
            data = source.read(16777217)
        require(len(data) == size, 'Mask changed during read')
        sha = hashlib.sha256(data).hexdigest()
        require(sha == capture['sha256'], 'Mask hash mismatch')
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                require(image.format == 'PNG' and getattr(image, 'n_frames', 1) == 1, 'Expected single PNG')
                require(image.size == (capture['width'], capture['height']), 'Mask dimensions mismatch')
                pixels = image.width * image.height
                require(total_pixels + pixels <= 16777216, 'Decoded pixel quota')
                image.load()
                images[identity] = image.convert('RGBA').getchannel('A').point(lambda x: 255 if x else 0, mode='1')
        total_pixels += pixels
        total_bytes += size
        records.append(dict(id=identity, sourcePath=capture['path'], sha256=sha, width=capture['width'], height=capture['height']))
    measured, seen, used, comparison_pixels = [], set(), set(), 0
    from PIL import ImageChops
    for comparison in comparisons:
        exact(comparison, ['id', 'captureA', 'captureB'])
        identity, a, b = comparison['id'], comparison['captureA'], comparison['captureB']
        require(integer(identity, 0, 255) and identity not in seen and type(a) is int and type(b) is int and a != b and a in images and b in images, 'Invalid pair mapping')
        require(images[a].size == images[b].size, 'Pair projection mismatch')
        comparison_pixels += images[a].width * images[a].height
        require(comparison_pixels <= 67108864, 'Comparison pixel quota')
        count = sum(ImageChops.logical_and(images[a], images[b]).histogram()[1:])
        measured.append(dict(id=identity, previewOverlapPixels=count))
        seen.add(identity)
        used.update([a, b])
    require(used == set(images), 'Unused mask capture')
    return dict(version=1, metricVersion='native-alpha-overlap-v1', planHash=request['planHash'], renderLayoutHash=request['renderLayoutHash'], captures=records, comparisons=measured, decodedPixels=total_pixels, comparisonPixels=comparison_pixels)


def main():
    try:
        require(len(sys.argv) == 2, 'Usage: masks.py request.json')
        file = Path(sys.argv[1])
        require(file.stat().st_size <= 2097152, 'Request quota')
        print(json.dumps(run(json.loads(file.read_text(encoding='utf-8'))), allow_nan=False))
        return 0
    except Exception as error:
        print(json.dumps(dict(error=dict(code='MASK_INSPECTION_FAILED', message=str(error)))))
        return 2


if __name__ == '__main__':
    sys.exit(main())
