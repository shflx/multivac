import { mkdir } from 'node:fs/promises';
await mkdir('.tmp/prototype-alignment', { recursive: true });
import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const nav = async (name) => page.getByRole('navigation', { name: '主要导航' }).getByRole('button', { name, exact: true }).click();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
try {
  await page.goto(process.env.PROTOTYPE_URL || 'http://127.0.0.1:5179');
  await page.getByRole('textbox', { name: '发送给 Multivac' }).waitFor();

  // 图片输入：选择后模拟上传，完成后可只发图片，消息里显示缩略图并可预览。
  const assistant = page.locator('.assistant-composer');
  await assistant.locator('input[type="file"]').setInputFiles({ name: 'diagram.png', mimeType: 'image/png', buffer: PNG });
  await expect(assistant.getByText('上传中', { exact: true })).toBeVisible();
  await expect(assistant.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  await assistant.getByRole('button', { name: '发送', exact: true }).click();
  await page.locator('.message-stream').getByRole('button', { name: '查看图片 diagram.png' }).click();
  await expect(page.getByRole('dialog', { name: '图片预览' })).toBeVisible();
  await page.getByRole('button', { name: '放大图片' }).click();
  await expect(page.getByRole('dialog', { name: '图片预览' }).getByText('150%', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '图片预览' })).toBeHidden();
  await assistant.locator('input[type="file"]').setInputFiles([1, 2, 3, 4, 5].map((index) => ({ name: `p${index}.png`, mimeType: 'image/png', buffer: PNG })));
  await expect(assistant.getByText('最多 4 张图片，总大小不超过 20 MiB。', { exact: true })).toBeVisible();

  // 任务树由父任务统一执行；子任务引导回父任务。
  await page.keyboard.press('Meta+g'); await page.getByRole('dialog').waitFor(); await page.keyboard.press('3');
  await page.getByRole('button', { name: '查看任务：统一模型配置页文案', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '任务详情' });
  await expect(inspector.getByText('由父任务会话统一处理，没有独立子任务运行；暂停、继续请在父任务操作。', { exact: true })).toBeVisible();
  await expect(inspector.getByText('处理中', { exact: true })).toBeVisible();
  await inspector.getByRole('button', { name: '查看父任务执行', exact: true }).click();
  await expect(inspector.getByRole('heading', { name: '统一设置页说明文案', exact: true })).toBeVisible();
  await expect(inspector.getByRole('region', { name: '任务树执行' })).toContainText('本次固定范围 3 项；本轮成果候选 1 项。');
  await inspector.getByRole('button', { name: '暂停', exact: true }).click();
  await inspector.getByRole('button', { name: /统一模型配置页文案/ }).first().click();
  await expect(inspector.getByText('待继续', { exact: true })).toBeVisible();
  await page.screenshot({ path: '.tmp/prototype-alignment/task-tree.png' });

  // 额度用完暂停的任务：继续时提示补充额度。
  await page.getByRole('button', { name: '查看任务：补充页面可访问性检查', exact: true }).click();
  await expect(inspector.getByText('继续任务会按当前偏好补充执行额度，已有工作和历史记录保留。', { exact: true })).toBeVisible();

  // 独立任务会话视图：不改写工作区现场，失败原因默认展开。
  await page.getByRole('button', { name: '查看任务：检查构建环境', exact: true }).click();
  await inspector.getByRole('button', { name: '打开任务会话', exact: true }).click();
  const failure = page.getByRole('note', { name: '本次运行失败原因' });
  await expect(failure).toContainText('找不到 tsconfig.demo.json');
  await page.screenshot({ path: '.tmp/prototype-alignment/task-session.png' });
  await page.getByRole('button', { name: '返回工作区', exact: true }).click();
  await expect(failure).toBeHidden();

  // 偏好：任务执行预算与执行诊断。
  await page.keyboard.press('Meta+g'); await page.getByRole('dialog').waitFor(); await page.keyboard.press('3');
  await nav('偏好');
  const budget = page.getByRole('combobox', { name: '执行时长上限', exact: true });
  await expect(budget).toHaveValue(String(6 * 3600000));
  await budget.selectOption({ label: '2 小时' });
  await expect(budget).toHaveValue(String(2 * 3600000));
  await page.getByRole('combobox', { name: '执行诊断', exact: true }).selectOption('off');

  // 模型默认推理等级与待核对状态。
  await nav('模型');
  await page.getByRole('button', { name: /自建 Responses 模型/ }).first().click();
  await expect(page.getByText(/高（待核对/)).toBeVisible();
  await page.getByRole('button', { name: /GPT-5\.2/ }).first().click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '默认推理等级', exact: true })).toHaveValue('high');
  await page.getByRole('button', { name: '取消', exact: true }).click();

  // 运行：会话启动的托管进程与“结束会话运行”。
  await nav('运行');
  const processes = page.getByRole('region', { name: '后台进程' });
  await expect(processes.getByText('前台执行', { exact: true })).toBeVisible();
  await expect(processes.getByText('恢复核对 · 服务重启后进程归属待核对', { exact: true })).toBeVisible();
  await processes.getByRole('button', { name: '结束会话运行', exact: true }).first().click();
  await expect(processes.getByText('这将结束该会话当前执行，并停止该会话全部托管进程。其他会话不受影响。', { exact: false })).toBeVisible();
  await page.screenshot({ path: '.tmp/prototype-alignment/processes.png' });
  await processes.getByRole('alert').getByRole('button', { name: '结束会话运行', exact: true }).click();
  await expect(processes.getByText('单元测试', { exact: true })).toBeHidden();
  await expect(processes.getByText('文档预览服务', { exact: true })).toBeHidden();

  // 读书：导入书籍、移除划线后撤销、删除书籍。
  await nav('读书');
  await page.getByRole('button', { name: '书架', exact: true }).click();
  await page.getByRole('button', { name: '导入书籍', exact: true }).click();
  const importer = page.getByRole('dialog', { name: '导入书籍' });
  await importer.locator('input[type="file"]').setInputFiles({ name: '阅读笔记.md', mimeType: 'text/markdown', buffer: Buffer.from('# 第一章\n第一段正文。\n\n第二段正文。\n# 第二章\n第三段正文。') });
  await importer.getByRole('button', { name: '导入', exact: true }).click();
  await expect(importer.getByText('正在导入，完成后自动打开书籍。', { exact: true })).toBeVisible();
  await expect(importer).toBeHidden({ timeout: 5000 });
  await expect(page.getByRole('heading', { name: '《阅读笔记》', exact: true })).toBeVisible();
  await page.screenshot({ path: '.tmp/prototype-alignment/reading-import.png' });
  await page.getByRole('button', { name: '书架', exact: true }).click();
  await page.getByRole('button', { name: '删除《阅读笔记》', exact: true }).click();
  await page.getByRole('alert').getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByRole('button', { name: '删除《阅读笔记》', exact: true })).toBeHidden();

  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, errors }));
} catch (error) {
  console.log('ERRORS', errors);
  console.log((await page.locator('body').innerText()).slice(-6000));
  await page.screenshot({ path: '.tmp/prototype-alignment/features-failure.png' });
  throw error;
} finally { await browser.close(); }
