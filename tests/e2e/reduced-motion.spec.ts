import { test, expect } from '@playwright/test';
import { resetE2eState, openPanel } from './test-state.js';

test.beforeEach(async ({ request }) => { await resetE2eState(request); });

test('减少动效时首次打开笔记页，删除按钮按下不缩放', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '笔记', exact: true }).click();
  await page.getByRole('button', { name: '新建笔记', exact: true }).click();
  await page.locator('.notes-library-item[data-selected="true"]').hover();
  const remove = page.getByRole('complementary', { name: '笔记库' }).getByRole('button', { name: '删除笔记', exact: true });
  await remove.hover(); await page.mouse.down();
  await expect(remove).toHaveCSS('transform', 'none');
  await page.screenshot({ path: info.outputPath('note-reduced-pressed.png') });
  // 在按钮外释放，避免触发删除操作。
  await page.mouse.move(1, 1); await page.mouse.up();
});
