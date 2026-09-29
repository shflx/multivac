import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Project, WorkspaceSession } from '@multivac/contracts';
import { escapeFromManagement, fakeApiRoot, openCreationDialog, openPanel, resetE2eState } from './test-state.js';

/**
 * 会话临时目录的生命周期与“设置 · 偏好”：
 * 归档时空目录直接删除，有文件时确认卡提示一次并按偏好保留；到期移到（注入的）废纸篓；
 * 到期前恢复则取消清理，已清理的恢复时重建空目录并说明；项目目录永不清理。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const workspaceBar = (page: Page) => page.getByRole('toolbar', { name: '工作区' });
const sessionMenu = (page: Page) => page.getByRole('dialog', { name: '工作区会话' });
const preferencesPage = (page: Page) => page.getByRole('main', { name: '偏好' });
const sessionsPage = (page: Page) => page.getByRole('main', { name: '会话' });
const notice = (page: Page) => page.locator('.workspace-notice');
const preferenceRow = (page: Page, label: string) =>
  preferencesPage(page).locator('.settings-row').filter({ has: page.locator('.settings-row-label strong', { hasText: label }) });

interface SweepResult {
  trashed: Array<{ path: string; trashPath: string; sessionId: string; reason: string }>;
  removed: string[];
  cancelled: string[];
  failed: Array<{ path: string; error: string }>;
}

async function createSession(page: Page, title: string): Promise<WorkspaceSession> {
  await openCreationDialog(page);
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill(title);
  const created = page.waitForResponse((response) =>
    response.url().endsWith('/api/sessions') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
  return await (await created).json() as WorkspaceSession;
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

/** 拨快清理用的时钟并立即做一次到期检查（测试控制路由）。 */
async function advanceAndSweep(request: APIRequestContext, days: number): Promise<SweepResult> {
  const response = await request.post(`${fakeApiRoot}/api/__e2e/temp-directories`, { data: { advanceMs: days * DAY_MS } });
  expect(response.ok()).toBe(true);
  return await response.json() as SweepResult;
}

/** 废纸篓必须是测试注入的临时目录：在系统临时目录下，且不是用户主目录下真实的废纸篓。 */
function expectInjectedTrash(trashPath: string): void {
  const real = realpathSync(trashPath);
  const insideTmp = relative(realpathSync(tmpdir()), real);
  expect(insideTmp.startsWith('..') || insideTmp.startsWith(sep)).toBe(false);
  expect(real.startsWith(join(homedir(), '.Trash'))).toBe(false);
  expect(real.startsWith(join(homedir(), '.local', 'share', 'Trash'))).toBe(false);
}

async function openPreferences(page: Page): Promise<void> {
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '偏好' }).click();
  await expect(preferencesPage(page).getByRole('heading', { name: '偏好', level: 1 })).toBeVisible();
}

async function returnToWork(page: Page): Promise<void> {
  await escapeFromManagement(page);
  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  await page.goto('/');
  await openPanel(page, 'workspace');
  await expect(workspaceBar(page)).toBeVisible();
});

test('归档确认卡：临时目录有文件时提示一次保留时长与去向；空的临时目录归档时直接删除', async ({ page }) => {
  const kept = await createSession(page, '留下文件');
  const empty = await createSession(page, '空目录');
  writeFileSync(join(kept.workingDirectory.path, 'report.md'), '调研报告');
  writeFileSync(join(kept.workingDirectory.path, 'data.csv'), '1,2');

  const menu = await openSessionMenu(page);
  await menu.getByRole('button', { name: '归档「留下文件」' }).click();
  const card = page.getByRole('dialog', { name: '归档「留下文件」' });
  await expect(card).toHaveAccessibleDescription(new RegExp(
    '归档后不再出现在工作区中。.*临时目录里还有文件：data\\.csv、report\\.md。.*'
    + '归档后临时目录保留 30 天，到期移到废纸篓；到期前恢复会话则取消清理。.*'
    + '可以在会话列表底部的“已归档”或管理的“会话”页恢复。',
  ));
  await card.getByRole('button', { name: '归档', exact: true }).click();
  await expect(card).toHaveCount(0);
  // 有文件的临时目录保留，等到期再清理。
  expect(readFileSync(join(kept.workingDirectory.path, 'report.md'), 'utf8')).toBe('调研报告');

  await menu.getByRole('button', { name: '归档「空目录」' }).click();
  const emptyCard = page.getByRole('dialog', { name: '归档「空目录」' });
  await expect(emptyCard).toContainText('对话历史会保留；临时目录是空的，归档时一并删除。');
  await expect(emptyCard).not.toContainText('废纸篓');
  await emptyCard.getByRole('button', { name: '归档', exact: true }).click();
  await expect(emptyCard).toHaveCount(0);
  expect(existsSync(empty.workingDirectory.path)).toBe(false);

  // 恢复空目录的会话：按原路径补建，不另作说明。
  await menu.locator('.scene-archived-toggle').click();
  await menu.getByRole('button', { name: '恢复「空目录」' }).click();
  await expect(menu.locator('.conversation-menu-list').getByText('空目录', { exact: true })).toBeVisible();
  expect(readdirSync(empty.workingDirectory.path)).toEqual([]);
  await expect(notice(page)).toHaveCount(0);
});

test('偏好页修改保留时长并显示占用；到期清理进入注入的废纸篓，恢复时重建空目录并说明；到期前恢复的不再清理，项目目录不清理', async ({ page, request }) => {
  const kept = await createSession(page, '到期清理');
  const back = await createSession(page, '提前恢复');
  const later = await createSession(page, '管理页恢复');
  writeFileSync(join(kept.workingDirectory.path, 'report.md'), '0123456789');
  writeFileSync(join(back.workingDirectory.path, 'draft.md'), 'abcde');
  writeFileSync(join(later.workingDirectory.path, 'notes.md'), 'x'.repeat(2048));
  // 项目托管目录中的会话：归档后永不清理。
  const project = (await (await request.post(`${fakeApiRoot}/api/projects`, { data: { name: '长期资料' } })).json() as { project: Project }).project;
  const projectDir = project.directories[0]!.path;
  expect((await request.post(`${fakeApiRoot}/api/sessions`, {
    data: { sessionId: 'in-project', title: '项目会话', workspaceId: project.projectId },
  })).status()).toBe(201);
  writeFileSync(join(projectDir, 'keep.md'), '项目文件');

  // 偏好页：默认 30 天；占用由服务端统计。
  await openPreferences(page);
  const retention = preferencesPage(page).getByRole('combobox', { name: '临时目录清理' });
  await expect(retention).toHaveValue('30');
  await expect(retention.locator('option')).toHaveText(['归档 7 天后', '归档 30 天后', '归档 90 天后', '从不清理']);
  const usage = preferenceRow(page, '临时目录占用');
  await expect(usage).toContainText('3 个临时目录，含归档后等待清理的。只显示，不提醒。');
  await expect(usage.locator('.preference-value strong')).toHaveText('2 KB');
  expect(await preferencesPage(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  // 改为 7 天：立即保存到服务端（下拉框旁短暂显示“已保存”），刷新后保持。
  await retention.selectOption('7');
  await expect(preferenceRow(page, '临时目录清理').getByRole('status')).toHaveText('已保存');
  expect(await (await request.get(`${fakeApiRoot}/api/preferences`)).json()).toEqual({ preferences: { tempRetentionDays: 7 } });
  await page.reload();
  await openPanel(page, 'workspace');
  await openPreferences(page);
  await expect(preferencesPage(page).getByRole('combobox', { name: '临时目录清理' })).toHaveValue('7');
  await returnToWork(page);
  await expect(workspaceBar(page)).toBeVisible();

  // 归档三个会话（确认卡写明 7 天）与项目会话，再在到期前恢复“提前恢复”。
  const menu = await openSessionMenu(page);
  await menu.getByRole('button', { name: '归档「到期清理」' }).click();
  const card = page.getByRole('dialog', { name: '归档「到期清理」' });
  await expect(card).toContainText('归档后临时目录保留 7 天，到期移到废纸篓；到期前恢复会话则取消清理。');
  await card.getByRole('button', { name: '归档', exact: true }).click();
  await expect(card).toHaveCount(0);
  for (const sessionId of [back.sessionId, later.sessionId, 'in-project']) {
    expect((await request.post(`${fakeApiRoot}/api/sessions/${sessionId}/archive`)).ok()).toBe(true);
  }
  await closeSessionMenu(page);
  await page.reload();
  await openPanel(page, 'workspace');
  await openSessionMenu(page);
  await sessionMenu(page).locator('.scene-archived-toggle').click();
  await sessionMenu(page).getByRole('button', { name: '恢复「提前恢复」' }).click();
  await expect(sessionMenu(page).locator('.conversation-menu-list').getByText('提前恢复', { exact: true })).toBeVisible();

  // 6 天：都没到期。
  expect((await advanceAndSweep(request, 6)).trashed).toEqual([]);
  // 再过 2 天：到期的两个临时目录移到注入的废纸篓；恢复了的会话与项目目录不动。
  const sweep = await advanceAndSweep(request, 2);
  expect(sweep.failed).toEqual([]);
  expect(sweep.trashed.map((item) => item.sessionId).sort()).toEqual([kept.sessionId, later.sessionId].sort());
  const trashOf = (sessionId: string) => sweep.trashed.find((item) => item.sessionId === sessionId)!.trashPath;
  for (const [session, name, content] of [[kept, 'report.md', '0123456789'], [later, 'notes.md', 'x'.repeat(2048)]] as const) {
    const trashPath = trashOf(session.sessionId);
    expectInjectedTrash(trashPath);
    expect(basename(trashPath)).toBe(basename(session.workingDirectory.path));
    expect(readFileSync(join(trashPath, name), 'utf8')).toBe(content);
    expect(existsSync(session.workingDirectory.path)).toBe(false);
  }
  expect(readFileSync(join(back.workingDirectory.path, 'draft.md'), 'utf8')).toBe('abcde');
  expect(readFileSync(join(projectDir, 'keep.md'), 'utf8')).toBe('项目文件');

  // 在工作区恢复已清理的会话：重建空的临时目录，顶部说明何时移走、移到了哪里。
  await sessionMenu(page).getByRole('button', { name: '恢复「到期清理」' }).click();
  await expect(notice(page)).toContainText('已恢复「到期清理」。它的临时目录已于');
  await expect(notice(page)).toContainText(`到期移到废纸篓（${trashOf(kept.sessionId)}），已重建空的临时目录；需要原来的文件，可以从废纸篓找回。`);
  expect(readdirSync(kept.workingDirectory.path)).toEqual([]);
  await closeSessionMenu(page);

  // 在管理 · 管理页恢复另一个：说明留在页面上（会话随恢复离开“已归档”筛选）。
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '会话' }).click();
  await sessionsPage(page).getByRole('group', { name: '按状态筛选' }).getByRole('button', { name: '已归档' }).click();
  await sessionsPage(page).getByRole('list', { name: '会话列表' }).getByText('管理页恢复', { exact: true }).click();
  await sessionsPage(page).locator('.session-detail').getByRole('button', { name: '恢复', exact: true }).click();
  await expect(sessionsPage(page).locator('.sessions-notice')).toContainText(
    `已恢复「管理页恢复」。它的临时目录已于`,
  );
  await expect(sessionsPage(page).locator('.sessions-notice')).toContainText(trashOf(later.sessionId));
  expect(readdirSync(later.workingDirectory.path)).toEqual([]);

  // 恢复后再怎么拨时钟都不清理；项目目录仍然不动。
  expect((await advanceAndSweep(request, 400)).trashed).toEqual([]);
  expect(readFileSync(join(back.workingDirectory.path, 'draft.md'), 'utf8')).toBe('abcde');
  expect(readFileSync(join(projectDir, 'keep.md'), 'utf8')).toBe('项目文件');

  // 占用随之更新：只剩“提前恢复”的 5 个字节。
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '偏好' }).click();
  await expect(usage.locator('.preference-value strong')).toHaveText('5 B');
  await preferencesPage(page).getByRole('button', { name: '重新统计临时目录占用' }).click();
  await expect(usage.locator('.preference-value strong')).toHaveText('5 B');
});

test('偏好为从不清理时到期也不清理；改回有限时长后按归档时间立即生效', async ({ page, request }) => {
  const session = await createSession(page, '长期保留');
  writeFileSync(join(session.workingDirectory.path, 'keep.md'), '保留');
  expect((await request.post(`${fakeApiRoot}/api/sessions/${session.sessionId}/archive`)).ok()).toBe(true);

  await openPreferences(page);
  const retention = preferencesPage(page).getByRole('combobox', { name: '临时目录清理' });
  await retention.selectOption('never');
  await expect(preferenceRow(page, '临时目录清理').getByRole('status')).toHaveText('已保存');
  expect(await (await request.get(`${fakeApiRoot}/api/preferences`)).json()).toEqual({ preferences: { tempRetentionDays: null } });
  expect((await advanceAndSweep(request, 365)).trashed).toEqual([]);
  expect(readFileSync(join(session.workingDirectory.path, 'keep.md'), 'utf8')).toBe('保留');

  // 改为 90 天：已归档一年，保存后随即移到废纸篓。
  await retention.selectOption('90');
  await expect(preferenceRow(page, '临时目录清理').getByRole('status')).toHaveText('已保存');
  await expect.poll(() => existsSync(session.workingDirectory.path)).toBe(false);
  await expect(preferenceRow(page, '临时目录占用').locator('.preference-value strong')).toHaveText('0 B');
});

test('偏好页是“会话与临时目录”卡片：左说明右控件；保存后下拉框旁短暂显示“已保存”，失败时原因写在行下；窄时控件折到说明下方', async ({ page, request }) => {
  await openPreferences(page);
  const card = preferencesPage(page).getByRole('region', { name: '会话与临时目录' });
  await expect(card.getByRole('heading', { name: '会话与临时目录', level: 2 })).toBeVisible();
  // 卡片说明：作用范围与原说明框里的规则都在，不再有单独的灰色说明框。
  const description = card.locator('header p');
  await expect(description).toContainText('对所有项目与默认工作区生效。');
  await expect(description).toContainText('会话未归档时临时目录不清理，归档时空的临时目录直接删除');
  await expect(description).toContainText('Multivac 工作目录与项目目录（托管或挂载）永不自动清理。');
  await expect(preferencesPage(page).locator('.preferences-note')).toHaveCount(0);

  // 行：左边名称与说明，右边下拉框；修改立即影响已排期目录这一点写在行说明里。
  const row = preferenceRow(page, '临时目录清理');
  const retention = row.getByRole('combobox', { name: '临时目录清理' });
  await expect(retention).toHaveAccessibleDescription(/修改后按归档时间重新计算，已超过新时长的随即移到废纸篓。$/);
  const labelBox = (await row.locator('.settings-row-label').boundingBox())!;
  const selectBox = (await retention.boundingBox())!;
  expect(labelBox.x + labelBox.width).toBeLessThan(selectBox.x);
  expect(Math.round(selectBox.width)).toBe(160);
  expect(Math.round(selectBox.height)).toBe(28);
  await expect(preferenceRow(page, '临时目录占用').getByRole('button', { name: '重新统计临时目录占用' })).toBeVisible();

  // 保存成功：下拉框左侧短暂显示“✓ 已保存”，约 1.6 秒后淡出消失；页面上没有常驻的保存说明。
  await retention.selectOption('7');
  const mark = row.locator('.saved-mark');
  await expect(mark).toHaveText('已保存');
  await expect(mark).toHaveAttribute('role', 'status');
  const markBox = (await mark.boundingBox())!;
  const savedSelectBox = (await retention.boundingBox())!;
  expect(markBox.x + markBox.width).toBeLessThanOrEqual(savedSelectBox.x);
  expect(Math.abs((markBox.y + markBox.height / 2) - (savedSelectBox.y + savedSelectBox.height / 2))).toBeLessThan(3);
  await expect(preferencesPage(page).getByText(/已保存：/)).toHaveCount(0);
  await expect(mark).toHaveCount(0, { timeout: 4_000 });

  // 保存失败：原因写在这一行下方，下拉框回到已保存的值并关联原因；不显示“已保存”。
  await page.route('**/api/preferences', (route) => route.request().method() === 'PATCH'
    ? route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '偏好保存失败：服务暂时不可用。' } }),
    })
    : route.continue());
  await retention.selectOption('90');
  const error = row.getByRole('alert');
  await expect(error).toHaveText('偏好保存失败：服务暂时不可用。');
  await expect(retention).toHaveValue('7');
  await expect(retention).toHaveAttribute('aria-invalid', 'true');
  await expect(retention).toHaveAccessibleDescription(/偏好保存失败：服务暂时不可用。$/);
  await expect(mark).toHaveCount(0);
  const errorBox = (await error.boundingBox())!;
  const rowLabelBox = (await row.locator('.settings-row-label').boundingBox())!;
  expect(errorBox.y).toBeGreaterThanOrEqual(rowLabelBox.y + rowLabelBox.height);
  expect(Math.round(errorBox.x)).toBe(Math.round(rowLabelBox.x));
  expect(await (await request.get(`${fakeApiRoot}/api/preferences`)).json()).toEqual({ preferences: { tempRetentionDays: 7 } });

  // 恢复后再保存：原因消失，显示“已保存”。
  await page.unroute('**/api/preferences');
  await retention.selectOption('90');
  await expect(mark).toHaveText('已保存');
  await expect(error).toHaveCount(0);
  await expect(retention).not.toHaveAttribute('aria-invalid');

  // 宽屏最窄一档且侧栏打开：控件折到说明下方，页面不横向溢出。
  await page.keyboard.press('ControlOrMeta+J');
  await expect(page.locator('.multivac-sidebar')).toBeVisible();
  await page.setViewportSize({ width: 800, height: 820 });
  await expect.poll(() => preferencesPage(page).evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
  const stackedLabel = (await row.locator('.settings-row-label').boundingBox())!;
  const stackedSelect = (await retention.boundingBox())!;
  expect(stackedSelect.y).toBeGreaterThanOrEqual(stackedLabel.y + stackedLabel.height);
});
