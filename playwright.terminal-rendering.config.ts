import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

/** 直接加载安装后的浏览器构建，验证字符布局；不启动 API、PTY 或开发服务器。 */
export default defineConfig({
  ...base,
  testMatch: 'terminal-rendering.spec.ts',
  webServer: [],
  projects: [
    { name: 'standard', use: { deviceScaleFactor: 1 } },
    { name: 'retina', use: { deviceScaleFactor: 2 } },
  ],
});
