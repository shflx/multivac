import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

/** 原页、二进制导入和既有格式分别覆盖三种浏览器；结果保留失败轨迹。 */
export default defineConfig({
  ...base,
  testMatch: ['reading-pdf-pages.spec.ts', 'reading-binary.spec.ts', 'reading.spec.ts', 'reading-notes-ui.spec.ts', 'reading-highlights-ui.spec.ts'],
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
