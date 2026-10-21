'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  runImageOperation
} = require('../lib/image-tools');
async function fixture(t) {
  const scratch = path.resolve(__dirname, '../../.tmp/image-tools');
  await fs.mkdir(scratch, {
    recursive: true
  });
  const root = await fs.mkdtemp(path.join(scratch, 'operation-'));
  t.after(() => fs.rm(root, {
    recursive: true,
    force: true
  }));
  return {
    stagingDir: root,
    config: {
      tools: {
        python: {
          executable: process.execPath
        }
      },
      background: {
        modelPath: 'configured-model.onnx',
        packageRoot: 'configured-package'
      }
    }
  };
}
test('image operations choose registered workers and trusted background configuration', async t => {
  const f = await fixture(t);
  let observed;
  const result = await runImageOperation('remove-background', {
    input: 'source.png',
    modelPath: 'untrusted-model'
  }, {
    ...f,
    runTool: async (tools, name, args) => {
      observed = {
        tools,
        name,
        args,
        request: JSON.parse(await fs.readFile(args[1], 'utf8'))
      };
      await fs.mkdir(observed.request.outputDirectory, {
        recursive: true
      });
      const file = path.join(observed.request.outputDirectory, 'foreground.png');
      await fs.writeFile(file, 'bounded worker output');
      return {
        exitCode: 0,
        error: null,
        stdout: JSON.stringify({
          ok: true,
          image: {
            path: file,
            width: 2,
            height: 3
          },
          model: {
            sha256: 'fixture'
          }
        })
      };
    }
  });
  assert.match(observed.args[0], /workers[\\/]background\.py$/);
  assert.equal(observed.request.modelPath, 'configured-model.onnx');
  assert.equal(observed.request.packageRoot, 'configured-package');
  assert.equal(result.image.height, 3);
  await assert.rejects(runImageOperation('arbitrary-script', {}, f), {
    code: 'UNSUPPORTED'
  });
  await assert.rejects(runImageOperation('remove-background', {}, {
    ...f,
    config: {
      tools: f.config.tools
    }
  }), {
    code: 'CAPABILITY_MISSING'
  });
});
test('worker protocol, cancellation and escaped output cannot report success', async t => {
  const f = await fixture(t);
  for (const result of [{
    exitCode: 1,
    error: {
      code: 'ABORTED'
    },
    stdout: ''
  }, {
    exitCode: 1,
    error: null,
    stdout: '{}'
  }, {
    exitCode: 0,
    error: null,
    stdout: JSON.stringify({
      ok: true,
      image: {
        path: path.join(f.stagingDir, '..', 'escape.png'),
        width: 1,
        height: 1
      }
    })
  }]) {
    await assert.rejects(runImageOperation('mask', {
      input: 'mask.png'
    }, {
      ...f,
      runTool: async () => result
    }));
  }
});
test('conditioning preview uses the registered lossless preview worker', async t => {
  const f = await fixture(t);
  const result = await runImageOperation('preview', {
    input: 'original.jpg'
  }, {
    ...f,
    runTool: async (tools, name, args) => {
      assert.match(args[0], /workers[\\/]preview\.py$/);
      const request = JSON.parse(await fs.readFile(args[1], 'utf8'));
      await fs.mkdir(request.outputDirectory, {
        recursive: true
      });
      const file = path.join(request.outputDirectory, 'original.png');
      await fs.writeFile(file, 'normalized fixture');
      return {
        exitCode: 0,
        error: null,
        stdout: JSON.stringify({
          ok: true,
          image: {
            path: file,
            width: 1,
            height: 1
          }
        })
      };
    }
  });
  assert.equal(result.image.width, 1);
});

test('raster actions dispatch through repaint and bind both padded outputs', async t => {
  const f = await fixture(t);
  for (const action of ['inspect-raster', 'pad-raster', 'crop-raster']) {
    const result = await runImageOperation(action, { input: 'source.png' }, {
      ...f,
      runTool: async (tools, name, args) => {
        assert.match(args[0], /workers[\\/]repaint\.py$/);
        const request = JSON.parse(await fs.readFile(args[1], 'utf8'));
        assert.equal(request.action, action);
        await fs.mkdir(request.outputDirectory, { recursive: true });
        const image = { path: path.join(request.outputDirectory, 'raster.png'), width: 64, height: 64 };
        const mask = { path: path.join(request.outputDirectory, 'paint.png'), width: 64, height: 64 };
        await fs.writeFile(image.path, 'pixels');
        await fs.writeFile(mask.path, 'paint');
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, image, mask }) };
      }
    });
    assert.match(result.image.sha256, /^[a-f0-9]{64}$/);
    assert.match(result.mask.sha256, /^[a-f0-9]{64}$/);
  }
});

test('optional paint output cannot escape staging or bypass metadata checks', async t => {
  const f = await fixture(t);
  for (const mask of [
    { path: path.join(f.stagingDir, '..', 'escape.png'), width: 64, height: 64 },
    { path: 'paint.png', width: 0, height: 64 }
  ]) {
    await assert.rejects(runImageOperation('pad-raster', { input: 'source.png' }, {
      ...f,
      runTool: async (tools, name, args) => {
        const request = JSON.parse(await fs.readFile(args[1], 'utf8'));
        await fs.mkdir(request.outputDirectory, { recursive: true });
        const file = path.join(request.outputDirectory, 'raster.png');
        await fs.writeFile(file, 'pixels');
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, image: { path: file, width: 64, height: 64 }, mask }) };
      }
    }));
  }
});
