import importlib.util
import contextlib
import io
import json
import struct
import sys
from pathlib import Path
import tempfile
import unittest
import wave
from unittest.mock import patch
import numpy as np

ROOT = Path(__file__).resolve().parents[2]

class AudioTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=ROOT / 'test/python')
        self.root = Path(self.tmp.name)
        spec = importlib.util.spec_from_file_location('audio_worker', ROOT / 'workers/audio.py')
        self.worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.worker)

    def tearDown(self):
        self.tmp.cleanup()

    def wav(self, channels=2, frames=48000, rate=48000, width=2):
        source = self.root / 'source.wav'
        with wave.open(str(source), 'wb') as out:
            out.setnchannels(channels)
            out.setsampwidth(width)
            out.setframerate(rate)
            out.writeframes(bytes(frames * channels * width))
        return source

    def test_inspect_and_encode_exact_frames(self):
        source = self.wav()
        before = source.read_bytes()
        result = self.worker.run(dict(action='inspect', sourcePath=str(source)))
        self.assertEqual(result['audio']['decodedFrames'], 48000)
        self.assertEqual(result['audio']['durationRational'], dict(numerator=48000, denominator=48000))
        encoded = self.worker.run(dict(action='encode-vorbis', sourcePath=str(source), outputDirectory=str(self.root / 'out'), bitrate=64000))
        self.assertEqual(encoded['audio']['decodedFrames'], 48000)
        self.assertEqual(encoded['audio']['format'], 'ogg-vorbis')
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(len(list((self.root / 'out').iterdir())), 1)
        self.assertEqual(self.worker.run(dict(action='inspect', sourcePath=encoded['audio']['path']))['audio']['channels'], 2)

    def test_reject_inputs(self):
        for request in [{}, dict(action='shell', sourcePath='x'), dict(action='inspect', sourcePath='https://example.com/a.wav')]:
            with self.assertRaises(ValueError): self.worker.run(request)
        for kwargs in [dict(width=1), dict(rate=4000), dict(channels=3), dict(frames=0), dict(frames=48000*31)]:
            with self.assertRaises(ValueError): self.worker.run(dict(action='inspect', sourcePath=str(self.wav(**kwargs))))
        bad = self.root / 'bad.ogg'
        bad.write_bytes(b'OggSbad')
        with self.assertRaises(Exception): self.worker.run(dict(action='inspect', sourcePath=str(bad)))

    def test_mono_and_settings(self):
        source = self.wav(channels=1)
        self.assertEqual(self.worker.run(dict(action='inspect', sourcePath=str(source)))['audio']['channels'], 1)
        with self.assertRaisesRegex(ValueError, 'stereo'): self.worker.run(dict(action='encode-vorbis', sourcePath=str(source), outputDirectory=str(self.root / 'out')))
        for bitrate in [True, 1, 999999, '64000']:
            with self.assertRaises(ValueError): self.worker.run(dict(action='encode-vorbis', sourcePath=str(self.wav()), outputDirectory=str(self.root / 'out'), bitrate=bitrate))

    def test_encode_failure_cleanup(self):
        source = self.wav()
        with patch.object(self.worker, 'encode', side_effect=RuntimeError('encode failed')):
            with self.assertRaises(RuntimeError): self.worker.run(dict(action='encode-vorbis', sourcePath=str(source), outputDirectory=str(self.root / 'out')))
        self.assertEqual(list((self.root / 'out').iterdir()), [])

    def test_nonfinite_and_decoded_bounds(self):
        with self.assertRaises(ValueError): self.worker.check_samples(np.array([float('nan')]), 1, 48000, 2)
        with self.assertRaises(ValueError): self.worker.check_samples(np.array([0]), 48000*31, 48000, 2)
        with self.assertRaises(ValueError): self.worker.check_samples(np.array([0]), 9000000, 96000, 2)

    def test_short_conversion_rejected_and_cleaned(self):
        source = self.wav(frames=4800)
        with self.assertRaisesRegex(ValueError, 'sample count'):
            self.worker.run(dict(action='encode-vorbis', sourcePath=str(source), outputDirectory=str(self.root / 'out')))
        self.assertEqual(list((self.root / 'out').iterdir()), [])

    def test_header_corruption_and_metadata(self):
        original = self.wav().read_bytes()
        for data in [original[:10], original[:-1], original.replace(b'fmt ', b'xxxx', 1), original.replace(b'data', b'xxxx', 1)]:
            with self.assertRaises(ValueError): self.worker.wav_header(data)
        bad_rate = bytearray(original)
        struct.pack_into('<I', bad_rate, 28, 1)
        with self.assertRaises(ValueError): self.worker.wav_header(bad_rate)
        chunk = b'JUNK' + struct.pack('<I', 65538) + bytes(65538)
        bad = bytearray(original + chunk)
        struct.pack_into('<I', bad, 4, len(bad)-8)
        with self.assertRaisesRegex(ValueError, 'metadata'): self.worker.wav_header(bad)
        valid = bytearray(original + b'JUNK' + struct.pack('<I', 1) + b'x\0')
        struct.pack_into('<I', valid, 4, len(valid)-8)
        self.assertEqual(self.worker.wav_header(valid), 48000)

    def test_protocol_missing_oversized_and_collision(self):
        for path in ['file://a.wav', '//server/share/file', 'a:evil', str(self.root / 'missing')]:
            with self.assertRaises(ValueError): self.worker.run(dict(action='inspect', sourcePath=path))
        large = self.root / 'large'
        with large.open('wb') as out: out.truncate(self.worker.MAX_BYTES+1)
        with self.assertRaises(ValueError): self.worker.run(dict(action='inspect', sourcePath=str(large)))
        source = self.wav()
        self.worker.run(dict(action='encode-vorbis', sourcePath=str(source), outputDirectory=str(self.root / 'out')))
        # Native Ogg serialization chooses serials, so collision is explicitly
        # exercised with a fixed candidate instead of relying on encoder bytes.
        with patch.object(self.worker, 'inspect', return_value=dict(format='ogg-vorbis', frames=48000, sampleRate=48000, channels=2, sha256='existing')), patch.object(self.worker, 'encode', side_effect=lambda src, target, meta, bitrate: target.write_bytes(b'candidate')):
            (self.root / 'out/existing.ogg').write_bytes(b'existing')
            with self.assertRaisesRegex(ValueError, 'collision'):
                self.worker.run(dict(action='encode-vorbis', sourcePath=str(source), outputDirectory=str(self.root / 'out')))

    def test_main_success_and_error(self):
        request = self.root / 'request.json'
        request.write_text(json.dumps(dict(action='inspect', sourcePath=str(self.wav()))))
        for arguments, expected in [[['audio.py', str(request)], 0], [['audio.py'], 2]]:
            output = io.StringIO()
            with patch.object(sys, 'argv', arguments), contextlib.redirect_stdout(output):
                self.assertEqual(self.worker.main(), expected)
            self.assertEqual(json.loads(output.getvalue())['ok'], expected == 0)

if __name__ == '__main__': unittest.main()




