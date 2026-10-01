import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

test('四种真实预览、查找循环与焦点；HTML 不执行或发起资源请求', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  const sessionId = crypto.randomUUID();
  const response = await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '原文预览验收' } });
  expect(response.ok()).toBeTruthy();
  const root = (await response.json()).workingDirectory.path as string;
  const files = {
    'readme.md': '# 真实原文\n\n## 文件预览\n\n查找**目标**，查找目标。\n\n| 文件 | 状态 |\n| --- | --- |\n| README | 可读 |',
    'source.ts': 'const target = "查找目标";\nexport const other = "查找目标";',
    'notes.txt': '第一行查找目标，边界\n验证，第二行查找目标',
    'page.html': '<meta http-equiv="refresh" content="0;url=/api/assistant/page-state"><style>@import url(https://blocked.example/style);</style><h1>真实 HTML 原文</h1><p>查找目标</p><p>查找目标</p><img src="https://blocked.example/image"><script>parent.__previewExecuted=true;fetch("/api/assistant/page-state")</script><a href="/api/assistant/page-state">危险导航</a><form action="/api/assistant/turns"><input name="message"></form>',
  };
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  writeFileSync(join(root, 'large.txt'), Buffer.alloc(512 * 1024 + 1, 'x'));
  const blocked: string[] = [];
  page.on('request', (request) => { if (request.url().includes('blocked.example')) blocked.push(request.url()); });
  await page.goto('/'); await openPanel(page, 'workspace');
  const panel = page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: '原文预览验收', exact: true }) });
  await panel.getByRole('button', { name: '查看文件', exact: true }).click();
  const browser = panel.getByRole('region', { name: '工作目录文件浏览' });
  for (const path of Object.keys(files)) {
    await browser.getByRole('button', { name: path, exact: true }).click();
    const preview = path.endsWith('.html') ? page.frameLocator('iframe.discussion-html').locator('body') : browser.getByRole('article');
    await expect(preview).toContainText('查找目标', { useInnerText: true });
    if (path === 'source.ts') await expect(preview.locator('.hljs-keyword')).toHaveCount(3);
    await browser.getByRole('button', { name: '查找原文', exact: true }).click();
    await browser.getByLabel('原文内查找').fill('查找目标');
    await expect(browser.locator('.content-find-bar')).toContainText('1/2');
    await browser.getByRole('button', { name: '查找下一个' }).click();
    await expect(browser.locator('.content-find-bar')).toContainText('2/2');
    await browser.getByRole('button', { name: '查找下一个' }).click();
    await expect(browser.locator('.content-find-bar')).toContainText('1/2');
    await browser.getByLabel('原文内查找').fill('不存在');
    await expect(browser.locator('.content-find-bar')).toContainText('0/0');
    if (path === 'notes.txt') {
      await browser.getByLabel('原文内查找').fill('边界验证');
      await expect(browser.locator('.content-find-bar')).toContainText('0/0');
    }
    await browser.getByLabel('原文内查找').press('Escape');
    await expect(browser.getByRole('button', { name: '查找原文', exact: true })).toBeFocused();
    await expect(browser).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${path}.png`) });
  }
  expect(blocked).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __previewExecuted?: boolean }).__previewExecuted)).toBeUndefined();
  await expect(page.frameLocator('iframe.discussion-html').locator('script,form,[href],[src]')).toHaveCount(0);
  await browser.getByRole('button', { name: 'large.txt', exact: true }).click();
  await expect(browser.getByRole('alert')).toContainText('512 KiB');
});

test('切换文件时旧内容响应不能覆盖新选择', async ({ page, request }) => {
  await resetE2eState(request);
  const response = await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId: crypto.randomUUID(), title: '内容竞争' } });
  const root = (await response.json()).workingDirectory.path as string;
  writeFileSync(join(root, 'old.txt'), '旧文件内容'); writeFileSync(join(root, 'new.txt'), '新文件内容');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/files/content?*', async (route) => { if (route.request().url().includes('old.txt')) await gate; await route.continue(); });
  await page.goto('/'); await openPanel(page, 'workspace');
  await page.getByRole('button', { name: '查看文件', exact: true }).click();
  const browser = page.getByRole('region', { name: '工作目录文件浏览' });
  await browser.getByRole('button', { name: 'old.txt', exact: true }).click();
  await browser.getByRole('button', { name: 'new.txt', exact: true }).click();
  release();
  await expect(browser.getByRole('article')).toContainText('新文件内容');
  await expect(browser).not.toContainText('旧文件内容');
});
