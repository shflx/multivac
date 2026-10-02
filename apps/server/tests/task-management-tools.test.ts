import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { UNKNOWN_CHANGE_ORIGIN } from '@multivac/contracts';
import { TaskService } from '../src/application/task-service.js';
import { createTaskKind } from '../src/application/proposals/task-proposals.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

test('任务创建提议只读预览，项目目录变化使预览过期，确认命令重放不重复创建', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-proposal-'));
  const store = new SqliteAssistantStore(join(root, 'db.sqlite'));
  let project = { name: '研究', directories: [{ path: '/research' }], defaultConstraints: '仅文本' };
  store.createProject({ projectId: 'project', ...project, directories: [{ kind: 'mounted', path: '/research' }], createdAt: new Date().toISOString() });
  const tasks = new TaskService({ repository: store.tasks, requireProject: () => project, describeProject: () => project });
  const kind = createTaskKind(tasks);
  const payload = { title: '调研', goal: '比较资料', projectId: 'project' };
  try {
    const draft = await kind.prepare(payload);
    assert.equal(tasks.list().total, 0);
    assert.equal(await kind.revalidate(payload, draft.preview, undefined), null);
    project = { ...project, directories: [{ path: '/new-directory' }] };
    assert.match((await kind.revalidate(payload, draft.preview, undefined))!, /已变化/);
    const current = await kind.prepare(payload);
    const origin = { ...UNKNOWN_CHANGE_ORIGIN, commandId: 'user-confirm-proposal' };
    await kind.execute(payload, current.preview, origin, undefined);
    await kind.execute(payload, current.preview, origin, undefined);
    assert.equal(tasks.list().total, 1);
    assert.equal(tasks.list().tasks[0]?.status, 'idle');
    assert.equal(store.taskRuns.active().length, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
