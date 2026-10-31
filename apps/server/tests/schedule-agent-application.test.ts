import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';
import { DEFAULT_AGENT_ID } from '@multivac/contracts';

async function until(check: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error('等待定时执行超时。'); await new Promise(resolve => setTimeout(resolve, 50)); }
}
test('独立定时会话使用真实 bash、冻结快照与结果 Inbox，不创建 Task/TaskRun', async () => {
  await mkdir('.tmp', { recursive: true }); const root = await mkdtemp(resolve('.tmp/schedule-agent-'));
  const app = createMultivacApplication(testApplicationEnvironment(root));
  try {
    await app.ready;
    const before = app.tasks.list({}).total;
    const schedule = app.schedules.create('global-coordinator', { commandId: 'create', name: '独立运行', timeZone: 'UTC', rule: { kind: 'daily', time: '09:00' }, missedPolicy: 'skip',
      action: { kind: 'agent', instruction: 'bash执行：'+JSON.stringify({ command: "printf 'scheduled' > result.txt && cat result.txt", timeout: 5 }), agentId: DEFAULT_AGENT_ID, projectId: null, directory: null,
        budget: { maxMillis: 10000, maxOutputBytes: 1024 * 1024, maxToolCalls: 20 } } });
    for (const commandId of ['one','two']) {
      app.schedules.control('global-coordinator', { commandId, scheduleId: schedule.scheduleId, revision: 1, operation: 'trigger' });
      await until(() => !app.schedules.detail(schedule.scheduleId).active);
    }
    const records = app.schedules.detail(schedule.scheduleId).history.items;
    assert.equal(records.length, 2);
    assert.deepEqual(records.map(r => r.status), ['succeeded','succeeded']);
    assert.notEqual(records[0]!.sessionId, records[1]!.sessionId);
    const snapshot = records[0]!.executionSnapshot as any;
    assert.equal(await readFile(join(snapshot.workingDirectory.path,'result.txt'), 'utf8'), 'scheduled');
    assert.equal(snapshot.agentExecution.executor.agentId, DEFAULT_AGENT_ID);
    assert.equal(snapshot.runtimeConfig.model.provider, 'fixture');
    assert.ok(snapshot.toolCalls > 0);
    const processes = app.managedProcesses.list(true).filter(p => records.some(r => r.sessionId === p.sessionId));
    assert.equal(processes.length, 2); assert.ok(processes.every(p => p.taskId === null && p.runId === null && p.state === 'exited'));
    assert.equal(app.tasks.list({}).total, before);
    const notifications = app.inbox.page({ status: 'all' }).items.filter(i => i.notification?.source === 'agent');
    assert.equal(notifications.length, 2); assert.ok(notifications.every(i => i.notification?.reminderId === null));
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
test('停止本次真实进程不暂停周期；失效智能体明确失败且结果可查', async () => {
  await mkdir('.tmp', { recursive: true }); const root = await mkdtemp(resolve('.tmp/schedule-stop-'));
  const app = createMultivacApplication(testApplicationEnvironment(root));
  try {
    await app.ready;
    const schedule = app.schedules.create('global-coordinator', { commandId: 'create', name: '停止', timeZone: 'UTC', rule: { kind: 'daily', time: '09:00' }, missedPolicy: 'skip',
      action: { kind: 'agent', instruction: 'bash执行：'+JSON.stringify({ command: 'node -e "setInterval(()=>{},1000)"', mode: 'foreground' }), agentId: DEFAULT_AGENT_ID, projectId: null, directory: null,
        budget: { maxMillis: 15000, maxOutputBytes: 1024 * 1024, maxToolCalls: 20 } } });
    app.schedules.control('global-coordinator', { commandId: 'one', scheduleId: schedule.scheduleId, revision: 1, operation: 'trigger' });
    await until(() => app.managedProcesses.list(true).some(p => p.state === 'running'));
    app.schedules.control('global-coordinator', { commandId: 'stop', scheduleId: schedule.scheduleId, revision: 1, operation: 'stop' });
    await until(() => !!app.schedules.detail(schedule.scheduleId).history.items[0]?.endedAt);
    assert.equal(app.schedules.detail(schedule.scheduleId).history.items[0]!.status, 'stopped');
    assert.ok(app.managedProcesses.list(true).every(p => ['exited','failed'].includes(p.state)));
    assert.equal(app.schedules.get(schedule.scheduleId).state, 'active');
    const invalid = app.schedules.create('global-coordinator', { commandId: 'invalid', name: '失效引用', timeZone: 'UTC', rule: { kind: 'daily', time: '09:00' }, missedPolicy: 'skip',
      action: { kind: 'agent', instruction: '读取目录', agentId: 'removed-agent', projectId: null, directory: null, budget: { maxMillis: 1000, maxOutputBytes: 1024, maxToolCalls: 1 } } });
    app.schedules.control('global-coordinator', { commandId: 'bad', scheduleId: invalid.scheduleId, revision: 1, operation: 'trigger' });
    await until(() => !app.schedules.detail(invalid.scheduleId).active);
    assert.equal(app.schedules.detail(invalid.scheduleId).history.items[0]!.status, 'failed');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
test('Inbox 澄清沿原等待恢复，预算耗尽使人工等待失效且阻止迟到回应', async () => {
  await mkdir('.tmp', { recursive: true }); const root = await mkdtemp(resolve('.tmp/schedule-input-'));
  const app = createMultivacApplication(testApplicationEnvironment(root));
  try {
    await app.ready;
    for (const [commandId, millis] of [['answered',10000],['expired',1000]] as const) {
      const schedule = app.schedules.create('global-coordinator', { commandId, name: commandId, timeZone: 'UTC', rule: { kind: 'daily', time: '09:00' }, missedPolicy: 'skip',
        action: { kind: 'agent', instruction: '内部工具：request_schedule_input {"question":"选择输出格式"}', agentId: DEFAULT_AGENT_ID, projectId: null, directory: null,
          budget: { maxMillis: millis, maxOutputBytes: 1024 * 1024, maxToolCalls: 20 } } });
      app.schedules.control('global-coordinator', { commandId: 'run-'+commandId, scheduleId: schedule.scheduleId, revision: 1, operation: 'trigger' });
      await until(() => app.inbox.page({status:'all'}).items.some(i => i.scheduleInput?.scheduleId === schedule.scheduleId));
      const request = app.inbox.page({status:'all'}).items.find(i => i.scheduleInput?.scheduleId === schedule.scheduleId)!;
      assert.equal(request.taskId, null);
      if (commandId === 'answered') {
        await app.inbox.decide(request.id, { commandId: 'answer', revision: request.revision, decision: 'answer', answer: 'Markdown' });
        await until(() => !app.schedules.detail(schedule.scheduleId).active);
        assert.equal(app.schedules.detail(schedule.scheduleId).history.items[0]!.status, 'succeeded');
      } else {
        await until(() => !app.schedules.detail(schedule.scheduleId).active);
        assert.equal(app.schedules.detail(schedule.scheduleId).history.items[0]!.status, 'stopped');
        assert.equal(app.inbox.get(request.id).status, 'invalidated');
        await assert.rejects(app.inbox.decide(request.id, { commandId: 'late', revision: request.revision, decision: 'answer', answer: '继续' }));
      }
    }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
