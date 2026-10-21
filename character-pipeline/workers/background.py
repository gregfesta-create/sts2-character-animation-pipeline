"""Offline foreground extraction using an explicitly configured local ISNet model."""
import hashlib
import importlib
import io
import json
from pathlib import Path
import sys
from PIL import Image, ImageChops

MAX_BYTES = 64 * 1024 * 1024
MAX_PIXELS = 16000000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def safe_path(value):
    path = Path(value).absolute()
    require(not any(p.is_symlink() or p.is_junction() for p in [path, *path.parents]), 'Link paths forbidden')
    return path


def read(path, maximum):
    path = safe_path(path)
    require(path.is_file() and path.stat().st_size <= maximum, 'Missing or oversized file')
    with path.open('rb') as handle:
        result = handle.read(maximum + 1)
    require(len(result) <= maximum, 'Oversized file')
    return result


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1048576), b''):
            digest.update(chunk)
    return digest.hexdigest()


def load_predictor(model, package_root=None):
    if package_root:
        root = safe_path(package_root)
        require((root / 'rembg').is_dir(), 'Missing configured rembg package')
        sys.path.insert(0, str(root))
    # Deliberately avoid rembg.new_session and download_models. The existing
    # predictor runs only the local ONNX session supplied here.
    module = importlib.import_module('rembg.sessions.dis_general_use')
    ort = importlib.import_module('onnxruntime')
    session = module.DisSession.__new__(module.DisSession)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    session.inner_session = ort.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider'])
    return session.predict


def run(request, predictor=None):
    require(isinstance(request, dict) and request.get('action') == 'remove-background', 'Expected remove-background action')
    source = safe_path(request['input'])
    model = safe_path(request['modelPath'])
    require(model.is_file() and 0 < model.stat().st_size <= 1073741824, 'Missing or oversized local model; downloads disabled')
    data = read(source, MAX_BYTES)
    with Image.open(io.BytesIO(data)) as original:
        require(0 < original.width * original.height <= MAX_PIXELS and getattr(original, 'n_frames', 1) == 1, 'Invalid decoded image dimensions or animation')
        original.load()
        image = original.convert('RGBA')
    root = safe_path(request['outputDirectory'])
    target = safe_path(root / 'foreground.png')
    require(not target.exists() and target != source and target != model, 'Output collision')
    masks = (predictor or load_predictor(model, request.get('packageRoot')))(image)
    require(isinstance(masks, list) and len(masks) == 1 and isinstance(masks[0], Image.Image), 'Expected one foreground mask')
    mask = masks[0]
    require(mask.size == image.size, 'Foreground mask must retain source dimensions')
    image.putalpha(ImageChops.multiply(image.getchannel('A'), mask.convert('L')))
    bounds = image.getchannel('A').getbbox()
    require(bounds is not None, 'Foreground extraction returned empty alpha')
    root.mkdir(parents=True, exist_ok=True)
    image.save(target)
    return dict(ok=True, image=dict(path=str(target), width=image.width, height=image.height, alphaBounds=list(bounds)), source=dict(sha256=hashlib.sha256(data).hexdigest(), width=image.width, height=image.height), model=dict(path=str(model), sha256=sha256(model)), alignment=dict(scale=1, translation=[0, 0]))


def main():
    try:
        require(len(sys.argv) == 2, 'Usage: background.py request.json')
        request = json.loads(read(sys.argv[1], 4194304))
        print(json.dumps(run(request), allow_nan=False))
        return 0
    except Exception as error:
        print(json.dumps(dict(ok=False, error=dict(code='BACKGROUND_FAILED', message=str(error)))))
        return 2


if __name__ == '__main__':
    sys.exit(main())
