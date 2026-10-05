import { GLOBAL_ASSISTANT_SESSION_ID as SESSION } from '@multivac/contracts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/skill-fixture.js';
import { ProposalService } from '../src/application/proposals/proposal-service.js';
import { createSkillKind } from '../src/application/proposals/skill-proposals.js';
import { SqliteProposalRepository } from '../src/storage/sqlite-assistant-store.js';
test('对话草案经确认才登记，取消、重复确认、旧版本冲突与真实加载', async () => {
  const f = fixture();
  try {
    const proposals = new ProposalService({
      repository: new SqliteProposalRepository(f.store),
      kinds: [createSkillKind(() => f.service)],
    });
    const payload = {
      displayName: '沉淀方法',
      projectId: null,
      files: {
        'SKILL.md':
          '---\nname: captured-method\ndescription: 根据明确要求沉淀的方法\nallowed-tools: ""\n---\n先核对证据。',
      },
    };
    const origin = { sessionId: SESSION, turnCommandId: 'turn', toolCallId: 'first', originWindowId: null };
    const p = await proposals.submit({ kind: 'skill.register', payload }, origin);
    assert.equal(f.service.list().length, 0);
    const cancelled = await proposals.decide(SESSION, p.proposalId, 'cancel');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(f.service.list().length, 0);
    const next = await proposals.submit(
      { kind: 'skill.register', payload },
      { ...origin, toolCallId: 'second' },
    );
    const result = await proposals.decide(SESSION, next.proposalId, 'confirm');
    assert.equal(result.status, 'executed');
    await proposals.decide(SESSION, next.proposalId, 'confirm');
    assert.equal(f.service.list().length, 1);
    const record = f.service.list()[0]!;
    f.service.setContextResolver(() => ({ sessionId: SESSION, projectId: null, host: 'reading', tools: [] }));
    assert.match(f.service.load(SESSION, record, 'load'), /先核对证据/);
    const edit = await proposals.submit(
      { kind: 'skill.register', payload: { ...payload, skillId: record.skillId, revision: record.revision } },
      { ...origin, toolCallId: 'edit' },
    );
    f.service.state({
      commandId: 'disable',
      skillId: record.skillId,
      revision: record.revision,
      action: 'disable',
    });
    assert.equal((await proposals.decide(SESSION, edit.proposalId, 'confirm')).status, 'expired');
  } finally {
    f.close();
  }
});
