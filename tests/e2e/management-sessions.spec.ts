import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { fakeApiRoot, resetE2eState, openCreationDialog } from './test-state.js';

interface ListedSession {
  sessionId: string;
  title: string;
  archivedAt: string | null;
  parentSessionId: string | null;
}

const workspaceBar = (page: Page) => page.getByRole('toolbar', { name: '工作区' });
const sessionMenu = (page: Page) => page.getByRole('dialog', { name: '工作区会话' });
const sessionsPage = (page: Page) => page.getByRole('main', { name: '会话' });
const sessionList = (page: Page) => sessionsPage(page).getByRole('list', { name: '会话列表' });
const listTitles = (page: Page) => sessionList(page).locator('strong');
const detail = (page: Page) => sessionsPage(page).locator('.session-detail');
const statusFilter = (page: Page) => sessionsPage(page).getByRole('group', { name: '按状态筛选' });
const kindFilter = (page: Page) => sessionsPage(page).getByRole('group', { name: '按类型筛选' });
const search = (page: Page) => sessionsPage(page).getByRole('searchbox', { name: '按标题搜索' });

function panel(page: Page, title: string) {
  return page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

function row(page: Page, title: string) {
  return sessionList(page).getByRole('button').filter({ has: page.getByText(title, { exact: true }) });
}

async function enterWorkspace(page: Page): Promise<void> {
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(workspaceBar(page)).toBeVisible();
}

async function createSession(page: Page, title: string): Promise<void> {
  await openCreationDialog(page);
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill(title);
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
}

async function createSessionByApi(request: APIRequestContext, sessionId: string, title: string): Promise<void> {
  const response = await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title } });
  expect(response.status()).toBe(201);
}

async function listSessions(request: APIRequestContext): Promise<ListedSession[]> {
  const response = await request.get(`${fakeApiRoot}/api/sessions?archived=include`);
  expect(response.ok()).toBe(true);
  return (await response.json() as { sessions: ListedSession[] }).sessions;
}

async function openSessionMenu(page: Page) {
  if (await sessionMenu(page).count() === 0) await workspaceBar(page).getByRole('button', { name: /^会话/ }).click();
  await expect(sessionMenu(page)).toBeVisible();
  return sessionMenu(page);
}

async function closeSessionMenu(page: Page): Promise<void> {
  if (await sessionMenu(page).count() > 0) await workspaceBar(page).getByRole('button', { name: /^会话/ }).click();
  await expect(sessionMenu(page)).toHaveCount(0);
}

/** 进入管理：回到上次所在的页面，首次进入是会话页。 */
async function openManagement(page: Page): Promise<void> {
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await expect(sessionsPage(page)).toBeVisible();
  await expect(sessionList(page).or(sessionsPage(page).locator('.sessions-empty'))).toBeVisible();
}

async function returnToWork(page: Page): Promise<void> {
  await sessionsPage(page).getByRole('button', { name: '返回', exact: true }).click();
  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
}

async function sendIn(page: Page, title: string, text: string): Promise<void> {
  const target = panel(page, title);
  await target.getByLabel('Multivac 草稿').fill(text);
  await target.getByLabel('发送消息').click();
  await expect(target.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
}

/** 在父会话里选中一段回复，深入一层新建栈式子会话。 */
async function drillDown(page: Page, needle: string): Promise<void> {
  await page.evaluate((text) => {
    for (const host of document.querySelectorAll('.conversation-panel [data-quote-entry-id]')) {
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.textContent?.indexOf(text) ?? -1;
        if (index < 0) continue;
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
  await page.getByRole('toolbar', { name: '选中内容操作' }).getByRole('button', { name: '深入一层' }).click();
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  await page.goto('/');
});

test('会话页在“工作”组，列出全部会话（含已归档与栈式子会话），按状态、类型筛选并按标题搜索', async ({ page }) => {
  const child = 'Fake Multivac 已处理当前消息';
  await enterWorkspace(page);
  await createSession(page, '导航结构');
  await sendIn(page, '导航结构', '顶栏只保留两个入口吗？');
  await drillDown(page, child);
  await expect(panel(page, child)).toBeVisible();
  await createSession(page, '资料整理');
  await createSession(page, '旧草稿');
  await openSessionMenu(page);
  await sessionMenu(page).getByRole('button', { name: '归档「旧草稿」' }).click();
  await page.getByRole('dialog', { name: '归档「旧草稿」' }).getByRole('button', { name: '归档', exact: true }).click();
  await closeSessionMenu(page);

  // 进入管理首先打开工作组的“会话”，设置组的“模型”沉到底部。
  await openManagement(page);
  const nav = page.getByRole('complementary', { name: '管理导航' });
  await expect(nav.getByRole('group')).toHaveCount(2);
  await expect(nav.getByRole('group', { name: '工作' }).getByRole('button', { name: '会话' }))
    .toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.shell-page-name')).toHaveText('会话');
  await expect(sessionsPage(page).locator('.management-page-header span')).toHaveText('管理 · 工作');

  // 默认只看进行中的会话，新建的在前；只有一个工作区时不显示工作区筛选，所在写在每一行。
  await expect(listTitles(page)).toHaveText(['资料整理', child, '导航结构']);
  await expect(sessionsPage(page).getByLabel('按工作区筛选')).toHaveCount(0);
  await expect(row(page, '导航结构')).toContainText('默认工作区 · 顶层会话');
  await expect(row(page, child)).toContainText('默认工作区 · 栈式子会话');
  await expect(row(page, child)).toContainText('第 2 层 · 来自「导航结构」');
  // 全局 Multivac 不是工作会话，不在这里列出。
  await expect(sessionList(page).getByText('Multivac', { exact: true })).toHaveCount(0);

  // 不显示计数与角标：筛选项只有文字。
  await expect(statusFilter(page).getByRole('button')).toHaveText(['进行中', '已归档', '全部']);
  await expect(kindFilter(page).getByRole('button')).toHaveText(['全部类型', '顶层', '栈式子会话']);
  await expect(statusFilter(page).getByRole('button', { name: '进行中' })).toHaveAttribute('aria-pressed', 'true');

  await statusFilter(page).getByRole('button', { name: '已归档' }).click();
  await expect(listTitles(page)).toHaveText(['旧草稿']);
  await expect(row(page, '旧草稿')).toContainText('默认工作区 · 顶层会话 · 已归档');
  await expect(detail(page)).toContainText('已归档（不在工作区列表里，可以恢复）');

  await statusFilter(page).getByRole('button', { name: '全部' }).click();
  await expect(listTitles(page)).toHaveText(['旧草稿', '资料整理', child, '导航结构']);

  await kindFilter(page).getByRole('button', { name: '栈式子会话' }).click();
  await expect(listTitles(page)).toHaveText([child]);
  // 选中项不在筛选结果中时，详情显示第一项：类型与栈式路径。
  await expect(detail(page).getByRole('heading', { name: child })).toBeVisible();
  await expect(detail(page)).toContainText(`栈式子会话栈式路径 · 导航结构 / ${child}`);
  await expect(detail(page)).toContainText('临时目录');

  await kindFilter(page).getByRole('button', { name: '顶层' }).click();
  await expect(listTitles(page)).toHaveText(['旧草稿', '资料整理', '导航结构']);

  // 按标题搜索：忽略大小写与首尾空白，与筛选叠加。
  await kindFilter(page).getByRole('button', { name: '全部类型' }).click();
  await search(page).fill('  fake multivac ');
  await expect(listTitles(page)).toHaveText([child]);
  await search(page).fill('导航');
  await expect(listTitles(page)).toHaveText(['导航结构']);
  await kindFilter(page).getByRole('button', { name: '栈式子会话' }).click();
  await expect(sessionList(page)).toHaveCount(0);
  await expect(sessionsPage(page).getByRole('heading', { name: '没有符合条件的会话' })).toBeVisible();

  // 页面里的筛选在离开管理再回来后保留。
  await returnToWork(page);
  await openManagement(page);
  await expect(search(page)).toHaveValue('导航');
  await expect(kindFilter(page).getByRole('button', { name: '栈式子会话' })).toHaveAttribute('aria-pressed', 'true');
});

test('会话页的改名、归档、恢复与工作区会话列表是同一份结果', async ({ page, request }) => {
  await enterWorkspace(page);
  await createSession(page, '导航结构');
  await createSession(page, '资料整理');

  await openManagement(page);
  await expect(listTitles(page)).toHaveText(['资料整理', '导航结构']);

  // 改名：Esc 放弃，Enter 保存；列表与详情随之更新。
  await row(page, '导航结构').click();
  await detail(page).getByRole('button', { name: '改名' }).click();
  const input = detail(page).getByLabel('会话名称');
  await expect(input).toBeFocused();
  await input.fill('不保存的名字');
  await input.press('Escape');
  await expect(detail(page).getByRole('heading', { name: '导航结构' })).toBeVisible();
  await expect(detail(page).getByRole('button', { name: '改名' })).toBeFocused();
  await detail(page).getByRole('button', { name: '改名' }).click();
  await input.fill('导航结构 v2');
  await input.press('Enter');
  await expect(detail(page).getByRole('heading', { name: '导航结构 v2' })).toBeVisible();
  await expect(listTitles(page)).toHaveText(['资料整理', '导航结构 v2']);

  // 归档走与工作区相同的确认卡；归档后离开“进行中”，焦点交给新的选中行。
  await row(page, '资料整理').click();
  await detail(page).getByRole('button', { name: '归档' }).click();
  const card = page.getByRole('dialog', { name: '归档「资料整理」' });
  await expect(card).toHaveAccessibleDescription(/归档后不再出现在工作区中。.*管理的“会话”页恢复/);
  await card.getByRole('button', { name: '归档', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(listTitles(page)).toHaveText(['导航结构 v2']);
  await expect(row(page, '导航结构 v2')).toBeFocused();

  // 回到工作区：不刷新就能看到同样的结果。
  await returnToWork(page);
  await expect(workspaceBar(page)).toBeVisible();
  await expect(panel(page, '导航结构 v2')).toBeVisible();
  await expect(panel(page, '资料整理')).toHaveCount(0);
  const menu = await openSessionMenu(page);
  await expect(menu.locator('.conversation-menu-list .conversation-menu-name strong')).toHaveText(['导航结构 v2']);
  await expect(menu.locator('.scene-archived-toggle')).toHaveText('已归档 1');

  // 在工作区恢复“资料整理”、归档“导航结构 v2”，会话页同样立即可见。
  await menu.locator('.scene-archived-toggle').click();
  await menu.getByRole('button', { name: '恢复「资料整理」' }).click();
  await menu.getByRole('button', { name: '归档「导航结构 v2」' }).click();
  await page.getByRole('dialog', { name: '归档「导航结构 v2」' }).getByRole('button', { name: '归档', exact: true }).click();
  await expect(menu.locator('.conversation-menu-list .conversation-menu-name strong')).toHaveText(['资料整理']);
  await closeSessionMenu(page);

  await openManagement(page);
  await expect(listTitles(page)).toHaveText(['资料整理']);
  await statusFilter(page).getByRole('button', { name: '已归档' }).click();
  await expect(listTitles(page)).toHaveText(['导航结构 v2']);

  // 在会话页恢复：离开“已归档”筛选后列表为空，焦点交给搜索框。
  await detail(page).getByRole('button', { name: '恢复', exact: true }).click();
  await expect(sessionsPage(page).getByRole('heading', { name: '没有符合条件的会话' })).toBeVisible();
  await expect(search(page)).toBeFocused();
  await statusFilter(page).getByRole('button', { name: '进行中' }).click();
  await expect(listTitles(page)).toHaveText(['资料整理', '导航结构 v2']);

  // 服务端记录与两处界面一致；工作区列表同样已恢复。
  expect((await listSessions(request)).map((session) => [session.title, session.archivedAt === null]))
    .toEqual([['导航结构 v2', true], ['资料整理', true]]);
  await returnToWork(page);
  await openSessionMenu(page);
  await expect(sessionMenu(page).locator('.conversation-menu-list .conversation-menu-name strong'))
    .toHaveText(['资料整理', '导航结构 v2']);
  await expect(sessionMenu(page).locator('.scene-archived-toggle')).toHaveCount(0);

  // 刷新后服务端现场与列表不变。
  await page.reload();
  await openManagement(page);
  await expect(listTitles(page)).toHaveText(['资料整理', '导航结构 v2']);
});

test('在工作区打开：离开管理并聚焦该会话；已归档的先恢复再打开；工作区尚未打开过也可以', async ({ page, request }) => {
  for (const [id, title] of [['open-a', '甲方案'], ['open-b', '乙方案'], ['open-c', '丙方案']] as const) {
    await createSessionByApi(request, id, title);
  }
  await request.post(`${fakeApiRoot}/api/sessions/open-b/archive`);
  await page.reload();

  // 从未进入过工作区：打开后工作区读取现场，再聚焦这个会话。
  await openManagement(page);
  await expect(listTitles(page)).toHaveText(['丙方案', '甲方案']);
  await row(page, '甲方案').click();
  await detail(page).getByRole('button', { name: '在工作区打开' }).click();
  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
  await expect(workspaceBar(page)).toBeVisible();
  await expect(page.locator('.conversation-panel')).toHaveCount(1);
  await expect(panel(page, '甲方案')).toBeVisible();
  await expect(workspaceBar(page).getByRole('button', { name: '聚焦' })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel(page, '甲方案').getByLabel('Multivac 草稿')).toBeFocused();

  // 已归档的会话：按钮写明会先恢复；恢复后回到原工作区并聚焦。
  await workspaceBar(page).getByRole('button', { name: '并排' }).click();
  await openManagement(page);
  await statusFilter(page).getByRole('button', { name: '已归档' }).click();
  await expect(detail(page).getByRole('button', { name: '在工作区打开', exact: true })).toHaveCount(0);
  await detail(page).getByRole('button', { name: '恢复并在工作区打开' }).click();
  await expect(panel(page, '乙方案')).toBeVisible();
  await expect(page.locator('.conversation-panel')).toHaveCount(1);
  await expect(panel(page, '乙方案').getByLabel('Multivac 草稿')).toBeFocused();
  expect((await listSessions(request)).find((session) => session.sessionId === 'open-b')?.archivedAt).toBeNull();
  await openSessionMenu(page);
  await expect(sessionMenu(page).locator('.scene-archived-toggle')).toHaveCount(0);
  await expect(sessionMenu(page).locator('.scene-row.selected strong')).toHaveText('乙方案');
  await closeSessionMenu(page);

  // 刷新后工作区现场保存了这次聚焦。
  await page.reload();
  await enterWorkspace(page);
  await expect(page.locator('.conversation-panel')).toHaveCount(1);
  await expect(panel(page, '乙方案')).toBeVisible();
});

test('会话页按自身可用宽度排版：侧栏打开或窄屏时不横向溢出', async ({ page, request }) => {
  await createSessionByApi(request, 'layout-a', '一个名字相当长、用来检查换行与省略的会话标题');
  await page.reload();
  await page.setViewportSize({ width: 1180, height: 820 });
  await openManagement(page);

  const overflow = () => sessionsPage(page).evaluate((element) => element.scrollWidth - element.clientWidth);
  const stacked = async () => {
    const [list, info] = await Promise.all([
      sessionList(page).boundingBox(),
      detail(page).boundingBox(),
    ]);
    return info!.y >= list!.y + list!.height - 1;
  };
  expect(await overflow()).toBeLessThanOrEqual(0);
  expect(await stacked()).toBe(false);

  // 侧栏打开把页面挤窄后，列表与详情改为上下排列。
  await page.getByRole('button', { name: 'Multivac', exact: true }).click();
  await expect(page.locator('.management-shell .multivac-sidebar')).toBeVisible();
  await expect.poll(stacked).toBe(true);
  expect(await overflow()).toBeLessThanOrEqual(0);

  await page.setViewportSize({ width: 600, height: 820 });
  await expect.poll(overflow).toBeLessThanOrEqual(0);
  await expect(detail(page).getByRole('button', { name: '在工作区打开' })).toBeVisible();
});
