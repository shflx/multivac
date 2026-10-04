import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, openCreationDialog, openPanel, openArchivePage, resetE2eState, currentWorkspaceGroup, setWorkspaceMode, ensureWorkspaceRail, railSessionAction } from './test-state.js';

interface ListedSession {
  sessionId: string;
  title: string;
  archivedAt: string | null;
  parentSessionId: string | null;
  workingDirectory: { kind: string; path: string };
}

const workspaceBar = (page: Page) => page.locator('.workspace-page');
const sessionMenu = (page: Page) => currentWorkspaceGroup(page);
const activeTitles = (page: Page) => sessionMenu(page).locator('.rail-item .rail-session-open .nav-label');

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

async function closeSessionMenu(page: Page): Promise<void> {
  if (await page.locator('.workspace-rail-wrap.overlay').isVisible()) await page.keyboard.press('Escape');
}

/** 在会话列表中归档：经确认卡确认。 */
async function archive(page: Page, title: string): Promise<void> {
  const menu = await openSessionMenu(page);
  await railSessionAction(page, title, '归档');
  const card = page.getByRole('dialog', { name: `归档「${title}」` });
  await card.getByRole('button', { name: '归档', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(menu.locator('.rail-item .rail-session-open').filter({ hasText: title })).toHaveCount(0);
}

/** 在归档页恢复后回到原工作区。 */
async function restore(page: Page, title: string): Promise<void> {
  await openArchivePage(page);
  const main = page.getByRole('main', { name: '归档' });
  await main.getByRole('list', { name: '归档会话列表' }).getByRole('button').filter({ hasText: title }).click();
  await main.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(main.locator('.archive-list strong').filter({ hasText: title })).toHaveCount(0);
  await openPanel(page, 'workspace');
  await ensureWorkspaceRail(page);
  await expect(activeTitles(page).filter({ hasText: title })).toHaveCount(1);
}

async function sendIn(page: Page, title: string, text: string): Promise<void> {
  const target = panel(page, title);
  await target.getByLabel('Multivac 草稿').fill(text);
  await target.getByLabel('发送消息').click();
  await expect(target.locator('article.chat-row.user').filter({ hasText: text })).toHaveCount(1);
  await expect(target.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
}

async function listSessions(page: Page): Promise<ListedSession[]> {
  const response = await page.request.get(`${fakeApiRoot}/api/sessions?archived=include`);
  expect(response.ok()).toBe(true);
  return (await response.json() as { sessions: ListedSession[] }).sessions;
}

async function selectInPanel(page: Page, needle: string): Promise<void> {
  await page.evaluate((text) => {
    const hosts = [...document.querySelectorAll('.conversation-panel [data-quote-entry-id]')];
    for (const host of hosts) {
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.textContent?.indexOf(text) ?? -1;
        if (index < 0) continue;
        (host as HTMLElement).scrollIntoView({ block: 'center' });
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + text.length);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        return;
      }
    }
    throw new Error(`会话面板中未找到：${text}`);
  }, needle);
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  await page.goto('/');
  await openPanel(page, 'workspace');
  await expect(workspaceBar(page)).toBeVisible();
});

test('归档后经管理页恢复：历史与工作目录不变，恢复后可以继续发送，刷新后保持', async ({ page }) => {
  await createSession(page, '归档往返');
  await sendIn(page, '归档往返', '归档前的问题');
  const history = await panel(page, '归档往返').locator('article.chat-row').allTextContents();
  const [before] = await listSessions(page);

  await archive(page, '归档往返');
  await expect(currentWorkspaceGroup(page).locator('.rail-item')).toHaveCount(0);
  await expect(page.locator('.conversation-panel')).toHaveCount(0);

  await restore(page, '归档往返');
  // 恢复后回到工作区列表；工作区有空栏，会话补进来并显示原有历史。
  await expect(activeTitles(page)).toHaveText(['归档往返']);
  await closeSessionMenu(page);
  await expect(panel(page, '归档往返').locator('article.chat-row')).toHaveText(history);
  const [after] = await listSessions(page);
  expect(after).toEqual(before);

  await sendIn(page, '归档往返', '恢复后的问题');
  await expect(panel(page, '归档往返').locator('article.chat-row.user')).toHaveCount(2);
  await expect(panel(page, '归档往返').locator('article.chat-row.user')).toContainText(['归档前的问题', '恢复后的问题']);

  await page.reload();
  await openPanel(page, 'workspace');
  await expect(panel(page, '归档往返').locator('article.chat-row.user')).toHaveCount(2);
  await expect(panel(page, '归档往返').locator('article.chat-row.user')).toContainText(['归档前的问题', '恢复后的问题']);
  await openSessionMenu(page);
});

test('归档恢复与工作区实时同步；恢复只补空栏，不替换正在展示的会话', async ({ page }) => {
  for (const title of ['会话甲', '会话乙', '会话丙', '会话丁']) await createSession(page, title);
  await setWorkspaceMode(page, 'parallel');
  await expect(page.locator('.conversation-panel h2')).toHaveText(['会话丁', '会话丙']);

  await archive(page, '会话甲');
  await archive(page, '会话乙');
  // 与会话列表同序：新建的在前。
  await expect(activeTitles(page)).toHaveText(['会话丁', '会话丙']);

  // 两栏都有会话：恢复的会话回到列表但不展示，不挤掉现有栏位。
  await restore(page, '会话乙');
  await expect(activeTitles(page)).toHaveText(['会话丁', '会话丙', '会话乙']);
  await expect(sessionMenu(page).locator('.rail-item[data-session-id]').filter({ hasText: '会话乙' }).locator('small'))
    .toHaveCount(0);
  await expect(page.locator('.conversation-panel h2')).toHaveText(['会话丁', '会话丙']);

  // 归档正在展示的会话后空出一栏，恢复的会话按列表顺序补位。
  await archive(page, '会话丁');
  await expect(page.locator('.conversation-panel h2')).toHaveText(['会话丙', '会话乙']);

  await page.reload();
  await openPanel(page, 'workspace');
  await openSessionMenu(page);
  await expect(activeTitles(page)).toHaveText(['会话丙', '会话乙']);
  const sessions = await listSessions(page);
  expect(sessions.filter((session) => session.archivedAt !== null).map((session) => session.title)).toEqual(['会话甲', '会话丁']);
});

test('栈式父子：父会话归档后子会话路径标注已归档且不能返回；单独恢复子会话可继续发送，恢复父会话后可以返回', async ({ page }) => {
  await createSession(page, '导航结构');
  await sendIn(page, '导航结构', '顶栏只保留两个入口吗？');
  const parentHistory = await panel(page, '导航结构').locator('article.chat-row').allTextContents();

  await selectInPanel(page, 'Fake Multivac 已处理当前消息');
  await page.getByRole('toolbar', { name: '选中内容操作' }).getByRole('button', { name: '深入一层' }).click();
  const childTitle = 'Fake Multivac 已处理当前消息';
  const child = panel(page, childTitle);
  await expect(child.locator('.conversation-path')).toHaveText(`栈式路径 · 导航结构 / ${childTitle}`);
  await sendIn(page, childTitle, '展开讲讲子话题');

  // 归档父会话：子会话仍在，路径显示父会话名并标注已归档，“返回父会话”不可用。
  await archive(page, '导航结构');
  await expect(child.locator('.conversation-path')).toContainText('导航结构（已归档）');
  await closeSessionMenu(page);
  await expect(child.locator('.conversation-path')).toHaveText(`栈式路径 · 导航结构（已归档） / ${childTitle}`);
  await expect(child.getByRole('button', { name: '返回父会话' })).toHaveCount(0);

  // 子会话也归档，然后只恢复子会话：父会话保持归档。
  await archive(page, childTitle);
  await restore(page, childTitle);
  await closeSessionMenu(page);
  await expect(child.locator('.conversation-path')).toHaveText(`栈式路径 · 导航结构（已归档） / ${childTitle}`);
  await expect(child.getByRole('button', { name: '返回父会话' })).toHaveCount(0);
  await expect(child.locator('.stack-source p')).toHaveText(childTitle);
  await expect(child.locator('article.chat-row.user')).toHaveCount(1);
  await expect(child.locator('article.chat-row.user')).toContainText(['展开讲讲子话题']);
  await sendIn(page, childTitle, '恢复后继续追问');

  // 恢复父会话后栈式关系完整：路径不再标注，“返回父会话”回到父会话（子会话随之归档），父会话历史不变。
  await restore(page, '导航结构');
  await closeSessionMenu(page);
  await expect(child.locator('.conversation-path')).toHaveText(`栈式路径 · 导航结构 / ${childTitle}`);
  await child.getByRole('button', { name: '返回父会话' }).click();
  await expect(panel(page, '导航结构').locator('article.chat-row')).toHaveText(parentHistory);

  const sessions = await listSessions(page);
  expect(sessions.map((session) => [session.title, session.parentSessionId !== null, session.archivedAt])).toEqual([
    ['导航结构', false, null], [childTitle, true, expect.any(String)],
  ]);
});
