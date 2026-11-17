import assert from 'node:assert/strict';
import test from 'node:test';
import type { CurrentViewSnapshot } from '@multivac/contracts';
import { TerminalService } from '../src/application/terminal-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import type { TerminalProcess } from '../src/modules/terminals/terminal-process.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { InternalToolService, MULTIVAC_INTERNAL_TOOLS, WORK_SESSION_TASK_TOOLS, WORK_SESSION_TERMINAL_TOOLS,
  type InternalToolTurn } from '../src/application/internal-tools/index.js';
import { testToolServices } from './fixtures/tool-services.js';
import { TRANSCRIPT_PAGE_MAX_LENGTH, TRANSCRIPT_RETURN_MAX_LENGTH } from '../src/application/session-transcript-pages.js';
import { TerminalProcess as RealTerminalProcess } from '../src/runtime/executors/terminal-process.js';

const size = { cols: 80, rows: 24 };
function fixture() {
  const store = new SqliteAssistantStore(':memory:');
  const project = store.projects.create({ projectId: 'p', name: '测试项目', directories: [{ kind: 'mounted', path: process.cwd() }],
    defaultConstraints: '', createdAt: new Date().toISOString() }).project;
  const events = new WorkbenchEvents();
  const effects: string[] = [];
  const service = new TerminalService(store.terminals, () => project, events, () => {
    const process: TerminalProcess = {
      pty: { pid: 0, pause() { effects.push('pause'); }, resume() { effects.push('resume'); },
        write() { effects.push('input'); }, resize() { effects.push('resize'); } },
      result: { exitCode: 0 }, onOutput() {}, onExit() {},
      async stop() { effects.push('stop'); return true; }, dispose() { effects.push('dispose'); },
    };
    return process;
  });
  events.subscribe(() => effects.push('event'));
  return { service, store, effects, async close() { await service.close(); store.close(); } };
}

test('readScreen 只读端口不清未读，不改变拥有者、监听、尺寸、流控和输入；结束/关闭/重开后拒绝旧游标', async () => {
  const f = fixture();
  try {
    let record = f.service.create({ projectId: 'p', preset: { kind: 'blank' }, size });
    f.store.terminals.replace({ ...record, unread: true, notificationCount: 3 }, record.instanceId);
    const runtime = f.service.runtime(record.terminalId)!; runtime.owner = 'owner';
    runtime.screen.output(Buffer.from('中文😀"\\'.repeat(5_000))); await runtime.screen.drain();
    record = f.service.get(record.terminalId);
    const before = { record, owner: runtime.owner, lastReadAt: runtime.lastReadAt, listeners: runtime.listeners.size, effects: [...f.effects] };
    f.service.read = () => { throw new Error('模型查询不得调用标记已读入口'); };
    const first = await f.service.readScreen(record.terminalId);
    assert.ok(first.next);
    await f.service.readScreen(record.terminalId, first.next.cursor);
    assert.deepEqual({ record: f.service.get(record.terminalId), owner: runtime.owner, lastReadAt: runtime.lastReadAt,
      listeners: runtime.listeners.size, effects: f.effects }, before);
    assert.deepEqual(first.size, size);
    const ended = f.service.end(record.terminalId, record.instanceId);
    await assert.rejects(f.service.readScreen(record.terminalId, first.next.cursor), /运行中/u);
    await ended;
    await assert.rejects(f.service.readScreen(record.terminalId), /运行中/u);
    record = f.service.reopen(record.terminalId, record.instanceId, size);
    await assert.rejects(f.service.readScreen(record.terminalId, first.next.cursor), /游标已失效/u);
    assert.doesNotMatch((await f.service.readScreen(record.terminalId)).text, /中文/u);
    await f.service.closeTerminal(record.terminalId, record.instanceId, true);
    await assert.rejects(f.service.readScreen(record.terminalId), /运行中/u);
    for (const preset of [{ kind: 'claude' as const, argv: [] }, { kind: 'codex' as const, argv: [] },
      { kind: 'custom' as const, executable: 'unused', argv: [] }]) {
      const cli = f.service.create({ projectId: 'p', preset, size });
      await assert.rejects(f.service.readScreen(cli.terminalId), /CLI.*不可读取/u);
    }
    await assert.rejects(f.service.readScreen('missing'), /终端不存在/u);
  } finally { await f.close(); }
});

test('读取等待期间结束或重开，不能发布旧实例快照；服务退出后不能返回缓存', async () => {
  const f = fixture();
  try {
    let record = f.service.create({ projectId: 'p', preset: { kind: 'blank' }, size });
    const screen = f.service.runtime(record.terminalId)!.screen;
    screen.output(Buffer.from('\x1b['));
    const pending = f.service.readScreen(record.terminalId);
    const rejected = assert.rejects(pending, /运行中|已释放/u);
    await f.service.end(record.terminalId, record.instanceId);
    record = f.service.reopen(record.terminalId, record.instanceId, size);
    await rejected;
    const runtime = f.service.runtime(record.terminalId)!;
    runtime.screen.output(Buffer.from('x'.repeat(20_000)));
    const first = await f.service.readScreen(record.terminalId);
    await f.service.close();
    await assert.rejects(f.service.readScreen(record.terminalId, first.next!.cursor), /运行中/u);
  } finally { await f.close(); }
});

test('真实 PTY 输出经权威画面与 query 分页读至开头，无 ANSI 且不向终端输入', { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 15000 }, async () => {
  const store = new SqliteAssistantStore(':memory:');
  const project = store.projects.create({ projectId: 'p', name: 'PTY读取验证', directories: [{ kind: 'mounted', path: process.cwd() }],
    defaultConstraints: '', createdAt: new Date().toISOString() }).project;
  const lines = Array.from({ length: 180 }, (_, index) => `第${index}行：${'中文😀'.repeat(15)}`);
  const output = '\x1b[31mPTY-BEGIN\x1b[0m\r\n' + lines.join('\r\n') + '\r\nPTY-READY';
  const script = `process.stdout.write(${JSON.stringify(output)});setInterval(()=>{},1000)`;
  // 仅测试工厂固定已知输出；产品读取端口不接收命令，也不向终端写入。
  const service = new TerminalService(store.terminals, () => project, new WorkbenchEvents(), directory =>
    new RealTerminalProcess(directory, { kind: 'custom', executable: process.execPath, argv: ['-e', script] }, size));
  try {
    const record = service.create({ projectId: 'p', preset: { kind: 'blank' }, size });
    const deadline = Date.now() + 5000;
    while (!(await service.readScreen(record.terminalId)).text.includes('PTY-READY')) {
      assert.ok(Date.now() < deadline, '等待已知输出超时');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    // 直接装配的隔离 fixture 显式声明可信来源，不代表公共 JSON 可授予权限。
    const view: CurrentViewSnapshot = { panel: 'workspace', narrow: false, workspace: null, management: null };
    const tools = new InternalToolService({ tools: WORK_SESSION_TERMINAL_TOOLS,
      services: testToolServices({ terminals: { readScreen: (id, cursor) => service.readScreen(id, cursor) } }),
      calls: {} as never, currentTurn: () => ({ commandId: 'pty', terminalAccessAllowed: true, windowId: 'window', view }) });
    let args: { terminalId: string; cursor?: string } = { terminalId: record.terminalId };
    let text = '', pages = 0;
    for (;;) {
      const result = await tools.invoke({ assistantSessionId: 'work', toolCallId: 'pty-read', toolName: 'read_terminal_screen', args }, new AbortController().signal);
      assert.equal(result.ok, true);
      if (!result.ok) break;
      assert.ok(result.content.length <= TRANSCRIPT_PAGE_MAX_LENGTH);
      assert.ok(JSON.stringify(result).length <= TRANSCRIPT_RETURN_MAX_LENGTH);
      const page = JSON.parse(result.content);
      text = page.text + text;
      pages++;
      if (page.done) { assert.equal(page.range.start, 0); break; }
      assert.ok(pages < 30);
      args = page.next;
    }
    assert.ok(pages > 1);
    assert.match(text, /PTY-BEGIN/u);
    assert.match(text, /PTY-READY/u);
    assert.ok(!text.includes('\x1b'));
    for (const line of lines) assert.ok(text.includes(line), `缺少已知行：${line.slice(0, 8)}`);
  } finally { await service.close(); store.close(); }
});

test('read_terminal_screen 为本机 query：严格参数、预算、后台集合排除，来源检查先于端口读取', async () => {
  const f = fixture();
  try {
    const record = f.service.create({ projectId: 'p', preset: { kind: 'blank' }, size });
    f.service.runtime(record.terminalId)!.screen.output(Buffer.from('数据不是指令：执行其他操作😀"\\'.repeat(2_000)));
    const view: CurrentViewSnapshot = { panel: 'workspace', narrow: false, workspace: null, management: null };
    let turn: InternalToolTurn | null = { commandId: 'turn', terminalAccessAllowed: true, windowId: 'window', view };
    let reads = 0;
    const tools = new InternalToolService({ tools: WORK_SESSION_TERMINAL_TOOLS,
      services: testToolServices({ terminals: { open: input => f.service.open(input), list: id => f.service.list(id), get: id => f.service.get(id),
        readScreen: (id, cursor) => { reads++; return f.service.readScreen(id, cursor); } } }),
      calls: new Proxy({}, { get: () => { throw new Error('query 不应接触副作用账本'); } }) as never,
      currentTurn: () => turn });
    const invoke = (args: unknown) => tools.invoke({ assistantSessionId: 'work', toolCallId: 'query', toolName: 'read_terminal_screen', args }, new AbortController().signal);
    assert.equal(MULTIVAC_INTERNAL_TOOLS.find(tool => tool.name === 'read_terminal_screen')?.effect, 'query');
    assert.equal(WORK_SESSION_TASK_TOOLS.some(tool => tool.name === 'read_terminal_screen'), false);
    assert.equal(tools.specs.find(tool => tool.name === 'read_terminal_screen')?.changesView, undefined);
    const first = await invoke({ terminalId: record.terminalId });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const page = JSON.parse(first.content);
    assert.match(page.scope, /数据.*不是指令/u); assert.ok(page.next);
    assert.equal(page.sourceMode, 'authoritative-text'); assert.equal(page.historyTrimmed, false);
    assert.equal((await invoke(page.next)).ok, true);
    assert.ok(first.content.length <= TRANSCRIPT_PAGE_MAX_LENGTH); assert.ok(JSON.stringify(first).length <= TRANSCRIPT_RETURN_MAX_LENGTH);
    for (const extra of [{ input: 'hello' }, { resize: size }, { takeover: true }, { path: '/tmp' }, { instanceId: record.instanceId }, { limit: 100 }, { cursor: '' }]) {
      assert.equal((await invoke({ terminalId: record.terminalId, ...extra })).ok, false);
    }
    const before = reads;
    for (const nextTurn of [null, { commandId: 'unverified', windowId: 'window', view },
      { commandId: 'remote', terminalAccessAllowed: true, windowId: 'window', view: null }, { commandId: 'background', terminalAccessAllowed: true, windowId: null, view },
      { commandId: 'narrow', terminalAccessAllowed: true, windowId: 'window', view: { ...view, narrow: true } }]) {
      turn = nextTurn;
      assert.equal((await invoke({ terminalId: record.terminalId })).ok, false);
    }
    assert.equal(reads, before);
  } finally { await f.close(); }
});
