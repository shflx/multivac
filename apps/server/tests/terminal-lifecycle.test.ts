import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { TerminalService } from '../src/application/terminal-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
const size = { cols: 80, rows: 24 };
async function until(check: () => boolean) { const start = Date.now(); while (!check()) { if (Date.now() - start > 8000) throw new Error('终端状态未收敛'); await new Promise(resolve => setTimeout(resolve, 20)); } }
function fixture() {
  const root = mkdtempSync(join(process.cwd(), 'artifacts/terminal-lifecycle-'));
  const directories = ['a', 'b'].map(name => { const path = join(root, name); mkdirSync(path); return { kind: 'mounted' as const, path }; });
  const store = new SqliteAssistantStore(join(root, 'metadata.sqlite'));
  const project = store.projects.create({ projectId: 'lifecycle', name: '生命周期', directories, defaultConstraints: '', createdAt: new Date().toISOString() }).project;
  const events = new WorkbenchEvents(); const service = new TerminalService(store.terminals, id => store.projects.get(id)!, events);
  return { root, project, store, service, events, async close() { await service.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}
test('生命周期：目录卸载只停止受影响终端，原目录不可用时拒绝重开，正常服务退出先收尾', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const f = fixture();
  try {
    const first = f.service.create({ projectId: f.project.projectId, preset: { kind: 'blank' }, size });
    const second = f.service.create({ projectId: f.project.projectId, directory: f.project.directories[1]!.path, preset: { kind: 'blank' }, size });
    const updated = f.store.projects.update(f.project.projectId, { directories: [f.project.directories[1]!], updatedAt: new Date().toISOString() })!;
    f.events.publish({ type: 'workspace.changed', origin: { commandId: null, windowId: null }, change: 'updated', workspace: updated.workspace });
    await until(() => f.service.get(first.terminalId).status === 'exited');
    assert.equal(f.service.get(first.terminalId).lastExit?.reason, 'directory-removed'); assert.equal(f.service.get(second.terminalId).status, 'running');
    assert.throws(() => f.service.reopen(first.terminalId, first.instanceId, size), /登记/);
    assert.throws(() => f.service.create({ projectId: 'missing', preset: { kind: 'blank' }, size }), /项目不存在/);
    await f.service.close();
    assert.equal(f.service.get(second.terminalId).lastExit?.reason, 'service-shutdown'); assert.equal(f.service.runtime(second.terminalId), undefined);
  } finally { await f.close(); }
});
test('生命周期：无法确认停止时保留未确认且禁止关闭重开；项目收尾覆盖所有终端', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const f = fixture();
  try {
    const record = f.service.create({ projectId: f.project.projectId, preset: { kind: 'blank' }, size });
    const runtime = f.service.runtime(record.terminalId)!; const original = runtime.process.stop.bind(runtime.process);
    runtime.process.stop = async () => false;
    try {
      assert.equal((await f.service.end(record.terminalId, record.instanceId)).status, 'stop-unconfirmed');
      await assert.rejects(f.service.closeTerminal(record.terminalId, record.instanceId, true), /尚未证实/);
      assert.throws(() => f.service.reopen(record.terminalId, record.instanceId, size), /尚未证实/);
      assert.equal(f.service.get(record.terminalId).closedAt, null);
    } finally { runtime.process.stop = original; }
    f.service.create({ projectId: f.project.projectId, preset: { kind: 'blank' }, size });
    await f.service.endProject(f.project.projectId);
    assert.ok(f.service.list(f.project.projectId).every(item => item.status === 'exited' && item.lastExit?.reason === 'project-removed'));
  } finally { await f.close(); }
});
test('生命周期：重启只改遗留元数据，新实例无旧画面；反复创建结束关闭释放运行资源', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 5; i++) {
      const record = f.service.create({ projectId: f.project.projectId, preset: { kind: 'custom', executable: '/bin/sh', argv: ['-c', 'printf OLD-SCREEN; exit 1'] }, size });
      await until(() => f.service.get(record.terminalId).status === 'exited');
      assert.equal(f.service.get(record.terminalId).lastExit?.code, 1);
      await f.service.closeTerminal(record.terminalId, record.instanceId, false);
      assert.equal(f.service.runtime(record.terminalId), undefined);
      assert.equal(f.service.hasActivity, false);
    }
    const closed = f.service.list(f.project.projectId, true)[0]!;
    const interrupted = { ...closed, instanceId: 'interrupted', status: 'starting' as const, closedAt: null };
    assert.equal(f.store.terminals.replace(interrupted, closed.instanceId), true);
    const restarted = new TerminalService(f.store.terminals, id => f.store.projects.get(id)!, f.events);
    try {
      assert.equal(restarted.get(closed.terminalId).lastExit?.reason, 'multivac-restarted');
      assert.equal(restarted.runtime(closed.terminalId), undefined);
      assert.equal(restarted.hasActivity, false);
    } finally { await restarted.close(); }
  } finally { await f.close(); }
});
