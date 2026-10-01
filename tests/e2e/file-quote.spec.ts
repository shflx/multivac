import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

async function selectText(host: Locator, text: string) {
  await host.evaluate((element, needle) => {
    const document = element.ownerDocument;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent?.indexOf(needle) ?? -1;
      if (index < 0) continue;
      const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + needle.length);
      const selected = document.getSelection()!; selected.removeAllRanges(); selected.addRange(range); return;
    }
    throw new Error('未找到选区原文');
  }, text);
}

test('四类原文选区先进入草稿，明确发送后准确恢复文件来源与快照', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  const sessionId = crypto.randomUUID();
  const created = await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '原文选区验收' } });
  const root = (await created.json()).workingDirectory.path as string;
  const files = { 'readme.md': '# Markdown\n\nMarkdown 引用片段\n\n未选全文', 'source.ts': 'const text = "TypeScript 引用片段";\nconst other = "未选全文";', 'notes.txt': '    纯文本 引用片段\n未选全文', 'page.html': '<h1>原文章节</h1><p>HTML 引用片段</p><p>未选全文</p>' };
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  await page.goto('/'); await openPanel(page, 'workspace');
  const panel = page.locator(`.conversation-panel[data-session-id="${sessionId}"]`);
  await panel.getByRole('button', { name: '查看文件', exact: true }).click();
  const browser = panel.getByRole('region', { name: '工作目录文件浏览' });
  const sent: string[] = [];
  page.on('request', (call) => { if (call.method() === 'POST' && call.url().includes(`/sessions/${sessionId}/turns`)) sent.push(call.postData()!); });
  for (const [index, path] of Object.keys(files).entries()) {
    const text = ['Markdown 引用片段', 'TypeScript 引用片段', '    纯文本 引用片段', 'HTML 引用片段'][index]!;
    await browser.getByRole('button', { name: path, exact: true }).click();
    const host = path.endsWith('html') ? page.frameLocator('iframe.discussion-html').locator('body') : browser.getByRole('article');
    await expect(host).toContainText(text);
    await selectText(host, text);
    const toolbar = page.getByRole('toolbar', { name: '原文选中内容操作' });
    await expect(toolbar).toBeVisible();
    await expect.poll(() => toolbar.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
    const box = (await toolbar.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(1440);
    await page.screenshot({ path: testInfo.outputPath(`${path}-selection.png`) });
    await toolbar.getByRole('button', { name: '引用', exact: true }).click();
    await expect(panel.locator('.composer-quote p')).toHaveText(text);
    await expect(panel.locator('.composer-quote')).toContainText(path);
    expect(sent).toHaveLength(index);
    await panel.getByLabel('Multivac 草稿').fill(`讨论${path}`);
    await panel.getByLabel('发送消息').click();
    await expect(panel.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
    const snapshot = await (await request.get(`${fakeApiRoot}/api/sessions/${sessionId}/session`)).json();
    const message = snapshot.messages.find((item: { text: string }) => item.text === `讨论${path}`);
    expect(message.quote.sourceKind).toBe('file'); expect(message.quote.sourceFile.path).toBe(path); expect(message.quote.sourceFile.root).toBe(root); expect(message.quote.text).toBe(text); expect(message.quote.sourcePiEntryId).toBeUndefined();
    expect(sent[index]).not.toContain('未选全文');
  }
  await page.reload(); await openPanel(page, 'workspace');
  await expect(panel.locator('.message-quote')).toHaveCount(4);
  await expect(panel.locator('.message-quote').last()).toContainText('page.html');
});

test('文件选区深入、交给 Multivac 和超限提示保留原会话现场', async ({ page, request }) => {
  await resetE2eState(request);
  const sessionId = crypto.randomUUID();
  const created = await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '文件深入来源' } });
  const root = (await created.json()).workingDirectory.path as string;
  writeFileSync(join(root, 'notes.txt'), '文件深入片段\n' + '超限文本'.repeat(1500));
  await page.goto('/'); await openPanel(page, 'workspace');
  const panel = page.locator(`.conversation-panel[data-session-id="${sessionId}"]`);
  await panel.getByLabel('Multivac 草稿').fill('父会话保留草稿');
  await panel.getByRole('button', { name: '查看文件', exact: true }).click();
  const browser = panel.getByRole('region', { name: '工作目录文件浏览' });
  await browser.getByRole('button', { name: 'notes.txt', exact: true }).click();
  await selectText(browser.getByRole('article'), '文件深入片段');
  await page.getByRole('toolbar', { name: '原文选中内容操作' }).getByRole('button', { name: '深入一层' }).click();
  const child = page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: '文件深入片段', exact: true }) });
  await expect(child.locator('.composer-quote')).toContainText('notes.txt');
  await child.getByLabel('Multivac 草稿').fill('深入讨论文件'); await child.getByLabel('发送消息').click();
  await expect(child.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await child.getByRole('button', { name: '返回父会话' }).click();
  await expect(panel.getByLabel('Multivac 草稿')).toHaveValue('父会话保留草稿');
  await expect(browser.getByRole('article')).toContainText('文件深入片段');
  await selectText(browser.getByRole('article'), '文件深入片段');
  await page.getByRole('toolbar', { name: '原文选中内容操作' }).getByRole('button', { name: '交给 Multivac' }).click();
  const sidebar = page.locator('.multivac-sidebar');
  await expect(sidebar.locator('.composer-quote')).toContainText('notes.txt');
  await sidebar.getByLabel('Multivac 草稿').fill('处理这段文件');
  const sending = page.waitForRequest((call) => call.method() === 'POST' && call.url().includes('/api/assistant/turns'));
  await sidebar.getByLabel('发送消息').click();
  expect((await sending).postDataJSON().view.workspace.reading.path).toBe('notes.txt');
  await expect(sidebar.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  const snapshot = await (await request.get(`${fakeApiRoot}/api/assistant/session`)).json();
  expect(snapshot.messages.find((item: { text: string }) => item.text === '处理这段文件').quote.sourceFile.path).toBe('notes.txt');
  await page.keyboard.press('ControlOrMeta+J');
  await selectText(browser.getByRole('article'), '超限文本'.repeat(1500));
  await page.getByRole('toolbar', { name: '原文选中内容操作' }).getByRole('button', { name: '引用', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('4 KiB');
  await expect(panel.getByLabel('Multivac 草稿')).toHaveValue('父会话保留草稿');
  await selectText(browser.getByRole('article'), '文件深入片段');
  await page.getByRole('toolbar', { name: '原文选中内容操作' }).getByRole('button', { name: '引用', exact: true }).click();
  await expect(panel.locator('.composer-quote p')).toHaveText('文件深入片段');
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('伪造根目录、越界路径和超限文件引用在受理命令前拒绝', async ({ request }) => {
  await resetE2eState(request);
  const sessionId = crypto.randomUUID();
  const created = await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '文件边界校验' } });
  const root = (await created.json()).workingDirectory.path as string;
  writeFileSync(join(root, 'notes.txt'), '真实文件');
  for (const quote of [
    { sourceKind: 'file', sourceSessionId: sessionId, sourceFile: { root: '/outside', path: 'notes.txt' }, text: '片段' },
    { sourceKind: 'file', sourceSessionId: sessionId, sourceFile: { root, path: '../secret' }, text: '片段' },
    { sourceKind: 'file', sourceSessionId: sessionId, sourceFile: { root, path: 'notes.txt' }, text: '超限'.repeat(1000) },
  ]) {
    const commandId = crypto.randomUUID();
    const response = await request.post(`${fakeApiRoot}/api/sessions/${sessionId}/turns`, { data: { commandId, assistantSessionId: sessionId, text: '带引用发送', contextRefs: [], quote } });
    expect([400, 413]).toContain(response.status());
    expect((await response.json()).error.message).toMatch(/工作目录已变化|文件路径必须|4 KiB/);
    const receipt = await request.get(`${fakeApiRoot}/api/sessions/${sessionId}/commands/${commandId}`);
    expect((await receipt.json()).receipt).toBeNull();
  }
});
