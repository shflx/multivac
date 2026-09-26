import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

const workspaceBar = (page: Page) => page.getByRole('toolbar', { name: '工作区' });

async function enterWorkspace(page: Page): Promise<void> {
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(page.locator('.workspace-page')).toBeVisible();
}

async function createSession(page: Page, title: string): Promise<void> {
  await workspaceBar(page).getByRole('button', { name: '新会话' }).click();
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill(title);
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
}

/** 等待现场写入服务端，避免刷新早于延迟保存。 */
async function waitForScene(page: Page, predicate: (scene: Record<string, unknown>) => boolean): Promise<void> {
  await expect.poll(async () => {
    const response = await page.request.get(`${fakeApiRoot}/api/workspaces/default/scene`);
    return predicate((await response.json() as { scene: Record<string, unknown> }).scene);
  }).toBe(true);
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  await page.goto('/');
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
});

test('调整布局后刷新，并排会话与顺序、当前会话、列宽和工作区条完全恢复', async ({ page }) => {
  await enterWorkspace(page);
  for (const title of ['现场一', '现场二', '现场三']) await createSession(page, title);
  await workspaceBar(page).getByRole('button', { name: '并排', exact: true }).click();

  // 把“现场一”换入并排位并成为当前会话。
  await workspaceBar(page).getByRole('button', { name: /^会话/ }).click();
  await page.getByRole('dialog', { name: '工作区会话' }).locator('.scene-row').filter({ hasText: '现场一' })
    .locator('.scene-open').click();
  await expect(page.locator('.conversation-panel h2')).toHaveText(['现场三', '现场一']);

  const separator = page.getByRole('separator');
  await separator.focus();
  await page.keyboard.press('Shift+ArrowRight');
  const splitValue = await separator.getAttribute('aria-valuenow');
  expect(Number(splitValue)).toBeGreaterThan(50);

  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(workspaceBar(page)).toHaveCount(0);
  await waitForScene(page, (scene) => scene.barVisible === false);

  await page.reload();
  await enterWorkspace(page);
  await expect(workspaceBar(page)).toHaveCount(0);
  await expect(page.locator('.conversation-panel h2')).toHaveText(['现场三', '现场一']);
  await expect(page.locator('.conversation-panel').filter({ hasText: '现场一' })).toHaveClass(/active/);
  await expect(page.getByRole('separator')).toHaveAttribute('aria-valuenow', splitValue!);

  // 聚焦模式同样被记住。
  await page.keyboard.press('ControlOrMeta+Backslash');
  await workspaceBar(page).getByRole('button', { name: '聚焦', exact: true }).click();
  await waitForScene(page, (scene) => scene.viewMode === 'focus');
  await page.reload();
  await enterWorkspace(page);
  await expect(page.locator('.conversation-panel h2')).toHaveText(['现场一']);
  await expect(workspaceBar(page).getByRole('button', { name: '聚焦', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('归档正在展示的会话后现场自动补位，刷新后不再出现', async ({ page }) => {
  page.on('dialog', (dialog) => void dialog.accept());
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await enterWorkspace(page);
  for (const title of ['补位一', '补位二', '补位三']) await createSession(page, title);
  await workspaceBar(page).getByRole('button', { name: '并排', exact: true }).click();
  await expect(page.locator('.conversation-panel h2')).toHaveText(['补位三', '补位二']);

  await workspaceBar(page).getByRole('button', { name: /^会话/ }).click();
  await page.getByRole('button', { name: '归档「补位三」' }).click();
  await expect(page.locator('.conversation-panel h2')).toHaveText(['补位二', '补位一']);
  await waitForScene(page, (scene) => (scene.slots as string[]).length === 2);

  await page.reload();
  await enterWorkspace(page);
  await expect(page.locator('.conversation-panel h2')).toHaveText(['补位二', '补位一']);
  expect(errors).toEqual([]);
});

test('工作会话的草稿与阅读位置按会话恢复', async ({ page, request }) => {
  await enterWorkspace(page);
  await createSession(page, '长会话');
  const sessionId = await page.locator('.conversation-panel').getAttribute('data-session-id');
  for (let index = 1; index <= 40; index += 1) {
    const response = await request.post(`${fakeApiRoot}/api/__e2e/assistant/events/body`, {
      data: { sessionId, messageId: `long-${index}`, delta: `长会话第 ${index} 条回复。`, completed: true },
    });
    expect(response.ok()).toBe(true);
  }
  const panel = page.locator('.conversation-panel');
  await expect(panel.locator('article.chat-row').filter({ hasText: '长会话第 40 条回复。' })).toHaveCount(1);
  await panel.getByLabel('Multivac 草稿').fill('长会话里的草稿');

  const scroll = panel.locator('.message-scroll');
  await scroll.evaluate((element) => {
    element.scrollTop = Math.floor(element.scrollHeight / 3);
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(async () => {
    const state = await (await request.get(`${fakeApiRoot}/api/sessions/${sessionId}/page-state`)).json() as {
      anchorEntryId: string | null; draft: string;
    };
    return Boolean(state.anchorEntryId) && state.draft === '长会话里的草稿';
  }).toBe(true);
  const { anchorEntryId } = await (await request.get(`${fakeApiRoot}/api/sessions/${sessionId}/page-state`)).json() as {
    anchorEntryId: string;
  };
  const anchorRow = panel.locator(`[data-entry-id="${anchorEntryId}"]`);
  const offset = await anchorRow.evaluate((element) =>
    element.getBoundingClientRect().top - element.closest('.message-scroll')!.getBoundingClientRect().top);

  await page.reload();
  await enterWorkspace(page);
  await expect(panel.getByLabel('Multivac 草稿')).toHaveValue('长会话里的草稿');
  await expect.poll(() => anchorRow.evaluate((element) =>
    element.getBoundingClientRect().top - element.closest('.message-scroll')!.getBoundingClientRect().top))
    .toBeCloseTo(offset, 0);
});
