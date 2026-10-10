import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ExecutionDiagnostics } from '../src/application/execution-diagnostics.js';
import { observedModelRuntime } from '../src/runtime/executors/observed-model-runtime.js';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

const lines = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

test('默认关闭不创建日志与监视，关闭请求直接委托且不注入 SDK 钩子', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-diagnostics-off-'));
  const diagnostics = new ExecutionDiagnostics(root, () => { throw new Error('关闭时不应解析来源'); }, { enabled: false });
  const options = { signal: new AbortController().signal }, message = { stopReason: 'stop' }, result = Promise.resolve(message);
  const original = { completeSimple: (_model: unknown, _context: unknown, input: unknown) => { assert.equal(input, options); return result; } } as unknown as ModelRuntime;
  try {
    assert.equal(observedModelRuntime(() => original, 'session', diagnostics).completeSimple({ api: 'openai-responses' } as never, { messages: [] }, options), result);
    diagnostics.sample(); diagnostics.record('ignored'); diagnostics.agentEvent('session', { type: 'agent_start' });
    assert.equal(diagnostics.beginRequest('session', {}, true), undefined);
    assert.equal((diagnostics as any).timer, undefined); assert.equal((diagnostics as any).histogram, undefined); assert.equal((diagnostics as any).fd, undefined);
    await assert.rejects(readFile(diagnostics.path), { code: 'ENOENT' });
  } finally { diagnostics.close(); await rm(root, { recursive: true, force: true }); }
});

test('关闭清理资源与停止写入，重开不把关闭期间的时间和旧请求迟到事件当作新活动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-diagnostics-toggle-'));
  let wall = Date.now(), mono = 0;
  const diagnostics = new ExecutionDiagnostics(root, sessionId => ({ sessionId }), { clock: { wall: () => wall, monotonic: () => mono } });
  try {
    const request = diagnostics.beginRequest('session', {}, true)!;
    diagnostics.agentEvent('session', { type: 'agent_start' });
    diagnostics.setEnabled(false);
    const disabled = await readFile(diagnostics.path, 'utf8');
    assert.equal((diagnostics as any).timer, undefined); assert.equal((diagnostics as any).histogram, undefined); assert.equal((diagnostics as any).fd, undefined);
    request.body(20); request.event({ type: 'text_delta', delta: 'hidden' }); diagnostics.sample(); diagnostics.agentEvent('session', { type: 'agent_start' });
    assert.equal(await readFile(diagnostics.path, 'utf8'), disabled);
    wall += 3600000; mono += 3600000;
    diagnostics.setEnabled(true); diagnostics.sample();
    const enabled = await readFile(diagnostics.path, 'utf8');
    request.body(100); request.record('late'); request.finish({ stopReason: 'stop' });
    assert.equal(await readFile(diagnostics.path, 'utf8'), enabled);
    const entries = await lines(diagnostics.path);
    assert.equal(entries.filter(e => e.event === 'service.clock_gap').length, 0);
    assert.equal(entries.filter(e => e.event === 'service.heartbeat').at(-1).activeRequests, 0);
    diagnostics.agentEvent('session', { type: 'turn_start' }); diagnostics.sample();
    assert.equal((await lines(diagnostics.path)).filter(e => e.event === 'service.heartbeat').at(-1).activeExecutions, 1);
    assert.equal((await lines(diagnostics.path)).find(e => e.event === 'service.diagnostics.enabled').pid, process.pid);
    const next = diagnostics.beginRequest('session', {}, true)!; next.body(50); next.finish({ stopReason: 'stop' });
    assert.equal((await lines(diagnostics.path)).find(e => e.event === 'model.request.ended').bodyBytes, 50);
    diagnostics.setEnabled(true); assert.equal((await lines(diagnostics.path)).filter(e => e.event === 'service.diagnostics.enabled').length, 1);
    diagnostics.close(); diagnostics.setEnabled(true); assert.equal(diagnostics.enabled, false);
  } finally { diagnostics.close(); await rm(root, { recursive: true, force: true }); }
});

test('应用偏好关闭即时停止任务日志，保存后重启保持关闭，重开与重置都生效', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-diagnostics-preference-'));
  const environment = { ...testApplicationEnvironment(root), MULTIVAC_E2E_CONTROL: '1' };
  let app = createMultivacApplication(environment);
  const serve = async () => { await app.ready; await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(app.server.address() as import('node:net').AddressInfo).port}`; };
  const close = async () => { app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close(); };
  const path = join(app.paths.dataDir, 'diagnostics', 'execution.jsonl');
  const patch = async (endpoint: string, value: unknown) => {
    const response = await fetch(endpoint + '/api/preferences', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal(response.status, 200); return (await response.json()).preferences;
  };
  try {
    let endpoint = await serve();
    const initial = (await (await fetch(endpoint + '/api/preferences')).json()).preferences;
    assert.equal(initial.executionDiagnosticsEnabled, true);
    assert.equal((await patch(endpoint, { executionDiagnosticsEnabled: false })).executionDiagnosticsEnabled, false);
    const disabled = await readFile(path, 'utf8');
    const task = app.tasks.create({ commandId: 'off-task', title: '关闭诊断', goal: '仍可正常记录任务' }).task;
    assert.equal(task.status, 'idle'); assert.equal(await readFile(path, 'utf8'), disabled);
    await close();
    app = createMultivacApplication(environment); endpoint = await serve();
    assert.equal((await (await fetch(endpoint + '/api/preferences')).json()).preferences.executionDiagnosticsEnabled, false);
    assert.equal(await readFile(path, 'utf8'), disabled);
    assert.equal((await patch(endpoint, { recentDays: 1 })).executionDiagnosticsEnabled, false);
    await patch(endpoint, { executionDiagnosticsEnabled: true });
    app.tasks.create({ commandId: 'on-task', title: '开启诊断', goal: '记录新活动' });
    assert.equal((await lines(path)).filter(e => e.event === 'task.state').length, 1);
    const invalid = await fetch(endpoint + '/api/preferences', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"executionDiagnosticsEnabled":"false"}' });
    assert.equal(invalid.status, 400);
    await patch(endpoint, { executionDiagnosticsEnabled: false });
    assert.equal((await fetch(endpoint + '/api/__e2e/reset', { method: 'POST' })).status, 200);
    assert.equal((await (await fetch(endpoint + '/api/preferences')).json()).preferences.executionDiagnosticsEnabled, true);
    assert.equal((await lines(path)).filter(e => e.event === 'service.diagnostics.enabled').length, 2);
  } finally { await close(); await rm(root, { recursive: true, force: true }); }
});
