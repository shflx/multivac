import { mkdir } from 'node:fs/promises';
await mkdir('.tmp/prototype-alignment', { recursive: true });
import { chromium, expect } from '@playwright/test';
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const nav=async name=>page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name,exact:true}).click();
try {
 await page.goto(process.env.PROTOTYPE_URL || 'http://127.0.0.1:5179');await page.getByRole('textbox',{name:'发送给 Multivac'}).waitFor();
 await page.keyboard.press('Meta+g');await page.getByRole('dialog').waitFor();await page.keyboard.press('3');
 for(const name of ['运行','成果','会话','读书','笔记','归档','项目','能力','智能体','模型','知识与记忆','偏好','待办']) { await nav(name); await page.waitForTimeout(100); expect(errors, name).toEqual([]); }
 // 从筛选外任务的快速跳转恢复可见性。
 await page.getByRole('textbox',{name:'搜索任务',exact:true}).fill('不存在的任务');
 await page.keyboard.press('Meta+k');await page.getByRole('dialog').waitFor();
 const search=page.getByRole('dialog').getByRole('combobox');await search.fill('审阅实现结果');await page.keyboard.press('Enter');
 const inspector=page.getByRole('complementary',{name:'任务详情'});
 await expect(inspector.getByRole('heading',{name:'审阅实现结果',exact:true})).toBeVisible();
 await inspector.getByRole('textbox',{name:'修改意见'}).fill('补充交互验证');await inspector.getByRole('button',{name:'要求修改',exact:true}).click();
 await expect(inspector.getByText('已暂停',{exact:true})).toBeVisible();
 // 模型页离开守卫与草稿推理等级。
 await nav('模型');await page.getByRole('button',{name:'编辑',exact:true}).click();await page.getByRole('textbox',{name:'模型 ID',exact:true}).fill('new-model');
 await expect(page.getByText('保存后确认可选推理等级。',{exact:true})).toBeVisible();
 await nav('项目');await expect(page.getByRole('dialog')).toBeVisible();
 await page.getByRole('button',{name:'继续编辑',exact:true}).click();
 await page.getByRole('button',{name:'取消',exact:true}).click();
 await nav('项目');
 // 工作区会话状态、模型运行时不可切换、阅读原文。
 await page.keyboard.press('Meta+g');await page.getByRole('dialog').waitFor();await page.keyboard.press('2');
 await expect(page.getByRole('complementary',{name:'工作区侧栏'})).toBeVisible();
 const panel=page.locator('.conversation-panel').filter({has:page.locator('textarea')}).first();
 await panel.locator('textarea').fill('检查代码');await panel.getByRole('button',{name:'发送',exact:true}).click();
 await expect(panel.locator('.session-read-status')).toHaveText('处理中');
 await panel.locator('.model-selector-trigger').click();await expect(panel.getByRole('combobox')).toBeDisabled();
 await page.keyboard.press('Escape');await expect(panel.locator('.session-read-status')).toHaveText('已查看',{timeout:10000});
 await panel.getByRole('button',{name:'查看文件',exact:true}).click();await expect(page.locator('.discussion-surface.has-reading')).toBeVisible();
 await page.screenshot({path:'.tmp/prototype-alignment/workspace.png'});
 // 窄屏下原型特有读书入口仍可打开。
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'回到 Multivac',exact:true}).first().click();
 await page.screenshot({path:'.tmp/prototype-alignment/narrow.png'});
 expect(errors).toEqual([]);console.log(JSON.stringify({passed:true,errors}));
} catch(error){console.log('ERRORS',errors);console.log((await page.locator('body').innerText()).slice(-6000));await page.screenshot({path:'.tmp/prototype-alignment/sweep-failure.png'});throw error;} finally {await browser.close();}
