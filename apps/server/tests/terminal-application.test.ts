import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
