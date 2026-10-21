"""Lossless development APNG timeline; never a runtime asset or quality approval."""
import hashlib
import io
import json
import math
from fractions import Fraction
from pathlib import Path
import re
import struct
import sys
import warnings
import zlib
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from images import require, read, destination
from visual import absolute, source_path, exact, BoundedBuffer

DEFAULTS = dict(maxFrames=64, maxFileBytes=16777216, maxInputBytes=67108864,
                maxTotalPixels=16777216, maxOutputBytes=33554432)


def rational(value):
    require(type(value) in (int, float) and math.isfinite(value) and 0 < value <= 600,
            'Invalid frame duration')
    result = Fraction(str(value))
    require(result.numerator <= 65535 and result.denominator <= 65535,
            'Timing precision cannot be represented by APNG')
    return result


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


def run(request):
    require(isinstance(request, dict), 'Expected request object')
    keys = ['version', 'clipId', 'sourceRoot', 'frames', 'finalHoldSeconds', 'outputDirectory']
    exact(request, keys + [key for key in ['limits', 'operation', 'timingMode'] if key in request])
    operation = request.get('operation', 'encode')
    mode = request.get('timingMode', 'exact-decimal')
    require(operation in ('encode', 'verify') and mode in ('exact-decimal', 'bounded-rational'), 'Invalid motion operation or timing mode')
    require(type(request['version']) is int and request['version'] == 1, 'Unsupported motion contract')
    require(isinstance(request['clipId'], str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,79}', request['clipId']), 'Invalid clip id')
    cap = dict(DEFAULTS)
    require(isinstance(request.get('limits', {}), dict), 'Invalid limits')
    for key, value in request.get('limits', {}).items():
        require(key in cap and type(value) is int and 0 < value <= cap[key], 'Invalid limit')
        cap[key] = value
    root, output = absolute(request['sourceRoot']), absolute(request['outputDirectory'])
    require(root.is_dir(), 'Missing source root')
    target = destination(output, 'motion.png') if operation == 'encode' else source_path(output, 'motion.png')
    frames = request['frames']
    require(isinstance(frames, list) and 1 <= len(frames) <= cap['maxFrames'], 'Invalid frame count')
    times, images, records, paths = [], [], [], set()
    total_bytes = total_pixels = 0
    size = None
    for frame in frames:
        exact(frame, ['path', 'time'])
        time = frame['time']
        require(type(time) in (int, float) and math.isfinite(time) and 0 <= time <= 600 and
                (not times or time > times[-1]), 'Expected strictly increasing canonical times')
        times.append(time)
        source = source_path(root, frame['path'])
        require(source not in paths, 'Duplicate frame path')
        paths.add(source)
        data = read(source, min(cap['maxFileBytes'], cap['maxInputBytes'] - total_bytes))
        total_bytes += len(data)
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                require(image.format in ('PNG', 'JPEG', 'WEBP') and getattr(image, 'n_frames', 1) == 1,
                        'Unsupported or animated input')
                total_pixels += image.width * image.height
                require(image.width > 0 and image.height > 0 and total_pixels <= cap['maxTotalPixels'], 'Decoded pixel budget exceeded')
                require(size is None or size == image.size, 'Frame dimensions differ')
                size = image.size
                image.load()
                rgba = image.convert('RGBA')
                images.append(rgba.tobytes())
        records.append(dict(path=frame['path'], time=time, sha256=hashlib.sha256(data).hexdigest()))
    # Decimal subtraction avoids floating point artifacts such as .3 - .1.
    durations = [Fraction(str(times[i + 1])) - Fraction(str(times[i])) for i in range(len(times) - 1)]
    hold = request['finalHoldSeconds']
    require(type(hold) in (int, float) and math.isfinite(hold) and 0 < hold <= 600, 'Invalid final hold')
    durations.append(Fraction(str(hold)))
    timing = []
    requested = list(durations)
    for index, duration in enumerate(requested):
        require(0 < duration <= 600, 'Invalid duration')
        represented = (duration.limit_denominator(min(65535, math.floor(65535 / duration)))
                       if mode == 'bounded-rational' else rational(float(duration)))
        require(represented > 0 and represented.numerator <= 65535 and represented.denominator <= 65535 and
                (represented == duration if mode == 'exact-decimal' else abs(represented - duration) <= Fraction(1, 1000000)),
                'Timing precision cannot be represented by APNG')
        durations[index] = represented
        timing.append(dict(requestedDurationSeconds=float(duration), numerator=represented.numerator,
                           denominator=represented.denominator, representedDurationSeconds=float(represented),
                           errorSeconds=float(represented - duration)))
    width, height = size
    encoded = BoundedBuffer(cap['maxOutputBytes'])
    encoded.write(b'\x89PNG\r\n\x1a\n')
    encoded.write(chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)))
    encoded.write(chunk(b'acTL', struct.pack('>II', len(images), 0)))
    sequence = 0
    for index, (pixels, duration) in enumerate(zip(images, durations)):
        encoded.write(chunk(b'fcTL', struct.pack('>IIIIIHHBB', sequence, width, height, 0, 0,
                                              duration.numerator, duration.denominator, 0, 0)))
        sequence += 1
        stride = width * 4
        compressed = zlib.compress(b''.join(b'\x00' + pixels[y * stride:(y + 1) * stride] for y in range(height)))
        if index == 0:
            encoded.write(chunk(b'IDAT', compressed))
        else:
            encoded.write(chunk(b'fdAT', struct.pack('>I', sequence) + compressed))
            sequence += 1
    encoded.write(chunk(b'IEND', b''))
    data = encoded.getvalue()
    if operation == 'verify':
        require(read(target, cap['maxOutputBytes']) == data, 'APNG bytes differ from independently reconstructed captured timeline')
    # Independently decode every composited output frame, including identical poses.
    with Image.open(io.BytesIO(data)) as preview:
        require(preview.n_frames == len(images), 'Encoded timeline differs')
        for index, pixels in enumerate(images):
            preview.seek(index)
            require(preview.convert('RGBA').tobytes() == pixels and
                    abs(preview.info['duration'] / 1000 - float(durations[index])) < 1e-12,
                    'Encoded pixels or timing differ')
    if operation == 'encode':
        output.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(data)
    return dict(ok=True, version=1, clipId=request['clipId'], visualQuality='unverified',
                scope='development-motion-preview', path='motion.png', width=width, height=height,
                encodedFrames=len(images), frames=records, durationsSeconds=[float(d) for d in durations],
                finalHoldPolicy='explicit-seconds', timingMode=mode, maxDurationErrorSeconds=0 if mode == 'exact-decimal' else .000001,
                timing=timing, cumulativePlaybackErrorSeconds=float(sum(durations) - sum(requested)),
                sha256=hashlib.sha256(data).hexdigest(), bytes=len(data))


def main():
    try:
        require(len(sys.argv) == 2, 'Expected request file')
        request = json.loads(read(absolute(sys.argv[1]), 1048576))
        print(json.dumps(run(request)))
        return 0
    except Exception as error:
        print(json.dumps(dict(ok=False, error=str(error))))
        return 1


if __name__ == '__main__':
    sys.exit(main())
