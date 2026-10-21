'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pythonTestTools } = require('./support/python-tool');

test('real-worker Python registry honors the explicit executable without parsing arguments', () => {
  assert.deepEqual(pythonTestTools({ PIPELINE_TEST_PYTHON: 'C:/Python with spaces/python.exe', PYTHON: 'ignored' }), {
    python: { executable: 'C:/Python with spaces/python.exe' }
  });
});

test('real-worker Python registry defaults to python on PATH without private configuration', () => {
  assert.deepEqual(pythonTestTools({}), { python: { executable: 'python' } });
  assert.deepEqual(pythonTestTools({ PIPELINE_TEST_PYTHON: '' }), { python: { executable: 'python' } });
  const artworkTests = fs.readFileSync(path.join(__dirname, 'artwork.test.js'), 'utf8');
  assert.equal(artworkTests.includes('local.tools.json'), false);
});
