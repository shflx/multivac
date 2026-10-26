import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';
/** 终端用生产静态资源做本机同源测试，不依赖固定的 Vite 开发端口。运行前构建 web。 */
export default defineConfig({ ...base,
  testMatch: 'terminals*.spec.ts',
  use: { ...base.use, baseURL: `http://127.0.0.1:${process.env.MULTIVAC_E2E_API_PORT ?? '4317'}` },
  webServer: Array.isArray(base.webServer) ? [base.webServer[0]!] : base.webServer,
});
