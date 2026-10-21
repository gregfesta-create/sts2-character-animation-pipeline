import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'workers'))
SPEC = importlib.util.spec_from_file_location('visual', ROOT / 'workers/visual.py')
visual = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(visual)


class VisualTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / 'test/python')
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def frame(self, name, x=1, empty=False, size=(4, 4)):
        image = Image.new('RGBA', size)
        if not empty:
            image.putpixel((x, 1), (200, 40, 20, 128))
        path = self.root / name
        image.save(path)
        return path

    def request(self, *names, **changes):
        return dict(version=1, sourceRoot=str(self.root), frames=[dict(id='frame' + str(i), path=n) for i, n in enumerate(names)], outputDirectory=str(self.root / 'out'), **changes)

    def test_exact_pixel_metrics_and_lossless_sheet_preserve_sources(self):
        first = self.frame('first.png')
        second = self.frame('second.png', x=2)
        before = [p.read_bytes() for p in (first, second)]
        result = visual.run(self.request('first.png', 'second.png'))
        self.assertTrue(result['ok'])
        self.assertEqual(result['visualQuality'], 'unverified')
        self.assertEqual(result['frames'][0]['visiblePixels'], 1)
        self.assertEqual(result['frames'][0]['alphaBounds'], [1, 1, 2, 2])
        self.assertEqual(result['frames'][0]['normalizedCentroid'], [0.375, 0.375])
        self.assertEqual(result['differences'][0]['normalizedCentroidDisplacement'], 0.25)
        self.assertGreater(result['differences'][0]['normalizedPremultipliedRgbaDifference'], 0)
        with Image.open(result['contactSheet']['path']) as sheet:
            self.assertEqual(sheet.size, (8, 4))
            self.assertEqual(sheet.getpixel((1, 1)), (200, 40, 20, 128))
            self.assertEqual(sheet.getpixel((6, 1)), (200, 40, 20, 128))
        self.assertEqual([p.read_bytes() for p in (first, second)], before)

    def test_empty_alpha_and_edge_risk_are_observations_not_quality_pass(self):
        self.frame('empty.png', empty=True)
        self.frame('edge.png', x=0)
        result = visual.run(self.request('empty.png', 'edge.png'))
        self.assertIsNone(result['frames'][0]['normalizedCentroid'])
        self.assertIsNone(result['differences'][0]['normalizedCentroidDisplacement'])
        self.assertEqual(result['frames'][1]['edgeVisiblePixels'], 1)
        self.assertEqual([d['code'] for d in result['diagnostics']], ['EMPTY_ALPHA', 'EDGE_ALPHA_RISK'])

    def test_rejects_escape_shape_budgets_animation_and_output_collision(self):
        self.frame('a.png')
        self.frame('b.png', size=(5, 4))
        requests = [self.request('../a.png'), self.request('a.png', 'b.png'), self.request('a.png', limits=dict(maxPixels=1)), self.request('a.png', limits=dict(maxOutputBytes=1)), self.request('a.png', limits=dict(maxOutputPixels=1)), self.request('a.png', limits=dict(maxFileBytes=1))]
        for request in requests:
            with self.subTest(request=request), self.assertRaises((ValueError, OSError)):
                visual.run(request)
            self.assertFalse((self.root / 'out/contact-sheet.png').exists())
        animation = self.root / 'animation.png'
        Image.new('RGBA', (4, 4), 'red').save(animation, save_all=True, append_images=[Image.new('RGBA', (4, 4), 'blue')])
        with self.assertRaises(ValueError):
            visual.run(self.request('animation.png'))
        visual.run(self.request('a.png'))
        with self.assertRaises(ValueError):
            visual.run(self.request('a.png'))

    def test_junction_source_and_output_are_rejected(self):
        import _winapi
        self.frame('a.png')
        link = self.root / 'junction'
        _winapi.CreateJunction(str(self.root), str(link))
        try:
            for request in [self.request('junction/a.png'), {**self.request('a.png'), 'sourceRoot': str(link)}, {**self.request('a.png'), 'outputDirectory': str(link / 'out')}]:
                with self.assertRaises(ValueError):
                    visual.run(request)
        finally:
            link.rmdir()

    def test_hidden_rgb_is_not_motion_and_malformed_or_bomb_inputs_fail_closed(self):
        first = Image.new('RGBA', (2, 2), (255, 0, 0, 0))
        second = Image.new('RGBA', (2, 2), (0, 255, 0, 0))
        first.save(self.root / 'first.png')
        second.save(self.root / 'second.png')
        result = visual.run(self.request('first.png', 'second.png'))
        self.assertEqual(result['differences'][0]['normalizedPremultipliedRgbaDifference'], 0)
        self.frame('normal.png')
        for request in [{**self.request('normal.png'), 'version': True}, {**self.request('normal.png'), 'unknown': True}, self.request('normal.png', limits=dict(unknown=1)), self.request('normal.png', 'normal.png')]:
            request['outputDirectory'] = str(self.root / 'invalid')
            with self.assertRaises(ValueError):
                visual.run(request)
        with patch.object(Image, 'MAX_IMAGE_PIXELS', 1):
            with self.assertRaises((Image.DecompressionBombError, Image.DecompressionBombWarning)):
                visual.run({**self.request('normal.png'), 'outputDirectory': str(self.root / 'bomb')})
        self.assertFalse((self.root / 'bomb/contact-sheet.png').exists())

    def test_main_uses_single_bounded_json_result_and_error_exit(self):
        import contextlib
        self.frame('a.png')
        request = self.root / 'request.json'
        request.write_text(json.dumps(self.request('a.png')))
        output = io.StringIO()
        with patch.object(sys, 'argv', ['visual.py', str(request)]), contextlib.redirect_stdout(output):
            self.assertEqual(visual.main(), 0)
        self.assertTrue(json.loads(output.getvalue())['ok'])
        output = io.StringIO()
        with patch.object(sys, 'argv', ['visual.py', str(request)]), contextlib.redirect_stdout(output):
            self.assertEqual(visual.main(), 2)
        self.assertEqual(json.loads(output.getvalue())['error']['code'], 'VISUAL_INSPECTION_FAILED')


if __name__ == '__main__':
    unittest.main()
