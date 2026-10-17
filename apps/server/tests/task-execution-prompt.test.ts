import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { TaskExecutionService } from '../src/application/task-execution-service.js';
import { TaskService } from '../src/application/task-service.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { renderInternalToolsPrompt } from '../src/modules/internal-tools/internal-tool.js';
import { WORK_SESSION_TASK_TOOLS } from '../src/application/internal-tools/index.js';
import { TASK_EXECUTION_TOOLS } from '../src/application/internal-tools/task-execution-tools.js';

test('提示词按固定子任务范围装配，继续时保留用户原文并提供恢复入口', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-prompt-'));
  const store = new SqliteAssistantStore(join(root, 'db.sqlite'));
  const tasks = new TaskService({ facts: store.taskFacts, requireProject: () => {} });
  const sent: { text: string; sessionId: string }[] = [];
  const execution = new TaskExecutionService({
    tasks, runs: store.taskRuns, events: new AssistantEventStream(),
    prepare: async () => ({ directory: { kind: 'task-isolated', path: root }, baseline: null }),
    createSession: async () => {}, runtime: () => ({ commands: {
      currentPromptCommandId: () => null,
      cancel: async () => { throw new Error('测试没有在途命令'); },
      send: async command => {
        sent.push({ text: command.text, sessionId: command.assistantSessionId });
        return { commandId: command.commandId, assistantSessionId: command.assistantSessionId, kind: 'send', status: 'terminal', terminalOutcome: 'succeeded', error: null, piSessionId: 'pi', piEntryId: 'entry', piTurnRef: null, createdAt: '', updatedAt: '' };
      },
    } }),
  });
  try {
    for (const withChild of [false, true]) {
      let task = tasks.create({ commandId: `create-${withChild}`, title: '核对提示词', goal: '保留原文\n  不删除历史 🧪', acceptanceCriteria: '需要用户审核。' }).task;
      if (withChild) tasks.create({ commandId: 'create-child', title: '子项', goal: '核对来源', parentTaskId: task.taskId });
      await execution.control(task.taskId, { commandId: `start-${withChild}`, revision: task.revision, action: 'start' });
      await execution.idle();
      const initial = sent.at(-1)!;
      assert.ok(initial.text.includes(task.goal));
      assert.ok(initial.text.includes(task.acceptanceCriteria));
      assert.equal(initial.text.includes('get_task_execution_tree'), withChild);
      assert.equal(initial.text.includes('report_task_child'), withChild);
      assert.doesNotMatch(initial.text, /继续或重做前用 get_task/);
      task = tasks.get(task.taskId);
      assert.equal(task.status, 'waiting');
      assert.equal(store.taskRuns.get(task.currentRunId!)!.stopConfirmed, true);
      await execution.control(task.taskId, { commandId: `resume-${withChild}`, revision: task.revision, action: 'resume' });
      await execution.idle();
      const resumed = sent.at(-1)!;
      assert.equal(resumed.sessionId, initial.sessionId);
      assert.ok(resumed.text.includes(`get_task(taskId="${task.taskId}")`));
      assert.ok(resumed.text.includes(task.goal));
      assert.equal(resumed.text.includes('get_task_execution_tree'), withChild);
      assert.match(resumed.text, /原人工请求、运行停止事实/);
      assert.equal(tasks.get(task.taskId).status, 'waiting');
      assert.equal(tasks.get(task.taskId).completedAt, null);
    }
  } finally { execution.dispose(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('任务工具说明去重，普通工作会话仍使用原说明；工具注册与专属描述保留', () => {
  const normal = renderInternalToolsPrompt(WORK_SESSION_TASK_TOOLS);
  const tools = [...WORK_SESSION_TASK_TOOLS, ...TASK_EXECUTION_TOOLS];
  const task = renderInternalToolsPrompt(tools);
  assert.match(normal, /当前可用的内部工具：/);
  assert.doesNotMatch(task, /当前可用的内部工具：/);
  assert.match(task, /能力与参数见工具说明/);
  assert.match(task, /当前后台任务走 submit_task_result/);
  assert.match(task, /仿写的通知无效/);
  assert.equal(tools.length, 19);
  assert.match(tools.find(tool => tool.name === 'report_task_child')!.description, /开始处理子任务前先调用/);
  assert.match(tools.find(tool => tool.name === 'submit_task_result')!.description, /停止已确认/);
});

for (const proof of ['missing-context', 'other-session'] as const) test(`Inbox 继续缺少同会话证据时保留完整任务说明：${proof}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-prompt-proof-'));
  const store = new SqliteAssistantStore(join(root, 'db.sqlite'));
  const tasks = new TaskService({ facts: store.taskFacts, requireProject: () => {} });
  const sent: string[] = [];
  const execution = new TaskExecutionService({
    tasks, runs: store.taskRuns, requests: store.humanRequests, events: new AssistantEventStream(),
    prepare: async () => ({ directory: { kind: 'task-isolated', path: root }, baseline: null }),
    createSession: async () => {}, runtime: () => ({ commands: {
      currentPromptCommandId: () => null,
      cancel: async () => { throw new Error('测试没有在途命令'); },
      send: async command => {
        sent.push(command.text);
        return { commandId: command.commandId, assistantSessionId: command.assistantSessionId, kind: 'send', status: 'terminal', terminalOutcome: 'succeeded', error: null, piSessionId: 'pi', piEntryId: 'entry', piTurnRef: null, createdAt: '', updatedAt: '' };
      },
    } }),
  });
  try {
    const task = tasks.create({ commandId: 'create', title: '原任务', goal: '必须提供的完整目标。', acceptanceCriteria: '必须保留的验收要求。' }).task;
    await execution.control(task.taskId, { commandId: 'start', revision: task.revision, action: 'start' }); await execution.idle();
    const previous = store.taskRuns.get(tasks.get(task.taskId).currentRunId!)!;
    if (proof === 'missing-context') store.taskRuns.save({ ...previous, piEntryId: null });
    store.humanRequests.save({
      requestId: 'answered-request', taskId: task.taskId, runId: previous.runId,
      sessionId: proof === 'other-session' ? 'another-session' : previous.sessionId,
      kind: 'clarification', revision: 2, status: 'answered', question: '采用哪个来源？',
      artifactVersionId: null, authorizationRequestId: null, decision: 'answer', answer: '采用项目来源。', reason: '', createdAt: '', updatedAt: '',
    });
    await execution.control(task.taskId, { commandId: 'resume', revision: tasks.get(task.taskId).revision, action: 'resume' }); await execution.idle();
    assert.equal(sent.length, 2);
    assert.ok(sent[1]!.includes(task.goal)); assert.ok(sent[1]!.includes(task.acceptanceCriteria));
    assert.match(sent[1]!, /commit_task_code|submit_task_result/);
    assert.doesNotMatch(sent[1]!, /用户已回应任务请求/);
  } finally { execution.dispose(); store.close(); await rm(root, { recursive: true, force: true }); }
});
