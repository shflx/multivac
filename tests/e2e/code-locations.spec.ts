import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

// 此组必须在允许启动浏览器及本机测试服务的环境执行。
test('正文/code/Markdown范围、键盘、历史、刷新与失效提示', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  const sessionId = crypto.randomUUID();
  const response = await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '代码范围验收' } });
  const root = (await response.json()).workingDirectory.path as string;
  writeFileSync(join(root, 'path.ts'), Array.from({ length: 260 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n'));
  writeFileSync(join(root, 'other.ts'), 'export const other = 1;\n'.repeat(20));
  writeFileSync(join(root, 'guide.md'), '# 阅读说明\n\n第一段\n第二行\n\n## 阅读现场\n\n章节内容');
  await page.goto('/'); await openPanel(page, 'workspace');
  const panel = page.locator(`.conversation-panel[data-session-id="${sessionId}"]`);
  const text = 'path.ts:24–27 和 `:205–218`。\n\n`other.ts:8-10` 和 [范围](path.ts#L50-L52)。\n\n[章节](guide.md#阅读现场) [源码行](guide.md:3–4)。\n\npath.ts:258–270。\n\n:7–9 无前置文件，path.ts:0 非法。';
  await request.post(`${fakeApiRoot}/api/__e2e/assistant/events/body`, { data: { sessionId, messageId: 'ranges', delta: text, completed: false } });
  await expect(panel.locator('.file-reference-link')).toHaveCount(0);
  await request.post(`${fakeApiRoot}/api/__e2e/assistant/events/body`, { data: { sessionId, messageId: 'ranges', delta: text, completed: true } });
  await panel.getByLabel('Multivac 草稿').fill('保留草稿');
  const target = (path: string, range: string) => panel.getByTitle(`${root}/${path}:${range}`, { exact: true });
  await target('path.ts', '24–27').focus(); await page.keyboard.press('Enter');
  const browser = panel.getByRole('region', { name: '工作目录文件浏览' });
  const highlights = () => browser.locator('.location-line').evaluateAll(elements => elements.map(e => Number((e as HTMLElement).dataset.line)));
  await expect.poll(highlights).toEqual([24, 25, 26, 27]);
  await target('path.ts', '205–218').click();
  await expect.poll(highlights).toEqual(Array.from({ length: 14 }, (_, i) => 205 + i));
  await expect.poll(() => browser.getByRole('article').evaluate(e => e.scrollTop)).toBeGreaterThan(2000);
  await target('other.ts', '8–10').click();
  await expect.poll(highlights).toEqual([8, 9, 10]);
  await browser.getByRole('button', { name: '返回上一处阅读' }).click();
  await expect.poll(highlights).toEqual(Array.from({ length: 14 }, (_, i) => 205 + i));
  await page.reload(); await openPanel(page, 'workspace');
  await expect.poll(highlights).toEqual(Array.from({ length: 14 }, (_, i) => 205 + i));
  await target('path.ts', '50–52').click();
  await expect.poll(highlights).toEqual([50, 51, 52]);
  await target('path.ts', '258–270').click();
  await expect(panel.getByRole('alert')).toContainText('实际共 260 行');
  await expect.poll(highlights).toEqual([50, 51, 52]);
  await panel.getByTitle(`${root}/guide.md#阅读现场`, { exact: true }).click();
  await expect(browser.getByRole('heading', { name: '阅读现场', exact: true })).toBeVisible();
  await target('guide.md', '3–4').click();
  await expect.poll(highlights).toEqual([3, 4]);
  await expect(panel.getByLabel('Multivac 草稿')).toHaveValue('保留草稿');
  await expect(panel.locator('.file-reference-link').filter({ hasText: ':7–9' })).toHaveCount(0);
  const snapshot = await (await request.get(`${fakeApiRoot}/api/sessions/${sessionId}/session`)).json();
  const frozen = snapshot.messages.find((message: { text: string }) => message.text === text).fileReferences;
  expect(frozen[0]).toMatchObject({ root, path: 'path.ts', line: 24, endLine: 27 });
  await page.screenshot({ path: testInfo.outputPath('code-range.png') });
  unlinkSync(join(root, 'other.ts'));
  await target('other.ts', '8–10').click();
  await expect(panel.getByRole('alert')).toContainText('不存在');
});

test('快速连续引用最后选择生效，同文件与跨文件迟到响应不能覆盖目标', async ({ page, request }) => {
  await resetE2eState(request);
  const sessionId = crypto.randomUUID();
  const response = await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '代码范围竞争' } });
  const root = (await response.json()).workingDirectory.path as string;
  for (const path of ['a.ts', 'b.ts']) writeFileSync(join(root, path), 'export const value = 1;\n'.repeat(100));
  await page.goto('/'); await openPanel(page, 'workspace');
  const panel = page.locator(`.conversation-panel[data-session-id="${sessionId}"]`);
  await request.post(`${fakeApiRoot}/api/__e2e/assistant/events/body`, { data: { sessionId, messageId: 'race', delta: 'a.ts:5–8 和 a.ts:70–75\n\nb.ts:20–25', completed: true } });
  const browser = panel.getByRole('region', { name: '工作目录文件浏览' });
  for (const [path, line, endLine] of [['a.ts', 70, 75], ['b.ts', 20, 25]] as const) {
    let release!: () => void;
    let entered!: () => void;
    let finished!: () => void;
    const completed = new Promise<void>(resolve => { finished = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let intercepted = false;
    await page.route('**/files/content?*', async route => {
      if (intercepted || new URL(route.request().url()).searchParams.get('path') !== 'a.ts') { await route.continue(); return; }
      intercepted = true;
      const response = await route.fetch(); entered(); await gate;
      try { await route.fulfill({ response }); } catch { /* 旧请求已取消时允许交付失败。 */ } finally { finished(); }
    });
    await panel.getByTitle(`${root}/a.ts:5–8`, { exact: true }).click();
    await started;
    await panel.getByTitle(`${root}/${path}:${line}–${endLine}`, { exact: true }).click();
    release(); await completed;
    await expect(browser.getByRole('article')).toHaveAttribute('aria-label', `预览 ${path}`);
    await expect.poll(() => browser.locator('.location-line').evaluateAll(elements => elements.map(e => Number((e as HTMLElement).dataset.line)))).toEqual(Array.from({ length: endLine - line + 1 }, (_, i) => line + i));
    await page.unroute('**/files/content?*');
  }
});

test('路径文字选区保持原文且不触发打开，仍可引用', async ({ page, request }) => {
  await resetE2eState(request);
  const sessionId = crypto.randomUUID();
  await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '路径选区验收' } });
  await page.goto('/'); await openPanel(page, 'workspace');
  const panel = page.locator(`.conversation-panel[data-session-id="${sessionId}"]`);
  await request.post(`${fakeApiRoot}/api/__e2e/assistant/events/body`, { data: { sessionId, messageId: 'selection', delta: '引用 path.ts:24–27 保留原文。', completed: true } });
  const body = panel.locator('.markdown-body[data-quote-entry-id]').filter({ hasText: '引用 path.ts:24–27' });
  await body.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('引用 path.ts:24–27 保留原文。');
  await expect(page.getByRole('toolbar', { name: '选中内容操作' })).toBeVisible();
  await body.locator('.file-reference-link').dispatchEvent('click', { detail: 1 });
  await expect(panel.getByRole('region', { name: '工作目录文件浏览' })).toHaveCount(0);
});
