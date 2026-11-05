import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

test('任务创建上传同名文本与图片，失败重试保留输入，详情分别展示输入、快照与独立成果', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建任务' });
  const title = `附件核对 ${Date.now()}`;
  await dialog.getByLabel('任务名称', { exact: true }).fill(title);
  await dialog.getByLabel('目标说明', { exact: true }).fill('读取文本与图片并生成独立报告。');
  let rejectFirst = true;
  const attempts: string[] = [];
  await page.route('**/api/task-attachment-drafts/**', async route => {
    if (route.request().method() === 'PUT') {
      attempts.push(route.request().url());
      if (rejectFirst) { rejectFirst = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '模拟上传失败，请重试' } }) }); return; }
    }
    await route.continue();
  });
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'green' } }).png().toBuffer();
  await dialog.getByLabel('添加任务附件').setInputFiles([
    { name: 'same.txt', mimeType: 'image/png', buffer: Buffer.from('文本核对码=7391') },
    { name: 'same.txt', mimeType: 'text/plain', buffer: Buffer.from('第二份同名材料') },
    { name: 'picture.png', mimeType: 'application/octet-stream', buffer: png },
  ]);
  await expect(dialog.getByText(/模拟上传失败/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: '创建任务', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '重试上传', exact: true }).click();
  await expect(dialog.locator('.task-attachment-row')).toHaveCount(3);
  await expect(dialog.getByRole('button', { name: '创建任务', exact: true })).toBeEnabled();
  expect(attempts.filter(value => value === attempts[0])).toHaveLength(2);
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const inspector = page.getByRole('complementary', { name: '任务详情' });
  const inputs = inspector.getByRole('region', { name: '输入附件', exact: true });
  await expect(inputs.locator('.task-attachment-row')).toHaveCount(3);
  await expect(inputs).toContainText('可读取图片（需模型支持）');
  await inputs.locator('.task-attachment-row').filter({ hasText: 'same.txt' }).first().getByRole('button', { name: '预览', exact: true }).click();
  await expect(inputs.locator('pre')).toHaveText(/7391|第二份同名材料/);
  await inputs.locator('.task-attachment-row').filter({ hasText: 'picture.png' }).getByRole('button', { name: '预览', exact: true }).click();
  await expect(inputs.getByRole('img', { name: 'picture.png' })).toBeVisible();
  const listed = await (await request.get(`${fakeApiRoot}/api/tasks?query=${encodeURIComponent(title)}`)).json();
  const task = listed.tasks[0];
  const before = await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json();
  expect(before.attachments).toHaveLength(3); expect(new Set(before.attachments.map((item: any) => item.id)).size).toBe(3);
  await inspector.getByRole('button', { name: `启动任务：${title}`, exact: true }).click();
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).runs[0]?.stopConfirmed).toBe(true);
  const stopped = await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json();
  expect(stopped.artifacts).toHaveLength(0); expect(stopped.runs[0].inputSnapshot.attachments).toHaveLength(3);
  const denied = await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/artifacts`, { data: { commandId: crypto.randomUUID(), revision: stopped.task.revision, runId: stopped.runs[0].runId, title: '原件不能交付', path: before.attachments[0].id } });
  expect(denied.status()).toBe(400);
  const saved = await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/artifacts`, { data: { commandId: crypto.randomUUID(), revision: stopped.task.revision, runId: stopped.runs[0].runId, title: '独立核对报告', text: '用户单独提交的报告：文本核对码为 7391。' } });
  expect(saved.ok()).toBeTruthy();
  await expect(inspector).toContainText('独立核对报告');
  await expect(inputs.locator('.task-attachment-row')).toHaveCount(3);
  await inspector.getByText('执行输入历史', { exact: true }).click();
  const history = inspector.getByRole('region', { name: '执行输入历史', exact: true });
  await history.locator('details details summary').first().click();
  await expect(history.getByRole('link', { name: '下载固定原件' })).toHaveCount(3);
  const href = await history.getByRole('link', { name: '下载固定原件' }).first().getAttribute('href');
  expect((await request.get(fakeApiRoot + href)).ok()).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('task-attachment-input-output.png'), fullPage: true });
});

test('任务详情及时同步其他窗口上传与移除，其他格式准确标为仅下载', async ({ page, request }) => {
  await resetE2eState(request);
  const created = await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: crypto.randomUUID(), title: '附件同步', goal: '读取输入' } });
  const { task } = await created.json();
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  await page.getByRole('button', { name: `查看任务：${task.title}`, exact: true }).click();
  const inputs = page.getByRole('region', { name: '输入附件', exact: true });
  // 可编辑时空列表只显示上传区，不再单列“暂无附件”。
  await expect(inputs.locator('.task-attachment-row')).toHaveCount(0);
  const id = crypto.randomUUID(), url = `${fakeApiRoot}/api/tasks/${task.taskId}/attachments/${id}`;
  expect((await request.put(`${url}?name=source.pdf`, { data: Buffer.from('%PDF-1.7\n') })).ok()).toBeTruthy();
  await expect(inputs).toContainText('仅保存与下载');
  expect((await request.delete(url)).ok()).toBeTruthy();
  await expect(inputs.locator('.task-attachment-row')).toHaveCount(0);
});

test('详情附件上传中与失败时阻止启动，重试或取消后按完整清单启动', async ({ page, request }, info) => {
  await resetE2eState(request);
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建任务' });
  const title = '上传完成后启动';
  await dialog.getByLabel('任务名称', { exact: true }).fill(title);
  await dialog.getByLabel('目标说明', { exact: true }).fill('以用户选择的完整附件为输入。');
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '任务详情' });
  const inputs = inspector.getByRole('region', { name: '输入附件', exact: true });
  const start = inspector.getByRole('button', { name: `启动任务：${title}`, exact: true });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let failFirst = true;
  await page.route(/\/api\/tasks\/[^/]+\/attachments\/[^/?]+\?name=/, async route => {
    if (route.request().url().includes('cancel.txt') || failFirst) {
      failFirst = false; await gate;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '上传暂不可用，请重试' } }) });
    } else await route.continue();
  });
  try {
    await inputs.getByLabel('添加任务附件').setInputFiles({ name: 'chosen.txt', mimeType: 'text/plain', buffer: Buffer.from('本轮需要读取的材料') });
    await expect(inputs).toContainText('上传中…'); await expect(start).toBeDisabled();
    await page.screenshot({ path: info.outputPath('upload-pending.png') });
    release();
    await expect(inputs).toContainText('上传暂不可用'); await expect(start).toBeDisabled();
    await page.screenshot({ path: info.outputPath('upload-error.png') });
    await inputs.getByRole('button', { name: '重试上传', exact: true }).click();
    await expect(inputs.locator('.task-attachment-row')).toHaveCount(1); await expect(start).toBeEnabled();
    await inputs.getByLabel('添加任务附件').setInputFiles({ name: 'cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('不再上传') });
    await expect(inputs).toContainText('上传暂不可用'); await expect(start).toBeDisabled();
    await inputs.getByRole('button', { name: '取消此上传', exact: true }).click();
    await expect(start).toBeEnabled(); await start.click();
    await inspector.getByText('执行输入历史', { exact: true }).click();
    await expect(inspector.getByRole('region', { name: '执行输入历史' })).toContainText('1 个附件');
    await page.screenshot({ path: info.outputPath('complete-input-started.png') });
  } finally { release(); }
});
