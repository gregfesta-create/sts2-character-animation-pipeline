import io
import sys
import tempfile
import unittest
import json
from unittest.mock import patch
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'workers'))
import motion


class MotionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / 'test/python')
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def request(self, times=(0, .1, .35), identical=False):
        frames = []
        for i, time in enumerate(times):
            image = Image.new('RGBA', (4, 3))
            image.putpixel((0 if identical else i % 4, 1), (20, 30, 40, 128))
            image.save(self.root / f'{i}.png')
            frames.append(dict(path=f'{i}.png', time=time))
        return dict(version=1, clipId='attack', sourceRoot=str(self.root), frames=frames,
                    finalHoldSeconds=.2, outputDirectory=str(self.root / 'output'))

    def test_moving_variable_timing_and_transparency(self):
        request = self.request()
        before = [(self.root / f'{i}.png').read_bytes() for i in range(3)]
        result = motion.run(request)
        self.assertEqual(result['durationsSeconds'], [.1, .25, .2])
        self.assertEqual(result['encodedFrames'], 3)
        with Image.open(self.root / 'output' / 'motion.png') as image:
            self.assertEqual(image.n_frames, 3)
            for i in range(3):
                image.seek(i)
                with Image.open(io.BytesIO(before[i])) as expected:
                    self.assertEqual(image.convert('RGBA').tobytes(), expected.tobytes())
        self.assertEqual(before, [(self.root / f'{i}.png').read_bytes() for i in range(3)])

    def test_identical_frames_remain_exact_timeline(self):
        result = motion.run(self.request(identical=True))
        self.assertEqual(result['encodedFrames'], 3)

    def test_invalid_timing_and_paths(self):
        for times in [(0, 0), (1, 0), (0, .0000001), (0, 601)]:
            with self.subTest(times=times), self.assertRaises(ValueError):
                motion.run(self.request(times))
        request = self.request()
        request['frames'][0]['path'] = '../escape.png'
        with self.assertRaises(ValueError):
            motion.run(request)

    def test_limits_and_animated_input(self):
        request = self.request()
        request['limits'] = dict(maxTotalPixels=10)
        with self.assertRaises(ValueError):
            motion.run(request)
        request = self.request()
        a, b = Image.new('RGBA', (4, 3), 'red'), Image.new('RGBA', (4, 3), 'blue')
        a.save(self.root / '0.png', save_all=True, append_images=[b], duration=100)
        with self.assertRaises(ValueError):
            motion.run(request)

    def test_output_budget(self):
        request = self.request()
        request['limits'] = dict(maxOutputBytes=50)
        with self.assertRaises(ValueError):
            motion.run(request)

    def test_contract_dimensions_collision_and_bounds(self):
        for changes in [dict(version=True), dict(clipId='../bad'), dict(frames=[]),
                        dict(finalHoldSeconds=0), dict(finalHoldSeconds=True),
                        dict(limits=dict(maxFrames=65)), dict(limits=[]), dict(extra=1),
                        dict(limits=dict(maxFileBytes=1)), dict(limits=dict(maxInputBytes=1))]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                motion.run(dict(self.request(), **changes))
        request = self.request()
        Image.new('RGBA', (5, 3)).save(self.root / '2.png')
        with self.assertRaises(ValueError):
            motion.run(request)
        request = self.request()
        request['frames'][1]['path'] = request['frames'][0]['path']
        with self.assertRaises(ValueError):
            motion.run(request)
        request = self.request(times=(0,))
        self.assertEqual(motion.run(request)['encodedFrames'], 1)
        with self.assertRaises(ValueError):
            motion.run(request)

    def test_cli_and_decompression_bomb(self):
        request = self.request()
        with patch.object(Image, 'MAX_IMAGE_PIXELS', 5), self.assertRaises(Image.DecompressionBombError):
            motion.run(request)
        request_file = self.root / 'request.json'
        request_file.write_text(json.dumps(request))
        with patch.object(sys, 'argv', ['motion.py', str(request_file)]), patch('builtins.print') as output:
            self.assertEqual(motion.main(), 0)
            self.assertTrue(json.loads(output.call_args.args[0])['ok'])
        with patch.object(sys, 'argv', ['motion.py']), patch('builtins.print'):
            self.assertEqual(motion.main(), 1)

    def test_explicit_bounded_rational_and_independent_verification(self):
        request = self.request(times=(0, 1 / 30, 2 / 30))
        request['timingMode'] = 'bounded-rational'
        result = motion.run(request)
        self.assertEqual(result['timing'][0]['numerator'], 1)
        self.assertEqual(result['timing'][0]['denominator'], 30)
        self.assertLess(abs(result['cumulativePlaybackErrorSeconds']), .000001)
        self.assertEqual(motion.run(dict(request, operation='verify')), result)
        target = self.root / 'output/motion.png'
        target.write_bytes(target.read_bytes()[:-1])
        with self.assertRaises(ValueError):
            motion.run(dict(request, operation='verify'))

    def test_bounded_mode_does_not_silently_erase_tiny_duration(self):
        request = self.request(times=(0, 1e-9))
        request['timingMode'] = 'bounded-rational'
        with self.assertRaises(ValueError):
            motion.run(request)
