'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  resolveContained,
  hashFile
} = require('./assets');
const {
  runTool: defaultRunTool
} = require('./process');
const fail = (code, message) => Object.assign(new Error(message), {
  code
});
async function runImageOperation(action, request, {
  config,
  stagingDir,
  runTool = defaultRunTool,
  signal
} = {}) {
  const scripts = {
    'remove-background': 'background.py',
    mask: 'repaint.py',
    composite: 'repaint.py',
    'inspect-raster': 'repaint.py',
    'pad-raster': 'repaint.py',
    'crop-raster': 'repaint.py',
    preview: 'preview.py'
  };
  if (!Object.hasOwn(scripts, action)) throw fail('UNSUPPORTED', 'Unknown registered image operation.');
  if (!config?.tools?.python?.executable) throw fail('CAPABILITY_MISSING', 'Configured Python with Pillow is required.');
  if (action === 'remove-background' && !config.background?.modelPath) throw fail('CAPABILITY_MISSING', 'An existing local background-removal model must be configured. Downloads are disabled.');
  const relative = 'operation-' + crypto.randomUUID();
  const folder = await resolveContained(stagingDir, relative, {
    mustExist: false
  });
  await fs.mkdir(folder, {
    recursive: true
  });
  const payload = {
    ...request,
    action,
    outputDirectory: path.join(folder, 'output')
  };
  if (action === 'remove-background') {
    payload.modelPath = config.background.modelPath;
    payload.packageRoot = config.background.packageRoot;
  }
  const file = path.join(folder, 'request.json');
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > 1024 * 1024) throw fail('QUOTA_EXCEEDED', 'Image operation request exceeds limit.');
  await fs.writeFile(file, serialized);
  const result = await runTool({
    python: config.tools.python
  }, 'python', [path.resolve(__dirname, '../workers', scripts[action]), file], {
    signal,
    timeoutMs: 120000,
    maxOutputBytes: 1024 * 1024
  });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw fail(result.error?.code || 'INVALID_WORKER_OUTPUT', 'Image operation returned invalid JSON.');
  }
  if (parsed?.ok === false) throw fail(parsed.error?.code || 'IMAGE_OPERATION_FAILED', parsed.error?.message || 'Image operation failed.');
  if (result.error || result.exitCode !== 0) throw fail(result.error?.code || 'IMAGE_OPERATION_FAILED', 'Image operation failed.');
  if (parsed?.ok !== true) throw fail('INVALID_WORKER_OUTPUT', 'Image operation returned invalid metadata.');
  async function bindImage(image) {
    if (typeof image?.path !== 'string' || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width <= 0 || image.height <= 0 || image.width * image.height > 16000000) throw fail('INVALID_WORKER_OUTPUT', 'Image operation returned invalid metadata.');
    const rel = path.relative(folder, path.resolve(image.path));
    const output = await resolveContained(folder, rel);
    const stat = await fs.stat(output);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw fail('QUOTA_EXCEEDED', 'Image operation output exceeds limit.');
    return { ...image, path: output, sha256: await hashFile(output) };
  }
  return {
    ...parsed,
    image: await bindImage(parsed.image),
    ...(parsed.mask === undefined ? {} : { mask: await bindImage(parsed.mask) })
  };
}
module.exports = {
  runImageOperation
};
