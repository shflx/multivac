import { expect, test, type Page } from '@playwright/test';
import { resetE2eState } from './test-state.js';

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  await page.goto('/');
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
});

/** 从发起本轮的消息开始，按界面顺序列出消息与轨迹（轨迹列出其中的工具）。 */
function turnItems(page: Page, firstUserText: string) {
  return page.evaluate((text) => {
    const children = [...(document.querySelector('.message-stream')?.children ?? [])];
    const start = children.findLastIndex((node) => node.classList.contains('chat-row') &&
      node.classList.contains('user') && node.textContent?.includes(text));
    return children.slice(start).flatMap((node) => {
      if (node.classList.contains('run-trace')) {
        const tools = [...node.querySelectorAll('[data-tool-call-id]')]
          .map((tool) => tool.getAttribute('data-tool-call-id')?.replace(/-[0-9a-f-]{36}$/u, ''));
        return [`trace:${tools.join(',')}`];
      }
      if (!node.classList.contains('chat-row')) return [];
      const role = node.classList.contains('user') ? 'user' : 'reply';
      const author = node.querySelector('.message-author')?.textContent ?? '';
      return [`${role}:${node.querySelector('.chat-content')?.textContent?.slice(author.length) ?? ''}`];
    });
  }, firstUserText);
}

test('运行中立即调整：调整前后的工具各自跟在所属消息之下，按执行顺序排列，刷新后一致', async ({ page }, testInfo) => {
  const draft = page.getByLabel('Multivac 草稿');
  const opening = '运行中调整场景：先检查第一项';
  const steering = '改为检查第二项';
  await draft.fill(opening);
  await draft.press('Enter');

  const firstTool = page.locator('[data-tool-call-id^="steer-first-"]');
  await expect(firstTool).toContainText('执行中');
  await expect.poll(() => turnItems(page, opening)).toEqual([`user:${opening}`, 'trace:steer-first']);

  await draft.fill(steering);
  await page.getByRole('button', { name: '立即调整' }).click();
  await page.getByLabel('发送消息').click();

  // 调整消息交付后：之前的工具留在原消息之下并收起，之后的工具在调整消息之下继续执行。
  const secondTool = page.locator('[data-tool-call-id^="steer-second-"]');
  await expect(secondTool).toContainText('执行中');
  await expect.poll(() => turnItems(page, opening)).toEqual([
    `user:${opening}`, 'trace:steer-first', `user:${steering}`, 'trace:steer-second',
  ]);
  const firstTrace = page.locator('.run-trace').filter({ has: firstTool });
  const secondTrace = page.locator('.run-trace').filter({ has: secondTool });
  await expect(firstTrace).not.toHaveAttribute('open', '');
  await expect(firstTrace.locator('summary')).toContainText('用时');
  await expect(secondTrace).toHaveAttribute('open', '');
  await expect(secondTrace.locator('summary')).toContainText('思考中');
  await page.screenshot({ path: testInfo.outputPath('steer-trace-running.png'), animations: 'disabled' });

  const reply = `已按调整处理：${steering}`;
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  const settled = [`user:${opening}`, 'trace:steer-first', `user:${steering}`, 'trace:steer-second', `reply:${reply}`];
  await expect.poll(() => turnItems(page, opening)).toEqual(settled);
  await page.screenshot({ path: testInfo.outputPath('steer-trace-settled.png'), animations: 'disabled' });

  await page.reload();
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  await expect.poll(() => turnItems(page, opening)).toEqual(settled);
});
