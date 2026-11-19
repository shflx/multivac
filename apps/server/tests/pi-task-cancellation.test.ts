import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { configureScriptedModel, startScriptedModel } from './fixtures/scripted-model.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

test('真实 Pi 执行任务工具，取消后核对托管进程退出，服务重启保留原结果', {
  skip: process.platform !== 'darwin', timeout: 20_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-task-stop-'));
  const upstream = await startScriptedModel();
  const environment = {
    ...testApplicationEnvironment(root), MULTIVAC_MODE: 'development', MULTIVAC_FAKE_ASSISTANT: '0',
    MULTIVAC_PROVIDER: 'local-scripted', MULTIVAC_MODEL: 'scripted',
  };
  let app: ReturnType<typeof createMultivacApplication> | undefined;
  try {
    await configureScriptedModel(join(environment.MULTIVAC_DATA_DIR!, 'pi'), upstream.endpoint);
    upstream.script({ toolCalls: [{ name: 'bash', arguments: { command: 'echo tool-started; exec /bin/sleep 30' } }] });
    app = createMultivacApplication(environment);
    await app.ready;
    const task = app.tasks.create({ commandId: 'create', title: '核对工具停止', goal: '等待任务取消' }).task;
    await app.taskExecution.control(task.taskId, { commandId: 'start', revision: task.revision, action: 'start' });
    let processId: string | undefined;
    for (let attempt = 0; attempt < 150; attempt++) {
      const process = app.managedProcesses.list().find(item => item.taskId === task.taskId);
      if (process?.state === 'running' && (await app.managedProcesses.logs(process.processId)).text.includes('tool-started')) {
        processId = process.processId;
        break;
      }
      const current = app.tasks.get(task.taskId);
      assert.ok(['queued', 'running'].includes(current.status), current.reason ?? current.status);
      await delay(40);
    }
    assert.ok(processId, '托管工具已开始执行');
    assert.equal(app.tasks.detail(task.taskId).runs![0]!.stopConfirmed, false);
    const [request] = upstream.takeRequests();
    assert.ok(request?.tools.includes('bash'));
    assert.ok(!request.tools.some(name => name === 'codemode' || name.startsWith('mcp__')));

    await app.taskExecution.control(task.taskId, { commandId: 'cancel', revision: app.tasks.get(task.taskId).revision, action: 'cancel' });
    await app.taskExecution.idle();
    const run = app.tasks.detail(task.taskId).runs![0]!;
    assert.equal(run.stopConfirmed, true);
    assert.deepEqual(run.pendingToolIds, []);
    assert.deepEqual(run.nativePendingIds, []);
    assert.equal(app.managedProcesses.get(processId)?.state, 'exited');
    assert.equal(app.tasks.get(task.taskId).status, 'cancelled');
    const databasePath = app.paths.databasePath;
    await app.close();
    app = undefined;
    assert.deepEqual(upstream.takeRequests(), []);
    const store = new SqliteAssistantStore(databasePath);
    try {
      const record = store.managedProcesses.get(processId);
      assert.ok(record?.pid);
      assert.throws(() => process.kill(record.pid!, 0), { code: 'ESRCH' });
    } finally { store.close(); }

    app = createMultivacApplication(environment);
    await app.ready;
    await app.taskExecution.idle();
    assert.equal(app.tasks.get(task.taskId).status, 'cancelled');
    assert.deepEqual(app.tasks.detail(task.taskId).runs?.map(item => item.runId), [run.runId]);
    assert.equal(app.managedProcesses.get(processId)?.state, 'exited');
    assert.deepEqual(upstream.takeRequests(), []);
  } finally {
    await app?.close();
    await upstream.close();
    await rm(root, { recursive: true, force: true });
  }
});
