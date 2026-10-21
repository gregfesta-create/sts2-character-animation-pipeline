'use strict';

// Development-only gate. Istanbul instruments statements; Node's line counters
// are never used as a substitute for independent statement coverage.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const METRICS = ['statements', 'branches', 'functions', 'lines'];
const EXCLUDED = ['test', 'node_modules', '.devtools', 'evidence', 'assets', 'examples', 'jobs', 'output'];

function listProductionFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || EXCLUDED.includes(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Coverage refuses symbolic link: ${target}`);
      if (entry.isDirectory()) visit(target);
      else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) files.push(path.resolve(target));
    }
  }
  visit(root);
  return files.sort();
}

function evaluateCoverage({ files, summary, thresholds }) {
  for (const metric of METRICS) {
    if (!Number.isFinite(thresholds[metric]) || thresholds[metric] < 0 || thresholds[metric] > 100) throw new Error(`Invalid ${metric} coverage threshold`);
  }
  const entries = new Map(Object.entries(summary).filter(([key]) => key !== 'total').map(([key, value]) => [path.resolve(key), value]));
  const missingFiles = files.filter(file => !entries.has(path.resolve(file)));
  const errors = missingFiles.map(file => `Missing production module: ${file}`);
  if (!files.length) errors.push('No production modules found');
  const metrics = {};
  let unverified = false;
  for (const metric of METRICS) {
    let total = 0, covered = 0, missing = false;
    for (const file of files) {
      const entry = entries.get(path.resolve(file));
      if (!entry) continue;
      const counter = entry[metric];
      if (!counter) { missing = true; continue; }
      if (!Number.isSafeInteger(counter.total) || !Number.isSafeInteger(counter.covered) || counter.total < 0 || counter.covered < 0 || counter.covered > counter.total) throw new Error(`Invalid ${metric} coverage counter for ${file}`);
      total += counter.total;
      covered += counter.covered;
    }
    if (missing) {
      metrics[metric] = null;
      unverified = true;
      errors.push(`Independent ${metric} coverage is unavailable`);
    } else {
      const percent = total === 0 ? 100 : covered / total * 100;
      metrics[metric] = { total, covered, percent, threshold: thresholds[metric] };
      if (percent < thresholds[metric]) errors.push(`${metric} coverage ${percent.toFixed(2)}% is below ${thresholds[metric]}%`);
    }
  }
  return { status: unverified ? 'UNVERIFIED' : errors.length ? 'FAIL' : 'PASS', metrics, missingFiles, files, errors };
}

function runCoverage({ root = path.resolve(__dirname, '..'), thresholdFile = path.resolve(root, '..', '.coverage-thresholds.json'), nyc = path.join(root, '.devtools/node_modules/nyc/bin/nyc.js'), out = path.join(root, 'evidence/coverage') } = {}) {
  root = path.resolve(root);
  out = path.resolve(out);
  nyc = path.resolve(nyc);
  thresholdFile = path.resolve(thresholdFile);
  const thresholdsBytes = fs.readFileSync(thresholdFile);
  const thresholds = JSON.parse(thresholdsBytes).thresholds;
  const files = listProductionFiles(root);
  // Validate the policy before launching any child process.
  evaluateCoverage({ files, summary: {}, thresholds });
  fs.mkdirSync(out, { recursive: true });
  const runDir = path.join(out, `run-${Date.now()}-${crypto.randomUUID()}`);
  fs.mkdirSync(runDir);
  const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const base = { startedAt: new Date().toISOString(), cwd: root, nodeVersion: process.version, thresholdFile: path.resolve(thresholdFile), thresholdsSha256: sha256(thresholdsBytes), sourceSha256: Object.fromEntries(files.map(file => [file, sha256(fs.readFileSync(file))])), instrumenter: 'nyc (Istanbul statement instrumentation)', runDir };
  let result;
  if (!fs.existsSync(nyc)) {
    result = { ...base, status: 'UNVERIFIED', errors: [`Missing nyc instrumenter: ${nyc}`], files };
  } else {
    base.instrumenterSha256 = sha256(fs.readFileSync(nyc));
    const reportDir = path.join(runDir, 'report');
    const args = [path.resolve(nyc), '--cwd', root, '--all', '--extension', '.js', '--extension', '.cjs', '--extension', '.mjs', '--include', '**/*.{js,cjs,mjs}', ...EXCLUDED.flatMap(name => ['--exclude', `${name}/**`]), '--temp-dir', path.join(runDir, 'raw'), '--report-dir', reportDir, '--reporter', 'json-summary', '--reporter', 'json', '--reporter', 'text', process.execPath, '--test', 'test/**/*.test.js'];
    const cleanEnvironment = ({ env }) => {
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_OPTIONS;
      for (const key of Object.keys(env)) if (key.startsWith('NYC_') || key.startsWith('NODE_PRELOAD_')) delete env[key];
    };
    const env = { ...process.env };
    cleanEnvironment({ env });
    // nyc's dependency injects parent hooks after spawn's env option is read.
    // Its public listener API lets this nested gate get its own instrumenter.
    const spawnHooks = require(require.resolve('process-on-spawn', { paths: [path.dirname(path.resolve(nyc))] }));
    spawnHooks.addListener(cleanEnvironment);
    let child;
    try {
      child = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 900000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    } finally {
      spawnHooks.removeListener(cleanEnvironment);
    }
    fs.writeFileSync(path.join(runDir, 'stdout.txt'), child.stdout || '');
    fs.writeFileSync(path.join(runDir, 'stderr.txt'), child.stderr || '');
    result = { ...base, command: [process.execPath, ...args], exitCode: child.status, signal: child.signal, stdoutPath: path.join(runDir, 'stdout.txt'), stderrPath: path.join(runDir, 'stderr.txt') };
    const reportFile = path.join(reportDir, 'coverage-summary.json');
    if (fs.existsSync(reportFile)) {
      result = { ...result, ...evaluateCoverage({ files, summary: JSON.parse(fs.readFileSync(reportFile, 'utf8')), thresholds }), reportFile };
    } else {
      result = { ...result, status: 'UNVERIFIED', errors: ['Istanbul coverage report was not produced'], files };
    }
    if (child.status !== 0 || child.error) {
      result.status = 'FAIL';
      result.errors.push(`Test/instrumenter process failed: ${child.error ? child.error.message : child.status}`);
    }
  }
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(runDir, 'gate.json'), JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'gate.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

function main(args) {
  const options = {};
  const names = { '--root': 'root', '--thresholds': 'thresholdFile', '--nyc': 'nyc', '--out': 'out' };
  for (let i = 0; i < args.length; i += 2) {
    if (!names[args[i]] || !args[i + 1]) throw new Error(`Unknown or incomplete coverage argument: ${args[i]}`);
    options[names[args[i]]] = path.resolve(args[i + 1]);
  }
  const result = runCoverage(options);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.status === 'PASS' ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 2; }
}

module.exports = { evaluateCoverage, listProductionFiles, runCoverage };
