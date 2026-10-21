import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import types
from unittest.mock import patch
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT / 'workers/background.py'


class BackgroundTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=ROOT / 'test/python')
        self.root = Path(self.tmp.name)
        spec = importlib.util.spec_from_file_location('background', WORKER)
        self.worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.worker)
        self.source = self.root / 'source.png'
        Image.new('RGBA', (4, 4), (20, 40, 60, 128)).save(self.source)
        self.model = self.root / 'model.onnx'
        self.model.write_bytes(b'fixture')
        self.request = dict(action='remove-background', input=str(self.source), modelPath=str(self.model), outputDirectory=str(self.root / 'out'))

    def tearDown(self):
        self.tmp.cleanup()

    def test_pixel_alpha_alignment_immutable(self):
        original = self.source.read_bytes()
        result = self.worker.run(self.request, predictor=lambda image: [Image.new('L', image.size, 128)])
        image = Image.open(result['image']['path'])
        self.assertEqual(image.size, (4, 4))
        self.assertEqual(image.getpixel((0, 0)), (20, 40, 60, 64))
        self.assertEqual(result['alignment'], dict(scale=1, translation=[0, 0]))
        self.assertEqual(self.source.read_bytes(), original)

    def test_failures(self):
        for delta in [dict(action='unknown'), dict(input=str(self.root / 'missing')), dict(modelPath=str(self.root / 'missing'))]:
            with self.subTest(delta=delta), self.assertRaises((ValueError, FileNotFoundError)):
                self.worker.run(dict(self.request, **delta), predictor=lambda image: [])
        for masks in [[], [Image.new('L', (1, 1), 255)], [Image.new('L', (4, 4), 0)]]:
            with self.subTest(masks=len(masks)), self.assertRaises(ValueError):
                self.worker.run(self.request, predictor=lambda image: masks)

    def test_cli_diagnostic(self):
        with patch.object(sys, 'argv', [str(WORKER)]), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(self.worker.main(), 2)
            self.assertFalse(json.loads(output.getvalue())['ok'])

    def test_model_session_is_local_only(self):
        class FakeSession:
            def predict(self, image):
                return [Image.new('L', image.size, 255)]
        calls = []
        fake_ort = types.SimpleNamespace(SessionOptions=lambda: types.SimpleNamespace(), InferenceSession=lambda path, **options: calls.append((path, options)))
        modules = {'rembg.sessions.dis_general_use': types.SimpleNamespace(DisSession=FakeSession), 'onnxruntime': fake_ort}
        package = self.root / 'package'
        (package / 'rembg').mkdir(parents=True)
        with patch.object(self.worker.importlib, 'import_module', side_effect=lambda name: modules[name]):
            predictor = self.worker.load_predictor(self.model, str(package))
            self.assertEqual(predictor(Image.new('RGB', (2, 2)))[0].size, (2, 2))
            self.assertTrue(callable(self.worker.load_predictor(self.model)))
        self.assertEqual(calls[0][0], str(self.model))
        self.assertEqual(calls[0][1]['providers'], ['CPUExecutionProvider'])
        with self.assertRaises(ValueError):
            self.worker.load_predictor(self.model, str(self.root / 'missing'))

    def test_collision_size_limits_and_model_failure(self):
        with patch.object(self.worker, 'MAX_PIXELS', 1), self.assertRaises(ValueError):
            self.worker.run(self.request, predictor=lambda image: [])
        with patch.object(self.worker, 'MAX_BYTES', 1), self.assertRaises(ValueError):
            self.worker.run(self.request, predictor=lambda image: [])
        with patch.object(self.worker, 'load_predictor', side_effect=RuntimeError('local model invalid')), self.assertRaisesRegex(RuntimeError, 'local model invalid'):
            self.worker.run(self.request)
        self.worker.run(self.request, predictor=lambda image: [Image.new('L', image.size, 255)])
        with self.assertRaisesRegex(ValueError, 'collision'):
            self.worker.run(self.request, predictor=lambda image: [])

    def test_junction_rejection(self):
        import _winapi
        junction = self.root / 'junction'
        _winapi.CreateJunction(str(self.root), str(junction))
        try:
            with self.assertRaisesRegex(ValueError, 'Link paths'):
                self.worker.run(dict(self.request, outputDirectory=str(junction / 'out')))
            with self.assertRaisesRegex(ValueError, 'Link paths'):
                self.worker.run(dict(self.request, input=str(junction / 'source.png')))
        finally:
            junction.rmdir()

    def test_main_success(self):
        path = self.root / 'request.json'
        path.write_text(json.dumps(self.request))
        with patch.object(sys, 'argv', [str(WORKER), str(path)]), patch.object(self.worker, 'load_predictor', return_value=lambda image: [Image.new('L', image.size, 255)]), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(self.worker.main(), 0)
            self.assertTrue(json.loads(output.getvalue())['ok'])

    def test_actual_offline_onnx(self):
        # Synthetic solid-color fixture exercises the real installed model only;
        # it is not evidence of semantic part separation or creative art quality.
        request = dict(self.request, modelPath='D:/StS2Modding/tools/rembg_models/models/isnet-general-use/isnet-general-use.onnx', packageRoot='D:/StS2Modding/tools/rembglib')
        with patch('socket.socket.connect', side_effect=AssertionError('Network forbidden')):
            result = self.worker.run(request)
        self.assertEqual(Image.open(result['image']['path']).size, (4, 4))
        self.assertEqual(result['alignment']['translation'], [0, 0])


if __name__ == '__main__':
    unittest.main()
