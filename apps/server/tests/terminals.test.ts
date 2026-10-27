import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, ProjectTerminal } from '@multivac/contracts';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { PreferencesService } from '../src/application/preferences-service.js';
import { assertTerminalConnection, assertTerminalOperation, assertTerminalOwner, selectTerminalDirectory } from '../src/modules/terminals/terminal-record.js';

const at = '2026-10-25T09:00:00.000Z';
const project: Project = { projectId: 'p', name: '项目', directories: [{ kind: 'mounted', path: '/project' }, { kind: 'mounted', path: '/other' }], defaultConstraints: '', createdAt: at, updatedAt: at };
const initial: ProjectTerminal = { terminalId: 't', projectId: 'p', instanceId: 'i1', title: '终端', directory: '/project', preset: { kind: 'custom', executable: 'printf', argv: ['%s', 'a b', "a'b"] }, status: 'starting', lastExit: null, createdAt: at, instanceStartedAt: at, lastActivityAt: at, closedAt: null, unread: false, notificationCount: 0 };
function createProject(store: SqliteAssistantStore): void { store.projects.create({ projectId: project.projectId, name: project.name, directories: project.directories, defaultConstraints: '', createdAt: at }); }

test('终端：只接受当前项目登记目录；关闭确认及重新打开状态有门禁', () => {
  assert.equal(selectTerminalDirectory(project), '/project');
  assert.equal(selectTerminalDirectory(project, '/other'), '/other');
  for (const path of ['/outside', '/project/child', '/project/../outside']) assert.throws(() => selectTerminalDirectory(project, path));
  assert.throws(() => selectTerminalDirectory(undefined));
  assert.throws(() => assertTerminalOperation(initial, 'old', 'end'));
  assert.throws(() => assertTerminalOperation(initial, 'i1', 'close'));
  assert.doesNotThrow(() => assertTerminalOperation(initial, 'i1', 'close', true));
  for (const status of ['starting', 'running', 'stopping', 'stop-unconfirmed'] as const) assert.throws(() => assertTerminalOperation({ ...initial, status }, 'i1', 'reopen'));
  assert.doesNotThrow(() => assertTerminalOperation({ ...initial, status: 'exited' }, 'i1', 'reopen'));
});

test('终端：SQLite持久化预设和元数据，重开后旧实例不能覆盖新实例', () => {
  const root = mkdtempSync(join(tmpdir(), 'multivac-terminal-storage-'));
  const path = join(root, 'metadata.sqlite');
  let store = new SqliteAssistantStore(path);
  try {
    createProject(store);
    store.terminals.insert(initial);
    const presets = [{ presetId: 'printf', title: '打印', command: initial.preset as { kind: 'custom'; executable: string; argv: string[] } }];
    new PreferencesService(store.preferences).update({ terminalCommandPresets: presets });
    assert.throws(() => store.terminals.insert({ ...initial, terminalId: 'bad', output: 'secret' } as ProjectTerminal));
    assert.throws(() => store.terminals.insert({ ...initial, terminalId: 'orphan', projectId: 'missing' }));
    store.close(); store = new SqliteAssistantStore(path);
    assert.deepEqual(store.terminals.get('t'), initial);
    assert.deepEqual(new PreferencesService(store.preferences).get().terminalCommandPresets, presets);
    const exited: ProjectTerminal = { ...initial, status: 'exited', lastExit: { instanceId: 'i1', code: 0, signal: 9, reason: 'process-exit', occurredAt: at } };
    assert.equal(store.terminals.replace(exited, 'i1'), true);
    const reopened: ProjectTerminal = { ...exited, instanceId: 'i2', status: 'starting', instanceStartedAt: 'later' };
    assert.equal(store.terminals.replace(reopened, 'i1'), true);
    assert.equal(store.terminals.replace(exited, 'i1'), false);
    assert.throws(() => store.terminals.replace({ ...reopened, directory: '/other' }, 'i2'));
    assert.throws(() => store.terminals.replace({ ...reopened, closedAt: at }, 'i2'));
    assert.equal(store.terminals.endInterrupted('restart'), 1);
    assert.equal(store.terminals.endInterrupted('again'), 0);
    const ended = store.terminals.get('t')!;
    assert.equal(ended.status, 'exited');
    assert.deepEqual(ended.lastExit, { instanceId: 'i2', code: null, signal: null, reason: 'multivac-restarted', occurredAt: 'restart' });
    const closed = { ...ended, closedAt: at };
    assert.equal(store.terminals.replace(closed, 'i2'), true);
    assert.equal(store.terminals.list('p').length, 0);
    assert.equal(store.terminals.list('p', true).length, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('终端：列表按最近活动排序，元数据更新不能改变身份或原命令', () => {
  const store = new SqliteAssistantStore(':memory:');
  try {
    createProject(store);
    store.terminals.insert(initial);
    store.terminals.insert({ ...initial, terminalId: 't2', instanceId: 'i2', lastActivityAt: '2026-10-25T10:00:00.000Z' });
    assert.deepEqual(store.terminals.list('p').map(item => item.terminalId), ['t2', 't']);
    assert.equal(store.terminals.replace({ ...initial, title: '新名字', unread: true, notificationCount: 1 }, 'i1'), true);
    assert.throws(() => store.terminals.replace({ ...initial, preset: { kind: 'blank' } }, 'i1'));
    assert.throws(() => store.terminals.replace({ ...initial, status: 'exited' }, 'i1'));
  } finally { store.close(); }
});

test('终端：自定义预设损坏回退为空，重复ID在其他偏好写入前拒绝', () => {
  const values = new Map<string, unknown>([['terminalCommandPresets', 'bad'], ['showDailyQuote', false]]);
  const service = new PreferencesService({ get: key => values.get(key), set: (key, value) => { values.set(key, value); }, clearForTest: () => values.clear() });
  assert.deepEqual(service.terminalCommandPresets(), []);
  const preset = { presetId: 'p', title: '自定义', command: { kind: 'custom' as const, executable: 'echo', argv: ['a b'] } };
  assert.throws(() => service.update({ showDailyQuote: true, terminalCommandPresets: [preset, preset] }));
  assert.equal(values.get('showDailyQuote'), false);
  service.update({ terminalCommandPresets: [preset] });
  assert.deepEqual(service.terminalCommandPresets(), [preset]);
});

test('终端：连接拒绝倒退/超前ACK、旧实例、失效连接和非拥有者控制', () => {
  const state = { instanceId: 'i1', connectionId: 'window1', acknowledged: 100, sent: 200, attached: true };
  for (const watermark of [100, 150, 200]) assert.doesNotThrow(() => assertTerminalConnection(state, { type: 'ack', instanceId: 'i1', connectionId: 'window1', watermark }));
  for (const watermark of [99, 201, Infinity, NaN]) assert.throws(() => assertTerminalConnection(state, { type: 'ack', instanceId: 'i1', connectionId: 'window1', watermark }));
  assert.throws(() => assertTerminalConnection(state, { type: 'ack', instanceId: 'old', connectionId: 'window1', watermark: 100 }));
  assert.throws(() => assertTerminalConnection({ ...state, attached: false }, { type: 'read', instanceId: 'i1', connectionId: 'window1' }));
  const input = { type: 'input' as const, instanceId: 'i1', connectionId: 'window1', data: 'x' };
  assert.throws(() => assertTerminalOwner(state, input, 'window2'));
  assert.doesNotThrow(() => assertTerminalOwner(state, input, 'window1'));
  assert.throws(() => assertTerminalOwner(state, { type: 'resize', instanceId: 'i1', connectionId: 'window1', size: { cols: 80, rows: 24 } }, 'window2'));
});
