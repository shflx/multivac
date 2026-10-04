import assert from 'node:assert/strict';
import test from 'node:test';
import { GLOBAL_ASSISTANT_SESSION_ID, UNKNOWN_CHANGE_ORIGIN, type ProcessPreview } from '@multivac/contracts';
import { InternalToolService, MULTIVAC_INTERNAL_TOOLS, WORK_SESSION_TASK_TOOLS, type InternalToolServices } from '../src/application/internal-tools/index.js';
import { SqliteAssistantStore, SqliteInternalToolCallRepository } from '../src/storage/sqlite-assistant-store.js';
import { stopProcessKind } from '../src/application/proposals/process-proposals.js';

test('全局对话查询只提供白名单，不给工作会话停止、日志或启动能力', async () => {
  const store = new SqliteAssistantStore(':memory:');
  const services = { processQueries: { list: () => [], logs: async () => ({ text: 'data\n', cursor: 5, truncated: false, available: true, unchanged: false }) } } as unknown as InternalToolServices;
  const calls = new SqliteInternalToolCallRepository(store);
  const global = new InternalToolService({ tools: MULTIVAC_INTERNAL_TOOLS, services, calls, currentTurn: () => ({ commandId: 'turn', windowId: null }) });
  const work = new InternalToolService({ tools: WORK_SESSION_TASK_TOOLS, services, calls, currentTurn: () => ({ commandId: 'turn', windowId: null }) });
  try {
    const result = await global.invoke({ assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, toolName: 'list_managed_processes', toolCallId: 'query', args: {} }, new AbortController().signal);
    assert.equal(result.ok, true);
    const forbidden = await work.invoke({ assistantSessionId: 'work-session', toolName: 'read_managed_process_log', toolCallId: 'read', args: { processId: 'p' } }, new AbortController().signal);
    assert.equal(forbidden.ok, false);
    assert.equal(MULTIVAC_INTERNAL_TOOLS.some((tool) => tool.name === 'start_managed_process'), false);
    assert.equal(WORK_SESSION_TASK_TOOLS.some((tool) => tool.name === 'propose_stop_managed_process'), false);
  } finally { store.close(); }
});

test('停止提议预览不执行，版本改变使确认失效；执行使用同一稳定命令', async () => {
  let revision = 1;
  const commands: string[] = [];
  const preview = () => ({ process: { processId: 'p', name: '服务', revision }, taskRevision: 2, needsConfirmation: true, impact: '影响任务' }) as ProcessPreview;
  const kind = stopProcessKind({ preview, stop: async (_id, input) => { commands.push(input.commandId); return preview().process; } });
  const payload = { processId: 'p' };
  const prepared = await kind.prepare(payload);
  assert.equal(commands.length, 0);
  assert.equal(await kind.revalidate(payload, prepared.preview, undefined), null);
  revision++;
  assert.match((await kind.revalidate(payload, prepared.preview, undefined))!, /变化/);
  const current = await kind.prepare(payload);
  await kind.execute(payload, current.preview, UNKNOWN_CHANGE_ORIGIN, undefined);
  await kind.execute(payload, current.preview, UNKNOWN_CHANGE_ORIGIN, undefined);
  assert.equal(commands[0], commands[1]);
});
