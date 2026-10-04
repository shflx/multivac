import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import {
  AssistantToolResultSchema,
  GLOBAL_ASSISTANT_SESSION_ID,
  INTERNAL_TOOL_DISPLAY,
  type Workspace,
} from '@multivac/contracts';
import {
  defineInternalTool,
  InternalToolService,
  MULTIVAC_INTERNAL_TOOLS,
  type InternalToolCallContext,
  type InternalToolDefinition,
  type InternalToolServices,
} from '../src/application/internal-tools/index.js';
import {
  internalToolCommandId,
  InternalToolError,
  renderInternalToolsPrompt,
  type InternalToolCallRepository,
} from '../src/modules/internal-tools/internal-tool.js';
import { parseScriptedInternalToolCalls } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { SqliteAssistantStore, SqliteInternalToolCallRepository } from '../src/storage/sqlite-assistant-store.js';

/**
 * 内部工具框架：注册表校验、参数校验与中文原因、幂等账本（重放、并发、冲突、重启后的未知结果）、
 * 提议类工具的约束、提示词自动生成，以及示例工具 list_workspaces。
 */

const SESSION = GLOBAL_ASSISTANT_SESSION_ID;

function workspace(workspaceId: string, name: string, project = true): Workspace {
  return {
    workspaceId,
    name,
    project: project ? {
      projectId: workspaceId, name, defaultConstraints: '', createdAt: 't', updatedAt: 't',
      directories: [{ kind: 'mounted', path: `/code/${workspaceId}` }],
    } : null,
  };
}

function services(workspaces: Workspace[] = [workspace('default', '默认工作区', false)]): InternalToolServices {
  return {
    projects: {
      listWorkspaces: () => ({ workspaces }),
      listProjects: () => ({ projects: workspaces.flatMap((item) => item.project ? [item.project] : []) }),
    },
    sessions: {
      get: () => { throw new Error('本测试不读取单个会话。'); },
      isRunning: () => false,
      getScene: () => { throw new Error('本测试不读取现场。'); },
      list: () => ({
        workspaceId: null,
        sessions: [
          { sessionId: 'a', title: 'A', kind: 'work', workspaceId: 'p1', createdAt: 't', archivedAt: null,
            parentSessionId: null, originText: null, workingDirectory: { kind: 'project-mounted', path: '/code/p1' } },
          { sessionId: 'b', title: 'B', kind: 'work', workspaceId: 'p1', createdAt: 't', archivedAt: null,
            parentSessionId: null, originText: null, workingDirectory: { kind: 'project-mounted', path: '/code/p1' } },
        ],
      }),
    },
    transcripts: { readMessages: () => [] },
  };
}

/** 测试用的内部工具展示口径：登记在契约表中，结束时移除。 */
function withDisplay(names: string[]): () => void {
  const table = INTERNAL_TOOL_DISPLAY as Record<string, { displayName: string }>;
  for (const name of names) table[name] = { displayName: `测试工具 ${name}` };
  return () => { for (const name of names) delete table[name]; };
}

async function withLedger<T>(run: (calls: InternalToolCallRepository, reopen: () => InternalToolCallRepository) => Promise<T>) {
  const root = await mkdtemp(join(tmpdir(), 'multivac-internal-tools-'));
  const path = join(root, 'multivac.sqlite');
  const stores = [new SqliteAssistantStore(path)];
  try {
    return await run(new SqliteInternalToolCallRepository(stores[0]!), () => {
      stores.push(new SqliteAssistantStore(path));
      return new SqliteInternalToolCallRepository(stores.at(-1)!);
    });
  } finally {
    for (const store of stores) store.close();
    await rm(root, { recursive: true, force: true });
  }
}

const signal = () => new AbortController().signal;

test('注册表拒绝不合法的定义：非法名称、与 Pi 内置工具重名、重复、缺少契约展示口径', () => {
  const restore = withDisplay(['sample_tool']);
  try {
    const tool = (name: string) => defineInternalTool({
      name, effect: 'query', description: '示例', parameters: Type.Object({}),
      execute: async () => ({ content: '', result: { summary: '完成', refs: [] } }),
    });
    const create = (tools: InternalToolDefinition[]) => new InternalToolService({
      tools, services: services(), calls: {} as InternalToolCallRepository, currentTurn: () => null,
    });
    assert.throws(() => create([tool('Sample-Tool')]), /不合法/u);
    assert.throws(() => create([tool('bash')]), /内置工具重名/u);
    assert.throws(() => create([tool('grep')]), /内置工具重名/u);
    assert.throws(() => create([tool('sample_tool'), tool('sample_tool')]), /重复注册/u);
    assert.throws(() => create([tool('unlisted_tool')]), /展示口径/u);
    assert.deepEqual(create([tool('sample_tool')]).specs.map((spec) => spec.name), ['sample_tool']);
  } finally {
    restore();
  }
});

test('注册的内部工具都有展示口径；提示词由注册的工具生成，写明三类规则与“扩大权限只能提议”', () => {
  const service = new InternalToolService({
    tools: MULTIVAC_INTERNAL_TOOLS, services: services(), calls: {} as InternalToolCallRepository,
    currentTurn: () => null,
  });
  assert.deepEqual(service.specs.map((spec) => [spec.name, spec.effect]), [
    ['list_books', 'query'], ['get_book', 'query'], ['open_book', 'manage'],
    ['list_runs', 'query'], ['list_managed_processes', 'query'], ['read_managed_process_log', 'query'], ['propose_stop_managed_process', 'propose'],
    ['list_tasks', 'query'], ['get_task', 'query'], ['list_task_groups', 'query'],
    ['confirm_human_task', 'manage'], ['create_task', 'manage'], ['propose_create_task', 'propose'], ['update_task', 'manage'], ['control_task', 'manage'], ['delete_task', 'manage'], ['create_task_group', 'manage'],
    ['list_inbox', 'query'], ['get_inbox_request', 'query'], ['respond_inbox_request', 'manage'],
    ['list_task_requests', 'query'], ['get_task_request', 'query'], ['respond_task_request', 'manage'],
    ['list_task_artifacts', 'query'], ['read_task_artifact', 'query'], ['submit_task_artifact', 'manage'],
    ['propose_git_publish', 'propose'],
    ['list_projects', 'query'], ['list_workspaces', 'query'], ['list_sessions', 'query'], ['get_session', 'query'],
    ['get_current_view', 'query'], ['read_session_recent', 'query'],
    ['create_session', 'manage'], ['rename_session', 'manage'], ['archive_session', 'manage'], ['restore_session', 'manage'],
    ['switch_workspace', 'manage'], ['open_session', 'manage'], ['set_parallel_count', 'manage'], ['set_view_mode', 'manage'],
    ['open_management_page', 'manage'], ['rename_project', 'manage'], ['update_project_constraints', 'manage'],
    ['propose_create_project', 'propose'], ['propose_mount_directory', 'propose'], ['propose_unmount_directory', 'propose'],
    ['propose_set_primary_directory', 'propose'], ['propose_move_session_to_project', 'propose'],
  ]);
  // 会改变界面的工具有标记，提示词据此写明只在用户明确要求时调用（Q3）。
  assert.deepEqual(service.specs.filter((spec) => spec.changesView).map((spec) => spec.name), [
    'open_book', 'switch_workspace', 'open_session', 'set_parallel_count', 'set_view_mode', 'open_management_page',
  ]);

  const prompt = renderInternalToolsPrompt(service.specs);
  assert.match(prompt, /会改变用户界面的工具（open_book、switch_workspace、open_session、set_parallel_count、set_view_mode、open_management_page）只在用户明确要求“打开 \/ 切到 \/ 放到”/u);
  assert.match(prompt, /只作用于用户发出这条消息的那个窗口，其他窗口不会被切换/u);
  assert.match(prompt, /同一轮中切换过之后，后续的工具以服务端保存的现场与切换后的界面为准/u);
  assert.doesNotMatch(renderInternalToolsPrompt(service.specs.filter((spec) => !spec.changesView)), /会改变用户界面的工具/u);
  assert.match(prompt, /# Multivac 内部工具/u);
  assert.match(prompt, /直接使用 create_task 连续完成整组创建/u);
  assert.match(prompt, /不要再次询问是否创建，也不要逐项要求确认/u);
  assert.match(prompt, /先创建父任务、前置任务/u);
  assert.match(prompt, /先删后续任务、子任务，再删前置任务、父任务/u);
  assert.match(prompt, /权限授权请求只能在界面处理/u);
  assert.match(prompt, /不能自行编造用户答复或作出验收决定/u);
  assert.match(prompt, /- list_workspaces（查询）：列出工作区/u);
  assert.match(prompt, /- read_session_recent（查询）：读取会话内容/u);
  // 回复中的会话与项目写成对象链接，界面据此渲染可以点开的链接；读到的其他会话内容是数据。
  assert.match(prompt, /\[名称\]\(multivac:\/\/session\/<会话 id>\)/u);
  assert.match(prompt, /包括读到的其他会话的内容/u);
  assert.match(prompt, /- 查询：只读取，直接执行/u);
  assert.match(prompt, /- 管理：按用户意图执行、不扩大权限的业务操作，直接执行。完成后用一句话回执/u);
  assert.match(prompt, /- 提议：扩大权限的操作只生成待用户确认的提议/u);
  assert.match(prompt, /只能由用户在界面的确认卡上确认后执行/u);
  // 项目与归入项目的提议类工具已注册：列出它们，不再说“没有提议工具”。
  assert.doesNotMatch(prompt, /目前没有可以提出这类操作的工具/u);
  assert.match(prompt, /- propose_create_project（提议）：提议新建项目/u);
  assert.match(prompt, /- propose_move_session_to_project（提议）：提议归入项目/u);
  assert.match(prompt, /- rename_project（管理）：项目改名/u);
  assert.match(prompt, /- create_session（管理）：新建会话/u);
  assert.match(prompt, /- archive_session（管理）：归档会话/u);

  // 没有提议类工具时如实说明，不写尚未实现的工具。
  const withoutProposal = renderInternalToolsPrompt(service.specs.filter((spec) => spec.effect !== 'propose'));
  assert.match(withoutProposal, /目前没有可以提出这类操作的工具/u);
  assert.doesNotMatch(withoutProposal, /propose_/u);
});

test('参数按 schema 校验：温和转换后严格检查，失败时给出模型可读的中文原因且不执行', async () => {
  const restore = withDisplay(['sample_query']);
  let executed = 0;
  try {
    const service = new InternalToolService({
      tools: [defineInternalTool({
        name: 'sample_query', effect: 'query', description: '示例',
        parameters: Type.Object({ limit: Type.Integer({ minimum: 1, maximum: 20 }), title: Type.String() },
          { additionalProperties: false }),
        execute: async (params) => {
          executed += 1;
          return { content: `limit=${params.limit}`, result: { summary: '完成', refs: [] } };
        },
      })],
      services: services(), calls: {} as InternalToolCallRepository, currentTurn: () => null,
    });

    assert.deepEqual(service.validate('sample_query', { limit: '3', title: 'x' }), { ok: true, value: { limit: 3, title: 'x' } });
    const missing = service.validate('sample_query', { limit: 3 });
    assert.equal(missing.ok, false);
    assert.match(!missing.ok ? missing.reason : '', /测试工具 sample_query（sample_query）的参数不符合要求：缺少参数 title。调用没有执行/u);
    const extra = service.validate('sample_query', { limit: 3, title: 'x', force: true });
    assert.match(!extra.ok ? extra.reason : '', /不支持参数 force/u);
    const range = service.validate('sample_query', { limit: 99, title: 'x' });
    assert.match(!range.ok ? range.reason : '', /参数 limit 必须 <= 20/u);
    const notObject = service.validate('sample_query', 'limit=3');
    assert.equal(notObject.ok, false);
    const unknown = service.validate('no_such_tool', {});
    assert.match(!unknown.ok ? unknown.reason : '', /没有名为 no_such_tool 的内部工具/u);

    const invalid = await service.invoke(
      { assistantSessionId: SESSION, toolName: 'sample_query', toolCallId: 'c1', args: { limit: 0, title: 'x' } }, signal(),
    );
    assert.equal(invalid.ok, false);
    assert.equal(executed, 0);
    const valid = await service.invoke(
      { assistantSessionId: SESSION, toolName: 'sample_query', toolCallId: 'c2', args: { limit: '2', title: 'x' } }, signal(),
    );
    assert.deepEqual(valid, { ok: true, content: 'limit=2', result: { summary: '完成', refs: [] } });
  } finally {
    restore();
  }
});

test('幂等：同一 toolCallId 重放只执行一次（含并发），结果原样返回；参数不同报冲突；查询不记账本', async () => {
  const restore = withDisplay(['sample_manage', 'sample_query']);
  try {
    await withLedger(async (calls) => {
      const effects: InternalToolCallContext[] = [];
      let queries = 0;
      const service = new InternalToolService({
        tools: [
          defineInternalTool({
            name: 'sample_manage', effect: 'manage', description: '示例',
            parameters: Type.Object({ title: Type.String() }),
            execute: async (params, context) => {
              effects.push(context);
              await new Promise((resolve) => setTimeout(resolve, 10));
              if (params.title === '失败') throw new InternalToolError('标题不能叫“失败”，没有改名。');
              return { content: `已改名为「${params.title}」`, result: { summary: `改名为「${params.title}」`, refs: [] } };
            },
          }),
          defineInternalTool({
            name: 'sample_query', effect: 'query', description: '示例', parameters: Type.Object({}),
            execute: async () => ({ content: String(queries += 1), result: { summary: '完成', refs: [] } }),
          }),
        ],
        services: services(), calls, currentTurn: (sessionId) => ({ commandId: `turn-of-${sessionId}`, windowId: null }),
      });
      const invoke = (toolCallId: string, args: unknown, toolName = 'sample_manage') =>
        service.invoke({ assistantSessionId: SESSION, toolName, toolCallId, args }, signal());

      // 并发的重放等待同一次执行；之后的重放读账本。
      const [first, concurrent] = await Promise.all([invoke('call-1', { title: '周报' }), invoke('call-1', { title: '周报' })]);
      const replay = await invoke('call-1', { title: '周报' });
      assert.deepEqual(first, { ok: true, content: '已改名为「周报」', result: { summary: '改名为「周报」', refs: [] } });
      assert.deepEqual(concurrent, first);
      assert.deepEqual(replay, first);
      assert.equal(effects.length, 1);

      // 执行函数拿到的上下文：派生的命令 id 稳定、与会话和 toolCallId 对应；本轮的发送命令。
      const commandId = internalToolCommandId(SESSION, 'call-1');
      assert.equal(commandId, internalToolCommandId(SESSION, 'call-1'));
      assert.notEqual(commandId, internalToolCommandId(SESSION, 'call-2'));
      assert.notEqual(commandId, internalToolCommandId('other-session', 'call-1'));
      assert.match(commandId, /^[A-Za-z0-9._:-]{1,128}$/u);
      assert.equal(effects[0]!.commandId, commandId);
      assert.equal(effects[0]!.turnCommandId, `turn-of-${SESSION}`);
      assert.equal(effects[0]!.toolCallId, 'call-1');
      assert.deepEqual(calls.get(commandId), {
        commandId, sessionId: SESSION, toolCallId: 'call-1', toolName: 'sample_manage', effect: 'manage',
        argumentsFingerprint: calls.get(commandId)!.argumentsFingerprint, status: 'succeeded', outcome: first,
        createdAt: calls.get(commandId)!.createdAt, updatedAt: calls.get(commandId)!.updatedAt,
      });

      // 同一 id、不同参数：不当作重放，也不执行。
      const conflict = await invoke('call-1', { title: '月报' });
      assert.equal(conflict.ok, false);
      assert.match(!conflict.ok ? conflict.reason : '', /调用 id 与之前的一次调用相同但内容不同/u);
      assert.equal(effects.length, 1);

      // 失败同样记账本，重放返回同一原因。
      const failed = await invoke('call-2', { title: '失败' });
      assert.deepEqual(failed, { ok: false, reason: '标题不能叫“失败”，没有改名。' });
      assert.deepEqual(await invoke('call-2', { title: '失败' }), failed);
      assert.equal(effects.length, 2);
      assert.equal(calls.get(internalToolCommandId(SESSION, 'call-2'))!.status, 'failed');

      // 查询没有副作用：每次都执行，不写账本。
      assert.deepEqual(await invoke('q-1', {}, 'sample_query'), { ok: true, content: '1', result: { summary: '完成', refs: [] } });
      assert.deepEqual(await invoke('q-1', {}, 'sample_query'), { ok: true, content: '2', result: { summary: '完成', refs: [] } });
      assert.equal(calls.get(internalToolCommandId(SESSION, 'q-1')), undefined);
    });
  } finally {
    restore();
  }
});

test('恢复只读对账：重启后账本中已结束的调用返回原结果，开始后结果未知的不再执行；已停止的一轮不执行', async () => {
  const restore = withDisplay(['sample_manage']);
  try {
    await withLedger(async (calls, reopen) => {
      let executed = 0;
      const tool = defineInternalTool({
        name: 'sample_manage', effect: 'manage', description: '示例', parameters: Type.Object({}),
        execute: async () => {
          executed += 1;
          return { content: '已完成', result: { summary: '已完成', refs: [] } };
        },
      });
      const create = (repository: InternalToolCallRepository) => new InternalToolService({
        tools: [tool], services: services(), calls: repository, currentTurn: () => null,
      });
      const invoke = (service: InternalToolService, toolCallId: string, abort?: AbortSignal) =>
        service.invoke({ assistantSessionId: SESSION, toolName: 'sample_manage', toolCallId, args: {} }, abort ?? signal());

      const done = await invoke(create(calls), 'done');
      // 模拟上一进程开始执行后退出：只写入了 running。
      calls.begin({
        commandId: internalToolCommandId(SESSION, 'interrupted'), sessionId: SESSION, toolCallId: 'interrupted',
        toolName: 'sample_manage', effect: 'manage',
        argumentsFingerprint: calls.get(internalToolCommandId(SESSION, 'done'))!.argumentsFingerprint,
        createdAt: new Date().toISOString(),
      });

      const restarted = create(reopen());
      assert.deepEqual(await invoke(restarted, 'done'), done);
      const unknown = await invoke(restarted, 'interrupted');
      assert.equal(unknown.ok, false);
      assert.match(!unknown.ok ? unknown.reason : '', /已在服务重启前开始执行，结果未知；为避免重复执行，没有再次执行/u);
      assert.equal(executed, 1);

      const controller = new AbortController();
      controller.abort();
      assert.deepEqual(await invoke(restarted, 'aborted', controller.signal), { ok: false, reason: '本轮已停止，调用没有执行。' });
      assert.equal(executed, 1);
    });
  } finally {
    restore();
  }
});

test('提议类工具只能经 propose 生成提议：确认卡未接入时明确报告尚不支持；执行异常转成通用原因', async () => {
  const restore = withDisplay(['sample_proposal', 'sample_broken']);
  try {
    await withLedger(async (calls) => {
      const tools = [
        defineInternalTool({
          name: 'sample_proposal', effect: 'propose', description: '示例', parameters: Type.Object({ name: Type.String() }),
          execute: async (params, context) => {
            const { proposalId } = await context.propose({ kind: 'sample', payload: params });
            return { content: `已提出（${proposalId}），等待你确认`, result: { summary: '已提出，等待确认', refs: [] } };
          },
        }),
        defineInternalTool({
          name: 'sample_broken', effect: 'manage', description: '示例', parameters: Type.Object({}),
          execute: async () => { throw new Error('SQLITE_BUSY: database is locked'); },
        }),
      ];
      const invoke = (service: InternalToolService, toolName: string, toolCallId: string, args: unknown = {}) =>
        service.invoke({ assistantSessionId: SESSION, toolName, toolCallId, args }, signal());

      const unsupported = new InternalToolService({ tools, services: services(), calls, currentTurn: () => ({ commandId: 'turn-1', windowId: null }) });
      const result = await invoke(unsupported, 'sample_proposal', 'p-1', { name: '研究' });
      assert.equal(result.ok, false);
      assert.match(!result.ok ? result.reason : '', /对话内的确认卡尚未实现，这项扩大权限的操作暂时不能在对话中提出，也没有执行/u);

      const broken = await invoke(unsupported, 'sample_broken', 'b-1');
      assert.deepEqual(broken, { ok: false, reason: '测试工具 sample_broken执行失败，没有完成。可以稍后重试，或请用户在界面中操作。' });

      const submitted: unknown[] = [];
      const withSink = new InternalToolService({
        tools, services: services(), calls, currentTurn: () => ({ commandId: 'turn-2', windowId: null }),
        proposals: { submit: async (proposal, origin) => { submitted.push({ proposal, origin }); return { proposalId: 'card-1' }; } },
      });
      assert.deepEqual(await invoke(withSink, 'sample_proposal', 'p-2', { name: '研究' }), {
        ok: true, content: '已提出（card-1），等待你确认', result: { summary: '已提出，等待确认', refs: [] },
      });
      // 提议同样幂等：重放不再生成第二张卡。
      await invoke(withSink, 'sample_proposal', 'p-2', { name: '研究' });
      assert.deepEqual(submitted, [{
        proposal: { kind: 'sample', payload: { name: '研究' } },
        origin: { sessionId: SESSION, toolCallId: 'p-2', commandId: internalToolCommandId(SESSION, 'p-2'), turnCommandId: 'turn-2', originWindowId: null },
      }]);
    });
  } finally {
    restore();
  }
});

test('示例工具 list_workspaces：按真实数据列出工作区与未归档会话数，公开结果符合契约白名单', async () => {
  const service = new InternalToolService({
    tools: MULTIVAC_INTERNAL_TOOLS,
    services: services([workspace('p1', '研究项目'), workspace('default', '默认工作区', false)]),
    calls: {} as InternalToolCallRepository,
    currentTurn: () => null,
  });
  const outcome = await service.invoke(
    { assistantSessionId: SESSION, toolName: 'list_workspaces', toolCallId: 'l-1', args: {} }, signal(),
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.content, [
    '共 2 个工作区：',
    '- [研究项目](multivac://workspace/p1)（id: p1，项目工作区）：主目录（挂载）/code/p1；2 个未归档会话',
    '- [默认工作区](multivac://workspace/default)（id: default）：不属于项目，其中的会话各自使用临时目录；0 个未归档会话',
  ].join('\n'));
  assert.deepEqual(outcome.result, {
    summary: '共 2 个工作区',
    refs: [
      { kind: 'workspace', workspaceId: 'p1', label: '研究项目' },
      { kind: 'workspace', workspaceId: 'default', label: '默认工作区' },
    ],
  });
  assert.equal(Check(AssistantToolResultSchema, outcome.result), true);
  // 不接受任何参数。
  assert.equal(service.validate('list_workspaces', { workspaceId: 'p1' }).ok, false);
});

test('fake 脚本：每行“内部工具：名称[#id] [JSON]”解析为一次调用', () => {
  assert.deepEqual(parseScriptedInternalToolCalls([
    '请帮我看看',
    '内部工具：list_workspaces',
    '内部工具： list_sessions#fixed-1 {"workspaceId":"p1"}',
    '内部工具：list_sessions {不是 JSON}',
  ].join('\n')), [
    { toolName: 'list_workspaces', args: {} },
    { toolName: 'list_sessions', toolCallId: 'fixed-1', args: { workspaceId: 'p1' } },
    { toolName: 'list_sessions', args: '{不是 JSON}' },
  ]);
  assert.deepEqual(parseScriptedInternalToolCalls('没有脚本'), []);
});
