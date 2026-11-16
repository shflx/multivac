import { expect, test } from '@playwright/test';
import type { InboxItem, InboxList } from '@multivac/contracts';
import { fakeApiRoot, resetE2eState } from './test-state.js';

for (const remote of [false, true]) test(`${remote ? '远程' : '桌面'} Inbox 后续历史分页挂起时立即显示真实回执并可处理下一项`, async ({ page, request }, info) => {
  await resetE2eState(request);
  const questions = ['第一项采用哪份资料？', '第二项需要补充什么？'];
  const ids: string[] = [], tasks: string[] = [];
  for (let i = 0; i < 2; i++) {
    const created = await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: `delay-create-${i}`, title: `来源核对 ${i}`, goal: '核对回执' } });
    const { task } = await created.json(); tasks.push(task.taskId);
    const asked = await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/requests`, { data: { commandId: `delay-ask-${i}`, question: questions[i] } });
    const { request: human } = await asked.json(); ids.push(human.requestId);
    const { task: fresh } = await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json();
    expect((await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/control`, { data: { commandId: `delay-pause-${i}`, revision: fresh.revision, action: 'pause' } })).ok()).toBeTruthy();
  }
  let hold = false, held = false, active = 0, maxActive = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // 业务决定走真实服务，只为列表增加历史并控制后续分页的网络时序。
  await page.route('**/api/inbox?*', async route => {
    active++; maxActive = Math.max(maxActive, active);
    try {
      const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
      if (hold && offset === 100) { held = true; await gate; }
      const original = await request.get(`${fakeApiRoot}/api/inbox?status=all&limit=100&offset=0`);
      const facts = await original.json() as InboxList;
      const base = facts.items.find(item => item.id === ids[0])!;
      const history: InboxItem[] = Array.from({ length: 101 }, (_, i) => ({ ...base, id: `history-${i}`, title: `历史回应 ${i}`, revision: 2, status: 'answered',
        human: { ...base.human!, requestId: `history-${i}`, revision: 2, status: 'answered', decision: 'answer', answer: '历史已保存' }, state: { revision: 0, draft: '', seen: true } }));
      const items = [...facts.items, ...history];
      await route.fulfill({ json: { ...facts, items: items.slice(offset, offset + 100), total: items.length, nextOffset: offset + 100 < items.length ? offset + 100 : null } });
    } finally { active--; }
  });
  if (remote) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/access', route => route.fulfill({ json: { kind: 'remote', authenticated: true, loginEnabled: true } }));
  }
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Inbox，2 项待处理', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Inbox', exact: true });
    await drawer.locator('.inbox-item').filter({ hasText: questions[0] }).click();
    await drawer.getByRole('textbox', { name: '澄清回应' }).fill('只使用已确认资料');
    await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/inbox/${ids[0]}`)).json()).item.state.draft).toBe('只使用已确认资料');
    await expect.poll(() => active).toBe(0);
    hold = true;
    const receipt = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/${ids[0]}/decision`));
    await drawer.getByRole('button', { name: '提交回应', exact: true }).click();
    expect((await receipt).ok()).toBeTruthy();
    await expect.poll(() => held).toBe(true);
    await expect(drawer).toContainText('回应已保存：只使用已确认资料');
    await expect(drawer.getByRole('heading', { name: questions[0], exact: true })).toBeVisible();
    const next = drawer.getByRole('button', { name: `处理下一项：${questions[1]}`, exact: true });
    await expect(next).toBeEnabled();
    await page.screenshot({ path: info.outputPath('inbox-delayed-receipt.png'), animations: 'disabled' });
    await next.click();
    await expect(drawer.getByRole('heading', { name: questions[1], exact: true })).toBeVisible();
    expect(maxActive).toBe(1);
    const detail = await (await request.get(`${fakeApiRoot}/api/tasks/${tasks[0]}`)).json();
    expect(detail.task.pauseSource).toBe('user'); expect(detail.task.currentRunId).toBe(null);
    hold = false; release();
    await expect(page.getByRole('button', { name: 'Inbox，1 项待处理', exact: true })).toBeVisible();
  } finally { hold = false; release(); }
});
