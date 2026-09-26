import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

const workspaceBar = (page: Page) => page.getByRole('toolbar', { name: '工作区' });

function panel(page: Page, title: string) {
  return page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

async function setupParallel(page: Page, titles: [string, string]): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: '进入工作区' }).click();
  for (const title of titles) {
    await workspaceBar(page).getByRole('button', { name: '新会话' }).click();
    const dialog = page.getByRole('dialog', { name: '创建新会话' });
    await dialog.getByLabel('会话名称').fill(title);
    await dialog.getByRole('button', { name: '创建' }).click();
    await expect(dialog).toHaveCount(0);
  }
  await workspaceBar(page).getByRole('button', { name: '并排', exact: true }).click();
  await expect(page.locator('.conversation-panel')).toHaveCount(2);
}

test.beforeEach(async ({ request }) => {
  await resetE2eState(request);
});

test('并排两个会话各自发送、补充指令与停止，互不影响', async ({ page, request }) => {
  await setupParallel(page, ['会话甲', '会话乙']);
  const first = panel(page, '会话乙');
  const second = panel(page, '会话甲');

  // 甲、乙先后开始运行；Fake 在释放前让两轮都保持运行。
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
  await first.getByLabel('Multivac 草稿').fill('乙的长任务');
  await first.getByLabel('Multivac 草稿').press('Enter');
  await expect(first.getByRole('button', { name: '取消当前处理' })).toBeVisible();

  await second.getByRole('button', { name: '在「会话甲」中继续' }).click();
  await expect(second.getByLabel('Multivac 草稿')).toBeFocused();
  await second.getByLabel('Multivac 草稿').fill('甲的长任务');
  await second.getByLabel('Multivac 草稿').press('Enter');
  await expect(second.getByRole('button', { name: '取消当前处理' })).toBeVisible();

  // 运行中补充指令只进入甲。
  await second.getByRole('button', { name: '立即调整' }).click();
  await second.getByLabel('Multivac 草稿').fill('甲的补充指令');
  await second.getByLabel('发送消息').click();
  await expect(second.locator('article.chat-row.user').filter({ hasText: '甲的补充指令' })).toHaveCount(1);
  await expect(first.locator('article.chat-row.user').filter({ hasText: '甲的补充指令' })).toHaveCount(0);

  // 停止乙不影响甲。
  await first.getByRole('button', { name: '取消当前处理' }).click();
  await expect(first.getByRole('status').getByText('处理已取消', { exact: true })).toBeVisible();
  await expect(second.getByRole('button', { name: '取消当前处理' })).toBeVisible();

  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(second.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(first.getByRole('status').getByText('处理已取消', { exact: true })).toBeVisible();
  await expect(second.locator('article.chat-row.user').filter({ hasText: '乙的长任务' })).toHaveCount(0);
});

test('分隔线可拖动与键盘调整列宽，双击恢复等宽', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await setupParallel(page, ['左栏会话', '右栏会话']);
  const separator = page.getByRole('separator', { name: '调整「右栏会话」与「左栏会话」的列宽' });
  await expect(separator).toHaveAttribute('aria-valuenow', '50');
  const leftPanel = page.locator('.workspace-slot').first();
  const initialWidth = (await leftPanel.boundingBox())!.width;

  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThan(50);
  await page.keyboard.press('Home');
  await expect(separator).toHaveAttribute('aria-valuenow', '50');

  const box = (await separator.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await leftPanel.boundingBox())!.width).toBeLessThan(initialWidth - 150);

  // 最小宽度约束：继续向左拖也不会小于 320px。
  await page.mouse.move(box.x - 200, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 900, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await leftPanel.boundingBox())!.width)).toBeGreaterThanOrEqual(320);

  await separator.dblclick();
  await expect(separator).toHaveAttribute('aria-valuenow', '50');
});

test('非当前会话输入区折叠，有草稿时保持展开；并排与聚焦切换不丢草稿', async ({ page }) => {
  await setupParallel(page, ['折叠甲', '折叠乙']);
  const current = panel(page, '折叠乙');
  const other = panel(page, '折叠甲');
  await expect(current).toHaveClass(/active/);
  await expect(other.getByRole('button', { name: '在「折叠甲」中继续' })).toBeVisible();
  await expect(other.getByLabel('Multivac 草稿')).toHaveCount(0);

  // 点入口展开并聚焦，原当前会话随之折叠。
  await other.getByRole('button', { name: '在「折叠甲」中继续' }).click();
  await expect(other).toHaveClass(/active/);
  await expect(other.getByLabel('Multivac 草稿')).toBeFocused();
  await expect(current.getByRole('button', { name: '在「折叠乙」中继续' })).toBeVisible();

  // 有未发送草稿的会话即使不是当前会话也保持展开。
  await other.getByLabel('Multivac 草稿').fill('甲的草稿');
  await current.getByRole('button', { name: '在「折叠乙」中继续' }).click();
  await expect(current.getByLabel('Multivac 草稿')).toBeFocused();
  await expect(other.getByLabel('Multivac 草稿')).toHaveValue('甲的草稿');

  // 聚焦模式只展示当前会话，返回并排后草稿仍在。
  await current.getByRole('button', { name: '放大「折叠乙」' }).click();
  await expect(page.locator('.conversation-panel')).toHaveCount(1);
  await expect(workspaceBar(page).getByRole('button', { name: '聚焦', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '返回并排' }).click();
  await expect(page.locator('.conversation-panel')).toHaveCount(2);
  await expect(panel(page, '折叠甲').getByLabel('Multivac 草稿')).toHaveValue('甲的草稿');
});

test('900px 窄屏并排时两栏不小于最小宽度，可横向滚动且页面不溢出', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 820 });
  await setupParallel(page, ['窄屏甲', '窄屏乙']);
  const widths = await page.locator('.workspace-slot').evaluateAll((slots) =>
    slots.map((slot) => slot.getBoundingClientRect().width));
  expect(widths.every((width) => width >= 320)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth))
    .toBe(false);
});

test('并排数可设为 3 / 4：各栏之间都可调整列宽，放不下时横向滚动；调小后当前会话仍在显示；刷新后恢复', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await setupParallel(page, ['栏一', '栏二']);
  for (const title of ['栏三', '栏四']) {
    await workspaceBar(page).getByRole('button', { name: '新会话' }).click();
    const dialog = page.getByRole('dialog', { name: '创建新会话' });
    await dialog.getByLabel('会话名称').fill(title);
    await dialog.getByRole('button', { name: '创建' }).click();
    await expect(dialog).toHaveCount(0);
  }
  const count = workspaceBar(page).getByLabel('并排数');
  await expect(count).toHaveValue('2');
  await expect(count.locator('option')).toHaveText(['2', '3', '4']);

  // 调大并排数回到并排视图，新会话在前。
  await count.selectOption('3');
  await expect(workspaceBar(page).getByRole('button', { name: '并排', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.conversation-panel h2')).toHaveText(['栏四', '栏三', '栏二']);
  await expect(page.getByRole('separator')).toHaveCount(2);
  const middle = page.getByRole('separator', { name: '调整「栏三」与「栏二」的列宽' });
  await middle.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => Number(await middle.getAttribute('aria-valuenow'))).toBeGreaterThan(50);
  const adjusted = await middle.getAttribute('aria-valuenow');

  // 4 栏超出可用宽度：每栏不窄于 320px，工作区横向滚动，侧栏不被挤压。
  await count.selectOption('4');
  await expect(page.locator('.conversation-panel')).toHaveCount(4);
  const widths = await page.locator('.workspace-slot').evaluateAll((slots) => slots.map((slot) => slot.getBoundingClientRect().width));
  expect(widths.every((width) => width >= 319.5)).toBe(true);
  expect(await page.locator('.workspace-panels').evaluate((grid) => grid.scrollWidth > grid.clientWidth)).toBe(true);
  expect(Math.round((await page.locator('.workspace-shell .multivac-sidebar').boundingBox())!.width)).toBe(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);

  // 当前会话在第 4 栏时调小为 2：它保留在最后一栏，其余会话退出显示但不关闭。
  await page.locator('.workspace-panels').evaluate((grid) => { grid.scrollLeft = grid.scrollWidth; });
  await panel(page, '栏一').locator('h2').click();
  await expect(panel(page, '栏一')).toHaveClass(/active/);
  await count.selectOption('2');
  await expect(page.locator('.conversation-panel h2')).toHaveText(['栏四', '栏一']);
  await workspaceBar(page).getByRole('button', { name: /^会话/ }).click();
  await expect(page.getByRole('dialog', { name: '工作区会话' }).locator('.scene-row')).toHaveCount(4);
  await page.keyboard.press('Escape');

  // 各并排数的列宽分别记住；刷新后并排数、栏位与列宽恢复。
  await count.selectOption('3');
  await expect(page.locator('.conversation-panel')).toHaveCount(3);
  await expect.poll(async () => {
    const scene = await (await page.request.get(`${fakeApiRoot}/api/workspaces/default/scene`)).json();
    return scene.scene.parallelCount;
  }).toBe(3);
  await page.reload();
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(workspaceBar(page).getByLabel('并排数')).toHaveValue('3');
  await expect(page.locator('.conversation-panel')).toHaveCount(3);
  await expect(page.getByRole('separator').nth(1)).toHaveAttribute('aria-valuenow', adjusted!);
});
