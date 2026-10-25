import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

/** 工具栏回归单独覆盖双浏览器，不扩大默认 E2E 的执行范围。 */
export default defineConfig(base, {
  testMatch: 'composer-toolbar-layout.spec.ts',
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
