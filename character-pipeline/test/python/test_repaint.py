import importlib.util
from pathlib import Path
import tempfile
import unittest
from PIL import Image

WORKER = Path(__file__).resolve().parents[2] / 'workers' / 'repaint.py'


class RepaintTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('repaint', WORKER)
        self.worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.worker)
        scratch = Path(__file__).resolve().parents[3] / '.tmp' / 'repaint-tests'
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def save(self, name, mode, pixels):
        image = Image.new(mode, (2, 1))
        image.putdata(pixels)
        path = self.root / name
        image.save(path)
        return str(path)

    def test_mask_and_unmasked_rgba_preservation(self):
        mask = self.save('mask.png', 'L', [0, 255])
        result = self.worker.run(dict(action='mask', input=mask, outputDirectory=str(self.root / 'mask')))
        with Image.open(result['image']['path']) as image:
            self.assertEqual(list(image.getchannel('A').getdata()), [255, 0])
        original = self.save('source.png', 'RGBA', [(1, 2, 3, 51), (4, 5, 6, 99)])
        generated = self.save('generated.png', 'RGBA', [(201, 202, 203, 255), (204, 205, 206, 255)])
        result = self.worker.run(dict(action='composite', original=original, generated=generated,
                                     mask=result['image']['path'], outputDirectory=str(self.root / 'result')))
        with Image.open(result['image']['path']) as image:
            self.assertEqual(list(image.getdata()), [(1, 2, 3, 51), (204, 205, 206, 255)])
        self.assertTrue(result['preservedUnmasked'])

    def test_rejects_unknown_action_invalid_mask_dimensions_and_collision(self):
        mask = self.save('mask.png', 'L', [0, 255])
        with self.assertRaises(ValueError):
            self.worker.run(dict(action='bad', outputDirectory=str(self.root / 'bad')))
        result = self.worker.run(dict(action='mask', input=mask, outputDirectory=str(self.root / 'out')))
        with self.assertRaises(ValueError):
            self.worker.run(dict(action='mask', input=mask, outputDirectory=str(self.root / 'out')))
        large = self.root / 'large.png'
        Image.new('RGBA', (3, 2)).save(large)
        with self.assertRaises(ValueError):
            self.worker.run(dict(action='composite', original=str(large), generated=str(large),
                                 mask=result['image']['path'], outputDirectory=str(self.root / 'mismatch')))

    def test_cli_and_error_protocol(self):
        import contextlib
        import io
        import json
        import sys
        from unittest.mock import patch
        mask = self.save('mask.png', 'L', [0, 255])
        request = self.root / 'request.json'
        request.write_text(json.dumps(dict(action='mask', input=mask, outputDirectory=str(self.root / 'cli'))))
        for args, expected in [(['repaint.py', str(request)], 0), (['repaint.py'], 2)]:
            with patch.object(sys, 'argv', args), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(self.worker.main(), expected)
                self.assertEqual(json.loads(output.getvalue())['ok'], expected == 0)

    def test_source_raster_round_trip_without_resampling(self):
        source = self.save('source.png', 'RGBA', [(1, 2, 3, 51), (4, 5, 6, 99)])
        mask = self.save('paint.png', 'L', [0, 255])
        inspected = self.worker.run(dict(action='inspect-raster', input=source, outputDirectory=str(self.root / 'inspect')))
        padded = self.worker.run(dict(action='pad-raster', input=source, mask=mask, outputDirectory=str(self.root / 'pad')))
        self.assertEqual(inspected['raster'], padded['raster'])
        self.assertEqual(padded['raster']['paddedSize'], dict(width=64, height=64))
        with Image.open(padded['image']['path']) as image:
            self.assertEqual(image.getpixel((1, 0)), (4, 5, 6, 99))
            self.assertEqual(image.getpixel((2, 0)), (0, 0, 0, 0))
        with Image.open(padded['mask']['path']) as image:
            self.assertEqual(image.mode, 'L')
            self.assertEqual(image.getpixel((1, 0)), 255)
            self.assertEqual(image.getpixel((2, 0)), 0)
        converted = self.worker.run(dict(action='mask', input=padded['mask']['path'], outputDirectory=str(self.root / 'converted')))
        with Image.open(converted['image']['path']) as image:
            self.assertEqual(image.getpixel((2, 0))[3], 255)
        cropped = self.worker.run(dict(action='crop-raster', input=padded['image']['path'], raster=padded['raster'], outputDirectory=str(self.root / 'crop')))
        with Image.open(cropped['image']['path']) as image:
            self.assertEqual(list(image.getdata()), [(1, 2, 3, 51), (4, 5, 6, 99)])
        with self.assertRaises(ValueError):
            self.worker.run(dict(action='pad-raster', input=source, outputDirectory=str(self.root / 'pad')))

    def test_raster_rejects_animation_and_accepts_axis_boundary(self):
        source = self.root / 'wide.png'
        Image.new('RGBA', (4096, 1)).save(source)
        result = self.worker.run(dict(action='pad-raster', input=str(source), outputDirectory=str(self.root / 'wide')))
        self.assertEqual(result['raster']['paddedSize'], dict(width=4096, height=64))
        animation = self.root / 'animated.png'
        Image.new('RGBA', (2, 2), 'red').save(animation, save_all=True, append_images=[Image.new('RGBA', (2, 2), 'blue')], duration=100)
        with self.assertRaises(ValueError):
            self.worker.run(dict(action='inspect-raster', input=str(animation), outputDirectory=str(self.root / 'animated')))

    def test_raster_mapping_bounds_and_rejections(self):
        source = self.root / 'bird.png'
        Image.new('RGBA', (1312, 1199)).save(source)
        result = self.worker.run(dict(action='inspect-raster', input=str(source), outputDirectory=str(self.root / 'inspect')))
        self.assertEqual(result['raster']['paddedSize'], dict(width=1312, height=1200))
        for size in [(4097, 1), (4096, 4096)]:
            Image.new('RGBA', size).save(source)
            with self.assertRaises(ValueError):
                self.worker.run(dict(action='inspect-raster', input=str(source), outputDirectory=str(self.root / str(size[0]))))
        small = self.save('small.png', 'RGBA', [(1, 2, 3, 4)] * 2)
        mask = self.root / 'wrong-mask.png'
        Image.new('L', (3, 1)).save(mask)
        with self.assertRaises(ValueError):
            self.worker.run(dict(action='pad-raster', input=small, mask=str(mask), outputDirectory=str(self.root / 'wrong-mask')))
        import copy
        for mapping in [result['raster'], dict(result['raster'], offset=dict(x=1, y=0)), dict(result['raster'], sourceSize=dict(width=True, height=1))]:
            with self.assertRaises(ValueError):
                self.worker.run(dict(action='crop-raster', input=small, raster=copy.deepcopy(mapping), outputDirectory=str(self.root / 'bad-crop')))


if __name__ == '__main__':
    unittest.main()
