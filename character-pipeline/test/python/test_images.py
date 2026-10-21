import importlib.util
import hashlib
import io
import json
import tempfile
import unittest
import zipfile
import subprocess
import sys
from unittest.mock import patch
import contextlib
from pathlib import Path
from PIL import Image

WORKER = Path(__file__).resolve().parents[2] / 'workers/images.py'


class ImagesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=WORKER.parents[1] / 'evidence/w2-images')
        self.root = Path(self.tmp.name)
        spec = importlib.util.spec_from_file_location('images', WORKER)
        self.worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.worker)

    def tearDown(self):
        self.tmp.cleanup()

    def image(self, name='source.png'):
        image = Image.new('RGBA', (8, 8), (255, 0, 255, 0))
        for x in range(2, 6):
            for y in range(1, 5):
                image.putpixel((x, y), (120, 80, 40, 255))
        path = self.root / name
        image.save(path)
        return path

    def prepare(self, **extra):
        part = dict(id='body', input=str(self.image()), pivot=[3, 4], pixelsPerUnit=2)
        part.update(extra)
        return self.worker.run(dict(action='prepare', parts=[part], outputDirectory=str(self.root / 'out')))

    def test_trim_scale_pivot_and_preserve(self):
        source = self.image().read_bytes()
        result = self.prepare(scale=2)
        part = result['parts'][0]
        self.assertEqual(part['image']['pivot'], [2, 6])
        self.assertEqual(part['image']['cropTranslation'], [-4, -2])
        self.assertEqual(part['image']['pixelsPerUnit'], 4)
        self.assertEqual(part['source']['alphaBounds'], [2, 1, 6, 5])
        self.assertEqual((part['image']['width'], part['image']['height']), (8, 8))
        self.assertEqual(self.image().read_bytes(), source)
        atlas = Image.open(result['atlas']['path'])
        region = result['atlas']['regions'][0]
        self.assertEqual(atlas.getpixel((0, 0)), (0, 0, 0, 0))
        self.assertEqual(atlas.getpixel((region['x'], region['y'])), (120, 80, 40, 255))

    def test_mask_multiplies_alpha(self):
        mask = Image.new('L', (8, 8), 0)
        mask.putpixel((3, 2), 128)
        path = self.root / 'mask.png'
        mask.save(path)
        part = self.prepare(mask=str(path))['parts'][0]
        self.assertEqual(Image.open(part['image']['path']).getpixel((0, 0)), (120, 80, 40, 128))

    def surface_mask(self, size=(8, 8), points=((3, 2),)):
        image = Image.new('L', size, 0)
        for point in points:
            image.putpixel(point, 1)
        path = self.root / 'required.png'
        image.save(path)
        return path

    def test_required_surface_receipt_binds_source_mask_and_final_output(self):
        mask = self.surface_mask()
        part = self.prepare(requiredSurfaceMask=str(mask), scale=2)['parts'][0]
        receipt = part['surfaceCoverage']
        self.assertEqual(receipt, dict(version=1, status='verified', sourceSha256=part['source']['sha256'], maskSha256=hashlib.sha256(mask.read_bytes()).hexdigest(), outputSha256=hashlib.sha256(Path(part['image']['path']).read_bytes()).hexdigest(), width=8, height=8, requiredPixels=1, missingPixels=0, alphaThreshold=1))

    def test_required_surface_rejects_empty_mismatch_and_uncovered(self):
        for size, points, message in [((8, 8), (), 'empty'), ((4, 4), ((1, 1),), 'dimensions'), ((8, 8), ((0, 0),), '1 required pixels')]:
            with self.subTest(size=size, points=points):
                mask = self.surface_mask(size, points)
                with self.assertRaisesRegex(ValueError, message):
                    self.prepare(requiredSurfaceMask=str(mask))
                self.assertFalse((self.root / 'out/body.png').exists())

    def test_required_surface_checks_extraction_alpha_and_accepts_one(self):
        mask = self.surface_mask()
        extraction = self.root / 'extraction.png'
        Image.new('L', (8, 8), 0).save(extraction)
        with self.assertRaisesRegex(ValueError, '1 required pixels'):
            self.prepare(requiredSurfaceMask=str(mask), mask=str(extraction))
        source = self.root / 'faint.png'
        Image.new('RGBA', (8, 8), (1, 2, 3, 1)).save(source)
        self.assertEqual(self.prepare(input=str(source), requiredSurfaceMask=str(mask))['parts'][0]['surfaceCoverage']['missingPixels'], 0)

    def test_no_required_surface_has_no_receipt(self):
        self.assertNotIn('surfaceCoverage', self.prepare()['parts'][0])

    def test_required_surface_limits_and_output_collisions(self):
        source = self.image()
        mask = self.surface_mask()
        part = dict(id='body', input=str(source), pivot=[0, 0], requiredSurfaceMask=str(mask))
        request = dict(action='prepare', parts=[part], outputDirectory=str(self.root / 'out'))
        self.surface_mask((9, 8))
        with self.assertRaisesRegex(ValueError, 'pixel limit'):
            self.worker.run(dict(request, limits=dict(maxPixels=64)))
        self.surface_mask()
        self.worker.run(request)
        with self.assertRaisesRegex(ValueError, 'collision'):
            self.worker.run(request)
        self.assertEqual(source.read_bytes(), self.image().read_bytes())

    def test_rejections(self):
        for changes in [dict(scale=0), dict(scale=float('nan')), dict(pivot=[0]), dict(id='../bad')]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.prepare(**changes)
        empty = self.root / 'empty.png'
        Image.new('RGBA', (8, 8)).save(empty)
        with self.assertRaises(ValueError):
            self.prepare(input=str(empty))
        opaque = self.root / 'opaque.png'
        Image.new('RGB', (8, 8)).save(opaque)
        with self.assertRaises(ValueError):
            self.prepare(input=str(opaque))

    def archive(self, entries):
        path = self.root / 'art.ora'
        with zipfile.ZipFile(path, 'w') as archive:
            for name, content in entries:
                archive.writestr(name, content)
        return path

    def test_layered_offsets(self):
        png = self.image().read_bytes()
        path = self.archive([('stack.xml', '<image w="8" h="8"><stack><layer name="Arm" src="data/a.png" x="-2" y="3"/></stack></image>'), ('data/a.png', png)])
        result = self.worker.run(dict(action='layered', input=str(path), outputDirectory=str(self.root / 'out')))
        self.assertEqual(result['layers'][0]['offset'], [-2, 3])
        self.assertEqual(result['layers'][0]['name'], 'Arm')

    def test_archive_attacks(self):
        for entries in [[('../escape', b'x')], [('stack.xml', '<!DOCTYPE x [<!ENTITY x "bad">]><image/>')], [('stack.xml', '<image w="8" h="8"><stack><layer src="../x"/></stack></image>')]]:
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                self.worker.run(dict(action='layered', input=str(self.archive(entries)), outputDirectory=str(self.root / 'out')))

    def test_limits_collisions_and_masks(self):
        source = self.image()
        request = dict(action='prepare', parts=[dict(id='p', input=str(source), pivot=[0, 0])], outputDirectory=str(self.root / 'out'))
        for limit in [dict(maxPixels=1), dict(maxAtlasPixels=1), dict(maxFileBytes=1), dict(maxParts=0), dict(unknown=1)]:
            with self.subTest(limit=limit), self.assertRaises(ValueError):
                self.worker.run(dict(request, limits=limit))
        mask = self.root / 'mask.png'
        Image.new('L', (1, 1), 255).save(mask)
        with self.assertRaises(ValueError):
            self.prepare(mask=str(mask))
        self.worker.run(request)
        with self.assertRaises(ValueError):
            self.worker.run(request)
        with self.assertRaises(ValueError):
            self.worker.run(dict(request, parts=request['parts'] * 2, outputDirectory=str(self.root / 'other')))

    def test_cli_json(self):
        path = self.root / 'request.json'
        path.write_text(json.dumps(dict(action='prepare', parts=[dict(id='part', input=str(self.image()), pivot=[0, 0])], outputDirectory=str(self.root / 'out'))))
        result = subprocess.run([sys.executable, str(WORKER), str(path)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['ok'])
        path.write_text('{broken')
        result = subprocess.run([sys.executable, str(WORKER), str(path)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)['error']['code'], 'IMAGE_INVALID')

    def test_alpha_cleanup_and_rgb_mask(self):
        mask = self.root / 'mask.png'
        Image.new('L', (8, 8), 128).save(mask)
        source = self.root / 'rgb.png'
        Image.new('RGB', (8, 8), (20, 40, 60)).save(source)
        result = self.prepare(input=str(source), mask=str(mask))
        self.assertEqual(Image.open(result['parts'][0]['image']['path']).getpixel((0, 0)), (20, 40, 60, 128))

    def test_archive_duplicates_links_and_expansion(self):
        cases = [ [('a', b'x'), ('a', b'x')], [('huge', b'0' * 1000000)], [('stack.xml', '<image w="8" h="8"><stack opacity="0.5"><layer src="a"/></stack></image>'), ('a', self.image().read_bytes())] ]
        for entries in cases:
            with self.subTest(entries=[e[0] for e in entries]), self.assertRaises(ValueError):
                self.worker.run(dict(action='layered', input=str(self.archive(entries)), outputDirectory=str(self.root / 'out'), limits=dict(maxFileBytes=10000)))

    def test_fractional_scale_empty_mask_and_multiple_parts(self):
        with self.assertRaises(ValueError):
            self.prepare(scale=0.3)
        mask = self.root / 'zero.png'
        Image.new('L', (8, 8), 0).save(mask)
        with self.assertRaises(ValueError):
            self.prepare(mask=str(mask))
        image = self.image()
        parts = [dict(id='p' + str(i), input=str(image), pivot=[0, 0], scale=0.5) for i in range(2)]
        result = self.worker.run(dict(action='prepare', parts=parts, outputDirectory=str(self.root / 'many')))
        self.assertEqual(result['parts'][0]['image']['width'], 2)
        self.assertEqual(result['atlas']['regions'][1]['y'], 8)

    def test_symlink_input_and_output(self):
        source = self.image()
        link = self.root / 'link.png'
        try:
            link.symlink_to(source)
        except OSError:
            self.skipTest('Windows symlink privilege unavailable')
        with self.assertRaises(ValueError):
            self.prepare(input=str(link))

    def test_archive_symlink_entry(self):
        path = self.root / 'linked.ora'
        with zipfile.ZipFile(path, 'w') as archive:
            info = zipfile.ZipInfo('linked')
            info.create_system = 3
            info.external_attr = 0o120777 << 16
            archive.writestr(info, 'target')
        with self.assertRaises(ValueError):
            self.worker.run(dict(action='layered', input=str(path), outputDirectory=str(self.root / 'out')))

    def test_archive_total_decoded_pixels(self):
        png = self.image().read_bytes()
        path = self.archive([('stack.xml', '<image w="8" h="8"><stack><layer src="a"/><layer src="b"/></stack></image>'), ('a', png), ('b', png)])
        with self.assertRaises(ValueError):
            self.worker.run(dict(action='layered', input=str(path), outputDirectory=str(self.root / 'out'), limits=dict(maxPixels=64)))

    def test_junction_input_and_output_roots(self):
        import _winapi
        owned = self.root / 'owned'
        owned.mkdir()
        source = owned / 'source.png'
        source.write_bytes(self.image().read_bytes())
        junction = self.root / 'junction'
        _winapi.CreateJunction(str(owned), str(junction))
        try:
            self.assertTrue(junction.is_junction())
            with self.assertRaisesRegex(ValueError, 'Link paths'):
                self.prepare(input=str(junction / 'source.png'))
            with self.assertRaisesRegex(ValueError, 'Link paths'):
                self.worker.run(dict(action='prepare', parts=[], outputDirectory=str(junction / 'output')))
            self.assertFalse((owned / 'output').exists())
        finally:
            junction.rmdir()

    def test_main_success_and_failure(self):
        path = self.root / 'request.json'
        path.write_text(json.dumps(dict(action='prepare', parts=[dict(id='p', input=str(self.image()), pivot=[0, 0])], outputDirectory=str(self.root / 'out'))))
        with patch.object(sys, 'argv', [str(WORKER), str(path)]), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(self.worker.main(), 0)
            self.assertTrue(json.loads(output.getvalue())['ok'])
        with patch.object(sys, 'argv', [str(WORKER)]), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(self.worker.main(), 2)
            self.assertFalse(json.loads(output.getvalue())['ok'])


if __name__ == '__main__':
    unittest.main()
