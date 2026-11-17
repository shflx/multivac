import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { AssistantCommandAnchor, AssistantMessageView, AssistantToolExecutionView } from '@multivac/contracts';
import sharp from 'sharp';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

const time = (second: number) => new Date(Date.UTC(2026, 10, 17, 0, 0, second)).toISOString();
const message = (id: string, role: 'user' | 'assistant', text: string, second: number, extra: Partial<AssistantMessageView> = {}): AssistantMessageView =>
  ({ id, runtimeSessionId: 'gallery-runtime', runtimeEntryId: id, role, text, createdAt: time(second), ...extra });
const imageMessage = (id: string, imageId: string, second: number, extra: Partial<AssistantMessageView> = {}) =>
  message(id, 'assistant', `Read image file [image/png] 模型专用提示 ${id}`, second, { toolName: 'read', imageIds: [imageId], ...extra });
const colors = [[230, 73, 128], [34, 139, 230]];

async function uploadImages(request: APIRequestContext, sessionId = 'global-coordinator') {
  const ids: string[] = [];
  for (const [r, g, b] of colors) {
    const png = await sharp({ create: { width: 120, height: 90, channels: 3, background: { r: r!, g: g!, b: b! } } }).png().toBuffer();
    const response = await request.post(`${fakeApiRoot}/api/sessions/${sessionId}/images`, { data: png, headers: { 'content-type': 'image/png' } });
    expect(response.ok()).toBe(true);
    const image = await response.json();
    expect((await request.get(`${fakeApiRoot}/api/sessions/${sessionId}/images/${image.id}/content`)).ok()).toBe(true);
    ids.push(image.id);
  }
  return ids;
}

/** 保留真实会话、图片资源和页面状态 API，只替换受测的历史投影，不改 DOM 或浏览器存储。 */
async function history(page: Page, messages: AssistantMessageView[], toolExecutions: AssistantToolExecutionView[] = [], commandAnchors: AssistantCommandAnchor[] = [], sessionId = 'global-coordinator') {
  const root = sessionId === 'global-coordinator' ? '/api/assistant' : `/api/sessions/${sessionId}`;
  await page.route(url => url.pathname === `${root}/session`, async route => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, messages, hasMore: false, nextBefore: null, streamingMessages: [], toolExecutions, commandAnchors, runTraces: [] } });
  });
}

/** 从浏览器实际绘制的图像截图取中心像素，加载占位或错误图片都不能通过。 */
async function expectPixels(picture: Locator, color: number[]) {
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth === 120)).toBe(true);
  const screenshot = await picture.screenshot();
  const { data, info } = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  expect([...data.subarray(offset, offset + 3)]).toEqual(color);
}

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
test.beforeEach(async ({ request }) => {
  await resetE2eState(request);
  const state = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json();
  expect((await request.put(`${fakeApiRoot}/api/assistant/page-state`, { data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: state.revision } })).ok()).toBe(true);
});

test('完整历史轮次：工具图片合组可见，折叠轨迹保留普通说明且不泄露模型提示', async ({ page, request }, info) => {
  const ids = await uploadImages(request);
  const tools: AssistantToolExecutionView[] = [1, 2].map(n => ({
    toolCallId: `read-${n}`, toolName: 'read', displayName: '读取文件', commandId: 'completed-read', cursor: String(n),
    status: 'succeeded', summary: '读取完成', detail: `读取 image-${n}.png`, isError: false,
    startedAt: time(n), endedAt: time(n + 1), authorization: null,
  }));
  await history(page, [message('user', 'user', '查看两张图片', 0), message('note', 'assistant', '先逐张检查文件。', 1),
    imageMessage('image-a', ids[0]!, 2), imageMessage('image-b', ids[1]!, 3),
    message('reply', 'assistant', '两张图片已检查。', 4, { runtimeMessageId: 'assistant:4' })], tools,
  [{ commandId: 'completed-read', runtimeEntryId: 'reply' }]);
  await page.goto('/');
  const group = page.locator('.chat-row').filter({ hasText: '工具读取了 2 张图片' });
  await expect(group.locator('.message-image')).toHaveCount(2);
  await expect(group.getByRole('button', { name: '复制消息' })).toHaveCount(0);
  await expect(page.getByText('两张图片已检查。', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-row').filter({ hasText: '先逐张检查文件。' })).toHaveCount(0);
  await expect(page.locator('.run-trace-note')).toBeHidden();
  await expectPixels(group.locator('img').nth(0), colors[0]!);
  await expectPixels(group.locator('img').nth(1), colors[1]!);
  await page.getByText('2 个工具', { exact: true }).click();
  await expect(page.locator('.run-trace-note')).toBeVisible();
  await expect(page.locator('.run-trace-note')).toHaveText('先逐张检查文件。');
  await expect(page.getByText(/模型专用提示/)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('completed-history.png') });
  await group.getByRole('button', { name: '查看图片 图片 1', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '图片预览' });
  await expectPixels(preview.locator('.image-preview-canvas img'), colors[0]!);
  await preview.getByRole('button', { name: '下一张图片', exact: true }).click();
  await expect(preview.locator('.image-preview-count')).toHaveText('2 / 2');
  await expectPixels(preview.locator('.image-preview-canvas img'), colors[1]!);
  await page.screenshot({ path: info.outputPath('completed-preview.png') });
  await page.keyboard.press('Escape');
  await expect(group.getByRole('button', { name: '查看图片 图片 1', exact: true })).toBeFocused();
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  test(`文字打断分组，数量说明不重叠且复制可用真实鼠标点击 ${viewport.width}`, async ({ page, request }, info) => {
    await page.setViewportSize(viewport);
    const ids = await uploadImages(request);
    const text = '下面继续检查另一张图片。';
    await history(page, [message('user', 'user', '查看图片', 0), imageMessage('image-a', ids[0]!, 1),
      imageMessage('image-b', ids[1]!, 2), message('reply', 'assistant', text, 3), imageMessage('image-c', ids[0]!, 4)]);
    await page.goto('/');
    await expect(page.locator('.message-note')).toHaveText(['工具读取了 2 张图片', '工具读取了 1 张图片']);
    await expect(page.locator('.message-image')).toHaveCount(3);
    await expect(page.getByText(/模型专用提示/)).toHaveCount(0);
    const reply = page.locator('.chat-row').filter({ hasText: text });
    const copy = reply.getByRole('button', { name: '复制消息' });
    await reply.hover();
    const note = (await page.getByText('工具读取了 2 张图片', { exact: true }).boundingBox())!;
    const paragraph = (await reply.locator('.markdown-body p').boundingBox())!;
    expect(note.y + note.height).toBeLessThanOrEqual(paragraph.y);
    await expect.poll(() => copy.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    })).toBe(true);
    await copy.click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text);
    await expect(copy).toHaveAttribute('data-state', 'copied');
    await page.screenshot({ path: info.outputPath(`layout-copy-${viewport.width}.png`) });
  });
}

for (const member of [0, 8]) {
  test(`旧图片阅读锚点恢复到合组成员 ${member}`, async ({ page, request }, info) => {
    const ids = await uploadImages(request);
    const state = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json();
    const anchorEntryId = `image-${member}`;
    expect((await request.put(`${fakeApiRoot}/api/assistant/page-state`, { data: { draft: '', anchorEntryId, anchorOffsetPx: 0, quote: null, revision: state.revision } })).ok()).toBe(true);
    expect((await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json()).anchorEntryId).toBe(anchorEntryId);
    await history(page, [message('user', 'user', '查看多张图片', 0),
      ...Array.from({ length: 25 }, (_, index) => imageMessage(`image-${index}`, ids[index % 2]!, index + 1))]);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await expect(page.locator('.message-image')).toHaveCount(25);
    const anchor = page.locator(`[data-entry-id="${anchorEntryId}"]`);
    await expect(anchor).toHaveCount(1);
    const scroll = page.locator('.message-scroll');
    await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - (await scroll.boundingBox())!.y)).toBeLessThan(2);
    expect(await scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(200);
    // 图片仍只是阅读锚点，不因此获得可以引用工具输出的身份。
    await expect(anchor.locator('[data-quote-entry-id]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`restored-member-${member}.png`) });
    await page.reload();
    await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - (await scroll.boundingBox())!.y)).toBeLessThan(2);
  });
}

test('真实任务回应到达后断开图片组，已打开的第二张预览保持像素与切图', async ({ page, request, context }, info) => {
  const title = '图片组回应断点';
  const created = await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: crypto.randomUUID(), title, goal: '核对两份资料的依据' } });
  expect(created.ok()).toBe(true);
  const { task } = await created.json();
  expect((await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/control`, { data: { commandId: crypto.randomUUID(), revision: task.revision, action: 'start' } })).ok()).toBe(true);
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).runs[0]?.stopConfirmed).toBe(true);
  const detail = await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json();
  const sessionId = detail.task.sessionId;
  const asked = await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/requests`, { data: { commandId: crypto.randomUUID(), question: '采用哪张图片？' } });
  expect(asked.ok()).toBe(true);
  const question = (await asked.json()).request;
  const ids = await uploadImages(request, sessionId);
  const before = new Date(Date.parse(question.createdAt) - 1000).toISOString();
  const after = new Date(Date.parse(question.createdAt) + 86_400_000).toISOString();
  await history(page, [message('task-user', 'user', '系统任务输入', 0, { createdAt: before }),
    imageMessage('task-image-a', ids[0]!, 1, { createdAt: before }), imageMessage('task-image-b', ids[1]!, 2, { createdAt: after })], [], [], sessionId);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  await page.getByRole('button', { name: `查看任务：${title}`, exact: true }).click();
  await page.getByRole('button', { name: `打开任务会话：${title}`, exact: true }).click();
  const view = page.getByRole('region', { name: '任务会话视图' });
  await expect(view.locator('.message-note')).toHaveText('工具读取了 2 张图片');
  await view.getByRole('button', { name: '查看图片 图片 1', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '图片预览' });
  await preview.getByRole('button', { name: '下一张图片', exact: true }).click();
  await expectPixels(preview.locator('.image-preview-canvas img'), colors[1]!);

  // 另一真实窗口提交回应；工作台事件会在预览打开期间更新原窗口的任务时间线。
  const responder = await context.newPage();
  try {
    await responder.goto('/');
    await expect(responder.getByLabel('Multivac 草稿')).toBeEditable();
    await openPanel(responder, 'management');
    await responder.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
    await responder.getByRole('button', { name: `查看任务：${title}`, exact: true }).click();
    const card = responder.getByRole('complementary', { name: '任务详情' }).getByRole('region', { name: '任务人工请求' }).filter({ hasText: '采用哪张图片？' });
    await card.getByRole('textbox', { name: '澄清回应', exact: true }).fill('采用第二张图片。');
    await card.getByRole('button', { name: '提交回应', exact: true }).click();
    await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/task-requests/${question.requestId}`)).json()).request.status).toBe('answered');
    const decided = (await (await request.get(`${fakeApiRoot}/api/task-requests/${question.requestId}`)).json()).request;
    expect(decided.sessionId).toBe(sessionId);
    expect(decided.answer).toBe('采用第二张图片。');
    expect(Date.parse(decided.updatedAt)).toBeGreaterThan(Date.parse(before));
    expect(Date.parse(decided.updatedAt)).toBeLessThan(Date.parse(after));
    await expect(view.locator('.message-note')).toHaveText(['工具读取了 1 张图片', '工具读取了 1 张图片']);
    await expect(preview.locator('.image-preview-count')).toHaveText('2 / 2');
    await expectPixels(preview.locator('.image-preview-canvas img'), colors[1]!);
    await preview.getByRole('button', { name: '上一张图片', exact: true }).click();
    await expectPixels(preview.locator('.image-preview-canvas img'), colors[0]!);
    await page.screenshot({ path: info.outputPath('task-reply-preview.png') });
    await page.keyboard.press('Escape');
    const reply = view.locator(`.task-request-reply[data-request-id="${question.requestId}"]`);
    await expect(reply).toContainText('采用第二张图片。');
    await expect(view.locator('.chat-row')).toHaveCount(3);
    const rows = view.locator('.chat-row');
    await expect(rows.nth(0).locator('[data-entry-id="task-image-a"]')).toHaveCount(1);
    await expect(rows.nth(1)).toHaveAttribute('data-request-id', question.requestId);
    await expect(rows.nth(2).locator('[data-entry-id="task-image-b"]')).toHaveCount(1);
    await expect(view.getByText(/模型专用提示/)).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath('task-reply-split.png') });
  } finally {
    await responder.close();
  }
});
