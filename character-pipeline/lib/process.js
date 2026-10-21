'use strict';

const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validPath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

/**
 * Execute a tool from a trusted, application-owned registry (never from a spec).
 * Output budget is shared by stdout and stderr. Exceeding it kills the owned
 * child. Descendants are not enumerated or killed; tools must own their workers.
 * All operational and validation failures resolve to the same result shape.
 */
async function runTool(registry, name, args = [], options = {}) {
  const started = performance.now();
  const base = { exitCode: null, signal: null, stdout: '', stderr: '', durationMs: 0, error: null };
  const failure = (code, message) => ({ ...base, durationMs: performance.now() - started, error: { code, message } });
  if (!isObject(registry) || typeof name !== 'string' || !name.length) {
    return failure('INVALID_INPUT', 'Expected a tool registry and nonempty tool name.');
  }
  if (!Object.hasOwn(registry, name)) {
    return failure('TOOL_NOT_FOUND', `Tool is not registered: ${name}`);
  }
  let tool = registry[name];
  if (!isObject(tool) || !validPath(tool.executable) ||
      (tool.cwd !== undefined && !validPath(tool.cwd))) {
    return failure('INVALID_INPUT', 'Registered tool requires a valid executable and optional cwd.');
  }
  if (!Array.isArray(args) || Array.from(args).some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    return failure('INVALID_INPUT', 'Tool arguments must be an array of strings without NUL bytes.');
  }
  if (!isObject(options) || Object.keys(options).some(key => !['timeoutMs', 'maxOutputBytes', 'signal'].includes(key))) {
    return failure('INVALID_INPUT', 'Unsupported process options.');
  }
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, signal } = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 ||
      (signal !== undefined && !(signal instanceof AbortSignal))) {
    return failure('INVALID_INPUT', 'Timeout, output budget, or cancellation signal is invalid.');
  }
  if (signal?.aborted) return failure('ABORTED', 'Tool execution was cancelled before launch.');
  try { tool = await require('./native-launch').prepareNativeTool(tool); }
  catch (error) { return failure(error.code || 'NATIVE_LAUNCH_BLOCKED', error.message); }
  if (signal?.aborted) return failure('ABORTED', 'Tool execution was cancelled before launch.');

  return new Promise(resolve => {
    let child;
    let timer;
    let resultError = null;
    let capturedBytes = 0;
    const chunks = { stdout: [], stderr: [] };

    function stop(code, message) {
      // The first failure explains the termination, even if later events race.
      if (resultError) return;
      resultError = { code, message };
      child.kill('SIGKILL');
      // Close our handles even if a tool's descendant inherited them. This
      // prevents a descendant from keeping a cancelled call open indefinitely.
      child.stdout.destroy();
      child.stderr.destroy();
    }

    function abort() {
      stop('ABORTED', 'Tool execution was cancelled.');
    }

    function capture(stream, chunk) {
      const remaining = maxOutputBytes - capturedBytes;
      const retained = chunk.subarray(0, remaining);
      if (retained.length) {
        // Copy a partial chunk so it cannot retain a larger backing buffer.
        chunks[stream].push(Buffer.from(retained));
        capturedBytes += retained.length;
      }
      if (chunk.length > remaining) stop('OUTPUT_LIMIT', `Tool output exceeded ${maxOutputBytes} bytes.`);
    }

    function finish(exitCode, exitSignal) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (!resultError && (exitCode !== 0 || exitSignal)) {
        resultError = { code: 'NONZERO_EXIT', message: `Tool exited with ${exitSignal || exitCode}.` };
      }
      // Do not flush an incomplete UTF-8 suffix cut by the byte cap: replacement
      // characters could inflate the returned text beyond the configured limit.
      let textBudget = maxOutputBytes;
      const decode = stream => {
        const text = new StringDecoder('utf8').write(Buffer.concat(chunks[stream]));
        const bounded = new StringDecoder('utf8').write(Buffer.from(text).subarray(0, textBudget));
        textBudget -= Buffer.byteLength(bounded);
        return bounded;
      };
      resolve({ exitCode: resultError?.code === 'SPAWN_FAILED' ? null : exitCode, signal: exitSignal, stdout: decode('stdout'), stderr: decode('stderr'),
        durationMs: performance.now() - started, error: resultError });
    }

    try {
      child = spawn(tool.executable, args, { cwd: tool.cwd, env: require('./native-launch').nativeEnvironment(tool), shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve(failure('SPAWN_FAILED', error.message));
      return;
    }
    child.stdout.on('data', chunk => capture('stdout', chunk));
    child.stderr.on('data', chunk => capture('stderr', chunk));
    child.on('error', error => { resultError ??= { code: 'SPAWN_FAILED', message: error.message }; });
    child.once('close', finish);
    timer = setTimeout(() => stop('TIMEOUT', `Tool exceeded ${timeoutMs} ms.`), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

module.exports = { runTool };
