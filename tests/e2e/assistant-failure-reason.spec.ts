import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { AssistantCommandReceipt } from '@multivac/contracts';

async function send(page: Page, text: string): Promise<AssistantCommandReceipt> {
  await page.getByRole('textbox', { name: 'Multivac 草稿', exact: true }).fill(text);
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/assistant/turns' && value.request().method() === 'POST');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  return (await (await response).json()) as AssistantCommandReceipt;
}

test.beforeEach(async ({ page }) => {
  const reset = await page.request.post('/api/__e2e/reset');
  expect(reset.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Multivac 草稿', exact: true })).toBeEnabled();
});

test('失败原因默认展开且不在输入区重复展示，允许手动收起，刷新后重新展开', async ({ page }, testInfo) => {
  const failed = await send(page, '认证失败原因场景');
  expect(failed.terminalOutcome).toBe('failed');
  const oldRun = page.locator(`.run-trace[data-run-command-id="${failed.commandId}"]`);
  await expect(oldRun).toHaveAttribute('open', '');
  await expect(oldRun.getByRole('note', { name: '本次运行失败原因' })).toBeVisible();
  await expect(oldRun.getByRole('note', { name: '本次运行失败原因' })).toContainText('HTTP 401：认证失败');
  await expect(page.locator('.assistant-composer .run-status.failed, .assistant-composer .send-error')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Multivac 草稿', exact: true })).toHaveAttribute('aria-invalid', 'false');
  await page.screenshot({ path: testInfo.outputPath('failure-expanded-content-only.png'), animations: 'disabled' });
  await oldRun.locator(':scope > summary').click();
  await expect(oldRun).not.toHaveAttribute('open', /.*/);
  const success = await send(page, '继续核对失败原因的历史记录');
  expect(success.terminalOutcome).toBe('succeeded');
  await expect(oldRun).toContainText('HTTP 401：认证失败');
  await expect(oldRun).not.toHaveAttribute('open', /.*/);
  await page.reload();
  const restored = page.locator(`.run-trace[data-run-command-id="${failed.commandId}"]`);
  await expect(restored.locator('summary')).toContainText('处理失败 · 查看原因');
  await expect(restored).toHaveAttribute('open', '');
  await expect(restored.getByRole('note', { name: '本次运行失败原因' })).toBeVisible();
  await expect(restored.getByRole('note', { name: '本次运行失败原因' })).toContainText('HTTP 401：认证失败');
});

test('无细节明确提示未提供，已恢复的工具中间错误不显示最终失败入口', async ({ page }) => {
  const missing = await send(page, '无细节失败场景');
  expect(missing.terminalOutcome).toBe('failed');
  const failedRun = page.locator(`.run-trace[data-run-command-id="${missing.commandId}"]`);
  await expect(failedRun).toHaveAttribute('open', '');
  await expect(failedRun.getByRole('note', { name: '本次运行失败原因' })).toBeVisible();
  await expect(failedRun).toContainText('原因未提供。');
  const recovered = await send(page, '工具失败后成功');
  expect(recovered.terminalOutcome).toBe('succeeded');
  const recoveredRun = page.locator(`.run-trace[data-run-command-id="${recovered.commandId}"]`);
  await expect(recoveredRun.locator('summary')).not.toContainText('处理失败');
  await expect(recoveredRun.getByRole('note', { name: '本次运行失败原因' })).toHaveCount(0);
});

test('超过最近 50 次运行后，加载更早历史仍能查看原失败原因', async ({ page }) => {
  test.setTimeout(60_000);
  const failed = await send(page, '认证失败原因场景：历史分页');
  for (let index = 0; index < 55; index += 1) {
    const response = await page.request.post('/api/assistant/turns', { data: {
      commandId: randomUUID(), assistantSessionId: 'global-coordinator', text: `后续成功运行 ${index}`, contextRefs: [],
    } });
    expect(response.ok()).toBeTruthy();
    expect((await response.json() as AssistantCommandReceipt).terminalOutcome).toBe('succeeded');
  }
  await page.reload();
  const restored = page.locator(`.run-trace[data-run-command-id="${failed.commandId}"]`);
  for (let attempt = 0; attempt < 8 && await restored.count() === 0; attempt += 1) {
    const load = page.getByRole('button', { name: '加载更早消息', exact: true });
    await expect(load).toBeVisible();
    const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/assistant/session' && new URL(value.url()).searchParams.has('before'));
    await load.click();
    await response;
    await expect(page.getByRole('button', { name: '正在加载', exact: true })).toHaveCount(0);
  }
  await expect(restored).toHaveAttribute('open', '');
  await expect(restored.getByRole('note', { name: '本次运行失败原因' })).toBeVisible();
  await expect(restored.getByRole('note', { name: '本次运行失败原因' })).toContainText('HTTP 401：认证失败');
});

test('发送前被拒绝的错误显示在内容区，不因没有运行轨迹而丢失', async ({ page }) => {
  await page.route('**/api/assistant/turns', route => route.fulfill({ status: 400, json: {
    error: { code: 'INVALID_REQUEST', message: '发送前核对失败：引用已失效' },
  } }));
  await page.getByRole('textbox', { name: 'Multivac 草稿', exact: true }).fill('需要核对引用的消息');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.message-stream .send-error')).toContainText('发送前核对失败：引用已失效');
  await expect(page.locator('.message-stream .send-error')).toBeVisible();
  await expect(page.locator('.assistant-composer .send-error, .assistant-composer .run-status.failed')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Multivac 草稿', exact: true })).toHaveValue('需要核对引用的消息');
  await expect(page.getByRole('button', { name: '重试发送', exact: true })).toBeVisible();
});

test('连续两段正文后的失败提示在最后一段之后，刷新和继续对话保持原轮次位置', async ({ page }) => {
  expect((await page.request.post('/api/__e2e/assistant/prompt-completion/arm-streaming')).ok()).toBeTruthy();
  const pending = send(page, '无细节失败场景：连续两段正文');
  try {
    expect((await page.request.get('/api/__e2e/assistant/prompt-completion/entered')).ok()).toBeTruthy();
    // 第一段先进入真实历史，第二段仍在流式输出；终态再将第二段保存并回读。
    expect((await page.request.post('/api/__e2e/assistant/events/body', { data: {
      messageId: 'failure-first-reply', delta: '第一段输出已经保存', completed: true,
    } })).ok()).toBeTruthy();
    await expect(page.locator('.message-stream article.chat-row.assistant').filter({ hasText: '第一段输出已经保存' })).toBeVisible();
  } finally {
    expect((await page.request.post('/api/__e2e/assistant/prompt-completion/release')).ok()).toBeTruthy();
  }
  const failed = await pending;
  expect(failed.terminalOutcome).toBe('failed');
  const run = page.locator(`.run-trace[data-run-command-id="${failed.commandId}"]`);
  const reply = page.locator('.message-stream article.chat-row.assistant').filter({ hasText: '（失败已校准）' });
  const expectFailureAfterReply = async () => {
    await expect(reply).toBeVisible();
    await expect(run.getByRole('note', { name: '本次运行失败原因' })).toBeVisible();
    await expect.poll(() => reply.evaluate((element, commandId) => {
      const trace = element.closest('.message-stream')?.querySelector(`[data-run-command-id="${commandId}"]`);
      return Boolean(trace && element.compareDocumentPosition(trace) & Node.DOCUMENT_POSITION_FOLLOWING);
    }, failed.commandId)).toBe(true);
  };
  await expectFailureAfterReply();
  await page.reload();
  await expectFailureAfterReply();
  const success = await send(page, '失败后继续正常对话');
  expect(success.terminalOutcome).toBe('succeeded');
  await expectFailureAfterReply();
  const nextUser = page.locator('.message-stream article.chat-row.user').filter({ hasText: '失败后继续正常对话' });
  await expect.poll(() => nextUser.evaluate((element, commandId) => {
    const trace = element.closest('.message-stream')?.querySelector(`[data-run-command-id="${commandId}"]`);
    return Boolean(trace && trace.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
  }, failed.commandId)).toBe(true);
});
