import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

const workspaceBar = (page: Page) => page.getByRole('toolbar', { name: '工作区' });
const sidebar = (page: Page) => page.locator('.workspace-shell .multivac-sidebar');

async function createSession(page: Page, title: string): Promise<void> {
  await workspaceBar(page).getByRole('button', { name: '新会话' }).click();
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill(title);
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  const current = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json() as { revision: number };
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: current.revision },
  });
  await page.goto('/');
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  await page.getByRole('button', { name: '进入工作区' }).click();
});

test('工作区侧栏与首页是同一会话，默认展开且提示当前焦点会话', async ({ page }) => {
  await expect(sidebar(page)).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: '收起 Multivac' })).toBeVisible();
  await createSession(page, '梳理导航结构');
  await createSession(page, '核对接口');
  await expect(sidebar(page).locator('.composer-context')).toHaveText('正在看「核对接口」，可以直接说“这个”');

  // 切换焦点会话后提示随之变化。
  await workspaceBar(page).getByRole('button', { name: '并排', exact: true }).click();
  await page.getByRole('button', { name: '在「梳理导航结构」中继续' }).click();
  await expect(sidebar(page).locator('.composer-context')).toHaveText('正在看「梳理导航结构」，可以直接说“这个”');

  // 在侧栏发送的消息回到首页可见。
  const draft = sidebar(page).getByLabel('Multivac 草稿');
  await draft.fill('这个会话下一步做什么？');
  await sidebar(page).getByLabel('发送消息').click();
  await expect(sidebar(page).getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回 Multivac' }).click();
  await expect(page.locator('.work-surface').first().locator('article.chat-row.user')
    .filter({ hasText: '这个会话下一步做什么？' })).toHaveCount(1);

  // 首页发送的消息在侧栏可见。
  await page.locator('.work-surface').first().getByLabel('Multivac 草稿').fill('首页发出的消息');
  await page.locator('.work-surface').first().getByLabel('发送消息').click();
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(sidebar(page).locator('article.chat-row.user').filter({ hasText: '首页发出的消息' })).toHaveCount(1);

  // 工作区页面按剩余宽度排版，不横向溢出。
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth))
    .toBe(false);
  // 等入场动画结束再测量布局。
  await sidebar(page).evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const shell = await page.locator('.workspace-shell').boundingBox();
  const panel = await sidebar(page).boundingBox();
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(shell!.x + shell!.width + 1);
});

test('侧栏可收起为窄轨，折叠状态跨进出工作区与刷新保留', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: '收起 Multivac' }).click();
  await expect(sidebar(page)).toHaveClass(/collapsed/);
  expect(Math.round((await sidebar(page).boundingBox())!.width)).toBe(44);

  await page.getByRole('button', { name: '返回 Multivac' }).click();
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(sidebar(page)).toHaveClass(/collapsed/);

  await page.reload();
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(sidebar(page)).toHaveClass(/collapsed/);
  await sidebar(page).getByRole('button', { name: '展开 Multivac' }).click();
  await expect(sidebar(page).getByLabel('Multivac 草稿')).toBeEditable();
  await page.reload();
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(sidebar(page)).not.toHaveClass(/collapsed/);
});

test('侧栏内容按侧栏宽度排版：长会话名不把消息和输入区撑出侧栏', async ({ page }) => {
  const title = '会话初始化/恢复、只读分页读历史、页面现场读写与 SSE 推送的对齐方案';
  await createSession(page, title);
  await sidebar(page).evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  await expect(sidebar(page).locator('.composer-context')).toHaveAttribute('title', `正在看「${title}」`);
  await sidebar(page).getByLabel('Multivac 草稿').fill('这个会话里 SSE 是什么意思？');
  await sidebar(page).getByLabel('发送消息').click();
  await expect(sidebar(page).getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();

  const bounds = await sidebar(page).boundingBox();
  const right = bounds!.x + bounds!.width;
  for (const selector of ['.assistant-composer', '.composer-context', 'article.chat-row.user .chat-content', '.message-stream']) {
    const box = await sidebar(page).locator(selector).last().boundingBox();
    expect(box!.x + box!.width, selector).toBeLessThanOrEqual(right + 0.5);
  }
});
