import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

test('真实历史文件链接刷新后保留来源，打开行号/章节并保存草稿与阅读历史', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  const sessionId = crypto.randomUUID();
  const created = await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '回复原文验收' } });
  const root = (await created.json()).workingDirectory.path as string;
  writeFileSync(join(root, 'source.ts'), Array.from({ length: 150 }, (_, line) => `export const line${line + 1} = ${line + 1};`).join('\n'));
  writeFileSync(join(root, 'readme.md'), '# 阅读说明\n\n' + '背景段落\n\n'.repeat(50) + '## 阅读现场\n\n章节原文');
  await page.goto('/'); await openPanel(page, 'workspace');
  const panel = page.locator(`.conversation-panel[data-session-id="${sessionId}"]`);
  await panel.getByLabel('Multivac 草稿').fill('阅读源码'); await panel.getByLabel('发送消息').click();
  await expect(panel.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await request.post(`${fakeApiRoot}/api/__e2e/assistant/events/body`, { data: { sessionId, messageId: 'file-reply', delta: '[实现代码](source.ts#L80) 和 [阅读现场](readme.md#阅读现场)。普通文字 source.ts 不产生来源。', completed: false } });
  await expect(panel.getByRole('button', { name: '打开原文 source.ts' })).toHaveCount(0);
  await request.post(`${fakeApiRoot}/api/__e2e/assistant/events/body`, { data: { sessionId, messageId: 'file-reply', delta: '[实现代码](source.ts#L80) 和 [阅读现场](readme.md#阅读现场)。普通文字 source.ts 不产生来源。', completed: true } });
  await expect(panel.getByRole('button', { name: '打开原文 source.ts' })).toBeVisible();
  await panel.getByLabel('Multivac 草稿').fill('未发送草稿');
  await panel.getByRole('button', { name: '打开原文 source.ts' }).click();
  const browser = panel.getByRole('region', { name: '工作目录文件浏览' });
  await expect(browser.getByRole('article')).toContainText('line80');
  await expect.poll(() => browser.getByRole('article').evaluate((element) => element.scrollTop)).toBeGreaterThan(1000);
  await expect(panel.getByLabel('Multivac 草稿')).toHaveValue('未发送草稿');
  await panel.getByRole('button', { name: '打开原文 readme.md' }).click();
  await expect(browser.getByRole('heading', { name: '阅读现场', exact: true })).toBeVisible();
  await browser.getByRole('button', { name: '返回上一处阅读' }).click();
  await expect(browser.getByRole('article')).toContainText('line80');
  await page.reload(); await openPanel(page, 'workspace');
  await expect(panel.getByRole('button', { name: '打开原文 source.ts' })).toBeVisible();
  const pageResponse = await request.get(`${fakeApiRoot}/api/sessions/${sessionId}/session`);
  expect(pageResponse.ok()).toBeTruthy();
  const snapshot = await pageResponse.json();
  const source = snapshot.messages.find((message: { fileReferences?: unknown[] }) => message.fileReferences?.length);
  expect(source.fileReferences[0].root).toBe(root);
  await page.screenshot({ path: testInfo.outputPath('reference.png') });
  unlinkSync(join(root, 'source.ts'));
  await panel.getByRole('button', { name: '打开原文 source.ts' }).click();
  await expect(panel.getByRole('alert')).toContainText('不存在');
  await expect(panel.getByLabel('Multivac 草稿')).toHaveValue('未发送草稿');
});

test('回复原文校验延迟时，切换文件或离开工作区会取消旧打开请求', async ({ page, request }) => {
  await resetE2eState(request);
  const sessionId = crypto.randomUUID();
  const created = await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '原文打开竞争' } });
  const root = (await created.json()).workingDirectory.path as string;
  for (const [path, text] of [['current.txt', '当前文件内容'], ['next.txt', '新选择文件内容'], ['old.txt', '过期文件内容']]) writeFileSync(join(root, path!), text!);
  await page.goto('/'); await openPanel(page, 'workspace');
  const panel = page.locator(`.conversation-panel[data-session-id="${sessionId}"]`);
  await expect(panel.getByLabel('Multivac 草稿')).toBeEditable();
  await request.post(`${fakeApiRoot}/api/__e2e/assistant/events/body`, { data: { sessionId, messageId: 'open-race', delta: '[旧原文](old.txt)', completed: true } });
  await expect(panel.getByRole('button', { name: '打开原文 old.txt' })).toBeVisible();
  await panel.getByRole('button', { name: '查看文件', exact: true }).click();
  const browser = panel.getByRole('region', { name: '工作目录文件浏览' });
  for (const action of ['file', 'hide']) {
    await browser.getByRole('button', { name: 'current.txt', exact: true }).click();
    await expect(browser.getByRole('article')).toContainText('当前文件内容');
    let release!: () => void;
    let entered!: () => void;
    let finished!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const completed = new Promise<void>((resolve) => { finished = resolve; });
    await page.route('**/files/content?*', async (route) => {
      if (new URL(route.request().url()).searchParams.get('path') !== 'old.txt') { await route.continue(); return; }
      const response = await route.fetch(); entered(); await gate;
      try { await route.fulfill({ response }); } finally { finished(); }
    });
    await panel.getByRole('button', { name: '打开原文 old.txt' }).click();
    await started;
    if (action === 'file') {
      await browser.getByRole('button', { name: 'next.txt', exact: true }).click();
      await expect(browser.getByRole('article')).toContainText('新选择文件内容');
    } else await openPanel(page, 'home');
    release(); await completed;
    if (action === 'hide') { await expect(page.locator('.workspace-page')).toBeHidden(); await openPanel(page, 'workspace'); }
    await expect(browser.getByRole('article')).toContainText(action === 'file' ? '新选择文件内容' : '当前文件内容');
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await page.unroute('**/files/content?*');
  }
});
