import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

const home = (page: Page) => page.locator('.work-surface').first();
const editor = (page: Page) => page.locator('.notes-open-document:visible').getByLabel('Markdown 正文', { exact: true });

async function global(page: Page) {
  await page.goto('/');
  await expect(home(page).getByLabel('Multivac 草稿')).toBeEditable();
}

// Fake 只指定模型工具序列；调用、保存回执、事件同步与笔记页全部走真实产品服务。
async function tool(page: Page, name: string, args: object, success = true) {
  const id = `note-${crypto.randomUUID()}`;
  const draft = home(page).getByLabel('Multivac 草稿');
  await draft.fill(`请按我指定的参数${name === 'create_note' ? '新建并保存' : name === 'update_note' ? '更新并保存' : '查询'}独立笔记。\n内部工具：${name}#${id} ${JSON.stringify(args)}`);
  await draft.press('Enter');
  await expect(home(page).locator(`.run-trace-tool[data-tool-call-id="${id}"]`)).toHaveClass(success ? /succeeded/ : /failed/);
  await expect(home(page).getByRole('button', { name: '发送消息', exact: true })).toBeVisible();
}

async function openNotes(page: Page) {
  await expect(page.getByRole('button', { name: '快捷键', exact: true })).toBeVisible();
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '笔记', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '笔记库' })).toBeVisible();
}

test('Multivac 对话查询、读写有真实回执，重复请求不重复新建，刷新后笔记应用可读', async ({ page, request }) => {
  await resetE2eState(request); await global(page);
  const title = `对话笔记-${crypto.randomUUID()}`;
  const create = { requestId: crypto.randomUUID(), title, body: '  用户提供的 Markdown\n\n# 正文' };
  await tool(page, 'create_note', create);
  await expect(home(page)).toContainText(`已保存笔记「${title}」`);
  const list = async () => (await (await request.get(`${fakeApiRoot}/api/notes`)).json()) as { notes: { id: string; title: string; revision: number }[] };
  const saved = (await list()).notes.find(note => note.title === title)!;
  expect(saved).toBeTruthy(); expect(saved.revision).toBe(1);
  await tool(page, 'list_notes', { query: title });
  await tool(page, 'read_note', { noteId: saved.id });
  await expect(home(page).locator('article.chat-row.assistant').last()).toContainText('用户提供的 Markdown');
  await tool(page, 'create_note', create);
  expect((await list()).notes.filter(note => note.id === saved.id)).toHaveLength(1);
  const update = { requestId: crypto.randomUUID(), noteId: saved.id, revision: 1, patch: { body: '# 修改后的正文\n保留空白  ' } };
  await tool(page, 'update_note', update);
  await tool(page, 'update_note', update);
  expect((await list()).notes.find(note => note.id === saved.id)?.revision).toBe(2);
  await tool(page, 'get_note_operation', { requestId: update.requestId });
  await expect(home(page).locator('article.chat-row.assistant').last()).toContainText('"status":"saved"');
  await page.reload(); await openNotes(page);
  await page.getByRole('complementary', { name: '笔记库' }).getByRole('button').filter({ hasText: title }).click();
  await expect(editor(page)).toHaveValue(update.patch.body);
  await expect(page.getByRole('region', { name: '笔记编辑器' }).getByLabel('笔记标题')).toHaveValue(title);
});

test('对话写入及时同步笔记页，远端更新保留本机草稿，旧版本失败不覆盖，重启恢复', async ({ page, context, request }) => {
  await resetE2eState(request); await global(page);
  const title = `同步笔记-${crypto.randomUUID()}`;
  const initial = await (await request.post(`${fakeApiRoot}/api/notes`, { data: { commandId: crypto.randomUUID(), id: crypto.randomUUID(), title, body: '共同基线' } })).json() as { id: string; revision: number };
  await openNotes(page);
  await page.getByRole('complementary', { name: '笔记库' }).getByRole('button').filter({ hasText: title }).click();
  await expect(editor(page)).toHaveValue('共同基线');
  const assistant = await context.newPage(); await global(assistant);
  const update = { requestId: crypto.randomUUID(), noteId: initial.id, revision: initial.revision, patch: { body: '对话保存的新正文' } };
  await tool(assistant, 'update_note', update);
  await expect(editor(page)).toHaveValue(update.patch.body);
  await editor(page).fill('本机未保存草稿');
  await tool(assistant, 'update_note', { requestId: crypto.randomUUID(), noteId: initial.id, revision: 2, patch: { title: `${title}-新标题` } });
  await expect(page.locator('.notes-open-document:visible .note-conflict')).toContainText('本机草稿已保留');
  await expect(editor(page)).toHaveValue('本机未保存草稿');
  await tool(assistant, 'update_note', { requestId: crypto.randomUUID(), noteId: initial.id, revision: 1, patch: { body: '旧版本误覆盖' } }, false);
  const stored = async () => (await (await request.get(`${fakeApiRoot}/api/notes/${initial.id}`)).json()) as { revision: number; body: string; title: string };
  expect(await stored()).toMatchObject({ revision: 3, body: update.patch.body, title: `${title}-新标题` });
  await assistant.close();
  expect((await request.post(`${fakeApiRoot}/api/__e2e/restart`)).status()).toBe(202);
  await new Promise(resolve => setTimeout(resolve, 300));
  await expect.poll(async () => { try { return (await request.get(`${fakeApiRoot}/api/notes/${initial.id}`, { timeout: 1000 })).status(); } catch { return 0; } }, { timeout: 30000 }).toBe(200);
  expect(await stored()).toMatchObject({ revision: 3, body: update.patch.body });
  await page.reload(); await openNotes(page);
  await expect(editor(page)).toHaveValue('本机未保存草稿');
  await expect(page.locator('.notes-open-document:visible .note-conflict')).toContainText('本机草稿已保留');
});
