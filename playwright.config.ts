import { defineConfig } from '@playwright/test';

const apiPort = process.env.MULTIVAC_E2E_API_PORT ?? '4317';
const webPort = process.env.MULTIVAC_E2E_WEB_PORT ?? '5173';
const webUrl = process.env.MULTIVAC_E2E_WEB_URL ?? `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['line']],
  use: {
    baseURL: webUrl,
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node scripts/e2e-server.mjs',
      url: `http://127.0.0.1:${apiPort}/api/assistant/page-state`,
      reuseExistingServer: false,
      timeout: 30_000,
      // 默认会直接 SIGKILL 进程组；先发 SIGTERM，让服务脚本清理临时数据目录与工作文件根目录。
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
      command: `npm run dev -w @multivac/web -- --host 127.0.0.1 --port ${webPort}`,
      url: webUrl,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
