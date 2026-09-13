import { spawn } from 'node:child_process';

const children = [
  spawn('npm', ['run', 'dev', '-w', '@multivac/server'], { stdio: 'inherit' }),
  spawn('npm', ['run', 'dev', '-w', '@multivac/web'], { stdio: 'inherit' }),
];

let stopping = false;

function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(signal));
}

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (!stopping) stop();
    if (signal) process.kill(process.pid, signal);
    process.exitCode = code ?? 1;
  });
}
