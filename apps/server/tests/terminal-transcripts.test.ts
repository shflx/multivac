import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { GLOBAL_ASSISTANT_SESSION_ID, type CoordinatorRuntimeConfig, type CurrentViewSnapshot, type ProjectTerminal } from '@multivac/contracts';
import { TerminalTranscriptReader } from '../src/application/terminal-transcripts.js';
import { transcriptMessage, transcriptPreview, TRANSCRIPT_PAGE_MAX_LENGTH, TRANSCRIPT_RETURN_MAX_LENGTH } from '../src/application/session-transcript-pages.js';
import { InternalToolService, MULTIVAC_INTERNAL_TOOLS, WORK_SESSION_TASK_TOOLS, WORK_SESSION_TERMINAL_TOOLS, type InternalToolServices, type InternalToolTurn } from '../src/application/internal-tools/index.js';
import { TaskService } from '../src/application/task-service.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { createTaskTool } from '../src/application/internal-tools/task-management-tools.js';
import { testToolServices } from './fixtures/tool-services.js';

const id = 'tracked-id';
const codexMeta = { type: 'session_meta', payload: { id } };
const codex = (text: string, role = 'assistant') => ({ type: 'response_item', timestamp: '2026-10-30', payload: { type: 'message', role,
  content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
const claude = (text: string, role = 'assistant') => ({ type: role, sessionId: id, message: { role, content: [{ type: 'text', text }] } });
const agentsBootstrap = '# AGENTS.md instructions for /fixture\n\n<INSTRUCTIONS>\n隐藏约束\n</INSTRUCTIONS>';
const environmentBootstrap = '<environment_context>\n  <cwd>/fixture</cwd>\n  <shell>zsh</shell>\n</environment_context>';
const permissionsBootstrap = '<permissions instructions>\n隐藏权限\n</permissions instructions>';
const userBootstrap = '<user_instructions>\n隐藏启动用户约束\n</user_instructions>';
const jsonl = (entries: unknown[]) => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';

function fixture(t: TestContext, kind: 'codex' | 'claude' = 'codex') {
  // 所有资料均在当前工作树中构造；测试不触碰真实用户的 CLI 目录。
  const home = mkdtempSync(join(process.cwd(), '.terminal-transcripts-fixture-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = kind === 'codex' ? join(home, '.codex/sessions/2026/10/30', `rollout-date-${id}.jsonl`) : join(home, '.claude/projects/project', `${id}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  const record: ProjectTerminal = { terminalId: 'terminal', projectId: 'project', instanceId: 'instance', title: '终端', directory: '/unused',
    preset: { kind, argv: [] }, status: 'exited', lastExit: null, createdAt: 'now', instanceStartedAt: 'now', lastActivityAt: 'now',
    closedAt: 'now', unread: false, notificationCount: 0, agentSessionId: id };
  const reader = new TerminalTranscriptReader({ home, getTerminal: key => key === record.terminalId ? record : undefined });
  return { home, file, record, reader, write: (entries: unknown[]) => writeFileSync(file, jsonl(entries)) };
}

test('Codex 仅从 response_item 的可见正文读取，忽略镜像、系统、思考、工具、文件及未知块', t => {
  const f = fixture(t);
  f.write([codexMeta, ...[agentsBootstrap, environmentBootstrap, permissionsBootstrap, userBootstrap].map(text => codex(text, 'user')), codex('用户正文', 'user'),
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '隐藏系统' }] } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ text: '隐藏思考' }] } },
    { type: 'response_item', payload: { type: 'function_call_output', output: '隐藏工具结果和文件内容' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: '重复镜像' } },
    { type: 'future', payload: { text: '隐藏未知事件' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '助手正文' },
      { type: 'file', text: '隐藏文件' }, { type: 'future', text: '隐藏未知块' }, { type: 'tool_use', text: '隐藏工具' }] } }]);
  assert.deepEqual(f.reader.readMessages('terminal').map(m => [m.role, m.text]), [['user', '用户正文'], ['assistant', '助手正文']]);
  assert.doesNotMatch(JSON.stringify(transcriptPreview(f.reader, 'terminal', { limit: 20 })), /隐藏|重复镜像/u);
});

test('Codex 合法用户正文即使以启动标签或 AGENTS 标题开头也逐字保留，无需 event 镜像', t => {
  const f = fixture(t);
  const texts = ['# AGENTS.md instructions：请解释这个 Markdown 标题',
    '# AGENTS.md instructions for /fixture\n请解释标题', '<environment_context>请解释这个标签',
    '<permissions instructions>请解释权限', '<user_instructions>请解释此标签',
    '<environment_context>合法单行示例</environment_context>',
    '# AGENTS.md instructions for /fixture\n\n<INSTRUCTIONS>\n不完整包装',
    agentsBootstrap + '\n请解释上述包装'];
  for (const text of texts) {
    f.write([codexMeta, codex(text, 'user')]);
    assert.deepEqual(f.reader.readMessages('terminal').map(m => m.text), [text], text);
  }
});

test('Codex 启动包装只在启动阶段排除；user_message 佐证真实用户输入且不重复镜像', t => {
  const f = fixture(t);
  f.write([codexMeta, codex(agentsBootstrap, 'user'), codex(environmentBootstrap, 'user'),
    codex(userBootstrap, 'user'), { type: 'event_msg', payload: { type: 'user_message', message: userBootstrap } },
    codex(permissionsBootstrap, 'user'), codex('助手正文')]);
  assert.deepEqual(f.reader.readMessages('terminal').map(m => m.text), [userBootstrap, permissionsBootstrap, '助手正文']);
  f.write([codexMeta, codex('普通用户输入', 'user'), codex(agentsBootstrap, 'user'),
    { type: 'event_msg', payload: { type: 'user_message', message: agentsBootstrap } }]);
  assert.deepEqual(f.reader.readMessages('terminal').map(m => m.text), ['普通用户输入', agentsBootstrap]);
});

test('Claude 核对 sessionId，只取正文和 text 块，关闭的终端也能读', t => {
  const f = fixture(t, 'claude');
  f.write([{ type: 'system', sessionId: id, content: '隐藏系统' }, claude('用户正文', 'user'),
    { ...claude('隐藏约束', 'user'), isMeta: true }, { ...claude('隐藏分支'), isSidechain: true },
    { type: 'progress', sessionId: id, text: '隐藏进度' },
    { type: 'user', sessionId: id, message: { role: 'user', content: [{ type: 'tool_result', content: '隐藏文件内容' }] } },
    { type: 'assistant', sessionId: id, message: { role: 'assistant', content: [{ type: 'thinking', thinking: '隐藏思考' },
      { type: 'tool_use', input: '隐藏输入' }, { type: 'text', text: '助手正文' }, { type: 'future', text: '隐藏未知' }] } },
    { type: 'user', sessionId: id, message: { role: 'user', content: '字符串正文' } }]);
  assert.deepEqual(f.reader.readMessages('terminal').map(m => [m.role, m.text]), [['user', '用户正文'], ['assistant', '助手正文'], ['user', '字符串正文']]);
  assert.doesNotMatch(JSON.stringify(transcriptPreview(f.reader, 'terminal', { limit: 20 })), /隐藏/u);
  appendFileSync(f.file, jsonl([{ ...claude('其他会话'), sessionId: 'other' }]));
  assert.throws(() => f.reader.readMessages('terminal'), /sessionId.*不匹配/u);
});

test('缺少 ID、文件、错误身份、空文件、损坏完整行均明确失败，未知类型不泄露', t => {
  const f = fixture(t);
  assert.throws(() => f.reader.readMessages('missing'), /受管理终端/u);
  f.record.agentSessionId = null;
  assert.throws(() => f.reader.readMessages('terminal'), /没有已跟踪.*ID/u);
  f.record.agentSessionId = '../escape';
  assert.throws(() => f.reader.readMessages('terminal'), /ID 无效/u);
  f.record.agentSessionId = id;
  assert.throws(() => f.reader.readMessages('terminal'), /没有找到/u);
  writeFileSync(f.file, '');
  assert.throws(() => f.reader.readMessages('terminal'), /文件为空/u);
  f.write([{ type: 'session_meta', payload: { id: 'other' } }]);
  assert.throws(() => f.reader.readMessages('terminal'), /session_meta.id/u);
  writeFileSync(f.file, jsonl([codexMeta]) + '{broken}\n');
  assert.throws(() => f.reader.readMessages('terminal'), /不可解析的完整记录/u);
  f.write([codexMeta, { type: 'future', text: 'private' }]);
  assert.deepEqual(f.reader.readMessages('terminal'), []);
  f.record.preset = { kind: 'blank' };
  assert.throws(() => f.reader.readMessages('terminal'), /只支持/u);
  const c = fixture(t, 'claude');
  c.write([{ type: 'future', sessionId: id, text: 'private' }]);
  assert.throws(() => c.reader.readMessages('terminal'), /受支持记录/u);
});

test('Codex 可定位归档，拒绝重复来源、文件链接和目录链接', t => {
  const f = fixture(t);
  f.write([codexMeta, codex('正文')]);
  const archive = join(f.home, '.codex/archived_sessions', `rollout-date-${id}.jsonl`);
  mkdirSync(dirname(archive), { recursive: true });
  renameSync(f.file, archive);
  assert.equal(f.reader.readMessages('terminal')[0]?.text, '正文');
  f.write([codexMeta, codex('第二来源')]);
  assert.throws(() => f.reader.readMessages('terminal'), /多个文件来源/u);
  rmSync(f.file);
  symlinkSync(archive, f.file);
  assert.throws(() => f.reader.readMessages('terminal'), /不是普通文件/u);
  rmSync(f.file);
  rmSync(join(f.home, '.codex/sessions'), { recursive: true });
  symlinkSync(dirname(archive), join(f.home, '.codex/sessions'));
  assert.throws(() => f.reader.readMessages('terminal'), /路径包含链接/u);
});

test('来源移动、记录身份变化和不可见记录改写也拒绝旧游标', t => {
  const f = fixture(t);
  const initial = [codexMeta, { type: 'future', value: 'original' }, codex('正文')];
  f.write(initial);
  const ref = transcriptPreview(f.reader, 'terminal', { limit: 1 }).messages[0]!.messageRef;
  f.write([codexMeta, { type: 'future', value: 'changed' }, codex('正文')]);
  assert.throws(() => transcriptMessage(f.reader, 'terminal', ref, 'body'), /重新.*定位/u);
  f.write(initial);
  const fresh = transcriptPreview(f.reader, 'terminal', { limit: 1 }).messages[0]!.messageRef;
  const archive = join(f.home, '.codex/archived_sessions', `rollout-date-${id}.jsonl`);
  mkdirSync(dirname(archive), { recursive: true });
  renameSync(f.file, archive);
  assert.throws(() => transcriptMessage(f.reader, 'terminal', fresh, 'body'), /重新.*定位/u);
  assert.equal(f.reader.readMessages('terminal')[0]!.text, '正文');
  const relocated = transcriptPreview(f.reader, 'terminal', { limit: 1 }).messages[0]!.messageRef;
  f.record.preset = { kind: 'claude', argv: [] };
  const claudeFile = join(f.home, '.claude/projects/project', `${id}.jsonl`);
  mkdirSync(dirname(claudeFile), { recursive: true });
  writeFileSync(claudeFile, jsonl([claude('正文')]));
  assert.throws(() => transcriptMessage(f.reader, 'terminal', relocated, 'body'), /重新.*定位/u);
});

test('文件大小、行长度和目录深度有界，不静默截断', t => {
  const f = fixture(t);
  f.write([codexMeta]);
  truncateSync(f.file, 32 * 1024 * 1024 + 1);
  assert.throws(() => f.reader.readMessages('terminal'), /文件超过读取预算/u);
  f.write([codexMeta, codex('x'.repeat(2 * 1024 * 1024))]);
  assert.throws(() => f.reader.readMessages('terminal'), /单条记录超过读取预算/u);
  rmSync(f.file);
  mkdirSync(join(f.home, '.codex/sessions/1/2/3/4/5/6/7/8/9'), { recursive: true });
  assert.throws(() => f.reader.readMessages('terminal'), /层级超过扫描预算/u);
});

for (const kind of ['codex', 'claude'] as const) test(`${kind} 长消息续读、追加与半截尾行、替换和篡改游标`, t => {
  const f = fixture(t, kind);
  const text = ' 原样\n😀\u0000\\\"'.repeat(5_000);
  const entries = [kind === 'codex' ? codexMeta : null, ...Array.from({ length: 8 }, (_, i) => kind === 'codex' ? codex(i === 7 ? text : `消息${i}`) : claude(i === 7 ? text : `消息${i}`))].filter(Boolean);
  f.write(entries);
  const page = transcriptPreview(f.reader, 'terminal', { limit: 2 });
  const ref = page.messages.at(-1)!.messageRef;
  let result = transcriptMessage(f.reader, 'terminal', ref, 'body');
  let restored = result.text;
  while (result.next) {
    const previousEnd = result.range.end;
    result = transcriptMessage(f.reader, 'terminal', result.next.messageRef, 'body', result.next.cursor);
    assert.equal(result.range.start, previousEnd);
    assert.ok(JSON.stringify(result).length <= TRANSCRIPT_PAGE_MAX_LENGTH);
    restored += result.text;
  }
  assert.equal(restored, text);
  const appended = kind === 'codex' ? codex('新增') : claude('新增');
  const tail = JSON.stringify(appended);
  appendFileSync(f.file, tail.slice(0, 20));
  assert.equal(f.reader.readMessages('terminal').length, 8);
  appendFileSync(f.file, tail.slice(20) + '\n');
  const history = transcriptPreview(f.reader, 'terminal', { limit: 2, cursor: page.next!.cursor });
  assert.deepEqual(history.range, { start: 4, end: 6, total: 8, currentTotal: 9 });
  assert.equal(transcriptMessage(f.reader, 'terminal', ref, 'body').text, restored.slice(0, transcriptMessage(f.reader, 'terminal', ref, 'body').range.end));
  assert.throws(() => transcriptMessage(f.reader, 'terminal', ref + 'tampered', 'body'), /重新.*定位/u);
  // Node 的宽松 base64 解码会忽略此字符，签名本身仍须使用规范编码。
  assert.throws(() => transcriptMessage(f.reader, 'terminal', ref + '!', 'body'), /重新.*定位/u);
  assert.throws(() => transcriptMessage(f.reader, 'other-terminal', ref, 'body'), /重新.*定位/u);
  const next = transcriptMessage(f.reader, 'terminal', ref, 'body').next!;
  assert.throws(() => transcriptMessage(f.reader, 'terminal', ref, 'body', next.cursor + 'x'), /重新.*定位/u);
  // 同一路径用另一 inode 替换，正文完全相同也必须拒绝旧游标。
  renameSync(f.file, f.file + '.old');
  f.write(entries);
  assert.throws(() => transcriptMessage(f.reader, 'terminal', ref, 'body'), /重新.*定位/u);
  const fresh = transcriptPreview(f.reader, 'terminal', { limit: 2 });
  const changed = [...entries];
  changed[changed.length - 1] = kind === 'codex' ? codex('修改已有消息') : claude('修改已有消息');
  f.write(changed);
  assert.throws(() => transcriptMessage(f.reader, 'terminal', fresh.messages[0]!.messageRef, 'body'), /重新.*定位/u);
});

test('终端工具只接受 terminalId，续读元数据正确，本机 query 可用且远程后台在碰磁盘前拒绝', async t => {
  const f = fixture(t);
  f.write([codexMeta, ...Array.from({ length: 9 }, (_, i) => codex(i === 8 ? 'read_session_history 正文😀'.repeat(3_000) : `消息${i}`))]);
  // 直接装配的隔离 fixture 显式声明可信来源，不代表公共 JSON 可授予权限。
  const view: CurrentViewSnapshot = { panel: 'workspace', narrow: false, workspace: null, management: null };
  let turn: InternalToolTurn | null = { commandId: 'turn', terminalAccessAllowed: true, windowId: 'window', view };
  let reads = 0;
  const services = testToolServices({ terminals: { get: () => f.record },
    terminalTranscripts: { readMessages: () => { throw new Error('应读快照'); }, readSnapshot: terminalId => { reads++; return f.reader.readSnapshot(terminalId); } },
  } as unknown as InternalToolServices);
  const service = new InternalToolService({ tools: WORK_SESSION_TERMINAL_TOOLS, services,
    calls: new Proxy({}, { get: () => { throw new Error('query 不得操作账本'); } }) as never, currentTurn: () => turn });
  const invoke = (toolName: string, args: unknown) => service.invoke({ assistantSessionId: 'work', toolCallId: 'query', toolName, args }, new AbortController().signal);
  const names = ['read_terminal_recent', 'read_terminal_history', 'read_terminal_message'];
  assert.deepEqual(WORK_SESSION_TERMINAL_TOOLS.map(tool => tool.name), ['get_current_view', 'list_project_terminals', ...names, 'read_terminal_screen']);
  for (const name of names) {
    assert.equal(MULTIVAC_INTERNAL_TOOLS.find(tool => tool.name === name)?.effect, 'query');
    assert.ok(WORK_SESSION_TERMINAL_TOOLS.some(tool => tool.name === name));
    assert.equal(WORK_SESSION_TASK_TOOLS.some(tool => tool.name === name), false);
    assert.equal((await invoke(name, { terminalId: 'terminal', sessionId: id, path: f.file })).ok, false);
  }
  const recent = await invoke(names[0]!, { terminalId: 'terminal', limit: 2 });
  assert.equal(recent.ok, true);
  if (!recent.ok) return;
  const page = JSON.parse(recent.content);
  assert.equal(page.terminalState.closed, true);
  assert.equal(page.mode, 'recent-preview');
  assert.equal(page.terminalId, 'terminal');
  assert.equal(page.sessionId, undefined);
  assert.equal(page.next.terminalId, 'terminal');
  assert.equal(page.next.sessionId, undefined);
  assert.match(page.historyStatus, /read_terminal_history/u);
  const bodyNext = page.messages.at(-1).body.next;
  assert.equal(bodyNext.terminalId, 'terminal');
  assert.equal(bodyNext.sessionId, undefined);
  let body = await invoke(names[2]!, { terminalId: 'terminal', messageRef: page.messages.at(-1).messageRef });
  assert.equal(body.ok, true);
  if (!body.ok) return;
  assert.match(JSON.parse(body.content).text, /read_session_history 正文/u);
  for (let n = 0; JSON.parse(body.content).next; n++) {
    assert.ok(n < 100);
    body = await invoke(names[2]!, JSON.parse(body.content).next);
    assert.equal(body.ok, true);
    if (!body.ok) return;
    assert.ok(body.content.length <= TRANSCRIPT_PAGE_MAX_LENGTH);
    assert.ok(JSON.stringify(body).length <= TRANSCRIPT_RETURN_MAX_LENGTH);
  }
  assert.equal((await invoke(names[2]!, bodyNext)).ok, true);
  assert.equal((await invoke(names[1]!, page.next)).ok, true);
  assert.equal((await invoke(names[2]!, { terminalId: 'terminal', messageRef: 'forged' })).ok, false);
  assert.equal((await invoke(names[2]!, { terminalId: 'terminal', messageRef: 'forged', part: 'quote' })).ok, false);
  const previousReads = reads;
  for (const nextTurn of [null, { commandId: 'unverified', windowId: 'window', view },
    { commandId: 'remote', terminalAccessAllowed: true, windowId: 'window', view: null }, { commandId: 'background', terminalAccessAllowed: true, windowId: null, view },
    { commandId: 'narrow', terminalAccessAllowed: true, windowId: 'window', view: { ...view, narrow: true } }]) {
    turn = nextTurn;
    for (const name of names) {
      const outcome = await invoke(name, { terminalId: 'terminal', ...(name.endsWith('message') ? { messageRef: 'forged' } : {}) });
      assert.equal(outcome.ok, false);
    }
  }
  assert.equal(reads, previousReads);
});


test('Fake 工具链：先确认终端，完整分页读取 CLI 长草案，再按真实 ID 创建父子任务与依赖', async t => {
  const f = fixture(t);
  const plan = { parent: { title: '实现草案', goal: '完成草案约定' }, children: [
    { title: '准备契约', goal: '核对契约', dependsOn: [] },
    { title: '接入界面', goal: '使用已确认契约', dependsOn: [0] },
  ] };
  const draft = '草案说明😀'.repeat(4000) + '\n草案JSON：' + JSON.stringify(plan);
  f.write([codexMeta, codex(draft)]);
  const store = new SqliteAssistantStore(join(f.home, 'tasks.sqlite'));
  const tasks = new TaskService({ afterCommit: () => {}, facts: store.taskFacts, requireProject: () => { throw new Error('本用例不创建项目任务'); } });
  const view: CurrentViewSnapshot = { panel: 'workspace', narrow: false, management: null,
    workspace: { workspaceId: 'project', scene: null, terminalId: 'terminal' } };
  const service = new InternalToolService({ tools: [...WORK_SESSION_TERMINAL_TOOLS, createTaskTool],
    services: testToolServices({ terminals: { get: () => f.record }, terminalTranscripts: f.reader, tasks, taskManagement: tasks,
      projects: { listWorkspaces: () => ({ workspaces: [{ workspaceId: 'project', name: '夹具项目', project: { projectId: 'project', name: '夹具项目' } }] }) },
      sessions: { list: () => ({ sessions: [] }) },
    } as unknown as InternalToolServices), calls: store.internalToolCalls,
    currentTurn: () => ({ commandId: 'terminal-plan', terminalAccessAllowed: true, windowId: 'window', view }) });
  const outcomes: Awaited<ReturnType<InternalToolService['invoke']>>[] = [];
  const called: string[] = [];
  const adapter = new FakeCoordinatorAdapter({ promptScenario: 'internalTools', promptDelayMs: 0, seedsHistory: () => false, sessionPathRoot: join(f.home, 'fake-sessions') });
  const config: CoordinatorRuntimeConfig = { systemPrompt: '按用户要求读取完整草案并创建父子任务与依赖。', authorizedContext: [],
    model: { provider: 'fake', modelId: 'fake-model', thinkingLevel: 'off' },
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 } };
  const invoke = async (toolName: string, args: unknown = {}) => {
    const result = await adapter.prompt(GLOBAL_ASSISTANT_SESSION_ID, `内部工具：${toolName} ${JSON.stringify(args)}`);
    assert.equal(result.ok, true);
    const outcome = outcomes.at(-1)!;
    assert.equal(outcome.ok, true, outcome.ok ? undefined : outcome.reason);
    if (!outcome.ok) throw new Error(outcome.reason);
    return outcome;
  };
  try {
    const ready = await adapter.createSession({ assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, config,
      workingDirectory: { kind: 'session-temp', path: f.home }, internalTools: {
        specs: service.specs, validate: (name, args) => service.validate(name, args),
        invoke: async (input, signal) => { called.push(input.toolName); const outcome = await service.invoke(input, signal); outcomes.push(outcome); return outcome; },
      } });
    assert.equal(ready.ok, true);
    const current = await invoke('get_current_view');
    assert.match(current.content, /当前焦点终端.*terminal/u);
    const { terminalId } = JSON.parse(current.content.match(/当前焦点终端：(.*)/u)![1]!);
    const preview = JSON.parse((await invoke('read_terminal_recent', { terminalId, limit: 1 })).content);
    assert.equal(preview.messages[0].body.done, false);
    let next = { terminalId, messageRef: preview.messages[0].messageRef };
    let full = '';
    let pages = 0;
    for (;;) {
      const page = JSON.parse((await invoke('read_terminal_message', next)).content);
      full += page.text;
      pages++;
      if (page.done) break;
      next = page.next;
      assert.ok(pages < 20, '分页应有界完成');
    }
    assert.ok(pages > 1);
    assert.equal(full, draft);
    const parsed: typeof plan = JSON.parse(full.split('\n草案JSON：')[1]!);
    const parent = await invoke('create_task', parsed.parent);
    const parentId = parent.result.refs.find(ref => ref.kind === 'task')!.taskId;
    const childIds: string[] = [];
    for (const child of parsed.children) {
      const created = await invoke('create_task', { title: child.title, goal: child.goal, parentTaskId: parentId,
        dependencyIds: child.dependsOn.map(index => childIds[index]) });
      childIds.push(created.result.refs.find(ref => ref.kind === 'task')!.taskId);
    }
    assert.deepEqual(childIds.map(id => tasks.get(id).parentTaskId), [parentId, parentId]);
    assert.deepEqual(tasks.get(childIds[1]!).dependencyIds, [childIds[0]]);
    assert.equal(tasks.get(parentId).status, 'idle');
    assert.equal(store.taskRuns.active().length, 0);
    assert.deepEqual(called.slice(0, 2), ['get_current_view', 'read_terminal_recent']);
    assert.deepEqual(called.slice(-3), ['create_task', 'create_task', 'create_task']);
  } finally { adapter.dispose(); store.close(); }
});
