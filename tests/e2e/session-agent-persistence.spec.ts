import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { fakeApiRoot, openCreationDialog, openPanel, resetE2eState } from './test-state.js';

async function openAgentSession(page: Page, request: APIRequestContext) {
  await resetE2eState(request);
  const created = await request.post(`${fakeApiRoot}/api/agents`, { data: {
    commandId: crypto.randomUUID(), name: '沿用审查', modelProfileId: 'fixture-openai', instructions: '先检查风险。',
  } });
  expect(created.ok()).toBe(true);
  const { agent } = await created.json() as { agent: { agentId: string } };
  await page.goto('/');
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  await openPanel(page, 'workspace'); await openCreationDialog(page);
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill('智能体保留验证');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  const panel = page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: '智能体保留验证', exact: true }) });
  const draft = panel.getByLabel('Multivac 草稿');
  await expect(draft).toBeEditable();
  const choose = async (name: string) => {
    await panel.getByRole('button', { name: '选择本轮智能体' }).click();
    const search = panel.getByRole('textbox', { name: '搜索执行智能体' });
    await search.fill(name); await expect(panel.getByRole('option')).toHaveCount(1); await search.press('Enter');
  };
  await choose('沿用审查');
  const mention = panel.getByRole('group', { name: '本轮智能体', exact: true });
  const sessionId = await panel.getAttribute('data-session-id');
  const stateUrl = `${fakeApiRoot}/api/sessions/${sessionId}/page-state`;
  const sends: { agentId?: string; text: string }[] = [];
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith(`/sessions/${sessionId}/turns`)) sends.push(req.postDataJSON()); });
  return { agent, panel, draft, mention, choose, stateUrl, sends };
}

test('执行失败后保留智能体，恢复按钮兼容相同选择且不覆盖另一智能体，再次发送沿用原选择', async ({ page, request }) => {
  const { agent, panel, draft, mention, choose, sends } = await openAgentSession(page, request);
  const text = '失败场景：保留智能体并恢复正文';
  await draft.fill(text); await panel.getByRole('button', { name: '发送消息', exact: true }).click();
  const failed = panel.getByRole('note', { name: '智能体发送恢复' });
  await expect(failed).toBeVisible();
  await expect(draft).toHaveValue(text);
  await expect(mention).toContainText('沿用审查');
  const restore = failed.getByRole('button', { name: '恢复到输入框' });
  await expect(restore).toBeDisabled();
  await draft.fill('');
  await expect(restore).toBeEnabled();
  await choose('通用执行'); await expect(restore).toBeDisabled();
  await choose('沿用审查'); await expect(restore).toBeEnabled();
  await restore.click();
  await expect(draft).toHaveValue(text);
  await expect(mention).toContainText('沿用审查');
  await panel.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => sends.length).toBe(2);
  expect(sends.every(send => send.agentId === agent.agentId)).toBe(true);
  await expect(draft).toHaveValue('');
  await expect(mention.getByRole('button', { name: '更换本轮智能体' })).toBeEnabled();
  await expect(mention).toContainText('沿用审查');
});

for (const changed of [false, true]) test(`发送后清稿发生版本冲突：${changed ? '不覆盖另一窗口的智能体选择' : '相同智能体可以自动重试保存'}`, async ({ page, request }) => {
  const { agent, panel, draft, mention, stateUrl } = await openAgentSession(page, request);
  const text = '发送后保留默认智能体';
  await draft.fill(text);
  await expect.poll(async () => (await (await request.get(stateUrl)).json()).draft).toBe(text);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let intercepted = false;
  let saves = 0;
  await page.route(`**${new URL(stateUrl).pathname}`, async route => {
    if (route.request().method() !== 'PUT' || route.request().postDataJSON().draft !== '') return route.continue();
    saves++;
    if (intercepted) return route.continue();
    intercepted = true; entered(); await gate;
    if (changed) return route.continue();
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'PAGE_STATE_CONFLICT', message: '保存版本已更新。' } }) });
  });
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
  await panel.getByRole('button', { name: '发送消息', exact: true }).click();
  await started;
  if (changed) {
    const current = await (await request.get(stateUrl)).json();
    expect((await request.put(stateUrl, { data: { ...current, draft: '', agentId: 'general' } })).ok()).toBe(true);
  }
  release();
  if (changed) await expect(panel.getByText('其他页面更新了保存版本；当前草稿已保留，请重试保存。')).toBeVisible();
  else await expect.poll(async () => (await (await request.get(stateUrl)).json()).draft).toBe('');
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(mention.getByRole('button', { name: '更换本轮智能体' })).toBeEnabled();
  await expect(mention).toContainText('沿用审查');
  const state = await (await request.get(stateUrl)).json();
  expect(state.agentId).toBe(changed ? 'general' : agent.agentId);
  expect(state.draft).toBe('');
  expect(saves).toBe(changed ? 1 : 2);
});
