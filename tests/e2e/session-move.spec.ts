import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Project, ToolAuthorizationRequest, WorkspaceSession } from '@multivac/contracts';
import { fakeApiRoot, openCreationDialog, openPanel, resetE2eState, workspaceRail, currentWorkspaceGroup, ensureWorkspaceRail, railSessionAction } from './test-state.js';

/**
 * 会话归入项目：三个入口（标题栏菜单、工作区会话列表、设置 · 归档页）共用一张确认卡；
 * 卡上写明目录与执行边界的变化，临时目录中的文件可选择移入（同名不覆盖）；运行中（含等待授权）不能归入；
 * 归入后会话在项目工作区中、以项目目录继续，重启后仍在项目目录。
 */

const workspaceBar = (page: Page) => page.locator('.workspace-page');
const switcherTrigger = (page: Page) => workspaceRail(page).locator('.rail-folder.active .rail-folder-toggle');
const sessionMenu = (page: Page) => currentWorkspaceGroup(page);
const moveCard = (page: Page, title: string) => page.getByRole('dialog', { name: `把「${title}」归入项目` });
const notice = (page: Page) => page.locator('.workspace-notice');
const directoryTrigger = (scope: Locator) => scope.locator('.session-directory-trigger');

function panel(page: Page, title: string): Locator {
  return page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

async function createProject(request: APIRequestContext, name: string, directory?: string): Promise<Project> {
  const response = await request.post(`${fakeApiRoot}/api/projects`, { data: { name, ...(directory ? { directory } : {}) } });
  expect(response.status()).toBe(201);
  return (await response.json() as { project: Project }).project;
}

async function sessionById(request: APIRequestContext, sessionId: string): Promise<WorkspaceSession> {
  const response = await request.get(`${fakeApiRoot}/api/sessions?workspace=all&archived=include`);
  expect(response.ok()).toBe(true);
  return (await response.json() as { sessions: WorkspaceSession[] }).sessions.find((item) => item.sessionId === sessionId)!;
}

async function authorizations(request: APIRequestContext, sessionId: string): Promise<ToolAuthorizationRequest[]> {
  const response = await request.get(`${fakeApiRoot}/api/sessions/${sessionId}/authorizations`);
  expect(response.status()).toBe(200);
  return (await response.json() as { requests: ToolAuthorizationRequest[] }).requests;
}

async function createSession(page: Page, title: string): Promise<string> {
  await openCreationDialog(page);
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill(title);
  const created = page.waitForResponse((response) =>
    response.url().endsWith('/api/sessions') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
  return (await (await created).json() as WorkspaceSession).sessionId;
}

async function send(scope: Locator, text: string): Promise<void> {
  const draft = scope.getByLabel('Multivac 草稿');
  await draft.fill(text);
  await draft.press('Enter');
}

/** 发送越界写入场景，等到服务端多出一条授权请求；返回这条请求（其中有本轮使用的工作目录）。 */
async function sendOutsideWrite(scope: Locator, request: APIRequestContext, sessionId: string): Promise<ToolAuthorizationRequest> {
  const before = (await authorizations(request, sessionId)).length;
  await send(scope, '越界写入场景');
  await expect.poll(async () => (await authorizations(request, sessionId)).length).toBe(before + 1);
  return (await authorizations(request, sessionId)).at(-1)!;
}

/** 真实重启服务：旧进程返回 202 后退出，等到新进程可以提供页面状态。 */
async function restartServer(request: APIRequestContext): Promise<void> {
  expect((await request.post(`${fakeApiRoot}/api/__e2e/restart`)).status()).toBe(202);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await expect.poll(async () => {
    try {
      return (await request.get(`${fakeApiRoot}/api/assistant/page-state`, { timeout: 1_000 })).status();
    } catch {
      return 0;
    }
  }, { timeout: 30_000 }).toBe(200);
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  await page.goto('/');
  await openPanel(page, 'workspace');
});

test('标题栏菜单归入项目：卡上写明目录与边界的变化，临时目录文件移入且同名不覆盖；归入后在项目中继续发送，重启后仍在项目目录', async ({ page, request }) => {
  test.setTimeout(90_000);
  const project = await createProject(request, '移入目标');
  const projectDir = project.directories[0]!.path;
  writeFileSync(join(projectDir, 'README.md'), '项目说明');
  await page.reload();
  await openPanel(page, 'workspace');

  const sessionId = await createSession(page, '临时探索');
  const scope = panel(page, '临时探索');
  await send(scope, '归入前的第一条消息');
  await expect(scope.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  const tempDir = (await sessionById(request, sessionId)).workingDirectory.path;
  writeFileSync(join(tempDir, 'notes.md'), '探索记录');
  writeFileSync(join(tempDir, 'README.md'), '临时说明');
  mkdirSync(join(tempDir, 'data'));
  writeFileSync(join(tempDir, 'data', 'raw.csv'), '1,2');

  // 标题栏菜单只有已实现的操作；Esc 收起并把焦点还给按钮。
  const more = scope.getByRole('button', { name: '「临时探索」的更多操作' });
  await more.click();
  const menu = page.getByRole('menu', { name: '「临时探索」的更多操作' });
  await expect(menu.getByRole('menuitem')).toHaveText(['归入项目…', '授权', '归档']);
  await expect(menu.getByRole('menuitem', { name: '归入项目…' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  await more.click();
  await menu.getByRole('menuitem', { name: '归入项目…' }).click();

  const card = moveCard(page, '临时探索');
  await expect(card).toHaveAttribute('aria-modal', 'true');
  await expect(card.getByLabel('归入的项目')).toHaveValue(project.projectId);
  await expect(card.getByLabel('归入的项目').locator('option')).toHaveText(['移入目标']);
  const change = card.locator('.move-change');
  await expect(change.locator('[data-directory-kind="session-temp"]')).toContainText(`现在临时目录${tempDir}`);
  await expect(change.locator('[data-directory-kind="project-managed"]')).toContainText(`归入后项目托管目录${projectDir}`);
  await expect(card).toContainText('之后按「移入目标」的项目目录执行：由 Multivac 托管，长期保留、不会自动清理，目录内的读写与命令自动执行。读取、修改或写入目录外的文件需要你确认。');
  await expect(card).toContainText('本会话内记住的授权继续有效；「移入目标」中“本项目内始终允许”的授权随即适用。');
  const moveFiles = card.getByRole('checkbox', { name: '把临时目录里的 3 项一并移入项目目录' });
  await expect(moveFiles).toBeChecked();
  await expect(card).toContainText('README.md、data、notes.md');
  await expect(card).toContainText('README.md 与项目目录中已有的同名，不覆盖，留在原临时目录，原临时目录随之保留，从归入时起保留 30 天后移到废纸篓。');
  await moveFiles.uncheck();
  await expect(card).toContainText('不移入：文件留在原临时目录，不再是会话的工作目录；从归入时起保留 30 天后移到废纸篓。');
  await moveFiles.check();
  await expect(card.locator('.move-warning')).toHaveCount(0);

  await card.getByRole('button', { name: '归入项目' }).click();
  await expect(card).toHaveCount(0);
  // 会话离开默认工作区，结果提示写明移入与留下的文件，焦点交给“到项目中打开”。
  await expect(panel(page, '临时探索')).toHaveCount(0);
  await expect(notice(page)).toContainText('已把「临时探索」归入「移入目标」，之后在项目目录中继续。2 项已移入项目目录。');
  await expect(notice(page)).toContainText(`README.md 与项目目录中已有的同名或没能移动，留在原临时目录 ${tempDir}，从现在起保留 30 天后移到废纸篓。`);
  const open = notice(page).getByRole('button', { name: '在「移入目标」中打开' });
  await expect(open).toBeFocused();
  expect(readFileSync(join(projectDir, 'notes.md'), 'utf8')).toBe('探索记录');
  expect(readFileSync(join(projectDir, 'data', 'raw.csv'), 'utf8')).toBe('1,2');
  expect(readFileSync(join(projectDir, 'README.md'), 'utf8')).toBe('项目说明');
  expect(readdirSync(tempDir)).toEqual(['README.md']);
  const moved = await sessionById(request, sessionId);
  expect(moved.workspaceId).toBe(project.projectId);
  expect(moved.workingDirectory).toEqual({ kind: 'project-managed', path: projectDir });

  // 到项目工作区中打开：同一个会话，历史仍在，标题栏显示项目目录。
  await open.click();
  await expect(switcherTrigger(page)).toContainText('移入目标');
  const inProject = panel(page, '临时探索');
  await expect(inProject).toBeVisible();
  await expect(directoryTrigger(inProject)).toHaveAccessibleName(`工作目录：项目托管目录 ${projectDir}`);
  await expect(inProject.locator('article.chat-row.user')).toContainText(['归入前的第一条消息']);

  // 继续发送：本轮以项目目录为工作目录（越界判定按项目目录进行）。
  const request1 = await sendOutsideWrite(inProject, request, sessionId);
  expect(request1.workingDirectory).toEqual({ kind: 'project-managed', path: projectDir });
  const pending = inProject.locator(`[data-request-id="${request1.requestId}"]`);
  await expect(pending).toContainText(projectDir);
  await pending.getByRole('button', { name: '拒绝' }).click();
  await expect(inProject.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();

  // 重启后仍在项目工作区与项目目录。
  await restartServer(request);
  await page.reload();
  await openPanel(page, 'workspace');
  await expect(switcherTrigger(page)).toContainText('移入目标');
  const restarted = panel(page, '临时探索');
  await expect(directoryTrigger(restarted)).toHaveAccessibleName(`工作目录：项目托管目录 ${projectDir}`);
  const request2 = await sendOutsideWrite(restarted, request, sessionId);
  expect(request2.workingDirectory).toEqual({ kind: 'project-managed', path: projectDir });
  await restarted.locator(`[data-request-id="${request2.requestId}"]`).getByRole('button', { name: '拒绝' }).click();
  await expect(restarted.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
});

test('运行中（等待授权）不能归入：会话列表入口打开的卡片说明先停止、确认不可执行，服务端同样拒绝；这一轮结束后即可归入', async ({ page, request }) => {
  const project = await createProject(request, '等待中的项目');
  await page.reload();
  await openPanel(page, 'workspace');
  const sessionId = await createSession(page, '等待授权');
  const scope = panel(page, '等待授权');
  const tempDir = (await sessionById(request, sessionId)).workingDirectory.path;
  const pending = await sendOutsideWrite(scope, request, sessionId);
  expect(pending.status).toBe('pending');
  await expect(scope.getByRole('status').getByText('等待你的授权')).toBeVisible();

  // 会话列表的行操作：列表先收起，再打开同一张确认卡。
  await ensureWorkspaceRail(page);
  await railSessionAction(page, '等待授权', '归入项目…');
  await expect(sessionMenu(page)).toBeVisible();
  const card = moveCard(page, '等待授权');
  await expect(card.locator('.move-warning')).toHaveText('这个会话正在运行（或在等待你的授权）。请先停止这一轮，再归入项目。');
  await expect(card.getByRole('button', { name: '归入项目' })).toBeDisabled();
  // 临时目录是空的：卡上说明归入后删除。
  await expect(card).toContainText('临时目录是空的，归入后删除。');

  // 服务端在会话互斥区内复核空闲，同样拒绝，什么都不改。
  const direct = await request.post(`${fakeApiRoot}/api/sessions/${sessionId}/move-to-project`, {
    data: { projectId: project.projectId, moveFiles: true },
  });
  expect(direct.status()).toBe(422);
  expect((await direct.json() as { error: { message: string } }).error.message).toBe('会话正在运行（或在等待授权），请先停止后再归入项目。');
  expect((await sessionById(request, sessionId)).workspaceId).toBe('default');

  // 这一轮结束（在别处拒绝了授权）：卡片随会话状态更新，可以归入。
  const decided = await request.post(`${fakeApiRoot}/api/sessions/${sessionId}/authorizations/${pending.requestId}/decision`, {
    data: { decision: 'deny' },
  });
  expect(decided.ok()).toBe(true);
  await expect(card.locator('.move-warning')).toHaveCount(0);
  const confirm = card.getByRole('button', { name: '归入项目' });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(card).toHaveCount(0);
  await expect(notice(page)).toContainText('已把「等待授权」归入「等待中的项目」，之后在项目目录中继续。空的临时目录已删除。');
  expect(existsSync(tempDir)).toBe(false);
  expect((await sessionById(request, sessionId)).workspaceId).toBe(project.projectId);
});

test('原临时目录正被其他项目挂载：归入卡与结果提示（工作区、会话页）写明保留原处、不会被清理，不说移到废纸篓', async ({ page, request }) => {
  const target = await createProject(request, '归入目标');
  const sessionId = await createSession(page, '被挂载的会话');
  const tempDir = (await sessionById(request, sessionId)).workingDirectory.path;
  writeFileSync(join(tempDir, 'notes.md'), '笔记');
  // 这个临时目录被另一个项目挂载为目录；归入的是“归入目标”。
  await createProject(request, '挂载了临时目录', tempDir);
  await page.reload();
  await openPanel(page, 'workspace');

  const kept = '原临时目录正被项目或其他会话使用，保留原处，不会被清理。';
  await panel(page, '被挂载的会话').getByRole('button', { name: '「被挂载的会话」的更多操作' }).click();
  await page.getByRole('menu', { name: '「被挂载的会话」的更多操作' }).getByRole('menuitem', { name: '归入项目…' }).click();
  const card = moveCard(page, '被挂载的会话');
  await card.getByLabel('归入的项目').selectOption(target.projectId);
  const moveFiles = card.getByRole('checkbox', { name: '把临时目录里的 1 项一并移入项目目录' });
  await expect(card).toContainText(`同名的不会覆盖；全部移入后，${kept}`);
  await moveFiles.uncheck();
  await expect(card).toContainText(`不移入：文件留在原临时目录，不再是会话的工作目录；${kept}`);
  await expect(card).not.toContainText('废纸篓');
  await card.getByRole('button', { name: '归入项目' }).click();
  await expect(card).toHaveCount(0);
  await expect(notice(page)).toHaveText(new RegExp(`已把「被挂载的会话」归入「归入目标」，之后在项目目录中继续。原临时目录 ${tempDir} 正被项目或其他会话使用，保留原处，不会被清理。`));
  await expect(notice(page)).not.toContainText('废纸篓');
  expect(readFileSync(join(tempDir, 'notes.md'), 'utf8')).toBe('笔记');

  // 设置 · 归档页归入空的、被挂载的临时目录：卡上不说“归入后删除”，结果同样写明保留。
  const emptyId = await createSession(page, '空的被挂载');
  const emptyDir = (await sessionById(request, emptyId)).workingDirectory.path;
  await createProject(request, '挂载了空目录', emptyDir);
  await page.reload();
  await openPanel(page, 'workspace');
  await railSessionAction(page, '空的被挂载', '归入项目…');
  const emptyCard = moveCard(page, '空的被挂载');
  await emptyCard.getByLabel('归入的项目').selectOption(target.projectId);
  await expect(emptyCard).toContainText(`临时目录是空的；${kept}`);
  await emptyCard.getByRole('button', { name: '归入项目' }).click();
  await expect(emptyCard).toHaveCount(0);
  await expect(notice(page)).toContainText(
    `已把「空的被挂载」归入「归入目标」，之后在项目目录中继续。原临时目录 ${emptyDir} 正被项目或其他会话使用，保留原处，不会被清理。`,
  );
  expect(existsSync(emptyDir)).toBe(true);
});
