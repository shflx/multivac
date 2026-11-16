import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Task, TaskRun } from '@multivac/contracts';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { HumanRequestService } from '../src/application/human-request-service.js';
import { TaskExecutionService } from '../src/application/task-execution-service.js';
import { TaskScheduler } from '../src/application/task-scheduler.js';
import { TaskService } from '../src/application/task-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function fixture(path = ':memory:', admitAgent: (id: string) => Promise<void> = async () => {}) {
  const store = new SqliteAssistantStore(path);
  const events = new WorkbenchEvents(), stream = new AssistantEventStream();
  let scheduler: TaskScheduler | undefined;
  let requests: HumanRequestService | undefined;
  const tasks = new TaskService({ facts: store.taskFacts, events, requireProject: () => {},
    afterCommit: task => { requests?.afterTaskCommit(task); scheduler?.wake(); } });
  let sends = 0, agentRevision = 1;
  const prompts: string[] = [];
  const execution = new TaskExecutionService({ tasks, requests: store.humanRequests, runs: store.taskRuns, events: stream,
    admitAgent, agentRevision: () => agentRevision, settleArtifacts: async () => {},
    prepare: async () => { throw new Error('测试必须沿用原目录'); }, createSession: async () => {},
    runtime: () => ({ commands: { currentPromptCommandId: () => null, cancel: async () => { throw new Error('没有活动模型'); },
      send: async command => {
        sends++; prompts.push(command.text);
        return { ...command, kind: 'send', status: 'terminal', terminalOutcome: 'succeeded', error: null,
          runtimeSessionId: 'pi', runtimeEntryId: 'entry', runtimeTurnRef: null, createdAt: '', updatedAt: '' };
      },
    } }),
  });
  requests = new HumanRequestService({ tasks, runs: store.taskRuns, requests: store.humanRequests, execution, events, assistantEvents: stream,
    authorization: { list: () => [], decide: () => { throw new Error('不涉及授权'); } }, reviewArtifact: async () => { throw new Error('不涉及验收'); } });
  function seed(id = 'task', patch: Partial<Task> = {}) {
    const task = tasks.create({ commandId: `create:${id}`, title: id, goal: '核对原现场', ...('dependencyIds' in patch ? { dependencyIds: patch.dependencyIds! } : {}) }).task;
    const at = new Date().toISOString();
    const run: TaskRun = { runId: `old:${id}`, taskId: task.taskId, sessionId: `session:${id}`, commandId: `command:${id}`, status: 'paused',
      stopIntent: 'pause', stopConfirmed: true, hasStarted: true, nativeLeaseFenced: true, nativePendingIds: [],
      ownerId: 'old-owner', ownerPid: 99999999, directory: { kind: 'worktree', path: `/test-only/${id}` }, baseline: null,
      goal: task.goal, scope: task.scope, projectId: null, pendingToolIds: [], toolFailures: 0,
      runtimeSessionId: 'pi', runtimeEntryId: 'entry', reason: '', createdAt: at, updatedAt: at };
    tasks.transition(task.taskId, { commandId: `seed:${id}`, key: id, kind: 'fixture', summary: '模拟已停止的原运行' }, (current, facts) => {
      facts.runs.save(run);
      return { ...current, ...patch, status: 'waiting', pauseSource: 'human', currentRunId: run.runId, sessionId: run.sessionId };
    });
    const request = requests!.create(task.taskId, 'clarification', '采用哪份来源？', `ask:${id}`);
    return { task: tasks.get(task.taskId), run, request };
  }
  return { store, tasks, execution, requests, prompts, seed, sends: () => sends,
    changeAgent() { agentRevision++; },
    start() { scheduler = new TaskScheduler(tasks, execution, store.taskRuns, store.taskRuntime).start(); },
    drain() { scheduler!.drain(); },
    async close() { scheduler?.dispose(); execution.beginClose(); await execution.idle(); requests!.dispose(); execution.dispose(); store.close(); },
  };
}
const answer = { commandId: 'answer', revision: 1, decision: 'answer' as const, answer: '来源 A' };

test('模型准入挂起时回应已返回并持久化，重复提交及调度唤醒仅恢复一次', async () => {
  const admission = gate(); let admits = 0;
  const f = fixture(':memory:', async () => { admits++; await admission.promise; });
  try {
    const { task, request, run } = f.seed(); f.start();
    const saved = await f.requests.decide(request.requestId, answer);
    assert.equal(saved.status, 'answered'); assert.equal(saved.answer, '来源 A');
    assert.ok(f.tasks.get(task.taskId).humanResumeIntent);
    assert.equal(f.tasks.get(task.taskId).status, 'paused');
    assert.equal(f.store.taskRuns.list(task.taskId).length, 1); assert.equal(f.sends(), 0);
    await f.requests.decide(request.requestId, answer);
    for (let i = 0; i < 10; i++) f.drain();
    await turn(); assert.equal(admits, 1);
    admission.release(); await f.execution.idle();
    assert.equal(f.sends(), 1); assert.equal(f.tasks.get(task.taskId).humanResumeIntent, null);
    const next = f.store.taskRuns.list(task.taskId).find(value => value.runId !== run.runId)!;
    assert.equal(next.sessionId, run.sessionId); assert.deepEqual(next.directory, run.directory);
    assert.equal(next.budgetRenewal, undefined); assert.match(f.prompts[0]!, /来源 A/);
    await f.requests.decide(request.requestId, answer); f.drain(); await f.execution.idle();
    assert.equal(f.store.taskRuns.list(task.taskId).length, 2); assert.equal(f.sends(), 1);
  } finally { admission.release(); await f.close(); }
});

for (const action of ['pause', 'cancel'] as const) test(`准入挂起期间用户 ${action} 不被迟到准入解除`, async () => {
  const admission = gate(); const f = fixture(':memory:', async () => admission.promise);
  try {
    const { task, request } = f.seed(); f.start();
    await f.requests.decide(request.requestId, answer); await turn();
    await f.execution.control(task.taskId, { commandId: action, revision: f.tasks.get(task.taskId).revision, action });
    admission.release(); await f.execution.idle(); f.drain(); await f.execution.idle();
    assert.equal(f.tasks.get(task.taskId).status, action === 'pause' ? 'paused' : 'cancelled');
    assert.equal(f.tasks.get(task.taskId).humanResumeIntent, null);
    assert.equal(f.sends(), 0); assert.equal(f.store.taskRuns.list(task.taskId).length, 1);
    assert.equal(f.requests.get(request.requestId).answer, '来源 A');
  } finally { admission.release(); await f.close(); }
});

for (const blocker of ['other-request', 'stop', 'tool', 'budget', 'dependency'] as const) test(`人工继续不绕过 ${blocker}，回答仍保存且原因可查询`, async () => {
  const f = fixture();
  try {
    const dependency = blocker === 'dependency' ? f.tasks.create({ commandId: 'dependency', title: '前置', goal: '等待' }).task : null;
    const { task, request, run } = f.seed('task', {
      ...(dependency ? { dependencyIds: [dependency.taskId] } : {}),
      ...(blocker === 'budget' ? { budget: { maxRuns: 1, maxMillis: 900000, maxOutputBytes: 4096 } } : {}),
    });
    if (blocker === 'other-request') f.requests.create(task.taskId, 'review', '还有一项确认', 'other');
    if (blocker === 'stop') f.store.taskRuns.save({ ...run, stopConfirmed: false });
    if (blocker === 'tool') f.store.taskRuns.save({ ...run, nativePendingIds: ['unknown'] });
    await f.requests.decide(request.requestId, answer); await f.execution.idle();
    assert.equal(f.requests.get(request.requestId).status, 'answered');
    assert.match(f.tasks.get(task.taskId).reason, /回应已保存，自动继续等待核对/);
    assert.equal(f.store.taskRuns.list(task.taskId).length, 1); assert.equal(f.sends(), 0);
    if (blocker === 'other-request') {
      const other = f.requests.list(task.taskId).find(value => value.status === 'pending')!;
      // 用持久请求事实模拟另一入口已保存的决定，再唤醒同一继续意图。
      f.store.humanRequests.save({ ...other, status: 'answered', revision: 2, decision: 'accept' });
    }
    if (blocker === 'stop') {
      f.store.taskRuns.save({ ...run, stopConfirmed: true });
      f.tasks.transition(task.taskId, { commandId: 'stop-settled', key: 'stop', kind: 'fixture', summary: '原运行晚于回应确认停止' }, current => ({ ...current, status: 'waiting', pauseSource: 'human' }));
    }
    if (blocker === 'tool') f.store.taskRuns.save({ ...run, nativePendingIds: [] });
    if (dependency) f.tasks.transition(dependency.taskId, { commandId: 'dependency-done', key: 'done', kind: 'fixture', summary: '前置已交付' }, current => ({ ...current, status: 'review' }));
    await f.execution.resumeAfterHuman(task.taskId); await f.execution.idle();
    if (blocker === 'budget') { assert.equal(f.sends(), 0); assert.equal(f.store.taskRuns.list(task.taskId).length, 1); }
    else { assert.equal(f.sends(), 1); assert.equal(f.store.taskRuns.list(task.taskId).length, 2); }
    assert.equal(f.store.taskRuns.list(task.taskId).some(value => value.budgetRenewal), false);
  } finally { await f.close(); }
});

test('并发多条回答全部保存后才继续，最后决定替换在途意图仍只产生一个新 Run', async () => {
  const admission = gate(); const f = fixture(':memory:', async () => admission.promise);
  try {
    const { task, request } = f.seed();
    const other = f.requests.create(task.taskId, 'recovery', '核对后继续？', 'other');
    await Promise.all([f.requests.decide(request.requestId, answer), f.requests.decide(other.requestId, { commandId: 'other-answer', revision: 1, decision: 'continue' })]);
    await turn(); assert.equal(f.sends(), 0); assert.equal(f.requests.pending(task.taskId), false);
    admission.release(); await f.execution.idle();
    // 新决定在慢准入期间替换了意图时，后续唤醒消费最新版本。
    await f.execution.resumeAfterHuman(task.taskId); await f.execution.idle();
    assert.equal(f.sends(), 1); assert.equal(f.store.taskRuns.list(task.taskId).length, 2);
  } finally { admission.release(); await f.close(); }
});

test('准入失败保留回答与继续意图，修复后可重试；执行边界变化使旧意图失效', async () => {
  let fail = true;
  const f = fixture(':memory:', async () => { if (fail) throw new Error('模型认证待核对'); });
  try {
    const { task, request } = f.seed();
    await f.requests.decide(request.requestId, answer); await f.execution.idle();
    assert.match(f.tasks.get(task.taskId).reason, /模型认证待核对/);
    assert.equal(f.requests.get(request.requestId).status, 'answered');
    fail = false;
    f.tasks.update(task.taskId, { commandId: 'boundary', revision: f.tasks.get(task.taskId).revision, patch: { goal: '用户新目标' } });
    await f.execution.resumeAfterHuman(task.taskId);
    assert.equal(f.tasks.get(task.taskId).humanResumeIntent, null); assert.equal(f.sends(), 0);
  } finally { await f.close(); }
});

test('回答保存后关闭并重开 SQLite，持久意图重核后仅恢复一次，已消费意图不重放', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-human-intent-'));
  const path = join(root, 'db.sqlite');
  const admission = gate(); let f = fixture(path, async () => admission.promise);
  try {
    const { task, request } = f.seed(); f.start();
    await f.requests.decide(request.requestId, answer); await turn();
    f.execution.beginClose(); admission.release(); await f.close();
    f = fixture(path); f.start(); await turn(); await f.execution.idle();
    assert.equal(f.requests.get(request.requestId).answer, '来源 A');
    assert.equal(f.sends(), 1); assert.equal(f.store.taskRuns.list(task.taskId).length, 2);
    assert.equal(f.tasks.get(task.taskId).humanResumeIntent, null);
    await f.close(); f = fixture(path); f.start(); await turn(); await f.execution.idle();
    assert.equal(f.sends(), 0); assert.equal(f.store.taskRuns.list(task.taskId).length, 2);
  } finally { admission.release(); await f.close(); await rm(root, { recursive: true, force: true }); }
});

for (const changed of ['stop', 'request', 'budget', 'dependency', 'run', 'agent'] as const) test(`慢准入后重新核对 ${changed}，迟到成功不创建 Run`, async () => {
  const admission = gate(); const f = fixture(':memory:', async () => admission.promise);
  try {
    const dependency = f.tasks.create({ commandId: 'dependency', title: '前置', goal: '核对' }).task;
    f.tasks.transition(dependency.taskId, { commandId: 'review', key: 'review', kind: 'fixture', summary: '前置已交付' }, current => ({ ...current, status: 'review' }));
    const { task, request, run } = f.seed('task', { dependencyIds: [dependency.taskId] });
    await f.requests.decide(request.requestId, answer); await turn();
    if (changed === 'stop') f.store.taskRuns.save({ ...run, stopConfirmed: false });
    if (changed === 'request') f.requests.create(task.taskId, 'review', '新的待处理项', 'new-request');
    if (changed === 'budget') f.store.taskRuns.save({ ...run, outputBytes: 16 * 1024 * 1024 });
    if (changed === 'dependency') f.tasks.transition(dependency.taskId, { commandId: 'changes', key: 'changes', kind: 'fixture', summary: '前置被退回' }, current => ({ ...current, status: 'paused', pauseSource: 'user' }));
    if (changed === 'run') f.tasks.transition(task.taskId, { commandId: 'replace', key: 'replace', kind: 'fixture', summary: '原运行身份已变化' }, current => ({ ...current, currentRunId: null }));
    if (changed === 'agent') f.changeAgent();
    admission.release(); await f.execution.idle();
    assert.equal(f.sends(), 0); assert.equal(f.store.taskRuns.list(task.taskId).length, 1);
    assert.equal(f.requests.get(request.requestId).answer, '来源 A');
  } finally { admission.release(); await f.close(); }
});

test('决定与意图、新 Run 与意图消费均在同一事务中回滚，重试只执行一次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-human-atomic-'));
  const path = join(root, 'db.sqlite'); const admission = gate(); const f = fixture(path, async () => admission.promise);
  const injector = new DatabaseSync(path);
  try {
    const { task, request } = f.seed();
    injector.exec("CREATE TRIGGER fail_decision BEFORE UPDATE ON task BEGIN SELECT RAISE(ABORT, 'decision-injected'); END;");
    await assert.rejects(f.requests.decide(request.requestId, answer), /decision-injected/);
    assert.equal(f.requests.get(request.requestId).status, 'pending');
    assert.equal(f.tasks.get(task.taskId).humanResumeIntent, undefined);
    assert.equal(f.tasks.commandRecorded(answer.commandId), false);
    injector.exec('DROP TRIGGER fail_decision');
    await f.requests.decide(request.requestId, answer); await turn();
    const intent = f.tasks.get(task.taskId).humanResumeIntent!;
    // 新 Run 已写入后任务更新失败，应连同 Run 和继续回执一起撤回。
    injector.exec("CREATE TRIGGER fail_consume BEFORE UPDATE ON task WHEN NEW.status='queued' BEGIN SELECT RAISE(ABORT, 'consume-injected'); END;");
    admission.release(); await f.execution.idle();
    assert.equal(f.requests.get(request.requestId).status, 'answered');
    assert.deepEqual(f.tasks.get(task.taskId).humanResumeIntent, intent);
    assert.equal(f.tasks.commandRecorded(intent.commandId), false);
    assert.equal(f.store.taskRuns.list(task.taskId).length, 1);
    assert.match(f.tasks.get(task.taskId).reason, /consume-injected/);
    injector.exec('DROP TRIGGER fail_consume');
    await f.execution.resumeAfterHuman(task.taskId); await f.execution.idle();
    assert.equal(f.sends(), 1); assert.equal(f.tasks.commandRecorded(intent.commandId), true);
    assert.equal(f.tasks.get(task.taskId).humanResumeIntent, null);
  } finally { admission.release(); injector.close(); await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('启动扫描读取超过百条待继续意图，慢准入不阻塞其他调度', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-human-pages-'));
  const path = join(root, 'db.sqlite'); const admission = gate(); let admits = 0;
  let f = fixture(path);
  try {
    f.execution.beginClose();
    for (let i = 0; i < 101; i++) {
      const { request } = f.seed(`task-${i}`);
      await f.requests.decide(request.requestId, { ...answer, commandId: `answer-${i}` });
    }
    await f.close();
    f = fixture(path, async () => { admits++; await admission.promise; }); f.start(); await turn();
    assert.equal(admits, 101); assert.equal(f.sends(), 0);
    for (let i = 0; i < 5; i++) f.drain();
    assert.equal(admits, 101);
    admission.release(); await f.execution.idle();
    assert.equal(f.sends(), 101);
    f.drain(); await f.execution.idle(); assert.equal(f.sends(), 101);
  } finally { admission.release(); await f.close(); await rm(root, { recursive: true, force: true }); }
});

for (const unknown of [false, true]) test(`继续意图已消费后重启沿用原 Run 恢复规则：${unknown ? '已开始且结果未知不重放' : '安全未开始队列仅接管一次'}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-human-consumed-'));
  const path = join(root, 'db.sqlite'); let f = fixture(path);
  try {
    const { task, request } = f.seed();
    f.execution.attachScheduler(() => {}, () => {});
    await f.requests.decide(request.requestId, answer); await f.execution.idle();
    const queued = f.store.taskRuns.get(f.tasks.get(task.taskId).currentRunId!)!;
    assert.equal(f.tasks.get(task.taskId).status, 'queued');
    assert.equal(f.tasks.get(task.taskId).humanResumeIntent, null);
    if (unknown) f.store.taskRuns.save({ ...queued, hasStarted: true, ownerPid: 99999999, nativePendingIds: ['unknown-effect'] });
    await f.close(); f = fixture(path); f.start(); await turn(); await f.execution.idle();
    assert.equal(f.store.taskRuns.list(task.taskId).length, 2);
    assert.equal(f.tasks.get(task.taskId).currentRunId, queued.runId);
    assert.equal(f.sends(), unknown ? 0 : 1);
    if (unknown) {
      assert.equal(f.tasks.get(task.taskId).status, 'recovery');
      assert.equal(f.store.taskRuns.get(queued.runId)!.stopConfirmed, false);
      assert.equal(f.requests.list(task.taskId).some(value => value.kind === 'recovery' && value.status === 'pending'), true);
    }
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});
