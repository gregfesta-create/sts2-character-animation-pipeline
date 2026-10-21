'use strict';

// Real worker tests require Python with Pillow. An explicit executable overrides
// PATH; missing dependencies fail normally instead of silently skipping tests.
function pythonTestTools(env = process.env) {
  return { python: { executable: env.PIPELINE_TEST_PYTHON || 'python' } };
}

module.exports = { pythonTestTools };
