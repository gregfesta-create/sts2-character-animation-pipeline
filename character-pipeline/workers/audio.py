"""Trusted local PCM/Vorbis decoder and optional stereo Vorbis encoder.

The parent validates Ogg pages/CRC and owns process time/output/resource limits.
No URL, protocol, playlist, chained stream or request-selected codec is accepted.
"""
from fractions import Fraction
import hashlib
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import av
import numpy as np

MAX_BYTES = 16 * 1024 * 1024
MAX_METADATA = 65536


def require(condition, message):
    if not condition:
        raise ValueError(message)


def local_path(value):
    require(isinstance(value, str) and value and '://' not in value and not value.startswith(('\\\\', '//')), 'Expected local file path')
    path = Path(value).absolute()
    require(':' not in str(path)[3:], 'Protocol or alternate stream forbidden')
    for parent in [path, *path.parents]:
        require(not parent.is_symlink() and not parent.is_junction(), 'Link path forbidden')
    return path


def check_samples(samples, frames, rate, channels):
    require(0 < frames <= rate * 30 and frames * channels * 2 <= MAX_BYTES, 'Decoded audio exceeds bounds')
    require(bool(np.isfinite(samples).all()), 'Nonfinite audio samples')


def source_bytes(source):
    require(source.is_file() and 0 < source.stat().st_size <= MAX_BYTES, 'Missing or oversized audio')
    with source.open('rb') as handle:
        data = handle.read(MAX_BYTES + 1)
    require(len(data) <= MAX_BYTES, 'Oversized audio')
    return data


def wav_header(data):
    require(len(data) >= 12 and data[:4] == b'RIFF' and data[8:12] == b'WAVE' and struct.unpack_from('<I', data, 4)[0] + 8 == len(data), 'Invalid RIFF WAV')
    position, fmt, payload, metadata = 12, None, None, 0
    while position < len(data):
        require(position + 8 <= len(data), 'Truncated WAV chunk')
        name, size = data[position:position+4], struct.unpack_from('<I', data, position+4)[0]
        position += 8
        require(position + size + size % 2 <= len(data), 'Truncated WAV data')
        chunk = data[position:position+size]
        if name == b'fmt ':
            require(fmt is None and size == 16, 'Unsupported WAV format header')
            fmt = struct.unpack('<HHIIHH', chunk)
        elif name == b'data':
            require(payload is None and size > 0, 'Invalid WAV payload')
            payload = size
        else:
            metadata += size
            require(metadata <= MAX_METADATA, 'Excessive audio metadata')
        position += size + size % 2
    require(fmt is not None and payload is not None, 'Missing WAV chunks')
    codec, channels, rate, byte_rate, alignment, bits = fmt
    require(codec == 1 and bits == 16 and channels in (1, 2) and 8000 <= rate <= 96000, 'Unsupported PCM WAV')
    require(alignment == channels * 2 and byte_rate == rate * alignment and payload % alignment == 0, 'Inconsistent WAV rates')
    return payload // alignment


def inspect(source):
    data = source_bytes(source)
    kind = 'wav' if data[:4] == b'RIFF' else 'ogg-vorbis'
    expected = wav_header(data) if kind == 'wav' else None
    require(kind == 'wav' or data[:4] == b'OggS', 'Unsupported audio container')
    frames = 0
    with av.open(io.BytesIO(data), mode='r', format='wav' if kind == 'wav' else 'ogg') as container:
        require(len(container.streams) == 1 and len(container.streams.audio) == 1, 'Expected one audio stream')
        stream = container.streams.audio[0]
        require(stream.codec_context.name == ('pcm_s16le' if kind == 'wav' else 'vorbis'), 'Unsupported audio codec')
        rate, channels = stream.codec_context.sample_rate, stream.codec_context.channels
        require(channels in (1, 2) and 8000 <= rate <= 96000, 'Unsupported audio layout/rate')
        require(sum(len(str(k).encode()) + len(str(v).encode()) for record in (container.metadata, stream.metadata) for k, v in record.items()) <= MAX_METADATA, 'Excessive audio metadata')
        for frame in container.decode(stream):
            require(frame.sample_rate == rate and len(frame.layout.channels) == channels and frame.samples <= rate * 30, 'Changing or oversized decoded frame')
            frames += frame.samples
            check_samples(frame.to_ndarray(), frames, rate, channels)
    require(frames > 0 and (expected is None or expected == frames), 'Empty or inconsistent decoded audio')
    return dict(format=kind, channels=channels, sampleRate=rate, frames=frames, decodedFrames=frames,
                duration=frames/rate, durationRational=dict(numerator=frames, denominator=rate),
                encodedBytes=len(data), decodedBytes=frames*channels*2, sha256=hashlib.sha256(data).hexdigest(), decoderVersion=av.__version__)


def encode(source, target, metadata, bitrate):
    rate = metadata['sampleRate']
    with av.open(str(source), mode='r', format='wav' if metadata['format'] == 'wav' else 'ogg') as incoming, av.open(str(target), mode='w', format='ogg') as outgoing:
        stream = outgoing.add_stream('vorbis', rate=rate, options={'strict': 'experimental'})
        stream.layout = 'stereo'
        stream.bit_rate = bitrate
        resampler = av.AudioResampler(format='fltp', layout='stereo', rate=rate)
        offset = 0
        for decoded in incoming.decode(incoming.streams.audio[0]):
            for frame in resampler.resample(decoded):
                frame.pts, frame.time_base = offset, Fraction(1, rate)
                offset += frame.samples
                for packet in stream.encode(frame):
                    outgoing.mux(packet)
                require(target.stat().st_size <= MAX_BYTES, 'Encoded audio exceeds bounds')
        for packet in stream.encode(None):
            outgoing.mux(packet)


def run(request):
    require(isinstance(request, dict) and set(request) <= {'action', 'sourcePath', 'outputDirectory', 'bitrate'}, 'Invalid audio request')
    action = request.get('action')
    require(action in ('inspect', 'encode-vorbis'), 'Unknown audio action')
    source = local_path(request.get('sourcePath'))
    metadata = inspect(source)
    if action == 'inspect':
        return dict(ok=True, audio=metadata)
    bitrate = request.get('bitrate', 64000)
    require(type(bitrate) is int and 32000 <= bitrate <= 192000, 'Invalid Vorbis bitrate')
    require(metadata['channels'] == 2, 'Available Vorbis encoder requires stereo; mono conversion is unavailable')
    root = local_path(request.get('outputDirectory'))
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.audio-', dir=root) as temporary:
        candidate = Path(temporary) / 'candidate.ogg'
        encode(source, candidate, metadata, bitrate)
        result = inspect(candidate)
        require(result['format'] == 'ogg-vorbis' and result['frames'] == metadata['frames'] and result['sampleRate'] == metadata['sampleRate'] and result['channels'] == metadata['channels'], 'Encoded sample count or layout changed')
        target = root / (result['sha256'] + '.ogg')
        require(not target.exists(), 'Audio output collision')
        candidate.replace(target)
    result.update(path=str(target), sourceSha256=metadata['sha256'], encoder=dict(codec='vorbis', version=av.__version__, bitrate=bitrate, strict='experimental'))
    return dict(ok=True, audio=result)


def main():
    try:
        require(len(sys.argv) == 2, 'Usage: audio.py request.json')
        path = local_path(sys.argv[1])
        require(path.stat().st_size <= 65536, 'Oversized audio request')
        print(json.dumps(run(json.loads(path.read_text(encoding='utf-8'))), allow_nan=False))
        return 0
    except Exception as error:
        print(json.dumps(dict(ok=False, error=dict(code='AUDIO_FAILED', message=str(error))), allow_nan=False))
        return 2


if __name__ == '__main__':
    sys.exit(main())
