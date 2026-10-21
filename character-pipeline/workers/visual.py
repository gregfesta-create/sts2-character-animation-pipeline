"""Bounded frame measurements and an original-scale lossless review sheet.

Metrics describe supplied pixels; they do not certify style or motion quality.
Frame paths are relative to an explicit source root. Inputs are never modified.
"""
import hashlib
import io
import json
import math
from pathlib import Path
import re
import sys
import warnings
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from images import destination, read, require, safe_path

DEFAULTS = dict(maxFrames=64, maxFileBytes=16777216, maxPixels=4194304,
                maxTotalPixels=16777216, maxOutputPixels=16777216,
                maxOutputBytes=33554432)


def exact(value, keys):
    require(isinstance(value, dict) and set(value) == set(keys), 'Unexpected request fields')


def absolute(value):
    require(isinstance(value, str) and value and len(value) <= 2048, 'Invalid absolute path')
    path = Path(value)
    require(path.is_absolute() and '..' not in path.parts, 'Expected absolute path without traversal')
    return safe_path(path)


def source_path(root, value):
    require(isinstance(value, str) and 0 < len(value) <= 512 and '\\' not in value and ':' not in value, 'Invalid relative frame path')
    parts = value.split('/')
    require(all(part not in ('', '.', '..') and not part.endswith(('.', ' ')) for part in parts), 'Frame path escape')
    path = safe_path(root.joinpath(*parts))
    require(path.is_relative_to(root), 'Frame path escape')
    return path


class BoundedBuffer(io.BytesIO):
    def __init__(self, limit):
        super().__init__()
        self.limit = limit

    def write(self, data):
        require(self.tell() + len(data) <= self.limit, 'Encoded sheet exceeds output byte budget')
        return super().write(data)


def measure(image):
    rgba = np.asarray(image)
    alpha = rgba[:, :, 3]
    visible = alpha > 0
    count = int(np.count_nonzero(visible))
    height, width = alpha.shape
    edge = int(np.count_nonzero(visible[0]))
    if height > 1:
        edge += int(np.count_nonzero(visible[-1]))
    if height > 2:
        edge += int(np.count_nonzero(visible[1:-1, 0]))
        if width > 1:
            edge += int(np.count_nonzero(visible[1:-1, -1]))
    mass = int(alpha.sum(dtype=np.uint64))
    centroid = None
    if mass:
        centroid = [float(np.dot(alpha.sum(axis=0, dtype=np.uint64), np.arange(width) + 0.5) / mass / width),
                    float(np.dot(alpha.sum(axis=1, dtype=np.uint64), np.arange(height) + 0.5) / mass / height)]
    canonical = rgba.copy()
    canonical[:, :, :3] = ((rgba[:, :, :3].astype(np.uint16) * alpha[:, :, None] + 127) // 255).astype(np.uint8)
    bounds = image.getchannel('A').getbbox()
    return dict(visiblePixels=count, alphaBounds=list(bounds) if bounds else None,
                edgeVisiblePixels=edge, edgeTouchRisk=edge > 0,
                normalizedCentroid=centroid), canonical


def run(request):
    require(isinstance(request, dict), 'Expected request object')
    require(set(request) in [set(['version', 'sourceRoot', 'frames', 'outputDirectory']), set(['version', 'sourceRoot', 'frames', 'outputDirectory', 'limits'])], 'Unexpected request fields')
    require(type(request['version']) is int and request['version'] == 1, 'Unsupported visual contract')
    configured = request.get('limits', {})
    require(isinstance(configured, dict), 'Invalid limits')
    cap = dict(DEFAULTS)
    for key, value in configured.items():
        require(key in DEFAULTS and type(value) is int and 0 < value <= DEFAULTS[key], 'Invalid limit')
        cap[key] = value
    source_root, output_root = absolute(request['sourceRoot']), absolute(request['outputDirectory'])
    require(source_root.is_dir(), 'Missing source root')
    target = destination(output_root, 'contact-sheet.png')
    frames = request['frames']
    require(isinstance(frames, list) and 0 < len(frames) <= cap['maxFrames'], 'Invalid frame count')
    ids, paths, images, records, differences, diagnostics = set(), set(), [], [], [], []
    total_pixels, previous = 0, None
    size = None
    for frame in frames:
        exact(frame, ['id', 'path'])
        identity = frame['id']
        require(isinstance(identity, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', identity) and identity not in ids, 'Invalid or duplicate frame id')
        ids.add(identity)
        source = source_path(source_root, frame['path'])
        require(source != target and str(source).casefold() not in paths, 'Duplicate frame source or output overwrite')
        paths.add(str(source).casefold())
        data = read(source, cap['maxFileBytes'])
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as original:
                require(original.format in ('PNG', 'JPEG', 'WEBP'), 'Unsupported raster format')
                require(getattr(original, 'n_frames', 1) == 1, 'Animated frames are unsupported')
                require(0 < original.width <= 4096 and 0 < original.height <= 4096, 'Invalid frame dimensions')
                pixels = original.width * original.height
                total_pixels += pixels
                require(pixels <= cap['maxPixels'] and total_pixels <= cap['maxTotalPixels'], 'Decoded frame pixel budget exceeded')
                require(size is None or size == original.size, 'Frame dimensions/crops differ')
                size = original.size
                original.load()
                image = original.convert('RGBA')
        metrics, canonical = measure(image)
        record = dict(id=identity, sourcePath=frame['path'], sha256=hashlib.sha256(data).hexdigest(), width=size[0], height=size[1], **metrics)
        if metrics['visiblePixels'] == 0:
            diagnostics.append(dict(code='EMPTY_ALPHA', frameId=identity))
        if metrics['edgeTouchRisk']:
            diagnostics.append(dict(code='EDGE_ALPHA_RISK', frameId=identity, message='Visible alpha touches the frame edge; clipping outside the frame is unknown.'))
        if previous is not None:
            prior_record, prior_pixels = previous
            centroid = metrics['normalizedCentroid']
            prior_centroid = prior_record['normalizedCentroid']
            displacement = math.hypot(*(centroid[i] - prior_centroid[i] for i in range(2))) if centroid and prior_centroid else None
            difference = float(np.abs(canonical.astype(np.int16) - prior_pixels.astype(np.int16)).sum(dtype=np.uint64) / (size[0] * size[1] * 4 * 255))
            differences.append(dict(fromFrameId=prior_record['id'], toFrameId=identity, normalizedCentroidDisplacement=displacement, normalizedPremultipliedRgbaDifference=difference))
        previous = (record, canonical)
        images.append(image)
        records.append(record)
    columns = math.ceil(math.sqrt(len(images)))
    rows = math.ceil(len(images) / columns)
    width, height = size[0] * columns, size[1] * rows
    require(width * height <= cap['maxOutputPixels'], 'Contact sheet pixel budget exceeded')
    sheet = Image.new('RGBA', (width, height))
    layout = []
    for index, image in enumerate(images):
        x, y = index % columns * size[0], index // columns * size[1]
        sheet.paste(image, (x, y))
        layout.append(dict(frameId=records[index]['id'], x=x, y=y, width=size[0], height=size[1]))
    buffer = BoundedBuffer(cap['maxOutputBytes'])
    sheet.save(buffer, format='PNG')
    encoded = buffer.getvalue()
    output_root.mkdir(parents=True, exist_ok=True)
    target = destination(safe_path(output_root), 'contact-sheet.png')
    with target.open('xb') as output:
        output.write(encoded)
    return dict(ok=True, version=1, metricVersion='visual-pixels-v1', scope='supplied-frame-pixels', visualQuality='unverified',
                coverage=dict(frameCount=len(records), decodedPixels=total_pixels), frames=records, differences=differences,
                diagnostics=diagnostics, contactSheet=dict(path=str(target), width=width, height=height, columns=columns, rows=rows,
                bytes=len(encoded), sha256=hashlib.sha256(encoded).hexdigest(), layout=layout))


def main():
    try:
        require(len(sys.argv) == 2, 'Usage: visual.py request.json')
        print(json.dumps(run(json.loads(read(sys.argv[1], 4194304))), allow_nan=False))
        return 0
    except Exception as error:
        print(json.dumps(dict(ok=False, error=dict(code='VISUAL_INSPECTION_FAILED', message=str(error)))))
        return 2


if __name__ == '__main__':
    sys.exit(main())
