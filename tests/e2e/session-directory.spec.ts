import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { fakeApiRoot, resetE2eState, openCreationDialog } from './test-state.js';

interface ListedSession {
  sessionId: string;
  title: string;
  workingDirectory: { kind: string; path: string };
}

interface CreatedProject {
  project: { directories: Array<{ kind: string; path: string }> };
}

const OUTSIDE_RULE = '读取、修改或写入目录外的文件需要你确认。';
const RULES = {
  临时目录: `会话专用，目录内的读写与命令自动执行。会话归档后，有文件的按“设置 · 偏好”保留（默认 30 天）再移到废纸篓，空目录直接删除。${OUTSIDE_RULE}`,
  项目托管目录: `由 Multivac 托管，长期保留、不会自动清理，目录内的读写与命令自动执行。${OUTSIDE_RULE}`,
  挂载目录: `你已有的目录，Multivac 不会清理它，目录内的读写与命令自动执行。${OUTSIDE_RULE}`,
} as const;

const workspaceBar = (page: Page) => page.getByRole('toolbar', { name: '工作区' });
const switcherTrigger = (page: Page) => workspaceBar(page).getByRole('button', { name: /^工作区/ });

function panel(page: Page, title: string): Locator {
  return page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

const directoryTrigger = (scope: Locator) => scope.locator('.session-directory-trigger');
const directoryDetail = (scope: Locator) => scope.getByRole('dialog', { name: '本会话的工作目录' });

async function createSession(page: Page, title: string): Promise<void> {
  await openCreationDialog(page);
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill(title);
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
}

async function sessionByTitle(request: APIRequestContext, title: string): Promise<ListedSession> {
  const response = await request.get(`${fakeApiRoot}/api/sessions?workspace=all&archived=include`);
  expect(response.ok()).toBe(true);
  const sessions = (await response.json() as { sessions: ListedSession[] }).sessions;
  const session = sessions.find((item) => item.title === title);
  expect(session).toBeDefined();
  return session!;
}

async function createProject(request: APIRequestContext, name: string, directory?: string): Promise<CreatedProject> {
  const response = await request.post(`${fakeApiRoot}/api/projects`, { data: { name, ...(directory ? { directory } : {}) } });
  expect(response.status()).toBe(201);
  return await response.json() as CreatedProject;
}

async function switchWorkspace(page: Page, name: string): Promise<void> {
  await switcherTrigger(page).click();
  await page.getByRole('dialog', { name: '切换工作区' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await expect(switcherTrigger(page)).toContainText(name);
}

/** 标题栏的工作目录：类型、目录名、悬停提示；展开后的类型、完整路径与规则。 */
async function expectDirectory(scope: Locator, kind: keyof typeof RULES, path: string, name: string): Promise<void> {
  const trigger = directoryTrigger(scope);
  await expect(trigger).toHaveAccessibleName(`工作目录：${kind} ${path}`);
  await expect(trigger).toHaveText(`${kind} · ${name}`);
  await expect(trigger).toHaveAttribute('title', `${kind} ${path}\n${RULES[kind]}`);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  // 放得下时目录名完整显示，不被省略。
  expect(await scope.locator('.session-directory-name').evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true);

  await trigger.click();
  const detail = directoryDetail(scope);
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(detail.locator('strong')).toHaveText(kind);
  await expect(detail.locator('code')).toHaveText(path);
  await expect(detail.locator('small')).toHaveText(RULES[kind]);
  await trigger.click();
  await expect(detail).toHaveCount(0);
}

async function sendInPanel(scope: Locator, text: string): Promise<void> {
  await scope.getByLabel('Multivac 草稿').fill(text);
  await scope.getByLabel('发送消息').click();
  await expect(scope.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
}

let mountedRoot: string;

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  // 挂载目录用测试自己的临时目录，不触碰用户主目录。
  mountedRoot = mkdtempSync(join(tmpdir(), 'multivac-e2e-mounted-'));
  await page.goto('/');
});

test.afterEach(() => {
  rmSync(mountedRoot, { recursive: true, force: true });
});

test('默认工作区的会话：标题栏显示“临时目录 · 目录名”，长目录名中间截断；说明写明完整路径与规则，键盘可达、可收起，不挡住其他操作', async ({ page, request }) => {
  await page.getByRole('button', { name: '进入工作区' }).click();
  const title = '梳理导航结构与会话标题栏的目录显示方案';
  await createSession(page, title);
  const session = await sessionByTitle(request, title);
  expect(session.workingDirectory.kind).toBe('session-temp');
  const path = session.workingDirectory.path;
  const name = basename(path);

  // 目录名形如“日期-会话名-短 id”，超出长度时保留开头的日期与结尾的短 id。
  const current = panel(page, title);
  const trigger = directoryTrigger(current);
  await expect(trigger).toHaveAccessibleName(`工作目录：临时目录 ${path}`);
  const shown = (await current.locator('.session-directory-name').textContent())!.replace(/^ · /, '');
  expect(name.length).toBeGreaterThan(28);
  expect(Array.from(shown)).toHaveLength(28);
  expect(shown.startsWith(name.slice(0, 11))).toBe(true);
  expect(shown.endsWith(name.slice(-9))).toBe(true);
  expect(shown).toContain('…');
  await expect(trigger).toHaveAttribute('title', `临时目录 ${path}\n${RULES.临时目录}`);

  // 键盘：聚焦可见，Enter 展开说明，Esc 收起并把焦点还给按钮；工作区与侧栏不受影响。
  await trigger.focus();
  await page.keyboard.press('Enter');
  const detail = directoryDetail(current);
  await expect(detail).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(detail.locator('strong')).toHaveText('临时目录');
  await expect(detail.locator('code')).toHaveText(path);
  await expect(detail.locator('small')).toHaveText(RULES.临时目录);
  // 展开时不再显示浏览器提示，避免与说明重叠。
  await expect(trigger).not.toHaveAttribute('title', /./);
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await trigger.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
  await expect(page.locator('.workspace-shell .multivac-sidebar')).toHaveClass(/collapsed/);
  await page.keyboard.press('Space');
  await expect(detail).toBeVisible();

  // 说明在本栏之内；完整路径可以选中复制。
  const panelBox = (await current.boundingBox())!;
  const detailBox = (await detail.boundingBox())!;
  expect(detailBox.x).toBeGreaterThanOrEqual(panelBox.x);
  expect(detailBox.x + detailBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
  await detail.locator('code').selectText();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(path);
  await expect(detail).toBeVisible();

  // 点别处即收起，这次点击照常生效：输入区获得焦点，可以继续输入。
  const draft = current.getByLabel('Multivac 草稿');
  await draft.click();
  await expect(detail).toHaveCount(0);
  await expect(draft).toBeFocused();
  await page.keyboard.type('继续');
  await expect(draft).toHaveValue('继续');

  // 刷新后仍按会话记录显示。
  await page.reload();
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(directoryTrigger(panel(page, title))).toHaveAccessibleName(`工作目录：临时目录 ${path}`);
});

test('项目托管目录与挂载目录的会话：标题栏显示各自的类型、目录名与规则；全局 Multivac 不显示', async ({ page, request }) => {
  const research = await createProject(request, '技术研究');
  await createProject(request, 'Multivac 开发', mountedRoot);
  const managedPath = research.project.directories[0]!.path;
  await page.reload();
  await page.getByRole('button', { name: '进入工作区' }).click();

  await switchWorkspace(page, '技术研究');
  await createSession(page, '文献整理');
  const managed = await sessionByTitle(request, '文献整理');
  expect(managed.workingDirectory).toEqual({ kind: 'project-managed', path: managedPath });
  await expectDirectory(panel(page, '文献整理'), '项目托管目录', managedPath, basename(managedPath));

  await switchWorkspace(page, 'Multivac 开发');
  await createSession(page, '修复恢复问题');
  const mounted = await sessionByTitle(request, '修复恢复问题');
  expect(mounted.workingDirectory).toEqual({ kind: 'project-mounted', path: mountedRoot });
  await expectDirectory(panel(page, '修复恢复问题'), '挂载目录', mountedRoot, basename(mountedRoot));

  // 同一工作区里的另一个会话共用项目目录，各自的标题栏都显示它。
  await createSession(page, '补充测试');
  await workspaceBar(page).getByRole('button', { name: '并排', exact: true }).click();
  await expect(page.locator('.conversation-panel')).toHaveCount(2);
  for (const title of ['修复恢复问题', '补充测试']) {
    await expect(directoryTrigger(panel(page, title))).toHaveText(`挂载目录 · ${basename(mountedRoot)}`);
  }

  // 按原型，全局 Multivac（工作区侧栏与首页）不显示工作目录。
  await page.getByRole('button', { name: '展开 Multivac' }).click();
  await expect(page.locator('.workspace-shell .multivac-sidebar .multivac-panel')).toBeVisible();
  await expect(page.locator('.workspace-shell .multivac-sidebar .session-directory')).toHaveCount(0);
  await page.getByRole('button', { name: '返回 Multivac' }).click();
  await expect(page.getByRole('button', { name: '进入工作区' })).toBeVisible();
  await expect(page.locator('.session-directory:visible')).toHaveCount(0);
});

test('并排窄栏：工作目录与栏位标签、栈式路径、返回父会话按钮共存，标题栏不溢出，说明不越出本栏', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 820 });
  await page.getByRole('button', { name: '进入工作区' }).click();
  const parentTitle = '梳理导航结构与会话标题栏的目录显示方案（窄栏）';
  await createSession(page, parentTitle);
  await sendInPanel(panel(page, parentTitle), '顶栏只保留两个入口吗？');
  await createSession(page, '接口约定');
  await workspaceBar(page).getByRole('button', { name: '并排', exact: true }).click();
  await workspaceBar(page).getByLabel('并排数').selectOption('3');

  // 在长标题的会话里深入一层：子会话带栈式路径与返回父会话按钮，仍在原来的栏位。
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
  }, 'Fake Multivac 已处理当前消息');
  await page.getByRole('toolbar', { name: '选中内容操作' }).getByRole('button', { name: '深入一层' }).click();
  const child = panel(page, 'Fake Multivac 已处理当前消息');
  await expect(child.locator('.conversation-path')).toContainText(parentTitle);
  await expect(child.getByRole('button', { name: '返回父会话' })).toBeVisible();
  await expect(child.locator('.slot-tag')).toBeVisible();
  await expect(directoryTrigger(child)).toContainText('临时目录 · ');

  // 每个标题栏都不横向溢出；工作目录按钮不越过右侧工具区。
  const headers = page.locator('.conversation-header');
  expect(await headers.count()).toBeGreaterThanOrEqual(2);
  for (const header of await headers.all()) {
    const fits = await header.evaluate((element) => {
      const tools = element.querySelector('.conversation-tools')!.getBoundingClientRect();
      const trigger = element.querySelector('.session-directory-trigger')!.getBoundingClientRect();
      const title = element.querySelector('.conversation-title')!.getBoundingClientRect();
      return element.scrollWidth <= element.clientWidth && trigger.right <= tools.left && title.right <= tools.left;
    });
    expect(fits).toBe(true);
  }

  await directoryTrigger(child).click();
  const detail = directoryDetail(child);
  await expect(detail).toBeVisible();
  const childBox = (await child.boundingBox())!;
  const detailBox = (await detail.boundingBox())!;
  expect(detailBox.x).toBeGreaterThanOrEqual(childBox.x);
  expect(detailBox.x + detailBox.width).toBeLessThanOrEqual(childBox.x + childBox.width);
  // 返回父会话按钮不被说明挡住：点它即收起说明并回到父会话。
  await child.getByRole('button', { name: '返回父会话' }).click();
  await expect(panel(page, parentTitle)).toHaveCount(1);
  await expect(page.getByRole('dialog', { name: '本会话的工作目录' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});
