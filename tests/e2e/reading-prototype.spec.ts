import { expect, test } from '@playwright/test';
import { openPanel, fakeApiRoot } from './test-state.js';

// 使用原型的同一章作为测试输入，比较实际分页页面；生产书架不植入示例数据。
const paragraphs = [
  '在分布式系统里，网络可能丢包、时钟可能不准、节点可能暂停。容错的一种办法，是找到一些通用的抽象，让应用可以依赖它们提供的保证。',
  '多数复制数据库至少提供最终一致性：如果停止写入并等待一段不确定的时间，所有读请求最终会返回相同的值。这是一种很弱的保证，它没有说什么时候会收敛。',
  '线性一致性的想法是让系统看起来好像只有一个数据副本，而且所有操作都是原子的。有了这个保证，即使底层有多个副本，应用也不必关心它们。',
  '一旦某个读操作返回了新值，之后的所有读操作都必须返回新值，即使写操作还没有完成。这就是线性一致性里“新鲜度”的含义。',
  '线性一致性很容易和可串行化混淆。可串行化是事务的隔离属性，保证多个事务的执行结果等价于某种串行顺序；线性一致性是对单个对象读写的新鲜度保证。',
  '实现线性一致性要付出性能代价，网络延迟越大代价越明显。这也是很多数据库选择不提供它的原因。',
];

test('原型阅读布局与正文笔记定位，浏览不推进边界，底部仅保留分页控件', async ({ page, request }, testInfo) => {
  const book = await (await request.post(`${fakeApiRoot}/api/reading/books`, { data: { commandId: 'prototype-layout', title: '数据密集型应用系统设计', author: 'Martin Kleppmann', format: 'md', text: '# 第 9 章 一致性与共识\n\n' + paragraphs.join('\n\n') + '\n\n# 第 10 章 批处理\n\n批处理系统接收大量输入数据，运行作业处理它们，并产生输出。作业通常要跑一段时间，所以不会有用户在等待。' } })).json();
  const scope = async () => (await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/scope`)).json());
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  await page.getByRole('navigation', { name: '书架' }).getByRole('button', { name: /数据密集型应用系统设计/u }).click();
  await expect(page.getByLabel('页码', { exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '本页已读', exact: true })).toHaveCount(0);
  const toolbar = await page.locator('.reading-toolbar').boundingBox();
  const footer = await page.locator('.reading-pagination').boundingBox();
  const prose = await page.getByLabel('书籍正文', { exact: true }).boundingBox();
  expect(toolbar!.height).toBe(54); expect(prose!.width).toBe(680);
  expect(footer!.y + footer!.height).toBe(900);
  await page.screenshot({ path: testInfo.outputPath('reading-aligned-desktop.png') });
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  expect((await scope()).boundary).toBeNull();

  const boundary = (await scope()).boundary;
  await page.evaluate(() => {
    const paragraphs = document.querySelectorAll('.reading-flow p');
    const range = document.createRange(); range.setStart(paragraphs[0]!.firstChild!.firstChild!, 0); range.setEnd(paragraphs[1]!.firstChild!.firstChild!, 20);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange'));
  });
  await page.getByRole('toolbar', { name: '选区操作' }).getByRole('button', { name: '写笔记', exact: true }).click();
  await page.getByLabel('笔记内容').fill('抽象提供的保证需要区分强弱，以及收敛的时间。');
  await page.getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(page.getByLabel('笔记内容')).toHaveCount(0);
  await expect(page.locator('.reading-note-mark')).toHaveCount(2);
  await page.locator('.reading-note-mark').last().press('Enter');
  await expect(page.getByLabel('笔记内容')).toHaveValue('抽象提供的保证需要区分强弱，以及收敛的时间。');
  await page.getByRole('button', { name: '收起笔记，保留草稿' }).click();
  await page.getByRole('button', { name: '阅读笔记', exact: true }).click();
  await page.getByRole('button', { name: '定位原文', exact: true }).click();
  await expect(page.locator('.reading-located').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '返回阅读处', exact: true })).toBeVisible();
  expect((await scope()).boundary).toEqual(boundary);
  await page.screenshot({ path: testInfo.outputPath('reading-aligned-notes.png') });
  await page.getByRole('button', { name: '关闭返回提示' }).click();
  await page.getByRole('button', { name: '收起辅助面板' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('书籍正文', { exact: true })).toBeVisible();
  await expect(page.getByLabel('页码', { exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '本页已读', exact: true })).toHaveCount(0);
  const controls = await page.locator('.reading-pagination').evaluate(el => [...el.querySelectorAll('button,input')].map(control => { const r = control.getBoundingClientRect(); return { left: r.left, right: r.right }; }));
  expect(controls.every(r => r.left >= 0 && r.right <= 390)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('reading-aligned-mobile.png') });
  await page.reload(); await page.getByRole('button', { name: '读书', exact: true }).click();
  await expect.poll(async () => (await scope()).boundary).toEqual(boundary);
});
