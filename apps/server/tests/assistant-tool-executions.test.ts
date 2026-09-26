import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { CoordinatorRuntimeConfig } from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import type { AppendAssistantPublicEventInput } from '../src/modules/sessions/assistant-turn.js';
import { toolExecutionDetail, toolExecutionView } from '../src/application/assistant-tool-executions.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantCommandRepository,
  SqliteAssistantEventRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
} from '../src/storage/sqlite-assistant-store.js';

const AT = '2026-09-18T08:00:00.000Z';
const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是 Multivac。',
  authorizedContext: [],
  model: { provider: 'fake', modelId: 'fake', thinkingLevel: 'off' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

function toolEvent(
  type: 'assistant.tool.started' | 'assistant.tool.ended',
  data: Record<string, unknown>,
  commandId: string | null = 'command-1',
): AppendAssistantPublicEventInput {
  return {
    sourceKey: `${type}:${JSON.stringify(data)}`,
    assistantSessionId: 'global-coordinator',
    commandId,
    type,
    data: data as AppendAssistantPublicEventInput['data'],
    occurredAt: AT,
  };
}

function runEvent(
  type: 'assistant.run.processing' | 'assistant.thinking.delta' |
    'assistant.run.succeeded' | 'assistant.run.failed' | 'assistant.run.cancelled',
  data: Record<string, unknown>,
): AppendAssistantPublicEventInput {
  return {
    sourceKey: `${type}:${JSON.stringify(data)}`,
    assistantSessionId: 'global-coordinator',
    commandId: 'command-1',
    type,
    data: data as AppendAssistantPublicEventInput['data'],
    occurredAt: AT,
  };
}

async function withStore(
  run: (
    store: SqliteAssistantStore,
    repository: SqliteAssistantEventRepository,
  ) => void | Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'multivac-tool-executions-'));
  const store = new SqliteAssistantStore(join(root, 'data.sqlite'));
  try {
    store.insertIfAbsent({
      assistantSessionId: 'global-coordinator',
      piSessionId: 'pi-1',
      piSessionPath: '/tmp/pi-1.jsonl',
      updatedAt: AT,
    });
    // 事件投影对命令回执有外键约束；工具事件必须归属一条已登记的命令。
    new SqliteAssistantCommandRepository(store).createAccepted({
      commandId: 'command-1',
      assistantSessionId: 'global-coordinator',
      kind: 'send',
      payloadFingerprint: 'fingerprint-1',
      piSessionId: 'pi-1',
    });
    await run(store, new SqliteAssistantEventRepository(store));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('工具开始与结束事件归并为一条执行记录并保留事件水位', async () => {
  await withStore((_store, repository) => {
    repository.append(toolEvent('assistant.tool.started', {
      toolCallId: 'tool-1', toolName: 'bash', inputText: 'command: npm test', inputTruncated: false,
    }));
    const ended = repository.append(toolEvent('assistant.tool.ended', {
      toolCallId: 'tool-1', toolName: 'bash', isError: false, outputText: '18 passed',
    }));
    assert.equal(JSON.stringify(ended).includes('18 passed'), false);

    const projections = repository.toolExecutionProjections('global-coordinator', 10);
    assert.equal(projections.length, 1);
    const view = toolExecutionView(projections[0]!);
    assert.equal(view.toolCallId, 'tool-1');
    assert.equal(view.commandId, 'command-1');
    assert.equal(view.status, 'succeeded');
    assert.equal(view.displayName, '执行命令');
    assert.equal(view.summary, '执行命令完成');
    assert.equal(view.detail, '运行 npm test');
    assert.equal(view.startedAt, AT);
    assert.equal(view.endedAt, AT);
    assert.equal(Number(view.cursor), Number(repository.latestCursor()));
  });
});

test('未结束的工具记录保持进行中，失败记录标记失败', async () => {
  await withStore((_store, repository) => {
    repository.append(toolEvent('assistant.tool.started', {
      toolCallId: 'tool-running', toolName: 'read', inputText: 'path: a.ts', inputTruncated: false,
    }));
    repository.append(toolEvent('assistant.tool.started', {
      toolCallId: 'tool-failed', toolName: 'edit', inputText: 'path: b.ts', inputTruncated: false,
    }));
    repository.append(toolEvent('assistant.tool.ended', {
      toolCallId: 'tool-failed', toolName: 'edit', isError: true, outputText: '未找到匹配文本',
    }));

    const views = repository.toolExecutionProjections('global-coordinator', 10).map(toolExecutionView);
    assert.deepEqual(views.map((view) => [view.toolCallId, view.status]), [
      ['tool-running', 'running'],
      ['tool-failed', 'failed'],
    ]);
    assert.equal(views[0]?.endedAt, null);
    assert.equal(views[0]?.summary, '正在读取文件');
    assert.equal(views[1]?.summary, '修改文件失败');
  });
});

test('执行明细只保留最多 1 KiB 输入，拒绝保存工具输出', async () => {
  await withStore((_store, repository) => {
    const long = '中'.repeat(1_000);
    repository.append(toolEvent('assistant.tool.started', {
      toolCallId: 'tool-long', toolName: 'bash', inputText: long, inputTruncated: false,
    }));
    repository.append(toolEvent('assistant.tool.ended', {
      toolCallId: 'tool-long', toolName: 'bash', isError: false, outputText: long,
    }));

    const projection = repository.toolExecutionProjection('global-coordinator', 'tool-long');
    assert.ok(projection);
    const detail = toolExecutionDetail(projection);
    assert.equal(detail.inputTruncated, true);
    assert.equal(Buffer.byteLength(detail.inputText, 'utf8') <= 1024, true);
    assert.equal(detail.inputText.includes('\uFFFD'), false);
    assert.equal('outputText' in detail, false);
    const stored = repository.listAfter('0');
    assert.equal(JSON.stringify(stored).includes(long), false);
    assert.equal(JSON.stringify(stored).includes('outputText'), false);

    assert.equal(repository.toolExecutionProjection('global-coordinator', 'missing'), undefined);
  });
});

test('工具列表与会话快照保留最新 50 条，并可向前分页读取旧记录', async () => {
  await withStore(async (store, repository) => {
    for (let index = 1; index <= 52; index += 1) {
      repository.append(toolEvent('assistant.tool.started', {
        toolCallId: `tool-${index}`, toolName: 'bash',
        inputText: `command: echo ${index}`, inputTruncated: false,
      }));
      repository.append(toolEvent('assistant.tool.ended', {
        toolCallId: `tool-${index}`, toolName: 'bash', isError: false,
      }));
    }

    const latest = repository.toolExecutionProjections('global-coordinator', 50);
    assert.equal(latest.length, 50);
    assert.deepEqual(
      [latest[0]?.toolCallId, latest.at(-1)?.toolCallId],
      ['tool-3', 'tool-52'],
    );

    const service = new AssistantSessionService({
      adapter: new FakeCoordinatorAdapter(),
      bindingRepository: new SqliteAssistantBindingRepository(store),
      pageStateRepository: new SqliteAssistantPageStateRepository(store),
      eventRepository: repository,
      commandRepository: new SqliteAssistantCommandRepository(store),
      runtimeConfig: config,
    });
    const page = await service.getSessionPage({ limit: 30 });
    assert.equal(page.toolExecutions?.length, 50);
    assert.deepEqual(
      [page.toolExecutions?.[0]?.toolCallId, page.toolExecutions?.at(-1)?.toolCallId],
      ['tool-3', 'tool-52'],
    );

    const first = await service.listToolExecutions({ limit: 50 });
    assert.equal(first.tools.length, 50);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextBefore, first.tools[0]?.cursor);
    assert.deepEqual(
      [first.tools[0]?.toolCallId, first.tools.at(-1)?.toolCallId],
      ['tool-3', 'tool-52'],
    );

    const earlier = await service.listToolExecutions({ before: first.nextBefore!, limit: 50 });
    assert.deepEqual(earlier.tools.map((tool) => tool.toolCallId), ['tool-1', 'tool-2']);
    assert.equal(earlier.hasMore, false);
    assert.equal(earlier.nextBefore, null);
  });
});

test('thinking 增量持久化为可恢复 Trace，并按总上限截断', async () => {
  await withStore(async (store, repository) => {
    repository.append(runEvent('assistant.run.processing', {}));
    repository.append(runEvent('assistant.thinking.delta', {
      piSessionId: 'pi-1', messageId: 'assistant:1',
      delta: '正在检查分页。', deltaTruncated: false,
    }));
    repository.append(toolEvent('assistant.tool.started', {
      toolCallId: 'tool-between-thoughts', toolName: 'read',
      inputText: 'path: page.ts', inputTruncated: false,
    }));
    for (let index = 0; index < 9; index += 1) {
      repository.append(runEvent('assistant.thinking.delta', {
        piSessionId: 'pi-1', messageId: 'assistant:1',
        delta: `${index}:` + '中'.repeat(1_400), deltaTruncated: false,
      }));
    }
    repository.append(runEvent('assistant.run.succeeded', {}));

    const traces = repository.runTraceProjections('global-coordinator', 10);
    assert.equal(traces.length, 1);
    assert.equal(traces[0]?.status, 'succeeded');
    assert.equal(traces[0]?.entries[0]?.kind, 'thinking');
    assert.equal(
      traces[0]?.entries[0]?.kind === 'thinking' &&
        traces[0].entries[0].text.startsWith('正在检查分页。'),
      true,
    );
    assert.equal(traces[0]?.thinkingTruncated, true);
    assert.deepEqual(traces[0]?.entries.map((entry) => entry.kind), [
      'thinking', 'tool', 'thinking',
    ]);
    const thinkingText = traces[0]?.entries.flatMap((entry) =>
      entry.kind === 'thinking' ? [entry.text] : []).join('') ?? '';
    assert.equal(Buffer.byteLength(thinkingText, 'utf8') <= 32 * 1024, true);

    const service = new AssistantSessionService({
      adapter: new FakeCoordinatorAdapter(),
      bindingRepository: new SqliteAssistantBindingRepository(store),
      pageStateRepository: new SqliteAssistantPageStateRepository(store),
      eventRepository: repository,
      commandRepository: new SqliteAssistantCommandRepository(store),
      runtimeConfig: config,
    });
    const page = await service.getSessionPage({ limit: 30 });
    assert.deepEqual(page.runTraces?.[0]?.entries, traces[0]?.entries);
    assert.equal(page.runTraces?.[0]?.thinkingTruncated, true);
  });
});

test('升级旧数据库时清除工具输出并截断旧输入，重放也不包含输出', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-tool-migration-'));
  const databasePath = join(root, 'data.sqlite');
  try {
    const store = new SqliteAssistantStore(databasePath);
    store.insertIfAbsent({
      assistantSessionId: 'global-coordinator', piSessionId: 'pi-1',
      piSessionPath: '/tmp/pi-1.jsonl', updatedAt: AT,
    });
    const repository = new SqliteAssistantEventRepository(store);
    repository.append(toolEvent('assistant.tool.started', {
      toolCallId: 'legacy', toolName: 'bash', inputText: 'short', inputTruncated: false,
    }, null));
    repository.append(toolEvent('assistant.tool.ended', {
      toolCallId: 'legacy', toolName: 'bash', isError: false,
    }, null));
    store.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.prepare(`UPDATE assistant_event_projection SET payload_json = json_set(
      payload_json, '$.inputText', ?, '$.inputTruncated', json('false'))
      WHERE event_type = 'assistant.tool.started'`).run('中'.repeat(400));
    legacy.prepare(`UPDATE assistant_event_projection SET payload_json = json_set(
      payload_json, '$.outputText', ?)
      WHERE event_type = 'assistant.tool.ended'`).run('private-legacy-output');
    // 回到 v6：版本 7 之后的迁移产物也要一并回滚，否则重放会撞上已存在的列。
    legacy.exec('DELETE FROM schema_migrations WHERE version >= 7');
    legacy.exec('ALTER TABLE assistant_page_state DROP COLUMN quote_json');
    legacy.close();

    const upgraded = new SqliteAssistantStore(databasePath);
    const replay = new SqliteAssistantEventRepository(upgraded).listAfter('0');
    assert.equal(JSON.stringify(replay).includes('private-legacy-output'), false);
    assert.equal(JSON.stringify(replay).includes('outputText'), false);
    const detail = upgraded.toolExecutionProjection('global-coordinator', 'legacy');
    assert.ok(detail);
    assert.equal(detail.inputTruncated, true);
    assert.equal(Buffer.byteLength(detail.inputText ?? '', 'utf8') <= 1024, true);
    upgraded.close();

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    const rows = inspection.prepare(`SELECT payload_json FROM assistant_event_projection
      WHERE event_type IN ('assistant.tool.started', 'assistant.tool.ended')`).all() as Array<{ payload_json: string }>;
    inspection.close();
    assert.equal(JSON.stringify(rows).includes('private-legacy-output'), false);
    assert.equal(JSON.stringify(rows).includes('outputText'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
