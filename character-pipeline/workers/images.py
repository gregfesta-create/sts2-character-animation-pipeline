"""Bounded supplied-art processing. No generation or semantic segmentation."""
import hashlib
import io
import json
import math
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from PIL import Image, ImageChops

DEFAULTS = dict(maxPixels=16000000, maxParts=1000, maxFileBytes=67108864,
                maxArchiveEntries=1024, maxArchiveBytes=536870912, maxAtlasPixels=16000000)
Image.MAX_IMAGE_PIXELS = DEFAULTS['maxPixels']


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value, positive=False):
    require(type(value) in (int, float) and math.isfinite(value), 'Expected finite number')
    require(not positive or value > 0, 'Expected positive number')
    return value


def pair(value):
    require(isinstance(value, list) and len(value) == 2, 'Expected coordinate pair')
    return [number(v) for v in value]


def limits(request):
    configured = request.get('limits', {})
    require(isinstance(configured, dict), 'Invalid limits')
    result = dict(DEFAULTS)
    for key, value in configured.items():
        require(key in DEFAULTS and type(value) is int and 0 < value <= DEFAULTS[key], 'Invalid limit')
        result[key] = value
    return result


def safe_path(value):
    path = Path(value).absolute()
    for ancestor in [path, *path.parents]:
        require(not ancestor.is_symlink() and not ancestor.is_junction(), 'Link paths are forbidden')
    return path


def read(path, cap):
    path = safe_path(path)
    require(path.is_file() and path.stat().st_size <= cap, 'Missing or oversized input')
    with path.open('rb') as source:
        data = source.read(cap + 1)
    require(len(data) <= cap, 'Oversized input')
    return data


def decode(data, bound, rgba=True):
    with Image.open(io.BytesIO(data)) as image:
        require(image.width * image.height <= bound, 'Decoded image exceeds pixel limit')
        require(image.width > 0 and image.height > 0 and getattr(image, 'n_frames', 1) == 1, 'Invalid image dimensions or animation')
        require(not rgba or 'A' in image.getbands() or 'transparency' in image.info, 'Input requires explicit alpha or a mask')
        image.load()
        return image.convert('RGBA' if rgba else 'L')


def destination(root, name):
    path = safe_path(root / name)
    require(path.parent == root and not path.exists(), 'Output collision or escape')
    return path


def prepare(request, root, cap):
    parts = request.get('parts')
    require(isinstance(parts, list) and 0 < len(parts) <= cap['maxParts'], 'Invalid part count')
    records, images, ids = [], [], set()
    total_pixels = 0
    for part in parts:
        identity = part.get('id')
        require(isinstance(identity, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,79}', identity) and identity not in ids, 'Invalid or duplicate part id')
        ids.add(identity)
        pivot = pair(part.get('pivot'))
        scale = number(part.get('scale', 1), True)
        ppu = number(part.get('pixelsPerUnit', 1), True)
        data = read(part['input'], cap['maxFileBytes'])
        if part.get('mask'):
            # Masks supply alpha for RGB sources; existing RGBA alpha is multiplied.
            image = decode(data, cap['maxPixels'], False).convert('RGBA')
            with Image.open(io.BytesIO(data)) as original:
                image = original.convert('RGBA')
            mask = decode(read(part['mask'], cap['maxFileBytes']), cap['maxPixels'], False)
            require(mask.size == image.size, 'Mask dimensions differ')
            image.putalpha(ImageChops.multiply(image.getchannel('A'), mask))
        else:
            image = decode(data, cap['maxPixels'])
        coverage = None
        if 'requiredSurfaceMask' in part:
            mask_data = read(part['requiredSurfaceMask'], cap['maxFileBytes'])
            required = decode(mask_data, cap['maxPixels'], False)
            require(required.size == image.size, 'Required surface mask dimensions differ')
            # Binary lookup tables avoid constructing source-sized Python pixel lists.
            required = required.point([0] + [255] * 255)
            required_pixels = required.histogram()[255]
            require(required_pixels > 0, 'Required surface mask is empty')
            uncovered = image.getchannel('A').point([255] + [0] * 255)
            missing_pixels = ImageChops.multiply(required, uncovered).histogram()[255]
            require(missing_pixels == 0, f'Required surface uncovered: {missing_pixels} required pixels')
            coverage = dict(version=1, status='verified', sourceSha256=hashlib.sha256(data).hexdigest(), maskSha256=hashlib.sha256(mask_data).hexdigest(), width=image.width, height=image.height, requiredPixels=required_pixels, missingPixels=0, alphaThreshold=1)
        bounds = image.getchannel('A').getbbox()
        require(bounds is not None, 'Part alpha is empty')
        width, height = image.size
        target = [max(1, round((bounds[2] - bounds[0]) * scale)), max(1, round((bounds[3] - bounds[1]) * scale))]
        require(target[0] * target[1] <= cap['maxPixels'], 'Resized image exceeds pixel limit')
        # Uniform scale is exact; reject fractional rounding that would distort registration.
        require(target[0] == (bounds[2] - bounds[0]) * scale and target[1] == (bounds[3] - bounds[1]) * scale, 'Scale must produce integral crop dimensions')
        image = image.crop(bounds).resize(target, Image.Resampling.LANCZOS)
        # Remove invisible RGB fringe without destroying antialias alpha.
        total_pixels += image.width * image.height
        require(total_pixels <= cap['maxAtlasPixels'], 'Combined images exceed pixel limit')
        pixels = list(image.get_flattened_data())
        image.putdata([(r, g, b, a) if a else (0, 0, 0, 0) for r, g, b, a in pixels])
        path = destination(root, identity + '.png')
        require(safe_path(part['input']) != path, 'Cannot overwrite source')
        translation = [-bounds[0] * scale, -bounds[1] * scale]
        records.append(dict(id=identity, image=dict(path=str(path), prepared=True, width=target[0], height=target[1], alphaBounds=list(image.getchannel('A').getbbox()), cropTranslation=translation, pivot=[pivot[i] * scale + translation[i] for i in range(2)], pixelsPerUnit=ppu * scale), source=dict(width=width, height=height, pivot=pivot, alphaBounds=list(bounds), sha256=hashlib.sha256(data).hexdigest()), transform=dict(scale=scale, translation=translation)))
        if coverage is not None:
            records[-1]['surfaceCoverage'] = coverage
        images.append(image)
    atlas_width = max(image.width for image in images) + 4
    atlas_height = sum(image.height + 4 for image in images)
    require(atlas_width * atlas_height <= cap['maxAtlasPixels'], 'Atlas exceeds pixel limit')
    atlas_path = destination(root, 'atlas.png')
    atlas = Image.new('RGBA', (atlas_width, atlas_height))
    regions, y = [], 2
    for record, image in zip(records, images):
        image.save(record['image']['path'])
        if 'surfaceCoverage' in record:
            record['surfaceCoverage']['outputSha256'] = hashlib.sha256(read(record['image']['path'], cap['maxFileBytes'])).hexdigest()
        atlas.paste(image, (2, y))
        regions.append(dict(id=record['id'], x=2, y=y, width=image.width, height=image.height))
        y += image.height + 4
    atlas.save(atlas_path)
    return dict(ok=True, parts=records, atlas=dict(path=str(atlas_path), width=atlas_width, height=atlas_height, regions=regions))


def archive_name(name):
    require(isinstance(name, str) and '\\' not in name and ':' not in name and not name.startswith('/') and all(p not in ('..', '.') for p in name.split('/')), 'Unsafe archive path')
    return name


def layered(request, root, cap):
    data = read(request['input'], cap['maxFileBytes'])
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        require(len(entries) <= cap['maxArchiveEntries'] and sum(e.file_size for e in entries) <= cap['maxArchiveBytes'], 'Archive exceeds limits')
        names = set()
        for entry in entries:
            archive_name(entry.filename)
            require(entry.filename not in names and ((entry.external_attr >> 16) & 0o170000) != 0o120000, 'Duplicate or linked archive entry')
            require(entry.file_size <= cap['maxFileBytes'] and entry.file_size <= max(1, entry.compress_size) * 1000, 'Archive expansion exceeds limit')
            names.add(entry.filename)
        require('stack.xml' in names, 'Missing OpenRaster stack.xml')
        require(archive.getinfo('stack.xml').file_size <= 1048576, 'Layer XML exceeds limit')
        xml = archive.read('stack.xml')
        require(b'<!DOCTYPE' not in xml.upper() and b'<!ENTITY' not in xml.upper(), 'XML declarations forbidden')
        tree = ET.fromstring(xml)
        width, height = int(tree.get('w', 0)), int(tree.get('h', 0))
        require(width > 0 and height > 0 and width * height <= cap['maxPixels'], 'Invalid archive canvas')
        layers = []
        total_pixels = 0
        def visit(node, x=0, y=0, depth=0):
            nonlocal total_pixels
            require(depth <= 64, 'Layer nesting exceeds limit')
            x += int(node.get('x', 0)); y += int(node.get('y', 0))
            require(node.get('composite-op', 'svg:src-over') == 'svg:src-over' and float(node.get('opacity', '1')) == 1 and node.get('visibility', 'visible') == 'visible', 'Unsupported layer blending/opacity/visibility')
            if node.tag == 'layer':
                src = archive_name(node.get('src'))
                require(src in names and len(layers) < cap['maxParts'], 'Missing layer or excessive layers')
                image = decode(archive.read(src), cap['maxPixels'])
                total_pixels += image.width * image.height
                require(total_pixels <= cap['maxPixels'], 'Combined layers exceed decoded pixel limit')
                identity = 'layer_' + str(len(layers))
                path = destination(root, identity + '.png')
                image.save(path)
                layers.append(dict(id=identity, name=node.get('name', identity), input=str(path), offset=[x, y]))
            else:
                for child in node:
                    visit(child, x, y, depth + 1)
        visit(tree)
        require(layers, 'No archive layers')
        return dict(ok=True, layers=layers, width=width, height=height)


def run(request):
    require(isinstance(request, dict), 'Request must be an object')
    cap = limits(request)
    root = safe_path(request['outputDirectory'])
    root.mkdir(parents=True, exist_ok=True)
    action = request.get('action')
    require(action in ('prepare', 'layered'), 'Unknown action')
    return prepare(request, root, cap) if action == 'prepare' else layered(request, root, cap)


def main():
    try:
        require(len(sys.argv) == 2, 'Usage: images.py request.json')
        request = json.loads(read(sys.argv[1], 4194304))
        result = run(request)
        print(json.dumps(result, allow_nan=False))
        return 0
    except Exception as error:
        print(json.dumps(dict(ok=False, error=dict(code='IMAGE_INVALID', message=str(error)))))
        return 2


if __name__ == '__main__':
    sys.exit(main())
