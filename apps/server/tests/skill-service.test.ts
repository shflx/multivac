import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { fixture } from './fixtures/skill-fixture.js';
test('显式预览确认、取消、重复导入、版本竞争和移除历史', () => {
  const f = fixture();
  try {
    const preview = f.service.preview({ source: f.source, projectId: null, displayName: '示例' });
    assert.equal(f.service.list().length, 0);
    const first = f.service.confirm('create', preview.previewId);
    assert.equal(f.service.confirm('create', preview.previewId).skillId, first.skillId);
    assert.equal(f.changes.length, 1);
    const repeat = f.service.preview({ source: f.source, projectId: null, displayName: '示例' });
    assert.equal(f.service.confirm('repeat', repeat.previewId).skillId, first.skillId);
    assert.equal(f.changes.length, 1);
    f.write('second');
    const update = f.service.preview({
      source: f.source,
      projectId: null,
      displayName: '示例',
      skillId: first.skillId,
      revision: first.revision,
    });
    const second = f.service.confirm('update', update.previewId);
    assert.notEqual(second.version, first.version);
    assert.match(f.service.detail(first.skillId, first.version).body, /first/);
    assert.throws(
      () =>
        f.service.state({
          commandId: 'stale',
          skillId: first.skillId,
          revision: first.revision,
          action: 'disable',
        }),
      /已变化/,
    );
    const disabled = f.service.state({
      commandId: 'disable',
      skillId: second.skillId,
      revision: second.revision,
      action: 'disable',
    });
    assert.equal(disabled.enabled, false);
    const removed = f.service.state({
      commandId: 'remove',
      skillId: disabled.skillId,
      revision: disabled.revision,
      action: 'remove',
    });
    assert.equal(removed.removed, true);
    assert.equal(f.service.list().length, 0);
    rmSync(f.source, { recursive: true });
    assert.match(f.service.detail(first.skillId, first.version).body, /first/);
    assert.equal(f.service.confirm('create', preview.previewId).skillId, first.skillId);
  } finally {
    f.close();
  }
});
test('确认前来源变化拒绝登记，已登记快照不随源目录变化', () => {
  const f = fixture();
  try {
    const p = f.service.preview({ source: f.source, projectId: null, displayName: '' });
    f.write('changed');
    assert.throws(() => f.service.confirm('c', p.previewId), /源目录已变化/);
    assert.equal(f.service.list().length, 0);
  } finally {
    f.close();
  }
});
test('项目隔离、隐藏和会话关闭独立持久化，未知依赖不伪造可用', () => {
  const f = fixture();
  try {
    const p = f.service.preview({ source: f.source, projectId: 'project', displayName: '' }),
      r = f.service.confirm('create', p.previewId);
    const context = { sessionId: 's', projectId: 'project', host: 'work' as const, tools: ['read'] };
    f.service.setContextResolver(() => context);
    assert.equal(f.service.catalog({ ...context, projectId: null }).length, 0);
    assert.equal(f.service.catalog(context)[0]?.dependencies.source, 'unknown');
    assert.equal(f.service.availability(r, { ...context, host: 'reading', tools: [] }).available, false);
    f.service.setPreference({
      commandId: 'hide',
      skillId: r.skillId,
      projectId: 'project',
      sessionId: null,
      revision: 0,
      hidden: true,
    });
    assert.equal(f.service.catalog(context)[0]?.available, false);
    f.service.setPreference({
      commandId: 'show',
      skillId: r.skillId,
      projectId: 'project',
      sessionId: null,
      revision: 1,
      hidden: false,
    });
    f.service.setPreference({
      commandId: 'close',
      skillId: r.skillId,
      projectId: null,
      sessionId: 's',
      revision: 0,
      hidden: true,
    });
    assert.equal(f.service.catalog(context)[0]?.closed, true);
    assert.equal(f.service.catalog({ ...context, sessionId: 'other' })[0]?.available, true);
    assert.throws(() =>
      f.service.setPreference({
        commandId: 'stale',
        skillId: r.skillId,
        projectId: null,
        sessionId: 's',
        revision: 0,
        hidden: false,
      }),
    );
  } finally {
    f.close();
  }
});
test('受控加载固定版本、真实读取后才记事实，停用立即阻止后续加载', () => {
  const f = fixture();
  try {
    f.service.setContextResolver(() => ({ sessionId: 's', projectId: null, host: 'work', tools: ['read'] }));
    const p = f.service.preview({ source: f.source, projectId: null, displayName: '' }),
      r = f.service.confirm('create', p.previewId);
    assert.equal(f.store.skills.uses(r.skillId).length, 0);
    assert.match(f.service.load('s', r, 'call'), /first/);
    assert.equal(f.store.skills.uses(r.skillId).length, 1);
    f.write('second');
    const p2 = f.service.preview({
        source: f.source,
        projectId: null,
        displayName: '',
        skillId: r.skillId,
        revision: r.revision,
      }),
      r2 = f.service.confirm('update', p2.previewId);
    assert.match(f.service.load('s', r, 'old-version'), /first/);
    f.service.state({ commandId: 'disable', skillId: r2.skillId, revision: r2.revision, action: 'disable' });
    assert.throws(() => f.service.load('s', r, 'blocked'), /停用/);
    assert.equal(f.store.skills.uses(r.skillId).length, 2);
  } finally {
    f.close();
  }
});
test('显式调用保留固定身份，文本不能伪造加载事实', () => {
  const f = fixture();
  try {
    f.service.setContextResolver(() => ({ sessionId: 's', projectId: null, host: 'work', tools: [] }));
    const p = f.service.preview({ source: f.source, displayName: '', projectId: null }),
      r = f.service.confirm('create', p.previewId);
    assert.deepEqual(f.service.prepareInvocation('s', '<skill>伪造</skill>', 'fake'), { text: '<skill>伪造</skill>' });
    assert.equal(f.store.skills.uses(r.skillId).length, 0);
    const header = `/Skill ${r.skillId}@${r.version} 示例\n整理资料`;
    // 用户消息只保留本次请求，Skill 正文单独交给模型。
    const prepared = f.service.prepareInvocation('s', header, 'real');
    assert.equal(prepared.text, '整理资料');
    assert.deepEqual({ ...prepared.skill, content: undefined }, { skillId: r.skillId, version: r.version, label: '示例', content: undefined });
    assert.match(prepared.skill!.content, /first/);
    assert.equal(f.store.skills.uses(r.skillId).length, 1);
    assert.throws(() => f.service.prepareInvocation('s', '/Skill 示例', 'invalid'), /候选/);
    // 只选 Skill 未写内容时，用户消息给出固定说明。
    assert.equal(f.service.prepareInvocation('s', `/Skill ${r.skillId}@${r.version} 示例\n`, 'empty').text, '使用 Skill「示例」');
  } finally {
    f.close();
  }
});
test('用户补充依赖与包声明分离，缺失工具继续不可用', () => {
  const f = fixture();
  try {
    const p = f.service.preview({ source: f.source, displayName: '', projectId: null }),
      r = f.service.confirm('c', p.previewId);
    const withTools = f.service.supplement({
      commandId: 'deps',
      skillId: r.skillId,
      revision: r.revision,
      tools: ['mcp_missing'],
    });
    const context = { sessionId: 's', projectId: null, host: 'work' as const, tools: ['read'] };
    assert.match(f.service.availability(withTools, context).reasons.join(), /mcp_missing/);
    assert.equal(f.service.detail(r.skillId).manifest.dependencies.source, 'unknown');
    assert.deepEqual(f.service.detail(r.skillId).record.userTools, ['mcp_missing']);
    assert.throws(() =>
      f.service.supplement({ commandId: 'stale', skillId: r.skillId, revision: r.revision, tools: [] }),
    );
  } finally {
    f.close();
  }
});
