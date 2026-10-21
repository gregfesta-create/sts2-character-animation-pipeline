'use strict';

const mode = process.argv[2];
if (mode === 'echo') {
  process.stdout.write(JSON.stringify({ args: process.argv.slice(3), cwd: process.cwd() }));
  process.stderr.write('diagnostic');
} else if (mode === 'fail') {
  process.stderr.write('intentional failure');
  process.exitCode = 7;
} else if (mode === 'hang') {
  process.stdout.write(String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'flood') {
  process.stdout.write('x'.repeat(100000));
  process.stderr.write('y'.repeat(100000));
  setInterval(() => {}, 1000);
} else if (mode === 'unicode') {
  process.stdout.write('😀'.repeat(100));
} else if (mode === 'stderr-flood') {
  process.stderr.write('z'.repeat(100000));
} else if (mode === 'binary') {
  process.stdout.write(Buffer.alloc(100, 255));
  process.stderr.write(Buffer.alloc(100, 255));
} else if (mode === 'exact') {
  process.stdout.write('12345');
} else if (mode === 'signal') {
  process.kill(process.pid, 'SIGKILL');
}
