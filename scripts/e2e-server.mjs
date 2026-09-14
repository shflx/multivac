import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'multivac-dev-155-e2e-'));
const child = spawn(
  process.execPath,
  ['node_modules/tsx/dist/cli.mjs', 'apps/server/src/main.ts'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      MULTIVAC_PORT: '4317',
      MULTIVAC_DATA_DIR: dataDir,
      MULTIVAC_FAKE_ASSISTANT: '1',
    },
  },
);

let stopping = false;
function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(signal));
}

child.on('exit', (code, signal) => {
  rmSync(dataDir, { recursive: true, force: true });
  if (!stopping && signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
