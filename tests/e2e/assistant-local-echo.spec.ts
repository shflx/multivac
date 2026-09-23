import { expect, test } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  const current = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json() as {
    revision: number;
  };
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: current.revision },
  });
  await page.goto('/');
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
});

test('发送后立即回显自己的消息，回读到历史时不留重复', async ({ page, request }) => {
  const submitted = '本地回显：这条消息在运行期间也应当可见';
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);

  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill(submitted);
  await page.getByLabel('发送消息').click();
  expect((await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`)).ok()).toBe(true);

  // 运行进行中：草稿已清空，正文必须留在会话里，而不是从屏幕上消失。
  const rows = page.locator('article.chat-row.user').filter({ hasText: submitted });
  await expect(draft).toHaveValue('');
  await expect(rows).toHaveCount(1);
  await expect(page.locator('article.chat-row.pending')).toHaveCount(1);
  // 回显没有 Pi entry：不作阅读锚点，也不作为引用来源。
  await expect(page.locator('article.chat-row.pending')).not.toHaveAttribute('data-entry-id', /./);
  expect(await page.locator('article.chat-row.pending [data-quote-entry-id]').count()).toBe(0);

  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();

  // 历史回读之后仍然只有一条，且已经变成可引用的持久化消息。
  await expect(rows).toHaveCount(1);
  await expect(page.locator('article.chat-row.pending')).toHaveCount(0);
  await expect(rows).toHaveAttribute('data-entry-id', /.+/);
});

test('连续发送同一段正文时两条都回显，不会被首条吞掉', async ({ page, request }) => {
  const submitted = '重复正文回显检查';
  const draft = page.getByLabel('Multivac 草稿');
  const rows = page.locator('article.chat-row.user').filter({ hasText: submitted });

  await draft.fill(submitted);
  await page.getByLabel('发送消息').click();
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(1);

  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
  await draft.fill(submitted);
  await page.getByLabel('发送消息').click();
  expect((await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`)).ok()).toBe(true);
  await expect(rows).toHaveCount(2);

  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect(page.locator('article.chat-row.pending')).toHaveCount(0);
});

test('发送失败时撤回回显，正文回到输入区', async ({ page }) => {
  const submitted = '失败场景：回显必须撤回';
  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill(submitted);
  await page.getByLabel('发送消息').click();

  await expect(page.getByRole('status').getByText('处理失败', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue(submitted);
  await expect(page.locator('article.chat-row.pending')).toHaveCount(0);
});
