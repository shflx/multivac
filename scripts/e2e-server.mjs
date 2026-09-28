import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 与服务端 E2E_RESTART_EXIT_CODE 一致：测试控制路由请求重启时服务以此退出。 */
const RESTART_EXIT_CODE = 75;

const dataDir = mkdtempSync(join(tmpdir(), 'multivac-dev-155-e2e-'));
// 工作文件根目录与内部数据目录分根，同样使用临时目录，不触碰真实的 ~/Multivac/。
const workRoot = mkdtempSync(join(tmpdir(), 'multivac-dev-155-e2e-work-'));
// 到期的临时目录移入的废纸篓同样是临时目录，不触碰真实的废纸篓。
const trashDir = mkdtempSync(join(tmpdir(), 'multivac-dev-155-e2e-trash-'));

let child;
let stopping = false;

function start() {
  child = spawn(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'apps/server/src/main.ts'],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        MULTIVAC_PORT: process.env.MULTIVAC_E2E_API_PORT ?? '4317',
        MULTIVAC_DATA_DIR: dataDir,
        MULTIVAC_WORK_ROOT: workRoot,
        MULTIVAC_TRASH_DIR: trashDir,
        MULTIVAC_FAKE_ASSISTANT: '1',
        MULTIVAC_E2E_CONTROL: '1',
        MULTIVAC_FAKE_PROMPT_DELAY_MS: '650',
      },
    },
  );

  child.on('exit', (code, signal) => {
    // 模拟服务重启：沿用同一数据目录、工作文件根目录与废纸篓重新启动，数据与上次进程一致。
    if (!stopping && code === RESTART_EXIT_CODE) {
      start();
      return;
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workRoot, { recursive: true, force: true });
    rmSync(trashDir, { recursive: true, force: true });
    if (!stopping && signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(signal));
}

start();
