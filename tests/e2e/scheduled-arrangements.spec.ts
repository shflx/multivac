import { test, expect, type Locator, type Page } from '@playwright/test';
import { fakeApiRoot, openPanel } from './test-state.js';
async function openSchedules(page: Page) {
  await page.goto('/'); await expect(page.getByRole('button',{name:'快捷键',exact:true})).toBeVisible();
  await openPanel(page,'management'); await page.getByRole('complementary',{name:'管理导航'}).getByRole('button',{name:'定时安排',exact:true}).click();
  await expect(page.getByRole('main',{name:'定时安排'})).toBeVisible();
}
const detail = (page: Page) => page.getByRole('region',{name:'安排详情'});
async function confirm(page:Page,name:string) { await page.getByRole('dialog',{name,exact:true}).getByRole('button',{name,exact:true}).click(); }
/** 编辑器里的下拉沿用待办筛选菜单：点开触发器后按名称选择。 */
async function choose(scope:Locator,field:string,option:string) { await scope.getByRole('button',{name:new RegExp(`^${field}：`)}).click(); await scope.page().getByRole('option',{name:option,exact:true}).click(); }

test('导航创建单次提醒，到期 Inbox、刷新历史与删除保留',async ({page,request},testInfo) => {
  const name = `单次验收-${crypto.randomUUID()}`, errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await openSchedules(page); await page.getByRole('button',{name:'新建安排',exact:true}).click();
  const form=page.getByRole('dialog',{name:'新建安排'});
  await form.getByLabel('名称',{exact:true}).fill(name); await form.getByLabel('提醒内容').fill('检查单次结果');
  await form.getByRole('radio',{name:'单次'}).click();await choose(form,'时区','协调世界时（UTC）');
  const at = new Date(Date.now()+10000).toISOString().slice(0,19);
  await form.getByLabel('日期',{exact:true}).fill(at.slice(0,10));await form.getByLabel('时间',{exact:true}).fill(at.endsWith(':00') ? at.slice(11,16) : at.slice(11,19));await expect(form.locator(`time[datetime="${at}.000Z"]`)).toBeVisible();
  await form.getByRole('button',{name:'保存并启用'}).click();await expect(detail(page).getByRole('heading',{name,exact:true})).toBeVisible();
  await expect(detail(page).locator('[data-occurrence-status=succeeded]')).toHaveCount(1,{timeout:15000});
  const list = await (await request.get(`${fakeApiRoot}/api/schedules?state=completed&query=${encodeURIComponent(name)}`)).json();expect(list.total).toBe(1);
  const id=list.items[0].scheduleId, history = await (await request.get(`${fakeApiRoot}/api/schedules/${id}`)).json();
  expect(history.history.items[0].plannedAt).toBe(`${at}.000Z`);
  await page.screenshot({path:testInfo.outputPath('schedule-reminder.png'),fullPage:true});
  await detail(page).getByRole('button',{name:'Inbox 通知',exact:true}).click();await expect(page.getByRole('main',{name:'Inbox'})).toBeVisible();await expect(page.getByRole('main',{name:'Inbox'}).getByText('检查单次结果',{exact:true}).first()).toBeVisible();
  await page.getByRole('complementary',{name:'管理导航'}).getByRole('button',{name:'定时安排',exact:true}).click();
  await detail(page).getByRole('button',{name:'删除',exact:true}).click();await confirm(page,'删除安排');await expect(detail(page)).toHaveAttribute('data-schedule-state','deleted');
  await page.reload();await openPanel(page,'management');await page.getByRole('complementary',{name:'管理导航'}).getByRole('button',{name:'定时安排',exact:true}).click();
  await page.getByRole('region',{name:'安排列表'}).getByRole('button',{name:/^已删除/}).click();await page.getByRole('button',{name:new RegExp(name)}).click();await expect(detail(page).locator('[data-occurrence-status=succeeded]')).toHaveCount(1);
  expect((await request.get(`${fakeApiRoot}/api/inbox/${history.history.items[0].notificationId}`)).ok()).toBeTruthy();expect(errors).toEqual([]);
});

test('每日和每周 Agent、双窗口编辑启停、手动执行不移游标与真实进程停止',async ({page,context,request},testInfo) => {
  test.setTimeout(45000);await openSchedules(page);const name=`Agent验收-${crypto.randomUUID()}`;
  await page.getByRole('button',{name:'新建安排',exact:true}).click();let form=page.getByRole('dialog',{name:'新建安排'});
  await form.getByLabel('名称',{exact:true}).fill(name);await form.getByRole('radio',{name:'Agent 执行'}).click();
  // 固定智能体不出现在候选中，默认选中的智能体可用。
  await form.getByRole('button',{name:/^智能体：/}).click();
  await expect(page.getByRole('option',{name:'Multivac（协调）',exact:true})).toHaveCount(0);
  await expect(page.getByRole('option',{selected:true})).toBeEnabled();await page.keyboard.press('Escape');
  await form.getByLabel('指令',{exact:true}).fill('bash执行：'+JSON.stringify({command:'node -e "setInterval(()=>{},1000)"',mode:'foreground'}));
  await choose(form,'时区','协调世界时（UTC）');await form.getByLabel('时间',{exact:true}).fill('23:59');await choose(form,'每次执行时长上限','15 分钟');
  await form.getByRole('button',{name:'保存并启用'}).click();await expect(detail(page).getByRole('heading',{name,exact:true})).toBeVisible();
  const initial=await (await request.get(`${fakeApiRoot}/api/schedules?query=${encodeURIComponent(name)}`)).json();const id=initial.items[0].scheduleId, nextAt=initial.items[0].nextAt;
  const peer=await context.newPage();await openSchedules(peer);await peer.getByRole('button',{name:new RegExp(name)}).click();
  await detail(page).getByRole('button',{name:'暂停',exact:true}).click();await expect(detail(peer)).toHaveAttribute('data-schedule-state','paused');
  await detail(peer).getByRole('button',{name:'启用',exact:true}).click();await expect(detail(page)).toHaveAttribute('data-schedule-state','active');
  await detail(page).getByRole('button',{name:'立即执行一次',exact:true}).click();await confirm(page,'立即执行一次');
  await expect.poll(async()=>{const r=await (await request.get(`${fakeApiRoot}/api/processes?activeOnly=true`)).json();return JSON.stringify(r).includes('setInterval');}).toBeTruthy();
  await expect(detail(page).getByRole('button',{name:'停止本次',exact:true})).toBeEnabled();await detail(page).getByRole('button',{name:'停止本次',exact:true}).click();await confirm(page,'停止本次');
  await expect.poll(async()=>{const r=await (await request.get(`${fakeApiRoot}/api/schedules/${id}`)).json();return r.history.items[0]?.status;}).toBe('stopped');
  const stopped=await (await request.get(`${fakeApiRoot}/api/schedules/${id}`)).json();expect(stopped.schedule.nextAt).toBe(nextAt);expect(stopped.schedule.state).toBe('active');expect(stopped.history.items[0].sessionId).toBeTruthy();
  await detail(page).getByRole('button',{name:'编辑',exact:true}).click();form=page.getByRole('dialog',{name:'编辑安排'});await form.getByRole('radio',{name:'每周'}).click();await form.getByLabel('指令',{exact:true}).fill('检查本周结果');await form.getByRole('button',{name:'保存',exact:true}).click();
  await expect(detail(peer)).toContainText('每周');await page.screenshot({path:testInfo.outputPath('schedule-agent.png'),fullPage:true});
  await detail(page).getByRole('button',{name:'执行会话',exact:true}).first().click();await expect(page.locator('.conversation-panel:visible').first()).toBeVisible();await peer.close();
});

test('创建响应丢失后刷新核对原回执，不重复创建',async ({page,request}) => {
  await openSchedules(page);const name=`回执验收-${crypto.randomUUID()}`;let sent=0;
  await page.route('**/api/schedules',async route=>{if(route.request().method()!=='POST') return route.continue();sent++;await route.fetch();await route.abort('failed');});
  await page.getByRole('button',{name:'新建安排',exact:true}).click();const form=page.getByRole('dialog',{name:'新建安排'});await form.getByLabel('名称',{exact:true}).fill(name);await form.getByLabel('提醒内容').fill('命令只创建一次');await form.getByRole('button',{name:'保存并启用'}).click();
  await expect(page.getByRole('button',{name:'核对上次操作',exact:true})).toBeVisible();await page.reload();await openPanel(page,'management');await page.getByRole('complementary',{name:'管理导航'}).getByRole('button',{name:'定时安排',exact:true}).click();await page.getByRole('button',{name:'核对上次操作',exact:true}).click();
  await expect(detail(page).getByRole('heading',{name,exact:true})).toBeVisible();expect(sent).toBe(1);const list=await (await request.get(`${fakeApiRoot}/api/schedules?query=${encodeURIComponent(name)}`)).json();expect(list.total).toBe(1);
});

test('计划 Agent 在独立会话完成，人工等待由 Inbox 原请求继续，窄屏无横向溢出',async ({page,request},testInfo) => {
  test.setTimeout(45000);await openSchedules(page);
  const taskCount=(await (await request.get(`${fakeApiRoot}/api/tasks`)).json()).total;
  const name=`计划Agent-${crypto.randomUUID()}`, at=new Date(Date.now()+3000).toISOString();
  const draft={name,commandId:crypto.randomUUID(),rule:{kind:'once',scheduledAt:at,localTime:at.slice(0,19)},timeZone:'UTC',missedPolicy:'skip',action:{kind:'agent',instruction:'bash执行：'+JSON.stringify({command:"printf 'scheduled-browser-result' > scheduled-result.txt && cat scheduled-result.txt",timeout:5}),agentId:'general',projectId:null,directory:null,budget:{maxMillis:10000,maxOutputBytes:1048576,maxToolCalls:20}}};
  const saved=await (await request.post(`${fakeApiRoot}/api/schedules`,{data:draft})).json();
  await page.getByRole('button',{name:new RegExp(name)}).click();
  await expect(detail(page).locator('[data-occurrence-status=succeeded]')).toHaveCount(1,{timeout:15000});
  const result=await (await request.get(`${fakeApiRoot}/api/schedules/${saved.scheduleId}`)).json();expect(result.history.items[0].source).toBe('planned');expect(result.history.items[0].executionSnapshot.runtimeConfig.model.provider).toBe('fixture');
  expect((await (await request.get(`${fakeApiRoot}/api/tasks`)).json()).total).toBe(taskCount);
  const askName=`等待回应-${crypto.randomUUID()}`;
  const ask=await (await request.post(`${fakeApiRoot}/api/schedules`,{data:{...draft,name:askName,commandId:crypto.randomUUID(),rule:{kind:'daily',time:'23:59'},action:{...draft.action,instruction:'内部工具：request_schedule_input {"question":"采用哪种输出格式？"}',budget:{...draft.action.budget,maxMillis:20000}}}})).json();
  await page.getByRole('button',{name:new RegExp(askName)}).click();await detail(page).getByRole('button',{name:'立即执行一次',exact:true}).click();await confirm(page,'立即执行一次');
  await expect(detail(page).locator('.schedule-active')).toContainText('等待人工');await detail(page).locator('.schedule-active').getByRole('button',{name:'去 Inbox 处理',exact:true}).click();
  const inbox=page.getByRole('main',{name:'Inbox',exact:true});await expect(inbox.getByRole('heading',{name:'采用哪种输出格式？',exact:true})).toBeVisible();await inbox.getByLabel('回应',{exact:true}).fill('Markdown');await inbox.getByRole('button',{name:'提交回应',exact:true}).click();
  await expect.poll(async()=>{const d=await (await request.get(`${fakeApiRoot}/api/schedules/${ask.scheduleId}`)).json();return d.history.items[0]?.status;},{timeout:10000}).toBe('succeeded');
  await page.getByRole('complementary',{name:'管理导航'}).getByRole('button',{name:'定时安排',exact:true}).click();
  await expect(detail(page).locator('.schedule-active')).toHaveCount(0);
  for(const width of [768,390]) {await page.setViewportSize({width,height:900});if(width === 390) await expect(page.getByRole('heading',{name:'管理请在桌面使用',exact:true})).toBeVisible(); else await expect(detail(page)).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();await page.screenshot({path:testInfo.outputPath(`schedule-${width}.png`),fullPage:true});}
});


test('通知跳转保留指定安排结果，不被更新的通知替换且不重复写已读', async ({ page }) => {
  const errors: string[] = [], stateWrites: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/inbox\/[^/]+\/state$/.test(request.url())) stateWrites.push(request.url()); });
  await openSchedules(page);
  const id = crypto.randomUUID(), older = `较早结果-${id}`, newer = `更新结果-${id}`;
  for (const name of [older, newer]) {
    await page.getByRole('button', { name: '新建安排', exact: true }).click();
    const form = page.getByRole('dialog', { name: '新建安排' });
    await form.getByLabel('名称', { exact: true }).fill(name);
    await form.getByLabel('提醒内容').fill(name);
    await form.getByRole('button', { name: '保存并启用', exact: true }).click();
    await expect(detail(page).getByRole('heading', { name, exact: true })).toBeVisible();
    await detail(page).getByRole('button', { name: '立即执行一次', exact: true }).click();
    await confirm(page, '立即执行一次');
    await expect(detail(page).locator('[data-occurrence-status=succeeded]')).toHaveCount(1);
  }
  await page.getByRole('region', { name: '安排列表' }).getByRole('button', { name: new RegExp(older) }).click();
  await detail(page).getByRole('button', { name: 'Inbox 通知', exact: true }).click();
  const inbox = page.getByRole('main', { name: 'Inbox', exact: true });
  await expect(inbox.getByRole('heading', { name: older, exact: true })).toBeVisible();
  await expect(inbox.getByRole('button', { name: new RegExp(older) }).getByRole('img', { name: '未查看', exact: true })).toHaveCount(0);
  expect(stateWrites.length).toBe(1);
  expect(errors).toEqual([]);
});


test('安排与时间上下文首次读取失败后，刷新恢复列表和新建入口', async ({ page }) => {
  const reads = /\/api\/schedules(?:\/context)?\?/;
  await page.route(reads, route => route.abort('failed'));
  await openSchedules(page);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: '新建安排', exact: true })).toBeDisabled();
  await expect(page.getByText('正在读取安排…', { exact: true })).toHaveCount(0);
  await expect(page.getByText('安排尚未读取，请点击“刷新安排”重试。', { exact: true })).toBeVisible();
  await page.unroute(reads);
  await page.getByRole('button', { name: '刷新安排', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新建安排', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '新建安排', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '新建安排' })).toBeVisible();
});
