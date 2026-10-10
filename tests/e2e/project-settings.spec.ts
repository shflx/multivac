import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { escapeFromManagement, fakeApiRoot, openCreationDialog, openPanel, resetE2eState, workspaceRail, ensureWorkspaceRail } from './test-state.js';

interface ListedSession {
  sessionId: string;
  title: string;
  workspaceId: string;
  workingDirectory: { kind: string; path: string };
}

interface ListedProject {
  projectId: string;
  name: string;
  directories: Array<{ kind: string; path: string }>;
  defaultConstraints: string;
}

const workspaceBar = (page: Page) => page.locator('.workspace-page');
const switcherTrigger = (page: Page) => workspaceRail(page).locator('.rail-folder.active .rail-folder-toggle');
const switcherMenu = (page: Page) => workspaceRail(page);
const newProjectCard = (page: Page) => page.getByRole('dialog', { name: '新建项目' });
const projectsPage = (page: Page) => page.getByRole('main', { name: '项目' });
const projectList = (page: Page) => projectsPage(page).getByRole('list', { name: '项目列表' });
const detail = (page: Page) => projectsPage(page).locator('.project-detail');
const directories = (page: Page) => detail(page).getByRole('list', { name: '项目目录' });

async function createProjectByApi(request: APIRequestContext, name: string, directory?: string): Promise<ListedProject> {
  const response = await request.post(`${fakeApiRoot}/api/projects`, { data: { name, ...(directory ? { directory } : {}) } });
  expect(response.status()).toBe(201);
  return (await response.json() as { project: ListedProject }).project;
}

async function createSessionByApi(request: APIRequestContext, sessionId: string, title: string, workspaceId?: string) {
  const response = await request.post(`${fakeApiRoot}/api/sessions`, {
    data: { sessionId, title, ...(workspaceId ? { workspaceId } : {}) },
  });
  expect(response.status()).toBe(201);
}

async function listSessions(request: APIRequestContext): Promise<ListedSession[]> {
  const response = await request.get(`${fakeApiRoot}/api/sessions?workspace=all&archived=include`);
  expect(response.ok()).toBe(true);
  return (await response.json() as { sessions: ListedSession[] }).sessions;
}

async function listProjects(request: APIRequestContext): Promise<ListedProject[]> {
  const response = await request.get(`${fakeApiRoot}/api/projects`);
  expect(response.ok()).toBe(true);
  return (await response.json() as { projects: ListedProject[] }).projects;
}

async function enterWorkspace(page: Page): Promise<void> {
  await openPanel(page, 'workspace');
  await expect(switcherTrigger(page)).toBeVisible();
}

async function openSwitcherFooter(page: Page, label: '新建项目…' | '项目设置'): Promise<void> {
  await ensureWorkspaceRail(page);
  if (label === '新建项目…') await workspaceRail(page).getByRole('button', { name: label }).click();
  else {
    const workspaceName = await switcherTrigger(page).textContent();
    await openProjectsPage(page);
    const project = projectList(page).getByRole('button').filter({ hasText: workspaceName?.trim() ?? '' });
    if (workspaceName?.trim() !== '默认工作区' && await project.count()) await project.click();
  }
}

async function openProjectsPage(page: Page): Promise<void> {
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '项目' }).click();
  await expect(projectsPage(page)).toBeVisible();
}

/** 在确认卡上填写目录并等服务端核对完：通过时给出路径，不通过时写明原因。 */
async function fillDirectory(page: Page, value: string): Promise<void> {
  await newProjectCard(page).getByLabel('项目目录').fill(value);
  await expect(newProjectCard(page).locator('.directory-rule-checking')).toHaveCount(0);
}

let tempRoot: string;

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  // 挂载目录一律在测试自己的临时目录下创建，不触碰用户主目录。
  tempRoot = mkdtempSync(join(tmpdir(), 'multivac-e2e-projects-'));
  await page.goto('/');
});

test.afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

test('从工作区切换菜单新建托管项目：确认卡写明目录、类型与执行规则，确认后出现同名工作区并进入；重名在卡上说明', async ({ page, request }) => {
  await enterWorkspace(page);
  await openSwitcherFooter(page, '新建项目…');

  const card = newProjectCard(page);
  await expect(card).toHaveAttribute('aria-modal', 'true');
  await expect(card.getByRole('heading', { name: '新建项目' })).toBeVisible();
  await expect(card).toContainText('确认后自动带一个同名工作区');
  await expect(card).toContainText('这个目录内的修改将自动执行。');
  await expect(card.getByLabel('项目名称')).toBeFocused();
  // 名称为空时不能确认；不填目录时是托管目录。
  await expect(card.getByRole('button', { name: '创建项目' })).toBeDisabled();
  await expect(card.locator('.directory-rule strong')).toHaveText('项目托管目录');

  // 填写名称后给出托管目录的完整路径（工作文件根目录的 projects/ 下），此时还没有创建。
  // E2E 重置不删除托管目录，重复运行时磁盘上已有同名目录，路径带序号。
  await card.getByLabel('项目名称').fill('读书笔记');
  await expect(card.locator('.directory-rule code')).toHaveText(/\/projects\/读书笔记(-\d+)?$/u);
  const managedPath = await card.locator('.directory-rule code').textContent();
  expect(await listProjects(request)).toEqual([]);

  // Esc 取消不创建；再次打开从空白开始。
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(workspaceRail(page).getByRole('button', { name: '新建项目…' })).toBeFocused();
  expect(await listProjects(request)).toEqual([]);

  await openSwitcherFooter(page, '新建项目…');
  await expect(card.getByLabel('项目名称')).toHaveValue('');
  await card.getByLabel('项目名称').fill('读书笔记');
  await expect(card.locator('.directory-rule code')).toHaveText(managedPath!);
  await card.getByLabel('项目名称').press('Enter');
  await expect(card).toHaveCount(0);

  // 立即出现同名工作区并进入它。
  await expect(switcherTrigger(page)).toContainText('读书笔记');
  await expect(page.getByRole('heading', { name: '读书笔记还没有会话' })).toBeVisible();
  await ensureWorkspaceRail(page);
  const options = switcherMenu(page).locator('.rail-group:not([data-workspace-id="recent"]) .rail-folder-toggle');
  await expect(options.locator('.nav-label')).toHaveText(['读书笔记', '默认工作区']);
  await expect(workspaceRail(page).locator('.rail-folder.active')).toContainText('读书笔记');
  await page.keyboard.press('Escape');
  const [project] = await listProjects(request);
  expect(project).toMatchObject({ name: '读书笔记', directories: [{ kind: 'managed', path: managedPath }] });

  // 名称不区分大小写地唯一：在卡上写明原因，不能确认。
  await openSwitcherFooter(page, '新建项目…');
  await card.getByLabel('项目名称').fill('读书笔记');
  await expect(card.locator('.confirm-card-error')).toHaveText('已有同名项目「读书笔记」，请换一个名称。');
  await expect(card.getByRole('button', { name: '创建项目' })).toBeDisabled();
  await card.getByRole('button', { name: '取消' }).click();
  expect(await listProjects(request)).toHaveLength(1);
});

test('在设置 · 项目新建挂载项目：非法目录在卡上说明原因且不能创建，合法目录创建后选中新项目', async ({ page, request }) => {
  const code = join(tempRoot, 'code');
  mkdirSync(code);
  writeFileSync(join(tempRoot, 'notes.txt'), 'x');
  await openProjectsPage(page);
  await expect(projectsPage(page).getByRole('heading', { name: '还没有项目' })).toBeVisible();
  // “新建项目…”只在页头的主要操作位，空状态里不再重复放一个。
  await expect(projectsPage(page).locator('.projects-page').getByRole('button')).toHaveCount(0);
  await projectsPage(page).locator('.management-page-actions').getByRole('button', { name: '新建项目…' }).click();

  const card = newProjectCard(page);
  await card.getByLabel('项目名称').fill('Multivac 开发');
  const error = card.locator('.confirm-card-error');
  const confirmButton = card.getByRole('button', { name: '创建项目' });
  const rejected: Array<[string, string | RegExp]> = [
    ['/', '不能挂载根目录：它包含整台电脑的文件，请选择具体的项目目录。'],
    ['code', /^目录必须是绝对路径/u],
    [join(tempRoot, 'missing'), `目录不存在：${join(tempRoot, 'missing')}`],
    [join(tempRoot, 'notes.txt'), `不是目录：${join(tempRoot, 'notes.txt')}`],
  ];
  for (const [value, reason] of rejected) {
    await fillDirectory(page, value);
    await expect(error).toHaveText(reason);
    await expect(confirmButton).toBeDisabled();
  }
  expect(await listProjects(request)).toEqual([]);

  // 合法目录：给出规范化后的路径与挂载目录的规则。
  await fillDirectory(page, `${code}/`);
  await expect(error).toHaveCount(0);
  await expect(card.locator('.directory-rule strong')).toHaveText('挂载目录');
  await expect(card.locator('.directory-rule code')).toHaveText(code);
  await expect(card.locator('.directory-rule small').last()).toHaveText('你已有的目录，目录内的修改自动执行，目录外的修改需要确认。');

  // 确认时服务端再校验一次：目录在核对之后被移走，原因留在卡上，可以改正后重试。
  rmSync(code, { recursive: true });
  await confirmButton.click();
  await expect(error).toHaveText(`目录不存在：${code}`);
  await expect(card).toBeVisible();
  mkdirSync(code);
  await fillDirectory(page, code);
  await expect(error).toHaveCount(0);
  await confirmButton.click();
  await expect(card).toHaveCount(0);

  // 新项目在列表中并被选中；详情写明挂载目录。
  await expect(projectList(page).getByRole('button')).toHaveCount(1);
  await expect(projectList(page).getByRole('button', { name: /Multivac 开发/ })).toHaveAttribute('aria-current', 'true');
  await expect(detail(page).getByRole('heading', { name: 'Multivac 开发' })).toBeVisible();
  await expect(directories(page).getByRole('listitem')).toHaveCount(1);
  await expect(directories(page).getByRole('listitem').first()).toContainText(`挂载目录主目录${code}`);
  expect(await listProjects(request)).toEqual([expect.objectContaining({ name: 'Multivac 开发', directories: [{ kind: 'mounted', path: code }] })]);

  // 同名工作区随即出现在工作区切换菜单中。
  await escapeFromManagement(page);
  await enterWorkspace(page);
  await ensureWorkspaceRail(page);
  await expect(switcherMenu(page).locator('.rail-group:not([data-workspace-id="recent"]) .rail-folder-toggle .nav-label')).toHaveText(['Multivac 开发', '默认工作区']);
});

test('设置 · 项目：改名、挂载与卸载目录、切换主目录、默认约束；改目录后新会话用新目录，已有会话不变', async ({ page, request }) => {
  const project = await createProjectByApi(request, '技术研究');
  const managed = project.directories[0]!.path;
  const docs = join(tempRoot, 'docs');
  mkdirSync(docs);
  await createSessionByApi(request, 'before-change', '改目录之前', project.projectId);
  await page.reload();
  await enterWorkspace(page);

  // 默认工作区中的“项目设置”打开项目页；在项目工作区中直达当前项目。
  await openSwitcherFooter(page, '项目设置');
  await expect(page.locator('.shell-page-name')).toHaveText('项目');
  await expect(projectList(page).getByRole('button', { name: /技术研究/ })).toHaveAttribute('aria-current', 'true');
  await expect(projectList(page)).toContainText('1 个会话');
  await escapeFromManagement(page);
  await ensureWorkspaceRail(page);
  await switcherMenu(page).getByRole('button', { name: /^技术研究/ }).click();
  await openSwitcherFooter(page, '项目设置');
  await expect(detail(page).getByRole('heading', { name: '技术研究' })).toBeVisible();
  await expect(detail(page)).toContainText('修改目录只影响之后新建的会话；已有会话继续使用创建时的工作目录。');

  // 改名：Esc 放弃，Enter 保存；同名工作区随之改名。
  await detail(page).getByRole('button', { name: '改名' }).click();
  await detail(page).getByLabel('项目名称').fill('放弃的名字');
  await detail(page).getByLabel('项目名称').press('Escape');
  await expect(detail(page).getByRole('heading', { name: '技术研究' })).toBeVisible();
  await expect(detail(page).getByRole('button', { name: '改名' })).toBeFocused();
  await detail(page).getByRole('button', { name: '改名' }).click();
  await detail(page).getByLabel('项目名称').fill('技术调研');
  await detail(page).getByLabel('项目名称').press('Enter');
  await expect(detail(page).getByRole('heading', { name: '技术调研' })).toBeVisible();
  await expect(projectList(page).getByRole('button', { name: /技术调研/ })).toBeVisible();
  await expect(detail(page).locator('.project-title .saved-mark')).toHaveText('已保存');

  // 只有一个目录时不能卸载。
  const unmountManaged = detail(page).getByRole('button', { name: `卸载 ${managed}` });
  await expect(unmountManaged).toBeDisabled();

  // 挂载非法目录：原因留在确认卡上，不挂载。
  const mountInput = detail(page).getByLabel('要挂载的目录');
  await mountInput.fill('/');
  await detail(page).getByRole('button', { name: '挂载' }).click();
  const mountCard = page.getByRole('dialog', { name: '挂载目录' });
  await expect(mountCard).toContainText('这个目录内的修改将自动执行');
  await mountCard.getByRole('button', { name: '挂载' }).click();
  await expect(mountCard.locator('.confirm-card-error')).toHaveText('不能挂载根目录：它包含整台电脑的文件，请选择具体的项目目录。');
  await mountCard.getByRole('button', { name: '取消' }).click();
  await expect(mountCard).toHaveCount(0);
  await expect(directories(page).getByRole('listitem')).toHaveCount(1);

  // 挂载合法目录：经确认卡确认后排在主目录之后。
  await mountInput.fill(docs);
  await mountInput.press('Enter');
  await expect(mountCard).toContainText(docs);
  await mountCard.getByRole('button', { name: '挂载' }).click();
  await expect(mountCard).toHaveCount(0);
  await expect(mountInput).toHaveValue('');
  const items = directories(page).getByRole('listitem');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText(`项目托管目录主目录${managed}`);
  await expect(items.nth(1)).toContainText(`挂载目录${docs}`);

  // 设为主目录，再卸载托管目录（目录本身不删除）。
  await items.nth(1).getByRole('button', { name: '设为主目录' }).click();
  await expect(items.nth(0)).toContainText(`挂载目录主目录${docs}`);
  await expect(detail(page).getByRole('button', { name: `卸载 ${docs}` })).toBeFocused();
  await detail(page).getByRole('button', { name: `卸载 ${managed}` }).click();
  const unmountCard = page.getByRole('dialog', { name: '卸载目录' });
  await expect(unmountCard).toContainText(managed);
  await expect(unmountCard).toContainText('目录本身和其中的文件不会被删除');
  await expect(unmountCard).toContainText('已有会话继续使用创建时的工作目录。');
  await unmountCard.getByRole('button', { name: '卸载' }).click();
  await expect(unmountCard).toHaveCount(0);
  await expect(items).toHaveCount(1);
  await expect(detail(page).getByRole('button', { name: `卸载 ${docs}` })).toBeDisabled();

  // 默认约束：保存后写明“已保存”，刷新后仍在。
  const constraints = detail(page).getByRole('textbox', { name: '默认约束' });
  const saveConstraints = detail(page).getByRole('button', { name: '保存', exact: true });
  await expect(saveConstraints).toBeDisabled();
  await constraints.fill('只修改 docs/ 下的文件。');
  await saveConstraints.click();
  await expect(detail(page).locator('.project-constraints-actions .saved-mark')).toHaveText('已保存');
  await expect(saveConstraints).toBeDisabled();
  expect(await listProjects(request)).toEqual([expect.objectContaining({
    name: '技术调研',
    directories: [{ kind: 'mounted', path: docs }],
    defaultConstraints: '只修改 docs/ 下的文件。',
  })]);

  // 回到工作区：工作区已改名，新会话使用新的主目录，已有会话不变。
  await escapeFromManagement(page);
  await expect(switcherTrigger(page)).toContainText('技术调研');
  await openCreationDialog(page);
  const creation = page.getByRole('dialog', { name: '创建新会话' });
  await expect(creation.locator('.creation-note code')).toHaveText(docs);
  await creation.getByLabel('会话名称').fill('改目录之后');
  await creation.getByRole('button', { name: '创建' }).click();
  await expect(creation).toHaveCount(0);
  await expect.poll(async () => (await listSessions(request)).map((session) => [session.title, session.workingDirectory])).toEqual([
    ['改目录之前', { kind: 'project-managed', path: managed }],
    ['改目录之后', { kind: 'project-mounted', path: docs }],
  ]);

  await page.reload();
  await openProjectsPage(page);
  await expect(detail(page).getByRole('heading', { name: '技术调研' })).toBeVisible();
  await expect(detail(page).getByRole('textbox', { name: '默认约束' })).toHaveValue('只修改 docs/ 下的文件。');
  await expect(projectList(page)).toContainText('2 个会话');
});

test('设置 · 项目按原型排版：“新建项目…”在页头，列表 300px 带箭头与提示，详情头写明工作目录，默认约束的说明在输入框下方', async ({ page, request }) => {
  const docs = join(tempRoot, 'docs');
  mkdirSync(docs);
  await createProjectByApi(request, '技术研究');
  await createProjectByApi(request, 'Multivac 开发', docs);
  await page.reload();
  await openProjectsPage(page);

  // 页头的主要操作位：原型 .secondary 尺寸；列表下只剩一句提示。
  const newButton = projectsPage(page).locator('.management-page-actions').getByRole('button', { name: '新建项目…' });
  await expect(newButton).toBeVisible();
  expect((await newButton.boundingBox())!.height).toBe(36);
  await expect(newButton).toHaveCSS('font-size', '15px');
  await expect(projectsPage(page).locator('.projects-page').getByRole('button', { name: '新建项目…' })).toHaveCount(0);
  await expect(projectsPage(page).locator('.settings-list-hint')).toHaveText('也可以对 Multivac 说“把 ~/code/notes 作为项目”，是同一张确认卡。');

  // 列表 300px；行：名称 15px / 700，右侧箭头，选中底色与竖条。
  expect((await projectsPage(page).locator('.project-list-pane').boundingBox())!.width).toBeCloseTo(300, 0);
  const rows = projectList(page).getByRole('button');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('svg')).toHaveCount(2);
  await expect(rows.nth(0).locator('strong')).toHaveCSS('font-size', '15px');
  await expect(rows.nth(0).locator('strong')).toHaveCSS('font-weight', '700');
  await expect(rows.nth(0)).toHaveCSS('box-shadow', /inset/u);
  expect((await rows.nth(0).boundingBox())!.height).toBeGreaterThanOrEqual(60);

  // 详情头：标题旁是行内的“改名”，下面写明同名工作区、项目中的会话在哪里工作，以及主目录。
  await rows.nth(1).click();
  const rename = detail(page).getByRole('button', { name: '改名' });
  await expect(rename).toHaveClass(/inline-link/u);
  await expect(rename).toHaveCSS('font-size', '11px');
  const [heading, link] = await Promise.all([detail(page).getByRole('heading', { name: 'Multivac 开发' }).boundingBox(), rename.boundingBox()]);
  expect(link!.x).toBeGreaterThan(heading!.x + heading!.width);
  expect(Math.abs(link!.y + link!.height / 2 - (heading!.y + heading!.height / 2))).toBeLessThan(4);
  await expect(detail(page).locator('.project-title-note')).toHaveText('同名工作区随项目改名，项目中的会话在项目目录里工作。');
  await expect(detail(page).locator('.project-working-directory')).toHaveText(`工作目录：挂载目录 ${basename(docs)}`);

  // 目录、默认约束与权限：小节标题 11px；挂载输入框的占位文字按原型。权限只放已记住的授权（没有时一句说明）。
  await expect(detail(page).locator('.section-title h3')).toHaveText(['目录', '默认约束', '权限']);
  await expect(detail(page).getByRole('region', { name: '权限' }).getByRole('heading', { level: 4 })).toHaveText(['已记住的授权']);
  await expect(detail(page).getByRole('region', { name: '权限' }))
    .toContainText('本项目还没有记住的授权。在授权卡上选“本项目内始终允许”后会出现在这里，可以随时撤销。');
  await expect(detail(page).locator('.section-title h3').first()).toHaveCSS('font-size', '11px');
  await expect(detail(page).getByLabel('要挂载的目录')).toHaveAttribute('placeholder', '输入已有目录的路径，如 ~/code/docs');

  // 默认约束的说明在输入框下方，如实写明还不会自动带入会话；按钮是“还原 / 保存”。
  const textarea = detail(page).getByRole('textbox', { name: '默认约束' });
  const note = detail(page).locator('.project-constraints-field > small');
  await expect(note).toHaveText('项目内会话长期遵守的约定。目前只保存在项目中，还不会自动带入会话。');
  await expect(textarea).toHaveAccessibleDescription('项目内会话长期遵守的约定。目前只保存在项目中，还不会自动带入会话。');
  const [textareaBox, noteBox] = await Promise.all([textarea.boundingBox(), note.boundingBox()]);
  expect(noteBox!.y).toBeGreaterThanOrEqual(textareaBox!.y + textareaBox!.height);
  await expect(detail(page).locator('.project-constraints-actions button')).toHaveText(['还原', '保存']);
});

test('设置 · 项目改名：重名与空名在输入框下方就地说明，保存后标题旁短暂显示“已保存”（减少动效时不淡出）', async ({ page, request }) => {
  const project = await createProjectByApi(request, '技术研究');
  await createProjectByApi(request, 'Multivac 开发');
  await page.reload();
  await openProjectsPage(page);
  await expect(detail(page).getByRole('heading', { name: '技术研究' })).toBeVisible();

  const rename = detail(page).getByRole('button', { name: '改名' });
  const input = detail(page).getByLabel('项目名称');
  const save = detail(page).getByRole('button', { name: '保存', exact: true }).first();
  const error = detail(page).locator('.project-detail-head .form-error');

  // 编辑态：输入框 +“保存 / 取消”文字按钮。
  await rename.click();
  await expect(input).toBeFocused();
  await expect(detail(page).locator('.project-rename button')).toHaveText(['保存', '取消']);

  // 重名（不区分大小写）：服务端的原因写在输入框下方，输入保留、焦点回到输入框，不改名。
  await input.fill('multivac 开发');
  await detail(page).locator('.project-rename').getByRole('button', { name: '保存' }).click();
  await expect(error).toHaveText('已有同名项目「Multivac 开发」，请换一个名称。');
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(input).toHaveValue('multivac 开发');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveAccessibleDescription('已有同名项目「Multivac 开发」，请换一个名称。');
  const [inputBox, errorBox] = await Promise.all([input.boundingBox(), error.boundingBox()]);
  expect(errorBox!.y).toBeGreaterThanOrEqual(inputBox!.y + inputBox!.height);
  expect(errorBox!.y - (inputBox!.y + inputBox!.height)).toBeLessThan(16);
  await expect(detail(page).locator('.session-detail-error')).toHaveCount(0);
  expect((await listProjects(request)).map((item) => item.name)).toEqual(['技术研究', 'Multivac 开发']);

  // 改动输入后原因消失；空名不提交，就地说明。
  await input.pressSequentially('2');
  await expect(error).toHaveCount(0);
  await expect(input).not.toHaveAttribute('aria-invalid', 'true');
  await input.fill('   ');
  await input.press('Enter');
  await expect(error).toHaveText('项目名称不能为空。');

  // 取消：回到标题，焦点回到“改名”，原因一并清除。
  await detail(page).locator('.project-rename').getByRole('button', { name: '取消' }).click();
  await expect(detail(page).getByRole('heading', { name: '技术研究' })).toBeVisible();
  await expect(rename).toBeFocused();
  await expect(error).toHaveCount(0);

  // 保存成功：标题旁显示“✓ 已保存”，约 1.6 秒后淡出消失。
  await rename.click();
  await input.fill('技术调研');
  await save.click();
  await expect(detail(page).getByRole('heading', { name: '技术调研' })).toBeVisible();
  await expect(rename).toBeFocused();
  const mark = detail(page).locator('.project-title .saved-mark');
  await expect(mark).toHaveText('已保存');
  await expect(mark).toHaveAttribute('role', 'status');
  await expect(mark.locator('svg')).toHaveCount(1);
  await expect(mark).toHaveCSS('animation-name', 'saved-fade');
  expect((await mark.boundingBox())!.x).toBeGreaterThan((await rename.boundingBox())!.x);
  await expect(mark).toHaveCount(0, { timeout: 4_000 });
  expect(await listProjects(request)).toEqual(expect.arrayContaining([expect.objectContaining({ projectId: project.projectId, name: '技术调研' })]));

  // 偏好减少动效：不做淡出动画，到时同样消失。
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await rename.click();
  await input.fill('技术研究');
  await input.press('Enter');
  await expect(mark).toBeVisible();
  await expect(mark).toHaveCSS('animation-name', 'none');
  await expect(mark).toHaveCount(0, { timeout: 4_000 });
});

test('设置 · 项目：默认约束“还原”到上次保存的值；空路径时挂载按钮不可用，已有目录在输入框下就地报错，成功后目录标题旁显示“已保存”', async ({ page, request }) => {
  const docs = join(tempRoot, 'docs');
  mkdirSync(docs);
  const response = await request.post(`${fakeApiRoot}/api/projects`, { data: { name: '技术研究', defaultConstraints: '提交前先运行测试。' } });
  expect(response.status()).toBe(201);
  const project = (await response.json() as { project: ListedProject }).project;
  const managed = project.directories[0]!.path;
  await page.reload();
  await openProjectsPage(page);

  // 默认约束：未改动时“还原 / 保存”都不可用；改动后“还原”回到上次保存的值，不提交。
  const constraints = detail(page).getByRole('textbox', { name: '默认约束' });
  const revert = detail(page).getByRole('button', { name: '还原' });
  const save = detail(page).getByRole('button', { name: '保存', exact: true });
  await expect(constraints).toHaveValue('提交前先运行测试。');
  await expect(revert).toBeDisabled();
  await expect(save).toBeDisabled();
  await constraints.fill('只修改 docs/ 下的文件。');
  await expect(revert).toBeEnabled();
  await expect(save).toBeEnabled();
  await revert.click();
  await expect(constraints).toHaveValue('提交前先运行测试。');
  await expect(constraints).toBeFocused();
  await expect(revert).toBeDisabled();
  await expect(save).toBeDisabled();
  expect((await listProjects(request))[0]!.defaultConstraints).toBe('提交前先运行测试。');

  // 保存后“已保存”出现在按钮旁；之后的“还原”回到新保存的值。
  await constraints.fill('  只修改 docs/ 下的文件。 ');
  await save.click();
  const constraintsMark = detail(page).locator('.project-constraints-actions .saved-mark');
  await expect(constraintsMark).toHaveText('已保存');
  await expect(constraints).toHaveValue('只修改 docs/ 下的文件。');
  await expect(revert).toBeDisabled();
  await constraints.fill('再改一次');
  await revert.click();
  await expect(constraints).toHaveValue('只修改 docs/ 下的文件。');
  expect((await listProjects(request))[0]!.defaultConstraints).toBe('只修改 docs/ 下的文件。');

  // 挂载：空路径时按钮不可用；已在项目中的目录不出确认卡，原因写在输入框下方，改动输入后消失。
  const mountInput = detail(page).getByLabel('要挂载的目录');
  const mountButton = detail(page).getByRole('button', { name: '挂载' });
  const mountError = detail(page).locator('.detail-section').first().locator('.form-error');
  const mountCard = page.getByRole('dialog', { name: '挂载目录' });
  await expect(mountButton).toBeDisabled();
  await mountInput.fill('   ');
  await expect(mountButton).toBeDisabled();
  await expect(mountCard).toHaveCount(0);
  await mountInput.fill(`${managed}/`);
  await expect(mountError).toHaveCount(0);
  await mountInput.press('Enter');
  await expect(mountError).toHaveText('这个目录已经在项目里了。');
  await expect(mountInput).toHaveAccessibleDescription('这个目录已经在项目里了。');
  await expect(mountCard).toHaveCount(0);
  const [inputBox, errorBox] = await Promise.all([mountInput.boundingBox(), mountError.boundingBox()]);
  expect(errorBox!.y).toBeGreaterThanOrEqual(inputBox!.y + inputBox!.height);
  expect((await listProjects(request))[0]!.directories).toHaveLength(1);

  // 合法目录经确认卡挂载，成功后“目录”标题旁显示“✓ 已保存”。
  await mountInput.fill(docs);
  await mountButton.click();
  await mountCard.getByRole('button', { name: '挂载' }).click();
  await expect(mountCard).toHaveCount(0);
  await expect(directories(page).getByRole('listitem')).toHaveCount(2);
  const directoriesMark = detail(page).locator('.section-title').filter({ hasText: '目录' }).first().locator('.saved-mark');
  await expect(directoriesMark).toHaveText('已保存');
  await expect(constraintsMark).toHaveCount(0);

  // 设为主目录同样标记；详情头的工作目录随之换成新的主目录。
  await expect(directoriesMark).toHaveCount(0, { timeout: 4_000 });
  await directories(page).getByRole('listitem').nth(1).getByRole('button', { name: '设为主目录' }).click();
  await expect(directoriesMark).toHaveText('已保存');
  await expect(detail(page).locator('.project-working-directory')).toHaveText(`工作目录：挂载目录 ${basename(docs)}`);
});

test('设置 · 项目按自身可用宽度排版：侧栏打开把页面挤窄时不横向溢出', async ({ page, request }) => {
  const deep = join(tempRoot, 'a-rather-long-directory-name-for-layout-checks', 'and-another-nested-level');
  mkdirSync(deep, { recursive: true });
  await createProjectByApi(request, '一个名字相当长、用来检查换行与省略的项目名称', deep);
  await page.reload();
  await page.setViewportSize({ width: 1180, height: 820 });
  await openProjectsPage(page);

  const overflow = () => projectsPage(page).evaluate((element) => element.scrollWidth - element.clientWidth);
  const stacked = async () => {
    const [list, info] = await Promise.all([projectList(page).boundingBox(), detail(page).boundingBox()]);
    return info!.y >= list!.y + list!.height - 1;
  };
  expect(await overflow()).toBeLessThanOrEqual(0);
  expect(await stacked()).toBe(false);

  await page.keyboard.press('ControlOrMeta+J');
  await expect(page.locator('.multivac-sidebar')).toBeVisible();
  await expect.poll(stacked).toBe(true);
  expect(await overflow()).toBeLessThanOrEqual(0);

  // 宽屏中最窄的一档（窄屏不显示管理页），侧栏仍开着，页面只剩两百多像素宽。
  await page.setViewportSize({ width: 800, height: 820 });
  await expect.poll(overflow).toBeLessThanOrEqual(0);
  await expect(detail(page).getByRole('button', { name: '挂载' })).toBeVisible();
  await expect(detail(page).getByRole('button', { name: '保存', exact: true })).toBeVisible();
});
