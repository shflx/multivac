import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { COORDINATOR_AGENT_ID, DEFAULT_AGENT_ID, type ModelSettingsSnapshot, type Task } from '@multivac/contracts';
import { AgentService } from '../src/application/agent-service.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { TaskExecutionService } from '../src/application/task-execution-service.js';
import { TaskService } from '../src/application/task-service.js';
import { readWorkingDirectoryAgentsFile, renderTaskConventions, TASK_AGENTS_FILE_MAX_BYTES } from '../src/application/task-agent-runtime.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

/** 一个可用模型（model-a，支持 high）与一个不可用模型（model-off）的配置快照。 */
function snapshot(): ModelSettingsSnapshot {
  const capabilities = { source: 'pi-catalog' as const, input: ['text' as const], reasoning: true, thinkingLevels: ['off', 'high'] as ('off' | 'high')[], contextWindow: 1000, maxTokens: 100 };
  return {
    revision: 1, defaultProfileId: 'model-a',
    profiles: [
      { profileId: 'model-a', displayName: '模型 A', provider: 'p', modelId: 'a', protocol: 'openai-completions', endpoint: null, capabilities, invalid: false },
      { profileId: 'model-off', displayName: '停用模型', provider: 'p', modelId: 'off', protocol: 'openai-completions', endpoint: null, capabilities, invalid: false },
    ],
    availability: [
      { profileId: 'model-a', authenticated: true, available: true, message: null },
      { profileId: 'model-off', authenticated: true, available: true, message: null },
    ],
  } as unknown as ModelSettingsSnapshot;
}

function services(root: string) {
  const store = new SqliteAssistantStore(join(root, 'db.sqlite'));
  let current = snapshot();
  // 先建任务服务，再接入智能体服务的校验与删除限制，与应用装配顺序一致。
  let agents!: AgentService;
  const tasks = new TaskService({ repository: store.tasks, runs: store.taskRuns, requireProject: () => {}, requireAgent: (id) => agents.requireExecutable(id) });
  agents = new AgentService({
    repository: store.agents, modelSettings: { getSnapshot: async () => current },
    usage: (id) => tasks.list({ agentId: id, viewStatus: 'unfinished', limit: 1 }).total ? '仍有未完成的任务使用这个智能体。' : null,
  });
  return { store, tasks, agents, setSnapshot: (next: ModelSettingsSnapshot) => { current = next; } };
}

test('任务绑定执行智能体：缺省通用执行、旧记录兼容、校验与按智能体筛选', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-agent-'));
  const { store, tasks, agents } = services(root);
  try {
    const reviewer = (await agents.create({ commandId: 'agent', name: '代码审查', modelProfileId: 'model-a', thinkingLevel: 'high', instructions: '先列风险。' })).agent;

    const plain = tasks.create({ commandId: 'plain', title: '默认', goal: '整理' }).task;
    assert.equal(plain.agentId, DEFAULT_AGENT_ID);
    // 显式选择通用执行与缺省等价，同一命令可以重放，保持升级前创建命令的重放指纹。
    assert.deepEqual(tasks.create({ commandId: 'plain', title: '默认', goal: '整理', agentId: DEFAULT_AGENT_ID }).task, plain);
    const bound = tasks.create({ commandId: 'bound', title: '审查', goal: '审查改动', agentId: reviewer.agentId }).task;
    assert.equal(bound.agentId, reviewer.agentId);
    assert.throws(() => tasks.create({ commandId: 'bound', title: '审查', goal: '审查改动' }), /同一个命令 ID/);

    assert.throws(() => tasks.create({ commandId: 'coord', title: '协调', goal: '协调', agentId: COORDINATOR_AGENT_ID }), /固定配置/);
    assert.throws(() => tasks.create({ commandId: 'missing', title: '缺失', goal: '缺失', agentId: 'missing-agent' }), /不存在/);
    assert.throws(() => tasks.preview({ title: '预览', goal: '预览', agentId: COORDINATOR_AGENT_ID }), /固定配置/);

    // 升级前的任务记录没有 agentId，按通用执行计入筛选。
    const legacy: Task = { ...plain, taskId: 'legacy-task', title: '旧任务' };
    delete legacy.agentId;
    store.tasks.save(legacy, null);
    const generalIds = tasks.list({ agentId: DEFAULT_AGENT_ID, limit: 10 }).tasks.map((task) => task.taskId).sort();
    assert.deepEqual(generalIds, ['legacy-task', plain.taskId].sort());
    assert.deepEqual(tasks.list({ agentId: reviewer.agentId, limit: 10 }).tasks.map((task) => task.taskId), [bound.taskId]);

    // 首次执行前可以更换智能体；更换为固定配置被拒绝。
    const switched = tasks.update(plain.taskId, { commandId: 'switch', revision: plain.revision, patch: { agentId: reviewer.agentId } }).task;
    assert.equal(switched.agentId, reviewer.agentId);
    assert.throws(() => tasks.update(plain.taskId, { commandId: 'switch-coord', revision: switched.revision, patch: { agentId: COORDINATOR_AGENT_ID } }), /固定配置/);

    // 未结束的任务仍引用时不能删除智能体。
    assert.throws(() => agents.remove(reviewer.agentId, { commandId: 'delete', revision: reviewer.revision }), /未完成的任务/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('启动前核对智能体模型，运行记录保存选定的智能体，已执行的任务不能更换智能体', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-agent-exec-'));
  const { store, tasks, agents, setSnapshot } = services(root);
  const execution = new TaskExecutionService({
    tasks, runs: store.taskRuns, events: new AssistantEventStream(),
    prepare: async () => { throw new Error('测试不准备目录'); },
    createSession: async () => {}, runtime: () => { throw new Error('尚无会话'); },
    admitAgent: async (id) => { await agents.admit(id); },
  });
  try {
    const offline = (await agents.create({ commandId: 'agent', name: '离线模型', modelProfileId: 'model-off' })).agent;
    const task = tasks.create({ commandId: 'task', title: '执行', goal: '整理', agentId: offline.agentId }).task;

    // 模型在保存后变为不可用：启动被拒绝，任务保持未执行，没有运行记录。
    const broken = snapshot();
    broken.availability[1] = { ...broken.availability[1]!, available: false, message: '认证已失效。' };
    setSnapshot(broken);
    await assert.rejects(execution.control(task.taskId, { commandId: 'start-blocked', revision: task.revision, action: 'start' }), /模型待核对：认证已失效/);
    assert.equal(tasks.get(task.taskId).status, 'idle');
    assert.equal(store.taskRuns.list(task.taskId).length, 0);

    setSnapshot(snapshot());
    await execution.control(task.taskId, { commandId: 'start', revision: task.revision, action: 'start' });
    const run = store.taskRuns.list(task.taskId)[0]!;
    assert.equal(run.agentId, offline.agentId);
    // 已受理的启动命令重放时不再核对模型，按原结果返回。
    setSnapshot(broken);
    await execution.control(task.taskId, { commandId: 'start', revision: task.revision, action: 'start' });

    const latest = tasks.get(task.taskId);
    assert.throws(() => tasks.update(task.taskId, { commandId: 'switch', revision: latest.revision, patch: { agentId: DEFAULT_AGENT_ID } }), /不能更换执行智能体/);
  } finally {
    execution.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('执行约定按智能体指令、项目默认约束、AGENTS.md 的顺序并列，空的部分省略', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-conventions-'));
  try {
    assert.equal(renderTaskConventions({ agentName: '通用执行', instructions: '  ', projectConstraints: '', agentsFile: null }), '');

    await writeFile(join(root, 'AGENTS.md'), '# 仓库约定\n提交前运行测试。\n');
    const text = renderTaskConventions({
      agentName: '代码审查', instructions: '先列风险。', projectConstraints: '只改 docs 目录。',
      agentsFile: readWorkingDirectoryAgentsFile(root),
    });
    const order = ['## 本任务的执行约定', '### 执行智能体「代码审查」的指令\n先列风险。', '### 项目默认约束\n只改 docs 目录。', '### 工作目录的 AGENTS.md\n# 仓库约定\n提交前运行测试。'];
    const positions = order.map((part) => text.indexOf(part));
    assert.ok(positions.every((position) => position >= 0), text);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    assert.match(text, /不扩大工具、目录与授权边界/);

    const onlyProject = renderTaskConventions({ agentName: '通用执行', instructions: '', projectConstraints: '只读。', agentsFile: null });
    assert.doesNotMatch(onlyProject, /执行智能体|AGENTS\.md/);

    // 超长文件截断并注明；链接与目录不读取。
    const large = join(root, 'large');
    await mkdir(large);
    await writeFile(join(large, 'AGENTS.md'), '约'.repeat(TASK_AGENTS_FILE_MAX_BYTES));
    const truncated = readWorkingDirectoryAgentsFile(large)!;
    assert.equal(truncated.truncated, true);
    assert.ok(Buffer.byteLength(truncated.content) <= TASK_AGENTS_FILE_MAX_BYTES);
    assert.doesNotMatch(truncated.content, /\uFFFD/);
    assert.match(renderTaskConventions({ agentName: 'x', instructions: '', projectConstraints: '', agentsFile: truncated }), /以上为开头部分/);

    const linked = join(root, 'linked');
    await mkdir(linked);
    await symlink(join(root, 'AGENTS.md'), join(linked, 'AGENTS.md'));
    assert.equal(readWorkingDirectoryAgentsFile(linked), null);
    assert.equal(readWorkingDirectoryAgentsFile(join(root, 'absent')), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
