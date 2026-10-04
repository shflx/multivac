import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { HumanRequest, ToolAuthorizationRequest } from '@multivac/contracts';
import { InboxService } from '../src/application/inbox-service.js';
import type { HumanRequestService } from '../src/application/human-request-service.js';
import type { ToolAuthorizationService } from '../src/application/tool-authorization-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { INBOX_MIGRATION, SqliteInboxRepository } from '../src/storage/sqlite-inbox-repository.js';

test('完整集合先去重排序再分页，查看不减少待处理，草稿冲突保留原值', () => {
  const db = new DatabaseSync(':memory:'); db.exec(INBOX_MIGRATION);
  const states = new SqliteInboxRepository(db);
  const human = (id: string): HumanRequest => ({ requestId: id, kind: 'clarification', taskId: 'task', runId: null, sessionId: 'work', revision: 1, status: 'pending', question: id, createdAt: id, updatedAt: id, artifactVersionId: null, authorizationRequestId: null, decision: null, answer: '', reason: '' });
  const auth: ToolAuthorizationRequest = { requestId: 'a', sessionId: 'global-coordinator', commandId: 'c', toolName: 'read', toolCallId: 't', requestedPath: '/a', targetPath: '/a', workingDirectory: { kind: 'temporary', path: '/work' }, status: 'pending', createdAt: '0000', expiresAt: '9999', decidedAt: null, approval: null, remember: null };
  const humans = Array.from({ length: 105 }, (_, i) => human(String(i).padStart(4, '0')));
  humans.push({ ...human('mirror'), kind: 'authorization', authorizationRequestId: 'a' });
  const service = new InboxService({ list: () => humans } as unknown as HumanRequestService, { all: () => [auth] } as unknown as ToolAuthorizationService, states, new WorkbenchEvents());
  try {
    const page = service.page({ limit: 100 });
    assert.equal(page.pendingCount, 106); assert.equal(page.total, 106); assert.equal(page.nextOffset, 100);
    assert.equal(page.items.filter((item) => item.kind === 'authorization').length, 1);
    assert.equal(service.get('authorization:a').taskId, 'task');
    assert.equal(service.page({ offset: 100 }).items.length, 6);
    service.updateState('authorization:a', { revision: 0, seen: true, draft: '原草稿' });
    assert.equal(service.page().pendingCount, 106); assert.equal(service.page().unseenCount, 105);
    assert.throws(() => service.updateState('authorization:a', { revision: 0, draft: '过期覆盖' }), /另一窗口/);
    assert.equal(new SqliteInboxRepository(db).get('authorization:a').draft, '原草稿');
    auth.status = 'expired';
    assert.equal(service.page().pendingCount, 105);
    assert.equal(service.get('authorization:a').status, 'expired');
    assert.throws(() => service.page({ limit: 101 }), /查询无效/);
  } finally { db.close(); }
});
