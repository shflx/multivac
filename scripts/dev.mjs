import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { waitForServerReady } from './dev-readiness.mjs';

const children = [];

let stopping = false;

function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(signal));
}

function track(child) {
  children.push(child);
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
    stop();
  });
  child.on('exit', (code, signal) => {
    if (!stopping) stop();
    if (signal) process.kill(process.pid, signal);
    process.exitCode = code ?? 1;
  });
  return child;
}

const server = track(fork(fileURLToPath(new URL('../apps/server/src/main.ts', import.meta.url)), [], {
  cwd: fileURLToPath(new URL('../apps/server', import.meta.url)),
  execArgv: ['--import', 'tsx'],
  stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
}));

try {
  await waitForServerReady(server);
  if (!stopping) track(spawn('npm', ['run', 'dev', '-w', '@multivac/web'], { stdio: 'inherit' }));
} catch (error) {
  if (!stopping) {
    console.error(error.message);
    process.exitCode = 1;
    stop();
  }
}
