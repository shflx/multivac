import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import {
  CreateTerminalSchema, TerminalClientMessageSchema, TerminalServerMessageSchema, TerminalSizeSchema,
  TerminalCommandPresetsSchema, ProjectTerminalSchema, terminalExitedSuccessfully, ListTerminalsSchema, GetTerminalSchema,
} from '../src/index.js';

test('终端：尺寸、预设及创建参数严格校验', () => {
  for (const size of [{ cols: 10, rows: 4 }, { cols: 240, rows: 100 }]) assert.ok(Check(TerminalSizeSchema, size));
  for (const size of [{ cols: 9, rows: 4 }, { cols: 241, rows: 4 }, { cols: 80, rows: 3 }, { cols: 80, rows: 101 }, { cols: 80.5, rows: 24 }]) assert.equal(Check(TerminalSizeSchema, size), false);
  const request = { projectId: 'project', preset: { kind: 'custom', executable: 'printf', argv: ['%s', 'a b', "a'b", ''] }, size: { cols: 80, rows: 24 } };
  assert.ok(Check(CreateTerminalSchema, request));
  for (const patch of [{ directory: '../outside' }, { preset: { kind: 'blank', argv: [] } }, { preset: { kind: 'custom', executable: ' ', argv: [] } }, { preset: { kind: 'codex', argv: ['\0'] } }, { title: ' ' }, { taskId: 'task' }]) assert.equal(Check(CreateTerminalSchema, { ...request, ...patch }), false);
  assert.equal(Check(TerminalCommandPresetsSchema, [{ presetId: 'p', title: '自定义', command: request.preset }]), true);
});

test('终端：列表与详情采用POST正文，拒绝未知筛选与实例正文', () => {
  assert.ok(Check(ListTerminalsSchema, { projectId: 'project', includeClosed: true }));
  assert.equal(Check(ListTerminalsSchema, { projectId: 'project', output: true }), false);
  assert.ok(Check(GetTerminalSchema, {}));
  assert.equal(Check(GetTerminalSchema, { pid: 123 }), false);
});

test('终端：连接消息与快照字段严格绑定实例，不允许未知参数', () => {
  const connection = { instanceId: 'instance', connectionId: 'window' };
  assert.ok(Check(TerminalClientMessageSchema, { type: 'takeover', ...connection, size: { cols: 100, rows: 30 } }));
  assert.ok(Check(TerminalClientMessageSchema, { type: 'ack', ...connection, watermark: 256 }));
  for (const message of [{ type: 'ack', ...connection, watermark: -1 }, { type: 'ack', ...connection, watermark: Number.MAX_SAFE_INTEGER + 1 }, { type: 'input', instanceId: 'instance', data: 'echo' }, { type: 'resize', ...connection, size: { cols: 1, rows: 24 } }, { type: 'read', ...connection, taskId: 't' }]) assert.equal(Check(TerminalClientMessageSchema, message), false);
  const snapshot = { type: 'snapshot-begin', ...connection, snapshotId: 'snapshot', size: { cols: 80, rows: 24 }, watermark: 12345, historyTrimmed: true };
  assert.ok(Check(TerminalServerMessageSchema, snapshot));
  assert.equal(Check(TerminalServerMessageSchema, { ...snapshot, watermark: undefined }), false);
  assert.ok(Check(TerminalServerMessageSchema, { type: 'snapshot-data', ...connection, snapshotId: 'snapshot', offset: 0, data: 'YWJj' }));
  assert.equal(Check(TerminalServerMessageSchema, { type: 'snapshot-data', ...connection, snapshotId: 'snapshot', offset: 0, data: '!' }), false);
});

test('终端：退出码 0 且存在信号不表示成功；持久化元数据拒绝正文', () => {
  const exit = { instanceId: 'instance', code: 0, signal: null, occurredAt: 'now', reason: 'process-exit' as const };
  assert.equal(terminalExitedSuccessfully(exit), true);
  assert.equal(terminalExitedSuccessfully({ ...exit, signal: 9 }), false);
  assert.equal(terminalExitedSuccessfully({ ...exit, code: 1 }), false);
  assert.equal(terminalExitedSuccessfully({ ...exit, reason: 'user-ended' }), false);
  const record = { terminalId: 't', projectId: 'p', instanceId: 'i', title: '终端', directory: '/project', preset: { kind: 'blank' }, status: 'starting', lastExit: null, createdAt: 'now', instanceStartedAt: 'now', lastActivityAt: 'now', closedAt: null, unread: false, notificationCount: 0 };
  assert.ok(Check(ProjectTerminalSchema, record));
  for (const field of ['output', 'pid', 'snapshot', 'watermark', 'connectionId', 'taskId']) assert.equal(Check(ProjectTerminalSchema, { ...record, [field]: 'forbidden' }), false);
});
