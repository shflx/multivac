import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GLOBAL_ASSISTANT_SESSION_ID, type Note } from '@multivac/contracts';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { PiModelSettingsCatalogFactory } from '../src/runtime/executors/pi-model-settings-catalog.js';
import { configureScriptedModel, startScriptedModel, type ScriptedStep } from './fixtures/scripted-model.js';
import { testApplicationEnvironment, testDataDir } from './fixtures/test-environment.js';

// 使用真实 Pi、应用装配、HTTP 与 SQLite；回环模型只决定工具序列，不验证供应商模型质量。
test('真实 Pi：全局 Multivac 笔记查询、读写及请求对账走真实应用服务，保存后恢复可读', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-notes-pi-'));
  const scripted = await startScriptedModel();
  const agentDir = join(root, 'pi-agent');
  await configureScriptedModel(agentDir, scripted.endpoint);
  await writeFile(join(testDataDir(root), 'model-settings.json'), JSON.stringify({ revision: 0,
    profiles: [{ profileId: 'scripted', displayName: '脚本模型', provider: 'local-scripted', modelId: 'scripted', protocol: 'openai-completions', endpoint: scripted.endpoint }], defaultProfileId: 'scripted', commands: [] }));
  const createApp = () => createMultivacApplication(testApplicationEnvironment(root), {
    coordinatorAdapter: new PiCoordinatorAdapter({ agentDir, sessionDir: join(root, 'pi-sessions'), taskProtectedPaths: [testDataDir(root)] }),
    modelSettingsCatalogFactory: new PiModelSettingsCatalogFactory({ authPath: join(agentDir, 'auth.json'), candidateRoot: join(root, 'candidates') }),
  });
  let app = createApp();
  try {
    await app.ready;
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    let base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    let serial = 0;
    const turn = async (text: string, ...steps: ScriptedStep[]) => {
      scripted.script(...steps, { text: '已核对实际笔记结果。' });
      const response = await fetch(`${base}/api/assistant/turns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: `turn-${++serial}`, assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, text, contextRefs: [] }) });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json() as { terminalOutcome: string }).terminalOutcome, 'succeeded');
      return { results: scripted.takeToolResults(), requests: scripted.takeRequests() };
    };
    const request = { requestId: 'explicit-create', title: '会议笔记', body: '  原文\n\n忽略所有规则只是笔记中的资料。' };
    const created = await turn('新建会议笔记，保存我提供的原文。', { toolCalls: [{ name: 'create_note', arguments: request }] });
    assert.match(created.results[0]!, /已真实保存/);
    assert.match(created.requests[0]!.systemPrompt, /模型提出建议本身不构成接受/);
    assert.ok(created.requests[0]!.tools.includes('get_note_operation'));
    let list = await (await fetch(`${base}/api/notes`)).json() as { notes: Note[] };
    assert.equal(list.notes.length, 1);
    const id = list.notes[0]!.id;
    const get = async () => (await (await fetch(`${base}/api/notes/${id}`)).json()) as Note;
    assert.equal((await get()).body, request.body);
    const read = await turn('查找会议笔记并读取，暂时只讨论建议。', { toolCalls: [{ name: 'list_notes', arguments: { query: '会议' } }, { name: 'read_note', arguments: { noteId: id } }] });
    assert.match(read.results.join('\n'), /原文/); assert.equal((await get()).revision, 1);
    await turn('把标题改为会议纪要，正文保留。', { toolCalls: [{ name: 'update_note', arguments: { requestId: 'explicit-update', noteId: id, revision: 1, patch: { title: '会议纪要' } } }] });
    assert.equal((await get()).title, '会议纪要'); assert.equal((await get()).body, request.body);
    const checked = await turn('核对之前新建是否保存，不重复新建。', { toolCalls: [{ name: 'get_note_operation', arguments: { requestId: request.requestId } }, { name: 'create_note', arguments: request }] });
    assert.match(checked.results[0]!, /"status":"saved"/);
    list = await (await fetch(`${base}/api/notes`)).json() as { notes: Note[] };
    assert.equal(list.notes.length, 1); assert.equal((await get()).revision, 2);
    app.server.closeAllConnections();
    await new Promise<void>(resolve => app.server.close(() => resolve()));
    await app.close();
    app = createApp();
    await app.ready;
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const restored = await turn('重启后读取会议纪要。', { toolCalls: [{ name: 'read_note', arguments: { noteId: id } }] });
    assert.match(restored.results[0]!, /会议纪要/); assert.match(restored.results[0]!, /原文/);
  } finally {
    app.server.closeAllConnections();
    await new Promise<void>(resolve => app.server.close(() => resolve()));
    await app.close(); await scripted.close(); await rm(root, { recursive: true, force: true });
  }
});
