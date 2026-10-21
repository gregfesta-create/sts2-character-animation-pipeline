'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { evaluateCoverage, listProductionFiles, runCoverage } = require('../tools/coverage.js');

const thresholds = { statements: 80, branches: 80, functions: 80, lines: 80 };
const row = (covered = 8, total = 10) => Object.fromEntries(Object.keys(thresholds).map(key => [key, { covered, total, pct: 100 }]));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-coverage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, content = 'module.exports = 1;') => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };
  return { root, put };
}

test('computes independent dimensions from source rows, never trusting pct or grand total', () => {
  const file = path.resolve('module.js');
  const result = evaluateCoverage({ files: [file], summary: { [file]: row(), total: row(1000, 1000), '/test.js': row(1000, 1000) }, thresholds });
  assert.equal(result.status, 'PASS');
  assert.equal(result.metrics.statements.percent, 80);
  assert.equal(result.metrics.lines.total, 10);
});

test('independently fails each configured dimension including statements', () => {
  const file = path.resolve('module.js');
  for (const metric of Object.keys(thresholds)) {
    const coverage = row();
    coverage[metric].covered = 7;
    const result = evaluateCoverage({ files: [file], summary: { [file]: coverage }, thresholds });
    assert.equal(result.status, 'FAIL');
    assert.ok(result.errors.some(error => error.includes(metric)));
  }
});

test('counts zero hit modules and rejects missing modules even with passing grand total', () => {
  const a = path.resolve('a.js'), b = path.resolve('b.js');
  const zero = evaluateCoverage({ files: [a, b], summary: { [a]: row(10), [b]: row(0) }, thresholds });
  assert.equal(zero.metrics.statements.percent, 50);
  assert.equal(zero.status, 'FAIL');
  const missing = evaluateCoverage({ files: [a, b], summary: { [a]: row(10), total: row(100, 100) }, thresholds });
  assert.equal(missing.status, 'FAIL');
  assert.deepEqual(missing.missingFiles, [b]);
});

test('missing independent statement measurements are UNVERIFIED', () => {
  const file = path.resolve('module.js'), coverage = row();
  delete coverage.statements;
  const result = evaluateCoverage({ files: [file], summary: { [file]: coverage }, thresholds });
  assert.equal(result.status, 'UNVERIFIED');
  assert.equal(result.metrics.statements, null);
});

test('fails closed on no production files, malformed thresholds and counters', () => {
  const file = path.resolve('module.js');
  assert.equal(evaluateCoverage({ files: [], summary: {}, thresholds }).status, 'FAIL');
  for (const invalid of [{ ...thresholds, lines: -1 }, { ...thresholds, statements: undefined }, { ...thresholds, branches: 101 }]) {
    assert.throws(() => evaluateCoverage({ files: [file], summary: { [file]: row() }, thresholds: invalid }), /threshold/);
  }
  for (const invalid of [-1, 11, NaN, 1.2, '8']) {
    const coverage = row(); coverage.lines.covered = invalid;
    assert.throws(() => evaluateCoverage({ files: [file], summary: { [file]: coverage }, thresholds }), /counter/);
  }
  const empty = evaluateCoverage({ files: [file], summary: { [file]: row(0, 0) }, thresholds });
  assert.equal(empty.metrics.functions.percent, 100);
});

test('includes tools and unimported nested production JS but excludes fixtures and generated evidence', t => {
  const { root, put } = fixture(t);
  const expected = ['cli.js', 'lib/unused.js', 'tools/coverage.js', 'library/helper.cjs', 'providers/test-data.mjs'].map(file => put(file));
  for (const file of ['test/fixtures/helper.js', 'node_modules/dependency/index.js', '.devtools/helper.js', 'evidence/result.js', 'assets/source/image.js', 'examples/example.js']) put(file);
  assert.deepEqual(listProductionFiles(root), expected.sort());
});

test('missing instrumentation writes explicit blocked evidence and cannot pass', t => {
  const { root, put } = fixture(t);
  put('cli.js');
  const thresholdFile = put('thresholds.json', JSON.stringify({ thresholds }));
  const out = path.join(root, 'evidence');
  const result = runCoverage({ root, thresholdFile, out, nyc: path.join(root, 'missing-nyc.js') });
  assert.equal(result.status, 'UNVERIFIED');
  assert.match(result.errors.join(' '), /nyc/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'gate.json'))).status, 'UNVERIFIED');
});

test('CLI rejects unknown arguments with nonzero diagnostic', () => {
  const child = spawnSync(process.execPath, [path.join(__dirname, '../tools/coverage.js'), '--unknown'], { encoding: 'utf8' });
  assert.equal(child.status, 2);
  assert.match(child.stderr, /Unknown/);
});

test('real Istanbul run instruments statements, includes unimported code, and reports failed tests', t => {
  const { root, put } = fixture(t);
  const nyc = process.env.PIPELINE_TEST_NYC || path.join(__dirname, '../.devtools/node_modules/nyc/bin/nyc.js');
  const thresholdFile = put('thresholds.json', JSON.stringify({ thresholds }));
  const source = put('math.js', 'module.exports = function answer() { return 42; };\n');
  put('test/math.test.js', "require('node:assert/strict').equal(require('../math.js')(), 42);\n");
  const options = { root, thresholdFile, nyc, out: path.join(root, 'evidence') };
  const passed = runCoverage(options);
  assert.equal(passed.status, 'PASS', JSON.stringify(passed));
  assert.equal(passed.metrics.statements.covered, 2);
  assert.equal(passed.metrics.lines.covered, 1);
  assert.deepEqual(passed.files, [source]);
  options.out = path.relative(process.cwd(), options.out);
  put('unused.js', 'module.exports = function unused() { return 100; };\n');
  const unimported = runCoverage(options);
  assert.equal(path.isAbsolute(unimported.runDir), true);
  assert.equal(unimported.status, 'FAIL');
  assert.equal(unimported.metrics.functions.percent, 50);
  assert.deepEqual(unimported.missingFiles, []);
  put('test/math.test.js', 'throw new Error("deliberate failure");\n');
  const failed = runCoverage(options);
  assert.equal(failed.status, 'FAIL');
  assert.equal(failed.exitCode, 1);
  assert.ok(failed.errors.some(error => error.includes('process failed')));
});

test('CLI produces machine readable failure when tool is unavailable', t => {
  const { root, put } = fixture(t);
  put('math.js');
  const thresholdFile = put('thresholds.json', JSON.stringify({ thresholds }));
  const child = spawnSync(process.execPath, [path.join(__dirname, '../tools/coverage.js'), '--root', root, '--thresholds', thresholdFile, '--nyc', path.join(root, 'missing.js'), '--out', path.join(root, 'evidence')], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).status, 'UNVERIFIED');
});
