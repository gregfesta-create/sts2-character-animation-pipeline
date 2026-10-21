import importlib.util
import hashlib
from pathlib import Path
import tempfile
import unittest
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('masks', ROOT / 'workers/masks.py')
masks = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(masks)


class MasksTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / 'test/python')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def request(self, second=1, alpha=1):
        captures = []
        for index, x in enumerate([1, second]):
            image = Image.new('RGBA', (4, 4))
            image.putpixel((x, 1), (255, 0, 0, alpha))
            file = self.root / f'part-mask-{index}.png'
            image.save(file)
            captures.append(dict(id=index, path=file.name, sha256=hashlib.sha256(file.read_bytes()).hexdigest(), width=4, height=4))
        return dict(version=1, sourceRoot=str(self.root), planHash='a'*64, renderLayoutHash='b'*64, captures=captures, comparisons=[dict(id=0, captureA=0, captureB=1)])

    def test_real_alpha_not_padding_and_alpha_one_counts(self):
        request = self.request(second=2)
        before = [(self.root / c['path']).read_bytes() for c in request['captures']]
        result = masks.run(request)
        self.assertEqual(result['comparisons'], [dict(id=0, previewOverlapPixels=0)])
        self.assertEqual(result['decodedPixels'], 32)
        self.assertEqual(before, [(self.root / c['path']).read_bytes() for c in request['captures']])
        self.assertEqual(masks.run(self.request())['comparisons'][0]['previewOverlapPixels'], 1)
        self.assertEqual(masks.run(self.request(alpha=0))['comparisons'][0]['previewOverlapPixels'], 0)

    def test_rejects_tampering_and_bad_mapping(self):
        for field, value in [('sha256', '0'*64), ('width', 5), ('path', '../bad.png')]:
            request = self.request()
            request['captures'][0][field] = value
            with self.subTest(field=field), self.assertRaises((ValueError, OSError)):
                masks.run(request)
        request = self.request()
        request['comparisons'][0]['captureB'] = 9
        with self.assertRaises(ValueError):
            masks.run(request)

    def test_rejects_corrupt_animated_oversized_and_excess_requests(self):
        request = self.request()
        file = self.root / request['captures'][0]['path']
        file.write_bytes(b'not PNG')
        request['captures'][0]['sha256'] = hashlib.sha256(file.read_bytes()).hexdigest()
        with self.assertRaises((ValueError, OSError)):
            masks.run(request)
        request = self.request()
        request['captures'] *= 33
        with self.assertRaises(ValueError):
            masks.run(request)

    def test_opaque_animation_and_unused_capture(self):
        request = self.request()
        for capture in request['captures']:
            file = self.root / capture['path']
            Image.new('RGBA', (4, 4), (1, 2, 3, 255)).save(file)
            capture['sha256'] = hashlib.sha256(file.read_bytes()).hexdigest()
        self.assertEqual(masks.run(request)['comparisons'][0]['previewOverlapPixels'], 16)
        file = self.root / request['captures'][0]['path']
        Image.new('RGBA', (4, 4)).save(file, save_all=True, append_images=[Image.new('RGBA', (4, 4), 'red')], duration=20)
        request['captures'][0]['sha256'] = hashlib.sha256(file.read_bytes()).hexdigest()
        with self.assertRaises(ValueError):
            masks.run(request)
        request = self.request()
        request['comparisons'][0]['captureB'] = True
        with self.assertRaises(ValueError):
            masks.run(request)


if __name__ == '__main__':
    unittest.main()
