import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { CurrentViewSnapshot, ProjectTerminal } from '@multivac/contracts';
import { TerminalTranscriptReader } from '../src/application/terminal-transcripts.js';
import { transcriptMessage, transcriptPreview, TRANSCRIPT_PAGE_MAX_LENGTH, TRANSCRIPT_RETURN_MAX_LENGTH } from '../src/application/session-transcript-pages.js';
import { InternalToolService, MULTIVAC_INTERNAL_TOOLS, WORK_SESSION_TASK_TOOLS, WORK_SESSION_TERMINAL_TOOLS, type InternalToolServices, type InternalToolTurn } from '../src/application/internal-tools/index.js';
import { testToolServices } from './fixtures/tool-services.js';

const id = 'tracked-id';
const codexMeta = { type: 'session_meta', payload: { id } };
const codex = (text: string, role = 'assistant') => ({ type: 'response_item', timestamp: '2026-10-30', payload: { type: 'message', role,
  content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
const claude = (text: string, role = 'assistant') => ({ type: role, sessionId: id, message: { role, content: [{ type: 'text', text }] } });
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
  f.write([codexMeta, codex('用户正文', 'user'), codex('# AGENTS.md instructions for /private\n隐藏约束', 'user'),
    codex('<environment_context>隐藏环境</environment_context>', 'user'),
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
  const view: CurrentViewSnapshot = { panel: 'workspace', narrow: false, workspace: null, management: null };
  let turn: InternalToolTurn | null = { commandId: 'turn', windowId: 'window', view };
  let reads = 0;
  const services = testToolServices({ terminals: { get: () => f.record },
    terminalTranscripts: { readMessages: () => { throw new Error('应读快照'); }, readSnapshot: terminalId => { reads++; return f.reader.readSnapshot(terminalId); } },
  } as unknown as InternalToolServices);
  const service = new InternalToolService({ tools: WORK_SESSION_TERMINAL_TOOLS, services,
    calls: new Proxy({}, { get: () => { throw new Error('query 不得操作账本'); } }) as never, currentTurn: () => turn });
  const invoke = (toolName: string, args: unknown) => service.invoke({ assistantSessionId: 'work', toolCallId: 'query', toolName, args }, new AbortController().signal);
  const names = ['read_terminal_recent', 'read_terminal_history', 'read_terminal_message'];
  assert.deepEqual(WORK_SESSION_TERMINAL_TOOLS.map(tool => tool.name), ['list_project_terminals', ...names, 'read_terminal_screen']);
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
  for (const nextTurn of [null, { commandId: 'remote', windowId: 'window', view: null }, { commandId: 'background', windowId: null, view },
    { commandId: 'narrow', windowId: 'window', view: { ...view, narrow: true } }]) {
    turn = nextTurn;
    for (const name of names) {
      const outcome = await invoke(name, { terminalId: 'terminal', ...(name.endsWith('message') ? { messageRef: 'forged' } : {}) });
      assert.equal(outcome.ok, false);
    }
  }
  assert.equal(reads, previousReads);
});
