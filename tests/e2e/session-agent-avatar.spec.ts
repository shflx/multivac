import { expect, test } from '@playwright/test';
import { fakeApiRoot, openCreationDialog, openPanel, resetE2eState } from './test-state.js';

for (const width of [1440, 900]) test(`智能体回复在流式、完成及历史恢复时只展示一个头像 ${width}px`, async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  const created = await request.post(`${fakeApiRoot}/api/agents`, { data: {
    commandId: crypto.randomUUID(), name: 'Sun', modelProfileId: 'fixture-openai', instructions: '简洁回答。',
  } });
  expect(created.ok()).toBe(true);
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  await openPanel(page, 'workspace');
  await openCreationDialog(page);
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill('头像去重验证');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  const panel = page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: '头像去重验证', exact: true }) });
  const draft = panel.getByLabel('Multivac 草稿');
  const replies = panel.locator('.chat-row.assistant');
  const heading = panel.locator('.assistant-executor');
  await expect(draft).toBeEditable();
  await draft.fill('普通回复保留头像');
  await panel.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(replies).toHaveCount(1);
  await expect(replies.first().locator('.avatar')).toBeVisible();
  await expect(panel.getByRole('button', { name: '取消当前处理' })).toHaveCount(0);

  await panel.getByRole('button', { name: '选择本轮智能体' }).click();
  const search = panel.getByRole('textbox', { name: '搜索执行智能体' });
  await search.fill('Sun'); await expect(panel.getByRole('option')).toHaveCount(1); await search.press('Enter');
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm-streaming`)).ok()).toBe(true);
  await draft.fill('智能体回复只显示一个头像');
  await panel.getByRole('button', { name: '发送消息', exact: true }).click();
  expect((await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`)).ok()).toBe(true);
  await expect(replies).toHaveCount(2);
  await expect(heading).toContainText('Sun');
  await expect(heading.locator('.avatar')).toBeVisible();
  await expect(replies.last().locator('.avatar')).toBeHidden();
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(replies.last()).toHaveAttribute('data-entry-id', /.+/);
  await expect(replies.last().locator('.avatar')).toBeHidden();
  await expect(heading.locator('.avatar')).toBeVisible();

  await page.reload();
  await expect(page.locator('.assistant-composer:visible').first()).toBeVisible();
  if (!await panel.isVisible()) await openPanel(page, 'workspace');
  await expect(replies).toHaveCount(2);
  await expect(heading.locator('.avatar')).toBeVisible();
  await expect(replies.first().locator('.avatar')).toBeVisible();
  await expect(replies.last().locator('.avatar')).toBeHidden();
  await panel.locator('.message-stream').screenshot({ path: testInfo.outputPath(`agent-avatar-${width}.png`), animations: 'disabled' });

  await draft.fill('下一轮普通回复仍显示头像');
  await panel.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(replies).toHaveCount(3);
  await expect(replies.last().locator('.avatar')).toBeVisible();
  await expect(heading).toHaveCount(1);
});
