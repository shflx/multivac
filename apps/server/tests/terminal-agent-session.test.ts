import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TerminalPreset } from '@multivac/contracts';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { TerminalService } from '../src/application/terminal-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import type { TerminalProcess, TerminalProcessFactory } from '../src/modules/terminals/terminal-process.js';
import type { CodexThreads } from '../src/modules/terminals/codex-threads.js';

const size = { cols: 80, rows: 24 };

/** 记录每次启动收到的命令；结束时立即报告退出，不启动真实进程。 */
function fakeProcesses() {
  const launched: TerminalPreset[] = [];
  const factory: TerminalProcessFactory = (_directory, preset) => {
    launched.push(preset);
    let result: TerminalProcess['result'];
    return {
      pty: { pid: 1, pause() {}, resume() {}, write() {}, resize() {} },
      get result() { return result; },
      onOutput: () => {}, onExit: () => {},
      async stop() { result = { exitCode: 0 }; return true; },
      dispose() {},
    };
  };
  return { launched, factory };
}

/** 假的 Codex app-server：按顺序发放会话 ID，可切换为不可用。 */
function fakeCodexThreads() {
  const created: Array<{ cwd: string; name: string; id: string }> = [];
  let available = true; let sequence = 0;
  const threads: CodexThreads = {
    async endpoint() { if (!available) throw new Error('不可用'); return 'ws://127.0.0.1:4555'; },
    async createThread(cwd, name) { const id = `01a17c00-0000-7000-8000-${String(++sequence).padStart(12, '0')}`; created.push({ cwd, name, id }); return id; },
    async close() {},
  };
  return { threads, created, setAvailable(value: boolean) { available = value; } };
}

function fixture(options: { codex?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'multivac-terminal-agent-'));
  const directory = join(root, 'project'); mkdirSync(directory);
  const store = new SqliteAssistantStore(join(root, 'metadata.sqlite'));
  const project = store.projects.create({ projectId: 'agent', name: '会话跟踪', directories: [{ kind: 'mounted', path: directory }], defaultConstraints: '', createdAt: new Date().toISOString() }).project;
  const processes = fakeProcesses();
  const codex = options.codex ? fakeCodexThreads() : undefined;
  const service = new TerminalService(store.terminals, id => store.projects.get(id)!, new WorkbenchEvents(), processes.factory, codex?.threads);
  return { project, store, service, codex, directory, launched: processes.launched, async close() { await service.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('Claude Code：启动时指定会话 ID，重开默认接回同一会话，new 时换新会话', async () => {
  const f = fixture();
  try {
    const created = f.service.create({ projectId: f.project.projectId, preset: { kind: 'claude', argv: ['--model', 'sonnet'] }, size });
    const sessionId = created.agentSessionId!;
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(f.launched.at(-1), { kind: 'claude', argv: ['--session-id', sessionId, '--model', 'sonnet'] });
    // 保存的预设不含注入的会话参数。
    assert.deepEqual(f.service.get(created.terminalId).preset, { kind: 'claude', argv: ['--model', 'sonnet'] });

    const ended = await f.service.end(created.terminalId, created.instanceId);
    const resumed = f.service.reopen(created.terminalId, ended.instanceId, size);
    assert.equal(resumed.agentSessionId, sessionId);
    assert.deepEqual(f.launched.at(-1), { kind: 'claude', argv: ['--resume', sessionId, '--model', 'sonnet'] });

    const again = await f.service.end(created.terminalId, resumed.instanceId);
    const fresh = f.service.reopen(created.terminalId, again.instanceId, size, 'new');
    assert.notEqual(fresh.agentSessionId, sessionId);
    assert.deepEqual(f.launched.at(-1), { kind: 'claude', argv: ['--session-id', fresh.agentSessionId!, '--model', 'sonnet'] });
  } finally { await f.close(); }
});

test('会话跟踪只用于 Claude Code，用户参数自带会话时不注入', async () => {
  const f = fixture();
  try {
    for (const preset of [{ kind: 'blank' }, { kind: 'codex', argv: [] }, { kind: 'claude', argv: ['--resume', 'abc'] }, { kind: 'claude', argv: ['--continue'] }] as TerminalPreset[]) {
      const created = f.service.create({ projectId: f.project.projectId, preset, size });
      assert.equal(created.agentSessionId, null);
      assert.deepEqual(f.launched.at(-1), preset);
      const ended = await f.service.end(created.terminalId, created.instanceId);
      assert.equal(f.service.reopen(created.terminalId, ended.instanceId, size).agentSessionId, null);
      assert.deepEqual(f.launched.at(-1), preset);
    }
  } finally { await f.close(); }
});

test('跟踪会话之前创建的 Claude Code 终端：接回时继续该目录最近的会话', async () => {
  const f = fixture();
  try {
    const created = f.service.create({ projectId: f.project.projectId, preset: { kind: 'claude', argv: [] }, size });
    // 模拟旧记录：没有会话 ID。
    assert.ok(f.store.terminals.replace({ ...f.service.get(created.terminalId), agentSessionId: null }, created.instanceId));
    const ended = await f.service.end(created.terminalId, created.instanceId);
    const resumed = f.service.reopen(created.terminalId, ended.instanceId, size);
    assert.equal(resumed.agentSessionId, null);
    assert.deepEqual(f.launched.at(-1), { kind: 'claude', argv: ['--continue'] });
  } finally { await f.close(); }
});

test('Codex：在 app-server 中创建并命名会话，按 ID 以 --remote 接入，new 时创建新会话', async () => {
  const f = fixture({ codex: true });
  try {
    const created = await f.service.open({ projectId: f.project.projectId, preset: { kind: 'codex', argv: ['--model', 'gpt-5'] }, title: '修复导航', size });
    const sessionId = created.agentSessionId!;
    assert.deepEqual(f.codex!.created, [{ cwd: f.directory, name: '修复导航', id: sessionId }]);
    // 不加 -c、--profile 等参数，保持 Codex 不在终端进程内运行服务。
    assert.deepEqual(f.launched.at(-1), { kind: 'codex', argv: ['resume', sessionId, '--remote', 'ws://127.0.0.1:4555', '--model', 'gpt-5'] });
    assert.deepEqual(f.service.get(created.terminalId).preset, { kind: 'codex', argv: ['--model', 'gpt-5'] });

    const ended = await f.service.end(created.terminalId, created.instanceId);
    const resumed = await f.service.reopenTerminal(created.terminalId, ended.instanceId, size);
    assert.equal(resumed.agentSessionId, sessionId);
    assert.equal(f.codex!.created.length, 1);
    assert.deepEqual(f.launched.at(-1), { kind: 'codex', argv: ['resume', sessionId, '--remote', 'ws://127.0.0.1:4555', '--model', 'gpt-5'] });

    const again = await f.service.end(created.terminalId, resumed.instanceId);
    const fresh = await f.service.reopenTerminal(created.terminalId, again.instanceId, size, 'new');
    assert.equal(f.codex!.created.length, 2);
    assert.equal(fresh.agentSessionId, f.codex!.created[1]!.id);
  } finally { await f.close(); }
});

test('Codex：app-server 不可用时以普通方式启动；已有会话 ID 时仍由 Codex 自行接回', async () => {
  const f = fixture({ codex: true });
  try {
    const created = await f.service.open({ projectId: f.project.projectId, preset: { kind: 'codex', argv: [] }, size });
    const sessionId = created.agentSessionId!;
    f.codex!.setAvailable(false);
    const ended = await f.service.end(created.terminalId, created.instanceId);
    const resumed = await f.service.reopenTerminal(created.terminalId, ended.instanceId, size);
    assert.equal(resumed.agentSessionId, sessionId);
    assert.deepEqual(f.launched.at(-1), { kind: 'codex', argv: ['resume', sessionId] });

    const plain = await f.service.open({ projectId: f.project.projectId, preset: { kind: 'codex', argv: [] }, size });
    assert.equal(plain.agentSessionId, null);
    assert.deepEqual(f.launched.at(-1), { kind: 'codex', argv: [] });
  } finally { await f.close(); }
});

test('Codex：参数带子命令时不创建会话也不改写命令', async () => {
  const f = fixture({ codex: true });
  try {
    const created = await f.service.open({ projectId: f.project.projectId, preset: { kind: 'codex', argv: ['resume', '--last'] }, size });
    assert.equal(created.agentSessionId, null);
    assert.equal(f.codex!.created.length, 0);
    assert.deepEqual(f.launched.at(-1), { kind: 'codex', argv: ['resume', '--last'] });
  } finally { await f.close(); }
});
