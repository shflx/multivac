import { expect, test } from '@playwright/test';
import type { AssistantSessionPageResponse } from '@multivac/contracts';
import { resetE2eState } from './test-state.js';

for (const anchored of [true, false]) {
  test(`${anchored ? '已定位' : '无归属'}的旧中断记录不会随新提问、回复和刷新移动到对话底部`, async ({ page, request }) => {
    await resetE2eState(request);
    const commandId = anchored ? 'interrupted-anchored' : 'interrupted-unanchored';
    // 兼容旧数据：只有中断状态，没有回复、工具或正文位置记录。
    await page.route(/\/api\/assistant\/session(?:\?|$)/u, async route => {
      const response = await route.fetch();
      const snapshot = await response.json() as AssistantSessionPageResponse;
      const oldUser = { id: 'old-interrupted-user', piSessionId: snapshot.piSessionId, piEntryId: 'old-interrupted-user',
        role: 'user' as const, text: '服务重启前的提问', createdAt: '2026-10-01T00:00:00.000Z' };
      await route.fulfill({ response, json: { ...snapshot,
        messages: [oldUser, ...snapshot.messages],
        commandAnchors: [...(snapshot.commandAnchors ?? []), ...(anchored ? [{ commandId, piEntryId: oldUser.piEntryId }] : [])],
        runTraces: [{ commandId, cursor: '0', status: 'failed', startedAt: oldUser.createdAt, endedAt: null, entries: [], thinkingTruncated: false,
          error: { code: 'COMMAND_INTERRUPTED', message: '服务重启前命令尚未终结；provider stream 不可跨进程恢复，已标记为中断。' } }, ...(snapshot.runTraces ?? [])],
      } });
    });
    await page.goto('/');
    const failed = page.locator(`[data-run-command-id="${commandId}"]`);
    await expect(failed.getByRole('note', { name: '本次运行失败原因' })).toContainText('provider stream');
    if (!anchored) {
      await expect(failed).toHaveAttribute('aria-label', '未关联消息的历史运行记录');
      await expect(failed.locator('summary')).toContainText('历史处理失败');
    }
    const draft = page.getByRole('textbox', { name: 'Multivac 草稿', exact: true });
    await draft.fill('中断之后发出的新消息');
    const sent = page.waitForResponse(response => new URL(response.url()).pathname === '/api/assistant/turns' && response.request().method() === 'POST');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const newUser = page.locator('.message-stream article.chat-row.user').filter({ hasText: '中断之后发出的新消息' });
    const assertOrder = async () => {
      await expect(newUser).toBeVisible();
      await expect(failed).toHaveCount(1);
      await expect.poll(() => newUser.evaluate((element, commandId) => {
        const trace = element.closest('.message-stream')?.querySelector(`[data-run-command-id="${commandId}"]`);
        return Boolean(trace && trace.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
      }, commandId)).toBe(true);
      if (anchored) {
        const old = page.locator('.message-stream article.chat-row.user').filter({ hasText: '服务重启前的提问' });
        await expect.poll(() => old.evaluate((element, commandId) => {
          const trace = element.closest('.message-stream')?.querySelector(`[data-run-command-id="${commandId}"]`);
          return Boolean(trace && element.compareDocumentPosition(trace) & Node.DOCUMENT_POSITION_FOLLOWING);
        }, commandId)).toBe(true);
      }
    };
    await assertOrder();
    expect((await (await sent).json()).terminalOutcome).toBe('succeeded');
    await assertOrder();
    await page.reload();
    await assertOrder();
    await expect(failed.getByRole('note', { name: '本次运行失败原因' })).toContainText('provider stream');
  });
}

test('运行中的用户锚点不冒充回复，刷新后思考轨迹仍展开', async ({ page, request }) => {
  await resetE2eState(request);
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Multivac 草稿', exact: true })).toBeEditable();
  expect((await request.post('/api/__e2e/assistant/prompt-completion/arm')).ok()).toBe(true);
  const posted = page.waitForRequest(request => new URL(request.url()).pathname === '/api/assistant/turns' && request.method() === 'POST');
  await page.getByRole('textbox', { name: 'Multivac 草稿', exact: true }).fill('等待回复时核对用户锚点');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const commandId = (await posted).postDataJSON().commandId as string;
  const trace = page.locator(`[data-run-command-id="${commandId}"]`);
  try {
    expect((await request.get('/api/__e2e/assistant/prompt-completion/entered')).ok()).toBe(true);
    const snapshot = await (await request.get('/api/assistant/session')).json() as AssistantSessionPageResponse;
    const anchor = snapshot.commandAnchors!.find(anchor => anchor.commandId === commandId)!;
    expect(snapshot.messages.find(message => message.piEntryId === anchor.piEntryId)?.role).toBe('user');
    await expect(trace).toHaveAttribute('open', '');
    await page.reload();
    await expect(trace).toHaveAttribute('open', '');
    await expect(trace.locator('summary')).not.toContainText('失败');
  } finally {
    expect((await request.post('/api/__e2e/assistant/prompt-completion/release')).ok()).toBe(true);
  }
});
