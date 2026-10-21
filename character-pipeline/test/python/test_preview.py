import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT / 'workers/preview.py'
sys.path.insert(0, str(ROOT / 'workers'))


class PreviewTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=ROOT / 'test/python')
        self.root = Path(self.tmp.name)
        spec = importlib.util.spec_from_file_location('preview', WORKER)
        self.worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.worker)

    def tearDown(self):
        self.tmp.cleanup()

    def png(self, color, size=(3, 3), mode='RGBA'):
        buffer = io.BytesIO()
        Image.new(mode, size, color).save(buffer, format='PNG')
        return buffer.getvalue()

    def preview(self, data):
        source = self.root / 'extensionless'
        source.write_bytes(data)
        return self.worker.run(dict(input=str(source), outputDirectory=str(self.root / 'out')))

    def test_raster_exact_pixels_no_extra_outputs(self):
        data = self.png((20, 40, 60, 128))
        result = self.preview(data)
        image = Image.open(result['image']['path'])
        self.assertEqual(image.getpixel((0, 0)), (20, 40, 60, 128))
        self.assertEqual(image.size, (3, 3))
        self.assertEqual((self.root / 'extensionless').read_bytes(), data)
        self.assertEqual([p.name for p in (self.root / 'out').iterdir()], ['original.png'])

    def test_rgb_pixels(self):
        result = self.preview(self.png((10, 20, 30), mode='RGB'))
        self.assertEqual(Image.open(result['image']['path']).getpixel((0, 0)), (10, 20, 30, 255))

    def ora(self, stack, extra=()):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('stack.xml', stack)
            for name, value in extra:
                archive.writestr(name, value)
        return buffer.getvalue()

    def test_ora_order_canvas_offsets_alpha_ignores_false_merged(self):
        data = self.ora('<image w="6" h="5"><stack><layer src="top.png" x="2" y="1"/><layer src="bottom.png"/></stack></image>', [('top.png', self.png((255, 0, 0, 128), (2, 2))), ('bottom.png', self.png((0, 0, 255, 255))), ('mergedimage.png', self.png((0, 255, 0, 255)))])
        result = self.preview(data)
        image = Image.open(result['image']['path'])
        self.assertEqual(image.size, (6, 5))
        self.assertEqual(image.getpixel((2, 1)), (128, 0, 127, 255))
        self.assertEqual(image.getpixel((0, 0)), (0, 0, 255, 255))
        self.assertEqual(image.getpixel((5, 4)), (0, 0, 0, 0))
        self.assertEqual([p.name for p in (self.root / 'out').iterdir()], ['original.png'])

    def test_archive_adversaries(self):
        for data in [self.ora('<image w="3" h="3"/>', [('../escape', b'x')]), self.ora('<image w="3" h="3"><stack opacity="0.5"><layer src="a"/></stack></image>', [('a', self.png((1, 2, 3, 255)))]), self.ora('<image w="3" h="3"/>', [('bomb', b'0' * 2000000)]), b'PKbroken']:
            with self.subTest(data=len(data)), self.assertRaises((ValueError, OSError)):
                self.preview(data)
            self.assertFalse((self.root / 'out/original.png').exists())

    def test_archive_symlink(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            info = zipfile.ZipInfo('linked')
            info.create_system = 3
            info.external_attr = 0o120777 << 16
            archive.writestr(info, 'target')
        with self.assertRaisesRegex(ValueError, 'linked'):
            self.preview(buffer.getvalue())

    def test_negative_and_nested_offsets_clip_to_original_canvas(self):
        data = self.ora('<image w="3" h="3"><stack x="1" y="1"><stack x="-2"><layer src="a" y="-1"/></stack></stack></image>', [('a', self.png((10, 20, 30, 128), (2, 2)))])
        image = Image.open(self.preview(data)['image']['path'])
        self.assertEqual(image.size, (3, 3))
        self.assertEqual(image.getpixel((0, 0)), (10, 20, 30, 128))
        self.assertEqual(image.getpixel((1, 0)), (0, 0, 0, 0))

    def test_collision_and_limits(self):
        data = self.png((1, 2, 3, 255))
        self.preview(data)
        with self.assertRaises(ValueError):
            self.preview(data)
        source = self.root / 'extensionless'
        with self.assertRaises(ValueError):
            self.worker.run(dict(input=str(source), outputDirectory=str(self.root / 'other'), limits=dict(maxPixels=1)))

    def test_junctions(self):
        import _winapi
        source = self.root / 'source'
        source.write_bytes(self.png((1, 2, 3, 255)))
        junction = self.root / 'junction'
        _winapi.CreateJunction(str(self.root), str(junction))
        try:
            for request in [dict(input=str(junction / 'source'), outputDirectory=str(self.root / 'out')), dict(input=str(source), outputDirectory=str(junction / 'out'))]:
                with self.assertRaisesRegex(ValueError, 'Link paths'):
                    self.worker.run(request)
        finally:
            junction.rmdir()

    def test_cli_protocol(self):
        source = self.root / 'source'
        source.write_bytes(self.png((1, 2, 3, 255)))
        request = self.root / 'request.json'
        request.write_text(json.dumps(dict(input=str(source), outputDirectory=str(self.root / 'out'))))
        with patch.object(sys, 'argv', [str(WORKER), str(request)]), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(self.worker.main(), 0)
            self.assertTrue(json.loads(output.getvalue())['ok'])
        with patch.object(sys, 'argv', [str(WORKER)]), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(self.worker.main(), 2)
            self.assertEqual(json.loads(output.getvalue())['error']['code'], 'PREVIEW_FAILED')

    def test_actual_subprocess_cli(self):
        source = self.root / 'source'
        source.write_bytes(self.png((20, 40, 60, 128)))
        request = self.root / 'request.json'
        request.write_text(json.dumps(dict(input=str(source), outputDirectory=str(self.root / 'out'))))
        result = subprocess.run([sys.executable, str(WORKER), str(request)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['ok'])
        request.write_text('{invalid')
        result = subprocess.run([sys.executable, str(WORKER), str(request)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(json.loads(result.stdout)['error']['code'], 'PREVIEW_FAILED')


if __name__ == '__main__':
    unittest.main()
