import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixtures/skill-fixture.js';
import { configureScriptedModel, startScriptedModel } from './fixtures/scripted-model.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { createPiSkills } from '../src/runtime/executors/pi-skills.js';
test('真实 Pi SDK：只注入摘要，经工具加载正文，停用后重验；模型为本地脚本', async () => {
  const f = fixture(),
    model = await startScriptedModel(),
    agent = join(f.root, 'agent'),
    cwd = join(f.root, 'work');
  mkdirSync(cwd);
  const adapter = new PiCoordinatorAdapter({ agentDir: agent, sessionDir: join(f.root, 'sessions') });
  try {
    await configureScriptedModel(agent, model.endpoint);
    f.write('ONLY_AFTER_LOAD_正文');
    const p = f.service.preview({ source: f.source, displayName: '示例', projectId: null }),
      r = f.service.confirm('create', p.previewId);
    f.host.context = (() => ({
      sessionId: 's',
      projectId: null,
      host: 'work',
      tools: ['read', 'write', 'edit', 'bash'],
    }));
    adapter.setSkills((id) => createPiSkills(f.service, id));
    const created = await adapter.createSession({
      assistantSessionId: 's',
      workingDirectory: { kind: 'session-temp', path: cwd },
      config: {
        systemPrompt: '按需使用 Skill。',
        authorizedContext: [],
        model: { source: 'base', provider: 'local-scripted', modelId: 'scripted', thinkingLevel: 'off' },
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
        compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 },
      },
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const events: unknown[] = [];
    adapter.subscribe('s', (e) => events.push(e));
    model.script(
      { toolCalls: [{ name: 'skill_load', arguments: { skillId: r.skillId, version: r.version } }] },
      { text: '完成读取' },
    );
    const prepared = await adapter.prepareTurnExecution('s', {
      source: 'base', provider: 'local-scripted', modelId: 'scripted', thinkingLevel: 'off',
    }, '本轮智能体指令：先核对证据。');
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    assert.ok(prepared.ok);
    prepared.value.activate();
    const result = await adapter.prompt('s', '使用示例方法');
    prepared.value.restore();
    assert.equal(result.ok, true, JSON.stringify(result));
    const requests = model.takeRequests();
    assert.match(requests[0]!.systemPrompt, /sample/);
    assert.match(requests[0]!.systemPrompt, /本轮智能体指令：先核对证据。/);
    assert.ok(!requests[0]!.systemPrompt.includes('ONLY_AFTER_LOAD'));
    assert.ok(requests[0]!.tools.includes('skill_load'));
    assert.match(model.takeToolResults().join(), /ONLY_AFTER_LOAD/);
    assert.equal(f.store.skills.uses(r.skillId).length, 1);
    assert.match(JSON.stringify(events), /已加载 Skill/);
    f.service.state({ commandId: 'disable', skillId: r.skillId, revision: r.revision, action: 'disable' });
    model.script(
      { toolCalls: [{ name: 'skill_load', arguments: { skillId: r.skillId, version: r.version } }] },
      { text: '已停用' },
    );
    await adapter.prompt('s', '再次读取');
    assert.doesNotMatch(model.takeRequests()[0]!.systemPrompt, /本轮智能体指令/);
    assert.match(model.takeToolResults().join(), /已停用/);
    assert.equal(f.store.skills.uses(r.skillId).length, 1);
  } finally {
    adapter.dispose();
    await model.close();
    f.close();
  }
});
