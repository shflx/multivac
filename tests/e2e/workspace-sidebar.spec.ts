import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, openCreationDialog, openPanel, resetE2eState } from './test-state.js';

const workspaceBar = (page: Page) => page.getByRole('toolbar', { name: '工作区' });
const sidebar = (page: Page) => page.locator('.multivac-sidebar');

async function createSession(page: Page, title: string): Promise<void> {
  await openCreationDialog(page);
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill(title);
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
  // 新会话读完后把焦点交给自己的输入区；等它就绪再操作侧栏，免得焦点随后被抢走。
  await expect(page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
    .getByLabel('Multivac 草稿')).toBeFocused();
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  const current = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json() as { revision: number };
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: current.revision },
  });
  await page.goto('/');
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  await openPanel(page, 'workspace');
});

test('收起时不留窄轨，旧版记住的展开状态不再生效；叫出后与首页是同一会话并提示当前焦点会话', async ({ page }) => {
  // 旧版把开合记在本机：残留的“展开”记录不再让侧栏默认展开，并被清除。
  await page.evaluate(() => localStorage.setItem('multivac.workspace.multivac-sidebar', 'expanded'));
  await page.reload();
  await openPanel(page, 'workspace');
  await expect(sidebar(page)).toBeHidden();
  await expect(page.getByRole('button', { name: /展开 Multivac/ })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('multivac.workspace.multivac-sidebar'))).toBeNull();
  // 没有窄轨：工作区铺满内容区。
  const content = (await page.locator('.shell-content').boundingBox())!;
  const shell = (await page.locator('.workspace-shell').boundingBox())!;
  expect(Math.round(shell.x + shell.width)).toBe(Math.round(content.x + content.width));

  await createSession(page, '梳理导航结构');
  await createSession(page, '核对接口');
  await page.keyboard.press('ControlOrMeta+J');
  await expect(sidebar(page).getByLabel('Multivac 草稿')).toBeFocused();
  await expect(sidebar(page).getByText('与首页是同一个对话 · 开始干活即收起')).toBeVisible();
  await expect(sidebar(page).locator('.composer-context')).toHaveText('正在看「核对接口」，可以直接说“这个”');

  // 点选不算干活：切到并排、点会话标题，侧栏都不收起。
  await workspaceBar(page).getByRole('button', { name: '并排', exact: true }).click();
  await page.locator('.conversation-panel h2').first().click();
  await expect(sidebar(page)).toBeVisible();
  // 点进另一个会话的输入区才是开始干活：Multivac 已处理完，侧栏收起；再叫出时提示随焦点会话变化。
  await page.getByRole('button', { name: '在「梳理导航结构」中继续' }).click();
  await expect(sidebar(page)).toBeHidden();
  await page.keyboard.press('ControlOrMeta+J');
  await expect(sidebar(page).locator('.composer-context')).toHaveText('正在看「梳理导航结构」，可以直接说“这个”');

  // 在侧栏发送：处理完也不收起（处理结束本身不收起）；消息回到首页可见。
  const draft = sidebar(page).getByLabel('Multivac 草稿');
  await draft.fill('这个会话下一步做什么？');
  await sidebar(page).getByLabel('发送消息').click();
  await expect(sidebar(page).getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(sidebar(page)).toBeVisible();
  await openPanel(page, 'home');
  await expect(sidebar(page)).toBeHidden();
  await expect(page.locator('.work-surface').first().locator('article.chat-row.user')
    .filter({ hasText: '这个会话下一步做什么？' })).toHaveCount(1);

  // 首页发送的消息在侧栏可见；回到工作区时侧栏保持离开时的样子（工作区把焦点还给当前会话不算开始干活）。
  await page.locator('.work-surface').first().getByLabel('Multivac 草稿').fill('首页发出的消息');
  await page.locator('.work-surface').first().getByLabel('发送消息').click();
  await openPanel(page, 'workspace');
  await expect(sidebar(page)).toBeVisible();
  await expect(sidebar(page).locator('article.chat-row.user').filter({ hasText: '首页发出的消息' })).toHaveCount(1);

  // 工作区页面按剩余宽度排版，不横向溢出。
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth))
    .toBe(false);
  // 等入场动画结束再测量布局：并排时侧栏挤压工作区。
  await sidebar(page).evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const squeezed = (await page.locator('.workspace-shell').boundingBox())!;
  const panel = (await sidebar(page).boundingBox())!;
  expect(Math.round(panel.width)).toBe(360);
  expect(squeezed.x + squeezed.width).toBeLessThanOrEqual(panel.x + 1);
  expect(panel.x + panel.width).toBeLessThanOrEqual(content.x + content.width + 1);
});

test('开始干活即收起：点进或 Tab 进工作区的输入区时收起；有草稿、正在运行时保持展开', async ({ page, request }) => {
  await createSession(page, '整理需求');
  const workDraft = page.locator('.conversation-panel').getByLabel('Multivac 草稿');
  const draft = sidebar(page).getByLabel('Multivac 草稿');

  // 侧栏里有未发出的草稿：点进工作区输入区不收起。
  await page.keyboard.press('ControlOrMeta+J');
  await draft.fill('写了一半');
  await workDraft.click();
  await expect(workDraft).toBeFocused();
  await expect(sidebar(page)).toBeVisible();

  // 正在运行：同样不收起；处理完也不自动收起，下一次开始干活时才收起。
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
  await draft.press('Enter');
  expect((await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`)).ok()).toBe(true);
  await expect(sidebar(page).getByRole('button', { name: '取消当前处理' })).toBeVisible();
  await workDraft.click();
  await expect(sidebar(page)).toBeVisible();
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(sidebar(page).getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).locator('.message-scroll').click({ position: { x: 20, y: 20 } });
  await workDraft.click();
  await expect(sidebar(page)).toBeHidden();

  // 键盘同样算：从会话里输入区前面的一个控件 Tab 进输入区即收起。
  await page.keyboard.press('ControlOrMeta+J');
  await expect(draft).toBeFocused();
  await page.evaluate(() => {
    const panel = document.querySelector('.conversation-panel')!;
    const tabbable = [...panel.querySelectorAll<HTMLElement>('button, textarea, input, [tabindex="0"]')]
      .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.checkVisibility());
    const textarea = panel.querySelector('textarea')!;
    tabbable[tabbable.indexOf(textarea) - 1]!.focus();
  });
  await expect(sidebar(page)).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(workDraft).toBeFocused();
  await expect(sidebar(page)).toBeHidden();
});

test('⌘J / Ctrl+J、收起按钮与 Esc；收起不丢草稿与阅读位置，刷新后回到收起', async ({ page }) => {
  await createSession(page, '整理需求');
  const workDraft = page.locator('.conversation-panel').getByLabel('Multivac 草稿');
  await workDraft.click();

  // 快捷键叫出侧栏并把焦点交给输入区；再按一次收起，焦点回到叫出前的位置。
  await page.keyboard.press('ControlOrMeta+j');
  const draft = sidebar(page).getByLabel('Multivac 草稿');
  await expect(draft).toBeFocused();
  const collapse = sidebar(page).getByRole('button', { name: '收起 Multivac' });
  await expect(collapse).toHaveAttribute('aria-keyshortcuts', 'Meta+J Control+J');
  await expect(collapse).toHaveAttribute('title', /^收起 Multivac（(⌘J|Ctrl\+J)）$/);
  await page.keyboard.press('ControlOrMeta+j');
  await expect(sidebar(page)).toBeHidden();
  await expect(workDraft).toBeFocused();

  // 与切换工作区条的 Cmd/Ctrl+\ 互不影响。
  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(workspaceBar(page)).toHaveCount(0);
  await expect(sidebar(page)).toBeHidden();
  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(workspaceBar(page)).toBeVisible();

  // 手动收起随时可用：有草稿也能收起，草稿与阅读位置都保留。
  await page.keyboard.press('ControlOrMeta+j');
  await expect(draft).toBeFocused();
  await draft.fill('侧栏里写了一半');
  const scroll = sidebar(page).locator('.message-scroll');
  await scroll.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 400);
    element.dispatchEvent(new Event('scroll'));
  });
  const readingTop = await scroll.evaluate((element) => element.scrollTop);
  expect(readingTop).toBeGreaterThan(0);
  await collapse.click();
  await expect(sidebar(page)).toBeHidden();
  await page.keyboard.press('ControlOrMeta+j');
  await expect(draft).toHaveValue('侧栏里写了一半');
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(readingTop, 0);

  // Esc：输入框里的 Esc 只作用于输入框；侧栏其他位置的 Esc 收起侧栏，仍停留在工作区。
  await draft.focus();
  await page.keyboard.press('Escape');
  await expect(sidebar(page)).toBeVisible();
  await scroll.focus();
  await page.keyboard.press('Escape');
  await expect(sidebar(page)).toBeHidden();
  await expect(workspaceBar(page)).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.closest('.multivac-sidebar') ?? null)).toBeNull();

  // 首页不响应该快捷键；离开再回到工作区，侧栏保持离开时的样子。
  await page.keyboard.press('ControlOrMeta+j');
  await openPanel(page, 'home');
  await page.keyboard.press('ControlOrMeta+j');
  await expect(sidebar(page)).toBeHidden();
  await openPanel(page, 'workspace');
  await expect(sidebar(page)).toBeVisible();

  // 刷新后从收起开始，草稿仍在。
  await page.reload();
  await openPanel(page, 'workspace');
  await expect(sidebar(page)).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+j');
  await expect(draft).toHaveValue('侧栏里写了一半');
});

test('侧栏内容按侧栏宽度排版：长会话名不把消息和输入区撑出侧栏', async ({ page }) => {
  const title = '会话初始化/恢复、只读分页读历史、页面现场读写与 SSE 推送的对齐方案';
  await createSession(page, title);
  await page.keyboard.press('ControlOrMeta+J');
  await sidebar(page).evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  await expect(sidebar(page).locator('.composer-context')).toHaveAttribute('title', `正在看「${title}」`);
  await sidebar(page).getByLabel('Multivac 草稿').fill('这个会话里 SSE 是什么意思？');
  await sidebar(page).getByLabel('发送消息').click();
  await expect(sidebar(page).getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();

  const bounds = await sidebar(page).boundingBox();
  const right = bounds!.x + bounds!.width;
  for (const selector of ['.assistant-composer', '.composer-context', 'article.chat-row.user .chat-content', '.message-stream']) {
    const box = await sidebar(page).locator(selector).last().boundingBox();
    expect(box!.x + box!.width, selector).toBeLessThanOrEqual(right + 0.5);
  }
});
