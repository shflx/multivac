import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import type { ContinueCoordinatorSessionInput } from '../src/runtime/executors/coordinator-adapter.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { resolveMultivacDataPaths } from '../src/storage/data-paths.js';

class RepairableAdapter extends FakeCoordinatorAdapter {
  repaired = false;
  override async continueSession(input: ContinueCoordinatorSessionInput) {
    return this.repaired ? super.continueSession(input) : { ok: false as const,
      error: { code: 'SESSION_OPEN_FAILED' as const, message: 'injected initial recovery failure' } };
  }
}

test('真实 bootstrap 首次恢复失败，修复后旧回执一次性中断；后续 select/send 不永久占用或误终结新命令', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-bootstrap-reconcile-'));
  const paths = resolveMultivacDataPaths(root);
  const setup = new SqliteAssistantStore(paths.databasePath);
  setup.insertIfAbsent({ assistantSessionId: 'global-coordinator', piSessionId: 'pi-fake-global-coordinator',
    piSessionPath: join(paths.assistantSessionDir, 'pi-fake-global-coordinator.jsonl'), updatedAt: '2026-09-17T00:00:00.000Z',
    modelSource: 'base', modelProvider: 'fixture', modelId: 'gpt-fixture', modelProtocol: 'openai-responses',
    modelEndpoint: 'https://fixture.example/v1', modelResolvedEndpoint: 'https://fixture.example/v1' });
  for (const [commandId, phase] of [['old-accepted', 'accepted'], ['old-handed', 'handed'], ['old-running', 'running']] as const) {
    setup.createAccepted({ commandId, assistantSessionId: 'global-coordinator', kind: 'send', payloadFingerprint: commandId,
      piSessionId: 'pi-fake-global-coordinator' });
    if (phase !== 'accepted') setup.markHandedToPi(commandId, 'prompt');
    if (phase === 'running') setup.markRunning(commandId, 'old-turn');
  }
  setup.close();
  const adapter = new RepairableAdapter({ sessionPathRoot: paths.assistantSessionDir });
  const app = createMultivacApplication({ MULTIVAC_DATA_DIR: root, MULTIVAC_FAKE_ASSISTANT: '1' }, { coordinatorAdapter: adapter });
  await app.ready;
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const inspection = new SqliteAssistantStore(paths.databasePath);
  try {
    assert.equal((await fetch(`${base}/api/assistant/page-state`)).status, 503);
    assert.equal(inspection.listNonTerminal('global-coordinator').length, 3);
    adapter.repaired = true;
    assert.equal((await fetch(`${base}/api/assistant/page-state`)).status, 200);
    for (const id of ['old-accepted', 'old-handed', 'old-running']) {
      assert.equal(inspection.getCommand(id)?.error?.code, 'COMMAND_INTERRUPTED');
      assert.equal(inspection.getCommand(id)?.status, 'terminal');
    }
    assert.equal(adapter.calls.some((call) => call.method === 'prompt'), false);
    const options = await (await fetch(`${base}/api/assistant/model-selection`)).json();
    assert.equal(options.running, false);
    const changed = await fetch(`${base}/api/assistant/model-selection/model`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'after-repair-model', sessionId: 'global-coordinator', revision: options.selection.revision, profileId: 'fixture-openai' }) });
    assert.equal(changed.status, 200, await changed.text());
    adapter.armPromptCompletionBarrier();
    const sent = fetch(`${base}/api/assistant/turns`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'new-live-send', assistantSessionId: 'global-coordinator', text: 'new command stays live', contextRefs: [] }) });
    await adapter.waitForPromptCompletionBarrierEntry();
    // 再次初始化/读取不能扫描并终结本进程已发出的新命令。
    assert.equal((await fetch(`${base}/api/assistant/page-state`)).status, 200);
    assert.equal((await (await fetch(`${base}/api/assistant/model-selection`)).json()).running, true);
    assert.notEqual(inspection.getCommand('new-live-send')?.status, 'terminal');
    assert.equal(inspection.getCommand('new-live-send')?.error, null);
    adapter.releasePromptCompletionBarrier();
    assert.equal((await (await sent).json()).terminalOutcome, 'succeeded');
    assert.equal(adapter.calls.filter((call) => call.method === 'prompt').length, 1);
    const final = await (await fetch(`${base}/api/assistant/model-selection`)).json();
    assert.equal(final.running, false);
    const another = await fetch(`${base}/api/assistant/model-selection/model`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'second-model-after-repair', sessionId: 'global-coordinator', revision: final.selection.revision, profileId: 'fixture-anthropic' }) });
    assert.equal(another.status, 200);
    assert.equal(inspection.listAfter('0').filter((event) => event.type === 'assistant.command.reconciled' &&
      event.commandId?.startsWith('old-')).length, 3);
  } finally {
    adapter.releasePromptCompletionBarrier();
    inspection.close();
    await new Promise<void>((done) => app.server.close(() => done()));
    app.close(); await rm(root, { recursive: true, force: true });
  }
});
