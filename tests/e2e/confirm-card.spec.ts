import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, openCreationDialog, openPanel, resetE2eState, currentWorkspaceGroup, railSessionAction, ensureWorkspaceRail } from './test-state.js';

const workspaceBar = (page: Page) => page.locator('.workspace-page');
const sessionMenu = (page: Page) => currentWorkspaceGroup(page);
const archiveCard = (page: Page, title: string) => page.getByRole('dialog', { name: `归档「${title}」` });

function panel(page: Page, title: string) {
  return page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

async function createSession(page: Page, title: string): Promise<void> {
  await openCreationDialog(page);
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill(title);
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
}

async function openSessionMenu(page: Page) {
  await ensureWorkspaceRail(page);
  await expect(sessionMenu(page)).toBeVisible();
  return sessionMenu(page);
}

async function archivedAt(page: Page, title: string): Promise<string | null> {
  const response = await page.request.get(`${fakeApiRoot}/api/sessions?archived=include`);
  const { sessions } = await response.json() as { sessions: { title: string; archivedAt: string | null }[] };
  return sessions.find((session) => session.title === title)?.archivedAt ?? null;
}

/** 记录出现过的浏览器原生对话框（并关闭），确认已全部改用确认卡。 */
function watchNativeDialogs(page: Page): string[] {
  const messages: string[] = [];
  page.on('dialog', (dialog) => {
    messages.push(dialog.message());
    void dialog.dismiss();
  });
  return messages;
}

test.beforeEach(async ({ request }) => {
  await resetE2eState(request);
});

test('归档走确认卡：取消、Esc 与点击遮罩都不归档，Enter 确认后归档；焦点在卡内循环并在关闭后交还', async ({ page }) => {
  const nativeDialogs = watchNativeDialogs(page);
  await page.goto('/');
  await openPanel(page, 'workspace');
  await createSession(page, '确认归档');

  const menu = await openSessionMenu(page);
  const trigger = menu.getByRole('button', { name: '更多「确认归档」' });
  await railSessionAction(page, '确认归档', '归档');

  // 对话框语义：模态、以标题命名、以说明与要点描述。
  const card = archiveCard(page, '确认归档');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('aria-modal', 'true');
  await expect(card).toHaveAccessibleDescription(/归档后不再出现在工作区中。.*可以在“设置 · 归档”中恢复/);
  const confirm = card.getByRole('button', { name: '归档', exact: true });
  const cancel = card.getByRole('button', { name: '取消', exact: true });

  // 归档可以恢复：焦点默认在“归档”上；Tab 与 Shift+Tab 只在卡内循环。
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(confirm).toBeFocused();

  // 取消：不归档，焦点回到触发按钮，会话列表保持打开。
  await cancel.click();
  await expect(card).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(sessionMenu(page)).toBeVisible();

  // Esc 只关闭确认卡，不连带收起会话列表。
  await railSessionAction(page, '确认归档', '归档');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(sessionMenu(page)).toBeVisible();
  await expect(trigger).toBeFocused();

  // 点击遮罩取消；卡片上的点击不算作会话列表的外部点击。
  await railSessionAction(page, '确认归档', '归档');
  await card.locator('h2').click();
  await expect(card).toBeVisible();
  await expect(sessionMenu(page)).toBeVisible();
  await page.mouse.click(8, 8);
  await expect(card).toHaveCount(0);
  await expect(sessionMenu(page)).toBeVisible();
  expect(await archivedAt(page, '确认归档')).toBeNull();
  await expect(panel(page, '确认归档')).toHaveCount(1);

  // Enter 确认：会话归档，焦点交给“已归档 1”。
  await railSessionAction(page, '确认归档', '归档');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card).toHaveCount(0);
  const archivedToggle = sessionMenu(page).locator('.rail-archive-link');
  await expect(archivedToggle).toHaveText('查看归档');
  await expect(archivedToggle).toBeFocused();
  await expect(panel(page, '确认归档')).toHaveCount(0);
  expect(await archivedAt(page, '确认归档')).not.toBeNull();
  expect(nativeDialogs).toEqual([]);
});

test('确认进行中卡片忙碌、不可取消；失败时原因留在卡上，可以重试', async ({ page, request }) => {
  await page.goto('/');
  await openPanel(page, 'workspace');
  await createSession(page, '运行中归档');

  // 让这一轮保持运行：运行中的会话不能归档。
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
  const target = panel(page, '运行中归档');
  await target.getByLabel('Multivac 草稿').fill('一项长任务');
  await target.getByLabel('Multivac 草稿').press('Enter');
  await expect(target.getByRole('button', { name: '取消当前处理' })).toBeVisible();

  const menu = await openSessionMenu(page);
  await railSessionAction(page, '运行中归档', '归档');
  const card = archiveCard(page, '运行中归档');
  const confirm = card.getByRole('button', { name: '归档', exact: true });
  await confirm.click();

  // 失败：卡片不关闭，写明服务端给出的原因；焦点回到“归档”，可以直接重试。
  await expect(card.getByRole('alert')).toHaveText('会话正在运行，请先停止后再归档。');
  await expect(card).toBeVisible();
  await expect(confirm).toBeEnabled();
  await expect(confirm).toBeFocused();
  expect(await archivedAt(page, '运行中归档')).toBeNull();

  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(target.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();

  // 重试：请求进行中卡片忙碌，按钮禁用，Esc 不取消。
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/sessions/*/archive', async (route) => {
    await gate;
    await route.continue();
  });
  await page.keyboard.press('Enter');
  await expect(card).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).toBeDisabled();
  await expect(card.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await expect(card.getByRole('alert')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(card).toBeVisible();

  release();
  await expect(card).toHaveCount(0);
  await expect(sessionMenu(page).locator('.rail-archive-link')).toHaveText('查看归档');
  expect(await archivedAt(page, '运行中归档')).not.toBeNull();
});
