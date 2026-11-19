import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectTerminal } from '@multivac/contracts';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';
test('真实应用：正常退出先停止终端再关库，重新启动清空遗留运行状态且不恢复画面', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-terminal-app-'));
  const environment = testApplicationEnvironment(root);
  const app = createMultivacApplication(environment); let closed = false;
  try {
    await app.ready; await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const created = await fetch(`${origin}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ name: '关闭核对' }) });
    const { project } = await created.json() as { project: { projectId: string } };
    const record = app.terminals.create({ projectId: project.projectId, preset: { kind: 'blank' }, size: { cols: 80, rows: 24 } });
    const pid = app.terminals.runtime(record.terminalId)!.process.pty.pid;
    await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close(); closed = true;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    const store = new SqliteAssistantStore(app.paths.databasePath);
    try {
      const ended = store.terminals.get(record.terminalId)!; assert.equal(ended.status, 'exited'); assert.equal(ended.lastExit?.reason, 'service-shutdown');
      assert.equal(store.terminals.replace({ ...ended, instanceId: 'interrupted-application', status: 'starting', closedAt: null }, ended.instanceId), true);
    } finally { store.close(); }
    const restarted = createMultivacApplication(environment);
    try {
      await restarted.ready; const interrupted = restarted.terminals.get(record.terminalId);
      assert.equal(interrupted.status, 'exited'); assert.equal(interrupted.lastExit?.reason, 'multivac-restarted');
      assert.equal(restarted.terminals.runtime(record.terminalId), undefined); assert.equal(restarted.terminals.hasActivity, false);
    } finally { await restarted.close(); }
  } finally {
    if (!closed) { await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close(); }
    await rm(root, { recursive: true, force: true });
  }
});


test('真实应用：无项目时创建和列出日常终端，工作根变更后仍在原目录重开', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-daily-terminal-app-'));
  const environment = testApplicationEnvironment(root);
  const size = { cols: 80, rows: 24 };
  let app = createMultivacApplication(environment);
  try {
    await app.ready;
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const post = (path: string, body: unknown) => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
    const projectList = await fetch(origin + '/api/projects');
    assert.deepEqual((await projectList.json() as { projects: unknown[] }).projects, []);
    const input = { workspaceId: 'default', preset: { kind: 'blank' }, size };
    assert.equal((await post('/api/terminals', { ...input, directory: root })).status, 400);
    const response = await post('/api/terminals', input);
    assert.equal(response.status, 200);
    const { terminal } = await response.json() as { terminal: ProjectTerminal };
    assert.equal(terminal.projectId, null);
    assert.equal(terminal.directory, join(await realpath(environment.MULTIVAC_WORK_ROOT!), 'terminals'));
    const list = await post('/api/terminals/list', { workspaceId: 'default' });
    assert.deepEqual((await list.json() as { terminals: ProjectTerminal[] }).terminals.map(item => item.terminalId), [terminal.terminalId]);
    await new Promise<void>(resolve => app.server.close(() => resolve()));
    await app.close();

    app = createMultivacApplication({ ...environment, MULTIVAC_WORK_ROOT: join(root, 'new-work') });
    await app.ready;
    const reopened = await app.terminals.reopenTerminal(terminal.terminalId, terminal.instanceId, size);
    assert.equal(reopened.terminalId, terminal.terminalId);
    assert.notEqual(reopened.instanceId, terminal.instanceId);
    assert.equal(reopened.directory, terminal.directory);
  } finally {
    if (app.server.listening) await new Promise<void>(resolve => app.server.close(() => resolve()));
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
