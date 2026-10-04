import { test, expect } from '@playwright/test';
import { fakeApiRoot, resetE2eState, openPanel } from './test-state.js';

test('工作会话完成任务后面板实时更新，说明可验收、要求修改并追溯来源', async ({ page, request }) => {
  await resetE2eState(request);
  const sessionId = 'work-completion-e2e';
  expect((await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '任务来源会话' } })).ok()).toBeTruthy();
  const task = (await (await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: 'create', title: '核对引用报告', goal: '比较两个来源并记录日期', acceptance: true } })).json()).task;
  const complete = async (summary: string) => {
    const current = (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).task;
    const response = await request.post(`${fakeApiRoot}/api/sessions/${sessionId}/turns`, { data: {
      commandId: crypto.randomUUID(), assistantSessionId: sessionId, contextRefs: [],
      text: `内部工具：complete_task ${JSON.stringify({ taskId: task.taskId, revision: current.revision, summary })}`,
    } });
    expect(response.ok()).toBeTruthy();
  };
  await page.goto('/');
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  await page.getByRole('button', { name: `查看任务：${task.title}`, exact: true }).click();
  const detail = page.getByRole('complementary', { name: '任务详情' });
  await complete('已核对两个来源，报告位于 report.md。');
  const review = detail.getByRole('region', { name: '任务人工请求' });
  await expect(review).toContainText('已核对两个来源');
  await review.getByRole('textbox', { name: '修改意见' }).fill('补齐来源日期');
  await review.getByRole('button', { name: '要求修改', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(detail.getByRole('region', { name: '当前情况' })).toContainText('已暂停');
  await expect(detail.getByRole('region', { name: '工作会话完成说明' })).toContainText('补齐来源日期');
  await complete('已补齐两个来源日期并再次核对，报告位于 report.md。');
  await expect(review).toContainText('已补齐两个来源日期');
  await review.getByRole('button', { name: '接受成果', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(detail.getByRole('region', { name: '当前情况' })).toContainText('已完成');
  await expect(detail.getByRole('region', { name: '工作会话完成说明' })).toContainText('已补齐两个来源日期');
  await page.reload();
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  await expect(page.getByRole('button', { name: `查看任务：${task.title}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `查看任务：${task.title}`, exact: true }).click();
  await detail.getByRole('button', { name: '查看来源会话', exact: true }).click();
  await expect(page.locator('.workspace-page .conversation-panel:visible')).toContainText('任务来源会话');
});

test('连续交付的审核卡片只在任务详情显示，不堆积在来源对话', async ({ page, request }) => {
  await resetE2eState(request);
  const sessionId = 'batch-completion';
  expect((await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '连续交付会话' } })).ok()).toBeTruthy();
  for (let index = 0; index < 3; index++) {
    const task = (await (await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: `batch-${index}`, title: `批量交付 ${index}`, goal: '核对来源并交付', acceptance: true } })).json()).task;
    const response = await request.post(`${fakeApiRoot}/api/sessions/${sessionId}/turns`, { data: {
      commandId: `complete-${index}`, assistantSessionId: sessionId, contextRefs: [],
      text: `内部工具：complete_task ${JSON.stringify({ taskId: task.taskId, revision: task.revision, summary: `已核对，交付文件 report-${index}.md。` })}`,
    } });
    expect(response.ok()).toBeTruthy();
    const detail = (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json());
    expect(detail.task.status).toBe('review');
    expect(detail.requests.filter((item: { status: string }) => item.status === 'pending')).toHaveLength(1);
  }
  await page.goto('/');
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  await page.getByRole('button', { name: '查看任务：批量交付 0', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '任务详情' });
  await expect(inspector.getByRole('region', { name: '任务人工请求' })).toContainText('report-0.md');
  await inspector.getByRole('button', { name: '查看来源会话', exact: true }).click();
  const conversation = page.locator('.workspace-page .conversation-panel:visible');
  await expect(conversation).toContainText('连续交付会话');
  await expect(conversation.getByRole('region', { name: '任务人工请求' })).toHaveCount(0);
  await expect(conversation.getByRole('button', { name: '接受成果', exact: true })).toHaveCount(0);
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  await page.getByRole('button', { name: '查看任务：批量交付 0', exact: true }).click();
  await inspector.getByRole('button', { name: '接受成果', exact: true }).click();
  await expect(inspector.getByRole('region', { name: '当前情况' })).toContainText('已完成');
  await inspector.getByRole('button', { name: '查看来源会话', exact: true }).click();
  await expect(conversation.getByText('回应已保存', { exact: true })).toHaveCount(0);
  await expect(conversation.getByRole('region', { name: '任务人工请求' })).toHaveCount(0);
});
