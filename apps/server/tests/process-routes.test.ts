import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { GLOBAL_ASSISTANT_SESSION_ID } from '@multivac/contracts';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { ManagedProcessService } from '../src/application/managed-process-service.js';
import { TaskService } from '../src/application/task-service.js';
import { createProcessRequestHandler } from '../src/adapters/http/process-routes.js';

test('活跃进程查询先过滤历史再分页，保留启动和停止中，总数与游标准确', async () => {
  const store = new SqliteAssistantStore(':memory:');
  const processes = new ManagedProcessService(store.managedProcesses, process.cwd(), []);
  const tasks = new TaskService({ repository: store.tasks, requireProject: () => null });
  const handler = createProcessRequestHandler(processes, tasks);
  const server = createServer((request, response) => { void handler(request, response); });
  try {
    const states = ['starting', 'running', 'stopping', ...Array.from({ length: 105 }, (_, i) => (['exited', 'failed', 'recovery'] as const)[i % 3]!)] as const;
    for (const [index, state] of states.entries()) store.managedProcesses.save({
      commandId: `command-${index}`, fingerprint: `key-${index}`, directory: process.cwd(), ownerId: 'owner', token: 'token', pid: null,
      public: { processId: `process-${index}`, taskId: null, runId: null, sessionId: GLOBAL_ASSISTANT_SESSION_ID, revision: 1,
        mode: 'background', name: `进程 ${index}`, command: '测试记录', state, requiredWhileRunning: false,
        startedAt: null, endedAt: null, port: null, exitCode: null, reason: state },
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const root = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/processes`;
    const active = await (await fetch(`${root}?activeOnly=true`)).json();
    assert.equal(active.total, 3); assert.equal(active.nextOffset, null);
    assert.deepEqual(active.processes.map((item: { state: string }) => item.state), ['stopping', 'running', 'starting']);
    const last = await (await fetch(`${root}?activeOnly=true&offset=2`)).json();
    assert.equal(last.processes.length, 1); assert.equal(last.total, 3);
    assert.equal((await (await fetch(root)).json()).total, 108);
    assert.equal((await fetch(`${root}?activeOnly=maybe`)).status, 400);
    assert.equal((await fetch(`${root}?activeOnly=true&activeOnly=false`)).status, 400);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); store.close();
  }
});
