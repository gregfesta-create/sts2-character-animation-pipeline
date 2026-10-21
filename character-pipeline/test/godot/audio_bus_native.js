'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { runTool } = require('../../lib/process');
async function main() {
  const index = process.argv.indexOf('--evidence');
  if (index >= 0 && !process.argv[index + 1]) throw new Error('--evidence requires a directory');
  const out = index >= 0 ? path.resolve(process.argv[index + 1]) : path.resolve(__dirname, '../../evidence/audio-bus-native');
  await fs.mkdir(out, { recursive: true });
  const config = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../config/local.tools.json'), 'utf8'));
  const tool = config.tools.megadot || config.tools.godot;
  const project = path.join(out, 'project');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'project.godot'), '[application]\nconfig/name="Audio bus routing probe"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
  await fs.copyFile(path.resolve(__dirname, '../../godot/audio_controller.gd'), path.join(project, 'audio_controller.gd'));
  await fs.copyFile(path.join(__dirname, 'audio_bus_probe.gd'), path.join(project, 'probe.gd'));
  await fs.rm(path.join(project, 'audio-bus-result.json'), { force: true });
  const run = await runTool({ native: { ...tool, cwd: path.dirname(tool.executable) } }, 'native', ['--headless', '--path', project, '--script', 'res://probe.gd', '--log-file', path.join(project, 'native.log')], { timeoutMs: 15000 });
  await fs.writeFile(path.join(out, 'process.json'), JSON.stringify(run, null, 2));
  const result = JSON.parse(await fs.readFile(path.join(project, 'audio-bus-result.json'), 'utf8'));
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  if (run.exitCode || run.error || /SCRIPT ERROR|ERROR:/.test(run.stdout + run.stderr) || !result.passed) throw new Error(JSON.stringify({ run, result }));
  console.log(JSON.stringify(result));
}
if (process.argv.includes('--run')) main().catch(error => { console.error(error); process.exitCode = 1; });
