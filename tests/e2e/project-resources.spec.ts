import { test, expect, type Page } from '@playwright/test';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openPanel } from './test-state.js';

const resources = (page: Page) => page.getByRole('region', { name: '项目资料', exact: true });
async function enter(page: Page) {
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '项目', exact: true }).click();
  await expect(page.getByRole('button', { name: '新建项目…', exact: true })).toBeVisible();
}
async function create(page: Page, name: string) {
  await page.getByRole('button', { name: '新建项目…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建项目', exact: true });
  await dialog.getByLabel('项目名称').fill(name);
  const reply = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/projects');
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click();
  const { project } = await (await reply).json() as { project: { projectId: string; directories: { path: string }[] } };
  await expect(dialog).toBeHidden();
  await page.getByRole('tab', { name: /^资料/ }).click();
  await expect(resources(page)).toBeVisible();
  return project;
}
async function add(page: Page, kind: string) {
  await resources(page).getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('menu', { name: '添加资料', exact: true }).getByRole('menuitem', { name: new RegExp(kind) }).click();
}
async function menu(page: Page, name: string) {
  await resources(page).getByRole('button', { name: `「${name}」的操作`, exact: true }).click();
  return page.getByRole('menu', { name: `「${name}」的操作`, exact: true });
}

test('项目资料：新建、改标题简介、常驻、上传、目录引用、缺失与移除', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  // 验证界面发起打开请求，避免测试在用户桌面启动编辑器。
  await page.route('**/resources/*/open', route => route.fulfill({ json: { message: '已交给系统默认程序打开。' } }));
  await enter(page); const project = await create(page, '项目资料验收');
  await expect(resources(page).getByText('还没有资料', { exact: true })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('01-empty-1440.png') });
  await add(page, '新建文档');
  const fresh = page.getByRole('dialog', { name: '新建文档', exact: true });
  await fresh.getByLabel('文件名').fill('需求说明');
  await fresh.getByRole('button', { name: '新建并打开', exact: true }).click();
  await expect(fresh).toBeHidden(); await expect(resources(page).getByRole('button', { name: '「需求说明.md」的操作' })).toBeVisible();
  await (await menu(page, '需求说明.md')).getByRole('menuitem', { name: '编辑标题和简介', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑资料', exact: true });
  await edit.getByLabel('标题', { exact: true }).fill('需求边界');
  await edit.getByLabel('简介', { exact: true }).fill('评估需求时优先查阅这份资料。');
  await edit.getByRole('button', { name: '保存', exact: true }).click(); await expect(edit).toBeHidden();
  await (await menu(page, '需求边界')).getByRole('menuitem', { name: '设为常驻', exact: true }).click();
  await expect(resources(page).getByText(/常驻 1 份/)).toBeVisible();
  const picker = page.waitForEvent('filechooser'); await add(page, '从本机添加文件');
  await (await picker).setFiles({ name: '参考.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF fixture') });
  await expect(resources(page).getByRole('button', { name: '「参考.pdf」的操作' })).toBeVisible();
  await expect((await menu(page, '参考.pdf')).getByRole('menuitem', { name: '设为常驻', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  const directory = project.directories[0]!.path;
  expect(directory.startsWith(process.env.TMPDIR!)).toBe(true);
  const path = join(directory, '引用.md'); writeFileSync(path, '# 引用\n\n目录内资料');
  await add(page, '从项目目录选择');
  const selection = page.getByRole('dialog', { name: '从项目目录选择', exact: true });
  await selection.getByLabel('文件路径').fill('引用.md');
  await selection.getByRole('button', { name: '添加', exact: true }).click(); await expect(selection).toBeHidden();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('02-populated-1440.png') });
  await page.setViewportSize({ width: 1280, height: 720 });
  await (await menu(page, '需求边界')).getByRole('menuitem', { name: '编辑标题和简介', exact: true }).click();
  await expect(edit.getByLabel('标题', { exact: true })).toBeFocused();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('03-edit-1280.png') }); await page.keyboard.press('Escape');
  unlinkSync(path);
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '归档', exact: true }).click();
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '项目', exact: true }).click();
  await expect(resources(page).getByText('文件缺失', { exact: true })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('04-missing-1280.png') });
  await (await menu(page, '参考.pdf')).getByRole('menuitem', { name: '移除', exact: true }).click();
  const removal = page.getByRole('dialog', { name: '移除「参考.pdf」', exact: true });
  await expect(removal).toContainText('废纸篓'); await removal.getByRole('button', { name: '移除', exact: true }).click();
  await expect(resources(page).getByRole('button', { name: '「参考.pdf」的操作' })).toHaveCount(0);
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await expect(page.getByRole('list', { name: '项目目录', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('项目资料：长列表末行菜单在小视口内完整可见，键盘可取消返回入口', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 720 }); await enter(page); await create(page, '长列表资料验收');
  const picker = page.waitForEvent('filechooser'); await add(page, '从本机添加文件');
  await (await picker).setFiles(Array.from({ length: 24 }, (_, index) => ({ name: `文档-${String(index).padStart(2, '0')}.md`, mimeType: 'text/markdown', buffer: Buffer.from('项目资料') })));
  await expect(resources(page).getByRole('button', { name: /的操作$/ })).toHaveCount(24);
  const trigger = resources(page).getByRole('button', { name: '「文档-00.md」的操作', exact: true });
  await trigger.scrollIntoViewIfNeeded(); await trigger.click();
  const popup = page.getByRole('menu', { name: '「文档-00.md」的操作', exact: true });
  await expect(popup).toBeVisible(); await page.screenshot({ animations: 'disabled', path: info.outputPath('05-last-row-menu-1280.png') });
  const box = await popup.boundingBox(); expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(8); expect(box!.y + box!.height).toBeLessThanOrEqual(712);
  await expect(popup.getByRole('menuitem', { name: '打开', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(popup.getByRole('menuitem', { name: '移除', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
});


test('项目资料：初次读取有加载提示，失败可见，重新进入后恢复空列表', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await enter(page);
  const gate = Promise.withResolvers<void>();
  await page.route('**/api/projects/*/resources', async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    await gate.promise;
    await route.fulfill({ status: 503, json: { error: { code: 'INTERNAL_ERROR', message: '资料暂时不可用，请稍后重试。' } } });
  });
  try {
    await create(page, '加载与失败资料验收');
    await expect(resources(page).getByText('正在读取资料…', { exact: true })).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: info.outputPath('06-loading-1440.png') });
    gate.resolve();
    await expect(resources(page).getByRole('alert')).toContainText('资料暂时不可用');
    await page.screenshot({ animations: 'disabled', path: info.outputPath('07-error-1440.png') });
    await page.unroute('**/api/projects/*/resources');
    await page.getByRole('tab', { name: '概览', exact: true }).click();
    await page.getByRole('tab', { name: /^资料/ }).click();
    await expect(resources(page).getByText('还没有资料', { exact: true })).toBeVisible();
    await expect(resources(page).getByRole('alert')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { gate.resolve(); }
});
