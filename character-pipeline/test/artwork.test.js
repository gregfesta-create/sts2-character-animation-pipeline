'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pythonTestTools } = require('./support/python-tool');
const {
  prepareArtwork
} = require('../lib/artwork');
const temporaryRoots = [];
test('explicit background removal runs before cropping and retains model provenance', async () => {
  const f = await fixture();
  f.config.background = {
    modelPath: 'trusted.onnx',
    packageRoot: 'trusted-package'
  };
  const input = structuredClone(spec);
  input.artwork.provider = 'comfyui';
  input.artwork.settings = {
    backgroundRemoval: true
  };
  const calls = [];
  const result = await prepareArtwork(input, {
    ...f,
    runTool: async (tools, name, args) => {
      const request = JSON.parse(await fs.readFile(args[1], 'utf8'));
      calls.push(request.action);
      await fs.mkdir(request.outputDirectory, {
        recursive: true
      });
      const output = path.join(request.outputDirectory, 'image.png');
      await fs.writeFile(output, 'fixture pixels');
      if (request.action === 'remove-background') {
        assert.equal(request.modelPath, 'trusted.onnx');
        return {
          error: null,
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            image: {
              path: output,
              width: 8,
              height: 8
            },
            model: {
              sha256: 'model-fixture'
            },
            alignment: {
              scale: 1,
              translation: [0, 0]
            }
          })
        };
      }
      assert.equal(calls[0], 'remove-background');
      return {
        error: null,
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          parts: [{
            id: 'body',
            image: {
              path: output,
              prepared: true,
              width: 8,
              height: 8,
              alphaBounds: [0, 0, 8, 8],
              cropTranslation: [0, 0],
              pivot: [4, 5],
              pixelsPerUnit: 1
            },
            transform: {
              scale: 1,
              translation: [0, 0]
            }
          }]
        })
      };
    }
  });
  assert.deepEqual(calls, ['remove-background', 'prepare']);
  assert.equal(result.parts[0].background.model.sha256, 'model-fixture');
});
test.after(async () => {
  for (const root of temporaryRoots) {
    const target = path.resolve(root);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('artwork-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(target, {
      recursive: true,
      force: true
    });
  }
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artwork-'));
  temporaryRoots.push(root);
  await fs.writeFile(path.join(root, 'part.png'), 'source');
  const stagingDir = path.join(root, 'stage');
  await fs.mkdir(stagingDir);
  return {
    root,
    stagingDir,
    config: {
      sourceRoots: [root],
      tools: {
        python: {
          executable: 'trusted-python'
        }
      }
    }
  };
}
const spec = {
  artwork: {
    provider: 'existing'
  },
  parts: [{
    id: 'body',
    pivot: [4, 5],
    image: {
      path: 'part.png'
    },
    mesh: {
      vertices: [[0, 0]],
      uv: [[4, 5]]
    }
  }]
};
test('rejects unsupported provider and missing Python capability', async () => {
  const f = await fixture();
  await assert.rejects(prepareArtwork({
    ...spec,
    artwork: {
      provider: 'magic'
    }
  }, f), {
    code: 'UNSUPPORTED_PROVIDER'
  });
  await assert.rejects(prepareArtwork(spec, {
    ...f,
    config: {
      sourceRoots: [f.root]
    }
  }), {
    code: 'CAPABILITY_MISSING'
  });
});
test('copies immutable source, preserves spec and maps UV using crop transform', async () => {
  const f = await fixture();
  const before = JSON.stringify(spec);
  let request;
  const result = await prepareArtwork(spec, {
    ...f,
    runTool: async (registry, name, args) => {
      assert.equal(registry.python.executable, 'trusted-python');
      request = JSON.parse(await fs.readFile(args[1], 'utf8'));
      assert.notEqual(request.parts[0].input, path.join(f.root, 'part.png'));
      const output = path.join(request.outputDirectory, 'body.png');
      await fs.mkdir(request.outputDirectory, {
        recursive: true
      });
      await fs.writeFile(output, 'processed');
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          parts: [{
            id: 'body',
            image: {
              path: output,
              prepared: true,
              width: 8,
              height: 8,
              alphaBounds: [0, 0, 8, 8],
              cropTranslation: [-2, -3],
              pivot: [2, 2],
              pixelsPerUnit: 1
            },
            transform: {
              scale: 1,
              translation: [-2, -3]
            }
          }]
        }),
        error: null
      };
    }
  });
  assert.equal(JSON.stringify(spec), before);
  assert.deepEqual(result.spec.parts[0].mesh.uv, [[2, 2]]);
  assert.deepEqual(result.spec.parts[0].pivot, [4, 5]);
  assert.equal(await fs.readFile(request.parts[0].input, 'utf8'), 'source');
});
test('source traversal, worker failure and escaped outputs fail closed', async () => {
  const f = await fixture();
  await assert.rejects(prepareArtwork({
    ...spec,
    parts: [{
      ...spec.parts[0],
      image: {
        path: '../outside.png'
      }
    }]
  }, f), {
    code: 'UNSAFE_PATH'
  });
  await assert.rejects(prepareArtwork(spec, {
    ...f,
    runTool: async () => ({
      exitCode: 2,
      stdout: JSON.stringify({
        ok: false,
        error: {
          code: 'EMPTY_IMAGE',
          message: 'empty'
        }
      }),
      error: {
        code: 'NONZERO_EXIT'
      }
    })
  }), {
    code: 'EMPTY_IMAGE'
  });
  await assert.rejects(prepareArtwork(spec, {
    ...f,
    runTool: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        parts: [{
          id: 'body',
          image: {
            path: path.join(f.root, 'part.png')
          }
        }]
      }),
      error: null
    })
  }), {
    code: 'UNSAFE_PATH'
  });
});
test('real Pillow worker crops supplied art, applies mask and safely imports OpenRaster layers', async () => {
  const f = await fixture();
  f.config.tools = pythonTestTools();
  const {
    runTool
  } = require('../lib/process');
  const script = "from PIL import Image; import sys, zipfile, io; from pathlib import Path; p=Path(sys.argv[1]); im=Image.new('RGBA',(10,10)); im.paste((255,0,0,255),(2,3,8,9)); im.save(p/'part.png'); mask=Image.new('L',(10,10)); mask.paste(255,(3,4,7,8)); mask.save(p/'mask.png'); b=io.BytesIO(); im.save(b,format='PNG'); z=zipfile.ZipFile(p/'layers.ora','w'); z.writestr('mimetype','image/openraster'); z.writestr('stack.xml','<image w=\"20\" h=\"20\"><stack><layer name=\"body\" src=\"data/body.png\" x=\"4\" y=\"5\"/></stack></image>'); z.writestr('data/body.png',b.getvalue()); z.close()";
  const create = await runTool(f.config.tools, 'python', ['-c', script, f.root]);
  assert.equal(create.exitCode, 0, create.stderr);
  const original = await fs.readFile(path.join(f.root, 'part.png'));
  const result = await prepareArtwork({
    ...spec,
    parts: [{
      ...spec.parts[0],
      mask: {
        path: 'mask.png'
      }
    }]
  }, f);
  assert.deepEqual(result.parts[0].image.pivot, [1, 1]);
  assert.deepEqual(result.spec.parts[0].mesh.vertices, [[-3, -4]]);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'part.png')), original);
  assert.ok(result.atlas.width > 0);
  const layered = await prepareArtwork({
    ...spec,
    artwork: {
      provider: 'layered',
      source: 'layers.ora'
    }
  }, {
    ...f,
    stagingDir: path.join(f.root, 'layerstage')
  });
  assert.deepEqual(layered.parts[0].image.pivot, [-2, -3]);
  assert.deepEqual(layered.spec.parts[0].mesh.uv, [[-2, -3]]);
  const layeredAgain = await prepareArtwork(layered.spec, {
    ...f,
    stagingDir: path.join(f.root, 'layeragain')
  });
  assert.deepEqual(layeredAgain.spec.parts[0].mesh, layered.spec.parts[0].mesh);
  assert.deepEqual(layeredAgain.spec.parts[0].image.pivot, layered.spec.parts[0].image.pivot);
});
test('part selection rejects unknown IDs and junction source escapes', async t => {
  const f = await fixture();
  const joined = path.join(f.root, 'linked');
  try {
    await fs.symlink(os.tmpdir(), joined, 'junction');
  } catch (e) {
    if (e.code === 'EPERM') {
      t.skip('Windows does not grant junction creation');
      return;
    }
    throw e;
  }
  await assert.rejects(prepareArtwork({
    ...spec,
    parts: [{
      ...spec.parts[0],
      image: {
        path: 'linked/foreign.png'
      }
    }]
  }, f), {
    code: 'UNSAFE_PATH'
  });
  await assert.rejects(prepareArtwork(spec, {
    ...f,
    partIds: ['absent']
  }), {
    code: 'INVALID_INPUT'
  });
});
test('selected parts only are prepared and native worker cancellation fails clearly', async () => {
  const f = await fixture();
  f.config.tools = pythonTestTools();
  const {
    runTool
  } = require('../lib/process');
  await runTool(f.config.tools, 'python', ['-c', "from PIL import Image;import sys;im=Image.new('RGBA',(4,4));im.putpixel((1,1),(0,255,0,255));im.save(sys.argv[1])", path.join(f.root, 'part.png')]);
  const second = {
    ...spec.parts[0],
    id: 'other',
    image: {
      path: 'missing-unselected.png'
    }
  };
  const result = await prepareArtwork({
    ...spec,
    parts: [...spec.parts, second]
  }, {
    ...f,
    partIds: ['body']
  });
  assert.equal(result.parts.length, 1);
  assert.deepEqual(result.spec.parts[1], second);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareArtwork(spec, {
    ...f,
    stagingDir: path.join(f.root, 'abort'),
    signal: controller.signal
  }), {
    code: 'ABORTED'
  });
});
test('worker protocol failures and malformed registration cannot report success', async () => {
  for (const response of [{
    exitCode: 0,
    stdout: 'bad'
  }, {
    exitCode: 0,
    stdout: '{}'
  }, {
    exitCode: 0,
    stdout: JSON.stringify({
      ok: true,
      parts: []
    })
  }, {
    exitCode: 0,
    stdout: JSON.stringify({
      ok: true,
      parts: [{
        id: 'alien'
      }]
    })
  }, {
    exitCode: 1,
    stdout: JSON.stringify({
      ok: true
    })
  }, {
    exitCode: 0,
    stdout: '',
    error: {
      code: 'TIMEOUT'
    }
  }]) {
    const f = await fixture();
    await assert.rejects(prepareArtwork(spec, {
      ...f,
      runTool: async () => response
    }));
  }
  const f = await fixture();
  await assert.rejects(prepareArtwork(spec, {
    ...f,
    runTool: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        parts: [{
          id: 'body',
          image: {
            path: path.join(f.root, 'part.png')
          }
        }]
      })
    })
  }), {
    code: 'UNSAFE_PATH'
  });
  await assert.rejects(prepareArtwork({
    ...spec,
    parts: [{
      id: 'body'
    }]
  }, f), {
    code: 'ART_INPUT_MISSING'
  });
  await assert.rejects(prepareArtwork({
    ...spec,
    artwork: {
      provider: 'layered'
    }
  }, f), {
    code: 'ART_INPUT_MISSING'
  });
  await assert.rejects(prepareArtwork(spec, {
    ...f,
    config: {
      tools: f.config.tools
    }
  }), {
    code: 'UNSAFE_PATH'
  });
});
test('prepared boundary rejects out-of-range alpha bounds and incomplete crop registration', async () => {
  for (const override of [{
    alphaBounds: [0, 0, 9, 8]
  }, {
    alphaBounds: [1, 1, 0, 0]
  }, {
    alphaBounds: [0, 0, NaN, 8]
  }, {
    cropTranslation: undefined
  }, {
    cropTranslation: [0, 1]
  }]) {
    const f = await fixture();
    await assert.rejects(prepareArtwork(spec, {
      ...f,
      runTool: async (_registry, _name, args) => {
        const request = JSON.parse(await fs.readFile(args[1], 'utf8'));
        const output = path.join(request.outputDirectory, 'body.png');
        await fs.writeFile(output, 'processed');
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            parts: [{
              id: 'body',
              image: {
                path: output,
                prepared: true,
                width: 8,
                height: 8,
                alphaBounds: [0, 0, 8, 8],
                cropTranslation: [-2, -3],
                pivot: [2, 2],
                pixelsPerUnit: 1,
                ...override
              },
              transform: {
                scale: 1,
                translation: [-2, -3]
              }
            }]
          })
        };
      }
    }), {
      code: 'INVALID_WORKER_OUTPUT'
    });
  }
});
test('prepared artwork can be imported again without changing registration or reapplying its raw mask', async () => {
  const f = await fixture();
  f.config.tools = pythonTestTools();
  const {
    runTool
  } = require('../lib/process');
  await runTool(f.config.tools, 'python', ['-c', "from PIL import Image;import sys;from pathlib import Path;p=Path(sys.argv[1]);im=Image.new('RGBA',(10,10));im.paste((255,0,0,255),(2,3,8,9));im.save(p/'part.png');mask=Image.new('L',(10,10));mask.paste(255,(3,4,7,8));mask.save(p/'mask.png')", f.root]);
  const original = {
    ...spec,
    parts: [{
      ...spec.parts[0],
      mask: {
        path: 'mask.png'
      }
    }]
  };
  const first = await prepareArtwork(original, f);
  const again = await prepareArtwork(first.spec, {
    ...f,
    stagingDir: path.join(f.root, 'again')
  });
  assert.deepEqual(again.spec.parts[0].image.pivot, first.spec.parts[0].image.pivot);
  assert.deepEqual(again.spec.parts[0].mesh, first.spec.parts[0].mesh);
  assert.deepEqual(again.spec.parts[0].pivot, first.spec.parts[0].pivot);
  assert.equal(again.spec.parts[0].image.width, first.spec.parts[0].image.width);
  assert.equal(again.spec.parts[0].image.pixelsPerUnit, first.spec.parts[0].image.pixelsPerUnit);
});

test('required surfaces reach every supplied preparation and reject missing or forged receipts', async()=>{
 const f=await fixture();await fs.writeFile(path.join(f.root,'required.png'),'required');
 const input=structuredClone(spec);input.parts[0].requiredSurfaceMask={path:'required.png'};
 let requestSeen;
 const runTool=async(tools,name,args)=>{
 const request=JSON.parse(await fs.readFile(args[1],'utf8'));requestSeen=request;
 await fs.mkdir(request.outputDirectory,{recursive:true});const output=path.join(request.outputDirectory,'body.png');await fs.writeFile(output,'result');
 return {exitCode:0,stdout:JSON.stringify({ok:true,parts:[{id:'body',image:{path:output,prepared:true,width:8,height:8,pivot:[4,5],pixelsPerUnit:1,alphaBounds:[0,0,8,8],cropTranslation:[0,0]},transform:{scale:1,translation:[0,0]}}]})};
 };
 await assert.rejects(prepareArtwork(input,{...f,runTool}),{code:'INVALID_SURFACE_COVERAGE'});
 assert.equal(path.isAbsolute(requestSeen.parts[0].requiredSurfaceMask),true);
 assert.equal(await fs.readFile(requestSeen.parts[0].requiredSurfaceMask,'utf8'),'required');
});

test('real worker verifies reconstructed surfaces across supplied, layered and prepared images',async()=>{
 const f=await fixture();f.config.tools=pythonTestTools();const {runTool}=require('../lib/process');
 const script="from PIL import Image; import sys,zipfile,io; from pathlib import Path; p=Path(sys.argv[1]); im=Image.new('RGBA',(8,8),(0,255,0,255)); im.save(p/'part.png'); m=Image.new('L',(8,8),255); m.save(p/'required.png'); b=io.BytesIO(); im.save(b,format='PNG'); z=zipfile.ZipFile(p/'layers.ora','w'); z.writestr('mimetype','image/openraster'); z.writestr('stack.xml','<image w=\"8\" h=\"8\"><stack><layer name=\"body\" src=\"data/body.png\" x=\"0\" y=\"0\"/></stack></image>'); z.writestr('data/body.png',b.getvalue()); z.close()";
 const create=await runTool(f.config.tools,'python',['-c',script,f.root]);assert.equal(create.exitCode,0,create.stderr);
 const input=structuredClone(spec);input.parts[0].requiredSurfaceMask={path:'required.png'};
 const supplied=await prepareArtwork(input,f);assert.equal(supplied.parts[0].surfaceCoverage.requiredPixels,64);assert.equal(supplied.parts[0].surfaceCoverage.missingPixels,0);
 const prepared=await prepareArtwork(supplied.spec,{...f,stagingDir:path.join(f.root,'again')});assert.equal(prepared.parts[0].surfaceCoverage.status,'verified');
 const layered=await prepareArtwork({...input,artwork:{provider:'layered',source:'layers.ora'}},{...f,stagingDir:path.join(f.root,'layered')});assert.equal(layered.parts[0].surfaceCoverage.requiredPixels,64);
 const damage=await runTool(f.config.tools,'python',['-c',"from PIL import Image;import sys;im=Image.open(sys.argv[1]);im.putpixel((4,4),(0,0,0,0));im.save(sys.argv[1])",path.join(f.root,'part.png')]);assert.equal(damage.exitCode,0,damage.stderr);
 await assert.rejects(prepareArtwork(input,{...f,stagingDir:path.join(f.root,'missing')}),/Required surface uncovered/);
});

test('coverage rejects worker receipts without independent decoded source dimensions',async()=>{
 const f=await fixture();await fs.writeFile(path.join(f.root,'required.png'),'required');const input=structuredClone(spec);input.parts[0].requiredSurfaceMask={path:'required.png'};
 const hashFile=require('../lib/assets').hashFile;
 const runTool=async(tools,name,args)=>{
 const request=JSON.parse(await fs.readFile(args[1],'utf8'));await fs.mkdir(request.outputDirectory,{recursive:true});const output=path.join(request.outputDirectory,'body.png');await fs.writeFile(output,'result');const p=request.parts[0];
 return {exitCode:0,stdout:JSON.stringify({ok:true,parts:[{id:'body',image:{path:output,prepared:true,width:8,height:8,pivot:[4,5],pixelsPerUnit:1,alphaBounds:[0,0,8,8],cropTranslation:[0,0]},transform:{scale:1,translation:[0,0]},surfaceCoverage:{version:1,status:'verified',sourceSha256:await hashFile(p.input),maskSha256:await hashFile(p.requiredSurfaceMask),outputSha256:await hashFile(output),width:8,height:8,requiredPixels:1,missingPixels:0,alphaThreshold:1}}]})};
 };
 await assert.rejects(prepareArtwork(input,{...f,runTool}),{code:'INVALID_SURFACE_COVERAGE'});
});
