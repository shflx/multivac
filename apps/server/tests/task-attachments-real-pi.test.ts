import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { startScriptedModel } from './fixtures/scripted-model.js';
import { testApplicationEnvironment, testDataDir } from './fixtures/test-environment.js';

/** 真实 Pi/HTTP/工具/成果链路；模型输出由本机脚本提供，不证明外部模型自主行为。 */
test('真实 Pi：独立子任务读取祖先快照文本及图片经模型请求交付，独立报告正常提交，原件不进入执行目录', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-attachment-pi-'));
  const model = await startScriptedModel();
  const dataDir = testDataDir(root);
  await mkdir(join(dataDir, 'pi'), { recursive: true });
  await writeFile(join(dataDir, 'pi/auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'local-test-only' } }), { mode: 0o600 });
  await writeFile(join(dataDir, 'model-settings.json'), JSON.stringify({ revision: 0, profiles: [{ profileId: 'scripted', displayName: '受控图片模型', provider: 'openai', modelId: 'gpt-4o', protocol: 'openai-completions', endpoint: model.endpoint }], defaultProfileId: 'scripted', commands: [] }));
  const app = createMultivacApplication({ ...testApplicationEnvironment(root), MULTIVAC_MODE: 'development', MULTIVAC_FAKE_ASSISTANT: '0', MULTIVAC_PROVIDER: 'openai', MULTIVAC_MODEL: 'gpt-4o' });
  try {
    await app.ready;
    const parent = app.tasks.create({ commandId: 'parent', title: '上级材料', goal: '提供只读需求' }).task;
    const task = app.tasks.create({ commandId: 'create', title: '附件联调', goal: '读取上级输入并生成独立报告', acceptance: true, parentTaskId: parent.taskId }).task;
    const source = await app.taskAttachments.upload({ taskId: parent.taskId }, randomUUID(), 'source.json', Buffer.from('{"check":7391}'));
    const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#39a542' } }).png().toBuffer();
    const image = await app.taskAttachments.upload({ taskId: parent.taskId }, randomUUID(), 'source.png', png);
    model.script(
      { toolCalls: [{ name: 'list_task_attachments', arguments: { taskId: parent.taskId } }] },
      { toolCalls: [{ name: 'read_task_attachment', arguments: { taskId: parent.taskId, attachmentId: source.id } }] },
      { toolCalls: [{ name: 'read_task_attachment', arguments: { taskId: parent.taskId, attachmentId: image.id } }] },
      { toolCalls: [{ name: 'write', arguments: { path: 'report.md', content: '受控联调报告：输入 check=7391；图片已通过真实 Pi 模型请求交付。脚本不代表真实模型视觉识别。' } }] },
      { toolCalls: [{ name: 'submit_task_result', arguments: { path: 'report.md', title: '独立联调报告' } }] },
      { text: '报告已登记，等待服务端停止核对。' },
    );
    await app.taskExecution.control(task.taskId, { commandId: 'start', revision: task.revision, action: 'start' });
    for (let i = 0; i < 200; i++) {
      if (app.tasks.detail(task.taskId).runs?.[0]?.stopConfirmed) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    await app.taskExecution.idle();
    const detail = app.tasks.detail(task.taskId), run = detail.runs![0]!;
    assert.equal(detail.task.status, 'review', JSON.stringify(detail));
    const outputs = model.takeToolResults().join('\n');
    assert.equal(run.toolFailures, 0, outputs); assert.ok(run.stopConfirmed);
    assert.deepEqual(run.nativePendingIds, []);
    assert.equal(detail.attachments!.length, 0); assert.deepEqual(run.inputSnapshot!.ancestorTaskIds, [parent.taskId]); assert.equal(run.inputSnapshot!.attachments.length, 2); assert.equal(detail.artifacts!.length, 1);
    assert.match((await app.artifacts.read(detail.artifacts![0]!.versionId)).content, /7391/);
    assert.deepEqual(await readdir(run.directory!.path), ['report.md']);
    assert.equal((await app.taskAttachments.read({ taskId: parent.taskId }, source.id)).data.toString(), '{"check":7391}');
    assert.match(outputs, /7391/);
    const requests = model.takeRequests();
    assert.ok(requests.some(request => request.imageUrls.includes(`data:image/png;base64,${png.toString('base64')}`)), '真实 SDK 请求应包含上传图片的实际内容');
    assert.ok(requests.every(request => request.tools.includes('read_task_attachment')));
    assert.equal(JSON.stringify(detail).includes(png.toString('base64')), false);
  } finally { await app.taskExecution.idle(); await app.close(); await model.close(); await rm(root, { recursive: true, force: true }); }
});
