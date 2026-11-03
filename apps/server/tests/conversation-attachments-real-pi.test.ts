import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { startScriptedModel } from './fixtures/scripted-model.js';
import { testApplicationEnvironment, testDataDir } from './fixtures/test-environment.js';

/** SDK、HTTP、历史落盘和工具真实运行；本机脚本模型不证明外部模型自主选参。 */
test('真实 Pi：上传需求、模型读取、创建任务，重启清理未领用旧草稿并保留消息清单', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-conversation-pi-'));
  const model = await startScriptedModel();
  const dataDir = testDataDir(root);
  await mkdir(join(dataDir, 'pi'), { recursive: true });
  await writeFile(join(dataDir, 'pi/auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'local-test-only' } }), { mode: 0o600 });
  await writeFile(join(dataDir, 'model-settings.json'), JSON.stringify({ revision: 0, profiles: [{ profileId: 'scripted', displayName: '本机脚本模型', provider: 'openai', modelId: 'gpt-4o', protocol: 'openai-completions', endpoint: model.endpoint }], defaultProfileId: 'scripted', commands: [] }));
  const environment = { ...testApplicationEnvironment(root), MULTIVAC_MODE: 'development', MULTIVAC_FAKE_ASSISTANT: '0', MULTIVAC_PROVIDER: 'openai', MULTIVAC_MODEL: 'gpt-4o' };
  let app = createMultivacApplication(environment);
  const listen = async () => { await app.ready; await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`; };
  const stop = async () => { app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close(); };
  try {
    let base = await listen();
    const draftId = randomUUID(), id = randomUUID(), text = '# 需求\n保持原文：7391😀';
    const filePath = `/api/sessions/global-coordinator/attachment-drafts/${draftId}/attachments/${id}`;
    assert.equal((await fetch(`${base}${filePath}?name=${encodeURIComponent('需求.md')}`, { method: 'PUT', body: text })).status, 200);
    model.script(
      { toolCalls: [{ name: 'list_task_attachments', arguments: { attachmentDraftId: draftId } }] },
      { toolCalls: [{ name: 'read_task_attachment', arguments: { attachmentDraftId: draftId, attachmentId: id } }] },
      { toolCalls: [{ name: 'create_task', arguments: { attachmentDraftId: draftId, title: '按需求创建任务', goal: '处理用户上传的需求' } }] },
      { text: '任务已创建。' },
    );
    const response = await fetch(`${base}/api/assistant/turns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: randomUUID(), assistantSessionId: 'global-coordinator', text: '请根据附件创建任务', contextRefs: [], attachmentDraftId: draftId }) });
    assert.equal(response.status, 200, await response.clone().text());
    const task = app.tasks.list().tasks[0]!;
    const outputs = model.takeToolResults().join('\n');
    assert.ok(task, outputs);
    assert.equal((await app.taskAttachments.read({ taskId: task.taskId }, id)).data.toString(), text);
    assert.match(outputs, /保持原文/);
    const requests = model.takeRequests();
    assert.ok(requests.some(item => item.userTexts.some(value => value.includes(draftId) && value.includes('需求.md'))));
    assert.ok(requests.every(item => !item.systemPrompt.includes(draftId)), '附件清单只能作为用户数据交付');
    const unusedDraft = randomUUID(), unusedId = randomUUID();
    const unusedPath = `/api/sessions/global-coordinator/attachment-drafts/${unusedDraft}/attachments/${unusedId}`;
    assert.equal((await fetch(`${base}${unusedPath}?name=${encodeURIComponent('未领用.md')}`, { method: 'PUT', body: '留在消息历史' })).status, 200);
    model.script({ text: '材料已收到，暂不创建任务。' });
    assert.equal((await fetch(`${base}/api/assistant/turns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: randomUUID(), assistantSessionId: 'global-coordinator', text: '保留材料', contextRefs: [], attachmentDraftId: unusedDraft }) })).status, 200);
    const databasePath = app.paths.databasePath;
    await stop();
    const database = new DatabaseSync(databasePath);
    database.prepare('UPDATE session_attachment_draft SET created_at=?').run(new Date(Date.now() - 8 * 86400000).toISOString());
    database.close();
    app = createMultivacApplication(environment); base = await listen();
    const page = await (await fetch(`${base}/api/assistant/session`)).json() as any;
    const user = page.messages.find((item: any) => item.attachments?.draftId === draftId);
    assert.equal(user.attachments.taskId, task.taskId);
    assert.equal(user.attachments.attachments[0].name, '需求.md');
    assert.equal(await (await fetch(`${base}${filePath}/content`)).text(), text);
    const unused = page.messages.find((item: any) => item.attachments?.draftId === unusedDraft);
    assert.equal(unused.attachments.expired, true);
    assert.equal(unused.attachments.attachments[0].name, '未领用.md');
    assert.equal(unused.attachments.attachments[0].bytes, Buffer.byteLength('留在消息历史'));
    assert.equal(app.taskAttachments.repository.sessionDraft(unusedDraft), undefined);
    assert.equal(app.taskAttachments.repository.get(unusedId), undefined);
    assert.notEqual((await fetch(`${base}${unusedPath}/content`)).status, 200);
  } finally { await stop(); await model.close(); await rm(root, { recursive: true, force: true }); }
});
