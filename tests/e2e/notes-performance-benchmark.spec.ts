import { expect, test, type Page } from '@playwright/test';
import { openPanel } from './test-state.js';
import { noteBody } from './notes-helpers.js';

// 独立性能采样，不设置耗时门槛。须在允许启动测试服务/浏览器的环境显式启用。
test.skip(process.env.MULTIVAC_NOTES_BENCHMARK !== '1', '设置 MULTIVAC_NOTES_BENCHMARK=1 启用采样');
const unit = '长段落性能样本文字。';
const text = (length: number) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
const typed = '连续输入性能测量文本用于笔记响应速度验证'.repeat(2).slice(0, 20);
const time = '2026-01-01T00:00:00.000Z';
const summary = (id: string, title = id) => ({ id, title, revision: 1, createdAt: time, updatedAt: time });

async function openNotes(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '快捷键', exact: true })).toBeVisible();
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '笔记', exact: true }).click();
  await expect(noteBody(page)).toBeVisible();
}
async function begin(page: Page) {
  await page.evaluate(() => {
    const state = window as typeof window & { noteBenchmark?: { start: number; tasks: { start: number; duration: number }[]; supported: boolean; observer?: PerformanceObserver } };
    state.noteBenchmark?.observer?.disconnect();
    const sample = { start: performance.now(), tasks: [] as { start: number; duration: number }[], supported: PerformanceObserver.supportedEntryTypes.includes('longtask'), observer: undefined as PerformanceObserver | undefined };
    if (sample.supported) {
      sample.observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) sample.tasks.push({ start: entry.startTime, duration: entry.duration }); });
      sample.observer.observe({ type: 'longtask' });
    }
    state.noteBenchmark = sample;
  });
}
async function end(page: Page) {
  return page.evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const state = (window as typeof window & { noteBenchmark: { start: number; tasks: { start: number; duration: number }[]; supported: boolean; observer?: PerformanceObserver } }).noteBenchmark;
    const elapsedMs = performance.now() - state.start;
    const tasks = state.tasks.filter(task => task.start >= state.start);
    state.observer?.disconnect();
    return { elapsedMs, longTaskSupported: state.supported, longTasks: tasks, mountedRows: document.querySelectorAll('.note-list-open').length, openedDocuments: document.querySelectorAll('.notes-open-document').length };
  });
}

for (const [name, body] of [
  ['short', text(100)], ['single', text(99000)],
  ['multi', Array.from({ length: 96 }, () => text(1000)).join('\n\n')],
] as const) {
  test(`输入20字符采样：${name}`, async ({ page, browser }, testInfo) => {
    const note = { ...summary(`perf-${name}`), body };
    await page.route('**/api/notes', route => route.fulfill({ json: { notes: [summary(note.id)] } }));
    await page.route(`**/api/notes/${note.id}`, route => route.fulfill({ json: note }));
    // 每次导航清除本测试的笔记草稿，使重复样本都从同一正文开始。
    await page.addInitScript(id => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('multivac:note-draft:')) localStorage.removeItem(key);
      for (const key of Object.keys(sessionStorage)) if (key.startsWith('multivac:note-')) sessionStorage.removeItem(key);
      sessionStorage.setItem('multivac:active-note', id);
    }, note.id);
    const samples = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      await openNotes(page);
      await expect(noteBody(page)).toHaveText(body.replace(/\n\n/g, ''));
      await noteBody(page).focus(); await noteBody(page).press('ControlOrMeta+End');
      await begin(page); await noteBody(page).pressSequentially(typed);
      samples.push(await end(page));
      const draft = await page.evaluate(id => {
        const key = sessionStorage.getItem(`multivac:note-draft-pointer:${id}`);
        return key ? JSON.parse(localStorage.getItem(key) ?? 'null') as { body: string } | null : null;
      }, note.id);
      expect(draft?.body).toBe(body + typed);
    }
    await testInfo.attach(`notes-input-${name}.json`, { body: JSON.stringify({ browser: browser.version(), viewport: page.viewportSize(), bodyCharacters: body.length, typed, samples }, null, 2), contentType: 'application/json' });
  });
}

for (const count of [100, 1000]) {
  test(`列表显示搜索切换采样：${count}`, async ({ page, browser }, testInfo) => {
    const notes = Array.from({ length: count }, (_, index) => summary(`perf-${index}`, `性能笔记${String(index).padStart(4, '0')}`));
    await page.route('**/api/notes', route => route.fulfill({ json: { notes } }));
    await page.route(/\/api\/notes\/perf-\d+$/, route => {
      const id = new URL(route.request().url()).pathname.split('/').at(-1);
      return route.fulfill({ json: { ...notes.find(note => note.id === id), body: '短正文' } });
    });
    await openNotes(page);
    const library = page.getByRole('complementary', { name: '笔记库' });
    const search = library.getByRole('searchbox', { name: '搜索笔记标题', exact: true });
    const samples = [];
    // 先打开两篇，之后的切换不计入首次正文读取和挂载；所有样本固定打开数为2。
    await library.locator('.note-list-open').nth(1).click();
    await expect(page.locator('.notes-open-document')).toHaveCount(2);
    for (let repeat = 0; repeat < 3; repeat++) {
      await page.locator('.notes-open-document:visible').getByRole('button', { name: '专注写作', exact: true }).click();
      await begin(page);
      await page.locator('.notes-open-document:visible').getByRole('button', { name: '退出专注写作', exact: true }).click();
      const show = await end(page);
      await begin(page); await search.fill('性能'); const searchAll = await end(page);
      await search.fill('');
      await begin(page); await library.locator('.note-list-open').nth(repeat % 2).click(); const change = await end(page);
      samples.push({ show, searchAll, change });
    }
    await testInfo.attach(`notes-list-${count}.json`, { body: JSON.stringify({ browser: browser.version(), viewport: page.viewportSize(), count, opened: 2, samples, method: '列表显示以退出专注为触发；搜索匹配全部；切换已挂载短笔记；包含自动化协议与两帧等待' }, null, 2), contentType: 'application/json' });
  });
}
